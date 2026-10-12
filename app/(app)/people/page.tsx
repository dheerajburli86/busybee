"use client";

// Checklist #21: desk roles and who is allowed onto the desk. Controls only
// appear for people allowed to use them; the server enforces the same rules.
//
// Everyone's box is coloured by the live performance heatmap (lib/heatmap.ts):
// how their work stands against how far along it should be by now. Tapping a
// box opens that person's open and finished tasks (?person=<id>).

import { useEffect, useState } from "react";
import { cached, load as loadApi, useBeforePaint, useRefresh } from "@/lib/apiCache";
import { sendJSON } from "@/lib/api";
import { SIMPLE } from "@/lib/simple";
import { HeatLegend, HowItWorks, PersonTasks, PersonTile } from "@/components/people/Heat";
import { useHeatmap } from "@/components/people/useHeatmap";

type Person = { id: string; name: string; email: string; role?: string; telegram?: boolean; oversees?: boolean };

const DESK_ROLES = [
  { value: "member", label: "Member", help: "Works on what they're given; can't move deadlines" },
  { value: "manager", label: "Manager", help: "Runs the projects they're made manager of" },
  { value: "supervisor", label: "Supervisor (Project Manager)", help: "Manages every project and task" },
  { value: "admin", label: "Admin", help: "Everything a supervisor can do, plus appointing admins" },
];

