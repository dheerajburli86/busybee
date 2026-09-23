// app/api/tasks/route.ts
import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";
import { sendMail } from "@/lib/email";
import {
  deny,
  getMemberships,
  isForMe,
  isPrivateToSomeoneElse,
  logActivity,
  notifyMany,
  notOnDesk,
  requireUser,
  taskAccess,
  taskAudience,
  projectMemberIds,
  userProjectIds,
  visibleTasks,
} from "@/lib/permissions";
import { isFinished, PRIORITY_VALUES, STATUS_VALUES } from "@/lib/status";
import { isValidColor } from "@/components/tasks/types";
import { normalizeTimestamp } from "@/lib/format";
import { inChunks, selectAll } from "@/lib/chunks";
import { completionMove, firstSection, notifyCompleted, sectionInProject } from "@/lib/workflow";

// Fields only an assignor / task manager / project manager / supervisor may change.
const MANAGE_FIELDS = [
  "title",
  "description",
  "priority",
  "due_date",
  "start_date",
  "assigned_to",
  "milestone",
  "archived_at",
  "task_manager_id",
  "key_result_id",
  "progress_type",
  "progress_target",
  "project_id",
  "stage_id",
  "color",
];
// Fields the person doing the work may also report.
const WORK_FIELDS = ["status", "progress_percent", "progress_current", "remind_at"];

const clampPercent = (v: any) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
const validAmount = (v: any) => v === null || (typeof v === "number" && isFinite(v) && v >= 0);

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
  archived_at: "archive",
  remind_at: "reminder",
};
const label = (k: string) => FIELD_LABEL[k] || k.replace(/_/g, " ");
const labels = (keys: string[]) => Array.from(new Set(keys.map(label))).join(", ");

// #2: "remind me at" is per person (task_reminders): on a shared task everyone
// keeps their own time. Before the round-2 migration that table doesn't
// exist, and the single reminder on the task row is used as before.
const tableMissing = (error: any) =>
  !!error && (["42P01", "PGRST205"].includes(error.code) || /task_reminders/.test(error.message || "") && /not find|does not exist/i.test(error.message || ""));

/** This person's reminder times by task id, or null on an older database. */
async function myReminders(supabase: any, userId: string): Promise<Map<string, string> | null> {
  const { data, error } = await supabase.from("task_reminders").select("task_id, remind_at").eq("user_id", userId);
  if (error) {
    if (tableMissing(error)) return null;
    throw error;
  }
  return new Map((data || []).map((r: any) => [r.task_id, r.remind_at]));
}

