"use client";

// Simple mode: one pass through the create form makes as many tasks as you
// like. People and project are picked once; each task below gets its own
// title, deadline, priority and subtasks. "+ Add another task" adds a row.

import { PRIORITIES } from "./types";

export type Draft = {
  key: number;
  title: string;
  description: string;
  subtasks: string;
  due: string;
  priority: string;
};

let nextKey = 1;
export function blankDraft(from?: Partial<Draft>): Draft {
  return { key: nextKey++, title: "", description: "", subtasks: "", due: "", priority: from?.priority || "medium" };
}

const inputCls = "px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm";

export function TaskDrafts({
  drafts,
  onChange,
  quick,
  disabled,
}: {
  drafts: Draft[];
  onChange: (drafts: Draft[]) => void;
  quick: { label: string; value: string }[];
  disabled?: boolean;
}) {
  const set = (key: number, patch: Partial<Draft>) =>
    onChange(drafts.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  const remove = (key: number) => onChange(drafts.filter((d) => d.key !== key));
  const add = () => onChange([...drafts, blankDraft(drafts[drafts.length - 1])]);
  const many = drafts.length > 1;

  return (
    <div className="space-y-3">
      {drafts.map((d, i) => (
        <div key={d.key} className={many ? "bg-slate-900/60 border border-slate-700 rounded p-3 space-y-2" : "space-y-2"}>
          {many && (
            <div className="flex justify-between items-center">
              <span className="text-xs font-semibold text-slate-300">Task {i + 1}</span>
              <button
                type="button"
                onClick={() => remove(d.key)}
                disabled={disabled}
                className="text-xs text-slate-400 hover:text-red-400 px-2 py-1"
                aria-label={`Remove task ${i + 1}`}
              >
                ✕ Remove
              </button>
            </div>
          )}
          <input
            type="text"
            placeholder="Task title"
            value={d.title}
            onChange={(e) => set(d.key, { title: e.target.value })}
            disabled={disabled}
            className={`${inputCls} w-full`}
            aria-label={`Task ${i + 1} title`}
          />
          <textarea
            placeholder="Description / instructions (optional)..."
            value={d.description}
            onChange={(e) => set(d.key, { description: e.target.value })}
            disabled={disabled}
            rows={2}
            className={`${inputCls} w-full resize-y`}
          />
          <textarea
            placeholder="Subtasks (optional) - one per line, they get a tick box each"
            value={d.subtasks}
            onChange={(e) => set(d.key, { subtasks: e.target.value })}
            disabled={disabled}
            rows={2}
            className={`${inputCls} w-full resize-y`}
            aria-label={`Task ${i + 1} subtasks, one per line`}
          />
          <p className="text-xs font-semibold text-slate-300 pt-1">By when?</p>
          <div className="flex flex-wrap gap-2" role="group" aria-label={`Task ${i + 1} quick deadline`}>
            {quick.map((q) => (
              <button
                key={q.label}
                type="button"
                onClick={() => set(d.key, { due: q.value })}
                disabled={disabled}
                className={`px-3 py-1.5 rounded-full text-sm border ${
                  d.due === q.value
                    ? "bg-blue-600 border-blue-500 text-white"
                    : "bg-slate-900 border-slate-600 text-slate-300 hover:border-slate-400"
                }`}
              >
                {q.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 items-end">
            <label className="flex flex-col text-xs text-slate-400 gap-1">
              Deadline (or pick a date and time)
              <input
                type="datetime-local"
                value={d.due}
                onChange={(e) => set(d.key, { due: e.target.value })}
                disabled={disabled}
                className={inputCls}
              />
            </label>
            <label className="flex flex-col text-xs text-slate-400 gap-1">
              Priority
              <select
                value={d.priority}
                onChange={(e) => set(d.key, { priority: e.target.value })}
                disabled={disabled}
                className={inputCls}
              >
                {PRIORITIES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        disabled={disabled}
        className="w-full py-2 border border-dashed border-slate-600 rounded text-sm text-blue-300 hover:border-blue-500 hover:text-blue-200 disabled:opacity-50"
      >
        + Add another task
      </button>
    </div>
  );
}
