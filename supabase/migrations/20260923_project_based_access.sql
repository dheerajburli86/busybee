-- Project-based access: replaces teams / departments / custom groups.
--
-- After this, who can see and do what is decided by two things only:
--   projects.manager_id      - the person who runs the project
--   project_members          - the people on the project (role member|manager)
--
-- Safe to run more than once. It does NOT drop the old teams/departments/
-- groups tables: it copies their membership across first, so nobody loses
-- access. Drop them later, once you're happy (the last section shows how).

begin;

-- ---------------------------------------------------------------------------
-- 1. project_members - the table the whole access model now rests on.
-- ---------------------------------------------------------------------------
create table if not exists public.project_members (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role text not null default 'member' check (role in ('member', 'manager')),
  created_at timestamptz not null default now(),
  unique (project_id, user_id)
);

create index if not exists project_members_project_idx on public.project_members(project_id);
create index if not exists project_members_user_idx on public.project_members(user_id);

alter table public.project_members enable row level security;

-- Anyone on the desk that owns the project may read and write its membership;
-- the API layer (app/api/projects/members) applies the finer rule that only a
-- supervisor or the project's manager may add and remove people.
drop policy if exists project_members_all on public.project_members;
create policy project_members_all on public.project_members
  for all to authenticated
  using (
    exists (
      select 1 from public.projects p
      join public.desk_members dm on dm.desk_id = p.desk_id
      where p.id = project_id and dm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.projects p
      join public.desk_members dm on dm.desk_id = p.desk_id
      where p.id = project_id and dm.user_id = auth.uid()
    )
  );

-- projects.manager_id (#22) - already added by 20260922_close_the_gap, kept
-- here so this file stands on its own.
alter table if exists public.projects add column if not exists manager_id uuid;

-- ---------------------------------------------------------------------------
-- 2. Backfill, so the switch-over costs nobody their access.
--    Everyone who could reach a project's work before is made a member of it.
-- ---------------------------------------------------------------------------

-- (a) Whoever was on the team a project was given to.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'projects' and column_name = 'team_id'
  ) then
    insert into public.project_members (project_id, user_id, role)
    select p.id, tm.user_id,
           case when lower(coalesce(tm.role, '')) = 'manager' then 'manager' else 'member' end
    from public.projects p
    join public.team_members tm on tm.team_id = p.team_id
    where p.team_id is not null
    on conflict (project_id, user_id) do nothing;

    -- and whoever managed that team
    insert into public.project_members (project_id, user_id, role)
    select p.id, t.manager_id, 'manager'
    from public.projects p
    join public.teams t on t.id = p.team_id
    where p.team_id is not null and t.manager_id is not null
    on conflict (project_id, user_id) do nothing;
  end if;
end $$;

-- (b) Anyone already doing or running work in the project.
insert into public.project_members (project_id, user_id, role)
select distinct t.project_id, t.assigned_to, 'member'
from public.tasks t
where t.project_id is not null and t.assigned_to is not null
on conflict (project_id, user_id) do nothing;

insert into public.project_members (project_id, user_id, role)
select distinct t.project_id, t.created_by, 'member'
from public.tasks t
where t.project_id is not null and t.created_by is not null
on conflict (project_id, user_id) do nothing;

insert into public.project_members (project_id, user_id, role)
select distinct t.project_id, t.task_manager_id, 'member'
from public.tasks t
where t.project_id is not null and t.task_manager_id is not null
on conflict (project_id, user_id) do nothing;

-- (c) The project's own manager is on it, as a manager.
insert into public.project_members (project_id, user_id, role)
select p.id, p.manager_id, 'manager'
from public.projects p
where p.manager_id is not null
on conflict (project_id, user_id) do update set role = 'manager';

