// Server-side permission checks. Every write route goes through here so the
// rules live in one place instead of being re-implemented per endpoint.
//
// Access is project-based: a person sees and does work through the projects
// they are a member of, and the project's manager runs it.
//
// Roles (desk_members.role):
//   admin, supervisor  - super user: can manage everything on the desk
//   manager            - manages the projects they run and the work in them
//   member             - works on what they are given
//
// A person's relationship to a task adds to their role:
//   assignor   - created the task, is its task manager, or was added as an
//                extra assignor
//   worker     - is the assignee, is assigned one of its subtasks, or is a
//                member of the project the task belongs to
//
// Personal to-do items (tasks.personal) belong to their owner alone: nobody
// else sees them, supervisors included.

import { NextResponse } from "next/server";
import { selectAll } from "@/lib/chunks";
import { getPrefsMap, wantsInApp } from "@/lib/notifications";

export const SUPER_ROLES = ["admin", "supervisor"];
export const MANAGER_ROLES = ["admin", "supervisor", "manager"];
export const DESK_ROLE_VALUES = ["member", "manager", "supervisor", "admin"];

/**
 * desk_members.role as the app understands it. Data from the original app
 * can hold "owner" (whoever set the desk up) or odd casing/spacing; "owner"
 * is the desk's admin. Anything else unknown counts as a plain member, so
 * nobody gains rights by accident.
 */
export function normalizeRole(raw: unknown): string {
  const r = String(raw ?? "").trim().toLowerCase();
  if (r === "owner" || r === "administrator" || r === "superadmin" || r === "super_admin") return "admin";
  return DESK_ROLE_VALUES.includes(r) ? r : "member";
}

export type Membership = { desk_id: string; role: string };

export type TaskAccess = {
  task: any;
  role: string;
  isSuper: boolean;
  isAssignor: boolean;
  isProjectManager: boolean;
  isWorker: boolean;
  /** May edit the task's definition: dates, assignment, priority, archive. */
  canManage: boolean;
  /** May report on it: status, progress, subtasks, comments, files. */
  canWork: boolean;
  /** May see it at all. */
  canView: boolean;
};

export function deny(message = "You don't have permission to do that", status = 403) {
  return NextResponse.json({ error: message }, { status });
}

export async function getMemberships(supabase: any, userId: string): Promise<Membership[]> {
  const { data } = await supabase
    .from("desk_members")
    .select("desk_id, role")
    .eq("user_id", userId);
  return (data || []).map((m: any) => ({ desk_id: m.desk_id, role: normalizeRole(m.role) }));
}

export function roleIn(memberships: Membership[], deskId: string | null | undefined): string {
  return memberships.find((m) => m.desk_id === deskId)?.role || "member";
}

/** Highest role the user holds on any desk - for pages that aren't desk-specific. */
export function topRole(memberships: Membership[]): string {
  const order = ["member", "manager", "supervisor", "admin"];
  return memberships.reduce(
    (best, m) => (order.indexOf(m.role) > order.indexOf(best) ? m.role : best),
    "member"
  );
}

/**
 * Project ids the user runs: projects.manager_id (#22) plus any project they
 * sit on as a 'manager'.
 */
export async function managedProjectIds(supabase: any, userId: string): Promise<string[]> {
  const [{ data: led }, { data: asMember }] = await Promise.all([
    supabase.from("projects").select("id").eq("manager_id", userId),
    supabase.from("project_members").select("project_id").eq("user_id", userId).eq("role", "manager"),
  ]);
  return Array.from(
    new Set([...(led || []).map((p: any) => p.id), ...(asMember || []).map((p: any) => p.project_id)])
  );
}

/** Project ids the user is a member of, whatever their role on them. */
export async function userProjectIds(supabase: any, userId: string): Promise<string[]> {
  const { data } = await supabase.from("project_members").select("project_id").eq("user_id", userId);
  return Array.from(new Set((data || []).map((p: any) => p.project_id).filter(Boolean)));
}

/**
 * What the user may do with a project: see it (on their desk) and manage it
 * (supervisor/admin, or this project's own manager (#22)).
 */
export async function projectAccess(supabase: any, userId: string, projectId: string) {
  const { data: project } = await supabase.from("projects").select("*").eq("id", projectId).maybeSingle();
  if (!project) return null;
  const memberships = await getMemberships(supabase, userId);
  if (!memberships.some((m) => m.desk_id === project.desk_id)) return null;
  const role = roleIn(memberships, project.desk_id);
  const managed = await managedProjectIds(supabase, userId);
  const isProjectManager = project.manager_id === userId || managed.includes(project.id);
  const canManage = SUPER_ROLES.includes(role) || isProjectManager;
  return { project, role, canManage, isProjectManager };
}

/**
 * Work out what the current user may do with one task. Returns null when the
 * task doesn't exist or isn't on one of the user's desks.
 */
