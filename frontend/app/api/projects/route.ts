import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: memberships } = await supabase
      .from("desk_members")
      .select("desk_id")
      .eq("user_id", user.id);

    const deskIds = (memberships || []).map((m: any) => m.desk_id);
    if (deskIds.length === 0) return NextResponse.json({ projects: [] });

    const { data: projects, error } = await supabase
      .from("projects")
      .select("id, name, description, created_at")
      .in("desk_id", deskIds)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return NextResponse.json({ projects: projects || [] });
  } catch (error: any) {
    console.error("GET /api/projects failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

// SOW #3: edit a project's description.
export async function PUT(req: Request) {
  try {
    const { id, description, name } = await req.json();
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const patch: Record<string, any> = {};
    if (description !== undefined) patch.description = description;
    if (name !== undefined && name.trim()) patch.name = name.trim();

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("projects")
      .update(patch)
      .eq("id", id)
      .select("id, name, description, created_at")
      .single();

    if (error) throw error;
    return NextResponse.json(data);
  } catch (error: any) {
    console.error("PUT /api/projects failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
