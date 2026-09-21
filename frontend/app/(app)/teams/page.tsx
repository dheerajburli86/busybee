"use client";

// Checklist #21 / #23 / #25 / #26: roles, departments, teams with managers,
// and custom groups. Controls only appear for people allowed to use them;
// the server enforces the same rules.

import { useEffect, useState } from "react";
import { sendJSON } from "@/lib/api";
import { PeoplePicker } from "@/components/tasks/TaskDetail";

type Department = { id: string; name: string };
type Team = { id: string; name: string; department_id: string | null; manager_id: string | null };
type TeamMember = { id: string; team_id: string; user_id: string; role: string };
type Group = { id: string; name: string; created_by: string | null };
type GroupMember = { id: string; group_id: string; user_id: string };
type Person = { id: string; name: string; email: string; role?: string };

const DESK_ROLES = [
  { value: "member", label: "Team member", help: "Works on what they're given; can't move deadlines" },
  { value: "manager", label: "Team manager", help: "Runs the teams they manage and those teams' projects" },
  { value: "supervisor", label: "Supervisor (Project Manager)", help: "Manages every project, team and task" },
  { value: "admin", label: "Admin", help: "Everything a supervisor can do, plus appointing admins" },
];

export default function TeamsPage() {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupMembers, setGroupMembers] = useState<GroupMember[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [role, setRole] = useState("member");
  const [managed, setManaged] = useState<string[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [newDept, setNewDept] = useState("");
  const [newTeam, setNewTeam] = useState({ name: "", department: "", manager: "" });
  const [newGroup, setNewGroup] = useState({ name: "", people: [] as string[] });
  // #21: accounts waiting to be let onto the desk, and the system check.
  const [pending, setPending] = useState<{ id: string; name: string; email: string; created_at: string | null }[]>([]);
  const [health, setHealth] = useState<{ ok: boolean; checks: { name: string; ok: boolean; detail: string }[] } | null>(null);
  const [showHealth, setShowHealth] = useState(false);

  const isSuper = ["admin", "supervisor"].includes(role);
  const noPrivilegedYet = !people.some((p) => ["admin", "supervisor"].includes(p.role || "member"));
  const canEditRoles = isSuper || noPrivilegedYet;

  const load = async () => {
    try {
      const [t, m] = await Promise.all([fetch("/api/teams", { cache: "no-store" }), fetch("/api/team/members", { cache: "no-store" })]);
      if (!t.ok) throw new Error("Could not load teams");
      const d = await t.json();
      setDepartments(d.departments || []);
      setTeams(d.teams || []);
      setTeamMembers(d.teamMembers || []);
      setGroups(d.groups || []);
      setGroupMembers(d.groupMembers || []);
      setRole(d.role || "member");
      setManaged(d.managedTeams || []);
      setMe(d.me || null);
      if (m.ok) {
        const md = await m.json();
        setPeople(md.members || []);
        setPending(md.pending || []);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const call = async (method: "POST" | "PUT" | "DELETE", body: any) => {
    try {
      const r = await sendJSON("/api/teams", method, body);
      await load();
      return r;
    } catch (e: any) {
      setError(e.message);
      return null;
    }
  };

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

  const nameFor = (id: string | null) => {
    if (!id) return "nobody";
    const p = people.find((x) => x.id === id);
    return p?.name || p?.email || "Unknown";
  };

  if (loading) return <p className="text-slate-400 p-6">Loading structure...</p>;

  const card = "bg-slate-800 border border-slate-700 rounded p-4 mb-6";
  const inputCls = "px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm";

  return (
    <div className="max-w-4xl mx-auto p-3 sm:p-6">
      <h1 className="text-2xl sm:text-3xl font-bold mb-2">Teams &amp; permissions</h1>
      <p className="text-sm text-slate-400 mb-6">
        Your role: <span className="text-slate-200">{DESK_ROLES.find((r) => r.value === role)?.label}</span>
        {managed.length > 0 && ` · you manage ${managed.length} team${managed.length > 1 ? "s" : ""}`}
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

      {/* Departments */}
      <h2 className="text-lg font-semibold mb-2">Departments</h2>
      <div className={card}>
        {isSuper && (
          <div className="flex gap-2 mb-3">
            <input value={newDept} onChange={(e) => setNewDept(e.target.value)} placeholder="New department..." className={`${inputCls} flex-1`} />
            <button
              onClick={async () => {
                if (!newDept.trim()) return;
                if (await call("POST", { kind: "department", name: newDept.trim() })) setNewDept("");
              }}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm"
            >Add</button>
          </div>
        )}
        {departments.length === 0 ? (
          <p className="text-sm text-slate-500">No departments yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {departments.map((d) => (
              <span key={d.id} className="px-3 py-1.5 bg-slate-900 rounded text-sm flex items-center gap-2">
                {d.name}
                <span className="text-xs text-slate-500">{teams.filter((t) => t.department_id === d.id).length} teams</span>
                {isSuper && (
                  <button onClick={() => confirm(`Delete ${d.name}?`) && call("DELETE", { kind: "department", id: d.id })} className="text-slate-500 hover:text-red-400" aria-label="Delete department">✕</button>
                )}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Teams */}
      <h2 className="text-lg font-semibold mb-2">Teams</h2>
      <div className={card}>
        {isSuper && (
          <div className="flex flex-wrap gap-2 mb-4">
            <input value={newTeam.name} onChange={(e) => setNewTeam({ ...newTeam, name: e.target.value })} placeholder="New team..." className={`${inputCls} flex-1 min-w-40`} />
            <select value={newTeam.department} onChange={(e) => setNewTeam({ ...newTeam, department: e.target.value })} className={inputCls} aria-label="Department">
              <option value="">No department</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <select value={newTeam.manager} onChange={(e) => setNewTeam({ ...newTeam, manager: e.target.value })} className={inputCls} aria-label="Manager">
              <option value="">No manager</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button
              onClick={async () => {
                if (!newTeam.name.trim()) return;
                const ok = await call("POST", { kind: "team", name: newTeam.name.trim(), department_id: newTeam.department || null, manager_id: newTeam.manager || null });
                if (ok) setNewTeam({ name: "", department: "", manager: "" });
              }}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm"
            >Add team</button>
          </div>
        )}
        {teams.length === 0 ? (
          <p className="text-sm text-slate-500">No teams yet.</p>
        ) : (
          <div className="space-y-3">
            {teams.map((t) => {
              const members = teamMembers.filter((m) => m.team_id === t.id);
              const canRun = isSuper || managed.includes(t.id);
              return (
                <div key={t.id} className="bg-slate-900 rounded p-3">
                  <div className="flex flex-wrap justify-between items-center gap-2 mb-2">
                    <p className="font-semibold">
                      {t.name}
                      {managed.includes(t.id) && <span className="ml-2 text-xs text-blue-400">you manage this</span>}
                    </p>
                    <div className="flex flex-wrap gap-2 items-center text-xs">
                      {isSuper ? (
                        <>
                          <select value={t.department_id || ""} onChange={(e) => call("PUT", { id: t.id, department_id: e.target.value || null })} className={`${inputCls} text-xs py-1`} aria-label="Department">
                            <option value="">No department</option>
                            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                          </select>
                          <select value={t.manager_id || ""} onChange={(e) => call("PUT", { id: t.id, manager_id: e.target.value || null })} className={`${inputCls} text-xs py-1`} aria-label="Manager">
                            <option value="">No manager</option>
                            {people.map((p) => <option key={p.id} value={p.id}>Manager: {p.name}</option>)}
                          </select>
                          <button onClick={() => confirm(`Delete team ${t.name}?`) && call("DELETE", { kind: "team", id: t.id })} className="text-slate-500 hover:text-red-400">Delete</button>
                        </>
                      ) : (
                        <span className="text-slate-400">
                          {departments.find((d) => d.id === t.department_id)?.name || "No department"} · manager {nameFor(t.manager_id)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {members.length === 0 && <span className="text-xs text-slate-500">No members yet.</span>}
                    {members.map((m) => (
                      <span key={m.id} className="px-2 py-1 bg-slate-800 rounded text-xs flex items-center gap-2">
                        {nameFor(m.user_id)}
                        {m.role === "manager" && <span className="text-blue-400">manager</span>}
                        {isSuper && (
                          <button onClick={() => call("PUT", { kind: "member", id: m.id, role: m.role === "manager" ? "member" : "manager" })} className="text-slate-400 hover:text-white" title="Toggle team manager">
                            {m.role === "manager" ? "↓" : "↑"}
                          </button>
                        )}
                        {canRun && (
                          <button onClick={() => call("DELETE", { kind: "member", id: m.id })} className="text-slate-500 hover:text-red-400" aria-label="Remove from team">✕</button>
                        )}
                      </span>
                    ))}
                  </div>
                  {canRun && (
                    <select value="" onChange={(e) => e.target.value && call("POST", { kind: "member", team_id: t.id, user_id: e.target.value })} className={`${inputCls} text-xs py-1 mt-2`} aria-label="Add member">
                      <option value="">Add a member...</option>
                      {people.filter((p) => !members.some((m) => m.user_id === p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  )}
                </div>
              );
            })}
          </div>
        )}
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

      {/* Custom groups */}
      <h2 className="text-lg font-semibold mb-2">Custom groups</h2>
      <div className={card}>
        <p className="text-xs text-slate-400 mb-3">A group is any set of people you want to give work to together, across teams. Anyone can make one.</p>
        <div className="space-y-2 mb-4">
          <input value={newGroup.name} onChange={(e) => setNewGroup({ ...newGroup, name: e.target.value })} placeholder="Group name..." className={`${inputCls} w-full`} />
          <PeoplePicker people={people.filter((p) => p.id !== me)} value={newGroup.people} onChange={(ids) => setNewGroup({ ...newGroup, people: ids })} />
          <button
            onClick={async () => {
              if (!newGroup.name.trim()) return;
              const ok = await call("POST", { kind: "group", name: newGroup.name.trim(), user_ids: newGroup.people });
              if (ok) setNewGroup({ name: "", people: [] });
            }}
            disabled={!newGroup.name.trim()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm"
          >Create group</button>
        </div>
        {groups.length === 0 ? (
          <p className="text-sm text-slate-500">No groups yet.</p>
        ) : (
          <div className="space-y-3">
            {groups.map((g) => {
              const members = groupMembers.filter((m) => m.group_id === g.id);
              const mine = g.created_by === me || isSuper;
              return (
                <div key={g.id} className="bg-slate-900 rounded p-3">
                  <div className="flex justify-between items-center gap-2 mb-2">
                    <p className="font-semibold">{g.name} <span className="text-xs text-slate-500 font-normal">by {nameFor(g.created_by)}</span></p>
                    {mine && <button onClick={() => confirm(`Delete group ${g.name}?`) && call("DELETE", { kind: "group", id: g.id })} className="text-xs text-slate-500 hover:text-red-400">Delete</button>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {members.map((m) => (
                      <span key={m.id} className="px-2 py-1 bg-slate-800 rounded text-xs flex items-center gap-2">
                        {nameFor(m.user_id)}
                        {(mine || m.user_id === me) && (
                          <button onClick={() => call("DELETE", { kind: "group_member", id: m.id })} className="text-slate-500 hover:text-red-400" aria-label="Remove from group">✕</button>
                        )}
                      </span>
                    ))}
                  </div>
                  {mine && (
                    <select value="" onChange={(e) => e.target.value && call("POST", { kind: "group_member", group_id: g.id, user_id: e.target.value })} className={`${inputCls} text-xs py-1 mt-2`} aria-label="Add to group">
                      <option value="">Add someone...</option>
                      {people.filter((p) => !members.some((m) => m.user_id === p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
