// The People heatmap: ONE set of rules, used by the People screen, which
// re-applies them every 30 seconds so colours change as deadlines approach
// and pass, even when nobody touches anything.
//
// No scores. Every task gets a colour and a plain label from facts anyone can
// check - its deadline, how much of its time is gone, how much work is left.
// A person's colour is their worst real problem, never an average.
//
// No imports on purpose: tests run this file directly (tests/heatmap.test.mjs).
//
// ---------------------------------------------------------------------------
// ONE TASK (unfinished)
//   work left   checklist items not ticked (part-way items count part-way);
//               a task with no checklist uses the progress reported on it
//   time gone   share of the time from when the person was given the task
//               (created, or handed to them) to its deadline. An approved
//               extension moves the deadline, so it counts automatically.
//
//   Past the deadline ............................. DARK RED     "Overdue"
//     Late is late: no "slightly late". Overdue for more than 30 days is
//     also listed as stale (close it or give it a new date).
//   Final stretch (last 20% of its time) and
//     more than half the work left ................ LIGHT RED    "Deadline close!"
//   Final stretch with any work left, or more than
//     a quarter of its time gone and the work is a
//     quarter or more behind the time .............. YELLOW       "Pending - still time"
//   Work done is clearly ahead of the time gone,
//     or all the work is done (just not closed) .... DARK GREEN   "Ahead"
//   Anything else ................................. LIGHT GREEN  "On track"
//
// ONE TASK (finished): before its deadline DARK GREEN "Done on time";
//   after it DARK RED "Done late" (fixed - it never changes afterwards).
// NOT COLOURED: no deadline; waiting on another unfinished task.
//
// A PERSON: the worst colour among their unfinished tasks. With nothing
// unfinished: dark green if they finished something in the last 7 days,
// all on time; light green if some of it was late; grey if nothing at all.
//
// Only real progress (ticking items, reported progress, finishing) changes a
// colour; a status change alone doesn't. Time is calendar time (BusyBee has
// no working-hours or leave calendar yet).
// ---------------------------------------------------------------------------

export type HeatTask = {
  id: string;
  title: string;
  status: string;
  /** When this person was given the task: created, or last reassigned to them. */
  start: string;
  /** The deadline in force now (approved extensions have already moved it). */
  due: string | null;
  completed_at: string | null;
  /** Checklist items; 0 when the task has no checklist. */
  items: number;
  /** Items done (part-way items count part-way); with no checklist, the reported share 0-1. */
  done: number;
  /** Waiting on another task that isn't finished yet. */
  blocked?: boolean;
  /** When real progress last happened (an item ticked, the task finished). */
  last_progress_at?: string | null;
  // For showing only:
  assigned_to?: string | null;
  project?: string | null;
  is_list?: boolean;
};

export type BandKey = "overdue" | "close" | "behind" | "on_track" | "ahead";
export type Band = { key: BandKey; colour: string; label: string; meaning: string; bg: string; fg: string };

/** Worst to best. Text colours chosen for contrast on each. */
export const BANDS: Band[] = [
  { key: "overdue", colour: "Dark red", label: "Overdue", meaning: "Past the deadline and not finished", bg: "#7f1d1d", fg: "#ffffff" },
  { key: "close", colour: "Light red", label: "Deadline close!", meaning: "Deadline is close and a lot is still left - act now", bg: "#fca5a5", fg: "#000000" },
  { key: "behind", colour: "Yellow", label: "Pending - still time", meaning: "Work is pending, but there's still time", bg: "#fde047", fg: "#000000" },
  { key: "on_track", colour: "Light green", label: "On track", meaning: "Work is keeping up with the time used", bg: "#86efac", fg: "#000000" },
  { key: "ahead", colour: "Dark green", label: "Ahead", meaning: "Work is ahead of the time used, or done on time", bg: "#166534", fg: "#ffffff" },
];
export const band = (k: BandKey): Band => BANDS.find((b) => b.key === k)!;
/** Shown when there is nothing to colour. */
export const NO_BAND = { bg: "#525252", fg: "#ffffff", colour: "Grey", label: "Nothing open" };

export const RULES = {
  /** The last share of a task's time that counts as the final stretch. */
  finalStretch: 0.2,
  /** "Most of the work left" in the final stretch: more than this share. */
  mostLeft: 0.5,
  /** Falling behind: work trails the time gone by this much... */
  behindGap: 0.25,
  /** ...once at least this much of its time is gone. */
  behindAfter: 0.25,
  /** Ahead: work leads the time gone by at least this much. */
  aheadGap: 0.1,
  /** Overdue this long: also listed as stale. */
  staleMs: 30 * 24 * 3600 * 1000,
  /** Finished work counts towards a person's colour for this long. */
  recentMs: 7 * 24 * 3600 * 1000,
};

