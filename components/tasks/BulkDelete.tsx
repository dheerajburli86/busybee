"use client";

// Select several tasks (or to-do lists) and delete them at once, with Undo.
// Deleted work waits 30 days in "Recently deleted" (restorable) before it is
// removed for good - see DELETE /api/tasks.

import { useCallback, useEffect, useRef, useState } from "react";
import { sendJSON } from "@/lib/api";
import { formatDue } from "./types";

const DAY = 24 * 3600 * 1000;

export function useBulkDelete(opts: { onRemoved: (ids: string[]) => void; onRestored: (ids: string[]) => void; onError: (m: string) => void }) {
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<{ ids: string[]; label: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const o = useRef(opts);
  o.current = opts;

  const toggle = useCallback((id: string) => {
    if (id.startsWith("sending-")) return;
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);
  const stop = () => {
    setSelecting(false);
    setPicked(new Set());
  };

  const remove = async (ids: string[]) => {
    if (!ids.length || busy) return;
    setBusy(true);
    try {
      const r = await sendJSON("/api/tasks", "DELETE", { ids });
      const done: string[] = r.done || [];
      if (done.length) {
        o.current.onRemoved(done);
        clearTimeout(timer.current);
        setUndo({ ids: done, label: `${done.length} deleted` });
        timer.current = setTimeout(() => setUndo(null), 15000);
      }
      if (r.failed?.length) o.current.onError(`${r.failed.length} couldn't be deleted: ${r.failed[0].error}`);
      stop();
    } catch (e: any) {
      o.current.onError(e.message || "Could not delete");
    } finally {
      setBusy(false);
    }
  };

  const restore = async (ids: string[]) => {
    if (!ids.length) return;
    try {
      const r = await sendJSON("/api/tasks", "DELETE", { ids, restore: true });
      o.current.onRestored(r.done || ids);
      setUndo((u) => (u && u.ids.every((x) => ids.includes(x)) ? null : u));
    } catch (e: any) {
      o.current.onError(e.message || "Could not restore");
    }
  };

  useEffect(() => () => clearTimeout(timer.current), []);
  return { selecting, setSelecting, picked, toggle, setPicked, stop, remove, restore, busy, undo, setUndo };
}

export type Bulk = ReturnType<typeof useBulkDelete>;

/** Select / Select all / Delete selected / Cancel - on the left, in that order. */
export function BulkBar({ bulk, allIds, noun = "task" }: { bulk: Bulk; allIds: string[]; noun?: string }) {
  if (!bulk.selecting) {
    return (
      <button type="button" onClick={() => bulk.setSelecting(true)} className="px-3 py-2 rounded text-sm bg-slate-800 text-slate-300 hover:bg-slate-700">
        ☑ Select
      </button>
    );
  }
  const n = bulk.picked.size;
  const all = allIds.length > 0 && allIds.every((id) => bulk.picked.has(id));
  return (
    <div className="flex flex-wrap items-center gap-2 bg-slate-800 border border-slate-600 rounded px-2 py-1.5" role="toolbar" aria-label="Selected">
      <button
        type="button"
        onClick={() => bulk.setPicked(all ? new Set() : new Set(allIds))}
        className="px-3 py-1.5 rounded text-sm bg-slate-700 hover:bg-slate-600"
      >
        {all ? "Unselect all" : `Select all (${allIds.length})`}
      </button>
      <button
        type="button"
        disabled={!n || bulk.busy}
        onClick={() => bulk.remove(Array.from(bulk.picked))}
        className="px-3 py-1.5 rounded text-sm bg-red-600 hover:bg-red-500 disabled:opacity-50 font-semibold"
      >
        {bulk.busy ? "Deleting..." : `🗑 Delete selected (${n})`}
      </button>
      <button type="button" onClick={bulk.stop} className="px-3 py-1.5 rounded text-sm bg-slate-700 hover:bg-slate-600">
        Cancel
      </button>
      <span className="text-xs text-slate-400">Tap {noun}s to select them</span>
    </div>
  );
}

/** The tick box shown on a card while selecting. */
export function PickBox({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 w-5 h-5 rounded border-2 items-center justify-center text-xs font-bold ${on ? "bg-blue-600 border-blue-500 text-white" : "border-slate-500"}`}
    >
      {on ? "✓" : ""}
    </span>
  );
}

/** "3 deleted - Undo", for 15 seconds after a delete. */
export function UndoBar({ bulk }: { bulk: Bulk }) {
  if (!bulk.undo) return null;
  return (
    <div className="fixed toast-bottom left-4 z-[60] bg-slate-900 border border-slate-600 text-white px-4 py-3 rounded shadow-lg text-sm flex items-center gap-3" role="status">
      <button type="button" onClick={() => bulk.restore(bulk.undo!.ids)} className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 font-semibold">
        Undo
      </button>
      <span>{bulk.undo.label}. Kept 30 days in Recently deleted.</span>
    </div>
  );
}

type DeletedRow = { id: string; title: string; deleted_at: string; assigned_to?: string | null; due_date?: string | null; is_list?: boolean };

/** Recently deleted (last 30 days): restore one, some or all. */
export function RecentlyDeleted({ lists, bulk, nameOf, reloadKey }: { lists: boolean; bulk: Bulk; nameOf: (id: string | null | undefined) => string; reloadKey: number }) {
  const [rows, setRows] = useState<DeletedRow[] | null>(null);
  const [err, setErr] = useState("");
  const [pick, setPick] = useState<Set<string>>(new Set());
  useEffect(() => {
    let off = false;
    fetch(`/api/tasks?deleted=1${lists ? "&lists=1" : ""}`, { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || "Could not load deleted items");
        return d;
      })
      .then((d) => !off && setRows((d.tasks || []).filter((t: any) => !!t.is_list === lists)))
      .catch((e) => !off && setErr(/deleted_at/.test(e.message) ? "Run supabase/migrations/20261014_soft_delete.sql in Supabase to turn on Recently deleted." : e.message));
    return () => {
      off = true;
    };
  }, [lists, reloadKey]);

  const restore = async (ids: string[]) => {
    await bulk.restore(ids);
    setRows((r) => (r || []).filter((x) => !ids.includes(x.id)));
    setPick(new Set());
  };
  if (err) return <p className="text-sm text-amber-300 mb-4">{err}</p>;
  if (!rows) return <p className="text-sm text-slate-400 mb-4">Loading deleted items...</p>;
  return (
    <div className="bg-slate-800 border border-slate-700 rounded p-3 mb-6">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <h2 className="font-semibold">Recently deleted ({rows.length})</h2>
        {rows.length > 0 && (
          <>
            <button type="button" onClick={() => setPick(pick.size === rows.length ? new Set() : new Set(rows.map((r) => r.id)))} className="px-3 py-1.5 rounded text-sm bg-slate-700 hover:bg-slate-600">
              {pick.size === rows.length ? "Unselect all" : "Select all"}
            </button>
            <button type="button" disabled={!pick.size} onClick={() => restore(Array.from(pick))} className="px-3 py-1.5 rounded text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 font-semibold">
              ↩ Restore selected ({pick.size})
            </button>
          </>
        )}
      </div>
      <p className="text-xs text-slate-400 mb-2">Deleted items are removed for good 30 days after they were deleted.</p>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-400">Nothing deleted in the last 30 days.</p>
      ) : (
        <ol className="space-y-1">
          {rows.map((r, i) => {
            const left = Math.max(0, Math.ceil((Date.parse(r.deleted_at) + 30 * DAY - Date.now()) / DAY));
            const on = pick.has(r.id);
            return (
              <li key={r.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-700">
                <button type="button" onClick={() => restore([r.id])} className="px-3 py-1 rounded text-xs bg-slate-700 hover:bg-slate-600 shrink-0">
                  ↩ Restore
                </button>
                <button
                  type="button"
                  onClick={() => setPick((p) => { const n = new Set(p); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })}
                  className="flex items-center gap-2 min-w-0 flex-1 text-left"
                >
                  <span className="text-xs text-slate-400 w-5">{i + 1}.</span>
                  <PickBox on={on} />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold break-words">{r.title}</span>
                    <span className="block text-xs text-slate-400">
                      {[nameOf(r.assigned_to), r.due_date ? `due ${formatDue(r.due_date)}` : null, `${left} day${left === 1 ? "" : "s"} left to restore`].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
