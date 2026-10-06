"use client";

// Checklist #18 / SOW #9: GANTT chart.
//   - one bar per task, from its start (or creation) to its deadline
//   - subtasks nested under their task, ending at their own deadline
//   - colour by status, red for overdue, darker fill showing % complete
//   - tasks grouped by milestone, with a ◆ marker where the milestone lands
//   - dependencies drawn as finish-to-start arrows between the bars
//   - people allowed to move a deadline can drag the end of a bar

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { isFinished, isOverdue, statusLabel } from "@/lib/status";
import { subtaskPercent } from "@/lib/progress";
import { Milestone, Person, Task, formatDue, milestoneLabel, nameOf } from "./types";

type Sub = {
  id: string;
  task_id: string;
  title: string;
  done: boolean;
  progress_percent: number | null;
  progress_type: string | null;
  progress_target: number | null;
  progress_current: number | null;
  due_date: string | null;
  assigned_to: string | null;
};

const DAY = 86400000;
const COLORS: Record<string, string> = {
  pending: "bg-slate-500",
  in_progress: "bg-blue-600",
  need_help: "bg-amber-500",
  done: "bg-green-600",
  closed: "bg-slate-400",
};

// Row geometry, in pixels. The dependency arrows live on one overlay stretched
// across every row, so it has to know where each bar sits vertically without
// measuring anything: a measurement taken before a zoom, a scroll or a subtask
// being expanded is already stale by the time the arrow is drawn. Every row
// below is therefore pinned to one of these heights (h-4 / h-9), so these are
// the layout rather than a guess at it - change a row's class and this too.
const GROUP_GAP = 12; // mt-3 above each milestone group
const HEAD_H = 16; // the milestone header row (h-4)
const TASK_GAP = 4; // mt-1 above each task
const TASK_H = 36; // the task row (h-9), with the h-7 bar centred in it
const SUB_GAP = 2; // mt-0.5 above each subtask
const SUB_H = 16; // the subtask row (h-4)
// How far an arrow stands off a bar's edge, as a share of the chart's width.
const STUB = 1.2;

