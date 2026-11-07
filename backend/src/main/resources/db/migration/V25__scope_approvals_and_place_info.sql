-- V25: approvals found by a grant's scope, as in the movement programme (owner, 6 Nov 2026; ADR-042).
--
-- A unit target may be limited to levels of the hierarchy below it. The levels stay as levels: the units they reach are
-- worked out from the published HR snapshot, so they follow the hierarchy after every synchronisation.
alter table membership_scope_target add column levels integer[];
alter table membership_scope_target add constraint membership_scope_target_levels_check
  check (levels is null or (kind = 'ORGANIZATION' and include_descendants and cardinality(levels) > 0));

-- by_scope: the step goes to whoever's grant reaches the requesting unit, the nearest grant first.
-- independent_of_earlier: nobody who approved an earlier step of this request decides this one, nor through their delegation.
alter table task_assignment add column by_scope boolean not null default false;
alter table task_assignment add column independent_of_earlier boolean not null default false;
