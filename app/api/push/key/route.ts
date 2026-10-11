// The public half of the server's push key pair, which a phone needs to turn
// notifications on. Made the first time anyone asks (see lib/push.ts).
import { NextResponse } from "next/server";
import { createServerSideClient } from "@/lib/supabase-server";
import { requireUser } from "@/lib/permissions";
import { vapidKeys } from "@/lib/push";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const v = await vapidKeys(true);
    if (!v) {
      return NextResponse.json(
        { error: "Pop-up notifications aren't set up on the server yet (it needs SUPABASE_SERVICE_ROLE_KEY and the latest database migration)." },
        { status: 503 }
      );
    }
    return NextResponse.json({ publicKey: v.publicKey }, { headers: { "Cache-Control": "no-store" } });
  } catch (error: any) {
    console.error("GET /api/push/key failed:", error);
    return NextResponse.json({ error: error?.message || "Could not load the key" }, { status: 500 });
  }
}
