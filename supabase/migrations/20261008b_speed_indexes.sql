-- BusyBee: indexes for lookups the app makes on every task it opens.
-- Safe to run more than once.
create index if not exists subtasks_task_idx on public.subtasks (task_id);
create index if not exists subtasks_assigned_idx on public.subtasks (assigned_to);
create index if not exists projects_manager_idx on public.projects (manager_id);
