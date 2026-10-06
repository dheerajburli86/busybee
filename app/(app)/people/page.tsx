"use client";

// Checklist #21: desk roles and who is allowed onto the desk. Controls only
// appear for people allowed to use them; the server enforces the same rules.

import { useEffect, useState } from "react";
import { sendJSON } from "@/lib/api";

type Person = { id: string; name: string; email: string; role?: string };

const DESK_ROLES = [
  { value: "member", label: "Member", help: "Works on what they're given; can't move deadlines" },
  { value: "manager", label: "Manager", help: "Runs the projects they're made manager of" },
  { value: "supervisor", label: "Supervisor (Project Manager)", help: "Manages every project and task" },
  { value: "admin", label: "Admin", help: "Everything a supervisor can do, plus appointing admins" },
];

export default function PeoplePage() {
  const [people, setPeople] = useState<Person[]>([]);
  const [role, setRole] = useState("member");
  const [me, setMe] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // #21: accounts waiting to be let onto the desk, and the system check.
  const [pending, setPending] = useState<{ id: string; name: string; email: string; created_at: string | null }[]>([]);
  const [health, setHealth] = useState<{ ok: boolean; checks: { name: string; ok: boolean; detail: string }[] } | null>(null);
  const [showHealth, setShowHealth] = useState(false);

  const isSuper = ["admin", "supervisor"].includes(role);
  const noPrivilegedYet = !people.some((p) => ["admin", "supervisor"].includes(p.role || "member"));
  const canEditRoles = isSuper || noPrivilegedYet;

  const load = async () => {
    try {
      const m = await fetch("/api/team/members", { cache: "no-store" });
      if (!m.ok) throw new Error("Could not load people");
      const md = await m.json();
      setPeople(md.members || []);
      setPending(md.pending || []);
      setRole(md.myRole || "member");
      setMe(md.me || null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const changeRole = async (person: Person, newRole: string) => {
    try {
      await sendJSON("/api/team/members", "PUT", { user_id: person.id, role: newRole });
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const letIn = async (id: string, newRole: string) => {
    try {
      await sendJSON("/api/team/members", "POST", { user_id: id, role: newRole });
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const runHealth = async () => {
    setShowHealth(true);
    setHealth(null);
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "System check failed");
      setHealth(d);
    } catch (e: any) {
      setError(e.message);
      setShowHealth(false);
    }
  };

  if (loading) return <p className="text-slate-400 p-6">Loading people...</p>;

  const card = "bg-slate-800 border border-slate-700 rounded p-4 mb-6";
  const inputCls = "px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm";

  return (
    <div className="max-w-4xl mx-auto p-3 sm:p-6">
      <h1 className="text-2xl sm:text-3xl font-bold mb-2">People &amp; permissions</h1>
      <p className="text-sm text-slate-400 mb-6">
        Your role: <span className="text-slate-200">{DESK_ROLES.find((r) => r.value === role)?.label ?? role}</span>
      </p>

      {error && (
        <div className="bg-red-950 border border-red-800 text-red-300 px-4 py-3 rounded mb-4 text-sm flex justify-between">
          <span>{error}</span>
          <button onClick={() => setError("")}>dismiss</button>
        </div>
      )}

      {isSuper && pending.length > 0 && (
        <>
          <h2 className="text-lg font-semibold mb-2">Waiting for access ({pending.length})</h2>
          <div className={`${card} border-amber-700`}>
            <p className="text-xs text-slate-400 mb-3">These people signed up but aren&apos;t on the desk yet, so they can&apos;t see anything. Let in the ones you know.</p>
            <div className="space-y-2">
              {pending.map((p) => (
                <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 bg-slate-900 rounded px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm truncate">{p.name}</p>
                    <p className="text-xs text-slate-500 truncate">{p.email}{p.created_at ? ` · signed up ${new Date(p.created_at).toLocaleDateString()}` : ""}</p>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => letIn(p.id, "member")} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-xs">Add as member</button>
                    <button onClick={() => letIn(p.id, "manager")} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs">Add as manager</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Roles */}
      <h2 className="text-lg font-semibold mb-2">People &amp; roles</h2>
      <div className={card}>
        <ul className="text-xs text-slate-400 mb-3 space-y-0.5">
          {DESK_ROLES.map((r) => <li key={r.value}><span className="text-slate-300">{r.label}</span> - {r.help}</li>)}
        </ul>
        {noPrivilegedYet && (
          <p className="text-xs text-amber-400 mb-3">Nobody is a supervisor yet. Make someone a supervisor to lock role changes down.</p>
        )}
        <div className="space-y-2">
          {people.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 bg-slate-900 rounded px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm truncate">{p.name}{p.id === me && " (you)"}</p>
                <p className="text-xs text-slate-500 truncate">{p.email}</p>
              </div>
              {canEditRoles ? (
                <select value={p.role || "member"} onChange={(e) => changeRole(p, e.target.value)} className={`${inputCls} text-xs py-1`} aria-label={`Role for ${p.name}`}>
                  {DESK_ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              ) : (
                <span className="text-xs text-slate-400">{DESK_ROLES.find((r) => r.value === (p.role || "member"))?.label}</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {isSuper && (
        <>
          <h2 className="text-lg font-semibold mb-2">System check</h2>
          <div className={card}>
            <div className="flex flex-wrap justify-between items-center gap-2">
              <p className="text-xs text-slate-400">Checks the database update is in place, email is set up and the reminder scheduler is running.</p>
              <button onClick={runHealth} className="px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm">Run check</button>
            </div>
            {showHealth && !health && <p className="text-sm text-slate-400 mt-3">Checking...</p>}
            {health && (
              <ul className="mt-3 space-y-1 text-sm">
                {health.checks.map((c) => (
                  <li key={c.name} className="flex gap-2">
                    <span className={c.ok ? "text-green-400" : "text-amber-400"}>{c.ok ? "✓" : "!"}</span>
                    <span className="text-slate-200">{c.name}</span>
                    <span className="text-slate-500 text-xs self-center break-all">{c.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
