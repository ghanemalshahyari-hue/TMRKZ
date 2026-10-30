-- V15: stationing proposal on the map (owner brief of 30 Oct 2026, ADR-025).
-- An organisation's proposed premises are placed by dragging a marker; configurable distance rules and occupancy are
-- checked while dragging and again on the server at save, submission and approval. Nothing here changes the site
-- register or any reservation: the proposal stays part of the relocation request (ADR-023).

-- Administrative distance rules between the current premises and the proposed location. No rule is seeded: the
-- numbers are the owner's configuration, never constants in the code. The most specific active rule applies
-- (organisation over all organisations, nearer ancestor over farther, a level-specific rule over any level).
create table placement_rule (
  id                  uuid primary key,
  name                text not null check (length(name) between 2 and 120),
  action              text not null check (action in ('RELOCATE', 'WORK_AREA')),
  station_level       text check (station_level in ('MAIN', 'BRANCH')),          -- null = any level
  organization_id     uuid references organization(id),                         -- null = every organisation
  include_descendants boolean not null default true,
  min_m               double precision not null default 0 check (min_m >= 0),
  max_m               double precision check (max_m is null or max_m > min_m),  -- null = no upper limit
  measure             text not null default 'CENTER' check (measure in ('CENTER', 'EDGE')),
  active              boolean not null default true,
  version             int not null default 1,
  updated_by          uuid references person(id),
  updated_at          timestamptz not null default now()
);
create index placement_rule_action_idx on placement_rule(action) where active;

-- The proposal gains its kind, level, duration, the organisations it covers, the dragged point, an optional registered
-- target site, and the result of the last server check (kept for the review card; re-run before every decision).
alter table request_relocation
  add column action            text not null default 'RELOCATE' check (action in ('RELOCATE', 'WORK_AREA')),
  add column station_level     text check (station_level in ('MAIN', 'BRANCH')),
  add column temporary         boolean not null default false,
  add column temporary_end     timestamptz,
  add column target_site_id    uuid references site(id),
  add column included_org_ids  uuid[] not null default '{}',
  add column distance_m        double precision,
  add column rule_id           uuid references placement_rule(id),
  add column rule_version      int,
  add column check_status      text check (check_status in ('OK', 'OUT_OF_RANGE', 'OCCUPIED'));
