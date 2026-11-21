-- V64 (ADR-095 continuation, owner approvals 21 Nov 2026):
--
--   B2  — replace per-owning-unit unit_fyi_target with a flat organisation-wide fyi_designation(unit_id,
--         include_descendants, set_by, set_at), matching MOVER's «الجهات الرئيسية للعلم» shape. The effective FYI set
--         is the union of every entry's unit plus, when include_descendants = true, its active descendant units at
--         the moment of distribution. The admin maintains this list once; every finally-approved request after the
--         change uses it.
--   B4  — fyi_designation changes write audit events (ACCESS_FYI_DESIGNATION_SET / _REMOVED).
--   Q3  — delete the legacy MOVER facility roles (REQUESTER, FACILITIES_REVIEWER, ORG_MANAGER, APPROVER, LIMITED_VIEWER)
--         outright. V49 had emptied them for the test environment under a legacy-facility-roles profile; the owner's
--         21 Nov 2026 answer to the artifact's Q3 removes them permanently.
--   D5b — every legacy request stuck at APPROVED_NOT_ACTIVATED gets marked MIGRATION_REQUIRED so an administrator
--         reviews each one. The server does not replay an old decision against today's register.
--
-- unit_fyi_target was introduced by V62 as an interim shape and nobody has configured it yet; we drop it outright and
-- let V64 install the final shape. The migration bypasses the user triggers the same way V62 does.

set local session_replication_role = replica;

-- ---- 1. drop the interim table from V62 ---------------------------------------------------------------------
drop table if exists unit_fyi_target cascade;

-- ---- 2. install the final shape (B2) ------------------------------------------------------------------------
create table fyi_designation (
  id                   uuid primary key default gen_random_uuid(),
  unit_id              uuid not null references organization(id),
  include_descendants  boolean not null default false,
  set_by               uuid references person(id),
  set_at               timestamptz not null default now(),
  constraint fyi_designation_unique unique (unit_id, include_descendants)
);

create index fyi_designation_unit_idx on fyi_designation(unit_id);

comment on table fyi_designation is 'ADR-095 B2: the flat organisation-wide list of FYI recipients. The effective set at activation time is the union of each row''s unit plus (when include_descendants = true) its active descendant units. Maintained by SYSTEM_ADMIN organisation-wide and by UNIT_ACCESS_MANAGER within their scope (ADR-095 B3). Changes audited as ACCESS_FYI_DESIGNATION_SET / _REMOVED.';

-- ---- 3. legacy MOVER facility roles — DELETE (Q3) ----------------------------------------------------------
create temporary table adr095_legacy_facility_roles(code text primary key) on commit drop;
insert into adr095_legacy_facility_roles(code) values
  ('REQUESTER'),
  ('FACILITIES_REVIEWER'),
  ('ORG_MANAGER'),
  ('APPROVER'),
  ('LIMITED_VIEWER');

create temporary table adr095c_ended (kind text, id uuid, role_code text, person_id uuid, organization_id uuid) on commit drop;

with d as (
  update delegation g set revoked_at = now(),
         revoke_reason = 'حُذف دور «' || m.role_code || '» بقرار المالك (ADR-095 Q3، ترحيل V64): دور مرافق قديم لم يعد مُستخدماً'
    from membership m
   where m.id = g.membership_id and m.role_code in (select code from adr095_legacy_facility_roles)
     and g.revoked_at is null and g.valid_to > now()
  returning g.id, m.role_code, g.delegate_id, m.organization_id)
insert into adr095c_ended select 'DELEGATION', id, role_code, delegate_id, organization_id from d;

with m as (
  update membership set valid_to = greatest(now(), valid_from + interval '1 second'),
         ended_reason = 'حُذف دور مرافق قديم بقرار المالك (ADR-095 Q3، ترحيل V64)'
   where role_code in (select code from adr095_legacy_facility_roles) and (valid_to is null or valid_to > now())
  returning id, role_code, person_id, organization_id)
insert into adr095c_ended select 'MEMBERSHIP', id, role_code, person_id, organization_id from m;

with u as (
  update unit_grant set valid_to = greatest(now(), valid_from + interval '1 second'), ended_by = granted_by,
         ended_reason = 'حُذف دور مرافق قديم بقرار المالك (ADR-095 Q3، ترحيل V64)'
   where role_code in (select code from adr095_legacy_facility_roles) and (valid_to is null or valid_to > now())
  returning id, role_code, organization_id)
insert into adr095c_ended select 'UNIT_GRANT', id, role_code, null, organization_id from u;

with p as (
  update duty_permit set ended_at = now(), ended_by = issued_by,
         end_reason = 'حُذف دور مرافق قديم بقرار المالك (ADR-095 Q3، ترحيل V64)'
   where role_code in (select code from adr095_legacy_facility_roles) and ended_at is null
  returning id, role_code, person_id, organization_id)
insert into adr095c_ended select 'DUTY_PERMIT', id, role_code, person_id, organization_id from p;

with s as (
  update position_seat set active = false
   where role_code in (select code from adr095_legacy_facility_roles) and active
  returning id, role_code, organization_id)
insert into adr095c_ended select 'POSITION_SEAT', id, role_code, null, organization_id from s;

-- drop the codes from every remaining role's grantable_roles
update role_def
   set grantable_roles = coalesce((
         select array_agg(g order by n)
           from unnest(grantable_roles) with ordinality as t(g, n)
          where g not in (select code from adr095_legacy_facility_roles)), '{}')
 where exists (select 1 from unnest(grantable_roles) as g(name) where g.name in (select code from adr095_legacy_facility_roles));

