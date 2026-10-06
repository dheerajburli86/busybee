-- Org structure (departments / teams / ad-hoc groups) and real milestones.
--
-- This ADDS an assignment layer on top of the project-based access model put
-- in by 20260923_project_based_access. It does NOT change that model: who can
-- see a project's work is still decided by projects.manager_id and
-- project_members. Departments and teams are about *structure and assignment*
-- - "this task belongs to the QA team", "this person sits in Delivery" - not
-- about access.
--
-- Two things to know about the existing tables:
--   * teams / team_members / departments may already exist from before the
--     project-based switch-over (that migration deliberately left them in
--     place rather than dropping them). So every table here is created with
--     `if not exists` AND every column is then added with
--     `add column if not exists`, so a half-built old copy is brought up to
--     the shape the app now expects instead of being silently left short.
--   * tasks.milestone (text) is legacy and still read by the Gantt view and
--     the dashboard. It is left completely untouched; tasks.milestone_id is
--     the new, real foreign key alongside it.
--
-- Idempotent and defensive, like the previous two migrations. Run it in the
-- Supabase SQL editor; it is safe to run more than once.

begin;

-- ---------------------------------------------------------------------------
-- 1. Helper predicates.
--
--    The previous migrations spelled "is a supervisor or admin on this desk"
--    out by hand in every policy (see bb_can_see_document in
--    20260922_close_the_gap). It is now needed in a dozen more places, so it
--    gets a name here - same role list, same security definer / stable shape
--    as bb_can_see_document, so it behaves identically.
-- ---------------------------------------------------------------------------
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

-- "Runs this project" - the project's own manager, or anyone carrying the
-- manager role on it in project_members. Mirrors the rule the API layer
-- applies in app/api/projects/members.
create or replace function public.bb_manages_project(p_project uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.projects p
    where p.id = p_project and p.manager_id = auth.uid()
  ) or exists (
    select 1 from public.project_members pm
    where pm.project_id = p_project and pm.user_id = auth.uid()
      and lower(coalesce(pm.role, '')) = 'manager'
  );
$$;

-- Who may see a project at all. Mirrors how project_members is scoped in
-- 20260923_project_based_access: membership of the desk that owns it.
create or replace function public.bb_can_see_project(p_project uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.projects p
    join public.desk_members dm on dm.desk_id = p.desk_id
    where p.id = p_project and dm.user_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------------
-- 2. departments
-- ---------------------------------------------------------------------------
create table if not exists public.departments (
  id uuid primary key default gen_random_uuid(),
  desk_id uuid not null,
  name text not null,
  created_by uuid,
  created_at timestamptz default now()
);

-- Bring an older copy of the table up to shape.
alter table public.departments add column if not exists desk_id uuid;
alter table public.departments add column if not exists name text;
alter table public.departments add column if not exists created_by uuid;
alter table public.departments add column if not exists created_at timestamptz default now();

create index if not exists departments_desk_idx on public.departments(desk_id);
-- Case-insensitive uniqueness per desk. An expression has to go in an index
-- rather than a table-level unique constraint. Guarded, so an older table that
-- already holds two departments called "Delivery" and "delivery" reports the
-- clash instead of aborting the whole migration.
do $$ begin
  create unique index if not exists departments_desk_name_key
    on public.departments(desk_id, lower(name));
exception when others then
  raise notice 'departments_desk_name_key not created (duplicate names?): %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- 3. teams - 'team' is a standing team, 'group' is an ad-hoc custom group put
--    together for a one-off assignment. Same table so both can be handed work
--    the same way.
-- ---------------------------------------------------------------------------
create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  desk_id uuid not null,
  name text not null,
  kind text not null default 'team' check (kind in ('team', 'group')),
  department_id uuid references public.departments(id) on delete set null,
  manager_id uuid,
  created_by uuid,
  created_at timestamptz default now()
);

