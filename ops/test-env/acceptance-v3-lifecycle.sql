-- FICTIONAL ACCEPTANCE DATA for the Stationing V3 lifecycle (owner, 4 Nov 2026; ADR-034): four fictional people in the
-- fictional HR mirror (the same shape as ops/test-env/seed.sql), each holding exactly one of the four lifecycle rights
-- over the whole fictional organisation, so that every lifecycle decision is taken by another human than the one who
-- asked. Run only through ops/test-env/provision-acceptance-v3-lifecycle.sh. Idempotent. Nothing else changes.
\set ON_ERROR_STOP on
begin;

do $$
begin
  if coalesce(shobj_description((select oid from pg_database where datname = current_database()), 'pg_database'), '') not like 'ACCEPTANCE%' then
    raise exception 'refused: the database is not labelled ACCEPTANCE';
  end if;
  if (select max(version::int) from flyway_schema_history where success and version is not null) < 20 then
    raise exception 'refused: migration V20 is not applied';
  end if;
end $$;

create temp table provisioned(item text primary key, n integer) on commit drop;

-- one single-action role per lifecycle right (no VIEW, nothing else)
with ins as (
  insert into role_def(code, name, permissions, scope, summary_only, sort_order) values
    ('ACC_V3_DECIDE_PRE_ACTIVATION_CANCELLATION', 'قرار الإلغاء قبل التفعيل (بيانات قبول وهمية)', '{DECIDE_PRE_ACTIVATION_CANCELLATION}', 'ORGANIZATION', false, 964),
    ('ACC_V3_DECIDE_BEFORE_START_CANCELLATION', 'قرار إلغاء المؤقت قبل بدء نفاذه (بيانات قبول وهمية)', '{DECIDE_BEFORE_START_CANCELLATION}', 'ORGANIZATION', false, 965),
    ('ACC_V3_DECIDE_EARLY_RETURN', 'قرار العودة المبكرة (بيانات قبول وهمية)', '{DECIDE_EARLY_RETURN}', 'ORGANIZATION', false, 966),
    ('ACC_V3_ACTIVATE_TEMPORARY_EXTENSION', 'تفعيل تمديد التمركز المؤقت (بيانات قبول وهمية)', '{ACTIVATE_TEMPORARY_EXTENSION}', 'ORGANIZATION', false, 967)
  on conflict (code) do nothing
  returning 1)
insert into provisioned select 'roles_created', count(*) from ins;

create temp table t_lc(uid text, emp text, name text, role text) on commit drop;
insert into t_lc values
  ('t.lc.cancel', 'T-0016', 'صاحب قرار الإلغاء قبل التفعيل (بيانات قبول وهمية)', 'ACC_V3_DECIDE_PRE_ACTIVATION_CANCELLATION'),
  ('t.lc.start', 'T-0017', 'صاحب قرار الإلغاء قبل بدء النفاذ (بيانات قبول وهمية)', 'ACC_V3_DECIDE_BEFORE_START_CANCELLATION'),
  ('t.lc.return', 'T-0018', 'صاحب قرار العودة المبكرة (بيانات قبول وهمية)', 'ACC_V3_DECIDE_EARLY_RETURN'),
  ('t.lc.ext', 'T-0019', 'مفعّل تمديد التمركز المؤقت (بيانات قبول وهمية)', 'ACC_V3_ACTIVATE_TEMPORARY_EXTENSION');

with snap as (select id from hr_snapshot where status = 'PUBLISHED' order by published_at desc limit 1),
     ins as (
       insert into hr_person(snapshot_id, external_id, employee_number, domain_account, full_name, unit_external_id, status_text, active)
       select (select id from snap), 'P-' || d.uid, d.emp, d.uid, d.name, o.source_external_id, 'في الخدمة', true
         from t_lc d join organization o on o.code = 'HR-T-ORG'
       on conflict do nothing
       returning 1)
insert into provisioned select 'hr_people_added', count(*) from ins;

with ins as (
  insert into person(id, employee_no, display_name, username, status, source, source_external_id)
  select md5('t:person:' || uid)::uuid, emp, name, uid, 'ACTIVE', 'HR', 'P-' || uid from t_lc
  on conflict do nothing
  returning 1)
insert into provisioned select 'people_added', count(*) from ins;

with ins as (
  insert into affiliation(id, person_id, organization_id, valid_from)
  select md5('t:aff:' || d.uid)::uuid, md5('t:person:' || d.uid)::uuid, o.id, '2026-01-01T00:00:00Z'
    from t_lc d join organization o on o.code = 'HR-T-ORG'
  on conflict do nothing
  returning 1)
insert into provisioned select 'affiliations_added', count(*) from ins;

with ins as (
  insert into membership(id, person_id, organization_id, role_code, position_title, valid_from, follows_affiliation)
  select gen_random_uuid(), md5('t:person:' || d.uid)::uuid, o.id, d.role, 'بيانات قبول وهمية — دورة حياة الطلب (Stationing V3)', now(), false
    from t_lc d join organization o on o.code = 'HR-T-ORG'
   where not exists (select 1 from membership m where m.person_id = md5('t:person:' || d.uid)::uuid and m.organization_id = o.id
                       and m.role_code = d.role and m.valid_to is null)
  returning 1)
insert into provisioned select 'lifecycle_roles_granted', count(*) from ins;

insert into audit_event(actor_person_id, actor_name, action, entity_type, entity_id, entity_label, detail, reason)
select null, 'النظام', 'ACCEPTANCE_DATA_PROVISIONED', 'ACCEPTANCE_DATA', 'stationing-v3-lifecycle', 'بيانات قبول وهمية — دورة حياة الطلب',
       (select jsonb_object_agg(item, n) from provisioned), 'قرار المالك (4 نوفمبر 2026): أصحاب صلاحيات دورة الحياة في التطبيق الحقيقي'
 where :'apply' = 'on' and (select sum(n) from provisioned) > 0;

select item || '=' || n from provisioned order by item;
select d.uid || ' → ' || m.role_code || ' @ ' || o.code
  from t_lc d join person p on p.username = d.uid join membership m on m.person_id = p.id and m.valid_to is null
  join organization o on o.id = m.organization_id order by d.uid;

\if :apply
commit;
\else
rollback;
\endif
