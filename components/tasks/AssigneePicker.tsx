"use client";

// Step 2 of the assignment flow: before anything else, the assignor sees how
// many people they can hand work to and picks one or more of them.
//
// Picking several people creates one task each (see createTask on the
// dashboard). Each person then accepts their own deadline, is reviewed on
// their own work and carries their own reward or penalty - money has to
// attach to one person and one piece of work, never to a crowd.

import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { Person } from "./types";

export function AssigneePicker({
  people,
  me,
  selected,
  onChange,
  disabled,
  loading,
}: {
  people: Person[];
  me: string | null;
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  /** True until the names have arrived, so an empty list doesn't read as "nobody". */
  loading?: boolean;
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
  // Names starting with what was typed come first, then any other match.
  const shown = term
    ? sorted
        .filter((p) => `${p.name} ${p.email}`.toLowerCase().includes(term))
        .sort((a, b) => Number(!String(a.name).toLowerCase().startsWith(term)) - Number(!String(b.name).toLowerCase().startsWith(term)))
    : sorted;
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name || "Someone";

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  const available = people.filter((p) => p.id !== me).length;
  const stillLoading = Boolean(loading) && people.length === 0;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-slate-300">
          {stillLoading ? (
            "Loading people..."
          ) : (
            <>
              <span className="font-semibold text-white">{available}</span>{" "}
              {available === 1 ? "person" : "people"} you can assign to
              {selected.length > 0 && (
                <span className="text-blue-400"> · {selected.length} selected</span>
              )}
            </>
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

      {/* Search: type part of a name or email; Enter picks the top match. */}
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" aria-hidden="true" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              // Never submits the form: picks the first match instead.
              e.preventDefault();
              if (term && shown[0]) {
                if (!selected.includes(shown[0].id)) onChange([...selected, shown[0].id]);
                setQ("");
              }
            } else if (e.key === "Escape") setQ("");
          }}
          placeholder={available > 0 ? `Search ${available} people by name or email...` : "Search people by name or email..."}
          aria-label="Search people to assign"
          enterKeyHint="done"
          autoComplete="off"
          disabled={disabled}
          className="w-full pl-9 pr-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm"
        />
      </div>

      {/* Who's picked, even when the search hides them. */}
      {selected.length > 0 && (term || people.length > 12) && (
        <div className="flex flex-wrap gap-1.5" aria-label="Picked">
          {selected.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => toggle(id)}
              disabled={disabled}
              className="inline-flex items-center gap-1 pl-2.5 pr-1.5 py-1 rounded-full text-xs bg-blue-600 border border-blue-500 text-white"
              aria-label={`Remove ${nameOf(id)}`}
            >
              {nameOf(id)}
              {id === me ? " (you)" : ""}
              <X size={12} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto" role="group" aria-label="Assignees">
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
        {shown.length === 0 && !stillLoading && (
          <p className="text-sm text-slate-400">{term ? `Nobody matches "${q.trim()}".` : "Nobody to assign to yet."}</p>
        )}
      </div>

      {selected.length > 1 && (
        <p className="text-xs text-slate-400">
          Each of the {selected.length} people gets their own copy with everything in it - the description, every item, the
          deadline and who else is on it - and each accepts their own deadline and is reviewed on their own work.
        </p>
      )}
    </div>
  );
}
