-- V46 (owner decision, 17 Nov 2026; ADR-070): «مدير النظام» may submit «طلب إعادة تمركز» for any unit.
--
-- The protected system role (V2: configuration, access, facilities, source identifiers; never reading request content or
-- deciding) gains exactly one operational right, CREATE_RESTATIONING, over its existing ALL scope. The request still belongs to
-- the unit it is made for (requesting_unit_id) and goes through the approvals like anyone's; the administrator is recorded as
-- its submitter and, as every requester, never decides it. Initial stationing, deployment areas and site registration stay
-- with their own roles.
--
-- The system role is outside policy publication (AccessPolicyService skips it and refuses a draft that changes it), so it is
-- changed here, as V2 did; a fresh installation seeds it with the right (Bootstrap). An open draft carries the same definition,
-- so its impact check keeps matching the live role (a new draft copies the live roles). Published versions are immutable (a
-- trigger refuses any change) and stay as they were published: the system role was never theirs to change.
update role_def
   set permissions = array_append(permissions, 'CREATE_RESTATIONING'), updated_at = now()
 where code = 'SYSTEM_ADMIN' and system and not ('CREATE_RESTATIONING' = any(permissions));

update access_policy_version v
   set roles = (select jsonb_agg(case
                                     when e->>'code' = 'SYSTEM_ADMIN' and not coalesce(e->'permissions', '[]'::jsonb) ? 'CREATE_RESTATIONING'
                                         then jsonb_set(e, '{permissions}', coalesce(e->'permissions', '[]'::jsonb) || '["CREATE_RESTATIONING"]'::jsonb)
                                     else e end
                                 order by n)
                  from jsonb_array_elements(v.roles) with ordinality as t(e, n))
 where v.status = 'DRAFT'
   and jsonb_typeof(v.roles) = 'array'
   and exists (select 1 from jsonb_array_elements(v.roles) e
                where e->>'code' = 'SYSTEM_ADMIN' and not coalesce(e->'permissions', '[]'::jsonb) ? 'CREATE_RESTATIONING');
