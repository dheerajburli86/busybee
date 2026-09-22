// app/api/tasks/[id]/subtasks/route.ts
//
// Subtasks double as the task's checklist (checklist #37): each has its own
// assignee, deadline, and progress - either a percentage or a count/amount
// against a target - and the parent task's progress is rolled up from them.

import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";
import { deny, logActivity, notifyMany, notOnDesk, requireUser, taskAccess, taskAudience } from "@/lib/permissions";
import { recomputeTaskProgress } from "@/lib/progress";
import { autoCompleteFromChecklist } from "@/lib/workflow";
import { normalizeTimestamp } from "@/lib/format";

const COLUMNS =
  "id, title, done, progress_percent, position, assigned_to, due_date, progress_type, progress_target, progress_current, created_by";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const { id: taskId } = await params;
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const access = await taskAccess(supabase, user.id, taskId);
    if (!access?.canView) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    const { data, error } = await supabase
      .from("subtasks")
      .select(COLUMNS)
      .eq("task_id", taskId)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });

    if (error) throw error;
    return NextResponse.json(data || []);
  } catch (error: any) {
    console.error("GET /api/tasks/[id]/subtasks failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  const { id: taskId } = await params;
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const access = await taskAccess(supabase, user.id, taskId);
    if (!access) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    // SOW #14: team members working on the task may break it down further.
    if (!access.canWork) return deny("Only people working on this task can add subtasks.");

    const body = await request.json();
    const { title, assigned_to, progress_type, progress_target } = body;
    if (typeof title !== "string" || !title.trim()) {
      return NextResponse.json({ error: "Title is required" }, { status: 400 });
    }
    const due_date = body.due_date ? normalizeTimestamp(body.due_date) : null;
    if (body.due_date && !due_date) {
      return NextResponse.json({ error: "That deadline isn't a valid date" }, { status: 400 });
    }
    if (due_date && access.task.due_date && new Date(due_date) > new Date(access.task.due_date)) {
      return NextResponse.json({ error: "A subtask can't be due after its task" }, { status: 400 });
    }
    if (assigned_to) {
      const problem = await notOnDesk(supabase, access.task.desk_id, { assigned_to });
      if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    }

    const { count } = await supabase
      .from("subtasks")
      .select("id", { count: "exact", head: true })
      .eq("task_id", taskId);

    const { data: subtask, error } = await supabase
      .from("subtasks")
      .insert({
        task_id: taskId,
        title: title.trim(),
        position: count || 0,
        due_date: due_date || null,
        assigned_to: assigned_to || null,
        progress_type: progress_type || "percent",
        progress_target: progress_target ?? null,
        created_by: user.id,
      })
      .select(COLUMNS)
      .single();

    if (error) throw error;

    const progress = await recomputeTaskProgress(supabase, taskId);
    await logActivity(supabase, {
      entity_type: "task",
      entity_id: taskId,
      action: `added subtask "${subtask.title}"`,
      performed_by: user.id,
      desk_id: access.task.desk_id,
    });
    if (assigned_to && assigned_to !== user.id) {
      await notifyMany(supabase, [assigned_to], {
        task_id: taskId,
        type: "assigned",
        title: "Subtask assigned",
        message: `You were assigned a subtask: ${subtask.title}`,
      });
    }

    return NextResponse.json({ ...subtask, task_progress: progress });
  } catch (error: any) {
    console.error("POST /api/tasks/[id]/subtasks failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  const { id: taskId } = await params;
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const { subtask_id } = body;
    if (!subtask_id) return NextResponse.json({ error: "subtask_id is required" }, { status: 400 });

    const access = await taskAccess(supabase, user.id, taskId);
    if (!access) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    const { data: existing } = await supabase
      .from("subtasks")
      .select("id, task_id, title, assigned_to")
      .eq("id", subtask_id)
      .maybeSingle();
    if (!existing || existing.task_id !== taskId) {
      return NextResponse.json({ error: "Subtask not found" }, { status: 404 });
    }

    const mine = existing.assigned_to === user.id;
    if (!access.canWork && !mine) return deny("You can't update this subtask.");

    const patch: Record<string, any> = {};
    for (const field of [
      "title",
      "done",
      "progress_percent",
      "assigned_to",
      "due_date",
      "progress_type",
      "progress_target",
      "progress_current",
    ]) {
      if (Object.prototype.hasOwnProperty.call(body, field)) patch[field] = body[field];
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
    }
    // Re-assigning and re-dating subtasks is a management decision. (Round-1
    // audit fix: this used to compare against `!access.canWork`, which is
    // always false for anyone who reached this line - since canWork already
    // includes canManage, and line 133 above already required canWork or
    // mine - so the guard could never actually stop a plain team member from
    // reassigning or re-dating a checklist item. Compare against `mine`
    // instead, so only the current subtask assignee or someone with
    // canManage may change who does it or when.)
    if (("assigned_to" in patch || "due_date" in patch || "progress_target" in patch) && !access.canManage && !mine) {
      return deny("Only the assignor, supervisor or the person already doing this item can change who does it or when.");
    }
    if ("due_date" in patch && patch.due_date) {
      const due = normalizeTimestamp(patch.due_date);
      if (!due) return NextResponse.json({ error: "That deadline isn't a valid date" }, { status: 400 });
      patch.due_date = due;
    } else if ("due_date" in patch) {
      patch.due_date = null;
    }
    if (patch.due_date && access.task.due_date && new Date(patch.due_date) > new Date(access.task.due_date)) {
      return NextResponse.json({ error: "A subtask can't be due after its task" }, { status: 400 });
    }
    if ("assigned_to" in patch && patch.assigned_to) {
      const problem = await notOnDesk(supabase, access.task.desk_id, { assigned_to: patch.assigned_to });
      if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    }
    patch.updated_at = new Date().toISOString();

    const { data: subtask, error } = await supabase
      .from("subtasks")
      .update(patch)
      .eq("id", subtask_id)
      .select(COLUMNS)
      .single();
    if (error) throw error;

    const progress = await recomputeTaskProgress(supabase, taskId);

    const what = Object.keys(patch).filter((k) => k !== "updated_at");
    await logActivity(supabase, {
      entity_type: "task",
      entity_id: taskId,
      action:
        "done" in patch
          ? `${patch.done ? "completed" : "reopened"} subtask "${subtask.title}"`
          : `updated subtask "${subtask.title}" (${what.join(", ").replace(/_/g, " ")})`,
      performed_by: user.id,
      desk_id: access.task.desk_id,
      changes: patch,
    });

    // SOW #14 + #2: tell the member when they pick up a subtask.
    if (patch.assigned_to && patch.assigned_to !== user.id && patch.assigned_to !== existing.assigned_to) {
      await notifyMany(supabase, [patch.assigned_to], {
        task_id: taskId,
        type: "assigned",
        title: "Subtask assigned",
        message: `You were assigned a subtask: ${subtask.title}`,
      });
    }
    // DOCX: when a checklist item is finished, everyone on the task hears about
    // it, so whoever's work comes next can start.
    let task = null;
    if (patch.done === true) {
      const t = access.task;
      const audience = (await taskAudience(supabase, t)).filter((x) => x !== user.id);
      await notifyMany(supabase, audience, {
        task_id: taskId,
        type: "subtask_completed",
        title: "Checklist item done",
        message: `"${subtask.title}" is done on: ${t.title}`,
      });
      // #20: a project may complete the task once its whole checklist is done.
      task = await autoCompleteFromChecklist(supabase, taskId, user.id);
    }

    return NextResponse.json({ ...subtask, task_progress: task ? 100 : progress, task });
  } catch (error: any) {
    console.error("PUT /api/tasks/[id]/subtasks failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const { id: taskId } = await params;
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { subtask_id } = await request.json();
    if (!subtask_id) return NextResponse.json({ error: "subtask_id is required" }, { status: 400 });

    const access = await taskAccess(supabase, user.id, taskId);
    if (!access) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    const { data: existing } = await supabase
      .from("subtasks")
      .select("id, task_id, title, created_by")
      .eq("id", subtask_id)
      .maybeSingle();
    if (!existing || existing.task_id !== taskId) {
      return NextResponse.json({ error: "Subtask not found" }, { status: 404 });
    }
    if (!access.canManage && existing.created_by !== user.id) {
      return deny("Only the assignor or whoever added it can remove a subtask.");
    }

    const { error } = await supabase.from("subtasks").delete().eq("id", subtask_id);
    if (error) throw error;

    const progress = await recomputeTaskProgress(supabase, taskId);
    await logActivity(supabase, {
      entity_type: "task",
      entity_id: taskId,
      action: `removed subtask "${existing.title}"`,
      performed_by: user.id,
      desk_id: access.task.desk_id,
    });

    // Removing the last unticked item can finish the checklist.
    const task = await autoCompleteFromChecklist(supabase, taskId, user.id);
    return NextResponse.json({ ok: true, task_progress: task ? 100 : progress, task });
  } catch (error: any) {
    console.error("DELETE /api/tasks/[id]/subtasks failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
