"use client";

// The items inside one task: each line gets a tick box for the person doing
// it and an optional date of its own. Used by the Tasks form and To-Do lists.

import { useState } from "react";
import { CalendarPlus } from "lucide-react";
import { fromLocalInput } from "./types";
import { DateTimeInput } from "./DateInputs";

export type ItemRow = { key: number; title: string; due: string };

let rowKey = 1;
export const blankItem = (title = ""): ItemRow => ({ key: rowKey++, title, due: "" });
export const blankItems = (n = 3): ItemRow[] => Array.from({ length: n }, () => blankItem());

/** Filled rows, ready to send as `items` to POST /api/tasks. */
export function itemsPayload(rows: ItemRow[]) {
  return rows.filter((r) => r.title.trim()).map((r) => ({ title: r.title.trim(), due_date: fromLocalInput(r.due) }));
}

/** The latest date set on any item, if any. */
export function latestItemDate(rows: ItemRow[]): string | null {
  return (
    rows
      .filter((r) => r.title.trim())
      .map((r) => fromLocalInput(r.due))
      .filter((x): x is string => !!x)
      .sort()
      .pop() || null
  );
}

const inputCls = "px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm";

export function ItemRows({
  rows,
  onChange,
  disabled,
  placeholder = "Item",
}: {
  rows: ItemRow[];
  onChange: (rows: ItemRow[]) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const set = (key: number, patch: Partial<ItemRow>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  // An item's date box shows once asked for (or when it has a date), so the
  // list stays short on a phone.
  const [dated, setDated] = useState<Set<number>>(new Set());

  // Pasting several lines into one box makes one item per line.
  const paste = (key: number, text: string) => {
    const lines = text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    if (lines.length < 2) return false;
    const at = rows.findIndex((r) => r.key === key);
    const out = [...rows.slice(0, at), ...lines.map((l) => blankItem(l)), ...rows.slice(at + 1)];
    onChange(out.some((r) => !r.title) ? out : [...out, blankItem()]);
    return true;
  };

  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={r.key} className="flex flex-wrap gap-2 items-center">
          <span className="text-slate-500 text-sm w-5 text-right">{i + 1}.</span>
          <input
            value={r.title}
            onChange={(e) => set(r.key, { title: e.target.value })}
            onPaste={(e) => {
              if (paste(r.key, e.clipboardData.getData("text"))) e.preventDefault();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (i === rows.length - 1) onChange([...rows, blankItem()]);
              }
            }}
            placeholder={placeholder}
            className={`${inputCls} flex-1 min-w-40`}
            disabled={disabled}
            aria-label={`Item ${i + 1}`}
          />
          {r.due || dated.has(r.key) ? (
            <DateTimeInput
              value={r.due}
              onChange={(due) => set(r.key, { due })}
              className={`${inputCls} w-auto`}
              disabled={disabled}
              aria-label={`Item ${i + 1} date (optional)`}
              title="Date for this item (optional)"
              autoFocus={!r.due}
            />
          ) : (
            <button
              type="button"
              onClick={() => setDated((d) => new Set(d).add(r.key))}
              disabled={disabled}
              className="w-10 h-10 flex items-center justify-center rounded border border-slate-600 text-slate-400 hover:text-white hover:border-slate-400"
              aria-label={`Add a date to item ${i + 1}`}
              title="Add a date to this item (optional)"
            >
              <CalendarPlus size={18} aria-hidden="true" />
            </button>
          )}
          {rows.length > 1 && (
            <button
              type="button"
              onClick={() => onChange(rows.filter((x) => x.key !== r.key))}
              className="text-slate-500 hover:text-red-400 px-2"
              aria-label={`Remove item ${i + 1}`}
            >
              ✕
            </button>
          )}
        </div>
      ))}
      <button type="button" onClick={() => onChange([...rows, blankItem()])} disabled={disabled} className="text-sm text-blue-400 hover:text-blue-300 px-1">
        + Add item
      </button>
      <p className="text-xs text-slate-500">Dates on items are optional (the calendar button). Paste several lines into one box and each line becomes an item.</p>
    </div>
  );
}
