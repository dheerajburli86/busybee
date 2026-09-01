"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Message = {
  id: string;
  content: string;
  author_id: string;
  channel: string;
  created_at: string;
};

type Member = { id: string; name: string; email: string };

const CHANNELS = ["general", "projects", "random"];

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [channel, setChannel] = useState("general");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const load = async (ch: string) => {
    try {
      const res = await fetch(`/api/chat?channel=${encodeURIComponent(ch)}`);
      if (!res.ok) throw new Error("Could not load messages");
      const data = await res.json();
      setMessages(data.messages || []);
      setMeId(data.me ?? null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    (async () => {
      const m = await fetch("/api/team/members");
      if (m.ok) setMembers((await m.json()).members || []);
    })();
  }, []);

  useEffect(() => {
    setLoading(true);
    load(channel);
    // Poll so a second person's messages appear without a refresh.
    const t = setInterval(() => load(channel), 10000);
    return () => clearInterval(t);
  }, [channel]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const nameFor = (id: string) => {
    const m = members.find((x) => x.id === id);
    return m?.name || m?.email || "Someone";
  };

  const send = async () => {
    if (!draft.trim()) return;
    setSending(true);
    setError("");
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: draft.trim(), channel }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Could not send");
      setMessages((prev) => [...prev, body]);
      setDraft("");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="p-6 bg-slate-950 min-h-screen">
      <div className="max-w-4xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-3xl font-bold">Team Chat</h1>
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

        <div className="flex gap-2 mb-4">
          {CHANNELS.map((c) => (
            <button
              key={c}
              onClick={() => setChannel(c)}
              className={`px-4 py-2 rounded text-sm ${
                channel === c
                  ? "bg-blue-600 text-white"
                  : "bg-slate-800 text-slate-300 hover:bg-slate-700"
              }`}
            >
              #{c}
            </button>
          ))}
        </div>

        <div className="bg-slate-800 border border-slate-700 rounded p-4 h-96 overflow-y-auto mb-4">
          {loading ? (
            <p className="text-slate-400 text-sm">Loading...</p>
          ) : messages.length === 0 ? (
            <p className="text-slate-500 text-sm">
              Nothing in #{channel} yet. Start the conversation.
            </p>
          ) : (
            <div className="space-y-3">
              {messages.map((m) => {
                const mine = m.author_id === meId;
                return (
                  <div key={m.id} className={mine ? "text-right" : ""}>
                    <div
                      className={`inline-block max-w-md px-3 py-2 rounded text-sm text-left ${
                        mine ? "bg-blue-600 text-white" : "bg-slate-700 text-slate-200"
                      }`}
                    >
                      {!mine && (
                        <p className="text-xs text-slate-400 mb-1">{nameFor(m.author_id)}</p>
                      )}
                      <p className="whitespace-pre-wrap">{m.content}</p>
                    </div>
                    <p className="text-xs text-slate-500 mt-1">
                      {new Date(m.created_at).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <div className="flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={`Message #${channel}...`}
            disabled={sending}
            className="flex-1 px-3 py-2 bg-slate-900 border border-slate-600 rounded placeholder-slate-500"
          />
          <button
            onClick={send}
            disabled={sending || !draft.trim()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 rounded text-sm"
          >
            {sending ? "Sending..." : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
