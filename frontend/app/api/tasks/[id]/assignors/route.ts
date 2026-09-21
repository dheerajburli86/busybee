import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { deny, getMemberships, logActivity, notifyMany, requireUser, taskAccess } from "@/lib/permissions";

// SOW #44: an assignor can add other assignors to a task. Only someone who
// already manages the task may do it, so nobody can grant themselves rights.
type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const access = await taskAccess(supabase, user.id, id);
    if (!access?.canView) return NextResponse.json({ error: "Task not found" }, { status: 404 });

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

export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { user_id } = await req.json();
    if (!user_id) return NextResponse.json({ error: "user_id required" }, { status: 400 });

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const access = await taskAccess(supabase, user.id, id);
    if (!access) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    if (!access.canManage) return deny("Only an existing assignor or a supervisor can add assignors.");

    // The new assignor has to be on the same desk.
    const theirs = await getMemberships(supabase, user_id);
    if (!theirs.some((m) => m.desk_id === access.task.desk_id)) {
      return NextResponse.json({ error: "That person isn't on this desk" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("task_assignors")
      .insert({ task_id: id, user_id })
      .select("id, user_id, created_at")
      .single();
    if (error) throw error;

    await logActivity(supabase, {
      entity_type: "task",
      entity_id: id,
      action: "added an assignor",
      performed_by: user.id,
      desk_id: access.task.desk_id,
      changes: { user_id },
    });
    if (user_id !== user.id) {
      await notifyMany(supabase, [user_id], {
        task_id: id,
        type: "assignor_added",
        title: "Added as assignor",
        message: `You can now assign and manage work on: ${access.task.title}`,
      });
    }
    return NextResponse.json(data);
  } catch (error: any) {
    console.error("POST assignors failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { user_id } = await req.json();
    if (!user_id) return NextResponse.json({ error: "user_id required" }, { status: 400 });

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const access = await taskAccess(supabase, user.id, id);
    if (!access) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    // Anyone may step down themselves; removing someone else needs management rights.
    if (user_id !== user.id && !access.canManage) return deny("Only an assignor or a supervisor can remove assignors.");

    const { error } = await supabase.from("task_assignors").delete().eq("task_id", id).eq("user_id", user_id);
    if (error) throw error;

    await logActivity(supabase, {
      entity_type: "task",
      entity_id: id,
      action: "removed an assignor",
      performed_by: user.id,
      desk_id: access.task.desk_id,
      changes: { user_id },
    });
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("DELETE assignors failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
