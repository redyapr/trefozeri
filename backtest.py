#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TREFOZERI - Backtester
===========================================================================
Bar-by-bar historical test of the TREFOZERI confluence engine + entry zone.

It reuses the SAME signal and entry-zone logic from `trefozeri.py` (no copy of
the trading rules), walking the series one candle at a time with NO look-ahead.

Realism (v2):
  * REAL scale-in fills (not the zone mid). The position is two legs:
      - market leg (0.5): fills at the signal bar.
      - limit  leg (0.5): fills only if price touches the pullback edge within
        `entry_valid_bars`; otherwise the trade runs at half size.
    Each leg is managed TP1 (half) -> breakeven -> TP2, with a hard stop and a
    time stop. R is normalized to the planned full-size risk (a full stop = -1R).
  * COSTS: a round-trip cost = spread + entry*cost_bps/1e4 is charged per filled
    leg and subtracted from R.
  * FULL CONFLUENCE (optional, --cot): feeds historical COT, mapped to the most
    recently *completed* COT week per bar (no look-ahead). MDP-proxy stays NEUTRAL
    (no historical retail-sentiment feed exists), so it is a 3-of-4 confluence.

Output: a printed summary + `backtest_trades.csv` + `backtest_summary.json`.

Author : Redy Apriyadi  |  https://bit.ly/trefozeri
Disclaimer: a decision-support tool, NOT financial advice and NOT a profit
guarantee. Past (or simulated) performance does not guarantee future results.
"""

from __future__ import annotations

import json
import argparse
import datetime as dt

import numpy as np
import pandas as pd

import trefozeri as t


# ============================================================================
# DATA
# ============================================================================

def make_bt_ohlc(bars: int, seed: int | None, start: float, vol_frac: float,
                 n_regimes: int = 6, tf_min: int = 15) -> pd.DataFrame:
    """Long synthetic series with several random trend regimes (up/down/choppy),
    so the backtest sees a mix of conditions. Volatility scales to the price."""
    rng = np.random.default_rng(seed)
    unit = start * vol_frac
    seg = bars // n_regimes
    pieces = []
    for k in range(n_regimes):
        n = seg if k < n_regimes - 1 else bars - seg * (n_regimes - 1)
        pieces.append(np.full(n, rng.normal(0.0, unit * 0.14)))
    drift = np.concatenate(pieces)
    vol = rng.uniform(unit * 0.8, unit * 1.3)
    rets = rng.normal(drift, vol, bars)
    close = start + np.cumsum(rets)
    open_ = np.concatenate([[start], close[:-1]])
    high = np.maximum(open_, close) + np.abs(rng.normal(0, unit * 0.8, bars))
    low = np.minimum(open_, close) - np.abs(rng.normal(0, unit * 0.8, bars))
    t0 = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=tf_min * bars)
    times = [t0 + dt.timedelta(minutes=tf_min * i) for i in range(bars)]
    return pd.DataFrame({"datetime": times, "open": open_, "high": high,
                         "low": low, "close": close})


def _to_naive(idx) -> pd.DatetimeIndex:
    idx = pd.DatetimeIndex(idx)
    return idx.tz_convert("UTC").tz_localize(None) if idx.tz is not None else idx


def build_cot_pack(cfg: dict, live: bool, seed: int | None):
    """Precompute a weekly COT ComponentResult series for a full-confluence test.
    Returns (naive_week_dates, [ComponentResult per week]) or None on failure."""
    cot_df = t.fetch_cot_live(cfg) if live else t.make_demo_cot(seed=seed)
    cot_df = cot_df.sort_values("_date").reset_index(drop=True)
    sigs = []
    for w in range(len(cot_df)):
        sub = cot_df.iloc[:w + 1]
        sigs.append(t.cot_signal(sub, cfg) if len(sub) >= 2
                    else t.ComponentResult("cot", 0.0, 0.1, "NEUTRAL", {}))
    return _to_naive(cot_df["_date"]).to_numpy(), sigs


# ============================================================================
# CAUSAL INDICATOR PRECOMPUTE (one pass, no look-ahead)
# ============================================================================

def _bars_since_flip(trend: np.ndarray) -> np.ndarray:
    bsf = np.zeros(len(trend), dtype=int)
    for i in range(1, len(trend)):
        bsf[i] = 0 if trend[i] != trend[i - 1] else bsf[i - 1] + 1
    return bsf


def _dp_score(trend_i: int, bsf_i: int):
    """Mirror of trefozeri.dark_point_signal scoring for a single bar."""
    freshness = max(0.0, 1.0 - bsf_i / 20.0)
    score = float(trend_i) * (0.5 + 0.5 * freshness)
    quality = 0.5 + 0.5 * freshness
    direction = "BUY" if trend_i > 0 else "SELL"
    return score, quality, direction


def _homma_at(o, h, l, c, ema_arr, i, cfg) -> t.ComponentResult:
    """Mirror of trefozeri.homma_signal for bar i, reading precomputed arrays."""
    look = cfg["homma_lookback"]
    up_trend = c[i] > ema_arr[i]
    raw = 0.0
    patterns = 0
    for k in range(1, look + 1):
        ci = i - (k - 1)
        if ci < 2:
            break
        O, H, L, C = o[ci], h[ci], l[ci], c[ci]
        po, pc = o[ci - 1], c[ci - 1]
        body = abs(C - O)
        rng = max(H - L, 1e-9)
        upper = H - max(O, C)
        lower = min(O, C) - L
        recency = 1.0 - (k - 1) / look
        bull = C > O
        if body <= cfg["doji_body_ratio"] * rng:
            if lower >= cfg["long_shadow_ratio"] * body and upper < body:
                raw += 0.6 * recency; patterns += 1
            elif upper >= cfg["long_shadow_ratio"] * body and lower < body:
                raw -= 0.6 * recency; patterns += 1
        if lower >= cfg["long_shadow_ratio"] * body and upper <= body and body > 0:
            raw += 0.8 * recency * (1.3 if not up_trend else 0.8); patterns += 1
        if upper >= cfg["long_shadow_ratio"] * body and lower <= body and body > 0:
            raw += -0.8 * recency * (1.3 if up_trend else 0.8); patterns += 1
        if bull and pc < po and (C >= po) and (O <= pc):
            raw += 0.9 * recency; patterns += 1
        if (not bull) and pc > po and (O >= pc) and (C <= po):
            raw += -0.9 * recency; patterns += 1
        if ci >= 2:
            o2, c2 = o[ci - 2], c[ci - 2]
            small_mid = abs(pc - po) <= 0.5 * abs(c2 - o2)
            if c2 < o2 and small_mid and bull and C > (o2 + c2) / 2:
                raw += 1.0 * recency; patterns += 1
            if c2 > o2 and small_mid and (not bull) and C < (o2 + c2) / 2:
                raw += -1.0 * recency; patterns += 1
    score = float(max(-1.0, min(1.0, raw / 2.0)))
    direction = "BUY" if score > 0.05 else ("SELL" if score < -0.05 else "NEUTRAL")
    quality = min(1.0, abs(score) + 0.15 * patterns)
    return t.ComponentResult("homma", score, quality, direction, {})


# ============================================================================
# TRADE SIMULATION
# ============================================================================

def _sim_leg(direction, l, h, c, N, entry_idx, entry_price, leg_size,
             sl, tp1, tp2, R0, max_hold, spread, cost_bps):
    """Simulate ONE filled leg: TP1 (half of leg) -> breakeven -> TP2, hard stop,
    time stop. R is normalized by R0 (planned full-trade risk). Returns
    (R_net, cost_R, exit_idx). Within a bar the stop is checked before the target."""
    cost_R = leg_size * (spread + entry_price * cost_bps / 1e4) / R0
    half = leg_size / 2.0
    stop = sl
    realized = 0.0
    tp1_done = False
    last = min(N - 1, entry_idx + max_hold)
    for j in range(entry_idx + 1, last + 1):
        lo, hi = l[j], h[j]
        if direction == "BUY":
            if not tp1_done:
                if lo <= stop:
                    return leg_size * (stop - entry_price) / R0 - cost_R, cost_R, j
                if hi >= tp1:
                    realized += half * (tp1 - entry_price) / R0
                    tp1_done = True; stop = entry_price          # breakeven
            else:
                if lo <= stop:
                    return realized + half * (stop - entry_price) / R0 - cost_R, cost_R, j
                if hi >= tp2:
                    return realized + half * (tp2 - entry_price) / R0 - cost_R, cost_R, j
        else:  # SELL
            if not tp1_done:
                if hi >= stop:
                    return leg_size * (entry_price - stop) / R0 - cost_R, cost_R, j
                if lo <= tp1:
                    realized += half * (entry_price - tp1) / R0
                    tp1_done = True; stop = entry_price
            else:
                if hi >= stop:
                    return realized + half * (entry_price - stop) / R0 - cost_R, cost_R, j
                if lo <= tp2:
                    return realized + half * (entry_price - tp2) / R0 - cost_R, cost_R, j
    # time stop: close the remaining size at the last close
    cl = c[last]
    rem = half if tp1_done else leg_size
    move = (cl - entry_price) if direction == "BUY" else (entry_price - cl)
    return realized + rem * move / R0 - cost_R, cost_R, last


def sim_trade(sig, e, l, h, c, N, cfg, max_hold, spread, cost_bps):
    d = sig.direction
    z = sig.entry_zone
    sl, tp1, tp2 = sig.sl, sig.tp1, sig.tp2
    R0 = abs(z["mid"] - sl)
    if R0 <= 0:
        return None
    market_price = z["high"] if d == "BUY" else z["low"]   # fills now
    limit_price = z["low"] if d == "BUY" else z["high"]    # fills on pullback

    R_m, cost_m, exit_m = _sim_leg(d, l, h, c, N, e, market_price, 0.5,
                                   sl, tp1, tp2, R0, max_hold, spread, cost_bps)

    # limit leg fills only if the pullback edge is touched within entry_valid_bars
    fill_bar = None
    last_fill = min(N - 1, e + cfg["entry_valid_bars"])
    for j in range(e + 1, last_fill + 1):
        if (d == "BUY" and l[j] <= limit_price) or (d == "SELL" and h[j] >= limit_price):
            fill_bar = j
            break
    if fill_bar is not None:
        R_l, cost_l, exit_l = _sim_leg(d, l, h, c, N, fill_bar, limit_price, 0.5,
                                       sl, tp1, tp2, R0, max_hold, spread, cost_bps)
        legs = 2
    else:
        R_l, cost_l, exit_l = 0.0, 0.0, exit_m
        legs = 1

    return {"entry_time": None, "dir": d,   # entry_time set by caller (real bar datetime)
            "market": round(market_price, 2), "limit": round(limit_price, 2),
            "sl": sl, "tp1": tp1, "tp2": tp2, "legs_filled": legs,
            "R": round(R_m + R_l, 3), "cost_R": round(cost_m + cost_l, 4),
            "bars": max(exit_m, exit_l) - e, "entry_idx": e,
            "exit_idx": max(exit_m, exit_l)}


# ============================================================================
# BACKTEST DRIVER
# ============================================================================

def backtest(df: pd.DataFrame, cfg: dict, max_hold: int = 60,
             spread: float = 0.0, cost_bps: float = 0.0, cot_pack=None,
             start_bar=None) -> dict:
    df = df.reset_index(drop=True)
    o = df["open"].to_numpy(float); h = df["high"].to_numpy(float)
    l = df["low"].to_numpy(float);  c = df["close"].to_numpy(float)
    N = len(df)

    atr_e = t.atr(df, cfg["atr_period"]).to_numpy(float)
    dp_e = t.dark_point(df, cfg["atr_period"], cfg["dp_multiplier"])
    trend_e = dp_e["dp_trend"].to_numpy(int)
    line_e = dp_e["dp_line"].to_numpy(float)
    bsf_e = _bars_since_flip(trend_e)
    ema_e = t.ema(df["close"], cfg["trend_ema"]).to_numpy(float)

    htf = t.resample_htf(df, cfg["htf"])
    dp_h = t.dark_point(htf, cfg["atr_period"], cfg["dp_multiplier"])
    trend_h = dp_h["dp_trend"].to_numpy(int)
    bsf_h = _bars_since_flip(trend_h)
    # most recently *completed* HTF bar at each entry bar (shift back one HTF duration)
    htf_dur = pd.Timedelta(cfg["htf"])
    htf_idx = np.asarray(pd.DatetimeIndex(htf["datetime"]).searchsorted(
        pd.DatetimeIndex(df["datetime"]) - htf_dur, side="right")) - 1

    cot_neutral = t.ComponentResult("cot", 0.0, 0.1, "NEUTRAL", {})
    mdp_neutral = t.ComponentResult("mdp_proxy", 0.0, 0.1, "NEUTRAL", {})
    cot_map = cot_sigs = None
    if cot_pack is not None:
        cot_dates, cot_sigs = cot_pack
        cot_map = np.searchsorted(cot_dates, _to_naive(df["datetime"]).to_numpy(),
                                  side="right") - 1

    def signal_at(i: int):
        s_e, q_e, d_e = _dp_score(trend_e[i], bsf_e[i])
        hi_ = max(0, int(htf_idx[i]))
        s_h, q_h, _ = _dp_score(trend_h[hi_], bsf_h[hi_])
        dp_combined = t.ComponentResult(
            "dark_point", float(np.clip(0.6 * s_e + 0.4 * s_h, -1, 1)),
            (q_e + q_h) / 2, d_e, {})
        dp_entry = t.ComponentResult("dark_point", s_e, q_e, d_e, {"line": float(line_e[i])})
        homma = _homma_at(o, h, l, c, ema_e, i, cfg)
        cot = cot_neutral
        if cot_map is not None and cot_map[i] >= 0:
            cot = cot_sigs[cot_map[i]]
        return t.combine([dp_combined, homma, cot, mdp_neutral],
                         float(c[i]), float(atr_e[i]), dp_entry, "", "clear", cfg)

    trades = []
    # start_bar lets walk-forward prepend a warmup prefix and trade only the OOS part
    start_idx = start_bar if start_bar is not None else max(cfg["trend_ema"] + 5, 64)
    i = start_idx
    while i < N - 1:
        sig = signal_at(i)
        if sig.direction in ("BUY", "SELL") and sig.entry_zone:
            tr = sim_trade(sig, i, l, h, c, N, cfg, max_hold, spread, cost_bps)
            if tr:
                tr["entry_time"] = str(df["datetime"].iloc[i])  # real bar time, not run time
                trades.append(tr)
                i = tr["exit_idx"] + 1
                continue
        i += 1

    return _metrics(trades, N, start_idx, cfg, spread, cost_bps, cot_pack is not None)


def _metrics(trades, N, start_idx, cfg, spread, cost_bps, cot_on) -> dict:
    R = np.array([tr["R"] for tr in trades], dtype=float)
    cost = np.array([tr["cost_R"] for tr in trades], dtype=float)
    n = len(R)
    wins = int((R > 0).sum())
    gross_win = float(R[R > 0].sum())
    gross_loss = float(-R[R < 0].sum())
    eq = np.cumsum(R) if n else np.array([0.0])
    max_dd = float((np.maximum.accumulate(eq) - eq).max()) if n else 0.0
    by = {}
    for d in ("BUY", "SELL"):
        rr = [tr["R"] for tr in trades if tr["dir"] == d]
        by[d] = {"trades": len(rr), "avg_R": round(float(np.mean(rr)), 3) if rr else 0.0}
    full = sum(1 for tr in trades if tr["legs_filled"] == 2)
    return {
        "symbol": cfg["symbol"],
        "confluence": "DarkPoint+Homma+COT (MDP neutral)" if cot_on else "DarkPoint+Homma (price only)",
        "costs": {"spread": spread, "cost_bps": cost_bps},
        "bars_tested": N - start_idx,
        "trades": n,
        "win_rate_pct": round(100 * wins / n, 1) if n else 0.0,
        "expectancy_R": round(float(R.mean()), 3) if n else 0.0,
        "total_R": round(float(R.sum()), 2) if n else 0.0,
        "gross_R_before_costs": round(float(R.sum() + cost.sum()), 2) if n else 0.0,
        "cost_drag_R": round(float(cost.sum()), 2) if n else 0.0,
        "profit_factor": round(gross_win / gross_loss, 2) if gross_loss > 0 else None,
        "max_drawdown_R": round(max_dd, 2),
        "limit_fill_rate_pct": round(100 * full / n, 1) if n else 0.0,
        "avg_bars_held": round(float(np.mean([tr["bars"] for tr in trades])), 1) if n else 0.0,
        "by_direction": by,
        "trades_detail": trades,
    }


def print_summary(m: dict):
    print("=" * 60)
    print(f"  TREFOZERI Backtest — {m['symbol']}")
    print("=" * 60)
    print(f"  Confluence     : {m['confluence']}")
    print(f"  Costs          : spread {m['costs']['spread']}  +  {m['costs']['cost_bps']} bps")
    print(f"  Bars tested    : {m['bars_tested']}")
    print(f"  Trades         : {m['trades']}   (both legs filled: {m['limit_fill_rate_pct']}%)")
    print(f"  Win rate       : {m['win_rate_pct']}%")
    print(f"  Expectancy     : {m['expectancy_R']} R / trade")
    print(f"  Total (net)    : {m['total_R']} R   "
          f"(gross {m['gross_R_before_costs']} R, cost drag {m['cost_drag_R']} R)")
    print(f"  Profit factor  : {m['profit_factor']}")
    print(f"  Max drawdown   : {m['max_drawdown_R']} R")
    print(f"  Avg hold       : {m['avg_bars_held']} bars")
    print(f"  By direction   : BUY {m['by_direction']['BUY']}  |  SELL {m['by_direction']['SELL']}")
    print("=" * 60)
    print("  R = risk units (a full stop = -1R). MDP-proxy is held neutral (no")
    print("  historical sentiment). Demo data is synthetic & trend-rich, so results")
    print("  flatter a trend-follower — validate on --live data. Not financial advice.")


# ============================================================================
# ROBUSTNESS: parameter sweep + walk-forward
# ============================================================================

def parse_range(spec: str):
    """'NAME:START:STOP:STEP' -> (name, [values...]) inclusive of stop."""
    try:
        name, a, b, s = spec.split(":")
        start, stop, step = float(a), float(b), float(s)
    except ValueError:
        raise SystemExit("Range must be NAME:START:STOP:STEP, e.g. dp_multiplier:2:4:0.25")
    if step <= 0:
        raise SystemExit("STEP must be > 0")
    n = int(round((stop - start) / step)) + 1
    return name, [round(start + k * step, 6) for k in range(max(1, n))]


def _with_param(cfg: dict, name: str, value):
    """Copy cfg with one top-level key changed (int-cast if the key holds an int)."""
    if name not in cfg:
        raise SystemExit(f"Unknown parameter '{name}'. Use a top-level CONFIG key.")
    c = dict(cfg)
    c[name] = int(round(value)) if isinstance(cfg[name], int) else float(value)
    return c


def run_sweep(df, cfg, name, values, max_hold, spread, cost_bps, cot_pack):
    """Backtest once per value of `name` — does the edge hold across the range?"""
    rows = []
    for v in values:
        c = _with_param(cfg, name, v)
        m = backtest(df, c, max_hold=max_hold, spread=spread,
                     cost_bps=cost_bps, cot_pack=cot_pack)
        rows.append({"value": c[name], "trades": m["trades"], "win_rate_pct": m["win_rate_pct"],
                     "expectancy_R": m["expectancy_R"], "total_R": m["total_R"],
                     "profit_factor": m["profit_factor"], "max_drawdown_R": m["max_drawdown_R"]})
    print("=" * 72)
    print(f"  Parameter sweep — {name}   ({cfg['symbol']})")
    print("=" * 72)
    print(f"  {'value':>12} | trades | win% | exp R | total R |  PF  | maxDD R")
    print("  " + "-" * 62)
    for r in rows:
        pf = "-" if r["profit_factor"] is None else r["profit_factor"]
        print(f"  {r['value']:>12} | {r['trades']:>6} | {r['win_rate_pct']:>4} | "
              f"{r['expectancy_R']:>5} | {r['total_R']:>7} | {pf:>4} | {r['max_drawdown_R']:>6}")
    exps = [r["expectancy_R"] for r in rows]
    pos = sum(1 for e in exps if e > 0)
    print("  " + "-" * 62)
    print(f"  Robustness: {pos}/{len(rows)} values positive | exp R "
          f"min {min(exps)} / median {sorted(exps)[len(exps) // 2]} / max {max(exps)}.")
    print("  A broad plateau of positive values = robust; a lone spike = likely overfit.")
    return {"mode": "sweep", "param": name, "symbol": cfg["symbol"], "rows": rows}


def run_walkforward(df, cfg, name, values, is_bars, oos_bars, max_hold, spread,
                    cost_bps, cot_pack, metric="total_R"):
    """Optimize `name` on each in-sample window, trade it on the next (unseen)
    out-of-sample window, roll forward, and aggregate the OOS results."""
    N = len(df)
    warm = max(cfg["trend_ema"] + 5, 64)
    if is_bars <= warm:
        raise SystemExit(f"--is-bars ({is_bars}) must exceed the warmup ({warm}).")
    if N < is_bars + oos_bars:
        raise SystemExit(f"Need >= {is_bars + oos_bars} bars; got {N}. Increase --bars.")

    steps, oos_trades = [], []
    pos = 0
    while pos + is_bars + oos_bars <= N:
        is_df = df.iloc[pos:pos + is_bars]
        best_v, best_score = None, None
        for v in values:
            c = _with_param(cfg, name, v)
            mis = backtest(is_df, c, max_hold=max_hold, spread=spread,
                           cost_bps=cost_bps, cot_pack=cot_pack)
            score = mis.get(metric)
            score = -1e18 if score is None else score
            if best_score is None or score > best_score:
                best_score, best_v = score, c[name]
        # OOS: prepend `warm` bars of the IS tail for indicator warmup; trade from there
        c = _with_param(cfg, name, best_v)
        oos_df = df.iloc[pos + is_bars - warm: pos + is_bars + oos_bars]
        moos = backtest(oos_df, c, max_hold=max_hold, spread=spread,
                        cost_bps=cost_bps, cot_pack=cot_pack, start_bar=warm)
        steps.append({"step": len(steps) + 1, "chosen": best_v,
                      "is_score": round(float(best_score), 2), "oos_trades": moos["trades"],
                      "oos_total_R": moos["total_R"], "oos_expectancy_R": moos["expectancy_R"]})
        oos_trades += moos["trades_detail"]
        pos += oos_bars

    R = np.array([tr["R"] for tr in oos_trades], dtype=float)
    n = len(R)
    gw = float(R[R > 0].sum()); gl = float(-R[R < 0].sum())
    eq = np.cumsum(R) if n else np.array([0.0])
    maxdd = float((np.maximum.accumulate(eq) - eq).max()) if n else 0.0
    is_avg = float(np.mean([s["is_score"] for s in steps])) if steps else 0.0
    oos_avg = float(np.mean([s["oos_total_R"] for s in steps])) if steps else 0.0
    eff = round(oos_avg / is_avg, 2) if is_avg > 0 else None
    pf = round(gw / gl, 2) if gl > 0 else None

    print("=" * 72)
    print(f"  Walk-forward — optimize {name} on {metric}   ({cfg['symbol']})")
    print(f"  in-sample {is_bars} bars -> out-of-sample {oos_bars} bars, rolling")
    print("=" * 72)
    print("  step | chosen | IS score | OOS trades | OOS total R | OOS exp R")
    print("  " + "-" * 60)
    for s in steps:
        print(f"  {s['step']:>4} | {s['chosen']:>6} | {s['is_score']:>8} | "
              f"{s['oos_trades']:>10} | {s['oos_total_R']:>11} | {s['oos_expectancy_R']:>9}")
    print("  " + "-" * 60)
    print(f"  OUT-OF-SAMPLE total: {n} trades | "
          f"win {round(100 * int((R > 0).sum()) / n, 1) if n else 0}% | "
          f"expectancy {round(float(R.mean()), 3) if n else 0} R | "
          f"total {round(float(R.sum()), 2) if n else 0} R | PF {pf} | maxDD {round(maxdd, 2)} R")
    print(f"  Walk-forward efficiency (avg OOS / avg IS total R per window): {eff}")
    print("  Positive OOS total after costs = edge survived unseen data; efficiency")
    print("  near/above 1 = robust, well below = overfit. Not financial advice.")
    return {"mode": "walkforward", "param": name, "metric": metric, "symbol": cfg["symbol"],
            "is_bars": is_bars, "oos_bars": oos_bars, "steps": steps, "oos_trades": n,
            "oos_total_R": round(float(R.sum()), 2) if n else 0.0,
            "oos_expectancy_R": round(float(R.mean()), 3) if n else 0.0,
            "oos_profit_factor": pf, "oos_max_drawdown_R": round(maxdd, 2),
            "wf_efficiency": eff}


# ============================================================================
# MAIN
# ============================================================================

def main():
    ap = argparse.ArgumentParser(description="TREFOZERI confluence backtester")
    ap.add_argument("--demo", action="store_true", help="synthetic data (default)")
    ap.add_argument("--live", action="store_true", help="real data from TwelveData")
    ap.add_argument("--bars", type=int, default=1500, help="number of candles to test")
    ap.add_argument("--seed", type=int, default=None, help="fix the demo RNG seed")
    ap.add_argument("--symbol", default=None,
                    help="instrument (default: auto weekday/weekend). e.g. 'XAU/USD' or 'BTC/USD'")
    ap.add_argument("--max-hold", type=int, default=60, help="max bars to hold a trade")
    ap.add_argument("--cot", action="store_true",
                    help="full confluence: feed historical COT (else price-only)")
    ap.add_argument("--spread", type=float, default=None,
                    help="bid/ask spread in price (default: per-instrument)")
    ap.add_argument("--cost-bps", type=float, default=0.0,
                    help="extra round-trip commission in basis points of price")
    ap.add_argument("--csv", default="backtest_trades.csv", help="trades CSV output path")
    ap.add_argument("--json", default="backtest_summary.json", help="summary JSON output path")
    ap.add_argument("--sweep", default=None, metavar="P:START:STOP:STEP",
                    help="robustness sweep of one CONFIG param, e.g. dp_multiplier:2:4:0.25")
    ap.add_argument("--walkforward", default=None, metavar="P:START:STOP:STEP",
                    help="walk-forward: optimize one param in-sample, test out-of-sample")
    ap.add_argument("--is-bars", type=int, default=800, help="walk-forward in-sample window")
    ap.add_argument("--oos-bars", type=int, default=200, help="walk-forward out-of-sample window")
    ap.add_argument("--wf-metric", default="total_R",
                    choices=["total_R", "expectancy_R", "profit_factor"],
                    help="metric optimized in-sample during walk-forward")
    args = ap.parse_args()

    cfg = dict(t.CONFIG)
    t.apply_instrument(cfg, args.symbol or t.pick_symbol(cfg))
    spread = args.spread if args.spread is not None else cfg.get("spread", 0.0)

    if args.live:
        df = t.fetch_price_twelvedata(cfg["symbol"], cfg["entry_tf"], args.bars)
    else:
        df = make_bt_ohlc(args.bars, args.seed, cfg["demo_start"], cfg["demo_vol_frac"],
                          tf_min=t.tf_minutes(cfg["entry_tf"]))

    cot_pack = None
    if args.cot:
        try:
            cot_pack = build_cot_pack(cfg, args.live, args.seed)
        except Exception as ex:
            print(f"[cot] could not build COT feed ({type(ex).__name__}); price-only.")

    if args.sweep:
        name, values = parse_range(args.sweep)
        res = run_sweep(df, cfg, name, values, args.max_hold, spread, args.cost_bps, cot_pack)
        with open("sweep_summary.json", "w", encoding="utf-8") as f:
            json.dump(res, f, ensure_ascii=False, indent=2)
        print("\n[saved] sweep_summary.json")
        return
    if args.walkforward:
        name, values = parse_range(args.walkforward)
        res = run_walkforward(df, cfg, name, values, args.is_bars, args.oos_bars,
                              args.max_hold, spread, args.cost_bps, cot_pack, args.wf_metric)
        with open("walkforward_summary.json", "w", encoding="utf-8") as f:
            json.dump(res, f, ensure_ascii=False, indent=2)
        print("\n[saved] walkforward_summary.json")
        return

    m = backtest(df, cfg, max_hold=args.max_hold, spread=spread,
                 cost_bps=args.cost_bps, cot_pack=cot_pack)
    print_summary(m)

    pd.DataFrame(m["trades_detail"]).to_csv(args.csv, index=False)
    with open(args.json, "w", encoding="utf-8") as f:
        json.dump({k: v for k, v in m.items() if k != "trades_detail"}, f,
                  ensure_ascii=False, indent=2)
    print(f"\n[saved] {args.csv}  &  {args.json}")


if __name__ == "__main__":
    main()