/** Statuses that mean the work is finished (same as lib/status.ts). */
const FINISHED = ["done", "closed"];

export type TaskState = "overdue" | "close" | "behind" | "on_track" | "ahead" | "done_on_time" | "done_late" | "no_deadline" | "blocked";

export type TaskHeat = {
  band: Band | null;
  state: TaskState;
  /** Short label: "Overdue", "Done on time", "No deadline"... */
  label: string;
  /** One line of facts: why it has this colour. */
  reason: string;
  /** Unfinished. */
  open: boolean;
  /** Overdue for more than 30 days. */
  stale: boolean;
  /** Finished in the last 7 days. */
  recent: boolean;
};

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/** "40 minutes", "5 hours", "1 day 6 hours", "4 days". */
export function span(msLong: number): string {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const m = Math.max(1, Math.round(msLong / 60000));
  if (m < 60) return plural(m, "minute");
  const h = Math.round(m / 60);
  if (h < 24) return plural(h, "hour");
  const d = Math.floor(h / 24);
  const rest = h - d * 24;
  if (d < 3 && rest > 0) return `${plural(d, "day")} ${plural(rest, "hour")}`;
  return plural(Math.round(h / 24), "day");
}

/** "2 of 3 items done" / "half reported done" / "no progress reported". */
function workText(t: HeatTask, done: number): string {
  if (t.items > 0) {
    const n = Math.floor(done * t.items + 1e-9);
    return `${n} of ${t.items} item${t.items === 1 ? "" : "s"} done`;
  }
  if (done <= 0) return "no progress reported";
  if (done >= 1) return "reported fully done";
  return `${Math.round(done * 100)}% reported done`;
}

/** "a quarter", "half", "three quarters", "most" of its time is gone. */
function timeText(used: number): string {
  if (used < 0.2) return "Just started";
  if (used < 0.4) return "About a quarter of its time is gone";
  if (used < 0.6) return "About half its time is gone";
  if (used < 0.8) return "About three quarters of its time is gone";
  return "Most of its time is gone";
}

