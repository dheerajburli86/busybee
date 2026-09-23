// Dates in notification and email text. The server runs in UTC, so format in
// the office's timezone explicitly (APP_TIMEZONE, default India).

const ZONE = process.env.APP_TIMEZONE || "Asia/Kolkata";

export function formatForPeople(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const text = d.toLocaleString("en-IN", {
    timeZone: ZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  return ZONE === "Asia/Kolkata" ? `${text} IST` : text;
}

/** Today's date (YYYY-MM-DD) in the office's timezone. */
export function officeToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The office's UTC offset, e.g. "+05:30" (read from APP_TIMEZONE). */
function officeOffset(at: Date): string {
  try {
    const part =
      new Intl.DateTimeFormat("en-US", { timeZone: ZONE, timeZoneName: "longOffset" } as any)
        .formatToParts(at)
        .find((p) => p.type === "timeZoneName")?.value || "";
    const m = /GMT([+-]\d{1,2}):?(\d{2})?/.exec(part);
    if (m) {
      const sign = m[1].startsWith("-") ? "-" : "+";
      const hours = m[1].replace(/[+-]/, "").padStart(2, "0");
      return `${sign}${hours}:${m[2] || "00"}`;
    }
    if (part === "GMT") return "+00:00";
  } catch {
    /* fall through */
  }
  return "+05:30";
}

/**
 * A date/time from a request, as a full ISO timestamp. The app's own screens
 * always send a timezone; a value without one is read as office time rather
 * than UTC (so "18:00" means 18:00 IST), and a bare date means the end of that
 * day. Returns null for anything that isn't a real date between 2000 and 2100.
 */
export function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let s = value.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s = `${s}T23:59:00`;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?$/.test(s)) {
    s = s.replace(" ", "T");
    const approx = new Date(`${s}Z`);
    s += officeOffset(isNaN(approx.getTime()) ? new Date() : approx);
  }
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  if (year < 2000 || year > 2100) return null;
  return d.toISOString();
}
