"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { STATUSES, isFinished, isOverdue, statusClass, statusLabel } from "@/lib/status";
import { sendJSON } from "@/lib/api";
import { OPEN_TASK_EVENT } from "@/components/NotificationBell";
import dynamic from "next/dynamic";
import { SIMPLE } from "@/lib/simple";
import { cached, freshKeeper, keepSame, load, prefetch, remember, useBeforePaint, useRefresh } from "@/lib/apiCache";
import { AssigneePicker } from "@/components/tasks/AssigneePicker";
import { BulkBar, PickBox, RecentlyDeleted, UndoBar, useBulkDelete } from "@/components/tasks/BulkDelete";
import { DateTimeInput, DeadlinePicker } from "@/components/tasks/DateInputs";
import { ItemRow, ItemRows, blankItems, itemsPayload, latestItemDate } from "@/components/tasks/ItemRows";

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
  toLocalInput,
} from "@/components/tasks/types";

// The task panel and the timeline are big and only needed after a tap: they
// load in the background (see below), so the list itself appears sooner.
const loadTaskDetail = () => import("@/components/tasks/TaskDetail");
const TaskDetail = dynamic(() => loadTaskDetail().then((m) => m.TaskDetail), { ssr: false });
const GanttView = dynamic(() => import("@/components/tasks/GanttView").then((m) => m.GanttView), { ssr: false });

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

// Dates here are ISO strings, which sort correctly as plain text - much
// faster than localeCompare on a long list.
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const emptyLookups: Lookups = { people: [], projects: [], keyResults: [], me: null };

/**
 * One task in the list. Memoised: typing in the form above or ticking a
 * filter doesn't redraw every card, only the ones whose task changed.
 */
