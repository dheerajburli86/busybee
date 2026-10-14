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

import { after, NextResponse } from "next/server";
import { selectAll } from "@/lib/chunks";
import { Alert, AlertResult, sendAlert } from "@/lib/alerts";
import { remembered, tokenExpiry } from "@/lib/serverCache";

// How long a person's desk, projects and teams are reused between API calls.
// Changes to any of them clear it at once (forgetAccess in lib/serverCache).
const ACCESS_TTL = 10_000;

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
  const list = await remembered<Membership[]>(
    supabase,
    `m:${userId}`,
    ACCESS_TTL,
    async () => {
      const { data } = await supabase.from("desk_members").select("desk_id, role").eq("user_id", userId);
      return (data || []).map((m: any) => ({ desk_id: m.desk_id as string, role: normalizeRole(m.role) }));
    },
    // Someone not let onto a desk yet is checked afresh every time, so the
    // moment a supervisor adds them, they're in.
    (v) => v.length > 0
  );
  return list.map((m) => ({ ...m }));
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
  const ids = await remembered(supabase, `pm:${userId}`, ACCESS_TTL, async () => {
    const [{ data: led }, { data: asMember }] = await Promise.all([
      supabase.from("projects").select("id").eq("manager_id", userId),
      supabase.from("project_members").select("project_id").eq("user_id", userId).eq("role", "manager"),
    ]);
    return Array.from(
      new Set<string>([...(led || []).map((p: any) => p.id), ...(asMember || []).map((p: any) => p.project_id)])
    );
  });
  return [...ids];
}

/** Project ids the user is a member of, whatever their role on them. */
export async function userProjectIds(supabase: any, userId: string): Promise<string[]> {
  const ids = await remembered(supabase, `pj:${userId}`, ACCESS_TTL, async () => {
    const { data } = await supabase.from("project_members").select("project_id").eq("user_id", userId);
    return Array.from(new Set<string>((data || []).map((p: any) => p.project_id).filter(Boolean)));
  });
  return [...ids];
}

/**
 * SOW #41/#29: team and group ids the user belongs to. A task given to a team
 * is a task every member of that team is expected to see and work on, so this
 * feeds both visibility and the notification audience.
 *
 * The teams tables arrived after the rest of the app, so a database that
 * hasn't had the migration run yet must not break every task query - an error
 * here means "no teams", not a failed request.
 */
export async function userTeamIds(supabase: any, userId: string): Promise<string[]> {
  const ids = await remembered(supabase, `tm:${userId}`, ACCESS_TTL, async () => {
    try {
      const { data, error } = await supabase.from("team_members").select("team_id").eq("user_id", userId);
      if (error) return [] as string[];
      return Array.from(new Set<string>((data || []).map((t: any) => t.team_id).filter(Boolean)));
    } catch {
      return [] as string[];
    }
  });
  return [...ids];
}

/** Everyone in a team or group, for assignment and notifications. */
export async function teamMemberIds(supabase: any, teamId: string | null | undefined): Promise<string[]> {
  if (!teamId) return [];
  try {
    const { data, error } = await supabase.from("team_members").select("user_id").eq("team_id", teamId);
    if (error) return [];
    return Array.from(new Set((data || []).map((t: any) => t.user_id).filter(Boolean)));
  } catch {
    return [];
  }
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

export async function taskAccess(supabase: any, userId: string, taskId: string, opts: { includeDeleted?: boolean } = {}): Promise<TaskAccess | null> {
  const [{ data: task }, memberships] = await Promise.all([
    supabase.from("tasks").select("*").eq("id", taskId).maybeSingle(),
    getMemberships(supabase, userId),
  ]);
  if (!task) return null;
  // Deleted (waiting 30 days before it's removed for good): gone, except to Undo.
  if (task.deleted_at && !opts.includeDeleted) return null;
  if (isPrivateToSomeoneElse(task, userId)) return null;
  if (!memberships.some((m) => m.desk_id === task.desk_id)) return null;

  const role = roleIn(memberships, task.desk_id);
  const isSuper = SUPER_ROLES.includes(role);

  const [{ data: extra }, { data: subs }, managed, myProjects, myTeams] = await Promise.all([
    supabase.from("task_assignors").select("user_id").eq("task_id", taskId),
    supabase.from("subtasks").select("assigned_to").eq("task_id", taskId),
    managedProjectIds(supabase, userId),
    userProjectIds(supabase, userId),
    userTeamIds(supabase, userId),
  ]);

  const isAssignor =
    task.created_by === userId ||
    task.task_manager_id === userId ||
    (extra || []).some((a: any) => a.user_id === userId);

  // Checklist #22: whoever runs this task's project runs its tasks too.
  const isProjectManager = !!task.project_id && managed.includes(task.project_id);

  // SOW #29: a task given to a team is work for everyone in that team, the
  // same as if they had been named on it individually.
  //
  // Being in the task's project lets you SEE it. It only lets you WORK on it
  // when it's open to the project (nobody named): a task given to one person
  // is that person's copy - a colleague mustn't be able to mark it done or
  // ask for more time on it, since review and pay hang off it.
  const inProject = !!task.project_id && myProjects.includes(task.project_id);
  const isWorker =
    task.assigned_to === userId ||
    (subs || []).some((s: any) => s.assigned_to === userId) ||
    (!!task.team_id && myTeams.includes(task.team_id)) ||
    (inProject && !task.assigned_to);

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
    canView: canWork || inProject,
  };
}

