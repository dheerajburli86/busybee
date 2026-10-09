"""
BusyBee scheduler.

Runs the notifications that need a clock rather than a user action:
  #9  / SOW #24 - reminders 24, 8 and 6 hours before a deadline, to the
                  assignee (or the team it was given to) and the assignors
  #43           - an overdue alert once the deadline passes
  #6            - a reminder when a checklist item is due within a day
  #2            - "remind me at" reminders people set on tasks and to-do items
  #35 / SOW #25 - a start-of-day and end-of-day summary for every user
  SOW #24       - a nudge for an update when open work has gone quiet
  #12           - completed work is archived after a few days

Deploy on Railway with these environment variables:
  SUPABASE_URL          - https://<project>.supabase.co
  SUPABASE_SERVICE_KEY  - the service_role key (not the anon key)
  BOD_HOUR              - optional, defaults to 9
  EOD_HOUR              - optional, defaults to 18
  TZ_OFFSET_HOURS       - optional, defaults to 5.5 for IST
  UPDATE_REQUEST_DAYS   - optional, defaults to 3 (0 switches it off)
  AUTO_ARCHIVE_DAYS     - optional, defaults to 7 (0 switches it off)
  GMAIL_USER            - optional, Gmail address to send email from
  GMAIL_APP_PASSWORD    - optional, that account's 16-letter app password
  RESEND_API_KEY        - optional alternative to Gmail
  MAIL_FROM             - optional, Resend sender, e.g. "BusyBee <busybee@yourdomain.com>"
                          (Resend's default test sender only delivers to the
                          Resend account's own address)
  APP_URL               - optional, e.g. https://busybee-xi.vercel.app, to put
                          a link to the task in emails and Telegram messages
  TELEGRAM_BOT_TOKEN    - optional, the same bot token as the web app, to send
                          every alert to people's Telegram as well
"""

import json as _json
import smtplib
import ssl
from email.message import EmailMessage
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

from apscheduler.schedulers.blocking import BlockingScheduler
from supabase import create_client

VERSION = "2026-10-08"


def _env_number(name: str, default, cast=int):
    """A number from the environment; an empty or malformed value falls back
    to the default (with a warning) instead of crashing the service."""
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        return cast(raw)
    except ValueError:
        print(f"{name}={raw!r} isn't a number - using {default}", file=sys.stderr, flush=True)
        return default


def _env_hour(name: str, default: int) -> int:
    """Like _env_number, but also rejects an out-of-range hour (e.g. 24, -1)
    instead of handing it to CronTrigger/timezone(), which raise ValueError
    at import time - outside any try/except - and would crash the whole
    container on boot over a single bad env var."""
    value = _env_number(name, default)
    if not (0 <= value <= 23):
        print(f"{name}={value!r} isn't a valid hour (0-23) - using {default}", file=sys.stderr, flush=True)
        return default
    return value


def _env_offset(name: str, default: float) -> float:
    value = _env_number(name, default, float)
    if not (-23.99 <= value <= 23.99):
        print(f"{name}={value!r} isn't a valid UTC offset - using {default}", file=sys.stderr, flush=True)
        return default
    return value


SUPABASE_URL = (os.environ.get("SUPABASE_URL") or "").strip()
SUPABASE_SERVICE_KEY = (os.environ.get("SUPABASE_SERVICE_KEY") or "").strip()
BOD_HOUR = _env_hour("BOD_HOUR", 9)
EOD_HOUR = _env_hour("EOD_HOUR", 18)
TZ_OFFSET_HOURS = _env_offset("TZ_OFFSET_HOURS", 5.5)
UPDATE_REQUEST_DAYS = _env_number("UPDATE_REQUEST_DAYS", 3)
# The hour (office time) for the once-a-day countdown to every live deadline.
DAILY_REMINDER_HOUR = _env_hour("DAILY_REMINDER_HOUR", 10)
# How long the daily "still overdue" note keeps going after a deadline. Without
# a cap, the first run would ping everyone about every task that went overdue
# months ago and was simply never closed.
OVERDUE_DAILY_DAYS = _env_number("OVERDUE_DAILY_DAYS", 14)
AUTO_ARCHIVE_DAYS = _env_number("AUTO_ARCHIVE_DAYS", 7)
APP_URL = (os.environ.get("APP_URL") or "").strip().rstrip("/")

if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
    print("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set", file=sys.stderr, flush=True)
    sys.exit(1)

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
LOCAL_TZ = timezone(timedelta(hours=TZ_OFFSET_HOURS))

# Reminder thresholds, in hours before the deadline, smallest first.
THRESHOLDS = [6, 8, 24]
FINISHED = ["done", "closed"]
PAGE = 1000
# An overdue alert goes out once, shortly after the deadline passes. Work that
# has been overdue for longer (e.g. from before this scheduler was deployed)
# is left to the daily summaries instead of arriving as a burst of alerts.
OVERDUE_ALERT_WINDOW = timedelta(hours=24)
# A "remind me at" time that passed long ago (e.g. while the scheduler was
# down) is marked handled without sending a stale reminder.
STALE_REMINDER = timedelta(hours=12)

