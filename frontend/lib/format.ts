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
