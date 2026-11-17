-- V49 (owner decisions, 17 Nov 2026; ADR-078): fewer stationing permissions, fewer roles.
--
-- Actions removed from the application (ae.mover.access.Permission):
--   CREATE_INITIAL_STATIONING              initial stationing is recorded only by site setup («تهيئة المواقع», ADR-067/076)
--   CREATE_DEPLOYMENT_REQUEST              merged into CREATE_RESTATIONING («طلب إعادة التمركز ومناطق الانتشار»)
--   APPROVE_DEPLOYMENT_DISTANCE_EXCEPTION  a request beyond the range is flagged and decided by its final approver
--   DECIDE_PRE_ACTIVATION_CANCELLATION, DECIDE_BEFORE_START_CANCELLATION, DECIDE_EARLY_RETURN
--                                          started by the requesting unit's requester, decided by the unit's final approver
--   ACTIVATE_TEMPORARY_EXTENSION           an approved extension is activated with ACTIVATE_STATIONING
-- Roles (data): «مقدم الطلب» is the stationing requester (STATIONING_REQUESTER: VIEW, CREATE_RESTATIONING,
-- REQUEST_SITE_REGISTRATION); «معتمد عمليات الوحدة» also manages facilities and site links within its grant; «مدير النظام»
-- also re-sends failed stationing events. The old MOVER facilities roles and the partial duplicates of the stationing roles
-- are emptied (a role is never deleted from the policy), renamed so they cannot be mistaken for the roles in use, their grants
-- ended with this reason, and they are no longer offered for request.
--
-- Nothing here assumes data: on a new database role_def is still empty (Bootstrap seeds it after the migrations) and every
-- statement below changes nothing. Published policy versions are immutable and keep the names they were published with; the
-- application translates them when one is restored (Permission.current). The removed names may still appear in published
-- policy versions, in the stages of old requests (restationing_stage.permission) and in the audit, as history.

create function adr078_role(p_code text, p_name text, p_perms text[], p_grantable text[], p_system boolean, p_requester boolean)
    returns table (new_name text, new_perms text[], new_grantable text[]) language plpgsql immutable as $$
declare
  retired constant text[] := array['REQUESTER', 'FACILITIES_REVIEWER', 'ORG_MANAGER', 'APPROVER', 'LIMITED_VIEWER',
                                   'DEPLOYMENT_REQUESTER', 'SITE_REGISTRATION_REQUESTER', 'SITE_LINK_MANAGER'];
  v_perms text[];
  v_grantable text[];
  v_name text := p_name;
