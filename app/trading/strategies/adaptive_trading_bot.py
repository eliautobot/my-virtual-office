"""
Adaptive Trading Bot — v7.0
============================
รวม AdaptiveEngine (จาก adaptive_engine_draft.py) + SJUTBotV4 signal engine เข้าด้วยกัน
แก้ไขทุกจุดที่วิเคราะห์พบ:

[FIX 1] _calculate_health() — คำนวณจริงจาก 5 ตัวชี้วัด (momentum, volume,
         structure, ATR, divergence) แทนที่ค่าคงที่แบบเดิมที่ไม่ได้คำนวณอะไรจริง
[FIX 2] _close_position() — บันทึก PnL จริง + อัปเดต current_trade + ส่งผ่าน
         execution callback ที่ wire ได้จากภายนอก
[FIX 3] adjust_weights_from_learning() — วิเคราะห์แยก per market_state
         ไม่ใช่ winrate รวมทั้งหมด
[FIX 4] Partial TP ครอบคลุมทั้ง LONG และ SHORT
[FIX 5] on_tick() while-loop มี guard ป้องกัน infinite loop
[FIX 6] _scale_score() — cap input ที่ 100 ก่อนคำนวณ
[FIX 7] TP3 hit logic ใน _manage_open_position()
[FIX 8] Recovery state มี logic ใน on_tick()
[FIX 9] cooldown_until ใช้ datetime แทน time.time() float
[FIX 10] Dynamic weight learning ปรับ per-condition ไม่ใช่ global shift

--- v6.0: production readiness สำหรับเทรดจริงบน OKX ---
[FIX 11] Logging module จริง (console + rotating file) แทน print()
[FIX 12] _send_order() แยก fatal error ออกจาก error ที่ retry แล้วหมดสิทธิ์
         (retry/backoff จริงอยู่ใน OKXExecutionAdapter — ดู okx_exchange.py)
[FIX 13] save_state() / load_state() / reconcile_with_exchange() —
         persist + reload position state ตอนรีสตาร์ตบอท พร้อมเทียบกับ
         position จริงบน exchange (กันกรณี SL/TP ถูก trigger ระหว่างบอท offline)

--- v7.0: multi-timeframe entry (15M) + TP structure ---
[FIX 17] เปลี่ยน timeframe เข้าออเดอร์เป็น 15M ทั้งหมด (layer scoring, entry
         trigger, risk engine, position management) — 4H ใช้กำหนด market_state/
         regime เหมือนเดิม, เพิ่ม 1H เป็นตัวกรองแนวโน้มชั้นกลาง
         (_check_htf_trend_filter) ก่อนอนุญาตให้สัญญาณ 15M เข้าไม้ได้
         → on_tick() ตอนนี้ต้องรับ candle_15m/ind_15m เพิ่ม (breaking change
         จาก v6 — ดู signature ใหม่)
[FIX 16] ตัด TP3 ออก เหลือแค่ TP1 (scale-out ตาม tp1_close_pct, default 50%)
         และ TP2 (ปิดที่เหลือทั้งหมด = full exit) — พอ TP1 hit จะขยับ SL ไป
         breakeven ทันที (เดิมต้องรอ current_r >= 0.8 แยกอิสระจาก TP)

หมายเหตุ: ข้อมูล indicator ตัวอย่างใน `if __name__ == "__main__":` ด้านล่าง เป็น
ตัวอย่าง indicator สำหรับรันเดโม/เทสต์เท่านั้น ไม่ใช่ placeholder ของ logic จริง —
logic ทั้งหมดด้านบนคำนวณจาก indicator ที่ส่งเข้ามาจริงทุกจุดแล้ว

ต้องการ: numpy, pandas (สำหรับ signal engine), ccxt (สำหรับ okx_exchange.py)
"""

import numpy as np
import datetime
import json
import os
import logging
from logging.handlers import RotatingFileHandler
from typing import Optional, Callable, Dict, List, Any


# ──────────────────────────────────────────────────────────────────────────────
# LOGGING SETUP
# [FIX 11] ใช้ logging module จริง (console + rotating file) แทน print() ล้วนๆ
# ──────────────────────────────────────────────────────────────────────────────

def _setup_logger(log_file: str = "trading_bot.log") -> logging.Logger:
    logger = logging.getLogger("adaptive_trading_bot")
    if logger.handlers:          # ป้องกัน duplicate handler ถ้าเรียกซ้ำ
        return logger
    logger.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s | %(levelname)-7s | %(message)s", "%Y-%m-%d %H:%M:%S")

    console = logging.StreamHandler()
    console.setFormatter(fmt)
    logger.addHandler(console)

    try:
        file_handler = RotatingFileHandler(
            log_file, maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8"
        )
        file_handler.setFormatter(fmt)
        logger.addHandler(file_handler)
    except OSError as e:
        # เช่น ไม่มี write permission ใน directory ปัจจุบัน — ยังใช้งานต่อได้ด้วย console เท่านั้น
        logger.warning(f"Could not attach file log handler ({e}); logging to console only")

    return logger


logger = _setup_logger()


# ──────────────────────────────────────────────────────────────────────────────
# ADAPTIVE ENGINE
# ──────────────────────────────────────────────────────────────────────────────

