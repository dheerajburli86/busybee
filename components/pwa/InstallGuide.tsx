"use client";

// Step-by-step: put BusyBee on a phone, tablet or computer as an app, then
// turn its notifications on. Picks the right steps for the device it's
// opened on; the tabs switch to another device's steps.

import Link from "next/link";
import { useEffect, useState } from "react";
import { Share, PlusSquare, MoreHorizontal, MoreVertical, Bell, Copy } from "lucide-react";
import { installOffer, iosVersion, isIpad, isStandalone, platform, promptInstall } from "@/lib/pushClient";

type Tab = "ios" | "android" | "desktop";

const PROD_HOST = "busybee-xi.vercel.app";

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3 items-start bg-slate-900 border border-slate-700 rounded-xl p-4">
      <span className="shrink-0 w-8 h-8 rounded-full bg-amber-400 text-slate-950 font-bold flex items-center justify-center">{n}</span>
      <div className="text-[15px] leading-relaxed text-slate-200 pt-0.5">{children}</div>
    </li>
  );
}

const Key = ({ children }: { children: React.ReactNode }) => (
  <span className="inline-flex items-center gap-1 px-2 py-0.5 mx-0.5 rounded-md bg-slate-700 text-white text-sm font-medium align-middle whitespace-nowrap">
    {children}
  </span>
);