begin
  -- every role: the removed actions go; a deployment-area request is the re-stationing request's right now
  select coalesce(array_agg(x order by n), '{}') into v_perms from (
    select x, min(n) as n from (
      select case u.p when 'CREATE_DEPLOYMENT_REQUEST' then 'CREATE_RESTATIONING' else u.p end as x, u.n
        from unnest(coalesce(p_perms, '{}')) with ordinality as u(p, n)
       where u.p not in ('CREATE_INITIAL_STATIONING', 'APPROVE_DEPLOYMENT_DISTANCE_EXCEPTION', 'DECIDE_PRE_ACTIVATION_CANCELLATION',
                         'ACTIVATE_TEMPORARY_EXTENSION', 'DECIDE_EARLY_RETURN', 'DECIDE_BEFORE_START_CANCELLATION')) t
     group by x) g;
  -- an emptied role is given by nobody; «مقدم الطلب» takes the place of the facilities requester where that one was given
  select coalesce(array_agg(x order by n), '{}') into v_grantable from (
    select x, min(n) as n from (
      select case when u.g = 'REQUESTER' and p_requester then 'STATIONING_REQUESTER' else u.g end as x, u.n
        from unnest(coalesce(p_grantable, '{}')) with ordinality as u(g, n)
       where not (u.g = any(retired)) or (u.g = 'REQUESTER' and p_requester)) t
     group by x) g;
  if p_system then
    if p_code = 'SYSTEM_ADMIN' and not ('REPLAY_STATIONING_EVENTS' = any(v_perms)) then
      v_perms := array_append(v_perms, 'REPLAY_STATIONING_EVENTS');
    end if;
    return query select v_name, v_perms, v_grantable;
    return;
  end if;
  case p_code
    when 'STATIONING_REQUESTER' then
      v_name := 'مقدم الطلب';
      v_perms := array['VIEW', 'CREATE_RESTATIONING', 'REQUEST_SITE_REGISTRATION'];
    when 'UNIT_OPERATIONS_APPROVER' then
      if not ('MANAGE_FACILITIES' = any(v_perms)) then v_perms := array_append(v_perms, 'MANAGE_FACILITIES'); end if;
      if not ('MANAGE_SITE_LINKS' = any(v_perms)) then v_perms := array_append(v_perms, 'MANAGE_SITE_LINKS'); end if;
    when 'REQUESTER' then v_name := 'مقدم الطلب (مرافق — غير مستخدم)';
    when 'FACILITIES_REVIEWER' then v_name := 'مراجع المرافق (مرافق — غير مستخدم)';
    when 'ORG_MANAGER' then v_name := 'مدير الجهة (مرافق — غير مستخدم)';
    when 'APPROVER' then v_name := 'صاحب الاعتماد (مرافق — غير مستخدم)';
    when 'LIMITED_VIEWER' then v_name := 'اطلاع محدود (مرافق — غير مستخدم)';
    when 'DEPLOYMENT_REQUESTER' then v_name := 'إنشاء طلب منطقة انتشار (مكرر — غير مستخدم)';
    when 'SITE_REGISTRATION_REQUESTER' then v_name := 'طلب اعتماد موقع (مكرر — غير مستخدم)';
    when 'SITE_LINK_MANAGER' then v_name := 'ربط الوحدات بالمواقع (مكرر — غير مستخدم)';
    else null;
  end case;
  if p_code = any(retired) then
    v_perms := '{}';
    v_grantable := '{}';
  end if;
  return query select v_name, v_perms, v_grantable;
end $$;

create temporary table adr078_before on commit drop as
select code, name, permissions, grantable_roles, system from role_def;

-- 1. the roles in force ---------------------------------------------------------------------------------------------------
update role_def r
   set name = x.new_name, permissions = x.new_perms, grantable_roles = x.new_grantable, updated_at = now()
  from (select d.code, f.*
          from role_def d,
               adr078_role(d.code, d.name, d.permissions, d.grantable_roles, d.system,
                           exists (select 1 from role_def s where s.code = 'STATIONING_REQUESTER')) f) x
 where x.code = r.code
   and (r.name, r.permissions, r.grantable_roles) is distinct from (x.new_name, x.new_perms, x.new_grantable);

-- 2. the grants of the emptied roles end, with this reason ----------------------------------------------------------------
create temporary table adr078_retired on commit drop as
select code from role_def
 where code in ('REQUESTER', 'FACILITIES_REVIEWER', 'ORG_MANAGER', 'APPROVER', 'LIMITED_VIEWER',
                'DEPLOYMENT_REQUESTER', 'SITE_REGISTRATION_REQUESTER', 'SITE_LINK_MANAGER');

create temporary table adr078_ended (kind text, id uuid, role_code text, person_id uuid, organization_id uuid) on commit drop;

with d as (
  update delegation g set revoked_at = now(),
         revoke_reason = 'أُفرغ الدور «' || m.role_code || '» بقرار المالك (ADR-078، ترحيل V49)'
    from membership m
   where m.id = g.membership_id and m.role_code in (select code from adr078_retired)
     and g.revoked_at is null and g.valid_to > now()
  returning g.id, m.role_code, g.delegate_id, m.organization_id)
insert into adr078_ended select 'DELEGATION', id, role_code, delegate_id, organization_id from d;

