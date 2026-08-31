// app/api/tasks/route.ts
import { createServerSideClient } from "@/lib/supabase";
import { NextRequest, NextResponse } from "next/server";

// GET /api/tasks - list tasks for current user's desks
export async function GET(request: NextRequest) {
  try {
    const supabase = await createServerSideClient();

    // Get current user
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get user's desks
    const { data: desks, error: desksError } = await supabase
      .from("desk_members")
      .select("desk_id")
      .eq("user_id", user.id);

    if (desksError) throw desksError;

    const deskIds = desks.map((d) => d.desk_id);

    // Get tasks in those desks
    const { data: tasks, error: tasksError } = await supabase
      .from("tasks")
      .select(
        `
        id,
        title,
        description,
        priority,
        assigned_to,
        created_by,
        stage_id,
        project_id,
        desk_id,
        created_at,
        archived_at,
        approved_deadlines (approved_datetime),
        subtasks (id, title, done)
      `
      )
      .in("desk_id", deskIds)
      .is("archived_at", null)
      .order("created_at", { ascending: false });

    if (tasksError) throw tasksError;

    return NextResponse.json({ tasks });
  } catch (error) {
    console.error("Error fetching tasks:", error);
    return NextResponse.json(
      { error: "Failed to fetch tasks" },
      { status: 500 }
    );
  }
}

// POST /api/tasks - create a task
export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSideClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const {
      desk_id,
      project_id,
      stage_id,
      title,
      description,
      priority = "medium",
      task_group_id = null,
    } = body;

    // Verify user is a supervisor in this desk
    const { data: member } = await supabase
      .from("desk_members")
      .select("role")
      .eq("desk_id", desk_id)
      .eq("user_id", user.id)
      .single();

    if (!member || !["supervisor", "owner"].includes(member.role)) {
      return NextResponse.json(
        { error: "Only supervisors can create tasks" },
        { status: 403 }
      );
    }

    // Create task
    const { data: task, error } = await supabase
      .from("tasks")
      .insert({
        desk_id,
        project_id,
        stage_id,
        title,
        description,
        priority,
        task_group_id,
        created_by: user.id,
      })
      .select()
      .single();

    if (error) throw error;

    // Log to activity log
    await supabase.from("activity_log").insert({
      entity_type: "task",
      entity_id: task.id,
      action: "created",
      performed_by: user.id,
      desk_id,
      changes: { created: true },
    });

    return NextResponse.json({ task });
  } catch (error) {
    console.error("Error creating task:", error);
    return NextResponse.json(
      { error: "Failed to create task" },
      { status: 500 }
    );
  }
}
