"use client";

// Step 2 of the assignment flow: before anything else, the assignor sees how
// many people they can hand work to and picks one or more of them.
//
// Picking several people creates one task each (see createTask on the
// dashboard). Each person then accepts their own deadline, is reviewed on
// their own work and carries their own reward or penalty - money has to
// attach to one person and one piece of work, never to a crowd.

import { useMemo, useState } from "react";
import { Search, UserPlus, X } from "lucide-react";
import { sendJSON } from "@/lib/api";
import { cached, remember } from "@/lib/apiCache";
import { Person } from "./types";

export function AssigneePicker({
  people,
  me,
  selected,
  onChange,
  disabled,
  loading,
  onPeopleChange,
  myRole,
}: {
  people: Person[];
  me: string | null;
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  /** True until the names have arrived, so an empty list doesn't read as "nobody". */
  loading?: boolean;
  /** Given: the "Add person" button shows, and a new person is passed back here. */
  onPeopleChange?: (people: Person[]) => void;
  /** The adder's desk role (only an admin can add an admin). */
  myRole?: string;
}) {
  const [q, setQ] = useState("");
  // ---- Add person -----------------------------------------------------------
  const blank = { name: "", email: "", telegram: "", role: "member" };
  const [adding, setAdding] = useState(false);
  const [np, setNp] = useState(blank);
  const [addErr, setAddErr] = useState("");
  const [addNote, setAddNote] = useState<{ text: string; link?: string | null; tg?: string | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const addPerson = async () => {
    if (saving) return;
    setAddErr("");
    setSaving(true);
    try {
      const r = await sendJSON("/api/team/add", "POST", np);
      const person = { id: r.person.id, name: r.person.name, email: r.person.email, role: r.person.role } as Person;
      const list = people.some((x) => x.id === person.id) ? people : [...people, person];
      onPeopleChange?.(list);
      const known = cached<any>("/api/team/members");
      if (known) remember("/api/team/members", { ...known, members: list });
      if (!selected.includes(person.id)) onChange([...selected, person.id]);
      setAddNote({
        text: `${person.name} added${r.emailed ? " - a welcome email with a sign-in link is on its way" : ""}.`,
        link: r.sign_in_link,
        tg: r.telegram_link,
      });
      setNp(blank);
      setAdding(false);
    } catch (e: any) {
      setAddErr(e.message || "Could not add them");
    } finally {
      setSaving(false);
    }
  };

  const sorted = useMemo(
    () =>
      people
        .slice()
        .sort((a, b) => (a.id === me ? 1 : b.id === me ? -1 : String(a.name).localeCompare(String(b.name)))),
    [people, me]
  );
  const term = q.trim().toLowerCase();
  // Names starting with what was typed come first, then any other match.
  const shown = term
    ? sorted
        .filter((p) => `${p.name} ${p.email}`.toLowerCase().includes(term))
        .sort((a, b) => Number(!String(a.name).toLowerCase().startsWith(term)) - Number(!String(b.name).toLowerCase().startsWith(term)))
    : sorted;
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name || "Someone";

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  const available = people.filter((p) => p.id !== me).length;
  const stillLoading = Boolean(loading) && people.length === 0;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-start gap-2">
        <p className="text-sm text-slate-300">
          {stillLoading ? (
            "Loading people..."
          ) : (
            <>
              <span className="font-semibold text-white">{available}</span>{" "}
              {available === 1 ? "person" : "people"} you can assign to
              {selected.length > 0 && (
                <span className="text-blue-400"> · {selected.length} selected</span>
              )}
            </>
          )}
        </p>
        <div className="flex gap-3 text-xs">
          {onPeopleChange && (
            <button
              type="button"
              onClick={() => { setAdding((a) => !a); setAddNote(null); }}
              className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 font-semibold"
              disabled={disabled}
            >
              <UserPlus size={14} aria-hidden="true" /> Add person
            </button>
          )}
          {selected.length > 0 && (
            <button type="button" onClick={() => onChange([])} className="text-slate-400 hover:text-white" disabled={disabled}>
              Clear
            </button>
          )}
        </div>
      </div>

      {adding && (
        <div className="bg-slate-900 border border-slate-600 rounded p-3 space-y-2" role="group" aria-label="Add person">
          <div className="grid gap-2 sm:grid-cols-2">
            <input value={np.name} onChange={(e) => setNp({ ...np, name: e.target.value })} placeholder="1. Name" aria-label="Name" className="px-3 py-2 bg-slate-800 border border-slate-600 rounded text-sm" />
            <input value={np.email} onChange={(e) => setNp({ ...np, email: e.target.value })} placeholder="2. Email" type="email" aria-label="Email" className="px-3 py-2 bg-slate-800 border border-slate-600 rounded text-sm" />
            <input value={np.telegram} onChange={(e) => setNp({ ...np, telegram: e.target.value })} placeholder="3. Telegram @username or id (optional)" aria-label="Telegram" className="px-3 py-2 bg-slate-800 border border-slate-600 rounded text-sm" />
            <select value={np.role} onChange={(e) => setNp({ ...np, role: e.target.value })} aria-label="Designation" className="px-3 py-2 bg-slate-800 border border-slate-600 rounded text-sm">
              <option value="member">4. Member</option>
              {myRole === "admin" && <option value="admin">4. Admin</option>}
            </select>
          </div>
          {addErr && <p className="text-sm text-red-400">{addErr}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={addPerson} disabled={saving || !np.name.trim() || !np.email.trim()} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-semibold">
              {saving ? "Adding..." : "Add"}
            </button>
            <button type="button" onClick={() => setAdding(false)} className="px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm">
              Cancel
            </button>
          </div>
        </div>
      )}
      {addNote && (
        <div className="text-sm bg-green-950 border border-green-800 text-green-200 rounded px-3 py-2 space-y-1" role="status">
          <p>{addNote.text}</p>
          {addNote.link && (
            <p>
              Send them this sign-in link:{" "}
              <button type="button" className="underline" onClick={() => navigator.clipboard?.writeText(addNote.link!)}>copy link</button>
            </p>
          )}
          {addNote.tg && (
            <p>
              Telegram alerts:{" "}
              <button type="button" className="underline" onClick={() => navigator.clipboard?.writeText(addNote.tg!)}>copy Telegram link</button>
            </p>
          )}
        </div>
      )}

      {/* Search: type part of a name or email; Enter picks the top match. */}
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" aria-hidden="true" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              // Never submits the form: picks the first match instead.
              e.preventDefault();
              if (term && shown[0]) {
                if (!selected.includes(shown[0].id)) onChange([...selected, shown[0].id]);
                setQ("");
              }
            } else if (e.key === "Escape") setQ("");
          }}
          placeholder={available > 0 ? `Search ${available} people by name or email...` : "Search people by name or email..."}
          aria-label="Search people to assign"
          enterKeyHint="done"
          autoComplete="off"
          disabled={disabled}
          className="w-full pl-9 pr-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm"
        />
      </div>

      {/* Who's picked, even when the search hides them. */}
      {selected.length > 0 && (term || people.length > 12) && (
        <div className="flex flex-wrap gap-1.5" aria-label="Picked">
          {selected.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => toggle(id)}
              disabled={disabled}
              className="inline-flex items-center gap-1 pl-2.5 pr-1.5 py-1 rounded-full text-xs bg-blue-600 border border-blue-500 text-white"
              aria-label={`Remove ${nameOf(id)}`}
            >
              {nameOf(id)}
              {id === me ? " (you)" : ""}
              <X size={12} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto" role="group" aria-label="Assignees">
        {shown.map((p) => {
          const on = selected.includes(p.id);
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => toggle(p.id)}
              disabled={disabled}
              aria-pressed={on}
              className={`px-3 py-1.5 rounded-full text-sm border disabled:opacity-50 ${
                on
                  ? "bg-blue-600 border-blue-500 text-white"
                  : "bg-slate-900 border-slate-600 text-slate-300 hover:border-slate-400"
              }`}
            >
              {on ? "✓ " : ""}
              {p.name}
              {p.id === me ? " (you)" : ""}
            </button>
          );
        })}
        {shown.length === 0 && !stillLoading && (
          <p className="text-sm text-slate-400">{term ? `Nobody matches "${q.trim()}".` : "Nobody to assign to yet."}</p>
        )}
      </div>

      {selected.length > 1 && (
        <p className="text-xs text-slate-400">
          Each of the {selected.length} people gets their own copy with everything in it - the description, every item, the
          deadline and who else is on it - and each accepts their own deadline and is reviewed on their own work.
        </p>
      )}
    </div>
  );
}
