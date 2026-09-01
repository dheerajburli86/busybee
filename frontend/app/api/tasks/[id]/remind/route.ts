import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";

// SOW #24 (supervisor seeks an update) and #39 (manual reminder).
// Both are the same action: send a notification about this task to someone.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    let kind = "reminder";
    let note = "";
    try {
      const body = await req.json();
      kind = body?.kind || "reminder";
      note = body?.message || "";
    } catch {
      // defaults are fine
    }

    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: task, error: taskError } = await supabase
      .from("tasks")
      .select("id, title, assigned_to, created_by")
      .eq("id", id)
      .single();

    if (taskError || !task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    // An update request goes to whoever is doing the work; if nobody is
    // assigned there is no one to ask.
    const target = task.assigned_to;
    if (!target) {
      return NextResponse.json(
        { error: "Assign the task to someone before sending a reminder" },
        { status: 400 }
      );
    }

    const isUpdateRequest = kind === "update_request";

    const { error } = await supabase.from("notifications").insert({
      user_id: target,
      task_id: id,
      type: isUpdateRequest ? "update_request" : "reminder",
      title: isUpdateRequest ? "Update requested" : "Reminder",
      message:
        note ||
        (isUpdateRequest
          ? `An update was requested on: ${task.title}`
          : `Reminder about: ${task.title}`),
      read: false,
    });

    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("POST /api/tasks/[id]/remind failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
