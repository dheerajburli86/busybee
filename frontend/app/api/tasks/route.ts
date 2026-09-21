// app/api/tasks/route.ts
import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";
import { sendMail } from "@/lib/email";
import {
  deny,
  getMemberships,
  isForMe,
  logActivity,
  notifyMany,
  requireUser,
  taskAccess,
  taskAudience,
  unitMemberIds,
  userUnits,
  visibleTasks,
} from "@/lib/permissions";
import { isFinished } from "@/lib/status";
import { inChunks, selectAll } from "@/lib/chunks";
import { completionMove, firstSection, notifyCompleted, sectionInProject } from "@/lib/workflow";

// Fields only an assignor / task manager / team manager / supervisor may change.
const MANAGE_FIELDS = [
  "title",
  "description",
  "priority",
  "due_date",
  "start_date",
  "assigned_to",
  "milestone",
  "archived_at",
  "team_id",
  "department_id",
  "group_id",
  "task_manager_id",
  "key_result_id",
  "progress_type",
  "progress_target",
  "project_id",
  "stage_id",
];
// Fields the person doing the work may also report.
const WORK_FIELDS = ["status", "progress_percent", "progress_current", "remind_at"];

const validDate = (v: any) => typeof v === "string" && !isNaN(new Date(v).getTime());

// Plain words for change notifications and history.
const FIELD_LABEL: Record<string, string> = {
  due_date: "due date",
  start_date: "start date",
  assigned_to: "assignee",
  task_manager_id: "task manager",
  key_result_id: "OKR link",
  progress_percent: "progress",
  progress_current: "progress",
  progress_target: "target",
  progress_type: "progress measure",
  project_id: "project",
  stage_id: "section",
  team_id: "team",
  department_id: "department",
  group_id: "group",
  archived_at: "archive",
  remind_at: "reminder",
};
const label = (k: string) => FIELD_LABEL[k] || k.replace(/_/g, " ");
const labels = (keys: string[]) => Array.from(new Set(keys.map(label))).join(", ");

async function resolveContext(supabase: any, userId: string, projectId?: string | null) {
  const memberships = await getMemberships(supabase, userId);
  if (memberships.length === 0) return null;

  let project: any = null;
  if (projectId) {
    const { data } = await supabase
      .from("projects")
      .select("id, desk_id")
      .eq("id", projectId)
      .maybeSingle();
    if (!data || !memberships.some((m) => m.desk_id === data.desk_id)) return null;
    project = data;
  } else {
    const { data } = await supabase
      .from("projects")
      .select("id, desk_id")
      .in("desk_id", memberships.map((m) => m.desk_id))
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    project = data;
  }
  if (!project) return null;

  return { desk_id: project.desk_id, project_id: project.id, memberships };
}

