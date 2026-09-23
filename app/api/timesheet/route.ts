import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { getMemberships, requireUser, MANAGER_ROLES } from "@/lib/permissions";
import { officeToday } from "@/lib/format";

// SOW #43 / checklist #39: daily activity report via timesheet. Everyone
// logs their own time; supervisors and managers can also read the entries of
// people on their desk (GET ?user_id=).

async function mayRead(supabase: any, me: string, them: string) {
  if (me === them) return true;
  const [mine, theirs] = await Promise.all([getMemberships(supabase, me), getMemberships(supabase, them)]);
  return mine.some((m) => MANAGER_ROLES.includes(m.role) && theirs.some((t) => t.desk_id === m.desk_id));
}

export async function GET(req: Request) {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const url = new URL(req.url);
    const from = url.searchParams.get("from");
    const who = url.searchParams.get("user_id") || user.id;
    if (!(await mayRead(supabase, user.id, who))) {
      return NextResponse.json({ error: "You can only see your own timesheet" }, { status: 403 });
    }

    let q = supabase
      .from("timesheet_entries")
      .select("id, user_id, task_id, entry_date, hours, notes, created_at")
      .eq("user_id", who)
      .order("entry_date", { ascending: false })
      .limit(1000);

    if (from) q = q.gte("entry_date", from);

    const { data, error } = await q;
    if (error) throw error;

    // Task titles for the entries, so a lead sees what the time went on.
    const taskIds = Array.from(new Set((data || []).map((e: any) => e.task_id).filter(Boolean)));
    const { data: tasks } = taskIds.length
      ? await supabase.from("tasks").select("id, title").in("id", taskIds.slice(0, 200))
      : { data: [] };
    const titles = new Map((tasks || []).map((t: any) => [t.id, t.title]));

    return NextResponse.json({
      entries: (data || []).map((e: any) => ({ ...e, task_title: e.task_id ? titles.get(e.task_id) || null : null })),
      user_id: who,
    });
  } catch (error: any) {
    console.error("GET /api/timesheet failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { task_id, entry_date, hours, notes } = await req.json();
    const h = Number(hours);
    if (!h || h <= 0) {
      return NextResponse.json({ error: "Hours must be greater than zero" }, { status: 400 });
    }
    if (h > 24) return NextResponse.json({ error: "That's more than a day" }, { status: 400 });
    if (entry_date && !/^\d{4}-\d{2}-\d{2}$/.test(entry_date)) {
      return NextResponse.json({ error: "Pick a valid date" }, { status: 400 });
    }

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data, error } = await supabase
      .from("timesheet_entries")
      .insert({
        user_id: user.id,
        task_id: task_id || null,
        // Today in the office's timezone, not the server's (UTC).
        entry_date: entry_date || officeToday(),
        hours: h,
        notes: notes || null,
      })
      .select("id, user_id, task_id, entry_date, hours, notes, created_at")
      .single();

    if (error) throw error;
    return NextResponse.json(data);
  } catch (error: any) {
    console.error("POST /api/timesheet failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { entry_id } = await req.json();
    if (!entry_id) return NextResponse.json({ error: "entry_id required" }, { status: 400 });

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data, error } = await supabase
      .from("timesheet_entries")
      .delete()
      .eq("id", entry_id)
      .eq("user_id", user.id)
      .select("id");

    if (error) throw error;
    if (!data || data.length === 0) return NextResponse.json({ error: "Entry not found" }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("DELETE /api/timesheet failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
