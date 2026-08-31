"use client";

import { useEffect, useState } from "react";
import { TaskDetail } from "@/components/TaskDetail";

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

export default function DashboardPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [priority, setPriority] = useState("medium");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  useEffect(() => {
    loadTasks();
  }, []);

  const loadTasks = async () => {
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
  };

  const handleCreate = async (e: React.FormEvent) => {
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

  if (selectedTask) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <TaskDetail task={selectedTask} />
        <button
          onClick={() => setSelectedTask(null)}
          className="mt-4 text-blue-400 hover:underline"
        >
          ← Back to tasks
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <h1 className="text-3xl font-bold mb-6">Tasks</h1>

      {error && (
        <div className="bg-red-950 border border-red-800 text-red-300 px-4 py-3 rounded mb-4 text-sm">
          {error}
        </div>
      )}

      <form
        onSubmit={handleCreate}
        className="bg-slate-800 p-4 rounded border border-slate-700 mb-6"
      >
        <input
          type="text"
          placeholder="Task title..."
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded mb-3 placeholder-slate-500"
          disabled={creating}
        />
        <textarea
          placeholder="Description (optional)..."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded mb-3 placeholder-slate-500 resize-none"
          rows={2}
          disabled={creating}
        />
        <div className="grid grid-cols-3 gap-3 mb-3">
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="px-3 py-2 bg-slate-900 border border-slate-600 rounded"
            disabled={creating}
          />
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className="px-3 py-2 bg-slate-900 border border-slate-600 rounded"
            disabled={creating}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="super_high">Super High</option>
          </select>
          <button
            type="submit"
            disabled={creating || !title.trim()}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-4 py-2 rounded"
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
            <div
              key={task.id}
              onClick={() => setSelectedTask(task)}
              className="bg-slate-800 p-4 rounded border border-slate-700 cursor-pointer hover:border-blue-500"
            >
              <div className="flex justify-between items-start mb-2">
                <h3 className="font-bold text-lg">{task.title}</h3>
                <span className={`text-xs px-2 py-1 rounded ${getStatusColor(task.status)}`}>
                  {task.status}
                </span>
              </div>
              {task.description && (
                <p className="text-slate-400 text-sm mb-2">{task.description}</p>
              )}
              <div className="flex gap-4 text-xs text-slate-500 mb-2">
                <span>Priority: {task.priority}</span>
                <span>Progress: {task.progress_percent}%</span>
                {task.due_date && (
                  <span>Due: {new Date(task.due_date).toLocaleDateString()}</span>
                )}
              </div>
              <div className="w-full bg-slate-900 rounded h-2">
                <div
                  className="bg-blue-600 h-2 rounded"
                  style={{ width: `${task.progress_percent}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function getStatusColor(status: string) {
  const colors: Record<string, string> = {
    pending: "bg-slate-700 text-slate-300",
    in_progress: "bg-blue-900 text-blue-300",
    done: "bg-green-900 text-green-300",
    need_help: "bg-red-900 text-red-300",
  };
  return colors[status] || "bg-slate-700 text-slate-300";
}
