-- V3: read-only HR source (Oracle views compatible with the TNQL contract), hourly mirror with staged snapshots,
-- projection onto organisations and people with dated affiliations, position seats, and task realignment.
--
-- Source view and column names are configuration supplied by operations; they are never part of this repository.

-- Source profile -------------------------------------------------------------------------------------------------

create table hr_source (
  id                    uuid primary key,
  name                  text not null unique,
  provider              text not null default 'ORACLE' check (provider in ('ORACLE')),
  enabled               boolean not null default false,
  settings_ciphertext   text,                -- AES-GCM JSON: hostOrUrl, port, serverName, nameType, username, password
  settings_key_id       text,                -- fingerprint of the key that encrypted it (detects rotation)
  unit_view             text,
  person_view           text,
  connect_timeout_s     int not null default 10 check (connect_timeout_s between 1 and 300),
  call_timeout_ms       int not null default 30000 check (call_timeout_ms between 1000 and 300000),
  drop_percent          int not null default 10 check (drop_percent between 0 and 100),
  drop_minimum          int not null default 3 check (drop_minimum >= 0),
  max_age_hours         int not null default 720 check (max_age_hours between 1 and 8760),
  last_connection_ok    boolean,
  last_connection_at    timestamptz,
  last_success_at       timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Mapping versions: canonical field → source column. Published versions are immutable. ---------------------------

create table hr_mapping_version (
  id                  uuid primary key,
  source_id           uuid not null references hr_source(id),
  version             int not null,
  status              text not null check (status in ('DRAFT', 'PUBLISHED', 'SUPERSEDED')),
  fields              jsonb not null,      -- [{entity, field, column, transform, alternates[], enabled}]
  active_rules        jsonb not null,      -- {UNIT: {column, operator, values[]}, PERSON: {...}}
  discovered_columns  jsonb,               -- {UNIT: [...], PERSON: [...]}
  discovered_at       timestamptz,
  created_by          uuid references person(id),
  created_at          timestamptz not null default now(),
  published_by        uuid references person(id),
  published_at        timestamptz,
  unique (source_id, version)
);
create unique index hr_mapping_one_published on hr_mapping_version(source_id) where status = 'PUBLISHED';
create unique index hr_mapping_one_draft on hr_mapping_version(source_id) where status = 'DRAFT';

create function hr_mapping_immutable() returns trigger language plpgsql as $$
begin
  if old.status <> 'DRAFT' then
    if new.fields is distinct from old.fields or new.active_rules is distinct from old.active_rules
        or new.discovered_columns is distinct from old.discovered_columns
        or new.version <> old.version or new.source_id <> old.source_id then
      raise exception 'published HR mapping versions are immutable' using errcode = '23514';
    end if;
    if new.status <> old.status and not (old.status = 'PUBLISHED' and new.status = 'SUPERSEDED') then
      raise exception 'published HR mapping versions are immutable' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger hr_mapping_immutable before update on hr_mapping_version for each row execute function hr_mapping_immutable();

-- Runs, snapshots and the mirror ------------------------------------------------------------------------------------

create table hr_sync_run (
  id                  uuid primary key,
  source_id           uuid references hr_source(id),
  mapping_version_id  uuid references hr_mapping_version(id),
  trigger             text not null check (trigger in ('SCHEDULED', 'MANUAL')),
  requested_by        uuid references person(id),
  status              text not null check (status in ('RUNNING', 'SUCCEEDED', 'REJECTED', 'FAILED', 'SKIPPED')),
  started_at          timestamptz not null,
  finished_at         timestamptz,
  snapshot_id         uuid,
  counts              jsonb not null default '{}'::jsonb,
  error_code          text,
  error_message       text,                 -- never contains source rows
  override_reason     text
);
create index hr_sync_run_started_idx on hr_sync_run(started_at desc);

create table hr_snapshot (
  id                   uuid primary key,
  run_id               uuid not null references hr_sync_run(id),
  mapping_version_id   uuid not null references hr_mapping_version(id),
  status               text not null check (status in ('STAGING', 'PUBLISHED', 'SUPERSEDED', 'DISCARDED')),
  unit_count           int not null default 0,
  person_count         int not null default 0,
  active_unit_count    int not null default 0,
  active_person_count  int not null default 0,
  created_at           timestamptz not null default now(),
  published_at         timestamptz
);
create unique index hr_snapshot_one_published on hr_snapshot((true)) where status = 'PUBLISHED';

create table hr_unit (
  snapshot_id          uuid not null references hr_snapshot(id) on delete cascade,
  external_id          text not null,
  code                 text,
  name                 text not null,
  name_en              text,
  parent_external_id   text,
  status_raw           text,
  active               boolean not null,
  level                int,
  primary key (snapshot_id, external_id)
);
create index hr_unit_parent_idx on hr_unit(snapshot_id, parent_external_id);

create table hr_person (
  snapshot_id             uuid not null references hr_snapshot(id) on delete cascade,
  external_id             text not null,
  employee_number         text not null,
  legacy_employee_number  text,
  domain_account          text,
  full_name               text not null,
  unit_external_id        text,
  position_id             text,
  position_title          text,
  job_title               text,
  status_text             text,
  active                  boolean not null,
  primary key (snapshot_id, external_id)
);
create index hr_person_number_idx on hr_person(snapshot_id, employee_number);
create index hr_person_account_idx on hr_person(snapshot_id, lower(domain_account));
create index hr_person_unit_idx on hr_person(snapshot_id, unit_external_id);

create table hr_sync_issue (
  id           bigserial primary key,
  run_id       uuid not null references hr_sync_run(id),
  kind         text not null,      -- MISSING_KEY, DUPLICATE_KEY, ORPHAN_UNIT, CYCLE, UNKNOWN_UNIT, DUPLICATE_NUMBER
  entity       text not null check (entity in ('UNIT', 'PERSON')),
  external_id  text,               -- source identifier only; shown to VIEW_SOURCE_IDENTIFIERS holders
  detail       text
);
create index hr_sync_issue_run_idx on hr_sync_issue(run_id);

-- Local projection ----------------------------------------------------------------------------------------------------

alter table organization add column source text not null default 'LOCAL' check (source in ('LOCAL', 'HR'));
alter table organization add column source_external_id text;
create unique index organization_source_idx on organization(source, source_external_id) where source_external_id is not null;

alter table person add column source text not null default 'LOCAL' check (source in ('LOCAL', 'HR'));
alter table person add column source_external_id text;
create unique index person_source_idx on person(source, source_external_id) where source_external_id is not null;

-- Fields that come from HR are read-only outside the projection (which sets tmrkz.hr_projection for its transaction).
create function organization_hr_read_only() returns trigger language plpgsql as $$
begin
  if old.source = 'HR' and coalesce(current_setting('tmrkz.hr_projection', true), '') <> 'on'
     and (new.name is distinct from old.name or new.code is distinct from old.code
          or new.parent_id is distinct from old.parent_id or new.status is distinct from old.status
          or new.source is distinct from old.source or new.source_external_id is distinct from old.source_external_id) then
    raise exception 'HR_FIELD_READ_ONLY' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger organization_hr_read_only before update on organization for each row execute function organization_hr_read_only();

create function person_hr_read_only() returns trigger language plpgsql as $$
begin
  if old.source = 'HR' and coalesce(current_setting('tmrkz.hr_projection', true), '') <> 'on'
     and (new.display_name is distinct from old.display_name or new.employee_no is distinct from old.employee_no
          or new.status is distinct from old.status or new.source is distinct from old.source
          or new.source_external_id is distinct from old.source_external_id) then
    raise exception 'HR_FIELD_READ_ONLY' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger person_hr_read_only before update on person for each row execute function person_hr_read_only();

-- Local additions kept apart from HR originals (display names, tags, notes).
create table local_metadata (
  entity_type   text not null check (entity_type in ('ORGANIZATION', 'PERSON')),
  entity_id     uuid not null,
  display_name  text,
  tags          text[] not null default '{}',
  note          text,
  updated_by    uuid references person(id),
  updated_at    timestamptz not null default now(),
  primary key (entity_type, entity_id)
);

-- Dated HR affiliation (organisation and position), separate from permission grants.
create table affiliation (
  id               uuid primary key,
  person_id        uuid not null references person(id),
  organization_id  uuid not null references organization(id),
  position_id      text,
  position_title   text,
  source           text not null default 'HR' check (source in ('HR')),
  valid_from       timestamptz not null,
  valid_to         timestamptz,
  ended_reason     text,
  check (valid_to is null or valid_to > valid_from)
);
create unique index affiliation_open_idx on affiliation(person_id) where valid_to is null;
create index affiliation_org_idx on affiliation(organization_id, position_id) where valid_to is null;

-- A grant normally follows the person's HR affiliation: it ends when they leave the grant organisation's subtree.
-- An explicit cross-organisation grant is marked false and is kept (and listed for review).
alter table membership add column follows_affiliation boolean not null default true;

-- Responsibility seats: a role held by whoever currently occupies an HR position in an organisation.
create table position_seat (
  id               uuid primary key,
  organization_id  uuid not null references organization(id),
  position_id      text not null,
  name             text not null,
  role_code        text not null references role_def(code),
  site_scope_id    uuid references site(id),
  active           boolean not null default true,
  created_by       uuid references person(id),
  created_at       timestamptz not null default now(),
  unique (organization_id, position_id, role_code)
);

-- Realignment of open tasks after affiliation or grant changes.
create table task_reassignment (
  id               uuid primary key,
  task_kind        text not null check (task_kind in ('REVIEW', 'EXECUTION')),
  task_id          uuid not null,
  request_id       uuid not null references request(id),
  reason           text not null,
  departed         uuid[] not null default '{}',
  holders          uuid[] not null default '{}',
  outcome          text not null check (outcome in ('SOLE_SUBSTITUTE', 'POOL_CONTINUES', 'ROUTED_TO_ACCESS_MANAGER')),
  routed_to_org    uuid references organization(id),
  resolved_at      timestamptz,
  resolved_by      uuid references person(id),
  created_at       timestamptz not null default now()
);
create index task_reassignment_open_idx on task_reassignment(outcome) where resolved_at is null;
