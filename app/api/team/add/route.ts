// "Add person" (Tasks → Who is this for?): makes a full BusyBee user in one go.
//
//   1. a sign-in account (Supabase Auth) - or the existing one for that email
//   2. their profile row (public.users, made by the sign-up trigger) with name
//   3. a place on the adder's desk with the chosen role (member or admin)
//   4. Telegram: a numeric Telegram id is connected straight away; a @username
//      is connected the moment that person messages the bot (webhook)
//   5. a welcome email with a link to set their password, and a link that
//      connects Telegram in one tap
//
// Members can't add people; only an admin can add an admin. Needs SUPABASE_SERVICE_ROLE_KEY.
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { createServerSideClient } from "@/lib/supabase-server";
import { createAdminClient } from "@/lib/supabase-admin";
import { getMemberships, logActivity, normalizeRole, requireUser } from "@/lib/permissions";
import { accessChanged } from "@/lib/serverCache";
import { deliver, mailConfigured } from "@/lib/email";
import { appUrl, botUsername, telegramConfigured } from "@/lib/telegram";

export const dynamic = "force-dynamic";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const admin = createAdminClient();
    if (!admin) return NextResponse.json({ error: "Adding people needs SUPABASE_SERVICE_ROLE_KEY set on the server" }, { status: 500 });

    const body = await request.json().catch(() => ({}));
    const name = String(body.name || "").trim().slice(0, 120);
    const email = String(body.email || "").trim().toLowerCase();
    const telegram = String(body.telegram || "").trim().replace(/^@/, "").slice(0, 64);
    const role = body.role === "admin" ? "admin" : "member";
    if (!name) return NextResponse.json({ error: "Add their name" }, { status: 400 });
    if (!EMAIL.test(email)) return NextResponse.json({ error: "That email doesn't look right" }, { status: 400 });
    if (telegram && !/^(\d{5,15}|[A-Za-z0-9_]{4,32})$/.test(telegram)) {
      return NextResponse.json({ error: "Telegram: a @username or the numeric Telegram id" }, { status: 400 });
    }

    const memberships = await getMemberships(supabase, user.id);
    const mine = memberships[0];
    if (!mine) return NextResponse.json({ error: "You are not on a desk" }, { status: 403 });
    if (normalizeRole(mine.role) === "member") {
      return NextResponse.json({ error: "Members can't add people. Ask an admin." }, { status: 403 });
    }
    if (role === "admin" && normalizeRole(mine.role) !== "admin") {
      return NextResponse.json({ error: "Only an admin can add an admin" }, { status: 403 });
    }

    // 1. The account: existing (same email) or new.
    const { data: existing } = await admin.from("users").select("id").eq("email", email).maybeSingle();
    let userId: string | null = existing?.id || null;
    let created = false;
    const meta = { full_name: name, ...(telegram && !/^\d+$/.test(telegram) ? { telegram_username: telegram.toLowerCase() } : {}) };
    if (!userId) {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password: randomBytes(18).toString("base64url"),
        email_confirm: true,
        user_metadata: meta,
      });
      if (error || !data?.user) return NextResponse.json({ error: error?.message || "Could not create the account" }, { status: 400 });
      userId = data.user.id;
      created = true;
    } else {
      await admin.auth.admin.updateUserById(userId, { user_metadata: meta }).catch(() => null);
    }

    // 2. Profile row (the sign-up trigger normally makes it; make sure).
    await admin.from("users").upsert({ id: userId, email, full_name: name }, { onConflict: "id" });

    // 3. Desk place.
    const { data: already } = await admin.from("desk_members").select("role").eq("desk_id", mine.desk_id).eq("user_id", userId).maybeSingle();
    if (already) {
      if (role === "admin" && normalizeRole(already.role) !== "admin") {
        await admin.from("desk_members").update({ role }).eq("desk_id", mine.desk_id).eq("user_id", userId);
      }
    } else {
      const { error } = await admin.from("desk_members").insert({ desk_id: mine.desk_id, user_id: userId, role });
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    }
    accessChanged();

    // 4. Telegram.
    let telegramLink: string | null = null;
    if (telegram && /^\d+$/.test(telegram)) {
      await admin
        .from("user_telegram")
        .upsert({ user_id: userId, chat_id: Number(telegram), username: null, linked_at: new Date().toISOString() }, { onConflict: "user_id" });
    }
    if (telegramConfigured()) {
      const bot = await botUsername();
      if (bot) {
        const token = randomBytes(24).toString("hex");
        const { error } = await admin
          .from("telegram_link_tokens")
          .insert({ token, user_id: userId, expires_at: new Date(Date.now() + 14 * 864e5).toISOString() });
        if (!error) telegramLink = `https://t.me/${bot}?start=${token}`;
      }
    }

    // 5. Welcome email with a set-password link.
    const base = appUrl(request.nextUrl.origin);
    let signInLink: string | null = null;
    const { data: link } = await admin.auth.admin
      .generateLink({ type: "recovery", email, options: { redirectTo: `${base}/welcome` } })
      .catch(() => ({ data: null }) as any);
    signInLink = link?.properties?.action_link || null;
    let emailed = false;
    if (mailConfigured() && signInLink) {
      const lines = [
        `Hi ${name.split(" ")[0]}, you've been added to BusyBee as ${role}.`,
        ``,
        `Set your password: ${signInLink}`,
        telegramLink ? `Get alerts on Telegram: ${telegramLink}` : "",
        `Open BusyBee: ${base}`,
      ].filter((l) => l !== "");
      const html = `<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;line-height:1.5">
<p>Hi ${esc(name.split(" ")[0])}, you've been added to <b>BusyBee</b> as ${role}.</p>
<p><a href="${esc(signInLink)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600">Set your password</a></p>
${telegramLink ? `<p><a href="${esc(telegramLink)}">Get alerts on Telegram</a> (tap, then Start)</p>` : ""}
</div>`;
      emailed = await deliver([email], "You're on BusyBee", lines.join("\n"), html).catch(() => false);
    }

    await logActivity(supabase, {
      entity_type: "desk",
      entity_id: mine.desk_id,
      action: `added ${name} as ${role}`,
      performed_by: user.id,
      desk_id: mine.desk_id,
      changes: { user_id: userId, role },
    });

    return NextResponse.json({
      ok: true,
      person: { id: userId, name, email, role },
      created,
      emailed,
      // For the adder to share by hand if email isn't set up.
      sign_in_link: emailed ? null : signInLink,
      telegram_link: telegramLink,
    });
  } catch (error: any) {
    console.error("POST /api/team/add failed:", error);
    return NextResponse.json({ error: error?.message || "Could not add the person" }, { status: 500 });
  }
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
