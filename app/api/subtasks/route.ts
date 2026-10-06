// Subtasks and dependencies for many tasks at once (used by the Gantt chart).
// Only returns rows for tasks the caller is allowed to see.
//   POST { task_ids: [...] }  -> { subtasks, dependencies }
//   GET  ?task_ids=a,b,c      -> { subtasks }  (short lists only)
import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";
import { getMemberships, requireUser, visibleTasks } from "@/lib/permissions";
import { inChunks } from "@/lib/chunks";

const MAX = 1000;

async function load(ids: string[], withDeps: boolean) {
  const supabase = await createServerSideClient();
  const user = await requireUser(supabase);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!ids.length) return NextResponse.json({ subtasks: [], dependencies: [] });

  const memberships = await getMemberships(supabase, user.id);
  const deskIds = memberships.map((m) => m.desk_id);
  const tasks = await inChunks<any>(ids, (part) => supabase.from("tasks").select("*").in("id", part).in("desk_id", deskIds));
  const allowed = (await visibleTasks(supabase, user.id, tasks)).map((t: any) => t.id);
  if (!allowed.length) return NextResponse.json({ subtasks: [], dependencies: [] });

  const [subtasks, dependencies] = await Promise.all([
    inChunks<any>(allowed, (part) =>
      supabase
        .from("subtasks")
        .select("id, task_id, title, done, progress_percent, progress_type, progress_target, progress_current, due_date, assigned_to, position")
        .in("task_id", part)
    ),
    withDeps
      ? inChunks<any>(allowed, (part) => supabase.from("task_dependencies").select("task_id, depends_on_task_id").in("task_id", part))
      : Promise.resolve([]),
  ]);
  subtasks.sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0));
  return NextResponse.json({ subtasks, dependencies });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const ids: string[] = (Array.isArray(body.task_ids) ? body.task_ids : []).filter((x: any) => typeof x === "string").slice(0, MAX);
    return await load(ids, true);
  } catch (error: any) {
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    // ?mine=1 -> open checklist items assigned to me, with their task (for My To-Do).
    if (request.nextUrl.searchParams.get("mine")) {
      const supabase = await createServerSideClient();
      const user = await requireUser(supabase);
      if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      const { data: mine } = await supabase
        .from("subtasks")
        .select("id, task_id, title, done, due_date, progress_percent, progress_type, progress_target, progress_current")
        .eq("assigned_to", user.id)
        .order("due_date", { ascending: true, nullsFirst: false })
        .limit(300);
      const taskIds = Array.from(new Set((mine || []).map((s: any) => s.task_id)));
      const memberships = await getMemberships(supabase, user.id);
      const tasks = await inChunks<any>(taskIds, (part) =>
        supabase.from("tasks").select("*").in("id", part).in("desk_id", memberships.map((m) => m.desk_id)).is("archived_at", null)
      );
      const visible = new Map((await visibleTasks(supabase, user.id, tasks)).map((t: any) => [t.id, t]));
      return NextResponse.json({
        subtasks: (mine || [])
          .filter((s: any) => visible.has(s.task_id))
          .map((s: any) => ({ ...s, task_title: visible.get(s.task_id).title, task_status: visible.get(s.task_id).status })),
      });
    }
    const ids = (request.nextUrl.searchParams.get("task_ids") || "").split(",").filter(Boolean).slice(0, 100);
    return await load(ids, false);
  } catch (error: any) {
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
