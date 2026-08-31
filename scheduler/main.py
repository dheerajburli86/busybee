#!/usr/bin/env python3
# scheduler/main.py

import os
import logging
from datetime import datetime, timedelta
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger
from supabase import create_client, Client
import google.generativeai as genai
import json
import time

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Initialize Supabase
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY")
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# Initialize Gemini
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
genai.configure(api_key=GEMINI_API_KEY)
gemini_model = genai.GenerativeModel('gemini-2.5-flash')

# ============================================================================
# REMINDER FUNCTIONS
# ============================================================================

def check_and_send_reminders():
    """Check for tasks that need reminders and send them."""
    try:
        logger.info("Checking for reminders...")
        now = datetime.utcnow()
        
        # Get all approved deadlines that haven't been archived
        response = supabase.table("approved_deadlines").select(
            "*, tasks(id, title, assigned_to, desk_id, created_by)"
        ).execute()
        
        deadlines = response.data
        
        for deadline in deadlines:
            task = deadline['tasks']
            if not task:
                continue
            
            approved_datetime = datetime.fromisoformat(deadline['approved_datetime'].replace('Z', '+00:00'))
            
            # 24 hours before
            if approved_datetime - timedelta(hours=24) <= now < approved_datetime - timedelta(hours=23):
                send_reminder(task['id'], task['assigned_to'], task['created_by'], task['desk_id'], "24h")
            
            # 8 hours before
            elif approved_datetime - timedelta(hours=8) <= now < approved_datetime - timedelta(hours=7):
                send_reminder(task['id'], task['assigned_to'], task['created_by'], task['desk_id'], "8h")
            
            # 6 hours before
            elif approved_datetime - timedelta(hours=6) <= now < approved_datetime - timedelta(hours=5):
                send_reminder(task['id'], task['assigned_to'], task['created_by'], task['desk_id'], "6h")
            
            # At deadline (within 5-min window)
            elif approved_datetime <= now < approved_datetime + timedelta(minutes=5):
                send_at_deadline_reminder(task['id'], task['assigned_to'], task['created_by'], task['desk_id'])
            
            # Overdue (24 hours after)
            elif approved_datetime + timedelta(hours=24) <= now < approved_datetime + timedelta(hours=25):
                send_overdue_reminder(task['id'], task['assigned_to'], task['created_by'], task['desk_id'])
        
        logger.info("Reminder check completed")
    except Exception as e:
        logger.error(f"Error checking reminders: {e}")

def send_reminder(task_id, assigned_to, created_by, desk_id, reminder_type):
    """Send a reminder notification."""
    try:
        # Check if already sent
        existing = supabase.table("notification_log").select(
            "id"
        ).eq("task_id", task_id).eq("user_id", assigned_to).eq("reminder_type", reminder_type).execute()
        
        if existing.data:
            logger.info(f"Reminder already sent for task {task_id} - {reminder_type}")
            return
        
        # Send to assigned person
        if assigned_to:
            supabase.table("notifications").insert({
                "user_id": assigned_to,
                "task_id": task_id,
                "type": "deadline_reminder",
                "title": f"Reminder: {reminder_type} until deadline",
                "message": f"You have {reminder_type} until your deadline",
                "action_url": f"/tasks/{task_id}"
            }).execute()
            
            supabase.table("notification_log").insert({
                "user_id": assigned_to,
                "task_id": task_id,
                "type": "deadline_reminder",
                "reminder_type": reminder_type,
            }).execute()
        
        # Send to supervisor
        supabase.table("notifications").insert({
            "user_id": created_by,
            "task_id": task_id,
            "type": "deadline_reminder",
            "title": f"Task reminder: {reminder_type} until deadline",
            "message": f"Task has {reminder_type} until deadline",
            "action_url": f"/tasks/{task_id}"
        }).execute()
        
        supabase.table("notification_log").insert({
            "user_id": created_by,
            "task_id": task_id,
            "type": "deadline_reminder",
            "reminder_type": reminder_type,
        }).execute()
        
        logger.info(f"Reminder sent for task {task_id} - {reminder_type}")
    except Exception as e:
        logger.error(f"Error sending reminder for task {task_id}: {e}")

def send_at_deadline_reminder(task_id, assigned_to, created_by, desk_id):
    """Send dual reminders at deadline."""
    try:
        # Check if already sent
        existing = supabase.table("notification_log").select("id").eq(
            "task_id", task_id
        ).eq("reminder_type", "at_deadline").execute()
        
        if existing.data:
            logger.info(f"Deadline reminder already sent for task {task_id}")
            return
        
        # Supervisor: collect report
        supabase.table("notifications").insert({
            "user_id": created_by,
            "task_id": task_id,
            "type": "deadline_due",
            "title": "Deadline reached - Collect report",
            "message": "Deadline has passed. Time to collect the report from your team member.",
            "action_url": f"/tasks/{task_id}"
        }).execute()
        
        # Assignee: submit report
        if assigned_to:
            supabase.table("notifications").insert({
                "user_id": assigned_to,
                "task_id": task_id,
                "type": "deadline_due",
                "title": "Deadline reached - Submit report",
                "message": "Your deadline has passed. Please submit your completion report now.",
                "action_url": f"/tasks/{task_id}"
            }).execute()
        
        # Log both
        supabase.table("notification_log").insert({
            "user_id": created_by,
            "task_id": task_id,
            "type": "deadline_due",
            "reminder_type": "at_deadline",
        }).execute()
        
        if assigned_to:
            supabase.table("notification_log").insert({
                "user_id": assigned_to,
                "task_id": task_id,
                "type": "deadline_due",
                "reminder_type": "at_deadline",
            }).execute()
        
        logger.info(f"At-deadline reminder sent for task {task_id}")
    except Exception as e:
        logger.error(f"Error sending at-deadline reminder for task {task_id}: {e}")

