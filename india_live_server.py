"""
india_live_server.py — Railway always-on server
Streams Angel One live ticks → Supabase india_live_prices table.
Loads prev_close from DB on startup for accurate intraday % calculation.
"""

import os, time, threading, logging, pyotp, requests
from datetime import datetime, timezone, timedelta
from supabase import create_client

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
log = logging.getLogger(__name__)

ANGEL_API_KEY     = os.environ["ANGEL_API_KEY"]
ANGEL_CLIENT_ID   = os.environ["ANGEL_CLIENT_ID"]
ANGEL_PIN         = os.environ["ANGEL_PIN"]
ANGEL_TOTP_SECRET = os.environ["ANGEL_TOTP_SECRET"]
SUPABASE_URL      = os.environ["SUPABASE_URL"]
SUPABASE_KEY      = os.environ["SUPABASE_KEY"]

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

UPSERT_BATCH    = 50
UPSERT_INTERVAL = 0.5

def is_nse_open():
    now = datetime.now(timezone.utc)
    ist = now + timedelta(hours=5, minutes=30)
    if ist.weekday() >= 5:
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
    now = datetime.now(timezone.utc)
    ist = now + timedelta(hours=5, minutes=30)
    next_open = ist.replace(hour=9, minute=15, second=0, microsecond=0)
    if ist >= next_open:
        next_open += timedelta(days=1)
    while next_open.weekday() >= 5:
        next_open += timedelta(days=1)
    return max((next_open - ist).total_seconds(), 0)

def angel_login():
    totp = pyotp.TOTP(ANGEL_TOTP_SECRET).now()
    resp = requests.post(
        "https://apiconnect.angelbroking.com/rest/auth/angelbroking/user/v1/loginByPassword",
        headers={"Content-Type":"application/json","Accept":"application/json","X-UserType":"USER","X-SourceID":"WEB","X-ClientLocalIP":"127.0.0.1","X-ClientPublicIP":"127.0.0.1","X-MACAddress":"00:00:00:00:00:00","X-PrivateKey":ANGEL_API_KEY},
        json={"clientcode":ANGEL_CLIENT_ID,"password":ANGEL_PIN,"totp":totp},
        timeout=15
    ).json()
    if not resp.get("status") or not resp.get("data",{}).get("jwtToken"):
        raise Exception(f"Login failed: {resp.get('message')}")
    log.info("Angel One login successful")
    return resp["data"]["jwtToken"], resp["data"]["feedToken"]

def load_scrip_master():
    log.info("Loading scrip master...")
    data = requests.get("https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json", timeout=30).json()
    token_to_sym = {}
    sym_to_token = {}
    for item in data:
        if item.get("exch_seg") == "NSE" and str(item.get("symbol","")).endswith("-EQ"):
            sym = item["symbol"].replace("-EQ","")
            tok = str(item["token"])
            token_to_sym[tok] = sym
            sym_to_token[sym] = tok
    log.info(f"Scrip master loaded: {len(token_to_sym)} NSE equity symbols")
    return token_to_sym, sym_to_token

def load_prev_closes(jwt, token_to_sym):
    """
    Fetch official NSE previous close for all India stocks via Angel One bulk quote.
    Angel One's 'close' field = yesterday's official closing price from NSE.
    Returns {symbol: prev_close_price}.
    """
    log.info("Loading prev_close from Angel One bulk quote...")
    prev_closes = {}
    tokens = list(token_to_sym.keys())
    try:
        for i in range(0, len(tokens), 50):
            batch = tokens[i:i+50]
            resp = requests.post(
                "https://apiconnect.angelbroking.com/rest/secure/angelbroking/market/v1/quote/",
                headers={"Authorization": f"Bearer {jwt}", "Content-Type": "application/json",
                         "Accept": "application/json", "X-UserType": "USER", "X-SourceID": "WEB",
                         "X-ClientLocalIP": "127.0.0.1", "X-ClientPublicIP": "127.0.0.1",
                         "X-MACAddress": "00:00:00:00:00:00", "X-PrivateKey": ANGEL_API_KEY},
                json={"mode": "LTP", "exchangeTokens": {"NSE": batch}},
                timeout=15
            ).json()
            if resp.get("status"):
                for q in resp.get("data", {}).get("fetched", []):
                    tok = str(q.get("symbolToken", ""))
                    sym = token_to_sym.get(tok)
                    close = q.get("close") or q.get("ltp")
                    if sym and close:
                        prev_closes[sym] = float(close)
            time.sleep(0.1)
    except Exception as e:
        log.error(f"Failed to load prev_closes: {e}")
    log.info(f"Loaded prev_close for {len(prev_closes)} symbols")
    return prev_closes

def load_india_tokens(sym_to_token):
    log.info("Loading India instruments from Supabase...")
    all_syms = []
    offset = 0
    while True:
        batch = supabase.table("instruments").select("symbol").eq("universe","india_stocks").range(offset, offset+999).execute()
        all_syms.extend([r["symbol"] for r in batch.data])
        if len(batch.data) < 1000:
            break
        offset += 1000
    tokens = []
    skipped = []
    for sym in all_syms:
        tok = sym_to_token.get(sym) or sym_to_token.get(sym.replace("_","")) or \
              (sym_to_token.get(sym.replace(".RR","")) if ".RR" in sym else None)
        if tok:
            tokens.append(tok)
        else:
            skipped.append(sym)
    log.info(f"Mapped: {len(tokens)}  Skipped: {len(skipped)}")
    return tokens

tick_buffer = {}
buffer_lock = threading.Lock()

