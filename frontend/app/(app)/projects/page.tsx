"use client";

import { useEffect, useRef, useState } from "react";
import { isFinished, isOverdue } from "@/lib/status";
import { sendJSON } from "@/lib/api";
import { COLOR_SWATCHES } from "@/components/tasks/types";

type Section = { id: string; name: string; position: number };
type Person = { id: string; name: string; email: string };

interface Project {
  id: string;
  name: string;
  description: string | null;
  manager_id?: string | null;
  color?: string | null;
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
  const [people, setPeople] = useState<Person[]>([]);
  const [role, setRole] = useState("member");
  const [loading, setLoading] = useState(true);
  // Stops a double click from creating a project or comment twice.
  const busy = useRef(false);
  // The project whose details are open, for answers that arrive late.
  const openRef = useRef<string | null>(null);
  const [error, setError] = useState("");
  const [openProject, setOpenProject] = useState<string | null>(null);
  const [sectionsOpen, setSectionsOpen] = useState<string | null>(null);
  const [sectionCounts, setSectionCounts] = useState<Record<string, number>>({});
  const [comments, setComments] = useState<any[]>([]);
  const [draft, setDraft] = useState("");
  const [descDraft, setDescDraft] = useState("");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState({ name: "", description: "", manager: "", color: "" });

  const isSuper = ["admin", "supervisor"].includes(role);
  const canCreate = isSuper;

