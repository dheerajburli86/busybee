"use client";

// The heatmap's live data: the tasks from /api/heatmap (fetched again every
// minute while the screen is open, straight away after a pop-up or when the
// app comes back), and a clock that ticks every 30 seconds so colours move as
// time passes even when nothing else changes. The clock follows the server's
// time, not the phone's, so a phone set wrong can't change anyone's colour.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cached, load, useBeforePaint, useRefresh } from "@/lib/apiCache";
import { PUSH_EVENT } from "@/lib/appEvents";
import { scorePerson, type HeatTask, type PersonHeat, type TaskHeat } from "@/lib/heatmap";

type HeatData = { now: string; scope: "all" | "visible"; tasks: HeatTask[] };
const HEAT_URL = "/api/heatmap";
const REFETCH_MS = 60_000;
const TICK_MS = 30_000;

export type PersonResult = PersonHeat & { perTask: Map<string, TaskHeat>; tasks: HeatTask[] };

export function useHeatmap(peopleIds: string[]) {
  const [data, setData] = useState<HeatData | null>(null);
  const [error, setError] = useState("");
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  // Server clock minus this device's clock.
  const offset = useRef(0);
  const [tick, setTick] = useState(0);

  const show = useCallback((d: HeatData, fresh: boolean) => {
    if (fresh) offset.current = Date.parse(d.now) - Date.now();
    setData(d);
    if (fresh) setLoadedAt(Date.now());
  }, []);

  const refresh = useCallback(async () => {
    try {
      show(await load<HeatData>(HEAT_URL), true);
      setError("");
    } catch (e: any) {
      setError(e?.message || "Could not load the heatmap");
    }
  }, [show]);

  useBeforePaint(() => {
    const known = cached<HeatData>(HEAT_URL);
    if (known) show(known, false);
    refresh();
  }, [refresh, show]);
  useRefresh(refresh);

  // Live: new data every minute and on a pop-up; the clock every 30 s.
  // Nothing runs while the screen is hidden; coming back catches up at once.
  useEffect(() => {
    let fetchTimer: ReturnType<typeof setInterval> | undefined;
    let tickTimer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      stop();
      fetchTimer = setInterval(refresh, REFETCH_MS);
      tickTimer = setInterval(() => setTick((n) => n + 1), TICK_MS);
    };
    const stop = () => {
      clearInterval(fetchTimer);
      clearInterval(tickTimer);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        setTick((n) => n + 1);
        refresh();
        start();
      } else stop();
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(PUSH_EVENT, refresh);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(PUSH_EVENT, refresh);
    };
  }, [refresh]);

  const key = peopleIds.join(",");
  const results = useMemo(() => {
    const now = Date.now() + offset.current;
    const byPerson = new Map<string, HeatTask[]>();
    (data?.tasks || []).forEach((t) => {
      if (!t.assigned_to) return;
      byPerson.set(t.assigned_to, [...(byPerson.get(t.assigned_to) || []), t]);
    });
    const out = new Map<string, PersonResult>();
    for (const id of key ? key.split(",") : []) {
      const tasks = byPerson.get(id) || [];
      out.set(id, { ...scorePerson(tasks, now), tasks });
    }
    return { now, out };
    // `tick` re-runs the scoring as time passes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, key, tick]);

  return { ready: !!data, scope: data?.scope || "visible", error, loadedAt, now: results.now, people: results.out, refresh };
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
export function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return "never";
  const m = Math.round((now - Date.parse(iso)) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}
