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
  RESEND_API_KEY        - optional, to send email as well
  MAIL_FROM             - optional, e.g. "BusyBee <busybee@yourdomain.com>"
                          (Resend's default test sender only delivers to the
                          Resend account's own address)
  APP_URL               - optional, e.g. https://busybee-xi.vercel.app, to put
                          a link to the task in emails
"""

import json as _json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

from apscheduler.schedulers.blocking import BlockingScheduler
from supabase import create_client

VERSION = "2026-09-22"


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
        rows = fetch_all(lambda: supabase.table("desk_members").select("desk_id, user_id, role").order("user_id"))
        self.members = {}   # desk_id -> {user ids}
        self.people = {}    # user_id -> {"desks": set, "leads": set}
        for r in rows:
            self.members.setdefault(r["desk_id"], set()).add(r["user_id"])
            p = self.people.setdefault(r["user_id"], {"desks": set(), "leads": set()})
            p["desks"].add(r["desk_id"])
            if normal_role(r.get("role")) in ("admin", "supervisor"):
                p["leads"].add(r["desk_id"])

    def only_on_desk(self, desk_id, ids) -> set:
        """Drop anyone no longer on the task's desk (they can't open it any more)."""
        on_desk = self.members.get(desk_id, set())
        return {x for x in ids if x and x in on_desk}


class Units:
    """Who belongs to which team, department and custom group."""

    def __init__(self):
        teams = fetch_all(lambda: supabase.table("teams").select("id, department_id, manager_id").order("id"))
        members = fetch_all(lambda: supabase.table("team_members").select("team_id, user_id").order("team_id"))
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
        return bool(res.data)
    except Exception as exc:
        warn(f"dedupe check failed for {task_id}: {exc!r}")
        # Fail closed so a database blip cannot cause a burst of duplicates.
        return True


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
    if t == "overdue" or t == "checklist_due" or t.startswith("reminder"):
        return "reminders"
    if t in ("bod_summary", "eod_summary", "update_request"):
        return "daily_summary"
    return "tasks"


def _prefs_for(user_id: str) -> dict:
    cached = _prefs.get(user_id)
    if cached and time.time() - cached[1] < 300:
        return cached[0]
    prefs = {"email_enabled": True, "categories": {}}
    try:
        res = supabase.table("notification_prefs").select("email_enabled, categories").eq("user_id", user_id).limit(1).execute()
        row = (res.data or [None])[0]
        if row:
            prefs["email_enabled"] = row.get("email_enabled") is not False
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
    cat = prefs["categories"].get(_category_of(ntype)) or {}
    return cat.get(channel) is not False


# SOW #30: email alongside the in-app notification, through Resend's REST API
# via the standard library. A no-op until RESEND_API_KEY is set.
MAIL_FROM = (os.environ.get("MAIL_FROM") or "").strip() or "BusyBee <onboarding@resend.dev>"
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


def send_mail(user_id: str, subject: str, body: str) -> bool:
    key = os.environ.get("RESEND_API_KEY")
    if not key:
        return False
    address = _email_for(user_id)
    if not address:
        return False
    payload = _json.dumps({"from": MAIL_FROM, "to": [address], "subject": subject, "text": body}).encode()
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


def notify(user_id: str, task_id, ntype: str, title: str, message: str, subject: str = "") -> bool:
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
        body = message
        if APP_URL:
            body += f"\n\nOpen BusyBee: {APP_URL}/dashboard" + (f"?task={task_id}" if task_id else "")
        send_mail(user_id, subject or title, body)
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
                for r in recipients:
                    notify(r, task["id"], "overdue", "Overdue", f"{task['title']} was due at {local(due)} and isn't finished",
                           subject=f"Overdue: {task['title']}")
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
                notify(r, task["id"], marker, title, f"{task['title']} is due at {local(due)}",
                       subject=f"{title}: {task['title']}")
            sent += 1
        except Exception as exc:
            warn(f"deadline_reminders: skipping task {task.get('id')}: {exc!r}")
            continue

    if sent:
        log(f"deadline reminders: {sent} task(s)")


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
            for r in desks.only_on_desk(task.get("desk_id"), who):
                notify(r, task["id"], "checklist_due", "Checklist item due",
                       f"\"{item['title']}\" on {task['title']} is due at {local(due)}",
                       subject=f"Checklist item due: {item['title']}")
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
                       f"No movement on {task['title']} for {UPDATE_REQUEST_DAYS} days. How is it going?",
                       subject=f"Update requested: {task['title']}")
            if targets:
                asked += 1
        except Exception as exc:
            warn(f"recurring_update_requests: skipping task {task.get('id')}: {exc!r}")
            continue
    log(f"checked for quiet tasks: {asked} update request(s)")


def _summaries():
    """(user_id, open, due_today, overdue, desk_overdue) for every user."""
    now = now_utc()
    today = now.astimezone(LOCAL_TZ).date()
    tasks = open_tasks()
    units = Units()
    desks = Desks()

    mine = {uid: [] for uid in desks.people}
    desk_overdue = {}
    for task in tasks:
        try:
            due = parse(task.get("due_date"))
            late = bool(due and due < now)
            if late and not task.get("personal"):
                desk_overdue[task["desk_id"]] = desk_overdue.get(task["desk_id"], 0) + 1
            owners = {owner_of(task)} if task.get("personal") else doers(task, units)
            for uid in desks.only_on_desk(task.get("desk_id"), owners):
                if uid in mine:
                    mine[uid].append((due, late))
        except Exception as exc:
            warn(f"_summaries: skipping task {task.get('id')}: {exc!r}")
            continue

    for uid, info in desks.people.items():
        try:
            items = mine.get(uid, [])
            due_today = sum(1 for due, late in items if due and not late and due.astimezone(LOCAL_TZ).date() == today)
            overdue = sum(1 for _, late in items if late)
            team_late = sum(desk_overdue.get(d, 0) for d in info["leads"]) if info["leads"] else None
            yield uid, len(items), due_today, overdue, team_late
        except Exception as exc:
            warn(f"_summaries: skipping user {uid}: {exc!r}")
            continue


def _sentence(*parts) -> str:
    """Join clauses into one message with single full stops."""
    return ". ".join(p.strip().rstrip(".") for p in parts if p and p.strip()) + "."


def start_of_day() -> None:
    """#35: what each person has on today - sent to every user."""
    count = 0
    for uid, open_count, due_today, overdue, team_late in _summaries():
        if open_count == 0:
            mine = "Nothing is assigned to you right now"
        else:
            mine = f"{open_count} open, {due_today} due today" + (f", {overdue} overdue" if overdue else "")
        desk = f"Across the desk: {team_late} overdue" if team_late else ""
        notify(uid, None, "bod_summary", "Your day", _sentence(mine, desk), subject="BusyBee: your day")
        count += 1
    log(f"sent start-of-day summaries to {count}")


