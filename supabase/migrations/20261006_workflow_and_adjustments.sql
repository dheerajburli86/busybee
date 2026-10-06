-- Assignment workflow: deadline acceptance, supervisor review, and the
-- rupee reward/penalty ledger.
--
-- This completes the task lifecycle the business actually runs on:
--
--   assign -> ACCEPT THE DEADLINE -> work (daily reminders) -> done
--          -> SUPERVISOR REVIEW -> optional REWARD / PENALTY in rupees
--
-- Three of those steps had no home in the database before this migration.
-- The extension-request half of the negotiation (ask for more time, approve
-- with a different date, reject) already exists in extension_requests and is
-- left completely untouched - acceptance sits *before* it, not instead of it.
--
-- Idempotent and defensive like every migration before it: every table is
-- created with `if not exists`, every column added with
-- `add column if not exists`, every policy dropped before it is created. Safe
-- to run more than once. Run it in the Supabase SQL editor.

begin;

-- ---------------------------------------------------------------------------
-- 1. Helper: which desk does a task sit on?
--
--    The two new tables carry their own desk_id (denormalised, exactly like
--    milestones and team_members do) so that row-level security never has to
--    join back to tasks. This helper is only used to BACKFILL that column and
--    to keep it honest with a trigger, not inside any policy.
-- ---------------------------------------------------------------------------
-- Desk membership helpers. An earlier (since archived) teams migration may
-- already have created these; same definitions, so replacing is harmless.
create or replace function public.bb_is_desk_admin(p_desk uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.desk_members dm
    where dm.desk_id = p_desk and dm.user_id = auth.uid()
      and lower(coalesce(dm.role, '')) in ('admin', 'supervisor', 'owner', 'administrator', 'superadmin', 'super_admin')
  );
$$;

create or replace function public.bb_is_desk_member(p_desk uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.desk_members dm
    where dm.desk_id = p_desk and dm.user_id = auth.uid()
  );
$$;

create or replace function public.bb_task_desk(p_task uuid)
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select t.desk_id from public.tasks t where t.id = p_task;
$$;

-- ---------------------------------------------------------------------------
-- 2. Supervisor review (step 9 of the flow)
--
--    Lives on tasks itself rather than in its own table: a task has exactly
--    one review outcome at a time, and the dashboard needs to filter on it
--    without a join. "Sent back" deliberately does NOT reopen the task's
--    status automatically - the API does that, so the history records who
--    reopened it and why.
--
--      not_required  work that never needs signing off (personal to-dos)
--      pending       finished, waiting for a supervisor
--      approved      signed off
--      sent_back     rejected with a note; back to the assignee
-- ---------------------------------------------------------------------------
-- The review rules below exempt private to-dos. `personal` has been on tasks
-- since the My To-Do feature; this only guards an older copy without it.
alter table public.tasks add column if not exists personal boolean default false;
alter table public.tasks add column if not exists completed_at timestamptz;

alter table public.tasks add column if not exists review_status text;
alter table public.tasks add column if not exists review_note   text;
alter table public.tasks add column if not exists reviewed_by    uuid;
alter table public.tasks add column if not exists reviewed_at    timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tasks_review_status_check'
  ) then
    alter table public.tasks
      add constraint tasks_review_status_check
      check (review_status is null or review_status in ('not_required', 'pending', 'approved', 'sent_back'));
  end if;
exception when others then
  -- An older copy with unexpected values in the column: leave it unconstrained
  -- rather than failing the whole migration.
  null;
end $$;

do $$
begin
  alter table public.tasks
    add constraint tasks_reviewed_by_fkey
    foreign key (reviewed_by) references public.users(id) on delete set null;
exception when duplicate_object then null;
  when others then null;
end $$;

create index if not exists tasks_review_status_idx
  on public.tasks (desk_id, review_status)
  where review_status in ('pending', 'sent_back');

-- ---------------------------------------------------------------------------
-- 3. Deadline acceptance (step 4 of the flow)
--
--    One row per person per task. A task handed to a team needs an acceptance
--    from each member, which is why this is a table and not a column: the
--    assignor can see exactly who has signed up to the date and who has not.
--
--    Declining is recorded here too, but declining is not a veto - it is the
--    trigger for an extension request, which carries the proposed new date.
-- ---------------------------------------------------------------------------
create table if not exists public.task_acceptances (
  task_id     uuid not null references public.tasks(id) on delete cascade,
  user_id     uuid not null references public.users(id) on delete cascade,
  desk_id     uuid,
  decision    text not null default 'accepted',
  note        text,
  due_date_at_decision timestamptz,
  created_at  timestamptz not null default now(),
  primary key (task_id, user_id)
);

