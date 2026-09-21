"use client";

// Checklist #18 / SOW #9: GANTT chart.
//   - one bar per task, from its start (or creation) to its deadline
//   - subtasks nested under their task, ending at their own deadline
//   - colour by status, red for overdue, darker fill showing % complete
//   - tasks grouped by milestone, with a ◆ marker where the milestone lands
//   - dependency links listed on the bar
//   - people allowed to move a deadline can drag the end of a bar

import { useEffect, useMemo, useRef, useState } from "react";
import { isFinished, isOverdue, statusLabel } from "@/lib/status";
import { subtaskPercent } from "@/lib/progress";
import { Person, Task, formatDue, milestoneLabel, nameOf } from "./types";

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
  const [showSubs, setShowSubs] = useState(true);
  const [drag, setDrag] = useState<{ id: string; ms: number } | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);

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

  if (dated.length === 0) return <p className="text-slate-400">No tasks with due dates to plot.</p>;

  const startOf = (t: Task) => new Date(t.start_date || t.created_at).getTime();
  const endOf = (t: Task) => (drag?.id === t.id ? drag.ms : new Date(t.due_date as string).getTime());

  const times: number[] = [Date.now()];
  dated.forEach((t) => times.push(startOf(t), endOf(t)));
  subs.forEach((s) => s.due_date && times.push(new Date(s.due_date).getTime()));
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

  // Group by milestone (no milestone last).
  const groups = new Map<string, Task[]>();
  dated
    .slice()
    .sort((a, b) => startOf(a) - startOf(b))
    .forEach((t) => {
      const key = t.milestone || "";
      groups.set(key, [...(groups.get(key) || []), t]);
    });
  const orderedKeys = Array.from(groups.keys()).sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));

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

  const Bar = ({ t }: { t: Task }) => {
    const s = startOf(t);
    const e = endOf(t);
    const left = pct(Math.min(s, e));
    const width = Math.max(pct(Math.max(s, e)) - left, 1.2);
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
                setDrag({ id: t.id, ms: e });
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
        <div className="min-w-[720px]" onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={onPointerUp}>
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
            {/* Today line across all rows */}
            <div className="absolute top-0 bottom-0 grid grid-cols-[180px_1fr] gap-2 w-full pointer-events-none">
              <div />
              <div className="relative">
                <div className="absolute top-0 bottom-0 w-px bg-red-500" style={{ left: `${pct(Date.now())}%` }} />
              </div>
            </div>

            {orderedKeys.map((key) => {
              const list = groups.get(key) || [];
              const milestoneAt = Math.max(...list.map((t) => new Date(t.due_date as string).getTime()));
              return (
                <div key={key || "none"} className="mt-3">
                  <div className="grid grid-cols-[180px_1fr] gap-2 items-center">
                    <p className="text-xs font-semibold text-slate-300 truncate">{key ? `◆ ${milestoneLabel(key)}` : "No milestone"}</p>
                    <div className="relative h-4">
                      {key && (
                        <span
                          className="absolute -translate-x-1/2 text-yellow-400 text-sm leading-4"
                          style={{ left: `${pct(milestoneAt)}%` }}
                          title={`${milestoneLabel(key)} - ${formatDue(new Date(milestoneAt).toISOString())}`}
                        >
                          ◆
                        </span>
                      )}
                    </div>
                  </div>

                  {list.map((t) => {
                    const children = showSubs ? subs.filter((s) => s.task_id === t.id) : [];
                    return (
                      <div key={t.id} className="mt-1">
                        <div className="grid grid-cols-[180px_1fr] gap-2 items-center">
                          <button onClick={() => onOpen(t.id)} className="text-left text-xs text-slate-300 truncate hover:text-white" title={t.title}>
                            {t.title}
                            <span className="block text-[10px] text-slate-500 truncate">{nameOf(people, t.assigned_to)}</span>
                          </button>
                          <Bar t={t} />
                        </div>
                        {children.map((s) => {
                          const sStart = startOf(t);
                          const sEnd = s.due_date ? new Date(s.due_date).getTime() : endOf(t);
                          const left = pct(Math.min(sStart, sEnd));
                          const width = Math.max(pct(Math.max(sStart, sEnd)) - left, 1);
                          const p = subtaskPercent(s);
                          const late = !s.done && s.due_date && new Date(s.due_date).getTime() < Date.now();
                          return (
                            <div key={s.id} className="grid grid-cols-[180px_1fr] gap-2 items-center mt-0.5">
                              <p className="text-[11px] text-slate-400 truncate pl-3" title={s.title}>↳ {s.title}</p>
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
        <span>⛓ has dependencies</span>
        <span><span className="inline-block w-px h-3 bg-red-500 mr-1 align-middle" />Today</span>
      </div>
    </div>
  );
}
