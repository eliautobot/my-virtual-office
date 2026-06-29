"""
Trading bot entry point. Load config from env vars and start the bot.

Usage:
    python run_bot.py

Config via environment variables or a .env file in the same directory.
"""
import asyncio
import logging
import os
import signal
import sys


# ---------------------------------------------------------------------------
# Load .env if present
# ---------------------------------------------------------------------------

def _load_dotenv():
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if not os.path.exists(env_path):
        return
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


_load_dotenv()

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

log_level = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, log_level, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("run_bot")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _env_list(key: str, default: str) -> list:
    val = os.environ.get(key, default)
    return [s.strip() for s in val.split(",") if s.strip()]


def _env_bool(key: str, default: bool) -> bool:
    val = os.environ.get(key, "")
    if not val:
        return default
    return val.lower() in ("1", "true", "yes")


def _env_float(key: str, default: float) -> float:
    try:
        return float(os.environ.get(key, str(default)))
    except ValueError:
        return default


def _env_int(key: str, default: int) -> int:
    try:
        return int(os.environ.get(key, str(default)))
    except ValueError:
        return default


# ---------------------------------------------------------------------------
# Build config
# ---------------------------------------------------------------------------

def build_config() -> dict:
    return {
        "exchange":        os.environ.get("EXCHANGE", "okx"),
        "api_key":         os.environ.get("EXCHANGE_API_KEY", ""),
        "api_secret":      os.environ.get("EXCHANGE_API_SECRET", ""),
        "api_passphrase":  os.environ.get("EXCHANGE_PASSPHRASE", ""),
        "paper":           _env_bool("PAPER_TRADING", False),
        "leverage":        _env_int("LEVERAGE", 10),
        "symbols":         _env_list("SYMBOLS", "BTC-USDT-SWAP"),
        "interval":        _env_int("INTERVAL_SECONDS", 60),
        "bot_state_file":  os.environ.get("BOT_STATE_FILE", "bot_state.json"),

        # Adaptive bot core params
        "account_balance":       _env_float("ACCOUNT_BALANCE", 10_000.0),
        "base_risk_pct":         _env_float("BASE_RISK_PCT", 0.01),
        "daily_loss_limit_pct":  _env_float("DAILY_LOSS_LIMIT_PCT", -3.0),
        "daily_profit_limit_pct": _env_float("DAILY_PROFIT_LIMIT_PCT", 8.0),
        "cooldown_minutes":      _env_int("COOLDOWN_MINUTES", 30),
        "max_loss_streak":       _env_int("MAX_LOSS_STREAK", 3),
        "tp1_close_pct":         _env_float("TP1_CLOSE_PCT", 0.50),

        # Runtime safety
        "max_tick_staleness_sec": _env_int("MAX_TICK_STALENESS_SEC", 900),

        "telegram_token":      os.environ.get("TELEGRAM_BOT_TOKEN", ""),
        "telegram_chat_id":    os.environ.get("TELEGRAM_CHAT_ID", ""),
    }


# ---------------------------------------------------------------------------
# Build connector (for live execution + data fetch)
# ---------------------------------------------------------------------------

def _make_exchange_adapter(cfg: dict):
    from trading.strategies.okx_exchange import OKXExecutionAdapter

    return OKXExecutionAdapter(
        symbol=cfg["symbols"][0],
        sandbox=cfg["paper"],
        td_mode="cross",
    )


# ---------------------------------------------------------------------------
# Build telegram
# ---------------------------------------------------------------------------

def _make_telegram(cfg: dict):
    from trading.telegram_notifier import TelegramNotifier

    token = cfg.get("telegram_token", "").strip()
    chat = cfg.get("telegram_chat_id", "").strip()
    if not token or not chat:
        logger.warning("Telegram NOT configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing)")
        return None
    return TelegramNotifier(token=token, chat_id=chat)


# ---------------------------------------------------------------------------
# Indicator/Candle mapping helpers
# ---------------------------------------------------------------------------

def _to_candle_dict(ohlcv_row):
    # ohlcv format from ccxt: [timestamp, open, high, low, close, volume]
    ts, o, h, l, c, v = ohlcv_row
    return {
        "timestamp": ts,
        "open": float(o),
        "high": float(h),
        "low": float(l),
        "close": float(c),
        "volume": float(v),
        # fallback placeholders for pattern-based SL logic
        "pattern_low": float(l),
        "pattern_high": float(h),
    }


