-- Hierarchy units skipped inside a climbing approval step (owner decision of 16 Nov 2026, ADR-062).
-- A «hierarchy unit skipped» is one unit of the climb that had no hierarchy approver — neither its own nor an inherited one
-- covering it (ADR-058) — in a step whose flow says to pass such units (chain.skipEmpty). It is NOT a «workflow stage skipped»
-- (a whole step bypassed by its condition or carried from an earlier revision); a step may hold approved, inherited and skipped
-- units and still end. Written once, when the process reaches the step for that request revision, in the same transaction;
-- the unit's name and level are kept as they were then, so the history never depends on today's hierarchy.
create table request_route_skip (
    request_id          uuid        not null references request (id),
    revision            int         not null,
    stage_key           text        not null,
    organization_id     uuid        not null,
    organization_name   text        not null,
    organization_level  int,
    hierarchy_order     int         not null,
    reason_code         text        not null check (reason_code in ('NO_HIERARCHY_APPROVER')),
    reason_text         text        not null,
    workflow_version_id uuid,
    created_at          timestamptz not null default now(),
    primary key (request_id, revision, stage_key, organization_id)
);
create index request_route_skip_request on request_route_skip (request_id, revision);

-- The same owner decision in the stationing engine (ADR-062): a hierarchy stage whose level has no approver, own or inherited,
-- is marked SKIPPED (no decider, never an approval) so the request goes on; the history per revision keeps what was skipped.
alter table restationing_stage drop constraint restationing_stage_mark_check;
alter table restationing_stage add constraint restationing_stage_mark_check check (mark in ('APPROVED', 'CARRIED', 'SKIPPED'));
alter table restationing_stage drop constraint restationing_stage_check1;
alter table restationing_stage add constraint restationing_stage_decider_check
    check (((mark is null or mark = 'SKIPPED') = (decided_by is null)) and ((decided_by is null) = (decided_at is null)));
alter table restationing_stage add constraint restationing_stage_skip_check check (mark <> 'SKIPPED' or kind = 'HIERARCHY');

create table restationing_route_skip (
    request_id         uuid        not null references restationing_request (id),
    revision           int         not null,
    route_no           int         not null,
    stage_key          text        not null,
    organization_id    uuid        not null,
    organization_name  text        not null,
    organization_level int,
    hierarchy_order    int         not null,
    reason_code        text        not null check (reason_code in ('NO_HIERARCHY_APPROVER')),
    reason_text        text        not null,
    policy_version     int,
    created_at         timestamptz not null default now(),
    primary key (request_id, revision, stage_key)
);
