"use client";

import { useEffect, useState } from "react";
import { isFinished, isOverdue } from "@/lib/status";
import { sendJSON } from "@/lib/api";

type Section = { id: string; name: string; position: number };

interface Project {
  id: string;
  name: string;
  description: string | null;
  team_id: string | null;
  created_at: string;
  can_manage?: boolean;
  auto_advance?: boolean;
  auto_complete?: boolean;
  sections?: Section[];
}

type Stats = { progress: number; total: number; done: number; overdue: number };

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [stats, setStats] = useState<Record<string, Stats>>({});
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([]);
  const [managedTeams, setManagedTeams] = useState<string[]>([]);
  const [role, setRole] = useState("member");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openProject, setOpenProject] = useState<string | null>(null);
  const [sectionsOpen, setSectionsOpen] = useState<string | null>(null);
  const [sectionCounts, setSectionCounts] = useState<Record<string, number>>({});
  const [comments, setComments] = useState<any[]>([]);
  const [draft, setDraft] = useState("");
  const [descDraft, setDescDraft] = useState("");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState({ name: "", description: "", team: "" });

  const isSuper = ["admin", "supervisor"].includes(role);
  const canCreate = isSuper || managedTeams.length > 0;

  useEffect(() => {
    (async () => {
      try {
        const [p, t, tm] = await Promise.all([fetch("/api/projects"), fetch("/api/tasks"), fetch("/api/teams")]);
        const pd = await p.json();
        if (!p.ok) throw new Error(pd.error || "Could not load projects");
        setProjects(pd.projects || []);

        if (tm.ok) {
          const d = await tm.json();
          setTeams(d.teams || []);
          setRole(d.role || "member");
          setManagedTeams(d.managedTeams || []);
        }

        // Roll task progress (already rolled up from subtasks) to project level.
        if (t.ok) {
          const tasks = (await t.json()).tasks || [];
          const s: Record<string, Stats> = {};
          const perSection: Record<string, number> = {};
          tasks.forEach((task: any) => {
            if (task.stage_id) perSection[task.stage_id] = (perSection[task.stage_id] || 0) + 1;
            if (!task.project_id) return;
            s[task.project_id] ||= { progress: 0, total: 0, done: 0, overdue: 0 };
            s[task.project_id].total += 1;
            s[task.project_id].progress += task.progress_percent || 0;
            if (isFinished(task.status)) s[task.project_id].done += 1;
            if (isOverdue(task)) s[task.project_id].overdue += 1;
          });
          Object.values(s).forEach((v) => (v.progress = Math.round(v.progress / v.total)));
          setStats(s);
          setSectionCounts(perSection);
        }
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const openPanel = async (project: Project) => {
    setOpenProject(project.id);
    setDescDraft(project.description || "");
    setComments([]);
    try {
      const c = await fetch(`/api/projects/comments?project_id=${project.id}`);
      if (c.ok) setComments((await c.json()).comments || []);
    } catch {
      setError("Could not load project details");
    }
  };

  const update = async (id: string, patch: Partial<Project>) => {
    try {
      const data = await sendJSON("/api/projects", "PUT", { id, ...patch });
      setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, ...data } : p)));
    } catch (e: any) {
      setError(e.message);
    }
  };

  // #20: sections and workflow.
  const reloadSections = async (projectId: string) => {
    const r = await fetch(`/api/sections?project_id=${projectId}`, { cache: "no-store" });
    if (r.ok) {
      const d = await r.json();
      setProjects((prev) => prev.map((p) => (p.id === projectId ? { ...p, sections: d.sections || [] } : p)));
    }
  };
  const sectionCall = async (projectId: string, method: "POST" | "PUT" | "DELETE", body: any) => {
    try {
      await sendJSON("/api/sections", method, body);
      await reloadSections(projectId);
      return true;
    } catch (e: any) {
      setError(e.message);
      return false;
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!creating.name.trim()) return;
    try {
      const p = await sendJSON("/api/projects", "POST", {
        name: creating.name.trim(),
        description: creating.description.trim() || null,
        team_id: creating.team || null,
      });
      setProjects((prev) => [p, ...prev]);
      setCreating({ name: "", description: "", team: "" });
    } catch (err: any) {
      setError(err.message);
    }
  };

  const addComment = async (projectId: string) => {
    if (!draft.trim()) return;
    try {
      const body = await sendJSON("/api/projects/comments", "POST", { project_id: projectId, content: draft.trim() });
      setComments((prev) => [...prev, body]);
      setDraft("");
    } catch (e: any) {
      setError(e.message);
    }
  };

  if (loading) return <p className="text-slate-400 p-6">Loading projects...</p>;

  const teamName = (id: string | null) => teams.find((t) => t.id === id)?.name;
  const inputCls = "px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm";
  const visible = projects.filter((p) =>
    `${p.name} ${p.description || ""} ${teamName(p.team_id) || ""}`.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="max-w-5xl mx-auto p-3 sm:p-6">
      <h1 className="text-2xl sm:text-3xl font-bold mb-4">Projects</h1>
      {error && (
        <div className="bg-red-950 border border-red-800 text-red-300 px-4 py-3 rounded mb-4 text-sm flex justify-between">
          <span>{error}</span>
          <button onClick={() => setError("")}>dismiss</button>
        </div>
      )}

      {canCreate && (
        <form onSubmit={create} className="bg-slate-800 border border-slate-700 rounded p-3 sm:p-4 mb-4 flex flex-wrap gap-2">
          <input value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} placeholder="New project name..." className={`${inputCls} flex-1 min-w-48`} />
          <input value={creating.description} onChange={(e) => setCreating({ ...creating, description: e.target.value })} placeholder="Description (optional)" className={`${inputCls} flex-1 min-w-48`} />
          <select value={creating.team} onChange={(e) => setCreating({ ...creating, team: e.target.value })} className={inputCls} aria-label="Assign to team">
            <option value="">{isSuper ? "No team yet" : "Pick your team"}</option>
            {teams.filter((t) => isSuper || managedTeams.includes(t.id)).map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          <button type="submit" disabled={!creating.name.trim()} className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-4 py-2 rounded text-sm">Create project</button>
        </form>
      )}

      <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter projects..." className={`${inputCls} w-full mb-4`} />

      {visible.length === 0 ? (
        <p className="text-slate-400">No projects{search ? " match" : " yet"}.</p>
      ) : (
        <div className="grid gap-4">
          {visible.map((project) => {
            const s = stats[project.id];
            return (
              <div key={project.id} className="p-4 sm:p-6 bg-slate-800 rounded border border-slate-700">
                <div className="flex flex-wrap justify-between items-start gap-3 mb-2">
                  <a href={`/dashboard?project=${project.id}`} className="text-xl font-bold hover:text-blue-400">{project.name}</a>
                  <div className="flex flex-wrap gap-3 text-xs">
                    <a href={`/search?project_id=${project.id}`} className="text-slate-400 hover:text-white">Search in project</a>
                    <a href={`/activity?project_id=${project.id}`} className="text-slate-400 hover:text-white">History</a>
                    <button onClick={() => setSectionsOpen(sectionsOpen === project.id ? null : project.id)} className="text-slate-400 hover:text-white">
                      {sectionsOpen === project.id ? "Hide sections" : `Sections (${project.sections?.length || 0})`}
                    </button>
                    <button onClick={() => (openProject === project.id ? setOpenProject(null) : openPanel(project))} className="text-slate-400 hover:text-white">
                      {openProject === project.id ? "Hide details" : "Details & comments"}
                    </button>
                  </div>
                </div>
                <p className="text-slate-400 text-sm">{project.description || "No description"}</p>
                <p className="text-xs text-slate-500 mt-1">
                  Team: {teamName(project.team_id) || "not assigned"} · created {new Date(project.created_at).toLocaleDateString()}
                </p>

                {s ? (
                  <div className="mt-4">
                    <div className="flex justify-between text-xs text-slate-400 mb-1">
                      <span>
                        {s.done} of {s.total} tasks done{s.overdue ? ` · ` : ""}
                        {s.overdue > 0 && <span className="text-red-400">{s.overdue} overdue</span>}
                      </span>
                      <span>{s.progress}%</span>
                    </div>
                    <div className="w-full bg-slate-900 rounded h-2">
                      <div className="bg-blue-600 h-2 rounded" style={{ width: `${s.progress}%` }} />
                    </div>
                  </div>
                ) : (
                  <p className="text-slate-500 text-xs mt-4">No tasks yet</p>
                )}

                {sectionsOpen === project.id && (
                  <SectionsPanel
                    project={project}
                    counts={sectionCounts}
                    onCall={(method, body) => sectionCall(project.id, method, body)}
                    onWorkflow={(patch) => update(project.id, patch)}
                  />
                )}

                {openProject === project.id && (
                  <div className="mt-4 pt-4 border-t border-slate-700 space-y-4">
                    {project.can_manage && (
                      <div className="space-y-2">
                        <p className="text-sm font-semibold text-slate-300">Description</p>
                        <textarea value={descDraft} onChange={(e) => setDescDraft(e.target.value)} rows={3} className={`${inputCls} w-full`} />
                        <div className="flex flex-wrap gap-2 items-center">
                          <button onClick={() => update(project.id, { description: descDraft })} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-xs">Save description</button>
                          {isSuper && (
                            <select value={project.team_id || ""} onChange={(e) => update(project.id, { team_id: e.target.value || null })} className={`${inputCls} text-xs`} aria-label="Team">
                              <option value="">No team</option>
                              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                            </select>
                          )}
                        </div>
                      </div>
                    )}

                    <div>
                      <p className="text-sm font-semibold text-slate-300 mb-2">Comments ({comments.length})</p>
                      <div className="space-y-2 mb-3">
                        {comments.map((c) => (
                          <div key={c.id} className="bg-slate-700 rounded p-3">
                            <div className="flex justify-between gap-2 mb-1 text-xs">
                              <span className="text-slate-300 font-semibold">{c.author_name || "Someone"}</span>
                              <span className="text-slate-500">{new Date(c.created_at).toLocaleString()}</span>
                            </div>
                            <p className="text-sm text-slate-200 whitespace-pre-wrap">{c.content}</p>
                          </div>
                        ))}
                      </div>
                      <div className="flex gap-2">
                        <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addComment(project.id)} placeholder="Add a comment..." className={`${inputCls} flex-1`} />
                        <button onClick={() => addComment(project.id)} className="px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm">Post</button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SectionsPanel({
  project,
  counts,
  onCall,
  onWorkflow,
}: {
  project: Project;
  counts: Record<string, number>;
  onCall: (method: "POST" | "PUT" | "DELETE", body: any) => Promise<boolean>;
  onWorkflow: (patch: Partial<Project>) => void;
}) {
  const sections = (project.sections || []).slice().sort((a, b) => a.position - b.position);
  const [name, setName] = useState("");
  const [removing, setRemoving] = useState<{ id: string; to: string } | null>(null);
  const can = !!project.can_manage;
  const inputCls = "px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm";

  const move = (i: number, dir: -1 | 1) => {
    const order = sections.map((x) => x.id);
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    onCall("PUT", { project_id: project.id, order });
  };

  return (
    <div className="mt-4 pt-4 border-t border-slate-700 space-y-3">
      <p className="text-sm font-semibold text-slate-300">Sections</p>
      <p className="text-xs text-slate-400">
        Group this project&apos;s tasks, e.g. Design, Development, Writing. On the Tasks page, pick this project and choose Board → Group by: Section to drag tasks between them.
      </p>
      <ol className="space-y-2">
        {sections.map((sec, i) => (
          <li key={sec.id} className="bg-slate-900 rounded px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-slate-500 w-5">{i + 1}.</span>
              {can ? (
                <input
                  defaultValue={sec.name}
                  key={`${sec.id}-${sec.name}`}
                  onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== sec.name && onCall("PUT", { id: sec.id, name: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  className={`${inputCls} py-1 flex-1 min-w-32`}
                  aria-label={`Section ${i + 1} name`}
                />
              ) : (
                <span className="flex-1">{sec.name}</span>
              )}
              <span className="text-xs text-slate-500">{counts[sec.id] || 0} task{counts[sec.id] === 1 ? "" : "s"}</span>
              {can && (
                <span className="flex gap-1">
                  <button onClick={() => move(i, -1)} disabled={i === 0} className="px-2 py-1 bg-slate-800 rounded disabled:opacity-30" aria-label="Move up">↑</button>
                  <button onClick={() => move(i, 1)} disabled={i === sections.length - 1} className="px-2 py-1 bg-slate-800 rounded disabled:opacity-30" aria-label="Move down">↓</button>
                  <button
                    onClick={() => setRemoving({ id: sec.id, to: sections.find((x) => x.id !== sec.id)?.id || "" })}
                    disabled={sections.length < 2}
                    className="px-2 py-1 bg-slate-800 rounded text-red-300 disabled:opacity-30"
                    aria-label="Remove section"
                    title={sections.length < 2 ? "A project needs at least one section" : "Remove"}
                  >
                    ✕
                  </button>
                </span>
              )}
            </div>
            {removing?.id === sec.id && (
              <div className="flex flex-wrap items-center gap-2 mt-2 text-xs">
                <span className="text-slate-300">Move its tasks to</span>
                <select value={removing.to} onChange={(e) => setRemoving({ ...removing, to: e.target.value })} className={`${inputCls} py-1 text-xs`} aria-label="Move tasks to">
                  {sections.filter((x) => x.id !== sec.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
                <button
                  onClick={async () => {
                    if (await onCall("DELETE", { id: sec.id, move_to: removing.to })) setRemoving(null);
                  }}
                  className="px-3 py-1 bg-red-700 hover:bg-red-600 rounded"
                >
                  Remove section
                </button>
                <button onClick={() => setRemoving(null)} className="px-3 py-1 bg-slate-700 rounded">Cancel</button>
              </div>
            )}
          </li>
        ))}
      </ol>
      {can && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (name.trim() && (await onCall("POST", { project_id: project.id, name }))) setName("");
          }}
          className="flex gap-2"
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New section, e.g. Design" className={`${inputCls} flex-1`} aria-label="New section name" />
          <button type="submit" disabled={!name.trim()} className="px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm">Add section</button>
        </form>
      )}

      <div className="bg-slate-900 rounded p-3 space-y-2 text-sm">
        <p className="font-semibold text-slate-300">Workflow</p>
        <label className="flex items-start gap-2">
          <input type="checkbox" checked={!!project.auto_complete} disabled={!can} onChange={(e) => onWorkflow({ auto_complete: e.target.checked })} className="mt-1" />
          <span>When every checklist item on a task is ticked, mark the task <b>Completed</b>.</span>
        </label>
        <label className="flex items-start gap-2">
          <input type="checkbox" checked={!!project.auto_advance} disabled={!can} onChange={(e) => onWorkflow({ auto_advance: e.target.checked })} className="mt-1" />
          <span>When a task is completed, move it to the <b>next section</b> (it shows there as Completed).</span>
        </label>
        {!can && <p className="text-xs text-slate-500">Only a supervisor or this project&apos;s team manager can change sections and workflow.</p>}
      </div>
    </div>
  );
}
