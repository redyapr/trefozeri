//+------------------------------------------------------------------+
//|                                         MA_Cross_HA_Telegram.mq5 |
//|  Telegram alerts: EMA10/EMA30 cross on M1..H4 + Heikin Ashi      |
//|  + BUY/SELL suggestion + optional auto trading (entry & exit)    |
//+------------------------------------------------------------------+
#property copyright   "Redy Apriyadi"
#property version     "1.82"
#property description "Sends Telegram notifications when the fast & slow EMA cross"
#property description "on M1/M5/M15/H1/H4, with Heikin Ashi condition + BUY/SELL suggestion."
#property description "Auto trading: cross/pullback entry + HA confirmation, HTF/ADX/session/news"
#property description "filters, ATR SL, TP1/TP2/TP3 ladder with SL ratchet, circuit breaker,"
#property description "Telegram bot commands, daily recap and CSV research log."

#include <Trade/Trade.mqh>

//=== ENUMS =========================================================
enum ENUM_ENTRY_MODE
{
   ENTRY_CROSS,     // Cross — enter right after the confirmed cross
   ENTRY_PULLBACK   // Pullback — wait for a retrace to the fast EMA first
};

enum ENUM_FLAT_FILTER
{
   FLAT_OFF,        // Off
   FLAT_ADX,        // ADX
   FLAT_EMA_GAP,    // EMA distance (ATR units)
   FLAT_BOTH        // ADX + EMA distance
};

//=== INPUTS ========================================================
input group "── Telegram ──"
input string InpBotToken = "8824824923:AAFdEDAyqPbQuGzkRgsddRe6ffn9UAmuKPI";     // Bot Token
input string InpChatID   = "-1004278499982";     // Destination Chat ID
input bool   InpSendTest = false;  // Send test message on EA start

input group "── Moving Average (EMA) ──"
input int                InpFastPeriod = 10;          // Fast EMA period
input int                InpSlowPeriod = 30;          // Slow EMA period
input ENUM_APPLIED_PRICE InpMAPrice    = PRICE_CLOSE; // Applied price

input group "── Monitored timeframes ──"
input bool InpUseM1  = false;  // Monitor M1
input bool InpUseM5  = true;   // Monitor M5
input bool InpUseM15 = false;  // Monitor M15
input bool InpUseH1  = false;  // Monitor H1
input bool InpUseH4  = false;  // Monitor H4

input group "── Auto Trading ──"
input bool            InpAutoTrade   = true;        // Enable auto trading
input ENUM_TIMEFRAMES InpTradeTF     = PERIOD_M5;   // Trading timeframe
input int             InpMinScore    = 1;           // Min HA score to enter (0..2)
input int             InpConfirmBars = 1;           // Extra bars to wait for HA confirmation (0 = cross bar only)
input int             InpMaxStreak   = 10;          // Skip entry if HA streak ≥ this (0 = off)
input bool            InpUseHTF      = false;       // Higher-TF EMA trend filter
input ENUM_TIMEFRAMES InpHTF         = PERIOD_H1;   // Higher timeframe for the filter

input group "── Risk Management ──"
input double InpLots         = 0.01;      // Fixed lot (used when Risk % = 0)
input double InpRiskPct      = 20.0;       // Risk % of balance per trade (requires SL > 0)
input int    InpATRPeriod    = 14;        // ATR period (on trading TF)
input double InpSL_ATR       = 2.0;       // Stop Loss  = ATR × this (0 = none)
input double InpTP_ATR       = 0.0;       // Take Profit = ATR × this (0 = none; used when TP ladder is OFF)
input double InpTrail_ATR    = 0.0;       // Trailing stop = ATR × this (0 = off)
input bool   InpExitOnCross  = true;      // Exit on opposite EMA cross
input int    InpHAExitBars   = 0;         // Exit after N opposite HA candles (0 = off)
input int    InpMaxSpreadPts = 0;         // Max spread in points to enter (0 = no limit)
input long   InpMagic        = 57765566;  // Magic number

input group "── Entry Mode ──"
input ENUM_ENTRY_MODE InpEntryMode    = ENTRY_CROSS; // Entry mode
input int             InpPullbackBars = 12;          // Pullback: max bars to wait for the retrace

input group "── Sideways Filter ──"
input ENUM_FLAT_FILTER InpFlatFilter = FLAT_BOTH;  // Filter mode
input int    InpADXPeriod = 14;    // ADX period (trading TF)
input double InpADXMin    = 22.0;  // Min ADX to allow entry
input double InpEMAGapATR = 0.15;  // Min |EMA fast-slow| in ATR units

input group "── Session Filter ──"
input bool InpUseSession     = false; // Limit entries to trading hours (server time)
input int  InpSessionFrom    = 7;     // Session start hour (inclusive)
input int  InpSessionTo      = 22;    // Session end hour (exclusive)
input bool InpSkipFridayLate = true;  // No new entries late on Friday
input int  InpFridayLastHour = 20;    // Last entry hour on Friday

input group "── News Filter ──"
input bool InpUseNews       = true;  // Pause entries around high-impact news
input int  InpNewsBeforeMin = 5;     // Minutes before the event
input int  InpNewsAfterMin  = 15;    // Minutes after the event

input group "── Take Profit Ladder (TP1/TP2/TP3) ──"
input bool   InpUseLadder  = true;   // Enable 3-level TP ladder
input double InpTP1_ATR    = 1.5;    // TP1 = entry ATR × this (partial close, SL → mid entry-TP1)
input double InpTP2_ATR    = 3.0;    // TP2 = entry ATR × this (partial close, SL → mid TP1-TP2)
input double InpTP3_ATR    = 4.5;    // TP3 = entry ATR × this (full close, broker-side TP)
input double InpPartialPct = 50.0;   // % of remaining volume closed at TP1 and TP2

input group "── Circuit Breaker ──"
input bool   InpUseBreaker      = true; // Pause entries after a bad day
input int    InpMaxConsecLoss   = 3;    // Max consecutive losing trades per day (0 = off)
input double InpMaxDailyLossPct = 10.0;  // Max daily loss, % of balance (0 = off)

input group "── Telegram Commands ──"
input bool InpUseCommands = true;  // Enable /status /pause /resume /close
input int  InpPollSec     = 10;    // Poll interval, seconds

input group "── Reports & Logging ──"
input bool InpDailySummary = true; // Daily recap to Telegram (+weekly every Monday)
input bool InpCSVLog       = true; // Log entries/exits to CSV in MQL5/Files
input bool InpDeleteDeadSignals = true; // Delete the signal chat message when no entry happens

//=== GLOBALS =======================================================
#define TF_COUNT 5
ENUM_TIMEFRAMES g_tf[TF_COUNT] = {PERIOD_M1, PERIOD_M5, PERIOD_M15, PERIOD_H1, PERIOD_H4};
bool            g_on[TF_COUNT];
int             g_hFast[TF_COUNT];
int             g_hSlow[TF_COUNT];
datetime        g_lastBar[TF_COUNT];

//--- auto trading
CTrade   g_trade;
int      g_hTradeFast   = INVALID_HANDLE;
int      g_hTradeSlow   = INVALID_HANDLE;
int      g_hATR         = INVALID_HANDLE;
int      g_hHTFFast     = INVALID_HANDLE;
int      g_hHTFSlow     = INVALID_HANDLE;
int      g_hADX         = INVALID_HANDLE;
datetime g_tradeLastBar = 0;
bool     g_tradeWarned  = false;   // "algo trading disabled" printed once

//--- Telegram command polling
datetime g_lastPoll     = 0;
bool     g_pollFailed   = false;
datetime g_lastStatusTs = 0;       // /status broadcasts already handled
datetime g_lastCloseTs  = 0;       // /close broadcasts already handled

//--- cross signal waiting for Heikin Ashi confirmation
struct Pending
{
   bool active;
   bool bull;
   int  barsLeft;
   long msgId;      // Telegram id of the alert that armed this signal
   int  stage;      // pullback mode: 1 = waiting retrace, 2 = retraced, waiting HA
};
Pending g_pending = {false, false, 0, 0, 0};

//--- closed-trade statistics over a time range
struct PeriodStats
{
   int    trades;
   int    wins;
   double netPips;
   double netMoney;
   int    tailLosses;   // consecutive losses at the end of the period
};

//--- Heikin Ashi state of the last closed bar
struct HAState
{
   bool   valid;
   bool   bull;        // is the last HA candle green?
   int    streak;      // consecutive candles of the same color
   double bodyPct;     // body as % of range
   bool   strongWick;  // bull with no lower wick / bear with no upper wick
   bool   indecision;  // long wicks on both sides
};

//+------------------------------------------------------------------+
string TFName(ENUM_TIMEFRAMES tf)
{
   switch(tf)
   {
      case PERIOD_M1:  return "M1";
      case PERIOD_M5:  return "M5";
      case PERIOD_M15: return "M15";
      case PERIOD_H1:  return "H1";
      case PERIOD_H4:  return "H4";
   }
   return EnumToString(tf);
}

//+------------------------------------------------------------------+
ENUM_TIMEFRAMES TradeTF()
{
   return InpTradeTF==PERIOD_CURRENT ? (ENUM_TIMEFRAMES)Period() : InpTradeTF;
}

// 1 pip = 10 points on 5-digit FX and 3-digit JPY; BTCUSD and XAUUSD use 100 points instead
double PipSize()
{
   // gold & BTC pips are defined in PRICE units so any broker digit count works
   // (Exness XAUUSDm = 3-digit, Valetax XAUUSD.vxc = 2-digit -> both $0.10/pip)
   if(StringFind(_Symbol, "XAU") >= 0) return 0.1;  // XAUUSD: 1 pip = $0.10
   if(StringFind(_Symbol, "BTC") >= 0) return 1.0;  // BTCUSD: 1 pip = $1.00
   return (_Digits==5 || _Digits==3 || _Digits==2) ? 10*_Point : _Point;
}

