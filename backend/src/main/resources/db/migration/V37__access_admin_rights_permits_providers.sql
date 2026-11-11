-- V37: the rest of TNQL's access workspace (owner, 11 Nov 2026: "finish the missing one in one go"; ADR-059).

-- 1. «مسؤول إدارة الوصول والصلاحيات»: the separate rights of a grant of a role that manages access. Null: every right (all
--    grants made before V37, and a global manager's). A delegated grant names the grant it was delegated from; it is never
--    wider than that grant, and only its issuer or a global manager edits or ends it.
alter table membership add column access_rights text[];
alter table membership add column sponsor_id uuid references membership(id);
alter table membership add constraint membership_access_rights_known check (access_rights is null or access_rights <@ array[
  'LOOKUP', 'REVIEW', 'GRANT', 'ANNEXED', 'DELEGATE', 'FINALIZE', 'DUTY', 'ROUTING', 'UNIT_OPERATIONS', 'ATTACH']::text[]);
create index membership_sponsor on membership(sponsor_id) where sponsor_id is not null;

-- 2. «تصاريح المناوبة»: a role at a unit for one duty window, issued by a holder of the DUTY right, in force only once its
--    holder activates it inside the window, and never after it ends. Additive: the unit's own approvers keep theirs.
create table duty_permit (
  id               uuid primary key,
  person_id        uuid not null references person(id),
  organization_id  uuid not null references organization(id),
  role_code        text not null references role_def(code),
  valid_from       timestamptz not null,
  valid_to         timestamptz not null,
  reason           text not null,
  issued_by        uuid not null references person(id),
  issued_at        timestamptz not null default now(),
  activated_at     timestamptz,
  ended_at         timestamptz,
  ended_by         uuid references person(id),
  end_reason       text,
  check (valid_to > valid_from),
  check (valid_to - valid_from <= interval '7 days'),
  check (person_id <> issued_by),
  check ((ended_at is null) = (ended_by is null))
);
create index duty_permit_person on duty_permit(person_id) where ended_at is null;
create index duty_permit_org on duty_permit(organization_id) where ended_at is null;
create trigger duty_permit_authz after insert or update on duty_permit
  for each statement execute function authz_note_shared('grants');

-- 3. «معتمد التوفر» per providing department: each department is a role (roles are data; ADR-018); a unit provides the
--    departments chosen here (the ATTACH right). An approver at a providing unit is «فعالة», elsewhere «احتياطية».
create table provider_unit (
  organization_id  uuid not null references organization(id),
  role_code        text not null references role_def(code),
  added_by         uuid not null references person(id),
  added_at         timestamptz not null default now(),
  primary key (organization_id, role_code)
);

-- 4. The account card: a person's access can be switched off here whatever HR says (HR keeps its own status); a local
--    account can be retired (never deleted: the audit refers to it).
alter table person add column access_disabled boolean not null default false;
alter table person add column access_disabled_reason text;
create trigger person_access_authz after update of access_disabled on person
  for each statement execute function authz_note_shared('grants');

-- 5. HR availability: a person HR marks away (leave, absence) is left out of who a step goes to and cannot act on it, but
--    still counts as appointed, so nothing is inherited past them (TNQL). Empty: available.
alter table hr_person add column leave_status text;
alter table person add column hr_unavailable text;
