// app/api/tasks/[id]/subtasks/route.ts

import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data, error } = await supabase
      .from("subtasks")
      .select("id, title, done, progress_percent, position, assigned_to")
      .eq("task_id", taskId)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });

    if (error) throw error;
    return NextResponse.json(data || []);
  } catch (error: any) {
    console.error("GET /api/tasks/[id]/subtasks failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { title } = await request.json();
    if (!title || !title.trim()) {
      return NextResponse.json({ error: "Title is required" }, { status: 400 });
    }

    const { count } = await supabase
      .from("subtasks")
      .select("id", { count: "exact", head: true })
      .eq("task_id", taskId);

    const { data: subtask, error } = await supabase
      .from("subtasks")
      .insert({
        task_id: taskId,
        title: title.trim(),
        position: count || 0,
      })
      .select("id, title, done, progress_percent, position, assigned_to")
      .single();

    if (error) throw error;
    return NextResponse.json(subtask);
  } catch (error: any) {
    console.error("POST /api/tasks/[id]/subtasks failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await params;

  try {
    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const { subtask_id } = body;
    if (!subtask_id) {
      return NextResponse.json({ error: "subtask_id is required" }, { status: 400 });
    }

    const patch: Record<string, any> = {};
    for (const field of ["title", "done", "progress_percent", "assigned_to"]) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        patch[field] = body[field];
      }
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
    }
    patch.updated_at = new Date().toISOString();

    const { data: subtask, error } = await supabase
      .from("subtasks")
      .update(patch)
      .eq("id", subtask_id)
      .select("id, title, done, progress_percent, position, assigned_to")
      .single();

    if (error) throw error;

    // SOW #14 + #2: tell the member when they pick up a subtask.
    if (patch.assigned_to && patch.assigned_to !== user.id) {
      await supabase.from("notifications").insert({
        user_id: patch.assigned_to,
        type: "assigned",
        title: "Subtask assigned",
        message: `You were assigned a subtask: ${subtask?.title ?? ""}`,
        read: false,
      }).then(() => {}, () => {});
    }

    return NextResponse.json(subtask);
  } catch (error: any) {
    console.error("PUT /api/tasks/[id]/subtasks failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await params;

  try {
    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { subtask_id } = await request.json();
    if (!subtask_id) {
      return NextResponse.json({ error: "subtask_id is required" }, { status: 400 });
    }

    const { error } = await supabase.from("subtasks").delete().eq("id", subtask_id);
    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("DELETE /api/tasks/[id]/subtasks failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