alter table public.teams add column if not exists desk_id uuid;
alter table public.teams add column if not exists name text;
alter table public.teams add column if not exists kind text not null default 'team';
alter table public.teams add column if not exists department_id uuid;
alter table public.teams add column if not exists manager_id uuid;
alter table public.teams add column if not exists created_by uuid;
alter table public.teams add column if not exists created_at timestamptz default now();

-- The kind CHECK, restated so an older teams table gets it too. Anything not
-- already 'team'/'group' is normalised first so the constraint can be added.
do $$
begin
  update public.teams set kind = 'team' where kind is null or kind not in ('team', 'group');
  alter table public.teams drop constraint if exists teams_kind_check;
  alter table public.teams add constraint teams_kind_check check (kind in ('team', 'group'));
exception when others then
  raise notice 'teams.kind constraint left as-is: %', sqlerrm;
end $$;

-- The department FK, for the case where teams already existed without it.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'teams_department_id_fkey'
      and conrelid = 'public.teams'::regclass
  ) then
    alter table public.teams
      add constraint teams_department_id_fkey
      foreign key (department_id) references public.departments(id) on delete set null;
  end if;
exception when others then
  raise notice 'teams.department_id FK not added: %', sqlerrm;
end $$;

create index if not exists teams_desk_idx on public.teams(desk_id);
create index if not exists teams_department_idx on public.teams(department_id);
do $$ begin
  create unique index if not exists teams_desk_name_key
    on public.teams(desk_id, lower(name));
exception when others then
  raise notice 'teams_desk_name_key not created (duplicate names?): %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- 4. team_members
-- ---------------------------------------------------------------------------
-- user_id carries a real FK to public.users, exactly as project_members does in
-- 20260923_project_based_access. It is not decoration: /api/teams reads its
-- people with PostgREST resource embedding - team_members -> users(id, email,
-- full_name) - and PostgREST only offers an embed it can see a foreign key for.
-- Without it every teams request fails with PGRST200 and the screen 500s.
--
-- Uniqueness of (team_id, user_id) is NOT declared inline: it is carried by the
-- team_members_team_user_key index below, which is guarded so an older table
-- holding duplicate rows reports the clash instead of aborting the migration.
-- Declaring it in both places left two identical unique indexes on the table.
create table if not exists public.team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  added_at timestamptz default now()
);

alter table public.team_members add column if not exists team_id uuid;
alter table public.team_members add column if not exists user_id uuid;
alter table public.team_members add column if not exists added_at timestamptz default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'team_members_team_id_fkey'
      and conrelid = 'public.team_members'::regclass
  ) then
    alter table public.team_members
      add constraint team_members_team_id_fkey
      foreign key (team_id) references public.teams(id) on delete cascade;
  end if;
exception when others then
  raise notice 'team_members.team_id FK not added: %', sqlerrm;
end $$;

-- The users FK, for the case where team_members already existed without it.
-- Rows pointing at a user who no longer exists would block it, so it is
-- guarded like the rest and reports rather than aborting.
do $$
begin
  if to_regclass('public.users') is null then
    raise notice 'public.users not present - team_members.user_id FK skipped';
  elsif not exists (
    select 1 from pg_constraint where conname = 'team_members_user_id_fkey'
      and conrelid = 'public.team_members'::regclass
  ) then
    alter table public.team_members
      add constraint team_members_user_id_fkey
      foreign key (user_id) references public.users(id) on delete cascade;
  end if;
exception when others then
  raise notice 'team_members.user_id FK not added: %', sqlerrm;
end $$;

create index if not exists team_members_team_idx on public.team_members(team_id);
create index if not exists team_members_user_idx on public.team_members(user_id);
do $$ begin
  create unique index if not exists team_members_team_user_key
    on public.team_members(team_id, user_id);
exception when others then
  raise notice 'team_members_team_user_key not created (duplicate rows?): %', sqlerrm;
end $$;

