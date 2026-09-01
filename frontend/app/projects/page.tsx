"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

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
  const router = useRouter();

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
              if (t.status === "done") stats[t.project_id].done += 1;
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
              onClick={() => router.push(`/dashboard?project=${project.id}`)}
              className="p-6 bg-slate-800 rounded border border-slate-700 hover:border-blue-500 cursor-pointer"
            >
              <h2 className="text-xl font-bold mb-2">{project.name}</h2>
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
