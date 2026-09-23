import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { deny, logActivity, requireUser, taskAccess } from "@/lib/permissions";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const access = await taskAccess(supabase, user.id, id);
    if (!access?.canView) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    const { data: deps, error } = await supabase
      .from("task_dependencies")
      .select("depends_on_task_id")
      .eq("task_id", id);
    if (error) throw error;
    return NextResponse.json(deps || []);
  } catch (error: any) {
    console.error("GET /api/tasks/[id]/dependencies failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

/** Would adding task -> dependsOn create a loop? Walks the existing graph. */
async function createsCycle(supabase: any, taskId: string, dependsOn: string): Promise<boolean> {
  const seen = new Set<string>();
  let frontier = [dependsOn];
  while (frontier.length) {
    if (frontier.includes(taskId)) return true;
    frontier.forEach((f) => seen.add(f));
    const { data } = await supabase
      .from("task_dependencies")
      .select("depends_on_task_id")
      .in("task_id", frontier);
    frontier = (data || []).map((d: any) => d.depends_on_task_id).filter((x: string) => !seen.has(x));
  }
  return false;
}

export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { depends_on_task_id, dependency_type } = await req.json();
    if (!depends_on_task_id) {
      return NextResponse.json({ error: "depends_on_task_id required" }, { status: 400 });
    }
    if (id === depends_on_task_id) {
      return NextResponse.json({ error: "Task cannot depend on itself" }, { status: 400 });
    }

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const access = await taskAccess(supabase, user.id, id);
    if (!access) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    if (!access.canManage) return deny("Only the assignor or a supervisor can change dependencies.");

    if (await createsCycle(supabase, id, depends_on_task_id)) {
      return NextResponse.json({ error: "That would create a circular dependency" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("task_dependencies")
      .insert({ task_id: id, depends_on_task_id, dependency_type: dependency_type || "blocks" })
      .select("id");
    if (error) throw error;

    await logActivity(supabase, {
      entity_type: "task",
      entity_id: id,
      action: "added a dependency",
      performed_by: user.id,
      desk_id: access.task.desk_id,
      changes: { depends_on_task_id },
    });
    return NextResponse.json({ success: true, id: data?.[0]?.id });
  } catch (error: any) {
    console.error("POST /api/tasks/[id]/dependencies failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { depends_on_task_id } = await req.json();
    if (!depends_on_task_id) {
      return NextResponse.json({ error: "depends_on_task_id required" }, { status: 400 });
    }

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const access = await taskAccess(supabase, user.id, id);
    if (!access) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    if (!access.canManage) return deny("Only the assignor or a supervisor can change dependencies.");

    const { error } = await supabase
      .from("task_dependencies")
      .delete()
      .eq("task_id", id)
      .eq("depends_on_task_id", depends_on_task_id);
    if (error) throw error;

    await logActivity(supabase, {
      entity_type: "task",
      entity_id: id,
      action: "removed a dependency",
      performed_by: user.id,
      desk_id: access.task.desk_id,
      changes: { depends_on_task_id },
    });
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("DELETE /api/tasks/[id]/dependencies failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
