// What every BusyBee email looks like.
//
// An alert email must make sense to someone who has never opened the task:
// whose task it is, who gave it, what it's about, when it's due, how far it
// has got, and why this reader is getting the email. So every email about a
// task carries a short "About this task" card built from the task itself.
//
// The Python scheduler (scheduler/main.py) builds the same layout for the
// reminders and daily summaries it sends.

import { formatForPeople } from "@/lib/format";

export type TaskCard = {
  id: string;
  title: string;
  description: string | null;
  assignee: string | null;
  assignee_id: string | null;
  given_by: string | null;
  given_by_id: string | null;
  project: string | null;
  priority: string | null;
  status: string;
  review_status: string | null;
  due: string | null;
  progress: number | null;
  is_list: boolean;
  items: { title: string; done: boolean; due: string | null }[];
};

const STATUS: Record<string, string> = {
  pending: "Not started",
  in_progress: "Being worked on",
  need_help: "Stuck - needs help",
  done: "Finished - waiting for review",
  closed: "Approved and closed",
};
const PRIORITY: Record<string, string> = { super_high: "Super high", high: "High", medium: "Medium", low: "Low" };

/** Load everything the card needs. `db` should be able to read users, projects and subtasks. */
export async function loadTaskCard(db: any, taskId: string): Promise<TaskCard | null> {
  try {
    const { data: t } = await db
      .from("tasks")
      .select("id, title, description, status, priority, due_date, assigned_to, created_by, project_id, progress_percent, review_status, is_list")
      .eq("id", taskId)
      .maybeSingle();
    if (!t) return null;
    const ids = [t.assigned_to, t.created_by].filter(Boolean);
    const [{ data: users }, { data: project }, { data: subs }] = await Promise.all([
      ids.length ? db.from("users").select("id, full_name, email").in("id", ids) : Promise.resolve({ data: [] }),
      t.project_id ? db.from("projects").select("name").eq("id", t.project_id).maybeSingle() : Promise.resolve({ data: null }),
      db.from("subtasks").select("title, done, due_date, position").eq("task_id", taskId).order("position", { ascending: true }),
    ]);
    const nm = (id: string | null) => {
      const u = (users || []).find((x: any) => x.id === id);
      return u ? u.full_name || u.email : null;
    };
    return {
      id: t.id,
      title: t.title,
      description: t.description || null,
      assignee: nm(t.assigned_to),
      assignee_id: t.assigned_to,
      given_by: nm(t.created_by),
      given_by_id: t.created_by,
      project: project?.name || null,
      priority: t.priority || null,
      status: t.status,
      review_status: t.review_status || null,
      due: t.due_date || null,
      progress: typeof t.progress_percent === "number" ? t.progress_percent : null,
      is_list: !!t.is_list,
      items: (subs || []).map((s: any) => ({ title: s.title, done: !!s.done, due: s.due_date || null })),
    };
  } catch {
    return null;
  }
}

/** "Fri, 9 Oct, 6:00 pm IST (in 2 days)" / "(overdue by 3 days)". */
export function dueText(iso: string | null, finished = false): string {
  if (!iso) return "No deadline";
  const ms = new Date(iso).getTime() - Date.now();
  const days = Math.round(Math.abs(ms) / 86400000);
  const hours = Math.round(Math.abs(ms) / 3600000);
  let rel = "";
  if (!finished) {
    if (ms < 0) rel = days >= 1 ? `overdue by ${days} day${days === 1 ? "" : "s"}` : `overdue by ${Math.max(1, hours)} hour${hours === 1 ? "" : "s"}`;
    else rel = days >= 1 ? `in ${days} day${days === 1 ? "" : "s"}` : `in ${Math.max(1, hours)} hour${hours === 1 ? "" : "s"}`;
  }
  return `${formatForPeople(iso)}${rel ? ` (${rel})` : ""}`;
}

/** Why this reader is getting the email, in their terms. */
export function whyYou(card: TaskCard | null, userId: string): string {
  if (!card) return "You're getting this because you use BusyBee.";
  if (card.assignee_id === userId) return "You're getting this because this task is assigned to you.";
  if (card.given_by_id === userId) return `You're getting this because you gave this task to ${card.assignee || "someone"}.`;
  return `You're getting this to keep you in the loop as a supervisor on BusyBee. ${card.given_by || "Someone"} gave this task to ${card.assignee || "someone"}.`;
}

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export type Section = { heading: string; lines: string[]; numbered?: boolean };

