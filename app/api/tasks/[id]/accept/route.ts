import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import {
  deny,
  logActivity,
  notifyMany,
  requireUser,
  taskAccess,
  teamMemberIds,
} from "@/lib/permissions";
import { formatForPeople, normalizeTimestamp } from "@/lib/format";
import { isFinished } from "@/lib/status";
import { decidersFor, schemaMissing } from "@/lib/workflow";
import { createAdminClient } from "@/lib/supabase-admin";

// Step 4 of the assignment flow: the person doing the work accepts the
// deadline they were given, or declines it.
//
// Declining is NOT a veto and does not change the deadline. It records that
// the assignee does not think the date is achievable and tells the assignor
// so, which is the cue to raise an extension request (that flow already
// exists in /api/tasks/[id]/extension and carries the proposed new date).
// Keeping the two apart matters: acceptance is about agreeing to a date,
// an extension is about proposing a different one.

type Params = { params: Promise<{ id: string }> };

/** Everyone expected to accept: the named assignee plus the task's team. */
async function expectedAcceptors(supabase: any, task: any): Promise<string[]> {
  const ids = new Set<string>();
  if (task.assigned_to) ids.add(task.assigned_to);
  (await teamMemberIds(supabase, task.team_id)).forEach((x) => ids.add(x));
  // Whoever set the work up does not accept their own deadline.
  ids.delete(task.created_by);
  if (task.task_manager_id) ids.delete(task.task_manager_id);
  return Array.from(ids);
}

/** The people to tell when someone accepts or declines. */
function assignorsOf(task: any, extra: any[]): string[] {
  const ids = new Set<string>();
  [task.created_by, task.task_manager_id].forEach((x: string | null) => x && ids.add(x));
  (extra || []).forEach((x: any) => x.user_id && ids.add(x.user_id));
  return Array.from(ids);
}

