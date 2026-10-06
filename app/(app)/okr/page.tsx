"use client";

import { useEffect, useRef, useState } from "react";
import { sendJSON } from "@/lib/api";
import { useRouter } from "next/navigation";

type Objective = {
  id: string;
  owner_id?: string | null;
  title: string;
  description: string | null;
  period: string | null;
  created_at: string;
};

type KeyResult = {
  id: string;
  objective_id: string;
  title: string;
  target_value: number;
  current_value: number;
  unit: string;
};

type Task = {
  id: string;
  title: string;
  status: string;
  progress_percent: number;
  key_result_id: string | null;
};

export default function OkrPage() {
  const [objectives, setObjectives] = useState<Objective[]>([]);
  const [keyResults, setKeyResults] = useState<KeyResult[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  // Stops a double click from adding the same objective or key result twice.
  const busy = useRef(false);
  const [error, setError] = useState("");
  const [newObjective, setNewObjective] = useState("");
  const [newKr, setNewKr] = useState<Record<string, { title: string; target: string }>>({});
  const [role, setRole] = useState("member");
  const [me, setMe] = useState<string | null>(null);
  const router = useRouter();
  const isManager = ["admin", "supervisor", "manager"].includes(role);

  const load = async () => {
    try {
      const [o, t, m] = await Promise.all([fetch("/api/okr"), fetch("/api/tasks"), fetch("/api/team/members")]);
      if (!o.ok) throw new Error("Could not load OKRs");
      const data = await o.json();
      setObjectives(data.objectives || []);
      setKeyResults(data.keyResults || []);
      if (t.ok) setTasks((await t.json()).tasks || []);
      if (m.ok) {
        const md = await m.json();
        setRole(md.myRole || "member");
        setMe(md.me || null);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const addObjective = async () => {
    if (!newObjective.trim() || busy.current) return;
    busy.current = true;
    try {
      const res = await fetch("/api/okr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newObjective.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Could not add objective");
      setObjectives((prev) => [body, ...prev]);
      setNewObjective("");
    } catch (e: any) {
      setError(e.message);
    } finally {
      busy.current = false;
    }
  };

  const addKeyResult = async (objectiveId: string) => {
    const draft = newKr[objectiveId] || { title: "", target: "" };
    const title = draft.title.trim();
    if (!title) return;
    const target = Number(draft.target) > 0 ? Number(draft.target) : 100;
    if (busy.current) return;
    busy.current = true;
    try {
      const res = await fetch("/api/okr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objective_id: objectiveId, title, target_value: target }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Could not add key result");
      setKeyResults((prev) => [...prev, body]);
      setNewKr((prev) => ({ ...prev, [objectiveId]: { title: "", target: "" } }));
    } catch (e: any) {
      setError(e.message);
    } finally {
      busy.current = false;
    }
  };

  const updateKr = async (kr: KeyResult, value: number) => {
    const before = kr.current_value;
    setKeyResults((prev) =>
      prev.map((k) => (k.id === kr.id ? { ...k, current_value: value } : k))
    );
    try {
      await sendJSON("/api/okr", "PUT", {
        key_result_id: kr.id,
        current_value: value,
      });
    } catch (err: any) {
      setKeyResults((prev) =>
        prev.map((k) => (k.id === kr.id ? { ...k, current_value: before } : k))
      );
      setError(err.message || "Could not save that value");
    }
  };

  // An objective's progress is the mean of its key results.
  const objectiveProgress = (objId: string) => {
    const krs = keyResults.filter((k) => k.objective_id === objId);
    if (krs.length === 0) return 0;
    const total = krs.reduce((sum, k) => {
      const target = Number(k.target_value) || 1;
      return sum + Math.max(0, Math.min((Number(k.current_value) / target) * 100, 100));
    }, 0);
    return Math.round(total / krs.length);
  };

  if (loading) return <p className="text-slate-400 p-6">Loading OKRs...</p>;

  return (
    <div className="p-3 sm:p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-3xl font-bold">OKR Dashboard</h1>
          <button
            onClick={() => router.push("/dashboard")}
            className="text-sm text-slate-400 hover:text-white"
          >
            Back to tasks
          </button>
        </div>

        {error && (
          <div className="bg-red-950 border border-red-800 text-red-300 px-4 py-3 rounded mb-4 text-sm flex justify-between gap-3">
            <span>{error}</span>
            <button onClick={() => setError("")} className="text-red-200 hover:text-white" aria-label="Dismiss">✕</button>
          </div>
        )}

        {isManager ? (
        <div className="bg-slate-800 border border-slate-700 rounded p-4 mb-6 flex gap-2">
          <input
            value={newObjective}
            onChange={(e) => setNewObjective(e.target.value)}
            placeholder="New objective..."
            className="flex-1 px-3 py-2 bg-slate-900 border border-slate-600 rounded placeholder-slate-500"
          />
          <button
            onClick={addObjective}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm"
          >
            Add objective
          </button>
        </div>
        ) : (
          <p className="text-xs text-slate-500 mb-4">Managers and supervisors set objectives. Link your tasks to a key result from the task panel.</p>
        )}

        {objectives.length === 0 ? (
          <p className="text-slate-400">No objectives yet. Add one above.</p>
        ) : (
          <div className="space-y-4">
            {objectives.map((o) => {
              const krs = keyResults.filter((k) => k.objective_id === o.id);
              const pct = objectiveProgress(o.id);
              return (
                <div key={o.id} className="bg-slate-800 border border-slate-700 rounded p-4">
                  <div className="flex justify-between items-start mb-2">
                    <h2 className="text-lg font-semibold">{o.title}</h2>
                    <span className="text-slate-400 text-sm">{pct}%</span>
                  </div>
                  <div className="w-full bg-slate-900 rounded h-2 mb-4">
                    <div className="bg-blue-600 h-2 rounded" style={{ width: `${pct}%` }} />
                  </div>

                  {krs.length > 0 && (
                    <div className="space-y-3 mb-3">
                      {krs.map((k) => {
                        const target = Number(k.target_value) || 1;
                        const kpct = Math.max(0, Math.min(
                          Math.round((Number(k.current_value) / target) * 100),
                          100
                        ));
                        // SOW #36: tasks linked to this key result
                        const linked = tasks.filter((t) => t.key_result_id === k.id);
                        return (
                          <div key={k.id} className="bg-slate-700 rounded p-3">
                            <div className="flex justify-between items-center gap-2 mb-2">
                              <span className="text-sm text-slate-200">{k.title}</span>
                              <div className="flex items-center gap-2 shrink-0">
                                <input
                                  type="number"
                                  key={`${k.id}-${k.current_value}`}
                                  defaultValue={k.current_value}
                                  onBlur={(e) => Number(e.target.value) !== Number(k.current_value) && updateKr(k, Number(e.target.value))}
                                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                                  disabled={!(isManager || o.owner_id === me)}
                                  className="w-20 px-2 py-1 bg-slate-900 border border-slate-600 rounded text-xs disabled:opacity-60"
                                  aria-label={`Current value for ${k.title}`}
                                />
                                <span className="text-xs text-slate-400">
                                  / {k.target_value}
                                </span>
                              </div>
                            </div>
                            <div className="w-full bg-slate-900 rounded h-1.5">
                              <div
                                className="bg-green-600 h-1.5 rounded"
                                style={{ width: `${kpct}%` }}
                              />
                            </div>
                            {linked.length > 0 && (
                              <div className="mt-2 space-y-1">
                                <p className="text-xs text-slate-400">
                                  {linked.length} linked task{linked.length !== 1 ? "s" : ""} · their average progress{" "}
                                  {Math.round(linked.reduce((sum, t) => sum + (t.progress_percent || 0), 0) / linked.length)}%
                                </p>
                                {linked.map((t) => (
                                  <a key={t.id} href={`/dashboard?task=${t.id}`} className="flex items-center gap-2 text-xs text-slate-300 hover:text-white">
                                    <span className="flex-1 truncate">{t.title}</span>
                                    <span className="w-16 bg-slate-900 rounded h-1.5 shrink-0">
                                      <span className="block bg-blue-500 h-1.5 rounded" style={{ width: `${t.progress_percent || 0}%` }} />
                                    </span>
                                    <span className="w-9 text-right">{t.progress_percent || 0}%</span>
                                  </a>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {(isManager || o.owner_id === me) && (
                  <div className="flex flex-wrap gap-2">
                    <input
                      value={newKr[o.id]?.title || ""}
                      onChange={(e) =>
                        setNewKr((prev) => ({ ...prev, [o.id]: { target: prev[o.id]?.target || "", title: e.target.value } }))
                      }
                      placeholder="Add a key result..."
                      className="flex-1 min-w-40 px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm placeholder-slate-500"
                    />
                    <input
                      type="number"
                      min="1"
                      value={newKr[o.id]?.target || ""}
                      onChange={(e) => setNewKr((prev) => ({ ...prev, [o.id]: { title: prev[o.id]?.title || "", target: e.target.value } }))}
                      placeholder="Target (100)"
                      className="w-28 px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm placeholder-slate-500"
                      aria-label="Target"
                    />
                    <button
                      onClick={() => addKeyResult(o.id)}
                      className="px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm"
                    >
                      Add
                    </button>
                  </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