export function renderEmail(opts: {
  greeting?: string | null;
  headline: string;
  /** A small line under the headline, e.g. who did it and when. */
  meta?: string | null;
  paragraphs?: string[];
  card?: TaskCard | null;
  sections?: Section[];
  cta?: { url: string; label: string } | null;
  why?: string;
  settingsUrl?: string | null;
}): { text: string; html: string } {
  const { card } = opts;
  const finished = !!card && ["done", "closed"].includes(card.status);

  // ---- the task card, as label/value rows ----
  const rows: [string, string][] = [];
  if (card) {
    rows.push([card.is_list ? "To-do list" : "Task", card.title]);
    rows.push(["What it's about", card.description?.trim() || "No description was given."]);
    rows.push(["Assigned to", card.assignee || "Nobody yet"]);
    rows.push([
      "Given by",
      card.given_by_id && card.given_by_id === card.assignee_id
        ? `${card.given_by || "Someone"} (set this task for themselves)`
        : card.given_by || "Someone",
    ]);
    if (card.project) rows.push(["Project", card.project]);
    if (card.priority) rows.push(["Priority", PRIORITY[card.priority] || card.priority]);
    rows.push(["Deadline", dueText(card.due, finished)]);
    rows.push(["Where it stands", `${STATUS[card.status] || card.status}${card.review_status === "sent_back" && !finished ? " (sent back for changes)" : ""}`]);
    if (card.items.length) {
      const done = card.items.filter((i) => i.done).length;
      rows.push(["Progress", `${done} of ${card.items.length} items done (${card.progress ?? Math.round((done / card.items.length) * 100)}%)`]);
    } else if (card.progress != null) {
      rows.push(["Progress", `${card.progress}%`]);
    }
  }
  const itemLines = card?.items.map((i, n) => `${n + 1}. ${i.done ? "[done] " : ""}${i.title}${i.due ? ` - by ${formatForPeople(i.due)}` : ""}`) || [];

  // ---- plain text ----
  const t: string[] = [];
  if (opts.greeting) t.push(opts.greeting, "");
  t.push(opts.headline);
  if (opts.meta) t.push(opts.meta);
  (opts.paragraphs || []).forEach((p) => t.push("", p));
  if (card) {
    t.push("", "ABOUT THIS TASK");
    rows.forEach(([k, v]) => t.push(`${k}: ${v}`));
    if (itemLines.length) {
      t.push("", "Items:");
      itemLines.forEach((l) => t.push(`  ${l}`));
    }
  }
  (opts.sections || []).forEach((s) => {
    t.push("", s.heading.toUpperCase());
    s.lines.forEach((l, i) => t.push(s.numbered === false ? `  ${l}` : `  ${i + 1}. ${l}`));
  });
  if (opts.cta) t.push("", `${opts.cta.label}: ${opts.cta.url}`);
  t.push("", "--", opts.why || "You're getting this because you use BusyBee.");
  if (opts.settingsUrl) t.push(`Choose which emails you get: ${opts.settingsUrl}`);
  const text = t.join("\n");

  // ---- HTML ----
  const green = "#2f8f3a";
  const h: string[] = [];
  h.push(
    `<div style="background:#f4f6f4;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;color:#1d2a1f">`,
    `<div style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #dfe5df;border-radius:8px;overflow:hidden">`,
    `<div style="background:${green};color:#ffffff;padding:12px 20px;font-size:15px;font-weight:bold">🐝 BusyBee</div>`,
    `<div style="padding:20px">`
  );
  if (opts.greeting) h.push(`<p style="margin:0 0 12px;font-size:15px">${esc(opts.greeting)}</p>`);
  h.push(`<p style="margin:0 0 ${opts.meta ? 4 : 12}px;font-size:17px;font-weight:bold;line-height:1.4">${esc(opts.headline)}</p>`);
  if (opts.meta) h.push(`<p style="margin:0 0 12px;font-size:13px;color:#6b7a6e">${esc(opts.meta)}</p>`);
  (opts.paragraphs || []).forEach((p) => h.push(`<p style="margin:0 0 12px;font-size:15px;line-height:1.5">${esc(p)}</p>`));
  if (card) {
    h.push(
      `<div style="margin:16px 0;border:1px solid #dfe5df;border-radius:6px">`,
      `<div style="background:#eef5ee;padding:8px 14px;font-size:12px;font-weight:bold;letter-spacing:.06em;color:${green}">ABOUT THIS TASK</div>`,
      `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:14px">`
    );
    rows.forEach(([k, v]) =>
      h.push(
        // Label above value: reads well on a phone, where two columns squeeze the text.
        `<tr><td style="padding:8px 14px;border-top:1px solid #eef1ee"><div style="font-size:12px;color:#5b6b5e;margin-bottom:2px">${esc(k)}</div><div style="font-size:15px;line-height:1.45">${esc(v)}</div></td></tr>`
      )
    );
    h.push(`</table>`);
    if (card.items.length) {
      h.push(`<div style="padding:4px 14px 12px"><div style="font-size:13px;color:#5b6b5e;margin:6px 0">Items</div><ol style="margin:0;padding-left:22px;font-size:14px;line-height:1.6">`);
      card.items.forEach((i) =>
        h.push(
          `<li style="${i.done ? "color:#8a978c;text-decoration:line-through" : ""}">${esc(i.title)}${i.due ? ` <span style="color:#8a978c">- by ${esc(formatForPeople(i.due))}</span>` : ""}</li>`
        )
      );
      h.push(`</ol></div>`);
    }
    h.push(`</div>`);
  }
  (opts.sections || []).forEach((s) => {
    h.push(`<div style="margin:16px 0 6px;font-size:12px;font-weight:bold;letter-spacing:.06em;color:${green}">${esc(s.heading.toUpperCase())}</div>`);
    const tag = s.numbered === false ? "ul" : "ol";
    h.push(`<${tag} style="margin:0;padding-left:22px;font-size:14px;line-height:1.6">`);
    s.lines.forEach((l) => h.push(`<li>${esc(l)}</li>`));
    h.push(`</${tag}>`);
  });
  if (opts.cta)
    h.push(
      `<p style="margin:20px 0 4px"><a href="${esc(opts.cta.url)}" style="background:${green};color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:bold;display:inline-block">${esc(opts.cta.label)}</a></p>`
    );
  h.push(
    `</div>`,
    `<div style="border-top:1px solid #dfe5df;padding:12px 20px;font-size:12px;color:#7a887c;line-height:1.5">${esc(opts.why || "You're getting this because you use BusyBee.")}${
      opts.settingsUrl ? ` <a href="${esc(opts.settingsUrl)}" style="color:#7a887c">Choose which emails you get</a>.` : ""
    }</div>`,
    `</div></div>`
  );
  return { text, html: h.join("") };
}
