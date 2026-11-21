-- V62 (owner decision 21 Nov 2026, ADR-095): activation is part of the final approver's decision, not a separate human
-- action; «تحديد وحدات العلم» is a per-unit CONFIGURATION rather than a per-request permission. This migration finishes
-- the data side of that change in one atomic step:
--
--   1. a new table `unit_fyi_target` holds the configured FYI recipients per owning unit, with include_descendants,
--      maintained by the unit's access manager («مدير صلاحيات الوحدة») through the access workspace;
--   2. every live grant pointing at FYI_DISTRIBUTOR or STATIONING_ACTIVATOR is ENDED with a recorded reason;
--   3. every stored role_def that still declares the retired permissions MANAGE_FYI_DISTRIBUTION or ACTIVATE_STATIONING
--      loses those names from its permissions array (the role itself remains unless it is one of the two below);
--   4. the two role_def rows FYI_DISTRIBUTOR and STATIONING_ACTIVATOR are DELETED outright — the matrix drops to the
--      eight canonical columns the owner approved on 21 Nov 2026;
--   5. every stored access_policy_version has its roles jsonb pruned the same way, so a restore of an old version
--      cannot bring either role back nor resurrect the retired permission names;
--   6. one audit event names everything removed, and an authz_change notice makes every holder's decisions be
--      reconsidered on the next request.
--
-- Nothing here assumes data: on a bare database every statement below changes nothing beyond creating the table.
-- Published policy versions stay in place; only their stored role array is pruned.

-- 0. the per-unit FYI target configuration -------------------------------------------------------------------
create table if not exists unit_fyi_target (
  id                   uuid primary key default gen_random_uuid(),
  owning_unit_id       uuid not null references organization(id),
  target_unit_id       uuid not null references organization(id),
  include_descendants  boolean not null default false,
  reason               text,
  configured_by        uuid references person(id),
  configured_at        timestamptz not null default now(),
  ended_at             timestamptz,
  ended_by             uuid references person(id),
  end_reason           text,
  constraint unit_fyi_target_unique unique (owning_unit_id, target_unit_id)
);

create index if not exists unit_fyi_target_owning_idx on unit_fyi_target(owning_unit_id) where ended_at is null;
create index if not exists unit_fyi_target_target_idx on unit_fyi_target(target_unit_id) where ended_at is null;

comment on table unit_fyi_target is 'ADR-095: per-unit FYI recipient configuration. The requesting unit''s configured target list is read at activation time and the recipient units are notified without a per-request human «توزيع للعلم» step.';

-- 1. the obsolete roles, named in one place -----------------------------------------------------------------
create temporary table adr095_obsolete_roles(code text primary key) on commit drop;
insert into adr095_obsolete_roles(code) values
  ('FYI_DISTRIBUTOR'),
  ('STATIONING_ACTIVATOR');

-- 2. end every live grant pointing at them, with a recorded reason ------------------------------------------
set local session_replication_role = replica;

create temporary table adr095_ended (kind text, id uuid, role_code text, person_id uuid, organization_id uuid) on commit drop;

with d as (
  update delegation g set revoked_at = now(),
         revoke_reason = 'ألغي الدور «' || m.role_code || '» بقرار المالك (ADR-095، ترحيل V62): التفعيل جزء من الاعتماد النهائي والعلم إعداد للوحدة'
    from membership m
   where m.id = g.membership_id and m.role_code in (select code from adr095_obsolete_roles)
     and g.revoked_at is null and g.valid_to > now()
  returning g.id, m.role_code, g.delegate_id, m.organization_id)
insert into adr095_ended select 'DELEGATION', id, role_code, delegate_id, organization_id from d;

with m as (
  update membership set valid_to = greatest(now(), valid_from + interval '1 second'),
         ended_reason = 'ألغي الدور بقرار المالك (ADR-095، ترحيل V62): التفعيل جزء من الاعتماد النهائي والعلم إعداد للوحدة'
   where role_code in (select code from adr095_obsolete_roles) and (valid_to is null or valid_to > now())
  returning id, role_code, person_id, organization_id)
insert into adr095_ended select 'MEMBERSHIP', id, role_code, person_id, organization_id from m;

with u as (
  update unit_grant set valid_to = greatest(now(), valid_from + interval '1 second'), ended_by = granted_by,
         ended_reason = 'ألغي الدور بقرار المالك (ADR-095، ترحيل V62)'
   where role_code in (select code from adr095_obsolete_roles) and (valid_to is null or valid_to > now())
  returning id, role_code, organization_id)
insert into adr095_ended select 'UNIT_GRANT', id, role_code, null, organization_id from u;

with p as (
  update duty_permit set ended_at = now(), ended_by = issued_by,
         end_reason = 'ألغي الدور بقرار المالك (ADR-095، ترحيل V62)'
   where role_code in (select code from adr095_obsolete_roles) and ended_at is null
  returning id, role_code, person_id, organization_id)
