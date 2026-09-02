"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { isFinished } from "@/lib/status";

interface Project {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  // SOW #33: cumulative progress per project, averaged over its tasks.
  const [projectStats, setProjectStats] = useState<Record<string, { progress: number; total: number; done: number }>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // SOW #3: description editing and a per-project comment trail.
  const [openProject, setOpenProject] = useState<string | null>(null);
  const [comments, setComments] = useState<any[]>([]);
  const [draft, setDraft] = useState("");
  const [descDraft, setDescDraft] = useState("");
  const [members, setMembers] = useState<any[]>([]);
  const router = useRouter();

  const openPanel = async (project: Project) => {
    setOpenProject(project.id);
    setDescDraft(project.description || "");
    setComments([]);
    try {
      const [c, m] = await Promise.all([
        fetch(`/api/projects/comments?project_id=${project.id}`),
        fetch("/api/team/members"),
      ]);
      if (c.ok) setComments((await c.json()).comments || []);
      if (m.ok) setMembers((await m.json()).members || []);
    } catch {
      setError("Could not load project details");
    }
  };

  const saveDescription = async (projectId: string) => {
    try {
      const res = await fetch("/api/projects", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: projectId, description: descDraft }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Could not save");
      setProjects((prev) =>
        prev.map((p) => (p.id === projectId ? { ...p, description: descDraft } : p))
      );
    } catch (e: any) {
      setError(e.message);
    }
  };

  const addComment = async (projectId: string) => {
    if (!draft.trim()) return;
    try {
      const res = await fetch("/api/projects/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: projectId, content: draft.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Could not comment");
      setComments((prev) => [...prev, body]);
      setDraft("");
    } catch (e: any) {
      setError(e.message);
    }
  };

  const nameFor = (id: string) => {
    const m = members.find((x: any) => x.id === id);
    return m?.name || m?.email || "Someone";
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/projects");
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not load projects");
        setProjects(data.projects || []);

        // Roll task progress up to the project level.
        try {
          const tRes = await fetch("/api/tasks");
          if (tRes.ok) {
            const tData = await tRes.json();
            const tasks = tData.tasks || tData || [];
            const stats: Record<string, { progress: number; total: number; done: number }> = {};
            tasks.forEach((t: any) => {
              if (!t.project_id) return;
              if (!stats[t.project_id]) stats[t.project_id] = { progress: 0, total: 0, done: 0 };
              stats[t.project_id].total += 1;
              stats[t.project_id].progress += t.progress_percent || 0;
              if (isFinished(t.status)) stats[t.project_id].done += 1;
            });
            Object.keys(stats).forEach((k) => {
              stats[k].progress = Math.round(stats[k].progress / stats[k].total);
            });
            setProjectStats(stats);
          }
        } catch {
          /* cards still render without the rollup */
        }
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <p className="text-slate-400">Loading projects...</p>;

  return (
    <div className="p-6 bg-slate-950 min-h-screen">
      <h1 className="text-3xl font-bold mb-6">Your Projects</h1>

      {error && <p className="text-red-400 mb-4">{error}</p>}

      {projects.length === 0 ? (
        <p className="text-slate-400">No projects yet.</p>
      ) : (
        <div className="grid gap-4">
          {projects.map((project) => (
            <div
              key={project.id}
              className="p-6 bg-slate-800 rounded border border-slate-700"
            >
              <div className="flex justify-between items-start gap-3 mb-2">
                <h2
                  onClick={() => router.push(`/dashboard?project=${project.id}`)}
                  className="text-xl font-bold cursor-pointer hover:text-blue-400"
                >
                  {project.name}
                </h2>
                <button
                  onClick={() =>
                    openProject === project.id ? setOpenProject(null) : openPanel(project)
                  }
                  className="text-xs text-slate-400 hover:text-white shrink-0"
                >
                  {openProject === project.id ? "Hide details" : "Details & comments"}
                </button>
              </div>
              <p className="text-slate-400 text-sm">{project.description || "No description"}</p>

              {projectStats[project.id] ? (
                <div className="mt-4">
                  <div className="flex justify-between text-xs text-slate-400 mb-1">
                    <span>
                      {projectStats[project.id].done} of {projectStats[project.id].total} tasks done
                    </span>
                    <span>{projectStats[project.id].progress}%</span>
                  </div>
                  <div className="w-full bg-slate-900 rounded h-2">
                    <div
                      className="bg-blue-600 h-2 rounded"
                      style={{ width: `${projectStats[project.id].progress}%` }}
                    />
                  </div>
                </div>
              ) : (
                <p className="text-slate-500 text-xs mt-4">No tasks yet</p>
              )}

              <p className="text-slate-500 text-xs mt-4">
                Created {new Date(project.created_at).toLocaleDateString()}
              </p>

              {openProject === project.id && (
                <div className="mt-4 pt-4 border-t border-slate-700">
                  <p className="text-sm font-semibold text-slate-300 mb-2">Description</p>
                  <textarea
                    value={descDraft}
                    onChange={(e) => setDescDraft(e.target.value)}
                    rows={3}
                    placeholder="What is this project for?"
                    className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm placeholder-slate-500 mb-2"
                  />
                  <button
                    onClick={() => saveDescription(project.id)}
                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-xs mb-4"
                  >
                    Save description
                  </button>

                  <p className="text-sm font-semibold text-slate-300 mb-2">
                    Comments ({comments.length})
                  </p>
                  {comments.length > 0 && (
                    <div className="space-y-2 mb-3">
                      {comments.map((c) => (
                        <div key={c.id} className="bg-slate-700 rounded p-3">
                          <div className="flex justify-between items-baseline gap-2 mb-1">
                            <span className="text-xs text-slate-400">
                              {nameFor(c.author_id)}
                            </span>
                            <span className="text-xs text-slate-500">
                              {new Date(c.created_at).toLocaleDateString()}
                            </span>
                          </div>
                          <p className="text-sm text-slate-200 whitespace-pre-wrap">
                            {c.content}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex gap-2">
                    <input
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") addComment(project.id);
                      }}
                      placeholder="Add a comment..."
                      className="flex-1 px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm placeholder-slate-500"
                    />
                    <button
                      onClick={() => addComment(project.id)}
                      className="px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm"
                    >
                      Post
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
