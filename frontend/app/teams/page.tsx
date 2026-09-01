"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Department = { id: string; name: string; description: string | null };
type Team = {
  id: string;
  name: string;
  description: string | null;
  department_id: string | null;
  manager_id: string | null;
};
type TeamMember = { id: string; team_id: string; user_id: string; role: string };
type Member = { id: string; name: string; email: string };

export default function TeamsPage() {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [people, setPeople] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [newDept, setNewDept] = useState("");
  const [newTeam, setNewTeam] = useState("");
  const [newTeamDept, setNewTeamDept] = useState("");
  const router = useRouter();

  const load = async () => {
    try {
      const [t, m] = await Promise.all([fetch("/api/teams"), fetch("/api/team/members")]);
      if (!t.ok) throw new Error("Could not load teams");
      const data = await t.json();
      setDepartments(data.departments || []);
      setTeams(data.teams || []);
      setTeamMembers(data.teamMembers || []);
      if (m.ok) setPeople((await m.json()).members || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const post = async (payload: any, onDone: (body: any) => void) => {
    try {
      const res = await fetch("/api/teams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Request failed");
      onDone(body);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const remove = async (kind: string, id: string) => {
    try {
      await fetch("/api/teams", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, id }),
      });
      if (kind === "department") setDepartments((p) => p.filter((d) => d.id !== id));
      else if (kind === "member") setTeamMembers((p) => p.filter((m) => m.id !== id));
      else setTeams((p) => p.filter((t) => t.id !== id));
    } catch {
      setError("Could not delete");
    }
  };

  const nameFor = (id: string) => {
    const p = people.find((x) => x.id === id);
    return p?.name || p?.email || "Unknown";
  };

  if (loading) return <p className="text-slate-400 p-6">Loading structure...</p>;

  return (
    <div className="p-6 bg-slate-950 min-h-screen">
      <div className="max-w-4xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-3xl font-bold">Teams &amp; Departments</h1>
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

        <h2 className="text-lg font-semibold mb-3">Departments</h2>
        <div className="bg-slate-800 border border-slate-700 rounded p-4 mb-4 flex gap-2">
          <input
            value={newDept}
            onChange={(e) => setNewDept(e.target.value)}
            placeholder="New department..."
            className="flex-1 px-3 py-2 bg-slate-900 border border-slate-600 rounded placeholder-slate-500"
          />
          <button
            onClick={() => {
              if (!newDept.trim()) return;
              post({ kind: "department", name: newDept.trim() }, (b) => {
                setDepartments((p) => [...p, b]);
                setNewDept("");
              });
            }}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm"
          >
            Add
          </button>
        </div>

        {departments.length > 0 && (
          <div className="space-y-2 mb-8">
            {departments.map((d) => (
              <div
                key={d.id}
                className="bg-slate-800 border border-slate-700 rounded p-3 flex justify-between items-center"
              >
                <span className="text-slate-200">🏢 {d.name}</span>
                <button
                  onClick={() => remove("department", d.id)}
                  className="text-slate-500 hover:text-red-400 text-xs"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <h2 className="text-lg font-semibold mb-3">Teams</h2>
        <div className="bg-slate-800 border border-slate-700 rounded p-4 mb-4">
          <div className="flex flex-wrap gap-2">
            <input
              value={newTeam}
              onChange={(e) => setNewTeam(e.target.value)}
              placeholder="New team..."
              className="flex-1 min-w-48 px-3 py-2 bg-slate-900 border border-slate-600 rounded placeholder-slate-500"
            />
            <select
              value={newTeamDept}
              onChange={(e) => setNewTeamDept(e.target.value)}
              className="px-3 py-2 bg-slate-900 border border-slate-600 rounded"
            >
              <option value="">No department</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <button
              onClick={() => {
                if (!newTeam.trim()) return;
                post(
                  { kind: "team", name: newTeam.trim(), department_id: newTeamDept || null },
                  (b) => {
                    setTeams((p) => [...p, b]);
                    setNewTeam("");
                    setNewTeamDept("");
                  }
                );
              }}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm"
            >
              Add
            </button>
          </div>
        </div>

        {teams.length === 0 ? (
          <p className="text-slate-400">No teams yet.</p>
        ) : (
          <div className="space-y-4">
            {teams.map((t) => {
              const members = teamMembers.filter((m) => m.team_id === t.id);
              const dept = departments.find((d) => d.id === t.department_id);
              return (
                <div key={t.id} className="bg-slate-800 border border-slate-700 rounded p-4">
                  <div className="flex justify-between items-start mb-3">
                    <div>
                      <h3 className="font-semibold text-slate-200">👥 {t.name}</h3>
                      {dept && <p className="text-xs text-slate-500">in {dept.name}</p>}
                    </div>
                    <button
                      onClick={() => remove("team", t.id)}
                      className="text-slate-500 hover:text-red-400 text-xs"
                    >
                      ✕
                    </button>
                  </div>

                  {members.length > 0 && (
                    <div className="space-y-1 mb-3">
                      {members.map((m) => (
                        <div
                          key={m.id}
                          className="bg-slate-700 px-3 py-1.5 rounded text-sm flex justify-between items-center"
                        >
                          <span className="text-slate-300">
                            {nameFor(m.user_id)}
                            {m.role !== "member" && (
                              <span className="text-xs text-blue-400 ml-2">{m.role}</span>
                            )}
                          </span>
                          <button
                            onClick={() => remove("member", m.id)}
                            className="text-slate-500 hover:text-red-400 text-xs"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* SOW #28: name a person in charge of the team */}
                  <select
                    value=""
                    onChange={(e) => {
                      if (!e.target.value) return;
                      const [userId, role] = e.target.value.split("|");
                      post({ kind: "member", team_id: t.id, user_id: userId, role }, (b) =>
                        setTeamMembers((p) => [...p, b])
                      );
                    }}
                    className="px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm w-full"
                  >
                    <option value="">+ Add someone to this team...</option>
                    {people
                      .filter((p) => !members.some((m) => m.user_id === p.id))
                      .map((p) => (
                        <optgroup key={p.id} label={p.name || p.email}>
                          <option value={`${p.id}|member`}>
                            {p.name || p.email} as member
                          </option>
                          <option value={`${p.id}|supervisor`}>
                            {p.name || p.email} as supervisor
                          </option>
                        </optgroup>
                      ))}
                  </select>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
