// Checklist #48: per-person notification preferences. Every notification
// already carries a `type` (see lib/permissions.ts notifyMany and the
// scheduler's notify()); this groups those types into a small set of
// categories a person can turn on or off, separately for in-app and email.
//
// Unknown/future types default to "tasks" - a request never disappears
// silently just because a category was missed here; the worst case is it
// lands in the broadest, most-visible bucket, not that it can't be muted.

export const NOTIFICATION_CATEGORIES = [
  { key: "tasks", label: "Task assignments & updates", hint: "New tasks, reassignments, checklist items finished" },
  { key: "comments", label: "Comments & mentions", hint: "@mentions and private comments addressed to you" },
  { key: "extensions", label: "Extensions & assignors", hint: "Deadline extension requests/decisions, being added as an assignor" },
  { key: "reminders", label: "Deadline reminders", hint: "6h/8h/24h reminders, overdue alerts, checklist due dates" },
  { key: "daily_summary", label: "Daily summaries", hint: "Start-of-day / end-of-day digests, update requests" },
] as const;

export type CategoryKey = (typeof NOTIFICATION_CATEGORIES)[number]["key"];
export const CATEGORY_KEYS: CategoryKey[] = NOTIFICATION_CATEGORIES.map((c) => c.key);

/** Map a notification `type` (as stored on notifications.type) to a category. */
export function categoryOf(type: string): CategoryKey {
  const t = String(type || "");
  if (t === "mention" || t === "private_comment") return "comments";
  if (t === "extension_request" || t === "extension_reviewed" || t === "assignor_added") return "extensions";
  if (t === "overdue" || t === "checklist_due" || t.startsWith("reminder")) return "reminders";
  if (t === "bod_summary" || t === "eod_summary" || t === "update_request") return "daily_summary";
  // "assigned", "updated", "subtask_completed", "completed", and anything new.
  return "tasks";
}

export type ChannelPrefs = { in_app: boolean; email: boolean };
export type NotificationPrefs = {
  email_enabled: boolean;
  categories: Partial<Record<CategoryKey, ChannelPrefs>>;
};

export function defaultPrefs(): NotificationPrefs {
  return { email_enabled: true, categories: {} };
}

function channelPrefs(prefs: NotificationPrefs, category: CategoryKey): ChannelPrefs {
  return prefs.categories[category] || { in_app: true, email: true };
}

export function wantsInApp(prefs: NotificationPrefs, type: string): boolean {
  return channelPrefs(prefs, categoryOf(type)).in_app;
}

export function wantsEmail(prefs: NotificationPrefs, type: string): boolean {
  if (!prefs.email_enabled) return false;
  return channelPrefs(prefs, categoryOf(type)).email;
}

function normalizeRow(row: any): NotificationPrefs {
  const cats = row?.categories && typeof row.categories === "object" ? row.categories : {};
  const categories: NotificationPrefs["categories"] = {};
  for (const key of CATEGORY_KEYS) {
    const c = cats[key];
    categories[key] = {
      in_app: c?.in_app !== false,
      email: c?.email !== false,
    };
  }
  return { email_enabled: row?.email_enabled !== false, categories };
}

/** Load prefs for a set of users, defaulting anyone with no row to "everything on". */
export async function getPrefsMap(supabase: any, userIds: string[]): Promise<Map<string, NotificationPrefs>> {
  const map = new Map<string, NotificationPrefs>();
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (!ids.length) return map;
  try {
    const { data } = await supabase.from("notification_prefs").select("user_id, email_enabled, categories").in("user_id", ids);
    (data || []).forEach((row: any) => map.set(row.user_id, normalizeRow(row)));
  } catch {
    /* table missing or unreachable: everyone falls back to "everything on" below */
  }
  ids.forEach((id) => {
    if (!map.has(id)) map.set(id, defaultPrefs());
  });
  return map;
}

/** Load one person's own prefs, defaulting to "everything on". */
export async function getPrefsFor(supabase: any, userId: string): Promise<NotificationPrefs> {
  const map = await getPrefsMap(supabase, [userId]);
  return map.get(userId) || defaultPrefs();
}
