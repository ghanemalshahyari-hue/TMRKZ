-- V55 (owner, 20 Nov 2026; ADR-094): units imported on demand and, when switched on, every N hours (24 by default); people
-- never synced in bulk — fetched when needed and refreshed after 24 hours on the next need; a directory sign-in admitted as a
-- zero-access person even when HR does not answer (a toggle), matched with HR later.
alter table hr_source add column auto_sync boolean not null default false;
alter table hr_source add column sync_interval_hours int not null default 24 check (sync_interval_hours between 1 and 720);
alter table hr_source add column people_sync boolean not null default false;
alter table hr_source add column directory_sign_in_suffices boolean not null default true;
-- an installation that synced hourly keeps syncing, now every 24 hours; its linked people are refreshed on demand from now on
update hr_source set auto_sync = enabled;
alter table person add column hr_fetched_at timestamptz;
alter table person add column hr_match_pending boolean not null default false;
