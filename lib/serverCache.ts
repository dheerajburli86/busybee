// Short-lived answers kept on the server between API calls.
//
// A screen fires several API calls at once and people tap around quickly, and
// most calls start with the same questions: is this sign-in valid, which desk
// is this person on, which projects are theirs. Each answer is looked up once
// per request, and kept for a few seconds per person so the calls right after
// it skip the trip to the database. Anything that changes who can see what
// (desk roles, project members, teams) clears it straight away - see
// forgetAccess().

import { after } from "next/server";

type Kept = { until: number; value: Promise<unknown> };

const shared = new Map<string, Kept>();
const perRequest = new WeakMap<object, Map<string, Promise<unknown>>>();

/**
 * `load()` once per `scope` (one request's Supabase client) and, with a TTL,
 * once per `ttlMs` across requests. `keep` decides whether an answer may be
 * reused by later requests (e.g. don't keep "not on any desk yet").
 */
export function remembered<T>(
  scope: object | null,
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
  keep?: (value: T) => boolean
): Promise<T> {
  let local: Map<string, Promise<unknown>> | undefined;
  if (scope) {
    local = perRequest.get(scope);
    if (!local) {
      local = new Map();
      perRequest.set(scope, local);
    }
    const mine = local.get(key);
    if (mine) return mine as Promise<T>;
  }

  const now = Date.now();
  const hit = shared.get(key);
  let value: Promise<T>;
  if (ttlMs > 0 && hit && hit.until > now) {
    value = hit.value as Promise<T>;
  } else {
    value = load();
    if (ttlMs > 0) {
      shared.set(key, { until: now + ttlMs, value });
      value.then(
        (v) => {
          if (keep && !keep(v)) shared.delete(key);
        },
        () => shared.delete(key)
      );
      if (shared.size > 5000) {
        for (const [k, v] of Array.from(shared)) if (v.until <= now) shared.delete(k);
      }
    }
  }
  local?.set(key, value);
  return value;
}

/** Forget kept answers about access (all of them, or keys starting with `prefix`). */
export function forgetAccess(prefix = ""): void {
  for (const k of Array.from(shared.keys())) {
    if (!prefix || k.startsWith(prefix)) shared.delete(k);
  }
}

/**
 * Someone's desk, role, projects or teams are about to change: forget what's
 * kept, now and again once the change is saved (so a call that slipped in
 * between can't keep the old answer).
 */
export function accessChanged(): void {
  forgetAccess();
  try {
    after(() => forgetAccess());
  } catch {
    /* not inside a request */
  }
}

/** When a token stops being valid (ms since 1970), read from the token itself. */
export function tokenExpiry(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/** Whose token this is (its "sub"), read from the token itself - no check. */
export function tokenSubject(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}
