#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TREFOZERI - MT5 bridge
===========================================================================
Emits a signal to MetaTrader 5 (for auto-execution by an EA) two ways:

  * FILE  : an atomic one-line contract written into the terminal's MQL5/Files
            folder. The `TrefozeriBridge.mq5` EA reads it on a timer.
  * WEBHOOK: the full signal as JSON, POSTed to a URL (for a dashboard/relay).

Compact file contract (one line, ';'-separated) — easy to parse in MQL5:

  schema;id;symbol;direction;confidence;market;limit;sl;tp1;tp2;tp3;valid_bars;tg_msg_id

  - schema     : "TREFOZERI1" (version tag)
  - id         : the signal timestamp; the EA acts on each id only once
  - symbol     : MT5 symbol (e.g. XAUUSD) — add a broker suffix in the EA if needed
  - direction  : BUY | SELL | NEUTRAL  (EA ignores NEUTRAL / cancels stale pendings)
  - confidence : 0..100
  - market     : the market-half entry price (blank if NEUTRAL)
  - limit      : the pullback limit-half entry price (blank if NEUTRAL)
  - sl/tp1/tp2/tp3 : levels (blank if NEUTRAL; tp3 is the final broker target)
  - valid_bars : how many bars the pullback limit stays valid
  - tg_msg_id  : Telegram message_id of the signal alert (EA replies to it on
                 close; blank when no alert was sent)

The file is written atomically (temp + os.replace) so the EA never reads a
half-written line.

Disclaimer: auto-execution risks real money. Test on a DEMO account first.
"""

from __future__ import annotations

import os
import sys

SCHEMA = "TREFOZERI1"


def to_contract_line(sig: dict, mt5_symbol: str, tg_msg_id=None) -> str:
    """Render the signal as the compact one-line file contract."""
    market = limit = ""
    for e in (sig.get("entries") or []):
        if e.get("type") == "market":
            market = e.get("price", "")
        elif e.get("type") == "limit":
            limit = e.get("price", "")

    def s(v):
        return "" if v is None else v

    fields = [SCHEMA, sig.get("timestamp", ""), mt5_symbol,
              sig.get("direction", "NEUTRAL"), sig.get("confidence", 0),
              s(market), s(limit), s(sig.get("sl")), s(sig.get("tp1")),
              s(sig.get("tp2")), s(sig.get("tp3")), sig.get("valid_bars", 0), s(tg_msg_id)]
    return ";".join(str(x) for x in fields)


def _atomic_write(path: str, text: str) -> None:
    """Write to a temp file then replace, so readers never see a partial file."""
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="ascii", errors="replace", newline="\n") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _post(url: str, payload: dict) -> None:
    """POST JSON to a webhook; never let a webhook failure crash the engine."""
    try:
        import requests
        requests.post(url, json=payload, timeout=10)
    except Exception as ex:
        print(f"[webhook] failed: {type(ex).__name__}", file=sys.stderr)


def emit(sig: dict, mt5_symbol: str, file_path: str | None = None,
         webhook_url: str | None = None, tg_msg_id=None) -> str:
    """Write the file contract and/or POST the webhook. Returns the contract line."""
    line = to_contract_line(sig, mt5_symbol, tg_msg_id)
    if file_path:
        # file_path may list several destinations separated by commas (e.g. two MT5
        # terminals / Wine prefixes) — write the same contract to each, atomically.
        for path in [p.strip() for p in str(file_path).split(",") if p.strip()]:
            try:
                _atomic_write(path, line + "\n")
                print(f"[mt5] wrote {path}")
            except Exception as ex:
                print(f"[mt5] file write failed for {path}: {type(ex).__name__}", file=sys.stderr)
    if webhook_url:
        _post(webhook_url, {**sig, "mt5_symbol": mt5_symbol,
                            "tg_msg_id": tg_msg_id, "contract": line})
        print(f"[webhook] posted to {webhook_url}")
    return line


if __name__ == "__main__":
    # quick self-test of the contract format
    demo = {"timestamp": "2026-06-27T08:00:00+00:00", "direction": "BUY",
            "confidence": 72.2, "sl": 3312.5, "tp1": 3325.0, "tp2": 3332.5,
            "valid_bars": 8,
            "entries": [{"portion": 0.5, "type": "market", "price": 3320.0},
                        {"portion": 0.5, "type": "limit", "price": 3315.0}]}
    print(to_contract_line(demo, "XAUUSD"))