-- ---------------------------------------------------------------------------
-- 3. Chat rooms: per-project instead of per-team / per-department.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'chat_rooms') then

    alter table public.chat_rooms add column if not exists project_id uuid;

    -- Carry existing team rooms over to the project that team was given to.
    if exists (select 1 from information_schema.columns
               where table_schema='public' and table_name='chat_rooms' and column_name='team_id')
       and exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='projects' and column_name='team_id')
    then
      update public.chat_rooms r
      set project_id = p.id, kind = 'project'
      from public.projects p
      where r.kind = 'team' and r.team_id is not null and p.team_id = r.team_id
        and r.project_id is null;
    end if;

    -- Department rooms have no project equivalent; make them ordinary custom
    -- rooms rather than deleting anyone's message history.
    update public.chat_rooms set kind = 'custom' where kind = 'department';
    -- Any team room with no matching project, likewise.
    update public.chat_rooms set kind = 'custom' where kind = 'team' and project_id is null;

    -- Let 'project' through whatever CHECK the column carries.
    begin
      alter table public.chat_rooms drop constraint if exists chat_rooms_kind_check;
      alter table public.chat_rooms
        add constraint chat_rooms_kind_check
        check (kind in ('org', 'project', 'private', 'custom'));
    exception when others then
      raise notice 'chat_rooms.kind constraint left as-is: %', sqlerrm;
    end;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Documents: visibility becomes desk / project / private.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'documents') then

    alter table public.documents add column if not exists project_id uuid;

    -- A document shared with a team moves to that team's project.
    if exists (select 1 from information_schema.columns
               where table_schema='public' and table_name='documents' and column_name='team_id')
       and exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='projects' and column_name='team_id')
    then
      update public.documents d
      set project_id = p.id, visibility = 'project'
      from public.projects p
      where d.visibility = 'team' and d.team_id is not null and p.team_id = d.team_id;
    end if;

    -- Anything still team/department scoped becomes desk-wide rather than
    -- vanishing from everyone's list.
    update public.documents set visibility = 'desk'
    where visibility in ('team', 'department');

    alter table public.documents drop constraint if exists documents_visibility_check;
    alter table public.documents
      add constraint documents_visibility_check
      check (visibility in ('desk', 'project', 'private'));
  end if;
end $$;

-- Re-point the storage-layer visibility rule at projects. Mirrors
-- frontend/lib/documents.ts canSeeDocument().
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
      p_doc.visibility = 'project' and p_doc.project_id is not null
      and exists (
        select 1 from public.project_members pm
        where pm.project_id = p_doc.project_id and pm.user_id = auth.uid()
      )
    );
$$;

-- ---------------------------------------------------------------------------
-- 5. Default chat rooms, per project instead of per team.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'chat_rooms') then
    execute $fn$
      create or replace function public.bb_ensure_default_rooms(p_desk uuid)
      returns void
      language plpgsql
      security definer
      set search_path = public
      as $body$
      begin
        insert into public.chat_rooms (desk_id, name, kind)
        select p_desk, 'general', 'org'
        where not exists (
          select 1 from public.chat_rooms where desk_id = p_desk and kind = 'org'
        );

        insert into public.chat_rooms (desk_id, name, kind, project_id)
        select p_desk, p.name, 'project', p.id
        from public.projects p
        where p.desk_id = p_desk
          and not exists (
            select 1 from public.chat_rooms r
            where r.desk_id = p_desk and r.kind = 'project' and r.project_id = p.id
          );
      end
      $body$;
    $fn$;
  end if;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- 6. Check it worked.
-- ---------------------------------------------------------------------------
select p.name as project,
       count(pm.id) as members,
       count(*) filter (where pm.role = 'manager') as managers
from public.projects p
left join public.project_members pm on pm.project_id = p.id
group by p.name
order by p.name;

-- ---------------------------------------------------------------------------
-- 7. LATER, once you've confirmed everything works, the old structures can go.
--    Left commented out on purpose - run these only when you're sure.
-- ---------------------------------------------------------------------------
-- alter table public.tasks    drop column if exists team_id,
--                             drop column if exists department_id,
--                             drop column if exists group_id;
-- alter table public.projects drop column if exists team_id;
-- alter table public.documents drop column if exists team_id,
--                              drop column if exists department_id;
-- alter table public.chat_rooms drop column if exists team_id,
--                               drop column if exists department_id;
-- drop table if exists public.group_members;
-- drop table if exists public.groups;
-- drop table if exists public.team_members;
-- drop table if exists public.teams;
-- drop table if exists public.departments;
