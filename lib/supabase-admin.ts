// Server-only Supabase client with the service key, for the few lookups the
// signed-in user must NOT be able to make from their own browser:
//   * linking a Telegram chat (only after the webhook has verified Telegram)
//   * reading other people's alert settings and Telegram chats to send alerts
//
// SUPABASE_SERVICE_ROLE_KEY is a server environment variable (never
// NEXT_PUBLIC_), so it is never sent to a browser. Without it, Telegram stays
// off and alerts fall back to bell + email, as before.

import { createClient, SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

export function adminConfigured(): boolean {
  return Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() && process.env.NEXT_PUBLIC_SUPABASE_URL);
}

export function createAdminClient(): SupabaseClient | null {
  if (typeof window !== "undefined") throw new Error("supabase-admin is server-only");
  if (!adminConfigured()) return null;
  if (!cached) {
    cached = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cached;
}

/** Which of these people have a Telegram chat connected. Never returns the chat ids. */
export async function telegramConnected(ids: string[]): Promise<Set<string> | null> {
  const admin = createAdminClient();
  if (!admin || ids.length === 0) return admin ? new Set() : null;
  const { data, error } = await admin.from("user_telegram").select("user_id").in("user_id", ids);
  if (error) return null;
  return new Set((data || []).map((r: any) => r.user_id));
}
