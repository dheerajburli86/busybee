"use client";

// A date-and-time box that saves once - when you leave the field or press
// Enter - rather than on every keystroke. Browsers treat each partly-typed
// edit of a datetime-local box (a new day, then a new hour...) as a complete
// value, so saving on change sent one request, one history row and one
// notification per keystroke, and could store a half-typed year.

import { useEffect, useState } from "react";
import { fromLocalInput, toLocalInput } from "./types";

export function DateTimeField({
  value,
  onCommit,
  disabled,
  className,
  ariaLabel,
  allowClear = true,
}: {
  value: string | null | undefined;
  onCommit: (iso: string | null) => void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  /** false for fields that must always hold a date (e.g. a task's deadline). */
  allowClear?: boolean;
}) {
  const saved = toLocalInput(value);
  const [draft, setDraft] = useState(saved);
  const [editing, setEditing] = useState(false);

  // Follow changes made elsewhere (a save, a rollback) while not typing here.
  useEffect(() => {
    if (!editing) setDraft(saved);
  }, [saved, editing]);

  const commit = () => {
    setEditing(false);
    if (draft === saved) return;
    if (!draft) {
      if (allowClear) onCommit(null);
      else setDraft(saved);
      return;
    }
    const iso = fromLocalInput(draft);
    const year = iso ? new Date(iso).getFullYear() : 0;
    if (!iso || year < 2000 || year > 2100) {
      setDraft(saved);
      return;
    }
    onCommit(iso);
  };

  return (
    <input
      type="datetime-local"
      value={draft}
      disabled={disabled}
      onFocus={() => setEditing(true)}
      onChange={(e) => {
        setEditing(true);
        setDraft(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
      }}
      className={className}
      aria-label={ariaLabel}
    />
  );
}
