// app/api/team/members/route.ts

import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";

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
    if (deskIds.length === 0) return NextResponse.json({ members: [], me: user.id });

    const { data, error } = await supabase
      .from("desk_members")
      .select("user_id, users(id, email, full_name)")
      .in("desk_id", deskIds);

    if (error) throw error;

    const members = data?.map((dm: any) => ({
      id: dm.user_id,
      email: dm.users?.email,
      name: dm.users?.full_name || dm.users?.email,
    })) || [];

    return NextResponse.json({ members, me: user.id });
  } catch (error: any) {
    console.error("GET /api/team/members failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
