import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import {
  deny,
  logActivity,
  normalizeRole,
  notifyMany,
  requireUser,
  SUPER_ROLES,
  taskAccess,
  taskAudience,
} from "@/lib/permissions";
import { sendMail } from "@/lib/email";
import { formatForPeople, normalizeTimestamp } from "@/lib/format";

// Checklist #43 / #44, SOW #45: overdue module.
// The person doing the work states a reason and asks for a new deadline; the
// assignor approves it as asked, approves with a different date/time, or
// rejects it. Nobody may approve their own request.

type Params = { params: Promise<{ id: string }> };

/**
 * Everyone who can decide on a request: the task's creator, task manager and
 * extra assignors, and the manager of the project the task belongs to. If
 * that leaves nobody but the requester, the desk's supervisors.
 */
async function decidersFor(supabase: any, task: any, requester: string): Promise<string[]> {
  const ids = new Set<string>();
  [task.created_by, task.task_manager_id].forEach((x: string | null) => x && ids.add(x));
  const { data: extra } = await supabase.from("task_assignors").select("user_id").eq("task_id", task.id);
  (extra || []).forEach((x: any) => x.user_id && ids.add(x.user_id));

  if (task.project_id) {
    const [{ data: project }, { data: managers }] = await Promise.all([
      supabase.from("projects").select("manager_id").eq("id", task.project_id).maybeSingle(),
      supabase.from("project_members").select("user_id").eq("project_id", task.project_id).eq("role", "manager"),
    ]);
    if (project?.manager_id) ids.add(project.manager_id);
    (managers || []).forEach((m: any) => m.user_id && ids.add(m.user_id));
  }

  ids.delete(requester);
  if (ids.size === 0) {
    const { data: desk } = await supabase.from("desk_members").select("user_id, role").eq("desk_id", task.desk_id);
    (desk || [])
      .filter((m: any) => m.user_id !== requester && SUPER_ROLES.includes(normalizeRole(m.role)))
      .forEach((m: any) => ids.add(m.user_id));
  }
  return Array.from(ids);
}

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
    const body = await req.json();
    const reason: string = typeof body.reason === "string" ? body.reason : "";
    const requested_date = normalizeTimestamp(body.requested_date);

    if (!reason.trim()) {
      return NextResponse.json({ error: "A reason for the delay is required" }, { status: 400 });
    }
    if (!requested_date) {
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
    if (error) {
      // The check above is check-then-act and can race (two tabs, a retry).
      // The DB has a partial unique index on (task_id) where status='pending'
      // as the real guard - a unique-violation here just means someone else's
      // request landed first, which is the same outcome as the check above.
      if (error.code === "23505") {
        return NextResponse.json({ error: "There is already a request waiting for a decision" }, { status: 400 });
      }
      throw error;
    }

    await logActivity(supabase, {
      entity_type: "task",
      entity_id: id,
      action: "requested a deadline extension",
      performed_by: user.id,
      desk_id: access.task.desk_id,
      changes: { reason: reason.trim(), requested_date: data.requested_date },
    });

    const deciders = await decidersFor(supabase, access.task, user.id);
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
      type: "extension_request",
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
      const chosen = approved_date ? normalizeTimestamp(approved_date) : existing.requested_date;
      if (!chosen || isNaN(new Date(chosen).getTime())) {
        return NextResponse.json({ error: "Pick a valid new deadline" }, { status: 400 });
      }
      finalDate = new Date(chosen).toISOString();
      if (new Date(finalDate).getTime() <= Date.now()) {
        return NextResponse.json({ error: "The new deadline has to be in the future" }, { status: 400 });
      }
    }

    // The .eq("status", "pending") guard makes this update atomic: if two
    // reviewers submit a decision at the same moment, only the first one's
    // write actually matches a "pending" row and comes back with data - the
    // second sees zero rows updated instead of silently overwriting the
    // first decision or moving the deadline a second time.
    const { data, error } = await supabase
      .from("extension_requests")
      .update({ status, reviewed_by: user.id, approved_date: finalDate, review_note: review_note || null })
      .eq("id", request_id)
      .eq("status", "pending")
      .select("id, reason, requested_date, status, approved_date, review_note, requested_by, reviewed_by, created_at")
      .single();
    if (error) {
      // Row security skipped the update, or another request already decided
      // this one between our check above and this write (no row came back).
      if (error.code === "PGRST116") return NextResponse.json({ error: "This request has already been decided" }, { status: 400 });
      throw error;
    }

    if (finalDate) {
      const { error: moveError } = await supabase
        .from("tasks")
        .update({ due_date: finalDate, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (moveError) {
        // Don't leave an "approved" request whose deadline never moved.
        await supabase
          .from("extension_requests")
          .update({ status: "pending", reviewed_by: null, approved_date: null, review_note: null })
          .eq("id", request_id);
        throw moveError;
      }
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
      type: "extension_reviewed",
    });

    // Like any other deadline change, everyone else on the task hears about it.
    if (finalDate) {
      const others = (await taskAudience(supabase, access.task)).filter(
        (x) => x !== user.id && x !== existing.requested_by
      );
      await notifyMany(supabase, others, {
        task_id: id,
        type: "updated",
        title: "Deadline moved",
        message: `New deadline for ${access.task.title}: ${formatForPeople(finalDate)} (extension approved)`,
      });
    }

    return NextResponse.json({ ...data, can_review: false, task_due_date: finalDate });
  } catch (error: any) {
    console.error("PUT extension_requests failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