export function InstallGuide() {
  const [tab, setTab] = useState<Tab | null>(null);
  const [offer, setOffer] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notSafari, setNotSafari] = useState(false);
  const [webview, setWebview] = useState(false);
  const [oldIos, setOldIos] = useState(false);
  const [ipad, setIpad] = useState(false);
  const [host, setHost] = useState("");
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    // Opened from the Home Screen icon (if the phone started the app here
    // rather than at its start page): go straight to the tasks.
    if (isStandalone()) {
      window.location.replace("/dashboard");
      return;
    }
    const p = platform();
    const ua = navigator.userAgent || "";
    setTab(p);
    setIpad(isIpad());
    setOffer(!!installOffer());
    setHost(window.location.host);
    setOrigin(window.location.origin);
    setOldIos(p === "ios" && (iosVersion() || 99) < 16.4);
    setNotSafari(p === "ios" && (/CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|FBAN|FBAV|Instagram|WhatsApp|Line\//i.test(ua) || !/Safari\//.test(ua)));
    setWebview(p === "android" && (/; wv\)/.test(ua) || /FBAN|FBAV|Instagram|WhatsApp|Line\//i.test(ua)));
    const yes = () => setOffer(!!installOffer());
    const done = () => {
      setOffer(false);
      setInstalled(true);
    };
    window.addEventListener("bb-installable", yes);
    window.addEventListener("bb-installed", done);
    return () => {
      window.removeEventListener("bb-installable", yes);
      window.removeEventListener("bb-installed", done);
    };
  }, []);

  const link = `${origin || `https://${PROD_HOST}`}/install`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      /* clipboard blocked: the link is on screen */
    }
  };
  const install = async () => {
    if (await promptInstall()) setInstalled(true);
    setOffer(!!installOffer());
  };

  const tabBtn = (t: Tab, label: string) => (
    <button
      key={t}
      onClick={() => setTab(t)}
      aria-pressed={tab === t}
      className={`flex-1 px-3 py-2.5 rounded-lg text-sm font-semibold ${tab === t ? "bg-amber-400 text-slate-950" : "text-slate-300 hover:bg-slate-800"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="min-h-screen bg-slate-950 safe-top">
      <div className="max-w-xl mx-auto px-4 py-8 safe-bottom">
        <div className="flex items-center gap-4 mb-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icons/icon-192.png" alt="" width={64} height={64} className="rounded-2xl shadow-lg" />
          <div>
            <h1 className="text-2xl font-bold text-white">Get the BusyBee app</h1>
            <p className="text-slate-400 text-sm">On your phone, tablet or computer. No app store, nothing to pay - about a minute.</p>
          </div>
        </div>

        {installed && (
          <div className="bg-green-950 border border-green-800 rounded-xl p-5 mb-6">
            <p className="text-green-200 font-semibold">Installed. Open BusyBee from your home screen and sign in.</p>
            <p className="text-green-100/80 text-sm mt-2">When it offers pop-up notifications, tap Turn on, then Allow.</p>
          </div>
        )}

        <div className="flex gap-1 p-1 bg-slate-900 border border-slate-700 rounded-xl mb-5" role="group" aria-label="Your device">
          {tabBtn("ios", "iPhone / iPad")}
          {tabBtn("android", "Android")}
          {tabBtn("desktop", "Computer")}
        </div>

        {tab === "ios" && (
          <>
            {oldIos && (
              <p className="bg-amber-950 border border-amber-800 text-amber-200 rounded-xl p-4 mb-4 text-sm">
                Pop-up notifications need iOS 16.4 or newer. Update first: Settings → General → Software Update.
              </p>
            )}
            {notSafari && (
              <div className="bg-sky-950 border border-sky-800 text-sky-100 rounded-xl p-4 mb-4 text-sm">
                <p className="font-semibold mb-1">First, open this page in Safari.</p>
                <p className="mb-3">Copy the link, open Safari, paste it in the address bar, then follow the steps below.</p>
                <button onClick={copy} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-sky-600 text-white font-semibold">
                  <Copy size={16} aria-hidden="true" /> {copied ? "Copied" : "Copy link"}
                </button>
              </div>
            )}
            <ol className="space-y-3">
              <Step n={1}>
                In Safari, tap the <b>Share</b> button{" "}
                <Key>
                  <Share size={16} aria-hidden="true" />
                </Key>{" "}
                {ipad ? "at the top right" : "at the bottom of the screen"}. On newer {ipad ? "iPads" : "iPhones"} it&apos;s inside the{" "}
                <Key>
                  <MoreHorizontal size={16} aria-hidden="true" />
                </Key>{" "}
                button.
              </Step>
              <Step n={2}>
                Scroll down and tap{" "}
                <Key>
                  <PlusSquare size={16} aria-hidden="true" /> Add to Home Screen
                </Key>
                . (If you don&apos;t see it, tap <b>More</b> or <b>Edit Actions</b> at the bottom of the list.)
              </Step>
              <Step n={3}>
                If you see <b>Open as Web App</b>, leave it on. Tap <Key>Add</Key> at the top right.
              </Step>
              <Step n={4}>
                Open <b>BusyBee</b> from your Home Screen (the bee icon) and sign in.
              </Step>
              <Step n={5}>
                Tap{" "}
                <Key>
                  <Bell size={16} aria-hidden="true" /> Turn on
                </Key>{" "}
                in the bar at the top, then <b>Allow</b>. Done - tasks, deadlines and messages now pop up on your {ipad ? "iPad" : "iPhone"}.
              </Step>
            </ol>
            <p className="text-xs text-slate-500 mt-4">Pop-up notifications on iPhone and iPad need iOS 16.4 or newer and work in the app from the Home Screen.</p>
          </>
        )}

        {tab === "android" && (
          <>
            {webview && (
              <div className="bg-sky-950 border border-sky-800 text-sky-100 rounded-xl p-4 mb-4 text-sm">
                <p className="font-semibold mb-1">First, open this page in Chrome.</p>
                <p>
                  Tap{" "}
                  <Key>
                    <MoreVertical size={16} aria-hidden="true" />
                  </Key>{" "}
                  at the top right and choose <b>Open in Chrome</b> (or copy the link into Chrome).
                </p>
              </div>
            )}
            {offer && (
              <button
                onClick={install}
                className="w-full mb-4 px-5 py-4 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 text-lg font-bold shadow-lg"
              >
                Install BusyBee
              </button>
            )}
            <ol className="space-y-3">
              {offer ? (
                <Step n={1}>
                  Tap <b>Install BusyBee</b> above, then <Key>Install</Key>.
                </Step>
              ) : (
                <Step n={1}>
                  In Chrome, tap{" "}
                  <Key>
                    <MoreVertical size={16} aria-hidden="true" />
                  </Key>{" "}
                  at the top right, then <Key>Install app</Key> (or <Key>Add to Home screen</Key> → <Key>Install</Key>). Samsung Internet:{" "}
                  <Key>☰</Key> → <b>Add page to</b> → <b>Home screen</b>.
                </Step>
              )}
              <Step n={2}>Open <b>BusyBee</b> from your home screen or app drawer and sign in.</Step>
              <Step n={3}>
                Tap{" "}
                <Key>
                  <Bell size={16} aria-hidden="true" /> Turn on
                </Key>{" "}
                in the bar at the top, then <b>Allow</b>. Done - tasks, deadlines and messages now pop up on your phone.
              </Step>
            </ol>
          </>
        )}

        {tab === "desktop" && (
          <>
            <div className="bg-slate-900 border border-slate-700 rounded-xl p-5 mb-4 flex flex-col sm:flex-row gap-5 items-center">
              {host === PROD_HOST && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src="/install-qr.svg" alt="QR code for this page" width={152} height={152} className="rounded-lg bg-white p-1 shrink-0" />
              )}
              <div className="text-sm text-slate-300">
                <p className="text-white font-semibold text-base mb-1">On your phone</p>
                <p>
                  {host === PROD_HOST ? "Point your phone's camera at the code, or open " : "Open "}
                  <span className="text-amber-300 break-all">{link}</span> on your phone and follow the steps there.
                </p>
                <button onClick={copy} className="mt-3 inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white font-semibold">
                  <Copy size={16} aria-hidden="true" /> {copied ? "Copied" : "Copy link"}
                </button>
              </div>
            </div>
            <p className="text-white font-semibold mb-2">On this computer</p>
            {offer && (
              <button onClick={install} className="w-full mb-3 px-5 py-3 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold">
                Install BusyBee on this computer
              </button>
            )}
            <ol className="space-y-3">
              <Step n={1}>
                <b>Chrome or Edge:</b> click the install icon at the right end of the address bar, or the menu{" "}
                <Key>
                  <MoreVertical size={16} aria-hidden="true" />
                </Key>{" "}
                → <b>Install BusyBee</b> (Edge: <b>Apps → Install this site as an app</b>). <b>Safari on a Mac:</b> File →{" "}
                <b>Add to Dock</b>.
              </Step>
              <Step n={2}>
                In BusyBee, open <b>Settings</b> and tap <b>Turn on</b> under Pop-up notifications.
              </Step>
            </ol>
          </>
        )}

        <div className="mt-8 text-center">
          <Link href="/dashboard" className="text-sm text-slate-400 hover:text-white underline">
            Or keep using BusyBee in the browser
          </Link>
        </div>
      </div>
    </div>
  );
}
