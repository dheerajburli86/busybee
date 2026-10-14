-- Who wrote a hidden row on someone else's behalf (an admin's "delete for
-- everyone"), so that admin's Undo can bring it back for everyone.
alter table public.task_hidden add column if not exists hidden_by uuid references public.users(id) on delete set null;
create index if not exists task_hidden_by_idx on public.task_hidden (hidden_by) where hidden_by is not null;
notify pgrst, 'reload schema';
