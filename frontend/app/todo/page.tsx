"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

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
  created_at: string;
};

const PRIORITY_LABEL: Record<string, string> = {
  super_high: "Super High",
  high: "High",
  medium: "Medium",
  low: "Low",
};

function isOverdue(t: Task): boolean {
  if (!t.due_date || t.status === "done") return false;
  const due = new Date(t.due_date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return due < today;
}

export default function TodoPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newDue, setNewDue] = useState("");
  const [creating, setCreating] = useState(false);
  const router = useRouter();

  const load = async () => {
    try {
      const [tRes, mRes] = await Promise.all([
        fetch("/api/tasks"),
        fetch("/api/team/members"),
      ]);

      if (mRes.ok) {
        const m = await mRes.json();
        setMeId(m.me ?? null);
      }
      if (!tRes.ok) throw new Error("Could not load your tasks");
      const t = await tRes.json();
      setTasks(t.tasks || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  // SOW #1: add an item straight to your own list, assigned to yourself.
  const addPersonalItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !meId) return;
    setCreating(true);
    setError("");
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newTitle.trim(),
          due_date: newDue || null,
          priority: "medium",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not add item");

      // Assign it to yourself so it lands on this list.
      await fetch("/api/tasks", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: data.task.id, assigned_to: meId }),
      });

      setNewTitle("");
      setNewDue("");
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  };

  const toggleDone = async (t: Task) => {
    const next = t.status === "done" ? "pending" : "done";
    setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, status: next } : x)));
    try {
      await fetch("/api/tasks", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: t.id, status: next }),
      });
    } catch {
      setError("Could not update that item");
      load();
    }
  };

  // SOW #18: everything assigned to me shows up here automatically.
  const mine = tasks.filter((t) => meId && t.assigned_to === meId);
  const open = mine.filter((t) => t.status !== "done");
  const done = mine.filter((t) => t.status === "done");
  const overdue = open.filter(isOverdue);
  const dueToday = open.filter((t) => {
    if (!t.due_date) return false;
    const d = new Date(t.due_date).toDateString();
    return d === new Date().toDateString();
  });

  if (loading) return <p className="text-slate-400 p-6">Loading your list...</p>;

  return (
    <div className="p-6 bg-slate-950 min-h-screen">
      <div className="max-w-4xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-3xl font-bold">My To-Do List</h1>
          <button
            onClick={() => router.push("/dashboard")}
            className="text-sm text-slate-400 hover:text-white"
          >
            Back to tasks
          </button>
        </div>

        {error && (
          <div className="bg-red-950 border border-red-800 text-red-300 px-4 py-3 rounded mb-4 text-sm">
            {error}
          </div>
        )}

        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-slate-800 border border-slate-700 rounded p-4">
            <p className="text-2xl font-bold">{open.length}</p>
            <p className="text-slate-400 text-sm">Open</p>
          </div>
          <div className="bg-slate-800 border border-slate-700 rounded p-4">
            <p className="text-2xl font-bold text-yellow-500">{dueToday.length}</p>
            <p className="text-slate-400 text-sm">Due today</p>
          </div>
          <div className="bg-slate-800 border border-slate-700 rounded p-4">
            <p className="text-2xl font-bold text-red-500">{overdue.length}</p>
            <p className="text-slate-400 text-sm">Overdue</p>
          </div>
        </div>

        <div className="bg-slate-800 border border-slate-700 rounded p-4 mb-6">
          <div className="flex flex-wrap gap-3">
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Add something to your own list..."
              disabled={creating || !meId}
              className="flex-1 min-w-48 px-3 py-2 bg-slate-900 border border-slate-600 rounded placeholder-slate-500"
            />
            <input
              type="date"
              value={newDue}
              onChange={(e) => setNewDue(e.target.value)}
              disabled={creating || !meId}
              className="px-3 py-2 bg-slate-900 border border-slate-600 rounded"
            />
            <button
              onClick={addPersonalItem}
              disabled={creating || !newTitle.trim() || !meId}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 rounded text-sm"
            >
              {creating ? "Adding..." : "Add"}
            </button>
          </div>
        </div>

        {open.length === 0 ? (
          <p className="text-slate-400">Nothing open. Add an item above.</p>
        ) : (
          <div className="space-y-2 mb-8">
            {open.map((t) => (
              <div
                key={t.id}
                className={`bg-slate-800 border rounded p-3 flex items-start gap-3 ${
                  isOverdue(t) ? "border-l-4 border-l-red-600 border-slate-700" : "border-slate-700"
                }`}
              >
                <input
                  type="checkbox"
                  checked={false}
                  onChange={() => toggleDone(t)}
                  className="mt-1"
                />
                <div className="flex-1">
                  <p className="text-slate-200">{t.title}</p>
                  <div className="flex flex-wrap gap-3 text-xs text-slate-500 mt-1">
                    <span>{PRIORITY_LABEL[t.priority] ?? t.priority}</span>
                    <span>{t.progress_percent}%</span>
                    {t.due_date && <span>Due {new Date(t.due_date).toLocaleDateString()}</span>}
                    {t.milestone && <span>📍 {t.milestone}</span>}
                    {isOverdue(t) && <span className="text-red-400 font-semibold">OVERDUE</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {done.length > 0 && (
          <>
            <h2 className="text-sm font-semibold text-slate-400 mb-2">
              Completed ({done.length})
            </h2>
            <div className="space-y-2">
              {done.map((t) => (
                <div
                  key={t.id}
                  className="bg-slate-800 border border-slate-700 rounded p-3 flex items-start gap-3 opacity-60"
                >
                  <input
                    type="checkbox"
                    checked={true}
                    onChange={() => toggleDone(t)}
                    className="mt-1"
                  />
                  <p className="text-slate-400 line-through">{t.title}</p>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
