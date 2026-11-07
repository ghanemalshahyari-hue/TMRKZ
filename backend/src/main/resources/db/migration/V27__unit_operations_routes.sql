-- V27: «اعتماد عمليات الوحدة حسب الوقت», as in the movement programme (owner, 6 Nov 2026; ADR-042). A command may say which units
-- receive the step in which period: 07:00–15:00 one unit, after hours another. The first eligible approval closes it. The units
-- are pinned on the task when the request reaches the step, so a later edit affects new requests only.
create table unit_ops_route (
  id               uuid primary key,
  command_org_id   uuid not null references organization(id),
  name             text not null check (length(btrim(name)) >= 2),
  time_from        time not null,
  time_to          time not null,
  days             integer[] not null check (cardinality(days) > 0 and days <@ array[0, 1, 2, 3, 4, 5, 6]), -- 0 = Sunday
  active           boolean not null default true,
  created_by       uuid not null references person(id),
  created_at       timestamptz not null default now()
);
create index unit_ops_route_command_idx on unit_ops_route(command_org_id);

create table unit_ops_route_target (
  route_id         uuid not null references unit_ops_route(id) on delete cascade,
  organization_id  uuid not null references organization(id),
  primary key (route_id, organization_id)
);

alter table task_assignment add column scope_orgs uuid[];