// display name without the broker suffix (XAUUSDm / BTCUSD.vxc -> XAUUSD / BTCUSD);
// Telegram texts only — internals (orders, GVs, CSV) keep the exact symbol
string CleanSymbol()
{
   int n = 0;
   while(n < StringLen(_Symbol))
   {
      ushort c = StringGetCharacter(_Symbol, n);
      if((c>='A' && c<='Z') || (c>='0' && c<='9')) n++;
      else break;
   }
   return (n>=3) ? StringSubstr(_Symbol, 0, n) : _Symbol;
}

// terminal global variables scoped to this symbol+magic
string GVName(string suffix) { return "MAHA."+suffix+"."+_Symbol+"."+IntegerToString(InpMagic); }
string GVSig()               { return GVName("sig"); } // signal msg id of the open position

// stable per-symbol instance id (small enough to survive the double-typed GV)
long InstanceId()
{
   long h = 0;
   for(int i=0; i<StringLen(_Symbol); i++)
      h = h*131 + StringGetCharacter(_Symbol, i);
   return (h & 0x7FFFFFFF) + 1;
}

datetime DayStart(datetime t)
{
   MqlDateTime dt;
   TimeToStruct(t, dt);
   dt.hour=0; dt.min=0; dt.sec=0;
   return StructToTime(dt);
}

//+------------------------------------------------------------------+
int OnInit()
{
   if(InpFastPeriod >= InpSlowPeriod)
   {
      Print("Fast EMA period must be smaller than the slow EMA period.");
      return INIT_PARAMETERS_INCORRECT;
   }
   if(StringLen(InpBotToken) < 10 || StringLen(InpChatID) < 3)
      Print("WARNING: Bot Token / Chat ID not set. Alerts will not be sent.");
   if(InpAutoTrade && InpUseLadder &&
      !(InpTP1_ATR>0 && InpTP2_ATR>InpTP1_ATR && InpTP3_ATR>InpTP2_ATR))
   {
      Print("TP ladder requires 0 < TP1 < TP2 < TP3 (ATR multiples).");
      return INIT_PARAMETERS_INCORRECT;
   }

   g_on[0]=InpUseM1; g_on[1]=InpUseM5; g_on[2]=InpUseM15; g_on[3]=InpUseH1; g_on[4]=InpUseH4;

   for(int i=0; i<TF_COUNT; i++)
   {
      g_hFast[i]=INVALID_HANDLE; g_hSlow[i]=INVALID_HANDLE; g_lastBar[i]=0;
      if(!g_on[i]) continue;

      g_hFast[i]=iMA(_Symbol, g_tf[i], InpFastPeriod, 0, MODE_EMA, InpMAPrice);
      g_hSlow[i]=iMA(_Symbol, g_tf[i], InpSlowPeriod, 0, MODE_EMA, InpMAPrice);
      if(g_hFast[i]==INVALID_HANDLE || g_hSlow[i]==INVALID_HANDLE)
      {
         Print("Failed to create EMA handle for ", TFName(g_tf[i]));
         return INIT_FAILED;
      }
      g_lastBar[i]=iTime(_Symbol, g_tf[i], 0); // only process bars that close AFTER the EA is attached
   }

   if(InpAutoTrade)
   {
      g_hTradeFast = iMA(_Symbol, InpTradeTF, InpFastPeriod, 0, MODE_EMA, InpMAPrice);
      g_hTradeSlow = iMA(_Symbol, InpTradeTF, InpSlowPeriod, 0, MODE_EMA, InpMAPrice);
      g_hATR       = iATR(_Symbol, InpTradeTF, InpATRPeriod);
      if(g_hTradeFast==INVALID_HANDLE || g_hTradeSlow==INVALID_HANDLE || g_hATR==INVALID_HANDLE)
      {
         Print("Failed to create trading indicator handles.");
         return INIT_FAILED;
      }
      if(InpUseHTF)
      {
         g_hHTFFast = iMA(_Symbol, InpHTF, InpFastPeriod, 0, MODE_EMA, InpMAPrice);
         g_hHTFSlow = iMA(_Symbol, InpHTF, InpSlowPeriod, 0, MODE_EMA, InpMAPrice);
         if(g_hHTFFast==INVALID_HANDLE || g_hHTFSlow==INVALID_HANDLE)
         {
            Print("Failed to create higher-TF filter handles.");
            return INIT_FAILED;
         }
      }
      if(InpFlatFilter==FLAT_ADX || InpFlatFilter==FLAT_BOTH)
      {
         g_hADX = iADX(_Symbol, InpTradeTF, InpADXPeriod);
         if(g_hADX==INVALID_HANDLE)
         {
            Print("Failed to create ADX handle.");
            return INIT_FAILED;
         }
      }
      g_tradeLastBar = iTime(_Symbol, InpTradeTF, 0);

      g_trade.SetExpertMagicNumber((ulong)InpMagic);
      g_trade.SetDeviationInPoints(20);
      g_trade.SetTypeFillingBySymbol(_Symbol);
   }

   //--- treat command broadcasts issued before this init as already handled
   g_lastStatusTs = (datetime)(long)GlobalVariableGet("MAHA.cmd.status");
   datetime c1 = (datetime)(long)GlobalVariableGet("MAHA.cmd.close");
   datetime c2 = (datetime)(long)GlobalVariableGet("MAHA.cmd.close."+_Symbol);
   datetime c3 = (datetime)(long)GlobalVariableGet("MAHA.cmd.close."+CleanSymbol());
   g_lastCloseTs = (c1>c2 ? c1 : c2);
   if(c3>g_lastCloseTs) g_lastCloseTs = c3;

   EventSetTimer(5); // fallback when no ticks arrive

   if(InpSendTest)
   {
      string tfs="";
      for(int i=0;i<TF_COUNT;i++) if(g_on[i]) tfs += TFName(g_tf[i])+" ";
      string trading = InpAutoTrade
         ? "\n🤖 AutoTrade: ON — "+TFName(InpTradeTF)+
           (InpUseHTF ? " (trend filter "+TFName(InpHTF)+")" : "")+
           " · mode: "+(InpEntryMode==ENTRY_PULLBACK ? "Pullback" : "Cross")
         : "\nAutoTrade: OFF (alerts only)";
      if(InpUseCommands) trading += "\n⌨️ /status · /pause · /resume · /close [symbol]";
      SendTelegram("✅ <b>EMA Cross + Heikin Ashi EA active</b>\nSymbol: "+CleanSymbol()+
                   "\nTF: "+tfs+"\nEMA"+IntegerToString(InpFastPeriod)+" / EMA"+
                   IntegerToString(InpSlowPeriod)+trading);
   }
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   for(int i=0;i<TF_COUNT;i++)
   {
      if(g_hFast[i]!=INVALID_HANDLE) IndicatorRelease(g_hFast[i]);
      if(g_hSlow[i]!=INVALID_HANDLE) IndicatorRelease(g_hSlow[i]);
   }
   if(g_hTradeFast!=INVALID_HANDLE) IndicatorRelease(g_hTradeFast);
   if(g_hTradeSlow!=INVALID_HANDLE) IndicatorRelease(g_hTradeSlow);
   if(g_hATR!=INVALID_HANDLE)       IndicatorRelease(g_hATR);
   if(g_hHTFFast!=INVALID_HANDLE)   IndicatorRelease(g_hHTFFast);
   if(g_hHTFSlow!=INVALID_HANDLE)   IndicatorRelease(g_hHTFSlow);
   if(g_hADX!=INVALID_HANDLE)       IndicatorRelease(g_hADX);

   // hand the Telegram poller role over to another chart
   if((long)GlobalVariableGet("MAHA.tg.poller")==InstanceId())
      GlobalVariableSet("MAHA.tg.poller", 0.0);
}

void OnTick()  { CheckAll(); RunTrading(); }
void OnTimer() { CheckAll(); RunTrading(); PollCommands(); CheckDailySummary(); }

//+------------------------------------------------------------------+
//| Check all timeframes: signals only from bars that ALREADY closed |
//+------------------------------------------------------------------+
void CheckAll()
{
   for(int i=0; i<TF_COUNT; i++)
   {
      if(!g_on[i]) continue;

      datetime cur = iTime(_Symbol, g_tf[i], 0);
      if(cur==0 || cur==g_lastBar[i]) continue; // no new bar yet

      double fast[], slow[];
      ArraySetAsSeries(fast, true);
      ArraySetAsSeries(slow, true);
      // shift 1 = just-closed bar, shift 2 = the bar before it
      if(CopyBuffer(g_hFast[i], 0, 1, 2, fast) < 2) continue; // data not ready, retry later
      if(CopyBuffer(g_hSlow[i], 0, 1, 2, slow) < 2) continue;

      g_lastBar[i] = cur;

      bool bullCross = (fast[1] <= slow[1] && fast[0] >  slow[0]);
      bool bearCross = (fast[1] >= slow[1] && fast[0] <  slow[0]);
      if(!bullCross && !bearCross) continue;

      Print("SIGNAL ", TFName(g_tf[i]), bullCross ? " GOLDEN CROSS" : " DEATH CROSS");

      // With auto trading ON, only actionable signals reach Telegram:
      // RunTrading sends the trading-TF signal (with SL/TP levels) when it
      // arms a setup. Alerts-only mode (AutoTrade OFF) keeps every TF alert.
      if(!InpAutoTrade)
         SendTelegram(BuildMessage(g_tf[i], bullCross));
   }
}

