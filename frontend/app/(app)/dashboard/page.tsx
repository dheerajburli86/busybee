"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { STATUSES, isFinished, isOverdue, statusClass, statusLabel } from "@/lib/status";
import { sendJSON } from "@/lib/api";
import { OPEN_TASK_EVENT } from "@/components/NotificationBell";
import { TaskDetail } from "@/components/tasks/TaskDetail";
import { GanttView } from "@/components/tasks/GanttView";
import {
  COLOR_SWATCHES,
  Lookups,
  PRIORITIES,
  PRIORITY_RANK,
  Task,
  formatDue,
  fromLocalInput,
  milestoneLabel,
  nameOf,
  sectionsFor,
} from "@/components/tasks/types";

const SORT_OPTIONS = [
  { value: "created_at", label: "Newest first" },
  { value: "due_date", label: "Due date" },
  { value: "priority", label: "Priority" },
  { value: "progress", label: "Progress (most done first)" },
  { value: "progress_asc", label: "Progress (least done first)" },
  { value: "completed_at", label: "Date of completion" },
];

// Board column for cards whose value has no column of its own (an old
// status, a deleted section or project, someone no longer on the desk).
const OTHER_COLUMN = "__other";

const BOARD_GROUPS = [
  { value: "status", label: "Status" },
  { value: "section", label: "Section" },
  { value: "priority", label: "Priority" },
  { value: "assignee", label: "Assignee" },
  { value: "project", label: "Project" },
];

// Which task field a board column stands for.
const BOARD_FIELD: Record<string, string> = {
  status: "status",
  section: "stage_id",
  priority: "priority",
  assignee: "assigned_to",
  project: "project_id",
};

type View = "list" | "board" | "gantt";

const emptyLookups: Lookups = { people: [], projects: [], keyResults: [], me: null };

