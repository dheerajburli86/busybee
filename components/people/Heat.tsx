"use client";

// The People heatmap's pieces: the colour key, a person's coloured box, and a
// person's page (their open work and their finished work, each task with its
// own colour so it's clear what is pulling the colour down).

import Link from "next/link";
import { BANDS, NO_BAND, type HeatTask, type TaskHeat } from "@/lib/heatmap";
import { formatDue } from "@/components/tasks/types";
import { statusLabel } from "@/lib/status";
import { ago, type PersonResult } from "./useHeatmap";

const FINISHED_STATES = ["done_on_time", "done_late"];

export function HeatLegend() {
  return (
    <div className="flex flex-wrap gap-1.5 text-xs" aria-label="What the colours mean">
      {BANDS.map((b) => (
        <span key={b.key} className="px-2 py-1 rounded font-semibold" style={{ background: b.bg, color: b.fg }} title={b.meaning}>
          {b.min}-{b.max} {b.label}
        </span>
      ))}
      <span className="px-2 py-1 rounded font-semibold" style={{ background: NO_BAND.bg, color: NO_BAND.fg }} title="Nothing with a deadline to score">
        No colour: nothing due
      </span>
    </div>
  );
}

/** "3 open · 1 overdue · next due 14 Oct, 6:00 pm". */
function workLine(h: PersonResult): string {
  const parts = [`${h.open} open`];
  if (h.overdue) parts.push(`${h.overdue} overdue`);
  if (h.finishedRecently) parts.push(`${h.finishedRecently} finished this week`);
  if (h.nextDue) parts.push(`next due ${formatDue(h.nextDue)}`);
  return parts.join(" · ");
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
  const band = heat?.band || null;
  const colours = band ? { background: band.bg, color: band.fg } : { background: NO_BAND.bg, color: NO_BAND.fg };
  const detail = heat ? (band ? heat.reason.replace(/^[^-]+- /, "") : heat.reason) : ready ? "Nothing due" : "Working out...";
  const explain = heat
    ? [band ? `${band.label} (${heat.score}/100): ${band.meaning}` : "No colour", heat.reason, heat.main, `Last progress: ${ago(heat.lastProgress, now)}`]
        .filter(Boolean)
        .join("\n")
    : "";
  return (
    <div className="rounded-lg overflow-hidden border border-slate-700">
      <button
        type="button"
        onClick={onOpen}
        title={explain}
        aria-label={`${name}${me ? " (you)" : ""}: ${heat?.reason || "no colour"}. Open their tasks`}
        className="w-full text-left px-3 py-3 flex items-start gap-3 transition-[filter] hover:brightness-110 active:brightness-95"
        style={colours}
      >
        <div className="min-w-0 flex-1">
          <p className="font-bold text-base leading-tight truncate">
            {name}
            {me && " (you)"}
            {head && <span className="ml-2 align-middle text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-black/25">Head</span>}
          </p>
          <p className="text-xs font-semibold mt-1">{band ? `${band.label} · ${band.meaning}` : "No colour"}</p>
          <p className="text-xs mt-0.5">{detail}</p>
          {heat?.main && <p className="text-xs mt-0.5 line-clamp-2">{heat.main}</p>}
          {heat && (heat.open > 0 || heat.finishedRecently > 0) && <p className="text-xs mt-0.5 opacity-90">{workLine(heat)}</p>}
          {heat?.lastProgress && <p className="text-xs mt-0.5 opacity-90">Last progress {ago(heat.lastProgress, now)}</p>}
        </div>
        <div className="text-right shrink-0">
          <p className="text-3xl font-black leading-none tabular-nums">{heat?.score ?? "-"}</p>
          <p className="text-[10px] font-semibold uppercase tracking-wide mt-1">score</p>
        </div>
      </button>
      {children && <div className="bg-slate-900 px-3 py-2 flex flex-wrap items-center justify-between gap-2">{children}</div>}
    </div>
  );
}

