"use client";

import { useEffect, useState } from "react";
import { STATUSES, isFinished, isOverdue, statusClass } from "@/lib/status";
import { sendJSON } from "@/lib/api";

type Task = {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  progress_percent: number;
  due_date: string | null;
  assigned_to: string | null;
  milestone: string | null;
  project_id: string | null;
  archived_at: string | null;
  team_id: string | null;
  task_manager_id: string | null;
  key_result_id: string | null;
  progress_type: string | null;
  progress_target: number | null;
  progress_current: number | null;
  created_by: string | null;
  created_at: string;
};

type TeamMember = { id: string; name: string; email: string };
type Notification = { id: string; title: string; message: string | null; read: boolean; created_at: string };



const PRIORITIES = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "super_high", label: "Super High" },
];

const PRIORITY_RANK: Record<string, number> = {
  super_high: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const SORT_OPTIONS = [
  { value: "created_at", label: "Newest first" },
  { value: "due_date", label: "By due date" },
  { value: "priority", label: "By priority" },
  { value: "progress", label: "By progress" },
];

// datetime-local needs YYYY-MM-DDTHH:mm in local time, not an ISO string.
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// SOW #10: show the time alongside the date once one is set.
function formatDue(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const hasTime = d.getHours() !== 0 || d.getMinutes() !== 0;
  return hasTime
    ? d.toLocaleString([], { dateStyle: "short", timeStyle: "short" })
    : d.toLocaleDateString();
}


export default function DashboardPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "board" | "gantt" | "priority">("list");
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [myTasksOnly, setMyTasksOnly] = useState(false);

  const searchSuggestions = searchQuery.trim()
    ? tasks.filter((t) =>
        t.title.toLowerCase().includes(searchQuery.toLowerCase())
      ).slice(0, 5)
    : [];
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [taskDeps, setTaskDeps] = useState<Record<string, string[]>>({});
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState("created_at");
  const [showArchived, setShowArchived] = useState(false);
  // SOW #26: dragging a card changes its status or priority.
  const [draggedTask, setDraggedTask] = useState<string | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([]);
  const [keyResults, setKeyResults] = useState<{ id: string; title: string }[]>([]);
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([]);
  const [newTaskProject, setNewTaskProject] = useState("");
  const [currentProject, setCurrentProject] = useState<{ name: string; description: string | null } | null>(null);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [priority, setPriority] = useState("medium");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [tasksRes, membersRes, notifRes] = await Promise.all([
          fetch("/api/tasks"),
          fetch("/api/team/members"),
          fetch("/api/notifications"),
        ]);
        const tasksData = await tasksRes.json();
        if (!tasksRes.ok) throw new Error(tasksData.error || "Could not load tasks");
        setTasks(tasksData.tasks || []);

        const membersData = await membersRes.json();
        if (membersRes.ok) {
          setTeamMembers(membersData.members || []);
          setCurrentUserId(membersData.me || null);
        }

        const notifData = await notifRes.json();
        if (notifRes.ok) setNotifications(Array.isArray(notifData) ? notifData : []);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }

      // Dependencies are now fetched per-task when opening the modal
      // so we don't need to fetch all at once here
    })();
  }, []);

  // Read ?project=<id> from the URL and resolve it to a project.
  // window.location avoids useSearchParams, which would need a Suspense boundary.
  useEffect(() => {
    // SOW #4/#16: every project is needed for the create picker and duplicate target.
    // SOW #41/#36: teams and key results feed the assignment selectors.
    (async () => {
      try {
        const [pr, tm, ok] = await Promise.all([
          fetch("/api/projects"),
          fetch("/api/teams"),
          fetch("/api/okr"),
        ]);
        if (pr.ok) setProjects((await pr.json()).projects || []);
        if (tm.ok) setTeams((await tm.json()).teams || []);
        if (ok.ok) setKeyResults((await ok.json()).keyResults || []);
        const tp = await fetch("/api/templates");
        if (tp.ok) setTemplates((await tp.json()).templates || []);
      } catch {
        /* selectors fall back to empty lists */
      }
    })();

    const params = new URLSearchParams(window.location.search);
    const pid = params.get("project");
    if (!pid) return;
    setProjectFilter(pid);
    (async () => {
      try {
        const res = await fetch("/api/projects");
        if (!res.ok) return;
        const data = await res.json();
        const match = (data.projects || []).find((p: any) => p.id === pid);
        if (match) setCurrentProject(match);
      } catch {
        /* leave the header off if this fails */
      }
    })();
  }, []);

  // Keep the bell fresh without needing a page reload.
  const loadNotifications = async () => {
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setNotifications(Array.isArray(data) ? data : []);
    } catch {
      /* keep whatever is already on screen */
    }
  };

  useEffect(() => {
    const timer = setInterval(loadNotifications, 30000);
    return () => clearInterval(timer);
  }, []);

  const createTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    if (!dueDate) {
      setError("A due date and time is required before a task can be created.");
      return;
    }
    setCreating(true);
    setError("");
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || null,
          priority,
          due_date: dueDate || null,
          project_id: newTaskProject || projectFilter || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not create task");
      setTasks([data.task, ...tasks]);
      setTitle("");
      setDescription("");
      setDueDate("");
      setPriority("medium");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  };

  const patchTask = async (id: string, patch: Partial<Task>) => {
    // Keep the pre-edit copy so a rejected change can be undone. The server can
    // legitimately refuse a due-date edit, and the screen must not keep showing
    // a value that was never saved.
    const previous = tasks.find((t) => t.id === id);

    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    try {
      const res = await fetch("/api/tasks", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...patch }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not update task");
      setTasks((prev) => prev.map((t) => (t.id === id ? data.task : t)));

      // An assignment or a completion may have written a notification server-side.
      if (Object.prototype.hasOwnProperty.call(patch, "assigned_to") || isFinished(patch.status)) {
        loadNotifications();
      }
    } catch (e: any) {
      if (previous) {
        setTasks((prev) => prev.map((t) => (t.id === id ? previous : t)));
      }
      setError(e.message);
    }
  };

  const duplicateTask = async (id: string, targetProjectId?: string) => {
    try {
      const res = await fetch(`/api/tasks/${id}/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: targetProjectId || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not duplicate task");
      setTasks((prev) => [data.task, ...prev]);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const markNotificationRead = async (id: string) => {
    try {
      await sendJSON("/api/notifications", "PATCH", { id });
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    } catch (e) {
      console.error(e);
    }
  };

  const searchedTasks = tasks
    .filter((t) => {
      const q = searchQuery.toLowerCase().trim();
      if (!q) return true;
      // SOW #38: search task, milestone, and the assigned person's name/email.
      const assignee = teamMembers.find((m) => m.id === t.assigned_to);
      return (
        t.title.toLowerCase().includes(q) ||
        (t.description?.toLowerCase().includes(q) ?? false) ||
        (t.milestone?.toLowerCase().includes(q) ?? false) ||
        (assignee?.name?.toLowerCase().includes(q) ?? false) ||
        (assignee?.email?.toLowerCase().includes(q) ?? false)
      );
    })
    .filter((t) => (myTasksOnly ? t.assigned_to === currentUserId : true))
    .filter((t) => (projectFilter ? t.project_id === projectFilter : true))
    // SOW #12: archived tasks are hidden until you ask for them.
    .filter((t) => (showArchived ? !!t.archived_at : !t.archived_at))
    .sort((a, b) => {
      // SOW #8: sort by date, priority, progress, or completion date.
      if (sortBy === "due_date") {
        if (!a.due_date && !b.due_date) return 0;
        if (!a.due_date) return 1;
        if (!b.due_date) return -1;
        return a.due_date.localeCompare(b.due_date);
      }
      if (sortBy === "priority") {
        return (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0);
      }
      if (sortBy === "progress") {
        return b.progress_percent - a.progress_percent;
      }
      return b.created_at.localeCompare(a.created_at);
    });

  const groupedByStatus = searchedTasks.reduce((acc, task) => {
    const status = task.status || "pending";
    if (!acc[status]) acc[status] = [];
    acc[status].push(task);
    return acc;
  }, {} as Record<string, Task[]>);

  const unreadCount = notifications.filter((n) => !n.read).length;

return (
    <div className="min-h-screen bg-slate-950">
      {/* Header with notification bell */}
      <div className="bg-slate-900 border-b border-slate-700 px-6 py-4 flex justify-between items-center">
        <h1 className="text-2xl font-bold">BusyBee</h1>
        <div className="relative">
          <button
            onClick={() => {
              const opening = !showNotifications;
              setShowNotifications(opening);
              if (opening) loadNotifications();
            }}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded text-sm relative"
          >
            🔔 {unreadCount > 0 && <span className="ml-1">{unreadCount}</span>}
          </button>
          {showNotifications && (
            <div className="absolute right-0 mt-2 w-80 bg-slate-800 border border-slate-700 rounded shadow-lg z-10 max-h-64 overflow-y-auto">
              {notifications.length === 0 ? (
                <p className="p-4 text-slate-400 text-sm">No notifications</p>
              ) : (
                notifications.map((n) => (
                  <div
                    key={n.id}
                    className={`p-3 border-b border-slate-700 text-sm cursor-pointer hover:bg-slate-700 ${
                      n.read ? "text-slate-500" : "text-slate-200 font-bold"
                    }`}
                    onClick={() => markNotificationRead(n.id)}
                  >
                    <p>{n.message || n.title}</p>
                    <p className="text-xs text-slate-500 mt-1">
                      {new Date(n.created_at).toLocaleString()}
                    </p>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      <div className="max-w-7xl mx-auto p-4 sm:p-6">
        <div className="mb-6">
          <h2 className="text-3xl font-bold">Tasks</h2>
          {currentProject && (
            <div className="mt-3 bg-slate-800 border border-slate-700 rounded p-4">
              <div className="flex justify-between items-start gap-4">
                <div>
                  <p className="text-blue-400 font-semibold">{currentProject.name}</p>
                  {currentProject.description && (
                    <p className="text-slate-400 text-sm mt-1">{currentProject.description}</p>
                  )}
                </div>
                <a
                  href="/dashboard"
                  className="text-sm text-slate-400 hover:text-white whitespace-nowrap"
                >
                  Show all tasks
                </a>
              </div>
            </div>
          )}
        </div>

        {error && (
          <div className="bg-red-950 border border-red-800 text-red-300 px-4 py-3 rounded mb-4 text-sm flex justify-between">
            <span>{error}</span>
            <button onClick={() => setError("")} className="text-red-400">
              dismiss
            </button>
          </div>
        )}

        <form onSubmit={createTask} className="bg-slate-800 p-4 rounded border border-slate-700 mb-8">
          <input
            type="text"
            placeholder="Task title..."
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={creating}
            className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded mb-3 placeholder-slate-500"
          />
          <textarea
            placeholder="Description (optional)..."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={creating}
            rows={2}
            className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded mb-3 placeholder-slate-500 resize-none"
          />
          <div className="flex flex-wrap gap-3">
            <input
              type="datetime-local"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              disabled={creating}
              required
              title="Due date and time is required"
              className="px-3 py-2 bg-slate-900 border border-slate-600 rounded"
            />
            {/* SOW #11: start from a saved template */}
            {templates.length > 0 && (
              <select
                value=""
                onChange={async (e) => {
                  if (!e.target.value) return;
                  try {
                    const res = await fetch("/api/templates", {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        template_id: e.target.value,
                        project_id: newTaskProject || projectFilter || null,
                      }),
                    });
                    const body = await res.json();
                    if (!res.ok) throw new Error(body?.error || "Could not use template");
                    setTasks((prev) => [body.task, ...prev]);
                  } catch (err: any) {
                    setError(err.message);
                  }
                }}
                disabled={creating}
                className="px-3 py-2 bg-slate-900 border border-slate-600 rounded"
              >
                <option value="">Use a template...</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    📄 {t.name}
                  </option>
                ))}
              </select>
            )}
            {/* SOW #4: choose which project the task belongs to */}
            <select
              value={newTaskProject}
              onChange={(e) => setNewTaskProject(e.target.value)}
              disabled={creating}
              className="px-3 py-2 bg-slate-900 border border-slate-600 rounded"
            >
              <option value="">Default project</option>
              {projects.map((pr) => (
                <option key={pr.id} value={pr.id}>
                  {pr.name}
                </option>
              ))}
            </select>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              disabled={creating}
              className="px-3 py-2 bg-slate-900 border border-slate-600 rounded"
            >
              {PRIORITIES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={creating || !title.trim()}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-4 py-2 rounded ml-auto"
            >
              {creating ? "Creating..." : "Add Task"}
            </button>
          </div>
        </form>

        {/* Search bar */}
        <div className="relative mb-4">
          <input
            type="text"
            placeholder="Search tasks..."
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setShowSuggestions(true);
            }}
            onFocus={() => searchQuery && setShowSuggestions(true)}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
            className="w-full px-4 py-2 bg-slate-800 border border-slate-700 rounded placeholder-slate-500"
          />
          {showSuggestions && searchSuggestions.length > 0 && (
            <div className="absolute top-full left-0 right-0 bg-slate-800 border border-slate-600 rounded mt-1 z-40 max-h-48 overflow-y-auto">
              {searchSuggestions.map((task) => (
                <div
                  key={task.id}
                  onClick={() => {
                    setSearchQuery(task.title);
                    setShowSuggestions(false);
                  }}
                  className="px-4 py-2 hover:bg-slate-700 cursor-pointer text-sm"
                >
                  {task.title}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* View toggle buttons */}
        <div className="flex gap-2 mb-6">
          <button
            onClick={() => setViewMode("list")}
            className={`px-4 py-2 rounded ${
              viewMode === "list"
                ? "bg-blue-600 text-white"
                : "bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
          >
            📋 List
          </button>
          <button
            onClick={() => setMyTasksOnly(!myTasksOnly)}
            className={`px-4 py-2 rounded ${
              myTasksOnly
                ? "bg-blue-600 text-white"
                : "bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
          >
            My Tasks
          </button>
          <button
            onClick={() => setViewMode("board")}
            className={`px-4 py-2 rounded ${
              viewMode === "board"
                ? "bg-blue-600 text-white"
                : "bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
          >
            📊 Board
          </button>
          {/* SOW #26: reprioritise by dragging */}
          <button
            onClick={() => setViewMode("priority")}
            className={`px-4 py-2 rounded text-sm ${
              viewMode === "priority"
                ? "bg-blue-600 text-white"
                : "bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
          >
            🎚️ Priority
          </button>
          {/* SOW #9: timeline view */}
          <button
            onClick={() => setViewMode("gantt")}
            className={`px-4 py-2 rounded text-sm ${
              viewMode === "gantt"
                ? "bg-blue-600 text-white"
                : "bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
          >
            📅 Timeline
          </button>
          <a
            href="/todo"
            className="px-4 py-2 rounded text-sm bg-slate-800 text-slate-300 hover:bg-slate-700"
          >
            ✅ My To-Do
          </a>
          <a
            href="/projects"
            className="px-4 py-2 rounded text-sm bg-slate-800 text-slate-300 hover:bg-slate-700"
          >
            📁 Projects
          </a>
          <a
            href="/reports"
            className="px-4 py-2 rounded text-sm bg-slate-800 text-slate-300 hover:bg-slate-700"
          >
            📈 Reports
          </a>
          <a
            href="/chat"
            className="px-4 py-2 rounded text-sm bg-slate-800 text-slate-300 hover:bg-slate-700"
          >
            💬 Chat
          </a>
          <a
            href="/okr"
            className="px-4 py-2 rounded text-sm bg-slate-800 text-slate-300 hover:bg-slate-700"
          >
            🎯 OKR
          </a>
          <a
            href="/teams"
            className="px-4 py-2 rounded text-sm bg-slate-800 text-slate-300 hover:bg-slate-700"
          >
            👥 Teams
          </a>
          <a
            href="/timesheet"
            className="px-4 py-2 rounded text-sm bg-slate-800 text-slate-300 hover:bg-slate-700"
          >
            ⏱️ Timesheet
          </a>
          {/* SOW #12: browse archived tasks */}
          <button
            onClick={() => setShowArchived(!showArchived)}
            className={`px-4 py-2 rounded text-sm ${
              showArchived
                ? "bg-blue-600 text-white"
                : "bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
          >
            🗄️ Archive
          </button>

          {/* SOW #8: sort options */}
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="px-3 py-2 bg-slate-800 border border-slate-600 rounded text-sm text-slate-300"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {loading ? (
          <p className="text-slate-400">Loading...</p>
        ) : searchedTasks.length === 0 ? (
          <p className="text-slate-400">
            {searchQuery || myTasksOnly
              ? "No tasks match the current filter."
              : "No tasks yet. Create one above."}
          </p>
        ) : viewMode === "list" ? (
          <div className="grid gap-4">
            {searchedTasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                open={openId === task.id}
                onToggle={() => setOpenId(openId === task.id ? null : task.id)}
                onPatch={(patch) => patchTask(task.id, patch)}
                onError={setError}
                teamMembers={teamMembers}
                onDuplicate={duplicateTask}
                taskDeps={taskDeps}
                allTasks={tasks}
                teams={teams}
                keyResults={keyResults}
                currentUserId={currentUserId}
              />
            ))}
          </div>
        ) : viewMode === "priority" ? (
          /* SOW #26: drag a task between priority lanes to reprioritise it. */
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {PRIORITIES.map((p) => (
              <div
                key={p.value}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (draggedTask) {
                    patchTask(draggedTask, { priority: p.value } as Partial<Task>);
                    setDraggedTask(null);
                  }
                }}
                className="bg-slate-800 rounded p-4 border border-slate-700"
              >
                <h3 className="font-bold mb-4 text-slate-300">{p.label}</h3>
                <div className="space-y-3">
                  {searchedTasks
                    .filter((t) => t.priority === p.value)
                    .map((task) => (
                      <div
                        key={task.id}
                        draggable
                        onDragStart={() => setDraggedTask(task.id)}
                        onDragEnd={() => setDraggedTask(null)}
                        onClick={() => setOpenId(task.id)}
                        className={`bg-slate-900 p-3 rounded border border-slate-700 cursor-pointer hover:border-blue-500 text-sm ${
                          draggedTask === task.id ? "opacity-40" : ""
                        }`}
                      >
                        <p className="font-bold mb-1">{task.title}</p>
                        <div className="flex justify-between text-xs text-slate-500">
                          <span>
                            {STATUSES.find((s) => s.value === task.status)?.label}
                          </span>
                          <span>{task.progress_percent}%</span>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            ))}
          </div>
        ) : viewMode === "gantt" ? (
          /* SOW #9: GANTT-style timeline. Bars span creation date to due date,
             coloured by status, with today marked. */
          <GanttView tasks={searchedTasks} onOpen={(id) => setOpenId(id)} />
        ) : (
          /* Board view */
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            {["pending", "in_progress", "need_help", "done", "closed"].map((status) => (
              <div
                key={status}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (draggedTask) {
                    patchTask(draggedTask, { status } as Partial<Task>);
                    setDraggedTask(null);
                  }
                }}
                className="bg-slate-800 rounded p-4 border border-slate-700"
              >
                <h3 className="font-bold mb-4 capitalize text-slate-300">
                  {STATUSES.find((s) => s.value === status)?.label ?? status.replace(/_/g, " ")}
                </h3>
                <div className="space-y-3">
                  {(groupedByStatus[status] || []).map((task) => (
                    <div
                      key={task.id}
                      draggable
                      onDragStart={() => setDraggedTask(task.id)}
                      onDragEnd={() => setDraggedTask(null)}
                      onClick={() => setOpenId(task.id)}
                      className={`bg-slate-900 p-3 rounded border border-slate-700 cursor-pointer hover:border-blue-500 text-sm ${
                        draggedTask === task.id ? "opacity-40" : ""
                      }`}
                    >
                      <p className="font-bold mb-1">{task.title}</p>
                      <div className="flex justify-between text-xs text-slate-500 mb-2">
                        <span>{task.priority}</span>
                        <span>{task.progress_percent}%</span>
                      </div>
                      <div className="w-full bg-slate-800 rounded h-1.5">
                        <div
                          className="bg-blue-600 h-1.5 rounded"
                          style={{ width: `${task.progress_percent}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Task detail modal */}
        {openId && (
          <TaskDetail
            taskId={openId}
            tasks={tasks}
            onClose={() => setOpenId(null)}
            onPatch={patchTask}
            onError={setError}
            teamMembers={teamMembers}
            onDuplicate={duplicateTask}
            projects={projects}
            taskDeps={taskDeps}
            teams={teams}
            keyResults={keyResults}
            currentUserId={currentUserId}
          />
        )}
      </div>
    </div>
  );
}

type Comment = { id: string; content: string; created_at: string };
type Attachment = { id: string; file_name: string; file_url: string; file_size: number | null; visibility: string | null; uploaded_by: string | null; created_at: string };
type Subtask = { id: string; title: string; done: boolean; progress_percent: number; position: number | null; assigned_to: string | null };
type Activity = { id: string; action: string; created_at: string };

function TaskCard({
  task,
  open,
  onToggle,
  onPatch,
  onError,
  teamMembers,
  onDuplicate,
  taskDeps,
  allTasks,
  teams,
  keyResults,
  currentUserId,
}: {
  task: Task;
  open: boolean;
  onToggle: () => void;
  onPatch: (patch: Partial<Task>) => void;
  onError: (msg: string) => void;
  teamMembers: TeamMember[];
  onDuplicate?: (id: string) => void;
  taskDeps?: Record<string, string[]>;
  allTasks?: Task[];
  teams?: { id: string; name: string }[];
  keyResults?: { id: string; title: string }[];
  currentUserId?: string | null;
}) {
  // DOCX #2: only the assignor or the named task manager may move a deadline.
  // Everyone else files an extension request instead.
  const [comments, setComments] = useState<Comment[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [subtasks, setSubtasks] = useState<Subtask[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [newComment, setNewComment] = useState("");
  const [posting, setPosting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [pendingChanges, setPendingChanges] = useState<Record<string, any>>({});
  const [taskDependencies, setTaskDependencies] = useState<string[]>([]);
  const [newSubtask, setNewSubtask] = useState("");
  const [extensions, setExtensions] = useState<any[]>([]);
  const [extReason, setExtReason] = useState("");
  const [extDate, setExtDate] = useState("");
  const [depsLoading, setDepsLoading] = useState(false);
  // SOW #44: more than one person can be an assignor on a task.
  const [assignors, setAssignors] = useState<{ id: string; user_id: string }[]>([]);

  // DOCX #2: only the assignor, a named task manager, or anyone added as an
  // extra assignor (SOW #44) may move a deadline.
  const canChangeDueDate =
    !currentUserId ||
    task.created_by === currentUserId ||
    task.task_manager_id === currentUserId ||
    assignors.some((x) => x.user_id === currentUserId);

  useEffect(() => {
    if (!open || loaded) return;
    (async () => {
      try {
        const [c, a, s, l, d, x, g] = await Promise.all([
          fetch(`/api/tasks/${task.id}/comments`),
          fetch(`/api/tasks/${task.id}/attachments`),
          fetch(`/api/tasks/${task.id}/subtasks`),
          fetch(`/api/tasks/${task.id}/activity`),
          fetch(`/api/tasks/${task.id}/dependencies`),
          fetch(`/api/tasks/${task.id}/extension`),
          fetch(`/api/tasks/${task.id}/assignors`),
        ]);
        if (c.ok) setComments(await c.json());
        if (a.ok) setAttachments(await a.json());
        if (s.ok) setSubtasks(await s.json());
        if (l.ok) setActivity(await l.json());
        if (d.ok) {
          const deps = await d.json();
          setTaskDependencies((deps || []).map((r: any) => r.depends_on_task_id));
        }
        if (x.ok) setExtensions(await x.json());
        if (g.ok) setAssignors(await g.json());
        setLoaded(true);
      } catch {
        onError("Could not load task details");
      }
    })();
  }, [open, loaded, task.id, onError]);

  const postComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newComment.trim()) return;
    setPosting(true);
    try {
      const res = await fetch(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: newComment.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not post comment");
      setComments([data, ...comments]);
      // parseAndNotifyMentions(newComment, task.id, task.id);
      setNewComment("");
    } catch (e: any) {
      onError(e.message);
    } finally {
      setPosting(false);
    }
  };

  const uploadFile = async (file: File) => {
    setUploading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`/api/tasks/${task.id}/attachments`, {
        method: "POST",
        body,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      setAttachments([data, ...attachments]);
    } catch (e: any) {
      onError(e.message);
    } finally {
      setUploading(false);
    }
  };

  const assigneeLabel = teamMembers.find((m) => m.id === task.assigned_to)?.name || "Unassigned";

  return (
    <div className="bg-slate-800 rounded border border-slate-700">
      <div onClick={onToggle} className={`p-4 cursor-pointer hover:border-blue-500 ${isOverdue(task) ? "border-l-4 border-red-500 bg-red-950 bg-opacity-20" : ""}`}>
        <div className="flex justify-between items-start gap-3 mb-2">
          <h3 className={`font-bold text-lg ${isOverdue(task) ? "text-red-400" : ""}`}>
            {task.title}
            {isOverdue(task) && (
              <span className="ml-2 text-xs text-red-400 font-normal">OVERDUE</span>
            )}
          </h3>
          <span className={`text-xs px-2 py-1 rounded ${statusClass(task.status)}`}>
            {STATUSES.find((s) => s.value === task.status)?.label}
          </span>
        </div>
        {task.description && <p className="text-slate-400 text-sm mb-2">{task.description}</p>}
        <div className="flex flex-wrap gap-4 text-xs text-slate-500 mb-2">
          <span>{PRIORITIES.find((p) => p.value === task.priority)?.label}</span>
          <span>{task.progress_percent}%</span>
          {task.due_date && <span>Due {formatDue(task.due_date)}</span>}
          {task.milestone && <span>📍 {task.milestone}</span>}
          {taskDeps && taskDeps[task.id] && taskDeps[task.id].length > 0 && (
            <span className="text-yellow-500">🔗 {taskDeps[task.id].length} dep</span>
          )}
          <span className="ml-auto">👤 {assigneeLabel}</span>
        </div>
        <div className="w-full bg-slate-900 rounded h-2">
          <div className="bg-blue-600 h-2 rounded" style={{ width: `${task.progress_percent}%` }} />
        </div>
      </div>

      {open && (
        <div className="border-t border-slate-700 p-4 space-y-6 max-h-96 overflow-y-auto">
          <div className="flex flex-wrap gap-3">
            <select
              value={task.status}
              onChange={(e) => onPatch({ status: e.target.value })}
              className="px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm"
            >
              {STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <select
              value={task.priority}
              onChange={(e) => onPatch({ priority: e.target.value })}
              className="px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm"
            >
              {PRIORITIES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            <input
              type="datetime-local"
              value={task.due_date ? toLocalInput(task.due_date) : ""}
              onChange={(e) => onPatch({ due_date: e.target.value || null })}
              disabled={!canChangeDueDate}
              title={
                canChangeDueDate
                  ? "Due date and time"
                  : "Only the assignor can change this. Request an extension below."
              }
              className={`px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm ${
                canChangeDueDate ? "" : "opacity-50 cursor-not-allowed"
              }`}
            />
            {/* SOW #41: assign to a whole team, not just a person */}
            {teams && teams.length > 0 && (
              <select
                value={task.team_id || ""}
                onChange={(e) => onPatch({ team_id: e.target.value || null } as Partial<Task>)}
                className="px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm"
              >
                <option value="">No team</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    👥 {t.name}
                  </option>
                ))}
              </select>
            )}

            {/* SOW #13: name a task manager for work given to a team */}
            <select
              value={task.task_manager_id || ""}
              onChange={(e) =>
                onPatch({ task_manager_id: e.target.value || null } as Partial<Task>)
              }
              className="px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm"
            >
              <option value="">No task manager</option>
              {teamMembers.map((m) => (
                <option key={m.id} value={m.id}>
                  ⭐ {m.name || m.email}
                </option>
              ))}
            </select>

            {/* SOW #36: link this task to a key result */}
            {keyResults && keyResults.length > 0 && (
              <select
                value={task.key_result_id || ""}
                onChange={(e) =>
                  onPatch({ key_result_id: e.target.value || null } as Partial<Task>)
                }
                className="px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm"
              >
                <option value="">Not linked to an OKR</option>
                {keyResults.map((k) => (
                  <option key={k.id} value={k.id}>
                    🎯 {k.title}
                  </option>
                ))}
              </select>
            )}

            {/* Feature 13: Assignee dropdown */}
            <select
              value={task.assigned_to || ""}
              onChange={(e) => onPatch({ assigned_to: e.target.value || null })}
              className="px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm"
            >
              <option value="">Assign to...</option>
              {teamMembers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <select
              value={pendingChanges.milestone !== undefined ? (pendingChanges.milestone || "") : (task.milestone || "")}
              onChange={(e) => setPendingChanges({ ...pendingChanges, milestone: e.target.value || null })}
              className="px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm"
            >
              <option value="">Milestone...</option>
              <option value="phase1">Phase 1</option>
              <option value="phase2">Phase 2</option>
              <option value="phase3">Phase 3</option>
              <option value="launch">Launch</option>
              <option value="review">Review</option>
            </select>
            
            {Object.keys(pendingChanges).length > 0 && (
              <button
                onClick={() => {
                  onPatch(pendingChanges);
                  setPendingChanges({});
                }}
                className="px-4 py-2 bg-green-600 hover:bg-green-700 rounded text-sm font-bold"
              >
                💾 Save Changes
              </button>
            )}
          </div>

          <div>
            <p className="text-sm font-bold mb-2">Progress: {task.progress_percent}%</p>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={task.progress_percent}
              onChange={(e) => onPatch({ progress_percent: Number(e.target.value) })}
              className="w-full"
            />
          </div>

          {/* SOW #34: measure progress as a count or an amount, and let the
              percentage follow from what the assignee actually reports. */}
          <div className="mt-4">
            <p className="text-sm font-bold mb-2">Quantified target</p>
            <div className="flex flex-wrap gap-2 items-center">
              <select
                value={task.progress_type || "percent"}
                onChange={(e) =>
                  onPatch({ progress_type: e.target.value } as Partial<Task>)
                }
                className="px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm"
              >
                <option value="percent">Percentage</option>
                <option value="number">Number of units</option>
                <option value="amount">Amount</option>
              </select>

              {(task.progress_type === "number" || task.progress_type === "amount") && (
                <>
                  <input
                    type="number"
                    min="0"
                    value={task.progress_current ?? 0}
                    placeholder="Done"
                    onChange={(e) => {
                      const current = Number(e.target.value);
                      const target = Number(task.progress_target) || 0;
                      // Keep the headline percentage in step with the count.
                      const pct = target > 0
                        ? Math.min(Math.round((current / target) * 100), 100)
                        : task.progress_percent;
                      onPatch({
                        progress_current: current,
                        progress_percent: pct,
                      } as Partial<Task>);
                    }}
                    className="w-24 px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm"
                  />
                  <span className="text-slate-400 text-sm">of</span>
                  <input
                    type="number"
                    min="0"
                    value={task.progress_target ?? 0}
                    placeholder="Target"
                    onChange={(e) => {
                      const target = Number(e.target.value);
                      const current = Number(task.progress_current) || 0;
                      const pct = target > 0
                        ? Math.min(Math.round((current / target) * 100), 100)
                        : task.progress_percent;
                      onPatch({
                        progress_target: target,
                        progress_percent: pct,
                      } as Partial<Task>);
                    }}
                    className="w-24 px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm"
                  />
                  <span className="text-xs text-slate-500">
                    {task.progress_type === "amount" ? "amount" : "units"}
                  </span>
                </>
              )}
            </div>
          </div>

          <div>
            {/* SOW #44: several people can hold assignor rights on one task. */}
            <p className="text-sm font-bold mb-2">
              Assignors ({assignors.length + 1})
            </p>
            <div className="mb-4">
              <div className="flex flex-wrap gap-2 mb-2">
                <span className="px-2 py-1 bg-slate-700 rounded text-xs">
                  {teamMembers.find((m) => m.id === task.created_by)?.name ||
                    "Creator"}{" "}
                  <span className="text-slate-400">(created)</span>
                </span>
                {assignors.map((x) => (
                  <span
                    key={x.id}
                    className="px-2 py-1 bg-slate-700 rounded text-xs flex items-center gap-2"
                  >
                    {teamMembers.find((m) => m.id === x.user_id)?.name || "Someone"}
                    <button
                      onClick={async () => {
                        const removed = x;
                        setAssignors((prev) => prev.filter((y) => y.id !== x.id));
                        try {
                          await sendJSON(
                            `/api/tasks/${task.id}/assignors`,
                            "DELETE",
                            { user_id: x.user_id }
                          );
                        } catch (err: any) {
                          setAssignors((prev) => [...prev, removed]);
                          onError(err.message || "Could not remove assignor");
                        }
                      }}
                      className="text-slate-400 hover:text-red-400"
                      title="Remove assignor"
                    >
                      x
                    </button>
                  </span>
                ))}
              </div>
              <select
                value=""
                onChange={async (e) => {
                  const userId = e.target.value;
                  if (!userId) return;
                  try {
                    const added = await sendJSON(
                      `/api/tasks/${task.id}/assignors`,
                      "POST",
                      { user_id: userId }
                    );
                    setAssignors((prev) => [...prev, added]);
                  } catch (err: any) {
                    onError(err.message || "Could not add assignor");
                  }
                }}
                className="px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm"
              >
                <option value="">Add an assignor...</option>
                {teamMembers
                  .filter(
                    (m) =>
                      m.id !== task.created_by &&
                      !assignors.some((x) => x.user_id === m.id)
                  )
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </select>
            </div>

            <p className="text-sm font-bold mb-2">Attachments ({attachments.length})</p>
            {attachments.length > 0 && (
              <div className="space-y-1 mb-3">
                {attachments.map((a) => (
                  <div key={a.id} className="flex items-center gap-2">
                    <a
                      href={a.file_url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex-1 text-blue-400 hover:underline text-sm truncate"
                    >
                      {a.visibility === "restricted" && "🔒 "}
                      {a.file_name}
                    </a>
                    {/* SOW #32: restrict a document to the uploader and assignor. */}
                    <select
                      value={a.visibility || "all"}
                      onChange={async (e) => {
                        const val = e.target.value;
                        const before = a.visibility || "all";
                        setAttachments((prev) =>
                          prev.map((x) =>
                            x.id === a.id ? { ...x, visibility: val } : x
                          )
                        );
                        try {
                          const res = await fetch(
                            `/api/tasks/${task.id}/attachments`,
                            {
                              method: "PUT",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                attachment_id: a.id,
                                visibility: val,
                              }),
                            }
                          );
                          // fetch only rejects on network failure, so a 403
                          // from the server has to be checked explicitly.
                          if (!res.ok) {
                            const body = await res.json().catch(() => ({}));
                            throw new Error(
                              body?.error || "Could not change file access"
                            );
                          }
                        } catch (err: any) {
                          setAttachments((prev) =>
                            prev.map((x) =>
                              x.id === a.id ? { ...x, visibility: before } : x
                            )
                          );
                          onError(err.message || "Could not change file access");
                        }
                      }}
                      className="px-2 py-1 bg-slate-900 border border-slate-600 rounded text-xs shrink-0"
                    >
                      <option value="all">Everyone</option>
                      <option value="restricted">Restricted</option>
                    </select>
                  </div>
                ))}
              </div>
            )}
            <label className="inline-block">
              <input
                type="file"
                className="hidden"
                disabled={uploading}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadFile(f);
                  e.target.value = "";
                }}
              />
              <span className="bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded text-sm cursor-pointer inline-block">
                {uploading ? "Uploading..." : "Upload"}
              </span>
            </label>
          </div>

          <div>
            <p className="text-sm font-bold mb-2">Comments ({comments.length})</p>
            <form onSubmit={postComment} className="mb-3">
              <textarea
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder="Add a comment..."
                rows={2}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded mb-2 resize-none text-sm"
              />
              <button
                type="submit"
                disabled={posting || !newComment.trim()}
                className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-3 py-1.5 rounded text-sm"
              >
                {posting ? "Posting..." : "Post"}
              </button>
            </form>
            <div className="space-y-2">
              {comments.map((c) => (
                <div key={c.id} className="bg-slate-900 px-3 py-2 rounded text-sm flex justify-between gap-2">
                  <div className="flex-1">
                    <p className="text-slate-300">{c.content}</p>
                    <p className="text-slate-500 text-xs mt-1">{new Date(c.created_at).toLocaleString()}</p>
                  </div>
                  <button
                    onClick={async () => {
                      try {
                        const res = await fetch(`/api/tasks/${task.id}/comments/delete`, {
                          method: "DELETE",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ commentId: c.id }),
                        });
                        if (!res.ok) throw new Error("Could not delete");
                        setComments((prev) => prev.filter((x) => x.id !== c.id));
                      } catch (e: any) {
                        onError(e.message);
                      }
                    }}
                    className="text-slate-500 hover:text-red-400 text-xs shrink-0"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* SOW #45: overdue module - reason for delay and extension approval */}
          {(isOverdue(task) || extensions.length > 0) && (
            <div className="mt-6 pt-4 border-t border-slate-700">
              <h4 className="text-sm font-semibold text-slate-300 mb-3">
                Deadline extension
              </h4>

              {extensions.map((x) => (
                <div key={x.id} className="bg-slate-700 rounded p-3 mb-3 text-sm">
                  <div className="flex justify-between items-start gap-2 mb-1">
                    <span className="text-slate-300">{x.reason}</span>
                    <span
                      className={`text-xs shrink-0 ${
                        x.status === "approved"
                          ? "text-green-400"
                          : x.status === "rejected"
                          ? "text-red-400"
                          : "text-yellow-400"
                      }`}
                    >
                      {x.status}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400">
                    Asked for {new Date(x.requested_date).toLocaleString()}
                    {x.approved_date &&
                      ` - granted ${new Date(x.approved_date).toLocaleString()}`}
                  </p>

                  {x.status === "pending" && (
                    <div className="flex gap-2 mt-2">
                      <button
                        onClick={async () => {
                          try {
                            const res = await fetch(`/api/tasks/${task.id}/extension`, {
                              method: "PUT",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                request_id: x.id,
                                status: "approved",
                              }),
                            });
                            const b = await res.json();
                            if (!res.ok) throw new Error(b?.error || "Could not approve");
                            setExtensions((prev) =>
                              prev.map((r) =>
                                r.id === x.id
                                  ? { ...r, status: "approved", approved_date: r.requested_date }
                                  : r
                              )
                            );
                            onPatch({ due_date: x.requested_date });
                          } catch (err: any) {
                            onError(err.message);
                          }
                        }}
                        className="px-3 py-1 bg-green-700 hover:bg-green-600 rounded text-xs"
                      >
                        Approve
                      </button>
                      <button
                        onClick={async () => {
                          try {
                            const res = await fetch(`/api/tasks/${task.id}/extension`, {
                              method: "PUT",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                request_id: x.id,
                                status: "rejected",
                              }),
                            });
                            const b = await res.json();
                            if (!res.ok) throw new Error(b?.error || "Could not reject");
                            setExtensions((prev) =>
                              prev.map((r) =>
                                r.id === x.id ? { ...r, status: "rejected" } : r
                              )
                            );
                          } catch (err: any) {
                            onError(err.message);
                          }
                        }}
                        className="px-3 py-1 bg-slate-600 hover:bg-slate-500 rounded text-xs"
                      >
                        Reject
                      </button>
                    </div>
                  )}
                </div>
              ))}

              {isOverdue(task) && (
                <div className="space-y-2">
                  <input
                    value={extReason}
                    onChange={(e) => setExtReason(e.target.value)}
                    placeholder="Reason for the delay..."
                    className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm placeholder-slate-500"
                  />
                  <div className="flex gap-2">
                    <input
                      type="datetime-local"
                      value={extDate}
                      onChange={(e) => setExtDate(e.target.value)}
                      className="px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm"
                    />
                    <button
                      onClick={async () => {
                        if (!extReason.trim() || !extDate) {
                          onError("Give a reason and a new date");
                          return;
                        }
                        try {
                          const res = await fetch(`/api/tasks/${task.id}/extension`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              reason: extReason.trim(),
                              requested_date: extDate,
                            }),
                          });
                          const b = await res.json();
                          if (!res.ok) throw new Error(b?.error || "Could not send request");
                          setExtensions((prev) => [b, ...prev]);
                          setExtReason("");
                          setExtDate("");
                        } catch (err: any) {
                          onError(err.message);
                        }
                      }}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm"
                    >
                      Request extension
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* SOW #14: subtasks, each assignable to a team member */}
          <div className="mt-6 pt-4 border-t border-slate-700">
            <h4 className="text-sm font-semibold text-slate-300 mb-3">
              Subtasks ({subtasks.filter((st) => st.done).length}/{subtasks.length})
            </h4>

            {subtasks.length > 0 && (
              <div className="space-y-2 mb-3">
                {subtasks.map((st) => (
                  <div
                    key={st.id}
                    className="bg-slate-700 px-3 py-2 rounded flex items-center gap-2 flex-wrap"
                  >
                    <input
                      type="checkbox"
                      checked={st.done}
                      onChange={async () => {
                        const next = !st.done;
                        setSubtasks((prev) =>
                          prev.map((x) => (x.id === st.id ? { ...x, done: next } : x))
                        );
                        try {
                          await sendJSON(`/api/tasks/${task.id}/subtasks`, "PUT", {
                            subtask_id: st.id,
                            done: next,
                          });
                        } catch (err: any) {
                          setSubtasks((prev) =>
                            prev.map((x) =>
                              x.id === st.id ? { ...x, done: !next } : x
                            )
                          );
                          onError(err.message || "Could not update subtask");
                        }
                      }}
                    />
                    <div className="flex-1 min-w-32">
                      <span
                        className={`text-sm ${
                          st.done ? "line-through text-slate-500" : "text-slate-300"
                        }`}
                      >
                        {st.title}
                      </span>
                      <div className="flex items-center gap-2 mt-1">
                        <input
                          type="range"
                          min="0"
                          max="100"
                          step="5"
                          value={st.done ? 100 : st.progress_percent ?? 0}
                          onChange={async (e) => {
                            const val = Number(e.target.value);
                            const before = st.progress_percent ?? 0;
                            setSubtasks((prev) =>
                              prev.map((x) =>
                                x.id === st.id ? { ...x, progress_percent: val } : x
                              )
                            );
                            try {
                              const res = await fetch(
                                `/api/tasks/${task.id}/subtasks`,
                                {
                                  method: "PUT",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({
                                    subtask_id: st.id,
                                    progress_percent: val,
                                  }),
                                }
                              );
                              if (!res.ok) {
                                const body = await res.json().catch(() => ({}));
                                throw new Error(
                                  body?.error || "Could not update subtask progress"
                                );
                              }
                            } catch (err: any) {
                              setSubtasks((prev) =>
                                prev.map((x) =>
                                  x.id === st.id
                                    ? { ...x, progress_percent: before }
                                    : x
                                )
                              );
                              onError(
                                err.message || "Could not update subtask progress"
                              );
                            }
                          }}
                          className="flex-1 h-1"
                        />
                        <span className="text-xs text-slate-500 w-9 text-right">
                          {st.done ? 100 : st.progress_percent ?? 0}%
                        </span>
                      </div>
                    </div>

                    <select
                      value={st.assigned_to || ""}
                      onChange={async (e) => {
                        const val = e.target.value || null;
                        const before = st.assigned_to;
                        setSubtasks((prev) =>
                          prev.map((x) => (x.id === st.id ? { ...x, assigned_to: val } : x))
                        );
                        try {
                          await sendJSON(`/api/tasks/${task.id}/subtasks`, "PUT", {
                            subtask_id: st.id,
                            assigned_to: val,
                          });
                        } catch (err: any) {
                          setSubtasks((prev) =>
                            prev.map((x) =>
                              x.id === st.id ? { ...x, assigned_to: before } : x
                            )
                          );
                          onError(err.message || "Could not assign subtask");
                        }
                      }}
                      className="px-2 py-1 bg-slate-900 border border-slate-600 rounded text-xs"
                    >
                      <option value="">Unassigned</option>
                      {teamMembers.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name || m.email}
                        </option>
                      ))}
                    </select>

                    <button
                      onClick={async () => {
                        const removed = st;
                        setSubtasks((prev) => prev.filter((x) => x.id !== st.id));
                        try {
                          await sendJSON(`/api/tasks/${task.id}/subtasks`, "DELETE", {
                            subtask_id: st.id,
                          });
                        } catch (err: any) {
                          // Put it back where it was, not at the end.
                          setSubtasks((prev) =>
                            [...prev, removed].sort(
                              (a, b) => (a.position ?? 0) - (b.position ?? 0)
                            )
                          );
                          onError(err.message || "Could not delete subtask");
                        }
                      }}
                      className="text-slate-500 hover:text-red-400 text-xs"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <input
                value={newSubtask}
                onChange={(e) => setNewSubtask(e.target.value)}
                placeholder="Add a subtask..."
                className="flex-1 px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm placeholder-slate-500"
              />
              <button
                onClick={async () => {
                  if (!newSubtask.trim()) return;
                  try {
                    const res = await fetch(`/api/tasks/${task.id}/subtasks`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ title: newSubtask.trim() }),
                    });
                    const body = await res.json();
                    if (!res.ok) throw new Error(body?.error || "Could not add subtask");
                    setSubtasks((prev) => [...prev, body]);
                    setNewSubtask("");
                  } catch (err: any) {
                    onError(err.message);
                  }
                }}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm"
              >
                Add
              </button>
            </div>
          </div>

          {/* SOW #15: dependencies with picker */}
          <div className="mt-6 pt-4 border-t border-slate-700">
            <h4 className="text-sm font-semibold text-slate-300 mb-3">
              Dependencies (what this task depends on)
            </h4>

            {taskDependencies.length > 0 ? (
              <div className="space-y-2 mb-3">
                {taskDependencies.map((depId) => {
                  const depTask = (allTasks || []).find((t) => t.id === depId);
                  return (
                    <div
                      key={depId}
                      className="bg-slate-700 px-3 py-2 rounded text-sm text-slate-300 flex justify-between items-center gap-2"
                    >
                      <span>🔗 {depTask ? depTask.title : "Task not in current view"}</span>
                      <button
                        onClick={async () => {
                          try {
                            const res = await fetch(`/api/tasks/${task.id}/dependencies`, {
                              method: "DELETE",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ depends_on_task_id: depId }),
                            });
                            const body = await res.json();
                            if (!res.ok) throw new Error(body?.error || "Could not remove");
                            setTaskDependencies((prev) => prev.filter((x) => x !== depId));
                          } catch (err: any) {
                            onError(err.message);
                          }
                        }}
                        className="text-slate-500 hover:text-red-400 text-xs shrink-0"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-slate-500 mb-3">No dependencies</p>
            )}

            <select
              value=""
              onChange={async (e) => {
                const depId = e.target.value;
                if (!depId) return;
                try {
                  const res = await fetch(`/api/tasks/${task.id}/dependencies`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ depends_on_task_id: depId }),
                  });
                  const body = await res.json();
                  if (!res.ok) throw new Error(body?.error || "Could not add dependency");
                  setTaskDependencies((prev) => [...prev, depId]);
                } catch (err: any) {
                  onError(err.message);
                }
              }}
              className="px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm w-full"
            >
              <option value="">+ Add a dependency...</option>
              {(allTasks || [])
                .filter((t) => t.id !== task.id && !taskDependencies.includes(t.id))
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
            </select>
          </div>

        </div>
      )}
    </div>
  );
}

function TaskDetail({
  taskId,
  tasks,
  onClose,
  onPatch,
  onError,
  teamMembers,
  onDuplicate,
  projects,
  taskDeps,
  teams,
  keyResults,
  currentUserId,
}: {
  taskId: string;
  tasks: Task[];
  onClose: () => void;
  onPatch: (id: string, patch: Partial<Task>) => void;
  onError: (msg: string) => void;
  teamMembers: TeamMember[];
  onDuplicate?: (id: string, targetProjectId?: string) => void;
  projects?: { id: string; name: string }[];
  taskDeps?: Record<string, string[]>;
  teams?: { id: string; name: string }[];
  keyResults?: { id: string; title: string }[];
  currentUserId?: string | null;
}) {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded border border-slate-700 max-w-2xl w-full max-h-[85vh] sm:max-h-96 overflow-y-auto">
        <div className="p-4 border-b border-slate-700">
          <div className="flex justify-between items-start mb-3">
            <h2 className="text-xl font-bold">{task.title}</h2>
            <button onClick={onClose} className="text-slate-400 hover:text-white">
              ✕
            </button>
          </div>
          {onDuplicate && (
            <div className="flex flex-wrap gap-2 items-center">
              <button
                onClick={() => {
                  onDuplicate(task.id);
                  onClose();
                }}
                className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm"
              >
                📋 Duplicate here
              </button>
              {/* SOW #24: ask the assignee for a progress update */}
              <button
                onClick={async () => {
                  try {
                    const res = await fetch(`/api/tasks/${task.id}/remind`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ kind: "update_request" }),
                    });
                    const body = await res.json();
                    if (!res.ok) throw new Error(body?.error || "Could not send");
                    onError("Update request sent to the assignee.");
                  } catch (err: any) {
                    onError(err.message);
                  }
                }}
                className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm"
              >
                🔔 Request update
              </button>
              {/* SOW #39: manual reminder */}
              <button
                onClick={async () => {
                  try {
                    const res = await fetch(`/api/tasks/${task.id}/remind`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ kind: "reminder" }),
                    });
                    const body = await res.json();
                    if (!res.ok) throw new Error(body?.error || "Could not send");
                    onError("Reminder sent to the assignee.");
                  } catch (err: any) {
                    onError(err.message);
                  }
                }}
                className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm"
              >
                ⏰ Send reminder
              </button>
              {/* SOW #11/#12: keep this task as a reusable template */}
              <button
                onClick={async () => {
                  try {
                    const res = await fetch("/api/templates", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ from_task_id: task.id }),
                    });
                    const b = await res.json();
                    if (!res.ok) throw new Error(b?.error || "Could not save template");
                    onError("Saved as a template.");
                  } catch (err: any) {
                    onError(err.message);
                  }
                }}
                className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm"
              >
                📄 Save as template
              </button>
              {/* SOW #12: archive a finished task, or restore it as a template */}
              <button
                onClick={() => {
                  onPatch(task.id, {
                    archived_at: task.archived_at ? null : new Date().toISOString(),
                  } as Partial<Task>);
                  onClose();
                }}
                className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm"
              >
                {task.archived_at ? "♻️ Restore" : "🗄️ Archive"}
              </button>
              {/* SOW #16: copy this task into a different project */}
              {projects && projects.length > 0 && (
                <select
                  value=""
                  onChange={(e) => {
                    if (!e.target.value) return;
                    onDuplicate(task.id, e.target.value);
                    onClose();
                  }}
                  className="px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm"
                >
                  <option value="">Copy into another project...</option>
                  {projects
                    .filter((pr) => pr.id !== task.project_id)
                    .map((pr) => (
                      <option key={pr.id} value={pr.id}>
                        {pr.name}
                      </option>
                    ))}
                </select>
              )}
            </div>
          )}
        </div>
        <TaskCard
          task={task}
          open={true}
          onToggle={() => {}}
          onPatch={(patch) => onPatch(task.id, patch)}
          onError={onError}
          teamMembers={teamMembers}
          taskDeps={taskDeps}
          allTasks={tasks}
          teams={teams}
          keyResults={keyResults}
        />
      </div>
    </div>
  );
}

