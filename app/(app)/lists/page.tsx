"use client";

// To-Do lists: many small things for one person, given in one go.
//
// A list is one task (so the person accepts its deadline, gets reminders, and
// it is reviewed like any other task); its items are the task's subtasks, each
// with a tick box and an optional date of its own.

import { useCallback, useEffect, useRef, useState } from "react";
import { cached, freshKeeper, keepSame, load as loadApi, remember, useBeforePaint, useRefresh } from "@/lib/apiCache";
import { sendJSON } from "@/lib/api";
import { isFinished, isOverdue, statusClass, statusLabel } from "@/lib/status";
import { DeadlinePicker } from "@/components/tasks/DateInputs";
import { ItemRows, blankItem, type ItemRow } from "@/components/tasks/ItemRows";
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
type Row = ItemRow;

const blankRow = (): Row => blankItem();
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
  const [about, setAbout] = useState("");
  const [rows, setRows] = useState<Row[]>(() => [blankRow(), blankRow(), blankRow()]);
  const [due, setDue] = useState("");
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  // Lists being sent or just sent: a reload that set off before the server
  // had them doesn't wipe them from the screen.
  const [fresh] = useState(() => freshKeeper<ListTask>());

  const flash = (m: string) => {
    setError("");
    setInfo(m);
    setTimeout(() => setInfo((c) => (c === m ? "" : c)), 4000);
  };

  const showPeople = (m: any) => {
    setPeople(m.members || []);
    setMe(m.me || null);
    setRole(m.myRole || "member");
  };

  // Lists and their items come in one request.
  const load = useCallback(async () => {
    try {
      const [m, l] = await Promise.all([
        loadApi<any>("/api/team/members").catch(() => null),
        loadApi<{ tasks: ListTask[]; items: Item[] }>("/api/tasks?lists=1"),
      ]);
      if (m) showPeople(m);
      const server = (l.tasks || []).filter((x: ListTask) => x.is_list);
      const all = fresh.merge(server);
      setLists((prev) => keepSame(prev, all));
      if (all.length === server.length) setItems((prev) => keepSame(prev, l.items || []));
      else {
        const kept = new Set(all.slice(0, all.length - server.length).map((x) => x.id));
        setItems((prev) => keepSame(prev, [...prev.filter((x) => kept.has(x.task_id)), ...(l.items || [])]));
      }
    } catch (e: any) {
      setError(e.message || "Could not load the lists");
    } finally {
      setLoading(false);
    }
  }, [fresh]);

  useBeforePaint(() => {
    // Paint what this phone remembers at once; fresh data replaces it.
    const m = cached<any>("/api/team/members");
    const l = cached<{ tasks: ListTask[]; items: Item[] }>("/api/tasks?lists=1");
    if (m) showPeople(m);
    if (l) {
      setLists((l.tasks || []).filter((x: ListTask) => x.is_list));
      setItems(l.items || []);
      setLoading(false);
    }
    load();
  }, [load]);

  // Pull-to-refresh and coming back to the app reload in place.
  useRefresh(load);

  // Keep the remembered copy in step with ticks and edits made here.
  useEffect(() => {
    if (!loading)
      remember("/api/tasks?lists=1", {
        tasks: lists.filter((l) => !l.id.startsWith("sending-")),
        items: items.filter((x) => !x.id.startsWith("sending-")),
      });
  }, [lists, items, loading]);

  const canGive = ["admin", "supervisor", "manager"].includes(role);
  useEffect(() => {
    if (!loading && !canGive) setTab("mine");
  }, [loading, canGive]);

  // ---- create --------------------------------------------------------------
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

    // The lists are on screen the moment "Send" is tapped (marked
    // "Sending...") and the form is ready for the next one; the server
    // confirms behind them.
    const keep = { who, name, about, rows, due };
    const stamp = Date.now();
    const body = (person: string) => ({
      title: name.trim(),
      description: about.trim() || null,
      is_list: true,
      assigned_to: person,
      with: who,
      due_date: deadline,
      priority: "medium",
      items: filled.map((r) => ({ title: r.title.trim(), due_date: fromLocalInput(r.due) })),
    });
    const temp: ListTask[] = who.map((person, i) => ({
      id: `sending-${stamp}-${i}`,
      title: name.trim(),
      status: "pending",
      due_date: deadline,
      assigned_to: person,
      created_by: me || "",
      progress_percent: 0,
      is_list: true,
    }));
    const tempItems: Item[] = temp.flatMap((t) =>
      filled.map((r, j) => ({ id: `${t.id}-${j}`, task_id: t.id, title: r.title.trim(), done: false, due_date: fromLocalInput(r.due), position: j }))
    );
    temp.forEach((t) => fresh.add(t));
    setLists((ls) => [...temp, ...ls]);
    setItems((xs) => [...xs, ...tempItems]);
    setWho([]);
    setName("");
    setAbout("");
    setRows([blankRow(), blankRow(), blankRow()]);
    setDue("");
    setTab(who.every((p) => p === me) ? "mine" : "given");

    const failed: string[] = [];
    const failedPeople: string[] = [];
    try {
      // One copy per person, all sent at once.
      const made = await Promise.all(
        who.map(async (person, i) => {
          try {
            const r = await sendJSON("/api/tasks", "POST", body(person));
            return { temp: temp[i].id, task: (r?.task as ListTask) || null };
          } catch (e: any) {
            failed.push(`${nameOf(people, person)}: ${e.message}`);
            failedPeople.push(person);
            return { temp: temp[i].id, task: null };
          }
        })
      );
      // Real lists in place of the "Sending..." ones; the ones that failed go.
      const real = new Map(made.map((m) => [m.temp, m.task]));
      made.forEach((m) => {
        fresh.drop(m.temp);
        if (m.task) fresh.add({ ...m.task, is_list: true });
      });
      setLists((ls) => ls.flatMap((l) => (real.has(l.id) ? (real.get(l.id) ? [{ ...(real.get(l.id) as ListTask), is_list: true }] : []) : [l])));
      setItems((xs) =>
        xs.flatMap((x) => {
          if (!real.has(x.task_id)) return [x];
          const t = real.get(x.task_id);
          return t ? [{ ...x, task_id: t.id }] : [];
        })
      );
      if (failed.length) {
        // Back in the form for just the people it didn't reach, so a retry
        // doesn't send twice.
        setWho(failedPeople);
        setName(keep.name);
        setAbout(keep.about);
        setRows(keep.rows);
        setDue(keep.due);
        setError(`Not sent - ${failed.join("; ")}`);
      } else {
        flash(keep.who.length > 1 ? `List sent to ${keep.who.length} people.` : `List sent to ${nameOf(people, keep.who[0])}.`);
      }
      // The items' real ids (needed to tick them) come with a fresh load.
      await load();
    } finally {
      lock.current = false;
      setSaving(false);
    }
  };

  // ---- tick ----------------------------------------------------------------
  const tick = async (item: Item) => {
    if (item.id.startsWith("sending-")) return;
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
        <div className="fixed toast-bottom left-1/2 -translate-x-1/2 z-[60] bg-green-950 border border-green-800 text-green-200 px-4 py-3 rounded shadow-lg text-sm" role="status">
          {info}
        </div>
      )}

      {canGive && (
        <div className="bg-slate-800 border border-slate-700 rounded p-3 sm:p-4 mb-6 space-y-3">
          <p className="text-sm font-semibold text-white">1. Who is this list for?</p>
          <AssigneePicker people={people} me={me} selected={who} onChange={setWho} loading={loading} />

          <p className="text-sm font-semibold text-white pt-1">2. Name the list and write the items</p>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="List name"
            className={`${inputCls} w-full`}
            aria-label="List name"
          />
          <textarea
            value={about}
            onChange={(e) => setAbout(e.target.value)}
            placeholder="What is this list for? (optional)"
            rows={2}
            className={`${inputCls} w-full resize-y`}
            aria-label="What the list is for"
          />
          <ItemRows rows={rows} onChange={setRows} placeholder="Item" />

          <p className="text-sm font-semibold text-white pt-1">3. When is the whole list due?</p>
          <DeadlinePicker
            value={due}
            onChange={setDue}
            label="When the list is due"
            emptyNote={latestItemDate ? `No deadline picked: the last item's date (${formatDue(latestItemDate)}) will be used.` : "Pick when the whole list is due."}
          />
          <div className="flex flex-wrap gap-2 items-end">
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
            const sending = l.id.startsWith("sending-");
            return (
              <div key={l.id} className={`bg-slate-800 border rounded p-4 ${late ? "border-red-800" : "border-slate-700"} ${sending ? "opacity-70" : ""}`}>
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
                    <span className={`text-xs px-2 py-1 rounded ${sending ? "bg-slate-700 text-slate-300" : statusClass(l.status)}`}>
                      {sending ? "Sending..." : statusLabel(l.status)}
                    </span>
                    {!sending && (
                      <a href={`/dashboard?task=${l.id}`} className="text-xs px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-200">
                        Open
                      </a>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 mt-3">
                  <div className="flex-1 bg-slate-700 rounded h-2">
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
                            disabled={!isMine || !open || x.id.startsWith("sending-")}
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

                {isMine && open && !sending && its.length > 0 && done === its.length && (
                  <button onClick={() => markDone(l)} className="mt-3 px-4 py-2 bg-green-600 hover:bg-green-500 rounded text-sm font-semibold">
                    ✓ All ticked - mark the list as done
                  </button>
                )}
                {isMine && !sending && l.status === "pending" && (
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