def _basic_indicators_from_candles(rows):
    # Lightweight indicators to satisfy adaptive bot required keys.
    # This is intentionally conservative and deterministic.
    import numpy as np

    closes = np.array([r[4] for r in rows], dtype=float)
    highs = np.array([r[2] for r in rows], dtype=float)
    lows = np.array([r[3] for r in rows], dtype=float)
    vols = np.array([r[5] for r in rows], dtype=float)

    last_close = float(closes[-1])
    ema5 = float(np.mean(closes[-5:])) if len(closes) >= 5 else last_close
    ema20 = float(np.mean(closes[-20:])) if len(closes) >= 20 else last_close
    atr = float(np.mean(highs[-14:] - lows[-14:])) if len(highs) >= 14 else float(highs[-1] - lows[-1])
    vol_avg = float(np.mean(vols[-20:])) if len(vols) >= 20 else float(vols[-1])

    # simple proxy scores
    trend_score = 70.0 if ema5 > ema20 else 40.0
    momentum_score = 65.0 if closes[-1] > closes[-2] else 45.0 if len(closes) >= 2 else 50.0
    volume_score = 65.0 if vols[-1] >= vol_avg else 45.0

    # very simple RSI proxy
    if len(closes) >= 15:
        diffs = np.diff(closes[-15:])
        gain = np.mean(np.clip(diffs, 0, None))
        loss = np.mean(np.clip(-diffs, 0, None)) + 1e-9
        rs = gain / loss
        rsi = float(100 - (100 / (1 + rs)))
    else:
        rsi = 50.0

    return {
        "adx": 25.0,
        "rsi": rsi,
        "macd": float(ema5 - ema20),
        "macd_signal": float((ema5 - ema20) * 0.8),
        "ema5": ema5,
        "ema20": ema20,
        "atr": max(atr, 1e-9),
        "volume": float(vols[-1]),
        "vol_avg": max(vol_avg, 1e-9),
        "trend_score": trend_score,
        "momentum_score": momentum_score,
        "volume_score": volume_score,
        "pattern_score": 55.0,
        "structure_score": 70.0 if ema5 > ema20 else 40.0,
        "atr_score": 55.0,
        "rsi_score": min(max(rsi, 0), 100),
        "sweep_score": 50.0,
        "divergence_score": 50.0,
        "ema_score": 60.0 if ema5 > ema20 else 40.0,
        "vwap_score": 55.0,
        "macd_score": 60.0 if (ema5 - ema20) > 0 else 40.0,
        "eff_ratio": 0.7 if ema5 != ema20 else 0.3,
        "atr_exp": 1.1,
        "bb_width": 0.5,
        "ema20_slope_score": 60.0 if ema5 > ema20 else 40.0,
        "adx_score": 60.0,
        "eff_score": 60.0,
        "vol_score": 55.0,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main():
    cfg = build_config()

    if not cfg["symbols"]:
        logger.critical("No SYMBOLS configured")
        sys.exit(1)

    # Pre-flight: refuse to start live mode with missing credentials
    if not cfg["paper"]:
        required = ["api_key", "api_secret"]
        if cfg["exchange"] == "okx":
            required.append("api_passphrase")
        missing = [k for k in required if not cfg.get(k, "").strip()]
        if missing:
            logger.critical("LIVE MODE but %s not set — set env vars and restart", missing)
            sys.exit(1)

    if cfg["exchange"] != "okx":
        logger.critical("adaptive_trading_bot live runner currently supports EXCHANGE=okx only")
        sys.exit(1)

    logger.info(
        "=== Adaptive bot starting [%s] exchange=%s symbol=%s ===",
        "PAPER" if cfg["paper"] else "LIVE",
        cfg["exchange"],
        cfg["symbols"][0],
    )

    from trading.strategies.adaptive_trading_bot import TradingBot as AdaptiveTradingBot

    exchange_adapter = _make_exchange_adapter(cfg)
    telegram = _make_telegram(cfg)

    bot = AdaptiveTradingBot(
        account_balance=cfg["account_balance"],
        base_risk_pct=cfg["base_risk_pct"],
        daily_loss_limit_pct=cfg["daily_loss_limit_pct"],
        daily_profit_limit_pct=cfg["daily_profit_limit_pct"],
        cooldown_minutes=cfg["cooldown_minutes"],
        max_loss_streak=cfg["max_loss_streak"],
        tp1_close_pct=cfg["tp1_close_pct"],
        execution_callback=exchange_adapter.execute,
    )

    state_file = cfg["bot_state_file"]
    bot.load_state(state_file)
    bot.reconcile_with_exchange(cfg["symbols"][0], exchange_adapter)

    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()

    def _handle_signal():
        logger.info("Shutdown signal received")
        stop_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _handle_signal)
        except (NotImplementedError, RuntimeError):
            pass

    async def _tick_loop():
        symbol = cfg["symbols"][0]
        max_staleness_ms = cfg["max_tick_staleness_sec"] * 1000

        while not stop_event.is_set():
            try:
                rows_15m = exchange_adapter.exchange.fetch_ohlcv(symbol, timeframe="15m", limit=400)
                rows_1h = exchange_adapter.exchange.fetch_ohlcv(symbol, timeframe="1h", limit=400)
                rows_4h = exchange_adapter.exchange.fetch_ohlcv(symbol, timeframe="4h", limit=400)

                if len(rows_15m) < 30 or len(rows_1h) < 30 or len(rows_4h) < 30:
                    logger.warning("Not enough OHLCV yet (15m=%d 1h=%d 4h=%d)", len(rows_15m), len(rows_1h), len(rows_4h))
                    await asyncio.sleep(cfg["interval"])
                    continue

                c15 = _to_candle_dict(rows_15m[-1])
                c1h = _to_candle_dict(rows_1h[-1])
                c4h = _to_candle_dict(rows_4h[-1])

                now_ms = int(asyncio.get_running_loop().time() * 1000)
                # loop.time() is monotonic; only use as coarse guard with relaxed window.
                # Primary intent: avoid processing if feed stalls badly.
                if max_staleness_ms > 0 and abs(now_ms - int(c15["timestamp"])) > (max_staleness_ms * 10):
                    logger.warning("15m candle appears stale (ts=%s), skipping tick", c15["timestamp"])
                    await asyncio.sleep(cfg["interval"])
                    continue

                i15 = _basic_indicators_from_candles(rows_15m)
                i1h = _basic_indicators_from_candles(rows_1h)
                i4h = _basic_indicators_from_candles(rows_4h)

                extras = {
                    "symbol": symbol,
                    "session": "AUTO",
                    "funding_rate": None,
                    "oi": None,
                }
                current_price = float(c15["close"])

                bot.on_tick(
                    candle_15m=c15,
                    candle_1h=c1h,
                    candle_4h=c4h,
                    ind_15m=i15,
                    ind_1h=i1h,
                    ind_4h=i4h,
                    extras=extras,
                    current_price=current_price,
                )

                if telegram:
                    try:
                        status = bot.get_status()
                        telegram.notify_signal(
                            symbol=symbol,
                            side=status.get("direction") or "N/A",
                            confidence=0.5,
                            reason=f"state={status.get('state')} pnl={status.get('realized_pnl', 0):+.2f}",
                        )
                    except Exception as te:
                        logger.warning("Telegram notify failed: %s", te)

            except Exception as e:
                logger.exception("Tick loop error: %s", e)
                if bot.state == "ERROR":
                    logger.error("Bot entered ERROR state, stopping for manual intervention")
                    stop_event.set()
                    break

            await asyncio.sleep(cfg["interval"])

    tick_task = asyncio.create_task(_tick_loop())

    try:
        await stop_event.wait()
    finally:
        logger.info("Stopping adaptive bot...")
        tick_task.cancel()
        try:
            await tick_task
        except asyncio.CancelledError:
            pass

        try:
            bot.save_state(state_file)
        except Exception as e:
            logger.warning("Bot save_state error (non-fatal): %s", e)

        try:
            exchange_adapter.exchange.close()
        except Exception as e:
            logger.warning("Exchange close error (non-fatal): %s", e)

        await asyncio.sleep(0.2)
        logger.info("Done.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
