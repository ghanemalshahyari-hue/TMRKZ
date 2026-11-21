-- V60: a monotonic revision stream for /operational-posture (ADR-094 Gate 2.5 §C).
--
-- The Site-Hub summary response derives from many tables: org_stationing (stationing records), deployment_area
-- (PRIMARY/SUB counts), restationing_request (pending indicators), site (name/code/marker/status),
-- site_geometry_version (site boundaries), organization (unit name and hierarchy). The existing authz_change log
-- (V9) covers permission-relevant changes and a subset of structure (organization.parent_id, site.parent_id,
-- site_responsibility), but it does NOT move on a site name change, a site marker move, a new site geometry
-- version, or a unit name edit. A client with a stale ETag could then be answered 304 even though the posture
-- they would see has visibly changed.
--
-- posture_change is the posture equivalent of authz_change: an append-only log of bigserial sequence ids inserted
-- by per-statement triggers on every table that feeds the posture response. max(seq) is a single btree lookup —
-- cheaper than the three max(updated_at) probes we had before — and it covers EVERY input to the response.
-- A client's ETag combines this global posture seq with the per-person authz_change seq, so a change on either
-- axis invalidates the ETag on the very next request (next-request revocation plus next-request freshness).
--
-- Triggers are after-statement so a bulk write produces one log row instead of one per affected row — the posture
-- cares about "something posture-relevant changed", not row-by-row deltas. VACUUM policy is handled by the
-- existing DB maintenance; the table is append-only with a monotone primary key so autovacuum reclaims heap for
-- any future purges of the oldest rows if ever needed. The read side only reads max(seq), never scans.

create table posture_change (
  seq         bigserial primary key,
  source      text not null,
  changed_at  timestamptz not null default now()
);

-- The posture response joins reach to many tables; a change in any of them should flip the revision. Triggers are
-- for each statement (not for each row): the log is "something posture-relevant happened in this transaction",
-- which is exactly what the ETag needs — a value that differs when the derived response would differ.
create function posture_note_shared() returns trigger language plpgsql as $$
begin
  insert into posture_change(source) values (tg_argv[0]);
  return null;
end $$;

create trigger site_posture_change after insert or update or delete on site
  for each statement execute function posture_note_shared('site');
create trigger site_geometry_posture_change after insert or delete on site_geometry_version
  for each statement execute function posture_note_shared('site_geometry_version');
create trigger organization_posture_change after insert or update or delete on organization
  for each statement execute function posture_note_shared('organization');
create trigger org_stationing_posture_change after insert or update or delete on org_stationing
  for each statement execute function posture_note_shared('org_stationing');
create trigger deployment_area_posture_change after insert or update or delete on deployment_area
  for each statement execute function posture_note_shared('deployment_area');
create trigger restationing_request_posture_change after insert or update or delete on restationing_request
  for each statement execute function posture_note_shared('restationing_request');
create trigger site_responsibility_posture_change after insert or update or delete on site_responsibility
  for each statement execute function posture_note_shared('site_responsibility');

-- Seed row so max(seq) is always well-defined (callers never need to guard against a nothing-happened-yet DB).
insert into posture_change(source) values ('V60:init');
