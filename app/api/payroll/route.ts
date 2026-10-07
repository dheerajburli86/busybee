import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { deny, getMemberships, logActivity, notifyMany, requireUser, roleIn, SUPER_ROLES } from "@/lib/permissions";
import { schemaMissing } from "@/lib/workflow";

// Step 11: what finance actually reads.
//
// This is a REPORT, not an instruction. BusyBee never moves money and never
// touches a salary - it totals the rewards and penalties recorded against a
// month and leaves applying them to whoever runs payroll. That separation is
// the point: a disputed line can be traced back to a task, a reviewer and a
// written reason before anybody's pay changes.
//
// Who sees what is enforced by row-level security on task_adjustments, not
// here: supervisors and admins see their desk, everyone else sees only their
// own entries. This route adds names and totals on top of whatever comes back.

function monthStart(raw: string | null): string {
  const now = new Date();
  if (raw && /^\d{4}-\d{2}$/.test(raw)) return `${raw}-01`;
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export async function GET(req: Request) {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const url = new URL(req.url);
    const month = monthStart(url.searchParams.get("month"));
    const deskParam = url.searchParams.get("desk");

    const memberships = await getMemberships(supabase, user.id);
    if (memberships.length === 0) {
      return NextResponse.json({ month, rows: [], entries: [], is_supervisor: false, desks: [] });
    }
    const deskId = deskParam && memberships.some((m) => m.desk_id === deskParam) ? deskParam : memberships[0].desk_id;
    const isSupervisor = SUPER_ROLES.includes(roleIn(memberships, deskId));

    // Names for the desk picker, for anyone on more than one desk.
    const { data: deskRows } = await supabase
      .from("desks")
      .select("id, name")
      .in("id", memberships.map((m) => m.desk_id));
    const desks = memberships.map((m) => ({
      desk_id: m.desk_id,
      role: m.role,
      name: (deskRows || []).find((d: any) => d.id === m.desk_id)?.name || "Desk",
    }));

    const { data: raw, error } = await supabase
      .from("task_adjustments")
      .select("id, task_id, user_id, kind, amount, reason, effective_month, created_by, created_at, voided_at, void_reason")
      .eq("desk_id", deskId)
      .eq("effective_month", month)
      .order("created_at", { ascending: false });

    if (error) {
      // The migration hasn't been run yet - an empty report is a better
      // answer than a 500 on a page somebody just opened.
      if (schemaMissing(error)) {
        return NextResponse.json({ month, rows: [], entries: [], is_supervisor: isSupervisor, desk_id: deskId, desks });
      }
      throw error;
    }

    // Who a supervisor can pick: everyone on the desk except themselves (nobody
    // records money against their own pay).
    let people_list: { id: string; name: string }[] = [];
    if (isSupervisor) {
      const { data: mates } = await supabase
        .from("desk_members")
        .select("user_id, users(id, full_name, email)")
        .eq("desk_id", deskId);
      people_list = (mates || [])
        .filter((m: any) => m.user_id !== user.id)
        .map((m: any) => ({ id: m.user_id, name: m.users?.full_name || m.users?.email || "Someone" }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name));
    }

    // Tasks a supervisor can attach one to: not private, and either finished or
    // past their deadline (the database refuses anything else).
    let task_list: any[] = [];
    if (isSupervisor) {
      const { data: ts } = await supabase
        .from("tasks")
        .select("id, title, status, due_date, assigned_to, completed_at, personal")
        .eq("desk_id", deskId)
        .order("due_date", { ascending: false })
        .limit(500);
      const now = Date.now();
      task_list = (ts || [])
        .filter((t: any) => !t.personal)
        .filter((t: any) => ["done", "closed"].includes(t.status) || (t.due_date && new Date(t.due_date).getTime() < now))
        .map((t: any) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          due_date: t.due_date,
          assigned_to: t.assigned_to,
          finished: ["done", "closed"].includes(t.status),
        }));
    }

    const entries = raw || [];
    const ids = Array.from(
      new Set(entries.flatMap((e: any) => [e.user_id, e.created_by]).filter(Boolean) as string[])
    );
    const taskIds = Array.from(new Set(entries.map((e: any) => e.task_id).filter(Boolean) as string[]));

    const [{ data: people }, { data: tasks }] = await Promise.all([
      ids.length ? supabase.from("users").select("id, full_name, email").in("id", ids) : Promise.resolve({ data: [] }),
      taskIds.length
        ? supabase.from("tasks").select("id, title").in("id", taskIds)
        : Promise.resolve({ data: [] }),
    ]);

    const nameOf = (id: string | null) => {
      if (!id) return "Someone";
      const p = (people || []).find((x: any) => x.id === id);
      return p?.full_name || p?.email || "Someone";
    };
    const titleOf = (id: string | null) =>
      id ? (tasks || []).find((t: any) => t.id === id)?.title || "(task removed)" : "Entered directly (no task)";

    // Per-person totals. Voided entries are carried through so the report
    // shows they existed, but they contribute nothing to the net figure.
    const byUser = new Map<string, { user_id: string; name: string; reward: number; penalty: number; count: number }>();
    for (const e of entries as any[]) {
      if (!byUser.has(e.user_id)) {
        byUser.set(e.user_id, { user_id: e.user_id, name: nameOf(e.user_id), reward: 0, penalty: 0, count: 0 });
      }
      const row = byUser.get(e.user_id)!;
      if (e.voided_at) continue;
      row.count += 1;
      if (e.kind === "reward") row.reward += Number(e.amount);
      else row.penalty += Number(e.amount);
    }

    const rows = Array.from(byUser.values())
      .map((r) => ({ ...r, net: Math.round((r.reward - r.penalty) * 100) / 100 }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({
      month,
      is_supervisor: isSupervisor,
      desk_id: deskId,
      desks,
      people: people_list,
      tasks: task_list,
      rows,
      totals: {
        reward: Math.round(rows.reduce((s, r) => s + r.reward, 0) * 100) / 100,
        penalty: Math.round(rows.reduce((s, r) => s + r.penalty, 0) * 100) / 100,
        net: Math.round(rows.reduce((s, r) => s + r.net, 0) * 100) / 100,
      },
      entries: entries.map((e: any) => ({
        ...e,
        person: nameOf(e.user_id),
        by: nameOf(e.created_by),
        task_title: titleOf(e.task_id),
      })),
    });
  } catch (error: any) {
    console.error("GET payroll failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Record a reward or penalty from the Payroll page: pick a person, a task (it
// must be finished or past its deadline), an amount and a reason. Same rules as
// the task panel: only a supervisor or admin, never against yourself, a reason
// is always required, and the person is told at once. The database enforces
// the same limits, including that every entry hangs off a task.
// ---------------------------------------------------------------------------

const MAX_AMOUNT = 1_000_000;

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const kind: string = body?.kind;
    const amount = Number(body?.amount);
    const reason: string = typeof body?.reason === "string" ? body.reason.trim() : "";
    const targetUser: string = typeof body?.user_id === "string" ? body.user_id : "";
    const taskId: string = typeof body?.task_id === "string" ? body.task_id : "";

    if (!["reward", "penalty"].includes(kind)) return NextResponse.json({ error: "Choose reward or penalty" }, { status: 400 });
    if (!targetUser) return NextResponse.json({ error: "Choose who this applies to" }, { status: 400 });
    if (!taskId) return NextResponse.json({ error: "Choose the task this is for" }, { status: 400 });
    if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ error: "Enter an amount greater than zero" }, { status: 400 });
    if (amount > MAX_AMOUNT) {
      return NextResponse.json(
        { error: `That looks like a typo - the most you can enter at once is ₹${MAX_AMOUNT.toLocaleString("en-IN")}` },
        { status: 400 }
      );
    }
    if (!reason) return NextResponse.json({ error: "A reason is required - this affects someone's pay" }, { status: 400 });

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const memberships = await getMemberships(supabase, user.id);
    const deskId =
      typeof body?.desk_id === "string" && memberships.some((m) => m.desk_id === body.desk_id)
        ? body.desk_id
        : memberships[0]?.desk_id;
    if (!deskId) return NextResponse.json({ error: "You are not on a desk" }, { status: 400 });
    if (!SUPER_ROLES.includes(roleIn(memberships, deskId))) {
      return deny("Only a supervisor or an admin can record a reward or a penalty.");
    }
    if (targetUser === user.id) return deny("You can't record a reward or a penalty against yourself.");

    const { data: onDesk } = await supabase
      .from("desk_members")
      .select("user_id")
      .eq("desk_id", deskId)
      .eq("user_id", targetUser)
      .limit(1);
    if (!onDesk || onDesk.length === 0) return NextResponse.json({ error: "That person isn't on this desk" }, { status: 400 });

    const { data: task } = await supabase
      .from("tasks")
      .select("id, title, desk_id, status, due_date, personal")
      .eq("id", taskId)
      .maybeSingle();
    if (!task || task.desk_id !== deskId) return NextResponse.json({ error: "Task not found on this desk" }, { status: 404 });
    if (task.personal) return NextResponse.json({ error: "Private to-dos can't carry a reward or penalty" }, { status: 400 });
    const finished = ["done", "closed"].includes(task.status);
    const overdue = !!task.due_date && new Date(task.due_date).getTime() < Date.now();
    if (!finished && !overdue) {
      return NextResponse.json(
        { error: "A reward or penalty can be recorded once the work is finished or its deadline has passed" },
        { status: 400 }
      );
    }

    const effective_month = monthStart(typeof body?.effective_month === "string" ? body.effective_month.slice(0, 7) : null);

    const { data, error } = await supabase
      .from("task_adjustments")
      .insert({
        task_id: taskId,
        desk_id: deskId,
        user_id: targetUser,
        kind,
        amount: Math.round(amount * 100) / 100,
        reason,
        effective_month,
        created_by: user.id,
      })
      .select("id, user_id, kind, amount, reason, effective_month, created_by, created_at")
      .single();

    if (error) {
      if (schemaMissing(error)) {
        return NextResponse.json({ error: "Rewards and penalties aren't set up yet - run the database migration" }, { status: 400 });
      }
      throw error;
    }

    const rupees = `₹${Number(data.amount).toLocaleString("en-IN")}`;
    const message = `${kind === "reward" ? "A reward" : "A penalty"} of ${rupees} was recorded against ${task.title} - "${reason.slice(0, 180)}"`;
    await logActivity(supabase, {
      entity_type: "task",
      entity_id: taskId,
      action: kind === "reward" ? `recorded a reward of ${rupees}` : `recorded a penalty of ${rupees}`,
      performed_by: user.id,
      desk_id: deskId,
      changes: { kind, amount: data.amount, reason, user_id: targetUser, effective_month },
    });
    await notifyMany(supabase, [targetUser], {
      task_id: taskId,
      type: kind === "reward" ? "adjustment_reward" : "adjustment_penalty",
      title: kind === "reward" ? `Reward: ${rupees}` : `Penalty: ${rupees}`,
      message,
      email: {
        subject: kind === "reward" ? `Reward recorded: ${rupees}` : `Penalty recorded: ${rupees}`,
        body: `${message}\n\nIf you think this is wrong, reply to your supervisor - it can be cancelled, and the record will show that it was.`,
      },
    });

    return NextResponse.json(data);
  } catch (error: any) {
    console.error("POST payroll failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

// Cancel an entry (task-linked or not). Nothing is deleted: the row stays,
// marked cancelled, with who cancelled it and why.
export async function DELETE(req: Request) {
  try {
    const { adjustment_id, void_reason } = await req.json().catch(() => ({}));
    if (!adjustment_id) return NextResponse.json({ error: "adjustment_id is required" }, { status: 400 });
    const why = typeof void_reason === "string" ? void_reason.trim() : "";
    if (!why) return NextResponse.json({ error: "Say why this is being cancelled" }, { status: 400 });

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: existing } = await supabase
      .from("task_adjustments")
      .select("id, desk_id, user_id, kind, amount, voided_at")
      .eq("id", adjustment_id)
      .maybeSingle();
    if (!existing) return NextResponse.json({ error: "Entry not found" }, { status: 404 });

    const memberships = await getMemberships(supabase, user.id);
    if (!SUPER_ROLES.includes(roleIn(memberships, existing.desk_id))) {
      return deny("Only a supervisor or an admin can cancel a reward or a penalty.");
    }
    if (existing.user_id === user.id) return deny("You can't cancel an entry recorded against yourself - another supervisor has to.");
    if (existing.voided_at) return NextResponse.json({ error: "This entry was already cancelled" }, { status: 400 });

    const { data, error } = await supabase
      .from("task_adjustments")
      .update({ voided_at: new Date().toISOString(), voided_by: user.id, void_reason: why })
      .eq("id", adjustment_id)
      .is("voided_at", null)
      .select("id, voided_at, void_reason")
      .single();
    if (error) {
      if (error.code === "PGRST116") return NextResponse.json({ error: "This entry was already cancelled" }, { status: 400 });
      throw error;
    }

    const rupees = `₹${Number(existing.amount).toLocaleString("en-IN")}`;
    await notifyMany(supabase, [existing.user_id], {
      task_id: null,
      type: "adjustment_voided",
      title: `${existing.kind === "reward" ? "Reward" : "Penalty"} cancelled`,
      message: `The ${existing.kind} of ${rupees} was cancelled - "${why.slice(0, 180)}"`,
      email: { subject: `${existing.kind === "reward" ? "Reward" : "Penalty"} cancelled: ${rupees}` },
    });

    return NextResponse.json(data);
  } catch (error: any) {
    console.error("DELETE payroll failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
