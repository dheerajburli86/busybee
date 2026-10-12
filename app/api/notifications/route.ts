// app/api/notifications/route.ts

import { createServerSideClient } from "@/lib/supabase-server";
import { requireUser } from "@/lib/permissions";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data, error } = await supabase
      .from("notifications")
      .select("id, title, message, type, read, created_at, task_id")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw error;
    return NextResponse.json(data || []);
  } catch (error: any) {
    console.error("GET /api/notifications failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id, all } = await request.json();
    if (!id && !all) return NextResponse.json({ error: "id or all required" }, { status: 400 });

    let q = supabase.from("notifications").update({ read: true }).eq("user_id", user.id);
    q = all ? q.eq("read", false) : q.eq("id", id);
    const { error } = await q;

    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("PATCH /api/notifications failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
