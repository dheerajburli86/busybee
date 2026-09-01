import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";

// SOW #45: overdue module.
// The assignee states a reason and asks for a new deadline; the assignor
// approves it as-is or substitutes a different date.

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data, error } = await supabase
      .from("extension_requests")
      .select("id, reason, requested_date, status, approved_date, review_note, requested_by, created_at")
      .eq("task_id", id)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return NextResponse.json(data || []);
  } catch (error: any) {
    console.error("GET extension_requests failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { reason, requested_date } = await req.json();

    if (!reason || !reason.trim()) {
      return NextResponse.json({ error: "A reason for the delay is required" }, { status: 400 });
    }
    if (!requested_date) {
      return NextResponse.json({ error: "A requested new date is required" }, { status: 400 });
    }

    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data, error } = await supabase
      .from("extension_requests")
      .insert({
        task_id: id,
        requested_by: user.id,
        reason: reason.trim(),
        requested_date,
        status: "pending",
      })
      .select("id, reason, requested_date, status, created_at")
      .single();

    if (error) throw error;

    // Tell whoever created the task that an extension is waiting on them.
    const { data: task } = await supabase
      .from("tasks")
      .select("title, created_by")
      .eq("id", id)
      .single();

    if (task?.created_by && task.created_by !== user.id) {
      await supabase.from("notifications").insert({
        user_id: task.created_by,
        task_id: id,
        type: "extension_request",
        title: "Extension requested",
        message: `A new deadline was requested for: ${task.title}`,
        read: false,
      }).then(() => {}, () => {});
    }

    return NextResponse.json(data);
  } catch (error: any) {
    console.error("POST extension_requests failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

// Approve, amend, or reject. An approved request writes the new date onto the task.
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { request_id, status, approved_date, review_note } = await req.json();

    if (!request_id) {
      return NextResponse.json({ error: "request_id is required" }, { status: 400 });
    }
    if (!["approved", "rejected"].includes(status)) {
      return NextResponse.json({ error: "status must be approved or rejected" }, { status: 400 });
    }

    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: existing } = await supabase
      .from("extension_requests")
      .select("requested_by, requested_date")
      .eq("id", request_id)
      .single();

    // The assignor may accept the date asked for, or set a different one.
    const finalDate = status === "approved"
      ? (approved_date || existing?.requested_date || null)
      : null;

    const { data, error } = await supabase
      .from("extension_requests")
      .update({
        status,
        reviewed_by: user.id,
        approved_date: finalDate,
        review_note: review_note || null,
      })
      .eq("id", request_id)
      .select("id, status, approved_date, review_note")
      .single();

    if (error) throw error;

    if (status === "approved" && finalDate) {
      await supabase.from("tasks").update({ due_date: finalDate }).eq("id", id);
    }

    if (existing?.requested_by && existing.requested_by !== user.id) {
      await supabase.from("notifications").insert({
        user_id: existing.requested_by,
        task_id: id,
        type: "extension_reviewed",
        title: status === "approved" ? "Extension approved" : "Extension rejected",
        message:
          status === "approved"
            ? `New deadline: ${new Date(finalDate as string).toLocaleString()}`
            : review_note || "Your extension request was not approved",
        read: false,
      }).then(() => {}, () => {});
    }

    return NextResponse.json(data);
  } catch (error: any) {
    console.error("PUT extension_requests failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