/** Set (or with null, clear) this person's reminder. "missing" on an older database. */
async function setMyReminder(supabase: any, taskId: string, userId: string, at: string | null): Promise<"ok" | "missing"> {
  const { error } = at
    ? await supabase
        .from("task_reminders")
        .upsert({ task_id: taskId, user_id: userId, remind_at: at, sent_at: null }, { onConflict: "task_id,user_id" })
    : await supabase.from("task_reminders").delete().eq("task_id", taskId).eq("user_id", userId);
  if (error) {
    if (tableMissing(error)) return "missing";
    throw error;
  }
  return "ok";
}

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
    // No project chosen: fall back to the desk's oldest project so the task
    // still lands somewhere its members can see.
    const deskIds = memberships.map((m) => m.desk_id);
    const { data: general } = await supabase
      .from("projects")
      .select("id, desk_id")
      .in("desk_id", deskIds)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    project = general;
    if (!project) {
      const { data: created } = await supabase
        .from("projects")
        .insert({ desk_id: deskIds[0], name: "General", description: "Tasks that don't belong to a particular project" })
        .select("id, desk_id")
        .maybeSingle();
      if (created) {
        await supabase.from("stages").insert({ project_id: created.id, name: "To do", position: 0 });
        project = created;
      } else {
        const { data: oldest } = await supabase
          .from("projects")
          .select("id, desk_id")
          .in("desk_id", deskIds)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        project = oldest;
      }
    }
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

    const [visible, myProjects, reminders] = await Promise.all([
      visibleTasks(supabase, user.id, tasks || []),
      userProjectIds(supabase, user.id),
      myReminders(supabase, user.id),
    ]);

    // How many subtasks each task has, so the UI knows when progress is rolled up.
    const ids = visible.map((t: any) => t.id);
    const counts: Record<string, number> = {};
    const subs = await inChunks<any>(ids, (part) => supabase.from("subtasks").select("task_id").in("task_id", part).order("id"), { all: true });
    subs.forEach((s: any) => (counts[s.task_id] = (counts[s.task_id] || 0) + 1));

    return NextResponse.json({
      tasks: visible.map((t: any) => ({
        ...t,
        // Your own "remind me at" time, not whoever else set one on the task.
        ...(reminders ? { remind_at: reminders.get(t.id) ?? null } : {}),
        subtask_count: counts[t.id] || 0,
        for_me: isForMe(t, user.id, myProjects),
      })),
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
      stage_id,
      remind_at,
      color,
    } = body;
    // #1: an item added to "My To-Do" is private to its owner.
    const personal = body.personal === true;

    if (typeof title !== "string" || !title.trim()) return NextResponse.json({ error: "Title is required" }, { status: 400 });
    if (color && !isValidColor(color)) return NextResponse.json({ error: "Color must be a hex value like #3b82f6" }, { status: 400 });
    // DOCX #10: a task cannot exist without a due date and time.
    const due = normalizeTimestamp(due_date);
    if (!due) {
      return NextResponse.json({ error: "A due date and time is required" }, { status: 400 });
    }
    const start = start_date ? normalizeTimestamp(start_date) : null;
    if (start_date && !start) return NextResponse.json({ error: "The start date isn't a valid date" }, { status: 400 });
    const remind = remind_at ? normalizeTimestamp(remind_at) : null;
    if (remind_at && !remind) {
      return NextResponse.json({ error: "The reminder time isn't a valid date" }, { status: 400 });
    }
    if (!STATUS_VALUES.includes(status)) return NextResponse.json({ error: "Unknown status" }, { status: 400 });
    if (!PRIORITY_VALUES.includes(priority)) return NextResponse.json({ error: "Unknown priority" }, { status: 400 });

    const ctx = await resolveContext(supabase, user.id, project_id);
    if (!ctx) return NextResponse.json({ error: "No project is set up for your desk yet" }, { status: 400 });

    if (!personal) {
      const problem = await notOnDesk(supabase, ctx.desk_id, { assigned_to, project_id });
      if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    }

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
        due_date: due,
        start_date: start,
        progress_percent: clampPercent(progress_percent),
        assigned_to: personal ? user.id : assigned_to || null,
        created_by: user.id,
        color: color || null,
        ...(personal ? { personal: true } : {}),
      })
      .select("*")
      .single();

    if (error) throw error;

    if (remind && (await setMyReminder(supabase, task.id, user.id, remind)) === "missing") {
      // Older database: the reminder lives on the task row.
      await supabase.from("tasks").update({ remind_at: remind, remind_to: user.id }).eq("id", task.id);
    }
    task.remind_at = remind;

    await logActivity(supabase, {
      entity_type: "task",
      entity_id: task.id,
      action: "created the task",
      performed_by: user.id,
      desk_id: ctx.desk_id,
      changes: { title: task.title, due_date: task.due_date },
    });

    // Tell whoever the work was given to - a person and/or the whole project.
    const recipients = new Set<string>();
    if (task.assigned_to) recipients.add(task.assigned_to);
    (await projectMemberIds(supabase, task.project_id)).forEach((id) => recipients.add(id));
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
        type: "assigned",
      });
    }

    const myProjects = await userProjectIds(supabase, user.id);
    return NextResponse.json({ task: { ...task, subtask_count: 0, for_me: isForMe(task, user.id, myProjects) } });
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
      return deny("Only the assignor, task manager, project manager or a supervisor can change that.");
    }
    // Round-1 audit fix: checklist #17 / SOW #23 restrict priority changes to
    // "the assignor/supervisor", narrower than the general canManage (which
    // also includes a project manager who neither assigned nor supervises this
    // particular task). canManage above already lets the write through, so
    // add a dedicated, tighter check just for priority.
    if (Object.prototype.hasOwnProperty.call(patch, "priority") && !(access.isSuper || access.isAssignor)) {
      return deny("Only the assignor or a supervisor can change priority.");
    }
    if (touchesWork && !access.canWork) {
      return deny("Only people working on this task can update its status or progress.");
    }

    // Check the values themselves before anything is written.
    if ("title" in patch) {
      if (typeof patch.title !== "string" || !patch.title.trim()) {
        return NextResponse.json({ error: "A task needs a title" }, { status: 400 });
      }
      patch.title = patch.title.trim();
    }
    if ("description" in patch && patch.description !== null && typeof patch.description !== "string") {
      return NextResponse.json({ error: "The description must be text" }, { status: 400 });
    }
    if ("status" in patch && !STATUS_VALUES.includes(patch.status)) {
      return NextResponse.json({ error: "Unknown status" }, { status: 400 });
    }
    if ("priority" in patch && !PRIORITY_VALUES.includes(patch.priority)) {
      return NextResponse.json({ error: "Unknown priority" }, { status: 400 });
    }
    if ("progress_percent" in patch) patch.progress_percent = clampPercent(patch.progress_percent);
    for (const k of ["progress_current", "progress_target"]) {
      if (k in patch && !validAmount(patch[k])) {
        return NextResponse.json({ error: "Progress numbers can't be negative" }, { status: 400 });
      }
    }
    // Checklist #19: an optional custom color accent - "" clears it.
    if ("color" in patch) {
      if (patch.color && !isValidColor(patch.color)) {
        return NextResponse.json({ error: "Color must be a hex value like #3b82f6" }, { status: 400 });
      }
      patch.color = patch.color || null;
    }
    if ("project_id" in patch && !patch.project_id) {
      return NextResponse.json({ error: "A task must stay in a project" }, { status: 400 });
    }
    if (patch.due_date === null || patch.due_date === "") {
      return NextResponse.json({ error: "A task must keep a due date" }, { status: 400 });
    }
    if ("due_date" in patch) {
      const due = normalizeTimestamp(patch.due_date);
      if (!due) return NextResponse.json({ error: "That due date isn't a valid date" }, { status: 400 });
      patch.due_date = due;
    }
    if ("start_date" in patch && patch.start_date) {
      const start = normalizeTimestamp(patch.start_date);
      if (!start) return NextResponse.json({ error: "That start date isn't a valid date" }, { status: 400 });
      patch.start_date = start;
    } else if ("start_date" in patch) {
      patch.start_date = null;
    }
    {
      const problem = await notOnDesk(supabase, before.desk_id, patch);
      if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    }
    // "Remind me at" is this person's own reminder, not a change to the task:
    // no history entry, no notification, nobody else's reminder replaced.
    let myReminder: string | null | undefined;
    if ("remind_at" in patch) {
      let at: string | null = null;
      if (patch.remind_at) {
        at = normalizeTimestamp(patch.remind_at);
        if (!at) return NextResponse.json({ error: "The reminder time isn't a valid date" }, { status: 400 });
      }
      if ((await setMyReminder(supabase, id, user.id, at)) === "ok") {
        myReminder = at;
        delete patch.remind_at;
      } else {
        // Older database: the reminder lives on the task row, for whoever set it last.
        patch.remind_at = at;
        patch.remind_to = at ? user.id : null;
        patch.reminder_sent_at = null;
      }
      if (Object.keys(patch).length === 0) {
        const [{ count }, myProjects] = await Promise.all([
          supabase.from("subtasks").select("id", { count: "exact", head: true }).eq("task_id", id),
          userProjectIds(supabase, user.id),
        ]);
        return NextResponse.json({
          task: { ...before, remind_at: myReminder ?? null, subtask_count: count || 0, for_me: isForMe(before, user.id, myProjects) },
        });
      }
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
        // Finished work is 100% done (with subtasks, progress follows them).
        if ((subCount || 0) === 0) patch.progress_percent = 100;
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

    // Assignment: a person, or everyone in a newly chosen project.
    const newlyAssigned = new Set<string>();
    if (changes.assigned_to && task.assigned_to) newlyAssigned.add(task.assigned_to);
    if (changes.project_id) {
      (await projectMemberIds(supabase, task.project_id)).forEach((x) => newlyAssigned.add(x));
    }
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
        type: "assigned",
      });
    }

    // The person the work was taken from hears about it too.
    if (changes.assigned_to && before.assigned_to && before.assigned_to !== user.id && before.assigned_to !== task.assigned_to) {
      await notifyMany(supabase, [before.assigned_to], {
        task_id: id,
        type: "updated",
        title: "Task reassigned",
        message: `${task.title} was given to someone else`,
      });
    }

    const audience = (await taskAudience(supabase, task)).filter((x) => x !== user.id);

    // SOW #20: completion goes to everyone connected to the task.
    if (changes.status && isFinished(task.status) && !isFinished(before.status)) {
      await notifyCompleted(supabase, task, user.id);
    } else {
      // SOW #2: tell the project when something meaningful changes.
      const meaningful = Object.keys(changes).filter(
        (k) => !["assigned_to", "project_id", "remind_at"].includes(k)
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

    const [{ count }, myProjects, reminders] = await Promise.all([
      supabase.from("subtasks").select("id", { count: "exact", head: true }).eq("task_id", id),
      userProjectIds(supabase, user.id),
      myReminder === undefined ? myReminders(supabase, user.id) : Promise.resolve(null),
    ]);
    const shownReminder =
      myReminder !== undefined ? myReminder : reminders ? reminders.get(id) ?? null : task.remind_at ?? null;

    return NextResponse.json({
      task: { ...task, remind_at: shownReminder, subtask_count: count || 0, for_me: isForMe(task, user.id, myProjects) },
    });
  } catch (error: any) {
    console.error("PUT /api/tasks failed:", error);
    return NextResponse.json({ error: error?.message || "Failed to update task" }, { status: 500 });
  }
}

