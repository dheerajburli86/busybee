"use client";

// Connect this person's Telegram so alerts reach their phone.
//
// Telegram won't let a bot message anyone who hasn't pressed Start on it, so
// this is a one-time step per person: click Connect, press Start in Telegram,
// done. The page notices the connection by itself.

import { useCallback, useEffect, useRef, useState } from "react";
import { sendJSON } from "@/lib/api";

type Status = {
  configured: boolean;
  migrated: boolean;
  bot: string | null;
  connected: boolean;
  username: string | null;
  linked_at: string | null;
};

export function TelegramConnect({ onChange }: { onChange?: (connected: boolean) => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/telegram/link", { cache: "no-store" });
    if (!r.ok) return null;
    const d: Status = await r.json();
    setStatus(d);
    return d;
  }, []);

  useEffect(() => {
    load();
    return () => {
      if (poll.current) clearInterval(poll.current);
    };
  }, [load]);

  useEffect(() => {
    if (status) onChange?.(status.connected);
  }, [status, onChange]);

  const stopPolling = () => {
    if (poll.current) clearInterval(poll.current);
    poll.current = null;
    setWaiting(false);
  };

  const connect = async () => {
    setError("");
    setNote("");
    setBusy("connect");
    // Open the tab straight away (inside the click) so pop-up blockers allow it.
    const tab = window.open("about:blank", "_blank");
    try {
      const { url } = await sendJSON("/api/telegram/link", "POST", {});
      if (tab) tab.location.href = url;
      else window.location.href = url;
      setWaiting(true);
      const started = Date.now();
      if (poll.current) clearInterval(poll.current);
      poll.current = setInterval(async () => {
        const d = await load();
        if (d?.connected) {
          stopPolling();
          setNote("Connected. A confirmation is waiting in Telegram.");
        } else if (Date.now() - started > 5 * 60 * 1000) {
          stopPolling();
          setNote("Didn't see a Start press yet. If you pressed it, refresh this page; otherwise click Connect again.");
        }
      }, 3000);
    } catch (e: any) {
      tab?.close();
      setError(e.message);
    } finally {
      setBusy("");
    }
  };

  const test = async () => {
    setError("");
    setNote("");
    setBusy("test");
    try {
      await sendJSON("/api/telegram/test", "POST", {});
      setNote("Test sent - check Telegram.");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };

  const disconnect = async () => {
    if (!window.confirm("Stop BusyBee alerts on Telegram?")) return;
    setError("");
    setNote("");
    setBusy("disconnect");
    try {
      await sendJSON("/api/telegram/link", "DELETE", {});
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };

  if (!status) return null;

  return (
    <div className="bg-slate-800 border border-slate-700 rounded p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>
          <span className="font-semibold">Telegram</span>
          <span className="block text-xs text-slate-400 mt-0.5">
            {!status.configured
              ? "Telegram isn't switched on for BusyBee yet - ask your admin."
              : !status.migrated
              ? "Telegram is waiting on a database update - your admin needs to run the Telegram migration."
              : status.connected
              ? `Connected${status.username ? ` as @${status.username}` : ""}. Alerts arrive instantly on your phone.`
              : "Get alerts on your phone instantly. One tap to connect, free."}
          </span>
        </span>
        {status.configured && status.migrated && (
          <div className="flex flex-wrap gap-2">
            {status.connected ? (
              <>
                <button
                  onClick={test}
                  disabled={!!busy}
                  className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded text-sm"
                >
                  {busy === "test" ? "Sending..." : "Send a test"}
                </button>
                <button
                  onClick={disconnect}
                  disabled={!!busy}
                  className="px-3 py-1.5 text-slate-400 hover:text-white disabled:opacity-50 text-sm"
                >
                  Disconnect
                </button>
              </>
            ) : (
              <button
                onClick={connect}
                disabled={!!busy}
                className="px-4 py-2 bg-sky-600 hover:bg-sky-500 disabled:opacity-50 rounded text-sm font-medium"
              >
                {busy === "connect" ? "Opening..." : "Connect Telegram"}
              </button>
            )}
          </div>
        )}
      </div>
      {waiting && (
        <p className="text-xs text-sky-300 mt-3">
          Telegram opened in a new tab - press <b>Start</b> there. This page updates by itself once you do.
          {status.bot ? ` (The bot is @${status.bot}.)` : ""}
        </p>
      )}
      {note && <p className="text-xs text-green-400 mt-3">{note}</p>}
      {error && <p className="text-xs text-red-400 mt-3">{error}</p>}
    </div>
  );
}
