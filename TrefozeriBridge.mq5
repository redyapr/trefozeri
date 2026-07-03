//+------------------------------------------------------------------+
//|                                            TrefozeriBridge.mq5    |
//|   Reads TREFOZERI signals from MQL5/Files and auto-executes them. |
//|   Author: Redy Apriyadi   https://bit.ly/trefozeri               |
//|                                                                  |
//|   Management: TP1 -> partial + SL to mid(entry,TP1);             |
//|               TP2 -> partial + SL to mid(TP1,TP2);               |
//|               mid(TP2,TP3) -> SL to TP2 (trail, no partial);     |
//|               TP3 -> final target (broker TP).                   |
//|   If a partial can't meet the broker min lot, it FULL-closes.    |
//|   Each position carries "TP1;TP2;msgid" in its comment, so the   |
//|   Telegram reply is always correct (even after an EA restart or  |
//|   with several same-direction trades).                           |
//|                                                                  |
//|   SAFETY: test on a DEMO account first. Not investment advice.   |
//+------------------------------------------------------------------+
#property copyright "Redy Apriyadi"
#property link "https://bit.ly/trefozeri"
#property version "1.10"
#property strict

#include <Trade/Trade.mqh>

enum RiskModeEnum { RISK_PERCENT = 0, RISK_FIXED = 1 };

input string SignalFile = "trefozeri_signal.txt"; // file inside MQL5/Files
input bool UseCommonFolder = false; // read from shared Common\Files instead
input bool DryRun = false;          // SAFETY: log only, place nothing
input double MinConfidence = 40.0;  // ignore signals at/below this confidence
input int PollSeconds = 1;          // how often to check the file
input int MaxSignalAgeMin = 15;     // ignore signals older than this (stale)
input long MagicNumber = 57765566;
input int Deviation = 20;       // max slippage (points)
input int MaxSpreadPoints = 0;  // skip if spread wider than this (0 = off)
input string SymbolSuffix = ""; // e.g. ".r" / ".pro" if your broker adds one
input RiskModeEnum RiskMode = RISK_PERCENT;
input double RiskPercent = 2.0;       // % of balance risked per signal
input double FixedLots = 0.01;        // used when RiskMode = RISK_FIXED
input double MaxMarginPercent = 20.0; // cap: use at most this % of free margin
input bool UseLimitLeg = true;        // also place the pullback (limit) half
input bool AllowSameDirStack =
    true; // allow a new same-direction entry while one is open
input bool ManagePartials = true;    // TP1/TP2 partial closes + SL laddering
input double TP1ClosePercent = 50.0; // % of the position closed at TP1
input double TP2ClosePercent = 50.0; // % of the remainder closed at TP2
input int BarMinutes = 5;            // entry timeframe (pending-order expiry)
// --- Telegram (whitelist https://api.telegram.org in MT5 Options) ---
input bool EnableTelegram = false; // notify Telegram on TP1/TP2/TP3/SL
input string TelegramToken = "";   // bot token (same bot as the engine is fine)
input string TelegramChatId =
    ""; // chat id (MUST match the engine's chat for replies)

CTrade trade;
string g_lastId = ""; // last processed signal id (file de-dup)
long g_pingTp1[];     // msgids that already sent a TP1 ping
long g_pingTp2[];     // msgids that already sent a TP2 ping
long g_pingClose[];   // msgids that already sent a final close ping
// per-position params read once from (immutable) history: id -> TP1, TP2,
// msgid. history is used instead of the live comment, which some brokers alter
// on a partial close.
ulong g_cId[];
double g_cTp1[];
double g_cTp2[];
long g_cMsg[];

//+------------------------------------------------------------------+
int OnInit() {
  trade.SetExpertMagicNumber(MagicNumber);
  trade.SetDeviationInPoints(Deviation);
  EventSetTimer(MathMax(1, PollSeconds));
  PrintFormat("TrefozeriBridge started. DryRun=%s, file=%s", (string)DryRun,
              SignalFile);
  return (INIT_SUCCEEDED);
}

void OnDeinit(const int reason) { EventKillTimer(); }

void OnTimer() {
  ProcessSignal();
  if (ManagePartials)
    ManageTP();
}