export async function GET(request: NextRequest) {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // ?archived=only -> archived tasks, ?archived=all -> both, default -> live only.
    const archived = request.nextUrl.searchParams.get("archived");

    const memberships = await getMemberships(supabase, user.id);
    const deskIds = memberships.map((m) => m.desk_id);
    if (deskIds.length === 0) return NextResponse.json({ tasks: [] });

    const tasks = await selectAll<any>(() => {
      let q = supabase.from("tasks").select("*").in("desk_id", deskIds);
      if (archived === "only") q = q.not("archived_at", "is", null);
      else if (archived !== "all") q = q.is("archived_at", null);
      return q.order("created_at", { ascending: false }).order("id");
    });

    const [visible, units] = await Promise.all([visibleTasks(supabase, user.id, tasks || []), userUnits(supabase, user.id)]);

    // How many subtasks each task has, so the UI knows when progress is rolled up.
    const ids = visible.map((t: any) => t.id);
    const counts: Record<string, number> = {};
    const subs = await inChunks<any>(ids, (part) => supabase.from("subtasks").select("task_id").in("task_id", part).order("id"), { all: true });
    subs.forEach((s: any) => (counts[s.task_id] = (counts[s.task_id] || 0) + 1));

    return NextResponse.json({
      tasks: visible.map((t: any) => ({ ...t, subtask_count: counts[t.id] || 0, for_me: isForMe(t, user.id, units) })),
    });
  } catch (error: any) {
    console.error("GET /api/tasks failed:", error);
    return NextResponse.json({ error: error?.message || "Failed to fetch tasks" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const {
      title,
      description,
      priority = "medium",
      status = "pending",
      due_date,
      start_date,
      progress_percent = 0,
      project_id,
      assigned_to,
      team_id,
      department_id,
      group_id,
      stage_id,
      remind_at,
    } = body;
    // #1: an item added to "My To-Do" is private to its owner.
    const personal = body.personal === true;

    if (!title || !title.trim()) return NextResponse.json({ error: "Title is required" }, { status: 400 });
    // DOCX #10: a task cannot exist without a due date and time.
    if (!due_date || !validDate(due_date)) {
      return NextResponse.json({ error: "A due date and time is required" }, { status: 400 });
    }
    if (remind_at && !validDate(remind_at)) {
      return NextResponse.json({ error: "The reminder time isn't a valid date" }, { status: 400 });
    }

    const ctx = await resolveContext(supabase, user.id, project_id);
    if (!ctx) return NextResponse.json({ error: "No project is set up for your desk yet" }, { status: 400 });

    // #20: the task goes into the chosen section of its project, or the first one.
    let section: string | null = null;
    if (stage_id) {
      if (!(await sectionInProject(supabase, stage_id, ctx.project_id))) {
        return NextResponse.json({ error: "That section isn't part of the project" }, { status: 400 });
      }
      section = stage_id;
    } else {
      section = await firstSection(supabase, ctx.project_id);
    }

    const { data: task, error } = await supabase
      .from("tasks")
      .insert({
        desk_id: ctx.desk_id,
        project_id: ctx.project_id,
        stage_id: section,
        title: title.trim(),
        description: description || null,
        priority,
        status,
        due_date,
        start_date: start_date || null,
        progress_percent,
        assigned_to: personal ? user.id : assigned_to || null,
        team_id: personal ? null : team_id || null,
        department_id: personal ? null : department_id || null,
        group_id: personal ? null : group_id || null,
        created_by: user.id,
        ...(personal ? { personal: true } : {}),
        ...(remind_at ? { remind_at, remind_to: user.id } : {}),
      })
      .select("*")
      .single();

    if (error) throw error;

    await logActivity(supabase, {
      entity_type: "task",
      entity_id: task.id,
      action: "created the task",
      performed_by: user.id,
      desk_id: ctx.desk_id,
      changes: { title: task.title, due_date: task.due_date },
    });

    // Tell whoever the work was given to - a person and/or a whole unit.
    const recipients = new Set<string>();
    if (task.assigned_to) recipients.add(task.assigned_to);
    (await unitMemberIds(supabase, { teamId: task.team_id, departmentId: task.department_id, groupId: task.group_id })).forEach(
      (id) => recipients.add(id)
    );
    recipients.delete(user.id);
    if (recipients.size) {
      await notifyMany(supabase, Array.from(recipients), {
        task_id: task.id,
        type: "assigned",
        title: "New task assigned",
        message: `You were assigned: ${task.title}`,
      });
      await sendMail({
        userIds: Array.from(recipients),
        subject: `New task assigned: ${task.title}`,
        body: `You were assigned: ${task.title}`,
      });
    }

    const units = await userUnits(supabase, user.id);
    return NextResponse.json({ task: { ...task, subtask_count: 0, for_me: isForMe(task, user.id, units) } });
  } catch (error: any) {
    console.error("POST /api/tasks failed:", error);
    return NextResponse.json({ error: error?.message || "Failed to create task" }, { status: 500 });
  }
}

// PUT - Update task
export async function PUT(request: NextRequest) {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const { id } = body;
    if (!id) return NextResponse.json({ error: "Task ID is required" }, { status: 400 });

    const access = await taskAccess(supabase, user.id, id);
    if (!access) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    const before = access.task;

    const patch: Record<string, any> = {};
    for (const field of [...MANAGE_FIELDS, ...WORK_FIELDS]) {
      if (Object.prototype.hasOwnProperty.call(body, field)) patch[field] = body[field];
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
    }

    const touchesManage = Object.keys(patch).some((k) => MANAGE_FIELDS.includes(k));
    const touchesWork = Object.keys(patch).some((k) => WORK_FIELDS.includes(k));

    if (touchesManage && !access.canManage) {
      // DOCX #2 / #10: the assignee cannot move their own deadline.
      if (Object.prototype.hasOwnProperty.call(patch, "due_date")) {
        return deny("Only the assignor or a supervisor can change a due date. Request an extension instead.");
      }
      return deny("Only the assignor, task manager, team manager or a supervisor can change that.");
    }
    // Round-1 audit fix: checklist #17 / SOW #23 restrict priority changes to
    // "the assignor/supervisor", narrower than the general canManage (which
    // also includes a team manager who neither assigned nor supervises this
    // particular task). canManage above already lets the write through, so
    // add a dedicated, tighter check just for priority.
    if (Object.prototype.hasOwnProperty.call(patch, "priority") && !(access.isSuper || access.isAssignor)) {
      return deny("Only the assignor or a supervisor can change priority.");
    }
    if (touchesWork && !access.canWork) {
      return deny("Only people working on this task can update its status or progress.");
    }
    if (patch.due_date === null || patch.due_date === "") {
      return NextResponse.json({ error: "A task must keep a due date" }, { status: 400 });
    }
    if ("due_date" in patch && !validDate(patch.due_date)) {
      return NextResponse.json({ error: "That due date isn't a valid date" }, { status: 400 });
    }
    if ("remind_at" in patch) {
      if (patch.remind_at && !validDate(patch.remind_at)) {
        return NextResponse.json({ error: "The reminder time isn't a valid date" }, { status: 400 });
      }
      patch.remind_at = patch.remind_at || null;
      // The reminder goes to whoever set it.
      patch.remind_to = patch.remind_at ? user.id : null;
      patch.reminder_sent_at = null;
    }
    if (patch.project_id) {
      const memberships = await getMemberships(supabase, user.id);
      const { data: p } = await supabase.from("projects").select("desk_id").eq("id", patch.project_id).maybeSingle();
      if (!p || p.desk_id !== before.desk_id || !memberships.some((m) => m.desk_id === p.desk_id)) {
        return NextResponse.json({ error: "Unknown project" }, { status: 400 });
      }
    }
    // #20: a section always belongs to the task's project. Moving to another
    // project lands the task in that project's first section unless one is given.
    const projectAfter = patch.project_id || before.project_id;
    if (patch.stage_id) {
      if (!projectAfter || !(await sectionInProject(supabase, patch.stage_id, projectAfter))) {
        return NextResponse.json({ error: "That section isn't part of the task's project" }, { status: 400 });
      }
    } else if ("stage_id" in patch) {
      return NextResponse.json({ error: "A task must stay in a section" }, { status: 400 });
    } else if (patch.project_id && patch.project_id !== before.project_id) {
      patch.stage_id = await firstSection(supabase, patch.project_id);
    }

    // Checklist #37 / SOW #34: when progress is measured as a count or an
    // amount, the percentage follows from what the assignee reports. When the
    // task has subtasks, the percentage is rolled up from them instead.
    const { count: subCount } = await supabase
      .from("subtasks")
      .select("id", { count: "exact", head: true })
      .eq("task_id", id);
    if ((subCount || 0) > 0) {
      delete patch.progress_percent;
    } else {
      const type = patch.progress_type ?? before.progress_type;
      const target = Number(patch.progress_target ?? before.progress_target) || 0;
      const current = Number(patch.progress_current ?? before.progress_current) || 0;
      if ((type === "number" || type === "amount") && target > 0 &&
          ["progress_type", "progress_target", "progress_current"].some((k) => k in patch)) {
        // Round-1 audit fix: clamp the lower bound too (a negative
        // progress_current - e.g. a typo - previously produced a negative
        // percent, which then dragged down project-level averages).
        patch.progress_percent = Math.max(0, Math.min(100, Math.round((current / target) * 100)));
      }
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "Progress is calculated from the subtasks" }, { status: 400 });
    }

    // Checklist #14: remember when work was finished, and forget it if reopened.
    if (Object.prototype.hasOwnProperty.call(patch, "status")) {
      if (isFinished(patch.status) && !isFinished(before.status)) {
        patch.completed_at = new Date().toISOString();
        // #20: completed work moves on to the next section if the project says so.
        if (!("stage_id" in patch)) Object.assign(patch, await completionMove(supabase, { ...before, ...patch }));
      }
      if (!isFinished(patch.status)) patch.completed_at = null;
    }

    patch.updated_at = new Date().toISOString();

    const { data: task, error } = await supabase
      .from("tasks")
      .update(patch)
      .eq("id", id)
      .select("*")
      .single();

    if (error) throw error;
    if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    // Checklist #41: record exactly what changed, before and after.
    const changes: Record<string, { from: any; to: any }> = {};
    Object.keys(patch)
      .filter((k) => !["updated_at", "completed_at", "reminder_sent_at", "remind_to"].includes(k))
      .forEach((k) => {
        if (before[k] !== task[k]) changes[k] = { from: before[k] ?? null, to: task[k] ?? null };
      });
    if (Object.keys(changes).length) {
      await logActivity(supabase, {
        entity_type: "task",
        entity_id: id,
        action: "changed " + labels(Object.keys(changes)),
        performed_by: user.id,
        desk_id: task.desk_id,
        changes,
      });
    }

    // Assignment: a person, or everyone in a newly chosen team/department/group.
    const newlyAssigned = new Set<string>();
    if (changes.assigned_to && task.assigned_to) newlyAssigned.add(task.assigned_to);
    const unitIds = await unitMemberIds(supabase, {
      teamId: changes.team_id ? task.team_id : null,
      departmentId: changes.department_id ? task.department_id : null,
      groupId: changes.group_id ? task.group_id : null,
    });
    unitIds.forEach((x) => newlyAssigned.add(x));
    newlyAssigned.delete(user.id);
    if (newlyAssigned.size) {
      await notifyMany(supabase, Array.from(newlyAssigned), {
        task_id: id,
        type: "assigned",
        title: "New task assigned",
        message: `You were assigned: ${task.title}`,
      });
      await sendMail({
        userIds: Array.from(newlyAssigned),
        subject: `New task assigned: ${task.title}`,
        body: `You were assigned: ${task.title}`,
      });
    }

    const audience = (await taskAudience(supabase, task)).filter((x) => x !== user.id);

    // SOW #20: completion goes to everyone connected to the task.
    if (changes.status && isFinished(task.status) && !isFinished(before.status)) {
      await notifyCompleted(supabase, task, user.id);
    } else {
      // SOW #2: tell the team when something meaningful changes.
      const meaningful = Object.keys(changes).filter(
        (k) => !["assigned_to", "team_id", "department_id", "group_id", "remind_at"].includes(k)
      );
      if (meaningful.length) {
        await notifyMany(
          supabase,
          audience.filter((x) => !newlyAssigned.has(x)),
          {
            task_id: id,
            type: "updated",
            title: "Task updated",
            message: `${labels(meaningful)} changed on: ${task.title}`,
          }
        );
      }
    }

    const [{ count }, units] = await Promise.all([
      supabase.from("subtasks").select("id", { count: "exact", head: true }).eq("task_id", id),
      userUnits(supabase, user.id),
    ]);

    return NextResponse.json({ task: { ...task, subtask_count: count || 0, for_me: isForMe(task, user.id, units) } });
  } catch (error: any) {
    console.error("PUT /api/tasks failed:", error);
    return NextResponse.json({ error: error?.message || "Failed to update task" }, { status: 500 });
  }
}