delete from delegation
 where membership_id in (select id from membership where role_code in (select code from adr095_legacy_facility_roles));
delete from membership_scope_target
 where membership_id in (select id from membership where role_code in (select code from adr095_legacy_facility_roles));
delete from membership
 where role_code in (select code from adr095_legacy_facility_roles);
delete from unit_grant
 where role_code in (select code from adr095_legacy_facility_roles);
delete from duty_permit
 where role_code in (select code from adr095_legacy_facility_roles);
delete from position_seat
 where role_code in (select code from adr095_legacy_facility_roles);
delete from access_request_offer
 where role_code in (select code from adr095_legacy_facility_roles);
do $$ begin
  if exists (select 1 from information_schema.tables where table_name = 'provider_unit') then
    execute 'delete from provider_unit where role_code in (select code from adr095_legacy_facility_roles)';
  end if;
end $$;

delete from role_def
 where code in (select code from adr095_legacy_facility_roles);

-- prune every stored policy version so a restore cannot bring any of them back
update access_policy_version v
   set roles = (
     select coalesce(jsonb_agg(filtered order by n), '[]'::jsonb)
       from jsonb_array_elements(v.roles) with ordinality as t(role, n)
      cross join lateral (select case
        when role->>'code' in (select code from adr095_legacy_facility_roles) then null
        else jsonb_set(role, '{grantableRoles}', coalesce((
                 select jsonb_agg(g order by i)
                   from jsonb_array_elements_text(case when jsonb_typeof(role->'grantableRoles') = 'array' then role->'grantableRoles' else '[]'::jsonb end) with ordinality as gt(g, i)
                  where g not in (select code from adr095_legacy_facility_roles)), '[]'::jsonb))
      end as filtered) f
      where filtered is not null)
 where jsonb_typeof(v.roles) = 'array';

-- ---- 4. mark every legacy APPROVED_NOT_ACTIVATED request as MIGRATION_REQUIRED (D5b) ------------------------
-- The one-transaction final approval of the new flow never writes APPROVED_NOT_ACTIVATED. Every row still carrying
-- that state is a legacy two-step case the server must not replay against today's register. An administrator reviews
-- each one; a new request is submitted when the move still applies. The original state is kept in the audit detail
-- so nothing is lost. The state check constraint is widened first so the UPDATE can set the new value.
alter table restationing_request drop constraint restationing_request_state_check;
alter table restationing_request add constraint restationing_request_state_check
  check (state in ('DRAFT', 'UNDER_REVIEW', 'RETURNED_FOR_CHANGES', 'PAUSED_HIERARCHY_CHANGED',
                   'REJECTED', 'APPROVED_NOT_ACTIVATED', 'CANCELLATION_PENDING', 'CANCELLED_BEFORE_ACTIVATION',
                   'ACTIVATED_PERMANENT', 'TEMPORARY_SCHEDULED', 'START_HELD_PENDING_CANCELLATION', 'ACTIVE_TEMPORARY',
                   'TEMPORARY_RETURNED', 'TEMPORARY_CANCELLED_BEFORE_START', 'TEMPORARY_WINDOW_EXPIRED_WITHOUT_START',
                   'EXTENSION_ACTIVATED', 'LAPSED_NOT_ACTIVATED', 'MIGRATION_REQUIRED'));
with legacy as (
  select id, number, state from restationing_request where state = 'APPROVED_NOT_ACTIVATED'
), updated as (
  update restationing_request set state = 'MIGRATION_REQUIRED', updated_at = now(), version = version + 1
   where state = 'APPROVED_NOT_ACTIVATED'
  returning id, number
)
insert into audit_event(action, entity_type, entity_id, entity_label, detail, reason)
select 'RESTATIONING_MARKED_MIGRATION_REQUIRED', 'RESTATIONING_REQUEST', u.id::text, u.number,
       jsonb_build_object(
         'migration', 'V64', 'decision', 'ADR-095 D5b',
         'previousState', 'APPROVED_NOT_ACTIVATED',
         'newState', 'MIGRATION_REQUIRED',
         'reason', 'طلب علق في APPROVED_NOT_ACTIVATED قبل قرار المالك 21 نوفمبر 2026 (ADR-095). يُراجَع يدوياً.'),
       'طلب علق تحت نظام التفعيل المنفصل القديم — قرار المالك 21 نوفمبر 2026 (ADR-095 D5b)'
  from updated u;

-- ---- 5. one audit event names the whole V64 action ---------------------------------------------------------
insert into audit_event(action, entity_type, entity_id, entity_label, detail, reason)
select 'ACCESS_V64_APPLIED', 'POLICY', 'V64', 'ADR-095 FYI designation + legacy cleanup',
       jsonb_build_object(
         'migration', 'V64', 'decision', 'ADR-095 B2/B4/Q3/D5b',
         'droppedTable', 'unit_fyi_target',
         'newTable', 'fyi_designation',
         'deletedLegacyFacilityRoles', (select jsonb_agg(code order by code) from adr095_legacy_facility_roles),
         'markedMigrationRequired', (select count(*) from restationing_request where state = 'MIGRATION_REQUIRED'),
         'legacyGrantsEnded', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'id', id, 'role', role_code,
                                                                             'person', person_id, 'organization', organization_id)
                                          order by kind, role_code, id) from adr095c_ended), '[]')),
       'إعداد توزيع «للعلم» التنظيمي، وحذف أدوار المرافق القديمة، ووسم الطلبات العالقة — قرار المالك 21 نوفمبر 2026 (ADR-095)';

insert into authz_change(person_id, source) values (null, 'V64:grants');
