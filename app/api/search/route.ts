// Checklist #42 / SOW #38: one search box for projects, tasks (including
// their descriptions and comments), people and files. Results respect the
// same visibility rules as the rest of the app. Optional filters:
//   type=projects|tasks|people|files   project_id=<id> (project-level search)
//
// Matching happens in the database, then each hit is checked against what
// the person may see - so it keeps working however many tasks pile up.

import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";
import { getMemberships, requireUser, visibleProjects, visibleTasks, SUPER_ROLES, roleIn, normalizeRole } from "@/lib/permissions";
import { inChunks } from "@/lib/chunks";

const LIMIT = 25;
const SCAN = 200;

export async function GET(request: NextRequest) {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const sp = request.nextUrl.searchParams;
    const raw = (sp.get("q") || "").trim();
    const type = sp.get("type");
    const projectId = sp.get("project_id");
    const empty = { projects: [], tasks: [], people: [], files: [] };
    if (raw.length < 2) return NextResponse.json(empty);

    const q = raw.toLowerCase();
    // Wildcards and quote characters become spaces; everything else is
    // matched literally (values are quoted in the filter below).
    const safe = raw.replace(/["\\*%_]/g, " ").replace(/\s+/g, " ").trim();
    if (safe.length < 2) return NextResponse.json(empty);
    const pattern = `%${safe}%`;
    const want = (t: string) => !type || type === t;

    const memberships = await getMemberships(supabase, user.id);
    const deskIds = memberships.map((m) => m.desk_id);
    if (!deskIds.length) return NextResponse.json(empty);

    const projectRows = await visibleProjects(supabase, user.id);
    const projectName = new Map(projectRows.map((p: any) => [p.id, p.name]));

    // Load tasks by id, scoped to the desk (and project), keeping only the ones this person may see.
    const tasksById = async (taskIds: string[]) => {
      const rows = await inChunks<any>(taskIds, (part) => {
        let tq = supabase.from("tasks").select("*").in("id", part).in("desk_id", deskIds);
        if (projectId) tq = tq.eq("project_id", projectId);
        return tq;
      });
      return new Map((await visibleTasks(supabase, user.id, rows)).map((t: any) => [t.id, t]));
    };

    const out: any = { projects: [], tasks: [], people: [], files: [] };

    if (want("projects") && !projectId) {
      out.projects = projectRows
        .filter((p: any) => `${p.name} ${p.description || ""}`.toLowerCase().includes(q))
        .slice(0, LIMIT)
        .map((p: any) => ({ id: p.id, name: p.name, description: p.description }));
    }

    if (want("tasks")) {
      let direct = supabase
        .from("tasks")
        .select("id")
        .in("desk_id", deskIds)
        .or(`title.ilike."${pattern}",description.ilike."${pattern}",milestone.ilike."${pattern}"`)
        .order("created_at", { ascending: false })
        .limit(SCAN);
      if (projectId) direct = direct.eq("project_id", projectId);
      // Private comments only match for the people they were written for -
      // the database hides the rest (#31).
      const [{ data: hits }, { data: comments }] = await Promise.all([
        direct,
        supabase.from("comments").select("task_id, content").ilike("content", pattern).order("created_at", { ascending: false }).limit(SCAN),
      ]);
      const directIds = (hits || []).map((t: any) => t.id);
      const commentHits: Record<string, string> = {};
      (comments || []).forEach((c: any) => {
        if (!commentHits[c.task_id]) commentHits[c.task_id] = c.content;
      });
      const seen = await tasksById([...directIds, ...Object.keys(commentHits)]);
      const order = Array.from(new Set([...directIds, ...Object.keys(commentHits)]));

      out.tasks = order
        .map((id) => seen.get(id))
        .filter(Boolean)
        .slice(0, LIMIT)
        .map((t: any) => {
          const inTask = `${t.title} ${t.description || ""} ${t.milestone || ""}`.toLowerCase().includes(q);
          return {
            id: t.id,
            title: t.title,
            status: t.status,
            due_date: t.due_date,
            project_id: t.project_id,
            project_name: projectName.get(t.project_id) || null,
            archived: !!t.archived_at,
            matched_in: !inTask && commentHits[t.id] ? "comment" : "task",
            snippet: (!inTask && commentHits[t.id]?.slice(0, 140)) || t.description?.slice(0, 140) || null,
          };
        });
    }

    if (want("people") && !projectId) {
      const { data: mates } = await supabase
        .from("desk_members")
        .select("user_id, role, users(id, email, full_name)")
        .in("desk_id", deskIds);
      const seen = new Set<string>();
      out.people = (mates || [])
        .map((m: any) => ({ id: m.user_id, name: m.users?.full_name || m.users?.email, email: m.users?.email, role: normalizeRole(m.role) }))
        .filter((p: any) => (seen.has(p.id) ? false : (seen.add(p.id), true)))
        .filter((p: any) => `${p.name || ""} ${p.email || ""}`.toLowerCase().includes(q))
        .slice(0, LIMIT);
    }

    if (want("files")) {
      const { data: files } = await supabase
        .from("attachments")
        .select("id, task_id, file_name, visibility, uploaded_by, created_at")
        .ilike("file_name", pattern)
        .order("created_at", { ascending: false })
        .limit(SCAN);
      const tasks = await tasksById((files || []).map((f: any) => f.task_id));
      const [{ data: extra }, { data: shared }] = await Promise.all([
        supabase.from("task_assignors").select("task_id").eq("user_id", user.id),
        supabase.from("attachment_access").select("attachment_id").eq("user_id", user.id),
      ]);
      const assignorOf = new Set((extra || []).map((x: any) => x.task_id));
      const sharedWithMe = new Set((shared || []).map((x: any) => x.attachment_id));

      out.files = (files || [])
        .filter((f: any) => {
          const t = tasks.get(f.task_id);
          if (!t) return false;
          const v = f.visibility || "all";
          if (v === "all") return true;
          const inner =
            f.uploaded_by === user.id || t.created_by === user.id || t.assigned_to === user.id ||
            t.task_manager_id === user.id || assignorOf.has(t.id) || SUPER_ROLES.includes(roleIn(memberships, t.desk_id));
          return inner || (v === "custom" && sharedWithMe.has(f.id));
        })
        .slice(0, LIMIT)
        .map((f: any) => ({
          id: f.id,
          file_name: f.file_name,
          task_id: f.task_id,
          task_title: tasks.get(f.task_id)?.title,
          download_url: `/api/attachments/${f.id}/download`,
        }));
    }

    return NextResponse.json(out);
  } catch (error: any) {
    console.error("GET /api/search failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
