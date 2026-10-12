"use client";

// The People heatmap's pieces: the colour key, a person's coloured box, and a
// person's page (open work, stale work and finished work, each task with its
// own colour and label so it's clear what is behind the person's colour).
// No numbers: colours and plain words only (rules in lib/heatmap.ts).

import Link from "next/link";
import { BANDS, NO_BAND, type HeatTask, type TaskHeat } from "@/lib/heatmap";
import { formatDue } from "@/components/tasks/types";
import { ago, type PersonResult } from "./useHeatmap";

const coloursOf = (b: { bg: string; fg: string } | null) => (b ? { background: b.bg, color: b.fg } : { background: NO_BAND.bg, color: NO_BAND.fg });

export function HeatLegend() {
  return (
    <div className="flex flex-wrap gap-1.5 text-xs" aria-label="What the colours mean">
      {BANDS.map((b) => (
        <span key={b.key} className="px-2 py-1 rounded font-semibold" style={{ background: b.bg, color: b.fg }} title={b.meaning}>
          {b.label}
        </span>
      ))}
      <span className="px-2 py-1 rounded font-semibold" style={{ background: NO_BAND.bg, color: NO_BAND.fg }} title="No unfinished work with a deadline">
        Nothing open
      </span>
    </div>
  );
}

export function PersonTile({
  name,
  me,
  head,
  heat,
  now,
  ready,
  onOpen,
  children,
}: {
  name: string;
  me: boolean;
  head: boolean;
  heat: PersonResult | undefined;
  now: number;
  ready: boolean;
  onOpen: () => void;
  children?: React.ReactNode;
}) {
  const label = heat ? heat.label : ready ? NO_BAND.label : "Working out...";
  const explain = heat ? [label, heat.main, heat.summary, `Last progress: ${ago(heat.lastProgress, now)}`].filter(Boolean).join("\n") : "";
  return (
    <div className="rounded-lg overflow-hidden border border-slate-700">
      <button
        type="button"
        onClick={onOpen}
        title={explain}
        aria-label={`${name}${me ? " (you)" : ""}: ${label}. Open their tasks`}
        className="w-full text-left px-3 py-3 transition-[filter] hover:brightness-110 active:brightness-95"
        style={coloursOf(heat?.band || null)}
      >
        <p className="font-bold text-base leading-tight truncate">
          {name}
          {me && " (you)"}
          {head && <span className="ml-2 align-middle text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-black/25">Head</span>}
        </p>
        <p className="text-sm font-bold mt-1" data-heat-label>
          {label}
        </p>
        {heat?.main && <p className="text-xs mt-0.5 line-clamp-2">{heat.main}</p>}
        {heat && <p className="text-xs mt-0.5">{heat.summary}</p>}
        {heat?.nextDue && <p className="text-xs mt-0.5 opacity-90">Next deadline {formatDue(heat.nextDue)}</p>}
        {heat?.lastProgress && <p className="text-xs mt-0.5 opacity-90">Last progress {ago(heat.lastProgress, now)}</p>}
      </button>
      {children && <div className="bg-slate-900 px-3 py-2 flex flex-wrap items-center justify-between gap-2">{children}</div>}
    </div>
  );
}

const DAY_MS = 24 * 3600 * 1000;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** Whole calendar days from one moment's date to another's (local time). */
const calendarDays = (from: number, to: number) => {
  const d = (x: number) => {
    const t = new Date(x);
    return Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()) / DAY_MS;
  };
  return d(to) - d(from);
};

/** "due today", "due tomorrow", "due in 5 days", "no deadline". */
function dueWhen(t: HeatTask, now: number): string {
  if (!t.due) return "no deadline";
  const n = calendarDays(now, Date.parse(t.due));
  return n <= 0 ? "due today" : n === 1 ? "due tomorrow" : `due in ${n} days`;
}

/** "5 days overdue", "overdue 6 hours". */
function lateBy(t: HeatTask, now: number): string {
  const ms = now - Date.parse(t.due || "");
  const days = Math.floor(ms / DAY_MS);
  return days >= 1 ? `${plural(days, "day")} overdue` : `overdue ${plural(Math.max(1, Math.round(ms / 3600e3)), "hour")}`;
}

/** "done today · on time", "done 3 days ago · 1 day late". */
function doneWhen(t: HeatTask, h: TaskHeat, now: number): string {
  const at = Date.parse(t.completed_at || "");
  if (!Number.isFinite(at)) return "done";
  const n = calendarDays(at, now);
  const when = n <= 0 ? "done today" : n === 1 ? "done yesterday" : `done ${n} days ago`;
  if (h.state !== "done_late" || !t.due) return `${when}${t.due ? " · on time" : ""}`;
  const late = at - Date.parse(t.due);
  const lateText = late >= DAY_MS ? `${plural(Math.floor(late / DAY_MS), "day")} late` : `${plural(Math.max(1, Math.round(late / 3600e3)), "hour")} late`;
  return `${when} · ${lateText}`;
}

