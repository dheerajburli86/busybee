import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { deny, logActivity, notifyMany, requireUser, taskAccess } from "@/lib/permissions";
import { schemaMissing } from "@/lib/workflow";

// Steps 10-11 of the assignment flow: a reward or a penalty, in rupees,
// attached to a reviewed task.
//
// Three rules are deliberately strict here, because this feeds someone's pay:
//
//   1. Only a supervisor or admin may write one. Not the task's assignor, not
//      a project manager - levying money is a different authority from
//      running work, and conflating them is how this gets abused.
//   2. Nobody may raise one against themselves.
//   3. Nothing is ever edited or deleted. A mistake is VOIDED, by a named
//      person, with a reason, and the voided row stays visible next to its
//      replacement. An amount that can be quietly rewritten is worthless the
//      first time somebody disputes it.
//
// BusyBee does not pay or deduct anything. It produces a record that finance
// reads at the end of the month - see /api/payroll.

type Params = { params: Promise<{ id: string }> };

// A sanity ceiling, not a policy: it exists so a slipped keystroke shows up as
// a rejected entry rather than a ten-lakh penalty nobody notices until payday.
const MAX_AMOUNT = 1_000_000;

export async function GET(_req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const access = await taskAccess(supabase, user.id, id);
    if (!access?.canView) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    // Row-level security already limits this to the reader's own entries
    // unless they are a supervisor or admin on the desk; the query does not
    // need to repeat that, and must not be relied on to.
    const { data, error } = await supabase
      .from("task_adjustments")
      .select(
        "id, user_id, kind, amount, reason, effective_month, created_by, created_at, voided_at, voided_by, void_reason"
      )
      .eq("task_id", id)
      .order("created_at", { ascending: false });

    if (error) {
      if (schemaMissing(error)) return NextResponse.json({ entries: [], can_add: false });
      throw error;
    }

    return NextResponse.json({ entries: data || [], can_add: access.isSuper });
  } catch (error: any) {
    console.error("GET task_adjustments failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const body = await req.json();

    const kind: string = body?.kind;
    const amount = Number(body?.amount);
    const reason: string = typeof body?.reason === "string" ? body.reason.trim() : "";
    const month: string = typeof body?.effective_month === "string" ? body.effective_month : "";
    const targetUser: string = typeof body?.user_id === "string" ? body.user_id : "";

    if (!["reward", "penalty"].includes(kind)) {
      return NextResponse.json({ error: "kind must be reward or penalty" }, { status: 400 });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: "Enter an amount greater than zero" }, { status: 400 });
    }
    if (amount > MAX_AMOUNT) {
      return NextResponse.json(
        { error: `That looks like a typo - the most you can enter at once is ₹${MAX_AMOUNT.toLocaleString("en-IN")}` },
        { status: 400 }
      );
    }
    if (!reason) {
      return NextResponse.json({ error: "A reason is required - this affects someone's pay" }, { status: 400 });
    }
    if (!targetUser) {
      return NextResponse.json({ error: "Say who this applies to" }, { status: 400 });
    }

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const access = await taskAccess(supabase, user.id, id);
    if (!access) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    if (!access.isSuper) {
      return deny("Only a supervisor or an admin can record a reward or a penalty.");
    }
    if (targetUser === user.id) {
      return deny("You can't record a reward or a penalty against yourself.");
    }

    // Money follows a judgement about the work: either it's finished (and so
    // reviewable) or its deadline has passed. Not on work still in flight.
    const finished = ["done", "closed"].includes(access.task.status);
    const overdue = !!access.task.due_date && new Date(access.task.due_date).getTime() < Date.now();
    if (!finished && !overdue) {
      return NextResponse.json(
        { error: "A reward or penalty can be recorded once the work is finished or its deadline has passed" },
        { status: 400 }
      );
    }
    if (access.task.personal) {
      return NextResponse.json({ error: "Private to-dos can't carry a reward or penalty" }, { status: 400 });
    }

    // The person has to be on this desk - otherwise a supervisor on one desk
    // could post money against somebody they have no authority over.
    const { data: onDesk } = await supabase
      .from("desk_members")
      .select("user_id")
      .eq("desk_id", access.task.desk_id)
      .eq("user_id", targetUser)
      .limit(1);
    if (!onDesk || onDesk.length === 0) {
      return NextResponse.json({ error: "That person isn't on this desk" }, { status: 400 });
    }

    // Default to the month the task was finished in, not today's - work
    // signed off on 2 October for September belongs to September's payroll.
    const basis = access.task.completed_at || access.task.due_date || new Date().toISOString();
    // In the office's timezone (IST): work finished at 00:30 IST on 1 Nov is
    // November's, even though it's still October in UTC.
    const fallback = new Date(new Date(basis).getTime() + 330 * 60000);
    const effective_month = /^\d{4}-\d{2}/.test(month)
      ? `${month.slice(0, 7)}-01`
      : `${fallback.getUTCFullYear()}-${String(fallback.getUTCMonth() + 1).padStart(2, "0")}-01`;

    const { data, error } = await supabase
      .from("task_adjustments")
      .insert({
        task_id: id,
        desk_id: access.task.desk_id,
        user_id: targetUser,
        kind,
        amount: Math.round(amount * 100) / 100,
        reason,
        effective_month,
        created_by: user.id,
      })
      .select(
        "id, user_id, kind, amount, reason, effective_month, created_by, created_at, voided_at, voided_by, void_reason"
      )
      .single();

    if (error) {
      if (schemaMissing(error)) {
        return NextResponse.json(
          { error: "Rewards and penalties aren't set up yet - run the database migration" },
          { status: 400 }
        );
      }
      throw error;
    }

    const rupees = `₹${Number(data.amount).toLocaleString("en-IN")}`;
    await logActivity(supabase, {
      entity_type: "task",
      entity_id: id,
      action: kind === "reward" ? `recorded a reward of ${rupees}` : `recorded a penalty of ${rupees}`,
      performed_by: user.id,
      desk_id: access.task.desk_id,
      changes: { kind, amount: data.amount, reason, user_id: targetUser, effective_month },
    });

    // The person it applies to is always told, immediately, in the app and by email.
    // A deduction someone finds out about on payday is a dispute; one they were
    // told about on the day is a conversation.
    const notifType = kind === "reward" ? "adjustment_reward" : "adjustment_penalty";
    const message = `${kind === "reward" ? "A reward" : "A penalty"} of ${rupees} was recorded against ${access.task.title} - "${reason.slice(0, 180)}"`;
    const mailBody = `${message}\n\nIf you think this is wrong, reply to your supervisor - it can be voided, and the record will show that it was.`;

    await notifyMany(supabase, [targetUser], {
      task_id: id,
      type: notifType,
      title: kind === "reward" ? `Reward: ${rupees}` : `Penalty: ${rupees}`,
      message,
      email: {
        subject: kind === "reward" ? `Reward recorded: ${rupees}` : `Penalty recorded: ${rupees}`,
        body: mailBody,
      },
    });

    return NextResponse.json(data);
  } catch (error: any) {
    console.error("POST task_adjustments failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

// Void an entry. Not a delete: the row stays, marked, with a reason.
export async function DELETE(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { adjustment_id, void_reason } = await req.json();

    if (!adjustment_id) return NextResponse.json({ error: "adjustment_id is required" }, { status: 400 });
    const why = typeof void_reason === "string" ? void_reason.trim() : "";
    if (!why) return NextResponse.json({ error: "Say why this is being cancelled" }, { status: 400 });

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const access = await taskAccess(supabase, user.id, id);
    if (!access) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    if (!access.isSuper) return deny("Only a supervisor or an admin can cancel a reward or a penalty.");

    const { data: existing } = await supabase
      .from("task_adjustments")
      .select("id, task_id, user_id, kind, amount, voided_at")
      .eq("id", adjustment_id)
      .maybeSingle();

    if (!existing || existing.task_id !== id) {
      return NextResponse.json({ error: "Entry not found for this task" }, { status: 404 });
    }
    if (existing.user_id === user.id) {
      return deny("You can't cancel an entry recorded against yourself - another supervisor has to.");
    }
    if (existing.voided_at) {
      return NextResponse.json({ error: "This entry was already cancelled" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("task_adjustments")
      .update({ voided_at: new Date().toISOString(), voided_by: user.id, void_reason: why })
      .eq("id", adjustment_id)
      .is("voided_at", null)
      .select(
        "id, user_id, kind, amount, reason, effective_month, created_by, created_at, voided_at, voided_by, void_reason"
      )
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return NextResponse.json({ error: "This entry was already cancelled" }, { status: 400 });
      }
      throw error;
    }

    const rupees = `₹${Number(existing.amount).toLocaleString("en-IN")}`;
    const message = `The ${existing.kind} of ${rupees} on ${access.task.title} was cancelled - "${why.slice(0, 180)}"`;

    await logActivity(supabase, {
      entity_type: "task",
      entity_id: id,
      action: `cancelled a ${existing.kind} of ${rupees}`,
      performed_by: user.id,
      desk_id: access.task.desk_id,
      changes: { adjustment_id, void_reason: why },
    });
    await notifyMany(supabase, [existing.user_id], {
      task_id: id,
      type: "adjustment_voided",
      title: `${existing.kind === "reward" ? "Reward" : "Penalty"} cancelled`,
      message,
      email: { subject: `${existing.kind === "reward" ? "Reward" : "Penalty"} cancelled: ${rupees}` },
    });

    return NextResponse.json(data);
  } catch (error: any) {
    console.error("DELETE task_adjustments failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
