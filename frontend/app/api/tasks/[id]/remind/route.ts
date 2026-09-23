import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { sendMail } from "@/lib/email";
import { deny, logActivity, requireUser, taskAccess, unitMemberIds } from "@/lib/permissions";

// SOW #24 (supervisor seeks an update) and #39 (manual reminder).
// Both are the same action: send a notification about this task to someone.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    let kind = "reminder";
    let note = "";
    try {
      const body = await req.json();
      kind = body?.kind || "reminder";
      note = body?.message || "";
    } catch {
      // defaults are fine
    }

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const access = await taskAccess(supabase, user.id, id);
    if (!access) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    // SOW #24: seeking updates is the supervisor's / assignor's job.
    if (!access.canManage) return deny("Only the assignor or a supervisor can send reminders on this task.");
    const task = access.task;

    // It goes to whoever is doing the work: the named assignee, or - for work
    // given to a team, department or group with nobody named - everyone in
    // that unit.
    const doers: string[] = task.assigned_to
      ? [task.assigned_to]
      : await unitMemberIds(supabase, { teamId: task.team_id, departmentId: task.department_id, groupId: task.group_id });
    const targets = Array.from(new Set(doers.filter((x) => x && x !== user.id)));
    if (targets.length === 0) {
      return NextResponse.json(
        { error: "Nobody else is working on this task yet - assign it to someone first" },
        { status: 400 }
      );
    }

    const isUpdateRequest = kind === "update_request";
    const message =
      String(note || "").trim().slice(0, 500) ||
      (isUpdateRequest
        ? `An update was requested on: ${task.title}`
        : `Reminder about: ${task.title}`);

    const { error } = await supabase.from("notifications").insert(
      targets.map((uid) => ({
        user_id: uid,
        task_id: id,
        type: isUpdateRequest ? "update_request" : "reminder",
        title: isUpdateRequest ? "Update requested" : "Reminder",
        message,
        read: false,
      }))
    );

    if (error) throw error;

    // SOW #39: the reminder also goes out by email when mail is configured.
    // A failed or unconfigured send must not fail the request, so the result
    // is reported rather than thrown.
    const emailed = await sendMail({
      userIds: targets,
      subject: isUpdateRequest
        ? `Update requested: ${task.title}`
        : `Reminder: ${task.title}`,
      body: message,
      type: isUpdateRequest ? "update_request" : "reminder",
    });

    await logActivity(supabase, {
      entity_type: "task",
      entity_id: id,
      action: isUpdateRequest ? "requested an update" : "sent a reminder",
      performed_by: user.id,
      desk_id: task.desk_id,
    });

    return NextResponse.json({ success: true, emailed, sent_to: targets.length });
  } catch (error: any) {
    console.error("POST /api/tasks/[id]/remind failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
