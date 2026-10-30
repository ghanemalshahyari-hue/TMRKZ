-- Fictional acceptance data — TEST ENVIRONMENT ONLY (ops/test-env). Never load into a production database.
-- Mirrors what a successful HR sync would have left (published snapshot, projected organisations and people with dated
-- affiliations), adds grants and a fictional facility set. Identifiers are deterministic, so re-running changes nothing.
begin;
select set_config('tmrkz.hr_projection', 'on', true);

-- ---- HR mirror (fictional) ----------------------------------------------------------------------------------------
insert into hr_source(id, name, enabled, last_success_at)
values (md5('t:source')::uuid, 'مصدر الموارد البشرية — بيئة الاختبار', false, now())
on conflict (id) do update set last_success_at = now();
insert into hr_mapping_version(id, source_id, version, status, fields, active_rules)
values (md5('t:mapping')::uuid, md5('t:source')::uuid, 1, 'PUBLISHED', '[]', '{}') on conflict do nothing;
insert into hr_sync_run(id, source_id, mapping_version_id, trigger, status, started_at, finished_at, counts)
values (md5('t:run')::uuid, md5('t:source')::uuid, md5('t:mapping')::uuid, 'SCHEDULED', 'SUCCEEDED', now(), now(),
        '{"note": "fictional test data"}') on conflict do nothing;
insert into hr_snapshot(id, run_id, mapping_version_id, status, unit_count, person_count, active_unit_count, active_person_count, published_at)
values (md5('t:snapshot')::uuid, md5('t:run')::uuid, md5('t:mapping')::uuid, 'PUBLISHED', 8, 11, 8, 11, now()) on conflict do nothing;

insert into hr_unit(snapshot_id, external_id, code, name, parent_external_id, status_raw, active)
select md5('t:snapshot')::uuid, x, c, n, p, '1', true from (values
  ('T-ORG', 'ORG', 'المؤسسة', null),
  ('T-GA', 'GA', 'الإدارة العامة', 'T-ORG'),
  ('T-SS', 'SS', 'الخدمات المشتركة', 'T-ORG'),
  ('T-IT', 'IT', 'إدارة التقنية', 'T-ORG'),
  ('T-PM', 'PM', 'إدارة المشاريع', 'T-ORG'),
  -- a deeper branch, for choosing an organisation far down the tree (MAP-01)
  ('T-PM-1', 'PM-1', 'قسم مشاريع المباني', 'T-PM'),
  ('T-PM-1-1', 'PM-1-1', 'وحدة الصيانة الإدارية', 'T-PM-1'),
  ('T-PM-1-1-1', 'PM-1-1-1', 'فريق مرافق الشمال', 'T-PM-1-1')) v(x, c, n, p)
on conflict do nothing;

insert into organization(id, code, name, parent_id, status, valid_from, source, source_external_id)
select md5('t:org:' || u.external_id)::uuid, 'HR-' || u.external_id, u.name,
       case when u.parent_external_id is null then null else md5('t:org:' || u.parent_external_id)::uuid end,
       'ACTIVE', '2026-01-01T00:00:00Z', 'HR', u.external_id
from hr_unit u where u.snapshot_id = md5('t:snapshot')::uuid
on conflict do nothing;

-- uid (directory login = HR domain account), employee number, name, unit, role, site scope
create temporary table t_people(uid text, emp text, name text, unit text, role text, site text) on commit drop;
insert into t_people values
  ('t.admin', 'T-0001', 'مدير النظام التجريبي', 'GA', 'SYSTEM_ADMIN', null),
  ('t.requester', 'T-0002', 'مقدم طلب تجريبي', 'SS', 'REQUESTER', null),
  ('t.requester2', 'T-0003', 'مقدم طلب — التقنية', 'IT', 'REQUESTER', null),
  ('t.facilities', 'T-0004', 'مراجع المرافق التجريبي', 'SS', 'FACILITIES_REVIEWER', null),
  ('t.manager', 'T-0005', 'مدير الخدمات المشتركة', 'SS', 'ORG_MANAGER', null),
  ('t.manager.it', 'T-0006', 'مدير إدارة التقنية', 'IT', 'ORG_MANAGER', null),
  ('t.manager.ga', 'T-0007', 'مدير الإدارة العامة', 'GA', 'ORG_MANAGER', null),
  ('t.approver', 'T-0008', 'صاحب الاعتماد التجريبي', 'GA', 'APPROVER', null),
  ('t.approver2', 'T-0009', 'صاحب اعتماد بديل', 'GA', 'APPROVER', null),
  ('t.limited', 'T-0010', 'مستخدم اطلاع محدود', 'SS', 'LIMITED_VIEWER', '02'),
  ('t.auditor', 'T-0011', 'مدقق السجلات', 'GA', 'AUDITOR', null);