def on_tick(tick, token_to_sym, prev_closes):
    try:
        token = str(tick.get("token",""))
        sym   = token_to_sym.get(token)
        if not sym:
            return
        ltp  = tick.get("last_traded_price", 0) / 100
        prev = tick.get("close_price", 0) / 100

        # If Angel One sends zero prev_close, use DB prev_close
        if prev <= 0:
            prev = prev_closes.get(sym, 0)

        pct = ((ltp - prev) / prev * 100) if prev > 0 and ltp > 0 else None

        with buffer_lock:
            record = {
                "symbol":     sym,
                "ltp":        round(ltp, 2),
                "prev_close": round(prev, 2),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
            if pct is not None:
                record["percent_change"] = round(pct, 4)
            tick_buffer[sym] = record
    except Exception as e:
        log.warning(f"Tick error: {e}")

def flush_loop():
    while True:
        time.sleep(UPSERT_INTERVAL)
        with buffer_lock:
            if not tick_buffer:
                continue
            records = list(tick_buffer.values())
            tick_buffer.clear()
        try:
            for i in range(0, len(records), UPSERT_BATCH):
                supabase.table("india_live_prices").upsert(records[i:i+UPSERT_BATCH], on_conflict="symbol").execute()
            log.info(f"Flushed {len(records)} ticks to Supabase")
        except Exception as e:
            log.error(f"Supabase flush error: {e}")

def run_websocket(jwt, feed_token, tokens, token_to_sym, prev_closes):
    from SmartApi.smartWebSocketV2 import SmartWebSocketV2

    sws = SmartWebSocketV2(
        auth_token=jwt, api_key=ANGEL_API_KEY,
        client_code=ANGEL_CLIENT_ID, feed_token=feed_token, max_retry_attempt=5,
    )

    def on_open(wsapp):
        log.info("WebSocket connected — subscribing tokens...")
        BATCH = 999
        for i in range(0, len(tokens), BATCH):
            b = tokens[i:i+BATCH]
            sws.subscribe(f"india_live_{i}", 3, [{"exchangeType":1,"tokens":b}])
            log.info(f"Subscribed batch {i//BATCH+1}: {len(b)} tokens")
        log.info(f"Total: {len(tokens)} tokens subscribed")

    def on_data(wsapp, message):
        on_tick(message, token_to_sym, prev_closes)

    def on_error(wsapp, error):
        log.error(f"WebSocket error: {error}")

    def on_close(wsapp):
        log.warning("WebSocket closed")

    sws.on_open = on_open; sws.on_data = on_data
    sws.on_error = on_error; sws.on_close = on_close
    sws.connect()


def bulk_quote_poll(jwt, token_to_sym, prev_closes):
    tokens = list(token_to_sym.keys())
    last_poll = [0]
    while True:
        time.sleep(5)
        if time.time() - last_poll[0] < 60:
            continue
        if not is_nse_open():
            continue
        last_poll[0] = time.time()
        log.info("Bulk quote poll starting...")
        records = []
        try:
            for i in range(0, len(tokens), 50):
                batch = tokens[i:i+50]
                resp = requests.post(
                    "https://apiconnect.angelbroking.com/rest/secure/angelbroking/market/v1/quote/",
                    headers={"Authorization": f"Bearer {jwt}", "Content-Type": "application/json",
                             "Accept": "application/json", "X-UserType": "USER", "X-SourceID": "WEB",
                             "X-ClientLocalIP": "127.0.0.1", "X-ClientPublicIP": "127.0.0.1",
                             "X-MACAddress": "00:00:00:00:00:00", "X-PrivateKey": ANGEL_API_KEY},
                    json={"mode": "FULL", "exchangeTokens": {"NSE": batch}},
                    timeout=15
                ).json()
                if resp.get("status"):
                    for q in resp.get("data", {}).get("fetched", []):
                        tok = str(q.get("symbolToken", ""))
                        sym = token_to_sym.get(tok)
                        if not sym:
                            continue
                        ltp  = float(q.get("ltp") or 0)
                        prev = float(q.get("close") or 0) or prev_closes.get(sym, 0)
                        pct  = ((ltp - prev) / prev * 100) if prev > 0 and ltp > 0 else None
                        if ltp > 0:
                            record = {
                                "symbol": sym, "ltp": round(ltp, 2),
                                "prev_close": round(prev, 2),
                                "updated_at": datetime.now(timezone.utc).isoformat(),
                            }
                            if pct is not None:
                                record["percent_change"] = round(pct, 4)
                            records.append(record)
                time.sleep(0.1)
            for i in range(0, len(records), UPSERT_BATCH):
                supabase.table("india_live_prices").upsert(records[i:i+UPSERT_BATCH], on_conflict="symbol").execute()
            log.info(f"Bulk quote poll: pushed {len(records)} records")
        except Exception as e:
            log.error(f"Bulk quote poll error: {e}")

def main():
    log.info("🚀 India Live Server starting...")
    token_to_sym, sym_to_token = load_scrip_master()

    threading.Thread(target=flush_loop, daemon=True).start()

    while True:
        if not is_nse_open():
            wait = seconds_until_nse_open()
            log.info(f"NSE closed — sleeping {wait/3600:.1f} hours until next open")
            time.sleep(min(wait, 3600))
            continue
        try:
            log.info("NSE is open — connecting to Angel One WebSocket...")
            jwt, feed_token = angel_login()
            tokens     = load_india_tokens(sym_to_token)
            prev_closes = load_prev_closes(jwt, token_to_sym)
            threading.Thread(target=bulk_quote_poll, args=(jwt, token_to_sym, prev_closes), daemon=True).start()
            run_websocket(jwt, feed_token, tokens, token_to_sym, prev_closes)
        except Exception as e:
            log.error(f"Error: {e} — reconnecting in 10s...")
            time.sleep(10)

if __name__ == "__main__":
    main()