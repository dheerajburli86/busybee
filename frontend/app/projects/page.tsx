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
