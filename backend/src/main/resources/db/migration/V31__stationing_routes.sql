-- The approval path of each stationing request type, kept and activated on «مسار الموافقات» (owner, 7 Nov 2026; ADR-046). A version
-- is a draft until activated. A submitted request is pinned to the version in force when it was first sent, so changing a path
-- affects new requests only. Without an activated version a type follows the stationing policy's route, as before.
create table stationing_route_version (
  id            uuid primary key,
  purpose       text not null check (purpose in ('RESTATIONING', 'INITIAL_STATIONING', 'DEPLOYMENT_AREAS', 'SITE_REGISTRATION')),
  version       integer not null check (version > 0),
  status        text not null check (status in ('DRAFT', 'PUBLISHED')),
  routing       jsonb not null,
  stages        jsonb not null,
  reason        text,
  created_by    uuid not null references person(id),
  created_at    timestamptz not null,
  published_by  uuid references person(id),
  published_at  timestamptz,
  unique (purpose, version),
  check ((status = 'PUBLISHED') = (published_at is not null and published_by is not null and reason is not null))
);
create unique index stationing_route_one_draft on stationing_route_version(purpose) where status = 'DRAFT';
alter table restationing_request add column route_version_id uuid references stationing_route_version(id);
