// Server-side permission checks. Every write route goes through here so the
// rules live in one place instead of being re-implemented per endpoint.
//
// Roles (desk_members.role):
//   admin, supervisor  - Project Manager / super user: can manage everything
//   manager            - Team/Group manager: manages the teams they run and
//                        the tasks and projects given to those teams
//   member             - Team member: works on what they are given
//
// A person's relationship to a task adds to their role:
//   assignor   - created the task, is its task manager, or was added as an
//                extra assignor
//   worker     - is the assignee, or is assigned one of its subtasks, or
//                belongs to the team / department / group it was given to
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
  isTeamManager: boolean;
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

/** Team ids the user manages (as teams.manager_id or a 'manager' team member). */
export async function managedTeamIds(supabase: any, userId: string): Promise<string[]> {
  const [{ data: led }, { data: asMember }] = await Promise.all([
    supabase.from("teams").select("id").eq("manager_id", userId),
    supabase.from("team_members").select("team_id").eq("user_id", userId).eq("role", "manager"),
  ]);
  return Array.from(
    new Set([...(led || []).map((t: any) => t.id), ...(asMember || []).map((t: any) => t.team_id)])
  );
}

/**
 * What the user may do with a project: see it (on their desk) and manage it
 * (supervisor/admin, this project's own manager (#22), or manager of the
 * team the project is assigned to).
 */
export async function projectAccess(supabase: any, userId: string, projectId: string) {
  const { data: project } = await supabase.from("projects").select("*").eq("id", projectId).maybeSingle();
  if (!project) return null;
  const memberships = await getMemberships(supabase, userId);
  if (!memberships.some((m) => m.desk_id === project.desk_id)) return null;
  const role = roleIn(memberships, project.desk_id);
  const managed = project.team_id ? await managedTeamIds(supabase, userId) : [];
  const isProjectManager = project.manager_id === userId;
  const canManage = SUPER_ROLES.includes(role) || isProjectManager || (!!project.team_id && managed.includes(project.team_id));
  return { project, role, canManage, isProjectManager };
}

