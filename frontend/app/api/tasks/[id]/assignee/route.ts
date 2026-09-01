// app/api/tasks/[id]/assignee/route.ts

import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { assigned_to } = await request.json();

    const { data: task, error } = await supabase
      .from("tasks")
      .update({ assigned_to: assigned_to || null })
      .eq("id", taskId)
      .select("id, title, assigned_to")
      .single();

    if (error) throw error;

    if (assigned_to) {
      await supabase.from("notifications").insert({
        user_id: assigned_to,
        entity_type: "task",
        entity_id: taskId,
        action: "assigned",
        message: `Task assigned to you`,
        read: false,
      }).then(() => {}, () => {});
    }

    await supabase.from("activity_log").insert({
      entity_type: "task",
      entity_id: taskId,
      action: "assigned",
      performed_by: user.id,
    }).then(() => {}, () => {});

    return NextResponse.json({ task });
  } catch (error: any) {
    console.error("PUT /api/tasks/[id]/assignee failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
