// Admin button on the People page: (re)register the Telegram webhook for this
// deployment. Normally unnecessary - the first "Connect Telegram" does it - but
// needed if the bot token is ever changed or the site moves address.

import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";
import { getMemberships, requireUser, topRole, SUPER_ROLES } from "@/lib/permissions";
import { ensureWebhook } from "@/lib/telegram";

export async function POST(req: NextRequest) {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!SUPER_ROLES.includes(topRole(await getMemberships(supabase, user.id)))) {
      return NextResponse.json({ error: "Only a supervisor or admin can do this" }, { status: 403 });
    }
    const result = await ensureWebhook(req.nextUrl.origin, true);
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  } catch (error: any) {
    console.error("POST /api/telegram/setup failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