// #1: the owner of a private to-do item can delete it. Shared work is archived
// instead (never deleted) so its history and the reports keep it.
export async function DELETE(request: NextRequest) {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const id = body?.id;
    if (!id || typeof id !== "string") return NextResponse.json({ error: "Task ID is required" }, { status: 400 });

    const access = await taskAccess(supabase, user.id, id);
    if (!access) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    const task = access.task;

    // #1: personal to-do items can be deleted only by their owner.
    // Project tasks can be deleted only by those who can manage them (assignor/supervisor).
    if (task.personal) {
      if (isPrivateToSomeoneElse(task, user.id)) {
        return deny("Only your own private to-do items can be deleted.");
      }
    } else {
      if (!access.canManage) {
        return deny("Only the assignor or a supervisor can delete this task.");
      }
    }

    // Stored files first (the storage rule finds a file through its row),
    // then everything that hangs off the item.
    const { data: files } = await supabase.from("attachments").select("storage_path").eq("task_id", id);
    const paths = (files || []).map((f: any) => f.storage_path).filter(Boolean);
    if (paths.length) await supabase.storage.from("task-files").remove(paths);
    for (const table of ["attachments", "subtasks", "comments", "task_assignors", "extension_requests", "task_dependencies", "task_reminders"]) {
      await supabase.from(table).delete().eq("task_id", id);
    }
    await supabase.from("task_dependencies").delete().eq("depends_on_task_id", id);
    await supabase.from("notifications").delete().eq("task_id", id);
    await supabase.from("activity_log").delete().eq("entity_type", "task").eq("entity_id", id);

    const { error } = await supabase.from("tasks").delete().eq("id", id);
    if (error) {
      console.error("DELETE /api/tasks failed:", error);
      return NextResponse.json({ error: "Could not delete task. It may have dependencies that prevent deletion." }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("DELETE /api/tasks failed:", error);
    return NextResponse.json({ error: error?.message || "Could not delete the item" }, { status: 500 });
  }
}
