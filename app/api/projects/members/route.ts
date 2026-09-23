// Project members: who works on a project, and which of them run it.
//
// This is the whole of the access model below supervisor level - being on a
// project is what lets someone see and work on its tasks (lib/permissions.ts:
// userProjectIds / managedProjectIds). A member with role "manager" runs the
// project alongside projects.manager_id.

import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { deny, logActivity, projectAccess, requireUser } from "@/lib/permissions";

const MEMBER_ROLES = ["member", "manager"];

/** GET /api/projects/members?project_id=... - the people on one project. */
export async function GET(req: Request) {
  try {
    const projectId = new URL(req.url).searchParams.get("project_id");
    if (!projectId) return NextResponse.json({ error: "project_id required" }, { status: 400 });

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const access = await projectAccess(supabase, user.id, projectId);
    if (!access) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const { data, error } = await supabase
      .from("project_members")
      .select("id, user_id, role, users(id, email, full_name)")
      .eq("project_id", projectId);
    if (error) throw error;

    const members = (data || []).map((m: any) => ({
      id: m.id,
      user_id: m.user_id,
      role: MEMBER_ROLES.includes(m.role) ? m.role : "member",
      // The proper name; the email is only a fallback for a profile with no
      // name set. Fill users.full_name and this shows "Shankar Sharma".
      name: m.users?.full_name || m.users?.email || "Someone",
      email: m.users?.email || null,
    }));
    return NextResponse.json({ members, can_manage: access.canManage });
  } catch (error: any) {
    console.error("GET /api/projects/members failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

/** POST - add someone to a project. */
export async function POST(req: Request) {
  try {
    const { project_id, user_id, role = "member" } = await req.json();
    if (!project_id || !user_id) {
      return NextResponse.json({ error: "project_id and user_id required" }, { status: 400 });
    }
    if (!MEMBER_ROLES.includes(role)) {
      return NextResponse.json({ error: "Unknown role" }, { status: 400 });
    }

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const access = await projectAccess(supabase, user.id, project_id);
    if (!access) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (!access.canManage) return deny("Only a supervisor or the project's manager can add members.");

    // They must already be on this desk.
    const { data: onDesk } = await supabase
      .from("desk_members")
      .select("user_id")
      .eq("desk_id", access.project.desk_id)
      .eq("user_id", user_id)
      .limit(1);
    if (!onDesk || onDesk.length === 0) {
      return NextResponse.json({ error: "That person isn't on this desk" }, { status: 400 });
    }

    const { data: already } = await supabase
      .from("project_members")
      .select("id")
      .eq("project_id", project_id)
      .eq("user_id", user_id)
      .limit(1);
    if (already && already.length) {
      return NextResponse.json({ error: "They're already on this project" }, { status: 409 });
    }

    const { data, error } = await supabase
      .from("project_members")
      .insert({ project_id, user_id, role })
      .select("id, user_id, role, users(id, email, full_name)")
      .single();
    if (error) throw error;

    await logActivity(supabase, {
      entity_type: "project",
      entity_id: project_id,
      action: "added a project member",
      performed_by: user.id,
      desk_id: access.project.desk_id,
      changes: { user_id, role },
    });

    const m: any = data;
    return NextResponse.json({
      id: m.id,
      user_id: m.user_id,
      role: m.role,
      name: m.users?.full_name || m.users?.email || "Someone",
      email: m.users?.email || null,
    });
  } catch (error: any) {
    console.error("POST /api/projects/members failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

/** PUT - change a member's role on the project. */
export async function PUT(req: Request) {
  try {
    const { id, role } = await req.json();
    if (!id || !MEMBER_ROLES.includes(role)) {
      return NextResponse.json({ error: "id and a valid role required" }, { status: 400 });
    }

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: row } = await supabase
      .from("project_members")
      .select("id, project_id, user_id")
      .eq("id", id)
      .maybeSingle();
    if (!row) return NextResponse.json({ error: "Member not found" }, { status: 404 });

    const access = await projectAccess(supabase, user.id, row.project_id);
    if (!access) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (!access.canManage) return deny("Only a supervisor or the project's manager can change roles.");

    const { data, error } = await supabase
      .from("project_members")
      .update({ role })
      .eq("id", id)
      .select("id, user_id, role")
      .single();
    if (error) throw error;

    await logActivity(supabase, {
      entity_type: "project",
      entity_id: row.project_id,
      action: "changed a project member's role",
      performed_by: user.id,
      desk_id: access.project.desk_id,
      changes: { user_id: row.user_id, role },
    });
    return NextResponse.json(data);
  } catch (error: any) {
    console.error("PUT /api/projects/members failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

/** DELETE /api/projects/members?id=... - take someone off a project. */
export async function DELETE(req: Request) {
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: row } = await supabase
      .from("project_members")
      .select("id, project_id, user_id")
      .eq("id", id)
      .maybeSingle();
    if (!row) return NextResponse.json({ error: "Member not found" }, { status: 404 });

    const access = await projectAccess(supabase, user.id, row.project_id);
    if (!access) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (!access.canManage) return deny("Only a supervisor or the project's manager can remove members.");

    const { error } = await supabase.from("project_members").delete().eq("id", id);
    if (error) throw error;

    await logActivity(supabase, {
      entity_type: "project",
      entity_id: row.project_id,
      action: "removed a project member",
      performed_by: user.id,
      desk_id: access.project.desk_id,
      changes: { user_id: row.user_id },
    });
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("DELETE /api/projects/members failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
