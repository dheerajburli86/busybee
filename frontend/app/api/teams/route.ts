import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import {
  deny,
  getMemberships,
  logActivity,
  managedTeamIds,
  requireUser,
  roleIn,
  SUPER_ROLES,
} from "@/lib/permissions";

// Checklist #23 / #25 / #26, SOW #41: departments, teams, custom groups.
//
//   departments, teams      - created/removed by a supervisor or admin
//   team members            - added/removed by a supervisor/admin or that
//                             team's manager; team roles likewise
//   custom groups           - any member can make one for assigning work;
//                             the creator (or a supervisor) manages it

async function primaryDesk(supabase: any, userId: string) {
  const memberships = await getMemberships(supabase, userId);
  const deskId = memberships[0]?.desk_id ?? null;
  return { deskId, role: roleIn(memberships, deskId), memberships };
}

export async function GET() {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { deskId, role } = await primaryDesk(supabase, user.id);
    if (!deskId) {
      return NextResponse.json({ departments: [], teams: [], teamMembers: [], groups: [], groupMembers: [], role: "member", managedTeams: [], me: user.id });
    }

    const [dept, tm, gr, managed] = await Promise.all([
      supabase.from("departments").select("id, name, description, created_at").eq("desk_id", deskId).order("created_at"),
      supabase.from("teams").select("id, name, description, department_id, manager_id, created_at").eq("desk_id", deskId).order("created_at"),
      supabase.from("groups").select("id, name, created_by, created_at").eq("desk_id", deskId).order("created_at"),
      managedTeamIds(supabase, user.id),
    ]);

    const teamIds = (tm.data || []).map((t: any) => t.id);
    const groupIds = (gr.data || []).map((g: any) => g.id);
    const [tmem, gmem] = await Promise.all([
      teamIds.length
        ? supabase.from("team_members").select("id, team_id, user_id, role").in("team_id", teamIds)
        : Promise.resolve({ data: [] }),
      groupIds.length
        ? supabase.from("group_members").select("id, group_id, user_id").in("group_id", groupIds)
        : Promise.resolve({ data: [] }),
    ]);

    return NextResponse.json({
      departments: dept.data || [],
      teams: tm.data || [],
      teamMembers: (tmem as any).data || [],
      groups: gr.data || [],
      groupMembers: (gmem as any).data || [],
      role,
      managedTeams: managed,
      me: user.id,
    });
  } catch (error: any) {
    console.error("GET /api/teams failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

async function teamOnDesk(supabase: any, teamId: string, deskId: string) {
  const { data } = await supabase.from("teams").select("id, name, desk_id").eq("id", teamId).maybeSingle();
  return data && data.desk_id === deskId ? data : null;
}

async function groupOnDesk(supabase: any, groupId: string, deskId: string) {
  const { data } = await supabase.from("groups").select("id, name, desk_id, created_by").eq("id", groupId).maybeSingle();
  return data && data.desk_id === deskId ? data : null;
}

async function onDesk(supabase: any, userId: string, deskId: string) {
  const m = await getMemberships(supabase, userId);
  return m.some((x) => x.desk_id === deskId);
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { deskId, role } = await primaryDesk(supabase, user.id);
    if (!deskId) return NextResponse.json({ error: "No desk found" }, { status: 400 });
    const isSuper = SUPER_ROLES.includes(role);

    // Add a person to a team.
    if (body.kind === "member") {
      if (!body.team_id || !body.user_id) {
        return NextResponse.json({ error: "team_id and user_id required" }, { status: 400 });
      }
      const team = await teamOnDesk(supabase, body.team_id, deskId);
      if (!team) return NextResponse.json({ error: "Team not found" }, { status: 404 });
      const managed = await managedTeamIds(supabase, user.id);
      if (!isSuper && !managed.includes(team.id)) return deny("Only a supervisor or this team's manager can add members.");
      if (!(await onDesk(supabase, body.user_id, deskId))) {
        return NextResponse.json({ error: "That person isn't on this desk" }, { status: 400 });
      }
      const teamRole = body.role === "manager" ? "manager" : "member";
      if (teamRole === "manager" && !isSuper) return deny("Only a supervisor can appoint a team manager.");

      const { data, error } = await supabase
        .from("team_members")
        .insert({ team_id: team.id, user_id: body.user_id, role: teamRole })
        .select("id, team_id, user_id, role")
        .single();
      if (error) throw error;
      await logActivity(supabase, {
        entity_type: "team", entity_id: team.id, action: `added a member to ${team.name}`,
        performed_by: user.id, desk_id: deskId, changes: { user_id: body.user_id, role: teamRole },
      });
      return NextResponse.json(data);
    }

    // Custom group (checklist #26): anyone can make one to assign work to.
    if (body.kind === "group") {
      if (!body.name?.trim()) return NextResponse.json({ error: "A name is required" }, { status: 400 });
      const { data, error } = await supabase
        .from("groups")
        .insert({ desk_id: deskId, name: body.name.trim(), created_by: user.id })
        .select("id, name, created_by, created_at")
        .single();
      if (error) throw error;

      const members: string[] = Array.from(new Set([user.id, ...(Array.isArray(body.user_ids) ? body.user_ids : [])]));
      const valid: string[] = [];
      for (const uid of members) if (await onDesk(supabase, uid, deskId)) valid.push(uid);
      let groupMembers: any[] = [];
      if (valid.length) {
        const { data: gm } = await supabase
          .from("group_members")
          .insert(valid.map((user_id) => ({ group_id: data.id, user_id })))
          .select("id, group_id, user_id");
        groupMembers = gm || [];
      }
      await logActivity(supabase, {
        entity_type: "group", entity_id: data.id, action: `created group ${data.name}`,
        performed_by: user.id, desk_id: deskId, changes: { members: valid },
      });
      return NextResponse.json({ ...data, members: groupMembers });
    }

    if (body.kind === "group_member") {
      const group = await groupOnDesk(supabase, body.group_id, deskId);
      if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 });
      if (group.created_by !== user.id && !isSuper) return deny("Only the group's creator or a supervisor can change it.");
      if (!(await onDesk(supabase, body.user_id, deskId))) {
        return NextResponse.json({ error: "That person isn't on this desk" }, { status: 400 });
      }
      const { data, error } = await supabase
        .from("group_members")
        .insert({ group_id: group.id, user_id: body.user_id })
        .select("id, group_id, user_id")
        .single();
      if (error) throw error;
      return NextResponse.json(data);
    }

    if (!isSuper) return deny("Only a supervisor or admin can create departments and teams.");
    if (!body.name?.trim()) return NextResponse.json({ error: "A name is required" }, { status: 400 });

    if (body.kind === "department") {
      const { data, error } = await supabase
        .from("departments")
        .insert({ desk_id: deskId, name: body.name.trim(), description: body.description || null })
        .select("id, name, description, created_at")
        .single();
      if (error) throw error;
      await logActivity(supabase, {
        entity_type: "department", entity_id: data.id, action: `created department ${data.name}`,
        performed_by: user.id, desk_id: deskId,
      });
      return NextResponse.json(data);
    }

    // Otherwise create a team, optionally inside a department, with a manager.
    if (body.manager_id && !(await onDesk(supabase, body.manager_id, deskId))) {
      return NextResponse.json({ error: "That manager isn't on this desk" }, { status: 400 });
    }
    const { data, error } = await supabase
      .from("teams")
      .insert({
        desk_id: deskId,
        name: body.name.trim(),
        description: body.description || null,
        department_id: body.department_id || null,
        manager_id: body.manager_id || null,
      })
      .select("id, name, description, department_id, manager_id, created_at")
      .single();
    if (error) throw error;
    await logActivity(supabase, {
      entity_type: "team", entity_id: data.id, action: `created team ${data.name}`,
      performed_by: user.id, desk_id: deskId,
    });
    return NextResponse.json(data);
  } catch (error: any) {
    console.error("POST /api/teams failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

// Update a team (manager, department, name) or a member's team role.
export async function PUT(req: Request) {
  try {
    const body = await req.json();
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { deskId, role } = await primaryDesk(supabase, user.id);
    if (!deskId) return NextResponse.json({ error: "No desk found" }, { status: 400 });
    const isSuper = SUPER_ROLES.includes(role);

    if (body.kind === "member") {
      const { data: tm } = await supabase.from("team_members").select("id, team_id, user_id").eq("id", body.id).maybeSingle();
      const team = tm ? await teamOnDesk(supabase, tm.team_id, deskId) : null;
      if (!tm || !team) return NextResponse.json({ error: "Member not found" }, { status: 404 });
      if (!isSuper) return deny("Only a supervisor can change team roles.");
      const newRole = body.role === "manager" ? "manager" : "member";
      const { data, error } = await supabase
        .from("team_members").update({ role: newRole }).eq("id", tm.id)
        .select("id, team_id, user_id, role").single();
      if (error) throw error;
      await logActivity(supabase, {
        entity_type: "team", entity_id: team.id, action: `made a member ${newRole} of ${team.name}`,
        performed_by: user.id, desk_id: deskId, changes: { user_id: tm.user_id, role: newRole },
      });
      return NextResponse.json(data);
    }

    const team = await teamOnDesk(supabase, body.id, deskId);
    if (!team) return NextResponse.json({ error: "Team not found" }, { status: 404 });
    if (!isSuper) return deny("Only a supervisor can change a team.");

    const patch: Record<string, any> = {};
    if ("manager_id" in body) {
      if (body.manager_id && !(await onDesk(supabase, body.manager_id, deskId))) {
        return NextResponse.json({ error: "That manager isn't on this desk" }, { status: 400 });
      }
      patch.manager_id = body.manager_id || null;
    }
    if ("department_id" in body) patch.department_id = body.department_id || null;
    if (body.name?.trim()) patch.name = body.name.trim();

    const { data, error } = await supabase
      .from("teams").update(patch).eq("id", team.id)
      .select("id, name, description, department_id, manager_id, created_at").single();
    if (error) throw error;
    await logActivity(supabase, {
      entity_type: "team", entity_id: team.id, action: `updated team ${data.name}`,
      performed_by: user.id, desk_id: deskId, changes: patch,
    });
    return NextResponse.json(data);
  } catch (error: any) {
    console.error("PUT /api/teams failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { kind, id } = await req.json();
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { deskId, role } = await primaryDesk(supabase, user.id);
    if (!deskId) return NextResponse.json({ error: "No desk found" }, { status: 400 });
    const isSuper = SUPER_ROLES.includes(role);

    if (kind === "member") {
      const { data: tm } = await supabase.from("team_members").select("id, team_id, user_id").eq("id", id).maybeSingle();
      const team = tm ? await teamOnDesk(supabase, tm.team_id, deskId) : null;
      if (!tm || !team) return NextResponse.json({ error: "Member not found" }, { status: 404 });
      const managed = await managedTeamIds(supabase, user.id);
      if (!isSuper && !managed.includes(team.id)) return deny("Only a supervisor or this team's manager can remove members.");
      await supabase.from("team_members").delete().eq("id", id);
      await logActivity(supabase, {
        entity_type: "team", entity_id: team.id, action: `removed a member from ${team.name}`,
        performed_by: user.id, desk_id: deskId, changes: { user_id: tm.user_id },
      });
      return NextResponse.json({ success: true });
    }

    if (kind === "group" || kind === "group_member") {
      let groupId = id;
      let memberUser: string | null = null;
      if (kind === "group_member") {
        const { data: gm } = await supabase.from("group_members").select("id, group_id, user_id").eq("id", id).maybeSingle();
        if (!gm) return NextResponse.json({ error: "Member not found" }, { status: 404 });
        groupId = gm.group_id;
        memberUser = gm.user_id;
      }
      const group = await groupOnDesk(supabase, groupId, deskId);
      if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 });
      const leavingSelf = kind === "group_member" && memberUser === user.id;
      if (group.created_by !== user.id && !isSuper && !leavingSelf) {
        return deny("Only the group's creator or a supervisor can change it.");
      }
      await supabase.from(kind === "group" ? "groups" : "group_members").delete().eq("id", id);
      await logActivity(supabase, {
        entity_type: "group", entity_id: group.id,
        action: kind === "group" ? `deleted group ${group.name}` : `removed a member from ${group.name}`,
        performed_by: user.id, desk_id: deskId,
      });
      return NextResponse.json({ success: true });
    }

    if (!isSuper) return deny("Only a supervisor or admin can remove departments and teams.");
    const table = kind === "department" ? "departments" : "teams";
    const { data: row } = await supabase.from(table).select("id, name, desk_id").eq("id", id).maybeSingle();
    if (!row || row.desk_id !== deskId) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const { error } = await supabase.from(table).delete().eq("id", id);
    if (error) throw error;
    await logActivity(supabase, {
      entity_type: kind === "department" ? "department" : "team", entity_id: id,
      action: `deleted ${kind === "department" ? "department" : "team"} ${row.name}`,
      performed_by: user.id, desk_id: deskId,
    });
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("DELETE /api/teams failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
