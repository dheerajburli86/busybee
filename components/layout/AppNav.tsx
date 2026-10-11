"use client";

// One navigation bar for every signed-in page. On wider screens it's a single
// row of links. On phones and tablets it works like an app: the top bar keeps
// search and the bell, and a tab bar at the bottom has the main pages plus
// "More" for the rest.

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ClipboardList, ListChecks, Menu, MessageCircle, Sparkles, FolderKanban, X } from "lucide-react";
import { createClient } from "@/lib/supabase";
import { NotificationBell } from "@/components/NotificationBell";
import { SIMPLE } from "@/lib/simple";
import { clearSnapshots } from "@/lib/snapshot";
import { isStandalone } from "@/lib/pushClient";

// Simple mode: just the pages the core flow uses.
const SIMPLE_LINKS = [
  { href: "/dashboard", label: "Tasks" },
  { href: "/lists", label: "To-Do" },
  { href: "/chat", label: "Chat" },
  { href: "/ask", label: "Ask" },
  { href: "/projects", label: "Projects" },
  { href: "/reports", label: "Reports" },
  { href: "/payroll", label: "Payroll" },
  { href: "/people", label: "People" },
  { href: "/settings", label: "Settings" },
];

const ALL_LINKS = [
  { href: "/dashboard", label: "Tasks" },
  { href: "/todo", label: "My To-Do" },
  { href: "/projects", label: "Projects" },
  { href: "/reports", label: "Reports" },
  { href: "/activity", label: "History" },
  { href: "/chat", label: "Chat" },
  { href: "/okr", label: "OKR" },
  { href: "/documents", label: "Documents" },
  { href: "/people", label: "People" },
  { href: "/timesheet", label: "Timesheet" },
  { href: "/payroll", label: "Payroll" },
  { href: "/settings", label: "Settings" },
];

const LINKS = SIMPLE ? SIMPLE_LINKS : ALL_LINKS;

// The phone tab bar: four main pages, then "More".
const TABS = SIMPLE
  ? [
      { href: "/dashboard", label: "Tasks", Icon: ClipboardList },
      { href: "/lists", label: "To-Do", Icon: ListChecks },
      { href: "/chat", label: "Chat", Icon: MessageCircle },
      { href: "/ask", label: "Ask", Icon: Sparkles },
    ]
  : [
      { href: "/dashboard", label: "Tasks", Icon: ClipboardList },
      { href: "/todo", label: "To-Do", Icon: ListChecks },
      { href: "/projects", label: "Projects", Icon: FolderKanban },
      { href: "/chat", label: "Chat", Icon: MessageCircle },
    ];
const MORE = LINKS.filter((l) => !TABS.some((t) => t.href === l.href));

export function AppNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [app, setApp] = useState(true);

  // Close the "More" sheet whenever the page changes.
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => setApp(isStandalone()), []);

  // Presence heartbeat (checklist #27): "online" means seen in the last 2 min.
  useEffect(() => {
    const ping = () => fetch("/api/presence", { method: "POST" }).catch(() => {});
    ping();
    const t = setInterval(ping, 60000);
    return () => clearInterval(t);
  }, []);

  // Escape closes the sheet.
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [open]);

  const logout = async () => {
    // Sign out this browser only (the default signs out every device), then
    // load the login page fresh so no signed-in screen lingers.
    clearSnapshots();
    try {
      await createClient().auth.signOut({ scope: "local" });
    } catch {
      /* the cookie is cleared locally either way */
    }
    window.location.href = "/login";
  };

  const search = (e: React.FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    if (term.length < 2) return;
    if (pathname === "/search") {
      // Already on the search page, which doesn't reload for a new query
      // string: hand it the new words directly.
      window.dispatchEvent(new CustomEvent("bb-search", { detail: term }));
    } else {
      router.push(`/search?q=${encodeURIComponent(term)}`);
    }
  };

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");
  const moreActive = MORE.some((l) => isActive(l.href));

  return (
    <>
      <nav className="bg-slate-900 border-b border-slate-700 sticky top-0 z-40 safe-top">
        <div className="max-w-7xl mx-auto px-3 sm:px-4 py-2 flex items-center gap-2">
          <Link href="/dashboard" className="font-bold text-lg text-white shrink-0 mr-1">
            🐝 BusyBee
          </Link>

          <div className="hidden lg:flex flex-wrap gap-1 flex-1">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={`px-3 py-2 rounded text-sm ${
                  isActive(l.href) ? "bg-blue-600 text-white" : "text-slate-300 hover:bg-slate-800"
                }`}
              >
                {l.label}
              </Link>
            ))}
          </div>

          <form onSubmit={search} className="flex-1 lg:flex-none min-w-0">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search everything..."
              aria-label="Search projects, tasks, people and files"
              enterKeyHint="search"
              className="w-full lg:w-56 px-3 py-2 bg-slate-800 border border-slate-700 rounded text-sm placeholder-slate-500"
            />
          </form>

          <NotificationBell />

          <button
            onClick={logout}
            className="hidden lg:block px-3 py-2 rounded text-sm text-slate-300 hover:bg-slate-800 shrink-0"
          >
            Log out
          </button>
        </div>
      </nav>

      {/* Phone and tablet tab bar */}
      <nav
        className="tabbar lg:hidden fixed bottom-0 inset-x-0 z-40 bg-slate-900/95 backdrop-blur border-t border-slate-700 safe-bottom"
        aria-label="Main"
      >
        <div className="grid grid-cols-5 max-w-xl mx-auto">
          {TABS.map(({ href, label, Icon }) => {
            const on = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={on ? "page" : undefined}
                className={`flex flex-col items-center justify-center gap-0.5 h-14 text-[11px] font-medium ${
                  on ? "text-amber-300" : "text-slate-400 active:text-slate-200"
                }`}
              >
                <Icon size={22} strokeWidth={on ? 2.4 : 2} aria-hidden="true" />
                {label}
              </Link>
            );
          })}
          <button
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className={`flex flex-col items-center justify-center gap-0.5 h-14 text-[11px] font-medium ${
              open || moreActive ? "text-amber-300" : "text-slate-400 active:text-slate-200"
            }`}
          >
            {open ? <X size={22} aria-hidden="true" /> : <Menu size={22} aria-hidden="true" />}
            More
          </button>
        </div>
      </nav>

      {open && (
        // Under the tab bar (z-30 vs z-40), so "More" stays there to close it.
        <div className="lg:hidden fixed inset-0 z-30 bg-black/60" onClick={() => setOpen(false)}>
          <div
            role="dialog"
            aria-label="More pages"
            className="absolute inset-x-0 above-tabbar bg-slate-900 border-t border-slate-700 rounded-t-2xl px-3 pt-2"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto w-10 h-1.5 rounded-full bg-slate-700 mb-3" aria-hidden="true" />
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pb-3">
              {MORE.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  className={`px-4 py-3.5 rounded-xl text-sm font-medium ${
                    isActive(l.href) ? "bg-blue-600 text-white" : "text-slate-200 bg-slate-800 active:bg-slate-700"
                  }`}
                >
                  {l.label}
                </Link>
              ))}
              {!app && (
                <Link href="/install" className="px-4 py-3.5 rounded-xl text-sm font-medium text-amber-200 bg-amber-950 border border-amber-800">
                  📱 Get the app
                </Link>
              )}
              <button onClick={logout} className="px-4 py-3.5 rounded-xl text-sm font-medium text-left text-red-300 bg-slate-800 active:bg-slate-700">
                Log out
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
