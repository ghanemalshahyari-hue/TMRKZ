-- V23: the workflow studio's logical flow chart (owner, 6 Nov 2026; ADR-041). A published flow keeps its place in the
-- definition's JSON; these tables hold what is resolved outside it.
--
-- A responsibility names a duty («الموافقة على المرافق»); a rule says who carries it for a part of the organisation: for
-- every unit under scope_org_id the responsible unit is responsible_org_id. The nearest rule above a unit wins, so a few
-- rules cover any number of units, and a unit can differ from its branch by a rule of its own.
create table org_responsibility (
  code        text primary key check (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name        text not null,
  created_at  timestamptz not null default now(),
  created_by  uuid references person(id)
);

create table org_responsibility_rule (
  responsibility_code text not null references org_responsibility(code) on delete cascade,
  scope_org_id        uuid not null references organization(id),
  responsible_org_id  uuid not null references organization(id),
  updated_at          timestamptz not null default now(),
  updated_by          uuid references person(id),
  primary key (responsibility_code, scope_org_id)
);

-- A step of a chart that goes to a unit is decided by those who hold the role AT that unit, whatever the reach of the role
-- (the owner's «this place is responsible»). Tasks of definitions from before the chart keep the role's reach.
alter table task_assignment add column strict_place boolean not null default false;

-- A flow that ended through a «rejected» end. Written in the engine's transaction, read when the process has ended; a
-- process that ended with no row here ended through an approved end.
create table request_flow_end (
  request_id  uuid not null references request(id),
  revision    integer not null,
  node_key    text not null,
  outcome     text not null check (outcome in ('REJECTED')),
  note        text,
  ended_at    timestamptz not null default now(),
  primary key (request_id, revision)
);