//+------------------------------------------------------------------+
//| AUTO TRADING                                                     |
//| Entry: EMA cross on the trading TF + HA confirmation aligned     |
//|        (score ≥ min, streak not too old) + higher-TF trend filter|
//|        If HA is against the cross, wait up to InpConfirmBars     |
//|        bars for it to flip while the EMAs stay aligned.          |
//| Exit : opposite EMA cross, or N opposite HA candles, or ATR      |
//|        SL/TP, or ATR trailing stop.                              |
//+------------------------------------------------------------------+
void RunTrading()
{
   if(!InpAutoTrade) return;
   if(!MQLInfoInteger(MQL_TRADE_ALLOWED) || !TerminalInfoInteger(TERMINAL_TRADE_ALLOWED))
   {
      if(!g_tradeWarned)
      {
         Print("Auto trading blocked: enable the 'Algo Trading' button / EA trade permission.");
         g_tradeWarned = true;
      }
      return;
   }
   g_tradeWarned = false;

   ManageLadder();   // every tick
   ManageTrailing(); // every tick

   //--- the rest only on a new closed bar of the trading TF
   datetime cur = iTime(_Symbol, InpTradeTF, 0);
   if(cur==0 || cur==g_tradeLastBar) return;

   double fast[], slow[];
   ArraySetAsSeries(fast, true);
   ArraySetAsSeries(slow, true);
   if(CopyBuffer(g_hTradeFast, 0, 1, 2, fast) < 2) return; // data not ready, retry later
   if(CopyBuffer(g_hTradeSlow, 0, 1, 2, slow) < 2) return;

   g_tradeLastBar = cur;

   bool bullCross = (fast[1] <= slow[1] && fast[0] >  slow[0]);
   bool bearCross = (fast[1] >= slow[1] && fast[0] <  slow[0]);

   HAState ha;
   GetHAState(InpTradeTF, ha);

   //--- 1) manage the open position first
   ulong ticket; long dir;
   if(FindPosition(ticket, dir))
   {
      bool exitCross = InpExitOnCross && ((dir>0 && bearCross) || (dir<0 && bullCross));
      bool exitHA    = InpHAExitBars>0 && ha.valid &&
                       (ha.bull != (dir>0)) && ha.streak >= InpHAExitBars;

      if(exitCross)
         ClosePosition(ticket, dir, "opposite EMA cross");
      else if(exitHA)
         ClosePosition(ticket, dir, IntegerToString(ha.streak)+" opposite HA candles");

      if(FindPosition(ticket, dir)) return; // still holding -> ignore new entries
   }

   //--- 2) a fresh cross arms (or overwrites) the pending signal
   if(bullCross || bearCross)
   {
      if(g_pending.active) // superseded before it entered -> remove its chat message
         DropDeadSignal(g_pending.msgId, "superseded by a new cross");
      g_pending.active   = true;
      g_pending.bull     = bullCross;
      g_pending.barsLeft = (InpEntryMode==ENTRY_PULLBACK ? InpPullbackBars : InpConfirmBars);
      g_pending.stage    = (InpEntryMode==ENTRY_PULLBACK ? 1 : 0);

      // heads-up only: the full signal follows once the position actually
      // opens; if the setup dies first, this message gets deleted instead
      string side = bullCross ? "🔵 BUY" : "🔴 SELL";
      long msgId = SendTelegram("⏳ <b>Get ready "+side+"</b> — "+CleanSymbol()+" · "+
                                TFName(InpTradeTF)+"\nWaiting for "+
                                (InpEntryMode==ENTRY_PULLBACK ?
                                 "a pullback + HA confirmation" : "HA confirmation"));
      g_pending.msgId = (msgId>0 ? msgId : 0);

      if(InpEntryMode==ENTRY_PULLBACK) return; // the retrace can only start on later bars
   }

   if(!g_pending.active) return;

   //--- the EMAs must still be on the right side, otherwise the signal is dead
   bool aligned = g_pending.bull ? (fast[0] > slow[0]) : (fast[0] < slow[0]);
   if(!aligned)
   {
      g_pending.active = false;
      DropDeadSignal(g_pending.msgId, "EMAs crossed back before entry");
      return;
   }

   //--- pullback mode: wait for a retrace into the fast EMA first
   if(g_pending.stage==1)
   {
      bool touched = g_pending.bull ? (iLow(_Symbol, InpTradeTF, 1)  <= fast[0])
                                    : (iHigh(_Symbol, InpTradeTF, 1) >= fast[0]);
      if(touched) g_pending.stage = 2;
   }
   bool stageOK = (InpEntryMode==ENTRY_CROSS) || (g_pending.stage==2);

   //--- ATR-relative EMA gap of the closed bar (sideways filter + CSV log)
   double atrNow[];
   ArraySetAsSeries(atrNow, true);
   double gapATR = 0.0;
   if(CopyBuffer(g_hATR, 0, 1, 1, atrNow)==1 && atrNow[0]>0)
      gapATR = MathAbs(fast[0]-slow[0])/atrNow[0];

   //--- 3) enter when signal + environment agree; otherwise burn one waiting bar
   string why = "";
   if(!stageOK)          why = "waiting for the pullback retrace";
   else if(CmdPaused())  why = "paused by /pause";
   else if(!SessionOK()) why = "outside session hours";
   else if(!NewsOK())    why = "news window";
   else if(!BreakerOK()) why = "circuit breaker";
   else if(!EntryConfirmed(g_pending.bull, ha, gapATR, why)) { /* why filled */ }
   else if(TryEnter(g_pending.bull, ha, g_pending.msgId, gapATR))
   {
      g_pending.active = false;
      return;
   }
   else why = "order attempt failed (see log above)";

   if(--g_pending.barsLeft < 0)
   {
      g_pending.active = false;
      Print("Signal EXPIRED without entry — last reason: ", why);
      DropDeadSignal(g_pending.msgId, why);
   }
   else
      Print("Entry waiting (", g_pending.barsLeft+1, " more bars): ", why);
}

//+------------------------------------------------------------------+
//| A signal that will never turn into an entry: delete its chat     |
//| message so only actionable/traded signals remain in Telegram     |
//+------------------------------------------------------------------+
void DropDeadSignal(long msgId, string reason)
{
   if(!InpDeleteDeadSignals || msgId<=0) return;
   Print("Removing dead signal message (", reason, ")");
   DeleteTelegram(msgId);
}

//+------------------------------------------------------------------+
//| All signal-quality conditions for an entry                       |
//+------------------------------------------------------------------+
bool EntryConfirmed(bool bull, HAState &ha, double gapATR, string &why)
{
   why = "";
   if(!ha.valid)
      { why = "HA data not ready"; return false; }
   if(ha.bull != bull)
      { why = "HA candle against the signal"; return false; }
   if(HAScore(ha) < InpMinScore)
      { why = StringFormat("HA score %d < min %d", HAScore(ha), InpMinScore); return false; }
   if(InpMaxStreak>0 && ha.streak >= InpMaxStreak)
      { why = StringFormat("HA streak %d >= %d (late entry)", ha.streak, InpMaxStreak); return false; }
   if(!FlatOK(gapATR))
      { why = StringFormat("sideways filter: ADX %.1f (min %.1f), EMA gap %.2f ATR (min %.2f)",
                           GetADX(), InpADXMin, gapATR, InpEMAGapATR); return false; }
   if(!HTFAllows(bull))
      { why = "against the higher-TF trend"; return false; }
   return true;
}

//+------------------------------------------------------------------+
//| Higher-TF filter: trade longs only when fast EMA > slow EMA there|
//+------------------------------------------------------------------+
bool HTFAllows(bool bull)
{
   if(!InpUseHTF) return true;
   double f[], s[];
   ArraySetAsSeries(f, true);
   ArraySetAsSeries(s, true);
   if(CopyBuffer(g_hHTFFast, 0, 1, 1, f) < 1) return false;
   if(CopyBuffer(g_hHTFSlow, 0, 1, 1, s) < 1) return false;
   return bull ? (f[0] > s[0]) : (f[0] < s[0]);
}

//+------------------------------------------------------------------+
//| Find the EA's position on this symbol (one at a time by design)  |
//+------------------------------------------------------------------+
bool FindPosition(ulong &ticket, long &dir)
{
   ticket=0; dir=0;
   for(int i=PositionsTotal()-1; i>=0; i--)
   {
      ulong t = PositionGetTicket(i);
      if(t==0) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol)  continue;
      if(PositionGetInteger(POSITION_MAGIC) != InpMagic) continue;
      ticket = t;
      dir    = (PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY) ? 1 : -1;
      return true;
   }
   return false;
}

