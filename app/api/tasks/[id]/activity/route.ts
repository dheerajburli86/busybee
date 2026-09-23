// app/api/tasks/[id]/activity/route.ts
// Checklist #41: the full history of one task - who did what, when, and the
// before/after values.

import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";
import { requireUser, taskAccess } from "@/lib/permissions";
import { attachNames } from "@/lib/names";
import { namesForChanges } from "@/lib/describe";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: taskId } = await params;
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const access = await taskAccess(supabase, user.id, taskId);
    if (!access?.canView) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    const { data, error } = await supabase
      .from("activity_log")
      .select("id, action, performed_by, created_at, changes")
      .eq("entity_id", taskId)
      .eq("entity_type", "task")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;

    // Each row carries readable names for any ids in its changes.
    const rows = data || [];
    const names = await namesForChanges(supabase, rows);
    return NextResponse.json((await attachNames(supabase, rows, "performed_by")).map((r: any) => ({ ...r, names })));
  } catch (error: any) {
    console.error("GET /api/tasks/[id]/activity failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