export async function GET(_req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const access = await taskAccess(supabase, user.id, id);
    if (!access?.canView) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    const [{ data: rows }, expected] = await Promise.all([
      supabase
        .from("task_acceptances")
        .select("user_id, decision, note, created_at, due_date_at_decision")
        .eq("task_id", id),
      expectedAcceptors(supabase, access.task),
    ]);

    const mine = (rows || []).find((r: any) => r.user_id === user.id) || null;

    // A deadline that moved after someone accepted needs accepting again -
    // otherwise "Alok accepted" silently comes to mean a date he never saw.
    const current = access.task.due_date ? new Date(access.task.due_date).getTime() : null;
    const staleFor = (r: any) =>
      !!current && !!r.due_date_at_decision && new Date(r.due_date_at_decision).getTime() !== current;

    // Safety net: "it won't work" with no request for more time waiting
    // (it was rejected, or never filed) leaves the person nothing to do, so
    // ask them again.
    let declinedAndStuck = false;
    if (mine && mine.decision === "declined") {
      const { data: open } = await supabase
        .from("extension_requests")
        .select("id")
        .eq("task_id", id)
        .eq("requested_by", user.id)
        .eq("status", "pending")
        .limit(1);
      declinedAndStuck = !open || open.length === 0;
    }

    const iAmExpected = expected.includes(user.id);
    const needsMyDecision =
      iAmExpected &&
      !!access.task.due_date &&
      !isFinished(access.task.status) &&
      !access.task.archived_at &&
      (!mine || staleFor(mine) || declinedAndStuck);

    return NextResponse.json({
      expected,
      acceptances: (rows || []).map((r: any) => ({ ...r, stale: staleFor(r) })),
      mine,
      needs_my_decision: needsMyDecision,
      // The assignor's view: has everyone signed up to this date?
      all_accepted:
        expected.length > 0 &&
        expected.every((uid) =>
          (rows || []).some((r: any) => r.user_id === uid && r.decision === "accepted" && !staleFor(r))
        ),
    });
  } catch (error: any) {
    console.error("GET task_acceptances failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const body = await req.json();
    const decision: string = body?.decision === "declined" ? "declined" : "accepted";
    const note: string = typeof body?.note === "string" ? body.note.trim() : "";
    // "I need more time" can carry the date the person needs. Then one click
    // both records that the deadline doesn't work AND asks for the new date,
    // instead of two separate steps the person has to know about.
    const requestedDate = decision === "declined" && body?.requested_date ? normalizeTimestamp(body.requested_date) : null;
    if (decision === "declined" && body?.requested_date && !requestedDate) {
      return NextResponse.json({ error: "That date isn't valid" }, { status: 400 });
    }
    // "It won't work" always comes with the date that would - otherwise the
    // assignor has nothing to decide and the person is just asked again.
    if (decision === "declined" && !requestedDate) {
      return NextResponse.json({ error: "Pick the date you need" }, { status: 400 });
    }

    if (decision === "declined" && !note) {
      return NextResponse.json(
        { error: "Say why the deadline doesn't work, so the assignor has something to act on" },
        { status: 400 }
      );
    }

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const access = await taskAccess(supabase, user.id, id);
    if (!access) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    const expected = await expectedAcceptors(supabase, access.task);
    if (!expected.includes(user.id)) {
      return deny("Only the people this task was given to can accept its deadline.");
    }
    if (!access.task.due_date) {
      return NextResponse.json({ error: "This task has no deadline to accept" }, { status: 400 });
    }
    if (isFinished(access.task.status)) {
      return NextResponse.json({ error: "This task is already finished" }, { status: 400 });
    }
    if (requestedDate && (new Date(requestedDate) <= new Date(access.task.due_date) || new Date(requestedDate).getTime() <= Date.now())) {
      return NextResponse.json({ error: "Pick a date in the future, after the current deadline" }, { status: 400 });
    }
    if (requestedDate) {
      const { data: open } = await supabase
        .from("extension_requests")
        .select("id")
        .eq("task_id", id)
        .eq("status", "pending")
        .limit(1);
      if (open && open.length) {
        return NextResponse.json({ error: "There is already a request for more time waiting for a decision" }, { status: 400 });
      }
    }

    // Asking for more time: file the request FIRST. If that fails nothing is
    // written, so the person can simply try again - never a half-done state
    // where the deadline is marked "won't work" but nobody was asked.
    let ext: { id: string; requested_date: string } | null = null;
    if (requestedDate) {
      const { data: row, error: extError } = await supabase
        .from("extension_requests")
        .insert({
          task_id: id,
          requested_by: user.id,
          reason: note,
          requested_date: new Date(requestedDate).toISOString(),
          // Older databases also have a required new_deadline column; keep it in step.
          new_deadline: new Date(requestedDate).toISOString(),
          status: "pending",
        })
        .select("id, requested_date")
        .single();
      if (extError) {
        if (extError.code === "23505") {
          return NextResponse.json({ error: "There is already a request for more time waiting for a decision" }, { status: 400 });
        }
        throw extError;
      }
      ext = row;
    }

    const { data, error } = await supabase
      .from("task_acceptances")
      .upsert(
        {
          task_id: id,
          user_id: user.id,
          desk_id: access.task.desk_id,
          decision,
          note: note || null,
          due_date_at_decision: access.task.due_date,
          created_at: new Date().toISOString(),
        },
        { onConflict: "task_id,user_id" }
      )
      .select("user_id, decision, note, created_at, due_date_at_decision")
      .single();

    if (error) {
      if (ext) {
        // Take the request back with the service key (people can't delete
        // requests themselves), falling back to their own session.
        const { error: undoErr } = await (createAdminClient() || supabase).from("extension_requests").delete().eq("id", ext.id);
        if (undoErr) console.error("accept: could not take back the extension request", undoErr);
      }
      if (schemaMissing(error)) {
        return NextResponse.json(
          { error: "Deadline acceptance isn't set up yet - run the database migration" },
          { status: 400 }
        );
      }
      throw error;
    }

    await logActivity(supabase, {
      entity_type: "task",
      entity_id: id,
      action: decision === "accepted" ? "accepted the deadline" : "said the deadline doesn't work",
      performed_by: user.id,
      desk_id: access.task.desk_id,
      changes: { decision, note: note || null, due_date: access.task.due_date },
    });

    const { data: extra } = await supabase.from("task_assignors").select("user_id").eq("task_id", id);
    const tell = assignorsOf(access.task, extra || []).filter((x) => x !== user.id);

    if (ext) {
      await logActivity(supabase, {
        entity_type: "task",
        entity_id: id,
        action: "requested a deadline extension",
        performed_by: user.id,
        desk_id: access.task.desk_id,
        changes: { reason: note, requested_date: ext.requested_date },
      });
      // One alert, not two, to everyone who can decide on it.
      const deciders = await decidersFor(supabase, access.task, user.id);
      await notifyMany(supabase, deciders, {
        task_id: id,
        type: "extension_request",
        title: "More time requested",
        message: `${access.task.title}: asked to move the deadline from ${formatForPeople(access.task.due_date)} to ${formatForPeople(ext.requested_date)} - "${note.slice(0, 140)}". Open the task to approve or reject.`,
        email: { subject: `More time requested: ${access.task.title}` },
      });
      return NextResponse.json({ ...data, extension_requested: true });
    }


    const message =
      decision === "accepted"
        ? `The deadline for ${access.task.title} (${formatForPeople(access.task.due_date)}) was accepted`
        : `${access.task.title}: the deadline of ${formatForPeople(access.task.due_date)} was declined - "${note.slice(0, 140)}"`;

    await notifyMany(supabase, tell, {
      task_id: id,
      type: decision === "accepted" ? "deadline_accepted" : "deadline_declined",
      title: decision === "accepted" ? "Deadline accepted" : "Deadline declined",
      message,
      // "Accepted" is routine (bell + Telegram); "declined" needs action, so it's emailed too.
      email:
        decision === "declined"
          ? {
              subject: `Deadline declined: ${access.task.title}`,
              body: `${message}\n\nThey can now raise an extension request with a proposed new date.`,
            }
          : false,
    });

    return NextResponse.json(data);
  } catch (error: any) {
    console.error("POST task_acceptances failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
