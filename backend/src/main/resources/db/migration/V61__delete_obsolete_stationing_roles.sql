-- V61 (owner deletion order, ADR-094 post-cleanup): permanently DELETE the obsolete stationing role codes
-- and the retired permission names from the policy history. This is a DELETION, not a retirement: after this
-- migration, `select code from role_def where code in (<obsolete codes>)` returns ZERO rows and no supported
-- policy-version restore can bring them back.
--
-- V49 already emptied these roles (set permissions to '{}' and renamed them "(غير مستخدم)") and ended every
-- live grant pointing at them. V60 adds the posture_change log. V61 finishes the job: it removes the empty
-- role_def rows themselves, cleans every dependent reference discovered from the real schema, and strips the
-- obsolete role objects from every stored access_policy_version so a restore cannot reintroduce them.
--
-- Three retired codes added by V49 that were held under "(مكرر — غير مستخدم)" names are included:
--   DEPLOYMENT_REQUESTER, SITE_REGISTRATION_REQUESTER, SITE_LINK_MANAGER
-- because their stated purpose was to park the partial duplicates of STATIONING_REQUESTER / MANAGE_SITE_LINKS.
-- The retired *facility* MOVER roles (REQUESTER, FACILITIES_REVIEWER, ORG_MANAGER, APPROVER, LIMITED_VIEWER)
-- stay as-is: they are still seeded by Bootstrap when the legacy-facility-roles profile is on, for the test
-- environment that exercises MOVER's facilities reservation engine — a separate concern from the stationing
-- role model this deletion addresses.

-- The obsolete codes, in one place so the dependent-cleanup SELECTs below stay in step.
create temporary table adr094_obsolete_roles(code text primary key) on commit drop;
insert into adr094_obsolete_roles(code) values
  ('RESTATIONING_REQUESTER'),
  ('STATIONING_REGISTER_OFFICER'),
  ('STATIONING_UNIT_APPROVER'),
  ('STATIONING_OPS_APPROVER'),
  ('STATIONING_FINAL_APPROVER'),
  ('DEPLOYMENT_REQUESTER'),
  ('SITE_REGISTRATION_REQUESTER'),
  ('SITE_LINK_MANAGER'),
  ('STATIONING_ACTIVATOR_NEXT');

-- 1. remove every live or historical dependent row pointing at an obsolete role (every table discovered from
--    the current schema that holds a role_code column with an FK or soft reference to role_def).
--    membership_scope_target has a trigger (V9:28, membership_scope_target_no_update) that forbids UPDATE and
--    DELETE on scope targets of granted memberships. V49 has already ENDED every membership for the banned
--    role codes (set valid_to in the past). The rows themselves are what this migration removes, and that
--    requires bypassing the user triggers for this transaction only — SET LOCAL session_replication_role =
--    replica disables user triggers AND FK triggers for the duration of this transaction.
set local session_replication_role = replica;

delete from delegation
 where membership_id in (select id from membership where role_code in (select code from adr094_obsolete_roles));
delete from membership_scope_target
 where membership_id in (select id from membership where role_code in (select code from adr094_obsolete_roles));
delete from membership
 where role_code in (select code from adr094_obsolete_roles);
delete from unit_grant
 where role_code in (select code from adr094_obsolete_roles);
delete from duty_permit
 where role_code in (select code from adr094_obsolete_roles);
delete from position_seat
 where role_code in (select code from adr094_obsolete_roles);
delete from access_request_offer
 where role_code in (select code from adr094_obsolete_roles);
-- provider_unit was added by V37; delete only if present.
do $$ begin
  if exists (select 1 from information_schema.tables where table_name = 'provider_unit') then
    execute 'delete from provider_unit where role_code in (select code from adr094_obsolete_roles)';
  end if;
end $$;
-- Stage references may name a role_code on the approval chain template.
do $$ begin
  if exists (select 1 from information_schema.columns where table_name = 'restationing_stage' and column_name = 'permission') then
    -- restationing_stage.permission stores a permission NAME, not a role code; nothing to delete there for
    -- a role-level cleanup. Retired permission names are separately handled in step 3 below.
    null;
  end if;
end $$;

-- 2. DELETE the role rows themselves. No rename, no empty permissions kept — the rows go.
delete from role_def
 where code in (select code from adr094_obsolete_roles);

-- 3. REMOVE the obsolete role objects from every stored access_policy_version so a restore cannot bring any
--    of them back. The policy versions keep their id and metadata; only the role array inside the jsonb is
--    pruned. Also strip the retired PERMISSION names from every remaining role's permissions list so a
--    restore of an old published version does not resurrect CREATE_DEPLOYMENT_REQUEST etc. either.
update access_policy_version v
   set roles = (
     select coalesce(jsonb_agg(filtered order by n), '[]'::jsonb)
       from jsonb_array_elements(v.roles) with ordinality as t(role, n)
      cross join lateral (select case
        when role->>'code' in (select code from adr094_obsolete_roles) then null
        else jsonb_set(role, '{permissions}', coalesce((
          select jsonb_agg(p order by i)
            from jsonb_array_elements_text(case when jsonb_typeof(role->'permissions') = 'array' then role->'permissions' else '[]'::jsonb end) with ordinality as pt(p, i)
           where p not in ('CREATE_INITIAL_STATIONING', 'CREATE_DEPLOYMENT_REQUEST', 'APPROVE_DEPLOYMENT_DISTANCE_EXCEPTION',
                           'DECIDE_PRE_ACTIVATION_CANCELLATION', 'ACTIVATE_TEMPORARY_EXTENSION', 'DECIDE_EARLY_RETURN',
                           'DECIDE_BEFORE_START_CANCELLATION')
        ), '[]'::jsonb))
      end as filtered) f
      where filtered is not null)
 where jsonb_typeof(v.roles) = 'array';

-- 4. one audit event describes what was removed. Nothing restores them.
insert into audit_event(action, entity_type, entity_id, entity_label, detail, reason)
select 'ACCESS_ROLES_DELETED_PERMANENTLY', 'POLICY', 'V61', 'ADR-094 role deletion',
       jsonb_build_object(
         'migration', 'V61', 'decision', 'ADR-094',
         'deletedRoleCodes', (select jsonb_agg(code order by code) from adr094_obsolete_roles),
         'retiredPermissionNames', jsonb_build_array(
           'CREATE_INITIAL_STATIONING', 'CREATE_DEPLOYMENT_REQUEST', 'APPROVE_DEPLOYMENT_DISTANCE_EXCEPTION',
           'DECIDE_PRE_ACTIVATION_CANCELLATION', 'ACTIVATE_TEMPORARY_EXTENSION', 'DECIDE_EARLY_RETURN',
           'DECIDE_BEFORE_START_CANCELLATION')),
       'حذف دائم لأدوار التمركز المتقادمة وأسماء الصلاحيات الملغاة بقرار المالك (ADR-094)';

-- 5. every holder's decisions are reconsidered next request (role_def rows deleted, policy versions pruned).
insert into authz_change(person_id, source) values (null, 'V61:grants');