//+------------------------------------------------------------------+
//| "2026-06-27T08:00:00+00:00" -> datetime (UTC/GMT)                |
//+------------------------------------------------------------------+
datetime IsoToTime(string iso) {
  string s = iso;
  StringReplace(s, "-", ".");
  StringReplace(s, "T", " ");
  StringReplace(s, "Z", "");
  int plus = StringFind(s, "+");
  if (plus > 0)
    s = StringSubstr(s, 0, plus);
  return StringToTime(s);
}

//+------------------------------------------------------------------+
//| small helpers                                                    |
//+------------------------------------------------------------------+
bool InLong(long &arr[], long v) {
  for (int i = 0; i < ArraySize(arr); i++)
    if (arr[i] == v)
      return true;
  return false;
}
void AddLong(long &arr[], long v) {
  if (InLong(arr, v))
    return;
  int n = ArraySize(arr);
  ArrayResize(arr, n + 1);
  arr[n] = v;
}

// order/position comment format is "TP1;TP2;msgid"
void SplitComment(string cmt, double &tp1, double &tp2, long &msg) {
  tp1 = 0;
  tp2 = 0;
  msg = 0;
  string p[];
  int n = StringSplit(cmt, ';', p);
  if (n >= 1)
    tp1 = StringToDouble(p[0]);
  if (n >= 2)
    tp2 = StringToDouble(p[1]);
  if (n >= 3)
    msg = (long)StringToInteger(p[2]);
}

// msgid of a (possibly closed) position, read from its entry deal's comment
long PositionMsgId(ulong posId) {
  if (!HistorySelectByPosition(posId))
    return 0;
  int total = HistoryDealsTotal();
  for (int i = 0; i < total; i++) {
    ulong dt = HistoryDealGetTicket(i);
    if (HistoryDealGetInteger(dt, DEAL_ENTRY) == DEAL_ENTRY_IN) {
      double a, b;
      long m;
      SplitComment(HistoryDealGetString(dt, DEAL_COMMENT), a, b, m);
      return m;
    }
  }
  return 0;
}

// TP1/TP2/msgid for a position, read once from its entry deal (history), then
// cached.
bool LoadParams(ulong posId, double &tp1, double &tp2, long &msg) {
  for (int i = 0; i < ArraySize(g_cId); i++)
    if (g_cId[i] == posId) {
      tp1 = g_cTp1[i];
      tp2 = g_cTp2[i];
      msg = g_cMsg[i];
      return (tp1 > 0);
    }
  tp1 = 0;
  tp2 = 0;
  msg = 0;
  if (HistorySelectByPosition(posId)) {
    int total = HistoryDealsTotal();
    for (int i = 0; i < total; i++) {
      ulong dt = HistoryDealGetTicket(i);
      if (HistoryDealGetInteger(dt, DEAL_ENTRY) == DEAL_ENTRY_IN) {
        SplitComment(HistoryDealGetString(dt, DEAL_COMMENT), tp1, tp2, msg);
        break;
      }
    }
  }
  if (tp1 > 0) { // cache only a valid read
    int n = ArraySize(g_cId);
    ArrayResize(g_cId, n + 1);
    ArrayResize(g_cTp1, n + 1);
    ArrayResize(g_cTp2, n + 1);
    ArrayResize(g_cMsg, n + 1);
    g_cId[n] = posId;
    g_cTp1[n] = tp1;
    g_cTp2[n] = tp2;
    g_cMsg[n] = msg;
  }
  return (tp1 > 0);
}

void Ping(long &seen[], long msg, string text) {
  if (msg > 0 && InLong(seen, msg))
    return; // already pinged this trade
  if (msg > 0)
    AddLong(seen, msg);
  SendTelegram(text, msg);
}

