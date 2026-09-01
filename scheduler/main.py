"""
BusyBee scheduler.

Runs the notifications that need a clock rather than a user action:
  SOW #24 - reminders at 24, 8 and 6 hours before a deadline
  SOW #25 - a start-of-day and end-of-day summary for every user

Deploy on Railway with these environment variables:
  SUPABASE_URL          - https://<project>.supabase.co
  SUPABASE_SERVICE_KEY  - the service_role key (not the anon key)
  BOD_HOUR              - optional, defaults to 9
  EOD_HOUR              - optional, defaults to 18
  TZ_OFFSET_HOURS       - optional, defaults to 5.5 for IST
"""

import os
import sys
from datetime import datetime, timedelta, timezone

from apscheduler.schedulers.blocking import BlockingScheduler
from supabase import create_client

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
BOD_HOUR = int(os.environ.get("BOD_HOUR", "9"))
EOD_HOUR = int(os.environ.get("EOD_HOUR", "18"))
TZ_OFFSET_HOURS = float(os.environ.get("TZ_OFFSET_HOURS", "5.5"))

if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
    print("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set", file=sys.stderr)
    sys.exit(1)

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
LOCAL_TZ = timezone(timedelta(hours=TZ_OFFSET_HOURS))

# Reminder thresholds, in hours before the deadline.
THRESHOLDS = [24, 8, 6]


def already_sent(task_id: str, marker: str) -> bool:
    """A reminder is only sent once per task per threshold."""
    try:
        res = (
            supabase.table("notifications")
            .select("id")
            .eq("task_id", task_id)
            .eq("type", marker)
            .limit(1)
            .execute()
        )
        return bool(res.data)
    except Exception as exc:
        print(f"dedupe check failed for {task_id}: {exc}", file=sys.stderr)
        # Fail closed so a database blip cannot cause a burst of duplicates.
        return True


def notify(user_id: str, task_id, ntype: str, title: str, message: str) -> None:
    try:
        supabase.table("notifications").insert(
            {
                "user_id": user_id,
                "task_id": task_id,
                "type": ntype,
                "title": title,
                "message": message,
                "read": False,
            }
        ).execute()
    except Exception as exc:
        print(f"could not write notification for {user_id}: {exc}", file=sys.stderr)


def deadline_reminders() -> None:
    """SOW #24: warn the assignee at 24, 8 and 6 hours out."""
    now = datetime.now(timezone.utc)
    try:
        res = (
            supabase.table("tasks")
            .select("id, title, due_date, assigned_to, status")
            .not_.is_("due_date", "null")
            .not_.is_("assigned_to", "null")
            .neq("status", "done")
            .execute()
        )
    except Exception as exc:
        print(f"could not read tasks: {exc}", file=sys.stderr)
        return

    for task in res.data or []:
        try:
            due = datetime.fromisoformat(str(task["due_date"]).replace("Z", "+00:00"))
            if due.tzinfo is None:
                due = due.replace(tzinfo=timezone.utc)
        except (ValueError, TypeError):
            continue

        hours_left = (due - now).total_seconds() / 3600
        if hours_left <= 0:
            continue

        for threshold in THRESHOLDS:
            # Fire once when the task first falls inside the window.
            if threshold - 0.5 < hours_left <= threshold:
                marker = f"reminder_{threshold}h"
                if already_sent(task["id"], marker):
                    continue
                notify(
                    task["assigned_to"],
                    task["id"],
                    marker,
                    f"Due in {threshold} hours",
                    f"{task['title']} is due at {due.astimezone(LOCAL_TZ):%d %b %H:%M}",
                )
                print(f"sent {threshold}h reminder for {task['id']}")
                break


def _open_tasks_by_user() -> dict:
    try:
        res = (
            supabase.table("tasks")
            .select("id, title, due_date, assigned_to, status")
            .not_.is_("assigned_to", "null")
            .neq("status", "done")
            .execute()
        )
    except Exception as exc:
        print(f"could not read tasks: {exc}", file=sys.stderr)
        return {}

    grouped: dict = {}
    for task in res.data or []:
        grouped.setdefault(task["assigned_to"], []).append(task)
    return grouped


def _due_counts(tasks: list) -> tuple:
    now = datetime.now(timezone.utc)
    today = now.astimezone(LOCAL_TZ).date()
    due_today = 0
    overdue = 0

    for task in tasks:
        if not task.get("due_date"):
            continue
        try:
            due = datetime.fromisoformat(str(task["due_date"]).replace("Z", "+00:00"))
            if due.tzinfo is None:
                due = due.replace(tzinfo=timezone.utc)
        except (ValueError, TypeError):
            continue

        local_due = due.astimezone(LOCAL_TZ).date()
        if local_due < today:
            overdue += 1
        elif local_due == today:
            due_today += 1

    return due_today, overdue


def start_of_day() -> None:
    """SOW #25: what each person has on today."""
    for user_id, tasks in _open_tasks_by_user().items():
        due_today, overdue = _due_counts(tasks)
        message = f"{len(tasks)} open, {due_today} due today"
        if overdue:
            message += f", {overdue} overdue"
        notify(user_id, None, "bod_summary", "Your day", message)
    print("sent start-of-day summaries")


def end_of_day() -> None:
    """SOW #25: what is still outstanding at the end of the day."""
    for user_id, tasks in _open_tasks_by_user().items():
        due_today, overdue = _due_counts(tasks)
        if due_today == 0 and overdue == 0:
            message = f"{len(tasks)} open, nothing overdue. Good stopping point."
        else:
            message = f"{due_today} still due today, {overdue} overdue"
        notify(user_id, None, "eod_summary", "End of day", message)
    print("sent end-of-day summaries")


if __name__ == "__main__":
    scheduler = BlockingScheduler(timezone="UTC")

    # Every 30 minutes is frequent enough for the 0.5h windows above.
    scheduler.add_job(deadline_reminders, "interval", minutes=30, id="deadline_reminders")

    # BOD and EOD are configured in local time, converted to UTC for the cron.
    bod_utc = int((BOD_HOUR - TZ_OFFSET_HOURS) % 24)
    eod_utc = int((EOD_HOUR - TZ_OFFSET_HOURS) % 24)
    scheduler.add_job(start_of_day, "cron", hour=bod_utc, minute=0, id="bod")
    scheduler.add_job(end_of_day, "cron", hour=eod_utc, minute=0, id="eod")

    print(
        f"scheduler up: reminders every 30m, "
        f"BOD {BOD_HOUR}:00 local ({bod_utc}:00 UTC), "
        f"EOD {EOD_HOUR}:00 local ({eod_utc}:00 UTC)"
    )

    # Run once at boot so a deploy does not wait for the first tick.
    deadline_reminders()

    try:
        scheduler.start()
    except (KeyboardInterrupt, SystemExit):
        print("scheduler stopped")
