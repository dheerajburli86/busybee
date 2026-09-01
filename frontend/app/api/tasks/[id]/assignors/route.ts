import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";

// SOW #44: an assignor can add other assignors to a task.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data, error } = await supabase
      .from("task_assignors")
      .select("id, user_id, created_at")
      .eq("task_id", id);

    if (error) throw error;
    return NextResponse.json(data || []);
  } catch (error: any) {
    console.error("GET assignors failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user_id } = await req.json();
    if (!user_id) return NextResponse.json({ error: "user_id required" }, { status: 400 });

    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data, error } = await supabase
      .from("task_assignors")
      .insert({ task_id: id, user_id })
      .select("id, user_id, created_at")
      .single();

    if (error) throw error;

    const { data: task } = await supabase
      .from("tasks")
      .select("title")
      .eq("id", id)
      .single();

    if (user_id !== user.id) {
      await supabase.from("notifications").insert({
        user_id,
        task_id: id,
        type: "assignor_added",
        title: "Added as assignor",
        message: `You can now assign work on: ${task?.title ?? "a task"}`,
        read: false,
      }).then(() => {}, () => {});
    }

    return NextResponse.json(data);
  } catch (error: any) {
    console.error("POST assignors failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user_id } = await req.json();
    if (!user_id) return NextResponse.json({ error: "user_id required" }, { status: 400 });

    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { error } = await supabase
      .from("task_assignors")
      .delete()
      .eq("task_id", id)
      .eq("user_id", user_id);

    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("DELETE assignors failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