/**
 * Filter a list of desk tasks down to the ones this user may see.
 * Supervisors/admins see everything on their desks; everyone else sees work
 * they created, manage, do, or that sits in a project they belong to.
 */
export type VisibilitySets = { extraIds: Set<string>; subIds: Set<string>; projectIds: Set<string>; teamIds: Set<string> };

/**
 * Everything besides their role that lets this person see a task: tasks they
 * were added to as an assignor, tasks with an item given to them, and their
 * projects and teams. Looked up once per request; start it alongside the
 * task query so both arrive together.
 */
export function visibilitySets(supabase: any, userId: string): Promise<VisibilitySets> {
  return remembered(supabase, `vis:${userId}`, 0, async () => {
    // Filtered by person only - a list of every task id would not fit in a URL.
    const [extra, subs, managed, myProjects, myTeams] = await Promise.all([
      selectAll<any>(() => supabase.from("task_assignors").select("task_id").eq("user_id", userId).order("id")),
      selectAll<any>(() => supabase.from("subtasks").select("task_id").eq("assigned_to", userId).order("id")),
      managedProjectIds(supabase, userId),
      userProjectIds(supabase, userId),
      userTeamIds(supabase, userId),
    ]);
    return {
      extraIds: new Set<string>((extra || []).map((x: any) => x.task_id)),
      subIds: new Set<string>((subs || []).map((x: any) => x.task_id)),
      // Checklist #22: projects this user manages, plus the ones they are on.
      projectIds: new Set<string>([...managed, ...myProjects]),
      // SOW #29: plus anything handed to a team or group they belong to.
      teamIds: new Set<string>(myTeams),
    };
  });
}

/** The tasks this person may see, given their desks and visibilitySets(). */
export function filterVisible(tasks: any[], userId: string, memberships: Membership[], sets: VisibilitySets): any[] {
  return tasks.filter((t) => {
    if (isPrivateToSomeoneElse(t, userId)) return false;
    const role = roleIn(memberships, t.desk_id);
    if (SUPER_ROLES.includes(role)) return true;
    return (
      t.created_by === userId ||
      t.assigned_to === userId ||
      t.task_manager_id === userId ||
      sets.extraIds.has(t.id) ||
      sets.subIds.has(t.id) ||
      (!!t.team_id && sets.teamIds.has(t.team_id)) ||
      (!!t.project_id && sets.projectIds.has(t.project_id))
    );
  });
}

export async function visibleTasks(supabase: any, userId: string, tasks: any[]): Promise<any[]> {
  if (tasks.length === 0) return tasks;
  const [memberships, sets] = await Promise.all([getMemberships(supabase, userId), visibilitySets(supabase, userId)]);
  return filterVisible(tasks, userId, memberships, sets);
}

/**
 * Is this task on the person's own plate? Given to them by name, or sitting
 * unassigned in a project they are a member of.
 */