//+------------------------------------------------------------------+
//| Open a market order with ATR-based SL/TP and risk-based lots     |
//+------------------------------------------------------------------+
bool TryEnter(bool bull, HAState &ha, long msgId, double gapATR)
{
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   if(ask<=0 || bid<=0) return false;

   if(InpMaxSpreadPts>0 && (ask-bid)/_Point > InpMaxSpreadPts)
   {
      Print("Entry skipped: spread too wide (", DoubleToString((ask-bid)/_Point, 0), " pts)");
      return false;
   }

   double atr[];
   ArraySetAsSeries(atr, true);
   if(CopyBuffer(g_hATR, 0, 1, 1, atr) < 1 || atr[0] <= 0.0) return false;

   double minDist = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL)*_Point;
   double slDist  = InpSL_ATR>0 ? MathMax(InpSL_ATR*atr[0], minDist) : 0.0;
   // ladder ON: broker-side TP = TP3 (full close); ladder OFF: legacy single TP
   double tpMult  = InpUseLadder ? InpTP3_ATR : InpTP_ATR;
   double tpDist  = tpMult>0 ? MathMax(tpMult*atr[0], minDist) : 0.0;

   double price = bull ? ask : bid;
   double sl = slDist>0 ? NormalizeDouble(bull ? price-slDist : price+slDist, _Digits) : 0.0;
   double tp = tpDist>0 ? NormalizeDouble(bull ? price+tpDist : price-tpDist, _Digits) : 0.0;

   double lots = CalcLots(slDist);
   if(lots<=0) return false;

   lots = FitLotsToMargin(bull, price, lots);
   if(lots<=0)
   {
      Print("Entry skipped: free margin cannot cover even the minimum lot");
      return false;
   }

   string comment = "EMA-HA "+TFName(InpTradeTF);
   bool ok = bull ? g_trade.Buy(lots, _Symbol, 0.0, sl, tp, comment)
                  : g_trade.Sell(lots, _Symbol, 0.0, sl, tp, comment);
   uint rc = g_trade.ResultRetcode();

   //--- margin can shift between the check and the fill: halve once and retry
   if(!ok || rc==TRADE_RETCODE_NO_MONEY)
   {
      double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
      double minL = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
      double half = lots/2.0;
      if(step>0) half = MathFloor(half/step + 1e-9)*step;
      if(rc==TRADE_RETCODE_NO_MONEY && half>=minL)
      {
         Print("Not enough money for ", DoubleToString(lots, 2), " lots, retrying with ",
               DoubleToString(half, 2));
         lots = half;
         ok = bull ? g_trade.Buy(lots, _Symbol, 0.0, sl, tp, comment)
                   : g_trade.Sell(lots, _Symbol, 0.0, sl, tp, comment);
         rc = g_trade.ResultRetcode();
      }
   }
   if(!ok || (rc!=TRADE_RETCODE_DONE && rc!=TRADE_RETCODE_DONE_PARTIAL && rc!=TRADE_RETCODE_PLACED))
   {
      Print("Order failed: ", rc, " ", g_trade.ResultRetcodeDescription());
      return false;
   }

   // some brokers (e.g. .vxc) fill the order result without a price -> fall back
   double entryPrice = g_trade.ResultPrice();
   if(entryPrice<=0)
      entryPrice = bull ? SymbolInfoDouble(_Symbol, SYMBOL_ASK)
                        : SymbolInfoDouble(_Symbol, SYMBOL_BID);

   //--- position is OPEN: now send the real signal, replying to the heads-up
   int    dsign = bull ? 1 : -1;
   string lv = "📐 <b>Entry "+(bull ? "BUY" : "SELL")+"</b> @ "+DoubleToString(entryPrice, _Digits)+
               "\nLots: "+DoubleToString(lots, 2)+
               (sl>0 ? "\nSL: "+DoubleToString(sl, _Digits) : "");
   if(InpUseLadder)
      lv += "\nTP1: "+DoubleToString(entryPrice + dsign*InpTP1_ATR*atr[0], _Digits)+
            "\nTP2: "+DoubleToString(entryPrice + dsign*InpTP2_ATR*atr[0], _Digits)+
            "\nTP3: "+DoubleToString(entryPrice + dsign*InpTP3_ATR*atr[0], _Digits);
   else if(tp>0)
      lv += "\nTP: "+DoubleToString(tp, _Digits);

   long sigId = SendTelegram(BuildMessage(InpTradeTF, bull)+"\n\n"+lv, msgId);

   //--- persist per-position state (restart-safe via terminal global variables)
   GlobalVariableSet(GVSig(),         (double)(sigId>0 ? sigId : msgId)); // closes reply here
   GlobalVariableSet(GVName("atr"),   atr[0]);        // entry ATR for the TP ladder levels
   GlobalVariableSet(GVName("part1"), 0);             // TP1 partial not taken yet
   GlobalVariableSet(GVName("part2"), 0);             // TP2 partial not taken yet
   GlobalVariableSet(GVName("hwm"),   0);             // best favorable excursion so far

   Print("AUTO ENTRY ", bull ? "BUY" : "SELL", " ", DoubleToString(lots, 2),
         " @ ", DoubleToString(entryPrice, _Digits),
         "  SL ", DoubleToString(sl, _Digits), "  TP ", DoubleToString(tp, _Digits),
         "  (HA score ", HAScore(ha), ")");
   LogCSVEntry(bull ? "BUY" : "SELL", lots, entryPrice, sl, tp, ha, GetADX(), gapATR);
   return true;
}

//+------------------------------------------------------------------+
//| Close and report                                                 |
//+------------------------------------------------------------------+
void ClosePosition(ulong ticket, long dir, string reason)
{
   if(!PositionSelectByTicket(ticket)) return;
   double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
   long   posId     = PositionGetInteger(POSITION_IDENTIFIER);

   if(!g_trade.PositionClose(ticket))
   {
      Print("PositionClose failed: ", g_trade.ResultRetcode(), " ",
            g_trade.ResultRetcodeDescription()); // retried on the next bar
      return;
   }

   double closePrice = g_trade.ResultPrice();
   if(closePrice<=0)
      closePrice = dir>0 ? SymbolInfoDouble(_Symbol, SYMBOL_BID)
                         : SymbolInfoDouble(_Symbol, SYMBOL_ASK);

   double pips = (dir>0 ? closePrice-openPrice : openPrice-closePrice)/PipSize();
   ReportClose(pips, reason, true, posId);
}

//+------------------------------------------------------------------+
//| Net result of the whole position from its deal history:          |
//| volume-weighted exit pips + money incl. swap & commission.       |
//+------------------------------------------------------------------+
bool PositionNetResult(long posId, double &pips, double &money)
{
   pips=0.0; money=0.0;
   if(posId<=0 || !HistorySelectByPosition(posId)) return false;

   double in=0.0, outPV=0.0, outVol=0.0;
   int dir=0;
   int total = HistoryDealsTotal();
   for(int i=0; i<total; i++)
   {
      ulong d = HistoryDealGetTicket(i);
      if(d==0) continue;
      money += HistoryDealGetDouble(d, DEAL_PROFIT)
             + HistoryDealGetDouble(d, DEAL_SWAP)
             + HistoryDealGetDouble(d, DEAL_COMMISSION);
      ENUM_DEAL_ENTRY de = (ENUM_DEAL_ENTRY)HistoryDealGetInteger(d, DEAL_ENTRY);
      double price = HistoryDealGetDouble(d, DEAL_PRICE);
      double vol   = HistoryDealGetDouble(d, DEAL_VOLUME);
      if(de==DEAL_ENTRY_IN)
      {
         in  = price;
         dir = (HistoryDealGetInteger(d, DEAL_TYPE)==DEAL_TYPE_BUY) ? 1 : -1;
      }
      else if(de==DEAL_ENTRY_OUT || de==DEAL_ENTRY_INOUT)
      {
         outPV  += price*vol;
         outVol += vol;
      }
   }
   if(in<=0.0 || dir==0 || outVol<=0.0) return false;
   double avgOut = outPV/outVol;
   pips = (dir>0 ? avgOut-in : in-avgOut)/PipSize();
   return true;
}

//+------------------------------------------------------------------+
//| Reply to the originating signal alert with pips + reason.        |
//| Final close: net result. TP1/TP2 partial: hit notification too   |
//| (also a reply), keeping the per-position state alive.            |
//+------------------------------------------------------------------+
void ReportClose(double pips, string reason, bool isFinal=true, long posId=0)
{
   long replyTo = (long)GlobalVariableGet(GVSig());
   if(isFinal)
   {
      double netPips=pips, netMoney=0.0;
      bool haveNet = PositionNetResult(posId, netPips, netMoney);
      if(!haveNet) netPips = pips;
      string sign = netPips>=0 ? "+" : "";
      string head = netPips>=0 ? "✅ Profit Taken " : "❌ Loss Stopped ";
      string msg  = head+sign+DoubleToString(netPips, 1)+" pips";
      // if(haveNet)
      //    msg += " ("+(netMoney>=0 ? "+" : "")+DoubleToString(netMoney, 2)+" "+
      //           AccountInfoString(ACCOUNT_CURRENCY)+")";
      // msg += " — "+reason;
      SendTelegram(msg, replyTo);
   }
   else
   {
      string sign = pips>=0 ? "+" : "";
      SendTelegram("🎯 "+reason+" — "+sign+DoubleToString(pips, 1)+" pips", replyTo);
   }
   LogCSVExit(isFinal ? "EXIT" : "PARTIAL", pips, reason);
   if(isFinal)
   {
      GlobalVariableDel(GVSig());
      GlobalVariableDel(GVName("atr"));
      GlobalVariableDel(GVName("part1"));
      GlobalVariableDel(GVName("part2"));
      GlobalVariableDel(GVName("hwm"));
   }
}

//+------------------------------------------------------------------+
//| Shrink the requested volume until its margin fits the free       |
//| margin (with a 5% cushion), so a big risk-sized lot degrades     |
//| gracefully instead of being rejected with "not enough money".    |
//| Returns 0 when even the minimum lot does not fit.                |
//+------------------------------------------------------------------+
double FitLotsToMargin(bool bull, double price, double lots)
{
   ENUM_ORDER_TYPE type = bull ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   double minL  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double step  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   double freeM = AccountInfoDouble(ACCOUNT_MARGIN_FREE)*0.95; // keep a cushion

   double margin = 0.0;
   if(!OrderCalcMargin(type, _Symbol, lots, price, margin))
      return lots;                                  // cannot estimate -> try as requested
   if(margin<=0 || margin<=freeM) return lots;      // already affordable

   // scale down proportionally (margin is linear in volume), then walk down
   double fit = lots*freeM/margin;
   if(step>0) fit = MathFloor(fit/step + 1e-9)*step;
   while(fit >= minL)
   {
      if(OrderCalcMargin(type, _Symbol, fit, price, margin) && margin<=freeM)
      {
         Print("Lot auto-reduced ", DoubleToString(lots, 2), " -> ", DoubleToString(fit, 2),
               " to fit free margin (", DoubleToString(freeM, 2), " ",
               AccountInfoString(ACCOUNT_CURRENCY), ")");
         return fit;
      }
      fit -= (step>0 ? step : minL);
   }
   return 0.0;
}

