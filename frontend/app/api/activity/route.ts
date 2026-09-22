// Checklist #41: history across a project (its own changes plus every task
// in it), or across the whole desk when no project is given. Filterable by
// person and date range so it doubles as an audit trail.
//
// The newest matching history rows are read first and then checked against
// the tasks this person may see, so it keeps working as history grows.

import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";
import { getMemberships, requireUser, visibleProjects, visibleTasks, SUPER_ROLES } from "@/lib/permissions";
import { attachNames } from "@/lib/names";
import { namesForChanges } from "@/lib/describe";
import { inChunks, selectAll, selectUpTo } from "@/lib/chunks";

const MAX = 500;
const COLS = "id, entity_type, entity_id, action, performed_by, created_at, changes";

export async function GET(request: NextRequest) {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const sp = request.nextUrl.searchParams;
    const projectId = sp.get("project_id");
    const person = sp.get("user_id");
    const from = sp.get("from");
    const to = sp.get("to");

    const memberships = await getMemberships(supabase, user.id);
    const deskIds = memberships.map((m) => m.desk_id);
    if (!deskIds.length) return NextResponse.json({ entries: [], names: {} });
    const isSuper = memberships.some((m) => SUPER_ROLES.includes(m.role));

    const filters = (q: any) => {
      if (person) q = q.eq("performed_by", person);
      if (from) q = q.gte("created_at", from);
      if (to) q = q.lte("created_at", to);
      return q;
    };

    let taskRows: any[] = [];
    let titles = new Map<string, string>();

    if (projectId) {
      // Only a project this person can see.
      if (!(await visibleProjects(supabase, user.id)).some((p: any) => p.id === projectId)) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
      }
      // Every task in the project this person may see, and the project itself.
      const tasks = await selectAll<any>(() => supabase.from("tasks").select("*").in("desk_id", deskIds).eq("project_id", projectId).order("id"));
      const visible = await visibleTasks(supabase, user.id, tasks);
      titles = new Map(visible.map((t: any) => [t.id, t.title]));
      const entityIds = [...visible.map((t: any) => t.id), projectId];
      taskRows = await inChunks<any>(entityIds, (part) =>
        filters(supabase.from("activity_log").select(COLS).in("entity_id", part)).order("created_at", { ascending: false }).limit(MAX)
      );
    } else if (!isSuper) {
      // Start from the tasks this person may see (on a busy desk, the newest
      // history overall could be all about other people's work).
      const tasks = await selectAll<any>(() => supabase.from("tasks").select("*").in("desk_id", deskIds).order("id"));
      const visible = await visibleTasks(supabase, user.id, tasks);
      titles = new Map(visible.map((t: any) => [t.id, t.title]));
      taskRows = await inChunks<any>(visible.map((t: any) => t.id), (part) =>
        filters(supabase.from("activity_log").select(COLS).in("entity_id", part).eq("entity_type", "task"))
          .order("created_at", { ascending: false })
          .limit(MAX)
      );
    } else {
      // Supervisors see the whole desk: its newest task history.
      const recent = await selectUpTo<any>(
        () =>
          filters(supabase.from("activity_log").select(COLS).in("desk_id", deskIds).eq("entity_type", "task"))
            .order("created_at", { ascending: false })
            .order("id"),
        MAX * 4
      );
      const tasks = await inChunks<any>(recent.map((r: any) => r.entity_id), (part) =>
        supabase.from("tasks").select("*").in("id", part).in("desk_id", deskIds)
      );
      const visible = await visibleTasks(supabase, user.id, tasks);
      titles = new Map(visible.map((t: any) => [t.id, t.title]));
      taskRows = recent.filter((r: any) => titles.has(r.entity_id));
    }

    // Desk-level changes (teams, departments, groups, projects, roles) for supervisors.
    let deskRows: any[] = [];
    if (!projectId && isSuper) {
      const { data } = await filters(
        supabase.from("activity_log").select(COLS).in("desk_id", deskIds).in("entity_type", ["team", "department", "group", "project", "okr"])
      )
        .order("created_at", { ascending: false })
        .limit(200);
      deskRows = data || [];
    }

    const seen = new Set<string>();
    const merged = [...taskRows, ...deskRows]
      .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, MAX)
      .map((r) => ({ ...r, task_title: r.entity_type === "task" ? titles.get(r.entity_id) ?? null : null }));

    const names = await namesForChanges(supabase, merged);
    return NextResponse.json({ entries: await attachNames(supabase, merged, "performed_by"), names });
  } catch (error: any) {
    console.error("GET /api/activity failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