//+------------------------------------------------------------------+
//| Read the signal file, then execute if it is new & valid          |
//+------------------------------------------------------------------+
void ProcessSignal() {
  int flags = FILE_READ | FILE_TXT | FILE_ANSI;
  if (UseCommonFolder)
    flags |= FILE_COMMON;
  int fh = FileOpen(SignalFile, flags);
  if (fh == INVALID_HANDLE)
    return;
  string line = FileReadString(fh);
  FileClose(fh);
  if (StringLen(line) < 5)
    return;

  string p[];
  int n = StringSplit(line, (ushort)';', p);
  if (n < 13 || p[0] != "TREFOZERI1")
    return; // not our schema

  string id = p[1];
  string dir = p[3];
  double conf = StringToDouble(p[4]);
  double market = StringToDouble(p[5]);
  double limitp = StringToDouble(p[6]);
  double sl = StringToDouble(p[7]);
  double tp1 = StringToDouble(p[8]);
  double tp2 = StringToDouble(p[9]);
  double tp3 = StringToDouble(p[10]);
  int validBars = (int)StringToInteger(p[11]);
  long msgid = (long)StringToInteger(p[12]);

  if (id == g_lastId)
    return; // already handled this signal
  g_lastId = id;

  string sym = p[2] + SymbolSuffix;
  if (dir != "BUY" && dir != "SELL") { // NEUTRAL -> drop stale pendings
    CancelPendings(sym);
    return;
  }
  if (conf <= MinConfidence)
    return;
  if (MaxSignalAgeMin > 0) {
    datetime st = IsoToTime(id);
    if (st > 0 && (TimeGMT() - st) > MaxSignalAgeMin * 60) {
      Print("Signal too old, skipped.");
      return;
    }
  }
  if (!SymbolSelect(sym, true)) {
    PrintFormat("Symbol %s not found.", sym);
    return;
  }

  string exposure = ExposureDir(sym);
  if (exposure == dir && !AllowSameDirStack)
    return; // same-direction trade already live and stacking disabled
  if (exposure != "" && exposure != dir)
    CloseAndCancelAll(sym); // opposite signal -> close & reverse

  if (MaxSpreadPoints > 0) {
    double sp = (SymbolInfoDouble(sym, SYMBOL_ASK) -
                 SymbolInfoDouble(sym, SYMBOL_BID)) /
                SymbolInfoDouble(sym, SYMBOL_POINT);
    if (sp > MaxSpreadPoints) {
      PrintFormat("Spread %.0f > max, skipped.", sp);
      return;
    }
  }

  ExecuteSignal(sym, dir, market, limitp, sl, tp1, tp2, tp3, validBars, msgid);
}

//+------------------------------------------------------------------+
void ExecuteSignal(string sym, string dir, double market, double limitp,
                   double sl, double tp1, double tp2, double tp3, int validBars,
                   long msgid) {
  int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
  double slN = NormalizeDouble(sl, digits);
  double tp3N =
      NormalizeDouble(tp3, digits); // broker take-profit = final target
  // comment carries TP1;TP2;msgid so ManageTP + the close alert know them per
  // position
  string cmt = DoubleToString(NormalizeDouble(tp1, digits), digits) + ";" +
               DoubleToString(NormalizeDouble(tp2, digits), digits) + ";" +
               IntegerToString(msgid);
  double refEntry = (market > 0) ? market : SymbolInfoDouble(sym, SYMBOL_ASK);
  double slDist = MathAbs(refEntry - sl);
  if (slDist <= 0) {
    Print("Bad SL distance, skipped.");
    return;
  }

  double lots = ComputeLots(sym, slDist);
  double minL = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
  double lotsMkt = lots, lotsLim = 0.0;
  if (UseLimitLeg && lots >= 2 * minL) {
    lotsMkt = NormalizeLots(sym, lots * 0.5);
    lotsLim = NormalizeLots(sym, lots - lotsMkt);
  }

  if (DryRun) {
    PrintFormat(
        "[DRY] %s %s lots=%.2f (mkt %.2f/lim %.2f) SL=%.*f TP3=%.*f cmt=%s",
        dir, sym, lots, lotsMkt, lotsLim, digits, slN, digits, tp3N, cmt);
    return;
  }

  bool isBuy = (dir == "BUY");
  trade.SetTypeFillingBySymbol(sym);

  double point = SymbolInfoDouble(sym, SYMBOL_POINT);
  double stopsLvl =
      (double)SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL) * point;
  double mref = isBuy ? SymbolInfoDouble(sym, SYMBOL_ASK)
                      : SymbolInfoDouble(sym, SYMBOL_BID);
  if (stopsLvl > 0 &&
      (MathAbs(mref - slN) < stopsLvl || MathAbs(tp3N - mref) < stopsLvl))
    PrintFormat("WARN %s: SL/TP within broker stops level (%.0f pts) — order "
                "may be rejected.",
                dir, stopsLvl / point);

  bool ok = isBuy ? trade.Buy(lotsMkt, sym, 0.0, slN, tp3N, cmt)
                  : trade.Sell(lotsMkt, sym, 0.0, slN, tp3N, cmt);
  if (ok)
    Print("Market ", dir, " ok: ticket=", trade.ResultOrder());
  else
    Print("Market ", dir, " FAILED: retcode=", trade.ResultRetcode(), " (",
          trade.ResultRetcodeDescription(), ")");

  if (lotsLim > 0 && limitp > 0) {
    datetime exp =
        TimeCurrent() + MathMax(1, validBars) * MathMax(1, BarMinutes) * 60;
    double limN = NormalizeDouble(limitp, digits);
    bool okl = isBuy ? trade.BuyLimit(lotsLim, limN, sym, slN, tp3N,
                                      ORDER_TIME_SPECIFIED, exp, cmt)
                     : trade.SellLimit(lotsLim, limN, sym, slN, tp3N,
                                       ORDER_TIME_SPECIFIED, exp, cmt);
    if (!okl)
      Print("Limit ", dir, " FAILED: retcode=", trade.ResultRetcode(), " (",
            trade.ResultRetcodeDescription(), ")");
  }
}