export function isForMe(task: any, userId: string, projectIds: string[], teamIds: string[] = []): boolean {
  if (task.assigned_to) return task.assigned_to === userId;
  // SOW #29: unassigned work handed to my team is on my plate as much as
  // unassigned work sitting in my project.
  if (task.team_id && teamIds.includes(task.team_id)) return true;
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
  const [projects, managed, myProjects, tasks, sets] = await Promise.all([
    selectAll<any>(() => supabase.from("projects").select("*").in("desk_id", deskIds).order("created_at", { ascending: false }).order("id")),
    managedProjectIds(supabase, userId),
    userProjectIds(supabase, userId),
    selectAll<any>(() =>
      supabase
        .from("tasks")
        .select("id, desk_id, project_id, team_id, personal, created_by, assigned_to, task_manager_id")
        .in("desk_id", deskIds)
        .is("archived_at", null)
        .order("id")
    ),
    visibilitySets(supabase, userId),
  ]);
  const withTasks = new Set(filterVisible(tasks, userId, memberships, sets).map((t: any) => t.project_id));
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

  // SOW #2/#20: "the team" means the team too, not just the named people -
  // everyone in a team the task was given to hears about changes to it.
  const [members, teammates] = await Promise.all([
    projectMemberIds(supabase, task.project_id),
    teamMemberIds(supabase, task.team_id),
  ]);
  members.forEach((x) => ids.add(x));
  teammates.forEach((x) => ids.add(x));
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

/** Run `work` just after the response has gone out (inline outside a request). */
export async function afterResponse(work: () => Promise<unknown>): Promise<void> {
  const safe = () => work().catch((err) => console.error("background work failed:", err));
  try {
    after(safe);
  } catch {
    await safe();
  }
}

/**
 * Record an action in the activity history. Never throws, and never makes
 * the person wait: it's written just after the response goes out.
 */
export async function logActivity(
  supabase: any,
  entry: {
    entity_type: "task" | "project" | "okr" | "desk";
    entity_id: string;
    action: string;
    performed_by: string;
    desk_id?: string | null;
    changes?: any;
  }
) {
  await afterResponse(async () => {
    await supabase.from("activity_log").insert({
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
      action: entry.action,
      performed_by: entry.performed_by,
      desk_id: entry.desk_id ?? null,
      changes: entry.changes ?? null,
    });
  });
}

/**
 * Insert notifications for several people at once. Never throws.
 *
 * Checklist #48: a person who has muted this notification's category (or
 * every in-app notification) is skipped here rather than at read time, so
 * their bell count and list never show it in the first place.
 */
/**
 * Tell people about something: in the bell, by email and on Telegram, each
 * according to their own settings (see lib/alerts.ts). Never throws.
 *
 * Pass `email: { subject, body }` for a fuller email than the bell text, or
 * `email: false` to keep it to the bell and Telegram.
 */
export async function notifyMany(supabase: any, userIds: string[], n: Alert, opts: { wait?: boolean } = {}): Promise<AlertResult> {
  // Nobody waits for alerts: they go out just after the response, unless the
  // caller needs the counts (opts.wait).
  if (!opts.wait) {
    await afterResponse(() => sendAlert(supabase, userIds, n, { inline: true }));
    return { in_app: 0, email: 0, telegram: 0 };
  }
  try {
    return await sendAlert(supabase, userIds, n);
  } catch (err: any) {
    console.error("notifyMany failed:", err);
    return { in_app: 0, email: 0, telegram: 0, in_app_error: err?.message || "failed" };
  }
}

/**
 * The signed-in person, or null. The sign-in token comes from the cookie and
 * is checked with Supabase (on the spot where the project's keys allow it),
 * then trusted for up to a minute on this server, so the several calls a
 * screen makes at once don't each pay for the check.
 */
export async function requireUser(supabase: any): Promise<{ id: string; email?: string } | null> {
  let token: string | undefined;
  try {
    const { data } = await supabase.auth.getSession();
    token = data?.session?.access_token;
  } catch {
    return null;
  }
  if (!token) return null;
  const ttl = Math.min(60_000, tokenExpiry(token) - Date.now() - 5_000);
  return remembered(
    null,
    `u:${token.slice(-48)}`,
    Math.max(0, ttl),
    async () => {
      const { data, error } = await supabase.auth.getClaims(token);
      const c: any = data?.claims;
      if (error || !c?.sub) return null;
      return { id: String(c.sub), email: c.email ? String(c.email) : undefined };
    },
    (u) => !!u
  );
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
  refs: { assigned_to?: any; task_manager_id?: any; project_id?: any; team_id?: any; milestone_id?: any }
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
  // SOW #41: a task may only be handed to a team on its own desk.
  if (refs.team_id) {
    const { data, error } = await supabase.from("teams").select("desk_id").eq("id", refs.team_id).maybeSingle();
    if (error) return "Teams aren't set up yet - run the database migration";
    if (!data || data.desk_id !== deskId) return "That team isn't on this desk";
  }
  // SOW #17: and only onto a milestone of a project on this desk. Without
  // this a task could be pointed at another desk's milestone, which would
  // then show that desk an inflated task count for work it can't see.
  if (refs.milestone_id) {
    const { data, error } = await supabase
      .from("milestones")
      .select("project_id, projects(desk_id)")
      .eq("id", refs.milestone_id)
      .maybeSingle();
    if (error) return "Milestones aren't set up yet - run the database migration";
    const owner = (data as any)?.projects;
    const ownerDesk = Array.isArray(owner) ? owner[0]?.desk_id : owner?.desk_id;
    if (!data || ownerDesk !== deskId) return "That milestone isn't on this desk";
  }
  return null;
}
