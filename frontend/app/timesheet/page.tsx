"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Entry = {
  id: string;
  task_id: string | null;
  entry_date: string;
  hours: number;
  notes: string | null;
};

type Task = { id: string; title: string };

export default function TimesheetPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [hours, setHours] = useState("");
  const [taskId, setTaskId] = useState("");
  const [notes, setNotes] = useState("");
  const router = useRouter();

  const load = async () => {
    try {
      const [e, t] = await Promise.all([fetch("/api/timesheet"), fetch("/api/tasks")]);
      if (!e.ok) throw new Error("Could not load your timesheet");
      setEntries((await e.json()).entries || []);
      if (t.ok) setTasks((await t.json()).tasks || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const addEntry = async () => {
    if (!hours || Number(hours) <= 0) {
      setError("Enter how many hours you spent");
      return;
    }
    setError("");
    try {
      const res = await fetch("/api/timesheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entry_date: date,
          hours: Number(hours),
          task_id: taskId || null,
          notes: notes || null,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Could not save entry");
      setEntries((prev) => [body, ...prev]);
      setHours("");
      setNotes("");
      setTaskId("");
    } catch (err: any) {
      setError(err.message);
    }
  };

  const removeEntry = async (id: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
    try {
      await fetch("/api/timesheet", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry_id: id }),
      });
    } catch {
      setError("Could not delete that entry");
      load();
    }
  };

  const titleFor = (id: string | null) =>
    id ? tasks.find((t) => t.id === id)?.title || "Task" : "General";

  // Group by day so the page reads as a daily activity report.
  const byDate = entries.reduce((acc, e) => {
    (acc[e.entry_date] ||= []).push(e);
    return acc;
  }, {} as Record<string, Entry[]>);

  const todayTotal = (byDate[new Date().toISOString().slice(0, 10)] || []).reduce(
    (sum, e) => sum + Number(e.hours),
    0
  );
  const weekTotal = entries
    .filter((e) => {
      const d = new Date(e.entry_date);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 7);
      return d >= cutoff;
    })
    .reduce((sum, e) => sum + Number(e.hours), 0);

  if (loading) return <p className="text-slate-400 p-6">Loading timesheet...</p>;

  return (
    <div className="p-6 bg-slate-950 min-h-screen">
      <div className="max-w-4xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-3xl font-bold">Timesheet</h1>
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

        <div className="grid grid-cols-2 gap-4 mb-6">
          <div className="bg-slate-800 border border-slate-700 rounded p-4">
            <p className="text-2xl font-bold">{todayTotal}</p>
            <p className="text-slate-400 text-sm">Hours today</p>
          </div>
          <div className="bg-slate-800 border border-slate-700 rounded p-4">
            <p className="text-2xl font-bold text-blue-400">{weekTotal}</p>
            <p className="text-slate-400 text-sm">Hours this week</p>
          </div>
        </div>

        <div className="bg-slate-800 border border-slate-700 rounded p-4 mb-6">
          <div className="flex flex-wrap gap-3">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="px-3 py-2 bg-slate-900 border border-slate-600 rounded"
            />
            <input
              type="number"
              step="0.5"
              min="0"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              placeholder="Hours"
              className="w-24 px-3 py-2 bg-slate-900 border border-slate-600 rounded placeholder-slate-500"
            />
            <select
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
              className="px-3 py-2 bg-slate-900 border border-slate-600 rounded"
            >
              <option value="">General work</option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What did you work on?"
              className="flex-1 min-w-48 px-3 py-2 bg-slate-900 border border-slate-600 rounded placeholder-slate-500"
            />
            <button
              onClick={addEntry}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm"
            >
              Log time
            </button>
          </div>
        </div>

        {entries.length === 0 ? (
          <p className="text-slate-400">No entries yet. Log your first above.</p>
        ) : (
          <div className="space-y-6">
            {Object.keys(byDate)
              .sort((a, b) => b.localeCompare(a))
              .map((d) => {
                const dayTotal = byDate[d].reduce((sum, e) => sum + Number(e.hours), 0);
                return (
                  <div key={d}>
                    <div className="flex justify-between items-center mb-2">
                      <h2 className="text-sm font-semibold text-slate-300">
                        {new Date(d).toLocaleDateString(undefined, {
                          weekday: "long",
                          day: "numeric",
                          month: "short",
                        })}
                      </h2>
                      <span className="text-xs text-slate-500">{dayTotal} h</span>
                    </div>
                    <div className="space-y-2">
                      {byDate[d].map((e) => (
                        <div
                          key={e.id}
                          className="bg-slate-800 border border-slate-700 rounded p-3 flex justify-between items-start gap-3"
                        >
                          <div>
                            <p className="text-sm text-slate-200">{titleFor(e.task_id)}</p>
                            {e.notes && (
                              <p className="text-xs text-slate-400 mt-1">{e.notes}</p>
                            )}
                          </div>
                          <div className="flex items-center gap-3 shrink-0">
                            <span className="text-sm text-slate-300">{e.hours} h</span>
                            <button
                              onClick={() => removeEntry(e.id)}
                              className="text-slate-500 hover:text-red-400 text-xs"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
          </div>
        )}
      </div>
    </div>
  );
}
