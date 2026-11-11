-- V33: «إضافة مستخدم» to a unit, as in TNQL's access workspace (owner, 11 Nov 2026; ADR-049).
-- A person is placed in a unit's permission matrix with NO role: the row appears empty and the access manager ticks cells
-- afterwards. The person is either found in the HR mirror (already inside the manager's reach; acting when posted elsewhere)
-- or added by User ID without HR: a LOCAL person (employee_no 'USER-<login>') whose first directory sign-in under that login
-- is linked to it. An entry grants nothing by itself; it only makes the person a member of the unit for the matrix and the
-- manager's directory. Ending an entry never ends a grant. Every change is in audit_event (UNIT_MEMBER_ADDED / _ENDED,
-- LOCAL_USER_CREATED).
create table unit_member (
  id               uuid primary key,
  person_id        uuid not null references person(id),
  organization_id  uuid not null references organization(id),
  acting           boolean not null default false,
  added_by         uuid not null references person(id),
  added_at         timestamptz not null,
  ended_at         timestamptz,
  ended_by         uuid references person(id),
  ended_reason     text,
  check (ended_at is null or ended_at >= added_at),
  check ((ended_at is null) = (ended_by is null))
);
create unique index unit_member_current on unit_member(person_id, organization_id) where ended_at is null;
create index unit_member_org on unit_member(organization_id) where ended_at is null;

-- The first directory sign-in of such a User ID links to it with its own method (IdentityService.localUser).
alter table identity_link drop constraint identity_link_method_check;
alter table identity_link add constraint identity_link_method_check
  check (method in ('ENTERPRISE_KEY', 'ADMINISTRATOR', 'BOOTSTRAP', 'PLATFORM', 'LOCAL_USER'));