/** Team, department and group ids the user belongs to. */
export async function userUnits(supabase: any, userId: string) {
  const [{ data: tm }, { data: gm }] = await Promise.all([
    supabase.from("team_members").select("team_id").eq("user_id", userId),
    supabase.from("group_members").select("group_id").eq("user_id", userId),
  ]);
  const teamIds: string[] = (tm || []).map((t: any) => t.team_id);
  let departmentIds: string[] = [];
  if (teamIds.length) {
    const { data: teams } = await supabase.from("teams").select("department_id").in("id", teamIds);
    departmentIds = Array.from(
      new Set((teams || []).map((t: any) => t.department_id).filter(Boolean))
    ) as string[];
  }
  return { teamIds, departmentIds, groupIds: (gm || []).map((g: any) => g.group_id) as string[] };
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

  const [{ data: extra }, { data: subs }, managed, units, project] = await Promise.all([
    supabase.from("task_assignors").select("user_id").eq("task_id", taskId),
    supabase.from("subtasks").select("assigned_to").eq("task_id", taskId),
    managedTeamIds(supabase, userId),
    userUnits(supabase, userId),
    task.project_id
      ? supabase.from("projects").select("team_id, manager_id").eq("id", task.project_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const isAssignor =
    task.created_by === userId ||
    task.task_manager_id === userId ||
    (extra || []).some((a: any) => a.user_id === userId);

  const projectTeam = (project as any)?.data?.team_id ?? null;
  // Checklist #22: whoever is named this project's manager runs its tasks too,
  // independent of any team.
  const isProjectManager = (project as any)?.data?.manager_id === userId;
  // Whoever is named manager of the task's team (or its project's team) runs it.
  const isTeamManager =
    (task.team_id && managed.includes(task.team_id)) || (projectTeam && managed.includes(projectTeam));

  const isWorker =
    task.assigned_to === userId ||
    (subs || []).some((s: any) => s.assigned_to === userId) ||
    (task.team_id && units.teamIds.includes(task.team_id)) ||
    (task.department_id && units.departmentIds.includes(task.department_id)) ||
    (task.group_id && units.groupIds.includes(task.group_id)) ||
    (projectTeam && units.teamIds.includes(projectTeam));

  const canManage = isSuper || isAssignor || !!isTeamManager || isProjectManager;
  const canWork = canManage || !!isWorker;

  return {
    task,
    role,
    isSuper,
    isAssignor,
    isTeamManager: !!isTeamManager,
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
 * they created, manage, do, or that was given to a unit they belong to.
 */
export async function visibleTasks(supabase: any, userId: string, tasks: any[]): Promise<any[]> {
  if (tasks.length === 0) return tasks;
  const memberships = await getMemberships(supabase, userId);

  // Filtered by person only - a list of every task id would not fit in a URL.
  const [extra, subs, managed, units, projects] = await Promise.all([
    selectAll<any>(() => supabase.from("task_assignors").select("task_id").eq("user_id", userId).order("id")),
    selectAll<any>(() => supabase.from("subtasks").select("task_id").eq("assigned_to", userId).order("id")),
    managedTeamIds(supabase, userId),
    userUnits(supabase, userId),
    selectAll<any>(() => supabase.from("projects").select("id, team_id, manager_id").in("desk_id", memberships.map((m) => m.desk_id)).order("id")),
  ]);

  const extraIds = new Set((extra || []).map((x: any) => x.task_id));
  const subIds = new Set((subs || []).map((x: any) => x.task_id));
  const projectTeam = new Map<string, string | null>(
    (projects || []).map((p: any) => [p.id, p.team_id ?? null])
  );
  // Checklist #22: projects this user manages, independent of any team.
  const managedProjects = new Set(
    (projects || []).filter((p: any) => p.manager_id === userId).map((p: any) => p.id)
  );

  return tasks.filter((t) => {
    if (isPrivateToSomeoneElse(t, userId)) return false;
    const role = roleIn(memberships, t.desk_id);
    if (SUPER_ROLES.includes(role)) return true;
    const pTeam = t.project_id ? projectTeam.get(t.project_id) ?? null : null;
    return (
      t.created_by === userId ||
      t.assigned_to === userId ||
      t.task_manager_id === userId ||
      extraIds.has(t.id) ||
      subIds.has(t.id) ||
      (t.team_id && (units.teamIds.includes(t.team_id) || managed.includes(t.team_id))) ||
      (t.department_id && units.departmentIds.includes(t.department_id)) ||
      (t.group_id && units.groupIds.includes(t.group_id)) ||
      (pTeam && (units.teamIds.includes(pTeam) || managed.includes(pTeam))) ||
      (t.project_id && managedProjects.has(t.project_id))
    );
  });
}

/**
 * Is this task on the person's own plate? Given to them by name, or given to
 * a team, department or group they belong to with nobody named.
 */
export function isForMe(
  task: any,
  userId: string,
  units: { teamIds: string[]; departmentIds: string[]; groupIds: string[] }
): boolean {
  if (task.assigned_to) return task.assigned_to === userId;
  return (
    (!!task.team_id && units.teamIds.includes(task.team_id)) ||
    (!!task.department_id && units.departmentIds.includes(task.department_id)) ||
    (!!task.group_id && units.groupIds.includes(task.group_id))
  );
}

/**
 * Projects the user can see: supervisors see all on their desks; others see
 * unassigned projects, their teams' projects, and any project holding a task
 * they can see. `can_manage` marks the ones they run.
 */
export async function visibleProjects(supabase: any, userId: string): Promise<any[]> {
  const memberships = await getMemberships(supabase, userId);
  const deskIds = memberships.map((m) => m.desk_id);
  if (!deskIds.length) return [];
  const [projects, managed, units, tasks] = await Promise.all([
    selectAll<any>(() => supabase.from("projects").select("*").in("desk_id", deskIds).order("created_at", { ascending: false }).order("id")),
    managedTeamIds(supabase, userId),
    userUnits(supabase, userId),
    selectAll<any>(() => supabase.from("tasks").select("*").in("desk_id", deskIds).is("archived_at", null).order("id")),
  ]);
  const withTasks = new Set((await visibleTasks(supabase, userId, tasks)).map((t: any) => t.project_id));
  return projects
    .filter((p: any) => {
      if (SUPER_ROLES.includes(roleIn(memberships, p.desk_id))) return true;
      if (p.manager_id === userId) return true;
      if (!p.team_id) return true;
      return managed.includes(p.team_id) || units.teamIds.includes(p.team_id) || withTasks.has(p.id);
    })
    .map((p: any) => ({
      ...p,
      can_manage:
        SUPER_ROLES.includes(roleIn(memberships, p.desk_id)) ||
        p.manager_id === userId ||
        (!!p.team_id && managed.includes(p.team_id)),
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

  const unitMembers = await unitMemberIds(supabase, {
    teamId: task.team_id,
    departmentId: task.department_id,
    groupId: task.group_id,
  });
  unitMembers.forEach((x) => ids.add(x));
  return Array.from(ids);
}

/** Members of a team, department (all its teams) and/or custom group. */
export async function unitMemberIds(
  supabase: any,
  units: { teamId?: string | null; departmentId?: string | null; groupId?: string | null }
): Promise<string[]> {
  const ids = new Set<string>();
  const teamIds: string[] = [];
  if (units.teamId) teamIds.push(units.teamId);
  if (units.departmentId) {
    const { data } = await supabase.from("teams").select("id").eq("department_id", units.departmentId);
    (data || []).forEach((t: any) => teamIds.push(t.id));
  }
  if (teamIds.length) {
    const { data } = await supabase.from("team_members").select("user_id").in("team_id", teamIds);
    (data || []).forEach((m: any) => m.user_id && ids.add(m.user_id));
    const { data: mgrs } = await supabase.from("teams").select("manager_id").in("id", teamIds);
    (mgrs || []).forEach((m: any) => m.manager_id && ids.add(m.manager_id));
  }
  if (units.groupId) {
    const { data } = await supabase.from("group_members").select("user_id").eq("group_id", units.groupId);
    (data || []).forEach((m: any) => m.user_id && ids.add(m.user_id));
  }
  return Array.from(ids);
}

/** Record an action in the activity history. Never throws. */
export async function logActivity(
  supabase: any,
  entry: {
    entity_type: "task" | "project" | "team" | "department" | "group" | "okr";
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
 * The people and units a task (or subtask) is given to must be on the same
 * desk. Returns a message for the first one that isn't, or null. Shared by
 * every route that writes assigned_to/task_manager_id/team_id/etc. so this
 * check can't silently drift between them (subtasks used to skip it
 * entirely - see round-2 audit).
 */
export async function notOnDesk(
  supabase: any,
  deskId: string,
  refs: { assigned_to?: any; task_manager_id?: any; team_id?: any; department_id?: any; group_id?: any }
): Promise<string | null> {
  for (const [key, what] of [["assigned_to", "That person"], ["task_manager_id", "That task manager"]] as const) {
    const v = refs[key];
    if (!v) continue;
    const { data } = await supabase.from("desk_members").select("user_id").eq("desk_id", deskId).eq("user_id", v).limit(1);
    if (!data || data.length === 0) return `${what} isn't on this desk`;
  }
  for (const [key, table, what] of [
    ["team_id", "teams", "That team"],
    ["department_id", "departments", "That department"],
    ["group_id", "groups", "That group"],
  ] as const) {
    const v = refs[key];
    if (!v) continue;
    const { data } = await supabase.from(table).select("desk_id").eq("id", v).maybeSingle();
    if (!data || data.desk_id !== deskId) return `${what} isn't on this desk`;
  }
  return null;
}