-- An earlier version of this file declared the same uniqueness twice, so a
-- database that ran it carries a redundant second unique constraint on the very
-- same columns. Drop it once the index above is confirmed in place. This
-- removes a duplicate constraint only - no row is touched.
do $$
begin
  if exists (
    select 1 from pg_class where relname = 'team_members_team_user_key' and relkind = 'i'
  ) and exists (
    select 1 from pg_constraint where conname = 'team_members_team_id_user_id_key'
      and conrelid = 'public.team_members'::regclass
  ) then
    alter table public.team_members drop constraint team_members_team_id_user_id_key;
  end if;
exception when others then
  raise notice 'redundant team_members unique constraint left as-is: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- 5. milestones - real, per-project milestones with a date and an order.
--    Created BEFORE tasks.milestone_id below, which points at it.
-- ---------------------------------------------------------------------------
create table if not exists public.milestones (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  due_date timestamptz,
  position int not null default 0,
  created_by uuid,
  created_at timestamptz default now()
);

alter table public.milestones add column if not exists project_id uuid;
alter table public.milestones add column if not exists name text;
alter table public.milestones add column if not exists due_date timestamptz;
alter table public.milestones add column if not exists position int not null default 0;
alter table public.milestones add column if not exists created_by uuid;
alter table public.milestones add column if not exists created_at timestamptz default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'milestones_project_id_fkey'
      and conrelid = 'public.milestones'::regclass
  ) then
    alter table public.milestones
      add constraint milestones_project_id_fkey
      foreign key (project_id) references public.projects(id) on delete cascade;
  end if;
exception when others then
  raise notice 'milestones.project_id FK not added: %', sqlerrm;
end $$;

create index if not exists milestones_project_idx on public.milestones(project_id);

-- ---------------------------------------------------------------------------
-- 6. The new columns on the existing tables. All nullable, so nothing that
--    already exists has to be backfilled and no current screen changes.
-- ---------------------------------------------------------------------------

-- Where a person sits in the org.
alter table if exists public.desk_members add column if not exists department_id uuid;

-- Which team (or ad-hoc group) a piece of work belongs to.
alter table if exists public.tasks    add column if not exists team_id uuid;
alter table if exists public.subtasks add column if not exists team_id uuid;

-- The real milestone. tasks.milestone (text) is legacy and left alone - the
-- Gantt view and the dashboard still read it.
alter table if exists public.tasks add column if not exists milestone_id uuid;

-- The foreign keys for those columns, each added only if it isn't there. Done
-- separately from the column so an older schema that already had, say,
-- tasks.team_id as a bare uuid gets the constraint too.
--
-- Every table here is optional: subtasks in particular does not exist on every
-- deployment. The existence test therefore uses to_regclass(), which returns
-- NULL for a missing table, and NOT the `'public.x'::regclass` cast, which
-- THROWS for one. Postgres does not short-circuit AND, so a cast sitting in the
-- second half of an `exists(...) and not exists(... ::regclass ...)` guard is
-- evaluated even when the table is absent - and because that guard sat outside
-- the exception handler, the error escaped the DO block, aborted the
-- transaction and rolled the whole migration back. A missing table must be
-- skipped, not fatal, so the guard now runs inside the handler too.
do $$
declare
  r record;
  v_name text;
begin
  for r in
    select * from (values
      ('desk_members', 'department_id', 'departments', 'set null'),
      ('tasks',        'team_id',       'teams',       'set null'),
      ('subtasks',     'team_id',       'teams',       'set null'),
      ('tasks',        'milestone_id',  'milestones',  'set null')
    ) as v(tbl, col, target, on_delete)
  loop
    begin
      v_name := r.tbl || '_' || r.col || '_fkey';

      if to_regclass('public.' || r.tbl) is null then
        raise notice 'public.% not present - % skipped', r.tbl, v_name;
      elsif to_regclass('public.' || r.target) is null then
        raise notice 'public.% not present - % skipped', r.target, v_name;
      elsif not exists (
        select 1 from pg_constraint
        where conname = v_name
          and conrelid = to_regclass('public.' || r.tbl)
      ) then
        execute format(
          'alter table public.%I add constraint %I foreign key (%I) references public.%I(id) on delete %s',
          r.tbl, v_name, r.col, r.target, r.on_delete
        );
      end if;
    exception when others then
      raise notice '%.% FK not added: %', r.tbl, r.col, sqlerrm;
    end;
  end loop;