with m as (
  update membership set valid_to = greatest(now(), valid_from + interval '1 second'),
         ended_reason = 'أُفرغ الدور بقرار المالك (ADR-078، ترحيل V49): لم يعد يُستخدم'
   where role_code in (select code from adr078_retired) and (valid_to is null or valid_to > now())
  returning id, role_code, person_id, organization_id)
insert into adr078_ended select 'MEMBERSHIP', id, role_code, person_id, organization_id from m;

with u as (
  update unit_grant set valid_to = greatest(now(), valid_from + interval '1 second'), ended_by = granted_by,
         ended_reason = 'أُفرغ الدور بقرار المالك (ADR-078، ترحيل V49): لم يعد يُستخدم — أنهاه الترحيل لا من منحه'
   where role_code in (select code from adr078_retired) and (valid_to is null or valid_to > now())
  returning id, role_code, organization_id)
insert into adr078_ended select 'UNIT_GRANT', id, role_code, null, organization_id from u;

with p as (
  update duty_permit set ended_at = now(), ended_by = issued_by,
         end_reason = 'أُفرغ الدور بقرار المالك (ADR-078، ترحيل V49): لم يعد يُستخدم — أنهاه الترحيل لا من أصدره'
   where role_code in (select code from adr078_retired) and ended_at is null
  returning id, role_code, person_id, organization_id)
insert into adr078_ended select 'DUTY_PERMIT', id, role_code, person_id, organization_id from p;

with s as (
  update position_seat set active = false
   where role_code in (select code from adr078_retired) and active
  returning id, role_code, organization_id)
insert into adr078_ended select 'POSITION_SEAT', id, role_code, null, organization_id from s;

-- 3. no longer offered for request; «مقدم الطلب» takes the facilities requester's place in the list ------------------------
insert into access_request_offer(role_code, audience, description, scope_modes, default_scope)
select 'STATIONING_REQUESTER', o.audience, null, o.scope_modes, o.default_scope
  from access_request_offer o
 where o.role_code = 'REQUESTER'
   and exists (select 1 from adr078_retired where code = 'REQUESTER')
   and exists (select 1 from role_def where code = 'STATIONING_REQUESTER')
on conflict (role_code) do nothing;

delete from access_request_offer where role_code in (select code from adr078_retired);

-- 4. the policy history: a version that says what is in force now -------------------------------------------------------
create temporary table adr078_version (id uuid, version int) on commit drop;

do $$
declare
  changed boolean;
  published uuid;
  draft uuid;
  next_version int;
  new_id uuid := gen_random_uuid();
begin
  select exists (select 1 from role_def r join adr078_before b on b.code = r.code
                  where not r.system and (r.name, r.permissions, r.grantable_roles) is distinct from (b.name, b.permissions, b.grantable_roles))
    into changed;
  select id into published from access_policy_version where status = 'PUBLISHED';
  if not changed or published is null then
    return;
  end if;
  select id, version into draft, next_version from access_policy_version where status = 'DRAFT';
  if draft is not null then
    -- the open draft keeps its place after the version recorded here
    update access_policy_version set version = (select max(version) + 1 from access_policy_version) where id = draft;
  else
    select max(version) + 1 into next_version from access_policy_version;
  end if;
  update access_policy_version set status = 'SUPERSEDED' where id = published;
  insert into access_policy_version(id, version, status, roles, note, based_on, published_at)
  values (new_id, next_version, 'PUBLISHED',
          (select jsonb_agg(jsonb_build_object('code', code, 'name', name, 'permissions', to_jsonb(permissions), 'scope', scope,
                                               'summaryOnly', summary_only, 'system', system, 'grantableRoles', to_jsonb(grantable_roles),
                                               'sortOrder', sort_order) order by sort_order, code)
             from role_def),
          'تبسيط صلاحيات التمركز وتقليص الأدوار بقرار المالك (ADR-078، ترحيل V49)', published, now());
  update role_def set policy_version = next_version;
  if draft is not null then
    update access_policy_version set based_on = new_id where id = draft;
  end if;
  insert into adr078_version values (new_id, next_version);
end $$;