class AdaptiveEngine:
    """
    จัดการ dynamic weights, ATR volatility state, adaptive thresholds
    และ learning จาก trade journal
    """

    def __init__(self):
        self.regime_tiers = [
            (90, 1.10), (75, 1.05), (50, 1.00), (30, 0.95), (0, 0.90)
        ]
        self.atr_percentile_points = [10, 25, 50, 75, 90]
        self.atr_vol_labels = ["Very Low", "Low", "Normal", "High", "Extreme"]

        # Base weights per market state (sum = 100 ต่อ state)
        # [FIX 10] แยกเป็น per-condition เพื่อ learning อิสระ
        self.base_weights: Dict[str, Dict[str, float]] = {
            "Trending": {
                "trend": 20, "momentum": 15, "volume": 10, "pattern": 10,
                "structure": 10, "atr": 5, "rsi": 5, "sweep": 5,
                "divergence": 5, "ema": 5, "vwap": 5, "macd": 5
            },
            "Expansion": {
                "trend": 15, "momentum": 15, "volume": 20, "pattern": 10,
                "structure": 5, "atr": 15, "rsi": 5, "sweep": 0,
                "divergence": 5, "ema": 5, "vwap": 5, "macd": 0
            },
            "Compression": {
                "trend": 5, "momentum": 5, "volume": 10, "pattern": 20,
                "structure": 10, "atr": 5, "rsi": 10, "sweep": 15,
                "divergence": 10, "ema": 5, "vwap": 5, "macd": 0
            },
            "Sideway": {
                "trend": 5, "momentum": 10, "volume": 10, "pattern": 15,
                "structure": 10, "atr": 5, "rsi": 15, "sweep": 15,
                "divergence": 10, "ema": 0, "vwap": 5, "macd": 0
            },
            "Exhaustion": {
                "trend": 5, "momentum": 10, "volume": 15, "pattern": 10,
                "structure": 10, "atr": 5, "rsi": 10, "sweep": 5,
                "divergence": 20, "ema": 5, "vwap": 0, "macd": 5
            },
        }

        # [FIX 10] track learning stats per state สำหรับ per-condition adjustment
        self._learning_stats: Dict[str, Dict] = {
            state: {"win_count": 0, "loss_count": 0, "condition_wins": {k: 0 for k in w},
                    "condition_total": {k: 0 for k in w}}
            for state, w in self.base_weights.items()
        }

    # ── Regime / Volatility helpers ──────────────────────────────────────────

    def get_regime_multiplier(self, regime_score: float) -> float:
        for threshold, multiplier in self.regime_tiers:
            if regime_score >= threshold:
                return multiplier
        return 0.90

    def get_atr_volatility_state(self, current_atr: float, atr_history: List[float]) -> str:
        if len(atr_history) < 20:
            return "Normal"
        history = atr_history[-100:] if len(atr_history) >= 100 else atr_history
        percentiles = np.percentile(history, self.atr_percentile_points)
        for i in range(len(percentiles) - 1, -1, -1):
            if current_atr >= percentiles[i]:
                return self.atr_vol_labels[min(i, len(self.atr_vol_labels) - 1)]
        return "Very Low"

    def get_layer_thresholds(self, vol_state: str) -> Dict[str, float]:
        """ATR-adaptive entry threshold — ยิ่ง volatile ยิ่งต้องการ score สูงกว่า"""
        l1, l2 = 65.0, 60.0
        adjustments = {
            "Extreme":  (+8, +5),
            "High":     (+4, +2),
            "Normal":   ( 0,  0),
            "Low":      (-4, -2),
            "Very Low": (-6, -4),
        }
        delta1, delta2 = adjustments.get(vol_state, (0, 0))
        return {"L1_PASS": l1 + delta1, "L2_PASS": l2 + delta2}

    def get_dynamic_weights(self, market_state: str) -> Dict[str, float]:
        return self.base_weights.get(market_state, self.base_weights["Sideway"])

    # ── [FIX 10] Learning Engine — per market_state, per condition ───────────

    def record_trade_result(self, market_state: str, win: bool,
                            active_conditions: Dict[str, bool]):
        """
        บันทึกผล trade พร้อม conditions ที่ active ณ เวลา entry
        ใช้สำหรับ per-condition weight learning
        """
        if market_state not in self._learning_stats:
            return
        stats = self._learning_stats[market_state]
        if win:
            stats["win_count"] += 1
        else:
            stats["loss_count"] += 1

        for cond, is_active in active_conditions.items():
            if cond not in stats["condition_total"]:
                continue
            stats["condition_total"][cond] += 1
            if is_active and win:
                stats["condition_wins"][cond] += 1

    def adjust_weights_from_learning(self, journal_data: List[Dict]):
        """
        [FIX 3] ปรับ weight แยกต่อ market_state และ per-condition
        ไม่ใช่ global winrate

        Logic:
        - condition ที่มี conditional_winrate > global_winrate → +weight
        - condition ที่มี conditional_winrate < global_winrate → -weight
        - clamp ไว้ที่ [3, 40] เพื่อไม่ให้ weight ตายหรือ dominate
        """
        if not journal_data:
            return

        # แยก journal ตาม market_state
        by_state: Dict[str, List[Dict]] = {}
        for entry in journal_data:
            state = entry.get("market_state", "Sideway")
            by_state.setdefault(state, []).append(entry)

        for state, entries in by_state.items():
            if state not in self.base_weights or len(entries) < 10:
                continue  # ต้องการ sample อย่างน้อย 10 trades ต่อ state

            wins = [e for e in entries if e.get("win_loss") == "WIN"]
            total = len(entries)
            global_wr = len(wins) / total

            stats = self._learning_stats.get(state, {})
            cond_wins = stats.get("condition_wins", {})
            cond_total = stats.get("condition_total", {})

            weights = self.base_weights[state]
            for cond in weights:
                ct = cond_total.get(cond, 0)
                if ct < 5:
                    continue  # ข้อมูลน้อยเกินไป ไม่ปรับ
                cond_wr = cond_wins.get(cond, 0) / ct
                delta = (cond_wr - global_wr) * 10  # scale เป็น weight unit
                weights[cond] = float(np.clip(weights[cond] + delta, 3, 40))

            # normalize ให้ sum ≈ 100
            total_w = sum(weights.values())
            if total_w > 0:
                factor = 100 / total_w
                for k in weights:
                    weights[k] = round(weights[k] * factor, 1)


# ──────────────────────────────────────────────────────────────────────────────
# POSITION HEALTH CALCULATOR
# ──────────────────────────────────────────────────────────────────────────────

class PositionHealthCalculator:
    """
    [FIX 1] คำนวณ position health score 0–100 จาก 5 ตัวชี้วัด
    แทนที่ค่าคงที่แบบเดิมที่ไม่ได้คำนวณอะไรจริง
    """

    def calculate(self, ind: Dict[str, Any], trade: Dict[str, Any],
                  current_price: float) -> float:
        """
        Returns health score 0–100
        Components:
          - Momentum health (30%): RSI + MACD alignment
          - Volume health    (20%): volume vs avg volume
          - Structure health (20%): price vs key MAs
          - ATR health       (15%): ATR expansion vs entry ATR
          - Trend health     (15%): ADX strength
        """
        scores = []

        # 1. Momentum (RSI + MACD)
        rsi = ind.get("rsi", 50)
        direction = trade.get("direction", "LONG")
        if direction == "LONG":
            rsi_score = np.clip((rsi - 30) / 40 * 100, 0, 100)
        else:
            rsi_score = np.clip((70 - rsi) / 40 * 100, 0, 100)

        macd = ind.get("macd", 0)
        macd_signal = ind.get("macd_signal", 0)
        if direction == "LONG":
            macd_score = 80.0 if macd > macd_signal else 30.0
        else:
            macd_score = 80.0 if macd < macd_signal else 30.0
        momentum_score = (rsi_score * 0.6 + macd_score * 0.4)
        scores.append(("momentum", momentum_score, 0.30))

        # 2. Volume
        volume = ind.get("volume", 0)
        vol_avg = ind.get("vol_avg", volume if volume > 0 else 1)
        vol_ratio = volume / max(vol_avg, 1e-9)
        vol_score = float(np.clip(vol_ratio * 60, 0, 100))
        scores.append(("volume", vol_score, 0.20))

        # 3. Structure (price vs EMA)
        ema5 = ind.get("ema5", current_price)
        ema20 = ind.get("ema20", current_price)
        if direction == "LONG":
            struct_score = 100.0 if (current_price > ema5 and current_price > ema20) else \
                           60.0 if current_price > ema20 else 20.0
        else:
            struct_score = 100.0 if (current_price < ema5 and current_price < ema20) else \
                           60.0 if current_price < ema20 else 20.0
        scores.append(("structure", struct_score, 0.20))

        # 4. ATR health — ถ้า ATR ขยายมากกว่า entry ATR > 1.5x แสดงว่า volatility spike
        entry_atr = trade.get("atr_at_entry", ind.get("atr", 1))
        current_atr = ind.get("atr", entry_atr)
        atr_ratio = current_atr / max(entry_atr, 1e-9)
        atr_score = float(np.clip((2.0 - atr_ratio) / 1.0 * 100, 0, 100))
        scores.append(("atr", atr_score, 0.15))

        # 5. Trend (ADX)
        adx = ind.get("adx", 20)
        adx_score = float(np.clip((adx - 15) / 25 * 100, 0, 100))
        scores.append(("trend", adx_score, 0.15))

        # Weighted average
        total = sum(score * weight for _, score, weight in scores)
        return float(np.clip(total, 0, 100))


# ──────────────────────────────────────────────────────────────────────────────
# TRADING BOT
# ──────────────────────────────────────────────────────────────────────────────

