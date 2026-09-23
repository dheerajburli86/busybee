export type Task = {
  id: string;
  desk_id?: string;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  progress_percent: number;
  due_date: string | null;
  start_date: string | null;
  completed_at: string | null;
  assigned_to: string | null;
  milestone: string | null;
  project_id: string | null;
  stage_id?: string | null;
  archived_at: string | null;
  team_id: string | null;
  department_id: string | null;
  group_id: string | null;
  task_manager_id: string | null;
  key_result_id: string | null;
  progress_type: string | null;
  progress_target: number | null;
  progress_current: number | null;
  created_by: string | null;
  created_at: string;
  updated_at?: string | null;
  subtask_count?: number;
  /** A private item from "My To-Do" (#1). */
  personal?: boolean;
  /** "Remind me at" (#2). */
  remind_at?: string | null;
  /** On this person's own plate: theirs by name, or their unit's with nobody named. */
  for_me?: boolean;
  /** Checklist #19: an optional custom color, shown as an accent on cards and bars. Overrides nothing about status/priority logic - purely visual. */
  color?: string | null;
};

export type Section = { id: string; name: string; position: number };

export type Person = { id: string; name: string; email: string; role?: string };
export type Named = { id: string; name: string };

export type Project = Named & {
  description?: string | null;
  team_id?: string | null;
  can_manage?: boolean;
  auto_advance?: boolean;
  auto_complete?: boolean;
  sections?: Section[];
  /** Checklist #19: an optional custom color for this project's badge. */
  color?: string | null;
  /** Checklist #22: a person set as this project's manager (independent of team). */
  manager_id?: string | null;
};

export type Lookups = {
  people: Person[];
  projects: Project[];
  teams: (Named & { department_id?: string | null })[];
  departments: Named[];
  groups: Named[];
  keyResults: { id: string; title: string }[];
  me: string | null;
};

export const PRIORITIES = [
  { value: "super_high", label: "Super High" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

export const PRIORITY_RANK: Record<string, number> = { super_high: 4, high: 3, medium: 2, low: 1 };

// Checklist #19: a small fixed palette so cards, badges and bars stay
// legible in both themes rather than accepting any hex a person might type.
// "" always means "no custom color - fall back to status/priority colors".
export const COLOR_SWATCHES = [
  { value: "", label: "None" },
  { value: "#ef4444", label: "Red" },
  { value: "#f97316", label: "Orange" },
  { value: "#eab308", label: "Yellow" },
  { value: "#22c55e", label: "Green" },
  { value: "#14b8a6", label: "Teal" },
  { value: "#3b82f6", label: "Blue" },
  { value: "#8b5cf6", label: "Violet" },
  { value: "#ec4899", label: "Pink" },
  { value: "#64748b", label: "Slate" },
];

export function isValidColor(v: unknown): v is string {
  return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
}

export const MILESTONES = [
  { value: "phase1", label: "Phase 1" },
  { value: "phase2", label: "Phase 2" },
  { value: "phase3", label: "Phase 3" },
  { value: "launch", label: "Launch" },
  { value: "review", label: "Review" },
];

export function milestoneLabel(v: string | null) {
  if (!v) return null;
  return MILESTONES.find((m) => m.value === v)?.label ?? v;
}

/** datetime-local needs YYYY-MM-DDTHH:mm in the viewer's local time. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getFullYear()).padStart(4, "0")}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * A datetime-local value has no timezone. Convert it to a full ISO timestamp
 * in the viewer's zone before sending, so 18:00 IST is stored as 12:30Z and
 * not as 18:00Z.
 */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export function formatDue(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

/** Sections of a project, in order. */
export function sectionsFor(projects: Project[], projectId: string | null | undefined): Section[] {
  return (projects.find((p) => p.id === projectId)?.sections || []).slice().sort((a, b) => a.position - b.position);
}

export function nameOf(people: Person[], id: string | null | undefined, fallback = "Unassigned") {
  if (!id) return fallback;
  const p = people.find((m) => m.id === id);
  return p?.name || p?.email || "Someone";
}
