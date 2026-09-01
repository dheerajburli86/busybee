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
    if (deskIds.length === 0) return NextResponse.json([]);

    const { data, error } = await supabase
      .from("task_dependencies")
      .select("id, dependency_id, dependent_id")
      .in("desk_id", deskIds);

    if (error) throw error;
    return NextResponse.json(data || []);
  } catch (error: any) {
    console.error("GET /api/tasks/dependencies failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