TASK_COLUMNS = (
    "id, desk_id, title, due_date, status, assigned_to, created_by, task_manager_id, "
    "team_id, department_id, group_id, personal, archived_at, updated_at, created_at"
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def log(message: str) -> None:
    print(message, flush=True)


def warn(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def parse(ts):
    if not ts:
        return None
    try:
        d = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def local(d: datetime) -> str:
    return f"{d.astimezone(LOCAL_TZ):%d %b %H:%M}"


def fetch_all(build):
    """Page through a query (PostgREST returns at most 1000 rows at a time).

    Stops on an empty page rather than a short one: some client versions ask
    for one row fewer than the range they are given.
    """
    rows, start = [], 0
    while True:
        res = build().range(start, start + PAGE - 1).execute()
        batch = res.data or []
        if not batch:
            return rows
        rows.extend(batch)
        start += len(batch)


def open_tasks():
    return fetch_all(
        lambda: supabase.table("tasks")
        .select(TASK_COLUMNS)
        .not_.in_("status", FINISHED)
        .is_("archived_at", "null")
        .order("id")
    )


def safe(fn):
    """A failing job logs and waits for its next run instead of stopping the scheduler."""
    def run():
        try:
            fn()
        except Exception as exc:  # noqa: BLE001
            warn(f"{fn.__name__} failed: {exc!r}")
    run.__name__ = fn.__name__
    return run


def normal_role(role) -> str:
    """desk_members.role as the app reads it ("owner" from the original app is admin)."""
    r = str(role or "").strip().lower()
    if r in ("owner", "administrator", "superadmin", "super_admin"):
        return "admin"
    return r if r in ("member", "manager", "supervisor", "admin") else "member"


class Desks:
    """Who is on which desk, and who leads it (supervisor or admin)."""

    def __init__(self):
        # Ordered by columns every version of the table has.
        try:
            rows = fetch_all(lambda: supabase.table("desk_members").select("desk_id, user_id, role, oversees").order("user_id"))
        except Exception:
            # Before the "oversees" column exists.
            rows = fetch_all(lambda: supabase.table("desk_members").select("desk_id, user_id, role").order("user_id"))
        self.members = {}    # desk_id -> {user ids}
        self.people = {}     # user_id -> {"desks": set, "leads": set, "heads": set}
        self.overseers = {}  # desk_id -> {user ids who hear about everything}
        for r in rows:
            self.members.setdefault(r["desk_id"], set()).add(r["user_id"])
            p = self.people.setdefault(r["user_id"], {"desks": set(), "leads": set(), "heads": set()})
            p["desks"].add(r["desk_id"])
            if normal_role(r.get("role")) in ("admin", "supervisor"):
                p["leads"].add(r["desk_id"])
            if r.get("oversees"):
                self.overseers.setdefault(r["desk_id"], set()).add(r["user_id"])
        # Who gets the team view: the desk's overseers, or every supervisor
        # on a desk that has no overseer.
        for uid, p in self.people.items():
            p["heads"] = {d for d in p["desks"] if uid in self.overseers.get(d, set())}
            p["heads"] |= {d for d in p["leads"] if not self.overseers.get(d)}

    def only_on_desk(self, desk_id, ids) -> set:
        """Drop anyone no longer on the task's desk (they can't open it any more)."""
        on_desk = self.members.get(desk_id, set())
        return {x for x in ids if x and x in on_desk}


_units_warned = [False]


class Units:
    """Who belongs to which team, department and custom group."""

    def __init__(self):
        # Teams are optional: a database without them must not stop every
        # reminder, so a missing table just means "no teams".
        try:
            teams = fetch_all(lambda: supabase.table("teams").select("id, department_id, manager_id").order("id"))
            members = fetch_all(lambda: supabase.table("team_members").select("team_id, user_id").order("team_id"))
        except Exception as exc:
            if not _units_warned[0]:
                warn(f"teams not readable, treating as none: {exc!r}")
                _units_warned[0] = True
            teams, members = [], []
        try:
            groups = fetch_all(lambda: supabase.table("group_members").select("group_id, user_id").order("group_id"))
        except Exception:
            groups = []
        self.team = {}
        for t in teams:
            ids = self.team.setdefault(t["id"], set())
            if t.get("manager_id"):
                ids.add(t["manager_id"])
        for m in members:
            self.team.setdefault(m["team_id"], set()).add(m["user_id"])
        self.dept_teams = {}
        for t in teams:
            if t.get("department_id"):
                self.dept_teams.setdefault(t["department_id"], []).append(t["id"])
        self.group = {}
        for g in groups:
            self.group.setdefault(g["group_id"], set()).add(g["user_id"])

    def members(self, task) -> set:
        ids = set()
        if task.get("team_id"):
            ids |= self.team.get(task["team_id"], set())
        if task.get("department_id"):
            for tid in self.dept_teams.get(task["department_id"], []):
                ids |= self.team.get(tid, set())
        if task.get("group_id"):
            ids |= self.group.get(task["group_id"], set())
        return ids


def extra_assignors() -> dict:
    rows = fetch_all(lambda: supabase.table("task_assignors").select("task_id, user_id").order("task_id"))
    out = {}
    for r in rows:
        out.setdefault(r["task_id"], set()).add(r["user_id"])
    return out


def doers(task, units: Units) -> set:
    """Whoever does the work: the named assignee, else the team/department/group."""
    if task.get("assigned_to"):
        return {task["assigned_to"]}
    return units.members(task)


def assignors(task, extras: dict) -> set:
    ids = {task.get("created_by"), task.get("task_manager_id")} | extras.get(task["id"], set())
    ids.discard(None)
    return ids


def owner_of(task):
    return task.get("assigned_to") or task.get("created_by")


def people_for(task, units: Units, extras: dict, desks: Desks) -> set:
    if task.get("personal"):
        ids = {owner_of(task)}
    else:
        ids = doers(task, units) | assignors(task, extras)
    return desks.only_on_desk(task.get("desk_id"), ids)


def already_sent(task_id: str, marker: str, since: datetime) -> bool:
    """Has this reminder gone out for the current deadline? Newer than `since` counts."""
    try:
        res = (
            supabase.table("notifications")
            .select("id")
            .eq("task_id", task_id)
            .eq("type", marker)
            .gte("created_at", since.isoformat())
            .limit(1)
            .execute()
        )
        if res.data:
            return True
    except Exception as exc:
        warn(f"dedupe check failed for {task_id}: {exc!r}")
        # Fail closed so a database blip cannot cause a burst of duplicates.
        return True
    # Sent only by email/Telegram (the bell was muted), so no notification row.
    try:
        res = (
            supabase.table("scheduler_sent")
            .select("task_id")
            .eq("task_id", task_id)
            .eq("marker", marker)
            .gte("sent_at", since.isoformat())
            .limit(1)
            .execute()
        )
        return bool(res.data)
    except Exception as exc:
        text = repr(exc)
        if "scheduler_sent" in text and ("PGRST205" in text or "42P01" in text or "does not exist" in text or "Could not find" in text):
            # Table not there yet (Telegram migration not run): behave as before.
            return False
        warn(f"dedupe check failed for {task_id}: {exc!r}")
        return True  # fail closed, like the check above


def mark_sent(task_id, marker: str) -> None:
    if not task_id:
        return
    try:
        supabase.table("scheduler_sent").upsert(
            {"task_id": task_id, "marker": marker, "sent_at": now_utc().isoformat()},
            on_conflict="task_id,marker",
        ).execute()
    except Exception:
        pass  # before the migration; the notification row still dedupes as before


# Checklist #48: notification preferences, mirroring frontend/lib/notifications.ts
# category-for-category. The scheduler is the only source of "reminder"/
# "overdue"/"checklist_due"/"bod_summary"/"eod_summary"/"update_request"
# notifications, so without this the settings page's "Deadline reminders"
# and "Daily summaries" toggles would silently do nothing.
_prefs = {}


def _category_of(ntype: str) -> str:
    t = ntype or ""
    if t in ("mention", "private_comment"):
        return "comments"
    if t in ("extension_request", "extension_reviewed", "assignor_added"):
        return "extensions"
    if t == "overdue" or t == "checklist_due" or t.startswith("reminder") or t.startswith("review_pending"):
        return "reminders"
    if t in ("bod_summary", "eod_summary", "update_request"):
        return "daily_summary"
    return "tasks"


def _prefs_for(user_id: str) -> dict:
    cached = _prefs.get(user_id)
    if cached and time.time() - cached[1] < 300:
        return cached[0]
    prefs = {"email_enabled": True, "telegram_enabled": True, "categories": {}}
    try:
        try:
            res = (
                supabase.table("notification_prefs")
                .select("email_enabled, telegram_enabled, categories")
                .eq("user_id", user_id)
                .limit(1)
                .execute()
            )
        except Exception:
            # Before the Telegram migration there is no telegram_enabled column.
            res = supabase.table("notification_prefs").select("email_enabled, categories").eq("user_id", user_id).limit(1).execute()
        row = (res.data or [None])[0]
        if row:
            prefs["email_enabled"] = row.get("email_enabled") is not False
            prefs["telegram_enabled"] = row.get("telegram_enabled") is not False
            prefs["categories"] = row.get("categories") or {}
    except Exception as exc:
        # Table missing or unreachable: fail open (everything on), same default
        # as a person who never visited the settings page.
        warn(f"could not load notification prefs for {user_id}: {exc!r}")
    _prefs[user_id] = (prefs, time.time())
    return prefs


def _wants(user_id: str, ntype: str, channel: str) -> bool:
    prefs = _prefs_for(user_id)
    if channel == "email" and not prefs["email_enabled"]:
        return False
    if channel == "telegram" and not prefs.get("telegram_enabled", True):
        return False
    cat = prefs["categories"].get(_category_of(ntype)) or {}
    return cat.get(channel) is not False


# SOW #30: email alongside the in-app notification. Gmail (GMAIL_USER +
# GMAIL_APP_PASSWORD) over SMTP if set, otherwise Resend's REST API if
# RESEND_API_KEY is set, otherwise a no-op.
GMAIL_USER = (os.environ.get("GMAIL_USER") or "").strip()
GMAIL_APP_PASSWORD = "".join((os.environ.get("GMAIL_APP_PASSWORD") or "").split())
MAIL_FROM = (
    f"BusyBee <{GMAIL_USER}>"
    if GMAIL_USER and GMAIL_APP_PASSWORD
    else (os.environ.get("MAIL_FROM") or "").strip() or "BusyBee <onboarding@resend.dev>"
)
_gmail_dead = [False]


def mail_on() -> bool:
    return bool((GMAIL_USER and GMAIL_APP_PASSWORD) or os.environ.get("RESEND_API_KEY"))
_emails = {}
_last_mail = [0.0]


def _email_for(user_id: str):
    cached = _emails.get(user_id)
    if cached and time.time() - cached[1] < 3600:
        return cached[0]
    try:
        res = supabase.table("users").select("email").eq("id", user_id).limit(1).execute()
    except Exception as exc:
        # Don't remember a failure: try again next time.
        warn(f"could not look up the email for {user_id}: {exc!r}")
        return None
    address = (res.data or [{}])[0].get("email")
    _emails[user_id] = (address, time.time())
    return address


def _send_gmail(user_id: str, address: str, subject: str, body: str, html: str = "") -> bool:
    if _gmail_dead[0]:
        return False
    msg = EmailMessage()
    msg["From"] = MAIL_FROM
    msg["To"] = address
    msg["Subject"] = subject
    msg.set_content(body)
    if html:
        msg.add_alternative(html, subtype="html")
    # Gmail doesn't like bursts; keep a small gap between messages.
    wait = 1.0 - (time.time() - _last_mail[0])
    if wait > 0:
        time.sleep(wait)
    _last_mail[0] = time.time()
    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=ssl.create_default_context(), timeout=15) as smtp:
            smtp.login(GMAIL_USER, GMAIL_APP_PASSWORD)
            smtp.send_message(msg)
        return True
    except smtplib.SMTPAuthenticationError as exc:
        # Wrong app password fails identically every time - say so once and
        # stop trying until the next deploy.
        _gmail_dead[0] = True
        warn(f"Gmail refused the login for {GMAIL_USER} - check GMAIL_APP_PASSWORD: {exc!r}")
        return False
    except Exception as exc:
        warn(f"email to {user_id} failed: {exc!r}")
        return False


def send_mail(user_id: str, subject: str, body: str, html: str = "") -> bool:
    gmail = bool(GMAIL_USER and GMAIL_APP_PASSWORD)
    key = os.environ.get("RESEND_API_KEY")
    if not gmail and not key:
        return False
    address = _email_for(user_id)
    if not address:
        return False
    if gmail:
        return _send_gmail(user_id, address, subject, body, html)
    mail = {"from": MAIL_FROM, "to": [address], "subject": subject, "text": body}
    if html:
        mail["html"] = html
    payload = _json.dumps(mail).encode()
    for attempt in range(2):
        # Resend allows a couple of requests a second; space them out.
        wait = 0.6 - (time.time() - _last_mail[0])
        if wait > 0:
            time.sleep(wait)
        _last_mail[0] = time.time()
        req = urllib.request.Request(
            "https://api.resend.com/emails",
            data=payload,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return 200 <= resp.status < 300
        except urllib.error.HTTPError as exc:
            if exc.code == 429 and attempt == 0:
                time.sleep(1.5)
                continue
            warn(f"email to {user_id} failed: HTTP {exc.code}")
            return False
        except Exception as exc:
            # A mail failure must never stop the scheduler loop.
            warn(f"email to {user_id} failed: {exc!r}")
            return False
    return False


# Telegram, the phone half of every alert. A no-op until TELEGRAM_BOT_TOKEN is
# set, and for anyone who hasn't connected their chat in Settings.
TELEGRAM_BOT_TOKEN = (os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
_chats = {}
_last_tg = [0.0]
_tg_table_warned = [False]

TG_ICONS = {
    "overdue": "🚨",
    "review_pending": "🔍",
    "checklist_due": "⏰",
    "bod_summary": "☀️",
    "eod_summary": "🌙",
    "reminder": "⏰",
    "update_request": "📝",
}


def _html(text) -> str:
    return str(text or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _chat_for(user_id: str):
    cached = _chats.get(user_id)
    if cached and time.time() - cached[1] < 600:
        return cached[0]
    try:
        res = supabase.table("user_telegram").select("chat_id").eq("user_id", user_id).limit(1).execute()
    except Exception as exc:
        if not _tg_table_warned[0]:
            warn(f"Telegram connections table not readable (run the Telegram migration?): {exc!r}")
            _tg_table_warned[0] = True
        return None
    chat = (res.data or [{}])[0].get("chat_id")
    _chats[user_id] = (chat, time.time())
    return chat


def _forget_chat(user_id: str) -> None:
    """They blocked the bot or deleted the chat: stop trying until they reconnect."""
    _chats[user_id] = (None, time.time())
    try:
        supabase.table("user_telegram").delete().eq("user_id", user_id).execute()
        log(f"Telegram chat for {user_id} is gone (blocked the bot?) - disconnected; they can reconnect in Settings")
    except Exception as exc:
        warn(f"could not disconnect stale Telegram chat for {user_id}: {exc!r}")


def send_telegram(user_id: str, ntype: str, title: str, message: str, task_id=None) -> bool:
    if not TELEGRAM_BOT_TOKEN:
        return False
    chat = _chat_for(user_id)
    if not chat:
        return False
    icon = TG_ICONS.get(ntype) or ("⏰" if (ntype or "").startswith("reminder") else "🔔")
    payload = {
        "chat_id": int(chat),
        "text": f"{icon} <b>{_html(title)}</b>\n{_html(str(message)[:3500])}",
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    if APP_URL.startswith("https://"):
        link = f"{APP_URL}/dashboard" + (f"?task={task_id}" if task_id else "")
        payload["reply_markup"] = {"inline_keyboard": [[{"text": "Open in BusyBee", "url": link}]]}
    data = _json.dumps(payload).encode()
    for attempt in range(2):
        # Telegram allows about one message a second to the same chat and 30 a
        # second overall; spacing every send keeps well inside both.
        wait = 0.05 - (time.time() - _last_tg[0])
        if wait > 0:
            time.sleep(wait)
        _last_tg[0] = time.time()
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return 200 <= resp.status < 300
        except urllib.error.HTTPError as exc:
            detail = ""
            retry_after = 1
            try:
                body = _json.loads(exc.read().decode() or "{}")
                detail = body.get("description") or ""
                retry_after = int((body.get("parameters") or {}).get("retry_after") or 1)
            except Exception:
                pass
            if exc.code == 429 and attempt == 0:
                time.sleep(min(retry_after, 5))
                continue
            if exc.code == 403 or (exc.code == 400 and "chat not found" in detail.lower()):
                _forget_chat(user_id)
                return False
            warn(f"Telegram to {user_id} failed: HTTP {exc.code} {detail}")
            return False
        except Exception as exc:
            # A Telegram failure must never stop the scheduler loop.
            warn(f"Telegram to {user_id} failed: {exc!r}")
            return False
    return False


# ---------------------------------------------------------------------------
# What the emails look like (same layout as lib/mailfmt.ts in the web app).
#
# An email must make sense to someone who has never opened BusyBee: whose
# task it is, who gave it, what it's about, when it's due, how far it has got
# and why this reader is getting it.
# ---------------------------------------------------------------------------

STATUS_WORDS = {
    "pending": "Not started",
    "in_progress": "Being worked on",
    "need_help": "Stuck - needs help",
    "done": "Finished - waiting for review",
    "closed": "Approved and closed",
}
PRIORITY_WORDS = {"super_high": "Super high", "high": "High", "medium": "Medium", "low": "Low"}
_names = {}
_projects = {}


def person_name(uid) -> str:
    if not uid:
        return ""
    hit = _names.get(uid)
    if hit and time.time() - hit[1] < 3600:
        return hit[0]
    try:
        res = supabase.table("users").select("full_name, email").eq("id", uid).limit(1).execute()
        row = (res.data or [{}])[0]
        name = row.get("full_name") or row.get("email") or "Someone"
    except Exception:
        name = "Someone"
    _names[uid] = (name, time.time())
    return name


def first_name(uid) -> str:
    return (person_name(uid) or "").split(" ")[0]


def project_name(pid):
    if not pid:
        return None
    if pid in _projects:
        return _projects[pid]
    try:
        res = supabase.table("projects").select("name").eq("id", pid).limit(1).execute()
        _projects[pid] = (res.data or [{}])[0].get("name")
    except Exception:
        _projects[pid] = None
    return _projects[pid]


def when_text(d, finished: bool = False) -> str:
    """'Fri 9 Oct, 6:00 PM (in 2 days)' / '(overdue by 3 days)'."""
    if not d:
        return "No deadline"
    base = f"{d.astimezone(LOCAL_TZ):%a %d %b, %I:%M %p}".replace(" 0", " ")
    if finished:
        return base
    secs = (d - now_utc()).total_seconds()
    days = round(abs(secs) / 86400)
    hours = max(1, round(abs(secs) / 3600))
    span = f"{days} day{'' if days == 1 else 's'}" if days >= 1 else f"{hours} hour{'' if hours == 1 else 's'}"
    return f"{base} ({'overdue by ' + span if secs < 0 else 'in ' + span})"


def whose(task, reader) -> str:
    """'your task "X"' for the assignee, 'Dheeraj Burli's task "X"' for anyone else."""
    owner = task.get("assigned_to")
    if owner and owner == reader:
        return f'your task "{task.get("title")}"'
    if owner:
        return f'{person_name(owner)}\'s task "{task.get("title")}"'
    return f'the task "{task.get("title")}"'


def cc_overseers(task, desks, already, ntype, title, text, subject):
    """Send the desk's overseers (Shankar) their own copy of a scheduled alert,
    worded for someone who isn't doing the work. `already` = who got the
    original, so nobody gets it twice."""
    for o in desks.overseers.get(task.get("desk_id"), set()) - set(already):
        try:
            notify(o, task["id"], ntype, title, text, subject=subject, overseer=True)
        except Exception as exc:
            warn(f"cc_overseers {task.get('id')}: {exc!r}")


def task_card(task_id):
    """Everything the 'About this task' box needs, or None."""
    try:
        res = (
            supabase.table("tasks")
            .select("id, title, description, status, priority, due_date, assigned_to, created_by, project_id, progress_percent, review_status, is_list")
            .eq("id", task_id)
            .limit(1)
            .execute()
        )
        t = (res.data or [None])[0]
        if not t:
            return None
        subs = (
            supabase.table("subtasks").select("title, done, due_date, position").eq("task_id", task_id).order("position").execute().data
            or []
        )
    except Exception as exc:
        warn(f"task_card {task_id}: {exc!r}")
        return None
    return {**t, "items": subs}


def _card_rows(card):
    finished = card.get("status") in FINISHED
    rows = [
        ("To-do list" if card.get("is_list") else "Task", card.get("title") or ""),
        ("What it's about", (card.get("description") or "").strip() or "No description was given."),
        ("Assigned to", person_name(card.get("assigned_to")) or "Nobody yet"),
        ("Given by", (person_name(card.get("created_by")) or "Someone")
         + (" (set this task for themselves)" if card.get("created_by") and card.get("created_by") == card.get("assigned_to") else "")),
    ]
    proj = project_name(card.get("project_id"))
    if proj:
        rows.append(("Project", proj))
    if card.get("priority"):
        rows.append(("Priority", PRIORITY_WORDS.get(card["priority"], card["priority"])))
    rows.append(("Deadline", when_text(parse(card.get("due_date")), finished)))
    stand = STATUS_WORDS.get(card.get("status"), card.get("status") or "")
    if card.get("review_status") == "sent_back" and not finished:
        stand += " (sent back for changes)"
    rows.append(("Where it stands", stand))
    items = card.get("items") or []
    if items:
        done = sum(1 for i in items if i.get("done"))
        rows.append(("Progress", f"{done} of {len(items)} items done"))
    elif card.get("progress_percent") is not None:
        rows.append(("Progress", f"{card['progress_percent']}%"))
    return rows


def why_you(card, uid) -> str:
    if not card:
        return "You're getting this because you use BusyBee."
    if card.get("assigned_to") == uid:
        return "You're getting this because this task is assigned to you."
    if card.get("created_by") == uid:
        return f"You're getting this because you gave this task to {person_name(card.get('assigned_to')) or 'someone'}."
    return (f"You're getting this to keep you in the loop as a supervisor on BusyBee. "
            f"{person_name(card.get('created_by')) or 'Someone'} gave this task to {person_name(card.get('assigned_to')) or 'someone'}.")


def render_email(greeting=None, headline="", paragraphs=(), card=None, sections=(), cta=None, why="", settings=True):
    """Returns (text, html). sections: list of (heading, [lines], numbered)."""
    green = "#2f8f3a"
    rows = _card_rows(card) if card else []
    items = (card or {}).get("items") or []

    def item_line(i):
        d = parse(i.get("due_date"))
        return f"{'[done] ' if i.get('done') else ''}{i.get('title')}" + (f" - by {when_text(d, True)}" if d else "")

    t = []
    if greeting:
        t += [greeting, ""]
    t.append(headline)
    for p in paragraphs:
        t += ["", p]
    if card:
        t += ["", "ABOUT THIS TASK"] + [f"{k}: {v}" for k, v in rows]
        if items:
            t += ["", "Items:"] + [f"  {n}. {item_line(i)}" for n, i in enumerate(items, 1)]
    for heading, lines, numbered in sections:
        t += ["", heading.upper()]
        t += [f"  {n}. {l}" if numbered else f"  - {l}" for n, l in enumerate(lines, 1)]
    if cta:
        t += ["", f"{cta[1]}: {cta[0]}"]
    t += ["", "--", why or "You're getting this because you use BusyBee."]
    if settings and APP_URL:
        t.append(f"Choose which emails you get: {APP_URL}/settings")
    text = "\n".join(t)

    e = _html
    h = [
        f'<div style="background:#f4f6f4;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;color:#1d2a1f">',
        '<div style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #dfe5df;border-radius:8px;overflow:hidden">',
        f'<div style="background:{green};color:#ffffff;padding:12px 20px;font-size:15px;font-weight:bold">&#128029; BusyBee</div>',
        '<div style="padding:20px">',
    ]
    if greeting:
        h.append(f'<p style="margin:0 0 12px;font-size:15px">{e(greeting)}</p>')
    h.append(f'<p style="margin:0 0 12px;font-size:17px;font-weight:bold;line-height:1.4">{e(headline)}</p>')
    for p in paragraphs:
        h.append(f'<p style="margin:0 0 12px;font-size:15px;line-height:1.5">{e(p)}</p>')
    if card:
        h.append('<div style="margin:16px 0;border:1px solid #dfe5df;border-radius:6px">')
        h.append(f'<div style="background:#eef5ee;padding:8px 14px;font-size:12px;font-weight:bold;letter-spacing:.06em;color:{green}">ABOUT THIS TASK</div>')
        h.append('<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:14px">')
        for k, v in rows:
            # Label above value: reads well on a phone.
            h.append(
                f'<tr><td style="padding:8px 14px;border-top:1px solid #eef1ee">'
                f'<div style="font-size:12px;color:#5b6b5e;margin-bottom:2px">{e(k)}</div>'
                f'<div style="font-size:15px;line-height:1.45">{e(v)}</div></td></tr>'
            )
        h.append("</table>")
        if items:
            h.append('<div style="padding:4px 14px 12px"><div style="font-size:13px;color:#5b6b5e;margin:6px 0">Items</div>'
                     '<ol style="margin:0;padding-left:22px;font-size:14px;line-height:1.6">')
            for i in items:
                style = "color:#8a978c;text-decoration:line-through" if i.get("done") else ""
                d = parse(i.get("due_date"))
                tail = f' <span style="color:#8a978c">- by {e(when_text(d, True))}</span>' if d else ""
                h.append(f'<li style="{style}">{e(i.get("title"))}{tail}</li>')
            h.append("</ol></div>")
        h.append("</div>")
    for heading, lines, numbered in sections:
        tag = "ol" if numbered else "ul"
        h.append(f'<div style="margin:18px 0 6px;font-size:12px;font-weight:bold;letter-spacing:.06em;color:{green}">{e(heading.upper())}</div>')
        h.append(f'<{tag} style="margin:0;padding-left:22px;font-size:14px;line-height:1.6">')
        h += [f"<li>{e(l)}</li>" for l in lines]
        h.append(f"</{tag}>")
    if cta:
        h.append(
            f'<p style="margin:20px 0 4px"><a href="{e(cta[0])}" style="background:{green};color:#ffffff;text-decoration:none;'
            f'padding:10px 18px;border-radius:6px;font-size:14px;font-weight:bold;display:inline-block">{e(cta[1])}</a></p>'
        )
    foot = e(why or "You're getting this because you use BusyBee.")
    if settings and APP_URL:
        foot += f' <a href="{e(APP_URL)}/settings" style="color:#7a887c">Choose which emails you get</a>.'
    h.append(f'</div><div style="border-top:1px solid #dfe5df;padding:12px 20px;font-size:12px;color:#7a887c;line-height:1.5">{foot}</div></div></div>')
    return text, "".join(h)



def notify(user_id: str, task_id, ntype: str, title: str, message: str, subject: str = "",
           email: tuple = None, telegram_text: str = "", overseer: bool = False) -> bool:
    """In-app notification, then the same by email. No email if the in-app one
    couldn't be saved: the saved row is what stops it being sent again.

    Checklist #48: skipped per-channel when this person has muted ntype's
    category (or, for email, turned email off entirely)."""
    wrote = False
    if _wants(user_id, ntype, "in_app"):
        try:
            supabase.table("notifications").insert(
                {"user_id": user_id, "task_id": task_id, "type": ntype, "title": title, "message": message, "read": False}
            ).execute()
            wrote = True
        except Exception as exc:
            warn(f"could not write notification for {user_id}: {exc!r}")
            return False
    if _wants(user_id, ntype, "email"):
        try:
            if email:
                text, html = email
            else:
                # Any task alert carries the task itself, so it makes sense
                # to someone who has never opened BusyBee.
                card = task_card(task_id) if task_id else None
                text, html = render_email(
                    greeting=f"Hi {first_name(user_id)}," if first_name(user_id) else None,
                    headline=message,
                    card=card,
                    cta=(f"{APP_URL}/dashboard" + (f"?task={task_id}" if task_id else ""),
                         "Open the task in BusyBee" if task_id else "Open BusyBee") if APP_URL else None,
                    why=("You're getting this because you oversee all work on BusyBee, so you're told about "
                         "everything that happens on every task.") if overseer else why_you(card, user_id),
                )
            send_mail(user_id, subject or title, text, html)
        except Exception as exc:
            warn(f"email to {user_id} failed to build: {exc!r}")
    if _wants(user_id, ntype, "telegram"):
        send_telegram(user_id, ntype, title, telegram_text or message, task_id)
    if not wrote:
        mark_sent(task_id, ntype)
    return wrote


def hours_text(h: float) -> str:
    if h < 1:
        return f"{max(1, round(h * 60))} minutes"
    return f"{round(h)} hour{'' if round(h) == 1 else 's'}"


def heartbeat() -> None:
    """Lets the System check on the Teams page see this scheduler is running."""
    try:
        supabase.table("bb_meta").upsert(
            {"key": "scheduler", "value": f"scheduler {VERSION}", "updated_at": now_utc().isoformat()},
            on_conflict="key",
        ).execute()
    except Exception as exc:
        warn(f"heartbeat failed (run the round-2 migration?): {exc!r}")


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------

def deadline_reminders() -> None:
    """#9: warn assignee and assignors at 24, 8 and 6 hours out; #43: flag overdue work once."""
    now = now_utc()
    tasks = [t for t in open_tasks() if t.get("due_date")]
    if not tasks:
        return
    units, extras, desks = Units(), extra_assignors(), Desks()
    sent = 0

    for task in tasks:
        try:
            due = parse(task["due_date"])
            if not due:
                continue
            hours_left = (due - now).total_seconds() / 3600
            recipients = people_for(task, units, extras, desks)
            if not recipients:
                continue

            if hours_left <= 0:
                if now - due > OVERDUE_ALERT_WINDOW:
                    continue
                # Once per deadline: a new deadline (extension) can be overdue again.
                if already_sent(task["id"], "overdue", due):
                    continue
                # The overseer hears about it the moment work goes overdue.
                for o in desks.overseers.get(task.get("desk_id"), set()) - recipients:
                    giver = person_name(task.get("created_by")) or "Someone"
                    notify(o, task["id"], "overdue", f"Overdue: {task['title']}",
                           f"{whose(task, o)[0].upper()}{whose(task, o)[1:]}, given by {giver}, went past its deadline "
                           f"({when_text(due, True)}) without being finished.",
                           subject=f"Overdue: {task['title']} ({person_name(task.get('assigned_to')) or 'unassigned'})",
                           overseer=True)
                for r in recipients:
                    msg = f"{whose(task, r)[0].upper()}{whose(task, r)[1:]} was due {when_text(due, True)} and isn't finished yet."
                    if r == task.get("assigned_to"):
                        msg += " Finish it, or open the task and ask for more time."
                    notify(r, task["id"], "overdue", "Overdue", msg,
                           subject=f"Overdue: {task['title']} ({person_name(task.get('assigned_to')) or 'unassigned'})")
                sent += 1
                continue

            # The nearest threshold we are inside. If the scheduler was down and
            # missed an earlier one, only the most relevant reminder goes out.
            threshold = next((t for t in THRESHOLDS if hours_left <= t), None)
            if threshold is None:
                continue
            # Keyed to the exact due timestamp (not just "due - N hours") so
            # that editing a deadline earlier is always treated as a fresh
            # deadline for reminder purposes, matching the overdue marker's
            # semantics above instead of a relative window that could
            # retroactively swallow the new reminder.
            marker = f"reminder_{threshold}h_{due.isoformat()}"
            if already_sent(task["id"], marker, due - timedelta(hours=threshold + 1)):
                continue
            title = f"Due in {threshold} hours" if hours_left > threshold - 0.5 else f"Due in {hours_text(hours_left)}"
            for r in recipients:
                msg = f"{whose(task, r)[0].upper()}{whose(task, r)[1:]} is due {when_text(due)}."
                notify(r, task["id"], marker, title, msg,
                       subject=f"{title}: {task['title']} ({person_name(task.get('assigned_to')) or 'unassigned'})")
            who = person_name(task.get("assigned_to")) or "Nobody"
            cc_overseers(task, desks, recipients, marker, title,
                         f'{who}\'s task "{task["title"]}", given by {person_name(task.get("created_by")) or "someone"}, '
                         f"is due {when_text(due)}. Right now it is: {STATUS_WORDS.get(task.get('status'), 'open').lower()}.",
                         f"{title}: {task['title']} ({who})")
            sent += 1
        except Exception as exc:
            warn(f"deadline_reminders: skipping task {task.get('id')}: {exc!r}")
            continue

    if sent:
        log(f"deadline reminders: {sent} task(s)")


def daily_countdown() -> None:
    """Step 6 of the assignment flow: one reminder a day, every day, from the
    moment work is assigned until its deadline passes.

    This is deliberately separate from deadline_reminders() above, which fires
    at 24/8/6 hours out. Those are the last-minute warnings; this is the steady
    drumbeat that stops a three-week deadline being remembered in week three.

    Once the deadline has gone, the same daily note keeps going out and the
    assignors are copied in - an overdue task that nobody is told about again
    after the first alert is an overdue task everybody forgets.
    """
    now = now_utc()
    today = now.astimezone(LOCAL_TZ).date().isoformat()
    tasks = [t for t in open_tasks() if t.get("due_date")]
    if not tasks:
        return
    units, extras, desks = Units(), extra_assignors(), Desks()
    sent = 0

    for task in tasks:
        try:
            # Private to-dos have their own "remind me at"; they answer to nobody.
            if task.get("personal"):
                continue
            due = parse(task["due_date"])
            if not due:
                continue
            if now - due > timedelta(days=OVERDUE_DAILY_DAYS):
                continue

            # One per task per day, whatever happens to the process in between.
            marker = f"reminder_daily_{today}"
            if already_sent(task["id"], marker, now - timedelta(hours=20)):
                continue

            hours_left = (due - now).total_seconds() / 3600
            # Inside the last day the 24/8/6-hour reminders are already doing
            # this job, and better. Don't say it twice.
            if 0 < hours_left <= 24:
                continue

            people = doers(task, units)
            if hours_left <= 0:
                days_over = max(1, int((now - due).total_seconds() // 86400))
                title = f"Overdue by {days_over} day{'' if days_over == 1 else 's'}"
                body = None
                # Escalation: whoever assigned it hears about it too.
                people = people | assignors(task, extras)
            else:
                days_left = max(1, int(hours_left // 24))
                title = f"{days_left} day{'' if days_left == 1 else 's'} left"
                body = ""

            recipients = desks.only_on_desk(task.get("desk_id"), people)
            if not recipients:
                continue
            for r in recipients:
                lead = whose(task, r)
                lead = lead[0].upper() + lead[1:]
                if body is None:
                    msg = f"{lead} was due {when_text(due, True)} and is still open."
                    msg += (" Finish it, or open the task and ask for more time." if r == task.get("assigned_to")
                            else " You're copied in because you gave this task.")
                else:
                    msg = f"{lead} is due {when_text(due)}. This is the daily reminder until it's done."
                notify(r, task["id"], marker, title, msg,
                       subject=f"{title}: {task['title']} ({person_name(task.get('assigned_to')) or 'unassigned'})")
            who = person_name(task.get("assigned_to")) or "Nobody"
            giver = person_name(task.get("created_by")) or "someone"
            cc_overseers(
                task, desks, recipients, marker, title,
                (f'{who}\'s task "{task["title"]}", given by {giver}, was due {when_text(due, True)} and is still not finished.'
                 if body is None else
                 f'{who}\'s task "{task["title"]}", given by {giver}, is due {when_text(due)}. This is the daily reminder until it is done.'),
                f"{title}: {task['title']} ({who})",
            )
            sent += 1
        except Exception as exc:
            warn(f"daily_countdown: skipping task {task.get('id')}: {exc!r}")
            continue

    if sent:
        log(f"daily countdown: {sent} task(s)")


def review_reminders() -> None:
    """Step 9: nudge supervisors about work that is finished and waiting to be
    signed off, so a review queue never quietly becomes a backlog.

    Sent once a day, to the people who can actually decide (the assignors), and
    only for tasks that have been sitting unreviewed since yesterday - work
    finished an hour ago does not need chasing.
    """
    now = now_utc()
    today = now.astimezone(LOCAL_TZ).date().isoformat()
    try:
        rows = fetch_all(
            lambda: supabase.table("tasks")
            .select(TASK_COLUMNS + ", review_status, project_id")
            .eq("status", "done")
            .eq("review_status", "pending")
            .is_("archived_at", "null")
            .order("id")
        )
    except Exception as exc:
        # The migration adding review_status has not been run yet.
        warn(f"review_reminders: skipped ({exc!r})")
        return

    extras, desks, units = extra_assignors(), Desks(), Units()
    # Project managers can review too.
    try:
        managers = {
            p["id"]: p.get("manager_id")
            for p in fetch_all(lambda: supabase.table("projects").select("id, manager_id").order("id"))
        }
    except Exception:
        managers = {}
    sent = 0
    for task in rows:
        try:
            if task.get("personal"):
                continue
            finished = parse(task.get("updated_at")) or parse(task.get("created_at"))
            if finished and now - finished < timedelta(hours=18):
                continue
            marker = f"review_pending_{today}"
            if already_sent(task["id"], marker, now - timedelta(hours=20)):
                continue
            # Everyone who can sign it off: its assignors, the project's manager
            # and the desk's supervisors - minus anyone who did the work, since
            # they can't review it.
            deciders = assignors(task, extras)
            if managers.get(task.get("project_id")):
                deciders.add(managers[task["project_id"]])
            # Plus the desk's overseer (or, with none, its supervisors) - not
            # every supervisor on the desk.
            deciders |= desks.overseers.get(task.get("desk_id")) or {
                uid for uid, p in desks.people.items() if task.get("desk_id") in p["leads"]
            }
            workers = {task.get("assigned_to")} | units.members(task)
            recipients = desks.only_on_desk(task.get("desk_id"), deciders - workers)
            if not recipients:
                continue
            for r in recipients:
                notify(
                    r,
                    task["id"],
                    marker,
                    "Waiting for your review",
                    f"{person_name(task.get('assigned_to')) or 'Someone'} finished \"{task['title']}\" and it is waiting for "
                    "you to review it. Check the work however suits you (a call, a demo, a quick look), then open the task "
                    "and press Approve or Send back.",
                    subject=f"Waiting for your review: {task['title']} ({person_name(task.get('assigned_to')) or 'unassigned'})",
                )
            sent += 1
        except Exception as exc:
            warn(f"review_reminders: skipping task {task.get('id')}: {exc!r}")
            continue

    if sent:
        log(f"review reminders: {sent} task(s)")


def checklist_reminders() -> None:
    """#6: a checklist item due within a day reminds whoever is doing it, once per deadline."""
    now = now_utc()
    try:
        items = fetch_all(
            lambda: supabase.table("subtasks")
            .select("id, task_id, title, due_date, done, assigned_to, reminder_sent_for")
            .eq("done", False)
            .gte("due_date", (now - timedelta(hours=1)).isoformat())
            .lte("due_date", (now + timedelta(hours=24)).isoformat())
            .order("id")
        )
    except Exception as exc:
        warn(f"could not read checklist deadlines (run the round-2 migration?): {exc!r}")
        return
    items = [i for i in items if parse(i.get("due_date")) and parse(i.get("reminder_sent_for")) != parse(i.get("due_date"))]
    if not items:
        return
    parents = {t["id"]: t for t in open_tasks()}
    units, desks = Units(), Desks()
    sent = 0
    for item in items:
        try:
            task = parents.get(item["task_id"])
            if not task:  # finished or archived work isn't chased
                continue
            due = parse(item["due_date"])
            if task.get("personal"):
                who = {owner_of(task)}
            elif item.get("assigned_to"):
                who = {item["assigned_to"]}
            else:
                who = doers(task, units)
            got = desks.only_on_desk(task.get("desk_id"), who)
            for r in got:
                notify(r, task["id"], "checklist_due", "Checklist item due",
                       f"The item \"{item['title']}\" on {whose(task, r)} is due {when_text(due)}.",
                       subject=f"Checklist item due: {item['title']}")
            cc_overseers(task, desks, got, "checklist_due", "Checklist item due",
                         f"The item \"{item['title']}\" on {whose(task, None)} is due {when_text(due)}.",
                         f"Item due: {item['title']} ({person_name(task.get('assigned_to')) or 'unassigned'})")
            try:
                supabase.table("subtasks").update({"reminder_sent_for": item["due_date"]}).eq("id", item["id"]).execute()
            except Exception as exc:
                warn(f"could not mark checklist reminder for {item['id']}: {exc!r}")
            sent += 1
        except Exception as exc:
            warn(f"checklist_reminders: skipping item {item.get('id')}: {exc!r}")
            continue
    if sent:
        log(f"checklist reminders: {sent} item(s)")


def personal_reminders() -> None:
    """#2: the "remind me at" times people set on tasks and to-do items (each
    person has their own, in task_reminders)."""
    heartbeat()
    now = now_utc()
    try:
        due_rows = fetch_all(
            lambda: supabase.table("task_reminders")
            .select("id, task_id, user_id, remind_at, sent_at")
            .lte("remind_at", now.isoformat())
            .order("id")
        )
    except Exception as exc:
        warn(f"task_reminders unavailable ({exc!r}); using the reminder on the task itself")
        _task_row_reminders(now)
        return

    pending = [r for r in due_rows if parse(r.get("remind_at")) and not (parse(r.get("sent_at")) and parse(r["sent_at"]) >= parse(r["remind_at"]))]
    if not pending:
        return
    tasks = {}
    for part in [pending[i:i + 100] for i in range(0, len(pending), 100)]:
        ids = list({r["task_id"] for r in part})
        res = supabase.table("tasks").select("id, desk_id, title, due_date, status, archived_at").in_("id", ids).execute()
        for t in res.data or []:
            tasks[t["id"]] = t
    desks = Desks()

    for r in pending:
        try:
            task = tasks.get(r["task_id"])
            at = parse(r["remind_at"])
            if (task and now - at <= STALE_REMINDER and task.get("status") not in FINISHED and not task.get("archived_at")
                    and desks.only_on_desk(task.get("desk_id"), {r["user_id"]})):
                due = parse(task.get("due_date"))
                notify(r["user_id"], task["id"], "reminder", "Reminder", f"{task['title']}" + (f" (due {local(due)})" if due else ""),
                       subject=f"Reminder: {task['title']}")
            # Mark it handled either way so it doesn't fire again.
            try:
                supabase.table("task_reminders").update({"sent_at": now.isoformat()}).eq("id", r["id"]).execute()
            except Exception as exc:
                warn(f"could not mark reminder {r['id']} sent: {exc!r}")
        except Exception as exc:
            warn(f"personal_reminders: skipping reminder {r.get('id')}: {exc!r}")
            continue


def _task_row_reminders(now: datetime) -> None:
    """Before the round-2 migration: one reminder per task, on the task row."""
    try:
        rows = fetch_all(
            lambda: supabase.table("tasks")
            .select("id, desk_id, title, due_date, status, remind_at, remind_to, reminder_sent_at, assigned_to, created_by, archived_at, personal")
            .lte("remind_at", now.isoformat())
            .order("id")
        )
    except Exception as exc:
        warn(f"could not read reminders: {exc!r}")
        return

    pending = []
    for task in rows:
        at, last = parse(task.get("remind_at")), parse(task.get("reminder_sent_at"))
        if at and not (last and last >= at):
            pending.append((task, at))
    if not pending:
        return
    desks = Desks()

    for task, at in pending:
        fresh = now - at <= STALE_REMINDER
        if fresh and task.get("status") not in FINISHED and not task.get("archived_at"):
            who = task.get("remind_to") or owner_of(task)
            if who and desks.only_on_desk(task.get("desk_id"), {who}):
                due = parse(task.get("due_date"))
                notify(who, task["id"], "reminder", "Reminder", f"{task['title']}" + (f" (due {local(due)})" if due else ""),
                       subject=f"Reminder: {task['title']}")
        # Mark it handled either way so it doesn't fire again.
        try:
            supabase.table("tasks").update({"reminder_sent_at": now.isoformat()}).eq("id", task["id"]).execute()
        except Exception as exc:
            warn(f"could not mark reminder sent for {task['id']}: {exc!r}")


def recurring_update_requests() -> None:
    """SOW #24: ask for a progress update when open work has gone quiet."""
    if UPDATE_REQUEST_DAYS <= 0:
        return
    now = now_utc()
    cutoff = now - timedelta(days=UPDATE_REQUEST_DAYS)
    tasks = [t for t in open_tasks() if not t.get("personal")]
    if not tasks:
        return
    units, desks = Units(), Desks()

    # Work counts as moving if anything happened on it recently - a comment,
    # a ticked checklist item, a file - not only a change to the task itself.
    try:
        recent = fetch_all(
            lambda: supabase.table("activity_log")
            .select("entity_id")
            .eq("entity_type", "task")
            .gte("created_at", cutoff.isoformat())
            .order("created_at")
        )
        moving = {r["entity_id"] for r in recent}
    except Exception as exc:
        warn(f"could not read recent history: {exc!r}")
        moving = set()

    asked = 0
    for task in tasks:
        try:
            last = parse(task.get("updated_at") or task.get("created_at"))
            # Only chase work that has gone quiet for the whole interval...
            if not last or last > cutoff or task["id"] in moving:
                continue
            # ...and only once per interval. The job runs at midnight, so allow
            # half a day of slack or the next request slips a day each time.
            if already_sent(task["id"], "update_request", cutoff + timedelta(hours=12)):
                continue
            targets = desks.only_on_desk(task.get("desk_id"), doers(task, units))
            for r in targets:
                notify(r, task["id"], "update_request", "Update requested",
                       f"Nothing has changed on {whose(task, r)} for {UPDATE_REQUEST_DAYS} days. How is it going? "
                       "Open the task to update its progress, tick off items, or leave a comment.",
                       subject=f"Update requested: {task['title']}")
            if targets:
                cc_overseers(task, desks, targets, "update_request", "No movement",
                             f"Nothing has changed on {whose(task, None)} for {UPDATE_REQUEST_DAYS} days. "
                             f"{person_name(task.get('assigned_to')) or 'The assignee'} has been asked how it is going.",
                             f"No movement for {UPDATE_REQUEST_DAYS} days: {task['title']} ({person_name(task.get('assigned_to')) or 'unassigned'})")
                asked += 1
        except Exception as exc:
            warn(f"recurring_update_requests: skipping task {task.get('id')}: {exc!r}")
            continue
    log(f"checked for quiet tasks: {asked} update request(s)")


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def _collect():
    """Every task that counts towards the daily summaries, with who it's for.

    That is everything still open, plus finished work that hasn't been
    archived, plus anything finished since yesterday (even if archived).
    Private to-dos are left out: nobody assigned them.

    Returns (per_user, per_desk, desks): lists of entries, each entry a dict
    with the task and its bucket ("today", "yesterday", "earlier", "to_go").
    """
    now = now_utc()
    today = now.astimezone(LOCAL_TZ).date()
    yesterday = today - timedelta(days=1)
    since = datetime(yesterday.year, yesterday.month, yesterday.day, tzinfo=LOCAL_TZ).astimezone(timezone.utc)
    since_text = since.strftime("%Y-%m-%dT%H:%M:%SZ")
    cols = TASK_COLUMNS + ", completed_at, project_id, review_status"
    live = fetch_all(lambda: supabase.table("tasks").select(cols).is_("archived_at", "null").order("id"))
    recent = fetch_all(
        lambda: supabase.table("tasks").select(cols).not_.is_("archived_at", "null").gte("completed_at", since_text).order("id")
    )
    rows = list({t["id"]: t for t in live + recent}.values())
    units, desks = Units(), Desks()

    per_user, per_desk = {}, {}
    for task in rows:
        try:
            if task.get("personal"):
                continue
            people = desks.only_on_desk(task.get("desk_id"), doers(task, units))
            if not people:
                continue
            finished = task.get("status") in FINISHED
            if not finished and task.get("archived_at"):
                continue
            due = parse(task.get("due_date"))
            if finished:
                done_at = parse(task.get("completed_at"))
                day = done_at.astimezone(LOCAL_TZ).date() if done_at else None
                bucket = "today" if day == today else "yesterday" if day == yesterday else "earlier"
            else:
                bucket = "to_go"
            entry = {
                "task": task,
                "bucket": bucket,
                "due": due,
                "late": (not finished) and bool(due and due < now),
                "due_today": (not finished) and bool(due and due >= now and due.astimezone(LOCAL_TZ).date() == today),
                "review": task.get("status") == "done" and task.get("review_status") == "pending",
                "people": people,
            }
            for u in people:
                per_user.setdefault(u, []).append(entry)
            per_desk.setdefault(task.get("desk_id"), []).append(entry)
        except Exception as exc:
            warn(f"_collect: skipping task {task.get('id')}: {exc!r}")
    return per_user, per_desk, desks


def _by_due(entries):
    far = datetime.max.replace(tzinfo=timezone.utc)
    return sorted(entries, key=lambda e: e["due"] or far)


def _task_line(e, with_person=False, done_word=None) -> str:
    t = e["task"]
    parts = [f'"{t.get("title")}"']
    if with_person:
        parts.append(", ".join(person_name(p) for p in sorted(e["people"])) or "unassigned")
    if done_word:
        parts.append(done_word)
    else:
        parts.append(f"due {when_text(e['due'])}" if e["due"] else "no deadline")
    proj = project_name(t.get("project_id"))
    if proj:
        parts.append(f"project: {proj}")
    if not with_person and t.get("created_by"):
        parts.append(f"given by {person_name(t.get('created_by'))}")
    return " - ".join(parts)


def _team(info, per_desk):
    """Everything on the desks this person oversees, and who is on them."""
    entries, seen = [], set()
    for d in info["heads"]:
        for e in per_desk.get(d, []):
            if e["task"]["id"] not in seen:
                seen.add(e["task"]["id"])
                entries.append(e)
    return entries


def _team_people(info, desks, me):
    ids = set()
    for d in info["heads"]:
        ids |= desks.members.get(d, set())
    ids.discard(me)
    return sorted(ids, key=lambda u: person_name(u).lower())


def _send_summary(uid, ntype, title, subject, headline, paragraphs, sections):
    text, html = render_email(
        greeting=f"Hi {first_name(uid)}," if first_name(uid) else None,
        headline=headline,
        paragraphs=paragraphs,
        sections=sections,
        cta=(f"{APP_URL}/dashboard", "Open BusyBee") if APP_URL else None,
        why="You're getting this daily summary because you're on BusyBee.",
    )
    # Telegram gets the same words, without the email's footer.
    tg = text.split("\n--\n")[0]
    notify(uid, None, ntype, title, headline, subject=subject, email=(text, html), telegram_text=tg)


def start_of_day() -> None:
    """9 AM: what each person has to do today, and for supervisors, where the team stands."""
    per_user, per_desk, desks = _collect()
    count = 0
    for uid, info in desks.people.items():
        try:
            mine = per_user.get(uid, [])
            open_ = _by_due([e for e in mine if e["bucket"] == "to_go"])
            yday = [e for e in mine if e["bucket"] == "yesterday"]
            late = [e for e in open_ if e["late"]]
            today = [e for e in open_ if e["due_today"]]
            sections, paragraphs = [], []

            if open_:
                extra = []
                if late:
                    extra.append(f"{len(late)} overdue")
                if today:
                    extra.append(f"{len(today)} due today")
                headline = f"Good morning. You have {_plural(len(open_), 'task')} to finish" + (f" ({', '.join(extra)})." if extra else ".")
                sections.append(("Your tasks, soonest first", [_task_line(e) for e in open_], True))
            elif mine:
                headline = "Good morning. Everything assigned to you is done."
            elif info["heads"]:
                headline = "Good morning. Here is where your team stands today."
            else:
                headline = "Good morning. Nothing is assigned to you right now."
            if yday:
                sections.append(("You finished yesterday", [_task_line(e, done_word="finished") for e in yday], True))

            if info["heads"]:
                team = _team(info, per_desk)
                people = _team_people(info, desks, uid)
                t_open = [e for e in team if e["bucket"] == "to_go"]
                t_late = _by_due([e for e in t_open if e["late"]])
                t_yday = [e for e in team if e["bucket"] == "yesterday"]
                t_review = [e for e in team if e["review"]]
                if people:
                    paragraphs.append(
                        f"Your team is {len(people)} {'person' if len(people) == 1 else 'people'}: {', '.join(person_name(p) for p in people)}. "
                        f"Between them they have {_plural(len(t_open), 'open task')}"
                        + (f", {len(t_late)} of them overdue" if t_late else "")
                        + f", and {_plural(len(t_yday), 'task')} were finished yesterday."
                    )
                    lines = []
                    for p in people:
                        pe = per_user.get(p, [])
                        po = [e for e in pe if e["bucket"] == "to_go"]
                        pl = [e for e in po if e["late"]]
                        py = [e for e in pe if e["bucket"] == "yesterday"]
                        if not pe:
                            lines.append(f"{person_name(p)}: nothing assigned")
                            continue
                        lines.append(
                            f"{person_name(p)}: {len(po)} open" + (f" ({len(pl)} overdue)" if pl else "")
                            + f", {len(py)} finished yesterday"
                        )
                    sections.append(("Your team at a glance", lines, False))
                if t_review:
                    sections.append(("Finished and waiting for your review", [_task_line(e, with_person=True, done_word="finished") for e in t_review], True))
                if t_late:
                    sections.append(("Overdue across the team", [_task_line(e, with_person=True) for e in t_late], True))

            if not mine and not info["heads"]:
                continue
            _send_summary(uid, "bod_summary", "Your day", "BusyBee: your day", headline, paragraphs, sections)
            count += 1
        except Exception as exc:
            warn(f"start_of_day: skipping {uid}: {exc!r}")
    log(f"sent start-of-day summaries to {count}")


def end_of_day() -> None:
    """6 PM: how the day went - what was finished, what's left - per person and per team."""
    per_user, per_desk, desks = _collect()
    count = 0
    for uid, info in desks.people.items():
        try:
            mine = per_user.get(uid, [])
            done_today = [e for e in mine if e["bucket"] == "today"]
            yday = [e for e in mine if e["bucket"] == "yesterday"]
            open_ = _by_due([e for e in mine if e["bucket"] == "to_go"])
            late = [e for e in open_ if e["late"]]
            sections, paragraphs = [], []

            if mine:
                headline = (
                    f"End of day: you finished {_plural(len(done_today), 'task')} today"
                    + (f" (and {len(yday)} yesterday)" if yday else "")
                    + (f". {len(open_)} still to go" + (f", {len(late)} overdue." if late else ".") if open_ else ". Nothing left to do. 🎉")
                )
                paragraphs.append(
                    f"Out of {_plural(len(mine), 'task')} on your plate: {len(done_today)} done today, {len(yday)} done yesterday, "
                    f"{len([e for e in mine if e['bucket'] == 'earlier'])} done before that, and {len(open_)} to go."
                )
                if done_today:
                    sections.append(("Finished today", [_task_line(e, done_word="finished") for e in done_today], True))
                if open_:
                    sections.append(("Still to do, soonest first", [_task_line(e) for e in open_], True))
            elif info["heads"]:
                headline = "End of day: here is how your team did today."
            else:
                headline = "End of day: nothing was assigned to you today."

            if info["heads"]:
                team = _team(info, per_desk)
                people = _team_people(info, desks, uid)
                t_today = [e for e in team if e["bucket"] == "today"]
                t_open = [e for e in team if e["bucket"] == "to_go"]
                t_late = _by_due([e for e in t_open if e["late"]])
                if people:
                    paragraphs.append(
                        f"Your team ({', '.join(person_name(p) for p in people)}) finished {_plural(len(t_today), 'task')} today "
                        f"and has {len(t_open)} still open" + (f", {len(t_late)} of them overdue." if t_late else ".")
                    )
                    lines = []
                    for p in people:
                        pe = per_user.get(p, [])
                        pt = [e for e in pe if e["bucket"] == "today"]
                        po = [e for e in pe if e["bucket"] == "to_go"]
                        pl = [e for e in po if e["late"]]
                        if not pe:
                            lines.append(f"{person_name(p)}: nothing assigned")
                            continue
                        lines.append(f"{person_name(p)}: {len(pt)} finished today, {len(po)} to go" + (f" ({len(pl)} overdue)" if pl else ""))
                    sections.append(("Your team at a glance", lines, False))
                if t_today:
                    sections.append(("Finished today across the team", [_task_line(e, with_person=True, done_word="finished") for e in t_today], True))
                if t_late:
                    sections.append(("Overdue across the team", [_task_line(e, with_person=True) for e in t_late], True))

            if not mine and not info["heads"]:
                continue
            subject = (
                f"BusyBee: end of day - you finished {len(done_today)}, {len(open_)} to go" if mine else "BusyBee: end of day - your team"
            )
            _send_summary(uid, "eod_summary", "End of day", subject, headline, paragraphs, sections)
            count += 1
        except Exception as exc:
            warn(f"end_of_day: skipping {uid}: {exc!r}")
    log(f"sent end-of-day summaries to {count}")


def auto_archive() -> None:
    """#12: completed tasks go to the archive after AUTO_ARCHIVE_DAYS (they can be re-opened).

    Only tasks nobody has touched in that time: a finished task someone just
    restored from the archive stays out for another AUTO_ARCHIVE_DAYS."""
    if AUTO_ARCHIVE_DAYS <= 0:
        return
    cutoff = (now_utc() - timedelta(days=AUTO_ARCHIVE_DAYS)).isoformat()
    try:
        rows = fetch_all(
            lambda: supabase.table("tasks")
            .select("id, desk_id, updated_at")
            .in_("status", FINISHED)
            .is_("archived_at", "null")
            .lte("completed_at", cutoff)
            .order("id")
        )
    except Exception as exc:
        warn(f"could not read finished tasks: {exc!r}")
        return
    cutoff_at = parse(cutoff)
    rows = [t for t in rows if (parse(t.get("updated_at")) or cutoff_at) <= cutoff_at]
    stamp = now_utc().isoformat()
    archived = 0
    for task in rows:
        try:
            supabase.table("tasks").update({"archived_at": stamp}).eq("id", task["id"]).execute()
        except Exception as exc:
            warn(f"could not archive {task['id']}: {exc!r}")
            continue
        archived += 1
        try:
            supabase.table("activity_log").insert(
                {
                    "entity_type": "task",
                    "entity_id": task["id"],
                    "action": f"archived automatically ({AUTO_ARCHIVE_DAYS} days after completion)",
                    "desk_id": task.get("desk_id"),
                    "changes": {"archived_at": {"from": None, "to": stamp}},
                }
            ).execute()
        except Exception as exc:
            warn(f"archived {task['id']} but couldn't record it in the history: {exc!r}")
    if archived:
        log(f"archived {archived} completed task(s)")


if __name__ == "__main__":
    # Cron jobs run in the office's own timezone, so 9:00 means 9:00 IST. A job
    # whose moment was missed by a few minutes (a slow wake-up) still runs;
    # missed runs of the same job are merged into one.
    scheduler = BlockingScheduler(timezone=LOCAL_TZ, job_defaults={"misfire_grace_time": 3600, "coalesce": True})

    # Every minute: deadline and overdue alerts (each goes out once per
    # deadline, so checking often only makes them arrive sooner). Every 10
    # minutes: checklist reminders; every 5, "remind me at" (which also
    # records the heartbeat).
    scheduler.add_job(safe(deadline_reminders), "interval", minutes=1, id="deadline_reminders")
    scheduler.add_job(safe(checklist_reminders), "interval", minutes=10, id="checklist_reminders")
    scheduler.add_job(safe(personal_reminders), "interval", minutes=5, id="personal_reminders")

    # Once a day: the countdown to every live deadline, and the review queue.
    scheduler.add_job(safe(daily_countdown), "cron", hour=DAILY_REMINDER_HOUR, minute=5, id="daily_countdown")
    scheduler.add_job(safe(review_reminders), "cron", hour=DAILY_REMINDER_HOUR, minute=20, id="review_reminders")

    scheduler.add_job(safe(start_of_day), "cron", hour=BOD_HOUR, minute=0, id="bod")
    scheduler.add_job(safe(end_of_day), "cron", hour=EOD_HOUR, minute=0, id="eod")
    # Midnight local time: quiet-task nudges and archiving.
    scheduler.add_job(safe(recurring_update_requests), "cron", hour=0, minute=0, id="update_requests")
    scheduler.add_job(safe(auto_archive), "cron", hour=0, minute=15, id="auto_archive")

    log(
        f"scheduler {VERSION} up: deadline alerts every 1m, checklist every 10m, remind-me every 5m, "
        f"daily countdown + review queue at {DAILY_REMINDER_HOUR}:00, "
        f"BOD {BOD_HOUR}:00, EOD {EOD_HOUR}:00 (UTC{TZ_OFFSET_HOURS:+g}), "
        f"update requests every {UPDATE_REQUEST_DAYS or 'never'} days, "
        f"auto-archive after {AUTO_ARCHIVE_DAYS or 'never'} days, "
        f"email {'on' if mail_on() else 'off'}, "
        f"telegram {'on' if TELEGRAM_BOT_TOKEN else 'off'}"
    )

    # Run once at boot so a deploy does not wait for the first tick.
    safe(personal_reminders)()
    safe(deadline_reminders)()
    safe(checklist_reminders)()

    try:
        scheduler.start()
    except (KeyboardInterrupt, SystemExit):
        log("scheduler stopped")
