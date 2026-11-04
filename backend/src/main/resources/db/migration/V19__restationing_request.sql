-- Stationing V3 re-stationing requests (docs/STATIONING_MODEL_V3_AR.md §1, §3, §7; ADR-033). One proposed site, the
-- units that move chosen explicitly, permanent or temporary; the policy version pinned at the first submission; the
-- requesting unit's hierarchy snapshot and the route derived from it, every earlier route kept with its decisions
-- (O-10); revisions with the facts they changed and the decisions they invalidated or carried (V2 D18); the deployment
-- areas registered on activation. Activation writes org_stationing and the outbox in the same transaction (V18).
-- Extensions, early return and cancellation before start follow with their behaviour.

create sequence restationing_request_no;

create table restationing_request (
  id                  uuid primary key,
  number              text not null unique,
  requester_id        uuid not null references person(id),
  requesting_unit_id  uuid not null references organization(id),        -- the route starts here and belongs to it (O-07)
  state               text not null check (state in ('DRAFT', 'UNDER_REVIEW', 'RETURNED_FOR_CHANGES',
                        'PAUSED_HIERARCHY_CHANGED', 'REJECTED', 'APPROVED_NOT_ACTIVATED', 'ACTIVATED_PERMANENT',
                        'TEMPORARY_SCHEDULED', 'ACTIVE_TEMPORARY', 'TEMPORARY_RETURNED', 'TEMPORARY_CANCELLED_BEFORE_START')),
  kind                text not null check (kind in ('PERMANENT', 'TEMPORARY')),
  start_at            timestamptz not null,
  end_at              timestamptz,                                       -- planned end of a temporary stationing
  reason              text not null default '',
  -- the editable content a revision snapshots: units that move, decisions on other-branch units, the proposed site
  -- geometry (copied from a site and dragged, edited or drawn), the deployment areas and written distance exceptions
  content             jsonb not null,
  policy_version      integer references stationing_policy_version(version),
  route_no            integer not null default 0,
  route_path          uuid[],                                            -- requesting unit → top when the route was derived
  hierarchy_snapshot  jsonb,
  returned            jsonb,
  paused              jsonb,
  final_approver_id   uuid references person(id),
  activated_by        uuid references person(id),
  activated_at        timestamptz,
  site_id             uuid references site(id),                         -- the site registered on activation
  created_at          timestamptz not null,
  updated_at          timestamptz not null,
  version             integer not null default 0,
  check (end_at is null or end_at > start_at),
  check (state = 'DRAFT' or policy_version is not null and route_path is not null and hierarchy_snapshot is not null),
  check ((activated_at is null) = (activated_by is null) and (activated_at is null) = (site_id is null)),
  check (state not in ('ACTIVATED_PERMANENT', 'TEMPORARY_SCHEDULED', 'ACTIVE_TEMPORARY', 'TEMPORARY_RETURNED')
         or activated_at is not null)
);
create index restationing_request_unit_idx on restationing_request(requesting_unit_id, state);
create index restationing_request_due_idx on restationing_request(state, start_at, end_at)
  where state in ('TEMPORARY_SCHEDULED', 'ACTIVE_TEMPORARY');

-- The stages of every route of a request. route_no grows when a hierarchy change rebuilds the route; earlier routes
-- stay with their decisions. A stage is decided by a human of its unit's approver seat (or, for the distance
-- exception, by the permission), never by the requester, and one human decides at most one stage of a request.
create table restationing_stage (
  id              uuid primary key,
  request_id      uuid not null references restationing_request(id),
  route_no        integer not null,
  position        integer not null,
  stage_key       text not null,
  kind            text not null check (kind in ('HIERARCHY', 'CROSS_BRANCH', 'EXCEPTION')),
  unit_id         uuid references organization(id),
  permission      text not null,
  label           text not null,
  satisfies       jsonb not null,                                        -- every condition this decision satisfies (O-03b)
  depends_on      text[] not null,
  final_stage     boolean not null,
  independent_of  text,
  mark            text check (mark in ('APPROVED', 'CARRIED')),
  decided_by      uuid references person(id),
  via_delegation  uuid references delegation(id),
  decided_at      timestamptz,
  unique (request_id, route_no, stage_key),
  unique (request_id, route_no, position),
  check ((kind = 'EXCEPTION') = (unit_id is null)),
  check ((mark is null) = (decided_by is null) and (decided_by is null) = (decided_at is null))
);

-- One row per submission: the content as submitted, the facts that changed since the previous submission, and the
-- decisions that were invalidated (with who had decided them) or carried; the checks as evaluated (terrain audit).
create table restationing_revision (
  request_id      uuid not null references restationing_request(id),
  n               integer not null check (n > 0),
  submitted_by    uuid not null references person(id),
  submitted_at    timestamptz not null,
  content         jsonb not null,
  changed         text[] not null,
  reason          text,
  invalidated     jsonb not null,
  carried         text[] not null,
  route_no        integer not null,
  policy_version  integer not null references stationing_policy_version(version),
  checks          jsonb not null,
  primary key (request_id, n)
);

-- Deployment areas of an activated request (O-13: «منطقة الانتشار الرئيسية» / «منطقة الانتشار البديلة»), in the
-- stationing context of the site registered on activation.
create table deployment_area (
  id          uuid primary key,
  request_id  uuid not null references restationing_request(id),
  site_id     uuid not null references site(id),
  role        text not null check (role in ('PRIMARY', 'ALTERNATIVE')),
  geom        geometry(Polygon, 4326) not null,
  state       text not null check (state in ('ACTIVE', 'RETIRED')),
  valid_from  timestamptz not null,
  valid_to    timestamptz,
  created_at  timestamptz not null default now(),
  unique (request_id, role),
  check (valid_to is null or valid_to >= valid_from),
  check ((state = 'RETIRED') = (valid_to is not null))
);
create index deployment_area_geom_idx on deployment_area using gist (geom) where state = 'ACTIVE';

alter table org_stationing
  add constraint org_stationing_request_fk foreign key (request_id) references restationing_request(id);