//+------------------------------------------------------------------+
double ComputeLots(string sym, double slDistPrice) {
  if (RiskMode == RISK_FIXED)
    return NormalizeLots(sym, FixedLots);
  double balance = AccountInfoDouble(ACCOUNT_BALANCE);
  double riskCash = balance * RiskPercent / 100.0;
  double tickVal = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE);
  double tickSize = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE);
  if (tickVal <= 0 || tickSize <= 0)
    return NormalizeLots(sym, FixedLots);
  double lossPerLot = (slDistPrice / tickSize) * tickVal;
  if (lossPerLot <= 0)
    return NormalizeLots(sym, FixedLots);
  double lots = riskCash / lossPerLot;

  // safety cap: never need more than MaxMarginPercent of free margin
  if (MaxMarginPercent > 0) {
    double price = SymbolInfoDouble(sym, SYMBOL_ASK);
    double marginPerLot = 0.0;
    if (OrderCalcMargin(ORDER_TYPE_BUY, sym, 1.0, price, marginPerLot) &&
        marginPerLot > 0) {
      double freeM = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
      double cap = (freeM * MaxMarginPercent / 100.0) / marginPerLot;
      if (lots > cap) {
        PrintFormat(
            "Lots capped %.2f -> %.2f by margin (free %.0f, cap %.0f%%).", lots,
            cap, freeM, MaxMarginPercent);
        lots = cap;
      }
    }
  }
  return NormalizeLots(sym, lots);
}

double NormalizeLots(string sym, double lots) {
  double minL = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
  double maxL = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
  double step = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
  if (step <= 0)
    step = 0.01;
  lots = MathFloor(lots / step) * step;
  if (lots < minL)
    lots = minL;
  if (lots > maxL)
    lots = maxL;
  return NormalizeDouble(lots, 2);
}

//+------------------------------------------------------------------+
//| Existing exposure direction / clearing                           |
//+------------------------------------------------------------------+
string ExposureDir(string sym) {
  for (int i = PositionsTotal() - 1; i >= 0; i--) {
    ulong tk = PositionGetTicket(i);
    if (PositionSelectByTicket(tk) &&
        PositionGetInteger(POSITION_MAGIC) == MagicNumber &&
        PositionGetString(POSITION_SYMBOL) == sym)
      return (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) ? "BUY"
                                                                      : "SELL";
  }
  for (int i = OrdersTotal() - 1; i >= 0; i--) {
    ulong tk = OrderGetTicket(i);
    if (OrderSelect(tk) && OrderGetInteger(ORDER_MAGIC) == MagicNumber &&
        OrderGetString(ORDER_SYMBOL) == sym) {
      long ot = OrderGetInteger(ORDER_TYPE);
      return (ot == ORDER_TYPE_BUY_LIMIT || ot == ORDER_TYPE_BUY_STOP) ? "BUY"
                                                                       : "SELL";
    }
  }
  return "";
}