alter table public.task_acceptances add column if not exists desk_id    uuid;
alter table public.task_acceptances add column if not exists decision   text;
alter table public.task_acceptances add column if not exists note       text;
alter table public.task_acceptances add column if not exists due_date_at_decision timestamptz;
alter table public.task_acceptances add column if not exists created_at timestamptz default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'task_acceptances_decision_check') then
    alter table public.task_acceptances
      add constraint task_acceptances_decision_check
      check (decision in ('accepted', 'declined'));
  end if;
exception when others then null;
end $$;

update public.task_acceptances
   set desk_id = public.bb_task_desk(task_id)
 where desk_id is null;

create index if not exists task_acceptances_task_idx on public.task_acceptances (task_id);
create index if not exists task_acceptances_user_idx on public.task_acceptances (user_id);

-- ---------------------------------------------------------------------------
-- 4. Rupee reward / penalty ledger (steps 10-11 of the flow)
--
--    Append-only on purpose. Money that moves someone's pay must leave a
--    trail that cannot be quietly rewritten, so there is no UPDATE path for
--    amount or reason: a mistake is VOIDED (with a reason, by a named person)
--    and a corrected entry is added beside it. Both rows stay visible.
--
--    `amount` is always positive; `kind` carries the direction. Storing a
--    signed amount invites a penalty being entered as a reward by a stray
--    minus sign, and makes every sum in the app depend on getting that right.
--
--    `effective_month` is the payroll month the entry belongs to, which is
--    not always the month it was raised in (a penalty entered on 2 October
--    for September's work belongs to September). It is the first day of that
--    month.
--
--    NOTE: nothing here touches payroll by itself. This is a record that
--    finance reads and applies - see /api/payroll.
-- ---------------------------------------------------------------------------
create table if not exists public.task_adjustments (
  id              uuid primary key default gen_random_uuid(),
  task_id         uuid references public.tasks(id) on delete set null,
  desk_id         uuid,
  user_id         uuid not null references public.users(id) on delete cascade,
  kind            text not null,
  amount          numeric(12,2) not null,
  reason          text not null,
  effective_month date not null default date_trunc('month', (now() at time zone 'Asia/Kolkata'))::date,
  created_by      uuid references public.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  voided_at       timestamptz,
  voided_by       uuid references public.users(id) on delete set null,
  void_reason     text
);

alter table public.task_adjustments add column if not exists desk_id         uuid;
alter table public.task_adjustments add column if not exists effective_month date;
alter table public.task_adjustments add column if not exists voided_at       timestamptz;
alter table public.task_adjustments add column if not exists voided_by       uuid;
alter table public.task_adjustments add column if not exists void_reason     text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'task_adjustments_kind_check') then
    alter table public.task_adjustments
      add constraint task_adjustments_kind_check check (kind in ('reward', 'penalty'));
  end if;
exception when others then null;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'task_adjustments_amount_check') then
    alter table public.task_adjustments
      add constraint task_adjustments_amount_check check (amount > 0);
  end if;
exception when others then null;
end $$;

update public.task_adjustments
   set desk_id = public.bb_task_desk(task_id)
 where desk_id is null and task_id is not null;

create index if not exists task_adjustments_user_month_idx
  on public.task_adjustments (user_id, effective_month);
create index if not exists task_adjustments_desk_month_idx
  on public.task_adjustments (desk_id, effective_month);
create index if not exists task_adjustments_task_idx
  on public.task_adjustments (task_id);

-- ---------------------------------------------------------------------------
-- 5. Keep desk_id honest
--
--    Both tables are written through the API, which fills desk_id in - but a
--    row inserted by hand (or by a future route that forgets) would otherwise
--    be invisible to every policy below, which is a silent data-loss bug
--    rather than an error. The trigger fills it from the task.
-- ---------------------------------------------------------------------------
create or replace function public.bb_fill_desk_from_task()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.desk_id is null and new.task_id is not null then
    new.desk_id := public.bb_task_desk(new.task_id);
  end if;
  return new;
end $$;

drop trigger if exists bb_task_acceptances_desk on public.task_acceptances;
create trigger bb_task_acceptances_desk
  before insert or update on public.task_acceptances
  for each row execute function public.bb_fill_desk_from_task();

