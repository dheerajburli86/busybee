"use client";

// One slim bar under the top bar, at most one at a time, offering the next
// step that makes BusyBee work like a phone app for this person:
//   1. turn on pop-up notifications on this device
//   2. on a phone or tablet browser: install the app
//   3. no pop-ups possible: connect Telegram instead
// "Not now" hides it for a week. Never shown on the Settings page, which has
// all of these itself.

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { enablePush, installOffer, isIpad, isStandalone, platform, promptInstall, pushState } from "@/lib/pushClient";

type Kind = "push" | "install" | "telegram" | null;

const KEY = "bb-nudge-dismissed";
const WEEK = 7 * 24 * 3600 * 1000;

function dismissedRecently(): boolean {
  try {
    return Date.now() - (Number(localStorage.getItem(KEY)) || 0) < WEEK;
  } catch {
    return false;
  }
}

function thisDevice(): string {
  const p = platform();
  if (p === "desktop") return "computer";
  if (isIpad() || (p === "android" && !/Mobile/i.test(navigator.userAgent))) return "tablet";
  return "phone";
}

export function AppNudge() {
  const pathname = usePathname();
  const router = useRouter();
  const [kind, setKind] = useState<Kind>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (pathname?.startsWith("/settings")) {
      setKind(null);
      return;
    }
    if (dismissedRecently()) return;
    let live = true;
    (async () => {
      const state = await pushState().catch(() => "unsupported" as const);
      if (!live) return;
      if (state === "off") return setKind("push");
      if (!isStandalone() && platform() !== "desktop") return setKind("install");
      if (state === "on") return setKind(null);
      const d = await fetch("/api/telegram/link", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (live) setKind(d && d.configured && d.migrated && !d.connected ? "telegram" : null);
    })();
    return () => {
      live = false;
    };
  }, [pathname]);

  if (!kind || pathname?.startsWith("/settings")) return null;

  const later = () => {
    try {
      localStorage.setItem(KEY, String(Date.now()));
    } catch {
      /* fine */
    }
    setKind(null);
  };

  const turnOn = async () => {
    setBusy(true);
    setNote("");
    try {
      const s = await enablePush();
      if (s === "on") {
        setNote("Done - notifications are on. A test one is on its way.");
        fetch("/api/push/test", { method: "POST" }).catch(() => {});
        setTimeout(() => setKind(null), 4000);
      } else if (s === "blocked") {
        setNote("Notifications are blocked for BusyBee on this device. Settings shows how to allow them.");
      } else if (s === "needs-install") {
        setKind("install");
      } else {
        setNote("Nothing was turned on. Tap Turn on again and choose Allow.");
      }
    } catch (e: any) {
      setNote(e?.message || "Couldn't turn notifications on.");
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    if (installOffer()) {
      const ok = await promptInstall();
      if (ok) {
        setNote("Installed - open BusyBee from your home screen.");
        setTimeout(() => setKind(null), 4000);
        return;
      }
    }
    router.push("/install");
  };

  const bar = "border-b px-3 sm:px-6 py-2 text-sm flex flex-wrap items-center justify-start gap-2";
  const button = "px-3 py-1.5 rounded text-white text-xs font-semibold disabled:opacity-60";

  if (kind === "push") {
    return (
      <div className={`bg-amber-950 border-amber-800 ${bar}`} role="region" aria-label="Turn on notifications">
        <span className="text-amber-100">
          {note || `🔔 Get a pop-up on this ${thisDevice()} the moment you're given a task or a deadline is near.`}
        </span>
        <span className="flex gap-3 items-center">
          <button onClick={turnOn} disabled={busy} className={`${button} bg-amber-600 hover:bg-amber-500`}>
            {busy ? "Turning on..." : "Turn on"}
          </button>
          <button onClick={later} className="text-amber-300 hover:text-white text-xs">
            Not now
          </button>
        </span>
      </div>
    );
  }

  if (kind === "install") {
    const p = platform();
    const what = p === "ios" ? (isIpad() ? "iPad" : "iPhone") : thisDevice();
    return (
      <div className={`bg-sky-950 border-sky-800 ${bar}`} role="region" aria-label="Install the app">
        <span className="text-sky-100">{note || `📱 Put BusyBee on your ${what} as an app - it opens in one tap and pops up your alerts.`}</span>
        <span className="flex gap-3 items-center">
          <button onClick={install} className={`${button} bg-sky-600 hover:bg-sky-500`}>
            Install
          </button>
          <button onClick={later} className="text-sky-300 hover:text-white text-xs">
            Not now
          </button>
        </span>
      </div>
    );
  }

  return (
    <div className={`bg-sky-950 border-sky-800 ${bar}`} role="region" aria-label="Connect Telegram">
      <span className="text-sky-100">Get your BusyBee alerts on your phone, instantly - connect Telegram (free, one tap).</span>
      <span className="flex gap-3 items-center">
        <Link href="/settings" className={`${button} bg-sky-600 hover:bg-sky-500`}>
          Connect
        </Link>
        <button onClick={later} className="text-sky-300 hover:text-white text-xs">
          Later
        </button>
      </span>
    </div>
  );
}
