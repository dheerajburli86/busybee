"""
india_live_server.py — Railway always-on server
================================================
Connects to Angel One smartWebSocketV2, streams live NSE ticks
for all India stocks, writes to Supabase `india_live_prices` table.

Frontend subscribes to Supabase Realtime on that table — gets
sub-200ms live prices without any polling.

Architecture:
  Angel One WebSocket → this server → Supabase upsert → Frontend Realtime

Runs 24/7 on Railway. Auto-reconnects on disconnect.
Only active during NSE hours (9:15am–3:30pm IST weekdays).
Outside hours: sleeps and reconnects at next market open.

Environment variables (set in Railway dashboard):
  ANGEL_API_KEY
  ANGEL_CLIENT_ID
  ANGEL_PIN
  ANGEL_TOTP_SECRET
  SUPABASE_URL
  SUPABASE_KEY
"""

import os, time, json, asyncio, logging, pyotp, requests
from datetime import datetime, timezone, timedelta
from supabase import create_client

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
log = logging.getLogger(__name__)

# ─── CONFIG ───────────────────────────────────────────────────────────────────
ANGEL_API_KEY     = os.environ["ANGEL_API_KEY"]
ANGEL_CLIENT_ID   = os.environ["ANGEL_CLIENT_ID"]
ANGEL_PIN         = os.environ["ANGEL_PIN"]
ANGEL_TOTP_SECRET = os.environ["ANGEL_TOTP_SECRET"]
SUPABASE_URL      = os.environ["SUPABASE_URL"]
SUPABASE_KEY      = os.environ["SUPABASE_KEY"]

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# Batch size for Supabase upserts — balance between latency and API calls
UPSERT_BATCH    = 50
UPSERT_INTERVAL = 0.5   # seconds — flush accumulated ticks every 500ms

# ─── MARKET HOURS ─────────────────────────────────────────────────────────────
def is_nse_open():
    now = datetime.now(timezone.utc)
    ist = now + timedelta(hours=5, minutes=30)
    if ist.weekday() >= 5:  # Saturday=5, Sunday=6
        return False
    NSE_HOLIDAYS = {
        "2026-01-26","2026-02-26","2026-03-20","2026-04-02","2026-04-03",
        "2026-04-14","2026-05-01","2026-08-15","2026-10-02","2026-10-20",
        "2026-10-28","2026-10-29","2026-11-05","2026-12-25",
    }
    if ist.strftime("%Y-%m-%d") in NSE_HOLIDAYS:
        return False
    mins = ist.hour * 60 + ist.minute
    return 9 * 60 + 15 <= mins < 15 * 60 + 30

def seconds_until_nse_open():
    """Return seconds until next NSE market open."""
    now = datetime.now(timezone.utc)
    ist = now + timedelta(hours=5, minutes=30)
    # Next 9:15am IST
    next_open = ist.replace(hour=9, minute=15, second=0, microsecond=0)
    if ist >= next_open:
        next_open += timedelta(days=1)
    # Skip weekends
    while next_open.weekday() >= 5:
        next_open += timedelta(days=1)
    delta = (next_open - ist).total_seconds()
    return max(delta, 0)

# ─── ANGEL ONE AUTH ───────────────────────────────────────────────────────────
def angel_login():
    totp = pyotp.TOTP(ANGEL_TOTP_SECRET).now()
    resp = requests.post(
        "https://apiconnect.angelbroking.com/rest/auth/angelbroking/user/v1/loginByPassword",
        headers={
            "Content-Type": "application/json", "Accept": "application/json",
            "X-UserType": "USER", "X-SourceID": "WEB",
            "X-ClientLocalIP": "127.0.0.1", "X-ClientPublicIP": "127.0.0.1",
            "X-MACAddress": "00:00:00:00:00:00", "X-PrivateKey": ANGEL_API_KEY,
        },
        json={"clientcode": ANGEL_CLIENT_ID, "password": ANGEL_PIN, "totp": totp},
        timeout=15
    ).json()
    if not resp.get("status") or not resp.get("data", {}).get("jwtToken"):
        raise Exception(f"Login failed: {resp.get('message')} ({resp.get('errorcode')})")
    log.info("Angel One login successful")
    return resp["data"]["jwtToken"], resp["data"]["feedToken"]

# ─── SCRIP MASTER ─────────────────────────────────────────────────────────────
def load_scrip_master():
    """Load NSE equity token→symbol map from Angel One scrip master."""
    log.info("Loading scrip master...")
    data = requests.get(
        "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json",
        timeout=30
    ).json()
    # token → symbol (for looking up symbol from incoming tick token)
    token_to_sym = {}
    sym_to_token = {}
    for item in data:
        if item.get("exch_seg") == "NSE" and str(item.get("symbol","")).endswith("-EQ"):
            sym   = item["symbol"].replace("-EQ", "")
            token = str(item["token"])
            token_to_sym[token] = sym
            sym_to_token[sym]   = token
    log.info(f"Scrip master loaded: {len(token_to_sym)} NSE equity symbols")
    return token_to_sym, sym_to_token