end $$;

-- The indexes for those columns. Same problem, same treatment: a bare
-- `create index on public.subtasks(...)` against a database with no subtasks
-- table is just as fatal as the cast above was, and took the whole run down
-- with it. Skip the ones whose table isn't there.
do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('tasks_team_idx',              'tasks',        'team_id'),
      ('tasks_milestone_idx',         'tasks',        'milestone_id'),
      ('subtasks_team_idx',           'subtasks',     'team_id'),
      ('desk_members_department_idx', 'desk_members', 'department_id')
    ) as v(idx, tbl, col)
  loop
    begin
      if to_regclass('public.' || r.tbl) is null then
        raise notice 'public.% not present - index % skipped', r.tbl, r.idx;
      else
        execute format('create index if not exists %I on public.%I(%I)', r.idx, r.tbl, r.col);
      end if;
    exception when others then
      raise notice 'index % not created: %', r.idx, sqlerrm;
    end;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 6b. Close the shape gap on older tables.
--
--     The `create table` above spells the required columns NOT NULL, but it
--     only runs on a database that doesn't have the table yet. On one that
--     already had teams / departments / team_members, the columns were merely
--     `add column if not exists`ed and stayed nullable, so the same app ended
--     up running against two different shapes.
--
--     Tightening is attempted only where it is SAFE: a column is left exactly
--     as it is if any existing row holds a NULL there, and the whole thing is
--     guarded so a surprise can never fail the migration. Nothing is deleted
--     and no value is rewritten - an old row with a NULL desk_id stays, and the
--     column simply stays nullable until someone fills it in.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  v_has_null boolean;
begin
  for r in
    select * from (values
      ('departments',  'desk_id'),
      ('departments',  'name'),
      ('teams',        'desk_id'),
      ('teams',        'name'),
      ('teams',        'kind'),
      ('team_members', 'team_id'),
      ('team_members', 'user_id'),
      ('milestones',   'project_id'),
      ('milestones',   'name'),
      ('milestones',   'position')
    ) as v(tbl, col)
  loop
    begin
      if to_regclass('public.' || r.tbl) is null then
        continue;
      end if;
      execute format('select exists (select 1 from public.%I where %I is null)', r.tbl, r.col)
        into v_has_null;
      if v_has_null then
        raise notice '%.% left nullable - existing rows hold NULLs there; fill them in and re-run', r.tbl, r.col;
      else
        execute format('alter table public.%I alter column %I set not null', r.tbl, r.col);
      end if;
    exception when others then
      raise notice '%.% not set NOT NULL: %', r.tbl, r.col, sqlerrm;
    end;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Row level security.
--
--    Reading: anyone on the desk can see its structure - who is in which team
--    and department is not a secret, and every screen that assigns work needs
--    it. Writing: supervisors and admins, plus a team's own manager for that
--    team. Milestones follow the project: seen by anyone who can see the
--    project (same scoping as project_members), written by the project's
--    manager and by desk supervisors/admins.
-- ---------------------------------------------------------------------------
alter table public.departments  enable row level security;
alter table public.teams        enable row level security;
alter table public.team_members enable row level security;
alter table public.milestones   enable row level security;

-- departments -------------------------------------------------------------
drop policy if exists departments_read on public.departments;
create policy departments_read on public.departments
  for select to authenticated
  using (public.bb_is_desk_member(desk_id));

drop policy if exists departments_write on public.departments;
create policy departments_write on public.departments
  for all to authenticated
  using (public.bb_is_desk_admin(desk_id))
  with check (public.bb_is_desk_admin(desk_id));

-- teams -------------------------------------------------------------------
drop policy if exists teams_read on public.teams;
create policy teams_read on public.teams
  for select to authenticated
  using (public.bb_is_desk_member(desk_id));