/** One line in a summary box: task name, then the days. */
function Line({ t, h, days, tag }: { t: HeatTask; h: TaskHeat; days: string; tag?: string }) {
  const dot = coloursOf(h.band).background;
  return (
    <li>
      <Link href={`/dashboard?task=${t.id}`} className="flex items-start gap-2 px-2 py-1.5 rounded hover:bg-slate-700" title={h.reason}>
        <span className="mt-1.5 w-2.5 h-2.5 rounded-full shrink-0" style={{ background: dot }} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-white break-words leading-snug">
            {t.title}
            {tag && <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide px-1 py-0.5 rounded bg-slate-700 text-slate-200 align-middle">{tag}</span>}
          </span>
          <span className="block text-xs text-slate-400">{[days, t.project].filter(Boolean).join(" · ")}</span>
        </span>
      </Link>
    </li>
  );
}

function SummaryBox({ title, accent, count, empty, children }: { title: string; accent: string; count: number; empty: string; children: React.ReactNode }) {
  return (
    <section className="bg-slate-800 border border-slate-700 rounded-lg overflow-hidden flex flex-col" style={{ borderTop: `4px solid ${accent}` }} aria-label={title}>
      <div className="px-3 py-2.5 flex items-baseline justify-between gap-2 border-b border-slate-700">
        <h2 className="font-bold">{title}</h2>
        <span className="text-2xl font-black tabular-nums">{count}</span>
      </div>
      {count === 0 ? <p className="px-3 py-3 text-sm text-slate-400">{empty}</p> : <ul className="p-1.5 space-y-0.5 max-h-[28rem] overflow-y-auto">{children}</ul>}
    </section>
  );
}

export function PersonTasks({
  name,
  me,
  heat,
  now,
  scope,
  onBack,
}: {
  name: string;
  me: boolean;
  heat: PersonResult | undefined;
  now: number;
  scope: "all" | "visible";
  onBack: () => void;
}) {
  const tasks = heat?.tasks || [];
  const per = heat?.perTask || new Map<string, TaskHeat>();
  const h = (t: HeatTask) => per.get(t.id)!;
  const dueMs = (t: HeatTask) => (t.due ? Date.parse(t.due) : Infinity);
  // Pending: open and the deadline not passed yet (soonest first).
  const pending = tasks.filter((t) => h(t).open && h(t).state !== "overdue").sort((a, b) => dueMs(a) - dueMs(b));
  // Deadline missed: open and past the deadline (longest overdue first).
  const missed = tasks.filter((t) => h(t).state === "overdue").sort((a, b) => dueMs(a) - dueMs(b));
  // Completed in the last 30 days (most recent first).
  const done = tasks.filter((t) => !h(t).open).sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)));
  const late = done.filter((t) => h(t).state === "done_late").length;

  return (
    <div className="max-w-6xl mx-auto p-3 sm:p-6">
      <button type="button" onClick={onBack} className="mb-3 text-sm text-blue-400 hover:underline">
        ← All people
      </button>

      <div className="rounded-xl px-4 py-3 mb-4" style={coloursOf(heat?.band || null)}>
        <h1 className="text-2xl sm:text-3xl font-bold leading-tight break-words">
          {name}
          {me && " (you)"}
        </h1>
        <p className="text-base font-bold mt-0.5">{heat?.label || NO_BAND.label}</p>
        <p className="text-xs mt-1 opacity-90">
          {[heat?.nextDue ? `Next deadline ${formatDue(heat.nextDue)}` : null, heat?.lastProgress ? `last progress ${ago(heat.lastProgress, now)}` : null]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>

      {scope === "visible" && <p className="text-xs text-slate-400 mb-3">Only the tasks you can see.</p>}

      <div className="grid gap-3 md:grid-cols-3 mb-6">
        <SummaryBox title="Pending" accent="#facc15" count={pending.length} empty="Nothing pending.">
          {pending.map((t) => (
            <Line key={t.id} t={t} h={h(t)} days={dueWhen(t, now)} tag={h(t).state === "close" ? "deadline close" : h(t).state === "behind" ? "behind" : undefined} />
          ))}
        </SummaryBox>
        <SummaryBox title="Completed" accent="#22c55e" count={done.length} empty="Nothing finished in the last 30 days.">
          {done.map((t) => (
            <Line key={t.id} t={t} h={h(t)} days={doneWhen(t, h(t), now)} />
          ))}
        </SummaryBox>
        <SummaryBox title="Deadline missed" accent="#dc2626" count={missed.length} empty="No missed deadlines.">
          {missed.map((t) => (
            <Line key={t.id} t={t} h={h(t)} days={lateBy(t, now)} tag={h(t).stale ? "stale" : undefined} />
          ))}
        </SummaryBox>
      </div>
      <p className="text-xs text-slate-400 -mt-4 mb-6">
        Completed covers the last 30 days{late ? `; ${late} of them finished after the deadline` : ""}. Tasks marked stale have been overdue for over 30 days - close them or give them a new date. Tap a task to open it.
      </p>

      <HowItWorks />
    </div>
  );
}

/** A colour name shaded in its own colour. */
function Shade({ k, children }: { k: "overdue" | "close" | "behind" | "on_track" | "ahead"; children: React.ReactNode }) {
  const b = BANDS.find((x) => x.key === k)!;
  return (
    <span className="px-1.5 py-0.5 rounded font-bold whitespace-nowrap" style={{ background: b.bg, color: b.fg }}>
      {children}
    </span>
  );
}

export function HowItWorks() {
  return (
    <details className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-sm">
      <summary className="font-semibold cursor-pointer">How the colours work</summary>
      <ol className="list-decimal pl-5 mt-3 space-y-2.5 text-slate-200 leading-relaxed">
        <li>
          <Shade k="overdue">Dark red</Shade> - deadline passed, not finished.
        </li>
        <li>
          <Shade k="close">Light red</Shade> - deadline very near, most work left.
        </li>
        <li>
          <Shade k="behind">Yellow</Shade> - work is behind time.
        </li>
        <li>
          <Shade k="on_track">Light green</Shade> - on track.
        </li>
        <li>
          <Shade k="ahead">Dark green</Shade> - ahead, or done on time.
        </li>
      </ol>
    </details>
  );
}