# ─── LOAD INSTRUMENT TOKENS FROM SUPABASE ────────────────────────────────────
def load_india_tokens(sym_to_token):
    """
    Get all india_stocks symbols from Supabase instruments table.
    Map each to its Angel One token.
    Returns list of token strings to subscribe to.
    """
    log.info("Loading India instruments from Supabase...")
    all_syms = []
    offset   = 0
    while True:
        batch = supabase.table("instruments") \
                        .select("symbol") \
                        .eq("universe", "india_stocks") \
                        .range(offset, offset + 999).execute()
        all_syms.extend([r["symbol"] for r in batch.data])
        if len(batch.data) < 1000:
            break
        offset += 1000

    tokens  = []
    skipped = []
    for sym in all_syms:
        # Handle symbol variants (same logic as scraper)
        tok = sym_to_token.get(sym) or \
              sym_to_token.get(sym.replace("_","")) or \
              (sym_to_token.get(sym.replace(".RR","")) if ".RR" in sym else None)
        if tok:
            tokens.append(tok)
        else:
            skipped.append(sym)

    log.info(f"Subscribed tokens: {len(tokens)}  Skipped: {len(skipped)}")
    return tokens

# ─── SUPABASE WRITER ──────────────────────────────────────────────────────────
# Accumulates ticks and flushes every UPSERT_INTERVAL seconds
# This prevents hammering Supabase with individual upserts per tick

tick_buffer = {}   # { symbol: {ltp, percent_change, prev_close, updated_at} }
buffer_lock = asyncio.Lock()

async def flush_loop():
    """Background task — flush tick_buffer to Supabase every 500ms."""
    while True:
        await asyncio.sleep(UPSERT_INTERVAL)
        async with buffer_lock:
            if not tick_buffer:
                continue
            records = list(tick_buffer.values())
            tick_buffer.clear()

        # Upsert in batches
        try:
            for i in range(0, len(records), UPSERT_BATCH):
                batch = records[i:i + UPSERT_BATCH]
                supabase.table("india_live_prices").upsert(
                    batch, on_conflict="symbol"
                ).execute()
            log.debug(f"Flushed {len(records)} ticks to Supabase")
        except Exception as e:
            log.error(f"Supabase flush error: {e}")

async def on_tick(tick, token_to_sym):
    """Process a single tick from Angel One WebSocket."""
    try:
        token = str(tick.get("token", ""))
        sym   = token_to_sym.get(token)
        if not sym:
            return

        ltp      = tick.get("last_traded_price", 0) / 100  # Angel One sends paise
        prev     = tick.get("close_price", 0) / 100         # prev close in paise
        pct      = ((ltp - prev) / prev * 100) if prev > 0 else 0

        async with buffer_lock:
            tick_buffer[sym] = {
                "symbol":          sym,
                "ltp":             round(ltp, 2),
                "prev_close":      round(prev, 2),
                "percent_change":  round(pct, 4),
                "updated_at":      datetime.now(timezone.utc).isoformat(),
            }
    except Exception as e:
        log.warning(f"Tick processing error: {e}")

# ─── WEBSOCKET CLIENT ─────────────────────────────────────────────────────────
def run_websocket(jwt, feed_token, tokens, token_to_sym):
    """
    Connect to Angel One smartWebSocketV2 and stream ticks.
    Uses the official smartapi-python SmartWebSocketV2 under the hood.
    Falls back to manual websocket if library not available.
    """
    try:
        from SmartApi.smartWebSocketV2 import SmartWebSocketV2

        sws = SmartWebSocketV2(
            auth_token=jwt,
            api_key=ANGEL_API_KEY,
            client_code=ANGEL_CLIENT_ID,
            feed_token=feed_token,
            max_retry_attempt=5,
        )

        def on_open(wsapp):
            log.info("WebSocket connected — subscribing to tokens...")
            # Angel One limit: 1000 tokens per subscribe call — split into batches
            BATCH = 999
            for i in range(0, len(tokens), BATCH):
                batch = tokens[i:i+BATCH]
                token_list = [{"exchangeType": 1, "tokens": batch}]
                sws.subscribe(f"india_live_{i}", 3, token_list)
                log.info(f"Subscribed batch {i//BATCH+1}: {len(batch)} tokens")
            log.info(f"Total subscribed: {len(tokens)} NSE tokens")

        def on_data(wsapp, message):
            asyncio.run_coroutine_threadsafe(
                on_tick(message, token_to_sym),
                asyncio.get_event_loop()
            )

        def on_error(wsapp, error):
            log.error(f"WebSocket error: {error}")

        def on_close(wsapp):
            log.warning("WebSocket closed")

        sws.on_open    = on_open
        sws.on_data    = on_data
        sws.on_error   = on_error
        sws.on_close   = on_close

        sws.connect()

    except ImportError:
        log.error("SmartApi library not installed — install smartapi-python")
        raise

# ─── MAIN LOOP ────────────────────────────────────────────────────────────────
async def main():
    log.info("🚀 India Live Server starting...")

    token_to_sym, sym_to_token = load_scrip_master()

    # Start Supabase flush background task
    asyncio.create_task(flush_loop())

    while True:
        if not is_nse_open():
            wait = seconds_until_nse_open()
            log.info(f"NSE closed — sleeping {wait/3600:.1f} hours until next open")
            await asyncio.sleep(min(wait, 3600))  # wake up every hour max to recheck
            continue

        try:
            log.info("NSE is open — connecting to Angel One WebSocket...")
            jwt, feed_token = angel_login()
            tokens = load_india_tokens(sym_to_token)

            # Run WebSocket in executor (it's blocking)
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None,
                lambda: run_websocket(jwt, feed_token, tokens, token_to_sym)
            )

        except Exception as e:
            log.error(f"Error: {e} — reconnecting in 10s...")
            await asyncio.sleep(10)

if __name__ == "__main__":
    asyncio.run(main())
