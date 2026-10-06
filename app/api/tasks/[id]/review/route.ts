import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import {
  deny,
  logActivity,
  notifyMany,
  requireUser,
  taskAccess,
  taskAudience,
} from "@/lib/permissions";
import { schemaMissing, workersOn } from "@/lib/workflow";
import { sendMail } from "@/lib/email";

// Step 9 of the assignment flow: a supervisor signs the finished work off, or
// sends it back with a note.
//
// The review happens outside BusyBee - a call, a demo, a read-through. What
// this route records is the *decision*, because that is what the reward and
// penalty entries hang off and what anyone asking "was this ever actually
// checked?" needs to see months later.
//
//   approved   -> task moves from "done" to "closed". A reward or penalty may
//                 then be attached (see /api/tasks/[id]/adjustment).
//   sent_back  -> task returns to "in_progress" with the reviewer's note, and
//                 the people doing it are told why.

type Params = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const body = await req.json();
    const decision: string = body?.decision;
    const note: string = typeof body?.note === "string" ? body.note.trim() : "";

    if (!["approved", "sent_back"].includes(decision)) {
      return NextResponse.json({ error: "decision must be approved or sent_back" }, { status: 400 });
    }
    if (decision === "sent_back" && !note) {
      return NextResponse.json(
        { error: "Say what needs redoing - sending work back without a reason just loses time" },
        { status: 400 }
      );
    }

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const access = await taskAccess(supabase, user.id, id);
    if (!access) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    if (!access.canManage) {
      return deny("Only the assignor, the project's manager or a supervisor can review finished work.");
    }

    const workers = await workersOn(supabase, access.task);
    // Same principle as the extension flow: nobody signs off their own work.
    // Being one of several people on it is still reviewing your own work.
    if (workers.includes(user.id)) {
      return deny("You can't sign off your own work - someone else has to review it.");
    }

    if (!["done", "closed"].includes(access.task.status)) {
      return NextResponse.json(
        { error: "This task hasn't been marked finished yet, so there's nothing to review" },
        { status: 400 }
      );
    }
    if (access.task.review_status === "approved" && decision === "approved") {
      return NextResponse.json({ error: "This task has already been signed off" }, { status: 400 });
    }

    const now = new Date().toISOString();
    const patch: Record<string, any> =
      decision === "approved"
        ? {
            review_status: "approved",
            review_note: note || null,
            reviewed_by: user.id,
            reviewed_at: now,
            status: "closed",
            completed_at: access.task.completed_at || now,
            updated_at: now,
          }
        : {
            review_status: "sent_back",
            review_note: note,
            reviewed_by: user.id,
            reviewed_at: now,
            status: "in_progress",
            completed_at: null,
            updated_at: now,
          };

    const { data, error } = await supabase
      .from("tasks")
      .update(patch)
      // Guard against two reviewers deciding at the same moment: only the
      // first write still sees the status it was reviewing.
      .eq("id", id)
      .eq("status", access.task.status)
      .select("id, status, review_status, review_note, reviewed_by, reviewed_at, completed_at")
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return NextResponse.json({ error: "Someone else reviewed this a moment ago" }, { status: 400 });
      }
      if (schemaMissing(error)) {
        return NextResponse.json(
          { error: "Review isn't set up yet - run the database migration" },
          { status: 400 }
        );
      }
      throw error;
    }

    await logActivity(supabase, {
      entity_type: "task",
      entity_id: id,
      action: decision === "approved" ? "approved the finished work" : "sent the work back for changes",
      performed_by: user.id,
      desk_id: access.task.desk_id,
      changes: { review_status: decision, note: note || null },
    });

    const message =
      decision === "approved"
        ? `${access.task.title} was reviewed and signed off${note ? ` - "${note.slice(0, 140)}"` : ""}`
        : `${access.task.title} was sent back: "${note.slice(0, 200)}"`;

    const tell = Array.from(new Set([...workers, ...(await taskAudience(supabase, access.task))])).filter(
      (x) => x !== user.id
    );
    await notifyMany(supabase, tell, {
      task_id: id,
      type: decision === "approved" ? "review_approved" : "review_sent_back",
      title: decision === "approved" ? "Work approved" : "Work sent back",
      message,
    });
    await sendMail({
      userIds: workers.filter((x) => x !== user.id),
      subject: decision === "approved" ? `Approved: ${access.task.title}` : `Sent back: ${access.task.title}`,
      body: message,
      type: decision === "approved" ? "review_approved" : "review_sent_back",
    });

    return NextResponse.json(data);
  } catch (error: any) {
    console.error("POST task review failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
