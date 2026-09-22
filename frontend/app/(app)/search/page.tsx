"use client";

// Checklist #42 / SOW #38: universal and project-level search across
// projects, tasks (including comments), people and files.

import { useEffect, useState } from "react";

type Results = {
  projects: { id: string; name: string; description: string | null }[];
  tasks: { id: string; title: string; status: string; project_name: string | null; matched_in: string; snippet: string | null; archived: boolean }[];
  people: { id: string; name: string; email: string; role: string }[];
  files: { id: string; file_name: string; task_id: string; task_title: string; download_url: string }[];
};

const ROLE_LABEL: Record<string, string> = {
  member: "Team member",
  manager: "Team manager",
  supervisor: "Supervisor",
  admin: "Admin",
};

const TYPES = [
  { value: "", label: "Everything" },
  { value: "projects", label: "Projects" },
  { value: "tasks", label: "Tasks" },
  { value: "people", label: "People" },
  { value: "files", label: "Files" },
];

export default function SearchPage() {
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [results, setResults] = useState<Results | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    setQ(p.get("q") || "");
    setProjectId(p.get("project_id") || "");
    fetch("/api/projects")
      .then((r) => (r.ok ? r.json() : { projects: [] }))
      .then((d) => setProjects(d.projects || []))
      .catch(() => setProjects([]));
    // A new search from the header while this page is open.
    const onSearch = (e: Event) => setQ(String((e as CustomEvent).detail || ""));
    window.addEventListener("bb-search", onSearch);
    return () => window.removeEventListener("bb-search", onSearch);
  }, []);

  useEffect(() => {
    if (q.trim().length < 2) {
      setResults(null);
      setError("");
      return;
    }
    // Only the latest search may update the screen.
    let current = true;
    const t = setTimeout(() => {
      setLoading(true);
      const qs = new URLSearchParams({ q: q.trim(), ...(type ? { type } : {}), ...(projectId ? { project_id: projectId } : {}) });
      fetch(`/api/search?${qs}`)
        .then(async (r) => {
          const d = await r.json().catch(() => ({}));
          if (!current) return;
          if (!r.ok) {
            setResults(null);
            setError(d?.error || (r.status === 401 ? "Your session has expired - please sign in again." : "Search failed"));
            return;
          }
          setError("");
          setResults({ projects: d.projects || [], tasks: d.tasks || [], people: d.people || [], files: d.files || [] });
        })
        .catch(() => current && setError("Search failed - check your connection"))
        .finally(() => current && setLoading(false));
      window.history.replaceState(null, "", `/search?${qs}`);
    }, 250);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [q, type, projectId]);

  const total = results ? results.projects.length + results.tasks.length + results.people.length + results.files.length : 0;
  const inputCls = "px-3 py-2 bg-slate-800 border border-slate-700 rounded text-sm";
  const section = "mb-6";

  return (
    <div className="max-w-4xl mx-auto p-3 sm:p-6">
      <h1 className="text-2xl sm:text-3xl font-bold mb-4">Search</h1>
      <input autoFocus type="search" value={q} onChange={(e) => setQ(e.target.value)}
        placeholder="Search projects, tasks, comments, people and files..." className={`${inputCls} w-full mb-3 text-base`} />
      <div className="flex flex-wrap gap-2 mb-6">
        {TYPES.map((t) => (
          <button key={t.value} onClick={() => setType(t.value)}
            className={`px-3 py-1.5 rounded text-sm ${type === t.value ? "bg-blue-600 text-white" : "bg-slate-800 text-slate-300"}`}>
            {t.label}
          </button>
        ))}
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={inputCls} aria-label="Search within project">
          <option value="">Whole workspace</option>
          {projects.map((p) => <option key={p.id} value={p.id}>Only in: {p.name}</option>)}
        </select>
      </div>

      {q.trim().length < 2 && <p className="text-slate-400 text-sm">Type at least two characters.</p>}
      {error && <p className="text-red-400 text-sm mb-4">{error}</p>}
      {loading && <p className="text-slate-400 text-sm">Searching...</p>}
      {results && !loading && total === 0 && <p className="text-slate-400">Nothing found for "{q}".</p>}

      {results && results.projects.length > 0 && (
        <div className={section}>
          <h2 className="text-sm font-semibold text-slate-400 mb-2">Projects</h2>
          {results.projects.map((p) => (
            <a key={p.id} href={`/dashboard?project=${p.id}`} className="block bg-slate-800 border border-slate-700 rounded p-3 mb-2 hover:border-blue-500">
              <p className="font-semibold">{p.name}</p>
              {p.description && <p className="text-sm text-slate-400">{p.description}</p>}
            </a>
          ))}
        </div>
      )}
      {results && results.tasks.length > 0 && (
        <div className={section}>
          <h2 className="text-sm font-semibold text-slate-400 mb-2">Tasks</h2>
          {results.tasks.map((t) => (
            <a key={t.id} href={`/dashboard?task=${t.id}`} className="block bg-slate-800 border border-slate-700 rounded p-3 mb-2 hover:border-blue-500">
              <p className="font-semibold">{t.title}{t.archived && <span className="text-xs text-slate-500 ml-2">archived</span>}</p>
              <p className="text-xs text-slate-500">{t.project_name || "No project"}{t.matched_in === "comment" && " · matched in a comment"}</p>
              {t.snippet && <p className="text-sm text-slate-400 mt-1 line-clamp-2">{t.snippet}</p>}
            </a>
          ))}
        </div>
      )}
      {results && results.people.length > 0 && (
        <div className={section}>
          <h2 className="text-sm font-semibold text-slate-400 mb-2">People</h2>
          {results.people.map((p) => (
            <div key={p.id} className="bg-slate-800 border border-slate-700 rounded p-3 mb-2 flex justify-between gap-2">
              <div>
                <p className="font-semibold">{p.name}</p>
                <p className="text-xs text-slate-500">{p.email} · {ROLE_LABEL[p.role] || "Team member"}</p>
              </div>
              <a href={`/dashboard?assignee=${p.id}`} className="text-xs text-blue-400 self-center">
                Their tasks
              </a>
            </div>
          ))}
        </div>
      )}
      {results && results.files.length > 0 && (
        <div className={section}>
          <h2 className="text-sm font-semibold text-slate-400 mb-2">Files</h2>
          {results.files.map((f) => (
            <div key={f.id} className="bg-slate-800 border border-slate-700 rounded p-3 mb-2 flex flex-wrap justify-between gap-2">
              <a href={f.download_url} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">{f.file_name}</a>
              <a href={`/dashboard?task=${f.task_id}`} className="text-xs text-slate-400 hover:text-white">on {f.task_title}</a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