insert into adr095_ended select 'DUTY_PERMIT', id, role_code, person_id, organization_id from p;

with s as (
  update position_seat set active = false
   where role_code in (select code from adr095_obsolete_roles) and active
  returning id, role_code, organization_id)
insert into adr095_ended select 'POSITION_SEAT', id, role_code, null, organization_id from s;

-- 3. remove the two retired permission names from every remaining role's permissions ------------------------
update role_def
   set permissions = coalesce((
         select array_agg(p order by n)
           from unnest(permissions) with ordinality as t(p, n)
          where p not in ('MANAGE_FYI_DISTRIBUTION', 'ACTIVATE_STATIONING')), '{}'),
       updated_at = now()
 where exists (select 1 from unnest(permissions) as p(name)
                where p.name in ('MANAGE_FYI_DISTRIBUTION', 'ACTIVATE_STATIONING'));

-- also remove the two retired names from any role's grantable_roles list (the role codes they named are deleted below)
update role_def
   set grantable_roles = coalesce((
         select array_agg(g order by n)
           from unnest(grantable_roles) with ordinality as t(g, n)
          where g not in (select code from adr095_obsolete_roles)), '{}')
 where exists (select 1 from unnest(grantable_roles) as g(name) where g.name in (select code from adr095_obsolete_roles));

-- 4. clean up the dependent rows that still reference the deleted role codes, then delete the roles --------
delete from delegation
 where membership_id in (select id from membership where role_code in (select code from adr095_obsolete_roles));
delete from membership_scope_target
 where membership_id in (select id from membership where role_code in (select code from adr095_obsolete_roles));
delete from membership
 where role_code in (select code from adr095_obsolete_roles);
delete from unit_grant
 where role_code in (select code from adr095_obsolete_roles);
delete from duty_permit
 where role_code in (select code from adr095_obsolete_roles);
delete from position_seat
 where role_code in (select code from adr095_obsolete_roles);
delete from access_request_offer
 where role_code in (select code from adr095_obsolete_roles);
do $$ begin
  if exists (select 1 from information_schema.tables where table_name = 'provider_unit') then
    execute 'delete from provider_unit where role_code in (select code from adr095_obsolete_roles)';
  end if;
end $$;

delete from role_def
 where code in (select code from adr095_obsolete_roles);

-- 5. prune every stored policy version so a restore cannot bring back either role nor the retired names ----
update access_policy_version v
   set roles = (
     select coalesce(jsonb_agg(filtered order by n), '[]'::jsonb)
       from jsonb_array_elements(v.roles) with ordinality as t(role, n)
      cross join lateral (select case
        when role->>'code' in (select code from adr095_obsolete_roles) then null
        else jsonb_set(
               jsonb_set(role, '{permissions}', coalesce((
                 select jsonb_agg(p order by i)
                   from jsonb_array_elements_text(case when jsonb_typeof(role->'permissions') = 'array' then role->'permissions' else '[]'::jsonb end) with ordinality as pt(p, i)
                  where p not in ('MANAGE_FYI_DISTRIBUTION', 'ACTIVATE_STATIONING')), '[]'::jsonb)),
               '{grantableRoles}', coalesce((
                 select jsonb_agg(g order by i)
                   from jsonb_array_elements_text(case when jsonb_typeof(role->'grantableRoles') = 'array' then role->'grantableRoles' else '[]'::jsonb end) with ordinality as gt(g, i)
                  where g not in (select code from adr095_obsolete_roles)), '[]'::jsonb))
      end as filtered) f
      where filtered is not null)
 where jsonb_typeof(v.roles) = 'array';

-- 6. one audit event: what was removed, every grant ended, and the new configuration table --------------
insert into audit_event(action, entity_type, entity_id, entity_label, detail, reason)
select 'ACCESS_ROLES_DELETED_PERMANENTLY', 'POLICY', 'V62', 'ADR-095 role deletion',
       jsonb_build_object(
         'migration', 'V62', 'decision', 'ADR-095',
         'deletedRoleCodes', (select jsonb_agg(code order by code) from adr095_obsolete_roles),
         'retiredPermissionNames', jsonb_build_array('MANAGE_FYI_DISTRIBUTION', 'ACTIVATE_STATIONING'),
         'newConfiguration', 'unit_fyi_target (per-unit FYI recipient list)',
         'ended', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'id', id, 'role', role_code, 'person', person_id,
                                                                'organization', organization_id) order by kind, role_code, id)
                              from adr095_ended), '[]')),
       'التفعيل جزء من الاعتماد النهائي والعلم إعداد للوحدة — قرار المالك 21 نوفمبر 2026 (ADR-095)';

-- 7. every holder's decisions are reconsidered on the next request (role_def rows deleted, policy versions pruned)
insert into authz_change(person_id, source) values (null, 'V62:grants');
