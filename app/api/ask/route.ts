// Ask BusyBee: plain-English questions about the desk's work.
//
// It gathers only what the asker is allowed to see (their visible tasks and
// items, rewards/penalties that row security lets them read, requests for
// more time), then:
//   * with ANTHROPIC_API_KEY set in Vercel, Claude reads that data and answers
//     whatever was asked, citing the tasks it used;
//   * without it, a built-in reader (lib/ask.ts) answers the common questions
//     and says plainly when it doesn't understand.

import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";
import { getMemberships, requireUser, visibleTasks } from "@/lib/permissions";
import { inChunks, selectAll } from "@/lib/chunks";
import { isFinished, statusLabel } from "@/lib/status";
import { formatForPeople } from "@/lib/format";
import { AskPerson, Intent, parseQuestion, periodStart } from "@/lib/ask";

const PERIOD_WORDS: Record<string, string> = {
  today: "today",
  yesterday: "yesterday",
  week: "in the last 7 days",
  month: "in the last 30 days",
};

const rupees = (n: number) => `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export async function GET(request: NextRequest) {
  try {
    const question = (request.nextUrl.searchParams.get("q") || "").trim().slice(0, 500);
    if (!question) return NextResponse.json({ error: "Type a question" }, { status: 400 });

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const memberships = await getMemberships(supabase, user.id);
    const deskIds = memberships.map((m) => m.desk_id);
    if (!deskIds.length) return NextResponse.json({ answer: "You're not on a desk yet, so there's nothing to look up.", tasks: [] });

    // ---- gather what this person may see --------------------------------
    const [{ data: members }, rows, adjRes, { data: projects }] = await Promise.all([
      supabase.from("desk_members").select("user_id, users(id, email, full_name)").in("desk_id", deskIds),
      selectAll<any>(() =>
        supabase
          .from("tasks")
          .select(
            "id, title, description, status, priority, due_date, completed_at, created_at, assigned_to, created_by, task_manager_id, team_id, project_id, personal, archived_at, review_status, review_note, is_list, desk_id, progress_percent"
          )
          .in("desk_id", deskIds)
          .order("due_date", { ascending: true })
          .order("id")
      ),
      supabase
        .from("task_adjustments")
        .select("id, task_id, user_id, kind, amount, reason, effective_month, created_by, created_at, voided_at, void_reason")
        .in("desk_id", deskIds)
        .order("created_at", { ascending: false })
        .limit(500),
      supabase.from("projects").select("id, name").in("desk_id", deskIds),
    ]);

    const seen = new Set<string>();
    const people: AskPerson[] = [];
    (members || []).forEach((m: any) => {
      if (seen.has(m.user_id)) return;
      seen.add(m.user_id);
      people.push({ id: m.user_id, name: m.users?.full_name || m.users?.email || "Someone", email: m.users?.email || null });
    });
    const nameOf = (id: string | null) => people.find((p) => p.id === id)?.name || "Unassigned";
    const projectName = (id: string | null) => (projects || []).find((p: any) => p.id === id)?.name || null;

    const visible = (await visibleTasks(supabase, user.id, rows)).filter((t: any) => !t.personal);
    const visibleIds = visible.map((t: any) => t.id);
    const adjustments = (adjRes?.data || []) as any[];

    const [items, extensions] = await Promise.all([
      inChunks<any>(visibleIds, (part) =>
        supabase.from("subtasks").select("task_id, title, done, due_date").in("task_id", part)
      ).catch(() => []),
      inChunks<any>(visibleIds, (part) =>
        supabase
          .from("extension_requests")
          .select("task_id, requested_by, requested_date, reason, status, approved_date, created_at")
          .in("task_id", part)
      ).catch(() => []),
    ]);

    const now = Date.now();
    const late = (t: any) => !isFinished(t.status) && t.due_date && new Date(t.due_date).getTime() < now;
    const card = (t: any) => ({
      id: t.id,
      title: t.title,
      is_list: !!t.is_list,
      status: t.status,
      status_label: statusLabel(t.status),
      assignee: nameOf(t.assigned_to),
      due: t.due_date ? formatForPeople(t.due_date) : null,
      completed: t.completed_at ? formatForPeople(t.completed_at) : null,
      overdue: !!late(t),
    });

    // ---- with an AI key: let Claude read the data and answer ------------
    const key = process.env.ANTHROPIC_API_KEY?.trim();
    if (key) {
      try {
        const ai = await askClaude(key, question, {
          asker: nameOf(user.id),
          now: formatForPeople(new Date().toISOString()),
          people: people.map((p) => p.name),
          tasks: visible.slice(0, 400).map((t: any) => ({
            id: t.id,
            title: t.title,
            kind: t.is_list ? "to-do list" : "task",
            assigned_to: nameOf(t.assigned_to),
            given_by: nameOf(t.created_by),
            project: projectName(t.project_id),
            status: statusLabel(t.status),
            review: t.review_status || null,
            priority: t.priority,
            due: t.due_date ? formatForPeople(t.due_date) : null,
            overdue: !!late(t),
            finished: t.completed_at ? formatForPeople(t.completed_at) : null,
            progress: `${t.progress_percent ?? 0}%`,
            archived: !!t.archived_at,
            items: items
              .filter((s: any) => s.task_id === t.id)
              .map((s: any) => `${s.done ? "[x]" : "[ ]"} ${s.title}${s.due_date ? ` (by ${formatForPeople(s.due_date)})` : ""}`),
          })),
          rewards_and_penalties: adjustments.slice(0, 300).map((a) => ({
            person: nameOf(a.user_id),
            kind: a.kind,
            amount_rupees: Number(a.amount),
            reason: a.reason,
            for_month: String(a.effective_month).slice(0, 7),
            task: visible.find((t: any) => t.id === a.task_id)?.title || null,
            recorded_by: nameOf(a.created_by),
            recorded: formatForPeople(a.created_at),
            cancelled: a.voided_at ? `yes - ${a.void_reason || ""}` : "no",
          })),
          requests_for_more_time: extensions.slice(0, 200).map((x: any) => ({
            task: visible.find((t: any) => t.id === x.task_id)?.title || null,
            asked_by: nameOf(x.requested_by),
            wanted: x.requested_date ? formatForPeople(x.requested_date) : null,
            reason: x.reason,
            status: x.status,
            granted: x.approved_date ? formatForPeople(x.approved_date) : null,
          })),
        });
        const cited = visible.filter((t: any) => ai.task_ids.includes(t.id)).map(card);
        return NextResponse.json({ answer: ai.answer, tasks: cited, more: 0, by: "ai" });
      } catch (err) {
        // Any trouble with the AI service: fall through to the built-in reader.
        console.error("ask: AI answer failed, using the built-in reader", err);
      }
    }

    // ---- built-in reader -------------------------------------------------
    const parsed = parseQuestion(question, people, user.id);
    const ids = new Set(parsed.people.map((p) => p.id));
    const range = periodStart(parsed.period);
    const inRange = (iso: string | null) => {
      if (!range) return true;
      if (!iso) return false;
      const t = new Date(iso).getTime();
      return t >= range.from && t < range.to;
    };
    const when = parsed.period ? ` ${PERIOD_WORDS[parsed.period]}` : "";
    const forWhom = (pid: string | null) => parsed.everyone || ids.has(pid as string);

    // Name the person they asked about; "you" only when they asked about themselves.
    const who = parsed.everyone
      ? "the team"
      : parsed.people.map((p) => (parsed.self ? "you" : p.name.split(" ")[0])).join(" and ");
    const Who = who.charAt(0).toUpperCase() + who.slice(1);
    const plural = parsed.self || parsed.everyone || parsed.people.length > 1;
    const has = plural ? "have" : "has";
    const hasnt = plural ? "haven't" : "hasn't";

    if (parsed.intent === "unknown") {
      return NextResponse.json({
        answer:
          "I didn't understand that. I can answer questions about tasks (given, done, left, overdue, due today, waiting for review), rewards and penalties, and requests for more time - for example \"what is Priya left with?\" or \"penalties this month\".",
        tasks: [],
        more: 0,
      });
    }

    if (parsed.intent === "money") {
      const entries = adjustments
        .filter((a) => !a.voided_at && forWhom(a.user_id) && inRange(a.created_at))
        .filter((a) => {
          const q = question.toLowerCase();
          const wantsPenalty = /penalt|fine|deduct/.test(q);
          const wantsReward = /reward|bonus|incentive/.test(q);
          if (wantsPenalty && !wantsReward) return a.kind === "penalty";
          if (wantsReward && !wantsPenalty) return a.kind === "reward";
          return true;
        });
      const pen = entries.filter((a) => a.kind === "penalty").reduce((s, a) => s + Number(a.amount), 0);
      const rew = entries.filter((a) => a.kind === "reward").reduce((s, a) => s + Number(a.amount), 0);
      const parts: string[] = [];
      if (rew) parts.push(`${rupees(rew)} in rewards`);
      if (pen) parts.push(`${rupees(pen)} in penalties`);
      const answer = entries.length
        ? `${Who} ${has} ${parts.join(" and ")}${when} (${entries.length} entr${entries.length === 1 ? "y" : "ies"}):\n` +
          entries
            .slice(0, 20)
            .map(
              (a, i) =>
                `${i + 1}. ${a.kind === "reward" ? "Reward" : "Penalty"} ${rupees(a.amount)} - ${nameOf(a.user_id)} - "${a.reason}"${
                  visible.find((t: any) => t.id === a.task_id) ? ` (${visible.find((t: any) => t.id === a.task_id).title})` : ""
                } - ${formatForPeople(a.created_at)}`
            )
            .join("\n")
        : `No rewards or penalties for ${who}${when}${adjRes?.error ? " that you can see" : ""}.`;
      const taskIds = new Set(entries.map((a) => a.task_id));
      return NextResponse.json({ answer, tasks: visible.filter((t: any) => taskIds.has(t.id)).map(card), more: 0 });
    }

    if (parsed.intent === "extension") {
      const reqs = extensions.filter((x: any) => forWhom(x.requested_by) && inRange(x.created_at));
      const pending = reqs.filter((x: any) => x.status === "pending");
      const answer = reqs.length
        ? `${reqs.length} request${reqs.length === 1 ? "" : "s"} for more time${parsed.everyone ? "" : ` from ${who}`}${when}, ${pending.length} waiting for a decision:\n` +
          reqs
            .slice(0, 20)
            .map((x: any, i: number) => {
              const t = visible.find((v: any) => v.id === x.task_id);
              return `${i + 1}. ${nameOf(x.requested_by)} - ${t?.title || "a task"} - wants ${formatForPeople(x.requested_date)} - ${
                x.status === "pending" ? "waiting" : x.status
              }${x.reason ? ` - "${x.reason}"` : ""}`;
            })
            .join("\n")
        : `No requests for more time${parsed.everyone ? "" : ` from ${who}`}${when}.`;
      const taskIds = new Set(reqs.map((x: any) => x.task_id));
      return NextResponse.json({ answer, tasks: visible.filter((t: any) => taskIds.has(t.id)).map(card), more: 0 });
    }

    const todayRange = periodStart("today")!;
    const keep: Record<Exclude<Intent, "money" | "extension" | "unknown">, (t: any) => boolean> = {
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
    const intent = parsed.intent as keyof typeof keep;
    let matched = visible.filter((t: any) => (parsed.everyone ? !!t.assigned_to : ids.has(t.assigned_to))).filter(keep[intent]);
    if (intent === "assigned" && range) matched = matched.filter((t: any) => inRange(t.created_at));
    if (intent === "open" && range) matched = matched.filter((t: any) => inRange(t.due_date));
    matched.sort((a: any, b: any) =>
      intent === "completed"
        ? String(b.completed_at || "").localeCompare(String(a.completed_at || ""))
        : String(a.due_date || "9").localeCompare(String(b.due_date || "9"))
    );

    const n = matched.length;
    const tasksWord = `${n} task${n === 1 ? "" : "s"}`;
    let answer: string;
    switch (intent) {
      case "completed":
        answer = n ? `${Who} completed ${tasksWord}${when}.` : `${Who} ${hasnt} completed anything${when || " yet"}.`;
        break;
      case "open": {
        const overdue = matched.filter(late).length;
        answer = n
          ? `${Who} ${has} ${tasksWord} left${when}${overdue ? `, ${overdue} of them overdue` : ""}.`
          : `${Who} ${has} nothing left to do${when}. 🎉`;
        break;
      }
      case "overdue":
        answer = n ? `${tasksWord} overdue${parsed.everyone ? "" : ` for ${who}`}.` : `Nothing overdue${parsed.everyone ? "" : ` for ${who}`}. 👍`;
        break;
      case "review":
        answer = n ? `${tasksWord} finished and waiting for review.` : "Nothing is waiting for review.";
        break;
      case "due_today":
        answer = n ? `${tasksWord} due today${parsed.everyone ? "" : ` for ${who}`}.` : `Nothing due today${parsed.everyone ? "" : ` for ${who}`}.`;
        break;
      default: {
        const done = matched.filter((t: any) => isFinished(t.status)).length;
        answer = n
          ? `${Who} ${has} been given ${tasksWord}${when}: ${done} done, ${n - done} still open.`
          : `${Who} ${hasnt} been given any tasks${when}.`;
      }
    }

    return NextResponse.json({ answer, tasks: matched.slice(0, 100).map(card), more: Math.max(0, matched.length - 100) });
  } catch (error: any) {
    console.error("GET /api/ask failed:", error);
    return NextResponse.json({ error: error?.message || "Could not answer that" }, { status: 500 });
  }
}

/** One question to Claude with the data it may use. Returns the answer and the task ids it relied on. */
async function askClaude(key: string, question: string, data: unknown): Promise<{ answer: string; task_ids: string[] }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: process.env.ASK_MODEL?.trim() || "claude-haiku-4-5",
        max_tokens: 900,
        system:
          "You answer questions about a work team's tasks in BusyBee, a task app used by a finance firm in India. " +
          "Use ONLY the JSON data provided; never invent tasks, people, dates or amounts. If the data doesn't contain the answer, say so plainly. " +
          "Answer exactly what was asked, briefly and in plain English: one short sentence, then any list as numbered lines (1. ..., 2. ...), never bullets. " +
          "Amounts are in rupees (₹). 'asker' is the person asking: 'me'/'my'/'I' means them. " +
          'Reply with JSON only: {"answer": "<your answer>", "task_ids": ["<ids of the tasks your answer is about, if any>"]}',
        messages: [{ role: "user", content: `Data:\n${JSON.stringify(data)}\n\nQuestion: ${question}` }],
      }),
    });
    if (!res.ok) throw new Error(`AI service: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    const text: string = (body.content || []).map((c: any) => c.text || "").join("").trim();
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    try {
      const parsed = JSON.parse(json);
      return {
        answer: String(parsed.answer || "").trim() || "I couldn't find an answer to that.",
        task_ids: Array.isArray(parsed.task_ids) ? parsed.task_ids.map(String) : [],
      };
    } catch {
      return { answer: text || "I couldn't find an answer to that.", task_ids: [] };
    }
  } finally {
    clearTimeout(timer);
  }
}
