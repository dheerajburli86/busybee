// app/api/tasks/route.ts
import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";

async function resolveContext(supabase: any, userId: string) {
  const { data: membership } = await supabase
    .from("desk_members")
    .select("desk_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();

  if (!membership) return null;

  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("desk_id", membership.desk_id)
    .limit(1)
    .maybeSingle();

  if (!project) return null;

  const { data: stage } = await supabase
    .from("stages")
    .select("id")
    .eq("project_id", project.id)
    .order("position", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!stage) return null;

  return {
    desk_id: membership.desk_id,
    project_id: project.id,
    stage_id: stage.id,
  };
}

export async function GET() {
  try {
    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: memberships } = await supabase
      .from("desk_members")
      .select("desk_id")
      .eq("user_id", user.id);

    const deskIds = (memberships || []).map((m: any) => m.desk_id);
    if (deskIds.length === 0) return NextResponse.json({ tasks: [] });

    const { data: tasks, error } = await supabase
      .from("tasks")
      .select("id, title, description, priority, status, progress_percent, due_date, assigned_to, milestone, project_id, archived_at, team_id, task_manager_id, key_result_id, created_at")
      .in("desk_id", deskIds)
      .is("archived_at", null)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return NextResponse.json({ tasks: tasks || [] });
  } catch (error: any) {
    console.error("GET /api/tasks failed:", error);
    return NextResponse.json({ error: error?.message || "Failed to fetch tasks" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const { title, description, priority = "medium", status = "pending", due_date, progress_percent = 0, project_id } = body;

    if (!title || !title.trim()) return NextResponse.json({ error: "Title is required" }, { status: 400 });

    const ctx = await resolveContext(supabase, user.id);
    if (!ctx) return NextResponse.json({ error: "No desk/project/stage set up" }, { status: 400 });

    const { data: task, error } = await supabase
      .from("tasks")
      .insert({
        desk_id: ctx.desk_id,
        project_id: project_id || ctx.project_id,
        stage_id: ctx.stage_id,
        title: title.trim(),
        description: description || null,
        priority,
        status,
        due_date: due_date || null,
        progress_percent,
        created_by: user.id,
      })
      .select("id, title, description, priority, status, progress_percent, due_date, assigned_to, milestone, project_id, archived_at, team_id, task_manager_id, key_result_id, created_at")
      .single();

    if (error) throw error;

    await supabase.from("activity_log").insert({
      entity_type: "task",
      entity_id: task.id,
      action: "created",
      performed_by: user.id,
      desk_id: ctx.desk_id,
      changes: { created: true },
    }).then(() => {}, () => {});

    return NextResponse.json({ task });
  } catch (error: any) {
    console.error("POST /api/tasks failed:", error);
    return NextResponse.json({ error: error?.message || "Failed to create task" }, { status: 500 });
  }
}

// PUT - Update task
export async function PUT(request: NextRequest) {
  try {
    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const { id } = body;

    if (!id) return NextResponse.json({ error: "Task ID is required" }, { status: 400 });

    // Only send fields that were actually included in the request, so a
    // cleared date or a zero progress value is saved instead of skipped.
    const patch: Record<string, any> = {};
    for (const field of ["title", "description", "priority", "status", "progress_percent", "due_date", "assigned_to", "milestone", "archived_at", "team_id", "department_id", "task_manager_id", "key_result_id"]) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        patch[field] = body[field];
      }
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
    }

    patch.updated_at = new Date().toISOString();

    const { data: task, error } = await supabase
      .from("tasks")
      .update(patch)
      .eq("id", id)
      .select("id, title, description, priority, status, progress_percent, due_date, assigned_to, milestone, project_id, archived_at, team_id, task_manager_id, key_result_id, created_at")
      .single();

    if (error) throw error;
    if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    await supabase.from("activity_log").insert({
      entity_type: "task",
      entity_id: id,
      action: "updated " + Object.keys(patch).filter((k) => k !== "updated_at").join(", "),
      performed_by: user.id,
      changes: patch,
    }).then(() => {}, () => {});

    // Real notifications: assignment and completion.
    // Fire-and-forget so a notifications-table problem can never break the save.
    if (Object.prototype.hasOwnProperty.call(body, "assigned_to") && body.assigned_to) {
      await supabase.from("notifications").insert({
        user_id: body.assigned_to,
        task_id: id,
        type: "assigned",
        title: "New task assigned",
        message: `You were assigned: ${task.title}`,
        read: false,
      }).then(() => {}, () => {});
    }

    // SOW #20: on completion, notify everyone connected to the task, not just
    // the assignee - the creator and anyone who commented on it.
    if (patch.status === "done") {
      try {
        const recipients = new Set<string>();
        if (task.assigned_to) recipients.add(task.assigned_to);

        const { data: full } = await supabase
          .from("tasks")
          .select("created_by")
          .eq("id", id)
          .single();
        if (full?.created_by) recipients.add(full.created_by);

        const { data: commenters } = await supabase
          .from("comments")
          .select("author_id")
          .eq("task_id", id);
        (commenters || []).forEach((c: any) => c.author_id && recipients.add(c.author_id));

        recipients.delete(user.id); // no need to tell the person who just did it

        if (recipients.size > 0) {
          await supabase.from("notifications").insert(
            Array.from(recipients).map((uid) => ({
              user_id: uid,
              task_id: id,
              type: "completed",
              title: "Task completed",
              message: `Task marked done: ${task.title}`,
              read: false,
            }))
          );
        }
      } catch {
        /* never block the save on a notification problem */
      }
    }

    // SOW #2: tell the assignee when someone else changes their task.
    const meaningful = Object.keys(patch).filter(
      (k) => !["updated_at", "assigned_to", "status"].includes(k)
    );
    if (meaningful.length > 0 && task.assigned_to && task.assigned_to !== user.id) {
      await supabase.from("notifications").insert({
        user_id: task.assigned_to,
        task_id: id,
        type: "updated",
        title: "Task updated",
        message: `${meaningful.join(", ")} changed on: ${task.title}`,
        read: false,
      }).then(() => {}, () => {});
    }

    return NextResponse.json({ task });
  } catch (error: any) {
    console.error("PUT /api/tasks failed:", error);
    return NextResponse.json({ error: error?.message || "Failed to update task" }, { status: 500 });
  }
}
