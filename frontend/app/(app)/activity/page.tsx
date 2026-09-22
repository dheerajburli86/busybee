"use client";

// Checklist #41: history of every action across projects and tasks - who did
// what, when, and what it changed - filterable by project, person and dates.

import { useEffect, useState } from "react";

type Entry = {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  user_name?: string;
  performed_by: string;
  created_at: string;
  changes: any;
  task_title: string | null;
};

const FIELD_LABELS: Record<string, string> = {
  stage_id: "section",
  project_id: "project",
  assigned_to: "assignee",
  task_manager_id: "task manager",
  key_result_id: "OKR link",
  team_id: "team",
  department_id: "department",
  group_id: "group",
  due_date: "due date",
  start_date: "start date",
  progress_percent: "progress",
  archived_at: "archived",
  remind_at: "reminder",
};

function show(v: any) {
  if (v === null || v === undefined || v === "") return "none";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v).toLocaleString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export default function ActivityPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [projectId, setProjectId] = useState("");
  const [person, setPerson] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Don't load until the project in the address (?project_id=) has been read,
  // or the desk-wide history could arrive last and replace the project's.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("project_id");
    if (p) setProjectId(p);
    setReady(true);
    Promise.all([fetch("/api/projects"), fetch("/api/team/members")])
      .then(async ([pr, m]) => {
        if (pr.ok) setProjects((await pr.json()).projects || []);
        if (m.ok) setPeople((await m.json()).members || []);
      })
      .catch(() => {
        /* the filters just stay empty */
      });
  }, []);

  useEffect(() => {
    if (!ready) return;
    let current = true;
    setLoading(true);
    setError("");
    const qs = new URLSearchParams();
    if (projectId) qs.set("project_id", projectId);
    if (person) qs.set("user_id", person);
    if (from) qs.set("from", new Date(`${from}T00:00:00`).toISOString());
    if (to) qs.set("to", new Date(`${to}T23:59:59`).toISOString());
    fetch(`/api/activity?${qs}`, { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!current) return;
        if (!r.ok) throw new Error(d.error || "Could not load history");
        setEntries(d.entries || []);
        setNames(d.names || {});
      })
      .catch((e) => current && setError(e.message))
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, [ready, projectId, person, from, to]);

  const inputCls = "px-3 py-2 bg-slate-800 border border-slate-700 rounded text-sm";

  // Group by day for readability.
  const byDay = entries.reduce((acc, e) => {
    const k = new Date(e.created_at).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    (acc[k] ||= []).push(e);
    return acc;
  }, {} as Record<string, Entry[]>);

  return (
    <div className="max-w-4xl mx-auto p-3 sm:p-6">
      <h1 className="text-2xl sm:text-3xl font-bold mb-4">Activity history</h1>
      <div className="flex flex-wrap gap-2 mb-6">
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={inputCls} aria-label="Project">
          <option value="">All projects</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={person} onChange={(e) => setPerson(e.target.value)} className={inputCls} aria-label="Person">
          <option value="">Everyone</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} aria-label="From" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} aria-label="To" />
      </div>

      {error && <div className="bg-red-950 border border-red-800 text-red-300 px-4 py-3 rounded mb-4 text-sm">{error}</div>}
      {loading ? (
        <p className="text-slate-400">Loading...</p>
      ) : entries.length === 0 ? (
        <p className="text-slate-400">No recorded activity for these filters.</p>
      ) : (
        Object.entries(byDay).map(([day, list]) => (
          <div key={day} className="mb-6">
            <h2 className="text-sm font-semibold text-slate-400 mb-2">{day}</h2>
            <ol className="space-y-2">
              {list.map((e) => (
                <li key={e.id} className="bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm">
                  <p>
                    <span className="text-slate-500 text-xs mr-2">{new Date(e.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                    <span className="font-semibold text-slate-200">{e.user_name || "Someone"}</span>{" "}
                    <span className="text-slate-300">{e.action}</span>
                    {e.task_title && (
                      <>
                        {" on "}
                        <a href={`/dashboard?task=${e.entity_id}`} className="text-blue-400 hover:underline">{e.task_title}</a>
                      </>
                    )}
                    {!e.task_title && e.entity_type !== "task" && <span className="text-slate-500 text-xs ml-2">({e.entity_type})</span>}
                  </p>
                  {e.changes && typeof e.changes === "object" && (
                    <ul className="text-xs text-slate-400 mt-1">
                      {Object.entries(e.changes).map(([k, v]: [string, any]) =>
                        v && typeof v === "object" && "from" in v ? (
                          <li key={k}>{FIELD_LABELS[k] || k.replace(/_/g, " ")}: {show(names[v.from] ?? v.from)} → {show(names[v.to] ?? v.to)}</li>
                        ) : null
                      )}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          </div>
        ))
      )}
    </div>
  );
}
