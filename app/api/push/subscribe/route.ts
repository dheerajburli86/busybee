// This person's devices with pop-up notifications on.
//   GET     -> { devices: [{ id, device, created_at, last_ok_at }] }
//   POST    { subscription, device?, old_endpoint? } -> save this device
//   DELETE  { endpoint } or { id } -> turn a device off
import { NextResponse } from "next/server";
import { createServerSideClient } from "@/lib/supabase-server";
import { requireUser } from "@/lib/permissions";
import { pushConfigured } from "@/lib/push";

export const dynamic = "force-dynamic";

// The push services browsers use. Anything else is refused, so the server
// never posts to an address someone made up. (The database checks it too.)
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/i;

function validEndpoint(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2000) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && PUSH_HOSTS.test(u.hostname) ? raw : null;
  } catch {
    return null;
  }
}
const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

export async function GET() {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { data, error } = await supabase
      .from("push_subscriptions")
      .select("id, device, created_at, last_ok_at, endpoint")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    if (error) return NextResponse.json({ devices: [], configured: false, migrated: false });
    return NextResponse.json({
      configured: pushConfigured(),
      migrated: true,
      // The endpoint itself stays on the server; the page only needs to know
      // which row is this device, so it gets a short fingerprint instead.
      devices: (data || []).map((d: any) => ({
        id: d.id,
        device: d.device || "A device",
        created_at: d.created_at,
        last_ok_at: d.last_ok_at,
        tail: String(d.endpoint || "").slice(-16),
      })),
    });
  } catch (error: any) {
    console.error("GET /api/push/subscribe failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => null);
    const sub = body?.subscription;
    const endpoint = validEndpoint(sub?.endpoint);
    const p256dh = String(sub?.keys?.p256dh || "");
    const auth = String(sub?.keys?.auth || "");
    if (!endpoint) return NextResponse.json({ error: "This browser's notification service isn't supported." }, { status: 400 });
    if (!B64URL.test(p256dh) || !B64URL.test(auth) || p256dh.length < 80 || p256dh.length > 100 || auth.length < 16 || auth.length > 32) {
      return NextResponse.json({ error: "That notification subscription looks broken - turn notifications off and on again." }, { status: 400 });
    }
    const device = typeof body?.device === "string" ? body.device.slice(0, 60) : null;
    const ua = (req.headers.get("user-agent") || "").slice(0, 400);

    const { error } = await supabase.rpc("bb_push_subscribe", {
      p_endpoint: endpoint,
      p_p256dh: p256dh,
      p_auth: auth,
      p_device: device,
      p_user_agent: ua,
    });
    if (error) {
      const missing = /bb_push_subscribe|function|schema cache/i.test(error.message || "");
      return NextResponse.json(
        { error: missing ? "Pop-up notifications need the latest database migration (20261011_app_push.sql)." : error.message },
        { status: missing ? 503 : 400 }
      );
    }
    // The phone replaced its old subscription with this one.
    const old = typeof body?.old_endpoint === "string" ? body.old_endpoint : null;
    if (old && old !== endpoint) await supabase.from("push_subscriptions").delete().eq("user_id", user.id).eq("endpoint", old);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("POST /api/push/subscribe failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    let q = supabase.from("push_subscriptions").delete().eq("user_id", user.id);
    if (typeof body?.endpoint === "string" && body.endpoint) q = q.eq("endpoint", body.endpoint);
    else if (typeof body?.id === "string" && body.id) q = q.eq("id", body.id);
    else return NextResponse.json({ error: "endpoint or id required" }, { status: 400 });
    const { error } = await q;
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("DELETE /api/push/subscribe failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
