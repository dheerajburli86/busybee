// Ask BusyBee: answers "what has X been assigned / completed / left with"
// from the tasks the asker is allowed to see. See lib/ask.ts for the parsing.

import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";
import { getMemberships, requireUser, visibleTasks } from "@/lib/permissions";
import { selectAll } from "@/lib/chunks";
import { isFinished, statusLabel } from "@/lib/status";
import { formatForPeople } from "@/lib/format";
import { AskPerson, Intent, parseQuestion, periodStart } from "@/lib/ask";

const PERIOD_WORDS: Record<string, string> = {
  today: "today",
  yesterday: "yesterday",
  week: "in the last 7 days",
  month: "in the last 30 days",
};

export async function GET(request: NextRequest) {
  try {
    const question = (request.nextUrl.searchParams.get("q") || "").trim().slice(0, 300);
    if (!question) return NextResponse.json({ error: "Type a question" }, { status: 400 });

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const memberships = await getMemberships(supabase, user.id);
    const deskIds = memberships.map((m) => m.desk_id);
    if (!deskIds.length) return NextResponse.json({ answer: "You're not on a desk yet, so there's nothing to look up.", tasks: [] });

    const [{ data: members }, rows] = await Promise.all([
      supabase.from("desk_members").select("user_id, users(id, email, full_name)").in("desk_id", deskIds),
      selectAll<any>(() =>
        supabase
          .from("tasks")
          .select("id, title, status, due_date, completed_at, created_at, assigned_to, created_by, task_manager_id, team_id, project_id, personal, archived_at, review_status, is_list, desk_id")
          .in("desk_id", deskIds)
          .order("due_date", { ascending: true })
          .order("id")
      ),
    ]);

    const seen = new Set<string>();
    const people: AskPerson[] = [];
    (members || []).forEach((m: any) => {
      if (seen.has(m.user_id)) return;
      seen.add(m.user_id);
      people.push({ id: m.user_id, name: m.users?.full_name || m.users?.email || "Someone", email: m.users?.email || null });
    });
    const nameOf = (id: string | null) => people.find((p) => p.id === id)?.name || "Unassigned";

    // Only what this person may see; private to-dos never count.
    const visible = (await visibleTasks(supabase, user.id, rows)).filter((t: any) => !t.personal);

    const parsed = parseQuestion(question, people, user.id);
    const ids = new Set(parsed.people.map((p) => p.id));
    const now = Date.now();
    const range = periodStart(parsed.period);
    const inRange = (iso: string | null) => {
      if (!range) return true;
      if (!iso) return false;
      const t = new Date(iso).getTime();
      return t >= range.from && t < range.to;
    };

    const late = (t: any) => !isFinished(t.status) && t.due_date && new Date(t.due_date).getTime() < now;
    const todayRange = periodStart("today")!;
    const keep: Record<Intent, (t: any) => boolean> = {
      assigned: (t) => !t.archived_at || isFinished(t.status),
      completed: (t) => isFinished(t.status) && inRange(t.completed_at),
      open: (t) => !isFinished(t.status) && !t.archived_at,
      overdue: (t) => !t.archived_at && late(t),
      review: (t) => t.status === "done" && t.review_status === "pending",
      due_today: (t) => {
        if (isFinished(t.status) || !t.due_date) return false;
        const d = new Date(t.due_date).getTime();
        return d >= todayRange.from && d < todayRange.to;
      },
    };

    let matched = visible
      .filter((t: any) => (parsed.everyone ? !!t.assigned_to : ids.has(t.assigned_to)))
      .filter(keep[parsed.intent]);
    // "assigned this week" = given out this week.
    if (parsed.intent === "assigned" && range) matched = matched.filter((t: any) => inRange(t.created_at));
    if (parsed.intent === "open" && range) matched = matched.filter((t: any) => inRange(t.due_date));

    // Most useful first: overdue/soonest for open work, most recent for finished.
    matched.sort((a: any, b: any) =>
      parsed.intent === "completed"
        ? String(b.completed_at || "").localeCompare(String(a.completed_at || ""))
        : String(a.due_date || "9").localeCompare(String(b.due_date || "9"))
    );

    // The one-line answer.
    const who = parsed.everyone
      ? "the team"
      : parsed.people.map((p) => (p.id === user.id ? "you" : p.name.split(" ")[0])).join(" and ");
    const whoCap = who.charAt(0).toUpperCase() + who.slice(1);
    const n = matched.length;
    const tasksWord = `${n} task${n === 1 ? "" : "s"}`;
    const when = parsed.period ? ` ${PERIOD_WORDS[parsed.period]}` : "";
    const verb = (p: string, s: string) => (who === "you" || !parsed.everyone && parsed.people.length > 1 ? p : s);

    let answer: string;
    switch (parsed.intent) {
      case "completed":
        answer = n ? `${whoCap} completed ${tasksWord}${when}.` : `${whoCap} ${verb("haven't", "hasn't")} completed anything${when || " yet"}.`;
        break;
      case "open": {
        const overdue = matched.filter(late).length;
        answer = n
          ? `${whoCap} ${verb("have", "has")} ${tasksWord} left${when}${overdue ? `, ${overdue} of them overdue` : ""}.`
          : `${whoCap} ${verb("have", "has")} nothing left to do${when}. 🎉`;
        break;
      }
      case "overdue":
        answer = n ? `${tasksWord} overdue${parsed.everyone ? "" : ` for ${who}`}.` : `Nothing overdue${parsed.everyone ? "" : ` for ${who}`}. 👍`;
        break;
      case "review":
        answer = n ? `${tasksWord} finished and waiting for review${parsed.everyone ? "" : ` from ${who}`}.` : "Nothing is waiting for review.";
        break;
      case "due_today":
        answer = n ? `${tasksWord} due today${parsed.everyone ? "" : ` for ${who}`}.` : `Nothing due today${parsed.everyone ? "" : ` for ${who}`}.`;
        break;
      default: {
        const done = matched.filter((t: any) => isFinished(t.status)).length;
        answer = n
          ? `${whoCap} ${verb("have", "has")} been given ${tasksWord}${when}: ${done} done, ${n - done} still open.`
          : `${whoCap} ${verb("haven't", "hasn't")} been given any tasks${when}.`;
      }
    }
    if (parsed.everyone && parsed.intent !== "review" && /\b(he|she|they|him|her)\b/i.test(question)) {
      answer = `I couldn't tell who you meant, so this is for the whole team. ${answer}`;
    }

    return NextResponse.json({
      answer,
      understood: {
        people: parsed.people.map((p) => p.name),
        intent: parsed.intent,
        period: parsed.period,
      },
      tasks: matched.slice(0, 100).map((t: any) => ({
        id: t.id,
        title: t.title,
        is_list: !!t.is_list,
        status: t.status,
        status_label: statusLabel(t.status),
        assignee: nameOf(t.assigned_to),
        due: t.due_date ? formatForPeople(t.due_date) : null,
        completed: t.completed_at ? formatForPeople(t.completed_at) : null,
        overdue: !!late(t),
      })),
      more: Math.max(0, matched.length - 100),
    });
  } catch (error: any) {
    console.error("GET /api/ask failed:", error);
    return NextResponse.json({ error: error?.message || "Could not answer that" }, { status: 500 });
  }
}