-- The manager branch is scoped to the desk as well. On its own, `manager_id =
-- auth.uid()` says nothing about WHICH desk the row sits on, and manager_id is
-- supplied by whoever is writing - so anybody could INSERT a team onto any desk
-- in the system simply by naming themselves its manager, and that team then
-- appeared in that desk's team list. A team's manager may only manage a team on
-- a desk they are actually on.
drop policy if exists teams_write on public.teams;
create policy teams_write on public.teams
  for all to authenticated
  using (
    public.bb_is_desk_admin(desk_id)
    or (public.bb_is_desk_member(desk_id) and manager_id = auth.uid())
  )
  with check (
    public.bb_is_desk_admin(desk_id)
    or (public.bb_is_desk_member(desk_id) and manager_id = auth.uid())
  );

-- team_members ------------------------------------------------------------
drop policy if exists team_members_read on public.team_members;
create policy team_members_read on public.team_members
  for select to authenticated
  using (
    exists (
      select 1 from public.teams t
      where t.id = team_id and public.bb_is_desk_member(t.desk_id)
    )
  );

-- Same scoping as teams_write, and for the same reason: the acting user has to
-- be on the team's OWN desk, not merely named as its manager. Without that, the
-- hole in teams_write above was compounded - having planted a team on someone
-- else's desk, the same user satisfied this policy too and could staff that
-- team with that desk's people.
drop policy if exists team_members_write on public.team_members;
create policy team_members_write on public.team_members
  for all to authenticated
  using (
    exists (
      select 1 from public.teams t
      where t.id = team_id
        and (
          public.bb_is_desk_admin(t.desk_id)
          or (public.bb_is_desk_member(t.desk_id) and t.manager_id = auth.uid())
        )
    )
  )
  with check (
    exists (
      select 1 from public.teams t
      where t.id = team_id
        and (
          public.bb_is_desk_admin(t.desk_id)
          or (public.bb_is_desk_member(t.desk_id) and t.manager_id = auth.uid())
        )
    )
  );

-- milestones --------------------------------------------------------------
drop policy if exists milestones_read on public.milestones;
create policy milestones_read on public.milestones
  for select to authenticated
  using (public.bb_can_see_project(project_id));

-- Checked for the same unscoped-branch problem as teams_write, and it does not
-- have it: bb_manages_project() is tied to an existing project row - you have
-- to already be that project's manager_id, or carry the manager role on it in
-- project_members - so there is nothing here a writer can assert about
-- themselves the way manager_id could be asserted on an INSERT into teams.
-- bb_can_see_project() on the read side requires desk membership outright.
drop policy if exists milestones_write on public.milestones;
create policy milestones_write on public.milestones
  for all to authenticated
  using (
    public.bb_manages_project(project_id)
    or exists (
      select 1 from public.projects p
      where p.id = project_id and public.bb_is_desk_admin(p.desk_id)
    )
  )
  with check (
    public.bb_manages_project(project_id)
    or exists (
      select 1 from public.projects p
      where p.id = project_id and public.bb_is_desk_admin(p.desk_id)
    )
  );

commit;

