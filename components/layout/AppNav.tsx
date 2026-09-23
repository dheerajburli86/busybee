"use client";

// One navigation bar for every signed-in page. On phones it collapses into a
// menu button; on wider screens it's a single row that wraps if it must.

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";
import { NotificationBell } from "@/components/NotificationBell";

const LINKS = [
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
];

export function AppNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  // Close the phone menu whenever the page changes.
  useEffect(() => setOpen(false), [pathname]);

  // Presence heartbeat (checklist #27): "online" means seen in the last 2 min.
  useEffect(() => {
    const ping = () => fetch("/api/presence", { method: "POST" }).catch(() => {});
    ping();
    const t = setInterval(ping, 60000);
    return () => clearInterval(t);
  }, []);

  const logout = async () => {
    // Sign out this browser only (the default signs out every device), then
    // load the login page fresh so no signed-in screen lingers.
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

  return (
    <nav className="bg-slate-900 border-b border-slate-700 sticky top-0 z-40">
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

        <button
          onClick={() => setOpen(!open)}
          className="lg:hidden px-3 py-2 rounded bg-slate-800 text-slate-200 text-sm shrink-0 min-h-[40px]"
          aria-expanded={open}
          aria-label="Menu"
        >
          {open ? "✕" : "☰"}
        </button>
      </div>

      {open && (
        <div className="lg:hidden border-t border-slate-700 px-3 py-2 grid grid-cols-2 sm:grid-cols-3 gap-1">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`px-3 py-3 rounded text-sm ${
                isActive(l.href) ? "bg-blue-600 text-white" : "text-slate-200 bg-slate-800"
              }`}
            >
              {l.label}
            </Link>
          ))}
          <button onClick={logout} className="px-3 py-3 rounded text-sm text-left text-red-300 bg-slate-800">
            Log out
          </button>
        </div>
      )}
    </nav>
  );
}
