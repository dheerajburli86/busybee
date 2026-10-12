// The performance heatmap: ONE scoring function, used by the server
// (/api/heatmap) and by the People screen, which re-runs it every minute so
// colours move as time passes even when nobody touches anything.
//
// A colour says how someone's work is going compared with how far along it
// should be BY NOW, given its deadlines - not just how much is finished. Ten
// items due in four days, four ticked on the evening of day two (about five
// expected by then) is "slightly behind", not "60% missing".
//
// No imports on purpose: tests run this file directly (tests/heatmap.test.mjs).
//
// ---------------------------------------------------------------------------
// HOW ONE TASK IS SCORED (0-100)
//
//   units     work in the task: one per checklist item (subtask); a task with
//             no checklist is 1 unit
//   done      units finished: ticked items (an item with a number target
//             counts part-way); with no checklist, the progress the person
//             reported (0-100%); a finished task is all done
//   window    from when the person was given the task (created, or last
//             reassigned to them) to its deadline - an approved extension has
//             already moved the deadline, so it counts automatically
//   expected  units that should be done by now: the share of the window used
//             so far x units (a straight line from start to deadline)
//   slack     half a unit for tasks of 1-2 units, then 1 / units (0.1 for ten
//             items): stops a small task jumping to dark red the moment its
//             clock starts; on a big checklist it hardly matters
//
//   Before the deadline:   done >= expected  ->  100
//                          otherwise  ->  100 x (done + slack) / (expected + slack)
//      Nothing counts against anyone in the first 10% of the window (too
//      early to judge); between 10% and 20% the shortfall phases in.
//      Example: 10 items over 4 days, 4 ticked at the end of day 2 (5
//      expected): 100 x 4.1 / 5.1 = 80 -> light green, slightly behind.
//   Past the deadline, unfinished:  40 x (done + slack) / (units + slack),
//      fading towards 0 as the lateness grows to one more window (at least a
//      day) - so at best light red, and dark red when little is done or it is
//      very late
//   Finished on time:      100
//   Finished late:         100 - 60 x lateness / window (40 at the lowest).
//      Fixed at the moment it was finished: it never turns redder later.
//   Not scored:            no deadline; waiting on another unfinished task
//                          (task dependency); shown, never held against anyone
//
// A PERSON'S SCORE: the weighted average of their scored tasks - every
// unfinished one, plus those finished in the last 7 days (so good recent
// delivery counts, and old work drops out). Weight = the task's units (its
// size), between 1 and 10, unless a task carries its own effort weight.
// Nothing scored: no colour ("Nothing due").
//
// COLOURS: 0-20 dark red, 21-40 light red, 41-60 yellow, 61-80 light green,
// 81-100 dark green.
//
// FAIRNESS: only real progress moves a score (ticking items, reporting
// progress, finishing); changing a status or editing a task does not. Not
// updating is never treated as not working - a task simply follows its
// schedule. Time is calendar time: BusyBee has no working hours, weekends or
// leave calendar yet (pass a different `elapsed` to scoreTask when it does).
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
  /** Effort weight, when the task has one (not stored yet; for later). */
  weight?: number | null;
  /** Waiting on another task that isn't finished yet. */
  blocked?: boolean;
  /** When real progress last happened (an item ticked, the task finished). */
  last_progress_at?: string | null;
  // For showing only:
  assigned_to?: string | null;
  project?: string | null;
  is_list?: boolean;
};

export type BandKey = "critical" | "behind" | "neutral" | "good" | "excellent";
export type Band = { key: BandKey; label: string; min: number; max: number; bg: string; fg: string; meaning: string };

/** Worst to best. Text colours chosen for contrast on each. */
export const BANDS: Band[] = [
  { key: "critical", label: "Dark red", min: 0, max: 20, bg: "#7f1d1d", fg: "#ffffff", meaning: "Critically behind schedule" },
  { key: "behind", label: "Light red", min: 21, max: 40, bg: "#fca5a5", fg: "#000000", meaning: "Significantly behind schedule" },
  { key: "neutral", label: "Yellow", min: 41, max: 60, bg: "#fde047", fg: "#000000", meaning: "Moderate progress" },
  { key: "good", label: "Light green", min: 61, max: 80, bg: "#86efac", fg: "#000000", meaning: "Progressing well" },
  { key: "excellent", label: "Dark green", min: 81, max: 100, bg: "#166534", fg: "#ffffff", meaning: "Excellent progress" },
];
/** Shown when there is nothing to score. */
export const NO_BAND = { bg: "#525252", fg: "#ffffff", label: "No colour" };

