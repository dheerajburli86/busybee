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
  created_at: string;
};

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

function statusClass(status: string) {
  const map: Record<string, string> = {
    pending: "bg-slate-700 text-slate-300",
    in_progress: "bg-blue-900 text-blue-300",
    done: "bg-green-900 text-green-300",
    need_help: "bg-red-900 text-red-300",
  };
  return map[status] || "bg-slate-700 text-slate-300";
}

function priorityClass(priority: string) {
  const map: Record<string, string> = {
    low: "text-slate-400",
    medium: "text-slate-300",
    high: "text-orange-400",
    super_high: "text-red-400",
  };
  return map[priority] || "text-slate-300";
}

function labelFor(list: { value: string; label: string }[], value: string) {
  return list.find((x) => x.value === value)?.label ?? value;
}

export default function DashboardPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  // create form
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [priority, setPriority] = useState("medium");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/tasks");
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not load tasks");
        setTasks(data.tasks || []);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
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
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-6">
      <h1 className="text-3xl font-bold mb-6">Tasks</h1>

      {error && (
        <div className="bg-red-950 border border-red-800 text-red-300 px-4 py-3 rounded mb-4 text-sm flex justify-between gap-4">
          <span>{error}</span>
          <button onClick={() => setError("")} className="text-red-400 shrink-0">
            dismiss
          </button>
        </div>
      )}

      <form
        onSubmit={createTask}
        className="bg-slate-800 p-4 rounded border border-slate-700 mb-8"
      >
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

      {loading ? (
        <p className="text-slate-400">Loading...</p>
      ) : tasks.length === 0 ? (
        <p className="text-slate-400">No tasks yet. Create one above.</p>
      ) : (
        <div className="grid gap-4">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              open={openId === task.id}
              onToggle={() => setOpenId(openId === task.id ? null : task.id)}
              onPatch={(patch) => patchTask(task.id, patch)}
              onError={setError}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type Comment = { id: string; content: string; created_at: string };
type Attachment = {
  id: string;
  file_name: string;
  file_url: string;
  created_at: string;
};
type Subtask = {
  id: string;
  title: string;
  done: boolean;
  progress_percent: number;
};
type Activity = { id: string; action: string; created_at: string };

function TaskCard({
  task,
  open,
  onToggle,
  onPatch,
  onError,
}: {
  task: Task;
  open: boolean;
  onToggle: () => void;
  onPatch: (patch: Partial<Task>) => void;
  onError: (msg: string) => void;
}) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [subtasks, setSubtasks] = useState<Subtask[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [newComment, setNewComment] = useState("");
  const [posting, setPosting] = useState(false);

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
      setNewComment("");
    } catch (e: any) {
      onError(e.message);
    } finally {
      setPosting(false);
    }
  };

  const doneCount = subtasks.filter((s) => s.done).length;

  return (
    <div className="bg-slate-800 rounded border border-slate-700">
      <div
        onClick={onToggle}
        className="p-4 cursor-pointer hover:border-blue-500"
      >
        <div className="flex justify-between items-start gap-3 mb-2">
          <h3 className="font-bold text-lg">{task.title}</h3>
          <span
            className={`text-xs px-2 py-1 rounded shrink-0 ${statusClass(
              task.status
            )}`}
          >
            {labelFor(STATUSES, task.status)}
          </span>
        </div>
        {task.description && (
          <p className="text-slate-400 text-sm mb-2 whitespace-pre-wrap">
            {task.description}
          </p>
        )}
        <div className="flex flex-wrap gap-4 text-xs mb-2">
          <span className={priorityClass(task.priority)}>
            {labelFor(PRIORITIES, task.priority)}
          </span>
          <span className="text-slate-500">{task.progress_percent}%</span>
          {task.due_date && (
            <span className="text-slate-500">
              Due {new Date(task.due_date).toLocaleDateString()}
            </span>
          )}
        </div>
        <div className="w-full bg-slate-900 rounded h-2">
          <div
            className="bg-blue-600 h-2 rounded transition-all"
            style={{ width: `${task.progress_percent}%` }}
          />
        </div>
      </div>

      {open && (
        <div className="border-t border-slate-700 p-4 space-y-6">
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
          </div>

          <div>
            <p className="text-sm font-bold mb-2">
              Progress: {task.progress_percent}%
            </p>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={task.progress_percent}
              onChange={(e) =>
                onPatch({ progress_percent: Number(e.target.value) })
              }
              className="w-full"
            />
          </div>

          {subtasks.length > 0 && (
            <div>
              <p className="text-sm font-bold mb-2">
                Subtasks ({doneCount}/{subtasks.length})
              </p>
              <div className="space-y-2">
                {subtasks.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center gap-3 bg-slate-900 px-3 py-2 rounded text-sm"
                  >
                    <span className={s.done ? "line-through text-slate-500" : ""}>
                      {s.title}
                    </span>
                    <span className="ml-auto text-xs text-slate-500">
                      {s.progress_percent}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <p className="text-sm font-bold mb-2">
              Attachments ({attachments.length})
            </p>
            {attachments.length === 0 ? (
              <p className="text-slate-500 text-sm">None yet.</p>
            ) : (
              <div className="space-y-1">
                {attachments.map((a) => (
                  <a
                    key={a.id}
                    href={a.file_url}
                    target="_blank"
                    rel="noreferrer"
                    className="block text-blue-400 hover:underline text-sm truncate"
                  >
                    {a.file_name}
                  </a>
                ))}
              </div>
            )}
          </div>

          <div>
            <p className="text-sm font-bold mb-2">Comments ({comments.length})</p>
            <form onSubmit={postComment} className="mb-3">
              <textarea
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder="Add a comment..."
                rows={2}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded mb-2 resize-none text-sm placeholder-slate-500"
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
                <div key={c.id} className="bg-slate-900 px-3 py-2 rounded text-sm">
                  <p className="text-slate-300 whitespace-pre-wrap">{c.content}</p>
                  <p className="text-slate-500 text-xs mt-1">
                    {new Date(c.created_at).toLocaleString()}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {activity.length > 0 && (
            <div>
              <p className="text-sm font-bold mb-2">Activity</p>
              <div className="space-y-1">
                {activity.map((a) => (
                  <p key={a.id} className="text-slate-400 text-xs">
                    {a.action} · {new Date(a.created_at).toLocaleString()}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
