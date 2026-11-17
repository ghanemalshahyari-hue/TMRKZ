-- Deleting a site (owner decisions, 17 Nov 2026; ADR-086): the setup administrator erases a site completely — with its
-- inside sites, the initial stationing of the units there and their deployment areas — and everyone else who manages the
-- site asks for it. A request keeps a copy of the site's code and name (no foreign key), so it is still readable after
-- the site is gone; the deletion itself stays as one audit line.
create table site_deletion_request (
  id               uuid primary key,
  site_id          uuid not null,
  site_code        text not null,
  site_name        text not null,
  requested_by     uuid not null references person(id),
  reason           text not null,
  requested_at     timestamptz not null default now(),
  state            text not null default 'PENDING' check (state in ('PENDING', 'APPROVED', 'REFUSED', 'SUPERSEDED')),
  decided_by       uuid references person(id),
  decided_at       timestamptz,
  decision_reason  text,
  check ((state = 'PENDING') = (decided_at is null))
);
-- one open request per site
create unique index site_deletion_request_open_idx on site_deletion_request(site_id) where state = 'PENDING';
create index site_deletion_request_state_idx on site_deletion_request(state, requested_at desc);

-- The erase itself (ADR-086): sites, their boundary versions and their resources refuse a delete everywhere else. Only a
-- transaction that has declared a site erase (set_config('tmrkz.site_erase', 'on', true), SiteDeletionService) may delete
-- them; the audit trail, decisions and every other append-only record keep their guards unchanged.
create function mover_forbid_delete_unless_site_erase() returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('tmrkz.site_erase', true), '') = 'on' then
    return old;
  end if;
  raise exception '% rows cannot be deleted; retire them instead', tg_table_name using errcode = '42501';
end $$;

create function mover_forbid_change_unless_site_erase() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('tmrkz.site_erase', true), '') = 'on' then
    return old;
  end if;
  raise exception '% rows are append-only (attempted %)', tg_table_name, tg_op using errcode = '42501';
end $$;

drop trigger site_no_delete on site;
create trigger site_no_delete before delete on site for each row execute function mover_forbid_delete_unless_site_erase();
drop trigger resource_no_delete on resource;
create trigger resource_no_delete before delete on resource for each row execute function mover_forbid_delete_unless_site_erase();
drop trigger site_geometry_append_only on site_geometry_version;
create trigger site_geometry_append_only before update or delete on site_geometry_version
  for each row execute function mover_forbid_change_unless_site_erase();
