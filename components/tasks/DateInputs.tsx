"use client";

// Date and time boxes that take typing properly.
//
// Two things went wrong with plain <input type="datetime-local">:
//   * the year part accepts up to six digits, so typing "15112026" and then
//     the time put the time into the year (202618...) and the box never held
//     a date. A `max` with a four-digit year makes the browser move on to the
//     time after four digits.
//   * while a date is only partly typed the box reports "" - and putting ""
//     back into it cleared what was being typed. Those half-way moments are
//     ignored now.

import { useEffect, useState } from "react";
import { quickDeadlines } from "@/lib/deadlines";
import { formatDue, fromLocalInput } from "./types";

export const MAX_DATETIME = "9999-12-31T23:59";
export const MAX_DATE = "9999-12-31";

/** True while the box holds a half-typed value (not empty, not complete). */
const halfTyped = (e: React.ChangeEvent<HTMLInputElement>) => !e.target.value && e.target.validity?.badInput;

export function DateTimeInput({
  value,
  onChange,
  className,
  ...rest
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> & {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <input
      {...rest}
      type="datetime-local"
      max={rest.max ?? MAX_DATETIME}
      value={value}
      onChange={(e) => {
        if (halfTyped(e)) return;
        onChange(e.target.value);
      }}
      className={className}
    />
  );
}

/** "today", "tomorrow", "in 3 days", "3 days ago". */
function relative(iso: string): string {
  const d = new Date(iso);
  const day = (x: Date) => Math.floor(new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime() / 86400000);
  const n = day(d) - day(new Date());
  if (d.getTime() < Date.now()) return "already past";
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  return `in ${n} days`;
}

/**
 * "By when?": one-tap deadlines with a date and time box right next to them,
 * and the chosen deadline spelled out underneath. `value` is a local
 * "YYYY-MM-DDTHH:mm" (empty for none). A typed date without a time is due at
 * 6 pm, like the quick choices.
 */
export function DeadlinePicker({
  value,
  onChange,
  emptyNote,
  label = "Quick deadline",
}: {
  value: string;
  onChange: (value: string) => void;
  /** What happens with no deadline picked (shown when empty). */
  emptyNote?: string;
  label?: string;
}) {
  const quick = quickDeadlines();
  const date = value ? value.slice(0, 10) : "";
  const [time, setTime] = useState(value ? value.slice(11, 16) : "18:00");
  useEffect(() => {
    if (value) setTime(value.slice(11, 16));
  }, [value]);

  const iso = value ? fromLocalInput(value) : null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={label}>
        {quick.map((q) => (
          <button
            key={q.label}
            type="button"
            onClick={() => onChange(q.value)}
            aria-pressed={value === q.value}
            className={`px-3 py-1.5 rounded-full text-sm border ${
              value === q.value ? "bg-blue-600 border-blue-500 text-white" : "bg-slate-900 border-slate-600 text-slate-200 hover:border-slate-400"
            }`}
          >
            {q.label}
          </button>
        ))}
        {/* Date and time as one compact box: no gap between the text and its icon. */}
        <span className="tight-dt inline-flex items-center bg-slate-900 border border-slate-600 rounded text-sm">
          <input
            type="date"
            value={date}
            max={MAX_DATE}
            aria-label="Deadline date"
            title="Pick or type a date"
            onChange={(e) => {
              if (halfTyped(e)) return;
              onChange(e.target.value ? `${e.target.value}T${time || "18:00"}` : "");
            }}
            className="bg-transparent pl-2.5 pr-1 py-2 w-auto"
          />
          <input
            type="time"
            value={time}
            aria-label="Deadline time"
            title="Time on that day (6 pm unless you change it)"
            onChange={(e) => {
              if (halfTyped(e)) return;
              const t = e.target.value || "18:00";
              setTime(t);
              if (date) onChange(`${date}T${t}`);
            }}
            className="bg-transparent pl-1 pr-2.5 py-2 w-auto border-l border-slate-600"
          />
        </span>
      </div>
      <p className="text-sm" aria-live="polite">
        {iso ? (
          <>
            <span className="text-slate-400">Due </span>
            <b className="text-white">{formatDue(iso)}</b>
            <span className="text-slate-400"> ({relative(iso)})</span>
            <button type="button" onClick={() => onChange("")} className="ml-3 text-xs text-slate-400 hover:text-white underline">
              clear
            </button>
          </>
        ) : (
          <span className="text-slate-400">{emptyNote || "Pick a deadline above."}</span>
        )}
      </p>
    </div>
  );
}