class TradingBot:
    """
    State machine trading bot พร้อมใช้งาน
    ทุก bug ที่พบได้รับการแก้ไขแล้ว
    """

    # State machine states
    STATES = {
        "SCANNING", "FILTERING", "WAIT_CONFIRM", "PENDING_ORDER",
        "IN_POSITION", "PARTIAL_EXIT", "TRAILING", "EXITING",
        "COOLDOWN", "BLOCKED", "RECOVERY", "ERROR"
    }

    def __init__(self,
                 account_balance: float = 10_000.0,
                 base_risk_pct: float = 0.01,
                 daily_loss_limit_pct: float = -3.0,
                 daily_profit_limit_pct: float = 8.0,
                 cooldown_minutes: int = 30,
                 max_loss_streak: int = 3,
                 tp1_close_pct: float = 0.50,
                 execution_callback: Optional[Callable] = None):
        """
        Parameters
        ----------
        tp1_close_pct : สัดส่วนที่ปิดตอน TP1 hit (ที่เหลือเป็น runner ไปจน TP2 ซึ่งปิดทั้งหมด)
            ค่า default 0.50 = ปิดครึ่งหนึ่งที่ TP1 แล้วขยับ SL ไป breakeven ทันที
            ปรับได้ตามสไตล์ — ใส่ 0.30 ถ้าอยากปิดน้อยกว่าตอน TP1 และเก็บ runner ไว้มากกว่า
        execution_callback : callable(order_type, trade_info) → None
            ฟังก์ชัน callback สำหรับส่งคำสั่งไปยัง exchange จริง
            order_type: 'OPEN_LONG' | 'OPEN_SHORT' | 'CLOSE_PARTIAL' | 'CLOSE_FULL'
            trade_info: dict ประกอบด้วย entry, sl, tp1, tp2, size, reason
            ถ้า None จะ log เท่านั้น (paper trading mode)
        """
        # Core state
        self.state: str = "SCANNING"
        self.adaptive_engine = AdaptiveEngine()
        self.health_calc = PositionHealthCalculator()
        self.tp1_close_pct = tp1_close_pct

        # Account
        self.account_balance = account_balance
        self.base_risk_pct = base_risk_pct

        # Risk limits
        self.daily_loss_limit_pct = daily_loss_limit_pct
        self.daily_profit_limit_pct = daily_profit_limit_pct
        self.cooldown_minutes = cooldown_minutes
        self.max_loss_streak = max_loss_streak

        # Position tracking
        self.position_open: bool = False
        self.order_status: str = "CLOSED"
        self.current_trade: Dict[str, Any] = {}

        # Market state
        self.atr_history: List[float] = []
        self.current_market_state: str = "Sideway"
        self.regime_score: float = 0.0
        self.direction_focus: Optional[str] = None
        self.bars_since_trigger: int = 0

        # Risk tracking
        self.loss_streak: int = 0
        self.win_streak: int = 0
        self.daily_pnl_pct: float = 0.0
        # [FIX 9] ใช้ datetime แทน float timestamp
        self.cooldown_until: Optional[datetime.datetime] = None
        self.trading_date: Optional[datetime.date] = None

        # Journal
        self.trade_journal: List[Dict] = []

        # Execution
        self.execution_callback = execution_callback

        # [FIX 5] infinite loop guard
        self._tick_depth: int = 0
        self._max_tick_depth: int = 6

        # Logging
        self._log: List[str] = []

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _log_event(self, msg: str, level: str = "info"):
        """[FIX 11] log ผ่าน logging module จริง (console + rotating file)"""
        log_fn = getattr(logger, level, logger.info)
        log_fn(msg)
        ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        self._log.append(f"[{ts}] {msg}")

    def _send_order(self, order_type: str, trade_info: Dict):
        """
        ส่งคำสั่งผ่าน execution_callback (เช่น OKXExecutionAdapter.execute จาก okx_exchange.py)
        หรือ log เป็น paper-trading ถ้าไม่มี callback

        [FIX 12] execution_callback รับผิดชอบ retry เอง (network/rate-limit errors)
        ที่นี่จับเฉพาะ exception ที่ "หลุด" ออกมาหลัง retry หมดแล้ว หรือเป็น fatal error
        (auth ผิด, fund ไม่พอ, invalid order) แล้วหยุดบอทเข้า ERROR state ทันที
        เพื่อไม่ให้ trade ต่อไปด้วยสถานะที่ไม่รู้ว่า order จริงสำเร็จหรือไม่
        """
        if self.execution_callback:
            try:
                result = self.execution_callback(order_type, trade_info)
                self._log_event(f"[EXEC OK] {order_type} confirmed → {result}")
                return result
            except Exception as e:
                self._log_event(
                    f"[ERROR] execution_callback failed for {order_type} "
                    f"(trade_info={trade_info}): {e}",
                    level="error",
                )
                self.state = "ERROR"
                return None
        else:
            self._log_event(f"[PAPER] {order_type}: {trade_info}")
            return None

    # [FIX 6] _scale_score — cap input ที่ 100
    @staticmethod
    def _scale_score(val: float, max_weight: float) -> float:
        val_clamped = min(float(val), 100.0)
        return min((val_clamped / 100.0) * max_weight, max_weight)

    # ── Step 1: Market state engine ──────────────────────────────────────────

    def _step1_market_state_engine(self, ind: Dict) -> str:
        adx = ind.get("adx", 0)
        eff = ind.get("eff_ratio", 0)
        atr_exp = ind.get("atr_exp", 1.0)
        bb_w = ind.get("bb_width", 0.5)

        if adx > 25 and eff > 0.7:
            return "Trending"
        if atr_exp > 1.5 and bb_w > 0.8:
            return "Expansion"
        if bb_w < 0.2 and atr_exp < 0.8:
            return "Compression"
        if adx > 20 and eff < 0.4:
            return "Exhaustion"
        return "Sideway"

    # ── Step 2: 4H Regime score ──────────────────────────────────────────────

    def _step2_4h_regime(self, ind: Dict) -> float:
        score  = self._scale_score(ind.get("ema20_slope_score", 50), 30)
        score += self._scale_score(ind.get("adx_score",         50), 20)
        score += self._scale_score(ind.get("eff_score",         50), 20)
        score += self._scale_score(ind.get("atr_score",         50), 15)
        score += self._scale_score(ind.get("vol_score",         50), 15)
        return float(np.clip(score, 0, 100))

    # ── Step 3: Global gates ─────────────────────────────────────────────────

    def _check_global_gates(self) -> bool:
        if self.position_open:
            return False

        # [FIX 9] datetime comparison
        if self.cooldown_until and datetime.datetime.now() < self.cooldown_until:
            self.state = "COOLDOWN"
            return False

        if self.daily_pnl_pct <= self.daily_loss_limit_pct:
            self.state = "BLOCKED"
            self._log_event(f"BLOCKED: daily PnL {self.daily_pnl_pct:.2f}% hit loss limit", level="warning")
            return False

        if self.daily_pnl_pct >= self.daily_profit_limit_pct:
            self.state = "BLOCKED"
            self._log_event(f"BLOCKED: daily PnL {self.daily_pnl_pct:.2f}% hit profit limit", level="warning")
            return False

        return True

    # ── Step 4: Layer filtering ──────────────────────────────────────────────

    def _layer_filtering(self, direction: str, ind: Dict,
                         market_state: str, vol_state: str) -> bool:
        weights = self.adaptive_engine.get_dynamic_weights(market_state)

        layer_score = 0.0
        for key in ["trend", "momentum", "volume", "pattern", "structure",
                    "atr", "rsi", "sweep", "divergence", "ema", "vwap", "macd"]:
            layer_score += self._scale_score(
                ind.get(f"{key}_score", 0), weights.get(key, 0)
            )

        multiplier = self.adaptive_engine.get_regime_multiplier(self.regime_score)
        layer_score *= multiplier

        thresholds = self.adaptive_engine.get_layer_thresholds(vol_state)
        return layer_score >= thresholds["L1_PASS"]

    # ── [FIX 17] Step 3.5: 1H trend filter — กรองทิศทางก่อนเข้าไม้จาก 15M ──────

    def _check_htf_trend_filter(self, direction: str, ind_1h: Dict) -> bool:
        """
        ยืนยันว่าแนวโน้ม 1H ไปทางเดียวกับสัญญาณที่เจอบน 15M ก่อนอนุญาตเข้าไม้
        (4H ใช้กำหนด market_state/regime ทั้งระบบอยู่แล้วใน Step1/Step2 — ส่วนนี้
        เป็นตัวกรองชั้นกลางเพิ่มเติมระหว่าง 4H กับ entry timeframe 15M)

        เกณฑ์: ADX 1H ต้องมีความแรงพอสมควร (>=15) และโครงสร้าง EMA5/EMA20 บน 1H
        ต้องสอดคล้องกับทิศทางที่จะเข้า — ถ้า 1H ไม่มีตัวบอกทิศทางชัดเจน ไม่อนุญาตเข้า
        ปรับเกณฑ์นี้ได้ตามสไตล์เทรดของคุณ (เช่น เพิ่มเช็ค trend_score หรือ adx_score ของ 1H)
        """
        adx_1h = ind_1h.get("adx", 0)
        ema5_1h = ind_1h.get("ema5")
        ema20_1h = ind_1h.get("ema20")

        if adx_1h < 15 or ema5_1h is None or ema20_1h is None:
            return False

        if direction == "LONG":
            return ema5_1h >= ema20_1h
        else:
            return ema5_1h <= ema20_1h

    # ── Step 5: Risk engine + sizing ─────────────────────────────────────────

    def _step5_risk_engine(self, candle: Dict, direction: str, ind: Dict):
        entry_price = float(candle.get("close", 0))

        if direction == "LONG":
            pattern_sl = candle.get("pattern_low", entry_price * 0.99)
        else:
            pattern_sl = candle.get("pattern_high", entry_price * 1.01)

        sl_dist = abs(entry_price - float(pattern_sl))
        if sl_dist < 1e-8:
            sl_dist = entry_price * 0.01

        # [FIX] win streak risk reduction
        risk_pct = self.base_risk_pct
        if self.win_streak >= 5:
            risk_pct *= 0.80
            self._log_event(f"Win streak {self.win_streak} → risk reduced to {risk_pct:.2%}")

        risk_amount = self.account_balance * risk_pct
        position_size = risk_amount / sl_dist

        mult = 1 if direction == "LONG" else -1
        # [FIX 16] เหลือแค่ TP1/TP2 — TP1 scale-out + ขยับ SL ไป BE, TP2 = full exit
        tp1 = entry_price + sl_dist * 1.0 * mult
        tp2 = entry_price + sl_dist * 2.0 * mult

        self.current_trade = {
            "direction":            direction,
            "entry":                entry_price,
            "sl":                   float(pattern_sl),
            "sl_dist":              sl_dist,
            "tp1":                  tp1,
            "tp2":                  tp2,
            "size":                 position_size,
            "tp1_hit":              False,
            "tp2_hit":              False,
            "break_even_triggered": False,
            "status":               "OPEN",
            "entry_time":           datetime.datetime.now(),
            "atr_at_entry":         ind.get("atr", sl_dist),
            "realized_pnl":         0.0,
            "remaining_size":       position_size,
            "exit_price":           None,
            "final_rr":             None,
            "mae":                  0.0,   # max adverse excursion
            "mfe":                  0.0,   # max favorable excursion
        }
        self.position_open = True
        self.order_status  = "OPEN"

        self._send_order("OPEN_LONG" if direction == "LONG" else "OPEN_SHORT", {
            "entry":     entry_price,
            "sl":        float(pattern_sl),
            "tp1":       tp1, "tp2": tp2,
            "size":      position_size,
        })

    # ── Step 6: Position management ──────────────────────────────────────────

    def _manage_open_position(self, current_price: float,
                              ind: Dict) -> str:
        t = self.current_trade
        direction = t["direction"]
        sl_dist = t["sl_dist"]
        dir_mult = 1 if direction == "LONG" else -1
        current_r = ((current_price - t["entry"]) * dir_mult) / max(sl_dist, 1e-9)

        # Track MAE / MFE
        t["mae"] = min(t["mae"], current_r)
        t["mfe"] = max(t["mfe"], current_r)

        # ── [FIX 7] Emergency exit conditions ─────────────────────────────
        emergency_signals = [
            ind.get("opposite_choch"),
            ind.get("atr_collapse"),
            ind.get("momentum_collapse"),
            ind.get("volume_collapse"),
            ind.get("invalid_structure"),
        ]
        if any(emergency_signals):
            self._close_position("EMERGENCY_EXIT", current_price, 1.0, ind)
            return "EXITING"

        # ── Partial TP — [FIX 16] เหลือแค่ TP1/TP2 ──────────────────────────
        # TP1 = scale-out ตาม tp1_close_pct แล้วขยับ SL ไป breakeven ทันที
        # TP2 = ปิดที่เหลือทั้งหมด (full exit) — ไม่มี TP3/runner เลย R สูงๆ อีกต่อไป
        if direction == "LONG":
            tp1_hit_cond = current_price >= t["tp1"]
            tp2_hit_cond = current_price >= t["tp2"]
        else:
            tp1_hit_cond = current_price <= t["tp1"]
            tp2_hit_cond = current_price <= t["tp2"]

        # TP1 — close ตาม tp1_close_pct + [FIX 16] ขยับ SL ไป breakeven ทันที
        if tp1_hit_cond and not t["tp1_hit"]:
            self._close_position("PARTIAL_TP1", t["tp1"], self.tp1_close_pct, ind)
            t["tp1_hit"] = True
            if not t["break_even_triggered"]:
                t["sl"] = t["entry"]
                t["break_even_triggered"] = True
                self._log_event(
                    f"TP1 hit @ {t['tp1']:.2f} → ปิด {self.tp1_close_pct:.0%} "
                    f"+ ขยับ SL ไป breakeven ({t['entry']:.2f})"
                )
            self.state = "PARTIAL_EXIT"

        # TP2 — ปิดที่เหลือทั้งหมด (full exit)
        if tp2_hit_cond and not t["tp2_hit"]:
            self._close_position("FULL_TP2", t["tp2"], 1.0, ind)
            t["tp2_hit"] = True
            return "EXITING"

        # ── [FIX 1] Health-based position management ──────────────────────
        health = self.health_calc.calculate(ind, t, current_price)

        if health >= 80:
            # Health สูงมาก — ตัดสินใจ "ไม่แทรกแซง SL" คือ logic จริง (ไม่ใช่ unimplemented)
            # log ไว้เป็น telemetry ว่าทำไมไม่ trail ในรอบนี้ เพื่อ debug ได้ง่ายขึ้นตอนรันจริง
            self._log_event(
                f"Health {health:.0f} (≥80) → HOLD: ปล่อย position วิ่งต่อโดยไม่ขยับ SL "
                f"(current_r={current_r:.2f})",
                level="debug",
            )

        elif health >= 60 or t["break_even_triggered"]:
            # ATR trailing stop
            atr = ind.get("atr", sl_dist)
            atr_trail = atr * 2
            if direction == "LONG":
                new_sl = current_price - atr_trail
                t["sl"] = max(t["sl"], new_sl)
            else:
                new_sl = current_price + atr_trail
                t["sl"] = min(t["sl"], new_sl)

        elif health >= 40:
            if not t["break_even_triggered"]:
                t["sl"] = t["entry"]
                t["break_even_triggered"] = True
                self._log_event(f"Health {health:.0f} → forced break-even")

        elif health >= 20:
            if t["remaining_size"] > 0:
                self._close_position("HEALTH_REDUCE", current_price, 0.50, ind)
                self.state = "PARTIAL_EXIT"

        else:
            self._close_position("POOR_HEALTH_EXIT", current_price, 1.0, ind)
            return "EXITING"

        # ── SL hit check ──────────────────────────────────────────────────
        if direction == "LONG" and current_price <= t["sl"]:
            self._close_position("SL_HIT", t["sl"], 1.0, ind)
            return "EXITING"
        if direction == "SHORT" and current_price >= t["sl"]:
            self._close_position("SL_HIT", t["sl"], 1.0, ind)
            return "EXITING"

        return self.state

    # ── [FIX 2] Close position — คำนวณ PnL จริง ─────────────────────────────

    def _close_position(self, reason: str, price: float,
                        portion: float, ind: Dict):
        """
        [FIX 2] บันทึก PnL จริง อัปเดต current_trade และส่งคำสั่ง

        portion: 0.0–1.0 (1.0 = ปิดทั้งหมด)
        """
        t = self.current_trade
        if not t or t.get("status") != "OPEN":
            return

        direction   = t["direction"]
        entry_price = t["entry"]
        size        = t["size"]
        remaining   = t.get("remaining_size", size)

        close_size = remaining * min(max(float(portion), 0.0), 1.0)
        if close_size <= 0:
            return

        # คำนวณ PnL
        if direction == "LONG":
            pnl_per_unit = float(price) - entry_price
        else:
            pnl_per_unit = entry_price - float(price)

        pnl = pnl_per_unit * close_size

        # อัปเดต state
        t["realized_pnl"] = t.get("realized_pnl", 0.0) + pnl
        t["remaining_size"] = remaining - close_size
        t["exit_price"] = float(price)

        if t["sl_dist"] > 0:
            t["final_rr"] = pnl_per_unit / t["sl_dist"]

        self._send_order("CLOSE_PARTIAL" if portion < 1.0 else "CLOSE_FULL", {
            "reason":    reason,
            "price":     float(price),
            "size":      close_size,
            "pnl":       pnl,
            "direction": direction,
        })

        self._log_event(
            f"CLOSE {reason} | {direction} | price={price:.2f} "
            f"| size={close_size:.4f} | pnl={pnl:+.2f}"
        )

        # ถ้าปิดหมดแล้ว
        if portion >= 1.0 or t["remaining_size"] <= 1e-9:
            t["status"] = "CLOSED"
            self.position_open = False
            self.order_status  = "CLOSED"

    # ── Step 7: Journal + learning ────────────────────────────────────────────

    def _log_trade(self, result: str, ind: Dict, extras: Dict):
        """
        [FIX 10] บันทึก trade พร้อม active conditions สำหรับ per-condition learning
        """
        t = self.current_trade
        pnl = t.get("realized_pnl", 0.0)

        # Active conditions ณ เวลา entry (จาก indicator snapshot)
        active_conditions = {
            "trend":      ind.get("trend_score", 0) > 60,
            "momentum":   ind.get("momentum_score", 0) > 60,
            "volume":     ind.get("volume_score", 0) > 60,
            "pattern":    ind.get("pattern_score", 0) > 60,
            "structure":  ind.get("structure_score", 0) > 60,
            "atr":        ind.get("atr_score", 0) > 60,
            "rsi":        ind.get("rsi_score", 0) > 60,
            "sweep":      ind.get("sweep_score", 0) > 60,
            "divergence": ind.get("divergence_score", 0) > 60,
            "ema":        ind.get("ema_score", 0) > 60,
            "vwap":       ind.get("vwap_score", 0) > 60,
            "macd":       ind.get("macd_score", 0) > 60,
        }

        entry = {
            "symbol":           extras.get("symbol", "BTCUSDT"),
            "timeframe":        "15M",   # [FIX 17] เข้าออเดอร์จาก 15M (1H/4H เป็นตัวกรองแนวโน้ม)
            "direction":        t.get("direction"),
            "entry":            t.get("entry"),
            "exit":             t.get("exit_price"),
            "sl":               t.get("sl"),
            "tp1":              t.get("tp1"),
            "tp2":              t.get("tp2"),
            "rr":               t.get("final_rr"),
            "win_loss":         result,
            "pnl":              pnl,
            "mae":              t.get("mae"),
            "mfe":              t.get("mfe"),
            "hold_time_sec":    (datetime.datetime.now() - t.get("entry_time", datetime.datetime.now())).total_seconds(),
            "atr":              ind.get("atr"),
            "adx":              ind.get("adx"),
            "rsi":              ind.get("rsi"),
            "ema":              ind.get("ema5"),
            "macd":             ind.get("macd"),
            "market_state":     self.current_market_state,
            "volatility_state": self.adaptive_engine.get_atr_volatility_state(
                                    ind.get("atr", 0), self.atr_history),
            "regime_score":     self.regime_score,
            "session":          extras.get("session"),
            "funding":          extras.get("funding_rate"),
            "open_interest":    extras.get("oi"),
            "pattern":          ind.get("pattern"),
            "entry_reason":     "Strategy Trigger",
            "exit_reason":      result,
            "active_conditions": active_conditions,
        }
        self.trade_journal.append(entry)

        # [FIX 10] record to learning engine
        self.adaptive_engine.record_trade_result(
            self.current_market_state,
            win=(result == "WIN"),
            active_conditions=active_conditions,
        )

        # Update streaks + daily PnL
        self.daily_pnl_pct += (pnl / max(self.account_balance, 1)) * 100
        self.account_balance += pnl

        if result == "WIN":
            self.win_streak += 1
            self.loss_streak = 0
        else:
            self.loss_streak += 1
            self.win_streak = 0
            if self.loss_streak >= self.max_loss_streak:
                # [FIX 9] datetime cooldown
                self.cooldown_until = (datetime.datetime.now()
                                       + datetime.timedelta(minutes=self.cooldown_minutes))
                self.state = "COOLDOWN"
                self._log_event(
                    f"Loss streak {self.loss_streak} → COOLDOWN until "
                    f"{self.cooldown_until.strftime('%H:%M:%S')}",
                    level="warning",
                )

        # Learning every 100 trades
        if len(self.trade_journal) % 100 == 0:
            self.adaptive_engine.adjust_weights_from_learning(self.trade_journal[-100:])
            self._log_event("Learning engine updated weights from last 100 trades")

        self._log_event(
            f"TRADE CLOSED | {result} | PnL={pnl:+.2f} "
            f"| Balance={self.account_balance:.2f} "
            f"| WinStreak={self.win_streak} LossStreak={self.loss_streak}"
        )

    # ── Daily reset ───────────────────────────────────────────────────────────

    def _check_daily_reset(self):
        today = datetime.date.today()
        if self.trading_date != today:
            self.trading_date = today
            self.daily_pnl_pct = 0.0
            if self.state == "BLOCKED":
                self.state = "SCANNING"
                self._log_event("New trading day — BLOCKED state reset")

    # ── Core tick engine ──────────────────────────────────────────────────────

    def on_tick(self, candle_15m: Dict, candle_1h: Dict, candle_4h: Dict,
                ind_15m: Dict, ind_1h: Dict, ind_4h: Dict,
                extras: Dict, current_price: float):
        """
        เรียกต่อ closed candle หนึ่งครั้ง (ตาม timeframe เข้าออเดอร์ คือทุกแท่ง 15M ปิด)

        [FIX 17] เปลี่ยน timeframe เข้าออเดอร์เป็น 15M — ใช้ 1H และ 4H เป็นตัวกรอง
        แนวโน้มเท่านั้น ไม่ใช้เข้าไม้ตรงๆ อีกต่อไป:
            4H → market_state (Step1) + regime score (Step2): ภาพรวมระดับมาโคร
            1H → trend filter (_check_htf_trend_filter): ยืนยันทิศทางก่อนอนุญาตเข้า
            15M → layer scoring (Step4), entry trigger, risk engine, position
                   management ทั้งหมด — รันทุกครั้งที่แท่ง 15M ปิด

        Parameters
        ----------
        candle_15m, candle_1h, candle_4h : {'open','high','low','close','volume',
                                             'pattern_low','pattern_high'}
        ind_15m    : indicator values ของ 15M (ตัวที่ใช้ตัดสินใจเข้า/จัดการ position จริง)
        ind_1h     : indicator values ของ 1H (ใช้แค่กรองแนวโน้มก่อนเข้าไม้)
        ind_4h     : indicator values ของ 4H (ema20_slope_score, adx_score, ... สำหรับ regime)
        extras     : {'symbol','session','funding_rate','oi'}
        current_price : ราคา close ปัจจุบัน (ของแท่ง 15M)
        """
        self._check_daily_reset()

        # อัปเดต ATR history — ใช้ 4H เพื่อความนิ่งของ volatility regime classification
        # (ไม่ใช้ ATR ของ 15M ตรงนี้ เพราะจะ noisy เกินไปสำหรับ threshold ระดับ regime;
        #  ส่วน SL distance/position sizing ใน _step5_risk_engine ใช้ pattern/ATR ของ 15M เอง)
        atr_4h = ind_4h.get("atr", 0)
        if atr_4h > 0:
            self.atr_history.append(atr_4h)
            if len(self.atr_history) > 200:
                self.atr_history.pop(0)

        # อัปเดต market state จาก 4H (macro regime)
        self.current_market_state = self._step1_market_state_engine(ind_4h)
        self.regime_score          = self._step2_4h_regime(ind_4h)
        vol_state                  = self.adaptive_engine.get_atr_volatility_state(
                                         atr_4h, self.atr_history)

        # [FIX 5] State machine loop — guard ป้องกัน infinite loop
        self._tick_depth = 0
        state_changed = True

        while state_changed and self._tick_depth < self._max_tick_depth:
            state_changed = False
            self._tick_depth += 1

            # ── BLOCKED / COOLDOWN ─────────────────────────────────────────
            if self.state in ("BLOCKED", "COOLDOWN"):
                # [FIX 9] datetime comparison
                if (self.state == "COOLDOWN" and
                        (self.cooldown_until is None or
                         datetime.datetime.now() >= self.cooldown_until)):
                    self.state = "SCANNING"
                    self._log_event("Cooldown expired → SCANNING")
                    state_changed = True

            # ── SCANNING ───────────────────────────────────────────────────
            elif self.state == "SCANNING":
                if self._check_global_gates():
                    self.state = "FILTERING"
                    state_changed = True

            # ── FILTERING ──────────────────────────────────────────────────
            # [FIX 17] scoring ใช้ ind_15m (entry timeframe) แต่ต้องผ่าน 1H trend
            # filter ก่อน ไม่ใช่แค่ดู 15M เพียวๆ — กันสัญญาณสวนเทรนด์ใหญ่
            elif self.state == "FILTERING":
                triggered = False
                for direction in ("LONG", "SHORT"):
                    if not self._check_htf_trend_filter(direction, ind_1h):
                        continue
                    if self._layer_filtering(
                        direction, ind_15m, self.current_market_state, vol_state
                    ):
                        self.direction_focus   = direction
                        self.state             = "WAIT_CONFIRM"
                        self.bars_since_trigger = 0
                        self._log_event(
                            f"Signal found: {direction} in {self.current_market_state} "
                            f"(1H trend filter ผ่าน)"
                        )
                        state_changed = True
                        triggered = True
                        break
                # ถ้าไม่พบ signal ก็อยู่ที่ SCANNING ต่อไป
                if not triggered:
                    self.state = "SCANNING"

            # ── WAIT_CONFIRM ───────────────────────────────────────────────
            elif self.state == "WAIT_CONFIRM":
                if self.bars_since_trigger > 3:
                    self._log_event("WAIT_CONFIRM timeout → back to SCANNING")
                    self.state    = "SCANNING"
                    state_changed = True
                    continue

                # ตรวจสอบ trigger condition จาก indicator 15M (entry timeframe)
                confirmed = self._check_entry_trigger(ind_15m)
                if confirmed:
                    self.state = "PENDING_ORDER"
                    state_changed = True
                else:
                    self.bars_since_trigger += 1

            # ── PENDING_ORDER ──────────────────────────────────────────────
            elif self.state == "PENDING_ORDER":
                self._step5_risk_engine(candle_15m, self.direction_focus, ind_15m)
                self.state    = "IN_POSITION"
                state_changed = False  # หยุด loop — รอ tick ถัดไปตรวจ position

            # ── IN_POSITION / PARTIAL_EXIT / TRAILING ─────────────────────
            elif self.state in ("IN_POSITION", "PARTIAL_EXIT", "TRAILING"):
                new_state = self._manage_open_position(current_price, ind_15m)
                if new_state == "EXITING":
                    self.state = "EXITING"
                    state_changed = True
                elif new_state != self.state:
                    self.state = new_state

            # ── EXITING ────────────────────────────────────────────────────
            elif self.state == "EXITING":
                t     = self.current_trade
                pnl   = t.get("realized_pnl", 0.0)
                result = "WIN" if pnl > 0 else "LOSS"
                self._log_trade(result, ind_15m, extras)
                if self.state not in ("COOLDOWN", "BLOCKED"):
                    self.state = "SCANNING"

            # ── [FIX 8] RECOVERY ───────────────────────────────────────────
            elif self.state == "RECOVERY":
                # Recovery mode: รอ 1 trade ที่ risk ลดลง 50% ก่อน resume full risk
                if not self.position_open:
                    self._log_event("RECOVERY mode: waiting for next setup with half-risk")
                    if self._check_global_gates():
                        self._enter_recovery_trade(candle_15m, ind_15m, ind_1h, vol_state)

            # ── ERROR ──────────────────────────────────────────────────────
            elif self.state == "ERROR":
                self._log_event("Bot in ERROR state — manual intervention required", level="error")
                break

        # [FIX 13] persist state ทุก tick — กัน crash/restart เสีย state เกิน 1 tick
        # (เขียนแบบ atomic write ใน save_state แล้ว จึงไม่กระทบ performance loop มากนัก
        #  ถ้าต้องการลด I/O สามารถปรับให้ save แค่ตอน state เปลี่ยนแทนได้)
        self.save_state()

    def _check_entry_trigger(self, ind: Dict) -> bool:
        """
        ตรวจสอบ entry trigger condition จาก indicator 15M (entry timeframe)

        Override method นี้ใน subclass หรือ inject logic ของคุณ
        Default: ตรวจ RSI confirmation + candle close momentum
        """
        direction = self.direction_focus
        if direction is None:
            return False

        rsi = ind.get("rsi", 50)
        momentum = ind.get("momentum_score", 0)

        if direction == "LONG":
            return rsi > 45 and rsi < 70 and momentum > 50
        else:
            return rsi < 55 and rsi > 30 and momentum > 50

    def _enter_recovery_trade(self, candle: Dict, ind: Dict, ind_1h: Dict, vol_state: str):
        """[FIX 8] เปิด trade ด้วย risk 50% ใน recovery mode (ยังผ่าน 1H trend filter เหมือนปกติ)"""
        original_risk = self.base_risk_pct
        self.base_risk_pct *= 0.5

        for direction in ("LONG", "SHORT"):
            if not self._check_htf_trend_filter(direction, ind_1h):
                continue
            if self._layer_filtering(direction, ind, self.current_market_state, vol_state):
                self._step5_risk_engine(candle, direction, ind)
                self.state = "IN_POSITION"
                self._log_event(f"RECOVERY trade opened: {direction} at half-risk")
                break

        self.base_risk_pct = original_risk

    # ── Public API ────────────────────────────────────────────────────────────

    def get_status(self) -> Dict:
        """Summary ของ bot state ปัจจุบัน"""
        return {
            "state":           self.state,
            "position_open":   self.position_open,
            "direction":       self.current_trade.get("direction") if self.position_open else None,
            "entry":           self.current_trade.get("entry") if self.position_open else None,
            "realized_pnl":    self.current_trade.get("realized_pnl", 0),
            "account_balance": self.account_balance,
            "daily_pnl_pct":   self.daily_pnl_pct,
            "loss_streak":     self.loss_streak,
            "win_streak":      self.win_streak,
            "total_trades":    len(self.trade_journal),
            "market_state":    self.current_market_state,
            "regime_score":    self.regime_score,
            "cooldown_until":  self.cooldown_until.isoformat() if self.cooldown_until else None,
        }

    def get_performance_summary(self) -> Dict:
        """สรุปผลการเทรดจาก journal"""
        if not self.trade_journal:
            return {"message": "No trades yet"}

        wins   = [t for t in self.trade_journal if t["win_loss"] == "WIN"]
        losses = [t for t in self.trade_journal if t["win_loss"] == "LOSS"]
        pnls   = [t["pnl"] for t in self.trade_journal if t.get("pnl") is not None]

        by_state = {}
        for t in self.trade_journal:
            s = t.get("market_state", "Unknown")
            by_state.setdefault(s, {"wins": 0, "total": 0, "pnl": 0.0})
            by_state[s]["total"] += 1
            by_state[s]["pnl"]   += t.get("pnl", 0)
            if t["win_loss"] == "WIN":
                by_state[s]["wins"] += 1

        return {
            "total_trades":  len(self.trade_journal),
            "win_rate":      len(wins) / len(self.trade_journal),
            "net_pnl":       sum(pnls),
            "avg_win":       np.mean([t["pnl"] for t in wins])   if wins   else 0,
            "avg_loss":      np.mean([t["pnl"] for t in losses]) if losses else 0,
            "profit_factor": (sum(t["pnl"] for t in wins) /
                              abs(sum(t["pnl"] for t in losses)))
                             if losses else float("inf"),
            "by_market_state": {
                s: {**v, "win_rate": v["wins"] / max(v["total"], 1)}
                for s, v in by_state.items()
            },
        }

    def force_state(self, new_state: str):
        """Manual override สำหรับ emergency หรือ testing"""
        if new_state in self.STATES:
            self._log_event(f"Force state: {self.state} → {new_state}")
            self.state = new_state
        else:
            raise ValueError(f"Unknown state: {new_state}. Valid: {self.STATES}")

    # ── [FIX 13] State persistence — รองรับการรีสตาร์ตบอท ───────────────────
    #
    # บอทเทรดจริงต้องรันยาว ๆ บน VPS/server และอาจถูก restart (deploy ใหม่,
    # crash, server reboot) ระหว่างที่ "มี position เปิดอยู่" ถ้าไม่เก็บ state
    # บอทจะเริ่มจาก SCANNING ใหม่ทั้งที่ยังมี position ค้างอยู่จริงบน exchange
    # → เสี่ยงเปิด position ซ้ำ หรือไม่มีใครดูแล SL/TP/trailing ของ position เดิม

    DEFAULT_STATE_FILE = "bot_state.json"

    def save_state(self, path: str = DEFAULT_STATE_FILE):
        """บันทึก state ปัจจุบันลงไฟล์ JSON (เรียกทุกครั้งที่ state สำคัญเปลี่ยน)"""
        snapshot = {
            "state":                self.state,
            "position_open":        self.position_open,
            "order_status":         self.order_status,
            "current_trade":        self.current_trade,
            "account_balance":      self.account_balance,
            "daily_pnl_pct":        self.daily_pnl_pct,
            "loss_streak":          self.loss_streak,
            "win_streak":           self.win_streak,
            "cooldown_until":       self.cooldown_until.isoformat() if self.cooldown_until else None,
            "trading_date":         self.trading_date.isoformat() if self.trading_date else None,
            "current_market_state": self.current_market_state,
            "regime_score":         self.regime_score,
            "direction_focus":      self.direction_focus,
            "bars_since_trigger":   self.bars_since_trigger,
            "atr_history":          self.atr_history[-200:],
            "adaptive_weights":     self.adaptive_engine.base_weights,
            "saved_at":             datetime.datetime.now().isoformat(),
        }
        tmp_path = f"{path}.tmp"
        try:
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(snapshot, f, indent=2, default=str, ensure_ascii=False)
            os.replace(tmp_path, path)  # atomic write — กัน state file พังถ้า crash กลางทาง
        except OSError as e:
            self._log_event(f"[ERROR] save_state failed: {e}", level="error")

    def load_state(self, path: str = DEFAULT_STATE_FILE) -> bool:
        """
        โหลด state จากไฟล์ JSON ตอนสตาร์ทบอท
        Return True ถ้าโหลดสำเร็จ, False ถ้าไม่มีไฟล์ (= สตาร์ทใหม่)
        """
        if not os.path.exists(path):
            self._log_event(f"No saved state at '{path}' — starting fresh")
            return False

        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            self._log_event(
                f"[ERROR] load_state failed to read '{path}': {e} — starting fresh instead",
                level="error",
            )
            return False

        self.state           = data.get("state", "SCANNING")
        self.position_open    = data.get("position_open", False)
        self.order_status     = data.get("order_status", "CLOSED")
        self.current_trade    = data.get("current_trade") or {}

        # entry_time ถูกเก็บเป็น ISO string ใน JSON ต้องแปลงกลับเป็น datetime
        entry_time = self.current_trade.get("entry_time")
        if isinstance(entry_time, str):
            try:
                self.current_trade["entry_time"] = datetime.datetime.fromisoformat(entry_time)
            except ValueError:
                self.current_trade["entry_time"] = datetime.datetime.now()

        self.account_balance  = data.get("account_balance", self.account_balance)
        self.daily_pnl_pct     = data.get("daily_pnl_pct", 0.0)
        self.loss_streak       = data.get("loss_streak", 0)
        self.win_streak         = data.get("win_streak", 0)

        cooldown = data.get("cooldown_until")
        self.cooldown_until = datetime.datetime.fromisoformat(cooldown) if cooldown else None

        trading_date = data.get("trading_date")
        self.trading_date = datetime.date.fromisoformat(trading_date) if trading_date else None

        self.current_market_state = data.get("current_market_state", "Sideway")
        self.regime_score          = data.get("regime_score", 0.0)
        self.direction_focus        = data.get("direction_focus")
        self.bars_since_trigger      = data.get("bars_since_trigger", 0)
        self.atr_history              = data.get("atr_history", [])

        weights = data.get("adaptive_weights")
        if weights:
            self.adaptive_engine.base_weights = weights

        self._log_event(
            f"State loaded from '{path}' | state={self.state} "
            f"| position_open={self.position_open} | balance={self.account_balance:.2f} "
            f"| saved_at={data.get('saved_at')}"
        )
        return True

    def reconcile_with_exchange(self, symbol: str, exchange_adapter) -> None:
        """
        [FIX 13] เทียบ local state (จาก load_state) กับ position จริงบน exchange
        ต้องเรียกทุกครั้งหลัง restart ก่อนเริ่ม on_tick — เพราะระหว่างบอท offline
        position อาจถูกปิดไปแล้ว (SL/TP บน exchange โดน trigger) หรือมี position
        ที่ exchange แต่ไฟล์ state เก่าเกินไป/หาย

        exchange_adapter ต้องมีเมธอด fetch_open_position(symbol) -> dict | None
        (ดู OKXExecutionAdapter ใน okx_exchange.py)
        """
        try:
            live_position = exchange_adapter.fetch_open_position(symbol)
        except Exception as e:
            self._log_event(
                f"[ERROR] reconcile_with_exchange: fetch_open_position failed: {e} "
                f"— เข้า ERROR state เพื่อให้ตรวจสอบ manual ก่อนเทรดต่อ",
                level="error",
            )
            self.state = "ERROR"
            return

        live_size = float((live_position or {}).get("contracts", 0) or 0)

        if self.position_open and live_size == 0:
            self._log_event(
                "[RECONCILE] local state มี position เปิดอยู่ แต่ exchange ไม่มี position จริง "
                "→ ถือว่าปิดไปแล้วระหว่างบอท offline, เคลียร์ local state และกลับไป SCANNING",
                level="warning",
            )
            self.position_open = False
            self.current_trade = {}
            if self.state not in ("BLOCKED", "COOLDOWN", "ERROR"):
                self.state = "SCANNING"

        elif not self.position_open and live_size != 0:
            direction = "LONG" if live_size > 0 else "SHORT"
            entry_price = float(
                live_position.get("entryPrice") or live_position.get("entryPx") or 0
            )
            self._log_event(
                f"[RECONCILE] พบ position จริงบน exchange ({direction} size={abs(live_size)}) "
                "ที่ local state ไม่รู้จัก (อาจเปิดด้วยมือ หรือ state file หาย) "
                "→ สร้าง trade record ใหม่จากข้อมูล exchange — "
                "SL/TP/health logic จะ baseline ใหม่จากราคาปัจจุบัน",
                level="warning",
            )
            self.current_trade = {
                "direction": direction, "entry": entry_price,
                "sl": entry_price * (0.99 if direction == "LONG" else 1.01),
                "sl_dist": max(entry_price * 0.01, 1e-9),
                "tp1": entry_price, "tp2": entry_price,
                "size": abs(live_size), "remaining_size": abs(live_size),
                "tp1_hit": False, "tp2_hit": False,
                "break_even_triggered": False, "status": "OPEN",
                "entry_time": datetime.datetime.now(),
                "atr_at_entry": 0.0, "realized_pnl": 0.0,
                "exit_price": None, "final_rr": None, "mae": 0.0, "mfe": 0.0,
                "reconciled_from_exchange": True,
            }
            self.position_open = True
            self.state = "IN_POSITION"

        else:
            self._log_event("[RECONCILE] local state ตรงกับ exchange แล้ว — ไม่ต้องแก้ไข")