function GanttView({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: string) => void }) {
  const dated = tasks.filter((t) => t.due_date);
  if (dated.length === 0) {
    return <p className="text-slate-400">No tasks with due dates to plot.</p>;
  }

  // Work out the window the chart has to cover.
  const times: number[] = [];
  dated.forEach((t) => {
    times.push(new Date(t.created_at).getTime());
    if (t.due_date) times.push(new Date(t.due_date).getTime());
  });
  const now = Date.now();
  times.push(now);

  const min = Math.min(...times);
  const max = Math.max(...times);
  const span = Math.max(max - min, 1);

  const pct = (ms: number) => ((ms - min) / span) * 100;

  const statusColor: Record<string, string> = {
    done: "bg-green-600",
    in_progress: "bg-blue-600",
    need_help: "bg-yellow-600",
    pending: "bg-slate-600",
  };

  return (
    <div className="bg-slate-800 border border-slate-700 rounded p-4 overflow-x-auto">
      <div className="flex justify-between text-xs text-slate-500 mb-3">
        <span>{new Date(min).toLocaleDateString()}</span>
        <span>{new Date(max).toLocaleDateString()}</span>
      </div>

      <div className="space-y-2 relative">
        {/* today marker */}
        <div
          className="absolute top-0 bottom-0 w-px bg-red-500 z-10"
          style={{ left: `${pct(now)}%` }}
          title="Today"
        />

        {dated.map((t) => {
          const start = new Date(t.created_at).getTime();
          const end = new Date(t.due_date as string).getTime();
          const left = pct(Math.min(start, end));
          const width = Math.max(pct(Math.max(start, end)) - left, 1.5);
          return (
            <div
              key={t.id}
              onClick={() => onOpen(t.id)}
              className="cursor-pointer group"
            >
              <p className="text-xs text-slate-400 mb-1 truncate">{t.title}</p>
              <div className="relative h-5 bg-slate-900 rounded">
                <div
                  className={`absolute h-5 rounded ${statusColor[t.status] || "bg-slate-600"} group-hover:opacity-80`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${t.title} - due ${new Date(t.due_date as string).toLocaleDateString()}`}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-4 mt-4 pt-3 border-t border-slate-700 text-xs text-slate-400">
        <span><span className="inline-block w-3 h-3 bg-slate-600 rounded mr-1" />Pending</span>
        <span><span className="inline-block w-3 h-3 bg-blue-600 rounded mr-1" />In progress</span>
        <span><span className="inline-block w-3 h-3 bg-yellow-600 rounded mr-1" />Need help</span>
        <span><span className="inline-block w-3 h-3 bg-green-600 rounded mr-1" />Done</span>
        <span><span className="inline-block w-px h-3 bg-red-500 mr-1" />Today</span>
      </div>
    </div>
  );
}
