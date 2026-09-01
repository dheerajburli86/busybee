import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";

// SOW #41: Department / Team / Group / Individual structure.
// SOW #27 / #28: roles that decide who can manage what.
async function deskFor(supabase: any, userId: string) {
  const { data } = await supabase
    .from("desk_members")
    .select("desk_id, role")
    .eq("user_id", userId)
    .limit(1)
    .single();
  return data ?? null;
}

export async function GET() {
  try {
    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const ctx = await deskFor(supabase, user.id);
    if (!ctx?.desk_id) {
      return NextResponse.json({ departments: [], teams: [], teamMembers: [], role: "member" });
    }

    const [dept, tm] = await Promise.all([
      supabase
        .from("departments")
        .select("id, name, description, created_at")
        .eq("desk_id", ctx.desk_id)
        .order("created_at", { ascending: true }),
      supabase
        .from("teams")
        .select("id, name, description, department_id, manager_id, created_at")
        .eq("desk_id", ctx.desk_id)
        .order("created_at", { ascending: true }),
    ]);

    const teamIds = (tm.data || []).map((t: any) => t.id);
    let teamMembers: any[] = [];
    if (teamIds.length > 0) {
      const { data } = await supabase
        .from("team_members")
        .select("id, team_id, user_id, role")
        .in("team_id", teamIds);
      teamMembers = data || [];
    }

    return NextResponse.json({
      departments: dept.data || [],
      teams: tm.data || [],
      teamMembers,
      role: ctx.role || "member",
    });
  } catch (error: any) {
    console.error("GET /api/teams failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const ctx = await deskFor(supabase, user.id);
    if (!ctx?.desk_id) return NextResponse.json({ error: "No desk found" }, { status: 400 });

    // Add a person to a team.
    if (body.kind === "member") {
      if (!body.team_id || !body.user_id) {
        return NextResponse.json({ error: "team_id and user_id required" }, { status: 400 });
      }
      const { data, error } = await supabase
        .from("team_members")
        .insert({
          team_id: body.team_id,
          user_id: body.user_id,
          role: body.role || "member",
        })
        .select("id, team_id, user_id, role")
        .single();
      if (error) throw error;
      return NextResponse.json(data);
    }

    if (!body.name?.trim()) {
      return NextResponse.json({ error: "A name is required" }, { status: 400 });
    }

    // Create a department.
    if (body.kind === "department") {
      const { data, error } = await supabase
        .from("departments")
        .insert({
          desk_id: ctx.desk_id,
          name: body.name.trim(),
          description: body.description || null,
        })
        .select("id, name, description, created_at")
        .single();
      if (error) throw error;
      return NextResponse.json(data);
    }

    // Otherwise create a team, optionally inside a department.
    const { data, error } = await supabase
      .from("teams")
      .insert({
        desk_id: ctx.desk_id,
        name: body.name.trim(),
        description: body.description || null,
        department_id: body.department_id || null,
        manager_id: body.manager_id || null,
      })
      .select("id, name, description, department_id, manager_id, created_at")
      .single();

    if (error) throw error;
    return NextResponse.json(data);
  } catch (error: any) {
    console.error("POST /api/teams failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { kind, id } = await req.json();
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const table =
      kind === "department" ? "departments" : kind === "member" ? "team_members" : "teams";

    const { error } = await supabase.from(table).delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("DELETE /api/teams failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
