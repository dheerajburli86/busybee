"use client";

// Checklist #48: notification settings. Every category defaults to
// everything on, so nobody has to visit this page for BusyBee to work the
// way it always has - it only matters once someone wants less.

import { useEffect, useState } from "react";
import { sendJSON } from "@/lib/api";
import { TelegramConnect } from "@/components/settings/TelegramConnect";

type Category = { key: string; label: string; hint: string };
type Channel = "in_app" | "email" | "telegram";
type ChannelPrefs = Record<Channel, boolean>;
const ALL_ON: ChannelPrefs = { in_app: true, email: true, telegram: true };

export default function SettingsPage() {
  const [categoriesMeta, setCategoriesMeta] = useState<Category[]>([]);
  const [emailEnabled, setEmailEnabled] = useState(true);
  const [mailConfigured, setMailConfigured] = useState(true);
  const [telegramEnabled, setTelegramEnabled] = useState(true);
  const [telegramConfigured, setTelegramConfigured] = useState(false);
  const [categories, setCategories] = useState<Record<string, ChannelPrefs>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/notification-prefs", { cache: "no-store" });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Could not load settings");
        setCategoriesMeta(d.categories_meta || []);
        setEmailEnabled(d.email_enabled !== false);
        setMailConfigured(!!d.mail_configured);
        setTelegramEnabled(d.telegram_enabled !== false);
        setTelegramConfigured(!!d.telegram_configured);
        setCategories(d.categories || {});
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const save = async (next?: {
    email_enabled?: boolean;
    telegram_enabled?: boolean;
    categories?: Record<string, ChannelPrefs>;
  }) => {
    setSaving(true);
    setSaved(false);
    try {
      const body = {
        email_enabled: next?.email_enabled ?? emailEnabled,
        telegram_enabled: next?.telegram_enabled ?? telegramEnabled,
        categories: next?.categories ?? categories,
      };
      await sendJSON("/api/notification-prefs", "PUT", body);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const toggle = (key: string, channel: Channel) => {
    const current = { ...ALL_ON, ...(categories[key] || {}) };
    const updated = { ...current, [channel]: !current[channel] };
    const next = { ...categories, [key]: updated };
    setCategories(next);
    save({ categories: next });
  };

  const toggleEmailMaster = () => {
    const next = !emailEnabled;
    setEmailEnabled(next);
    save({ email_enabled: next });
  };

  const toggleTelegramMaster = () => {
    const next = !telegramEnabled;
    setTelegramEnabled(next);
    save({ telegram_enabled: next });
  };

  // Tailwind needs both class names spelled out in full to keep them.
  const cols = telegramConfigured ? "grid-cols-[1fr_auto_auto_auto]" : "grid-cols-[1fr_auto_auto]";

  if (loading) return <p className="text-slate-400 p-6">Loading settings...</p>;

  return (
    <div className="max-w-2xl mx-auto p-3 sm:p-6">
      <h1 className="text-2xl sm:text-3xl font-bold mb-1">⚙️ Notification settings</h1>
      <p className="text-slate-400 text-sm mb-6">
        Alerts reach you in the bell, by email and on Telegram. Everything is on by default; switch off what you
        don&apos;t need. Rewards and penalties always reach you on every channel.
      </p>

      {error && (
        <div className="bg-red-950 border border-red-800 text-red-300 px-4 py-3 rounded mb-4 text-sm flex justify-between">
          <span>{error}</span>
          <button onClick={() => setError("")}>dismiss</button>
        </div>
      )}

      <div className="mb-4">
        <TelegramConnect />
      </div>

      {telegramConfigured && (
        <div className="bg-slate-800 border border-slate-700 rounded p-4 mb-4">
          <label className="flex items-center justify-between gap-3">
            <span>
              <span className="font-semibold">Telegram alerts</span>
              <span className="block text-xs text-slate-400 mt-0.5">
                Turn off to pause all Telegram alerts without disconnecting.
              </span>
            </span>
            <input
              type="checkbox"
              checked={telegramEnabled}
              onChange={toggleTelegramMaster}
              className="w-5 h-5"
              aria-label="Telegram alerts master switch"
            />
          </label>
        </div>
      )}

      <div className="bg-slate-800 border border-slate-700 rounded p-4 mb-4">
        <label className="flex items-center justify-between gap-3">
          <span>
            <span className="font-semibold">Email notifications</span>
            <span className="block text-xs text-slate-400 mt-0.5">
              {mailConfigured ? "Turn off to stop all BusyBee emails, whatever the category below." : "Email isn't set up on this deployment yet, so this only takes effect once it is."}
            </span>
          </span>
          <input type="checkbox" checked={emailEnabled} onChange={toggleEmailMaster} className="w-5 h-5" aria-label="Email notifications master switch" />
        </label>
      </div>

      <div className="bg-slate-800 border border-slate-700 rounded divide-y divide-slate-700">
        <div className={`grid ${cols} gap-2 sm:gap-3 px-4 py-2 text-xs text-slate-500 font-semibold`}>
          <span>Category</span>
          <span className="text-center w-12 sm:w-16">In-app</span>
          <span className="text-center w-12 sm:w-16">Email</span>
          {telegramConfigured && <span className="text-center w-12 sm:w-16">Telegram</span>}
        </div>
        {categoriesMeta.map((c) => {
          const p = { ...ALL_ON, ...(categories[c.key] || {}) };
          return (
            <div key={c.key} className={`grid ${cols} gap-2 sm:gap-3 px-4 py-3 items-center`}>
              <span>
                <span className="text-sm font-medium">{c.label}</span>
                <span className="block text-xs text-slate-400">{c.hint}</span>
              </span>
              <span className="w-12 sm:w-16 text-center">
                <input type="checkbox" checked={p.in_app} onChange={() => toggle(c.key, "in_app")} className="w-5 h-5" aria-label={`${c.label}: in-app`} />
              </span>
              <span className="w-12 sm:w-16 text-center">
                <input
                  type="checkbox"
                  checked={p.email}
                  disabled={!emailEnabled}
                  onChange={() => toggle(c.key, "email")}
                  className="w-5 h-5 disabled:opacity-30"
                  aria-label={`${c.label}: email`}
                />
              </span>
              {telegramConfigured && (
              <span className="w-12 sm:w-16 text-center">
                <input
                  type="checkbox"
                  checked={p.telegram}
                  disabled={!telegramEnabled}
                  onChange={() => toggle(c.key, "telegram")}
                  className="w-5 h-5 disabled:opacity-30"
                  aria-label={`${c.label}: Telegram`}
                />
              </span>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-xs text-slate-500 mt-3">
        Small routine edits (progress nudges, a deadline being accepted) skip email, so your inbox only gets what
        needs you.
      </p>
      <p className="text-xs text-slate-500 mt-2 h-4">{saving ? "Saving..." : saved ? "Saved." : ""}</p>
    </div>
  );
}
