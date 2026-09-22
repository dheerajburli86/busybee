"use client";

// Checklist #30: typing "@" in a comment offers the people, teams,
// departments and groups that can be tagged, so nobody has to guess a handle.
// The handles match what the server looks for (lib: comments route).

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Lookups } from "./types";
import { handleFor } from "@/lib/mentions";

type Option = { handle: string; label: string; kind: string };

const slug = handleFor;

export function mentionOptions(lookups: Lookups): Option[] {
  const people = lookups.people.map((p) => ({
    handle: slug((p.email || "").split("@")[0]) || slug(p.name),
    label: p.name,
    kind: "person",
  }));
  const units = [
    ...lookups.teams.map((t) => ({ handle: slug(t.name), label: t.name, kind: "team" })),
    ...lookups.departments.map((d) => ({ handle: slug(d.name), label: d.name, kind: "department" })),
    ...lookups.groups.map((g) => ({ handle: slug(g.name), label: g.name, kind: "group" })),
  ];
  return [...people, ...units].filter((o) => /^[a-z0-9._-]+$/.test(o.handle));
}

export function MentionTextarea({
  value,
  onChange,
  lookups,
  placeholder,
  className,
  rows = 3,
}: {
  value: string;
  onChange: (v: string) => void;
  lookups: Lookups;
  placeholder?: string;
  className?: string;
  rows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Where the caret should go once the picked handle is in the text. Set
  // right after React writes the new value, before the next key press.
  const caret = useRef<number | null>(null);
  const [query, setQuery] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (caret.current === null || !ref.current) return;
    ref.current.focus();
    ref.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [value]);
  const [active, setActive] = useState(0);
  const all = useMemo(() => mentionOptions(lookups), [lookups]);

  const matches = query === null
    ? []
    : all.filter((o) => o.handle.includes(query.toLowerCase()) || o.label.toLowerCase().includes(query.toLowerCase())).slice(0, 8);

  const sync = (text: string, caret: number) => {
    const m = text.slice(0, caret).match(/(^|\s)@([\w.-]*)$/);
    setQuery(m ? m[2] : null);
    setActive(0);
  };

  const pick = (o: Option) => {
    const el = ref.current;
    if (!el) return;
    const at = el.selectionStart ?? value.length;
    const before = value.slice(0, at).replace(/@([\w.-]*)$/, `@${o.handle} `);
    caret.current = before.length;
    onChange(before + value.slice(at));
    setQuery(null);
  };

  return (
    <div className="relative">
      <textarea
        ref={ref}
        value={value}
        rows={rows}
        placeholder={placeholder}
        className={className}
        onChange={(e) => {
          onChange(e.target.value);
          sync(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onKeyDown={(e) => {
          if (!matches.length) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => (a + 1) % matches.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => (a - 1 + matches.length) % matches.length);
          } else if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            pick(matches[active]);
          } else if (e.key === "Escape") {
            setQuery(null);
          }
        }}
        onBlur={() => setTimeout(() => setQuery(null), 150)}
        aria-label="Comment"
      />
      {matches.length > 0 && (
        <ul className="absolute z-20 left-0 right-0 mt-1 bg-slate-900 border border-slate-600 rounded shadow-lg max-h-56 overflow-y-auto text-sm" role="listbox">
          {matches.map((o, i) => (
            <li key={`${o.kind}-${o.handle}`}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(o);
                }}
                className={`w-full text-left px-3 py-2 flex justify-between gap-2 ${i === active ? "bg-blue-600 text-white" : "hover:bg-slate-800"}`}
                role="option"
                aria-selected={i === active}
              >
                <span className="truncate">{o.label} <span className="opacity-70">@{o.handle}</span></span>
                <span className="text-xs opacity-60 shrink-0">{o.kind}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
