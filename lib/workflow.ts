// Checklist #20: sections and workflow.
//
// A project's sections are the rows of the `stages` table, in `position`
// order. Two optional per-project rules make it a workflow:
//   auto_complete - when every checklist item (subtask) on a task is ticked,
//                   the task is marked Completed
//   auto_advance  - when a task is completed, it moves to the next section
//                   (and keeps its Completed status there)

import { SUPER_ROLES, logActivity, normalizeRole, notifyMany, taskAudience, teamMemberIds } from "@/lib/permissions";
import { isFinished } from "@/lib/status";

export type Section = { id: string; project_id: string; name: string; position: number };

export async function sectionsOf(supabase: any, projectId: string): Promise<Section[]> {
  const { data } = await supabase
    .from("stages")
    .select("id, project_id, name, position, created_at")
    .eq("project_id", projectId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  return (data || []).map((s: any) => ({ id: s.id, project_id: s.project_id, name: s.name || "Section", position: s.position ?? 0 }));
}

/** The first section of a project, creating one if the project has none. */
export async function firstSection(supabase: any, projectId: string): Promise<string | null> {
  const list = await sectionsOf(supabase, projectId);
  if (list.length) return list[0].id;
  const { data } = await supabase.from("stages").insert({ project_id: projectId, name: "To do", position: 0 }).select("id").single();
  return data?.id ?? null;
}

/** Is this section part of that project? */
export async function sectionInProject(supabase: any, stageId: string, projectId: string): Promise<boolean> {
  const { data } = await supabase.from("stages").select("id, project_id").eq("id", stageId).maybeSingle();
  return !!data && data.project_id === projectId;
}

export async function workflowOf(supabase: any, projectId: string | null) {
  if (!projectId) return { auto_advance: false, auto_complete: false };
  const { data } = await supabase.from("projects").select("auto_advance, auto_complete").eq("id", projectId).maybeSingle();
  return { auto_advance: !!data?.auto_advance, auto_complete: !!data?.auto_complete };
}

/**
 * Extra fields to write when a task becomes Completed: the next section, if
 * the project moves completed work along. Returns {} when nothing changes.
 */
export async function completionMove(supabase: any, task: { project_id: string | null; stage_id: string | null }) {
  if (!task.project_id) return {};
  const wf = await workflowOf(supabase, task.project_id);
  if (!wf.auto_advance) return {};
  const list = await sectionsOf(supabase, task.project_id);
  const at = list.findIndex((s) => s.id === task.stage_id);
  const next = at >= 0 ? list[at + 1] : null;
  return next ? { stage_id: next.id } : {};
}

/** Tell everyone connected to a task that it was finished. */
export async function notifyCompleted(supabase: any, task: any, actorId: string | null, how = "") {
  const audience = (await taskAudience(supabase, task)).filter((x) => x !== actorId);
  const word = task.status === "closed" ? "closed" : "completed";
  await notifyMany(supabase, audience, {
    task_id: task.id,
    type: "completed",
    title: `Task ${word}`,
    message: `Task marked ${word}${how}: ${task.title}`,
    email: { subject: `Task ${word}: ${task.title}`, body: `${task.title} was marked ${word}${how}.` },
  });
}

/**
 * After a checklist change: if the project completes tasks automatically and
 * every item is now ticked, mark the task Completed (and move it on, if the
 * project does that too). Returns the updated task, or null if nothing
 * changed.
 */
export async function autoCompleteFromChecklist(supabase: any, taskId: string, actorId: string) {
  const { data: task } = await supabase.from("tasks").select("*").eq("id", taskId).maybeSingle();
  if (!task || isFinished(task.status) || task.archived_at) return null;
  const wf = await workflowOf(supabase, task.project_id);
  if (!wf.auto_complete) return null;

  const { data: subs } = await supabase.from("subtasks").select("done").eq("task_id", taskId);
  if (!subs || subs.length === 0 || subs.some((s: any) => !s.done)) return null;

  const now = new Date().toISOString();
  const move = await completionMove(supabase, task);
  const patch: Record<string, any> = { status: "done", completed_at: now, updated_at: now, progress_percent: 100, ...move };
  // Finished by checklist is still finished: it joins the supervisor's review
  // queue like any other (only once the review column exists).
  if ("review_status" in task && !task.personal) patch.review_status = "pending";
  const { data: updated, error } = await supabase.from("tasks").update(patch).eq("id", taskId).select("*").single();
  if (error || !updated) return null;

  const changes: Record<string, any> = { status: { from: task.status, to: "done" } };
  if (move.stage_id) changes.stage_id = { from: task.stage_id, to: move.stage_id };
  await logActivity(supabase, {
    entity_type: "task",
    entity_id: taskId,
    action: `completed the task (every checklist item done)${move.stage_id ? " and it moved to the next section" : ""}`,
    performed_by: actorId,
    desk_id: task.desk_id,
    changes,
  });
  await notifyCompleted(supabase, updated, actorId, " (every checklist item is done)");
  return updated;
}

/**
 * Everyone whose work a task is: the named assignee, its team, and whoever
 * holds an item on its checklist. Used to stop people signing off their own
 * work - the same rule the database enforces in bb_task_is_worker().
 */
export async function workersOn(supabase: any, task: any): Promise<string[]> {
  const ids = new Set<string>();
  if (task.assigned_to) ids.add(task.assigned_to);
  (await teamMemberIds(supabase, task.team_id)).forEach((x: string) => ids.add(x));
  const { data: subs } = await supabase.from("subtasks").select("assigned_to").eq("task_id", task.id);
  (subs || []).forEach((s: any) => s.assigned_to && ids.add(s.assigned_to));
  return Array.from(ids);
}

/**
 * True when a Supabase error means "the workflow migration hasn't been run":
 * a missing table or column, as Postgres reports it (42P01 / 42703) or as
 * newer PostgREST does (PGRST205 / PGRST204).
 */
export function schemaMissing(error: any): boolean {
  return ["42P01", "42703", "PGRST205", "PGRST204"].includes(String(error?.code || ""));
}

/**
 * Everyone who can decide on a request: the task's creator, task manager and
 * extra assignors, and the manager of the project the task belongs to. If
 * that leaves nobody but the requester, the desk's supervisors.
 */
export async function decidersFor(supabase: any, task: any, requester: string): Promise<string[]> {
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
