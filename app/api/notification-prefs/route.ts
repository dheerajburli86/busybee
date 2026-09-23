// app/api/notification-prefs/route.ts
//
// Checklist #48: read/write this person's own notification preferences.
// Nobody else's prefs are ever readable or writable through this route.

import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/permissions";
import { CATEGORY_KEYS, NOTIFICATION_CATEGORIES, getPrefsFor } from "@/lib/notifications";

export async function GET() {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const prefs = await getPrefsFor(supabase, user.id);
    return NextResponse.json({ ...prefs, mail_configured: !!process.env.RESEND_API_KEY, categories_meta: NOTIFICATION_CATEGORIES });
  } catch (error: any) {
    console.error("GET /api/notification-prefs failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const email_enabled = body.email_enabled !== false;
    const categories: Record<string, { in_app: boolean; email: boolean }> = {};
    for (const key of CATEGORY_KEYS) {
      const c = body.categories?.[key] || {};
      categories[key] = { in_app: c.in_app !== false, email: c.email !== false };
    }

    const { error } = await supabase
      .from("notification_prefs")
      .upsert({ user_id: user.id, email_enabled, categories, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    if (error) throw error;

    return NextResponse.json({ email_enabled, categories });
  } catch (error: any) {
    console.error("PUT /api/notification-prefs failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
