"use client";

// Ask BusyBee: type a question about who has what, get the answer and the
// tasks behind it. Answers only cover tasks you're allowed to see.

import { useEffect, useRef, useState } from "react";
import { SUGGESTIONS } from "@/lib/ask";
import { statusClass } from "@/lib/status";

type Hit = {
  id: string;
  title: string;
  is_list: boolean;
  status: string;
  status_label: string;
  assignee: string;
  due: string | null;
  completed: string | null;
  overdue: boolean;
};
type Answer = { question: string; answer: string; tasks: Hit[]; more: number };

export default function AskPage() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [example, setExample] = useState("Dheeraj");
  const inputRef = useRef<HTMLInputElement>(null);

  // Use a real teammate's name in the suggestions.
  useEffect(() => {
    fetch("/api/team/members", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const other = (d?.members || []).find((m: any) => m.id !== d.me && m.name);
        if (other) setExample(String(other.name).split(" ")[0]);
      })
      .catch(() => {});
    inputRef.current?.focus();
  }, []);

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/ask?q=${encodeURIComponent(text)}`, { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not answer that");
      setAnswers((prev) => [{ question: text, answer: d.answer, tasks: d.tasks || [], more: d.more || 0 }, ...prev].slice(0, 10));
      setQ("");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div className="max-w-3xl mx-auto p-3 sm:p-6">
      <h1 className="text-2xl sm:text-3xl font-bold mb-1">Ask BusyBee</h1>
      <p className="text-slate-400 text-sm mb-4">Ask about anyone&apos;s tasks in plain English.</p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(q);
        }}
        className="flex gap-2 mb-3"
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`e.g. What is ${example} left with?`}
          className="flex-1 min-w-0 px-4 py-3 bg-slate-900 border border-slate-600 rounded text-base"
          aria-label="Your question"
        />
        <button type="submit" disabled={busy || !q.trim()} className="px-5 py-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-semibold">
          {busy ? "..." : "Ask"}
        </button>
      </form>

      <div className="flex flex-wrap gap-2 mb-6">
        {SUGGESTIONS(example).map((s) => (
          <button
            key={s}
            onClick={() => ask(s)}
            disabled={busy}
            className="px-3 py-1.5 rounded-full text-sm border border-slate-600 bg-slate-900 text-slate-300 hover:border-blue-500 hover:text-white disabled:opacity-50"
          >
            {s}
          </button>
        ))}
      </div>

      {error && (
        <div className="bg-red-950 border border-red-800 text-red-300 px-4 py-3 rounded mb-4 text-sm" role="alert">
          {error}
        </div>
      )}

      <div className="space-y-5">
        {answers.map((a, i) => (
          <div key={`${a.question}-${i}`} className="space-y-2">
            <p className="text-sm text-slate-400">
              <span className="text-slate-500">You asked:</span> {a.question}
            </p>
            <div className="bg-slate-800 border border-slate-700 rounded p-4">
              <p className="text-lg font-semibold text-white mb-3">🐝 {a.answer}</p>
              {a.tasks.length > 0 && (
                <ul className="divide-y divide-slate-700">
                  {a.tasks.map((t) => (
                    <li key={t.id}>
                      <a
                        href={t.is_list ? "/lists" : `/dashboard?task=${t.id}`}
                        className="flex flex-wrap items-center justify-between gap-2 py-2 hover:bg-slate-700/40 rounded px-2 -mx-2"
                      >
                        <span className="min-w-0">
                          <span className={`font-medium ${t.overdue ? "text-red-400" : "text-slate-100"}`}>
                            {t.is_list ? "☑ " : ""}
                            {t.title}
                          </span>
                          <span className="block text-xs text-slate-400">
                            {t.assignee}
                            {t.completed ? ` · finished ${t.completed}` : t.due ? ` · due ${t.due}` : ""}
                            {t.overdue ? " · overdue" : ""}
                          </span>
                        </span>
                        <span className={`text-xs px-2 py-1 rounded shrink-0 ${statusClass(t.status)}`}>{t.status_label}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
              {a.more > 0 && <p className="text-xs text-slate-500 mt-2">…and {a.more} more.</p>}
            </div>
          </div>
        ))}
        {answers.length === 0 && (
          <p className="text-slate-500 text-sm">
            Try a suggestion above. You can name anyone on your desk, say &quot;me&quot;, and add &quot;today&quot;, &quot;this week&quot; or &quot;this month&quot;.
          </p>
        )}
      </div>
    </div>
  );
}