  useEffect(() => {
    (async () => {
      try {
        const [p, t, m] = await Promise.all([fetch("/api/projects"), fetch("/api/tasks"), fetch("/api/team/members")]);
        const pd = await p.json();
        if (!p.ok) throw new Error(pd.error || "Could not load projects");
        setProjects(pd.projects || []);
        // The server works out each project's figures over all of its tasks.
        const serverStats: Record<string, Stats> = {};
        const serverSections: Record<string, number> = {};
        (pd.projects || []).forEach((proj: any) => {
          if (proj.stats) serverStats[proj.id] = proj.stats;
          (proj.sections || []).forEach((sec: any) => {
            if (typeof sec.task_count === "number") serverSections[sec.id] = sec.task_count;
          });
        });
        const haveServerStats = Object.keys(serverStats).length > 0;
        if (haveServerStats) {
          setStats(serverStats);
          setSectionCounts(serverSections);
        }

        if (m.ok) {
          const d = await m.json();
          setPeople(d.members || []);
          setRole(d.myRole || "member");
        }

        // Older server without figures: roll up the tasks this person can see.
        if (t.ok && !haveServerStats) {
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
    openRef.current = project.id;
    setDescDraft(project.description || "");
    setComments([]);
    try {
      const c = await fetch(`/api/projects/comments?project_id=${project.id}`);
      const list = c.ok ? (await c.json()).comments || [] : [];
      // Opening another project meanwhile: these comments aren't for it.
      if (openRef.current === project.id) setComments(list);
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
    if (!creating.name.trim() || busy.current) return;
    busy.current = true;
    try {
      const p = await sendJSON("/api/projects", "POST", {
        name: creating.name.trim(),
        description: creating.description.trim() || null,
        manager_id: creating.manager || null,
        color: creating.color || null,
      });
      setProjects((prev) => [p, ...prev]);
      setCreating({ name: "", description: "", manager: "", color: "" });
    } catch (err: any) {
      setError(err.message);
    } finally {
      busy.current = false;
    }
  };

  const addComment = async (projectId: string) => {
    if (!draft.trim() || busy.current) return;
    busy.current = true;
    try {
      const body = await sendJSON("/api/projects/comments", "POST", { project_id: projectId, content: draft.trim() });
      setComments((prev) => [...prev, body]);
      setDraft("");
    } catch (e: any) {
      setError(e.message);
    } finally {
      busy.current = false;
    }
  };

  if (loading) return <p className="text-slate-400 p-6">Loading projects...</p>;

  const personName = (id: string | null | undefined) => (id ? people.find((p) => p.id === id)?.name || "Someone" : null);
  const inputCls = "px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm";
  const visible = projects.filter((p) =>
    `${p.name} ${p.description || ""} ${personName(p.manager_id) || ""}`.toLowerCase().includes(search.toLowerCase())
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
          {isSuper && (
            <select value={creating.manager} onChange={(e) => setCreating({ ...creating, manager: e.target.value })} className={inputCls} aria-label="Project manager (#22)" title="Project Manager: runs this project directly">
              <option value="">No project manager</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name} — Project Manager</option>)}
            </select>
          )}
          <div className="flex gap-1 items-center" role="radiogroup" aria-label="Project color">
            {COLOR_SWATCHES.map((c) => (
              <button
                key={c.value || "none"}
                type="button"
                role="radio"
                aria-checked={creating.color === c.value}
                title={c.label}
                aria-label={`Color: ${c.label}`}
                onClick={() => setCreating({ ...creating, color: c.value })}
                className={`w-6 h-6 rounded-full border-2 ${creating.color === c.value ? "border-white" : "border-slate-700"} ${c.value ? "" : "bg-slate-700 flex items-center justify-center text-[10px]"}`}
                style={c.value ? { backgroundColor: c.value } : undefined}
              >
                {!c.value && "✕"}
              </button>
            ))}
          </div>
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
                  <button onClick={() => (openProject === project.id ? setOpenProject(null) : openPanel(project))} className="text-xl font-bold hover:text-blue-400 flex items-center gap-2 text-left">
                    {project.color && <span className="inline-block w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: project.color }} title="Custom color" />}
                    {project.name}
                  </button>
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
                  Project Manager: {personName(project.manager_id) || "not assigned"}
                  {" "}· created {new Date(project.created_at).toLocaleDateString()}
                </p>

                {s && s.total > 0 ? (
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
                            <select value={project.manager_id || ""} onChange={(e) => update(project.id, { manager_id: e.target.value || null })} className={`${inputCls} text-xs`} aria-label="Project manager (#22)">
                              <option value="">No project manager</option>
                              {people.map((p) => <option key={p.id} value={p.id}>{p.name} — Project Manager</option>)}
                            </select>
                          )}
                        </div>
                        <div className="flex gap-1 items-center" role="radiogroup" aria-label="Project color">
                          <span className="text-xs text-slate-400 mr-1">Color:</span>
                          {COLOR_SWATCHES.map((c) => (
                            <button
                              key={c.value || "none"}
                              type="button"
                              role="radio"
                              aria-checked={(project.color || "") === c.value}
                              title={c.label}
                              aria-label={`Color: ${c.label}`}
                              onClick={() => update(project.id, { color: c.value || null })}
                              className={`w-5 h-5 rounded-full border-2 ${(project.color || "") === c.value ? "border-white" : "border-slate-700"} ${c.value ? "" : "bg-slate-700 flex items-center justify-center text-[9px]"}`}
                              style={c.value ? { backgroundColor: c.value } : undefined}
                            >
                              {!c.value && "✕"}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <ProjectMembers project={project} people={people} />

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

/**
 * Who works on this project. Being a member is what lets someone see and work
 * on the project's tasks; a member marked "manager" runs it alongside the
 * project manager.
 */
function ProjectMembers({ project, people }: { project: Project; people: Person[] }) {
  type Member = { id: string; user_id: string; role: string; name: string; email: string | null };
  const [members, setMembers] = useState<Member[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputCls = "px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm";

  const load = async () => {
    try {
      const r = await fetch(`/api/projects/members?project_id=${project.id}`, { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      setMembers(d.members || []);
      setCanManage(!!d.can_manage);
    } catch {
      /* leave the list as it is */
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const run = async (fn: () => Promise<any>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e: any) {
      setError(e.message || "That didn't work");
    } finally {
      setBusy(false);
    }
  };

  const add = () => {
    if (!pick) return;
    run(async () => {
      await sendJSON("/api/projects/members", "POST", { project_id: project.id, user_id: pick, role: "member" });
      setPick("");
    });
  };

  const setRole = (id: string, role: string) =>
    run(() => sendJSON("/api/projects/members", "PUT", { id, role }));

  const remove = (id: string) =>
    run(async () => {
      const r = await fetch(`/api/projects/members?id=${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json())?.error || "Could not remove them");
    });

  const onProject = new Set(members.map((m) => m.user_id));
  const addable = people.filter((p) => !onProject.has(p.id));

  return (
    <div>
      <p className="text-sm font-semibold text-slate-300 mb-2">Project members ({members.length})</p>
      {error && <p className="text-xs text-red-400 mb-2">{error}</p>}

      {members.length === 0 ? (
        <p className="text-xs text-slate-500 mb-2">Nobody on this project yet.</p>
      ) : (
        <div className="space-y-1 mb-2">
          {members.map((m) => (
            <div key={m.id} className="flex items-center justify-between gap-2 bg-slate-700 rounded px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm text-slate-100 truncate">{m.name}</p>
                {m.email && <p className="text-xs text-slate-400 truncate">{m.email}</p>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {canManage ? (
                  <select
                    value={m.role}
                    disabled={busy}
                    onChange={(e) => setRole(m.id, e.target.value)}
                    className={`${inputCls} text-xs py-1`}
                    aria-label={`Role for ${m.name}`}
                  >
                    <option value="member">Member</option>
                    <option value="manager">Manager</option>
                  </select>
                ) : (
                  <span className="text-xs text-slate-400">{m.role === "manager" ? "Manager" : "Member"}</span>
                )}
                {canManage && (
                  <button
                    onClick={() => remove(m.id)}
                    disabled={busy}
                    className="text-xs text-slate-400 hover:text-red-400 disabled:opacity-50"
                    aria-label={`Remove ${m.name} from this project`}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {canManage && addable.length > 0 && (
        <div className="flex gap-2">
          <select value={pick} onChange={(e) => setPick(e.target.value)} className={`${inputCls} flex-1 text-sm`} aria-label="Add someone to this project">
            <option value="">Add someone…</option>
            {addable.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <button
            onClick={add}
            disabled={busy || !pick}
            className="px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm"
          >
            Add
          </button>
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
        Organise this project&apos;s tasks, e.g. Design, Development, Writing. On the Tasks page, pick this project and choose Board → Arrange by: Section to drag tasks between them.
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
        {!can && <p className="text-xs text-slate-500">Only a supervisor or this project&apos;s manager can change sections and workflow.</p>}
      </div>
    </div>
  );
}