export const RULES = {
  /** Share of a task's window before anything counts against anyone. */
  grace: 0.1,
  /** Largest slack, in units (see the top of the file). */
  slack: 0.5,
  /** Best possible score for unfinished work past its deadline. */
  overdueCap: 40,
  /** Lowest score for work finished late. */
  lateFloor: 40,
  /** Finished work counts towards a person's colour for this long. */
  recentMs: 7 * 24 * 3600 * 1000,
  /** Weight limits per task. */
  minWeight: 1,
  maxWeight: 10,
  /** The shortest window a task is given (a deadline set right on creation). */
  minWindowMs: 60 * 1000,
};

/** Statuses that mean the work is finished (same as lib/status.ts). */
const FINISHED = ["done", "closed"];
const DAY = 24 * 3600 * 1000;

export type TaskState = "early" | "on_track" | "behind" | "overdue" | "done_on_time" | "done_late" | "no_deadline" | "blocked";

export type TaskHeat = {
  score: number | null;
  band: Band | null;
  state: TaskState;
  /** Units expected done by now (unfinished tasks), or all units. */
  expected: number;
  units: number;
  done: number;
  /** Counts towards the person's colour right now. */
  counts: boolean;
  weight: number;
  /** One line: why this task has its colour. */
  reason: string;
};

export function bandFor(score: number): Band {
  const s = Math.max(0, Math.min(100, Math.round(score)));
  return BANDS.find((b) => s <= b.max) || BANDS[BANDS.length - 1];
}

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

const round1 = (x: number) => Math.round(x * 10) / 10;
const fmtUnits = (x: number) => (Number.isInteger(round1(x)) ? String(Math.round(x)) : round1(x).toFixed(1));

/** "3 of 5 items done" or "40% reported". */
function doneText(t: HeatTask, units: number, done: number): string {
  return t.items > 0 ? `${fmtUnits(done)} of ${units} item${units === 1 ? "" : "s"} done` : `${Math.round(done * 100)}% reported done`;
}
function expectedText(t: HeatTask, expected: number): string {
  return t.items > 0 ? `about ${fmtUnits(expected)} expected by now` : `about ${Math.round(expected * 100)}% expected by now`;
}

/**
 * Elapsed time between two moments that counts as working time. Calendar time
 * for now; a working-hours / leave calendar can replace this later.
 */
export type Elapsed = (fromMs: number, toMs: number) => number;
export const calendarTime: Elapsed = (a, b) => b - a;

/** Slack for a task of this size: 0.5 units for 1-2 units, then 1 / units. */
export const slackFor = (units: number) => Math.min(RULES.slack, 1 / Math.max(1, units));

export function scoreTask(t: HeatTask, now: number, elapsed: Elapsed = calendarTime): TaskHeat {
  const units = Math.max(1, Math.round(t.items) || 0);
  const slack = slackFor(units);
  const finished = FINISHED.includes(t.status);
  const rawDone = finished ? units : t.items > 0 ? t.done : Math.max(0, Math.min(1, t.done)) * units;
  const done = Math.max(0, Math.min(units, rawDone));
  const weight = Math.max(RULES.minWeight, Math.min(RULES.maxWeight, t.weight && t.weight > 0 ? t.weight : units));
  const base = { units, done, weight };

  const due = ms(t.due);
  if (!Number.isFinite(due)) {
    return { ...base, score: null, band: null, state: "no_deadline", expected: 0, counts: false, reason: "No deadline - not scored" };
  }
  const startRaw = ms(t.start);
  const start = Number.isFinite(startRaw) ? Math.min(startRaw, due) : due;
  const window = Math.max(RULES.minWindowMs, elapsed(start, due));

  if (finished) {
    const at = ms(t.completed_at);
    if (!Number.isFinite(at)) {
      // Finished before finishing times were recorded: shown, not counted.
      return { ...base, score: 100, band: bandFor(100), state: "done_on_time", expected: units, counts: false, reason: "Finished" };
    }
    const when = at;
    const late = elapsed(due, when);
    const counts = now - when <= RULES.recentMs;
    if (late <= 0) {
      const band = bandFor(100);
      return { ...base, score: 100, band, state: "done_on_time", expected: units, counts, reason: "Finished on time" };
    }
    const score = Math.round(Math.max(RULES.lateFloor, 100 - (100 - RULES.lateFloor) * Math.min(1, late / window)));
    return { ...base, score, band: bandFor(score), state: "done_late", expected: units, counts, reason: `Finished ${span(late)} late` };
  }

  if (t.blocked) {
    return { ...base, score: null, band: null, state: "blocked", expected: 0, counts: false, reason: "Waiting on another task - not held against them" };
  }

  if (now > due) {
    const over = elapsed(due, now);
    const share = (done + slack) / (units + slack);
    const fade = Math.max(0, 1 - over / Math.max(window, DAY));
    const score = Math.round(RULES.overdueCap * share * fade);
    return {
      ...base,
      score,
      band: bandFor(score),
      state: "overdue",
      expected: units,
      counts: true,
      reason: `Overdue by ${span(over)}; ${doneText(t, units, done)}`,
    };
  }

  const used = Math.max(0, Math.min(1, elapsed(start, now) / window));
  const expected = units * used;
  const left = `due in ${span(due - now)}`;
  if (used < RULES.grace) {
    return { ...base, score: 100, band: bandFor(100), state: "early", expected, counts: true, reason: `Just started - ${left}` };
  }
  if (done >= expected) {
    return {
      ...base,
      score: 100,
      band: bandFor(100),
      state: "on_track",
      expected,
      counts: true,
      reason: `On track: ${doneText(t, units, done)}, ${expectedText(t, expected)}; ${left}`,
    };
  }
  const raw = Math.min(100, (100 * (done + slack)) / (expected + slack));
  // Between 10% and 20% of the window the shortfall phases in.
  const phase = Math.min(1, (used - RULES.grace) / RULES.grace);
  const score = Math.round(100 - phase * (100 - raw));
  return {
    ...base,
    score,
    band: bandFor(score),
    state: "behind",
    expected,
    counts: true,
    reason: `${doneText(t, units, done)}, ${expectedText(t, expected)}; ${left}`,
  };
}