//+------------------------------------------------------------------+
//| Lots from risk % of balance and SL distance (fallback: fixed lot)|
//+------------------------------------------------------------------+
double CalcLots(double slDist)
{
   double lots = InpLots;
   if(InpRiskPct>0 && slDist>0)
   {
      double tickVal  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
      double tickSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
      if(tickVal>0 && tickSize>0)
      {
         double riskMoney  = AccountInfoDouble(ACCOUNT_BALANCE)*InpRiskPct/100.0;
         double lossPerLot = slDist/tickSize*tickVal;
         if(lossPerLot>0) lots = riskMoney/lossPerLot;
      }
   }
   double minL = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxL = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(step>0) lots = MathFloor(lots/step + 1e-9)*step;
   return MathMin(MathMax(lots, minL), maxL);
}

//+------------------------------------------------------------------+
//| ATR trailing stop (only ever tightens)                           |
//+------------------------------------------------------------------+
void ManageTrailing()
{
   if(InpTrail_ATR<=0) return;

   ulong ticket; long dir;
   if(!FindPosition(ticket, dir)) return;

   double atr[];
   ArraySetAsSeries(atr, true);
   if(CopyBuffer(g_hATR, 0, 1, 1, atr) < 1 || atr[0] <= 0.0) return;

   double dist = MathMax(InpTrail_ATR*atr[0],
                         SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL)*_Point);

   if(!PositionSelectByTicket(ticket)) return;
   double curSL = PositionGetDouble(POSITION_SL);
   double curTP = PositionGetDouble(POSITION_TP);
   double bid   = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask   = SymbolInfoDouble(_Symbol, SYMBOL_ASK);

   double newSL = dir>0 ? NormalizeDouble(bid-dist, _Digits)
                        : NormalizeDouble(ask+dist, _Digits);
   bool better  = dir>0 ? (curSL==0.0 || newSL > curSL+_Point)
                        : (curSL==0.0 || newSL < curSL-_Point);
   if(!better) return;

   if(!g_trade.PositionModify(ticket, newSL, curTP))
      Print("Trailing modify failed: ", g_trade.ResultRetcode());
}

//+------------------------------------------------------------------+
//| Take the TP1/TP2 partial. If the remaining volume is too small   |
//| to split (already at min lot), close the position in full        |
//| instead (Telegram + CSV, like any other final close).            |
//| Returns true when the partial succeeded, false on a transient    |
//| order error (retried next tick) or once fully closed (nothing    |
//| left for the ladder to manage).                                  |
//+------------------------------------------------------------------+
bool LadderPartialClose(ulong ticket, long dir, double open, string label)
{
   if(!PositionSelectByTicket(ticket)) return false;
   double vol  = PositionGetDouble(POSITION_VOLUME);
   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   double minL = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double part = vol*InpPartialPct/100.0;
   if(step>0) part = MathFloor(part/step + 1e-9)*step;
   if(part < minL || vol-part < minL)
   {
      Print(label, ": volume ", DoubleToString(vol, 2), " too small to split, closing in full instead");
      ClosePosition(ticket, dir, label);
      return false; // position is gone; nothing left for the ladder to manage
   }

   if(!g_trade.PositionClosePartial(ticket, part))
   {
      Print(label, " partial close failed: ", g_trade.ResultRetcode(), " ",
            g_trade.ResultRetcodeDescription()); // retried on a later tick
      return false;
   }

   double closePrice = g_trade.ResultPrice();
   if(closePrice<=0) closePrice = dir>0 ? SymbolInfoDouble(_Symbol, SYMBOL_BID)
                                        : SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double pips = (dir>0 ? closePrice-open : open-closePrice)/PipSize();
   ReportClose(pips, label+" hit (partial "+DoubleToString(InpPartialPct, 0)+"%)", false);
   return true;
}

//+------------------------------------------------------------------+
//| TP1/TP2/TP3 ladder, driven by the best favorable excursion (hwm):|
//|   hit TP1          -> close 50%, SL -> mid(entry, TP1)           |
//|   reach mid(1,2)   -> SL -> TP1                                  |
//|   hit TP2          -> close 50% of the rest, SL -> mid(TP1, TP2) |
//|   reach mid(2,3)   -> SL -> TP2                                  |
//|   hit TP3          -> broker-side TP closes the remainder        |
//| The SL only ever tightens; state survives restarts via GVs.      |
//+------------------------------------------------------------------+
void ManageLadder()
{
   if(!InpUseLadder || InpPartialPct<=0) return;

   ulong ticket; long dir;
   if(!FindPosition(ticket, dir)) return;

   double entryATR = GlobalVariableGet(GVName("atr"));
   if(entryATR<=0) return; // position predates this feature

   if(!PositionSelectByTicket(ticket)) return;
   double open  = PositionGetDouble(POSITION_PRICE_OPEN);
   double curSL = PositionGetDouble(POSITION_SL);
   double curTP = PositionGetDouble(POSITION_TP);
   double bid   = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask   = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   if(bid<=0 || ask<=0) return;

   double d1 = InpTP1_ATR*entryATR;   // TP distances from the entry price
   double d2 = InpTP2_ATR*entryATR;
   double d3 = InpTP3_ATR*entryATR;

   //--- best favorable excursion so far (close prices: bid for long, ask for short)
   double fav = dir>0 ? bid-open : open-ask;
   double hwm = GlobalVariableGet(GVName("hwm"));
   if(fav > hwm) { hwm = fav; GlobalVariableSet(GVName("hwm"), hwm); }

   //--- partial closes: one per tick, silent (Telegram only on the final close)
   if(hwm >= d1 && GlobalVariableGet(GVName("part1")) < 0.5)
   {
      if(!LadderPartialClose(ticket, dir, open, "TP1")) return;
      GlobalVariableSet(GVName("part1"), 1);
   }
   else if(hwm >= d2 && GlobalVariableGet(GVName("part2")) < 0.5)
   {
      if(!LadderPartialClose(ticket, dir, open, "TP2")) return;
      GlobalVariableSet(GVName("part2"), 1);
   }

   //--- SL ratchet by the highest ladder level reached
   double slDist = -1.0;
   if(hwm >= (d2+d3)/2.0)      slDist = d2;           // SL -> TP2
   else if(hwm >= d2)          slDist = (d1+d2)/2.0;  // SL -> mid TP1-TP2
   else if(hwm >= (d1+d2)/2.0) slDist = d1;           // SL -> TP1
   else if(hwm >= d1)          slDist = d1/2.0;       // SL -> mid entry-TP1
   if(slDist < 0.0) return;

   double newSL = NormalizeDouble(dir>0 ? open+slDist : open-slDist, _Digits);
   bool better  = dir>0 ? (curSL==0.0 || newSL > curSL+_Point)
                        : (curSL==0.0 || newSL < curSL-_Point);
   if(!better) return;

   if(!g_trade.PositionModify(ticket, newSL, curTP))
      Print("Ladder SL modify failed: ", g_trade.ResultRetcode(), " ",
            g_trade.ResultRetcodeDescription()); // retried on a later tick
   else
      Print("Ladder SL -> ", DoubleToString(newSL, _Digits),
            " (hwm ", DoubleToString(hwm/PipSize(), 1), " pips)");
}

//+------------------------------------------------------------------+
//| Environment gates for entries                                    |
//+------------------------------------------------------------------+
bool CmdPaused() { return GlobalVariableGet("MAHA.cmd.pause") > 0.5; }

double GetADX()
{
   if(g_hADX==INVALID_HANDLE) return 0.0;
   double a[];
   ArraySetAsSeries(a, true);
   if(CopyBuffer(g_hADX, 0, 1, 1, a) < 1) return 0.0;
   return a[0];
}

bool FlatOK(double gapATR)
{
   if(InpFlatFilter==FLAT_OFF) return true;
   bool adxOK = true, gapOK = true;
   if(InpFlatFilter==FLAT_ADX || InpFlatFilter==FLAT_BOTH)
      adxOK = (GetADX() >= InpADXMin);
   if(InpFlatFilter==FLAT_EMA_GAP || InpFlatFilter==FLAT_BOTH)
      gapOK = (gapATR >= InpEMAGapATR);
   return adxOK && gapOK;
}

bool SessionOK()
{
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   if(InpSkipFridayLate && dt.day_of_week==5 && dt.hour>=InpFridayLastHour) return false;
   if(!InpUseSession) return true;
   if(InpSessionFrom==InpSessionTo) return true;
   if(InpSessionFrom < InpSessionTo)
      return (dt.hour>=InpSessionFrom && dt.hour<InpSessionTo);
   return (dt.hour>=InpSessionFrom || dt.hour<InpSessionTo); // overnight session
}

bool NewsOK()
{
   if(!InpUseNews) return true;
   if(MQLInfoInteger(MQL_TESTER)) return true; // calendar unavailable in the tester

   datetime now  = TimeCurrent();
   datetime from = now - InpNewsAfterMin*60;
   datetime to   = now + InpNewsBeforeMin*60;

   string curs[2];
   curs[0] = SymbolInfoString(_Symbol, SYMBOL_CURRENCY_BASE);
   curs[1] = SymbolInfoString(_Symbol, SYMBOL_CURRENCY_PROFIT);

   for(int c=0; c<2; c++)
   {
      if(curs[c]=="") continue;
      if(c==1 && curs[1]==curs[0]) continue;

      MqlCalendarValue vals[];
      if(!CalendarValueHistory(vals, from, to, NULL, curs[c])) continue;
      for(int i=0; i<ArraySize(vals); i++)
      {
         MqlCalendarEvent ev;
         if(!CalendarEventById(vals[i].event_id, ev)) continue;
         if(ev.importance==CALENDAR_IMPORTANCE_HIGH)
         {
            Print("Entry blocked by news filter: ", ev.name, " (", curs[c], ")");
            return false;
         }
      }
   }
   return true;
}

