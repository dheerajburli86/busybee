-- Deleted tasks wait 30 days before they are removed for good, so "Undo"
-- can bring them back. A deleted task is also archived (archived_at) so it
-- drops out of every live list, reminder and summary straight away.
alter table public.tasks add column if not exists deleted_at timestamptz;
alter table public.tasks add column if not exists deleted_by uuid references public.users(id) on delete set null;
create index if not exists tasks_deleted_idx on public.tasks (deleted_at) where deleted_at is not null;