def send_overdue_reminder(task_id, assigned_to, created_by, desk_id):
    """Send overdue reminders (daily nudge)."""
    try:
        if assigned_to:
            supabase.table("notifications").insert({
                "user_id": assigned_to,
                "task_id": task_id,
                "type": "task_overdue",
                "title": "Task overdue - Submit report",
                "message": "Your task is overdue. Please submit your report immediately.",
                "action_url": f"/tasks/{task_id}"
            }).execute()
        
        supabase.table("notifications").insert({
            "user_id": created_by,
            "task_id": task_id,
            "type": "task_overdue",
            "title": "Task overdue - Follow up",
            "message": "A task is overdue. Check on your team member's progress.",
            "action_url": f"/tasks/{task_id}"
        }).execute()
        
        logger.info(f"Overdue reminder sent for task {task_id}")
    except Exception as e:
        logger.error(f"Error sending overdue reminder for task {task_id}: {e}")

# ============================================================================
# DAR ANALYSIS
# ============================================================================

def analyze_daily_reports():
    """Analyze all daily reports submitted today."""
    try:
        logger.info("Analyzing daily reports...")
        
        today = datetime.utcnow().date()
        
        # Get all daily reports for today that haven't been analyzed
        response = supabase.table("daily_reports").select(
            "id, user_id, desk_id, content, hours_worked"
        ).eq("report_date", today.isoformat()).execute()
        
        reports = response.data or []
        
        for report in reports:
            # Check if already analyzed
            existing = supabase.table("ai_analyses").select("id").eq(
                "daily_report_id", report['id']
            ).execute()
            
            if existing.data:
                continue
            
            # Get user's active tasks
            tasks_response = supabase.table("tasks").select(
                "id, title, approved_deadlines(approved_datetime)"
            ).eq("assigned_to", report['user_id']).is_("archived_at", None).execute()
            
            tasks = tasks_response.data or []
            
            # Prepare prompt for Gemini
            prompt = f"""
            Analyze this daily activity report:
            
            Report content: {report['content']}
            Hours worked: {report['hours_worked'] or 'Not specified'}
            
            Active tasks for this user:
            {json.dumps([{'title': t['title'], 'deadline': t['approved_deadlines'][0]['approved_datetime'] if t['approved_deadlines'] else 'No deadline'} for t in tasks[:5]], indent=2)}
            
            Provide a JSON response with:
            {{
              "adequacy_signal": "adequate" | "borderline" | "inadequate",
              "reasoning": "Brief explanation",
              "risk_flags": ["flag1", "flag2"] or []
            }}
            """
            
            try:
                response = gemini_model.generate_content(prompt)
                analysis_text = response.text
                
                # Try to parse JSON from response
                try:
                    # Extract JSON from response
                    start_idx = analysis_text.find('{')
                    end_idx = analysis_text.rfind('}') + 1
                    if start_idx != -1 and end_idx > start_idx:
                        json_str = analysis_text[start_idx:end_idx]
                        analysis = json.loads(json_str)
                    else:
                        analysis = {
                            "adequacy_signal": "borderline",
                            "reasoning": analysis_text,
                            "risk_flags": []
                        }
                except json.JSONDecodeError:
                    analysis = {
                        "adequacy_signal": "borderline",
                        "reasoning": analysis_text,
                        "risk_flags": []
                    }
                
                # Store analysis
                supabase.table("ai_analyses").insert({
                    "daily_report_id": report['id'],
                    "adequacy_signal": analysis.get("adequacy_signal", "borderline"),
                    "reasoning": analysis.get("reasoning", ""),
                    "risk_flags": analysis.get("risk_flags", []),
                    "raw_response": analysis
                }).execute()
                
                # Notify supervisor
                desk = supabase.table("desks").select("*").eq("id", report['desk_id']).single().execute().data
                supervisors = supabase.table("desk_members").select("user_id").eq(
                    "desk_id", report['desk_id']
                ).in_("role", ["supervisor", "owner"]).execute().data or []
                
                for sup in supervisors:
                    supabase.table("notifications").insert({
                        "user_id": sup['user_id'],
                        "type": "dar_analyzed",
                        "title": "Daily report analyzed",
                        "message": f"Daily report analyzed - Signal: {analysis.get('adequacy_signal', 'unknown')}",
                        "action_url": f"/desk/{report['desk_id']}"
                    }).execute()
                
                logger.info(f"Analyzed DAR {report['id']}")
            except Exception as e:
                logger.error(f"Error analyzing with Gemini: {e}")
    
    except Exception as e:
        logger.error(f"Error in analyze_daily_reports: {e}")

# ============================================================================
# SCHEDULER SETUP
# ============================================================================

def start_scheduler():
    """Start the background scheduler."""
    scheduler = BackgroundScheduler()
    
    # Check reminders every 5 minutes
    scheduler.add_job(
        check_and_send_reminders,
        IntervalTrigger(minutes=5),
        id='check_reminders',
        name='Check and send reminders'
    )
    
    # Analyze DARs every hour
    scheduler.add_job(
        analyze_daily_reports,
        IntervalTrigger(hours=1),
        id='analyze_dars',
        name='Analyze daily reports'
    )
    
    scheduler.start()
    logger.info("Scheduler started")
    
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        scheduler.shutdown()
        logger.info("Scheduler stopped")

if __name__ == "__main__":
    logger.info("BusyBee Scheduler initializing...")
    start_scheduler()
