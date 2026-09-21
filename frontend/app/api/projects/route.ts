import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import {
  deny,
  getMemberships,
  logActivity,
  managedTeamIds,
  requireUser,
  roleIn,
  visibleProjects,
  SUPER_ROLES,
} from "@/lib/permissions";
import { inChunks } from "@/lib/chunks";

// Projects. Supervisors/admins see and manage every project on their desk.
// A team manager manages the projects assigned to their team (checklist #23).
// Everyone else sees projects assigned to their teams, unassigned projects,
// and any project holding a task they can see (checklist #21).

export async function GET() {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const out = await visibleProjects(supabase, user.id);

    // #20: each project's sections, in order.
    const stages = await inChunks<any>(out.map((p: any) => p.id), (part) =>
      supabase.from("stages").select("id, project_id, name, position, created_at").in("project_id", part)
    );
    const byProject = new Map<string, any[]>();
    stages
      .sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0) || String(a.created_at).localeCompare(String(b.created_at)))
      .forEach((st: any) => byProject.set(st.project_id, [...(byProject.get(st.project_id) || []), { id: st.id, name: st.name || "Section", position: st.position ?? 0 }]));

    return NextResponse.json({ projects: out.map((p: any) => ({ ...p, sections: byProject.get(p.id) || [] })) });
  } catch (error: any) {
    console.error("GET /api/projects failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

// Create a project (supervisor/admin, or a manager for their own team).
export async function POST(req: Request) {
  try {
    const { name, description, team_id } = await req.json();
    if (!name?.trim()) return NextResponse.json({ error: "A name is required" }, { status: 400 });

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const memberships = await getMemberships(supabase, user.id);
    const deskId = memberships[0]?.desk_id;
    if (!deskId) return NextResponse.json({ error: "No desk found" }, { status: 400 });
    const role = roleIn(memberships, deskId);

    if (!SUPER_ROLES.includes(role)) {
      const managed = await managedTeamIds(supabase, user.id);
      if (!managed.length) return deny("Only a supervisor or a team manager can create projects.");
      if (!team_id || !managed.includes(team_id)) {
        return deny("A team manager can only create projects for a team they manage.");
      }
    }
    if (team_id) {
      const { data: t } = await supabase.from("teams").select("desk_id").eq("id", team_id).maybeSingle();
      if (!t || t.desk_id !== deskId) return NextResponse.json({ error: "Team not found" }, { status: 404 });
    }

    const { data: project, error } = await supabase
      .from("projects")
      .insert({ desk_id: deskId, name: name.trim(), description: description || null, team_id: team_id || null })
      .select("*")
      .single();
    if (error) throw error;

    // Every project needs at least one section for tasks to sit in (#20).
    const { data: first } = await supabase
      .from("stages")
      .insert({ project_id: project.id, name: "To do", position: 0 })
      .select("id, name, position")
      .single();

    await logActivity(supabase, {
      entity_type: "project", entity_id: project.id, action: `created project ${project.name}`,
      performed_by: user.id, desk_id: deskId, changes: { team_id: team_id || null },
    });
    return NextResponse.json({ ...project, can_manage: true, sections: first ? [first] : [] });
  } catch (error: any) {
    console.error("POST /api/projects failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

// Edit name/description, or assign the project to a team.
export async function PUT(req: Request) {
  try {
    const body = await req.json();
    const { id } = body;
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: project } = await supabase.from("projects").select("*").eq("id", id).maybeSingle();
    const memberships = await getMemberships(supabase, user.id);
    if (!project || !memberships.some((m) => m.desk_id === project.desk_id)) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const role = roleIn(memberships, project.desk_id);
    const managed = await managedTeamIds(supabase, user.id);
    const isSuper = SUPER_ROLES.includes(role);
    const isTeamMgr = project.team_id && managed.includes(project.team_id);
    if (!isSuper && !isTeamMgr) return deny("Only a supervisor or the project's team manager can edit it.");

    const patch: Record<string, any> = {};
    if (body.description !== undefined) patch.description = body.description;
    if (body.name !== undefined && body.name.trim()) patch.name = body.name.trim();
    // #20: the project's workflow rules.
    if (typeof body.auto_advance === "boolean") patch.auto_advance = body.auto_advance;
    if (typeof body.auto_complete === "boolean") patch.auto_complete = body.auto_complete;
    if ("team_id" in body) {
      if (!isSuper) return deny("Only a supervisor can move a project to another team.");
      if (body.team_id) {
        const { data: t } = await supabase.from("teams").select("desk_id").eq("id", body.team_id).maybeSingle();
        if (!t || t.desk_id !== project.desk_id) return NextResponse.json({ error: "Team not found" }, { status: 404 });
      }
      patch.team_id = body.team_id || null;
    }
    if (Object.keys(patch).length === 0) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });

    const { data, error } = await supabase.from("projects").update(patch).eq("id", id).select("*").single();
    if (error) throw error;

    await logActivity(supabase, {
      entity_type: "project", entity_id: id,
      action:
        "team_id" in patch
          ? "assigned the project to a team"
          : "auto_advance" in patch || "auto_complete" in patch
          ? "changed the project's workflow"
          : "edited the project",
      performed_by: user.id, desk_id: project.desk_id, changes: patch,
    });
    const { data: sections } = await supabase.from("stages").select("id, name, position").eq("project_id", id).order("position");
    return NextResponse.json({ ...data, can_manage: true, sections: sections || [] });
  } catch (error: any) {
    console.error("PUT /api/projects failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
