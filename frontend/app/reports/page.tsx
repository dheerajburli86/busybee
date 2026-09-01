"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Task = {
  id: string;
  title: string;
  status: string;
  priority: string;
  progress_percent: number;
  due_date: string | null;
  assigned_to: string | null;
  project_id: string | null;
  created_at: string;
};

type Member = { id: string; name: string; email: string };
type Project = { id: string; name: string };

const PERIODS = [
  { value: "daily", label: "Daily", days: 1 },
  { value: "weekly", label: "Weekly", days: 7 },
  { value: "monthly", label: "Monthly", days: 30 },
];

export default function ReportsPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [period, setPeriod] = useState("weekly");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const router = useRouter();

  useEffect(() => {
    (async () => {
      try {
        const [t, m, p] = await Promise.all([
          fetch("/api/tasks"),
          fetch("/api/team/members"),
          fetch("/api/projects"),
        ]);
        if (!t.ok) throw new Error("Could not load tasks");
        setTasks((await t.json()).tasks || []);
        if (m.ok) setMembers((await m.json()).members || []);
        if (p.ok) setProjects((await p.json()).projects || []);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const days = PERIODS.find((p) => p.value === period)?.days ?? 7;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const inPeriod = tasks.filter((t) => new Date(t.created_at) >= cutoff);
  const completed = tasks.filter(
    (t) => t.status === "done" && new Date(t.created_at) >= cutoff
  );
  const overdue = tasks.filter((t) => {
    if (!t.due_date || t.status === "done") return false;
    return new Date(t.due_date) < new Date();
  });

  const avgProgress =
    tasks.length > 0
      ? Math.round(tasks.reduce((sum, t) => sum + (t.progress_percent || 0), 0) / tasks.length)
      : 0;

  // Per-person breakdown for the selected window.
  const byMember = members.map((m) => {
    const assigned = tasks.filter((t) => t.assigned_to === m.id);
    const doneCount = assigned.filter((t) => t.status === "done").length;
    return {
      name: m.name || m.email,
      assigned: assigned.length,
      done: doneCount,
      openCount: assigned.length - doneCount,
      pct: assigned.length ? Math.round((doneCount / assigned.length) * 100) : 0,
    };
  });

  // Per-project breakdown.
  const byProject = projects.map((pr) => {
    const list = tasks.filter((t) => t.project_id === pr.id);
    const doneCount = list.filter((t) => t.status === "done").length;
    return {
      name: pr.name,
      total: list.length,
      done: doneCount,
      pct: list.length ? Math.round((doneCount / list.length) * 100) : 0,
    };
  });

  if (loading) return <p className="text-slate-400 p-6">Building report...</p>;

  return (
    <div className="p-6 bg-slate-950 min-h-screen">
      <div className="max-w-5xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-3xl font-bold">MIS Report</h1>
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

        <div className="flex gap-2 mb-6">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              className={`px-4 py-2 rounded text-sm ${
                period === p.value
                  ? "bg-blue-600 text-white"
                  : "bg-slate-800 text-slate-300 hover:bg-slate-700"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <div className="bg-slate-800 border border-slate-700 rounded p-4">
            <p className="text-2xl font-bold">{tasks.length}</p>
            <p className="text-slate-400 text-sm">Total tasks</p>
          </div>
          <div className="bg-slate-800 border border-slate-700 rounded p-4">
            <p className="text-2xl font-bold text-blue-400">{inPeriod.length}</p>
            <p className="text-slate-400 text-sm">Created this period</p>
          </div>
          <div className="bg-slate-800 border border-slate-700 rounded p-4">
            <p className="text-2xl font-bold text-green-500">{completed.length}</p>
            <p className="text-slate-400 text-sm">Completed</p>
          </div>
          <div className="bg-slate-800 border border-slate-700 rounded p-4">
            <p className="text-2xl font-bold text-red-500">{overdue.length}</p>
            <p className="text-slate-400 text-sm">Overdue</p>
          </div>
        </div>

        <div className="bg-slate-800 border border-slate-700 rounded p-4 mb-8">
          <div className="flex justify-between text-sm mb-2">
            <span className="text-slate-300 font-semibold">Overall progress</span>
            <span className="text-slate-400">{avgProgress}%</span>
          </div>
          <div className="w-full bg-slate-900 rounded h-3">
            <div className="bg-blue-600 h-3 rounded" style={{ width: `${avgProgress}%` }} />
          </div>
        </div>

        <h2 className="text-lg font-semibold mb-3">By team member</h2>
        <div className="bg-slate-800 border border-slate-700 rounded overflow-hidden mb-8">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-slate-400">
              <tr>
                <th className="text-left px-4 py-2">Member</th>
                <th className="text-right px-4 py-2">Assigned</th>
                <th className="text-right px-4 py-2">Done</th>
                <th className="text-right px-4 py-2">Open</th>
                <th className="text-right px-4 py-2">Rate</th>
              </tr>
            </thead>
            <tbody>
              {byMember.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-3 text-slate-500">
                    No team members yet.
                  </td>
                </tr>
              ) : (
                byMember.map((r) => (
                  <tr key={r.name} className="border-t border-slate-700">
                    <td className="px-4 py-2 text-slate-300">{r.name}</td>
                    <td className="px-4 py-2 text-right text-slate-400">{r.assigned}</td>
                    <td className="px-4 py-2 text-right text-green-500">{r.done}</td>
                    <td className="px-4 py-2 text-right text-slate-400">{r.openCount}</td>
                    <td className="px-4 py-2 text-right text-slate-300">{r.pct}%</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <h2 className="text-lg font-semibold mb-3">By project</h2>
        <div className="bg-slate-800 border border-slate-700 rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-slate-400">
              <tr>
                <th className="text-left px-4 py-2">Project</th>
                <th className="text-right px-4 py-2">Tasks</th>
                <th className="text-right px-4 py-2">Done</th>
                <th className="text-right px-4 py-2">Rate</th>
              </tr>
            </thead>
            <tbody>
              {byProject.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-3 text-slate-500">
                    No projects yet.
                  </td>
                </tr>
              ) : (
                byProject.map((r) => (
                  <tr key={r.name} className="border-t border-slate-700">
                    <td className="px-4 py-2 text-slate-300">{r.name}</td>
                    <td className="px-4 py-2 text-right text-slate-400">{r.total}</td>
                    <td className="px-4 py-2 text-right text-green-500">{r.done}</td>
                    <td className="px-4 py-2 text-right text-slate-300">{r.pct}%</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