void CancelPendings(string sym) {
  for (int i = OrdersTotal() - 1; i >= 0; i--) {
    ulong tk = OrderGetTicket(i);
    if (OrderSelect(tk) && OrderGetInteger(ORDER_MAGIC) == MagicNumber &&
        OrderGetString(ORDER_SYMBOL) == sym)
      trade.OrderDelete(tk);
  }
}

void CloseAndCancelAll(string sym) {
  for (int i = PositionsTotal() - 1; i >= 0; i--) {
    ulong tk = PositionGetTicket(i);
    if (PositionSelectByTicket(tk) &&
        PositionGetInteger(POSITION_MAGIC) == MagicNumber &&
        PositionGetString(POSITION_SYMBOL) == sym) {
      if (!trade.PositionClose(tk))
        Print("Reverse: close FAILED ticket=", tk,
              " retcode=", trade.ResultRetcode());
    }
  }
  CancelPendings(sym);
  Print("Reversed: cleared existing ", sym, " exposure for the new signal.");
}

//+------------------------------------------------------------------+
//| Partial/laddered exit at TP1 and TP2 (TP3 handled by broker TP). |
//+------------------------------------------------------------------+
void DoLadder(ulong tk, string sym, double vol, double newSL, double tp,
              int dig, double pct) {
  double minL = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
  double step = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
  if (step <= 0)
    step = 0.01;
  double closeVol = MathFloor((vol * pct / 100.0) / step) * step;
  if (closeVol >= minL && (vol - closeVol) >= minL) {
    trade.PositionModify(tk, NormalizeDouble(newSL, dig),
                         tp); // advance SL (= stage marker)
    trade.PositionClosePartial(tk, closeVol);
  } else {
    trade.PositionClose(
        tk); // can't split under the broker min lot -> full close here
  }
}

void ManageTP() {
  for (int i = PositionsTotal() - 1; i >= 0; i--) {
    ulong tk = PositionGetTicket(i);
    if (!PositionSelectByTicket(tk))
      continue;
    if (PositionGetInteger(POSITION_MAGIC) != MagicNumber)
      continue;
    string sym = PositionGetString(POSITION_SYMBOL);
    double tp1, tp2;
    long msg;
    ulong posId = (ulong)PositionGetInteger(POSITION_IDENTIFIER);
    if (!LoadParams(posId, tp1, tp2, msg))
      continue; // couldn't read TP1;TP2;msgid from this position's entry deal

    bool isBuy = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY);
    double entry = PositionGetDouble(POSITION_PRICE_OPEN);
    double sl = PositionGetDouble(POSITION_SL);
    double tp = PositionGetDouble(POSITION_TP); // = TP3
    double vol = PositionGetDouble(POSITION_VOLUME);
    int dig = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
    double pnt = SymbolInfoDouble(sym, SYMBOL_POINT);
    double gap =
        MathMax((double)SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL) * pnt,
                10 * pnt);
    double px = isBuy ? SymbolInfoDouble(sym, SYMBOL_BID)
                      : SymbolInfoDouble(sym, SYMBOL_ASK);

    // stage is derived from where the SL currently sits (self-healing across
    // restarts)
    int stage;
    if (isBuy)
      stage = (sl >= tp2) ? 3 : (sl >= tp1) ? 2 : (sl > entry ? 1 : 0);
    else
      stage = (sl <= tp2 && sl > 0) ? 3 : (sl <= tp1 && sl > 0) ? 2 : (sl < entry ? 1 : 0);

    if (stage == 0) {
      if (isBuy ? (px >= tp1 + gap) : (px <= tp1 - gap)) {
        PrintFormat("TP1 hit %s: partial %.0f%%, SL -> %.*f", sym,
                    TP1ClosePercent, dig, (entry + tp1) / 2.0);
        DoLadder(tk, sym, vol, (entry + tp1) / 2.0, tp, dig, TP1ClosePercent);
        Ping(g_pingTp1, msg, "✅ TP1 HIT!");
      }
    } else if (stage == 1) {
      if (isBuy ? (px >= tp2 + gap) : (px <= tp2 - gap)) {
        PrintFormat("TP2 hit %s: partial %.0f%%, SL -> %.*f", sym,
                    TP2ClosePercent, dig, (tp1 + tp2) / 2.0);
        DoLadder(tk, sym, vol, (tp1 + tp2) / 2.0, tp, dig, TP2ClosePercent);
        Ping(g_pingTp2, msg, "✅ TP2 HIT!");
      }
    } else if (stage == 2 && tp > 0) {
      // past the midpoint of TP2..TP3 -> trail the stop up to TP2 (no partial)
      double midTP = (tp2 + tp) / 2.0;
      if (isBuy ? (px >= midTP) : (px <= midTP)) {
        PrintFormat("mid(TP2,TP3) reached %s: SL -> TP2 %.*f", sym, dig, tp2);
        trade.PositionModify(tk, NormalizeDouble(tp2, dig), tp);
      }
    }
  }
}

