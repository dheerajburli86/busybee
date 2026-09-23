-- BusyBee: closes the last 4 checklist gaps found by the round-2 audit -
-- #19 custom colors, #22 a distinct Project Manager, #46 a document
-- library, #48 notification settings.
--
-- Idempotent and defensive like the previous round's migration: the
-- production schema isn't available to this session, so every change is
-- guarded to be safe on a fresh run, a partial run, or a re-run. Run this
-- in the Supabase SQL editor; it is safe to run more than once.

-- ---------------------------------------------------------------------
-- #19: an optional custom color on tasks and projects (purely cosmetic -
-- nothing reads it for permissions or logic).
-- ---------------------------------------------------------------------
alter table if exists public.tasks add column if not exists color text;
alter table if exists public.projects add column if not exists color text;

-- ---------------------------------------------------------------------
-- #22: a Project Manager, independent of any team. No FK is added (the
-- exact shape of the users table isn't known here); the app validates
-- the id is a desk member before writing it.
-- ---------------------------------------------------------------------
alter table if exists public.projects add column if not exists manager_id uuid;

-- ---------------------------------------------------------------------
-- #46: a standalone document library, separate from per-task attachments.
-- #47: each document's visibility is enforced both in the app
-- (lib/documents.ts) and here in the database, the same belt-and-braces
-- approach the previous round used for private comments and chat rooms.
-- ---------------------------------------------------------------------
create table if not exists public.document_folders (
  id uuid primary key default gen_random_uuid(),
  desk_id uuid not null,
  parent_id uuid references public.document_folders(id) on delete cascade,
  name text not null,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists document_folders_desk_idx on public.document_folders(desk_id);
create index if not exists document_folders_parent_idx on public.document_folders(parent_id);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  desk_id uuid not null,
  folder_id uuid references public.document_folders(id) on delete set null,
  name text not null,
  storage_path text not null,
  file_size bigint,
  file_type text,
  visibility text not null default 'desk' check (visibility in ('desk', 'team', 'department', 'private')),
  team_id uuid,
  department_id uuid,
  uploaded_by uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists documents_desk_idx on public.documents(desk_id);
create index if not exists documents_folder_idx on public.documents(folder_id);
create index if not exists documents_uploaded_by_idx on public.documents(uploaded_by);

-- Mirrors frontend/lib/documents.ts canSeeDocument() so the storage-layer
-- rule can't be bypassed by calling Supabase directly with the anon key.
create or replace function public.bb_can_see_document(p_doc public.documents)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select
    exists (
      select 1 from public.desk_members dm
      where dm.desk_id = p_doc.desk_id and dm.user_id = auth.uid()
        and lower(coalesce(dm.role, '')) in ('admin', 'supervisor', 'owner', 'administrator', 'superadmin', 'super_admin')
    )
    or p_doc.uploaded_by = auth.uid()
    or (
      p_doc.visibility = 'desk'
      and exists (select 1 from public.desk_members dm where dm.desk_id = p_doc.desk_id and dm.user_id = auth.uid())
    )
    or (
      p_doc.visibility = 'team' and p_doc.team_id is not null
      and exists (select 1 from public.team_members tm where tm.team_id = p_doc.team_id and tm.user_id = auth.uid())
    )
    or (
      p_doc.visibility = 'department' and p_doc.department_id is not null
      and exists (
        select 1 from public.team_members tm
        join public.teams t on t.id = tm.team_id
        where t.department_id = p_doc.department_id and tm.user_id = auth.uid()
      )
    );
$$;

alter table public.document_folders enable row level security;
alter table public.documents enable row level security;

do $$ begin
  create policy bb_document_folders_desk on public.document_folders
    for select using (
      exists (select 1 from public.desk_members dm where dm.desk_id = document_folders.desk_id and dm.user_id = auth.uid())
    );
exception when duplicate_object then null; end $$;

do $$ begin
  create policy bb_document_folders_write on public.document_folders
    for all using (
      exists (select 1 from public.desk_members dm where dm.desk_id = document_folders.desk_id and dm.user_id = auth.uid())
    )
    with check (
      exists (select 1 from public.desk_members dm where dm.desk_id = document_folders.desk_id and dm.user_id = auth.uid())
    );
exception when duplicate_object then null; end $$;

do $$ begin
  create policy bb_documents_select on public.documents
    for select using (public.bb_can_see_document(documents));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy bb_documents_insert on public.documents
    for insert with check (
      exists (select 1 from public.desk_members dm where dm.desk_id = documents.desk_id and dm.user_id = auth.uid())
      and uploaded_by = auth.uid()
    );
exception when duplicate_object then null; end $$;

do $$ begin
  create policy bb_documents_update on public.documents
    for update using (
      uploaded_by = auth.uid()
      or exists (
        select 1 from public.desk_members dm
        where dm.desk_id = documents.desk_id and dm.user_id = auth.uid()
          and lower(coalesce(dm.role, '')) in ('admin', 'supervisor', 'owner', 'administrator', 'superadmin', 'super_admin')
      )
    );
exception when duplicate_object then null; end $$;

do $$ begin
  create policy bb_documents_delete on public.documents
    for delete using (
      uploaded_by = auth.uid()
      or exists (
        select 1 from public.desk_members dm
        where dm.desk_id = documents.desk_id and dm.user_id = auth.uid()
          and lower(coalesce(dm.role, '')) in ('admin', 'supervisor', 'owner', 'administrator', 'superadmin', 'super_admin')
      )
    );
exception when duplicate_object then null; end $$;

-- Private storage bucket, mirroring "task-files". Uploads/downloads go
-- through signed URLs minted by the API (see app/api/documents/**), never
-- a public URL.
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

do $$ begin
  create policy bb_documents_bucket_rw on storage.objects
    for all using (bucket_id = 'documents' and auth.uid() is not null)
    with check (bucket_id = 'documents' and auth.uid() is not null);
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- #48: per-person notification preferences. One row per user; a missing
-- row means "everything on" (see frontend/lib/notifications.ts
-- defaultPrefs()), so nobody's notifications change until they visit the
-- settings page.
-- ---------------------------------------------------------------------
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

-- The scheduler reads this table with the service key (bypasses RLS by
-- design, same as every other table it reads) to decide whether to write
-- a reminder/summary notification or send its email - see scheduler/main.py
-- _prefs_for() / _wants().
