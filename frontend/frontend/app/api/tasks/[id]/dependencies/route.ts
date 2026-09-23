import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { deny, logActivity, requireUser, taskAccess } from "@/lib/permissions";
import { selectAll } from "@/lib/chunks";

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

/**
 * Would adding "taskId depends on dependsOn" close a loop? The edges are read
 * once and walked in memory from dependsOn: if taskId is reachable that way,
 * the new edge would complete a cycle (A -> B -> A, or longer). The visited
 * set means the walk ends even if the stored edges already contain a loop.
 *
 * Every edge has to be read page by page: a graph truncated at 1000 rows would
 * hide the very edge that closes the loop. If the read fails the guard says
 * "cycle" rather than guessing - refusing a sound dependency is recoverable,
 * writing a circular one is not.
 */
async function createsCycle(supabase: any, taskId: string, dependsOn: string): Promise<boolean> {
  if (taskId === dependsOn) return true;

  let edges: any[];
  try {
    edges = await selectAll<any>(() =>
      supabase.from("task_dependencies").select("task_id, depends_on_task_id").order("id")
    );
  } catch (error: any) {
    console.error("dependency cycle check could not read the graph:", error);
    return true;
  }

  const dependsOnOf = new Map<string, string[]>();
  for (const edge of edges || []) {
    if (!edge?.task_id || !edge?.depends_on_task_id) continue;
    const existing = dependsOnOf.get(edge.task_id);
    if (existing) existing.push(edge.depends_on_task_id);
    else dependsOnOf.set(edge.task_id, [edge.depends_on_task_id]);
  }

  const seen = new Set<string>([dependsOn]);
  const stack: string[] = [dependsOn];
  while (stack.length) {
    const current = stack.pop() as string;
    for (const next of dependsOnOf.get(current) || []) {
      if (next === taskId) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
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