-- task_adjustments gets a stricter insert check of its own (section 6b), which
-- also fills desk_id. Remove the generic one if an earlier run created it.
drop trigger if exists bb_task_adjustments_desk on public.task_adjustments;

-- ---------------------------------------------------------------------------
-- 6. Row-level security
--
--    Acceptances are not sensitive: anyone on the desk may read who has
--    accepted what (the assignor needs exactly this), but a person may only
--    write their OWN acceptance. Nobody accepts a deadline on someone's
--    behalf.
--
--    Adjustments ARE sensitive - they are pay. A person sees their own
--    entries and nobody else's; supervisors and admins see their desk's and
--    are the only ones who may write. That asymmetry is the whole point: a
--    team member must be able to check what was levied against them without
--    being able to see a colleague's pay or change their own record.
-- ---------------------------------------------------------------------------
alter table public.task_acceptances enable row level security;
alter table public.task_adjustments enable row level security;

-- task_acceptances --------------------------------------------------------
drop policy if exists task_acceptances_read on public.task_acceptances;
create policy task_acceptances_read on public.task_acceptances
  for select to authenticated
  using (user_id = auth.uid() or public.bb_is_desk_member(desk_id));

drop policy if exists task_acceptances_write on public.task_acceptances;
create policy task_acceptances_write on public.task_acceptances
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.bb_is_desk_member(desk_id));

-- task_adjustments --------------------------------------------------------
drop policy if exists task_adjustments_read on public.task_adjustments;
create policy task_adjustments_read on public.task_adjustments
  for select to authenticated
  using (user_id = auth.uid() or public.bb_is_desk_admin(desk_id));

-- Writes are split by operation so the ledger is append-only in the database
-- itself, not just in the API. A supervisor holding the anon key and their
-- own session could otherwise UPDATE an amount or DELETE a row straight from
-- the browser console.
--
--   insert  supervisors/admins, recorded as themselves, never against themselves
--   update  supervisors/admins, and the trigger below only lets a void through
--   delete  no policy at all, so nobody can delete through the API
drop policy if exists task_adjustments_write  on public.task_adjustments;
drop policy if exists task_adjustments_insert on public.task_adjustments;
drop policy if exists task_adjustments_void   on public.task_adjustments;

create policy task_adjustments_insert on public.task_adjustments
  for insert to authenticated
  with check (
    public.bb_is_desk_admin(desk_id)
    and created_by = auth.uid()
    and user_id <> auth.uid()
    and voided_at is null
  );

create policy task_adjustments_void on public.task_adjustments
  for update to authenticated
  using (public.bb_is_desk_admin(desk_id) and user_id <> auth.uid())
  with check (public.bb_is_desk_admin(desk_id) and user_id <> auth.uid());

-- The lock. Once written, who / what / how much / why / which task / which
-- month can never change. The only permitted change is voiding an entry that
-- is not already void, with a reason, stamped with the voider and the time.
-- Runs for every role except the database owner working in the SQL editor
-- (auth.uid() is null there), which is the deliberate escape hatch for a
-- genuine data repair - and leaves its own trace in Postgres logs.
create or replace function public.bb_lock_adjustment()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  -- The task the entry hangs off is being deleted (task_id is ON DELETE SET
  -- NULL). Refuse, so the entry keeps pointing at the work it was for.
  if old.task_id is not null and new.task_id is null then
    raise exception 'This task has reward or penalty entries against it, so it cannot be deleted. Archive it instead.';
  end if;

  if new.task_id         is distinct from old.task_id
  or new.desk_id         is distinct from old.desk_id
  or new.user_id         is distinct from old.user_id
  or new.kind            is distinct from old.kind
  or new.amount          is distinct from old.amount
  or new.reason          is distinct from old.reason
  or new.effective_month is distinct from old.effective_month
  or new.created_by      is distinct from old.created_by
  or new.created_at      is distinct from old.created_at then
    raise exception 'Reward and penalty entries cannot be edited. Void it and record a new one.';
  end if;

  if old.voided_at is not null then
    raise exception 'This entry is already void and cannot be changed.';
  end if;

  if new.voided_at is null then
    raise exception 'The only change allowed on an entry is voiding it.';
  end if;

  if coalesce(btrim(new.void_reason), '') = '' then
    raise exception 'A reason is required to void an entry.';
  end if;

  new.voided_by := auth.uid();
  new.voided_at := now();
  return new;
end $$;

drop trigger if exists bb_task_adjustments_lock on public.task_adjustments;
create trigger bb_task_adjustments_lock
  before update on public.task_adjustments
  for each row execute function public.bb_lock_adjustment();

