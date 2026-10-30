-- V14: request to relocate an organisation's premises (owner request of 30 Oct 2026, ADR-023).
-- The requester proposes a new location drawn on the map; it is attached to the request and reviewed with it. The
-- official site register is never changed by the proposal: a facilities administrator registers a new site separately.

alter table request_type drop constraint request_type_kind_check;
alter table request_type add constraint request_type_kind_check
  check (kind in ('NEW_RESERVATION', 'EXTENSION', 'MODIFICATION', 'CANCELLATION', 'EVACUATION', 'RELOCATION'));

-- The working proposal of a request (editable with the draft); each submission copies it into the revision snapshot.
create table request_relocation (
  request_id          uuid primary key references request(id),
  organization_id     uuid not null references organization(id),
  include_descendants boolean not null default false,
  from_site_id        uuid not null references site(id),
  proposed_name       text not null check (length(proposed_name) between 2 and 120),
  proposed_geojson    jsonb not null,
  proposed_geom       geometry(Geometry, 4326) not null,
  area_m2             double precision,
  updated_by          uuid not null references person(id),
  updated_at          timestamptz not null,
  completed_at        timestamptz
);
create index request_relocation_geom on request_relocation using gist (proposed_geom);
