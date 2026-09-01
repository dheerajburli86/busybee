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