-- Belt and braces: deletes are refused even if a delete policy is ever added
-- by mistake. The SQL editor (no auth.uid()) can still repair data.
create or replace function public.bb_no_delete_adjustment()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is not null then
    raise exception 'Reward and penalty entries cannot be deleted. Void it instead.';
  end if;
  return old;
end $$;

drop trigger if exists bb_task_adjustments_no_delete on public.task_adjustments;
create trigger bb_task_adjustments_no_delete
  before delete on public.task_adjustments
  for each row execute function public.bb_no_delete_adjustment();

-- ---------------------------------------------------------------------------
-- 6b. What a new reward/penalty entry may say
--
--    RLS above decides WHO may insert. This decides WHAT they may insert, so
--    the API's rules hold even for someone writing straight from a browser
--    console with their own session:
--      * it hangs off a real task, and its desk is that task's desk
--      * not a private to-do
--      * the work is finished, or its deadline has passed
--      * the person it applies to is on that desk
--      * who recorded it and when are stamped by the database, not supplied
--      * the payroll month is a real month start, no more than six months
--        back and no later than next month
--    The SQL editor (no logged-in user) is left alone for genuine repairs.
-- ---------------------------------------------------------------------------
create or replace function public.bb_check_adjustment_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  t record;
  this_month date := date_trunc('month', (now() at time zone 'Asia/Kolkata'))::date;
begin
  if auth.uid() is null then
    if new.desk_id is null and new.task_id is not null then
      new.desk_id := public.bb_task_desk(new.task_id);
    end if;
    return new;
  end if;

  if new.task_id is null then
    raise exception 'A reward or penalty has to be recorded against a task.';
  end if;

  select id, desk_id, status, due_date, coalesce(personal, false) as personal
    into t from public.tasks where id = new.task_id;
  if not found then
    raise exception 'That task does not exist.';
  end if;

  new.desk_id := t.desk_id;

  if t.personal then
    raise exception 'Private to-dos cannot carry a reward or penalty.';
  end if;
  if not (t.status in ('done', 'closed') or (t.due_date is not null and t.due_date < now())) then
    raise exception 'A reward or penalty can be recorded once the work is finished or its deadline has passed.';
  end if;
  if not exists (
    select 1 from public.desk_members dm where dm.desk_id = t.desk_id and dm.user_id = new.user_id
  ) then
    raise exception 'That person is not on this desk.';
  end if;

  new.created_by  := auth.uid();
  new.created_at  := now();
  new.voided_at   := null;
  new.voided_by   := null;
  new.void_reason := null;

  new.effective_month := date_trunc('month', coalesce(new.effective_month, this_month))::date;
  if new.effective_month < (this_month - interval '6 months')::date
     or new.effective_month > (this_month + interval '1 month')::date then
    raise exception 'The payroll month must be within the last six months.';
  end if;

  if coalesce(btrim(new.reason), '') = '' then
    raise exception 'A reason is required.';
  end if;

  return new;
end $$;

drop trigger if exists bb_task_adjustments_check on public.task_adjustments;
create trigger bb_task_adjustments_check
  before insert on public.task_adjustments
  for each row execute function public.bb_check_adjustment_insert();

-- A person's ledger outlives their account. Deleting a user must not quietly
-- take their pay history with it (the default cascade would, and a cascade
-- runs with no logged-in user, so the no-delete trigger would let it pass).
do $$
begin
  alter table public.task_adjustments drop constraint if exists task_adjustments_user_id_fkey;
  alter table public.task_adjustments
    add constraint task_adjustments_user_id_fkey
    foreign key (user_id) references public.users(id) on delete restrict;
exception when others then
  raise notice 'task_adjustments.user_id FK not changed: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- 6c. The review gate on tasks
--
--    The API refuses to let anyone close their own work, but the tasks table
--    is writable from the browser with the same session the API uses. So the
--    gate lives here too:
--      * finishing work ("done") always puts it in the review queue
--      * closing it, or recording approved / sent back, can only be done by
--        someone who manages the task and did not work on it
--      * the reviewer and the time are stamped by the database
--      * a new task can't be created already finished, or already reviewed
--    Private to-dos are exempt. The scheduler and SQL editor (no logged-in
--    user) are exempt.
-- ---------------------------------------------------------------------------
create or replace function public.bb_task_is_worker(p_task public.tasks, p_user uuid)
returns boolean
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  t jsonb := to_jsonb(p_task);
  found_it boolean := false;
