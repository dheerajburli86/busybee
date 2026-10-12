// Screens open instantly.
//
// Every answer the app reads from the server is remembered on this device
// (in memory, and in localStorage so it survives closing the app). A screen
// shows the remembered answer at once and quietly fetches a fresh one behind
// it. Screens asking for the same thing at the same moment share one request,
// and the app fetches the main screens ahead of time (see AppNav), so moving
// between tabs never waits on the network.
//
// Cleared when anyone signs in or out (forgetAll), so one person's data is
// never shown to another.

import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * useLayoutEffect in the browser (runs before the screen is painted, so a
 * remembered answer is the first thing people see), useEffect on the server.
 */
export const useBeforePaint = typeof window !== "undefined" ? useLayoutEffect : useEffect;

const PREFIX = "bb-api:";
// Answers bigger than this stay in memory only (localStorage holds ~5 MB).
const MAX_STORED = 1_500_000;

type Entry = { data: unknown; at: number };
const mem = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

function stored(key: string): Entry | undefined {
  const hit = mem.get(key);
  if (hit) return hit;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw) {
      const entry = JSON.parse(raw) as Entry;
      mem.set(key, entry);
      return entry;
    }
  } catch {
    /* storage blocked or damaged: nothing remembered */
  }
  return undefined;
}

/** When the remembered answer for `key` came from the server (0: never). */
export function cachedAt(key: string): number {
  if (typeof window === "undefined") return 0;
  return stored(key)?.at || 0;
}

/** The remembered answer for `key` (a URL, usually), or undefined. */
export function cached<T>(key: string): T | undefined {
  if (typeof window === "undefined") return undefined;
  return stored(key)?.data as T | undefined;
}

/**
 * Remember `data` as the latest answer for `key` (e.g. after an edit on
 * screen). `at`: when it came from the server (default now) - what `fresh`
 * goes by.
 */
export function remember(key: string, data: unknown, at = Date.now()): void {
  const entry: Entry = { data, at };
  mem.set(key, entry);
  try {
    const text = JSON.stringify(entry);
    if (text.length > MAX_STORED) {
      localStorage.removeItem(PREFIX + key);
      return;
    }
    try {
      localStorage.setItem(PREFIX + key, text);
    } catch {
      // Full: make room by dropping the other remembered answers, then retry.
      Object.keys(localStorage)
        .filter((k) => k.startsWith(PREFIX) && k !== PREFIX + key)
        .forEach((k) => localStorage.removeItem(k));
      localStorage.setItem(PREFIX + key, text);
    }
  } catch {
    /* storage blocked: memory only */
  }
}

/**
 * A fresh answer from the server (remembered for next time). Concurrent
 * calls for the same key share one request. `fresh` (ms): reuse a remembered
 * answer that is at least this recent instead of asking again.
 */
export function load<T = any>(url: string, opts: { fresh?: number; key?: string; init?: RequestInit } = {}): Promise<T> {
  const key = opts.key || url;
  if (opts.fresh) {
    const e = stored(key);
    if (e && Date.now() - e.at < opts.fresh) return Promise.resolve(e.data as T);
  }
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = fetch(url, { cache: "no-store", ...opts.init })
    .then(async (r) => {
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error((d as any)?.error || `Request failed (${r.status})`), { status: r.status });
      remember(key, d);
      return d as T;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Fetch these ahead of time (skipping any fetched in the last `fresh` ms). Never throws. */
export function prefetch(urls: string[], fresh = 20_000): void {
  urls.forEach((u) => load(u, { fresh }).catch(() => {}));
}

/** Forget everything remembered (sign-in, sign-out). */
export function forgetAll(): void {
  mem.clear();
  inflight.clear();
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(PREFIX) || k.startsWith("bb-snap:"))
      .forEach((k) => localStorage.removeItem(k));
  } catch {
    /* nothing to clear */
  }
}

/**
 * `next`, reusing `prev`'s rows wherever nothing changed - and `prev` itself
 * when nothing changed at all - so a refresh that brings nothing new doesn't
 * redraw the screen (rows drawn by memo() components skip unchanged rows).
 */
export function keepSame<T extends { id: string }>(prev: T[], next: T[]): T[] {
  if (!prev.length || !next.length) return next;
  const old = new Map(prev.map((x) => [x.id, x]));
  let changed = prev.length !== next.length;
  const out = next.map((x, i) => {
    const o = old.get(x.id);
    if (o !== undefined && (o === x || JSON.stringify(o) === JSON.stringify(x))) {
      if (prev[i] !== o) changed = true;
      return o;
    }
    changed = true;
    return x;
  });
  return changed ? out : prev;
}

/**
 * Things just added on a screen (or still being sent) that a reload which set
 * off before the server had them must not wipe from the list. `merge` puts
 * them in front of the server's list until the server's list includes them
 * (or 20 seconds pass).
 */
export function freshKeeper<T extends { id: string }>() {
  const m = new Map<string, { item: T; at: number }>();
  return {
    add(item: T) {
      m.set(item.id, { item, at: Date.now() });
    },
    drop(id: string) {
      m.delete(id);
    },
    merge(server: T[]): T[] {
      const ids = new Set(server.map((x) => x.id));
      const now = Date.now();
      const keep: T[] = [];
      m.forEach((v, id) => {
        if (ids.has(id) || now - v.at > 20_000) m.delete(id);
        else keep.push(v.item);
      });
      return keep.length ? [...keep, ...server] : server;
    },
  };
}

// ---- Refreshing what's on screen --------------------------------------------
// Screens register how to reload themselves; pull-to-refresh and coming back
// to the app call them all, so data updates in place without reloading the
// whole app.

const refreshers = new Set<() => unknown>();

/** Reload every screen showing now. Returns how many screens took part. */
export async function refreshAll(): Promise<number> {
  const list = Array.from(refreshers);
  await Promise.allSettled(list.map((fn) => Promise.resolve().then(fn)));
  return list.length;
}

/** While mounted, `fn` runs on pull-to-refresh and when the app comes back. */
export function useRefresh(fn: () => unknown): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const run = () => ref.current();
    refreshers.add(run);
    return () => {
      refreshers.delete(run);
    };
  }, []);
}
