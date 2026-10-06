import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { getMemberships, requireUser, roleIn, SUPER_ROLES } from "@/lib/permissions";
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
      (tasks || []).find((t: any) => t.id === id)?.title || "(task removed)";

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
