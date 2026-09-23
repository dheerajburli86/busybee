"use client";

// Checklist #38 / SOW #42: daily, weekly and monthly MIS reports - task
// completion, status distribution, project and member performance, overdue
// work and the activity log for the period - with CSV export and print-to-PDF.

import { useEffect, useState } from "react";

type Report = {
  period: string;
  window: { start: string; end: string };
  summary: { open: number; created: number; completed: number; completed_late: number; overdue: number; avg_progress: number; hours: number };
  statusDistribution: { status: string; label: string; count: number }[];
  byMember: { id: string; name: string; assigned_open: number; completed: number; on_time_rate: number | null; overdue: number; actions: number; hours: number }[];
  byProject: { id: string; name: string; total: number; done: number; completed_in_period: number; overdue: number; progress: number }[];
  days: { date: string; completed: number; created: number }[];
  overdue: { id: string; title: string; assignee: string; project: string | null; due_date: string; days_late: number; progress: number }[];
  completed: { id: string; title: string; assignee: string; completed_at: string; due_date: string | null; on_time: boolean }[];
  activity: { id: string; action: string; user_name?: string; created_at: string; task_title: string | null }[];
};

const PERIODS = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-slate-500",
  in_progress: "bg-blue-600",
  need_help: "bg-amber-500",
  done: "bg-green-600",
  closed: "bg-slate-400",
};