export function isPrivateToSomeoneElse(task: any, userId: string): boolean {
  return !!task.personal && task.created_by !== userId && task.assigned_to !== userId;
}

export async function taskAccess(supabase: any, userId: string, taskId: string): Promise<TaskAccess | null> {
  const { data: task } = await supabase.from("tasks").select("*").eq("id", taskId).maybeSingle();
  if (!task) return null;
  if (isPrivateToSomeoneElse(task, userId)) return null;

  const memberships = await getMemberships(supabase, userId);
  if (!memberships.some((m) => m.desk_id === task.desk_id)) return null;

  const role = roleIn(memberships, task.desk_id);
  const isSuper = SUPER_ROLES.includes(role);

  const [{ data: extra }, { data: subs }, managed, myProjects] = await Promise.all([
    supabase.from("task_assignors").select("user_id").eq("task_id", taskId),
    supabase.from("subtasks").select("assigned_to").eq("task_id", taskId),
    managedProjectIds(supabase, userId),
    userProjectIds(supabase, userId),
  ]);

  const isAssignor =
    task.created_by === userId ||
    task.task_manager_id === userId ||
    (extra || []).some((a: any) => a.user_id === userId);

  // Checklist #22: whoever runs this task's project runs its tasks too.
  const isProjectManager = !!task.project_id && managed.includes(task.project_id);

  const isWorker =
    task.assigned_to === userId ||
    (subs || []).some((s: any) => s.assigned_to === userId) ||
    (!!task.project_id && myProjects.includes(task.project_id));

  const canManage = isSuper || isAssignor || isProjectManager;
  const canWork = canManage || !!isWorker;

  return {
    task,
    role,
    isSuper,
    isAssignor,
    isProjectManager,
    isWorker: !!isWorker,
    canManage,
    canWork,
    canView: canWork,
  };
}

/**
 * Filter a list of desk tasks down to the ones this user may see.
 * Supervisors/admins see everything on their desks; everyone else sees work
 * they created, manage, do, or that sits in a project they belong to.
 */
export async function visibleTasks(supabase: any, userId: string, tasks: any[]): Promise<any[]> {
  if (tasks.length === 0) return tasks;
  const memberships = await getMemberships(supabase, userId);

  // Filtered by person only - a list of every task id would not fit in a URL.
  const [extra, subs, managed, myProjects] = await Promise.all([
    selectAll<any>(() => supabase.from("task_assignors").select("task_id").eq("user_id", userId).order("id")),
    selectAll<any>(() => supabase.from("subtasks").select("task_id").eq("assigned_to", userId).order("id")),
    managedProjectIds(supabase, userId),
    userProjectIds(supabase, userId),
  ]);

  const extraIds = new Set((extra || []).map((x: any) => x.task_id));
  const subIds = new Set((subs || []).map((x: any) => x.task_id));
  // Checklist #22: projects this user manages, plus the ones they are on.
  const myProjectIds = new Set<string>([...managed, ...myProjects]);

  return tasks.filter((t) => {
    if (isPrivateToSomeoneElse(t, userId)) return false;
    const role = roleIn(memberships, t.desk_id);
    if (SUPER_ROLES.includes(role)) return true;
    return (
      t.created_by === userId ||
      t.assigned_to === userId ||
      t.task_manager_id === userId ||
      extraIds.has(t.id) ||
      subIds.has(t.id) ||
      (!!t.project_id && myProjectIds.has(t.project_id))
    );
  });
}

/**
 * Is this task on the person's own plate? Given to them by name, or sitting
 * unassigned in a project they are a member of.
 */
export function isForMe(task: any, userId: string, projectIds: string[]): boolean {
  if (task.assigned_to) return task.assigned_to === userId;
  return !!task.project_id && projectIds.includes(task.project_id);
}

/**
 * Projects the user can see: supervisors see all on their desks; others see
 * the projects they run, the ones they are a member of, and any project
 * holding a task they can see. `can_manage` marks the ones they run.
 */
export async function visibleProjects(supabase: any, userId: string): Promise<any[]> {
  const memberships = await getMemberships(supabase, userId);
  const deskIds = memberships.map((m) => m.desk_id);
  if (!deskIds.length) return [];
  const [projects, managed, myProjects, tasks] = await Promise.all([
    selectAll<any>(() => supabase.from("projects").select("*").in("desk_id", deskIds).order("created_at", { ascending: false }).order("id")),
    managedProjectIds(supabase, userId),
    userProjectIds(supabase, userId),
    selectAll<any>(() => supabase.from("tasks").select("*").in("desk_id", deskIds).is("archived_at", null).order("id")),
  ]);
  const withTasks = new Set((await visibleTasks(supabase, userId, tasks)).map((t: any) => t.project_id));
  return projects
    .filter((p: any) => {
      if (SUPER_ROLES.includes(roleIn(memberships, p.desk_id))) return true;
      if (p.manager_id === userId || managed.includes(p.id)) return true;
      return myProjects.includes(p.id) || withTasks.has(p.id);
    })
    .map((p: any) => ({
      ...p,
      can_manage:
        SUPER_ROLES.includes(roleIn(memberships, p.desk_id)) ||
        p.manager_id === userId ||
        managed.includes(p.id),
    }));
}