//+------------------------------------------------------------------+
//| Aggregate this EA's closed trades (grouped by position) in range |
//+------------------------------------------------------------------+
bool CollectStats(datetime from, datetime to, PeriodStats &st)
{
   st.trades=0; st.wins=0; st.netPips=0; st.netMoney=0; st.tailLosses=0;
   if(!HistorySelect(from, to)) return false;

   long     posIds[];
   double   posProfit[], posIn[], posOutPV[], posOutVol[];
   int      posDir[];
   int      n=0;

   int deals = HistoryDealsTotal();
   for(int i=0; i<deals; i++)
   {
      ulong d = HistoryDealGetTicket(i);
      if(d==0) continue;
      if(HistoryDealGetString(d, DEAL_SYMBOL)  != _Symbol)  continue;
      if(HistoryDealGetInteger(d, DEAL_MAGIC)  != InpMagic) continue;

      long pid = HistoryDealGetInteger(d, DEAL_POSITION_ID);
      int  idx = -1;
      for(int k=0; k<n; k++) if(posIds[k]==pid) { idx=k; break; }
      if(idx<0)
      {
         n++;
         ArrayResize(posIds, n);    ArrayResize(posProfit, n); ArrayResize(posIn, n);
         ArrayResize(posOutPV, n);  ArrayResize(posOutVol, n); ArrayResize(posDir, n);
         idx = n-1;
         posIds[idx]=pid; posProfit[idx]=0; posIn[idx]=0;
         posOutPV[idx]=0; posOutVol[idx]=0; posDir[idx]=0;
      }

      posProfit[idx] += HistoryDealGetDouble(d, DEAL_PROFIT)
                      + HistoryDealGetDouble(d, DEAL_SWAP)
                      + HistoryDealGetDouble(d, DEAL_COMMISSION);

      ENUM_DEAL_ENTRY de = (ENUM_DEAL_ENTRY)HistoryDealGetInteger(d, DEAL_ENTRY);
      double price = HistoryDealGetDouble(d, DEAL_PRICE);
      double vol   = HistoryDealGetDouble(d, DEAL_VOLUME);
      if(de==DEAL_ENTRY_IN)
      {
         posIn[idx]  = price;
         posDir[idx] = (HistoryDealGetInteger(d, DEAL_TYPE)==DEAL_TYPE_BUY) ? 1 : -1;
      }
      else if(de==DEAL_ENTRY_OUT || de==DEAL_ENTRY_INOUT)
      {
         posOutPV[idx]  += price*vol;
         posOutVol[idx] += vol;
      }
   }

   // one position at a time by design -> positions already come in close order
   for(int k=0; k<n; k++)
   {
      if(posOutVol[k]<=0) continue; // nothing closed inside the range
      st.trades++;
      st.netMoney += posProfit[k];
      if(posProfit[k]>=0) { st.wins++; st.tailLosses=0; }
      else                  st.tailLosses++;
      if(posIn[k]>0 && posDir[k]!=0)
      {
         double avgOut = posOutPV[k]/posOutVol[k];
         st.netPips += (posDir[k]>0 ? avgOut-posIn[k] : posIn[k]-avgOut)/PipSize();
      }
   }
   return true;
}

//+------------------------------------------------------------------+
//| Circuit breaker: pause entries for the rest of the day           |
//+------------------------------------------------------------------+
bool BreakerOK()
{
   if(!InpUseBreaker) return true;

   datetime day = DayStart(TimeCurrent());
   PeriodStats st;
   if(!CollectStats(day, TimeCurrent()+60, st)) return true;

   bool lossStreak = (InpMaxConsecLoss>0 && st.tailLosses>=InpMaxConsecLoss);
   double balance  = AccountInfoDouble(ACCOUNT_BALANCE);
   bool dailyLoss  = (InpMaxDailyLossPct>0 && balance>0 &&
                      st.netMoney <= -balance*InpMaxDailyLossPct/100.0);
   if(!lossStreak && !dailyLoss) return true;

   if((datetime)(long)GlobalVariableGet(GVName("brk")) != day) // notify once per day
   {
      GlobalVariableSet(GVName("brk"), (double)day);
      string why = lossStreak
         ? IntegerToString(st.tailLosses)+" consecutive losses"
         : "daily loss "+DoubleToString(st.netMoney, 2)+" "+AccountInfoString(ACCOUNT_CURRENCY);
      SendTelegram("⛔ <b>Circuit breaker</b> — "+CleanSymbol()+"\n"+why+
                   ". New entries paused until tomorrow.");
      Print("Circuit breaker active: ", why);
   }
   return false;
}

//+------------------------------------------------------------------+
//| Telegram bot commands: /status /pause /resume /close [symbol]    |
//| Commands are dispatched through terminal global variables so     |
//| every chart running this EA reacts, whichever instance polls.    |
//+------------------------------------------------------------------+
void PollCommands()
{
   HandleBroadcasts(); // react even when this chart is not the poller

   if(!InpUseCommands) return;
   if(MQLInfoInteger(MQL_TESTER)) return;
   if(StringLen(InpBotToken) < 10) return;

   datetime now = TimeCurrent();
   if(InpPollSec>0 && now - g_lastPoll < InpPollSec) return;
   g_lastPoll = now;

   //--- single-poller election: Telegram allows only ONE active getUpdates
   //    per bot, so exactly one chart polls; the rest take over if it dies.
   long me    = InstanceId();
   long owner = (long)GlobalVariableGet("MAHA.tg.poller");
   datetime beat = (datetime)(long)GlobalVariableGet("MAHA.tg.beat");
   int staleSec  = MathMax(3*InpPollSec, 30);
   if(owner != me)
   {
      if(owner != 0 && now-beat <= staleSec) return; // healthy poller elsewhere
      if(!GlobalVariableCheck("MAHA.tg.poller"))
         GlobalVariableSet("MAHA.tg.poller", 0.0);
      if(!GlobalVariableSetOnCondition("MAHA.tg.poller", (double)me, (double)owner))
         return; // lost the takeover race
      Print("Telegram poller role acquired by ", _Symbol);
   }
   GlobalVariableSet("MAHA.tg.beat", (double)now);

   long offset = (long)GlobalVariableGet("MAHA.tg.offset");
   string url = "https://api.telegram.org/bot"+InpBotToken+
                "/getUpdates?timeout=0&offset="+IntegerToString(offset);

   char data[], result[];
   string rh;
   ResetLastError();
   int status = WebRequest("GET", url, "", 10000, data, result, rh);
   if(status != 200)
   {
      if(!g_pollFailed)
      {
         Print("getUpdates failed, HTTP ", status, " err ", GetLastError(), " ",
               CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8));
         if(status==409)
            Print("409 = another getUpdates client (an old EA build on another chart?) ",
                  "or a webhook is using this bot. Backing off 60s.");
         g_pollFailed = true;
      }
      // back off, but stay under the 30s stale threshold so the role stays put
      if(status==409) g_lastPoll = now + 20;
      return;
   }
   g_pollFailed = false;

   string resp = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   long maxUid = 0;

   int pos = StringFind(resp, "\"update_id\":");
   while(pos >= 0)
   {
      int next = StringFind(resp, "\"update_id\":", pos+12);
      string chunk = (next<0) ? StringSubstr(resp, pos) : StringSubstr(resp, pos, next-pos);

      long uid = ParseLongAfter(chunk, "\"update_id\":");
      if(uid > maxUid) maxUid = uid;

      long   chatId = ParseLongAfter(chunk, "\"chat\":{\"id\":");
      string text   = ParseStringAfter(chunk, "\"text\":\"");
      if(IntegerToString(chatId)==InpChatID && StringLen(text)>0)
         HandleCommand(text);

      pos = next;
   }
   if(maxUid > 0) GlobalVariableSet("MAHA.tg.offset", (double)(maxUid+1));

   HandleBroadcasts(); // apply anything we just dispatched without waiting a tick
}

long ParseLongAfter(string s, string key)
{
   int p = StringFind(s, key);
   if(p < 0) return 0;
   p += StringLen(key);
   bool neg = (p < StringLen(s) && StringGetCharacter(s, p)=='-');
   if(neg) p++;
   long v = 0;
   while(p < StringLen(s))
   {
      ushort ch = StringGetCharacter(s, p);
      if(ch < '0' || ch > '9') break;
      v = v*10 + (ch - '0');
      p++;
   }
   return neg ? -v : v;
}

string ParseStringAfter(string s, string key)
{
   int p = StringFind(s, key);
   if(p < 0) return "";
   p += StringLen(key);
   int q = StringFind(s, "\"", p);
   if(q < 0) return "";
   return StringSubstr(s, p, q-p);
}

void HandleCommand(string text)
{
   StringTrimLeft(text);
   StringTrimRight(text);

   string cmd = text, arg = "";
   int sp = StringFind(text, " ");
   if(sp > 0) { cmd = StringSubstr(text, 0, sp); arg = StringSubstr(text, sp+1); }
   int at = StringFind(cmd, "@"); // strip /cmd@BotName
   if(at > 0) cmd = StringSubstr(cmd, 0, at);
   StringToLower(cmd);
   StringTrimLeft(arg);
   StringTrimRight(arg);

   if(cmd=="/pause")
   {
      GlobalVariableSet("MAHA.cmd.pause", 1.0);
      SendTelegram("⏸ Auto trading paused (all charts). Send /resume to continue.");
   }
   else if(cmd=="/resume")
   {
      GlobalVariableSet("MAHA.cmd.pause", 0.0);
      SendTelegram("▶️ Auto trading resumed.");
   }
   else if(cmd=="/close")
   {
      string gv = (StringLen(arg)>0) ? "MAHA.cmd.close."+arg : "MAHA.cmd.close";
      GlobalVariableSet(gv, (double)TimeCurrent());
   }
   else if(cmd=="/status")
      GlobalVariableSet("MAHA.cmd.status", (double)TimeCurrent());
   else if(StringLen(cmd)>0 && StringGetCharacter(cmd, 0)=='/')
      SendTelegram("Commands: /status · /pause · /resume · /close [symbol]");
}

