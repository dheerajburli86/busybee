// A copy of the last data a page showed, kept for this browser tab only, so
// coming back to a page paints straight away while fresh data loads behind
// it. Cleared on sign-out. Never trusted for anything but a first paint.

const PREFIX = "bb-snap:";

export function readSnapshot<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeSnapshot(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* full or blocked: just no instant paint next time */
  }
}

export function clearSnapshots(): void {
  try {
    Object.keys(sessionStorage)
      .filter((k) => k.startsWith(PREFIX))
      .forEach((k) => sessionStorage.removeItem(k));
  } catch {
    /* nothing to clear */
  }
}