/** Everyone connected to a task, for notifications. */
export async function taskAudience(supabase: any, task: any): Promise<string[]> {
  const ids = new Set<string>();
  [task.assigned_to, task.created_by, task.task_manager_id].forEach((x) => x && ids.add(x));

  const [{ data: extra }, { data: subs }, { data: commenters }] = await Promise.all([
    supabase.from("task_assignors").select("user_id").eq("task_id", task.id),
    supabase.from("subtasks").select("assigned_to").eq("task_id", task.id),
    supabase.from("comments").select("author_id").eq("task_id", task.id),
  ]);
  (extra || []).forEach((x: any) => x.user_id && ids.add(x.user_id));
  (subs || []).forEach((x: any) => x.assigned_to && ids.add(x.assigned_to));
  (commenters || []).forEach((x: any) => x.author_id && ids.add(x.author_id));

  const members = await projectMemberIds(supabase, task.project_id);
  members.forEach((x) => ids.add(x));
  return Array.from(ids);
}

/** Everyone on a project: its members plus whoever manages it. */
export async function projectMemberIds(
  supabase: any,
  projectId: string | null | undefined
): Promise<string[]> {
  if (!projectId) return [];
  const ids = new Set<string>();
  const [{ data: members }, { data: project }] = await Promise.all([
    supabase.from("project_members").select("user_id").eq("project_id", projectId),
    supabase.from("projects").select("manager_id").eq("id", projectId).maybeSingle(),
  ]);
  (members || []).forEach((m: any) => m.user_id && ids.add(m.user_id));
  if (project?.manager_id) ids.add(project.manager_id);
  return Array.from(ids);
}

/** Record an action in the activity history. Never throws. */
export async function logActivity(
  supabase: any,
  entry: {
    entity_type: "task" | "project" | "okr";
    entity_id: string;
    action: string;
    performed_by: string;
    desk_id?: string | null;
    changes?: any;
  }
) {
  try {
    await supabase.from("activity_log").insert({
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
      action: entry.action,
      performed_by: entry.performed_by,
      desk_id: entry.desk_id ?? null,
      changes: entry.changes ?? null,
    });
  } catch {
    /* history must never block the action itself */
  }
}

/**
 * Insert notifications for several people at once. Never throws.
 *
 * Checklist #48: a person who has muted this notification's category (or
 * every in-app notification) is skipped here rather than at read time, so
 * their bell count and list never show it in the first place.
 */
export async function notifyMany(
  supabase: any,
  userIds: string[],
  n: { task_id?: string | null; type: string; title: string; message: string }
) {
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (ids.length === 0) return;
  const prefs = await getPrefsMap(supabase, ids);
  const rows = ids
    .filter((uid) => wantsInApp(prefs.get(uid)!, n.type))
    .map((uid) => ({
      user_id: uid,
      task_id: n.task_id ?? null,
      type: n.type,
      title: n.title,
      message: n.message,
      read: false,
    }));
  if (rows.length === 0) return;
  try {
    await supabase.from("notifications").insert(rows);
  } catch {
    /* ignore */
  }
}

/** Resolve the logged-in user or return a 401 response. */
export async function requireUser(supabase: any) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user as { id: string; email?: string } | null;
}

/**
 * The people and project a task (or subtask) is given to must be on the same
 * desk. Returns a message for the first one that isn't, or null. Shared by
 * every route that writes assigned_to/task_manager_id/project_id so this
 * check can't silently drift between them (subtasks used to skip it
 * entirely - see round-2 audit).
 */
export async function notOnDesk(
  supabase: any,
  deskId: string,
  refs: { assigned_to?: any; task_manager_id?: any; project_id?: any }
): Promise<string | null> {
  for (const [key, what] of [["assigned_to", "That person"], ["task_manager_id", "That task manager"]] as const) {
    const v = refs[key];
    if (!v) continue;
    const { data } = await supabase.from("desk_members").select("user_id").eq("desk_id", deskId).eq("user_id", v).limit(1);
    if (!data || data.length === 0) return `${what} isn't on this desk`;
  }
  if (refs.project_id) {
    const { data } = await supabase.from("projects").select("desk_id").eq("id", refs.project_id).maybeSingle();
    if (!data || data.desk_id !== deskId) return "That project isn't on this desk";
  }
  return null;
}