def end_of_day() -> None:
    """#35: what is still outstanding at the end of the day - sent to every user."""
    count = 0
    for uid, open_count, due_today, overdue, team_late in _summaries():
        if due_today == 0 and overdue == 0:
            mine = f"{open_count} open, nothing overdue. Good stopping point" if open_count else "Nothing open. Good stopping point"
        else:
            mine = f"{due_today} still due today, {overdue} overdue"
        desk = f"Across the desk: {team_late} overdue" if team_late else ""
        notify(uid, None, "eod_summary", "End of day", _sentence(mine, desk), subject="BusyBee: end of day")
        count += 1
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

    # Every 10 minutes: deadline, overdue and checklist reminders; every 5,
    # "remind me at" (which also records the heartbeat).
    scheduler.add_job(safe(deadline_reminders), "interval", minutes=10, id="deadline_reminders")
    scheduler.add_job(safe(checklist_reminders), "interval", minutes=10, id="checklist_reminders")
    scheduler.add_job(safe(personal_reminders), "interval", minutes=5, id="personal_reminders")

    scheduler.add_job(safe(start_of_day), "cron", hour=BOD_HOUR, minute=0, id="bod")
    scheduler.add_job(safe(end_of_day), "cron", hour=EOD_HOUR, minute=0, id="eod")
    # Midnight local time: quiet-task nudges and archiving.
    scheduler.add_job(safe(recurring_update_requests), "cron", hour=0, minute=0, id="update_requests")
    scheduler.add_job(safe(auto_archive), "cron", hour=0, minute=15, id="auto_archive")

    log(
        f"scheduler {VERSION} up: reminders every 10m, remind-me every 5m, "
        f"BOD {BOD_HOUR}:00, EOD {EOD_HOUR}:00 (UTC{TZ_OFFSET_HOURS:+g}), "
        f"update requests every {UPDATE_REQUEST_DAYS or 'never'} days, "
        f"auto-archive after {AUTO_ARCHIVE_DAYS or 'never'} days, "
        f"email {'on' if os.environ.get('RESEND_API_KEY') else 'off'}"
    )

    # Run once at boot so a deploy does not wait for the first tick.
    safe(personal_reminders)()
    safe(deadline_reminders)()
    safe(checklist_reminders)()

    try:
        scheduler.start()
    except (KeyboardInterrupt, SystemExit):
        log("scheduler stopped")
