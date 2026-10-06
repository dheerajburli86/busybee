"use client";

// A slim bar for anyone who hasn't connected Telegram yet, so alerts actually
// reach every assignee's phone. Hidden once connected, on the Settings page
// itself, and for a week after "Later".

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const KEY = "bb-telegram-nudge-dismissed";
const WEEK = 7 * 24 * 3600 * 1000;

export function TelegramNudge() {
  const pathname = usePathname();
  const [show, setShow] = useState(false);

  // Re-checked on every page change, so the bar disappears as soon as someone
  // connects (e.g. on Settings) rather than after a full reload.
  useEffect(() => {
    if (pathname?.startsWith("/settings")) return;
    let dismissed = 0;
    try {
      dismissed = Number(localStorage.getItem(KEY)) || 0;
    } catch {
      /* storage blocked: just show it */
    }
    if (Date.now() - dismissed < WEEK) return;
    fetch("/api/telegram/link", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setShow(!!d && d.configured && d.migrated && !d.connected))
      .catch(() => {});
  }, [pathname]);

  if (!show || pathname?.startsWith("/settings")) return null;

  const later = () => {
    try {
      localStorage.setItem(KEY, String(Date.now()));
    } catch {
      /* fine */
    }
    setShow(false);
  };

  return (
    <div className="bg-sky-950 border-b border-sky-800 px-3 sm:px-6 py-2 text-sm flex flex-wrap items-center justify-between gap-2">
      <span className="text-sky-100">Get your BusyBee alerts on your phone, instantly - connect Telegram (free, one tap).</span>
      <span className="flex gap-3 items-center">
        <Link href="/settings" className="px-3 py-1 bg-sky-600 hover:bg-sky-500 rounded text-white text-xs font-medium">
          Connect
        </Link>
        <button onClick={later} className="text-sky-300 hover:text-white text-xs">
          Later
        </button>
      </span>
    </div>
  );
}