//+------------------------------------------------------------------+
//| Telegram close alerts (TP3 / clean SL). Requires whitelisting    |
//| https://api.telegram.org in Tools > Options > Expert Advisors.   |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest &request,
                        const MqlTradeResult &result) {
  if (trans.type != TRADE_TRANSACTION_DEAL_ADD)
    return;
  ulong deal = trans.deal;
  if (!HistoryDealSelect(deal))
    return;
  if (HistoryDealGetInteger(deal, DEAL_MAGIC) != MagicNumber)
    return;
  if (HistoryDealGetInteger(deal, DEAL_ENTRY) != DEAL_ENTRY_OUT)
    return; // only closing deals

  long reason = HistoryDealGetInteger(deal, DEAL_REASON);
  double profit = HistoryDealGetDouble(deal, DEAL_PROFIT);
  string sym = HistoryDealGetString(deal, DEAL_SYMBOL);
  double price = HistoryDealGetDouble(deal, DEAL_PRICE);
  double vol = HistoryDealGetDouble(deal, DEAL_VOLUME);
  long posId = HistoryDealGetInteger(deal, DEAL_POSITION_ID);
  int dig = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);

  string why;
  if (reason == DEAL_REASON_TP)
    why = "✅ TP3 HIT!";
  else if (reason == DEAL_REASON_SL) {
    if (profit >= 0)
      return; // SL sits at TP1/TP2 after a partial -> locked profit, don't ping
              // again
    why = "❌ SL HIT!";
  } else
    return; // stop-out, manual, EA partial/reverse closes -> silent

  long msg =
      PositionMsgId(posId); // re-selects history; all deal fields already read
  if (msg > 0 && InLong(g_pingClose, msg))
    return; // one close message per trade (the two legs would otherwise
            // duplicate)
  if (msg > 0)
    AddLong(g_pingClose, msg);

  string txt = why + " " + sym + "\n" + DoubleToString(vol, 2) + " @ " +
               DoubleToString(price, dig) + "  P/L " +
               DoubleToString(profit, 2) + " " +
               AccountInfoString(ACCOUNT_CURRENCY);
  SendTelegram(txt, msg);
}

//+------------------------------------------------------------------+
string JsonEscape(string s) {
  StringReplace(s, "\\", "\\\\");
  StringReplace(s, "\"", "\\\"");
  StringReplace(s, "\n", "\\n");
  StringReplace(s, "\r", "");
  return s;
}

void SendTelegram(string text, long replyTo = 0) {
  if (!EnableTelegram || TelegramToken == "" || TelegramChatId == "")
    return;
  string url = "https://api.telegram.org/bot" + TelegramToken + "/sendMessage";
  string reply = (replyTo > 0)
                     ? ",\"reply_to_message_id\":" + IntegerToString(replyTo) +
                           ",\"allow_sending_without_reply\":true"
                     : "";
  string body = "{\"chat_id\":\"" + TelegramChatId + "\",\"text\":\"" +
                JsonEscape(text) + "\"" + reply + "}";
  char post[];
  int n = StringToCharArray(body, post, 0, -1, CP_UTF8);
  if (n > 0)
    ArrayResize(post,
                n - 1); // drop the terminating null so the body is exact UTF-8
  char result[];
  string rh;
  ResetLastError();
  int code = WebRequest("POST", url, "Content-Type: application/json\r\n", 5000,
                        post, result, rh);
  if (code == -1)
    PrintFormat(
        "Telegram WebRequest err %d — whitelist https://api.telegram.org "
        "in Tools>Options>Expert Advisors.",
        GetLastError());
  else if (code != 200)
    PrintFormat("Telegram HTTP %d: %s", code, CharArrayToString(result));
}
//+------------------------------------------------------------------+
