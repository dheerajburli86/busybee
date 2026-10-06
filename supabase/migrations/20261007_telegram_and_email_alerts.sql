-- Alerts by email AND Telegram, alongside the in-app bell.
--
-- The brief: every alert reaches people on email and on their phone. WhatsApp
-- was swapped for Telegram because Telegram's bot API is free with no
-- per-message charge.
--
-- What this adds:
--   1. user_telegram           which Telegram chat belongs to which person
--   2. telegram_link_tokens    one-time links that connect a chat to a person
--   3. notification_prefs      a Telegram on/off switch next to the email one
--   4. bb_alert_targets()      the one lookup every sender uses: email,
--                              Telegram chat and preferences for desk-mates
--   5. bb_telegram_new_token() / bb_telegram_link()   the connect handshake
--   6. scheduler_sent          stops a muted bell causing repeat reminders
--
-- Telegram never lets a bot message someone first, so a chat id cannot be
-- typed in by an admin: each person taps "Connect Telegram" once in Settings,
-- presses Start in Telegram, and from then on is linked.
--
-- Idempotent: safe to run more than once. Run it in the Supabase SQL editor.

begin;

-- ---------------------------------------------------------------------------
-- 1. Linked chats
-- ---------------------------------------------------------------------------
create table if not exists public.user_telegram (
  user_id    uuid primary key references public.users(id) on delete cascade,
  chat_id    bigint not null,
  username   text,
  linked_at  timestamptz not null default now()
);

alter table public.user_telegram enable row level security;

-- A person can see and remove their own link. Nobody writes one directly:
-- links are only ever made by bb_telegram_link() below, after the person has
-- proved it is their Telegram by pressing Start on a one-time link.
drop policy if exists user_telegram_own_read on public.user_telegram;
create policy user_telegram_own_read on public.user_telegram
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists user_telegram_own_delete on public.user_telegram;
create policy user_telegram_own_delete on public.user_telegram
  for delete to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 2. One-time connect links (valid 30 minutes, used once)
-- ---------------------------------------------------------------------------
create table if not exists public.telegram_link_tokens (
  token      text primary key,
  user_id    uuid not null references public.users(id) on delete cascade,
  expires_at timestamptz not null
);

-- RLS on with no policies: only the security-definer functions below touch it.
alter table public.telegram_link_tokens enable row level security;

-- ---------------------------------------------------------------------------
-- 3. Preferences: a Telegram master switch. Per-category Telegram choices
--    live inside the existing `categories` json, next to in_app and email.
-- ---------------------------------------------------------------------------
create table if not exists public.notification_prefs (
  user_id uuid primary key,
  email_enabled boolean not null default true,
  categories jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.notification_prefs enable row level security;
do $$ begin
  create policy bb_notification_prefs_own on public.notification_prefs
    for all using (user_id = auth.uid())
    with check (user_id = auth.uid());
exception when duplicate_object then null; end $$;

alter table public.notification_prefs
  add column if not exists telegram_enabled boolean not null default true;

-- ---------------------------------------------------------------------------
-- 4. Who to alert, and how.
--
--    The app sends alerts while signed in as the person who did something,
--    and that person can only read their OWN notification_prefs row. Before
--    this function, everyone else's preferences silently read as "everything
--    on", so muting a category in Settings did nothing for alerts sent by the
--    app. The server now looks them up with the service key instead.
-- ---------------------------------------------------------------------------
create or replace function public.bb_alert_targets(p_users uuid[])
returns table (
  user_id          uuid,
  email            text,
  telegram_chat_id bigint,
  email_enabled    boolean,
  telegram_enabled boolean,
  categories       jsonb
)
language sql
security definer
set search_path = public
stable
as $$
  select u.id,
         u.email,
         ut.chat_id,
         coalesce(np.email_enabled, true),
         coalesce(np.telegram_enabled, true),
         coalesce(np.categories, '{}'::jsonb)
    from public.users u
    left join public.user_telegram ut on ut.user_id = u.id
    left join public.notification_prefs np on np.user_id = u.id
   where u.id = any(p_users);
$$;

-- Server only (the app's service key). Not callable from a browser, so
-- nobody can read a colleague's settings or Telegram chat.
revoke all on function public.bb_alert_targets(uuid[]) from public, anon, authenticated;
grant execute on function public.bb_alert_targets(uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- 5. The connect handshake
--
--    Settings asks for a token (signed in), opens t.me/<bot>?start=<token>,
--    the person presses Start, Telegram calls our webhook with the token and
--    their chat id, and the webhook - having checked Telegram's secret header
--    - calls bb_telegram_link() with the service key. Only the server can call
--    it, so nobody can attach a chat id of their choosing to their account:
--    the chat id always comes from Telegram itself. A token is two random
--    UUIDs (~244 bits), single use, and expires after 30 minutes.
-- ---------------------------------------------------------------------------
create or replace function public.bb_telegram_new_token()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  t  text;
begin
  if me is null then
    raise exception 'Sign in first.';
  end if;
  delete from public.telegram_link_tokens where user_id = me or expires_at < now();
  t := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.telegram_link_tokens (token, user_id, expires_at)
  values (t, me, now() + interval '30 minutes');
  return t;
end $$;

revoke all on function public.bb_telegram_new_token() from public, anon;
grant execute on function public.bb_telegram_new_token() to authenticated;

-- Returns the person's name on success, null if the link is unknown or expired.
create or replace function public.bb_telegram_link(p_token text, p_chat bigint, p_username text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  who  uuid;
  name text;
begin
  if p_token is null or length(p_token) < 32 or p_chat is null then
    return null;
  end if;

  delete from public.telegram_link_tokens
   where token = p_token and expires_at > now()
  returning user_id into who;

  if who is null then
    return null;
  end if;

  insert into public.user_telegram (user_id, chat_id, username, linked_at)
  values (who, p_chat, nullif(btrim(coalesce(p_username, '')), ''), now())
  on conflict (user_id) do update
     set chat_id = excluded.chat_id,
         username = excluded.username,
         linked_at = now();

  select coalesce(nullif(u.full_name, ''), u.email) into name from public.users u where u.id = who;
  return coalesce(name, 'there');
end $$;

revoke all on function public.bb_telegram_link(text, bigint, text) from public, anon, authenticated;
grant execute on function public.bb_telegram_link(text, bigint, text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. What the scheduler has already sent
--
--    The scheduler decides "has this reminder gone out?" by looking for the
--    bell notification. Someone who switches the bell off for reminders but
--    keeps email or Telegram on would have no such row, and would be sent the
--    same reminder every ten minutes. The scheduler now records each send
--    here too, whatever the person's settings. Service key only.
-- ---------------------------------------------------------------------------
create table if not exists public.scheduler_sent (
  task_id uuid not null,
  marker  text not null,
  sent_at timestamptz not null default now(),
  primary key (task_id, marker)
);
alter table public.scheduler_sent enable row level security;

commit;

-- ---------------------------------------------------------------------------
-- Check it landed:
--
--   select count(*) from user_telegram;
--   select column_name from information_schema.columns
--    where table_name = 'notification_prefs' and column_name = 'telegram_enabled';
-- ---------------------------------------------------------------------------