export function GanttView({
  tasks,
  people,
  canAdjust,
  onOpen,
  onMoveDeadline,
}: {
  tasks: Task[];
  people: Person[];
  canAdjust: (t: Task) => boolean;
  onOpen: (id: string) => void;
  onMoveDeadline: (id: string, iso: string) => void;
}) {
  const [subs, setSubs] = useState<Sub[]>([]);
  const [deps, setDeps] = useState<Record<string, string[]>>({});
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [showSubs, setShowSubs] = useState(true);
  const [drag, setDrag] = useState<{ id: string; ms: number } | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  // Two charts on one page must not share one <marker> id.
  const arrowId = `gantt-dep-${useId().replace(/:/g, "")}`;

  const dated = useMemo(() => tasks.filter((t) => t.due_date), [tasks]);
  const ids = dated.map((t) => t.id).join(",");

  useEffect(() => {
    if (!ids) {
      setSubs([]);
      setDeps({});
      return;
    }
    // One request for every visible task's subtasks and dependencies.
    fetch("/api/subtasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_ids: ids.split(",") }),
    })
      .then((r) => (r.ok ? r.json() : { subtasks: [], dependencies: [] }))
      .then((d) => {
        setSubs(Array.isArray(d?.subtasks) ? d.subtasks : []);
        const map: Record<string, string[]> = {};
        (Array.isArray(d?.dependencies) ? d.dependencies : []).forEach((x: any) => {
          map[x.task_id] = [...(map[x.task_id] || []), x.depends_on_task_id];
        });
        setDeps(map);
      })
      .catch(() => {
        setSubs([]);
        setDeps({});
      });
  }, [ids]);

  /**
   * SOW #17: the real milestones, each with a date of its own, so a ◆ can sit
   * where the milestone actually lands instead of where its last task happens
   * to end. Entirely optional: on a database that hasn't had the milestones
   * migration run this request fails, and the chart carries on inferring the
   * markers from the legacy free-text tasks.milestone column, as it always did.
   */
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await fetch("/api/milestones", { cache: "no-store" });
        if (!r.ok) return;
        const d = await r.json();
        if (live && Array.isArray(d?.milestones)) setMilestones(d.milestones);
      } catch {
        /* milestones are optional */
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  if (dated.length === 0) return <p className="text-slate-400">No tasks with due dates to plot.</p>;

  const startOf = (t: Task) => new Date(t.start_date || t.created_at).getTime();
  const endOf = (t: Task) => (drag?.id === t.id ? drag.ms : new Date(t.due_date as string).getTime());

  const realById = new Map(milestones.map((m) => [m.id, m]));

  // Group by milestone (no milestone last). A task pinned to a real milestone
  // is grouped by that one; anything else - an older task, or every task when
  // the milestones request failed - falls back to the legacy text column.
  type Group = { key: string; label: string; real: Milestone | null; sort: string; at: number; tasks: Task[] };
  const groups = new Map<string, Group>();
  dated
    .slice()
    .sort((a, b) => startOf(a) - startOf(b))
    .forEach((t) => {
      const real = (t.milestone_id && realById.get(t.milestone_id)) || null;
      const key = real ? `id:${real.id}` : t.milestone ? `name:${t.milestone}` : "";
      const g = groups.get(key) || {
        key,
        label: (real ? real.name : milestoneLabel(t.milestone)) || "",
        real,
        sort: (real ? real.name : t.milestone) || "",
        at: NaN,
        tasks: [] as Task[],
      };
      g.tasks.push(t);
      groups.set(key, g);
    });
  const ordered = Array.from(groups.values()).sort((a, b) =>
    a.key === "" ? 1 : b.key === "" ? -1 : a.sort.localeCompare(b.sort)
  );

  // Where the ◆ goes: the milestone's own deadline when it has one, and
  // otherwise the last deadline among its tasks - all the legacy column knows.
  ordered.forEach((g) => {
    const own = g.real?.due_date ? new Date(g.real.due_date).getTime() : NaN;
    const inferred = Math.max(...g.tasks.map((t) => new Date(t.due_date as string).getTime()));
    g.at = Number.isFinite(own) ? own : inferred;
  });

  const times: number[] = [Date.now()];
  dated.forEach((t) => times.push(startOf(t), endOf(t)));
  subs.forEach((s) => s.due_date && times.push(new Date(s.due_date).getTime()));
  // A real milestone can fall outside its tasks' dates - keep it on the chart.
  ordered.forEach((g) => {
    if (Number.isFinite(g.at)) times.push(g.at);
  });
  const min = Math.min(...times) - DAY;
  const max = Math.max(...times) + DAY;
  const span = Math.max(max - min, DAY);
  const pct = (ms: number) => ((ms - min) / span) * 100;

  // Week ticks.
  const ticks: number[] = [];
  const first = new Date(min);
  first.setHours(0, 0, 0, 0);
  const step = span > 120 * DAY ? 30 * DAY : span > 30 * DAY ? 7 * DAY : DAY * Math.max(1, Math.round(span / DAY / 10));
  for (let t = first.getTime(); t <= max; t += step) ticks.push(t);

  // The middle of every task bar, in pixels down from the top of the rows
  // block, walked in the order the rows are rendered: expanding a task's
  // subtasks pushes everything below it down by exactly as much here as on
  // screen, so the arrows follow.
  const midY = new Map<string, number>();
  let y = 0;
  ordered.forEach((g, gi) => {
    // The first group's mt-3 collapses into the rows block, so it adds nothing.
    if (gi > 0) y += GROUP_GAP;
    y += HEAD_H;
    g.tasks.forEach((t) => {
      y += TASK_GAP;
      midY.set(t.id, y + TASK_H / 2);
      y += TASK_H;
      if (showSubs) y += subs.filter((s) => s.task_id === t.id).length * (SUB_GAP + SUB_H);
    });
  });

  // The bars' own geometry, shared with the arrows so the two cannot drift.
  const barGeom = (t: Task) => {
    const s = startOf(t);
    const e = endOf(t);
    const left = pct(Math.min(s, e));
    const width = Math.max(pct(Math.max(s, e)) - left, 1.2);
    return { left, width, right: left + width, end: e };
  };

  // One finish-to-start elbow per dependency: out of the right edge of the task
  // being waited on, across, and into the left edge of the one that waits. A
  // dependency on a task that isn't on the chart (filtered out, or with no
  // deadline to plot) is left undrawn rather than drawn wrong.
  const rendered = new Map(dated.map((t) => [t.id, t]));
  const links: { key: string; pts: { x: number; y: number }[] }[] = [];
  const drawn = new Set<string>();
  Object.keys(deps).forEach((to) => {
    const target = rendered.get(to);
    const yTo = midY.get(to);
    if (!target || yTo === undefined) return;
    (deps[to] || []).forEach((from) => {
      const source = rendered.get(from);
      const yFrom = midY.get(from);
      const key = `${from}>${to}`;
      if (!source || yFrom === undefined || from === to || drawn.has(key)) return;
      drawn.add(key);
      const xFrom = barGeom(source).right;
      const xTo = barGeom(target).left;
      const mid = (yFrom + yTo) / 2;
      links.push({
        key,
        pts:
          xTo - xFrom >= 2 * STUB
            ? // Room to drop straight down just before the waiting bar.
              [
                { x: xFrom, y: yFrom },
                { x: xTo - STUB, y: yFrom },
                { x: xTo - STUB, y: yTo },
                { x: xTo, y: yTo },
              ]
            : // The waiting task starts before the other one ends: step out to
              // the right, back along the gap between the rows, and in again.
              [
                { x: xFrom, y: yFrom },
                { x: xFrom + STUB, y: yFrom },
                { x: xFrom + STUB, y: mid },
                { x: xTo - STUB, y: mid },
                { x: xTo - STUB, y: yTo },
                { x: xTo, y: yTo },
              ],
      });
    });
  });

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag || !trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
    const ms = min + (x / rect.width) * span;
    // Snap to the nearest 30 minutes.
    setDrag({ id: drag.id, ms: Math.round(ms / (30 * 60000)) * 30 * 60000 });
  };
  const onPointerUp = () => {
    if (!drag) return;
    const t = dated.find((x) => x.id === drag.id);
    if (t && Math.abs(drag.ms - new Date(t.due_date as string).getTime()) > 60000) {
      onMoveDeadline(drag.id, new Date(drag.ms).toISOString());
    }
    setDrag(null);
  };

  // A plain function, not a component: a component defined inside render is a
  // new type on every render, so each pointer move during a drag would
  // re-create every bar and drop the handle's pointer capture.
  const renderBar = (t: Task) => {
    const { left, width, end } = barGeom(t);
    const late = isOverdue(t);
    const color = late ? "bg-red-600" : COLORS[t.status] || "bg-slate-500";
    const adjustable = canAdjust(t) && !isFinished(t.status);
    const waits = (deps[t.id] || []).map((id) => tasks.find((x) => x.id === id)?.title).filter(Boolean);
    return (
      <div className="relative h-7">
        <div
          className={`absolute h-7 rounded ${color} bg-opacity-40 cursor-pointer ring-1 ring-inset ${late ? "ring-red-400" : "ring-white/10"}`}
          style={{ left: `${left}%`, width: `${width}%` }}
          onClick={() => onOpen(t.id)}
          title={`${t.title}\n${statusLabel(t.status)} · ${t.progress_percent}% · due ${formatDue(drag?.id === t.id ? new Date(drag.ms).toISOString() : t.due_date)}${waits.length ? `\nWaits on: ${waits.join(", ")}` : ""}`}
        >
          <div className={`h-full rounded ${color}`} style={{ width: `${Math.min(100, t.progress_percent || 0)}%` }} />
          <span className="absolute inset-0 flex items-center px-2 text-[11px] text-white font-medium whitespace-nowrap overflow-hidden">
            {t.progress_percent}%{waits.length ? " ⛓" : ""}
          </span>
          {adjustable && (
            <span
              onPointerDown={(ev) => {
                ev.stopPropagation();
                (ev.target as HTMLElement).setPointerCapture(ev.pointerId);
                setDrag({ id: t.id, ms: end });
              }}
              onClick={(ev) => ev.stopPropagation()}
              className="absolute right-0 top-0 h-full w-3 cursor-ew-resize bg-white/30 rounded-r touch-none"
              title="Drag to move the deadline"
            />
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="bg-slate-800 border border-slate-700 rounded p-3 sm:p-4">
      <div className="flex flex-wrap gap-3 items-center justify-between mb-3 text-xs text-slate-400">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={showSubs} onChange={() => setShowSubs(!showSubs)} /> Show subtasks
        </label>
        <span>Drag the end of a bar to move a deadline (if you're allowed to).</span>
      </div>

      <div className="overflow-x-auto">
        <div
          className="min-w-[720px]"
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          onPointerCancel={() => setDrag(null)}
        >
          {/* Axis */}
          <div className="grid grid-cols-[180px_1fr] gap-2">
            <div />
            <div className="relative h-5 border-b border-slate-700" ref={trackRef}>
              {ticks.map((t) => (
                <span key={t} className="absolute text-[10px] text-slate-500 -translate-x-1/2" style={{ left: `${pct(t)}%` }}>
                  {new Date(t).toLocaleDateString([], { day: "numeric", month: "short" })}
                </span>
              ))}
            </div>
          </div>

          <div className="relative">
            {/* Dependency arrows and the today line, across all rows. Both sit
                under the bars and take no pointer events, so nothing here can
                swallow a bar's click or its tooltip. */}
            <div className="absolute top-0 bottom-0 grid grid-cols-[180px_1fr] gap-2 w-full pointer-events-none">
              <div />
              <div className="relative">
                <svg className="absolute inset-0 w-full h-full overflow-visible pointer-events-none" aria-hidden="true">
                  <defs>
                    <marker
                      id={arrowId}
                      viewBox="0 0 7 7"
                      refX="6.5"
                      refY="3.5"
                      markerWidth="7"
                      markerHeight="7"
                      markerUnits="userSpaceOnUse"
                      orient="auto"
                    >
                      <path d="M0 0.5 L7 3.5 L0 6.5 Z" className="fill-slate-500" />
                    </marker>
                  </defs>
                  <g className="stroke-slate-500" strokeWidth={1.25} fill="none">
                    {links.map((l) =>
                      l.pts.slice(1).map((p, i) => (
                        <line
                          key={`${l.key}-${i}`}
                          x1={`${l.pts[i].x}%`}
                          y1={l.pts[i].y}
                          x2={`${p.x}%`}
                          y2={p.y}
                          markerEnd={i === l.pts.length - 2 ? `url(#${arrowId})` : undefined}
                        />
                      ))
                    )}
                  </g>
                </svg>
                <div className="absolute top-0 bottom-0 w-px bg-red-500" style={{ left: `${pct(Date.now())}%` }} />
              </div>
            </div>

            {ordered.map((g) => {
              // The date has been and gone, but the work under it hasn't.
              const slipped = Number.isFinite(g.at) && g.at < Date.now() && g.tasks.some((t) => !isFinished(t.status));
              const open = g.tasks.filter((t) => !isFinished(t.status)).length;
              return (
                <div key={g.key || "none"} className="mt-3">
                  <div className="grid grid-cols-[180px_1fr] gap-2 items-center h-4">
                    <p
                      className="text-xs font-semibold text-slate-300 truncate"
                      title={g.key ? `${g.label}${g.real?.project_name ? ` · ${g.real.project_name}` : ""}` : "No milestone"}
                    >
                      {g.key ? `◆ ${g.label}` : "No milestone"}
                    </p>
                    <div className="relative h-4">
                      {g.key && Number.isFinite(g.at) && (
                        <span
                          className={`absolute -translate-x-1/2 text-sm leading-4 ${slipped ? "text-amber-400" : "text-yellow-400"}`}
                          style={{ left: `${pct(g.at)}%` }}
                          title={`${g.label} - ${formatDue(new Date(g.at).toISOString())}${
                            g.real?.due_date ? "" : " (from its tasks' deadlines)"
                          }${slipped ? ` · date passed, ${open} task${open === 1 ? "" : "s"} still open` : ""}`}
                        >
                          ◆
                        </span>
                      )}
                    </div>
                  </div>

                  {g.tasks.map((t) => {
                    const children = showSubs ? subs.filter((s) => s.task_id === t.id) : [];
                    return (
                      <div key={t.id} className="mt-1">
                        {/* h-9 so the arrow overlay knows this row's height without
                            measuring it - it is what the row already comes to. */}
                        <div className="grid grid-cols-[180px_1fr] gap-2 items-center h-9">
                          <button onClick={() => onOpen(t.id)} className="text-left text-xs text-slate-300 truncate hover:text-white" title={t.title}>
                            {t.title}
                            <span className="block text-[10px] text-slate-500 truncate">{nameOf(people, t.assigned_to)}</span>
                          </button>
                          {renderBar(t)}
                        </div>
                        {children.map((s) => {
                          const sStart = startOf(t);
                          const sEnd = s.due_date ? new Date(s.due_date).getTime() : endOf(t);
                          const left = pct(Math.min(sStart, sEnd));
                          const width = Math.max(pct(Math.max(sStart, sEnd)) - left, 1);
                          const p = subtaskPercent(s);
                          const late = !s.done && s.due_date && new Date(s.due_date).getTime() < Date.now();
                          return (
                            <div key={s.id} className="grid grid-cols-[180px_1fr] gap-2 items-center mt-0.5 h-4">
                              <p className="text-[11px] leading-4 text-slate-400 truncate pl-3" title={s.title}>↳ {s.title}</p>
                              <div className="relative h-3.5">
                                <div
                                  className={`absolute h-3.5 rounded ${late ? "bg-red-600" : s.done ? "bg-green-600" : "bg-sky-500"} bg-opacity-30`}
                                  style={{ left: `${left}%`, width: `${width}%` }}
                                  title={`${s.title} · ${p}%${s.due_date ? ` · due ${formatDue(s.due_date)}` : ""}`}
                                >
                                  <div className={`h-full rounded ${late ? "bg-red-600" : s.done ? "bg-green-600" : "bg-sky-500"}`} style={{ width: `${p}%` }} />
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-4 mt-4 pt-3 border-t border-slate-700 text-xs text-slate-400">
        {[
          ["bg-slate-500", "Pending"],
          ["bg-blue-600", "In Process"],
          ["bg-amber-500", "Need Assistance"],
          ["bg-green-600", "Completed"],
          ["bg-slate-400", "Closed"],
          ["bg-red-600", "Overdue"],
        ].map(([c, l]) => (
          <span key={l}><span className={`inline-block w-3 h-3 rounded mr-1 align-middle ${c}`} />{l}</span>
        ))}
        <span><span className="text-yellow-400 mr-1">◆</span>Milestone</span>
        <span><span className="text-amber-400 mr-1">◆</span>Milestone date passed</span>
        <span>⛓ has dependencies</span>
        <span><span className="text-slate-500 mr-1">→</span>Waits for</span>
        <span><span className="inline-block w-px h-3 bg-red-500 mr-1 align-middle" />Today</span>
      </div>
    </div>
  );
}
