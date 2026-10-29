-- V10: per-resource relation to its sub-resources and an optional limit for shared use (PA-17; owner brief §2, §9).

-- true (default, the behaviour of every existing resource): reserving this resource blocks its sub-resources and a
-- reserved sub-resource blocks it. false: this resource and its sub-resources are booked independently.
alter table resource add column child_blocking boolean not null default true;

-- Shared resources have no capacity rule unless the facility manager sets one: at most this many approved uses at the
-- same time. Null (default) = no limit; never an artificial number.
alter table resource add column shared_limit int check (shared_limit is null or shared_limit >= 1);
alter table resource add constraint resource_shared_limit_policy check (shared_limit is null or policy = 'SHARED');

-- Highest number of active reservations of a resource that overlap one another inside a window (concurrency only
-- rises at a start, so the window start and every start inside it are the only instants to count).
create function resource_shared_peak(rid uuid, win tstzrange, exclude uuid) returns int language sql stable as $$
  with o as (
    select tstzrange(period_start, period_end, '[)') as p from reservation
    where resource_id = rid and status = 'ACTIVE' and (exclude is null or id <> exclude)
      and tstzrange(period_start, period_end, '[)') && win),
  pts as (select lower(win) as t union select lower(p) from o where lower(p) > lower(win))
  select coalesce(max((select count(*) from o where o.p @> pts.t)), 0)::int from pts
$$;
