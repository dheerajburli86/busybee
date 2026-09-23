// app/api/team/members/route.ts

import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";
import { DESK_ROLE_VALUES, logActivity, normalizeRole } from "@/lib/permissions";

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
      role: normalizeRole(dm.role),
    })) || [];

    const myRole = normalizeRole(data?.find((dm: any) => dm.user_id === user.id)?.role);

    let pending: any[] = [];
    if (["admin", "supervisor"].includes(myRole)) {
      const { data: waiting } = await supabase.rpc("bb_pending_people", { p_desk: deskIds[0] });
      pending = (waiting || []).map((p: any) => ({ id: p.id, email: p.email, name: p.full_name || p.email, created_at: p.created_at }));
    }

    const seen = new Set<string>();
    const unique = members.filter((m: any) => (seen.has(m.id) ? false : (seen.add(m.id), true)));

    return NextResponse.json({ members: unique, me: user.id, myRole, onDesk: true, pending });
  } catch (error: any) {
    console.error("GET /api/team/members failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

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
    if (!["admin", "supervisor"].includes(normalizeRole(desk.role))) {
      return NextResponse.json({ error: "Only a supervisor or admin can add people" }, { status: 403 });
    }

    const { error } = await supabase.rpc("bb_add_desk_member", { p_desk: desk.desk_id, p_user: user_id, p_role: role });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });

    await logActivity(supabase, {
      entity_type: "desk", entity_id: desk.desk_id, action: `let a new person onto the desk as ${role}`,
      performed_by: user.id, desk_id: desk.desk_id, changes: { user_id, role },
    });
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("POST /api/team/members failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { user_id, role } = await request.json();
    if (!user_id || typeof user_id !== "string") {
      return NextResponse.json({ error: "user_id required" }, { status: 400 });
    }
    if (!DESK_ROLE_VALUES.includes(role)) {
      return NextResponse.json(
        { error: `role must be one of: ${DESK_ROLE_VALUES.join(", ")}` },
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

    const rpc = await supabase.rpc("bb_set_desk_role", { p_user: user_id, p_role: role });
    const rpcMissing =
      !!rpc.error &&
      (rpc.error.code === "PGRST202" || /could not find the function|does not exist/i.test(rpc.error.message || ""));
    if (rpc.error && !rpcMissing) {
      const msg = rpc.error.message || "Could not change the role";
      const status = rpc.error.code === "42501" ? 403 : 400;
      return NextResponse.json({ error: msg }, { status });
    }

    if (rpcMissing) {
      const { data: deskMembers } = await supabase
        .from("desk_members")
        .select("user_id, role")
        .in("desk_id", deskIds);

      const privileged = ["supervisor", "admin"];
      const roleOf = (id: string) => normalizeRole(deskMembers?.find((m: any) => m.user_id === id)?.role);
      const myRole = roleOf(user.id);
      const anyPrivileged = (deskMembers || []).some((m: any) => privileged.includes(normalizeRole(m.role)));

      if (!(deskMembers || []).some((m: any) => m.user_id === user_id)) {
        return NextResponse.json({ error: "That person isn't on your desk" }, { status: 400 });
      }
      if (!privileged.includes(myRole) && anyPrivileged) {
        return NextResponse.json({ error: "Only a supervisor or admin can change roles" }, { status: 403 });
      }
      const anyAdmin = (deskMembers || []).some((m: any) => normalizeRole(m.role) === "admin");
      if ((role === "admin" || roleOf(user_id) === "admin") && myRole !== "admin" && anyAdmin) {
        return NextResponse.json({ error: "Only an admin can make someone an admin or change an admin's role" }, { status: 403 });
      }
      if (user_id === user.id && privileged.includes(myRole) && !privileged.includes(role)) {
        const others = (deskMembers || []).filter(
          (m: any) => m.user_id !== user.id && privileged.includes(normalizeRole(m.role))
        );
        if (others.length === 0) {
          return NextResponse.json({ error: "You are the only supervisor - promote someone else first" }, { status: 400 });
        }
      }

      const { data: changed, error } = await supabase
        .from("desk_members")
        .update({ role })
        .eq("user_id", user_id)
        .in("desk_id", deskIds)
        .select("user_id");
      if (error) throw error;
      if (!changed || changed.length === 0) {
        return NextResponse.json(
          { error: "The database didn't allow the role change. Run the latest BusyBee migration in Supabase, then try again." },
          { status: 409 }
        );
      }
    }

    await logActivity(supabase, {
      entity_type: "desk", entity_id: deskIds[0], action: `changed a desk role to ${role}`,
      performed_by: user.id, desk_id: deskIds[0], changes: { user_id, role },
    });
    return NextResponse.json({ user_id, role });
  } catch (error: any) {
    console.error("PUT /api/team/members failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
