"use client";

// Checklist #1 / #2 / #5: My To-Do.
//   - private items you add yourself (only you can see them), with an
//     optional "remind me at" time on top of the automatic deadline reminders
//   - every task on your plate: given to you by name, or given to a team,
//     department or group you're in with nobody named
//   - checklist items (subtasks) assigned to you on other people's tasks

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { isFinished, isOverdue } from "@/lib/status";
import { sendJSON } from "@/lib/api";
import { formatDue, fromLocalInput, milestoneLabel } from "@/components/tasks/types";

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
  personal?: boolean;
  remind_at?: string | null;
  for_me?: boolean;
};

type Item = {
  id: string;
  task_id: string;
  title: string;
  done: boolean;
  due_date: string | null;
  task_title: string;
};

const PRIORITY_LABEL: Record<string, string> = {
  super_high: "Super High",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export default function TodoPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newDue, setNewDue] = useState("");
  const [newRemind, setNewRemind] = useState("");
  const [creating, setCreating] = useState(false);
  const router = useRouter();

  const load = async () => {
    try {
      const [tRes, mRes, sRes] = await Promise.all([
        fetch("/api/tasks", { cache: "no-store" }),
        fetch("/api/team/members", { cache: "no-store" }),
        fetch("/api/subtasks?mine=1", { cache: "no-store" }),
      ]);

      if (mRes.ok) {
        const m = await mRes.json();
        setMeId(m.me ?? null);
      }
      if (!tRes.ok) throw new Error("Could not load your tasks");
      const t = await tRes.json();
      setTasks(t.tasks || []);
      if (sRes.ok) setItems((await sRes.json()).subtasks || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  // SOW #1: add an item straight to your own (private) list.
  const addPersonalItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !meId) return;
    setCreating(true);
    setError("");
    try {
      const due = fromLocalInput(newDue);
      if (!due) throw new Error("Pick a due date and time");
      const remind = fromLocalInput(newRemind);
      await sendJSON("/api/tasks", "POST", {
        title: newTitle.trim(),
        due_date: due,
        priority: "medium",
        assigned_to: meId,
        personal: true,
        ...(remind ? { remind_at: remind } : {}),
      });

      setNewTitle("");
      setNewDue("");
      setNewRemind("");
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  };

  // #1: delete one of your own private items.
  const removeItem = async (t: Task) => {
    if (!window.confirm(`Delete "${t.title}"? This can't be undone.`)) return;
    const before = tasks;
    setTasks((prev) => prev.filter((x) => x.id !== t.id));
    try {
      await sendJSON("/api/tasks", "DELETE", { id: t.id });
    } catch (err: any) {
      setTasks(before);
      setError(err.message || "Could not delete that item");
    }
  };

  const toggleDone = async (t: Task) => {
    const next = isFinished(t.status) ? "pending" : "done";
    const before = t.status;
    setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, status: next } : x)));
    try {
      const r = await sendJSON("/api/tasks", "PUT", { id: t.id, status: next });
      if (r?.task) setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, ...r.task } : x)));
    } catch (err: any) {
      setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, status: before } : x)));
      setError(err.message || "Could not update that item");
    }
  };

  const toggleItem = async (it: Item) => {
    setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, done: !it.done } : x)));
    try {
      const r = await sendJSON(`/api/tasks/${it.task_id}/subtasks`, "PUT", { subtask_id: it.id, done: !it.done });
      // Ticking the last item can complete the task it belongs to.
      if (r?.task?.id) setTasks((prev) => prev.map((x) => (x.id === r.task.id ? { ...x, ...r.task } : x)));
    } catch (err: any) {
      setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, done: it.done } : x)));
      setError(err.message || "Could not update that item");
    }
  };

  const setReminder = async (t: Task, value: string) => {
    const iso = value ? fromLocalInput(value) : null;
    try {
      const r = await sendJSON("/api/tasks", "PUT", { id: t.id, remind_at: iso });
      setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, remind_at: r.task.remind_at } : x)));
    } catch (err: any) {
      setError(err.message);
    }
  };

  // SOW #18: everything on my plate shows up here automatically.
  const mine = tasks.filter((t) => t.for_me || (meId && t.assigned_to === meId));
  const open = mine.filter((t) => !isFinished(t.status));
  const done = mine.filter((t) => isFinished(t.status));
  const overdue = open.filter(isOverdue);
  const dueToday = open.filter((t) => {
    if (!t.due_date) return false;
    const d = new Date(t.due_date).toDateString();
    return d === new Date().toDateString();
  });
  const openItems = items.filter((i) => !i.done);

  if (loading) return <p className="text-slate-400 p-6">Loading your list...</p>;

  const inputCls = "px-3 py-2 bg-slate-900 border border-slate-600 rounded";

  return (
    <div className="p-3 sm:p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex justify-between items-center mb-6 gap-3">
          <h1 className="text-2xl sm:text-3xl font-bold">My To-Do List</h1>
          <button onClick={() => router.push("/dashboard")} className="text-sm text-slate-400 hover:text-white">
            Back to tasks
          </button>
        </div>

        {error && (
          <div className="bg-red-950 border border-red-800 text-red-300 px-4 py-3 rounded mb-4 text-sm flex justify-between gap-2">
            <span>{error}</span>
            <button onClick={() => setError("")}>dismiss</button>
          </div>
        )}

        <div className="grid grid-cols-3 gap-2 sm:gap-4 mb-6">
          <div className="bg-slate-800 border border-slate-700 rounded p-4">
            <p className="text-2xl font-bold">{open.length + openItems.length}</p>
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

        <form onSubmit={addPersonalItem} className="bg-slate-800 border border-slate-700 rounded p-4 mb-6 space-y-2">
          <div className="flex flex-wrap gap-3 items-end">
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Add something to your own list..."
              disabled={creating || !meId}
              className={`${inputCls} flex-1 min-w-48 placeholder-slate-500`}
            />
            <label className="flex flex-col text-xs text-slate-400 gap-1">
              Due
              <input type="datetime-local" required aria-label="Due date and time" value={newDue} onChange={(e) => setNewDue(e.target.value)} disabled={creating || !meId} className={inputCls} />
            </label>
            <label className="flex flex-col text-xs text-slate-400 gap-1">
              Remind me (optional)
              <input type="datetime-local" aria-label="Remind me at" value={newRemind} onChange={(e) => setNewRemind(e.target.value)} disabled={creating || !meId} className={inputCls} />
            </label>
            <button type="submit" disabled={creating || !newTitle.trim() || !newDue || !meId} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 rounded text-sm">
              {creating ? "Adding..." : "Add"}
            </button>
          </div>
          <p className="text-xs text-slate-500">Items you add here are private to you. You also get automatic reminders 24, 8 and 6 hours before the due time.</p>
        </form>

        {open.length === 0 && openItems.length === 0 ? (
          <p className="text-slate-400 mb-8">Nothing open. Add an item above.</p>
        ) : (
          <div className="space-y-2 mb-8">
            {open.map((t) => (
              <div
                key={t.id}
                className={`bg-slate-800 border rounded p-3 flex items-start gap-3 ${isOverdue(t) ? "border-l-4 border-l-red-600 border-slate-700" : "border-slate-700"}`}
              >
                <input type="checkbox" checked={false} onChange={() => toggleDone(t)} className="mt-1" aria-label={`Mark ${t.title} done`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <a href={`/dashboard?task=${t.id}`} className="text-slate-200 hover:text-blue-400 break-words">
                      {t.personal && "🔒 "}
                      {t.title}
                    </a>
                    {t.personal && (
                      <button onClick={() => removeItem(t)} className="text-slate-500 hover:text-red-400 text-xs px-1 shrink-0" aria-label={`Delete ${t.title}`}>
                        🗑
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500 mt-1 items-center">
                    <span>{PRIORITY_LABEL[t.priority] ?? t.priority}</span>
                    <span>{t.progress_percent}%</span>
                    {t.due_date && <span>Due {formatDue(t.due_date)}</span>}
                    {!t.assigned_to && <span>for your team</span>}
                    {t.milestone && <span>📍 {milestoneLabel(t.milestone)}</span>}
                    {isOverdue(t) && <span className="text-red-400 font-semibold">OVERDUE</span>}
                    <label className="flex items-center gap-1">
                      ⏰
                      <input
                        type="datetime-local"
                        defaultValue={t.remind_at ? toLocal(t.remind_at) : ""}
                        key={`${t.id}-${t.remind_at || ""}`}
                        onBlur={(e) => e.target.value !== (t.remind_at ? toLocal(t.remind_at) : "") && setReminder(t, e.target.value)}
                        className="bg-transparent border border-slate-700 rounded px-1 py-0.5 text-xs text-slate-300"
                        aria-label={`Remind me about ${t.title}`}
                      />
                    </label>
                  </div>
                </div>
              </div>
            ))}
            {openItems.map((it) => (
              <div key={it.id} className="bg-slate-800 border border-slate-700 rounded p-3 flex items-start gap-3">
                <input type="checkbox" checked={false} onChange={() => toggleItem(it)} className="mt-1" aria-label={`Tick ${it.title}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-slate-200 break-words">{it.title}</p>
                  <p className="text-xs text-slate-500 mt-1">
                    Checklist item on <a href={`/dashboard?task=${it.task_id}`} className="text-blue-400 hover:underline">{it.task_title}</a>
                    {it.due_date && <span className={new Date(it.due_date) < new Date() ? "text-red-400" : ""}> · due {formatDue(it.due_date)}</span>}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}

        {done.length > 0 && (
          <>
            <h2 className="text-sm font-semibold text-slate-400 mb-2">Completed ({done.length})</h2>
            <div className="space-y-2">
              {done.map((t) => (
                <div key={t.id} className="bg-slate-800 border border-slate-700 rounded p-3 flex items-start gap-3 opacity-60">
                  <input type="checkbox" checked={true} onChange={() => toggleDone(t)} className="mt-1" aria-label={`Re-open ${t.title}`} />
                  <p className="text-slate-400 line-through break-words flex-1">{t.title}</p>
                  {t.personal && (
                    <button onClick={() => removeItem(t)} className="text-slate-500 hover:text-red-400 text-xs px-1" aria-label={`Delete ${t.title}`}>
                      🗑
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function toLocal(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