insert into hr_person(snapshot_id, external_id, employee_number, domain_account, full_name, unit_external_id, status_text, active)
select md5('t:snapshot')::uuid, 'P-' || uid, emp, uid, name, 'T-' || unit, 'في الخدمة', true from t_people
on conflict do nothing;

insert into person(id, employee_no, display_name, username, status, source, source_external_id)
select md5('t:person:' || uid)::uuid, emp, name, uid, 'ACTIVE', 'HR', 'P-' || uid from t_people
on conflict do nothing;

insert into affiliation(id, person_id, organization_id, valid_from)
select md5('t:aff:' || uid)::uuid, md5('t:person:' || uid)::uuid, md5('t:org:T-' || unit)::uuid, '2026-01-01T00:00:00Z' from t_people
on conflict do nothing;

-- ---- facilities (fictional, illustrative coordinates) ----------------------------------------------------------
create temporary table t_sites(code text, name text, kind text, parent text, org text, capacity int, lat double precision, lng double precision) on commit drop;
insert into t_sites values
  ('00', 'مجمع المؤسسة', 'موقع رئيسي', null, 'GA', null, 25.207, 55.31),
  ('01', 'المقر الإداري', 'مبنى إداري', '00', 'GA', 120, 25.224, 55.277),
  ('02', 'مركز الخدمات', 'مرفق خدمات', '00', 'SS', 65, 25.207, 55.316),
  ('03', 'مجمع الأعمال الشرقي', 'مكاتب إدارية', '00', 'PM', 90, 25.221, 55.357),
  ('04', 'قاعة الاجتماعات', 'قاعة مشتركة', '00', 'GA', 40, 25.189, 55.283),
  ('05', 'مركز التدريب الإداري', 'قاعات تدريب', '00', 'SS', 80, 25.176, 55.330),
  ('06', 'مكتب التقنية', 'مكاتب مشتركة', '00', 'IT', 35, 25.239, 55.325),
  ('07', 'مركز الدعم', 'مرفق دعم إداري', '00', 'IT', 30, 25.198, 55.365),
  ('08', 'مبنى الخدمات الغربية', 'مبنى خدمات', '00', 'SS', 55, 25.211, 55.247),
  ('10', 'مستودع اللوازم الشمالي', 'مستودع إداري', null, 'PM-1-1-1', null, 25.252, 55.301),
  ('11', 'المبنى المشترك', 'مبنى مشترك', null, 'SS', null, 25.196, 55.3005);

insert into site(id, code, name, kind, parent_id, capacity, lat, lng)
select md5('t:site:' || code)::uuid, code, name, kind, case when parent is null then null else md5('t:site:' || parent)::uuid end,
       capacity, lat, lng from t_sites
on conflict do nothing;
insert into site_responsibility(id, site_id, organization_id, valid_from)
select md5('t:resp:' || code)::uuid, md5('t:site:' || code)::uuid, md5('t:org:T-' || org)::uuid, '2026-01-01T00:00:00Z' from t_sites
on conflict do nothing;
-- No boundaries are seeded: markers only. Boundaries are imported or drawn through the application (map journey).
insert into resource(id, site_id, code, name, kind, policy, parent_resource_id, capacity)
select md5('t:res:R-' || code)::uuid, md5('t:site:' || code)::uuid, 'R-' || code, name, kind, 'EXCLUSIVE', null, capacity
from t_sites where parent is not null
on conflict do nothing;
insert into resource(id, site_id, code, name, kind, policy, parent_resource_id, capacity) values
  (md5('t:res:R-05A')::uuid, md5('t:site:05')::uuid, 'R-05A', 'قاعة التدريب أ', 'قاعة تدريب', 'EXCLUSIVE', md5('t:res:R-05')::uuid, 40),
  (md5('t:res:R-05B')::uuid, md5('t:site:05')::uuid, 'R-05B', 'قاعة التدريب ب', 'قاعة تدريب', 'EXCLUSIVE', md5('t:res:R-05')::uuid, 40),
  (md5('t:res:R-10')::uuid, md5('t:site:10')::uuid, 'R-10', 'مستودع اللوازم الشمالي', 'مستودع', 'EXCLUSIVE', null, null),
  -- shared building: shared use by several organisations, with independent exclusive rooms (MAP-10)
  (md5('t:res:R-11')::uuid, md5('t:site:11')::uuid, 'R-11', 'استخدام المبنى المشترك', 'استخدام مشترك', 'SHARED', null, null),
  (md5('t:res:R-11A')::uuid, md5('t:site:11')::uuid, 'R-11A', 'مكتب الاستقبال', 'مكتب', 'EXCLUSIVE', md5('t:res:R-11')::uuid, null),
  (md5('t:res:R-11B')::uuid, md5('t:site:11')::uuid, 'R-11B', 'القاعة متعددة الاستخدام', 'قاعة', 'EXCLUSIVE', md5('t:res:R-11')::uuid, null)
