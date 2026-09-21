// app/api/team/members/route.ts

import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";
import { logActivity } from "@/lib/permissions";

export async function GET(request: NextRequest) {
  try {
    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: memberships } = await supabase
      .from("desk_members")
      .select("desk_id")
      .eq("user_id", user.id);

    const deskIds = (memberships || []).map((m: any) => m.desk_id);
    // #21: someone who signed up but hasn't been let onto a desk yet.
    if (deskIds.length === 0) return NextResponse.json({ members: [], me: user.id, myRole: "member", onDesk: false, email: user.email });

    const { data, error } = await supabase
      .from("desk_members")
      .select("user_id, role, desk_id, users(id, email, full_name)")
      .in("desk_id", deskIds);

    if (error) throw error;

    const members = data?.map((dm: any) => ({
      id: dm.user_id,
      email: dm.users?.email,
      name: dm.users?.full_name || dm.users?.email,
      role: dm.role || "member",
    })) || [];

    // The caller's own role decides whether the UI offers role editing.
    const myRole =
      data?.find((dm: any) => dm.user_id === user.id)?.role || "member";

    // Supervisors also see accounts waiting to be let in.
    let pending: any[] = [];
    if (["admin", "supervisor"].includes(myRole)) {
      const { data: waiting } = await supabase.rpc("bb_pending_people", { p_desk: deskIds[0] });
      pending = (waiting || []).map((p: any) => ({ id: p.id, email: p.email, name: p.full_name || p.email, created_at: p.created_at }));
    }

    // One row per person even if they're on several desks.
    const seen = new Set<string>();
    const unique = members.filter((m: any) => (seen.has(m.id) ? false : (seen.add(m.id), true)));

    return NextResponse.json({ members: unique, me: user.id, myRole, onDesk: true, pending });
  } catch (error: any) {
    console.error("GET /api/team/members failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

// #21: let a new account onto the desk (supervisors and admins).
export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { user_id, role = "member" } = await request.json();
    if (!user_id) return NextResponse.json({ error: "user_id required" }, { status: 400 });

    const { data: memberships } = await supabase.from("desk_members").select("desk_id, role").eq("user_id", user.id);
    const desk = (memberships || [])[0];
    if (!desk) return NextResponse.json({ error: "You are not on a desk" }, { status: 403 });
    if (!["admin", "supervisor"].includes(desk.role)) {
      return NextResponse.json({ error: "Only a supervisor or admin can add people" }, { status: 403 });
    }

    const { error } = await supabase.rpc("bb_add_desk_member", { p_desk: desk.desk_id, p_user: user_id, p_role: role });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });

    await logActivity(supabase, {
      entity_type: "team", entity_id: desk.desk_id, action: `let a new person onto the desk as ${role}`,
      performed_by: user.id, desk_id: desk.desk_id, changes: { user_id, role },
    });
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("POST /api/team/members failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

// SOW #27 / #28: promote someone to supervisor, manager or admin.
//
// Only an existing privileged member may do this. There is one exception: a
// brand new desk has nobody privileged, so the change is allowed while no
// supervisor, manager or admin exists yet. That lets the first person set
// themselves up without a manual SQL statement, and closes as soon as one
// privileged member exists.
export async function PUT(request: NextRequest) {
  const ROLES = ["member", "manager", "supervisor", "admin"];

  try {
    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { user_id, role } = await request.json();
    if (!user_id) {
      return NextResponse.json({ error: "user_id required" }, { status: 400 });
    }
    if (!ROLES.includes(role)) {
      return NextResponse.json(
        { error: `role must be one of: ${ROLES.join(", ")}` },
        { status: 400 }
      );
    }

    const { data: memberships } = await supabase
      .from("desk_members")
      .select("desk_id")
      .eq("user_id", user.id);

    const deskIds = (memberships || []).map((m: any) => m.desk_id);
    if (deskIds.length === 0) {
      return NextResponse.json({ error: "You are not on a desk" }, { status: 403 });
    }

    const { data: deskMembers } = await supabase
      .from("desk_members")
      .select("user_id, role")
      .in("desk_id", deskIds);

    // Checklist #21: only supervisors and admins manage desk roles, and only
    // an admin can make someone else an admin.
    const privileged = ["supervisor", "admin"];
    const myRole =
      deskMembers?.find((m: any) => m.user_id === user.id)?.role || "member";
    const anyPrivileged = (deskMembers || []).some((m: any) =>
      privileged.includes(m.role || "member")
    );

    if (!privileged.includes(myRole) && anyPrivileged) {
      return NextResponse.json(
        { error: "Only a supervisor or admin can change roles" },
        { status: 403 }
      );
    }
    if (role === "admin" && myRole !== "admin" && anyPrivileged) {
      return NextResponse.json({ error: "Only an admin can make someone an admin" }, { status: 403 });
    }

    // Don't let the last privileged member demote themselves and lock
    // everyone out of role management.
    if (
      user_id === user.id &&
      privileged.includes(myRole) &&
      !privileged.includes(role)
    ) {
      const others = (deskMembers || []).filter(
        (m: any) => m.user_id !== user.id && privileged.includes(m.role || "member")
      );
      if (others.length === 0) {
        return NextResponse.json(
          { error: "You are the only supervisor - promote someone else first" },
          { status: 400 }
        );
      }
    }

    const { error } = await supabase
      .from("desk_members")
      .update({ role })
      .eq("user_id", user_id)
      .in("desk_id", deskIds);

    if (error) throw error;
    await logActivity(supabase, {
      entity_type: "team", entity_id: deskIds[0], action: `changed a desk role to ${role}`,
      performed_by: user.id, desk_id: deskIds[0], changes: { user_id, role },
    });
    return NextResponse.json({ user_id, role });
  } catch (error: any) {
    console.error("PUT /api/team/members failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
