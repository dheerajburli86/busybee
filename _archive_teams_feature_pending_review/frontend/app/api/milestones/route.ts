// A project's milestones: named checkpoints, each with an optional due date,
// that its tasks can be pinned to (tasks.milestone_id).
//
//   GET    /api/milestones?project_id=       the project's milestones, in order
//   GET    /api/milestones                   every milestone the caller can see
//                                            (for a picker), with project_name
//   POST   { project_id, name, due_date? }   add one at the end of the list
//   PUT    { id, name?, due_date?, position? }  rename, re-date, or reorder
//   DELETE { id }                            remove; its tasks lose the link
//
// Anyone on the desk who can see the project reads them; the project's
// managers (a supervisor/admin, or the project's own manager) change them.
//
// The old free-text tasks.milestone column is untouched here - it still holds
// the milestone names typed against the previous hardcoded dropdown, and old
// tasks are still read from it.

import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { deny, logActivity, projectAccess, requireUser, visibleProjects } from "@/lib/permissions";
import { inChunks } from "@/lib/chunks";

const MAX_NAME = 80;
const COLUMNS = "id, project_id, name, due_date, position, created_by, created_at";
const CANNOT_MANAGE = "Only a supervisor or the project's manager can change its milestones.";

async function access(supabase: any, userId: string, projectId: string | null | undefined) {
  if (!projectId) return null;
  return projectAccess(supabase, userId, projectId);
}

/** A milestone's date is optional; when given it must be a real date. Stored as ISO. */
function parseDueDate(value: any): { ok: boolean; iso: string | null } {
  if (value === null || value === undefined || value === "") return { ok: true, iso: null };
  const d = new Date(value);
  if (isNaN(d.getTime())) return { ok: false, iso: null };
  return { ok: true, iso: d.toISOString() };
}

/** One project's milestones: by position, then by date, oldest first. */
async function milestonesOf(supabase: any, projectId: string): Promise<any[]> {
  const { data, error } = await supabase
    .from("milestones")
    .select(COLUMNS)
    .eq("project_id", projectId)
    .order("position", { ascending: true })
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data || []) as any[];
}

/** How many tasks point at each milestone (the legacy text column isn't counted). */
async function taskCounts(supabase: any, ids: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (ids.length === 0) return counts;
  const rows = await inChunks<any>(
    ids,
    (part) => supabase.from("tasks").select("milestone_id").in("milestone_id", part).order("id"),
    { all: true }
  );
  rows.forEach((t: any) => {
    if (t.milestone_id) counts.set(t.milestone_id, (counts.get(t.milestone_id) || 0) + 1);
  });
  return counts;
}

