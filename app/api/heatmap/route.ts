import { NextResponse } from "next/server";
import { createServerSideClient } from "@/lib/supabase-server";
import { createAdminClient } from "@/lib/supabase-admin";
import { filterVisible, getMemberships, requireUser, SUPER_ROLES, visibilitySets } from "@/lib/permissions";
import { inChunks, selectAll } from "@/lib/chunks";
import { subtaskPercent } from "@/lib/progress";
import { isFinished } from "@/lib/status";
import type { HeatTask } from "@/lib/heatmap";

// The People heatmap's data: every task given to someone that the viewer is
// allowed to see (the same rules as the task list), as the facts the scoring
// needs - deadline, when it was given, items done, finished when. The colours
// themselves are worked out by lib/heatmap.ts, on the screen, every minute,
// so they keep moving with the clock between these loads. `now` lets the
// screen use the server's clock rather than a phone's.

export const dynamic = "force-dynamic";

const DAY = 24 * 3600 * 1000;
/** Finished tasks are listed on a person's page for this long. */
const SHOW_FINISHED_DAYS = 30;
const SUB_COLS = "done, progress_type, progress_target, progress_current, progress_percent, updated_at";
const TASK_COLS =
  "id, title, status, desk_id, project_id, team_id, personal, created_by, assigned_to, task_manager_id, created_at, due_date, completed_at, archived_at, is_list, progress_percent";

const latest = (...xs: (string | null | undefined)[]) =>
  xs.filter((x): x is string => !!x).reduce<string | null>((a, b) => (!a || Date.parse(b) > Date.parse(a) ? b : a), null);

export async function GET() {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const memberships = await getMemberships(supabase, user.id);
    const deskIds = memberships.map((m) => m.desk_id);
    const now = new Date();
    const scope = memberships.some((m) => SUPER_ROLES.includes(m.role)) ? "all" : "visible";
    if (deskIds.length === 0) return NextResponse.json({ now: now.toISOString(), scope, tasks: [] });

    const since = new Date(now.getTime() - SHOW_FINISHED_DAYS * DAY).toISOString();
    const query = (cols: string) => () =>
      supabase
        .from("tasks")
        .select(cols)
        .in("desk_id", deskIds)
        .eq("personal", false)
        .not("assigned_to", "is", null)
        .or(`completed_at.is.null,completed_at.gte.${since}`)
        .order("id");

    // Tasks with their items and project name in one go (separately on a
    // database that can't join them), alongside what decides visibility.
    const [joined, sets] = await Promise.all([
      selectAll<any>(query(`${TASK_COLS}, projects(name), subtasks(${SUB_COLS})`)).catch(() => null),
      visibilitySets(supabase, user.id),
    ]);
    let rows: any[] = joined || (await selectAll<any>(query(TASK_COLS)));
    // Put-away (archived) work that was never finished isn't anyone's to do;
    // finished work with no finishing time is from before that was recorded.
    rows = filterVisible(rows, user.id, memberships, sets).filter((t: any) => (isFinished(t.status) ? !!t.completed_at : !t.archived_at));
    if (!joined && rows.length) {
      const subs = await inChunks<any>(rows.map((t) => t.id), (part) => supabase.from("subtasks").select(`task_id, ${SUB_COLS}`).in("task_id", part).order("id"), { all: true });
      const by = new Map<string, any[]>();
      subs.forEach((s: any) => by.set(s.task_id, [...(by.get(s.task_id) || []), s]));
      rows.forEach((t: any) => (t.subtasks = by.get(t.id) || []));
    }
    const ids = rows.map((t) => t.id);
    const open = rows.filter((t) => !isFinished(t.status)).map((t) => t.id);

    // Waiting on another task (dependencies), and when each task was last
    // handed to someone else (the new person's clock starts then).
    const db = createAdminClient() || supabase;
    const [deps, moves] = await Promise.all([
      open.length
        ? inChunks<any>(open, (part) => supabase.from("task_dependencies").select("task_id, depends_on_task_id").in("task_id", part)).catch(() => [])
        : Promise.resolve([]),
      ids.length
        ? inChunks<any>(ids, (part) =>
            supabase.from("activity_log").select("entity_id, created_at").eq("entity_type", "task").in("entity_id", part).not("changes->assigned_to", "is", null)
          ).catch(() => [])
        : Promise.resolve([]),
    ]);
    const blockers = new Map<string, string[]>();
    deps.forEach((d: any) => blockers.set(d.task_id, [...(blockers.get(d.task_id) || []), d.depends_on_task_id]));
    const unfinished = new Set<string>();
    const depIds = Array.from(new Set(deps.map((d: any) => d.depends_on_task_id)));
    if (depIds.length) {
      // Only whether each is finished leaves here, not what the task is.
      const st = await inChunks<any>(depIds, (part) => db.from("tasks").select("id, status").in("id", part)).catch(() => []);
      st.forEach((x: any) => !isFinished(x.status) && unfinished.add(x.id));
    }
    const reassigned = new Map<string, string>();
    moves.forEach((m: any) => {
      const cur = reassigned.get(m.entity_id);
      if (!cur || Date.parse(m.created_at) > Date.parse(cur)) reassigned.set(m.entity_id, m.created_at);
    });

    const tasks: HeatTask[] = rows.map((t: any) => {
      const subs: any[] = Array.isArray(t.subtasks) ? t.subtasks : [];
      const done = subs.length
        ? subs.reduce((sum, s) => sum + subtaskPercent(s) / 100, 0)
        : Math.max(0, Math.min(100, Number(t.progress_percent) || 0)) / 100;
      const lastTick = latest(...subs.filter((s) => s.done).map((s) => s.updated_at));
      return {
        id: t.id,
        title: t.title,
        status: t.status,
        start: latest(t.created_at, reassigned.get(t.id)) || t.created_at,
        due: t.due_date,
        completed_at: t.completed_at,
        items: subs.length,
        done: Math.round(done * 100) / 100,
        blocked: (blockers.get(t.id) || []).some((id) => unfinished.has(id)),
        last_progress_at: latest(lastTick, t.completed_at),
        assigned_to: t.assigned_to,
        project: t.projects?.name || null,
        is_list: !!t.is_list,
      };
    });

    return NextResponse.json({ now: new Date().toISOString(), scope, tasks });
  } catch (error: any) {
    console.error("GET /api/heatmap failed:", error);
    return NextResponse.json({ error: error?.message || "Could not load the heatmap" }, { status: 500 });
  }
}