begin
  if (t->>'assigned_to')::uuid = p_user then
    return true;
  end if;
  -- Older databases still carry tasks.team_id and team_members from before
  -- project-based access. Count them only where they exist.
  if t ? 'team_id' and t->>'team_id' is not null and to_regclass('public.team_members') is not null then
    execute 'select exists (select 1 from public.team_members where team_id = $1 and user_id = $2)'
      into found_it using (t->>'team_id')::uuid, p_user;
    if found_it then
      return true;
    end if;
  end if;
  if exists (
    select 1 from public.subtasks s where s.task_id = p_task.id and s.assigned_to = p_user
  ) then
    return true;
  end if;
  return false;
end $$;

create or replace function public.bb_task_can_manage(p_task public.tasks, p_user uuid)
returns boolean
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  t jsonb := to_jsonb(p_task);
  found_it boolean := false;
begin
  if public.bb_is_desk_admin(p_task.desk_id) then
    return true;
  end if;
  if (t->>'created_by')::uuid = p_user or (t->>'task_manager_id')::uuid = p_user then
    return true;
  end if;
  if t->>'project_id' is not null then
    execute 'select exists (select 1 from public.projects where id = $1 and manager_id = $2)'
      into found_it using (t->>'project_id')::uuid, p_user;
    if found_it then
      return true;
    end if;
  end if;
  -- Extra assignors, where that table exists.
  if to_regclass('public.task_assignors') is not null then
    execute 'select exists (select 1 from public.task_assignors where task_id = $1 and user_id = $2)'
      into found_it using p_task.id, p_user;
    if found_it then
      return true;
    end if;
  end if;
  return false;
end $$;

create or replace function public.bb_guard_review()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  reviewing boolean;
begin
  if me is null or coalesce(new.personal, false) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status in ('done', 'closed') then
      new.status := 'pending';
      new.completed_at := null;
    end if;
    new.review_status := null;
    new.review_note := null;
    new.reviewed_by := null;
    new.reviewed_at := null;
    return new;
  end if;

  -- Finished work joins the queue, and stays in it until someone reviews it.
  if new.status = 'done'
     and (old.status is distinct from 'done' or new.review_status is distinct from old.review_status) then
    new.review_status := 'pending';
    new.reviewed_by := old.reviewed_by;
    new.reviewed_at := old.reviewed_at;
    return new;
  end if;

  reviewing :=
       (new.status = 'closed' and old.status is distinct from 'closed')
    or (new.review_status is distinct from old.review_status
        and new.review_status in ('approved', 'sent_back', 'not_required'))
    or new.reviewed_by is distinct from old.reviewed_by
    or new.reviewed_at is distinct from old.reviewed_at
    or (new.review_note is distinct from old.review_note and new.review_status in ('approved', 'sent_back'));

  if not reviewing then
    return new;
  end if;

  if not public.bb_task_can_manage(new, me) then
    raise exception 'Only the assignor, the project manager or a supervisor can sign off work.';
  end if;
  if public.bb_task_is_worker(new, me) then
    raise exception 'You cannot sign off your own work - someone else has to review it.';
  end if;

  if new.status = 'closed' and coalesce(new.review_status, '') not in ('approved', 'not_required') then
    new.review_status := 'approved';
  end if;
  if new.review_status is distinct from old.review_status
     or (new.status = 'closed' and old.status is distinct from 'closed') then
    new.reviewed_by := me;
    new.reviewed_at := now();
  else
    new.reviewed_by := old.reviewed_by;
    new.reviewed_at := old.reviewed_at;
  end if;
  return new;
end $$;

drop trigger if exists bb_tasks_review_guard on public.tasks;
create trigger bb_tasks_review_guard
  before insert or update on public.tasks
  for each row execute function public.bb_guard_review();

-- ---------------------------------------------------------------------------
-- 7. Backfill
--
--    Tasks that are already finished are marked as needing no review, so the
--    supervisor's queue starts empty instead of filling with months of
--    history nobody is going to sign off retrospectively. Everything closed
--    from here on goes through the real flow.
-- ---------------------------------------------------------------------------
update public.tasks
   set review_status = 'not_required'
 where review_status is null
   and status in ('done', 'closed');

commit;

-- ---------------------------------------------------------------------------
-- Check it landed:
--
--   select column_name from information_schema.columns
--    where table_name = 'tasks' and column_name like 'review%';
--
--   select count(*) from task_acceptances;
--   select count(*) from task_adjustments;
-- ---------------------------------------------------------------------------
