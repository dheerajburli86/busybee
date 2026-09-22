// System check for supervisors: is the database migration in place, is email
// set up, is the scheduler running? Shown on the Teams page.

import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { getMemberships, requireUser, topRole, SUPER_ROLES } from "@/lib/permissions";
import { mailConfigured } from "@/lib/email";
import { formatForPeople } from "@/lib/format";

// Every column the app reads or writes, table by table. A missing one shows up
// here by name instead of as a failing screen.
const SCHEMA: [string, string, string][] = [
  ["Tasks", "tasks", "id, desk_id, project_id, stage_id, title, description, priority, status, progress_percent, due_date, start_date, completed_at, assigned_to, created_by, task_manager_id, team_id, department_id, group_id, milestone, key_result_id, progress_type, progress_target, progress_current, archived_at, personal, remind_at, remind_to, reminder_sent_at, created_at, updated_at"],
  ["Checklist items", "subtasks", "id, task_id, title, done, progress_percent, position, assigned_to, due_date, progress_type, progress_target, progress_current, created_by, created_at, updated_at"],
  ["Comments", "comments", "id, task_id, author_id, content, created_at, updated_at, edited, is_private"],
  ["Private comment recipients", "comment_recipients", "id, comment_id, user_id"],
  ["Projects", "projects", "id, desk_id, name, description, team_id, auto_advance, auto_complete, created_at"],
  ["Sections", "stages", "id, project_id, name, position, created_at"],
  ["People on the desk", "desk_members", "desk_id, user_id, role"],
  ["Profiles", "users", "id, email, full_name, created_at"],
  ["Departments", "departments", "id, desk_id, name, description, created_at"],
  ["Teams", "teams", "id, desk_id, name, description, department_id, manager_id, created_at"],
  ["Team members", "team_members", "id, team_id, user_id, role"],
  ["Custom groups", "groups", "id, desk_id, name, created_by"],
  ["Group members", "group_members", "id, group_id, user_id"],
  ["Chat rooms", "chat_rooms", "id, desk_id, name, kind, team_id, department_id, created_by"],
  ["Chat room members", "chat_room_members", "id, room_id, user_id"],
  ["Chat messages", "chat_messages", "id, desk_id, room_id, author_id, content, created_at"],
  ["Online status", "user_presence", "user_id, last_seen_at"],
  ["Files", "attachments", "id, task_id, uploaded_by, file_name, file_type, file_size, storage_path, visibility, created_at"],
  ["File sharing", "attachment_access", "id, attachment_id, user_id"],
  ["Notifications", "notifications", "id, user_id, task_id, type, title, message, read, created_at"],
  ["History", "activity_log", "id, entity_type, entity_id, action, performed_by, desk_id, changes, created_at"],
  ["Extra assignors", "task_assignors", "id, task_id, user_id"],
  ["Extension requests", "extension_requests", "id, task_id, requested_by, reason, requested_date, status, approved_date, review_note, reviewed_by, created_at"],
  ["Dependencies", "task_dependencies", "id, task_id, depends_on_task_id, dependency_type"],
  ["Timesheets", "timesheet_entries", "id, user_id, task_id, entry_date, hours, notes, created_at"],
  ["Templates", "task_templates", "id, desk_id, name, title, description, priority, milestone, offset_days, checklist, created_by, created_at"],
  ["Project comments", "project_comments", "id, project_id, author_id, content, created_at"],
  ["Objectives", "objectives", "id, desk_id, title, description, period, owner_id, created_at"],
  ["Key results", "key_results", "id, objective_id, title, target_value, current_value, unit"],
];

