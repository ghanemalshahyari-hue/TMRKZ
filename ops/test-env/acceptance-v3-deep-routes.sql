-- FICTIONAL ACCEPTANCE DATA for Stationing V3 routes from L8, L9 and L10 (owner, 4 Nov 2026: fictional acceptance data
-- for L8/L9/L10 so that 3–5-stage routes are seen in the real application). Run only through
-- ops/test-env/provision-acceptance-v3-deep-routes.sh. Idempotent. Four fictional people in the fictional HR mirror
-- (the same shape as ops/test-env/seed.sql, so the directory sign-in links them), each with exactly one single-action
-- acceptance role: a requester for the building-projects branch (L8, covering its L9 and L10 units) and the approver
-- seat of each of L8, L9 and L10. The L7 (إدارة المشاريع) and L6 seats already exist. No level, policy, stationing,
-- boundary or terrain is changed.
\set ON_ERROR_STOP on
begin;

do $$
begin
  if coalesce(shobj_description((select oid from pg_database where datname = current_database()), 'pg_database'), '') not like 'ACCEPTANCE%' then
    raise exception 'refused: the database is not labelled ACCEPTANCE';
  end if;
  if (select count(*) from organization o join hr_unit h on h.external_id = o.source_external_id
       join hr_snapshot s on s.id = h.snapshot_id and s.status = 'PUBLISHED'
      where o.code in ('HR-T-PM-1', 'HR-T-PM-1-1', 'HR-T-PM-1-1-1') and h.level is not null) <> 3 then
    raise exception 'refused: the L8–L10 HR units or their levels are missing';
  end if;
end $$;

create temp table provisioned(item text primary key, n integer) on commit drop;
create temp table t_deep(uid text, emp text, name text, unit text, role text) on commit drop;
insert into t_deep values
  ('t.requester.pm', 'T-0012', 'مقدم طلب — مشاريع المباني (بيانات قبول وهمية)', 'HR-T-PM-1', 'ACC_V3_RESTATIONING_REQUESTER'),
  ('t.seat.l8', 'T-0013', 'معتمد المستوى L8 — قسم مشاريع المباني (بيانات قبول وهمية)', 'HR-T-PM-1', 'ACC_V3_UNIT_APPROVER'),
  ('t.seat.l9', 'T-0014', 'معتمد المستوى L9 — وحدة الصيانة الإدارية (بيانات قبول وهمية)', 'HR-T-PM-1-1', 'ACC_V3_UNIT_APPROVER'),
  ('t.seat.l10', 'T-0015', 'معتمد المستوى L10 — فريق مرافق الشمال (بيانات قبول وهمية)', 'HR-T-PM-1-1-1', 'ACC_V3_UNIT_APPROVER');

with snap as (select id from hr_snapshot where status = 'PUBLISHED' order by published_at desc limit 1),
     ins as (
       insert into hr_person(snapshot_id, external_id, employee_number, domain_account, full_name, unit_external_id, status_text, active)
       select (select id from snap), 'P-' || d.uid, d.emp, d.uid, d.name, o.source_external_id, 'في الخدمة', true
         from t_deep d join organization o on o.code = d.unit
       on conflict do nothing
       returning 1)
insert into provisioned select 'hr_people_added', count(*) from ins;

with ins as (
  insert into person(id, employee_no, display_name, username, status, source, source_external_id)
  select md5('t:person:' || uid)::uuid, emp, name, uid, 'ACTIVE', 'HR', 'P-' || uid from t_deep
  on conflict do nothing
  returning 1)
insert into provisioned select 'people_added', count(*) from ins;

with ins as (
  insert into affiliation(id, person_id, organization_id, valid_from)
  select md5('t:aff:' || d.uid)::uuid, md5('t:person:' || d.uid)::uuid, o.id, '2026-01-01T00:00:00Z'
    from t_deep d join organization o on o.code = d.unit
  on conflict do nothing
  returning 1)
insert into provisioned select 'affiliations_added', count(*) from ins;

with ins as (
  insert into membership(id, person_id, organization_id, role_code, position_title, valid_from, follows_affiliation)
  select gen_random_uuid(), md5('t:person:' || d.uid)::uuid, o.id, d.role, 'بيانات قبول وهمية — مسارات L8–L10 (Stationing V3)', now(), false
    from t_deep d join organization o on o.code = d.unit
   where not exists (select 1 from membership m where m.person_id = md5('t:person:' || d.uid)::uuid and m.organization_id = o.id
                       and m.role_code = d.role and m.valid_to is null)
  returning 1)
insert into provisioned select 'seats_and_roles_added', count(*) from ins;

insert into audit_event(actor_person_id, actor_name, action, entity_type, entity_id, entity_label, detail, reason)
select null, 'النظام', 'ACCEPTANCE_DATA_PROVISIONED', 'ACCEPTANCE_DATA', 'stationing-v3-deep-routes', 'بيانات قبول وهمية — مسارات L8–L10',
       (select jsonb_object_agg(item, n) from provisioned), 'قرار المالك (4 نوفمبر 2026): مسارات من 3 إلى 5 مراحل في التطبيق الحقيقي'
 where :'apply' = 'on' and (select sum(n) from provisioned) > 0;

select item || '=' || n from provisioned order by item;
select d.uid || ' → ' || m.role_code || ' @ ' || o.code
  from t_deep d join person p on p.username = d.uid join membership m on m.person_id = p.id and m.valid_to is null
  join organization o on o.id = m.organization_id order by d.uid;

\if :apply
commit;
\else
rollback;
\endif