function toCsv(rows: Record<string, any>[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: any) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

export default function ReportsPage() {
  const [period, setPeriod] = useState("weekly");
  const [date, setDate] = useState(() => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10));
  const [projectId, setProjectId] = useState("");
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/projects").then((r) => (r.ok ? r.json() : { projects: [] })).then((d) => setProjects(d.projects || []));
  }, []);

  useEffect(() => {
    // Switching period quickly: only the latest request may fill the page.
    let current = true;
    setLoading(true);
    setError("");
    const qs = new URLSearchParams({ period, date, ...(projectId ? { project_id: projectId } : {}) });
    fetch(`/api/reports?${qs}`, { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || "Could not build the report");
        if (current) setReport(d);
      })
      .catch((e) => current && setError(e.message))
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, [period, date, projectId]);

  const download = () => {
    if (!report) return;
    const sections: [string, Record<string, any>[]][] = [
      ["Summary", [{ period: report.period, from: report.window.start, to: report.window.end, ...report.summary }]],
      ["Status distribution", report.statusDistribution.map(({ label, count }) => ({ status: label, tasks: count }))],
      ["By project", report.byProject.map(({ id, ...r }) => r)],
      ["By member", report.byMember.map(({ id, ...r }) => r)],
      ["Completed in period", report.completed.map(({ id, ...r }) => r)],
      ["Overdue", report.overdue.map(({ id, ...r }) => r)],
      ["Activity", report.activity.map((a) => ({ when: a.created_at, who: a.user_name, task: a.task_title, action: a.action }))],
    ];
    const text = sections.map(([title, rows]) => `${title}\n${toCsv(rows) || "(none)"}`).join("\n\n");
    // The byte-order mark makes Excel read names with non-English letters correctly.
    const url = URL.createObjectURL(new Blob(["\uFEFF" + text], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `busybee-${report.period}-report-${date}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Give the browser time to start the download before freeing it.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  const card = "bg-slate-800 border border-slate-700 rounded p-4";
  const th = "text-left px-3 py-2 font-medium";
  const td = "px-3 py-2";
  const maxDay = Math.max(1, ...(report?.days || []).map((d) => Math.max(d.completed, d.created)));
  const totalStatus = Math.max(1, (report?.statusDistribution || []).reduce((s, x) => s + x.count, 0));

  return (
    <div className="max-w-6xl mx-auto p-3 sm:p-6 print:p-0">
      <div className="flex flex-wrap justify-between items-center gap-3 mb-4">
        <h1 className="text-2xl sm:text-3xl font-bold">MIS Report</h1>
        <div className="flex gap-2 print:hidden">
          <button onClick={download} disabled={!report} className="px-3 py-2 bg-slate-800 hover:bg-slate-700 rounded text-sm">Export CSV</button>
          <button onClick={() => window.print()} disabled={!report} className="px-3 py-2 bg-slate-800 hover:bg-slate-700 rounded text-sm">Print / PDF</button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-6 print:hidden">
        {PERIODS.map((p) => (
          <button key={p.value} onClick={() => setPeriod(p.value)}
            className={`px-4 py-2 rounded text-sm ${period === p.value ? "bg-blue-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}>
            {p.label}
          </button>
        ))}
        <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="px-3 py-2 bg-slate-800 border border-slate-700 rounded text-sm" aria-label="Report date (the day, week or month containing it)" />
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="px-3 py-2 bg-slate-800 border border-slate-700 rounded text-sm" aria-label="Project">
          <option value="">All projects</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      {error && <div className="bg-red-950 border border-red-800 text-red-300 px-4 py-3 rounded mb-4 text-sm">{error}</div>}
      {loading && <p className="text-slate-400">Building report...</p>}

      {report && !loading && (
        <>
          <p className="text-sm text-slate-400 mb-4">
            {new Date(report.window.start).toLocaleDateString()} – {new Date(report.window.end).toLocaleDateString()}
          </p>

          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
            {[
              ["Open now", report.summary.open, ""],
              ["Created", report.summary.created, "text-blue-400"],
              ["Completed", report.summary.completed, "text-green-500"],
              ["Finished late", report.summary.completed_late, "text-amber-400"],
              ["Overdue now", report.summary.overdue, "text-red-500"],
              ["Hours logged", report.summary.hours, "text-slate-200"],
            ].map(([label, value, cls]) => (
              <div key={label as string} className={card}>
                <p className={`text-2xl font-bold ${cls}`}>{value as number}</p>
                <p className="text-slate-400 text-xs">{label}</p>
              </div>
            ))}
          </div>

          <div className="grid lg:grid-cols-2 gap-4 mb-6">
            <div className={card}>
              <h2 className="font-semibold mb-3">Status distribution</h2>
              <div className="flex h-4 rounded overflow-hidden mb-3">
                {report.statusDistribution.map((s) => (
                  <div key={s.status} className={STATUS_COLORS[s.status]} style={{ width: `${(s.count / totalStatus) * 100}%` }} title={`${s.label}: ${s.count}`} />
                ))}
              </div>
              <ul className="grid grid-cols-2 gap-1 text-sm">
                {report.statusDistribution.map((s) => (
                  <li key={s.status}><span className={`inline-block w-3 h-3 rounded mr-2 align-middle ${STATUS_COLORS[s.status]}`} />{s.label}: {s.count}</li>
                ))}
              </ul>
              <p className="text-xs text-slate-400 mt-3">Average progress on open work: {report.summary.avg_progress}%</p>
            </div>

            <div className={card}>
              <h2 className="font-semibold mb-3">Created vs completed per day</h2>
              <div className="flex items-end gap-1 h-32 overflow-x-auto">
                {report.days.map((d) => (
                  <div key={d.date} className="flex flex-col items-center justify-end h-full min-w-[14px] flex-1" title={`${d.date}: ${d.created} created, ${d.completed} completed`}>
                    <div className="flex items-end gap-px h-full w-full justify-center">
                      <div className="bg-blue-500 w-1/2 rounded-t" style={{ height: `${(d.created / maxDay) * 100}%` }} />
                      <div className="bg-green-500 w-1/2 rounded-t" style={{ height: `${(d.completed / maxDay) * 100}%` }} />
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex justify-between text-[10px] text-slate-500 mt-1">
                <span>{report.days[0]?.date}</span>
                <span>{report.days[report.days.length - 1]?.date}</span>
              </div>
              <p className="text-xs text-slate-400 mt-2">
                <span className="inline-block w-3 h-3 bg-blue-500 rounded mr-1 align-middle" />Created
                <span className="inline-block w-3 h-3 bg-green-500 rounded mx-1 ml-3 align-middle" />Completed
              </p>
            </div>
          </div>

          <Table title="Project performance" empty="No project work in this period." headers={["Project", "Tasks", "Done", "Done this period", "Overdue", "Progress"]}
            rows={report.byProject.map((p) => [p.name, p.total, p.done, p.completed_in_period, p.overdue, `${p.progress}%`])} />

          <Table title="By member" empty="No activity in this period." headers={["Member", "Open", "Completed", "On time", "Overdue", "Actions", "Hours"]}
            rows={report.byMember.map((m) => [m.name, m.assigned_open, m.completed, m.on_time_rate === null ? "–" : `${m.on_time_rate}%`, m.overdue, m.actions, m.hours])} />

          <Table title={`Completed this period (${report.completed.length})`} empty="Nothing completed in this period." headers={["Task", "By", "Finished", "Due", ""]}
            rows={report.completed.map((c) => [c.title, c.assignee, new Date(c.completed_at).toLocaleString(), c.due_date ? new Date(c.due_date).toLocaleString() : "–", c.on_time ? "on time" : "late"])} />

          <Table title={`Overdue (${report.overdue.length})`} empty="Nothing overdue." headers={["Task", "Assignee", "Project", "Due", "Days late", "Progress"]}
            rows={report.overdue.map((o) => [o.title, o.assignee, o.project || "–", new Date(o.due_date).toLocaleString(), o.days_late, `${o.progress}%`])} />

          <div className={`${card} mb-6`}>
            <h2 className="font-semibold mb-3">Activity in this period ({report.activity.length})</h2>
            {report.activity.length === 0 ? (
              <p className="text-sm text-slate-500">No recorded activity.</p>
            ) : (
              <ul className="space-y-1 text-sm max-h-96 overflow-y-auto print:max-h-none">
                {report.activity.map((a) => (
                  <li key={a.id} className="flex flex-wrap gap-x-2">
                    <span className="text-slate-500 text-xs w-36 shrink-0">{new Date(a.created_at).toLocaleString()}</span>
                    <span className="font-semibold text-slate-200">{a.user_name}</span>
                    <span className="text-slate-300">{a.action}</span>
                    {a.task_title && <span className="text-slate-400">on "{a.task_title}"</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );

  function Table({ title, headers, rows, empty }: { title: string; headers: string[]; rows: (string | number)[][]; empty: string }) {
    return (
      <div className="mb-6">
        <h2 className="font-semibold mb-2">{title}</h2>
        <div className="bg-slate-800 border border-slate-700 rounded table-scroll">
          <table className="w-full text-sm min-w-[520px]">
            <thead className="bg-slate-900 text-slate-400">
              <tr>{headers.map((h, i) => <th key={i} className={`${th} ${i > 0 ? "text-right" : ""}`}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={headers.length} className={`${td} text-slate-500`}>{empty}</td></tr>
              ) : (
                rows.map((r, i) => (
                  <tr key={i} className="border-t border-slate-700">
                    {r.map((c, j) => <td key={j} className={`${td} ${j > 0 ? "text-right text-slate-300" : "text-slate-200"}`}>{c}</td>)}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
}
