// "Ask BusyBee": plain-English questions about who has what.
//
//   what tasks has dheeraj been assigned?   -> everything given to Dheeraj
//   what has dheeraj completed this week?   -> finished work, this week
//   what is dheeraj left with?              -> still open
//   who has overdue tasks?                  -> overdue, everyone
//
// No AI service involved: the question is matched against the desk's people
// and a handful of words, so answers are instant, free and exact.

export type Intent = "assigned" | "completed" | "open" | "overdue" | "review" | "due_today";
export type Period = "today" | "yesterday" | "week" | "month" | null;
export type AskPerson = { id: string; name: string; email?: string | null };

export type Parsed = {
  people: AskPerson[];
  everyone: boolean;
  intent: Intent;
  period: Period;
};

const has = (q: string, words: RegExp) => words.test(q);

export function parseQuestion(question: string, people: AskPerson[], meId: string): Parsed {
  const q = ` ${question.toLowerCase().replace(/[^a-z0-9@.\s'-]/g, " ").replace(/\s+/g, " ")} `;

  // Who: full names first, then first names, then email names; "me/my/I".
  const found = new Map<string, AskPerson>();
  const tokens = new Set(q.trim().split(" ").map((t) => t.replace(/'s$/, "")));
  for (const p of people) {
    const full = (p.name || "").toLowerCase().trim();
    const first = full.split(/\s+/)[0];
    const handle = (p.email || "").toLowerCase().split("@")[0];
    if ((full && q.includes(` ${full} `)) || (full && q.includes(` ${full}'s `))) found.set(p.id, p);
    else if (first && first.length > 2 && tokens.has(first)) found.set(p.id, p);
    else if (handle && handle.length > 2 && tokens.has(handle)) found.set(p.id, p);
  }
  if (!found.size && has(q, /\b(i|me|my|mine|myself)\b/)) {
    const self = people.find((p) => p.id === meId);
    if (self) found.set(self.id, self);
  }
  const everyone = !found.size;

  // What.
  let intent: Intent = "assigned";
  if (has(q, /\b(overdue|late|delayed|missed|behind|past due)\b/)) intent = "overdue";
  else if (has(q, /\b(review|approve|approval|sign off|signed off)\b/) && !has(q, /\bapproved\b/)) intent = "review";
  else if (has(q, /\b(due today|today's deadline)\b/)) intent = "due_today";
  else if (has(q, /\b(complet\w*|done|finish\w*|closed|approved|achieved|delivered)\b/) && !has(q, /\b(not|yet|un\w*|in ?complete|remaining|left)\b/))
    intent = "completed";
  else if (has(q, /\b(left|pending|remaining|remain|open|incomplete|not done|to do|todo|outstanding|yet|working on|ongoing|current|in progress)\b/))
    intent = "open";

  // When.
  let period: Period = null;
  if (has(q, /\byesterday\b/)) period = "yesterday";
  else if (has(q, /\btoday\b/) && intent !== "due_today") period = "today";
  else if (has(q, /\b(this|last|past) week\b|\bweekly\b/)) period = "week";
  else if (has(q, /\b(this|last|past) month\b|\bmonthly\b/)) period = "month";

  return { people: Array.from(found.values()), everyone, intent, period };
}

/** Start of a period in IST, as a timestamp. */
export function periodStart(period: Period, now = new Date()): { from: number; to: number } | null {
  if (!period) return null;
  const IST = 330 * 60000;
  const local = new Date(now.getTime() + IST);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - IST;
  const day = 86400000;
  if (period === "today") return { from: midnight, to: midnight + day };
  if (period === "yesterday") return { from: midnight - day, to: midnight };
  if (period === "week") return { from: midnight - 6 * day, to: midnight + day };
  return { from: midnight - 29 * day, to: midnight + day };
}

export const SUGGESTIONS = (name: string) => [
  `What tasks has ${name} been assigned?`,
  `What has ${name} completed this week?`,
  `What is ${name} left with?`,
  `Which of ${name}'s tasks are overdue?`,
  "Who has overdue tasks?",
  "What is waiting for review?",
];
