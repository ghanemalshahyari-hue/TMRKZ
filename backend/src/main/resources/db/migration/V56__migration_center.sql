-- V56 (owner, 20 Nov 2026; ADR-094 «Migration Center»): «الإعدادات → ترحيل قاعدة بيانات» — the data of an older TMRKZ
-- database brought into the current one, never the other way round and never replacing it. One row per attempt keeps the
-- source (never its password: that is encrypted with TMRKZ's own key, as integration_setting), the schema version read
-- from the source, the preview (per-table new / conflicting / identical rows), the chosen tables with their dependency
-- order, and the report. Decision A: a record that already exists in the current database is never changed; a conflict is
-- only reported.
create table db_migration (
  id                    uuid primary key,
  state                 text not null check (state in ('PREVIEWED', 'VALIDATED', 'MIGRATED', 'FAILED')),
  source                jsonb not null,
  secret_ciphertext     text,
  secret_key_id         text,
  source_schema_version int,
  created_by            uuid references person(id),
  created_at            timestamptz not null default now(),
  preview               jsonb,
  selection             jsonb,
  report                jsonb,
  finished_at           timestamptz
);
create index db_migration_created_idx on db_migration(created_at desc);
