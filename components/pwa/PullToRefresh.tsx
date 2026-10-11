"use client";

// Pull down at the top of the page to refresh - in the installed app only,
// which has no browser reload button. (In a browser tab the browser's own
// pull-to-refresh is left alone.)

import { useEffect, useRef, useState } from "react";
import { isStandalone } from "@/lib/pushClient";

const TRIGGER = 70; // px the spinner travels before a release refreshes

/**
 * Leave the gesture alone when the finger is on a pop-up (anything fixed on
 * screen: dialogs, menus, the tab bar) or inside a list that scrolls on its
 * own and isn't at its top.
 */
function insideScrolled(el: Element | null): boolean {
  if (!el || el.closest?.("[role=dialog], [data-no-pull]")) return true;
  for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
    const style = getComputedStyle(n);
    if (style.position === "fixed") return true;
    if (/(auto|scroll)/.test(style.overflowY) && n.scrollHeight > n.clientHeight && n.scrollTop > 0) return true;
  }
  return false;
}

export function PullToRefresh() {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const start = useRef<{ y: number; x: number } | null>(null);
  const dist = useRef(0);

  useEffect(() => {
    if (!isStandalone() || !("ontouchstart" in window)) return;

    const down = (e: TouchEvent) => {
      if (e.touches.length !== 1 || window.scrollY > 0 || insideScrolled(e.target as Element)) {
        start.current = null;
        return;
      }
      start.current = { y: e.touches[0].clientY, x: e.touches[0].clientX };
      dist.current = 0;
    };
    const move = (e: TouchEvent) => {
      if (!start.current) return;
      const dy = e.touches[0].clientY - start.current.y;
      const dx = Math.abs(e.touches[0].clientX - start.current.x);
      if (window.scrollY > 0 || dy <= 0 || dx > dy) {
        if (dist.current) setPull(0);
        dist.current = 0;
        return;
      }
      // Resistance: the spinner moves at half the finger's speed.
      dist.current = Math.min(dy / 2, TRIGGER * 1.4);
      setPull(dist.current);
    };
    const up = () => {
      if (!start.current) return;
      start.current = null;
      if (dist.current >= TRIGGER) {
        setRefreshing(true);
        setPull(TRIGGER);
        window.location.reload();
      } else {
        setPull(0);
      }
      dist.current = 0;
    };
    window.addEventListener("touchstart", down, { passive: true });
    window.addEventListener("touchmove", move, { passive: true });
    window.addEventListener("touchend", up, { passive: true });
    window.addEventListener("touchcancel", up, { passive: true });
    return () => {
      window.removeEventListener("touchstart", down);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", up);
      window.removeEventListener("touchcancel", up);
    };
  }, []);

  if (!pull && !refreshing) return null;
  const ready = pull >= TRIGGER;
  return (
    <div
      className="fixed left-1/2 z-[70] -translate-x-1/2 pointer-events-none"
      style={{ top: `calc(env(safe-area-inset-top) + ${Math.round(pull) - 8}px)` }}
      aria-hidden="true"
    >
      <div
        className={`w-10 h-10 rounded-full bg-slate-800 border border-slate-600 shadow-lg flex items-center justify-center text-lg ${
          refreshing ? "animate-spin" : ""
        } ${ready ? "text-amber-300" : "text-slate-300"}`}
        style={refreshing ? undefined : { transform: `rotate(${Math.round(pull * 4)}deg)` }}
      >
        ↻
      </div>
    </div>
  );
}