export type PersonHeat = {
  score: number | null;
  band: Band | null;
  /** "Yellow - 40% done; about 50% was expected by now". */
  reason: string;
  /** The task pulling the colour down most, when there is one. */
  main: string | null;
  open: number;
  overdue: number;
  finishedRecently: number;
  /** The next deadline still ahead among unfinished tasks. */
  nextDue: string | null;
  lastProgress: string | null;
};

export function scorePerson(tasks: HeatTask[], now: number, elapsed: Elapsed = calendarTime): PersonHeat & { perTask: Map<string, TaskHeat> } {
  const perTask = new Map<string, TaskHeat>();
  let wSum = 0;
  let sSum = 0;
  let doneShare = 0;
  let expShare = 0;
  let open = 0;
  let overdue = 0;
  let finishedRecently = 0;
  let nextDue: number | null = null;
  let last: number | null = null;
  let worst: { pull: number; t: HeatTask; h: TaskHeat } | null = null;

  for (const t of tasks) {
    const h = scoreTask(t, now, elapsed);
    perTask.set(t.id, h);
    const finished = h.state === "done_on_time" || h.state === "done_late";
    if (!finished) {
      open += 1;
      const d = ms(t.due);
      if (Number.isFinite(d) && d > now && (nextDue === null || d < nextDue)) nextDue = d;
    } else if (h.counts) finishedRecently += 1;
    if (h.state === "overdue") overdue += 1;
    const lp = ms(t.last_progress_at);
    if (Number.isFinite(lp) && (last === null || lp > last)) last = lp;

    if (h.score === null || !h.counts) continue;
    wSum += h.weight;
    sSum += h.weight * h.score;
    doneShare += h.weight * (h.done / h.units);
    expShare += h.weight * (h.expected / h.units);
    const pull = h.weight * (100 - h.score);
    if (h.score <= 80 && (!worst || pull > worst.pull)) worst = { pull, t, h };
  }

  const out = {
    open,
    overdue,
    finishedRecently,
    nextDue: nextDue === null ? null : new Date(nextDue).toISOString(),
    lastProgress: last === null ? null : new Date(last).toISOString(),
    perTask,
  };
  if (wSum === 0) {
    const why = open > 0 ? "Nothing with a deadline to score" : "Nothing due";
    return { ...out, score: null, band: null, reason: why, main: null };
  }
  const score = Math.round(sSum / wSum);
  const band = bandFor(score);
  const d = Math.round((100 * doneShare) / wSum);
  const e = Math.round((100 * expShare) / wSum);
  const reason = `${band.label} - ${d}% done; about ${e}% was expected by now`;
  const main = worst ? `Main reason: "${worst.t.title}" - ${worst.h.reason}` : null;
  return { ...out, score, band, reason, main };
}
