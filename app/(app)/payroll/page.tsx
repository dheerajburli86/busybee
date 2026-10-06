"use client";

// Step 11 of the assignment flow: the month's rewards and penalties, totalled
// per person, for whoever runs payroll to apply.
//
// This page pays nobody. It is a statement of what was recorded, who recorded
// it and why, so that a figure can be traced back to a task and a decision
// before it ever reaches a salary. A supervisor sees their whole desk; anyone
// else sees only their own entries, which is enforced by the database rather
// than by this page.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { rupees } from "@/components/tasks/TaskWorkflow";
import { formatDue } from "@/components/tasks/types";

type Row = { user_id: string; name: string; reward: number; penalty: number; net: number; count: number };
type Entry = {
  id: string;
  task_id: string | null;
  task_title: string;
  person: string;
  by: string;
  kind: "reward" | "penalty";
  amount: number;
  reason: string;
  created_at: string;
  voided_at: string | null;
  void_reason: string | null;
};

function thisMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function PayrollPage() {
  const [month, setMonth] = useState(thisMonth());
  const [rows, setRows] = useState<Row[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [totals, setTotals] = useState({ reward: 0, penalty: 0, net: 0 });
  const [isSupervisor, setIsSupervisor] = useState(false);
  const [desk, setDesk] = useState("");
  const [desks, setDesks] = useState<{ desk_id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const router = useRouter();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ month });
      if (desk) qs.set("desk", desk);
      const res = await fetch(`/api/payroll?${qs.toString()}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || "Could not load the report");
      const data = await res.json();
      setRows(data.rows || []);
      setEntries(data.entries || []);
      setTotals(data.totals || { reward: 0, penalty: 0, net: 0 });
      setIsSupervisor(!!data.is_supervisor);
      setDesks(data.desks || []);
      if (!desk && data.desk_id) setDesk(data.desk_id);
      setError("");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [month, desk]);

  useEffect(() => {
    load();
  }, [load]);

  const csv = () => {
    // Built for whoever applies it: "Net amount" is signed (penalties
    // negative) and is 0 for cancelled entries, so summing that one column
    // gives the right figure. Text that a spreadsheet would treat as a formula
    // is neutralised.
    const cell = (v: unknown) => {
      let t = String(v ?? "");
      if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
      return `"${t.replace(/"/g, '""')}"`;
    };
    const head = ["Person", "Kind", "Amount", "Net amount", "Status", "Task", "Reason", "Recorded by", "Date", "Cancel reason"];
    const lines = entries.map((e) => {
      const signed = e.voided_at ? 0 : e.kind === "penalty" ? -Number(e.amount) : Number(e.amount);
      return [
        cell(e.person),
        cell(e.kind),
        Number(e.amount).toFixed(2),
        signed.toFixed(2),
        cell(e.voided_at ? "cancelled" : "active"),
        cell(e.task_title),
        cell(e.reason),
        cell(e.by),
        cell(e.created_at),
        cell(e.void_reason || ""),
      ].join(",");
    });
    const blob = new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `busybee-payroll-${month}${desks.length > 1 ? `-${(desks.find((d) => d.desk_id === desk)?.name || "desk").replace(/\W+/g, "-")}` : ""}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-3 sm:p-6">
      <div className="max-w-5xl mx-auto">
        <div className="flex flex-wrap justify-between items-center gap-3 mb-6">
          <h1 className="text-3xl font-bold">Payroll adjustments</h1>
          <button onClick={() => router.push("/dashboard")} className="text-sm text-slate-400 hover:text-white">
            Back to tasks
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 mb-6">
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value || thisMonth())}
            className="px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm"
            aria-label="Month"
          />
          {desks.length > 1 && (
            <select
              value={desk}
              onChange={(e) => setDesk(e.target.value)}
              className="px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm"
              aria-label="Desk"
            >
              {desks.map((d) => (
                <option key={d.desk_id} value={d.desk_id}>
                  {d.name}
                </option>
              ))}
            </select>
          )}
          {entries.length > 0 && (
            <button onClick={csv} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm">
              Download CSV
            </button>
          )}
        </div>

        {error && (
          <div className="bg-red-950 border border-red-800 text-red-300 px-4 py-3 rounded mb-4 text-sm">{error}</div>
        )}

        {loading ? (
          <p className="text-slate-400">Loading...</p>
        ) : rows.length === 0 ? (
          <p className="text-slate-400">Nothing recorded for this month.</p>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
              <div className="bg-slate-800 border border-slate-700 rounded p-4">
                <p className="text-2xl font-bold text-green-400">{rupees(totals.reward)}</p>
                <p className="text-slate-400 text-sm">Rewards</p>
              </div>
              <div className="bg-slate-800 border border-slate-700 rounded p-4">
                <p className="text-2xl font-bold text-red-400">{rupees(totals.penalty)}</p>
                <p className="text-slate-400 text-sm">Penalties</p>
              </div>
              <div className="bg-slate-800 border border-slate-700 rounded p-4">
                <p className={`text-2xl font-bold ${totals.net < 0 ? "text-red-400" : "text-green-400"}`}>
                  {rupees(totals.net)}
                </p>
                <p className="text-slate-400 text-sm">Net</p>
              </div>
            </div>

            <div className="bg-slate-800 border border-slate-700 rounded overflow-x-auto mb-6">
              <table className="w-full text-sm">
                <thead className="text-slate-400 border-b border-slate-700">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium">Person</th>
                    <th className="text-right px-4 py-3 font-medium">Rewards</th>
                    <th className="text-right px-4 py-3 font-medium">Penalties</th>
                    <th className="text-right px-4 py-3 font-medium">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.user_id} className="border-b border-slate-700 last:border-0">
                      <td className="px-4 py-3">{r.name}</td>
                      <td className="px-4 py-3 text-right text-green-400">{r.reward ? rupees(r.reward) : "-"}</td>
                      <td className="px-4 py-3 text-right text-red-400">{r.penalty ? rupees(r.penalty) : "-"}</td>
                      <td className={`px-4 py-3 text-right font-medium ${r.net < 0 ? "text-red-400" : "text-green-400"}`}>
                        {rupees(r.net)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h2 className="text-lg font-semibold mb-3">Every entry</h2>
            <div className="space-y-2">
              {entries.map((e) => (
                <div
                  key={e.id}
                  className={`bg-slate-800 border border-slate-700 rounded p-3 text-sm ${e.voided_at ? "opacity-60" : ""}`}
                >
                  <div className="flex flex-wrap justify-between gap-2">
                    <span className={e.kind === "reward" ? "text-green-400" : "text-red-400"}>
                      {e.kind === "reward" ? "Reward" : "Penalty"} {rupees(e.amount)} · {e.person}
                      {e.voided_at && <span className="text-slate-400"> (cancelled)</span>}
                    </span>
                    <span className="text-slate-500 text-xs">{formatDue(e.created_at)}</span>
                  </div>
                  <p className="text-slate-300 mt-1">"{e.reason}"</p>
                  <p className="text-slate-500 text-xs mt-1">
                    {e.task_id ? (
                      <a href={`/dashboard?task=${e.task_id}`} className="hover:text-white underline">
                        {e.task_title}
                      </a>
                    ) : (
                      e.task_title
                    )}{" "}
                    · recorded by {e.by}
                  </p>
                  {e.voided_at && <p className="text-slate-400 text-xs mt-1">Cancelled: "{e.void_reason}"</p>}
                </div>
              ))}
            </div>
          </>
        )}

        <p className="text-xs text-slate-500 mt-8">
          BusyBee does not pay or deduct anything. This is the record finance works from.
          {isSupervisor
            ? " You see this desk because you're a supervisor."
            : " You see only entries recorded against you."}
        </p>
      </div>
    </div>
  );
}
