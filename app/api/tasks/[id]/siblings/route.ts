import { NextResponse } from "next/server";
import { createServerSideClient } from "@/lib/supabase-server";
import { createAdminClient } from "@/lib/supabase-admin";
import { requireUser, taskAccess } from "@/lib/permissions";
import { attachNames } from "@/lib/names";

// The same task given to several people at once: each person has their own
// copy (made in one go by the same person, same title and deadline). This
// tells each of them who else has it and how far they've got - names and
// status only, nothing else about the other copies.

export const dynamic = "force-dynamic";

/** Copies made in one go are created within this long of each other. */
const SAME_BATCH_MS = 2 * 60 * 1000;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const access = await taskAccess(supabase, user.id, id);
    if (!access?.canView) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    const t: any = access.task;
    if (!t.assigned_to || t.personal || !t.created_at) return NextResponse.json([]);

    const created = Date.parse(t.created_at);
    const db = createAdminClient() || supabase;
    const { data, error } = await db
      .from("tasks")
      .select("id, assigned_to, status, due_date, created_at")
      .eq("desk_id", t.desk_id)
      .eq("created_by", t.created_by)
      .eq("title", t.title)
      .gte("created_at", new Date(created - SAME_BATCH_MS).toISOString())
      .lte("created_at", new Date(created + SAME_BATCH_MS).toISOString())
      .neq("id", t.id)
      .is("archived_at", null);
    if (error) throw error;
    const sameDue = (x: any) => (x.due_date ? Date.parse(x.due_date) : null) === (t.due_date ? Date.parse(t.due_date) : null);
    const rows = (data || []).filter((x: any) => x.assigned_to && x.assigned_to !== t.assigned_to && sameDue(x));
    const named = await attachNames(supabase, rows.map((x: any) => ({ user_id: x.assigned_to, status: x.status })), "user_id", "name");
    return NextResponse.json(named);
  } catch (error: any) {
    console.error("GET /api/tasks/[id]/siblings failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
