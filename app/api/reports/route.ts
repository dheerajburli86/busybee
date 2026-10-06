// Checklist #38 / SOW #42: daily, weekly and monthly MIS reports.
//
// GET /api/reports?period=daily|weekly|monthly[&date=YYYY-MM-DD][&project_id=]
// Calendar periods in IST around `date` (default today): daily = that day,
// weekly = its Monday-to-Sunday week, monthly = its calendar month. A period
// that includes today runs up to the end of today. Everything is computed from
// tasks the caller is allowed to see.

import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";
import { getMemberships, requireUser, visibleTasks } from "@/lib/permissions";
import { isFinished, isOverdue, STATUSES } from "@/lib/status";
import { attachNames } from "@/lib/names";
import { inChunks, selectAll } from "@/lib/chunks";

const IST_OFFSET_MIN = 330;

const istDate = (d: Date) => new Date(d.getTime() + IST_OFFSET_MIN * 60000).toISOString().slice(0, 10);

const shiftDay = (ymd: string, days: number) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

function windowFor(period: string, dateStr: string | null) {
  const today = istDate(new Date());
  const valid = !!dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && !isNaN(new Date(`${dateStr}T00:00:00Z`).getTime());
  const ymd = valid ? (dateStr as string) : today;
  let first = ymd;
  let last = ymd;
  if (period === "weekly") {
    const monday = (new Date(`${ymd}T00:00:00Z`).getUTCDay() + 6) % 7; // days since Monday
    first = shiftDay(ymd, -monday);
    last = shiftDay(first, 6);
  } else if (period === "monthly") {
    first = `${ymd.slice(0, 8)}01`;
    const d = new Date(`${first}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1, 0); // last day of that month
    last = d.toISOString().slice(0, 10);
  }
  if (first <= today && last > today) last = today;
  return { start: new Date(`${first}T00:00:00+05:30`), end: new Date(`${last}T23:59:59.999+05:30`) };
}

export async function GET(request: NextRequest) {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const sp = request.nextUrl.searchParams;
    const period = ["daily", "weekly", "monthly"].includes(sp.get("period") || "") ? (sp.get("period") as string) : "weekly";
    const projectId = sp.get("project_id");
    const { start, end } = windowFor(period, sp.get("date"));
    const inWindow = (iso: string | null) => !!iso && new Date(iso) >= start && new Date(iso) <= end;

    const memberships = await getMemberships(supabase, user.id);
    const deskIds = memberships.map((m) => m.desk_id);
    if (!deskIds.length) return NextResponse.json({ error: "You are not on a desk" }, { status: 400 });

    // Only what the report needs: open work, plus anything created or
    // finished in the window (archived history stays out of it).
    const since = start.toISOString();
    const raw = await selectAll<any>(() => {
      let tq = supabase
        .from("tasks")
        .select("*")
        .in("desk_id", deskIds)
        .or(`archived_at.is.null,created_at.gte.${since},completed_at.gte.${since}`);
      if (projectId) tq = tq.eq("project_id", projectId);
      return tq.order("id");
    });
    const all = await visibleTasks(supabase, user.id, raw);
    const live = all.filter((t: any) => !t.archived_at);

    const [{ data: projects }, { data: mates }] = await Promise.all([
      supabase.from("projects").select("id, name").in("desk_id", deskIds),
      supabase.from("desk_members").select("user_id, users(id, full_name, email)").in("desk_id", deskIds),
    ]);

    const people = new Map<string, string>();
    (mates || []).forEach((m: any) => people.set(m.user_id, m.users?.full_name || m.users?.email || "Someone"));

    // Headline numbers.
    const completedInWindow = all.filter((t: any) => isFinished(t.status) && inWindow(t.completed_at));
    const completedLate = completedInWindow.filter((t: any) => t.due_date && t.completed_at && new Date(t.completed_at) > new Date(t.due_date));
    const createdInWindow = all.filter((t: any) => inWindow(t.created_at));
    const overdueNow = live.filter((t: any) => isOverdue(t));
    const open = live.filter((t: any) => !isFinished(t.status));
    const avgProgress = live.length ? Math.round(live.reduce((s: number, t: any) => s + (t.progress_percent || 0), 0) / live.length) : 0;

    // Status distribution (live tasks).
    const statusDistribution = STATUSES.map((s) => ({
      status: s.value,
      label: s.label,
      count: live.filter((t: any) => (t.status || "pending") === s.value).length,
    }));

    // Timesheet hours in the window (only rows the database lets us read).
    const hours = await selectAll<any>(() =>
      supabase
        .from("timesheet_entries")
        .select("user_id, task_id, hours, entry_date")
        .gte("entry_date", istDate(start))
        .lte("entry_date", istDate(end))
        .order("id")
    );

    // Activity in the window, for tasks we can see.
    const taskIds = all.map((t: any) => t.id);
    const activity = (
      await inChunks<any>(taskIds, (part) =>
        supabase
          .from("activity_log")
          .select("id, entity_id, action, performed_by, created_at")
          .eq("entity_type", "task")
          .in("entity_id", part)
          .gte("created_at", start.toISOString())
          .lte("created_at", end.toISOString())
          .order("created_at", { ascending: false })
          .limit(1000)
      )
    ).sort((a: any, b: any) => b.created_at.localeCompare(a.created_at));
    const titleOf = new Map(all.map((t: any) => [t.id, t.title]));

    // Per person.
    const byMember = Array.from(people.entries()).map(([id, name]) => {
      const mine = all.filter((t: any) => t.assigned_to === id);
      const doneWin = mine.filter((t: any) => isFinished(t.status) && inWindow(t.completed_at));
      const late = doneWin.filter((t: any) => t.due_date && new Date(t.completed_at) > new Date(t.due_date));
      return {
        id,
        name,
        assigned_open: mine.filter((t: any) => !t.archived_at && !isFinished(t.status)).length,
        completed: doneWin.length,
        on_time_rate: doneWin.length ? Math.round(((doneWin.length - late.length) / doneWin.length) * 100) : null,
        overdue: mine.filter((t: any) => !t.archived_at && isOverdue(t)).length,
        actions: activity.filter((a: any) => a.performed_by === id).length,
        hours: Math.round((hours || []).filter((h: any) => h.user_id === id).reduce((s: number, h: any) => s + Number(h.hours || 0), 0) * 10) / 10,
      };
    });

    const byProject = (projects || [])
      .filter((p: any) => !projectId || p.id === projectId)
      .map((p: any) => {
        const list = live.filter((t: any) => t.project_id === p.id);
        return {
          id: p.id,
          name: p.name,
          total: list.length,
          done: list.filter((t: any) => isFinished(t.status)).length,
          completed_in_period: all.filter((t: any) => t.project_id === p.id && isFinished(t.status) && inWindow(t.completed_at)).length,
          overdue: list.filter((t: any) => isOverdue(t)).length,
          progress: list.length ? Math.round(list.reduce((s: number, t: any) => s + (t.progress_percent || 0), 0) / list.length) : 0,
        };
      })
      .filter((p: any) => p.total > 0 || p.completed_in_period > 0);

    // Completions per day across the window.
    const days: { date: string; completed: number; created: number }[] = [];
    for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 86400000)) {
      const key = new Date(d.getTime() + IST_OFFSET_MIN * 60000).toISOString().slice(0, 10);
      const sameDay = (iso: string | null) =>
        !!iso && new Date(new Date(iso).getTime() + IST_OFFSET_MIN * 60000).toISOString().slice(0, 10) === key;
      days.push({
        date: key,
        completed: all.filter((t: any) => isFinished(t.status) && sameDay(t.completed_at)).length,
        created: all.filter((t: any) => sameDay(t.created_at)).length,
      });
    }

    const overdueList = overdueNow
      .map((t: any) => ({
        id: t.id,
        title: t.title,
        assignee: t.assigned_to ? people.get(t.assigned_to) || "Someone" : "Unassigned",
        project: (projects || []).find((p: any) => p.id === t.project_id)?.name || null,
        due_date: t.due_date,
        days_late: Math.floor((Date.now() - new Date(t.due_date).getTime()) / 86400000),
        progress: t.progress_percent || 0,
      }))
      .sort((a: any, b: any) => b.days_late - a.days_late);

    const completedList = completedInWindow
      .map((t: any) => ({
        id: t.id,
        title: t.title,
        assignee: t.assigned_to ? people.get(t.assigned_to) || "Someone" : "Unassigned",
        completed_at: t.completed_at,
        due_date: t.due_date,
        on_time: !t.due_date || new Date(t.completed_at) <= new Date(t.due_date),
      }))
      .sort((a: any, b: any) => b.completed_at.localeCompare(a.completed_at));

    const activityList = (await attachNames(supabase, activity.slice(0, 200), "performed_by")).map((a: any) => ({
      ...a,
      task_title: titleOf.get(a.entity_id) || null,
    }));

    return NextResponse.json({
      period,
      window: { start: start.toISOString(), end: end.toISOString() },
      summary: {
        open: open.length,
        created: createdInWindow.length,
        completed: completedInWindow.length,
        completed_late: completedLate.length,
        overdue: overdueNow.length,
        avg_progress: avgProgress,
        hours: Math.round((hours || []).reduce((s: number, h: any) => s + Number(h.hours || 0), 0) * 10) / 10,
      },
      statusDistribution,
      byMember: byMember.filter((m) => m.assigned_open || m.completed || m.overdue || m.actions || m.hours),
      byProject,
      days,
      overdue: overdueList,
      completed: completedList,
      activity: activityList,
    });
  } catch (error: any) {
    console.error("GET /api/reports failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
