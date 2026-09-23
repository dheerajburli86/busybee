-- Fix display names for the six team members.
--
-- Why names show as "shankar.sharma": every screen renders
-- `users.full_name || users.email`. When full_name is NULL the app falls back
-- to the email address. Nothing in the UI derives a name from an email on
-- purpose -- the column is simply empty. Filling it in fixes every screen at
-- once (tasks, dashboard, chat, reports, mentions).
--
-- Run this in the Supabase SQL editor.

-- ---------------------------------------------------------------------------
-- STEP 1 - look at what is there now. Run this on its own first.
-- ---------------------------------------------------------------------------
select id, email, full_name
from public.users
order by email;

-- ---------------------------------------------------------------------------
-- STEP 2 - set the proper names.
--
-- Matches on the part of the email before the "@", case-insensitive, so it
-- works whether the address is shankar@..., shankar.sharma@... or
-- shankar_sharma@... If someone's address does not start with their first
-- name, edit that row's pattern before running.
-- ---------------------------------------------------------------------------
update public.users u
set full_name = v.full_name
from (values
  ('shankar%', 'Shankar Sharma'),
  ('achin%',   'Achin Agarwal'),
  ('alok%',    'Alok Kumar'),
  ('shlok%',   'Shlok Rathod'),
  ('diptam%',  'Diptam Paul'),
  ('dheeraj%', 'Dheeraj Burli')
) as v(pattern, full_name)
where lower(u.email) like v.pattern;

-- ---------------------------------------------------------------------------
-- STEP 3 - keep Supabase Auth metadata in step, so a fresh sign-in or any
-- code reading user_metadata.name agrees with public.users.
-- ---------------------------------------------------------------------------
update auth.users a
set raw_user_meta_data =
      coalesce(a.raw_user_meta_data, '{}'::jsonb)
      || jsonb_build_object('name', u.full_name, 'full_name', u.full_name)
from public.users u
where u.id = a.id
  and u.full_name is not null
  and u.full_name <> '';

-- ---------------------------------------------------------------------------
-- STEP 4 - confirm. Every row should now show a proper name.
-- ---------------------------------------------------------------------------
select email, full_name
from public.users
order by full_name;

-- ---------------------------------------------------------------------------
-- If any row still shows an empty full_name, set it by hand, e.g.:
--   update public.users set full_name = 'Shankar Sharma'
--   where email = 'the.exact.address@yourdomain.com';
-- ---------------------------------------------------------------------------
