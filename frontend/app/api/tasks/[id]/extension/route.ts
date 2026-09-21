import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { deny, logActivity, notifyMany, requireUser, taskAccess } from "@/lib/permissions";
import { sendMail } from "@/lib/email";
import { formatForPeople } from "@/lib/format";

// Checklist #43 / #44, SOW #45: overdue module.
// The person doing the work states a reason and asks for a new deadline; the
// assignor approves it as asked, approves with a different date/time, or
// rejects it. Nobody may approve their own request.

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const access = await taskAccess(supabase, user.id, id);
    if (!access?.canView) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    const { data, error } = await supabase
      .from("extension_requests")
      .select("id, reason, requested_date, status, approved_date, review_note, requested_by, reviewed_by, created_at")
      .eq("task_id", id)
      .order("created_at", { ascending: false });

    if (error) throw error;
    // Tell the UI which rows this person may act on.
    return NextResponse.json(
      (data || []).map((r: any) => ({
        ...r,
        can_review: access.canManage && r.requested_by !== user.id && r.status === "pending",
      }))
    );
  } catch (error: any) {
    console.error("GET extension_requests failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { reason, requested_date } = await req.json();

    if (!reason || !reason.trim()) {
      return NextResponse.json({ error: "A reason for the delay is required" }, { status: 400 });
    }
    if (!requested_date || isNaN(new Date(requested_date).getTime())) {
      return NextResponse.json({ error: "A requested new date and time is required" }, { status: 400 });
    }

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const access = await taskAccess(supabase, user.id, id);
    if (!access) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    if (!access.canWork) return deny("Only people working on this task can ask for more time.");

    if (access.task.due_date && new Date(requested_date) <= new Date(access.task.due_date)) {
      return NextResponse.json({ error: "The new date must be after the current deadline" }, { status: 400 });
    }

    const { data: open } = await supabase
      .from("extension_requests")
      .select("id")
      .eq("task_id", id)
      .eq("status", "pending")
      .limit(1);
    if (open && open.length) {
      return NextResponse.json({ error: "There is already a request waiting for a decision" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("extension_requests")
      .insert({
        task_id: id,
        requested_by: user.id,
        reason: reason.trim(),
        requested_date: new Date(requested_date).toISOString(),
        status: "pending",
      })
      .select("id, reason, requested_date, status, requested_by, created_at")
      .single();
    if (error) throw error;

    await logActivity(supabase, {
      entity_type: "task",
      entity_id: id,
      action: "requested a deadline extension",
      performed_by: user.id,
      desk_id: access.task.desk_id,
      changes: { reason: reason.trim(), requested_date: data.requested_date },
    });

    // Everyone who can decide: the creator, task manager and extra assignors.
    const { data: extra } = await supabase.from("task_assignors").select("user_id").eq("task_id", id);
    const deciders = [access.task.created_by, access.task.task_manager_id, ...(extra || []).map((x: any) => x.user_id)]
      .filter((x) => x && x !== user.id);
    await notifyMany(supabase, deciders, {
      task_id: id,
      type: "extension_request",
      title: "Extension requested",
      message: `More time was requested for: ${access.task.title} - until ${formatForPeople(data.requested_date)} - "${reason.trim().slice(0, 100)}"`,
    });
    await sendMail({
      userIds: deciders,
      subject: `Extension requested: ${access.task.title}`,
      body: `Reason: ${reason.trim()}\nCurrent deadline: ${formatForPeople(access.task.due_date)}\nRequested new deadline: ${formatForPeople(data.requested_date)}`,
    });

    return NextResponse.json({ ...data, can_review: false });
  } catch (error: any) {
    console.error("POST extension_requests failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

// Approve (as asked or with a different date), or reject.
export async function PUT(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { request_id, status, approved_date, review_note } = await req.json();

    if (!request_id) return NextResponse.json({ error: "request_id is required" }, { status: 400 });
    if (!["approved", "rejected"].includes(status)) {
      return NextResponse.json({ error: "status must be approved or rejected" }, { status: 400 });
    }

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const access = await taskAccess(supabase, user.id, id);
    if (!access) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    if (!access.canManage) return deny("Only the assignor, task manager or a supervisor can decide on an extension.");

    const { data: existing } = await supabase
      .from("extension_requests")
      .select("id, task_id, requested_by, requested_date, status")
      .eq("id", request_id)
      .maybeSingle();

    if (!existing || existing.task_id !== id) {
      return NextResponse.json({ error: "Request not found for this task" }, { status: 404 });
    }
    if (existing.status !== "pending") {
      return NextResponse.json({ error: "This request has already been decided" }, { status: 400 });
    }
    if (existing.requested_by === user.id) return deny("You can't approve your own extension request.");

    let finalDate: string | null = null;
    if (status === "approved") {
      const chosen = approved_date || existing.requested_date;
      if (!chosen || isNaN(new Date(chosen).getTime())) {
        return NextResponse.json({ error: "Pick a valid new deadline" }, { status: 400 });
      }
      finalDate = new Date(chosen).toISOString();
    }

    const { data, error } = await supabase
      .from("extension_requests")
      .update({ status, reviewed_by: user.id, approved_date: finalDate, review_note: review_note || null })
      .eq("id", request_id)
      .select("id, reason, requested_date, status, approved_date, review_note, requested_by, reviewed_by, created_at")
      .single();
    if (error) throw error;

    if (finalDate) {
      await supabase.from("tasks").update({ due_date: finalDate, updated_at: new Date().toISOString() }).eq("id", id);
    }

    const amended = finalDate && new Date(finalDate).getTime() !== new Date(existing.requested_date).getTime();
    await logActivity(supabase, {
      entity_type: "task",
      entity_id: id,
      action:
        status === "rejected"
          ? "rejected an extension request"
          : amended
          ? "approved an extension with a different date"
          : "approved an extension",
      performed_by: user.id,
      desk_id: access.task.desk_id,
      changes: finalDate ? { due_date: { from: access.task.due_date, to: finalDate } } : { review_note },
    });

    const message =
      status === "approved"
        ? `New deadline for ${access.task.title}: ${formatForPeople(finalDate)}${amended ? ` (you asked for ${formatForPeople(existing.requested_date)})` : ""}`
        : review_note || `Your extension request for ${access.task.title} was not approved`;
    await notifyMany(supabase, [existing.requested_by], {
      task_id: id,
      type: "extension_reviewed",
      title: status === "approved" ? "Extension approved" : "Extension rejected",
      message,
    });
    await sendMail({
      userIds: [existing.requested_by],
      subject: status === "approved" ? "Extension approved" : "Extension rejected",
      body: message,
    });

    return NextResponse.json({ ...data, can_review: false, task_due_date: finalDate });
  } catch (error: any) {
    console.error("PUT extension_requests failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
