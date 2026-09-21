import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { sendMail } from "@/lib/email";
import { deny, logActivity, requireUser, taskAccess } from "@/lib/permissions";

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

    // An update request goes to whoever is doing the work; if nobody is
    // assigned there is no one to ask.
    const target = task.assigned_to;
    if (!target) {
      return NextResponse.json(
        { error: "Assign the task to someone before sending a reminder" },
        { status: 400 }
      );
    }

    const isUpdateRequest = kind === "update_request";

    const { error } = await supabase.from("notifications").insert({
      user_id: target,
      task_id: id,
      type: isUpdateRequest ? "update_request" : "reminder",
      title: isUpdateRequest ? "Update requested" : "Reminder",
      message:
        note ||
        (isUpdateRequest
          ? `An update was requested on: ${task.title}`
          : `Reminder about: ${task.title}`),
      read: false,
    });

    if (error) throw error;

    // SOW #39: the reminder also goes out by email when mail is configured.
    // A failed or unconfigured send must not fail the request, so the result
    // is reported rather than thrown.
    const message =
      note ||
      (isUpdateRequest
        ? `An update was requested on: ${task.title}`
        : `Reminder about: ${task.title}`);

    const emailed = await sendMail({
      userIds: [target],
      subject: isUpdateRequest
        ? `Update requested: ${task.title}`
        : `Reminder: ${task.title}`,
      body: message,
    });

    await logActivity(supabase, {
      entity_type: "task",
      entity_id: id,
      action: isUpdateRequest ? "requested an update" : "sent a reminder",
      performed_by: user.id,
      desk_id: task.desk_id,
    });

    return NextResponse.json({ success: true, emailed });
  } catch (error: any) {
    console.error("POST /api/tasks/[id]/remind failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