export default function DashboardPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [archivedTasks, setArchivedTasks] = useState<Task[]>([]);
  const [lookups, setLookups] = useState<Lookups>(emptyLookups);
  const [myRole, setMyRole] = useState("member");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([]);

  // View, filters and sorting (checklist #13 - #17).
  const [view, setView] = useState<View>("list");
  const [boardBy, setBoardBy] = useState("status");
  const [search, setSearch] = useState("");
  const [statusF, setStatusF] = useState("");
  const [priorityF, setPriorityF] = useState("");
  const [assigneeF, setAssigneeF] = useState("");
  const [projectF, setProjectF] = useState<string>("");
  const [mine, setMine] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [sortBy, setSortBy] = useState("created_at");
  const [showFilters, setShowFilters] = useState(false);
  const [dragged, setDragged] = useState<string | null>(null);

  // Create form.
  const [form, setForm] = useState({
    title: "",
    description: "",
    start: "",
    due: "",
    priority: "medium",
    project: "",
    section: "",
    assignee: "",
    color: "",
  });
  const [creating, setCreating] = useState(false);
  const [showMore, setShowMore] = useState(false);

  const showError = useCallback((m: string) => {
    setInfo("");
    setError(m);
  }, []);
  const showInfo = useCallback((m: string) => {
    setError("");
    setInfo(m);
    setTimeout(() => setInfo((cur) => (cur === m ? "" : cur)), 4000);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("project")) setProjectF(params.get("project") as string);
    if (params.get("task")) setOpenId(params.get("task"));
    if (params.get("assignee")) {
      setAssigneeF(params.get("assignee") as string);
      setShowFilters(true);
    }

    (async () => {
      try {
        const get = async (u: string) => {
          const r = await fetch(u, { cache: "no-store" });
          return r.ok ? r.json() : null;
        };
        const [t, m, p, okr, tpl] = await Promise.all([
          fetch("/api/tasks", { cache: "no-store" }),
          get("/api/team/members"),
          get("/api/projects"),
          get("/api/okr"),
          get("/api/templates"),
        ]);
        const td = await t.json();
        if (!t.ok) throw new Error(td.error || "Could not load tasks");
        setTasks(td.tasks || []);
        // A link to an archived task (?task=...) still opens it.
        const wanted = params.get("task");
        if (wanted && !(td.tasks || []).some((x: Task) => x.id === wanted)) {
          const all = await get("/api/tasks?archived=only");
          const found = (all?.tasks || []).find((x: Task) => x.id === wanted);
          if (found) {
            setArchivedTasks([found]);
          } else {
            // Round-1 audit fix: a notification link (e.g. a private comment
            // or @mention) can point at a task this person can't open - the
            // page used to silently do nothing on first load in that case,
            // while the same situation reached via the in-page "open task"
            // event already showed a message. Make both paths consistent.
            setOpenId(null);
            showError("That task is no longer available to you.");
          }
        }
        setLookups({
          people: m?.members || [],
          me: m?.me || null,
          projects: p?.projects || [],
          keyResults: okr?.keyResults || [],
        });
        setMyRole(m?.myRole || "member");
        setTemplates(tpl?.templates || []);
      } catch (e: any) {
        showError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [showError]);

  // Archive view (checklist #12): archived tasks come from their own query.
  useEffect(() => {
    if (!showArchived) return;
    fetch("/api/tasks?archived=only", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setArchivedTasks(d.tasks || []))
      .catch(() => showError("Could not load the archive"));
  }, [showArchived, showError]);

  const refreshProjects = useCallback(async () => {
    const r = await fetch("/api/projects", { cache: "no-store" });
    if (r.ok) {
      const d = await r.json();
      setLookups((l) => ({ ...l, projects: d.projects || [] }));
    }
  }, []);

  const replaceTask = useCallback((t: Partial<Task> & { id: string }) => {
    const apply = (list: Task[]) => list.map((x) => (x.id === t.id ? { ...x, ...t } : x));
    setTasks(apply);
    setArchivedTasks(apply);
  }, []);

  const patchTask = useCallback(
    async (id: string, patch: Partial<Task>): Promise<boolean> => {
      const before = [...tasks, ...archivedTasks].find((t) => t.id === id);
      replaceTask({ id, ...patch });
      try {
        const data = await sendJSON("/api/tasks", "PUT", { id, ...patch });
        const updated: Task = data.task;
        // Moving in or out of the archive moves between the two lists.
        if ("archived_at" in patch) {
          if (updated.archived_at) {
            setTasks((prev) => prev.filter((x) => x.id !== id));
            setArchivedTasks((prev) => [updated, ...prev.filter((x) => x.id !== id)]);
          } else {
            setArchivedTasks((prev) => prev.filter((x) => x.id !== id));
            setTasks((prev) => [updated, ...prev.filter((x) => x.id !== id)]);
          }
        } else {
          replaceTask(updated);
        }
        return true;
      } catch (e: any) {
        if (before) replaceTask(before);
        showError(e.message);
        return false;
      }
    },
    [tasks, archivedTasks, replaceTask, showError]
  );

  const createTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    const due = fromLocalInput(form.due);
    if (!due) return showError("A due date and time is required before a task can be created.");
    setCreating(true);
    try {
      const data = await sendJSON("/api/tasks", "POST", {
        title: form.title.trim(),
        description: form.description.trim() || null,
        priority: form.priority,
        due_date: due,
        start_date: fromLocalInput(form.start),
        project_id: form.project || projectF || null,
        stage_id: form.section || null,
        assigned_to: form.assignee || null,
        color: form.color || null,
      });
      setTasks((prev) => [data.task, ...prev]);
      setForm({ ...form, title: "", description: "", start: "", due: "", assignee: "", color: "" });
      // A new task may have created a project's first section; refresh the lookups quietly.
      if (!sectionsFor(lookups.projects, data.task.project_id).some((x) => x.id === data.task.stage_id)) refreshProjects();
      showInfo("Task created.");
    } catch (err: any) {
      showError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const applyTemplate = async (templateId: string) => {
    try {
      const body = await sendJSON("/api/templates", "PUT", {
        template_id: templateId,
        project_id: form.project || projectF || null,
        stage_id: form.section || null,
      });
      setTasks((prev) => [body.task, ...prev]);
      setOpenId(body.task.id);
    } catch (err: any) {
      showError(err.message);
    }
  };

  const source = showArchived ? archivedTasks : tasks;
  const q = search.toLowerCase().trim();

  const filtered = useMemo(() => {
    return source
      .filter((t) => {
        if (!q) return true;
        const assignee = lookups.people.find((m) => m.id === t.assigned_to);
        return [t.title, t.description, milestoneLabel(t.milestone), assignee?.name, assignee?.email]
          .some((s) => (s || "").toLowerCase().includes(q));
      })
      .filter((t) => (mine ? t.for_me || t.assigned_to === lookups.me : true))
      .filter((t) => (projectF ? t.project_id === projectF : true))
      .filter((t) => (statusF ? (statusF === "overdue" ? isOverdue(t) : t.status === statusF) : true))
      .filter((t) => (priorityF ? t.priority === priorityF : true))
      .filter((t) => (assigneeF ? (assigneeF === "none" ? !t.assigned_to : t.assigned_to === assigneeF) : true))
      .sort((a, b) => {
        if (sortBy === "due_date") {
          if (!a.due_date && !b.due_date) return 0;
          if (!a.due_date) return 1;
          if (!b.due_date) return -1;
          return a.due_date.localeCompare(b.due_date);
        }
        if (sortBy === "priority") return (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0);
        if (sortBy === "progress") return (b.progress_percent || 0) - (a.progress_percent || 0);
        if (sortBy === "progress_asc") return (a.progress_percent || 0) - (b.progress_percent || 0);
        if (sortBy === "completed_at") {
          // Finished work first, most recently finished at the top.
          if (!a.completed_at && !b.completed_at) return 0;
          if (!a.completed_at) return 1;
          if (!b.completed_at) return -1;
          return b.completed_at.localeCompare(a.completed_at);
        }
        return b.created_at.localeCompare(a.created_at);
      });
  }, [source, q, mine, projectF, statusF, priorityF, assigneeF, sortBy, lookups]);

  const activeFilters = [statusF, priorityF, assigneeF, projectF, mine ? "mine" : ""].filter(Boolean).length;

  // Board columns for the chosen arrangement (checklist #16 / #17, SOW #26).
  const projectSections = sectionsFor(lookups.projects, projectF);
  const columns = useMemo(() => {
    if (boardBy === "section") return projectSections.map((sec) => ({ key: sec.id, label: sec.name }));
    if (boardBy === "priority") return PRIORITIES.map((p) => ({ key: p.value, label: p.label }));
    if (boardBy === "assignee")
      return [{ key: "", label: "Unassigned" }, ...lookups.people.map((p) => ({ key: p.id, label: p.name }))];
    if (boardBy === "project")
      return [{ key: "", label: "No project" }, ...lookups.projects.map((p) => ({ key: p.id, label: p.name }))];
    return STATUSES.map((s) => ({ key: s.value, label: s.label }));
  }, [boardBy, lookups, projectSections]);

  const columnOf = (t: Task) =>
    boardBy === "section"
      ? t.stage_id || ""
      : boardBy === "priority"
      ? t.priority
      : boardBy === "assignee"
      ? t.assigned_to || ""
      : boardBy === "project"
      ? t.project_id || ""
      : t.status || "pending";

  const knownColumns = new Set(columns.map((c) => c.key));
  const boardColumns = filtered.some((t) => !knownColumns.has(columnOf(t)))
    ? [...columns, { key: OTHER_COLUMN, label: "Other" }]
    : columns;
  const inColumn = (t: Task, key: string) =>
    key === OTHER_COLUMN ? !knownColumns.has(columnOf(t)) : columnOf(t) === key;

  const moveTo = (id: string, key: string) => {
    const field = BOARD_FIELD[boardBy] || "status";
    const task = [...tasks, ...archivedTasks].find((x) => x.id === id);
    if (!task || columnOf(task) === key) return;
    patchTask(id, { [field]: key || null } as Partial<Task>);
  };

  const dropOn = (key: string) => {
    if (!dragged) return;
    if (key === OTHER_COLUMN) {
      setDragged(null);
      return;
    }
    moveTo(dragged, key);
    setDragged(null);
  };

  const sectionName = (t: Task) => {
    const list = sectionsFor(lookups.projects, t.project_id);
    return list.length > 1 ? list.find((x) => x.id === t.stage_id)?.name : null;
  };

  const isSuperRole = ["admin", "supervisor"].includes(myRole);
  const canAdjust = (t: Task) =>
    isSuperRole || t.created_by === lookups.me || t.task_manager_id === lookups.me;

  const openTask = [...tasks, ...archivedTasks].find((t) => t.id === openId);

  // A notification may point at a task that isn't loaded (e.g. archived).
  const openFromNotification = async (id: string) => {
    if (![...tasks, ...archivedTasks].some((t) => t.id === id)) {
      const r = await fetch("/api/tasks?archived=all", { cache: "no-store" });
      if (r.ok) {
        const d = await r.json();
        const found = (d.tasks || []).find((t: Task) => t.id === id);
        if (!found) return showError("That task is no longer available to you.");
        if (found.archived_at) setArchivedTasks((p) => [found, ...p.filter((x) => x.id !== id)]);
        else setTasks((p) => [found, ...p.filter((x) => x.id !== id)]);
      }
    }
    setOpenId(id);
  };

  // The bell in the navigation bar asks this page to open a task.
  useEffect(() => {
    const handler = (e: Event) => openFromNotification((e as CustomEvent<string>).detail);
    window.addEventListener(OPEN_TASK_EVENT, handler);
    return () => window.removeEventListener(OPEN_TASK_EVENT, handler);
  });

  const inputCls = "px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm";
  const pill = (on: boolean) =>
    `px-3 py-2 rounded text-sm ${on ? "bg-blue-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`;
  const currentProject = lookups.projects.find((p) => p.id === projectF) as any;

  return (
    <div className="max-w-7xl mx-auto p-3 sm:p-6">
      <div className="flex justify-between items-center gap-3 mb-4">
        <h1 className="text-2xl sm:text-3xl font-bold">Tasks</h1>
      </div>

      {currentProject && (
        <div className="mb-4 bg-slate-800 border border-slate-700 rounded p-4 flex justify-between gap-4">
          <div>
            <p className="text-blue-400 font-semibold">{currentProject.name}</p>
            {currentProject.description && <p className="text-slate-400 text-sm mt-1">{currentProject.description}</p>}
          </div>
          <button onClick={() => setProjectF("")} className="text-sm text-slate-400 hover:text-white whitespace-nowrap">Show all</button>
        </div>
      )}

      {error && (
        <div className="bg-red-950 border border-red-800 text-red-300 px-4 py-3 rounded mb-4 text-sm flex justify-between gap-3" role="alert">
          <span>{error}</span>
          <button onClick={() => setError("")} className="text-red-400 shrink-0">dismiss</button>
        </div>
      )}
      {/* A floating note, so the page doesn't jump when it appears and goes. */}
      {info && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] bg-green-950 border border-green-800 text-green-200 px-4 py-3 rounded shadow-lg text-sm max-w-[calc(100vw-2rem)]" role="status">
          {info}
        </div>
      )}

      {/* Create */}
      <form onSubmit={createTask} className="bg-slate-800 p-3 sm:p-4 rounded border border-slate-700 mb-6 space-y-3">
        <input
          type="text"
          placeholder="Task title..."
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          disabled={creating}
          className={`${inputCls} w-full`}
        />
        <textarea
          placeholder="Description / instructions (optional)..."
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          disabled={creating}
          rows={2}
          className={`${inputCls} w-full resize-y`}
        />
        <div className="flex flex-wrap gap-2 items-end">
          <label className="flex flex-col text-xs text-slate-400 gap-1">
            Due (required)
            <input type="datetime-local" value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} required className={inputCls} />
          </label>
          <label className="flex flex-col text-xs text-slate-400 gap-1">
            Priority
            <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} className={inputCls}>
              {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col text-xs text-slate-400 gap-1">
            Assign to
            <select value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })} className={inputCls}>
              <option value="">Nobody yet</option>
              {lookups.people.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          <button type="button" onClick={() => setShowMore(!showMore)} className="text-sm text-blue-400 px-2 py-2">
            {showMore ? "Fewer options" : "More options"}
          </button>
          <button type="submit" disabled={creating || !form.title.trim()} className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-4 py-2 rounded ml-auto">
            {creating ? "Creating..." : "Add Task"}
          </button>
        </div>
        {showMore && (
          <div className="flex flex-wrap gap-2 items-end">
            <label className="flex flex-col text-xs text-slate-400 gap-1">
              Start
              <input type="datetime-local" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} className={inputCls} />
            </label>
            <label className="flex flex-col text-xs text-slate-400 gap-1">
              Project
              <select value={form.project} onChange={(e) => setForm({ ...form, project: e.target.value, section: "" })} className={inputCls}>
                <option value="">{currentProject ? currentProject.name : "Default project"}</option>
                {lookups.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            {sectionsFor(lookups.projects, form.project || projectF).length > 0 && (
              <label className="flex flex-col text-xs text-slate-400 gap-1">
                Section
                <select value={form.section} onChange={(e) => setForm({ ...form, section: e.target.value })} className={inputCls} aria-label="Section">
                  {sectionsFor(lookups.projects, form.project || projectF).map((sec, i) => (
                    <option key={sec.id} value={i === 0 ? "" : sec.id}>{sec.name}</option>
                  ))}
                </select>
              </label>
            )}
            {templates.length > 0 && (
              <label className="flex flex-col text-xs text-slate-400 gap-1">
                Or start from a template
                <select value="" onChange={(e) => e.target.value && applyTemplate(e.target.value)} className={inputCls}>
                  <option value="">Choose...</option>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
            )}
            <div className="flex flex-col text-xs text-slate-400 gap-1">
              Color
              <div className="flex gap-1 items-center">
                {COLOR_SWATCHES.map((c) => (
                  <button
                    key={c.value || "none"}
                    type="button"
                    title={c.label}
                    aria-label={`Color: ${c.label}`}
                    onClick={() => setForm({ ...form, color: c.value })}
                    className={`w-6 h-6 rounded-full border-2 ${form.color === c.value ? "border-white" : "border-slate-700"} ${c.value ? "" : "bg-slate-700 flex items-center justify-center text-[10px]"}`}
                    style={c.value ? { backgroundColor: c.value } : undefined}
                  >
                    {!c.value && "✕"}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </form>

      {/* Search, views, filters, sort */}
      <div className="flex flex-wrap gap-2 mb-3">
        <input
          type="search"
          placeholder="Filter these tasks..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-48 px-3 py-2 bg-slate-800 border border-slate-700 rounded text-sm"
        />
        <div className="flex gap-1">
          <button onClick={() => setView("list")} className={pill(view === "list")}>List</button>
          <button onClick={() => setView("board")} className={pill(view === "board")}>Board</button>
          <button onClick={() => setView("gantt")} className={pill(view === "gantt")}>Gantt</button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 mb-4 items-center">
        <button onClick={() => setMine(!mine)} className={pill(mine)}>My tasks</button>
        <button onClick={() => setShowArchived(!showArchived)} className={pill(showArchived)}>🗄️ Archive</button>
        <button onClick={() => setShowFilters(!showFilters)} className={pill(showFilters || activeFilters > 0)}>
          Filters{activeFilters ? ` (${activeFilters})` : ""}
        </button>
        {view !== "gantt" && (
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className={inputCls} aria-label="Sort by">
            {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>Sort: {o.label}</option>)}
          </select>
        )}
        {view === "board" && (
          <select value={boardBy} onChange={(e) => setBoardBy(e.target.value)} className={inputCls} aria-label="Arrange board by">
            {BOARD_GROUPS.map((o) => <option key={o.value} value={o.value}>Arrange by: {o.label}</option>)}
          </select>
        )}
      </div>
      {showFilters && (
        <div className="flex flex-wrap gap-2 mb-4 bg-slate-800 border border-slate-700 rounded p-3">
          <select value={statusF} onChange={(e) => setStatusF(e.target.value)} className={inputCls} aria-label="Status">
            <option value="">Any status</option>
            {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            <option value="overdue">Overdue</option>
          </select>
          <select value={priorityF} onChange={(e) => setPriorityF(e.target.value)} className={inputCls} aria-label="Priority">
            <option value="">Any priority</option>
            {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          <select value={assigneeF} onChange={(e) => setAssigneeF(e.target.value)} className={inputCls} aria-label="Assignee">
            <option value="">Anyone</option>
            <option value="none">Unassigned</option>
            {lookups.people.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <select value={projectF} onChange={(e) => setProjectF(e.target.value)} className={inputCls} aria-label="Project">
            <option value="">All projects</option>
            {lookups.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {activeFilters > 0 && (
            <button onClick={() => { setStatusF(""); setPriorityF(""); setAssigneeF(""); setProjectF(""); setMine(false); }} className="text-sm text-slate-400 hover:text-white px-2">
              Clear
            </button>
          )}
        </div>
      )}

      {loading ? (
        <p className="text-slate-400">Loading...</p>
      ) : filtered.length === 0 ? (
        <p className="text-slate-400">
          {showArchived ? "Nothing in the archive matches." : q || activeFilters ? "No tasks match the current filters." : "No tasks yet. Create one above."}
        </p>
      ) : view === "list" ? (
        <div className="grid gap-3">
          {filtered.map((t) => {
            const late = isOverdue(t);
            return (
              <button
                key={t.id}
                onClick={() => setOpenId(t.id)}
                style={!late && t.color ? { borderLeftColor: t.color, borderLeftWidth: 4 } : undefined}
                className={`text-left bg-slate-800 rounded border p-4 hover:border-blue-500 ${late ? "border-l-4 border-l-red-500 border-slate-700" : t.color ? "border-slate-700" : "border-slate-700"}`}
              >
                <div className="flex justify-between items-start gap-3 mb-1">
                  <h3 className={`font-bold ${late ? "text-red-400" : ""}`}>
                    {t.color && <span className="inline-block w-2.5 h-2.5 rounded-full mr-2 align-middle" style={{ backgroundColor: t.color }} title="Custom color" />}
                    {t.title}
                    {late && <span className="ml-2 text-xs font-normal">OVERDUE</span>}
                  </h3>
                  <span className={`text-xs px-2 py-1 rounded shrink-0 ${statusClass(t.status)}`}>{statusLabel(t.status)}</span>
                </div>
                {t.description && <p className="text-slate-400 text-sm mb-2 line-clamp-2">{t.description}</p>}
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 mb-2">
                  <span>{PRIORITIES.find((p) => p.value === t.priority)?.label}</span>
                  {t.due_date && <span>Due {formatDue(t.due_date)}</span>}
                  {t.completed_at && <span>Finished {formatDue(t.completed_at)}</span>}
                  {sectionName(t) && <span>§ {sectionName(t)}</span>}
                  {t.milestone && <span>◆ {milestoneLabel(t.milestone)}</span>}
                  {(t.subtask_count || 0) > 0 && <span>{t.subtask_count} subtasks</span>}
                  {t.personal && <span>🔒 personal</span>}
                  <span className="ml-auto">👤 {nameOf(lookups.people, t.assigned_to)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex-1 bg-slate-900 rounded h-2">
                    <div className="bg-blue-600 h-2 rounded" style={{ width: `${t.progress_percent}%` }} />
                  </div>
                  <span className="text-xs text-slate-400 w-9 text-right">{t.progress_percent}%</span>
                </div>
              </button>
            );
          })}
        </div>
      ) : view === "gantt" ? (
        <GanttView
          tasks={filtered}
          people={lookups.people}
          canAdjust={canAdjust}
          onOpen={setOpenId}
          onMoveDeadline={(id, iso) => patchTask(id, { due_date: iso })}
        />
      ) : boardBy === "section" && !projectF ? (
        <div className="bg-slate-800 border border-slate-700 rounded p-4 text-sm text-slate-300 flex flex-wrap items-center gap-2">
          <span>Sections belong to a project. Pick one to see its sections:</span>
          <select value="" onChange={(e) => setProjectF(e.target.value)} className={inputCls} aria-label="Project for sections">
            <option value="">Choose a project...</option>
            {lookups.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2 snap-x">
          {boardColumns.map((col) => {
            const list = filtered.filter((t) => inColumn(t, col.key));
            return (
              <div
                key={col.key || "none"}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  dropOn(col.key);
                }}
                className="bg-slate-800 rounded p-3 border border-slate-700 min-w-[240px] w-[80vw] sm:w-[260px] shrink-0 snap-start"
              >
                <h3 className="font-bold mb-3 text-slate-300 text-sm">
                  {col.label} <span className="text-slate-500 font-normal">({list.length})</span>
                </h3>
                <div className="space-y-2 min-h-[40px]">
                  {list.map((t) => (
                    <div
                      key={t.id}
                      draggable
                      onDragStart={(e) => {
                        // Firefox only starts a drag when some data is set.
                        e.dataTransfer.setData("text/plain", t.id);
                        e.dataTransfer.effectAllowed = "move";
                        setDragged(t.id);
                      }}
                      onDragEnd={() => setDragged(null)}
                      onClick={() => setOpenId(t.id)}
                      style={!isOverdue(t) && t.color ? { borderColor: t.color } : undefined}
                      className={`bg-slate-900 p-3 rounded border cursor-pointer hover:border-blue-500 text-sm ${
                        isOverdue(t) ? "border-red-600" : "border-slate-700"
                      } ${dragged === t.id ? "opacity-40" : ""}`}
                    >
                      <p className="font-semibold mb-1">
                        {t.color && <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle" style={{ backgroundColor: t.color }} />}
                        {t.title}
                      </p>
                      <div className="flex justify-between text-xs text-slate-500 mb-2 gap-2">
                        <span>{boardBy === "status" ? PRIORITIES.find((p) => p.value === t.priority)?.label : statusLabel(t.status)}</span>
                        {boardBy === "section" && t.status && isFinished(t.status) && <span className="text-green-400">✓</span>}
                        <span>{t.due_date ? formatDue(t.due_date) : ""}</span>
                      </div>
                      <div className="w-full bg-slate-800 rounded h-1.5">
                        <div className={`h-1.5 rounded ${isFinished(t.status) ? "bg-green-600" : "bg-blue-600"}`} style={{ width: `${t.progress_percent}%` }} />
                      </div>
                      {/* Touch screens can't drag; offer a move menu instead. */}
                      <select
                        value=""
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          const key = e.target.value === "__none" ? "" : e.target.value;
                          moveTo(t.id, key);
                        }}
                        className="mt-2 w-full px-2 py-1 bg-slate-800 border border-slate-700 rounded text-xs sm:hidden"
                        aria-label="Move to"
                      >
                        <option value="">Move to...</option>
                        {columns.filter((c) => c.key !== col.key).map((c) => (
                          <option key={c.key || "none"} value={c.key || "__none"}>{c.label}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {openTask && (
        <TaskDetail
          key={openTask.id}
          task={openTask}
          allTasks={tasks}
          lookups={lookups}
          onClose={() => setOpenId(null)}
          onPatch={patchTask}
          onReplace={replaceTask}
          onAdd={(t) => setTasks((prev) => [t, ...prev])}
          onError={showError}
          onInfo={showInfo}
          onTemplateSaved={(tpl) => setTemplates((prev) => (prev.some((x) => x.id === tpl.id) ? prev : [...prev, tpl]))}
          onRemoved={(id) => {
            setTasks((prev) => prev.filter((x) => x.id !== id));
            setArchivedTasks((prev) => prev.filter((x) => x.id !== id));
          }}
        />
      )}
    </div>
  );
}
