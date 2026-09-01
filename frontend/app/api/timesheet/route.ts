import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";

// SOW #43: daily activity report via timesheet.
export async function GET(req: Request) {
  try {
    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const url = new URL(req.url);
    const from = url.searchParams.get("from");

    let q = supabase
      .from("timesheet_entries")
      .select("id, task_id, entry_date, hours, notes, created_at")
      .eq("user_id", user.id)
      .order("entry_date", { ascending: false });

    if (from) q = q.gte("entry_date", from);

    const { data, error } = await q;
    if (error) throw error;
    return NextResponse.json({ entries: data || [] });
  } catch (error: any) {
    console.error("GET /api/timesheet failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { task_id, entry_date, hours, notes } = await req.json();
    if (!hours || Number(hours) <= 0) {
      return NextResponse.json({ error: "Hours must be greater than zero" }, { status: 400 });
    }

    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data, error } = await supabase
      .from("timesheet_entries")
      .insert({
        user_id: user.id,
        task_id: task_id || null,
        entry_date: entry_date || new Date().toISOString().slice(0, 10),
        hours: Number(hours),
        notes: notes || null,
      })
      .select("id, task_id, entry_date, hours, notes, created_at")
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
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { error } = await supabase
      .from("timesheet_entries")
      .delete()
      .eq("id", entry_id)
      .eq("user_id", user.id);

    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("DELETE /api/timesheet failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