-- ---------------------------------------------------------------------------
-- 8. Check it worked.
--
--    A table existing is NOT the same as the migration having worked. Several
--    steps above are deliberately allowed to skip themselves with a NOTICE -
--    a unique index that duplicate rows won't accept, a foreign key that
--    existing data won't satisfy - and this section used to test nothing but
--    table and column existence, so it printed "yes" straight through a run in
--    which departments_desk_name_key, team_members_team_user_key and
--    tasks_team_id_fkey had all been skipped. tasks.team_id had no foreign key
--    at all and the output said everything was fine.
--
--    So the constraints, unique indexes and foreign keys are now checked by
--    name as well. Read the status column:
--
--      ok       - in place.
--      n/a      - the table doesn't exist on this deployment (subtasks often
--                 doesn't); nothing was expected and nothing is wrong.
--      MISSING  - the step was SKIPPED. Scroll up to the NOTICE naming it: it
--                 says why (almost always duplicate or orphaned rows). Clean
--                 those up and run this file again - it is safe to re-run.
--
--    The last row is the verdict.
-- ---------------------------------------------------------------------------
with expected(sort, kind, object, on_table, present, applicable) as (

  -- the tables this migration is responsible for
  select 1, 'table', t.name, '',
         to_regclass('public.' || t.name) is not null,
         true
  from (values ('departments'), ('teams'), ('team_members'), ('milestones')) as t(name)

  union all
  -- the columns added to tables that already existed
  select 2, 'column', c.col, c.tbl,
         exists (
           select 1 from information_schema.columns ic
           where ic.table_schema = 'public' and ic.table_name = c.tbl and ic.column_name = c.col
         ),
         to_regclass('public.' || c.tbl) is not null
  from (values
    ('desk_members', 'department_id'),
    ('tasks',        'team_id'),
    ('tasks',        'milestone_id'),
    ('subtasks',     'team_id')
  ) as c(tbl, col)

  union all
  -- the unique indexes - these are the ones dirty data skips
  select 3, 'unique index', u.idx, u.tbl,
         exists (select 1 from pg_indexes i where i.schemaname = 'public' and i.indexname = u.idx),
         to_regclass('public.' || u.tbl) is not null
  from (values
    ('departments_desk_name_key',  'departments'),
    ('teams_desk_name_key',        'teams'),
    ('team_members_team_user_key', 'team_members')
  ) as u(idx, tbl)

  union all
  -- the kind CHECK
  select 4, 'check', 'teams_kind_check', 'teams',
         exists (
           select 1 from pg_constraint c
           where c.conname = 'teams_kind_check' and c.contype = 'c'
             and c.conrelid = to_regclass('public.teams')
         ),
         to_regclass('public.teams') is not null

  union all
  -- the foreign keys. team_members_user_id_fkey is the one /api/teams needs:
  -- PostgREST will only embed users(...) from team_members if it can see it.
  select 5, 'foreign key', f.name, f.tbl,
         exists (
           select 1 from pg_constraint c
           where c.conname = f.name and c.contype = 'f'
             and c.conrelid = to_regclass('public.' || f.tbl)
         ),
         to_regclass('public.' || f.tbl) is not null
  from (values
    ('teams_department_id_fkey',       'teams'),
    ('team_members_team_id_fkey',      'team_members'),
    ('team_members_user_id_fkey',      'team_members'),
    ('milestones_project_id_fkey',     'milestones'),
    ('desk_members_department_id_fkey','desk_members'),
    ('tasks_team_id_fkey',             'tasks'),
    ('tasks_milestone_id_fkey',        'tasks'),
    ('subtasks_team_id_fkey',          'subtasks')
  ) as f(name, tbl)

  union all
  -- the row level security policies
  select 6, 'policy', p.name, p.tbl,
         exists (
           select 1 from pg_policies pp
           where pp.schemaname = 'public' and pp.tablename = p.tbl and pp.policyname = p.name
         ),
         to_regclass('public.' || p.tbl) is not null
  from (values
    ('departments_read',  'departments'),
    ('departments_write', 'departments'),
    ('teams_read',        'teams'),
    ('teams_write',       'teams'),
    ('team_members_read', 'team_members'),
    ('team_members_write','team_members'),
    ('milestones_read',   'milestones'),
    ('milestones_write',  'milestones')
  ) as p(name, tbl)
)
select kind, object, on_table, status
from (
  select sort, kind, object, on_table,
         case when present        then 'ok'
              when not applicable then 'n/a - no such table here'
              else                     'MISSING' end as status
  from expected

  union all

  select 9, 'VERDICT', '', '',
         case when count(*) filter (where applicable and not present) = 0
              then 'ALL CHECKS PASSED'
              else count(*) filter (where applicable and not present)::text
                   || ' CHECK(S) MISSING - see the MISSING rows above and the matching NOTICE'
         end
  from expected
) checks
order by sort, kind, on_table, object;
