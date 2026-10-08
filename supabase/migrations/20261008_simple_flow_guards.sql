-- BusyBee 2026-10-08: database guards for the simplified assignment flow.
-- Safe to run more than once.
--
-- 1. A project's "manager" members can review and close its tasks. The app
--    already treats them as managers; the database didn't, so their review
--    failed with an error.
-- 2. Approved work stays approved: the person who did it can't reopen a
--    closed task (a reward or penalty may already hang off it). A supervisor
--    or the assignor still can.

begin;

-- 1 ---------------------------------------------------------------------------
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
    if to_regclass('public.project_members') is not null then
      execute 'select exists (select 1 from public.project_members where project_id = $1 and user_id = $2 and role = ''manager'')'
        into found_it using (t->>'project_id')::uuid, p_user;
      if found_it then
        return true;
      end if;
    end if;
  end if;
  if to_regclass('public.task_assignors') is not null then
    execute 'select exists (select 1 from public.task_assignors where task_id = $1 and user_id = $2)'
      into found_it using p_task.id, p_user;
    if found_it then
      return true;
    end if;
  end if;
  return false;
end $$;

-- 2 ---------------------------------------------------------------------------
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

  -- Approved work stays approved unless someone with authority reopens it.
  if old.status = 'closed' and new.status is distinct from 'closed'
     and (not public.bb_task_can_manage(new, me) or public.bb_task_is_worker(new, me)) then
    raise exception 'This was approved and closed. Ask your supervisor to reopen it.';
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

commit;
