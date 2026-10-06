"use client";

// Checklist #27: chat rooms (organisation, project, private and custom),
// room creation and management, message search, and who's online.
// New messages arrive live through Supabase Realtime, with polling as a
// fallback if the live connection isn't available.

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase";
import { sendJSON } from "@/lib/api";
import { PeoplePicker } from "@/components/tasks/TaskDetail";

type Room = {
  id: string;
  name: string;
  kind: "org" | "project" | "private" | "custom";
  created_by: string | null;
  members: string[];
  last_message_at: string | null;
};
type Message = { id: string; content: string; author_id: string; author_name?: string; room_id: string; room_name?: string; created_at: string };
type Member = { id: string; name: string; email: string };

const KIND_LABEL: Record<string, string> = {
  org: "Organisation",
  project: "Projects",
  private: "Private",
  custom: "Custom rooms",
};

export default function ChatPage() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [presence, setPresence] = useState<Record<string, { online: boolean; last_seen_at: string }>>({});
  const [me, setMe] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Message[] | null>(null);
  const [creating, setCreating] = useState<{ kind: "private" | "custom"; name: string; people: string[] } | null>(null);
  const [showRooms, setShowRooms] = useState(true);
  const [lastSeen, setLastSeen] = useState<Record<string, string>>({});
  const bottomRef = useRef<HTMLDivElement>(null);

  const room = rooms.find((r) => r.id === roomId) || null;
  // The room on screen right now, for answers that arrive after a switch.
  const roomRef = useRef<string | null>(null);
  roomRef.current = roomId;

  const loadRooms = useCallback(async () => {
    const r = await fetch("/api/chat/rooms", { cache: "no-store" });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Could not load chat rooms");
    setRooms(d.rooms || []);
    setMe(d.me);
    setRoomId((cur) => cur || d.rooms?.find((x: Room) => x.kind === "org")?.id || d.rooms?.[0]?.id || null);
  }, []);

  useEffect(() => {
    try {
      setLastSeen(JSON.parse(localStorage.getItem("bb-chat-seen") || "{}"));
    } catch {
      /* private mode */
    }
    loadRooms().catch((e) => setError(e.message));
    fetch("/api/team/members").then((r) => (r.ok ? r.json() : null)).then((d) => d && setMembers(d.members || []));
    const loadPresence = () =>
      fetch("/api/presence", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((d) => d && setPresence(d.presence || {}));
    loadPresence();
    const t = setInterval(() => {
      loadPresence();
      loadRooms().catch(() => {});
    }, 30000);
    return () => clearInterval(t);
  }, [loadRooms]);

  const markSeen = useCallback((id: string) => {
    setLastSeen((prev) => {
      const next = { ...prev, [id]: new Date().toISOString() };
      try {
        localStorage.setItem("bb-chat-seen", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  // Messages for the open room: initial load, live updates, and a slow poll.
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    // Don't show the previous room's messages under this room's name.
    setMessages([]);
    const load = async () => {
      try {
        const r = await fetch(`/api/chat?room_id=${roomId}`, { cache: "no-store" });
        const d = await r.json();
        if (!cancelled && r.ok) setMessages(d.messages || []);
      } catch {
        /* try again on the next update or poll */
      }
    };
    load();
    markSeen(roomId);

    const supabase = createClient();
    const channel = supabase
      .channel(`room-${roomId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages", filter: `room_id=eq.${roomId}` }, () => {
        load();
        markSeen(roomId);
      })
      .subscribe();
    const poll = setInterval(load, 15000);

    return () => {
      cancelled = true;
      clearInterval(poll);
      supabase.removeChannel(channel);
    };
  }, [roomId, markSeen]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  // Search across every room you can see.
  useEffect(() => {
    if (search.trim().length < 2) return setResults(null);
    let current = true;
    const t = setTimeout(() => {
      fetch(`/api/chat?q=${encodeURIComponent(search.trim())}`)
        .then(async (r) => {
          const d = await r.json().catch(() => ({}));
          if (!current) return;
          if (!r.ok) {
            setError(d?.error || "Message search failed");
            setResults([]);
            return;
          }
          setResults(d.messages || []);
        })
        .catch(() => current && setError("Message search failed - check your connection"));
    }, 250);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [search]);

  const nameFor = (id: string) => {
    const m = members.find((x) => x.id === id);
    return m?.name || m?.email || "Someone";
  };

  // A private chat is named after the OTHER people in it, so each person sees
  // who they're talking to (its stored name is the creator's view).
  const roomLabel = (r: Room) => {
    if (r.kind !== "private" || !me) return r.name;
    const others = Array.from(new Set([r.created_by, ...r.members].filter((x): x is string => !!x && x !== me)));
    return others.length ? others.map(nameFor).join(", ") : r.name;
  };
  const online = (id: string) => presence[id]?.online;

  const send = async () => {
    if (!draft.trim() || !roomId) return;
    setSending(true);
    try {
      const sentTo = roomId;
      const msg = await sendJSON("/api/chat", "POST", { content: draft.trim(), room_id: sentTo });
      // Only add it here if that room is still the one on screen.
      if (roomRef.current === sentTo) {
        setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      }
      setDraft("");
      markSeen(roomId);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  };

  const creatingRoom = useRef(false);
  const createRoom = async () => {
    if (!creating || creatingRoom.current) return;
    creatingRoom.current = true;
    try {
      const r = await sendJSON("/api/chat/rooms", "POST", { kind: creating.kind, name: creating.name, user_ids: creating.people });
      setCreating(null);
      await loadRooms();
      setRoomId(r.id);
    } catch (e: any) {
      setError(e.message);
    } finally {
      creatingRoom.current = false;
    }
  };

  const deleteRoom = async (r: Room) => {
    if (!confirm(`Delete "${roomLabel(r)}" and all its messages?`)) return;
    try {
      await sendJSON("/api/chat/rooms", "DELETE", { room_id: r.id });
      setRoomId(null);
      await loadRooms();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const addPeople = async (r: Room, ids: string[]) => {
    try {
      await sendJSON("/api/chat/rooms", "PUT", { room_id: r.id, add_user_ids: ids });
      await loadRooms();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const unread = (r: Room) => r.last_message_at && r.id !== roomId && (!lastSeen[r.id] || r.last_message_at > lastSeen[r.id]);
  const roomSections = (["org", "project", "private", "custom"] as const)
    .map((k) => ({ kind: k, list: rooms.filter((r) => r.kind === k) }))
    .filter((g) => g.list.length);

  const inputCls = "px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm";
  const onlineCount = members.filter((m) => online(m.id)).length;

  return (
    <div className="max-w-6xl mx-auto p-3 sm:p-6">
      <div className="flex flex-wrap justify-between items-center gap-2 mb-4">
        <h1 className="text-2xl sm:text-3xl font-bold">Chat</h1>
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search all messages..." className={`${inputCls} w-full sm:w-64`} />
      </div>
      {error && (
        <div className="bg-red-950 border border-red-800 text-red-300 px-4 py-3 rounded mb-4 text-sm flex justify-between">
          <span>{error}</span>
          <button onClick={() => setError("")}>dismiss</button>
        </div>
      )}

      {results ? (
        <div className="bg-slate-800 border border-slate-700 rounded p-4">
          <div className="flex justify-between mb-3">
            <p className="text-sm text-slate-400">{results.length} message{results.length === 1 ? "" : "s"} found</p>
            <button onClick={() => setSearch("")} className="text-sm text-blue-400">Close search</button>
          </div>
          <div className="space-y-2">
            {results.map((m) => (
              <button key={m.id} onClick={() => { setRoomId(m.room_id); setSearch(""); }} className="block w-full text-left bg-slate-900 rounded p-3 hover:bg-slate-700">
                <p className="text-xs text-slate-400">#{m.room_name} · {m.author_name} · {new Date(m.created_at).toLocaleString()}</p>
                <p className="text-sm text-slate-200 mt-1 whitespace-pre-wrap">{m.content}</p>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="grid md:grid-cols-[240px_1fr] gap-4">
          {/* Rooms */}
          <aside className="bg-slate-800 border border-slate-700 rounded p-3 md:h-[70vh] md:overflow-y-auto">
            <button onClick={() => setShowRooms(!showRooms)} className="md:hidden w-full text-left text-sm font-semibold mb-2">
              {room ? `# ${roomLabel(room)}` : "Rooms"} {showRooms ? "▲" : "▼"}
            </button>
            <div className={`${showRooms ? "" : "hidden"} md:block`}>
              <div className="flex gap-2 mb-3">
                <button onClick={() => setCreating({ kind: "private", name: "", people: [] })} className="flex-1 px-2 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-xs">+ Private chat</button>
                <button onClick={() => setCreating({ kind: "custom", name: "", people: [] })} className="flex-1 px-2 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs">+ Room</button>
              </div>
              {roomSections.map((g) => (
                <div key={g.kind} className="mb-3">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">{KIND_LABEL[g.kind]}</p>
                  {g.list.map((r) => {
                    const other = r.kind === "private" && r.members.length === 2 ? r.members.find((x) => x !== me) : null;
                    return (
                      <button key={r.id} onClick={() => { setRoomId(r.id); setShowRooms(false); }}
                        className={`w-full text-left px-2 py-1.5 rounded text-sm flex items-center gap-2 ${r.id === roomId ? "bg-blue-600 text-white" : "text-slate-300 hover:bg-slate-700"}`}>
                        {other ? (
                          <span className={`w-2 h-2 rounded-full shrink-0 ${online(other) ? "bg-green-400" : "bg-slate-600"}`} />
                        ) : (
                          <span className="text-slate-500">#</span>
                        )}
                        <span className="truncate flex-1">{roomLabel(r)}</span>
                        {unread(r) && <span className="w-2 h-2 rounded-full bg-blue-400 shrink-0" aria-label="New messages" />}
                      </button>
                    );
                  })}
                </div>
              ))}
              <div className="mt-4 pt-3 border-t border-slate-700">
                <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">People · {onlineCount} online</p>
                {members
                  .slice()
                  .sort((a, b) => Number(!!online(b.id)) - Number(!!online(a.id)))
                  .map((m) => (
                    <div key={m.id} className="flex items-center gap-2 text-sm py-1 text-slate-300">
                      <span className={`w-2 h-2 rounded-full ${online(m.id) ? "bg-green-400" : "bg-slate-600"}`} />
                      <span className="truncate flex-1">{m.name}{m.id === me && " (you)"}</span>
                      {m.id !== me && (
                        <button onClick={() => { setCreating({ kind: "private", name: "", people: [m.id] }); }} className="text-xs text-blue-400" aria-label={`Message ${m.name}`}>
                          msg
                        </button>
                      )}
                    </div>
                  ))}
              </div>
            </div>
          </aside>

          {/* Messages */}
          <section className="bg-slate-800 border border-slate-700 rounded flex flex-col h-[70vh]">
            <div className="px-4 py-3 border-b border-slate-700 flex flex-wrap justify-between items-center gap-2">
              <div className="min-w-0">
                <p className="font-semibold truncate"># {room?.name || "..."}</p>
                {room && ["private", "custom"].includes(room.kind) && (
                  <p className="text-xs text-slate-400 truncate">{room.members.map(nameFor).join(", ")}</p>
                )}
              </div>
              {room && ["private", "custom"].includes(room.kind) && room.created_by === me && (
                <div className="flex gap-2 items-center">
                  <select value="" onChange={(e) => e.target.value && addPeople(room, [e.target.value])} className={`${inputCls} text-xs py-1`} aria-label="Add person">
                    <option value="">Add person...</option>
                    {members.filter((m) => !room.members.includes(m.id)).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                  <button onClick={() => deleteRoom(room)} className="text-xs text-red-400">Delete</button>
                </div>
              )}
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.length === 0 ? (
                <p className="text-slate-500 text-sm">Nothing here yet. Start the conversation.</p>
              ) : (
                messages.map((m) => {
                  const mine = m.author_id === me;
                  return (
                    <div key={m.id} className={mine ? "text-right" : ""}>
                      <div className={`inline-block max-w-[85%] sm:max-w-md px-3 py-2 rounded text-sm text-left ${mine ? "bg-blue-600 text-white" : "bg-slate-700 text-slate-200"}`}>
                        {!mine && (
                          <p className="text-xs text-slate-300 mb-1 flex items-center gap-1">
                            <span className={`w-1.5 h-1.5 rounded-full ${online(m.author_id) ? "bg-green-400" : "bg-slate-500"}`} />
                            {m.author_name || nameFor(m.author_id)}
                          </p>
                        )}
                        <p className="whitespace-pre-wrap break-words">{m.content}</p>
                      </div>
                      <p className="text-[11px] text-slate-500 mt-1">
                        {new Date(m.created_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
                      </p>
                    </div>
                  );
                })
              )}
              <div ref={bottomRef} />
            </div>
            <div className="p-3 border-t border-slate-700 flex gap-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                rows={1}
                placeholder={room ? `Message #${roomLabel(room)}...` : "Pick a room"}
                disabled={sending || !room}
                className={`${inputCls} flex-1 resize-none`}
              />
              <button onClick={send} disabled={sending || !draft.trim() || !room} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 rounded text-sm">
                Send
              </button>
            </div>
          </section>
        </div>
      )}

      {creating && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setCreating(null)}>
          <div className="bg-slate-800 border border-slate-700 rounded p-4 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-semibold mb-3">{creating.kind === "private" ? "New private chat" : "New room"}</h2>
            {creating.kind === "custom" && (
              <input value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} placeholder="Room name" className={`${inputCls} w-full mb-3`} />
            )}
            <p className="text-xs text-slate-400 mb-2">Who's in it?</p>
            <PeoplePicker people={members.filter((m) => m.id !== me)} value={creating.people} onChange={(people) => setCreating({ ...creating, people })} />
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setCreating(null)} className="px-3 py-2 bg-slate-700 rounded text-sm">Cancel</button>
              <button onClick={createRoom} disabled={creating.people.length === 0 || (creating.kind === "custom" && !creating.name.trim())}
                className="px-3 py-2 bg-blue-600 disabled:opacity-50 rounded text-sm">Create</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
