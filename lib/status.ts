// Single source of truth for task status.
//
// The spec (DOCX #6) has four states: In Process, Need Assistance, Completed
// and Closed. Two of those mean the work is finished, which is easy to get
// wrong in one place and not another - progress rollups, overdue flags and
// completion notifications all need to agree. Import from here rather than
// comparing against "done" inline.

export const STATUSES = [
  { value: "pending", label: "Pending" },
  { value: "in_progress", label: "In Process" },
  { value: "need_help", label: "Need Assistance" },
  { value: "done", label: "Completed" },
  { value: "closed", label: "Closed" },
];

export const STATUS_VALUES = STATUSES.map((s) => s.value);
export const PRIORITY_VALUES = ["super_high", "high", "medium", "low"];

/** Statuses that mean the work is finished. */
export const TERMINAL_STATUSES = ["done", "closed"];

/** True when a task needs no further work. */
export function isFinished(status: string | null | undefined): boolean {
  return TERMINAL_STATUSES.includes(status ?? "");
}

/** A task is only overdue if it has a deadline and is still unfinished. */
export function isOverdue(task: {
  due_date: string | null;
  status: string;
}): boolean {
  if (!task.due_date || isFinished(task.status)) return false;
  return new Date(task.due_date).getTime() < Date.now();
}

export function statusLabel(status: string): string {
  return STATUSES.find((s) => s.value === status)?.label ?? status;
}

export function statusClass(status: string): string {
  const map: Record<string, string> = {
    pending: "bg-slate-700 text-slate-300",
    in_progress: "bg-blue-900 text-blue-300",
    need_help: "bg-red-900 text-red-300",
    done: "bg-green-900 text-green-300",
    closed: "bg-slate-900 text-slate-400",
  };
  return map[status] || "bg-slate-700 text-slate-300";
}
