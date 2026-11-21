-- V65 (owner, 21 Nov 2026; ADR-097 «استيراد وحدات MOVER»): the migration center accepts a SQLite upload of an older
-- MOVER installation and brings its units into TMRKZ's organization tree. A unit row imported from MOVER records
-- source='MOVER' and source_external_id=<MOVER unit id>, so re-importing is idempotent and conflicts can be reported
-- per record. This migration adds 'MOVER' to the organization.source check constraint; no row is created here.

alter table organization drop constraint organization_source_check;
alter table organization add constraint organization_source_check
  check (source in ('LOCAL', 'HR', 'MOVER'));

comment on column organization.source is 'LOCAL = created in TMRKZ · HR = mirrored from the HR snapshot (V3) · MOVER = imported from a MOVER SQLite upload (ADR-097, V65). The pair (source, source_external_id) is unique per source.';
