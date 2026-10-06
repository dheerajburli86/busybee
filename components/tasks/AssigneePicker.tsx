"use client";

// Step 2 of the assignment flow: before anything else, the assignor sees how
// many people they can hand work to and picks one or more of them.
//
// Picking several people creates one task each (see createTask on the
// dashboard). Each person then accepts their own deadline, is reviewed on
// their own work and carries their own reward or penalty - money has to
// attach to one person and one piece of work, never to a crowd.

import { useMemo, useState } from "react";
import { Person } from "./types";

export function AssigneePicker({
  people,
  me,
  selected,
  onChange,
  disabled,
}: {
  people: Person[];
  me: string | null;
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const [q, setQ] = useState("");

  const sorted = useMemo(
    () =>
      people
        .slice()
        .sort((a, b) => (a.id === me ? 1 : b.id === me ? -1 : String(a.name).localeCompare(String(b.name)))),
    [people, me]
  );
  const term = q.trim().toLowerCase();
  const shown = term
    ? sorted.filter((p) => `${p.name} ${p.email}`.toLowerCase().includes(term))
    : sorted;

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  const available = people.filter((p) => p.id !== me).length;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-slate-300">
          <span className="font-semibold text-white">{available}</span>{" "}
          {available === 1 ? "person" : "people"} you can assign to
          {selected.length > 0 && (
            <span className="text-blue-400"> · {selected.length} selected</span>
          )}
        </p>
        <div className="flex gap-3 text-xs">
          {selected.length > 0 && (
            <button type="button" onClick={() => onChange([])} className="text-slate-400 hover:text-white" disabled={disabled}>
              Clear
            </button>
          )}
        </div>
      </div>

      {people.length > 8 && (
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Find someone..."
          aria-label="Find someone to assign"
          className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm"
        />
      )}

      <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto" role="group" aria-label="Assignees">
        {shown.map((p) => {
          const on = selected.includes(p.id);
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => toggle(p.id)}
              disabled={disabled}
              aria-pressed={on}
              className={`px-3 py-1.5 rounded-full text-sm border disabled:opacity-50 ${
                on
                  ? "bg-blue-600 border-blue-500 text-white"
                  : "bg-slate-900 border-slate-600 text-slate-300 hover:border-slate-400"
              }`}
            >
              {on ? "✓ " : ""}
              {p.name}
              {p.id === me ? " (you)" : ""}
            </button>
          );
        })}
        {shown.length === 0 && <p className="text-xs text-slate-500">Nobody matches.</p>}
      </div>

      {selected.length > 1 && (
        <p className="text-xs text-slate-400">
          Each of the {selected.length} people gets their own copy of this task, so each accepts their own deadline
          and is reviewed on their own work.
        </p>
      )}
    </div>
  );
}
