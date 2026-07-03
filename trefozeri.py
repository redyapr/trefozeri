#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TREFOZERI - Trend Following Zero Risk
===========================================================================
Trading Confluence Signal Engine

Combines 4 components into ONE confidence-scored signal:

  1. Dark Point   -> trend + SL/TP levels (reconstruction: ATR trend-filter / Supertrend-style)
  2. Homma        -> candlestick patterns / price action (Sakata style)
  3. COT          -> institutional positioning bias (CFTC, gold COMEX)
  4. MDP-proxy    -> liquidity/sentiment proxy (NOTE: real MDP data is institutional;
                     here an accessible proxy is used -> contrarian retail sentiment)

The final decision is DETERMINISTIC and transparent (backtestable).
The "AI" layer is an optional explainer (Claude/Gemini) that only narrates the
result; it does not make the decision.

Modes:
  --demo   : use synthetic data, runs without any API key (to see the output)
  --live   : use real data (requires API keys, see .env / environment variables)

Output: a summary printed to the screen + a JSON file. Optionally send to Telegram.

Author : Redy Apriyadi
Email  : redy.apriyadi@gmail.com
Link   : https://bit.ly/trefozeri

Disclaimer: a decision-support tool, NOT financial advice and NOT a profit
guarantee. Backtest before using real money.
"""

from __future__ import annotations

import os
import sys
import json
import argparse
import datetime as dt
from dataclasses import dataclass, field, asdict
from typing import Optional

import numpy as np
import pandas as pd

# Load the .env file that sits NEXT TO this script (not the current working
# directory), so credentials load no matter where the process is launched from —
# cron, launchd, or any other folder. Must run BEFORE CONFIG (CONFIG uses os.getenv()).
from pathlib import Path


def _load_env(path: Path) -> None:
    try:
        from dotenv import load_dotenv
        load_dotenv(path)
    except ImportError:
        # python-dotenv not installed -> minimal built-in loader for KEY=VALUE lines.
        # Real environment variables still take precedence (setdefault doesn't overwrite).
        if path.exists():
            for line in path.read_text().splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_env(Path(__file__).resolve().with_name(".env"))

# ============================================================================
# CONFIG  — change values here, or override via environment variables
# ============================================================================

# Single knob for the alert threshold (percent) — change this one number.
MIN_CONFIDENCE = 50.0

CONFIG = {
    "symbol": "XAU/USD",          # active instrument (auto-set at runtime, see below)
    "entry_tf": "5min",           # entry/timing timeframe
    "htf": "1h",                  # bias timeframe (higher timeframe)
    "bars": 1200,                 # candles pulled on entry_tf (enough history for the HTF bias)

    # Instrument auto-switch: gold on weekdays, crypto on the weekend
    # (the gold/forex market is closed on weekends; crypto trades 24/7).
    # Override on the CLI with --symbol. Each profile carries its own COT filter,
    # OANDA sentiment instrument, and demo price level.
    "weekday_symbol": "XAU/USD",
    "weekend_symbol": "BTC/USD",
    "instruments": {
        "XAU/USD": {"td_symbol": "XAU/USD", "mt5_symbol": "XAUUSD", "oanda_instrument": "XAU_USD",
                    "cot_market_keywords": ["GOLD"],
                    "cot_exchange_keywords": ["COMMODITY EXCHANGE"],
                    "demo_start": 3320.0, "demo_vol_frac": 0.00033, "spread": 0.30},
        "BTC/USD": {"td_symbol": "BTC/USD", "mt5_symbol": "BTCUSD", "oanda_instrument": None,
                    "cot_market_keywords": ["BITCOIN"],
                    "cot_exchange_keywords": ["CHICAGO MERCANTILE EXCHANGE"],
                    "demo_start": 68000.0, "demo_vol_frac": 0.0006, "spread": 12.0},
    },

    # Dark Point (ATR trend-filter)
    "atr_period": 14,
    "dp_multiplier": 3.0,         # ATR channel width -> larger = "looser"
    "tp1_atr": 1.5,               # TP1 = entry +/- 1.5 * ATR
    "tp2_atr": 3.0,               # TP2 = entry +/- 3.0 * ATR
    "tp3_atr": 4.5,               # TP3 = entry +/- 4.5 * ATR (final target)

    # Homma (candlestick)
    "homma_lookback": 5,          # how many recent candles to scan for patterns
    "trend_ema": 50,              # EMA for trend context (significance of reversal patterns)
    "doji_body_ratio": 0.1,       # body <= 10% of range -> doji
    "long_shadow_ratio": 2.0,     # shadow >= 2x body -> long shadow

    # COT (CFTC gold)
    "cot_market_keywords": ["GOLD"],                 # market name filter
    "cot_exchange_keywords": ["COMMODITY EXCHANGE"], # COMEX, avoid micro/other
    "cot_index_weeks": 156,       # COT index window (~3 years)

    # MDP-proxy (contrarian retail sentiment)
    "crowd_long_high": 60.0,      # crowd long > 60% -> lean bearish (contrarian)
    "crowd_long_low": 40.0,       # crowd long < 40% -> lean bullish

    # Confluence weights (total ~1.0)
    "weights": {
        "dark_point": 0.30,
        "homma": 0.25,
        "cot": 0.25,
        "mdp_proxy": 0.20,
    },

    # Signal thresholds
    "min_abs_score": 0.20,        # min |combined score| for BUY/SELL (otherwise NEUTRAL)
    "min_agreement": 0.50,        # min proportion of components that must agree

    # Entry zone (Dark Point-anchored, scale-in)
    "zone_pullback_atr": 1.0,     # max pullback depth from market price, in ATR (capped by the DP line)
    "zone_sl_buffer_atr": 0.5,    # SL placed this many ATR beyond the far edge of the zone
    "entry_valid_bars": 8,        # how many bars the pullback limit order stays valid

    # News filter (ForexFactory) — high-impact USD
    "news_block_minutes": 30,     # block the signal if news is < 30 minutes away
    "news_feed_utc_offset_hours": 0,  # the FF feed's UTC offset (0 = treat as UTC). Calibrate
                                      # against a known event time if the block fires at the wrong hour.

    # Alerts: only run the Analysis and send Telegram above this confidence
    "alert_min_confidence": MIN_CONFIDENCE,  # percent (strictly greater-than); edit MIN_CONFIDENCE above

    # Analysis
    "ai_provider": os.getenv("AI_PROVIDER", "none"),  # "claude" | "gemini" | "none"
    "ai_model_claude": "claude-sonnet-4-6",
    "ai_model_gemini": "gemini-2.0-flash",
    "ai_language": "en",          # narration language: "en" or "id"
}


# ============================================================================
# RESULT STRUCTURES
# ============================================================================

@dataclass
class ComponentResult:
    name: str
    score: float                  # [-1..+1], + = bullish, - = bearish
    quality: float                # [0..1] confidence of this component
    direction: str                # "BUY" | "SELL" | "NEUTRAL"
    detail: dict = field(default_factory=dict)


@dataclass
class Signal:
    symbol: str
    timestamp: str
    direction: str                # "BUY" | "SELL" | "NEUTRAL"
    confidence: float             # 0..100 %
    score: float                  # combined score [-1..+1]
    price: float
    sl: Optional[float]
    tp1: Optional[float]
    tp2: Optional[float]
    tp3: Optional[float]
    session: str
    news_flag: str
    components: dict = field(default_factory=dict)
    rationale: str = ""
    entry_zone: Optional[dict] = None      # {"low", "high", "mid"} or None when NEUTRAL
    entries: list = field(default_factory=list)  # scale-in orders [{portion, type, price}]
    rr: Optional[dict] = None              # blended reward:risk {"tp1", "tp2"} measured from zone mid
    invalidation: Optional[float] = None   # cancel the pending zone if this level trades first (= SL)
    valid_bars: int = 0                    # bars the pullback limit order stays valid


# ============================================================================
# INDICATOR UTILITIES
# ============================================================================

def atr(df: pd.DataFrame, period: int) -> pd.Series:
    """Average True Range (Wilder smoothing)."""
    h, l, c = df["high"], df["low"], df["close"]
    prev_c = c.shift(1)
    tr = pd.concat([(h - l).abs(),
                    (h - prev_c).abs(),
                    (l - prev_c).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / period, adjust=False).mean()


def ema(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(span=period, adjust=False).mean()


# ============================================================================
# 1) DARK POINT  (reconstruction: ATR trend-filter, Supertrend-style)
# ============================================================================
# The original Dark Point is closed-source. What is public from its description:
# trend-following based on a "dark-point moving average" + ATR, non-repaint,
# green/red dots when the trend flips, plus ATR-derived SL & TP levels.
# Supertrend is the closest, most transparent analog for that behavior.

def dark_point(df: pd.DataFrame, period: int, mult: float) -> pd.DataFrame:
    a = atr(df, period)
    hl2 = (df["high"] + df["low"]) / 2.0
    upper = hl2 + mult * a
    lower = hl2 - mult * a

    final_upper = upper.copy()
    final_lower = lower.copy()
    trend = pd.Series(index=df.index, dtype="int64")  # +1 up, -1 down
    close = df["close"]

    for i in range(len(df)):
        if i == 0:
            trend.iloc[i] = 1
            continue
        # final upper band
        if (upper.iloc[i] < final_upper.iloc[i - 1]) or (close.iloc[i - 1] > final_upper.iloc[i - 1]):
            fu = upper.iloc[i]
        else:
            fu = final_upper.iloc[i - 1]
        # final lower band
        if (lower.iloc[i] > final_lower.iloc[i - 1]) or (close.iloc[i - 1] < final_lower.iloc[i - 1]):
            fl = lower.iloc[i]
        else:
            fl = final_lower.iloc[i - 1]
        final_upper.iloc[i] = fu
        final_lower.iloc[i] = fl

        prev_trend = trend.iloc[i - 1]
        if prev_trend == 1:
            trend.iloc[i] = -1 if close.iloc[i] < fl else 1
        else:
            trend.iloc[i] = 1 if close.iloc[i] > fu else -1

    line = np.where(trend == 1, final_lower, final_upper)
    out = pd.DataFrame({"atr": a, "dp_trend": trend, "dp_line": line}, index=df.index)
    return out


def dark_point_signal(df: pd.DataFrame, cfg: dict) -> ComponentResult:
    dp = dark_point(df, cfg["atr_period"], cfg["dp_multiplier"])
    trend = int(dp["dp_trend"].iloc[-1])
    # signal "freshness": how many bars since the last flip (a fresh flip = stronger score)
    flips = dp["dp_trend"].diff().fillna(0) != 0
    bars_since_flip = int((~flips[::-1]).cumprod().sum()) if flips.any() else len(df)
    freshness = max(0.0, 1.0 - bars_since_flip / 20.0)  # decay over 20 bars

    score = float(trend) * (0.5 + 0.5 * freshness)       # [-1..+1]
    direction = "BUY" if trend > 0 else "SELL"
    quality = 0.5 + 0.5 * freshness

    return ComponentResult(
        name="dark_point", score=score, quality=quality, direction=direction,
        detail={
            "trend": "UP" if trend > 0 else "DOWN",
            "line": round(float(dp["dp_line"].iloc[-1]), 2),
            "atr": round(float(dp["atr"].iloc[-1]), 2),
            "bars_since_flip": bars_since_flip,
        },
    )


# ============================================================================
# 2) HOMMA  (candlestick patterns / price action)
# ============================================================================

def _anatomy(o, h, l, c):
    body = abs(c - o)
    rng = max(h - l, 1e-9)
    upper = h - max(o, c)
    lower = min(o, c) - l
    return body, rng, upper, lower


def homma_signal(df: pd.DataFrame, cfg: dict) -> ComponentResult:
    look = cfg["homma_lookback"]
    e = ema(df["close"], cfg["trend_ema"])
    up_trend = df["close"].iloc[-1] > e.iloc[-1]      # trend context
    patterns = []
    raw = 0.0

    n = len(df)
    for k in range(1, look + 1):     # newest candle (k=1) through look
        i = n - k
        if i < 2:
            break
        o, h, l, c = (df["open"].iloc[i], df["high"].iloc[i],
                      df["low"].iloc[i], df["close"].iloc[i])
        po, pc = df["open"].iloc[i - 1], df["close"].iloc[i - 1]
        body, rng, upper, lower = _anatomy(o, h, l, c)
        recency = 1.0 - (k - 1) / look          # newest candle gets the highest weight
        bull = c > o

        # --- Doji & its variants ---
        if body <= cfg["doji_body_ratio"] * rng:
            if lower >= cfg["long_shadow_ratio"] * body and upper < body:
                patterns.append((i, "Dragonfly Doji", +0.6 * recency)); raw += 0.6 * recency
            elif upper >= cfg["long_shadow_ratio"] * body and lower < body:
                patterns.append((i, "Gravestone Doji", -0.6 * recency)); raw -= 0.6 * recency

        # --- Hammer / Shooting star ---
        if lower >= cfg["long_shadow_ratio"] * body and upper <= body and body > 0:
            w = +0.8 * recency * (1.3 if not up_trend else 0.8)  # more valid in a downtrend
            patterns.append((i, "Hammer", w)); raw += w
        if upper >= cfg["long_shadow_ratio"] * body and lower <= body and body > 0:
            w = -0.8 * recency * (1.3 if up_trend else 0.8)
            patterns.append((i, "Shooting Star", w)); raw += w

        # --- Engulfing ---
        if bull and pc < po and (c >= po) and (o <= pc):
            w = +0.9 * recency
            patterns.append((i, "Bullish Engulfing", w)); raw += w
        if (not bull) and pc > po and (o >= pc) and (c <= po):
            w = -0.9 * recency
            patterns.append((i, "Bearish Engulfing", w)); raw += w

        # --- 3-candle Star (check at i, i-1, i-2) ---
        if i >= 2:
            o2, c2 = df["open"].iloc[i - 2], df["close"].iloc[i - 2]
            b1 = abs(pc - po)
            small_mid = b1 <= 0.5 * abs(c2 - o2)
            if c2 < o2 and small_mid and bull and c > (o2 + c2) / 2:
                w = +1.0 * recency
                patterns.append((i, "Morning Star", w)); raw += w
            if c2 > o2 and small_mid and (not bull) and c < (o2 + c2) / 2:
                w = -1.0 * recency
                patterns.append((i, "Evening Star", w)); raw += w

    score = float(max(-1.0, min(1.0, raw / 2.0)))   # normalize
    direction = "BUY" if score > 0.05 else ("SELL" if score < -0.05 else "NEUTRAL")
    quality = min(1.0, abs(score) + 0.15 * len(patterns))

    return ComponentResult(
        name="homma", score=score, quality=quality, direction=direction,
        detail={
            "trend_context": "UP" if up_trend else "DOWN",
            "patterns": [{"bars_ago": n - 1 - i, "name": nm, "w": round(w, 2)}
                         for (i, nm, w) in patterns][:6],
        },
    )


# ============================================================================
# 3) COT  (CFTC gold COMEX — institutional positioning bias)
# ============================================================================

def _find_col(cols, *keywords):
    for col in cols:
        cl = str(col).lower()
        if all(k.lower() in cl for k in keywords):
            return col
    return None


def fetch_cot_live(cfg: dict) -> pd.DataFrame:
    """Fetch COT legacy futures-only via the cot_reports library (needs internet, no key)."""
    import cot_reports as cot  # pip install cot-reports
    year = dt.date.today().year
    frames = []
    for y in (year, year - 1, year - 2):
        try:
            frames.append(cot.cot_year(year=y, cot_report_type="legacy_fut"))
        except Exception:
            pass
    if not frames:
        raise RuntimeError("Failed to fetch COT data")
    df = pd.concat(frames, ignore_index=True)

    mkt_col = _find_col(df.columns, "market", "names") or _find_col(df.columns, "market")
    mask = df[mkt_col].astype(str).str.contains("|".join(cfg["cot_market_keywords"]),
                                                case=False, na=False)
    for ek in cfg["cot_exchange_keywords"]:
        mask &= df[mkt_col].astype(str).str.contains(ek, case=False, na=False)
    g = df[mask].copy()
    if g.empty:
        raise RuntimeError(f"COT contract not found "
                           f"({cfg['cot_market_keywords']} / {cfg['cot_exchange_keywords']})")

    date_col = _find_col(g.columns, "as of date") or _find_col(g.columns, "report", "date") \
        or _find_col(g.columns, "date")
    nc_long = _find_col(g.columns, "noncommercial", "long")
    nc_short = _find_col(g.columns, "noncommercial", "short")

    g["_date"] = pd.to_datetime(g[date_col], errors="coerce")
    g["_net"] = pd.to_numeric(g[nc_long], errors="coerce") - pd.to_numeric(g[nc_short], errors="coerce")
    g = g.dropna(subset=["_date", "_net"]).sort_values("_date")
    return g[["_date", "_net"]].reset_index(drop=True)


def cot_signal(cot_df: pd.DataFrame, cfg: dict) -> ComponentResult:
    """COT index = net non-commercial position relative to a ~3-year range."""
    s = cot_df["_net"].tail(cfg["cot_index_weeks"])
    cur = float(s.iloc[-1])
    lo, hi = float(s.min()), float(s.max())
    idx = 50.0 if hi == lo else (cur - lo) / (hi - lo) * 100.0  # 0..100
    score = (idx - 50.0) / 50.0                                  # [-1..+1]

    # week-over-week momentum
    chg = float(s.iloc[-1] - s.iloc[-2]) if len(s) >= 2 else 0.0
    score = 0.7 * score + 0.3 * np.sign(chg) * min(1.0, abs(chg) / (abs(cur) + 1e-9) * 5)
    score = float(max(-1.0, min(1.0, score)))
    direction = "BUY" if score > 0.05 else ("SELL" if score < -0.05 else "NEUTRAL")

    return ComponentResult(
        name="cot", score=score, quality=0.6, direction=direction,
        detail={"cot_index": round(idx, 1), "net_noncommercial": int(cur),
                "wow_change": int(chg)},
    )


# ============================================================================
# 4) MDP-PROXY  (liquidity/sentiment proxy — NOT real MDP data)
# ============================================================================
# Real Multi-Dealer Platform data is institutional (requires ECP / prime broker).
# Not accessible to a solo dev. The proxy used here: retail sentiment
# (contrarian). Can be swapped for the OANDA position book, FXSSI, Myfxbook, etc.

def fetch_crowd_long_pct_oanda(instrument: Optional[str]) -> Optional[float]:
    """Approx % crowd long for `instrument` from the OANDA position book
    (needs OANDA_TOKEN, free practice account). Returns None if the instrument has
    no position book (e.g. crypto on the practice feed) or the token is missing."""
    if not instrument:
        return None
    token = os.getenv("OANDA_TOKEN")
    if not token:
        return None
    import requests
    url = f"https://api-fxpractice.oanda.com/v3/instruments/{instrument}/positionBook"
    r = requests.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=15)
    r.raise_for_status()
    buckets = r.json()["positionBook"]["buckets"]
    longs = sum(float(b["longCountPercent"]) for b in buckets)
    shorts = sum(float(b["shortCountPercent"]) for b in buckets)
    total = longs + shorts
    return None if total == 0 else longs / total * 100.0


def mdp_proxy_signal(crowd_long_pct: Optional[float], cfg: dict) -> ComponentResult:
    if crowd_long_pct is None:
        return ComponentResult("mdp_proxy", 0.0, 0.1, "NEUTRAL",
                               detail={"note": "no sentiment data"})
    # CONTRARIAN: crowd too long -> lean bearish, and vice versa
    if crowd_long_pct >= cfg["crowd_long_high"]:
        score = -min(1.0, (crowd_long_pct - 50) / 50)
    elif crowd_long_pct <= cfg["crowd_long_low"]:
        score = min(1.0, (50 - crowd_long_pct) / 50)
    else:
        score = -(crowd_long_pct - 50) / 50 * 0.5
    score = float(max(-1.0, min(1.0, score)))
    direction = "BUY" if score > 0.05 else ("SELL" if score < -0.05 else "NEUTRAL")
    return ComponentResult("mdp_proxy", score, 0.5, direction,
                           detail={"crowd_long_pct": round(crowd_long_pct, 1),
                                   "interpretation": "contrarian"})


# ============================================================================
# NEWS FILTER (ForexFactory) + SESSION
# ============================================================================

def trading_session(now_utc: dt.datetime) -> str:
    h = now_utc.hour
    if 7 <= h < 12:
        return "London"
    if 12 <= h < 16:
        return "London/NewYork overlap"
    if 16 <= h < 21:
        return "NewYork"
    return "Asia/Sydney"


def check_high_impact_news(cfg: dict) -> str:
    """Check the nearest high-impact USD news from the ForexFactory calendar (needs internet)."""
    try:
        import requests, xml.etree.ElementTree as ET
        url = "https://nfs.faireconomy.media/ff_calendar_thisweek.xml"
        r = requests.get(url, timeout=15)
        root = ET.fromstring(r.content)
        now = dt.datetime.now(dt.timezone.utc)
        soonest = None
        for ev in root.findall("event"):
            cur = (ev.findtext("country") or "").upper()
            imp = (ev.findtext("impact") or "").lower()
            if cur != "USD" or "high" not in imp:
                continue
            try:
                naive = dt.datetime.strptime(
                    f"{ev.findtext('date')} {ev.findtext('time')}", "%m-%d-%Y %I:%M%p")
                # feed time is in feed-local TZ; convert to UTC = local - offset
                when = (naive - dt.timedelta(hours=cfg.get("news_feed_utc_offset_hours", 0))
                        ).replace(tzinfo=dt.timezone.utc)
            except Exception:
                continue
            mins = (when - now).total_seconds() / 60
            if 0 <= mins <= cfg["news_block_minutes"]:
                if soonest is None or mins < soonest[0]:
                    soonest = (mins, ev.findtext("title"))
        if soonest:
            return f"BLOCK: '{soonest[1]}' in ~{int(soonest[0])} min"
        return "clear"
    except Exception as ex:
        return f"unknown ({type(ex).__name__})"


# ============================================================================
# CONFLUENCE  — combine into a single signal
# ============================================================================

def _entry_zone(final_dir: str, price: float, atr_val: float,
                line: Optional[float], cfg: dict):
    """Build a Dark Point-anchored entry zone + 50/50 scale-in orders + SL/TP/R:R.

    Idea (trend-following): don't chase the close — buy the pullback toward the
    Dark Point line (uptrend) or sell the rally toward it (downtrend). The line
    is also the trend-flip level, so the stop sits just beyond it.

      - one edge of the zone = current price (the "market" half of the position)
      - the other edge       = a pullback toward the DP line, capped at zone_pullback_atr
      - SL                   = zone_sl_buffer_atr beyond the far (pullback) edge
      - TP1/TP2              = measured from the blended (mid) entry -> honest R:R
    """
    pull_cap = cfg["zone_pullback_atr"] * atr_val
    sl_buf = cfg["zone_sl_buffer_atr"] * atr_val

    if final_dir == "BUY":
        far = price - pull_cap                       # deepest (best) fill
        if line is not None and line < price:
            far = max(far, line)                     # don't go past the trend line
        if far >= price:                             # degenerate -> fall back to ATR band
            far = price - 0.5 * atr_val
        low, high = far, price                       # low = pullback fill, high = market
        sl = low - sl_buf
        mid = (low + high) / 2.0
        tp1 = mid + cfg["tp1_atr"] * atr_val
        tp2 = mid + cfg["tp2_atr"] * atr_val
        tp3 = mid + cfg["tp3_atr"] * atr_val
        entries = [
            {"portion": 0.5, "type": "market", "price": round(high, 2)},
            {"portion": 0.5, "type": "limit",  "price": round(low, 2)},
        ]
    else:  # SELL
        far = price + pull_cap
        if line is not None and line > price:
            far = min(far, line)
        if far <= price:
            far = price + 0.5 * atr_val
        low, high = price, far                       # high = rally fill, low = market
        sl = high + sl_buf
        mid = (low + high) / 2.0
        tp1 = mid - cfg["tp1_atr"] * atr_val
        tp2 = mid - cfg["tp2_atr"] * atr_val
        tp3 = mid - cfg["tp3_atr"] * atr_val
        entries = [
            {"portion": 0.5, "type": "market", "price": round(low, 2)},
            {"portion": 0.5, "type": "limit",  "price": round(high, 2)},
        ]

    risk = abs(mid - sl)
    rr = {"tp1": round(abs(tp1 - mid) / risk, 2) if risk else None,
          "tp2": round(abs(tp2 - mid) / risk, 2) if risk else None,
          "tp3": round(abs(tp3 - mid) / risk, 2) if risk else None}
    zone = {"low": round(low, 2), "high": round(high, 2), "mid": round(mid, 2)}
    return zone, entries, round(sl, 2), round(tp1, 2), round(tp2, 2), round(tp3, 2), rr


def combine(components: list[ComponentResult], price: float, atr_val: float,
            dp: ComponentResult, session: str, news: str, cfg: dict) -> Signal:
    w = cfg["weights"]
    wsum = sum(w[c.name] for c in components)
    weighted = sum(c.score * w[c.name] for c in components) / (wsum or 1.0)

    final_dir = "BUY" if weighted > 0 else "SELL"
    agree = sum(w[c.name] for c in components
                if (c.score > 0) == (weighted > 0) and c.direction != "NEUTRAL")
    agreement = agree / (wsum or 1.0)

    # require strength + agreement, otherwise -> NEUTRAL
    if abs(weighted) < cfg["min_abs_score"] or agreement < cfg["min_agreement"]:
        final_dir = "NEUTRAL"

    # the news filter overrides everything
    if news.startswith("BLOCK"):
        final_dir = "NEUTRAL"

    confidence = round(min(100.0, (0.5 * abs(weighted) + 0.5 * agreement) * 100), 1)

    # --- Entry zone (Dark Point-anchored) + scale-in orders + SL/TP/R:R ---
    sl = tp1 = tp2 = tp3 = None
    entry_zone = rr = invalidation = None
    entries: list = []
    valid_bars = 0
    if final_dir in ("BUY", "SELL"):
        line = dp.detail.get("line") if dp is not None else None
        entry_zone, entries, sl, tp1, tp2, tp3, rr = _entry_zone(
            final_dir, price, atr_val, line, cfg)
        invalidation = sl                 # if SL trades before a fill, cancel the pending order
        valid_bars = cfg["entry_valid_bars"]

    return Signal(
        symbol=cfg["symbol"],
        timestamp=dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        direction=final_dir,
        confidence=confidence,
        score=round(weighted, 3),
        price=round(price, 2),
        sl=sl, tp1=tp1, tp2=tp2, tp3=tp3,
        session=session,
        news_flag=news,
        components={c.name: {"score": round(c.score, 3), "quality": round(c.quality, 2),
                             "direction": c.direction, **c.detail} for c in components},
        entry_zone=entry_zone, entries=entries, rr=rr,
        invalidation=invalidation, valid_bars=valid_bars,
    )


# ============================================================================
# ANALYSIS (optional) — narrates the result, does not decide
# ============================================================================

def ai_explain(sig: Signal, cfg: dict) -> str:
    provider = cfg["ai_provider"]
    if provider == "none":
        return ""
    lang = "Indonesian" if cfg["ai_language"] == "id" else "English"
    prompt = (
        f"You are a trading analyst. Briefly explain (3-4 sentences) in {lang} the "
        f"following signal for {sig.symbol}. Do not add any new recommendation, only "
        f"narrate the confluence of the components. Include why the direction and "
        f"confidence are what they are.\n\n"
        f"{json.dumps(asdict(sig), ensure_ascii=False, indent=2)}"
    )
    try:
        import requests
        if provider == "claude":
            key = os.getenv("CLAUDE_API_KEY", "")
            if not key:
                return "(Analysis skipped: CLAUDE_API_KEY not set)"
            r = requests.post(
                "https://api.anthropic.com/v1/messages",
                headers={"x-api-key": key,
                         "anthropic-version": "2023-06-01",
                         "content-type": "application/json"},
                json={"model": cfg["ai_model_claude"], "max_tokens": 400,
                      "messages": [{"role": "user", "content": prompt}]},
                timeout=40)
        elif provider == "gemini":
            key = os.getenv("GEMINI_API_KEY", "")
            if not key:
                return "(Analysis skipped: GEMINI_API_KEY not set)"
            # Send the key via header (NOT the URL) so it can never leak into an
            # error message, the JSON file, or the Telegram report.
            url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
                   f"{cfg['ai_model_gemini']}:generateContent")
            r = requests.post(url,
                              headers={"x-goog-api-key": key,
                                       "content-type": "application/json"},
                              json={"contents": [{"parts": [{"text": prompt}]}]},
                              timeout=40)
        else:
            return f"(Analysis skipped: unknown provider '{provider}')"

        # Surface the real reason on failure (HTTP status + trimmed response body).
        # The body carries Google's/Anthropic's actual error message; the key is in
        # the header, so it does not appear here.
        if r.status_code != 200:
            detail = " ".join(r.text.split())[:300]
            return f"(Analysis skipped: HTTP {r.status_code} — {detail})"

        if provider == "claude":
            return "".join(b.get("text", "") for b in r.json()["content"])
        return r.json()["candidates"][0]["content"]["parts"][0]["text"]
    except Exception as ex:
        return f"(Analysis skipped: {type(ex).__name__})"


# ============================================================================
# OUTPUT
# ============================================================================

def format_report(sig: Signal) -> str:
    icon = {"BUY": "🔵 BUY", "SELL": "🔴 SELL", "NEUTRAL": "⚪ NEUTRAL"}[sig.direction]
    pair = sig.symbol.replace("/", "")          # XAU/USD -> XAUUSD (all pairs)
    lines = [
        # f"{pair} {sig.session} Session",
        f"{icon} {pair} (confidence {sig.confidence}%)",
        # f"Score      : {sig.score:+.3f}   |  Price: {sig.price}",
        # f"Session    : {sig.session}",
        # f"News       : {sig.news_flag}",
    ]
    if sig.direction != "NEUTRAL":
        z = sig.entry_zone or {}
        rr = sig.rr or {}
        lines.append(f"\nEntry Zone :\n{z.get('low')} - {z.get('high')} (mid {z.get('mid')})")
        # for e in sig.entries:
        #     lines.append(f"      {int(e['portion'] * 100)}% {e['type']:<6} @ {e['price']}")
        lines += [f"\nTP1 : {sig.tp1} (R:R {rr.get('tp1')})",
                  f"TP2 : {sig.tp2} (R:R {rr.get('tp2')})",
                  f"TP3 : {sig.tp3} (R:R {rr.get('tp3')})",
                  f"\nSL : {sig.sl}"]
                #   f"Validity : ~{sig.valid_bars} bars (limit order)"]
    # lines.append("  Components:")
    # for name, d in sig.components.items():
    #     lines.append(f"    {name:<11}: {d['score']:+.2f}  [{d['direction']}]  q={d['quality']}")
    if sig.rationale:
        lines += ["Analysis:", sig.rationale.replace("\n", "\n  ")]
    # Disclaimer always last — after the analysis
    lines.append("\n⚠️ Not investment advice. Risk management is your responsibility.")
    return "\n".join(lines)


def send_telegram(text: str) -> Optional[int]:
    """Send directly to Telegram; return the sent message_id (or None).
    Requires TELEGRAM_BOT_TOKEN & TELEGRAM_CHAT_ID. Uses HTML parse mode so the
    first line renders in bold and the disclaimer in italics. The returned id lets
    the MT5 EA reply to this exact signal message when the trade later hits SL/TP."""
    token, chat = os.getenv("TELEGRAM_BOT_TOKEN"), os.getenv("TELEGRAM_CHAT_ID")
    if not token or not chat:
        return None
    import html as _html
    disclaimer = "⚠️ Not investment advice. Risk management is your responsibility."
    body = _html.escape(text)                         # escape &,<,> so HTML mode is safe
    # Wrap the Analysis block (from "Analysis:" up to the disclaimer) in a quote.
    if "\nAnalysis:" in body and disclaimer in body:
        head_part, _, after = body.partition("\nAnalysis:")
        analysis_block, _, _ = after.partition("\n\n" + disclaimer)
        body = f"{head_part}\n<blockquote expandable>Analysis:{analysis_block}</blockquote>\n\n{disclaimer}"
    body = body.replace(disclaimer, f"<i>{disclaimer}</i>")   # disclaimer has no &<> to escape
    # Bold the first line (the "<icon> SYMBOL (confidence ..)" header).
    head, sep, rest = body.partition("\n")
    body = f"<b>{head}</b>{sep}{rest}"
    try:
        import requests
        r = requests.post(f"https://api.telegram.org/bot{token}/sendMessage",
                          json={"chat_id": chat, "text": body, "parse_mode": "HTML"}, timeout=15)
        return r.json().get("result", {}).get("message_id")
    except Exception as ex:
        print(f"[telegram] failed: {ex}", file=sys.stderr)
        return None


# ============================================================================
# DATA — live (TwelveData) & demo (synthetic)
# ============================================================================

def fetch_price_twelvedata(symbol: str, interval: str, bars: int) -> pd.DataFrame:
    import requests
    key = os.getenv("TWELVEDATA_API_KEY")
    if not key:
        raise RuntimeError("TWELVEDATA_API_KEY is not set")
    try:
        r = requests.get("https://api.twelvedata.com/time_series",
                         params={"symbol": symbol, "interval": interval,
                                 "outputsize": bars, "apikey": key}, timeout=20)
    except requests.RequestException as ex:
        # `from None` drops the original exception, whose message embeds the full
        # URL (including apikey) — never let the key reach logs/tracebacks.
        raise RuntimeError(f"TwelveData request failed: {type(ex).__name__}") from None
    # Not raise_for_status(): its message echoes the URL (with the apikey) too.
    if r.status_code != 200:
        raise RuntimeError(f"TwelveData HTTP {r.status_code} for {symbol} {interval}")
    data = r.json()
    if "values" not in data:
        raise RuntimeError(f"TwelveData error: {data.get('message', data)}")
    df = pd.DataFrame(data["values"]).iloc[::-1].reset_index(drop=True)
    for col in ["open", "high", "low", "close"]:
        df[col] = pd.to_numeric(df[col])
    df["datetime"] = pd.to_datetime(df["datetime"])
    return df[["datetime", "open", "high", "low", "close"]]


def make_demo_ohlc(bars: int, seed: int | None = None, start: float = 3320.0,
                   vol_frac: float = 0.00033, tf_min: int = 15) -> pd.DataFrame:
    """Synthetic OHLC resembling the chosen instrument (random walk + trend + volatility).

    With seed=None each run draws a different regime (trending up, trending down,
    or choppy), so the demo can produce BUY, SELL, or NEUTRAL signals. `vol_frac`
    scales the per-bar move to the price level so gold (~3320) and BTC (~68000) both
    look realistic. Pass a fixed seed to reproduce a specific scenario.
    """
    rng = np.random.default_rng(seed)
    unit = start * vol_frac                       # per-bar move scaled to the price level
    slope = rng.normal(0.0, unit * 0.12)          # overall drift: + up, - down, ~0 choppy
    drift = np.full(bars, slope)
    if rng.random() < 0.45:                       # sometimes a regime change mid-series
        flip = int(rng.integers(bars // 3, 2 * bars // 3))
        drift[flip:] = rng.normal(0.0, unit * 0.12)
    vol = rng.uniform(unit * 0.8, unit * 1.3)     # random volatility
    rets = rng.normal(drift, vol, bars)
    close = start + np.cumsum(rets)
    open_ = np.concatenate([[start], close[:-1]])
    high = np.maximum(open_, close) + np.abs(rng.normal(0, unit * 0.8, bars))
    low = np.minimum(open_, close) - np.abs(rng.normal(0, unit * 0.8, bars))
    t0 = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=tf_min * bars)
    times = [t0 + dt.timedelta(minutes=tf_min * i) for i in range(bars)]
    return pd.DataFrame({"datetime": times, "open": open_, "high": high,
                         "low": low, "close": close})


def make_demo_cot(weeks: int = 160, seed: int | None = None) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    drift = rng.normal(0.0, 220.0)                # random net-position drift -> varied COT index
    net = 150000 + np.cumsum(rng.normal(drift, 6000, weeks))
    dates = [dt.date.today() - dt.timedelta(weeks=weeks - i) for i in range(weeks)]
    return pd.DataFrame({"_date": pd.to_datetime(dates), "_net": net})


def tf_minutes(tf: str) -> int:
    """Parse a timeframe string ('5min', '15min', '1h', '4h', '1day') into minutes."""
    s = tf.strip().lower()
    if s.endswith("min"):
        return int(s[:-3])
    if s.endswith("h"):
        return int(s[:-1]) * 60
    if s.endswith("day"):
        return int(s[:-3]) * 1440
    if s.endswith("d"):
        return int(s[:-1]) * 1440
    return int(s)


def resample_htf(df: pd.DataFrame, rule: str) -> pd.DataFrame:
    g = df.set_index("datetime").resample(rule).agg(
        {"open": "first", "high": "max", "low": "min", "close": "last"}).dropna()
    return g.reset_index()


# ============================================================================
# INSTRUMENT SELECTION  — gold on weekdays, crypto on the weekend
# ============================================================================

def pick_symbol(cfg: dict, now_utc: dt.datetime | None = None) -> str:
    """Auto-select the instrument by day of week (UTC): weekend -> crypto, else gold.
    The gold/forex market is closed on weekends while crypto trades 24/7."""
    now = now_utc or dt.datetime.now(dt.timezone.utc)
    return cfg["weekend_symbol"] if now.weekday() >= 5 else cfg["weekday_symbol"]  # Sat=5, Sun=6


def apply_instrument(cfg: dict, symbol: str) -> str:
    """Load the instrument's profile (TwelveData symbol, COT filter, OANDA instrument,
    demo price level) into the active config keys. Returns the resolved symbol."""
    if symbol not in cfg["instruments"]:
        raise ValueError(f"Unknown symbol '{symbol}'. Known: {list(cfg['instruments'])}")
    p = cfg["instruments"][symbol]
    cfg["symbol"] = p["td_symbol"]
    cfg["cot_market_keywords"] = p["cot_market_keywords"]
    cfg["cot_exchange_keywords"] = p["cot_exchange_keywords"]
    cfg["oanda_instrument"] = p["oanda_instrument"]
    cfg["demo_start"] = p["demo_start"]
    cfg["demo_vol_frac"] = p["demo_vol_frac"]
    cfg["spread"] = p.get("spread", 0.0)
    cfg["mt5_symbol"] = p.get("mt5_symbol", p["td_symbol"].replace("/", ""))
    return symbol


# ============================================================================
# MAIN
# ============================================================================

def run(mode: str, cfg: dict) -> Signal:
    # --- 0. Resolve the instrument (auto weekday/weekend, or --symbol override) ---
    apply_instrument(cfg, cfg.get("force_symbol") or pick_symbol(cfg))

    # --- 1. Fetch data ---
    if mode == "live":
        price_df = fetch_price_twelvedata(cfg["symbol"], cfg["entry_tf"], cfg["bars"])
        try:
            cot_df = fetch_cot_live(cfg)
        except Exception as ex:
            print(f"[cot] live failed ({ex}); using neutral fallback.", file=sys.stderr)
            cot_df = make_demo_cot()
        try:
            crowd = fetch_crowd_long_pct_oanda(cfg.get("oanda_instrument"))
        except Exception as ex:
            print(f"[mdp] OANDA failed ({ex}); using neutral fallback.", file=sys.stderr)
            crowd = None
        news = check_high_impact_news(cfg)
    else:  # demo — randomized so each run can yield BUY / SELL / NEUTRAL
        master = np.random.default_rng(cfg.get("demo_seed"))   # None = fresh each run
        price_df = make_demo_ohlc(cfg["bars"], seed=int(master.integers(1_000_000_000)),
                                  start=cfg["demo_start"], vol_frac=cfg["demo_vol_frac"],
                                  tf_min=tf_minutes(cfg["entry_tf"]))
        cot_df = make_demo_cot(seed=int(master.integers(1_000_000_000)))
        crowd = float(master.uniform(20.0, 80.0))              # random retail sentiment
        news = "clear (demo)"

    # --- 2. Multi-timeframe: HTF bias + entry-TF timing ---
    htf_df = resample_htf(price_df, cfg["htf"])
    dp_htf = dark_point_signal(htf_df, cfg)          # HTF directional bias
    dp_entry = dark_point_signal(price_df, cfg)      # timing + SL/TP

    # Final Dark Point component = HTF bias + timing combined (HTF acts as a filter)
    dp_combined = ComponentResult(
        name="dark_point",
        score=float(np.clip(0.6 * dp_entry.score + 0.4 * dp_htf.score, -1, 1)),
        quality=(dp_entry.quality + dp_htf.quality) / 2,
        direction=dp_entry.direction,
        detail={"entry_tf": dp_entry.detail, "htf": dp_htf.detail},
    )

    homma = homma_signal(price_df, cfg)
    cot = cot_signal(cot_df, cfg)
    mdp = mdp_proxy_signal(crowd, cfg)

    price = float(price_df["close"].iloc[-1])
    atr_val = float(atr(price_df, cfg["atr_period"]).iloc[-1])
    session = trading_session(dt.datetime.now(dt.timezone.utc))

    sig = combine([dp_combined, homma, cot, mdp], price, atr_val,
                  dp_entry, session, news, cfg)

    # --- 3. Optional Analysis (only high-confidence, actionable signals) ---
    if sig.direction != "NEUTRAL" and sig.confidence > cfg.get("alert_min_confidence", MIN_CONFIDENCE):
        sig.rationale = ai_explain(sig, cfg)
    return sig


def main():
    ap = argparse.ArgumentParser(description="TREFOZERI - XAUUSD Confluence Signal Engine")
    ap.add_argument("--mode", choices=["demo", "live"], default="demo",
                    help="demo = synthetic data without a key; live = real data")
    ap.add_argument("--demo", action="store_true", help="alias for --mode demo")
    ap.add_argument("--live", action="store_true", help="alias for --mode live")
    ap.add_argument("--json", metavar="FILE", default="signal.json",
                    help="JSON output path")
    ap.add_argument("--telegram", action="store_true",
                    help="send the result to Telegram (requires env token & chat id)")
    ap.add_argument("--seed", type=int, default=None,
                    help="fix the demo RNG seed to reproduce a specific scenario")
    ap.add_argument("--symbol", default=None,
                    help="override the auto weekday/weekend instrument (e.g. 'XAU/USD' or 'BTC/USD')")
    ap.add_argument("--mt5-file", default=None,
                    help="also write the signal to this path (point at your MT5 MQL5/Files folder)")
    ap.add_argument("--webhook", default=None,
                    help="also POST the signal JSON to this URL")
    args = ap.parse_args()

    mode = "live" if args.live else ("demo" if args.demo else args.mode)
    CONFIG["demo_seed"] = args.seed       # None -> demo is randomized each run
    CONFIG["force_symbol"] = args.symbol  # None -> auto weekday/weekend selection

    sig = run(mode, CONFIG)
    report = format_report(sig)
    print(report)

    with open(args.json, "w", encoding="utf-8") as f:
        json.dump(asdict(sig), f, ensure_ascii=False, indent=2)
    print(f"\n[saved] {args.json}")

    tg_msg_id = None
    if args.telegram:
        thr = CONFIG.get("alert_min_confidence", MIN_CONFIDENCE)
        if sig.direction != "NEUTRAL" and sig.confidence > thr:
            tg_msg_id = send_telegram(report)
        else:
            print(f"[telegram] skipped — needs a BUY/SELL with confidence > {thr}% "
                  f"(got {sig.direction} {sig.confidence}%).")

    # --- MT5 bridge: write a file (for the EA) and/or POST a webhook ---
    mt5_file = args.mt5_file or os.getenv("MT5_SIGNAL_FILE")
    webhook = args.webhook or os.getenv("WEBHOOK_URL")
    if mt5_file or webhook:
        import mt5_bridge
        mt5_bridge.emit(asdict(sig), CONFIG.get("mt5_symbol", sig.symbol),
                        file_path=mt5_file, webhook_url=webhook, tg_msg_id=tg_msg_id)


if __name__ == "__main__":
    main()
