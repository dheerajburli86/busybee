// app/api/tasks/route.ts
import { createServerSideClient } from "@/lib/supabase-server";
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

    // Get all tasks (no desk filter for now)
    const { data: tasks, error: tasksError } = await supabase
      .from("tasks")
      .select(`*`)
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

    // Create task (anyone can create)
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
