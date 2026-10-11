-- BusyBee as a phone app: pop-up notifications (Web Push).
--
-- push_subscriptions: one row per phone, tablet or browser that turned
-- notifications on. People can see and remove their own devices and nothing
-- else; the server (service key) reads them to send the pop-ups.
--
-- app_secrets: the server's Web Push key pair. The web app creates it the
-- first time anyone turns notifications on. RLS is on with no policies, so
-- only the service key (the web app's server and the scheduler) can read it.
--
-- Safe to run more than once.

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  device text,
  user_agent text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  last_error text
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;

drop policy if exists push_subscriptions_select_own on public.push_subscriptions;
create policy push_subscriptions_select_own on public.push_subscriptions
  for select to authenticated using (user_id = auth.uid());
drop policy if exists push_subscriptions_delete_own on public.push_subscriptions;
create policy push_subscriptions_delete_own on public.push_subscriptions
  for delete to authenticated using (user_id = auth.uid());
-- Adding or changing a device goes through bb_push_subscribe() below.
revoke all on public.push_subscriptions from anon;
revoke insert, update on public.push_subscriptions from authenticated;

-- Save this device for whoever is signed in on it. A phone someone else used
-- before moves to the person signed in now. Only real push services are
-- accepted (Google, Apple, Mozilla, Microsoft), so the server never posts
-- anywhere else. Keeps each person's 10 most recent devices.
create or replace function public.bb_push_subscribe(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_device text default null,
  p_user_agent text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  rid uuid;
begin
  if me is null then
    raise exception 'not signed in';
  end if;
  if p_endpoint is null or length(p_endpoint) > 2000
     or p_endpoint !~ '^https://([a-z0-9-]+\.)*(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)(:[0-9]+)?/' then
    raise exception 'unsupported push service';
  end if;
  if coalesce(p_p256dh, '') !~ '^[A-Za-z0-9_-]{80,100}={0,2}$' or coalesce(p_auth, '') !~ '^[A-Za-z0-9_-]{16,32}={0,2}$' then
    raise exception 'bad subscription keys';
  end if;

  insert into push_subscriptions (user_id, endpoint, p256dh, auth, device, user_agent)
  values (me, p_endpoint, p_p256dh, p_auth, left(p_device, 60), left(p_user_agent, 400))
  on conflict (endpoint) do update
    set user_id = excluded.user_id,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        device = excluded.device,
        user_agent = excluded.user_agent,
        last_error = null
  returning id into rid;

  delete from push_subscriptions
  where id in (
    select id from push_subscriptions where user_id = me order by created_at desc offset 10
  );
  return rid;
end $$;

revoke all on function public.bb_push_subscribe(text, text, text, text, text) from public, anon;
grant execute on function public.bb_push_subscribe(text, text, text, text, text) to authenticated;

create table if not exists public.app_secrets (
  key text primary key,
  value text not null,
  created_at timestamptz not null default now()
);
alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from anon, authenticated;
