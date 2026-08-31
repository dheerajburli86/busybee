"use client";

import { useEffect, useState } from "react";

export default function DashboardPage() {
  const [tasks, setTasks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/tasks")
      .then((r) => (r.ok ? r.json() : { tasks: [] }))
      .then((d) => setTasks(d.tasks || []))
      .catch(() => setTasks([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="max-w-7xl mx-auto p-6">
      <h1 className="text-3xl font-bold mb-6">Tasks</h1>
      {loading ? (
        <p className="text-slate-400">Loading...</p>
      ) : tasks.length === 0 ? (
        <p className="text-slate-400">No tasks yet.</p>
      ) : (
        <div className="grid gap-4">
          {tasks.map((task) => (
            <div
              key={task.id}
              className="bg-slate-800 p-4 rounded border border-slate-700"
            >
              <h3 className="font-bold">{task.title}</h3>
              <p className="text-slate-400 text-sm mt-2">{task.description}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
