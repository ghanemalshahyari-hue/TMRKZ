-- V47: additive registration of authorised Oracle-derived, unit-only file imports.
-- Drafted as V45 directly after V44; renumbered V47 so it follows the committed V45 (access_grants_per_role) and V46.
-- It touches only hr_snapshot and its own new table, neither of which V45/V46 change.
-- A preview stages its hr_unit rows in an ORACLE_UNIT_IMPORT hr_snapshot with status PREVIEWED, which the ordinary
-- hourly STAGING/SUPERSEDED/DISCARDED cleanup does not remove. Publication promotes that same snapshot to PUBLISHED.
-- The application service, not this SQL migration, carries people forward from carried_person_snapshot_id at commit.
-- This migration does not create, change or delete organizations, people, affiliations or other business data.
-- Publishing an Oracle-derived file records authorised local metadata only; it never proves live Oracle connectivity.

alter table hr_snapshot add column origin text not null default 'ORACLE_SYNC';
alter table hr_snapshot add constraint hr_snapshot_origin_check
  check (origin in ('ORACLE_SYNC', 'ORACLE_UNIT_IMPORT'));
alter table hr_snapshot alter column run_id drop not null;
alter table hr_snapshot alter column mapping_version_id drop not null;
alter table hr_snapshot add constraint hr_snapshot_origin_lineage_check check (
  (origin = 'ORACLE_SYNC' and run_id is not null and mapping_version_id is not null)
  or (origin = 'ORACLE_UNIT_IMPORT' and run_id is null and mapping_version_id is null)
);
comment on column hr_snapshot.origin is
  'ORACLE_SYNC needs run and mapping lineage; ORACLE_UNIT_IMPORT has neither and is registered in oracle_unit_import_run';

-- PREVIEWED is deliberately distinct from STAGING: HrSyncService cleanup leaves it alone. Keep every pre-V47 status.
alter table hr_snapshot drop constraint hr_snapshot_status_check;
alter table hr_snapshot add constraint hr_snapshot_status_check
  check (status in ('STAGING', 'PREVIEWED', 'PUBLISHED', 'SUPERSEDED', 'DISCARDED'));

create table oracle_unit_import_run (
  id                         uuid primary key,
  storage_key                text not null,
  payload_sha256             text not null,
  payload_size               bigint not null,
  schema_version             text not null,
  source_name                text not null,
  source_synced_at           timestamptz not null,
  source_contract            jsonb not null,
  structure_fingerprint      text not null,
  expected                   jsonb not null default '{}'::jsonb,
  actual                     jsonb,
  snapshot_id                uuid references hr_snapshot(id),
  carried_person_snapshot_id uuid references hr_snapshot(id),
  previewed_by               uuid not null references person(id),
  preview_expires_at         timestamptz not null,
  committed_by               uuid references person(id),
  committed_at               timestamptz,
  -- Captured when the preview is authorised and retained with the run for the later publication audit.
  reason                     text not null,
  status                     text not null,
  error_message              text,
  created_at                 timestamptz not null default now(),
  -- PostgreSQL unique constraints allow multiple nulls, but one run owns each non-null preview/published snapshot.
  constraint oracle_unit_import_snapshot_unique unique (snapshot_id),
  constraint oracle_unit_import_payload_sha256_check check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  constraint oracle_unit_import_payload_size_check check (payload_size > 0),
  constraint oracle_unit_import_reason_check check (length(btrim(reason)) > 0),
  constraint oracle_unit_import_status_check
    check (status in ('PREVIEWED', 'INVALID', 'PUBLISHING', 'PUBLISHED', 'REJECTED')),
  constraint oracle_unit_import_error_message_check
    check (error_message is null or char_length(error_message) <= 4000),
  constraint oracle_unit_import_commit_check check ((committed_by is null) = (committed_at is null))
);

-- Repeated previews may register the same bytes; immutable stored bytes must still be verified by the service on every
-- attempt. Only the terminal publication is deduplicated, so preview/invalid/rejected attempts remain auditable.
create unique index oracle_unit_import_one_published_payload
  on oracle_unit_import_run(payload_sha256) where status = 'PUBLISHED';
create index oracle_unit_import_status_created_idx on oracle_unit_import_run(status, created_at desc);

comment on table oracle_unit_import_run is
  'Unit-file preview/publication audit; people are carried forward in service code, not migration SQL; file publication never proves live Oracle connectivity';
comment on column oracle_unit_import_run.storage_key is 'Internal local-storage key, never a public or Oracle connection address';
comment on column oracle_unit_import_run.snapshot_id is
  'The owned ORACLE_UNIT_IMPORT PREVIEWED unit snapshot, promoted in place to PUBLISHED at commit';
comment on column oracle_unit_import_run.carried_person_snapshot_id is
  'Optional source of existing HR people carried forward by the application service during commit; V47 copies nobody';
