"use client";

import { useEffect, useState } from "react";

export default function DashboardPage() {
  const [tasks, setTasks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    loadTasks();
  }, []);

  const loadTasks = async () => {
    try {
      const r = await fetch("/api/tasks");
      if (r.ok) {
        const d = await r.json();
        setTasks(d.tasks || []);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setCreating(true);
    try {
      const r = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          desk_id: "temp-desk",
          project_id: null,
          stage_id: null,
          title: title.trim(),
          description: description.trim() || null,
        }),
      });

      if (r.ok) {
        const d = await r.json();
        setTasks([d.task, ...tasks]);
        setTitle("");
        setDescription("");
      }
    } catch (e) {
      console.error(e);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-6">
      <h1 className="text-3xl font-bold mb-6">Tasks</h1>

      <form
        onSubmit={handleCreate}
        className="bg-slate-800 p-4 rounded border border-slate-700 mb-6"
      >
        <input
          type="text"
          placeholder="Task title..."
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded mb-3 text-white placeholder-slate-500"
          disabled={creating}
        />
        <textarea
          placeholder="Description (optional)..."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded mb-3 text-white placeholder-slate-500 resize-none"
          rows={2}
          disabled={creating}
        />
        <button
          type="submit"
          disabled={creating || !title.trim()}
          className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded"
        >
          {creating ? "Creating..." : "Add Task"}
        </button>
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
              className="bg-slate-800 p-4 rounded border border-slate-700"
            >
              <h3 className="font-bold text-lg">{task.title}</h3>
              {task.description && (
                <p className="text-slate-400 text-sm mt-2">{task.description}</p>
              )}
              <p className="text-slate-500 text-xs mt-3">
                {new Date(task.created_at).toLocaleDateString()}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
