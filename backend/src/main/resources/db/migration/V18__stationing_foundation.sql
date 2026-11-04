-- V18 (ADR-031, Stationing Model V3 foundation; docs/STATIONING_MODEL_V3_AR.md): the versioned stationing policy, the
-- authoritative stationing of units, site ↔ unit links, the outbound stationing event outbox and the approved terrain
-- slope dataset. Additive only. request_relocation and placement_rule (V14/V15) keep their rows and meaning and are not
-- reinterpreted. Re-stationing requests, deployment areas and their route history follow with the request workflow in a
-- later migration, so no table is created before the behaviour that writes it.

-- Raster support for the terrain slope dataset (part of PostGIS; like V8, with separated database roles a DBA creates
-- the extension first).
create extension if not exists postgis_raster;

-- System Administrator policy (Studio), one complete value set per version (ae.mover.stationing.StationingPolicy):
-- footprint maximum, stationing_areas_requirement, deployment legs, terrain_slope_classification with its dataset,
-- terrain allowances and terrain_class_priority, exception, cross-branch and routing. Append-only: a change is a new
-- version that names the previous one, with author, reason, reference and the time it takes effect. A submitted request
-- keeps the version it was submitted under.
create table stationing_policy_version (
  id              uuid primary key,
  version         int not null unique check (version > 0),
  previous_id     uuid unique references stationing_policy_version(id),
  policy_values   jsonb not null,
  effective_from  timestamptz not null,
  reason          text not null check (length(btrim(reason)) >= 5),
  reference       text,
  created_by      uuid not null references person(id),
  created_at      timestamptz not null default now(),
  check ((version = 1) = (previous_id is null)),
  check (effective_from >= created_at - interval '5 seconds')
);

create function stationing_policy_version_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'stationing policy versions are append-only; publish a new version instead' using errcode = '42501';
end $$;
create trigger stationing_policy_version_frozen before update or delete on stationing_policy_version
  for each row execute function stationing_policy_version_append_only();

-- Authoritative stationing (V3 §1.4.3): which site a unit is stationed at, recorded explicitly — by an activated
-- re-stationing request or by a data correction with CORRECT_STATIONING. Not a link, not facility responsibility.
-- A temporary stationing overlays its permanent base (V2 D7) and returns to it; history is never deleted.
create table org_stationing (
  id               uuid primary key,
  organization_id  uuid not null references organization(id),
  site_id          uuid not null references site(id),
  kind             text not null check (kind in ('PERMANENT', 'TEMPORARY')),
  base_id          uuid references org_stationing(id),
  valid_from       timestamptz not null,
  valid_to         timestamptz,
  planned_end      timestamptz,
  origin           text not null check (origin in ('CORRECTION', 'REQUEST')),
  request_id       uuid,                                        -- the re-stationing request (its table follows later)
  reason           text not null check (length(btrim(reason)) >= 5),
  reference        text,
  recorded_by      uuid not null references person(id),
  recorded_at      timestamptz not null default now(),
  end_reason       text check (end_reason in ('SUPERSEDED', 'CORRECTED', 'RETURNED', 'CANCELLED', 'ENDED_EARLY')),
  ended_by         uuid references person(id),
  ended_at         timestamptz,
  check (valid_to is null or valid_to >= valid_from),
  check ((valid_to is null) = (end_reason is null)),
  check (kind = 'PERMANENT' and base_id is null and planned_end is null
      or kind = 'TEMPORARY' and base_id is not null and planned_end is not null and planned_end > valid_from),
  check (origin = 'CORRECTION' or request_id is not null),
  -- one permanent stationing per unit at any time, and at most one temporary
  constraint org_stationing_no_overlap exclude using gist
    (organization_id with =, kind with =, tstzrange(valid_from, valid_to, '[)') with &&)
);
create index org_stationing_site_idx on org_stationing(site_id) where valid_to is null;
create index org_stationing_org_idx on org_stationing(organization_id, valid_from);

-- Site ↔ unit link (V3 §1.4.2, §6): association only. Never stationing and never occupancy (O-15); activating a
-- re-stationing never changes links (O-14).
create table site_link (
  id               uuid primary key,
  site_id          uuid not null references site(id),
  organization_id  uuid not null references organization(id),
  valid_from       timestamptz not null,
  valid_to         timestamptz,
  source           text not null default 'TMRKZ' check (length(btrim(source)) between 2 and 40),
  reason           text not null check (length(btrim(reason)) >= 5),
  created_by       uuid not null references person(id),
  created_at       timestamptz not null default now(),
  ended_by         uuid references person(id),
  ended_reason     text,
  check (valid_to is null or valid_to > valid_from),
  check ((valid_to is null) = (ended_reason is null))
);
create unique index site_link_open_idx on site_link(site_id, organization_id) where valid_to is null;

-- Outbound integration (O-01): every authoritative stationing or link change writes its event in the same transaction;
-- a sender delivers it later (at least once, the event id as idempotency key, in sequence per unit). A consumer or
-- Oracle being down never blocks the change. FAILED events wait for an audited replay; nothing is dropped.
create table stationing_outbox (
  seq              bigserial primary key,
  event_id         uuid not null unique,
  event_type       text not null,
  organization_id  uuid not null references organization(id),
  payload          jsonb not null,
  state            text not null default 'PENDING' check (state in ('PENDING', 'DELIVERED', 'FAILED')),
  attempts         int not null default 0,
  available_at     timestamptz not null default now(),
  last_error       text,
  created_at       timestamptz not null default now(),
  delivered_at     timestamptz,
  check ((state = 'DELIVERED') = (delivered_at is not null))
);
create index stationing_outbox_due_idx on stationing_outbox(available_at, seq) where state = 'PENDING';
create index stationing_outbox_org_idx on stationing_outbox(organization_id, seq) where state <> 'DELIVERED';

-- Approved terrain dataset (owner decision 3: Copernicus GLO-30, a surface model) and its slope analysis product:
-- slope percent on the source grid, uint16 = floor(percent × 100), 65535 = no data (ops/terrain). Business classes are
-- derived at query time from the policy's terrain_slope_classification, never from display colours or hillshade.
-- Loaded by ops/terrain/load-slope.sh, not by this migration; empty until then.
create table terrain_dataset (
  id              uuid primary key,
  code            text not null,
  version         text not null,
  surface_model   text not null check (surface_model in ('DSM', 'DTM')),
  slope_encoding  text not null,
  manifest        jsonb not null,
  slope_sha256    text not null,
  loaded_at       timestamptz not null default now(),
  unique (code, version)
);
create table terrain_slope (
  rid         bigserial primary key,
  dataset_id  uuid not null references terrain_dataset(id),
  rast        raster not null
);
create index terrain_slope_hull on terrain_slope using gist (ST_ConvexHull(rast));
create index terrain_slope_dataset_idx on terrain_slope(dataset_id);