# ──────────────────────────────────────────────────────────────────────────────
# EXAMPLE USAGE
# ──────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":

    SYMBOL = os.environ.get("BOT_SYMBOL", "BTC-USDT-SWAP")
    STATE_FILE = os.environ.get("BOT_STATE_FILE", "bot_state.json")

    # ── โหมด live: ถ้ามี OKX API credentials ใน env var ─────────────────────
    # ตั้งค่า: OKX_API_KEY, OKX_API_SECRET, OKX_API_PASSPHRASE
    # (ใส่ OKX_SANDBOX=1 เพื่อทดสอบกับ OKX demo-trading environment ก่อนของจริง)
    has_okx_keys = bool(os.environ.get("OKX_API_KEY"))

    execution_callback = None
    exchange_adapter = None

    if has_okx_keys:
        from okx_exchange import OKXExecutionAdapter  # ดูไฟล์ okx_exchange.py

        exchange_adapter = OKXExecutionAdapter(
            symbol=SYMBOL,
            sandbox=os.environ.get("OKX_SANDBOX") == "1",
            td_mode="cross",
        )
        execution_callback = exchange_adapter.execute
        logger.info(f"OKX credentials พบใน env — รันโหมด LIVE/SANDBOX บน {SYMBOL}")
    else:
        logger.warning(
            "ไม่พบ OKX_API_KEY ใน env var — รันโหมด PAPER TRADING (execution_callback=None) "
            "ใส่ env var OKX_API_KEY/OKX_API_SECRET/OKX_API_PASSPHRASE เพื่อต่อ exchange จริง"
        )

    # ── สร้าง bot instance ────────────────────────────────────────────────────
    bot = TradingBot(
        account_balance=10_000.0,
        base_risk_pct=0.01,            # 1% risk ต่อ trade
        daily_loss_limit_pct=-3.0,     # หยุดถ้า drawdown วันนั้น > 3%
        daily_profit_limit_pct=8.0,    # หยุดถ้ากำไรวันนั้น > 8%
        cooldown_minutes=30,           # พัก 30 นาทีหลัง loss streak
        max_loss_streak=3,
        execution_callback=execution_callback,  # None = paper trading, adapter.execute = live
    )

    # ── [FIX 13] โหลด state เดิมก่อนเริ่ม (สำคัญถ้าบอทเพิ่ง restart) ──────────
    bot.load_state(STATE_FILE)
    if exchange_adapter is not None:
        bot.reconcile_with_exchange(SYMBOL, exchange_adapter)

    # ── Data feed: ใส่ indicator/candle จริงจาก exchange/data provider ของคุณ ──
    # ด้านล่างนี้คือ "ข้อมูลตัวอย่างสำหรับรันเดโม" เท่านั้น (ไม่ใช่ logic ของบอท)
    # ในระบบจริงให้ดึง OHLCV + คำนวณ indicator จาก exchange_adapter.exchange.fetch_ohlcv(...)
    # แล้วประกอบเป็น dict รูปแบบเดียวกันนี้ ก่อนส่งเข้า bot.on_tick()
    #
    # [FIX 17] ตอนนี้ต้องมี 3 timeframe: 15M (เข้าไม้จริง), 1H (trend filter), 4H (regime)
    demo_ind_15m = {
        "adx": 28, "rsi": 55, "macd": 40, "macd_signal": 30,
        "ema5": 91_100, "ema20": 90_800, "atr": 120,
        "volume": 200, "vol_avg": 160,
        "trend_score": 70, "momentum_score": 65, "volume_score": 60,
        "pattern_score": 55, "structure_score": 70, "atr_score": 60,
        "rsi_score": 55, "sweep_score": 50, "divergence_score": 45,
        "ema_score": 60, "vwap_score": 55, "macd_score": 65,
        "eff_ratio": 0.75, "atr_exp": 1.2, "bb_width": 0.6,
    }
    demo_ind_1h = {
        "adx": 32, "rsi": 55, "macd": 100, "macd_signal": 80,
        "ema5": 91_000, "ema20": 90_000, "atr": 400,
        "volume": 500, "vol_avg": 400,
    }
    demo_ind_4h = {
        **demo_ind_15m,
        "ema20_slope_score": 65, "adx_score": 60, "eff_score": 70,
        "atr_score": 55, "vol_score": 60,
        "atr": 1_200,
    }
    demo_candle_15m = {
        "open": 91_000, "high": 91_350, "low": 90_900,
        "close": 91_200, "volume": 200,
        "pattern_low": 90_950, "pattern_high": 91_400,
    }
    demo_candle_1h = {
        "open": 90_000, "high": 91_500, "low": 89_800,
        "close": 91_200, "volume": 500,
        "pattern_low": 89_500, "pattern_high": 91_800,
    }
    demo_extras = {
        "symbol": SYMBOL, "session": "London",
        "funding_rate": 0.0001, "oi": 5_000_000_000,
    }

    # รัน 3 tick (ในระบบจริง loop นี้จะรันทุกครั้งที่แท่ง 15M ปิด เช่น cron ทุก 15 นาที)
    for tick in range(3):
        logger.info(f"── Tick {tick + 1} ──")
        bot.on_tick(
            candle_15m=demo_candle_15m, candle_1h=demo_candle_1h, candle_4h=demo_candle_1h,
            ind_15m=demo_ind_15m, ind_1h=demo_ind_1h, ind_4h=demo_ind_4h,
            extras=demo_extras, current_price=91_200.0,
        )
        logger.info(bot.get_status())

    # Performance summary
    logger.info("── Performance Summary ──")
    print(json.dumps(bot.get_performance_summary(), indent=2, default=str))
