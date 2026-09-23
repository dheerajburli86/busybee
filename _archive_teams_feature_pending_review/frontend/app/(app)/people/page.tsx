"use client";

// Checklist #21: desk roles and who is allowed onto the desk. Controls only
// appear for people allowed to use them; the server enforces the same rules.

import { useEffect, useState } from "react";
import { sendJSON } from "@/lib/api";
import { Department, Team } from "@/components/tasks/types";

type Person = { id: string; name: string; email: string; role?: string; department_id?: string | null };

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
  // SOW #41: the org structure people sit in - departments, standing teams,
  // and ad-hoc groups put together for one assignment.
  const [departments, setDepartments] = useState<Department[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  // False once we know the database hasn't had the teams migration run, so
  // the whole area can step aside quietly instead of showing errors.
  const [orgReady, setOrgReady] = useState(true);

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
    await loadOrg();
  };

  /**
   * Departments and teams (#41). These tables came later than the rest of the
   * app, so on a database without the migration both requests fail - that is
   * a "not set up yet", not an error worth shouting about.
   */
  const loadOrg = async () => {
    try {
      const [d, t] = await Promise.all([
        fetch("/api/departments", { cache: "no-store" }),
        fetch("/api/teams", { cache: "no-store" }),
      ]);
      if (!d.ok || !t.ok) {
        setOrgReady(false);
        return;
      }
      setDepartments((await d.json()).departments || []);
      setTeams((await t.json()).teams || []);
      setOrgReady(true);
    } catch {
      setOrgReady(false);
    }
  };

  const org = async (path: string, method: "POST" | "PUT" | "PATCH" | "DELETE", body: any) => {
    try {
      await sendJSON(path, method, body);
      await loadOrg();
      return true;
    } catch (e: any) {
      setError(e.message);
      return false;
    }
  };

  const setPersonDepartment = async (person: Person, departmentId: string) => {
    // Show the change straight away; `load()` below confirms it from the
    // server, which returns department_id with each person.
    setPeople((prev) => prev.map((p) => (p.id === person.id ? { ...p, department_id: departmentId || null } : p)));
    if (await org("/api/departments", "PUT", { user_id: person.id, department_id: departmentId || null })) {
      await load();
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
              <div className="flex flex-wrap items-center gap-2">
                {/* #41: which department this person sits in. */}
                {orgReady && departments.length > 0 && (
                  isSuper ? (
                    <select
                      value={p.department_id || ""}
                      onChange={(e) => setPersonDepartment(p, e.target.value)}
                      className={`${inputCls} text-xs py-1`}
                      aria-label={`Department for ${p.name}`}
                    >
                      <option value="">No department</option>
                      {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  ) : p.department_id ? (
                    <span className="text-xs text-slate-400">{departments.find((d) => d.id === p.department_id)?.name}</span>
                  ) : null
                )}
                {canEditRoles ? (
                  <select value={p.role || "member"} onChange={(e) => changeRole(p, e.target.value)} className={`${inputCls} text-xs py-1`} aria-label={`Role for ${p.name}`}>
                    {DESK_ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                  </select>
                ) : (
                  <span className="text-xs text-slate-400">{DESK_ROLES.find((r) => r.value === (p.role || "member"))?.label}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* #41: departments, teams and ad-hoc groups. */}
      {!orgReady ? (
        <p className="text-xs text-slate-500 mb-6">Departments and teams need the latest database update.</p>
      ) : (
        <>
          {isSuper && (
            <>
              <h2 className="text-lg font-semibold mb-2">Departments</h2>
              <div className={card}>
                <p className="text-xs text-slate-400 mb-3">
                  The parts of the organisation people belong to. Teams sit inside a department.
                </p>
                <DepartmentList
                  departments={departments}
                  onRename={(id, name) => org("/api/departments", "PUT", { id, name })}
                  onDelete={(id) => org("/api/departments", "DELETE", { id })}
                  onAdd={(name) => org("/api/departments", "POST", { name })}
                  inputCls={inputCls}
                />
              </div>
            </>
          )}

          <h2 className="text-lg font-semibold mb-2">Teams &amp; groups</h2>
          <div className={card}>
            <p className="text-xs text-slate-400 mb-3">
              A <span className="text-slate-300">team</span> is a standing team people belong to. A{" "}
              <span className="text-slate-300">group</span> is an ad-hoc set of people put together for one
              piece of work. A task can be given to either, and everyone in it sees it and is told when it changes.
            </p>
            <TeamList
              teams={teams}
              departments={departments}
              people={people}
              isSuper={isSuper}
              inputCls={inputCls}
              onSave={(body) => org("/api/teams", body.id ? "PUT" : "POST", body)}
              onDelete={(id) => org("/api/teams", "DELETE", { id })}
            />
          </div>
        </>
      )}

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

/** #41: rename, remove and add the departments on this desk. */
function DepartmentList({
  departments,
  onRename,
  onDelete,
  onAdd,
  inputCls,
}: {
  departments: Department[];
  onRename: (id: string, name: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onAdd: (name: string) => Promise<boolean>;
  inputCls: string;
}) {
  const [adding, setAdding] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  const add = async () => {
    const name = adding.trim();
    if (!name) return;
    if (await onAdd(name)) setAdding("");
  };

  const rename = async () => {
    if (!editing || !editing.name.trim()) return;
    if (await onRename(editing.id, editing.name.trim())) setEditing(null);
  };

  return (
    <>
      <div className="space-y-2 mb-3">
        {departments.length === 0 && <p className="text-sm text-slate-500">No departments yet.</p>}
        {departments.map((d) => (
          <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 bg-slate-900 rounded px-3 py-2">
            {editing?.id === d.id ? (
              <div className="flex flex-wrap gap-2 flex-1">
                <input
                  value={editing.name}
                  onChange={(e) => setEditing({ id: d.id, name: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && rename()}
                  className={`${inputCls} text-xs py-1 flex-1 min-w-32`}
                  aria-label="Department name"
                  autoFocus
                />
                <button onClick={rename} className="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-xs">Save</button>
                <button onClick={() => setEditing(null)} className="px-2 py-1 text-slate-400 hover:text-white text-xs">Cancel</button>
              </div>
            ) : (
              <>
                <div className="min-w-0">
                  <p className="text-sm truncate">{d.name}</p>
                  <p className="text-xs text-slate-500">
                    {d.member_count || 0} {d.member_count === 1 ? "person" : "people"} · {d.team_count || 0}{" "}
                    {d.team_count === 1 ? "team" : "teams"}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setEditing({ id: d.id, name: d.name })} className="px-2 py-1 text-slate-400 hover:text-white text-xs">Rename</button>
                  <button
                    onClick={() => {
                      if (confirm(`Remove the department "${d.name}"? Its people and teams stay, they just stop belonging to a department.`)) onDelete(d.id);
                    }}
                    className="px-2 py-1 text-slate-500 hover:text-red-400 text-xs"
                  >
                    Remove
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <input
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="New department name..."
          className={`${inputCls} flex-1 min-w-40`}
        />
        <button onClick={add} disabled={!adding.trim()} className="px-3 py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded text-sm">
          Add department
        </button>
      </div>
    </>
  );
}

/** #41: the teams and ad-hoc groups on this desk, and who is in them. */
function TeamList({
  teams,
  departments,
  people,
  isSuper,
  inputCls,
  onSave,
  onDelete,
}: {
  teams: Team[];
  departments: Department[];
  people: Person[];
  isSuper: boolean;
  inputCls: string;
  onSave: (body: any) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
}) {
  const blank = { id: "", name: "", kind: "team", department_id: "", manager_id: "", member_ids: [] as string[] };
  const [draft, setDraft] = useState<typeof blank | null>(null);

  const open = (t?: Team) =>
    setDraft(
      t
        ? {
            id: t.id,
            name: t.name,
            kind: t.kind || "team",
            department_id: t.department_id || "",
            manager_id: t.manager_id || "",
            member_ids: (t.members || []).map((m) => m.id),
          }
        : { ...blank }
    );

  const toggle = (id: string) =>
    setDraft((d) =>
      !d ? d : { ...d, member_ids: d.member_ids.includes(id) ? d.member_ids.filter((x) => x !== id) : [...d.member_ids, id] }
    );

  const save = async () => {
    if (!draft || !draft.name.trim()) return;
    const body: any = {
      name: draft.name.trim(),
      kind: draft.kind,
      department_id: draft.department_id || null,
      manager_id: draft.manager_id || null,
      member_ids: draft.member_ids,
    };
    if (draft.id) body.id = draft.id;
    if (await onSave(body)) setDraft(null);
  };

  return (
    <>
      <div className="space-y-2 mb-3">
        {teams.length === 0 && <p className="text-sm text-slate-500">No teams or groups yet.</p>}
        {teams.map((t) => (
          <div key={t.id} className="bg-slate-900 rounded px-3 py-2">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm truncate">
                  {t.name}
                  <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded ${t.kind === "group" ? "bg-violet-900 text-violet-300" : "bg-slate-700 text-slate-300"}`}>
                    {t.kind === "group" ? "Group" : "Team"}
                  </span>
                </p>
                <p className="text-xs text-slate-500">
                  {t.department_name || "No department"}
                  {t.manager_name ? ` · led by ${t.manager_name}` : ""}
                  {` · ${(t.members || []).length} ${(t.members || []).length === 1 ? "person" : "people"}`}
                </p>
              </div>
              {(t.can_manage || isSuper) && (
                <div className="flex gap-2">
                  <button onClick={() => open(t)} className="px-2 py-1 text-slate-400 hover:text-white text-xs">Edit</button>
                  {isSuper && (
                    <button
                      onClick={() => {
                        if (confirm(`Remove "${t.name}"? The people in it stay on the desk.`)) onDelete(t.id);
                      }}
                      className="px-2 py-1 text-slate-500 hover:text-red-400 text-xs"
                    >
                      Remove
                    </button>
                  )}
                </div>
              )}
            </div>
            {(t.members || []).length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {(t.members || []).map((m) => (
                  <span key={m.id} className="text-[11px] bg-slate-800 text-slate-300 rounded px-2 py-0.5">{m.name}</span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {isSuper && !draft && (
        <button onClick={() => open()} className="px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm">
          New team or group
        </button>
      )}

      {draft && (
        <div className="bg-slate-900 border border-slate-700 rounded p-3 space-y-3">
          <div className="flex flex-wrap gap-2">
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="Name..."
              className={`${inputCls} flex-1 min-w-40`}
              aria-label="Team name"
              autoFocus
            />
            <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })} className={inputCls} aria-label="Kind">
              <option value="team">Team</option>
              <option value="group">Group</option>
            </select>
          </div>
          <div className="flex flex-wrap gap-2">
            <select
              value={draft.department_id}
              onChange={(e) => setDraft({ ...draft, department_id: e.target.value })}
              className={`${inputCls} flex-1 min-w-36`}
              aria-label="Department"
            >
              <option value="">No department</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <select
              value={draft.manager_id}
              onChange={(e) => setDraft({ ...draft, manager_id: e.target.value })}
              className={`${inputCls} flex-1 min-w-36`}
              aria-label="Person in charge"
            >
              <option value="">No person in charge</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <p className="text-xs text-slate-400 mb-2">Who is in it ({draft.member_ids.length} selected)</p>
            <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto">
              {people.map((p) => (
                <label key={p.id} className="flex items-center gap-1.5 text-xs bg-slate-800 rounded px-2 py-1 cursor-pointer">
                  <input type="checkbox" checked={draft.member_ids.includes(p.id)} onChange={() => toggle(p.id)} />
                  <span className="truncate max-w-32">{p.name}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={save} disabled={!draft.name.trim()} className="px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm">
              {draft.id ? "Save changes" : "Create"}
            </button>
            <button onClick={() => setDraft(null)} className="px-3 py-2 text-slate-400 hover:text-white text-sm">Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}
