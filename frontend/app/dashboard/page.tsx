"use client";

import { useEffect, useState } from "react";

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
  created_at: string;
};

type TeamMember = { id: string; name: string; email: string };
type Notification = { id: string; title: string; message: string | null; read: boolean; created_at: string };

const STATUSES = [
  { value: "pending", label: "Pending" },
  { value: "in_progress", label: "In Progress" },
  { value: "done", label: "Done" },
  { value: "need_help", label: "Need Help" },
];

const PRIORITIES = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "super_high", label: "Super High" },
];

function isOverdue(task: { due_date: string | null; status: string }): boolean {
  if (!task.due_date || task.status === "done") return false;
  const due = new Date(task.due_date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return due < today;
}

function statusClass(status: string) {
  const map: Record<string, string> = {
    pending: "bg-slate-700 text-slate-300",
    in_progress: "bg-blue-900 text-blue-300",
    done: "bg-green-900 text-green-300",
    need_help: "bg-red-900 text-red-300",
  };
  return map[status] || "bg-slate-700 text-slate-300";
}

export default function DashboardPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "board">("list");
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
      if (Object.prototype.hasOwnProperty.call(patch, "assigned_to") || patch.status === "done") {
        loadNotifications();
      }
    } catch (e: any) {
      setError(e.message);
    }
  };

  const duplicateTask = async (id: string) => {
    try {
      const res = await fetch(`/api/tasks/${id}/duplicate`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not duplicate task");
      setTasks((prev) => [data.task, ...prev]);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const markNotificationRead = async (id: string) => {
    try {
      await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    } catch (e) {
      console.error(e);
    }
  };

  const searchedTasks = tasks
    .filter((t) =>
      t.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (t.description?.toLowerCase().includes(searchQuery.toLowerCase()) ?? false)
    )
    .filter((t) => (myTasksOnly ? t.assigned_to === currentUserId : true));

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

      <div className="max-w-7xl mx-auto p-6">
        <h2 className="text-3xl font-bold mb-6">Tasks</h2>

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
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              disabled={creating}
              className="px-3 py-2 bg-slate-900 border border-slate-600 rounded"
            />
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
              />
            ))}
          </div>
        ) : (
          /* Board view */
          <div className="grid grid-cols-4 gap-4">
            {["pending", "in_progress", "done", "need_help"].map((status) => (
              <div key={status} className="bg-slate-800 rounded p-4 border border-slate-700">
                <h3 className="font-bold mb-4 capitalize text-slate-300">
                  {status.replace(/_/g, " ")}
                </h3>
                <div className="space-y-3">
                  {(groupedByStatus[status] || []).map((task) => (
                    <div
                      key={task.id}
                      onClick={() => setOpenId(task.id)}
                      className="bg-slate-900 p-3 rounded border border-slate-700 cursor-pointer hover:border-blue-500 text-sm"
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
          />
        )}
      </div>
    </div>
  );
}

type Comment = { id: string; content: string; created_at: string };
type Attachment = { id: string; file_name: string; file_url: string; file_size: number | null; created_at: string };
type Subtask = { id: string; title: string; done: boolean; progress_percent: number };
type Activity = { id: string; action: string; created_at: string };

function TaskCard({
  task,
  open,
  onToggle,
  onPatch,
  onError,
  teamMembers,
  onDuplicate,
}: {
  task: Task;
  open: boolean;
  onToggle: () => void;
  onPatch: (patch: Partial<Task>) => void;
  onError: (msg: string) => void;
  teamMembers: TeamMember[];
  onDuplicate?: (id: string) => void;
}) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [subtasks, setSubtasks] = useState<Subtask[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [newComment, setNewComment] = useState("");
  const [posting, setPosting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [pendingChanges, setPendingChanges] = useState<Record<string, any>>({});

  useEffect(() => {
    if (!open || loaded) return;
    (async () => {
      try {
        const [c, a, s, l] = await Promise.all([
          fetch(`/api/tasks/${task.id}/comments`),
          fetch(`/api/tasks/${task.id}/attachments`),
          fetch(`/api/tasks/${task.id}/subtasks`),
          fetch(`/api/tasks/${task.id}/activity`),
        ]);
        if (c.ok) setComments(await c.json());
        if (a.ok) setAttachments(await a.json());
        if (s.ok) setSubtasks(await s.json());
        if (l.ok) setActivity(await l.json());
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
          {task.due_date && <span>Due {new Date(task.due_date).toLocaleDateString()}</span>}
          {task.milestone && <span>📍 {task.milestone}</span>}
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
              type="date"
              value={task.due_date ? task.due_date.slice(0, 10) : ""}
              onChange={(e) => onPatch({ due_date: e.target.value || null })}
              className="px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm"
            />
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

          <div>
            <p className="text-sm font-bold mb-2">Attachments ({attachments.length})</p>
            {attachments.length > 0 && (
              <div className="space-y-1 mb-3">
                {attachments.map((a) => (
                  <a
                    key={a.id}
                    href={a.file_url}
                    target="_blank"
                    rel="noreferrer"
                    className="block text-blue-400 hover:underline text-sm"
                  >
                    {a.file_name}
                  </a>
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
}: {
  taskId: string;
  tasks: Task[];
  onClose: () => void;
  onPatch: (id: string, patch: Partial<Task>) => void;
  onError: (msg: string) => void;
  teamMembers: TeamMember[];
  onDuplicate?: (id: string) => void;
}) {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded border border-slate-700 max-w-2xl w-full max-h-96 overflow-y-auto">
        <div className="p-4 border-b border-slate-700">
          <div className="flex justify-between items-start mb-3">
            <h2 className="text-xl font-bold">{task.title}</h2>
            <button onClick={onClose} className="text-slate-400 hover:text-white">
              ✕
            </button>
          </div>
          {onDuplicate && (
            <button
              onClick={() => {
                onDuplicate(task.id);
                onClose();
              }}
              className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm"
            >
              📋 Duplicate this task
            </button>
          )}
        </div>
        <TaskCard
          task={task}
          open={true}
          onToggle={() => {}}
          onPatch={(patch) => onPatch(task.id, patch)}
          onError={onError}
          teamMembers={teamMembers}
        />
      </div>
    </div>
  );
}