export async function GET(req: Request) {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const params = new URL(req.url).searchParams;
    const projectId = params.get("project_id");

    // Asked for one project, but with nothing in the parameter.
    if (params.has("project_id") && !projectId?.trim()) {
      return NextResponse.json({ error: "project_id is required" }, { status: 400 });
    }

    // One project's milestones.
    if (projectId) {
      const a = await access(supabase, user.id, projectId);
      if (!a) return NextResponse.json({ error: "Project not found" }, { status: 404 });

      const rows = await milestonesOf(supabase, a.project.id);
      const counts = await taskCounts(supabase, rows.map((m: any) => m.id));
      return NextResponse.json({
        milestones: rows.map((m: any) => ({ ...m, task_count: counts.get(m.id) || 0 })),
        can_manage: a.canManage,
      });
    }

    // No project named: everything the caller can see, for a picker.
    const projects = await visibleProjects(supabase, user.id);
    const names = new Map<string, string>(projects.map((p: any) => [p.id, p.name]));
    const rows = await inChunks<any>(
      projects.map((p: any) => p.id),
      (part) => supabase.from("milestones").select(COLUMNS).in("project_id", part).order("id"),
      { all: true }
    );
    const counts = await taskCounts(supabase, rows.map((m: any) => m.id));

    const out = rows
      .map((m: any) => ({
        ...m,
        project_name: names.get(m.project_id) || null,
        task_count: counts.get(m.id) || 0,
      }))
      .sort(
        (a: any, b: any) =>
          String(a.project_name || "").localeCompare(String(b.project_name || "")) ||
          (a.position ?? 0) - (b.position ?? 0) ||
          String(a.due_date || "9999").localeCompare(String(b.due_date || "9999")) ||
          String(a.created_at).localeCompare(String(b.created_at))
      );
    return NextResponse.json({ milestones: out });
  } catch (error: any) {
    console.error("GET /api/milestones failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { project_id, name, due_date } = await req.json();
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    if (!project_id) return NextResponse.json({ error: "project_id is required" }, { status: 400 });
    const a = await access(supabase, user.id, project_id);
    if (!a) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (!a.canManage) return deny(CANNOT_MANAGE);

    const clean = String(name || "").trim().slice(0, MAX_NAME);
    if (!clean) return NextResponse.json({ error: "Give the milestone a name" }, { status: 400 });

    const due = parseDueDate(due_date);
    if (!due.ok) return NextResponse.json({ error: "That due date isn't a real date" }, { status: 400 });

    const existing = await milestonesOf(supabase, a.project.id);
    if (existing.some((m: any) => String(m.name || "").toLowerCase() === clean.toLowerCase())) {
      return NextResponse.json({ error: "This project already has a milestone with that name" }, { status: 400 });
    }
    const position = existing.length ? Math.max(...existing.map((m: any) => m.position ?? 0)) + 1 : 0;

    const { data, error } = await supabase
      .from("milestones")
      .insert({
        project_id: a.project.id,
        name: clean,
        due_date: due.iso,
        position,
        created_by: user.id,
      })
      .select(COLUMNS)
      .single();
    if (error) throw error;

    await logActivity(supabase, {
      entity_type: "project", entity_id: a.project.id, action: `added milestone "${clean}"`,
      performed_by: user.id, desk_id: a.project.desk_id, changes: { due_date: due.iso },
    });
    return NextResponse.json({ ...data, task_count: 0 });
  } catch (error: any) {
    console.error("POST /api/milestones failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const body = await req.json();
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const { data: milestone } = await supabase.from("milestones").select(COLUMNS).eq("id", body.id).maybeSingle();
    if (!milestone) return NextResponse.json({ error: "Milestone not found" }, { status: 404 });

    // The rule is the milestone's own project's rule - never what was posted.
    const a = await access(supabase, user.id, milestone.project_id);
    if (!a) return NextResponse.json({ error: "Milestone not found" }, { status: 404 });
    if (!a.canManage) return deny(CANNOT_MANAGE);

    const patch: Record<string, any> = {};

    if (body.name !== undefined) {
      const clean = String(body.name || "").trim().slice(0, MAX_NAME);
      if (!clean) return NextResponse.json({ error: "Give the milestone a name" }, { status: 400 });
      const others = (await milestonesOf(supabase, milestone.project_id)).filter((m: any) => m.id !== milestone.id);
      if (others.some((m: any) => String(m.name || "").toLowerCase() === clean.toLowerCase())) {
        return NextResponse.json({ error: "This project already has a milestone with that name" }, { status: 400 });
      }
      patch.name = clean;
    }

    if ("due_date" in body) {
      const due = parseDueDate(body.due_date);
      if (!due.ok) return NextResponse.json({ error: "That due date isn't a real date" }, { status: 400 });
      patch.due_date = due.iso;
    }

    if (body.position !== undefined) {
      const position = Number(body.position);
      if (!Number.isFinite(position) || position < 0) {
        return NextResponse.json({ error: "Position must be a number" }, { status: 400 });
      }
      patch.position = Math.floor(position);
    }

    if (Object.keys(patch).length === 0) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });

    const { data, error } = await supabase
      .from("milestones")
      .update(patch)
      .eq("id", milestone.id)
      .select(COLUMNS)
      .single();
    if (error) throw error;

    await logActivity(supabase, {
      entity_type: "project", entity_id: milestone.project_id,
      action:
        "position" in patch && Object.keys(patch).length === 1
          ? `moved milestone "${milestone.name}"`
          : patch.name && patch.name !== milestone.name
          ? `renamed milestone "${milestone.name}" to "${patch.name}"`
          : `edited milestone "${milestone.name}"`,
      performed_by: user.id, desk_id: a.project.desk_id, changes: patch,
    });
    const counts = await taskCounts(supabase, [milestone.id]);
    return NextResponse.json({ ...data, task_count: counts.get(milestone.id) || 0 });
  } catch (error: any) {
    console.error("PUT /api/milestones failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { id } = await req.json();
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const { data: milestone } = await supabase.from("milestones").select(COLUMNS).eq("id", id).maybeSingle();
    if (!milestone) return NextResponse.json({ error: "Milestone not found" }, { status: 404 });

    const a = await access(supabase, user.id, milestone.project_id);
    if (!a) return NextResponse.json({ error: "Milestone not found" }, { status: 404 });
    if (!a.canManage) return deny(CANNOT_MANAGE);

    // Let go of the tasks first, so none is left pointing at a milestone that
    // no longer exists. Their old free-text tasks.milestone is left alone.
    const counts = await taskCounts(supabase, [milestone.id]);
    const cleared = counts.get(milestone.id) || 0;
    if (cleared > 0) {
      const { error: clearError } = await supabase
        .from("tasks")
        .update({ milestone_id: null })
        .eq("milestone_id", milestone.id);
      if (clearError) throw clearError;
    }

    const { error } = await supabase.from("milestones").delete().eq("id", milestone.id);
    if (error) throw error;

    await logActivity(supabase, {
      entity_type: "project", entity_id: milestone.project_id,
      action: `removed milestone "${milestone.name}"${cleared ? ` from ${cleared} task${cleared === 1 ? "" : "s"}` : ""}`,
      performed_by: user.id, desk_id: a.project.desk_id,
    });
    return NextResponse.json({ ok: true, cleared });
  } catch (error: any) {
    console.error("DELETE /api/milestones failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
