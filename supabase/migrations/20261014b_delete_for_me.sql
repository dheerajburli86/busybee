-- "Delete" only removes a task from the deleter's own view. Everyone else
-- keeps it. One row per (person, task) they've removed; Undo deletes the row.
create table if not exists public.task_hidden (
  user_id uuid not null references public.users(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  hidden_at timestamptz not null default now(),
  primary key (user_id, task_id)
);
create index if not exists task_hidden_task_idx on public.task_hidden (task_id);
alter table public.task_hidden enable row level security;
drop policy if exists task_hidden_own on public.task_hidden;
create policy task_hidden_own on public.task_hidden
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.task_hidden to authenticated;

-- Tasks already deleted for everyone: bring them back for everyone else and
-- keep them gone only for whoever deleted them.
insert into public.task_hidden (user_id, task_id, hidden_at)
  select deleted_by, id, deleted_at from public.tasks
  where deleted_at is not null and deleted_by is not null
  on conflict do nothing;
update public.tasks
  set archived_at = case when archived_at = deleted_at then null else archived_at end,
      deleted_at = null, deleted_by = null
  where deleted_at is not null;

notify pgrst, 'reload schema';
