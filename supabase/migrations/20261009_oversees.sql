-- BusyBee: the desk's head ("gets every update").
-- People marked here get an email about everything that happens on every
-- task and the team section of the daily summaries; everyone else only hears
-- about tasks given to them or by them. Toggle it on the People page.
-- Safe to re-run.
alter table public.desk_members add column if not exists oversees boolean not null default false;
