-- V63 (ADR-095 follow-up, 21 Nov 2026): the two roles whose only remaining purpose was carrying permissions
-- V49 and ADR-078 removed from the application. They have no live permission now — only VIEW — and still show
-- as matrix columns because the matrix (AccessWorkspaceService.column()) counts any non-empty permission list
-- as a column. The owner's 21 Nov 2026 correction says the matrix is EIGHT roles exactly; these two roles have
-- no function left and are deleted outright.
--
--   DISTANCE_EXCEPTION_APPROVER   (صاحب قرار استثناء المسافة) — carried APPROVE_DEPLOYMENT_DISTANCE_EXCEPTION,
--     already removed by V49 (ADR-078: the final approver decides excess with the request, no separate stage).
--   STATIONING_LIFECYCLE_DECIDER  (صاحب قرارات دورة التمركز) — carried DECIDE_PRE_ACTIVATION_CANCELLATION,
--     DECIDE_EARLY_RETURN and DECIDE_BEFORE_START_CANCELLATION, all removed by V49 (ADR-078 lets the requesting
--     unit's final approver decide its lifecycle actions).
--
-- STATIONING_EVENTS_OPERATOR stays: it carries REPLAY_STATIONING_EVENTS, a legitimate whole-system permission
-- the matrix hides automatically (WHOLE_SYSTEM check in AccessWorkspaceService).
--
-- This migration runs on the data side the same way V62 does (bypassing frozen scope-target triggers), ends any
-- live grant pointing at either role, removes their stored references and deletes the role_def rows.

create temporary table adr095b_obsolete_roles(code text primary key) on commit drop;
insert into adr095b_obsolete_roles(code) values
  ('DISTANCE_EXCEPTION_APPROVER'),
  ('STATIONING_LIFECYCLE_DECIDER');

set local session_replication_role = replica;

create temporary table adr095b_ended (kind text, id uuid, role_code text, person_id uuid, organization_id uuid) on commit drop;

with d as (
  update delegation g set revoked_at = now(),
         revoke_reason = 'أُلغي الدور «' || m.role_code || '» بقرار المالك (ADR-095 متابعة، ترحيل V63): لا صلاحيات متبقية بعد V49'
    from membership m
   where m.id = g.membership_id and m.role_code in (select code from adr095b_obsolete_roles)
     and g.revoked_at is null and g.valid_to > now()
  returning g.id, m.role_code, g.delegate_id, m.organization_id)
insert into adr095b_ended select 'DELEGATION', id, role_code, delegate_id, organization_id from d;

with m as (
  update membership set valid_to = greatest(now(), valid_from + interval '1 second'),
         ended_reason = 'أُلغي الدور بقرار المالك (ADR-095 متابعة، ترحيل V63): لا صلاحيات متبقية بعد V49'
   where role_code in (select code from adr095b_obsolete_roles) and (valid_to is null or valid_to > now())
  returning id, role_code, person_id, organization_id)
insert into adr095b_ended select 'MEMBERSHIP', id, role_code, person_id, organization_id from m;

with u as (
  update unit_grant set valid_to = greatest(now(), valid_from + interval '1 second'), ended_by = granted_by,
         ended_reason = 'أُلغي الدور بقرار المالك (ADR-095 متابعة، ترحيل V63)'
   where role_code in (select code from adr095b_obsolete_roles) and (valid_to is null or valid_to > now())
  returning id, role_code, organization_id)
insert into adr095b_ended select 'UNIT_GRANT', id, role_code, null, organization_id from u;

with p as (
  update duty_permit set ended_at = now(), ended_by = issued_by,
         end_reason = 'أُلغي الدور بقرار المالك (ADR-095 متابعة، ترحيل V63)'
   where role_code in (select code from adr095b_obsolete_roles) and ended_at is null
  returning id, role_code, person_id, organization_id)
insert into adr095b_ended select 'DUTY_PERMIT', id, role_code, person_id, organization_id from p;

with s as (
  update position_seat set active = false
   where role_code in (select code from adr095b_obsolete_roles) and active
  returning id, role_code, organization_id)
insert into adr095b_ended select 'POSITION_SEAT', id, role_code, null, organization_id from s;

-- drop the two codes from every remaining role's grantable_roles
update role_def
   set grantable_roles = coalesce((
         select array_agg(g order by n)
           from unnest(grantable_roles) with ordinality as t(g, n)
          where g not in (select code from adr095b_obsolete_roles)), '{}')
 where exists (select 1 from unnest(grantable_roles) as g(name) where g.name in (select code from adr095b_obsolete_roles));

-- clean dependent rows and delete the roles
delete from delegation
 where membership_id in (select id from membership where role_code in (select code from adr095b_obsolete_roles));
delete from membership_scope_target
 where membership_id in (select id from membership where role_code in (select code from adr095b_obsolete_roles));
delete from membership
 where role_code in (select code from adr095b_obsolete_roles);
delete from unit_grant
 where role_code in (select code from adr095b_obsolete_roles);
delete from duty_permit
 where role_code in (select code from adr095b_obsolete_roles);
delete from position_seat
 where role_code in (select code from adr095b_obsolete_roles);
delete from access_request_offer
 where role_code in (select code from adr095b_obsolete_roles);
do $$ begin
  if exists (select 1 from information_schema.tables where table_name = 'provider_unit') then
    execute 'delete from provider_unit where role_code in (select code from adr095b_obsolete_roles)';
  end if;
end $$;

delete from role_def
 where code in (select code from adr095b_obsolete_roles);

-- prune every stored policy version so a restore cannot bring either role back
update access_policy_version v
   set roles = (
     select coalesce(jsonb_agg(filtered order by n), '[]'::jsonb)
       from jsonb_array_elements(v.roles) with ordinality as t(role, n)
      cross join lateral (select case
        when role->>'code' in (select code from adr095b_obsolete_roles) then null
        else jsonb_set(role, '{grantableRoles}', coalesce((
                 select jsonb_agg(g order by i)
                   from jsonb_array_elements_text(case when jsonb_typeof(role->'grantableRoles') = 'array' then role->'grantableRoles' else '[]'::jsonb end) with ordinality as gt(g, i)
                  where g not in (select code from adr095b_obsolete_roles)), '[]'::jsonb))
      end as filtered) f
      where filtered is not null)
 where jsonb_typeof(v.roles) = 'array';

insert into audit_event(action, entity_type, entity_id, entity_label, detail, reason)
select 'ACCESS_ROLES_DELETED_PERMANENTLY', 'POLICY', 'V63', 'ADR-095 zombie-role cleanup',
       jsonb_build_object(
         'migration', 'V63', 'decision', 'ADR-095 follow-up',
         'deletedRoleCodes', (select jsonb_agg(code order by code) from adr095b_obsolete_roles),
         'reason', 'VIEW-only shells left by V49 after their stationing permissions were removed',
         'ended', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'id', id, 'role', role_code, 'person', person_id,
                                                                'organization', organization_id) order by kind, role_code, id)
                              from adr095b_ended), '[]')),
       'حذف أدوار العرض الفارغة بعد ترحيل V49 — قرار المالك 21 نوفمبر 2026 (ADR-095 متابعة)';

insert into authz_change(person_id, source) values (null, 'V63:grants');