void HandleBroadcasts()
{
   //--- /status: every instance answers for its own symbol
   datetime ts = (datetime)(long)GlobalVariableGet("MAHA.cmd.status");
   if(ts > g_lastStatusTs)
   {
      g_lastStatusTs = ts;
      SendTelegram(StatusText());
   }

   //--- /close: global, exact symbol, or suffix-less display name
   datetime c1 = (datetime)(long)GlobalVariableGet("MAHA.cmd.close");
   datetime c2 = (datetime)(long)GlobalVariableGet("MAHA.cmd.close."+_Symbol);
   datetime c3 = (datetime)(long)GlobalVariableGet("MAHA.cmd.close."+CleanSymbol());
   datetime ct = (c1>c2 ? c1 : c2);
   if(c3>ct) ct = c3;
   if(ct > g_lastCloseTs)
   {
      g_lastCloseTs = ct;
      ulong ticket; long dir;
      if(FindPosition(ticket, dir))
         ClosePosition(ticket, dir, "manual /close command");
   }
}

string StatusText()
{
   string s = "📊 <b>"+CleanSymbol()+" · "+TFName(InpTradeTF)+"</b>\n";
   s += "AutoTrade: "+(InpAutoTrade ? (CmdPaused() ? "⏸ paused" : "ON") : "OFF");
   s += " · mode: "+(InpEntryMode==ENTRY_PULLBACK ? "Pullback" : "Cross");

   ulong ticket; long dir;
   if(FindPosition(ticket, dir) && PositionSelectByTicket(ticket))
   {
      double open = PositionGetDouble(POSITION_PRICE_OPEN);
      double curp = PositionGetDouble(POSITION_PRICE_CURRENT);
      double pips = (dir>0 ? curp-open : open-curp)/PipSize();
      s += "\nPosition: "+(dir>0 ? "BUY " : "SELL ")+
           DoubleToString(PositionGetDouble(POSITION_VOLUME), 2)+" @ "+
           DoubleToString(open, _Digits)+
           " ("+(pips>=0 ? "+" : "")+DoubleToString(pips, 1)+" pips)";
   }
   else s += "\nPosition: none";

   PeriodStats st;
   if(CollectStats(DayStart(TimeCurrent()), TimeCurrent()+60, st) && st.trades>0)
      s += "\nToday: "+IntegerToString(st.trades)+" trades · "+
           IntegerToString(st.wins)+" wins · net "+
           (st.netPips>=0 ? "+" : "")+DoubleToString(st.netPips, 1)+" pips";
   else
      s += "\nToday: no closed trades";

   if(!BreakerAllowsQuiet())
      s += "\n⛔ Circuit breaker active";
   return s;
}

// breaker state without the Telegram notification side effect
bool BreakerAllowsQuiet()
{
   if(!InpUseBreaker) return true;
   PeriodStats st;
   if(!CollectStats(DayStart(TimeCurrent()), TimeCurrent()+60, st)) return true;
   if(InpMaxConsecLoss>0 && st.tailLosses>=InpMaxConsecLoss) return false;
   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   if(InpMaxDailyLossPct>0 && balance>0 &&
      st.netMoney <= -balance*InpMaxDailyLossPct/100.0) return false;
   return true;
}

//+------------------------------------------------------------------+
//| Daily recap to Telegram; weekly totals appended every Monday     |
//+------------------------------------------------------------------+
void CheckDailySummary()
{
   if(!InpDailySummary) return;

   datetime today = DayStart(TimeCurrent());
   datetime last  = (datetime)(long)GlobalVariableGet(GVName("sum"));
   if(last==0) { GlobalVariableSet(GVName("sum"), (double)today); return; }
   if(last >= today) return;
   GlobalVariableSet(GVName("sum"), (double)today);

   string s = "";
   PeriodStats st;
   if(CollectStats(today-86400, today, st) && st.trades>0)
      s = "🗓 <b>Daily recap — "+CleanSymbol()+"</b>\n"+
          IntegerToString(st.trades)+" trades · "+IntegerToString(st.wins)+" wins\n"+
          "Net: "+(st.netPips>=0 ? "+" : "")+DoubleToString(st.netPips, 1)+" pips ("+
          DoubleToString(st.netMoney, 2)+" "+AccountInfoString(ACCOUNT_CURRENCY)+")";

   MqlDateTime dt;
   TimeToStruct(today, dt);
   if(dt.day_of_week==1) // Monday: include last week's totals
   {
      PeriodStats wk;
      if(CollectStats(today-7*86400, today, wk) && wk.trades>0)
         s += (s=="" ? "" : "\n\n")+
              "📅 <b>Last 7 days — "+CleanSymbol()+"</b>\n"+
              IntegerToString(wk.trades)+" trades · "+IntegerToString(wk.wins)+" wins\n"+
              "Net: "+(wk.netPips>=0 ? "+" : "")+DoubleToString(wk.netPips, 1)+" pips ("+
              DoubleToString(wk.netMoney, 2)+" "+AccountInfoString(ACCOUNT_CURRENCY)+")";
   }
   if(s!="") SendTelegram(s);
}

//+------------------------------------------------------------------+
//| CSV research log in MQL5/Files (one file per symbol+magic)       |
//+------------------------------------------------------------------+
int OpenLog()
{
   if(!InpCSVLog) return INVALID_HANDLE;
   string name = "MAHA_"+_Symbol+"_"+IntegerToString(InpMagic)+".csv";
   int h = FileOpen(name, FILE_READ|FILE_WRITE|FILE_TXT|FILE_ANSI);
   if(h==INVALID_HANDLE)
   {
      Print("CSV open failed: ", GetLastError());
      return INVALID_HANDLE;
   }
   if(FileSize(h)==0)
      FileWriteString(h, "time;event;side;lots;price;sl;tp;pips;reason;"+
                         "haScore;haStreak;haBodyPct;adx;emaGapATR;spreadPts\n");
   FileSeek(h, 0, SEEK_END);
   return h;
}

void LogCSVEntry(string side, double lots, double price, double sl, double tp,
                 HAState &ha, double adx, double gapATR)
{
   int h = OpenLog();
   if(h==INVALID_HANDLE) return;
   double spread = (SymbolInfoDouble(_Symbol, SYMBOL_ASK)
                  - SymbolInfoDouble(_Symbol, SYMBOL_BID))/_Point;
   FileWriteString(h,
      TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS)+";ENTRY;"+side+";"+
      DoubleToString(lots, 2)+";"+DoubleToString(price, _Digits)+";"+
      DoubleToString(sl, _Digits)+";"+DoubleToString(tp, _Digits)+";;"+
      (InpEntryMode==ENTRY_PULLBACK ? "pullback" : "cross")+";"+
      IntegerToString(HAScore(ha))+";"+IntegerToString(ha.streak)+";"+
      DoubleToString(ha.bodyPct, 0)+";"+DoubleToString(adx, 1)+";"+
      DoubleToString(gapATR, 2)+";"+DoubleToString(spread, 0)+"\n");
   FileClose(h);
}

void LogCSVExit(string event, double pips, string reason)
{
   int h = OpenLog();
   if(h==INVALID_HANDLE) return;
   FileWriteString(h,
      TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS)+";"+event+";;;;;;"+
      DoubleToString(pips, 1)+";"+reason+";;;;;;\n");
   FileClose(h);
}

//+------------------------------------------------------------------+
//| Report SL/TP hits (broker-side closes the EA didn't initiate)    |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest &request,
                        const MqlTradeResult &result)
{
   if(!InpAutoTrade) return;
   if(trans.type != TRADE_TRANSACTION_DEAL_ADD) return;
   if(!HistoryDealSelect(trans.deal)) return;

   if(HistoryDealGetString(trans.deal, DEAL_SYMBOL)  != _Symbol)  return;
   if(HistoryDealGetInteger(trans.deal, DEAL_MAGIC)  != InpMagic) return;

   ENUM_DEAL_ENTRY entry = (ENUM_DEAL_ENTRY)HistoryDealGetInteger(trans.deal, DEAL_ENTRY);
   if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_INOUT) return;

   ENUM_DEAL_REASON reason = (ENUM_DEAL_REASON)HistoryDealGetInteger(trans.deal, DEAL_REASON);
   bool manualClose = (reason==DEAL_REASON_CLIENT || reason==DEAL_REASON_MOBILE ||
                       reason==DEAL_REASON_WEB);
   if(reason != DEAL_REASON_SL && reason != DEAL_REASON_TP && !manualClose)
      return; // EA-initiated closes (DEAL_REASON_EXPERT) already reported

   double closePrice = HistoryDealGetDouble(trans.deal, DEAL_PRICE);
   bool   wasLong    = ((ENUM_DEAL_TYPE)HistoryDealGetInteger(trans.deal, DEAL_TYPE)==DEAL_TYPE_SELL);
   long   posId      = HistoryDealGetInteger(trans.deal, DEAL_POSITION_ID);

   //--- open price comes from the entry deal of the same position
   double openPrice = 0.0;
   if(HistorySelectByPosition(posId))
      for(int i=0; i<HistoryDealsTotal(); i++)
      {
         ulong d = HistoryDealGetTicket(i);
         if((ENUM_DEAL_ENTRY)HistoryDealGetInteger(d, DEAL_ENTRY)==DEAL_ENTRY_IN)
         {
            openPrice = HistoryDealGetDouble(d, DEAL_PRICE);
            break;
         }
      }
   if(openPrice<=0.0)
   {
      Print("SL/TP close: entry deal not found for position ", posId);
      return;
   }

   double pips = (wasLong ? closePrice-openPrice : openPrice-closePrice)/PipSize();
   //--- a partial close leaves the position open: no alert until it is fully closed
   if(PositionSelectByTicket((ulong)posId)) return;

   string why  = (reason==DEAL_REASON_TP) ? (InpUseLadder ? "TP3 hit" : "Take Profit hit")
               : (reason==DEAL_REASON_SL) ? "Stop Loss hit"
                                          : "Manual close";
   ReportClose(pips, why, true, posId);
}

