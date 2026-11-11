-- V36: «موروثة من الوحدة» — a role given to a unit, as TNQL's unit capabilities (owner, 11 Nov 2026; ADR-058).
-- Every current and future member of the unit (posted there in the HR mirror, or added through «إضافة مستخدم») holds the
-- role at the unit for as long as both last. Only roles that decide nothing are given this way (requesting, reading, for
-- information); an approval is always a named person's grant. A grant to a unit is ended, never deleted, and every change is
-- in audit_event (UNIT_GRANT_ADDED / UNIT_GRANT_ENDED).
create table unit_grant (
  id               uuid primary key,
  organization_id  uuid not null references organization(id),
  role_code        text not null references role_def(code),
  valid_from       timestamptz not null,
  valid_to         timestamptz,
  granted_by       uuid not null references person(id),
  ended_by         uuid references person(id),
  ended_reason     text,
  check (valid_to is null or valid_to > valid_from),
  check ((valid_to is null) = (ended_by is null))
);
create unique index unit_grant_current on unit_grant(organization_id, role_code) where valid_to is null;

-- the decision service follows: a unit grant, or a change of who is in the unit, changes what its members hold
create trigger unit_grant_authz after insert or update on unit_grant
  for each statement execute function authz_note_shared('grants');
create trigger unit_member_authz after insert or update on unit_member
  for each statement execute function authz_note_shared('grants');
