// System check for supervisors: is the database migration in place, is email
// set up, is the scheduler running? Shown on the Teams page.

import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { getMemberships, requireUser, topRole, SUPER_ROLES } from "@/lib/permissions";
import { mailConfigured } from "@/lib/email";

const SCHEMA: [string, string, string][] = [
  ["Tasks", "tasks", "id, stage_id, completed_at, start_date, department_id, group_id, personal, remind_at, remind_to, reminder_sent_at"],
  ["Checklist items", "subtasks", "id, due_date, progress_type, progress_target, progress_current, created_by"],
  ["Comments", "comments", "id, edited, is_private"],
  ["Private comment recipients", "comment_recipients", "id, comment_id, user_id"],
  ["Projects", "projects", "id, team_id, auto_advance, auto_complete"],
  ["Sections", "stages", "id, project_id, name, position"],
  ["Custom groups", "groups", "id, desk_id, name"],
  ["Group members", "group_members", "id, group_id, user_id"],
  ["Chat rooms", "chat_rooms", "id, kind, team_id, department_id"],
  ["Chat room members", "chat_room_members", "id, room_id, user_id"],
  ["Chat messages", "chat_messages", "id, room_id"],
  ["Online status", "user_presence", "user_id, last_seen_at"],
  ["File access", "attachments", "id, storage_path, visibility"],
  ["File sharing", "attachment_access", "id, attachment_id, user_id"],
  ["Templates", "task_templates", "id, checklist"],
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

    const fn = await supabase.rpc("bb_pending_people", { p_desk: memberships[0].desk_id });
    checks.push({
      name: "Database: sign-up approvals",
      ok: !fn.error,
      detail: fn.error ? `${fn.error.message} - run the migration` : "ready",
    });

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

    checks.push({
      name: "Email notifications",
      ok: mailConfigured(),
      detail: mailConfigured() ? "RESEND_API_KEY is set" : "Not set up - notifications are in-app only (set RESEND_API_KEY to add email)",
    });

    // The scheduler sends everyone a start-of-day summary; if the latest is
    // recent, it's running.
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
      ok: fresh,
      detail: lastAt ? `last daily summary ${lastAt.toISOString()}` : "no daily summary received yet - check the scheduler is deployed",
    });

    return NextResponse.json({ ok: checks.every((c) => c.ok), checks });
  } catch (error: any) {
    console.error("GET /api/health failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
