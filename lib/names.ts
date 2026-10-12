import { remembered } from "@/lib/serverCache";

/**
 * Attach a display name for each user id found under `key`. Names are kept
 * for half a minute, so a chat that refreshes every few seconds doesn't look
 * the same people up each time.
 */
export async function attachNames<T extends Record<string, any>>(
  supabase: any,
  rows: T[],
  key: string,
  as = "user_name"
): Promise<(T & Record<string, string>)[]> {
  const ids = Array.from(new Set(rows.map((r) => r[key]).filter(Boolean))).sort();
  if (!ids.length) return rows as any;
  const byId = await remembered(
    supabase,
    `names:${ids.join(",")}`,
    30_000,
    async () => {
      const { data } = await supabase.from("users").select("id, full_name, email").in("id", ids);
      return new Map<string, string>((data || []).map((u: any) => [u.id, u.full_name || u.email]));
    },
    (m) => m.size > 0
  );
  return rows.map((r) => ({ ...r, [as]: byId.get(r[key]) || "Someone" })) as any;
}
