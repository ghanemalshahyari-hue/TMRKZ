-- V66 (owner, 23 Nov 2026; ADR-098): TMRKZ does not use MOVER's database. The units that ADR-097 imported from a MOVER
-- SQLite file (source = 'MOVER') are removed — nothing refers to them except each other — and organization.source is
-- LOCAL or HR again. Units are otherwise never deleted (mover_forbid_delete: retire them instead); this one-off removal of
-- rows that should never have been imported is the only exception, and the guard is back on before the migration ends.
-- The permission store is told that the structure changed, so the units' tuples leave OpenFGA on the next sync.

alter table organization disable trigger organization_no_delete;
delete from organization where source = 'MOVER';
alter table organization enable trigger organization_no_delete;

insert into authz_change(person_id, source) values (null, 'organization:structure');

alter table organization drop constraint organization_source_check;
alter table organization add constraint organization_source_check check (source in ('LOCAL', 'HR'));

comment on column organization.source is 'LOCAL = created in TMRKZ · HR = mirrored from the HR snapshot (V3). (MOVER, V65, was removed by V66: TMRKZ does not use MOVER''s database.)';
