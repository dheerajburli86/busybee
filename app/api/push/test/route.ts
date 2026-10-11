// "Send a test": pops up a notification on every device this person turned on.
import { NextResponse } from "next/server";
import { createServerSideClient } from "@/lib/supabase-server";
import { requireUser } from "@/lib/permissions";
import { pushToUsers } from "@/lib/push";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { sent, devices } = await pushToUsers([user.id], {
      title: "🐝 BusyBee notifications are on",
      body: "This is how BusyBee tells you about new tasks, deadlines and messages.",
      url: "/dashboard",
      tag: "bb-test",
    });
    if (devices === 0) return NextResponse.json({ error: "No device has notifications on yet." }, { status: 404 });
    if (sent === 0) return NextResponse.json({ error: "The notification service didn't accept it. Turn notifications off and on again." }, { status: 502 });
    return NextResponse.json({ sent, devices });
  } catch (error: any) {
    console.error("POST /api/push/test failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