function TaskRow({ t, h, now }: { t: HeatTask; h: TaskHeat; now: number }) {
  const finished = FINISHED_STATES.includes(h.state);
  const band = h.band;
  const chip = band ? { background: band.bg, color: band.fg } : { background: NO_BAND.bg, color: NO_BAND.fg };
  const progress =
    t.items > 0 ? `${Math.round(h.done * 10) / 10} of ${t.items} item${t.items === 1 ? "" : "s"} done` : finished ? "Done" : `${Math.round(h.done * 100)}% reported done`;
  return (
    <Link
      href={`/dashboard?task=${t.id}`}
      className={`block rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 overflow-hidden ${finished ? "opacity-90" : ""}`}
      style={{ borderLeft: `6px solid ${chip.background}` }}
    >
      <div className="px-3 py-2.5 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className={`font-semibold leading-snug break-words ${finished ? "text-slate-300" : "text-white"}`}>
            {finished && <span aria-hidden="true">✓ </span>}
            {t.title}
            {t.is_list && <span className="ml-2 text-[10px] uppercase tracking-wide text-slate-400">to-do list</span>}
          </p>
          <p className="text-xs text-slate-400 mt-0.5">
            {[t.project, finished ? null : statusLabel(t.status), progress].filter(Boolean).join(" · ")}
          </p>
          <p className="text-xs text-slate-300 mt-0.5">
            {finished
              ? `Finished ${formatDue(t.completed_at)}`
              : t.due
              ? `Due ${formatDue(t.due)}${Date.parse(t.due) < now ? " (overdue)" : ""}`
              : "No deadline"}
          </p>
          <p className="text-xs text-slate-400 mt-0.5">{h.reason}</p>
        </div>
        <div className="shrink-0 text-right">
          {finished ? (
            <span
              className={`inline-block text-[11px] font-semibold px-2 py-1 rounded ${
                h.state === "done_on_time" ? "bg-green-900 text-green-300" : "bg-amber-900 text-amber-300"
              }`}
            >
              {h.state === "done_on_time" ? "On time" : "Late"}
            </span>
          ) : (
            <span className="inline-block min-w-[2.75rem] text-center text-sm font-black px-2 py-1 rounded tabular-nums" style={chip}>
              {h.score ?? "-"}
            </span>
          )}
        </div>
      </div>
    </Link>
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
  const isDone = (t: HeatTask) => FINISHED_STATES.includes(per.get(t.id)?.state || "");
  const dueMs = (t: HeatTask) => (t.due ? Date.parse(t.due) : Infinity);
  // Most urgent first: overdue, then soonest deadline, no deadline last.
  const open = tasks.filter((t) => !isDone(t)).sort((a, b) => dueMs(a) - dueMs(b));
  const done = tasks.filter(isDone).sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)));
  const band = heat?.band || null;
  const colours = band ? { background: band.bg, color: band.fg } : { background: NO_BAND.bg, color: NO_BAND.fg };

  return (
    <div className="max-w-4xl mx-auto p-3 sm:p-6">
      <button type="button" onClick={onBack} className="mb-3 text-sm text-blue-400 hover:underline">
        ← All people
      </button>

      <div className="rounded-xl px-4 py-4 mb-4 flex items-start gap-4" style={colours}>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl sm:text-3xl font-bold leading-tight break-words">
            {name}
            {me && " (you)"}
          </h1>
          <p className="text-sm font-semibold mt-1">{band ? `${band.label} · ${band.meaning}` : "No colour"}</p>
          <p className="text-sm mt-1">{heat ? (band ? heat.reason.replace(/^[^-]+- /, "") : heat.reason) : "Nothing due"}</p>
          {heat?.main && <p className="text-sm mt-1">{heat.main}</p>}
          <p className="text-xs mt-2 opacity-90">
            {heat ? workLine(heat) : ""}
            {heat?.lastProgress ? ` · last progress ${ago(heat.lastProgress, now)}` : ""}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-5xl font-black leading-none tabular-nums">{heat?.score ?? "-"}</p>
          <p className="text-[10px] font-semibold uppercase tracking-wide mt-1">out of 100</p>
        </div>
      </div>

      {scope === "visible" && <p className="text-xs text-slate-400 mb-4">Worked out from the tasks you can see.</p>}

      <h2 className="text-lg font-semibold mb-2">
        Open tasks <span className="text-slate-400 font-normal">({open.length})</span>
      </h2>
      {open.length === 0 ? (
        <p className="text-sm text-slate-400 mb-6">Nothing open right now.</p>
      ) : (
        <div className="space-y-2 mb-6">
          {open.map((t) => (
            <TaskRow key={t.id} t={t} h={per.get(t.id)!} now={now} />
          ))}
        </div>
      )}

      <h2 className="text-lg font-semibold mb-2">
        Completed <span className="text-slate-400 font-normal">({done.length}, last 30 days)</span>
      </h2>
      {done.length === 0 ? (
        <p className="text-sm text-slate-400 mb-6">Nothing finished in the last 30 days.</p>
      ) : (
        <div className="space-y-2 mb-6">
          {done.map((t) => (
            <TaskRow key={t.id} t={t} h={per.get(t.id)!} now={now} />
          ))}
        </div>
      )}

      <HowItWorks />
    </div>
  );
}

export function HowItWorks() {
  return (
    <details className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-sm">
      <summary className="font-semibold cursor-pointer">How the colours work</summary>
      <ul className="list-disc pl-5 mt-2 space-y-1 text-slate-300">
        <li>
          A colour compares the work <b>done</b> with the work <b>expected by now</b>, given each deadline - not just how much is finished. Four of ten
          items done halfway to the deadline is slightly behind (light green), not 60% missing.
        </li>
        <li>Work is counted in checklist items; a task without a checklist counts its reported progress, and a finished task counts in full.</li>
        <li>Nothing counts against anyone in the first tenth of a task&apos;s time. Small tasks get a little slack so one task can&apos;t turn red the moment it starts.</li>
        <li>Past the deadline and unfinished: light red at best, getting darker the later it gets.</li>
        <li>Finished on time stays dark green. Finished late keeps a fixed, smaller score - it never gets redder afterwards.</li>
        <li>A person&apos;s colour is the average of their tasks, bigger tasks counting more. Work finished in the last 7 days counts too.</li>
        <li>Approved extensions move the deadline, so they count automatically. Tasks with no deadline, or waiting on another task, aren&apos;t held against anyone.</li>
        <li>Only real progress changes a colour - ticking items, reporting progress, finishing. Changing a status doesn&apos;t. Colours update every minute on their own.</li>
        <li>0-20 dark red, 21-40 light red, 41-60 yellow, 61-80 light green, 81-100 dark green.</li>
      </ul>
    </details>
  );
}