export async function GET() {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const memberships = await getMemberships(supabase, user.id);
    if (!SUPER_ROLES.includes(topRole(memberships))) {
      return NextResponse.json({ error: "Only a supervisor or admin can run the system check" }, { status: 403 });
    }

    const checks: { name: string; ok: boolean; detail: string }[] = [];

    const schema = await Promise.all(
      SCHEMA.map(async ([name, table, cols]) => {
        const { error } = await supabase.from(table).select(cols).limit(1);
        return { name: `Database: ${name}`, ok: !error, detail: error ? `${error.message} - run the migration in supabase/migrations` : "ready" };
      })
    );
    checks.push(...schema);

    // Pick a desk this user actually supervises/admins - not just their
    // first membership - so the check queries the desk they're checking,
    // not an arbitrary one they might only be a plain member of.
    const superDesk = memberships.find((m: any) => SUPER_ROLES.includes(m.role)) || memberships[0];
    const fn = await supabase.rpc("bb_pending_people", { p_desk: superDesk.desk_id });
    checks.push({
      name: "Database: sign-up approvals",
      ok: !fn.error,
      detail: fn.error ? `${fn.error.message} - run the migration` : "ready",
    });

    // Round-2 database report: roles, public access, sign-ups.
    const report = await supabase.rpc("bb_health_report");
    const r: any = report.data || {};
    checks.push({
      name: "Database: round-2 update",
      ok: !report.error && r.version === "2026-09-22",
      detail: report.error ? `${report.error.message} - run supabase/migrations/20260922_round2.sql` : `installed (${r.version})`,
    });
    if (!report.error) {
      const unknown: string[] = Array.isArray(r.unknown_roles) ? r.unknown_roles.filter(Boolean) : [];
      checks.push({
        name: "Desk roles",
        ok: unknown.length === 0,
        detail: unknown.length
          ? `unrecognised role values: ${unknown.join(", ")} - these people count as plain members; set their role on this page`
          : "every person has a known role",
      });
      const open: string[] = Array.isArray(r.open_to_anon) ? r.open_to_anon : [];
      checks.push({
        name: "Public access (without signing in)",
        ok: open.length === 0,
        detail: open.length
          ? `these tables have a rule that lets anyone read them without signing in: ${open.join(", ")} - run the round-2 migration again`
          : "nothing is readable without signing in",
      });
      checks.push({
        name: "Sign-ups",
        ok: !!r.signup_trigger,
        detail: r.signup_trigger ? "new accounts get a profile automatically" : "the sign-up trigger is missing - run the round-2 migration",
      });
    }

    const rls = await supabase.rpc("bb_tables_without_rls");
    const open = (rls.data || []) as string[];
    checks.push({
      name: "Database security (row level security)",
      ok: !rls.error && open.length === 0,
      detail: rls.error
        ? `${rls.error.message} - run the migration`
        : open.length
        ? `switched off on: ${open.join(", ")} - anyone with the public key can read these tables; turn RLS on in Supabase`
        : "on for every table",
    });

    const from = process.env.MAIL_FROM || "";
    const testSender = !from || /@resend\.dev>?$/i.test(from.trim());
    checks.push({
      name: "Email notifications",
      ok: mailConfigured() && !testSender,
      detail: !mailConfigured()
        ? "Not set up - notifications are in-app only (set RESEND_API_KEY to add email)"
        : testSender
        ? "RESEND_API_KEY is set, but MAIL_FROM is Resend's test sender, which only delivers to the Resend account's own address - set MAIL_FROM to an address on your verified domain"
        : `sending as ${from}`,
    });

    // The round-2 scheduler records a heartbeat every few minutes.
    const { data: beat } = await supabase.from("bb_meta").select("value, updated_at").eq("key", "scheduler").maybeSingle();
    if (beat?.updated_at) {
      const age = Date.now() - new Date(beat.updated_at).getTime();
      checks.push({
        name: "Scheduler (reminders, BOD/EOD)",
        ok: age < 30 * 60 * 1000,
        detail:
          age < 30 * 60 * 1000
            ? `running (${beat.value || "current version"}), last seen ${formatForPeople(beat.updated_at)}`
            : `not seen since ${formatForPeople(beat.updated_at)} - check the Railway service`,
      });
      return NextResponse.json({ ok: checks.every((c) => c.ok), checks });
    }

    // Older scheduler without a heartbeat: it sends everyone a start-of-day
    // summary, so a recent one means it's running.
    const { data: last } = await supabase
      .from("notifications")
      .select("created_at")
      .eq("user_id", user.id)
      .in("type", ["bod_summary", "eod_summary"])
      .order("created_at", { ascending: false })
      .limit(1);
    const lastAt = last?.[0]?.created_at ? new Date(last[0].created_at) : null;
    const fresh = !!lastAt && Date.now() - lastAt.getTime() < 26 * 3600 * 1000;
    checks.push({
      name: "Scheduler (reminders, BOD/EOD)",
      ok: false,
      detail: fresh
        ? `an older scheduler is running (last daily summary ${formatForPeople(lastAt!.toISOString())}) - redeploy scheduler/ on Railway to get this release's reminders`
        : lastAt
        ? `last daily summary ${formatForPeople(lastAt.toISOString())} - check the scheduler is deployed`
        : "no heartbeat or daily summary yet - check the scheduler is deployed on Railway",
    });

    return NextResponse.json({ ok: checks.every((c) => c.ok), checks });
  } catch (error: any) {
    console.error("GET /api/health failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
