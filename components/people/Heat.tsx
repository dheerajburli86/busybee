"use client";

// The People heatmap's pieces: the colour key, a person's coloured box, and a
// person's page (open work, stale work and finished work, each task with its
// own colour and label so it's clear what is behind the person's colour).
// No numbers: colours and plain words only (rules in lib/heatmap.ts).

import Link from "next/link";
import { BANDS, NO_BAND, type HeatTask, type TaskHeat } from "@/lib/heatmap";
import { formatDue } from "@/components/tasks/types";
import { statusLabel } from "@/lib/status";
import { ago, type PersonResult } from "./useHeatmap";

const SEVERITY: Record<string, number> = { overdue: 0, close: 1, behind: 2, on_track: 3, ahead: 4, blocked: 5, no_deadline: 6 };

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

function TaskRow({ t, h }: { t: HeatTask; h: TaskHeat }) {
  const chip = coloursOf(h.band);
  return (
    <Link
      href={`/dashboard?task=${t.id}`}
      className="block rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 overflow-hidden"
      style={{ borderLeft: `6px solid ${chip.background}` }}
    >
      <div className="px-3 py-2.5 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className={`font-semibold leading-snug break-words ${h.open ? "text-white" : "text-slate-300"}`}>
            {!h.open && <span aria-hidden="true">✓ </span>}
            {t.title}
            {t.is_list && <span className="ml-2 text-[10px] uppercase tracking-wide text-slate-400">to-do list</span>}
          </p>
          <p className="text-xs text-slate-400 mt-0.5">{[t.project, h.open ? statusLabel(t.status) : null].filter(Boolean).join(" · ")}</p>
          <p className="text-xs text-slate-300 mt-0.5">
            {h.open ? (t.due ? `Due ${formatDue(t.due)}` : "No deadline") : `Finished ${formatDue(t.completed_at)}${t.due ? ` · was due ${formatDue(t.due)}` : ""}`}
          </p>
          <p className="text-xs text-slate-400 mt-0.5">{h.reason}</p>
        </div>
        <span className="shrink-0 text-xs font-bold px-2 py-1 rounded whitespace-nowrap" style={chip}>
          {h.label}
        </span>
      </div>
    </Link>
  );
}

function Group({ title, note, tasks, per, empty }: { title: string; note?: string; tasks: HeatTask[]; per: Map<string, TaskHeat>; empty?: string }) {
  if (!tasks.length && !empty) return null;
  return (
    <>
      <h2 className="text-lg font-semibold mb-1">
        {title} <span className="text-slate-400 font-normal">({tasks.length})</span>
      </h2>
      {note && <p className="text-xs text-slate-400 mb-2">{note}</p>}
      {tasks.length === 0 ? (
        <p className="text-sm text-slate-400 mb-6">{empty}</p>
      ) : (
        <div className="space-y-2 mb-6 mt-2">
          {tasks.map((t) => (
            <TaskRow key={t.id} t={t} h={per.get(t.id)!} />
          ))}
        </div>
      )}
    </>
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
  // Worst first, then the soonest deadline.
  const open = tasks
    .filter((t) => h(t).open && !h(t).stale)
    .sort((a, b) => SEVERITY[h(a).state] - SEVERITY[h(b).state] || dueMs(a) - dueMs(b));
  const stale = tasks.filter((t) => h(t).stale).sort((a, b) => dueMs(a) - dueMs(b));
  const done = tasks.filter((t) => !h(t).open).sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)));

  return (
    <div className="max-w-4xl mx-auto p-3 sm:p-6">
      <button type="button" onClick={onBack} className="mb-3 text-sm text-blue-400 hover:underline">
        ← All people
      </button>

      <div className="rounded-xl px-4 py-4 mb-4" style={coloursOf(heat?.band || null)}>
        <h1 className="text-2xl sm:text-3xl font-bold leading-tight break-words">
          {name}
          {me && " (you)"}
        </h1>
        <p className="text-lg font-bold mt-1">{heat?.label || NO_BAND.label}</p>
        {heat?.main && <p className="text-sm mt-1">{heat.main}</p>}
        <p className="text-sm mt-1">{heat?.summary || "Nothing assigned"}</p>
        <p className="text-xs mt-2 opacity-90">
          {[heat?.nextDue ? `Next deadline ${formatDue(heat.nextDue)}` : null, heat?.lastProgress ? `last progress ${ago(heat.lastProgress, now)}` : null]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>

      {scope === "visible" && <p className="text-xs text-slate-400 mb-4">Worked out from the tasks you can see.</p>}

      <Group title="Open tasks" tasks={open} per={per} empty="Nothing open right now." />
      <Group
        title="Stale - close it or give it a new date"
        note="Overdue for more than 30 days. Still counts as overdue until it's finished, closed or re-dated."
        tasks={stale}
        per={per}
      />
      <Group title="Completed (last 30 days)" tasks={done} per={per} empty="Nothing finished in the last 30 days." />

      <HowItWorks />
    </div>
  );
}

export function HowItWorks() {
  return (
    <details className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-sm">
      <summary className="font-semibold cursor-pointer">How the colours work</summary>
      <ul className="list-disc pl-5 mt-2 space-y-1.5 text-slate-300">
        <li>
          <b>Overdue (dark red):</b> past the deadline and not finished. Late is late, however late.
        </li>
        <li>
          <b>Deadline close (light red):</b> in the last fifth of its time with more than half the work left.
        </li>
        <li>
          <b>Falling behind (yellow):</b> in the last fifth of its time with some work left, or the work done is clearly behind the time used (for
          example, half the time gone and only a quarter done).
        </li>
        <li>
          <b>On track (light green):</b> the work is keeping up with the time used.
        </li>
        <li>
          <b>Ahead (dark green):</b> the work is clearly ahead of the time used, or all done. Finished on time is dark green; finished late is dark red.
        </li>
        <li>Work is counted in checklist items; a task without a checklist uses the progress reported on it.</li>
        <li>A person&apos;s colour is their worst open task - never an average. With nothing open, it shows how their last week of work went.</li>
        <li>Approved extensions move the deadline, so they count. Tasks without a deadline, or waiting on another task, have no colour.</li>
        <li>Only real progress changes a colour - ticking items, reporting progress, finishing. Changing a status doesn&apos;t. Colours update on their own.</li>
      </ul>
    </details>
  );
}