//+------------------------------------------------------------------+
//+------------------------------------------------------------------+
string BuildMessage(ENUM_TIMEFRAMES tf, bool bull)
{
   HAState ha;
   GetHAState(tf, ha);

   string head = bull
      ? "📈 <b>GOLDEN CROSS</b> — EMA"+IntegerToString(InpFastPeriod)+" crossed ABOVE EMA"+IntegerToString(InpSlowPeriod)
      : "📉 <b>DEATH CROSS</b> — EMA"+IntegerToString(InpFastPeriod)+" crossed BELOW EMA"+IntegerToString(InpSlowPeriod);

   string msg = "🔔 <b>"+CleanSymbol()+" · "+TFName(tf)+"</b>\n" + head + "\n" +
                Recommendation(bull, ha) + "\n\n" +
                HAText(ha);
   return msg;
}

//+------------------------------------------------------------------+
//| HA confirmation score: -1..2 (shared by alerts and auto trading) |
//+------------------------------------------------------------------+
int HAScore(HAState &st)
{
   int score = 0;
   if(st.strongWick)      score++;  // flat wick in the trend direction
   if(st.bodyPct >= 60.0) score++;  // dominant body
   if(st.indecision)      score--;  // wicks on both sides = indecision
   return score;
}

//+------------------------------------------------------------------+
//| BUY / SELL / WAIT suggestion based on cross + HA confirmation    |
//+------------------------------------------------------------------+
string Recommendation(bool bullCross, HAState &st)
{
   if(!st.valid)
      return "🎯 <b>Suggestion: WAIT</b> — not enough HA data";

   // HA against the cross direction -> do not enter yet
   if(st.bull != bullCross)
      return "🎯 <b>Suggestion: ⏸ WAIT</b> — HA candle is against the cross direction, wait for the next candle to confirm";

   string action = bullCross ? "🔵 BUY" : "🔴 SELL";

   int score = HAScore(st);

   string rec;
   if(score >= 2)      rec = "🎯 <b>Suggestion: "+action+"</b> 💪 — strong HA confirmation";
   else if(score == 1) rec = "🎯 <b>Suggestion: "+action+"</b> — decent HA confirmation";
   else                rec = "🎯 <b>Suggestion: "+action+" (caution)</b> — HA aligned but momentum is weak";

   if(st.streak >= 10)
      rec += "\n⚠️ HA trend has been running for "+IntegerToString(st.streak)+
             " bars — risk of a late entry, watch for a pullback";

   return rec;
}

//+------------------------------------------------------------------+
//| Calculate Heikin Ashi from real OHLC -> fill the HAState struct  |
//+------------------------------------------------------------------+
bool GetHAState(ENUM_TIMEFRAMES tf, HAState &st)
{
   st.valid=false; st.bull=false; st.streak=0;
   st.bodyPct=0.0; st.strongWick=false; st.indecision=false;

   MqlRates r[];
   int got = CopyRates(_Symbol, tf, 0, 150, r); // r[0] = oldest
   if(got < 20) return false;

   double haO[], haC[], haH[], haL[];
   ArrayResize(haO, got); ArrayResize(haC, got);
   ArrayResize(haH, got); ArrayResize(haL, got);

   haO[0]=(r[0].open+r[0].close)/2.0;
   haC[0]=(r[0].open+r[0].high+r[0].low+r[0].close)/4.0;
   haH[0]=r[0].high;  haL[0]=r[0].low;
   for(int i=1; i<got; i++)
   {
      haC[i]=(r[i].open+r[i].high+r[i].low+r[i].close)/4.0;
      haO[i]=(haO[i-1]+haC[i-1])/2.0;
      haH[i]=MathMax(r[i].high, MathMax(haO[i], haC[i]));
      haL[i]=MathMin(r[i].low,  MathMin(haO[i], haC[i]));
   }

   int k = got-2; // last closed bar
   st.bull = (haC[k] >= haO[k]);

   st.streak = 1;
   for(int i=k-1; i>=0 && st.streak<50; i--)
   {
      if(((haC[i] >= haO[i])) == st.bull) st.streak++;
      else break;
   }

   double body  = MathAbs(haC[k]-haO[k]);
   double range = haH[k]-haL[k];
   if(range <= 0.0) range = (body>0.0 ? body : 1e-10);
   double upW = haH[k]-MathMax(haO[k], haC[k]);
   double loW = MathMin(haO[k], haC[k])-haL[k];

   st.bodyPct    = 100.0*body/range;
   st.strongWick = st.bull ? (loW <= 0.10*range) : (upW <= 0.10*range);
   st.indecision = (upW > 0.25*range && loW > 0.25*range);
   st.valid      = true;
   return true;
}

//+------------------------------------------------------------------+
//| Heikin Ashi condition description for the message                |
//+------------------------------------------------------------------+
string HAText(HAState &st)
{
   if(!st.valid) return "🕯 Heikin Ashi: not enough data";

   string wick;
   if(st.strongWick)
      wick = st.bull ? "• Almost no lower wick → buying pressure dominant\n"
                     : "• Almost no upper wick → selling pressure dominant\n";
   else if(st.indecision)
      wick = "• Long wicks on both sides → market indecision\n";
   else
      wick = "• "+(st.bull ? "Lower" : "Upper")+" wick still present → momentum not full yet\n";

   string strength = st.bodyPct>=60 ? "strong" : (st.bodyPct>=30 ? "moderate" : "weak / near doji");

   string s = "🕯 <b>Heikin Ashi</b>\n";
   s += "• Candle: "+(st.bull ? "🟢 GREEN" : "🔴 RED")+", "+IntegerToString(st.streak)+" consecutive bars\n";
   s += wick;
   s += "• Body "+DoubleToString(st.bodyPct, 0)+"% of range ("+strength+")";
   return s;
}

//+------------------------------------------------------------------+
//| Send a Telegram message (HTML parse mode).                       |
//| replyTo > 0 makes it a reply to that message id.                 |
//| Returns the sent message id (>0), or -1 on failure.              |
//+------------------------------------------------------------------+
//+------------------------------------------------------------------+
//| Delete one of the bot's own messages (Bot API deleteMessage;     |
//| own messages are deletable within 48h — far beyond signal life)  |
//+------------------------------------------------------------------+
void DeleteTelegram(long msgId)
{
   if(msgId<=0) return;
   if(MQLInfoInteger(MQL_TESTER)) return;
   if(StringLen(InpBotToken) < 10 || StringLen(InpChatID) < 3) return;

   string url      = "https://api.telegram.org/bot"+InpBotToken+"/deleteMessage";
   string headers  = "Content-Type: application/x-www-form-urlencoded\r\n";
   string postData = "chat_id="+InpChatID+"&message_id="+IntegerToString(msgId);

   char post[], result[];
   string rh;
   int n = StringToCharArray(postData, post, 0, WHOLE_ARRAY, CP_UTF8);
   if(n > 0) ArrayResize(post, n-1);

   ResetLastError();
   int status = WebRequest("POST", url, headers, 10000, post, result, rh);
   if(status != 200)
      Print("deleteMessage failed, HTTP ", status, ": ",
            CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8));
}

long SendTelegram(string text, long replyTo=0)
{
   if(MQLInfoInteger(MQL_TESTER)) return -1; // no WebRequest in the tester
   if(StringLen(InpBotToken) < 10 || StringLen(InpChatID) < 3) return -1;

   string url      = "https://api.telegram.org/bot"+InpBotToken+"/sendMessage";
   string headers  = "Content-Type: application/x-www-form-urlencoded\r\n";
   string postData = "chat_id="+InpChatID+"&parse_mode=HTML&text="+URLEncode(text);
   if(replyTo>0)
      postData += "&reply_to_message_id="+IntegerToString(replyTo)+
                  "&allow_sending_without_reply=true";

   char post[], result[];
   string resultHeaders;
   int n = StringToCharArray(postData, post, 0, WHOLE_ARRAY, CP_UTF8);
   if(n > 0) ArrayResize(post, n-1); // strip the null terminator

   //--- transient network hiccups are common under Wine; one retry clears most of them
   int status = -1;
   for(int attempt=1;; attempt++)
   {
      ResetLastError();
      status = WebRequest("POST", url, headers, 10000, post, result, resultHeaders);
      if(status==200 || attempt>=2) break;
      Print("Telegram send attempt ", attempt, " failed (HTTP ", status,
            ", err ", GetLastError(), "), retrying...");
      Sleep(500);
   }

   if(status == -1)
   {
      Print("WebRequest failed, error ", GetLastError(),
            ". Make sure 'https://api.telegram.org' is added under ",
            "Tools > Options > Expert Advisors > Allow WebRequest.");
      return -1;
   }
   if(status != 200)
   {
      Print("Telegram HTTP ", status, ": ", CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8));
      return -1;
   }

   //--- pull message_id out of {"ok":true,"result":{"message_id":123,...}}
   string resp = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   int p = StringFind(resp, "\"message_id\":");
   if(p < 0) return 0;
   p += 13; // length of "message_id":
   long id = 0;
   while(p < StringLen(resp))
   {
      ushort ch = StringGetCharacter(resp, p);
      if(ch < '0' || ch > '9') break;
      id = id*10 + (ch - '0');
      p++;
   }
   return id;
}

//+------------------------------------------------------------------+
//| Percent-encode a string as UTF-8 bytes (emoji-safe)              |
//+------------------------------------------------------------------+
string URLEncode(string text)
{
   uchar bytes[];
   int len = StringToCharArray(text, bytes, 0, WHOLE_ARRAY, CP_UTF8);
   string out = "";
   for(int i=0; i<len-1; i++) // len-1: skip the null terminator
   {
      uchar c = bytes[i];
      if((c>='0' && c<='9') || (c>='A' && c<='Z') || (c>='a' && c<='z') ||
         c=='-' || c=='_' || c=='.' || c=='~')
         out += CharToString((char)c);
      else
         out += StringFormat("%%%02X", c);
   }
   return out;
}
//+------------------------------------------------------------------+
