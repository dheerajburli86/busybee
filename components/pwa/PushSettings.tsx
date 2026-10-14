"use client";

// Settings: pop-up notifications on this device (phone, tablet or computer),
// and the list of devices that have them on.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  PushState,
  currentSubscription,
  deviceLabel,
  disablePush,
  enablePush,
  iosVersion,
  isIpad,
  isStandalone,
  platform,
  pushState,
} from "@/lib/pushClient";

type Device = { id: string; device: string; created_at: string; last_ok_at: string | null; tail: string };

const day = (iso: string) => new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });

function BlockedHelp() {
  const p = platform();
  if (p === "ios")
    return (
      <>
        On your {isIpad() ? "iPad" : "iPhone"}: open the <b>Settings</b> app → <b>Notifications</b> → <b>BusyBee</b> → turn on{" "}
        <b>Allow Notifications</b>. Then come back here.
      </>
    );
  if (p === "android")
    return (
      <>
        Press and hold the BusyBee icon → <b>App info</b> → <b>Notifications</b> → turn them on. In a browser tab instead: tap the icon left
        of the address → <b>Permissions</b> → <b>Notifications</b> → <b>Allow</b>.
      </>
    );
  return (
    <>
      Click the icon to the left of the address bar → <b>Notifications</b> → <b>Allow</b>, then reload this page.
    </>
  );
}

export function PushSettings() {
  const [state, setState] = useState<PushState | "loading">("loading");
  const [devices, setDevices] = useState<Device[]>([]);
  const [mine, setMine] = useState<string | null>(null);
  const [ready, setReady] = useState(true);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [inApp, setInApp] = useState(true);

  const refresh = useCallback(async () => {
    setInApp(isStandalone());
    setState(await pushState().catch(() => "unsupported" as const));
    const sub = await currentSubscription();
    setMine(sub ? sub.endpoint.slice(-16) : null);
    try {
      const r = await fetch("/api/push/subscribe", { cache: "no-store" });
      if (r.ok) {
        const d = await r.json();
        setDevices(d.devices || []);
        setReady(d.configured !== false && d.migrated !== false);
      }
    } catch {
      /* offline: the device list stays empty */
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setNote("");
    setError("");
    try {
      await fn();
    } catch (e: any) {
      setError(e?.message || "Something went wrong");
    } finally {
      setBusy("");
      refresh();
    }
  };

  const test = () =>
    run("test", async () => {
      const r = await fetch("/api/push/test", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Couldn't send a test");
      setNote(`Sent to ${d.sent} device${d.sent === 1 ? "" : "s"}. It should pop up in a few seconds.`);
    });

  const turnOn = () =>
    run("on", async () => {
      const s = await enablePush();
      if (s === "on") {
        setNote("On. A test notification is on its way.");
        fetch("/api/push/test", { method: "POST" }).catch(() => {});
      } else if (s === "off") {
        setNote("Nothing changed - tap Turn on again and choose Allow.");
      }
    });

  const turnOff = () => run("off", () => disablePush());

  const what = deviceLabel();
  const ios = platform() === "ios";
  const oldIos = ios && (iosVersion() || 99) < 16.4;
  const btn = "px-4 py-2 rounded text-sm font-semibold disabled:opacity-60";

  return (
    <div className="bg-slate-800 border border-slate-700 rounded p-4">
      <p className="font-semibold">📱 Pop-up notifications</p>
      <p className="text-xs text-slate-400 mt-0.5 mb-3">
        A pop-up on your phone, tablet or computer the moment something needs you - even when BusyBee is closed.
      </p>

      {!ready && (
        <p className="text-xs text-amber-300 mb-3">Pop-ups aren&apos;t set up on the server yet. Ask your admin to run the latest update.</p>
      )}

      {state === "loading" && <p className="text-sm text-slate-400">Checking this device...</p>}

      {state === "needs-install" && (
        <div className="text-sm text-slate-200 space-y-2">
          <p>
            On {isIpad() ? "iPad" : "iPhone"}, pop-ups work in the BusyBee app. Add BusyBee to your Home Screen, open it from there, and
            turn them on in its Settings.
          </p>
          {oldIos && <p className="text-amber-300 text-xs">Your {isIpad() ? "iPad" : "iPhone"} needs iOS 16.4 or newer: Settings → General → Software Update.</p>}
          <Link href="/install" className={`${btn} inline-block bg-amber-600 hover:bg-amber-500 text-white`}>
            How to install (1 minute)
          </Link>
        </div>
      )}

      {state === "unsupported" && (
        <div className="text-sm text-slate-200 space-y-2">
          <p>This browser can&apos;t show pop-up notifications.</p>
          {platform() !== "desktop" && (
            <Link href="/install" className={`${btn} inline-block bg-amber-600 hover:bg-amber-500 text-white`}>
              Install the BusyBee app
            </Link>
          )}
        </div>
      )}

      {state === "off" && (
        <div className="flex flex-wrap items-center justify-start gap-3">
          <p className="text-sm text-slate-300">Off on this {what === "This device" ? "device" : what}.</p>
          <button onClick={turnOn} disabled={!!busy || !ready} className={`${btn} bg-amber-600 hover:bg-amber-500 text-white`}>
            {busy === "on" ? "Turning on..." : "Turn on"}
          </button>
        </div>
      )}

      {state === "blocked" && (
        <div className="text-sm text-slate-200 space-y-2">
          <p className="text-amber-300 font-medium">Blocked on this device.</p>
          <p className="text-slate-300">
            <BlockedHelp />
          </p>
        </div>
      )}

      {state === "on" && (
        <div className="flex flex-wrap items-center justify-start gap-3">
          <p className="text-sm text-green-300 font-medium">✓ On for this {what === "This device" ? "device" : what}</p>
          <span className="flex gap-2">
            <button onClick={test} disabled={!!busy} className={`${btn} bg-slate-700 hover:bg-slate-600 text-white`}>
              {busy === "test" ? "Sending..." : "Send a test"}
            </button>
            <button onClick={turnOff} disabled={!!busy} className={`${btn} bg-slate-900 border border-slate-600 text-slate-300`}>
              Turn off
            </button>
          </span>
        </div>
      )}

      {note && <p className="text-xs text-green-300 mt-3">{note}</p>}
      {error && <p className="text-xs text-red-300 mt-3">{error}</p>}

      {devices.length > 0 && (
        <div className="mt-4 pt-3 border-t border-slate-700">
          <p className="text-xs text-slate-500 mb-1">Pop-ups are on for:</p>
          <ul className="text-sm text-slate-300 space-y-0.5">
            {devices.map((d) => (
              <li key={d.id}>
                {d.device}
                {mine && d.tail === mine ? " (this one)" : ""} <span className="text-xs text-slate-500">· since {day(d.created_at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!inApp && platform() !== "desktop" && state !== "needs-install" && state !== "unsupported" && (
        <p className="text-xs text-slate-400 mt-3">
          Tip:{" "}
          <Link href="/install" className="text-amber-300 underline">
            put BusyBee on your home screen
          </Link>{" "}
          so it opens like an app.
        </p>
      )}
      <p className="text-xs text-slate-500 mt-3">Which alerts pop up follows the App column below.</p>
    </div>
  );
}
