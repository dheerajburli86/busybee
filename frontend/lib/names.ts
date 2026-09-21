/** Attach a display name for each user id found under `key`. */
export async function attachNames<T extends Record<string, any>>(
  supabase: any,
  rows: T[],
  key: string,
  as = "user_name"
): Promise<(T & Record<string, string>)[]> {
  const ids = Array.from(new Set(rows.map((r) => r[key]).filter(Boolean)));
  if (!ids.length) return rows as any;
  const { data } = await supabase.from("users").select("id, full_name, email").in("id", ids);
  const byId = new Map((data || []).map((u: any) => [u.id, u.full_name || u.email]));
  return rows.map((r) => ({ ...r, [as]: (byId.get(r[key]) as string) || "Someone" })) as any;
}
