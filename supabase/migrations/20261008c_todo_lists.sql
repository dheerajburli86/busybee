-- BusyBee: to-do lists. A list is an ordinary task (so it gets the deadline
-- agreement, reminders, review and payroll like any other) whose items are
-- its subtasks; this flag lets the To-Do page find them. Safe to re-run.
alter table public.tasks add column if not exists is_list boolean not null default false;
create index if not exists tasks_is_list_idx on public.tasks (desk_id) where is_list;