const TaskCard = memo(function TaskCard({
  t,
  project,
  section,
  assignee,
  onOpen,
  picking,
  picked,
}: {
  t: Task;
  project: string | null;
  section: string | null;
  assignee: string;
  onOpen: (id: string) => void;
  /** Selecting for delete: a tap ticks the card instead of opening it. */
  picking?: boolean;
  picked?: boolean;
}) {
  const late = isOverdue(t);
  const sending = t.id.startsWith("sending-");
  return (
    <button
      onClick={() => !sending && onOpen(t.id)}
      aria-pressed={picking ? !!picked : undefined}
      // A finger on the card starts loading its details before the tap ends.
      onPointerDown={() => !sending && prefetch([`/api/tasks/${t.id}/details`], 10_000)}
      aria-busy={sending || undefined}
      style={!late && t.color ? { borderLeftColor: t.color, borderLeftWidth: 4 } : undefined}
      className={`cv-auto text-left bg-slate-800 rounded border p-4 hover:border-blue-500 ${sending ? "opacity-70" : ""} ${late ? "border-l-4 border-l-red-500 border-slate-700" : "border-slate-700"}`}
    >
      <div className="flex justify-between items-start gap-3 mb-1">
        <h3 className={`font-bold ${late ? "text-red-400" : ""}`}>
          {picking && <span className="mr-2 align-middle inline-block"><PickBox on={!!picked} /></span>}
          {t.color && <span className="inline-block w-2.5 h-2.5 rounded-full mr-2 align-middle" style={{ backgroundColor: t.color }} title="Custom color" />}
          {t.title}
          {late && <span className="ml-2 text-xs font-normal">OVERDUE</span>}
        </h3>
        <span className={`text-xs px-2 py-1 rounded shrink-0 ${sending ? "bg-slate-700 text-slate-300" : statusClass(t.status)}`}>{sending ? "Sending..." : statusLabel(t.status)}</span>
      </div>
      {t.description && <p className="text-slate-400 text-sm mb-2 line-clamp-2">{t.description}</p>}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 mb-2">
        <span>{PRIORITIES.find((p) => p.value === t.priority)?.label}</span>
        {t.due_date && <span>Due {formatDue(t.due_date)}</span>}
        {t.completed_at && <span>Finished {formatDue(t.completed_at)}</span>}
        {section && <span>§ {section}</span>}
        {!SIMPLE && t.milestone && <span>◆ {milestoneLabel(t.milestone)}</span>}
        {project && <span>📁 {project}</span>}
        {(t.subtask_count || 0) > 0 && <span>{t.subtask_count} subtasks</span>}
        {t.personal && <span>🔒 personal</span>}
        <span className="ml-auto">👤 {assignee}</span>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 bg-slate-700 rounded h-2">
          <div className="bg-blue-600 h-2 rounded" style={{ width: `${t.progress_percent}%` }} />
        </div>
        <span className="text-xs text-slate-400 w-9 text-right">{t.progress_percent}%</span>
      </div>
    </button>
  );
});

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
  const [showDeleted, setShowDeleted] = useState(false);
  const [deletedKey, setDeletedKey] = useState(0);
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
    // Step 2 of the assignment flow: one or more people, picked first.
    assignees: [] as string[],
    color: "",
    // Simple mode: subtasks typed at creation, one per line.
    subtasks: "",
  });
  const [creating, setCreating] = useState(false);
  // Tasks being sent or just made here: a reload that set off before the
  // server had them doesn't wipe them from the list.
  const [fresh] = useState(() => freshKeeper<Task>());
  // Simple mode: the things to do inside this one task, each with a tick box.
  const [items, setItems] = useState<ItemRow[]>(() => blankItems(1));
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
  // Select several tasks and delete them (Undo / Recently deleted for 30 days).
  const bulk = useBulkDelete({
    onRemoved: (ids) => {
      const gone = new Set(ids);
      setTasks((prev) => prev.filter((t) => !gone.has(t.id)));
      setArchivedTasks((prev) => prev.filter((t) => !gone.has(t.id)));
      setDeletedKey((k) => k + 1);
    },
    onRestored: () => {
      setDeletedKey((k) => k + 1);
      loadAll(false);
    },
    onError: (m) => showError(m),
  });

  // Load (or reload) everything this page shows. On the first load the
  // remembered copy is already on screen; this swaps in fresh data.
  const loadAll = useCallback(
    async (first: boolean) => {
      const params = new URLSearchParams(window.location.search);
      try {
        // All at once, but the people list is what the form at the top needs
        // first, so it is shown the moment it lands.
        const tasksReq = load<{ tasks: Task[] }>("/api/tasks");
        const membersReq = load<any>("/api/team/members").catch(() => null);
        const projectsReq = load<any>("/api/projects").catch(() => null);
        // Simple mode never shows OKRs or templates: don't load them.
        const okrReq = SIMPLE ? Promise.resolve(null) : load<any>("/api/okr").catch(() => null);
        const templatesReq = SIMPLE ? Promise.resolve(null) : load<any>("/api/templates").catch(() => null);

        membersReq.then((m) => {
          if (!m) return;
          setLookups((cur) => ({ ...cur, people: m.members || [], me: m.me || null }));
          setMyRole(m.myRole || "member");
        });

        const [td, m, p, okr, tpl] = await Promise.all([tasksReq, membersReq, projectsReq, okrReq, templatesReq]);
        // Unchanged tasks keep their old objects: nothing redraws for them.
        setTasks((prev) => keepSame(prev, fresh.merge(td.tasks || [])));
        // A link to an archived task (?task=...) still opens it.
        const wanted = first ? params.get("task") : null;
        if (wanted && !(td.tasks || []).some((x: Task) => x.id === wanted)) {
          const all = await load<any>("/api/tasks?archived=only").catch(() => null);
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
        setLookups((cur) => ({
          people: m?.members || cur.people,
          me: m?.me || cur.me,
          projects: p?.projects || cur.projects,
          keyResults: okr?.keyResults || cur.keyResults,
        }));
        if (m) setMyRole(m.myRole || "member");
        if (tpl) setTemplates(tpl.templates || []);
      } catch (e: any) {
        showError(e.message || "Could not load tasks");
      } finally {
        setLoading(false);
      }
    },
    [showError, fresh]
  );

  useBeforePaint(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("project")) {
      const pid = params.get("project") as string;
      setProjectF(pid);
      // New tasks made while looking at a project go into it unless changed.
      if (SIMPLE) setForm((f) => ({ ...f, project: pid }));
    }
    if (params.get("task")) setOpenId(params.get("task"));
    if (params.get("assignee")) {
      setAssigneeF(params.get("assignee") as string);
      setShowFilters(true);
    }

    // Paint what this phone remembers at once; fresh data replaces it below.
    const t = cached<{ tasks: Task[] }>("/api/tasks");
    const m = cached<any>("/api/team/members");
    const p = cached<any>("/api/projects");
    if (t) {
      setTasks(t.tasks || []);
      setLoading(false);
    }
    if (m) {
      setLookups((cur) => ({ ...cur, people: m.members || [], me: m.me || null }));
      setMyRole(m.myRole || "member");
    }
    if (p) setLookups((cur) => ({ ...cur, projects: p.projects || [] }));

    loadAll(true);
  }, [loadAll]);

  // Pull-to-refresh and coming back to the app reload in place.
  useRefresh(() => loadAll(false));

  // Have the task panel ready before anyone taps a task.
  useEffect(() => {
    const t = setTimeout(() => loadTaskDetail().catch(() => {}), 1200);
    return () => clearTimeout(t);
  }, []);

  // Keep the remembered copy in step with edits made on this page, so other
  // screens (To-Do, Projects) and the next visit show them straight away.
  useEffect(() => {
    if (loading || !lookups.me) return;
    remember("/api/tasks", { tasks: tasks.filter((t) => !t.id.startsWith("sending-")) });
  }, [tasks, lookups.me, loading]);

  // Archive view (checklist #12): archived tasks come from their own query.
  useEffect(() => {
    if (!showArchived) return;
    fetch("/api/tasks?archived=only", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setArchivedTasks(d.tasks || []))
      .catch(() => showError("Could not load the archive"));
  }, [showArchived, showError]);

  const refreshProjects = useCallback(async () => {
    const d = await load<any>("/api/projects").catch(() => null);
    if (d) setLookups((l) => ({ ...l, projects: d.projects || [] }));
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
    const due = fromLocalInput(form.due) || (SIMPLE ? latestItemDate(items) : null);
    const others = form.assignees.filter((id) => id !== lookups.me);
    // Simple mode: every task belongs to someone, or nobody gets reminded.
    if (SIMPLE && form.assignees.length === 0) {
      showError("Pick who this is for first (step 1).");
      return;
    }
    // Steps 3-4: anyone else given this work has to accept a deadline, so
    // there must be one to accept.
    if (others.length > 0 && !due) {
      showError("Set a deadline - the people you're assigning this to will be asked to accept it.");
      return;
    }
    setCreating(true);
    const base = {
      title: form.title.trim(),
      description: form.description.trim() || null,
      priority: form.priority,
      due_date: due || null,
      start_date: fromLocalInput(form.start),
      project_id: SIMPLE ? form.project || null : form.project || projectF || null,
      stage_id: form.section || null,
      color: form.color || null,
    };
    // Several people means several tasks, one each: every person accepts,
    // is reviewed on, and is paid or penalised for their own work.
    const targets: (string | null)[] = form.assignees.length ? form.assignees : [null];
    const keepForm = form;
    const keepItems = items;
    const itemsBody = SIMPLE ? itemsPayload(items) : [];

    // The new task is in the list the moment "Assign" is tapped, and the
    // form is ready for the next one; the server confirms behind it.
    const stamp = Date.now();
    const now = new Date().toISOString();
    const placeholders = targets.map(
      (assignee, i) =>
        ({
          ...base,
          id: `sending-${stamp}-${i}`,
          assigned_to: assignee,
          created_by: lookups.me,
          status: "pending",
          progress_percent: 0,
          created_at: now,
          completed_at: null,
          archived_at: null,
          personal: false,
          subtask_count: itemsBody.length,
          for_me: assignee === lookups.me,
        }) as unknown as Task
    );
    placeholders.forEach((p) => fresh.add(p));
    setTasks((prev) => [...placeholders, ...prev]);
    setForm({ ...form, title: "", description: "", start: "", due: "", assignees: [], color: "", subtasks: "" });
    setItems(blankItems(1));

    const failed: string[] = [];
    const subFailed: string[] = [];
    const failedIds: string[] = [];
    try {
      // All the copies at once, not one after another.
      const results = await Promise.all(
        targets.map(async (assignee, i) => {
          try {
            const data = await sendJSON("/api/tasks", "POST", {
              ...base,
              assigned_to: assignee,
              // Everyone given it, so each person's alerts say who else has it.
              with: targets.filter(Boolean),
              ...(SIMPLE ? { items: itemsBody } : {}),
            });
            return { temp: placeholders[i].id, task: data.task as Task };
          } catch (err: any) {
            failed.push(`${assignee ? nameOf(lookups.people, assignee) : "task"}: ${err.message}`);
            if (assignee) failedIds.push(assignee);
            return { temp: placeholders[i].id, task: null as Task | null };
          }
        })
      );
      const made = results.map((r) => r.task).filter((t): t is Task => !!t);

      // Subtasks typed in the form go onto every copy, in the order written.
      const subLines = (SIMPLE ? "" : keepForm.subtasks)
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 50);
      if (subLines.length) {
        for (const t of made) {
          let added = 0;
          for (const title of subLines) {
            try {
              await sendJSON(`/api/tasks/${t.id}/subtasks`, "POST", { title });
              added += 1;
            } catch (err: any) {
              subFailed.push(`"${title}"`);
            }
          }
          (t as any).subtask_count = added;
        }
      }

      // Swap each placeholder for the real task, or take it away if it failed.
      const byTemp = new Map(results.map((r) => [r.temp, r.task]));
      results.forEach((r) => {
        fresh.drop(r.temp);
        if (r.task) fresh.add(r.task);
      });
      setTasks((prev) => prev.flatMap((t) => (byTemp.has(t.id) ? (byTemp.get(t.id) ? [byTemp.get(t.id) as Task] : []) : [t])));

      if (failed.length) {
        // Put the form back for just the ones that didn't go through, so
        // nobody ends up with two copies.
        setForm({ ...keepForm, assignees: failedIds });
        setItems(keepItems);
        showError(`Not created - ${failed.join("; ")}`);
      } else if (subFailed.length) {
        showError(`Task created, but these subtasks didn't save: ${Array.from(new Set(subFailed)).join(", ")}. Open the task to add them.`);
      } else if (made.length) {
        showInfo(
          made.length === 1
            ? others.length
              ? "Task created. They've been asked to accept the deadline."
              : "Task created."
            : `${made.length} tasks created, one for each person. Each has been asked to accept the deadline.`
        );
      }
      // A new task may have created a project's first section; refresh the lookups quietly.
      const first = made[0];
      if (first && !sectionsFor(lookups.projects, first.project_id).some((x) => x.id === first.stage_id)) refreshProjects();
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

  // To-do lists live on their own page (Lists), not in the task list.
  const source = useMemo(() => (showArchived ? archivedTasks : tasks).filter((t) => !(t as any).is_list), [showArchived, archivedTasks, tasks]);
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
          return byText(a.due_date, b.due_date);
        }
        if (sortBy === "priority") return (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0);
        if (sortBy === "progress") return (b.progress_percent || 0) - (a.progress_percent || 0);
        if (sortBy === "progress_asc") return (a.progress_percent || 0) - (b.progress_percent || 0);
        if (sortBy === "completed_at") {
          // Finished work first, most recently finished at the top.
          if (!a.completed_at && !b.completed_at) return 0;
          if (!a.completed_at) return 1;
          if (!b.completed_at) return -1;
          return byText(b.completed_at, a.completed_at);
        }
        return byText(b.created_at, a.created_at);
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

  const projectNames = useMemo(() => new Map(lookups.projects.map((p) => [p.id, p.name])), [lookups.projects]);

  // A long list paints its first cards at once and the rest straight after,
  // so the screen is never held up drawing cards below the fold.
  const [shown, setShown] = useState(10);
  useEffect(() => {
    if (shown >= filtered.length) return;
    const t = setTimeout(() => setShown(Number.MAX_SAFE_INTEGER), 30);
    return () => clearTimeout(t);
  }, [shown, filtered.length]);

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
      <div className="flex justify-start items-center gap-3 mb-4">
        <h1 className="text-2xl sm:text-3xl font-bold">Tasks</h1>
      </div>

      {currentProject && (
        <div className="mb-4 bg-slate-800 border border-slate-700 rounded p-4 flex justify-start gap-4">
          <div>
            <p className="text-blue-400 font-semibold">{currentProject.name}</p>
            {currentProject.description && <p className="text-slate-400 text-sm mt-1">{currentProject.description}</p>}
          </div>
          <button onClick={() => setProjectF("")} className="text-sm text-slate-400 hover:text-white whitespace-nowrap">Show all</button>
        </div>
      )}

      {error && (
        <div className="bg-red-950 border border-red-800 text-red-300 px-4 py-3 rounded mb-4 text-sm flex justify-start gap-3" role="alert">
          <span>{error}</span>
          <button onClick={() => setError("")} className="text-red-400 shrink-0">dismiss</button>
        </div>
      )}
      {/* A floating note, so the page doesn't jump when it appears and goes. */}
      {info && (
        <div className="fixed toast-bottom left-1/2 -translate-x-1/2 z-[60] bg-green-950 border border-green-800 text-green-200 px-4 py-3 rounded shadow-lg text-sm max-w-[calc(100vw-2rem)]" role="status">
          {info}
        </div>
      )}

      {/* Create */}
      <form onSubmit={createTask} className="bg-slate-800 p-3 sm:p-4 rounded border border-slate-700 mb-6 space-y-3">
        {SIMPLE && <p className="text-sm font-semibold text-white">1. Who is this for?</p>}
        <AssigneePicker
          people={lookups.people}
          me={lookups.me}
          selected={form.assignees}
          onChange={(ids) => setForm((f) => ({ ...f, assignees: ids }))}
          loading={loading}
          onPeopleChange={(people) => setLookups((cur) => ({ ...cur, people }))}
          myRole={myRole}
        />
        {SIMPLE && <p className="text-sm font-semibold text-white pt-1">2. What needs doing?</p>}
        <input
          type="text"
          placeholder="Task title"
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          className={`${inputCls} w-full`}
        />
        <textarea
          placeholder="What is this task about? (optional)"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          rows={2}
          className={`${inputCls} w-full resize-y`}
        />
        {SIMPLE && (
          <>
            <p className="text-xs text-slate-400 pt-1">
              Things to do in this task (optional) - one task, as many items as you like. They get a tick box each.
            </p>
            <ItemRows rows={items} onChange={setItems} placeholder="Item to do" />
            <p className="text-sm font-semibold text-white pt-1">3. By when?</p>
            <DeadlinePicker
              value={form.due}
              onChange={(due) => setForm((f) => ({ ...f, due }))}
              emptyNote={
                latestItemDate(items)
                  ? `No deadline picked: the last item's date (${formatDue(latestItemDate(items))}) will be used.`
                  : form.assignees.some((id) => id !== lookups.me)
                  ? "Pick a deadline - they'll be asked to accept it."
                  : "Pick a deadline (optional when it's just for you)."
              }
            />
          </>
        )}
        <div className="flex flex-wrap gap-2 items-end">
          {!SIMPLE && (
            <label className="flex flex-col text-xs text-slate-400 gap-1">
              {form.assignees.some((id) => id !== lookups.me) ? "Deadline" : "Due (optional)"}
              <DateTimeInput value={form.due} onChange={(due) => setForm((f) => ({ ...f, due }))} className={inputCls} />
            </label>
          )}
          <label className="flex flex-col text-xs text-slate-400 gap-1">
            Priority
            <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} className={inputCls}>
              {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </label>
          {SIMPLE && lookups.projects.length > 0 && (
            <label className="flex flex-col text-xs text-slate-400 gap-1">
              Project
              <select value={form.project} onChange={(e) => setForm({ ...form, project: e.target.value, section: "" })} className={inputCls}>
                <option value="">General</option>
                {lookups.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          )}
          {!SIMPLE && (
            <button type="button" onClick={() => setShowMore(!showMore)} className="text-sm text-blue-400 px-2 py-2">
              {showMore ? "Fewer options" : "More options"}
            </button>
          )}
          {/* The main button starts its own line, on the left. */}
          <div className="basis-full h-0" aria-hidden="true" />
          <button type="submit" disabled={creating || !form.title.trim()} className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-5 py-2.5 rounded font-semibold">
            {creating
              ? "Creating..."
              : form.assignees.length > 1
              ? SIMPLE ? `Assign to ${form.assignees.length} people` : `Add ${form.assignees.length} tasks`
              : SIMPLE ? "Assign task" : "Add Task"}
          </button>
        </div>
        {showMore && !SIMPLE && (
          <div className="flex flex-wrap gap-2 items-end">
            <label className="flex flex-col text-xs text-slate-400 gap-1">
              Start
              <DateTimeInput value={form.start} onChange={(start) => setForm((f) => ({ ...f, start }))} className={inputCls} />
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
          {!SIMPLE && <button onClick={() => setView("gantt")} className={pill(view === "gantt")}>Gantt</button>}
        </div>
      </div>
      <div className="flex flex-wrap gap-2 mb-4 items-center">
        <button onClick={() => setMine(!mine)} className={pill(mine)}>My tasks</button>
        <button onClick={() => setShowArchived(!showArchived)} className={pill(showArchived)}>🗄️ Archive</button>
        {view === "list" && <BulkBar bulk={bulk} allIds={filtered.filter((t) => !t.id.startsWith("sending-")).map((t) => t.id)} />}
        <button onClick={() => setShowDeleted(!showDeleted)} className={pill(showDeleted)}>🗑 Recently deleted</button>
        <button onClick={() => setShowFilters(!showFilters)} className={pill(showFilters || activeFilters > 0)}>
          Filters{activeFilters ? ` (${activeFilters})` : ""}
        </button>
        {view !== "gantt" && (
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className={inputCls} aria-label="Sort by">
            {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>Sort: {o.label}</option>)}
          </select>
        )}
        {view === "board" && !SIMPLE && (
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
          {(
            <select value={projectF} onChange={(e) => setProjectF(e.target.value)} className={inputCls} aria-label="Project">
              <option value="">All projects</option>
              {lookups.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          {activeFilters > 0 && (
            <button onClick={() => { setStatusF(""); setPriorityF(""); setAssigneeF(""); setProjectF(""); setMine(false); }} className="text-sm text-slate-400 hover:text-white px-2">
              Clear
            </button>
          )}
        </div>
      )}

      {showDeleted && <RecentlyDeleted lists={false} bulk={bulk} nameOf={(id) => nameOf(lookups.people, id)} reloadKey={deletedKey} />}
      <UndoBar bulk={bulk} />

      {loading ? (
        <p className="text-slate-400">Loading...</p>
      ) : filtered.length === 0 ? (
        <p className="text-slate-400">
          {showArchived ? "Nothing in the archive matches." : q || activeFilters ? "No tasks match the current filters." : "No tasks yet. Create one above."}
        </p>
      ) : view === "list" ? (
        <div className="grid gap-3">
          {filtered.slice(0, shown).map((t) => (
            <TaskCard
              key={t.id}
              t={t}
              project={SIMPLE && t.project_id ? projectNames.get(t.project_id) || null : null}
              section={!SIMPLE ? sectionName(t) || null : null}
              assignee={nameOf(lookups.people, t.assigned_to)}
              onOpen={bulk.selecting ? bulk.toggle : setOpenId}
              picking={bulk.selecting}
              picked={bulk.picked.has(t.id)}
            />
          ))}
        </div>
      ) : view === "gantt" && !SIMPLE ? (
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