// Simple mode offers three roles; anyone already a Manager keeps that role.
const ROLE_CHOICES = SIMPLE ? DESK_ROLES.filter((r) => r.value !== "manager") : DESK_ROLES;

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

  // Whose tasks are open (?person=<id>); the back button closes it.
  const [personId, setPersonId] = useState<string | null>(null);
  useEffect(() => {
    const read = () => setPersonId(new URLSearchParams(window.location.search).get("person"));
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  const openPerson = (id: string | null) => {
    const url = id ? `?person=${encodeURIComponent(id)}` : window.location.pathname;
    window.history.pushState({}, "", url);
    setPersonId(id);
    window.scrollTo(0, 0);
  };

  const heat = useHeatmap(people.map((p) => p.id));

  const isSuper = ["admin", "supervisor"].includes(role);
  const noPrivilegedYet = !people.some((p) => ["admin", "supervisor"].includes(p.role || "member"));
  const canEditRoles = isSuper || noPrivilegedYet;

  const show = (md: any) => {
    setPeople(md.members || []);
    setPending(md.pending || []);
    setRole(md.myRole || "member");
    setMe(md.me || null);
  };
  const load = async () => {
    try {
      // full=1: this is the one page that shows who is waiting for access and
      // who has their phone connected.
      show(await loadApi<any>("/api/team/members?full=1"));
    } catch (e: any) {
      setError(e.message || "Could not load people");
    } finally {
      setLoading(false);
    }
  };
  useRefresh(load);

  useBeforePaint(() => {
    const known = cached<any>("/api/team/members?full=1");
    if (known) {
      show(known);
      setLoading(false);
    }
    load();
  }, []);

  // "Gets every update": told about everything on every task (the boss).
  const toggleOversees = async (person: Person) => {
    const next = !person.oversees;
    setPeople((ps) => ps.map((x) => (x.id === person.id ? { ...x, oversees: next } : x)));
    try {
      const r = await fetch("/api/team/members", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: person.id, oversees: next }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || "Could not change that");
    } catch (e: any) {
      setPeople((ps) => ps.map((x) => (x.id === person.id ? { ...x, oversees: !next } : x)));
      alert(e.message);
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

  const [botNote, setBotNote] = useState("");
  const reconnectBot = async () => {
    setBotNote("Reconnecting...");
    try {
      const r = await sendJSON("/api/telegram/setup", "POST", {});
      setBotNote(`Telegram bot connected to ${r.url}`);
    } catch (e: any) {
      setBotNote(e.message);
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

  const opened = personId ? people.find((p) => p.id === personId) : null;
  if (opened) {
    return (
      <PersonTasks
        name={opened.name}
        me={opened.id === me}
        heat={heat.people.get(opened.id)}
        now={heat.now}
        scope={heat.scope}
        onBack={() => (window.history.length > 1 ? window.history.back() : openPerson(null))}
      />
    );
  }

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

      {/* People, coloured by the live heatmap, with their roles */}
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
        <h2 className="text-lg font-semibold">People &amp; how their work is going</h2>
        <p className="text-xs text-slate-400">
          {heat.error ? <span className="text-red-400">{heat.error}</span> : heat.loadedAt ? "Live - colours update every minute" : "Loading the heatmap..."}
        </p>
      </div>
      <div className="mb-3">
        <HeatLegend />
      </div>
      <p className="text-xs text-slate-400 mb-3">
        Colour = work done compared with the work expected by now, given each deadline. Tap a name to see their open and finished tasks.
        {heat.scope === "visible" && " Worked out from the tasks you can see."}
      </p>
      <div className="grid gap-3 sm:grid-cols-2 mb-4">
        {people.map((p) => (
          <PersonTile
            key={p.id}
            name={p.name}
            me={p.id === me}
            head={!!p.oversees}
            heat={heat.people.get(p.id)}
            now={heat.now}
            ready={heat.ready}
            onOpen={() => openPerson(p.id)}
          >
            <p className="text-xs text-slate-400 min-w-0 truncate">
              {p.email}
              {p.telegram !== undefined && (
                <span className={p.telegram ? "text-sky-400" : "text-slate-500"}>
                  {" · "}
                  {p.telegram ? "Telegram connected" : "no Telegram yet"}
                </span>
              )}
            </p>
            <div className="flex items-center gap-2 ml-auto">
              {isSuper && (
                <button
                  onClick={() => toggleOversees(p)}
                  className={`text-xs px-2 py-1 rounded border ${p.oversees ? "border-amber-600 text-amber-200" : "border-slate-600 text-slate-400 hover:text-white"}`}
                  title="Gets an email about everything that happens on every task, plus the team summary"
                >
                  {p.oversees ? "✓ Every update" : "Every update"}
                </button>
              )}
              {canEditRoles ? (
                <select value={p.role || "member"} onChange={(e) => changeRole(p, e.target.value)} className={`${inputCls} text-xs py-1`} aria-label={`Role for ${p.name}`}>
                  {(p.role === "manager" ? DESK_ROLES : ROLE_CHOICES).map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              ) : (
                <span className="text-xs text-slate-400">{DESK_ROLES.find((r) => r.value === (p.role || "member"))?.label}</span>
              )}
            </div>
          </PersonTile>
        ))}
      </div>
      <div className="mb-6">
        <HowItWorks />
      </div>

      {/* What the roles mean */}
      <div className={card}>
        <h2 className="text-sm font-semibold mb-2">Roles</h2>
        <ul className="text-xs text-slate-400 space-y-0.5">
          {ROLE_CHOICES.map((r) => <li key={r.value}><span className="text-slate-300">{r.label}</span> - {r.help}</li>)}
        </ul>
        {noPrivilegedYet && (
          <p className="text-xs text-amber-400 mt-3">Nobody is a supervisor yet. Make someone a supervisor to lock role changes down.</p>
        )}
      </div>

      {isSuper && (
        <>
          <h2 className="text-lg font-semibold mb-2">System check</h2>
          <div className={card}>
            <div className="flex flex-wrap justify-between items-center gap-2">
              <p className="text-xs text-slate-400">Checks the database update is in place, email and Telegram are set up and the reminder scheduler is running.</p>
              <div className="flex gap-2">
                <button onClick={reconnectBot} className="px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm" title="Re-register the Telegram webhook (after changing the bot token or site address)">
                  Reconnect Telegram bot
                </button>
                <button onClick={runHealth} className="px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm">Run check</button>
              </div>
            </div>
            {botNote && <p className="text-xs text-slate-400 mt-2 break-all">{botNote}</p>}
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