export function scoreTask(t: HeatTask, now: number): TaskHeat {
  const finished = FINISHED.includes(t.status);
  const done = finished ? 1 : t.items > 0 ? Math.max(0, Math.min(1, t.done / t.items)) : Math.max(0, Math.min(1, t.done));
  const out = (state: TaskState, b: Band | null, label: string, reason: string, extra: Partial<TaskHeat> = {}): TaskHeat => ({
    band: b,
    state,
    label,
    reason,
    open: !finished,
    stale: false,
    recent: false,
    ...extra,
  });

  const due = ms(t.due);
  if (finished) {
    const at = ms(t.completed_at);
    const recent = Number.isFinite(at) && now - at <= RULES.recentMs;
    if (!Number.isFinite(due) || !Number.isFinite(at)) return out("done_on_time", band("ahead"), "Done", "Finished", { recent });
    if (at <= due) return out("done_on_time", band("ahead"), "Done on time", "Finished before the deadline", { recent });
    return out("done_late", band("overdue"), "Done late", `Finished ${span(at - due)} after the deadline`, { recent });
  }
  if (!Number.isFinite(due)) return out("no_deadline", null, "No deadline", "No deadline - not coloured");
  if (t.blocked) return out("blocked", null, "Waiting", "Waiting on another task - not held against them");

  const work = workText(t, done);
  if (now > due) {
    const late = now - due;
    return out("overdue", band("overdue"), "Overdue", `Overdue by ${span(late)}; ${work}`, { stale: late > RULES.staleMs });
  }

  const startRaw = ms(t.start);
  const start = Number.isFinite(startRaw) ? Math.min(startRaw, due) : due;
  const window = Math.max(60_000, due - start);
  const used = Math.max(0, Math.min(1, (now - start) / window));
  const left = 1 - done;
  const finalStretch = due - now <= RULES.finalStretch * window;
  const dueIn = `due in ${span(due - now)}`;

  if (done >= 1) return out("ahead", band("ahead"), "Ahead", `All the work is done; ${dueIn}`);
  if (finalStretch && left > RULES.mostLeft) return out("close", band("close"), "Deadline close!", `${capital(dueIn)}; ${work}`);
  if (finalStretch) return out("behind", band("behind"), "Pending - still time", `${capital(dueIn)}; ${work}`);
  if (used >= RULES.behindAfter && used - done >= RULES.behindGap - 1e-9)
    return out("behind", band("behind"), "Pending - still time", `${timeText(used)}; ${work}; ${dueIn}`);
  if (done > 0 && done - used >= RULES.aheadGap - 1e-9) return out("ahead", band("ahead"), "Ahead", `${timeText(used)}; ${work}; ${dueIn}`);
  return out("on_track", band("on_track"), "On track", `${timeText(used)}; ${work}; ${dueIn}`);
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export type PersonCounts = {
  overdue: number;
  close: number;
  behind: number;
  on_track: number;
  ahead: number;
  not_coloured: number;
  stale: number;
  done_on_time: number;
  done_late: number;
};

export type PersonHeat = {
  band: Band | null;
  /** "Overdue work", "Deadline close", "On track", "Nothing open"... */
  label: string;
  /** "2 overdue · 1 deadline close · 3 on track · 1 done late this week". */
  summary: string;
  /** The tasks behind the colour: 'Overdue: "Report", "Deck"'. */
  main: string | null;
  counts: PersonCounts;
  open: number;
  /** The next deadline still ahead among unfinished tasks. */
  nextDue: string | null;
  lastProgress: string | null;
};

const PERSON_LABEL: Record<BandKey, string> = {
  overdue: "Overdue work",
  close: "Deadline close!",
  behind: "Work pending - still time",
  on_track: "On track",
  ahead: "Ahead",
};

/** Up to two task names, the earliest deadline first, then "+N more". */
function names(ts: HeatTask[]): string {
  const byDue = ts.slice().sort((a, b) => (ms(a.due) || 0) - (ms(b.due) || 0));
  const shown = byDue.slice(0, 2).map((t) => `"${t.title}"`);
  return ts.length > 2 ? `${shown.join(", ")} +${ts.length - 2} more` : shown.join(", ");
}

export function scorePerson(tasks: HeatTask[], now: number): PersonHeat & { perTask: Map<string, TaskHeat> } {
  const perTask = new Map<string, TaskHeat>();
  const counts: PersonCounts = { overdue: 0, close: 0, behind: 0, on_track: 0, ahead: 0, not_coloured: 0, stale: 0, done_on_time: 0, done_late: 0 };
  const byState = new Map<TaskState, HeatTask[]>();
  let nextDue: number | null = null;
  let last: number | null = null;

  for (const t of tasks) {
    const h = scoreTask(t, now);
    perTask.set(t.id, h);
    byState.set(h.state, [...(byState.get(h.state) || []), t]);
    if (h.state === "no_deadline" || h.state === "blocked") counts.not_coloured += 1;
    else if (h.state === "done_on_time") h.recent && (counts.done_on_time += 1);
    else if (h.state === "done_late") h.recent && (counts.done_late += 1);
    else counts[h.state] += 1;
    if (h.stale) counts.stale += 1;
    const d = ms(t.due);
    if (h.open && Number.isFinite(d) && d > now && (nextDue === null || d < nextDue)) nextDue = d;
    const lp = ms(t.last_progress_at);
    if (Number.isFinite(lp) && (last === null || lp > last)) last = lp;
  }

  const open = counts.overdue + counts.close + counts.behind + counts.on_track + counts.ahead + counts.not_coloured;
  const parts: string[] = [];
  if (counts.overdue) parts.push(`${counts.overdue} overdue`);
  if (counts.close) parts.push(`${counts.close} deadline close`);
  if (counts.behind) parts.push(`${counts.behind} pending`);
  if (counts.on_track) parts.push(`${counts.on_track} on track`);
  if (counts.ahead) parts.push(`${counts.ahead} ahead`);
  if (counts.not_coloured) parts.push(`${counts.not_coloured} without a deadline or waiting`);
  if (counts.done_on_time) parts.push(`${counts.done_on_time} done on time this week`);
  if (counts.done_late) parts.push(`${counts.done_late} done late this week`);

  // The worst colour among unfinished work.
  const worst = (["overdue", "close", "behind", "on_track", "ahead"] as BandKey[]).find((k) => counts[k] > 0) || null;
  let b: Band | null = worst ? band(worst) : null;
  let label = worst ? PERSON_LABEL[worst] : NO_BAND.label;
  let main: string | null = null;
  if (worst === "overdue") main = `Overdue: ${names(byState.get("overdue")!)}`;
  else if (worst === "close") main = `Deadline close: ${names(byState.get("close")!)}`;
  else if (worst === "behind") main = `Pending: ${names(byState.get("behind")!)}`;
  if (!worst && counts.done_on_time + counts.done_late > 0) {
    b = counts.done_late ? band("on_track") : band("ahead");
    label = counts.done_late ? "Nothing open (some finished late)" : "Nothing open, all done on time";
  }

  return {
    band: b,
    label,
    summary: parts.join(" · ") || "Nothing assigned",
    main,
    counts,
    open,
    nextDue: nextDue === null ? null : new Date(nextDue).toISOString(),
    lastProgress: last === null ? null : new Date(last).toISOString(),
    perTask,
  };
}
