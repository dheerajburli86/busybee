import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";
import { getMemberships, logActivity, requireUser, taskAccess } from "@/lib/permissions";
import { firstSection, sectionInProject } from "@/lib/workflow";
import { isFinished } from "@/lib/status";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    // SOW #16: optionally copy the task into a different project.
    let targetProjectId: string | null = null;
    try {
      const body = await request.json();
      targetProjectId = body?.project_id ?? null;
    } catch {
      // no body sent - copy into the same project
    }

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const access = await taskAccess(supabase, user.id, taskId);
    if (!access?.canView) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    const original = access.task;

    // The target project must be on a desk this person belongs to; the copy
    // goes onto that project's desk and first stage.
    let deskId = original.desk_id;
    let stageId = original.stage_id;
    if (targetProjectId && targetProjectId !== original.project_id) {
      const memberships = await getMemberships(supabase, user.id);
      const { data: proj } = await supabase.from("projects").select("id, desk_id").eq("id", targetProjectId).maybeSingle();
      if (!proj || !memberships.some((m) => m.desk_id === proj.desk_id)) {
        return NextResponse.json({ error: "Unknown project" }, { status: 400 });
      }
      deskId = proj.desk_id;
      stageId = await firstSection(supabase, proj.id);
    }
    // A copy is new work: it starts in the first section of its project when
    // the original has already moved on (e.g. into "Done"), or when the
    // section isn't part of that project.
    const copyProject = targetProjectId || original.project_id;
    if (
      copyProject &&
      (!stageId || isFinished(original.status) || !(await sectionInProject(supabase, stageId, copyProject)))
    ) {
      stageId = await firstSection(supabase, copyProject);
    }

    // Round-1 audit fix: copying a task whose deadline has already passed
    // used to carry that same past due_date onto the new, just-created copy,
    // so it showed up already overdue before anyone had a chance to act.
    // Keep the original's lead time (creation -> due) but measure it from
    // today instead, same idea as templates/route.ts.
    // Whole days are added so the deadline keeps its time of day, and the
    // checklist deadlines move by the same amount.
    let dueDate = original.due_date;
    let shiftMs = 0;
    const origDue = dueDate ? new Date(dueDate).getTime() : NaN;
    if (Number.isFinite(origDue) && origDue <= Date.now()) {
      const from = new Date(original.start_date || original.created_at).getTime();
      const spanMs = Number.isFinite(from) ? origDue - from : NaN;
      const days = Number.isFinite(spanMs) && spanMs > 0 ? Math.round(spanMs / 86400000) : 7;
      const target = Date.now() + Math.max(1, Math.min(days, 365)) * 86400000;
      shiftMs = Math.ceil((target - origDue) / 86400000) * 86400000;
      dueDate = new Date(origDue + shiftMs).toISOString();
    }

    const { data: duplicated, error: createError } = await supabase
      .from("tasks")
      .insert({
        desk_id: deskId,
        project_id: targetProjectId || original.project_id,
        stage_id: stageId,
        start_date: null,
        title: `${original.title} (copy)`,
        description: original.description,
        priority: original.priority,
        status: "pending",
        progress_percent: 0,
        progress_type: original.progress_type,
        progress_target: original.progress_target,
        progress_current: 0,
        due_date: dueDate,
        // A copy of a private to-do item stays private to whoever copied it.
        assigned_to: original.personal ? user.id : null,
        ...(original.personal ? { personal: true } : {}),
        created_by: user.id,
        milestone: original.milestone,
      })
      .select("*")
      .single();

    if (createError) throw createError;

    // The checklist comes along too (unticked, nobody assigned yet).
    const { data: items } = await supabase
      .from("subtasks")
      .select("title, position, due_date, progress_type, progress_target")
      .eq("task_id", taskId)
      .order("position", { ascending: true });
    const newDue = dueDate ? new Date(dueDate).getTime() : NaN;
    const itemDue = (d: string | null) => {
      if (!d) return null;
      const t = new Date(d).getTime() + shiftMs;
      if (!Number.isFinite(t) || t <= Date.now()) return null; // no stale deadlines on new work
      return new Date(Number.isFinite(newDue) ? Math.min(t, newDue) : t).toISOString();
    };
    let copiedItems = 0;
    let warning: string | undefined;
    if (items && items.length) {
      const { error: itemsError } = await supabase.from("subtasks").insert(
        items.map((it: any, i: number) => ({
          task_id: duplicated.id,
          title: it.title,
          position: it.position ?? i,
          due_date: itemDue(it.due_date),
          progress_type: it.progress_type || "percent",
          progress_target: it.progress_target,
          created_by: user.id,
        }))
      );
      if (itemsError) {
        console.error("copying the checklist failed:", itemsError);
        warning = "The task was copied, but its checklist couldn't be.";
      } else {
        copiedItems = items.length;
      }
    }

    await logActivity(supabase, {
      entity_type: "task",
      entity_id: duplicated.id,
      action: "copied this task from another task",
      performed_by: user.id,
      desk_id: deskId,
      changes: { from_task_id: taskId },
    });

    return NextResponse.json({ task: { ...duplicated, subtask_count: copiedItems, for_me: !!original.personal }, warning });
  } catch (error: any) {
    console.error("POST duplicate failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
