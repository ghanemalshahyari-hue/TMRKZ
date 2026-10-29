-- V6: open tasks can be held by one person. After a transfer or departure, the sole remaining holder of the task's role
-- and scope is assigned the task; with none or several, the task waits for the organisation's access manager, who
-- assigns it to one person from the authorised list (owner brief §5).
alter table task_assignment add column assigned_person_id uuid references person(id);
alter table task_assignment add column awaiting_assignment boolean not null default false;
alter table execution_task add column assigned_person_id uuid references person(id);
alter table execution_task add column awaiting_assignment boolean not null default false;

alter table task_reassignment add column assigned_person_id uuid references person(id);
alter table task_reassignment add column resolution_reason text;
alter table task_reassignment drop constraint task_reassignment_outcome_check;
alter table task_reassignment add constraint task_reassignment_outcome_check
  check (outcome in ('SOLE_SUBSTITUTE', 'ROUTED_TO_ACCESS_MANAGER', 'POOL_CONTINUES'));
create index task_reassignment_org_idx on task_reassignment(routed_to_org) where resolved_at is null;
