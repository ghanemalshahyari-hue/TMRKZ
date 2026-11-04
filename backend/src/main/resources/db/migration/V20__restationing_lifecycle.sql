-- Stationing V3: the remaining lifecycle of a re-stationing request (owner-approved model kept by V3:
-- docs/STATIONING_DOMAIN_MODEL_V2_AR.md §4.6–4.7, D9, D10, D12, D16, A4, A5, A6; plan
-- docs/audit/stationing-v3-production/LIFECYCLE_PLAN.md). Schema only: no rows are written, no existing row changes.
--   * an extension is its own request (kind EXTENSION) of a temporary one, approved by the normal workflow and activated
--     separately;
--   * cancellation before activation, cancellation before the start of an activated temporary and early return are
--     linked actions, each asked by one human and decided by another;
--   * a temporary record whose start is held by a pending cancellation is out of "in force" but still holds its ground.

-- 1. request kinds and states -------------------------------------------------------------------------------------
alter table restationing_request drop constraint restationing_request_kind_check;
alter table restationing_request add constraint restationing_request_kind_check
  check (kind in ('PERMANENT', 'TEMPORARY', 'EXTENSION'));

alter table restationing_request drop constraint restationing_request_state_check;
alter table restationing_request add constraint restationing_request_state_check
  check (state in ('DRAFT', 'UNDER_REVIEW', 'RETURNED_FOR_CHANGES', 'PAUSED_HIERARCHY_CHANGED', 'REJECTED',
                   'APPROVED_NOT_ACTIVATED', 'CANCELLATION_PENDING', 'CANCELLED_BEFORE_ACTIVATION',
                   'ACTIVATED_PERMANENT', 'TEMPORARY_SCHEDULED', 'START_HELD_PENDING_CANCELLATION', 'ACTIVE_TEMPORARY',
                   'TEMPORARY_RETURNED', 'TEMPORARY_CANCELLED_BEFORE_START', 'TEMPORARY_WINDOW_EXPIRED_WITHOUT_START',
                   'EXTENSION_ACTIVATED', 'LAPSED_NOT_ACTIVATED'));

-- the activated states carry the activation (an activated extension carries its parent's site)
alter table restationing_request drop constraint restationing_request_check3;
alter table restationing_request add constraint restationing_request_activated_check
  check (state not in ('ACTIVATED_PERMANENT', 'TEMPORARY_SCHEDULED', 'START_HELD_PENDING_CANCELLATION', 'ACTIVE_TEMPORARY',
                       'TEMPORARY_RETURNED', 'TEMPORARY_CANCELLED_BEFORE_START', 'TEMPORARY_WINDOW_EXPIRED_WITHOUT_START',
                       'EXTENSION_ACTIVATED')
         or activated_at is not null);

-- an extension belongs to one temporary request; only an extension has a parent
alter table restationing_request add column parent_request_id uuid references restationing_request(id);
alter table restationing_request add constraint restationing_request_parent_check
  check ((kind = 'EXTENSION') = (parent_request_id is not null));
alter table restationing_request add column lapsed_at timestamptz;
alter table restationing_request add column lapse_reason text;
alter table restationing_request add constraint restationing_request_lapse_check
  check ((state = 'LAPSED_NOT_ACTIVATED') = (lapsed_at is not null and lapse_reason is not null));
create index restationing_request_parent_idx on restationing_request(parent_request_id) where parent_request_id is not null;

drop index restationing_request_due_idx;
create index restationing_request_due_idx on restationing_request(state, start_at, end_at)
  where state in ('TEMPORARY_SCHEDULED', 'START_HELD_PENDING_CANCELLATION', 'ACTIVE_TEMPORARY');

-- 2. linked actions: asked by one human, decided by another (D9/D16, A4/A6, D12) -------------------------------------
create table restationing_action (
  id                 uuid primary key,
  request_id         uuid not null references restationing_request(id),
  kind               text not null check (kind in ('PRE_ACTIVATION_CANCELLATION', 'BEFORE_START_CANCELLATION', 'EARLY_RETURN')),
  state              text not null check (state in ('REQUESTED', 'APPROVED', 'REJECTED', 'NO_LONGER_ACTIONABLE', 'SUPERSEDED')),
  requested_by       uuid not null references person(id),
  requested_at       timestamptz not null,
  reason             text not null check (length(btrim(reason)) >= 5),
  resume_state       text,                                   -- the request state restored when a cancellation is rejected
  decided_by         uuid references person(id),
  decided_at         timestamptz,
  decision_reason    text,
  via_delegation     uuid,
  held_at            timestamptz,                            -- A6: the start was held while this was pending
  closed_at          timestamptz,
  close_reason       text,
  check ((state in ('APPROVED', 'REJECTED')) = (decided_by is not null and decided_at is not null)),
  check ((state in ('NO_LONGER_ACTIONABLE', 'SUPERSEDED')) = (closed_at is not null and close_reason is not null)),
  check (decision_reason is null or length(btrim(decision_reason)) >= 5)
);
-- at most one open action per request
create unique index restationing_action_open_idx on restationing_action(request_id) where state = 'REQUESTED';
create index restationing_action_request_idx on restationing_action(request_id, requested_at);

-- 3. authoritative stationing: a held start, and a window that ended without a start (A6) -------------------------
alter table org_stationing add column start_held_at timestamptz;
alter table org_stationing add constraint org_stationing_held_check
  check (start_held_at is null or kind = 'TEMPORARY');
alter table org_stationing drop constraint org_stationing_end_reason_check;
alter table org_stationing add constraint org_stationing_end_reason_check
  check (end_reason in ('SUPERSEDED', 'CORRECTED', 'RETURNED', 'CANCELLED', 'ENDED_EARLY', 'WINDOW_EXPIRED'));