on conflict do nothing;

-- ---- grants (dated memberships) --------------------------------------------------------------------------------
insert into membership(id, person_id, organization_id, role_code, position_title, site_scope_id, valid_from)
select md5('t:m:' || uid)::uuid, md5('t:person:' || uid)::uuid, md5('t:org:T-' || unit)::uuid, role, null,
       case when site is null then null else md5('t:site:' || site)::uuid end, '2026-01-01T00:00:00Z' from t_people
on conflict do nothing;
insert into membership(id, person_id, organization_id, role_code, site_scope_id, valid_from) values
  (md5('t:m:t.limited:05')::uuid, md5('t:person:t.limited')::uuid, md5('t:org:T-SS')::uuid, 'LIMITED_VIEWER', md5('t:site:05')::uuid, '2026-01-01T00:00:00Z'),
  (md5('t:m:t.limited:08')::uuid, md5('t:person:t.limited')::uuid, md5('t:org:T-SS')::uuid, 'LIMITED_VIEWER', md5('t:site:08')::uuid, '2026-01-01T00:00:00Z')
on conflict do nothing;

-- a second organisation using the shared building: a requester of IT with a role scoped to site 11 (MAP-10)
insert into role_def(code, name, permissions, scope, summary_only, sort_order)
values ('SHARED_SITE_REQUESTER', 'مقدم طلب في موقع مشترك', '{VIEW,CREATE,EDIT}', 'SITE', false, 20)
on conflict do nothing;
insert into membership(id, person_id, organization_id, role_code, site_scope_id, valid_from)
values (md5('t:m:t.requester2:11')::uuid, md5('t:person:t.requester2')::uuid, md5('t:org:T-IT')::uuid, 'SHARED_SITE_REQUESTER',
        md5('t:site:11')::uuid, '2026-01-01T00:00:00Z')
on conflict do nothing;

-- an access manager of SS only (permissions studio, ADR-018): may grant these roles inside SS and its branches
insert into role_def(code, name, permissions, scope, summary_only, sort_order, grantable_roles)
values ('ORG_ACCESS_MANAGER', 'مسؤول صلاحيات الجهة', '{MANAGE_ACCESS,VIEW}', 'ORGANIZATION', false, 21,
        '{REQUESTER,LIMITED_VIEWER,SHARED_SITE_REQUESTER}')
on conflict do nothing;
insert into membership(id, person_id, organization_id, role_code, valid_from)
values (md5('t:m:t.manager:access')::uuid, md5('t:person:t.manager')::uuid, md5('t:org:T-SS')::uuid, 'ORG_ACCESS_MANAGER',
        '2026-01-01T00:00:00Z')
on conflict do nothing;

-- one explicit scope: summary view of SS (with branches) AND the shared building (site 11) only
insert into membership(id, person_id, organization_id, role_code, valid_from, scope_mode, scope_combine)
values (md5('t:m:t.manager.it:custom')::uuid, md5('t:person:t.manager.it')::uuid, md5('t:org:T-IT')::uuid, 'LIMITED_VIEWER',
        '2026-01-01T00:00:00Z', 'CUSTOM', 'AND')
on conflict do nothing;
insert into membership_scope_target(membership_id, kind, target_id, include_descendants) values
  (md5('t:m:t.manager.it:custom')::uuid, 'ORGANIZATION', md5('t:org:T-SS')::uuid, true),
  (md5('t:m:t.manager.it:custom')::uuid, 'SITE', md5('t:site:11')::uuid, true)
on conflict do nothing;


-- informational unit symbol catalog (fictional acceptance data, ADR-021): generic administrative functions as land
-- unit SIDCs of APP-6 D, friend, no echelon. A production installation starts with an empty catalog.
insert into unit_symbol_catalog(code, standard, edition, sidc, name_ar) values
  ('ADM-C2', 'APP6', 'D', '10031000001100000000', 'قيادة وسيطرة'),
  ('ADM-ADMIN', 'APP6', 'D', '10031000001601000000', 'شؤون إدارية'),
  ('ADM-PERSONNEL', 'APP6', 'D', '10031000001624000000', 'خدمات الأفراد'),
  ('ADM-FINANCE', 'APP6', 'D', '10031000001607000000', 'الشؤون المالية'),
  ('ADM-MAINTENANCE', 'APP6', 'D', '10031000001611000000', 'الصيانة'),
  ('ADM-TRANSPORT', 'APP6', 'D', '10031000001636000000', 'النقل'),
  ('ADM-SUSTAINMENT', 'APP6', 'D', '10031000001600000000', 'الإسناد والدعم')
on conflict do nothing;
commit;
