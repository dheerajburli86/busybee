"use client";

// White on black, or black on white: one tap switches the whole app, and the
// choice is remembered on this device. The theme is put on <html> before the
// page is drawn (THEME_SCRIPT in lib/theme.ts), so it never flashes.

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { THEME_BAR as BAR, THEME_KEY as KEY, type Theme } from "@/lib/theme";

function current(): Theme {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

function apply(t: Theme, save: boolean) {
  document.documentElement.setAttribute("data-theme", t);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", BAR[t]));
  if (save) {
    try {
      localStorage.setItem(KEY, t);
    } catch {
      /* private mode: this visit only */
    }
  }
}

export function ThemeToggle({ className = "" }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const t = current();
    setTheme(t);
    apply(t, false);
    // Switched in another tab or window: follow it here too.
    const other = (e: StorageEvent) => {
      if (e.key !== KEY || (e.newValue !== "light" && e.newValue !== "dark")) return;
      apply(e.newValue, false);
      setTheme(e.newValue);
    };
    window.addEventListener("storage", other);
    return () => window.removeEventListener("storage", other);
  }, []);

  const flip = () => {
    const next: Theme = theme === "light" ? "dark" : "light";
    apply(next, true);
    setTheme(next);
  };

  const label = theme === "light" ? "Switch to white on black" : "Switch to black on white";
  return (
    <button
      type="button"
      onClick={flip}
      aria-label={label}
      title={label}
      className={`shrink-0 w-10 h-10 flex items-center justify-center rounded bg-slate-800 hover:bg-slate-700 text-white ${className}`}
    >
      {theme === "light" ? <Moon size={18} aria-hidden="true" /> : <Sun size={18} aria-hidden="true" />}
    </button>
  );
}
