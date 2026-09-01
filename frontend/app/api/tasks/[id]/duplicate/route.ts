import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: original, error: fetchError } = await supabase
      .from("tasks")
      .select("*")
      .eq("id", taskId)
      .single();

    if (fetchError || !original) throw new Error("Task not found");

    const { data: duplicated, error: createError } = await supabase
      .from("tasks")
      .insert({
        desk_id: original.desk_id,
        project_id: original.project_id,
        stage_id: original.stage_id,
        title: `${original.title} (copy)`,
        description: original.description,
        priority: original.priority,
        status: "pending",
        progress_percent: 0,
        progress_type: original.progress_type,
        progress_target: original.progress_target,
        progress_current: 0,
        due_date: original.due_date,
        assigned_to: null,
        created_by: user.id,
        milestone: original.milestone,
      })
      .select("*")
      .single();

    if (createError) throw createError;

    return NextResponse.json({ task: duplicated });
  } catch (error: any) {
    console.error("POST duplicate failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
