"use client";

// To-Do lists: many small things for one person, given in one go.
//
// A list is one task (so the person accepts its deadline, gets reminders, and
// it is reviewed like any other task); its items are the task's subtasks, each
// with a tick box and an optional date of its own.

import { useCallback, useEffect, useRef, useState } from "react";
import { sendJSON } from "@/lib/api";
import { isFinished, isOverdue, statusClass, statusLabel } from "@/lib/status";
import { quickDeadlines } from "@/lib/deadlines";
import { AssigneePicker } from "@/components/tasks/AssigneePicker";
import { Person, formatDue, fromLocalInput, nameOf } from "@/components/tasks/types";

type ListTask = {
  id: string;
  title: string;
  status: string;
  due_date: string | null;
  assigned_to: string | null;
  created_by: string;
  progress_percent: number;
  is_list?: boolean;
  review_status?: string | null;
};
type Item = { id: string; task_id: string; title: string; done: boolean; due_date: string | null; position: number };
type Row = { key: number; title: string; due: string };

let rowKey = 1;
const blankRow = (): Row => ({ key: rowKey++, title: "", due: "" });
const inputCls = "px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm";

export default function ListsPage() {
  const [people, setPeople] = useState<Person[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [role, setRole] = useState("member");
  const [lists, setLists] = useState<ListTask[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [tab, setTab] = useState<"mine" | "given">("mine");

  // Create form.
  const [who, setWho] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [rows, setRows] = useState<Row[]>(() => [blankRow(), blankRow(), blankRow()]);
  const [due, setDue] = useState("");
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);

  const flash = (m: string) => {
    setError("");
    setInfo(m);
    setTimeout(() => setInfo((c) => (c === m ? "" : c)), 4000);
  };

  const load = useCallback(async () => {
    try {
      const [m, t] = await Promise.all([
        fetch("/api/team/members", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
        fetch("/api/tasks", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
      ]);
      if (m) {
        setPeople(m.members || []);
        setMe(m.me || null);
        setRole(m.myRole || "member");
      }
      const found: ListTask[] = (t?.tasks || []).filter((x: ListTask) => x.is_list);
      setLists(found);
      if (found.length) {
        const s = await sendJSON("/api/subtasks", "POST", { task_ids: found.map((x) => x.id) });
        setItems(s.subtasks || []);
      } else {
        setItems([]);
      }
    } catch (e: any) {
      setError(e.message || "Could not load the lists");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const canGive = ["admin", "supervisor", "manager"].includes(role);
  useEffect(() => {
    if (!loading && !canGive) setTab("mine");
  }, [loading, canGive]);

  // ---- create --------------------------------------------------------------
  const setRow = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  // Pasting several lines into one item box turns each line into its own item.
  const pasteInto = (key: number, text: string) => {
    const lines = text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    if (lines.length < 2) return false;
    setRows((rs) => {
      const at = rs.findIndex((r) => r.key === key);
      const made = lines.map((l) => ({ ...blankRow(), title: l }));
      const out = [...rs.slice(0, at), ...made, ...rs.slice(at + 1)];
      return out.some((r) => !r.title) ? out : [...out, blankRow()];
    });
    return true;
  };

  const filled = rows.filter((r) => r.title.trim());
  const latestItemDate = filled
    .map((r) => fromLocalInput(r.due))
    .filter(Boolean)
    .sort()
    .pop();

  const create = async () => {
    if (lock.current) return;
    if (!who.length) return setError("Pick who this list is for (step 1).");
    if (!name.trim()) return setError("Give the list a name.");
    if (!filled.length) return setError("Add at least one item.");
    const deadline = fromLocalInput(due) || latestItemDate || null;
    if (!deadline) return setError("Pick when the whole list is due (step 3).");
    lock.current = true;
    setSaving(true);
    setError("");
    const failed: string[] = [];
    try {
      for (const person of who) {
        try {
          await sendJSON("/api/tasks", "POST", {
            title: name.trim(),
            is_list: true,
            assigned_to: person,
            due_date: deadline,
            priority: "medium",
            items: filled.map((r) => ({ title: r.title.trim(), due_date: fromLocalInput(r.due) })),
          });
        } catch (e: any) {
          failed.push(`${nameOf(people, person)}: ${e.message}`);
        }
      }
      if (failed.length) {
        setError(`Not sent - ${failed.join("; ")}`);
      } else {
        flash(who.length > 1 ? `List sent to ${who.length} people.` : `List sent to ${nameOf(people, who[0])}.`);
        setWho([]);
        setName("");
        setRows([blankRow(), blankRow(), blankRow()]);
        setDue("");
        setTab("given");
      }
      await load();
    } finally {
      lock.current = false;
      setSaving(false);
    }
  };

  // ---- tick ----------------------------------------------------------------
  const tick = async (item: Item) => {
    setItems((xs) => xs.map((x) => (x.id === item.id ? { ...x, done: !x.done } : x)));
    try {
      const r = await sendJSON(`/api/tasks/${item.task_id}/subtasks`, "PUT", { subtask_id: item.id, done: !item.done });
      if (r.task) setLists((ls) => ls.map((l) => (l.id === item.task_id ? { ...l, ...r.task } : l)));
      else if (typeof r.task_progress === "number")
        setLists((ls) => ls.map((l) => (l.id === item.task_id ? { ...l, progress_percent: r.task_progress } : l)));
    } catch (e: any) {
      setItems((xs) => xs.map((x) => (x.id === item.id ? item : x)));
      setError(e.message);
    }
  };

  const markDone = async (list: ListTask) => {
    try {
      const r = await sendJSON("/api/tasks", "PUT", { id: list.id, status: "done" });
      setLists((ls) => ls.map((l) => (l.id === list.id ? { ...l, ...r.task } : l)));
      flash("Done. It's gone to your supervisor for review.");
    } catch (e: any) {
      setError(e.message);
    }
  };

  const mine = lists.filter((l) => l.assigned_to === me);
  const given = lists.filter((l) => l.assigned_to !== me);
  const shown = tab === "mine" ? mine : given;
  const quick = quickDeadlines();

  return (
    <div className="max-w-4xl mx-auto p-3 sm:p-6">
      <h1 className="text-2xl sm:text-3xl font-bold mb-1">To-Do lists</h1>
      <p className="text-slate-400 text-sm mb-4">Many small things for one person, sent as one list. They tick items off as they go.</p>

      {error && (
        <div className="bg-red-950 border border-red-800 text-red-300 px-4 py-3 rounded mb-4 text-sm flex justify-between gap-3" role="alert">
          <span>{error}</span>
          <button onClick={() => setError("")} className="text-red-400 shrink-0">dismiss</button>
        </div>
      )}
      {info && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] bg-green-950 border border-green-800 text-green-200 px-4 py-3 rounded shadow-lg text-sm" role="status">
          {info}
        </div>
      )}

      {canGive && (
        <div className="bg-slate-800 border border-slate-700 rounded p-3 sm:p-4 mb-6 space-y-3">
          <p className="text-sm font-semibold text-white">1. Who is this list for?</p>
          <AssigneePicker people={people} me={me} selected={who} onChange={setWho} disabled={saving} loading={loading} />

          <p className="text-sm font-semibold text-white pt-1">2. Name the list and write the items</p>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="List name"
            className={`${inputCls} w-full`}
            disabled={saving}
            aria-label="List name"
          />
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={r.key} className="flex flex-wrap gap-2 items-center">
                <span className="text-slate-500 text-sm w-5 text-right">{i + 1}.</span>
                <input
                  value={r.title}
                  onChange={(e) => setRow(r.key, { title: e.target.value })}
                  onPaste={(e) => {
                    if (pasteInto(r.key, e.clipboardData.getData("text"))) e.preventDefault();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (i === rows.length - 1) setRows((rs) => [...rs, blankRow()]);
                    }
                  }}
                  placeholder="Item"
                  className={`${inputCls} flex-1 min-w-40`}
                  disabled={saving}
                  aria-label={`Item ${i + 1}`}
                />
                <input
                  type="datetime-local"
                  value={r.due}
                  onChange={(e) => setRow(r.key, { due: e.target.value })}
                  className={`${inputCls} w-auto`}
                  disabled={saving}
                  aria-label={`Item ${i + 1} date (optional)`}
                  title="Date for this item (optional)"
                />
                {rows.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                    className="text-slate-500 hover:text-red-400 px-2"
                    aria-label={`Remove item ${i + 1}`}
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={() => setRows((rs) => [...rs, blankRow()])}
              disabled={saving}
              className="text-sm text-blue-400 hover:text-blue-300 px-1"
            >
              + Add item
            </button>
            <p className="text-xs text-slate-500">Dates on items are optional. Tip: paste a list of lines into an item box and each line becomes an item.</p>
          </div>

          <p className="text-sm font-semibold text-white pt-1">3. When is the whole list due?</p>
          <div className="flex flex-wrap gap-2">
            {quick.map((q) => (
              <button
                key={q.label}
                type="button"
                onClick={() => setDue(q.value)}
                className={`px-3 py-1.5 rounded-full text-sm border ${
                  due === q.value ? "bg-blue-600 border-blue-500 text-white" : "bg-slate-900 border-slate-600 text-slate-300 hover:border-slate-400"
                }`}
              >
                {q.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 items-end">
            <label className="flex flex-col text-xs text-slate-400 gap-1">
              Or pick a date and time{!due && latestItemDate ? ` (blank = ${formatDue(latestItemDate)}, the last item's date)` : ""}
              <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} className={inputCls} />
            </label>
            <button
              onClick={create}
              disabled={saving || !who.length || !name.trim() || !filled.length}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-4 py-2 rounded ml-auto font-semibold"
            >
              {saving ? "Sending..." : `Send list (${filled.length} item${filled.length === 1 ? "" : "s"})`}
            </button>
          </div>
        </div>
      )}

      {canGive && (
        <div className="flex gap-1 mb-3">
          {(
            [
              ["mine", `For me (${mine.length})`],
              ["given", `Given out (${given.length})`],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`px-3 py-2 rounded text-sm ${tab === k ? "bg-blue-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <p className="text-slate-400">Loading...</p>
      ) : shown.length === 0 ? (
        <p className="text-slate-400">{tab === "mine" ? "No lists for you right now." : "You haven't given out any lists yet."}</p>
      ) : (
        <div className="grid gap-3">
          {shown.map((l) => {
            const its = items.filter((x) => x.task_id === l.id).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
            const done = its.filter((x) => x.done).length;
            const isMine = l.assigned_to === me;
            const open = !isFinished(l.status);
            const late = isOverdue(l as any);
            return (
              <div key={l.id} className={`bg-slate-800 border rounded p-4 ${late ? "border-red-800" : "border-slate-700"}`}>
                <div className="flex flex-wrap justify-between items-start gap-2">
                  <div className="min-w-0">
                    <h3 className="font-bold text-lg break-words">{l.title}</h3>
                    <p className={`text-xs mt-0.5 ${late ? "text-red-400" : "text-slate-400"}`}>
                      {isMine ? `From ${nameOf(people, l.created_by, "your supervisor")}` : `For ${nameOf(people, l.assigned_to)}`}
                      {l.due_date && ` · due ${formatDue(l.due_date)}`}
                      {late && " · overdue"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs px-2 py-1 rounded ${statusClass(l.status)}`}>{statusLabel(l.status)}</span>
                    <a href={`/dashboard?task=${l.id}`} className="text-xs px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-200">
                      Open
                    </a>
                  </div>
                </div>

                <div className="flex items-center gap-2 mt-3">
                  <div className="flex-1 bg-slate-900 rounded h-2">
                    <div className="bg-blue-600 h-2 rounded" style={{ width: `${its.length ? Math.round((done / its.length) * 100) : 0}%` }} />
                  </div>
                  <span className="text-xs text-slate-400 tabular-nums">
                    {done}/{its.length}
                  </span>
                </div>

                <ul className="mt-3 space-y-1">
                  {its.map((x) => {
                    const itemLate = x.due_date && !x.done && new Date(x.due_date) < new Date();
                    return (
                      <li key={x.id}>
                        <label className={`flex items-start gap-3 px-2 py-1.5 rounded ${isMine && open ? "hover:bg-slate-700/50 cursor-pointer" : ""}`}>
                          <input
                            type="checkbox"
                            checked={x.done}
                            disabled={!isMine || !open}
                            onChange={() => tick(x)}
                            className="mt-0.5 w-5 h-5 accent-blue-500 shrink-0"
                          />
                          <span className="min-w-0">
                            <span className={x.done ? "line-through text-slate-500" : "text-slate-100"}>{x.title}</span>
                            {x.due_date && (
                              <span className={`block text-xs ${itemLate ? "text-red-400" : "text-slate-500"}`}>
                                by {formatDue(x.due_date)}
                                {itemLate ? " (late)" : ""}
                              </span>
                            )}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>

                {isMine && open && its.length > 0 && done === its.length && (
                  <button onClick={() => markDone(l)} className="mt-3 px-4 py-2 bg-green-600 hover:bg-green-500 rounded text-sm font-semibold">
                    ✓ All ticked - mark the list as done
                  </button>
                )}
                {isMine && l.status === "pending" && (
                  <p className="text-xs text-slate-400 mt-3">
                    New list: press <b>Open</b> to accept its deadline (or ask for more time).
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
