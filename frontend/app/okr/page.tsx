"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Objective = {
  id: string;
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
  const [error, setError] = useState("");
  const [newObjective, setNewObjective] = useState("");
  const [newKr, setNewKr] = useState<Record<string, string>>({});
  const router = useRouter();

  const load = async () => {
    try {
      const [o, t] = await Promise.all([fetch("/api/okr"), fetch("/api/tasks")]);
      if (!o.ok) throw new Error("Could not load OKRs");
      const data = await o.json();
      setObjectives(data.objectives || []);
      setKeyResults(data.keyResults || []);
      if (t.ok) setTasks((await t.json()).tasks || []);
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
    if (!newObjective.trim()) return;
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
    }
  };

  const addKeyResult = async (objectiveId: string) => {
    const title = (newKr[objectiveId] || "").trim();
    if (!title) return;
    try {
      const res = await fetch("/api/okr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objective_id: objectiveId, title }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Could not add key result");
      setKeyResults((prev) => [...prev, body]);
      setNewKr((prev) => ({ ...prev, [objectiveId]: "" }));
    } catch (e: any) {
      setError(e.message);
    }
  };

  const updateKr = async (kr: KeyResult, value: number) => {
    setKeyResults((prev) =>
      prev.map((k) => (k.id === kr.id ? { ...k, current_value: value } : k))
    );
    try {
      await fetch("/api/okr", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key_result_id: kr.id, current_value: value }),
      });
    } catch {
      setError("Could not save that value");
    }
  };

  // An objective's progress is the mean of its key results.
  const objectiveProgress = (objId: string) => {
    const krs = keyResults.filter((k) => k.objective_id === objId);
    if (krs.length === 0) return 0;
    const total = krs.reduce((sum, k) => {
      const target = Number(k.target_value) || 1;
      return sum + Math.min((Number(k.current_value) / target) * 100, 100);
    }, 0);
    return Math.round(total / krs.length);
  };

  if (loading) return <p className="text-slate-400 p-6">Loading OKRs...</p>;

  return (
    <div className="p-6 bg-slate-950 min-h-screen">
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
          <div className="bg-red-950 border border-red-800 text-red-300 px-4 py-3 rounded mb-4 text-sm">
            {error}
          </div>
        )}

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
                        const kpct = Math.min(
                          Math.round((Number(k.current_value) / target) * 100),
                          100
                        );
                        // SOW #36: tasks linked to this key result
                        const linked = tasks.filter((t) => t.key_result_id === k.id);
                        return (
                          <div key={k.id} className="bg-slate-700 rounded p-3">
                            <div className="flex justify-between items-center gap-2 mb-2">
                              <span className="text-sm text-slate-200">{k.title}</span>
                              <div className="flex items-center gap-2 shrink-0">
                                <input
                                  type="number"
                                  value={k.current_value}
                                  onChange={(e) => updateKr(k, Number(e.target.value))}
                                  className="w-20 px-2 py-1 bg-slate-900 border border-slate-600 rounded text-xs"
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
                              <p className="text-xs text-slate-400 mt-2">
                                {linked.length} linked task{linked.length !== 1 ? "s" : ""}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <div className="flex gap-2">
                    <input
                      value={newKr[o.id] || ""}
                      onChange={(e) =>
                        setNewKr((prev) => ({ ...prev, [o.id]: e.target.value }))
                      }
                      placeholder="Add a key result..."
                      className="flex-1 px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm placeholder-slate-500"
                    />
                    <button
                      onClick={() => addKeyResult(o.id)}
                      className="px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm"
                    >
                      Add
                    </button>
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