-- 5. an open draft carries the same definitions, so its impact check keeps matching the roles in force --------------------
update access_policy_version v
   set roles = (select jsonb_agg(case
                  when jsonb_typeof(e) = 'object' then
                    e || (select jsonb_build_object('name', f.new_name, 'permissions', to_jsonb(f.new_perms), 'grantableRoles', to_jsonb(f.new_grantable))
                            from adr078_role(e->>'code', e->>'name',
                                             array(select jsonb_array_elements_text(case when jsonb_typeof(e->'permissions') = 'array' then e->'permissions' else '[]'::jsonb end)),
                                             array(select jsonb_array_elements_text(case when jsonb_typeof(e->'grantableRoles') = 'array' then e->'grantableRoles' else '[]'::jsonb end)),
                                             coalesce((e->>'system')::boolean, false),
                                             exists (select 1 from role_def s where s.code = 'STATIONING_REQUESTER')) f)
                  else e end order by n)
                  from jsonb_array_elements(v.roles) with ordinality as t(e, n))
 where v.status = 'DRAFT' and jsonb_typeof(v.roles) = 'array' and jsonb_array_length(v.roles) > 0;

-- 6. an old request waiting at a distance-exception stage: its final approver decides it now ------------------------------
-- (an undecided exception stage of a request still on its way is taken off its route; a decided one stays as history)
create temporary table adr078_stages on commit drop as
select s.id, s.request_id, s.route_no, s.stage_key
  from restationing_stage s join restationing_request q on q.id = s.request_id and q.route_no = s.route_no
 where s.kind = 'EXCEPTION' and s.mark is null
   and q.state in ('DRAFT', 'UNDER_REVIEW', 'RETURNED_FOR_CHANGES', 'PAUSED_HIERARCHY_CHANGED', 'CANCELLATION_PENDING');
delete from restationing_stage where id in (select id from adr078_stages);

-- 7. one audit event: what changed, and every grant ended -----------------------------------------------------------------
insert into audit_event(action, entity_type, entity_id, entity_label, detail, reason)
select 'ACCESS_ROLES_SIMPLIFIED', 'POLICY', coalesce((select id::text from adr078_version), 'V49'),
       coalesce('الإصدار ' || (select version from adr078_version), 'V49'),
       jsonb_build_object(
         'migration', 'V49', 'decision', 'ADR-078',
         'policyVersion', (select version from adr078_version),
         'roles', coalesce((select jsonb_agg(jsonb_build_object('code', r.code, 'nameBefore', b.name, 'name', r.name,
                                                                'before', to_jsonb(b.permissions), 'after', to_jsonb(r.permissions)) order by r.code)
                              from role_def r join adr078_before b on b.code = r.code
                             where (r.name, r.permissions, r.grantable_roles) is distinct from (b.name, b.permissions, b.grantable_roles)), '[]'),
         'ended', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'id', id, 'role', role_code, 'person', person_id,
                                                                'organization', organization_id) order by kind, role_code, id)
                              from adr078_ended), '[]'),
         'exceptionStagesRemoved', coalesce((select jsonb_agg(jsonb_build_object('request', request_id, 'route', route_no, 'stage', stage_key))
                                               from adr078_stages), '[]')),
       'تبسيط صلاحيات التمركز وتقليص الأدوار بقرار المالك (17 نوفمبر 2026)'
 where exists (select 1 from role_def r join adr078_before b on b.code = r.code
                where (r.name, r.permissions, r.grantable_roles) is distinct from (b.name, b.permissions, b.grantable_roles))
    or exists (select 1 from adr078_ended) or exists (select 1 from adr078_stages);

-- every holder's decisions are worked out again (the role_def trigger notes it too; a seat or a permit has no trigger of its own)
insert into authz_change(person_id, source)
select null, 'V49:grants' where exists (select 1 from adr078_ended) or exists (select 1 from adr078_stages)
    or exists (select 1 from role_def r join adr078_before b on b.code = r.code where r.permissions is distinct from b.permissions);

drop function adr078_role(text, text, text[], text[], boolean, boolean);
