-- FICTIONAL / ACCEPTANCE — owner morning review of the complete request phase (ADR-045). ops/test-env/owner-review.sh only;
-- never a retained or production database. Organisations, people, sites and holders are invented; only the terrain under
-- the sites is real (GLO-30). Every holder here is a TEST assignment, not a production default. Re-running changes nothing.
\set ON_ERROR_STOP on
begin;
select set_config('tmrkz.hr_projection', 'on', true);

-- ---- the organisation, as the HR mirror would hold it ------------------------------------------------------------
create temporary table n_units(x text, n text, p text, lvl int, main boolean) on commit drop;
insert into n_units values
  ('N-A', 'القيادة الرئيسية أ', null, 6, true),
  ('N-A1', 'إدارة الخدمات أ', 'N-A', 7, false),
  ('N-A11', 'قسم الحركة أ', 'N-A1', 8, false),
  ('N-A111', 'شعبة أ1', 'N-A11', 9, false),
  ('N-A112', 'شعبة أ2', 'N-A11', 9, false),
  ('N-A113', 'شعبة أ3', 'N-A11', 9, false),
  ('N-A114', 'شعبة أ4', 'N-A11', 9, false),
  ('N-A115', 'شعبة أ5', 'N-A11', 9, false),
  ('N-B', 'القيادة الرئيسية ب', null, 6, true),
  ('N-B1', 'إدارة ب1', 'N-B', 7, false),
  ('N-C', 'القيادة الرئيسية ج', null, 6, true),
  ('N-D', 'القيادة الرئيسية د', null, 6, true);
insert into hr_unit(snapshot_id, external_id, code, name, parent_external_id, status_raw, active, level, is_main)
select md5('t:snapshot')::uuid, x, x, n, p, '1', true, lvl, main from n_units on conflict do nothing;
insert into organization(id, code, name, parent_id, status, valid_from, source, source_external_id)
select md5('t:org:' || x)::uuid, 'HR-' || x, n, case when p is null then null else md5('t:org:' || p)::uuid end, 'ACTIVE', '2026-01-01T00:00:00Z', 'HR', x
  from n_units order by lvl on conflict do nothing;

create temporary table n_people(uid text, emp text, name text, unit text) on commit drop;
insert into n_people values
  ('p01.new', 'T-P01', 'مستخدم جديد (وهمي)', 'N-A111'),
  ('p02.access', 'T-P02', 'مدير صلاحيات الوحدة (وهمي)', 'N-A1'),
  ('p03.final', 'T-P03', 'معتمد الصلاحيات النهائي (وهمي)', 'N-A'),
  ('p04.sites', 'T-P04', 'مدير المواقع (وهمي)', 'N-A'),
  ('p05.req', 'T-P05', 'مقدم الطلبات (وهمي)', 'N-A11'),
  ('p06.h1', 'T-P06', 'معتمد المستوى الأول (وهمي)', 'N-A11'),
  ('p07.h2', 'T-P07', 'معتمد المستوى الثاني (وهمي)', 'N-A1'),
  ('p08.ops', 'T-P08', 'معتمد عمليات الوحدة (وهمي)', 'N-A'),
  ('p09.fin', 'T-P09', 'المعتمد النهائي (وهمي)', 'N-A'),
  ('p10.fyi', 'T-P10', 'موزع العلم (وهمي)', 'N-A'),
  ('p11.act', 'T-P11', 'مفعّل التمركز (وهمي)', 'N-A'),
  ('p12.view', 'T-P12', 'متابع الموقف (وهمي)', 'N-A11'),
  ('p13.other', 'T-P13', 'متابع من فرع آخر (وهمي)', 'N-B1'),
  ('p14.admin', 'T-P14', 'مدير المنصة (وهمي)', 'N-A'),
  -- no permission at all: one in the unit chosen for information, one in its parent, who must not inherit it
  ('p15.fyi', 'T-P15', 'موظف في وحدة العلم (وهمي)', 'N-B1'),
  ('p16.branch', 'T-P16', 'موظف في الجهة الأعلى (وهمي)', 'N-B');
insert into hr_person(snapshot_id, external_id, employee_number, domain_account, full_name, unit_external_id, status_text, active)
select md5('t:snapshot')::uuid, 'P-' || uid, emp, uid, name, unit, 'في الخدمة', true from n_people on conflict do nothing;
insert into person(id, employee_no, display_name, username, status, source, source_external_id)
select md5('t:person:' || uid)::uuid, emp, name, uid, 'ACTIVE', 'HR', 'P-' || uid from n_people on conflict do nothing;
insert into affiliation(id, person_id, organization_id, valid_from)
select md5('t:aff:' || uid)::uuid, md5('t:person:' || uid)::uuid, md5('t:org:' || unit)::uuid, '2026-01-01T00:00:00Z' from n_people on conflict do nothing;
update hr_source set last_success_at = now() where id = md5('t:source')::uuid;

-- ---- capabilities: what a person sees is an Arabic name; the permissions behind it stay on the server ---------------
insert into role_def(code, name, permissions, scope, summary_only, sort_order, grantable_roles) values
  ('POSTURE_VIEWER', 'متابعة الموقف العملياتي', '{VIEW_OPERATIONAL_POSTURE}', 'ORGANIZATION', false, 100, '{}'),
  ('STATIONING_REQUESTER', 'إنشاء طلبات التمركز', '{VIEW,CREATE_INITIAL_STATIONING,CREATE_DEPLOYMENT_REQUEST,CREATE_RESTATIONING,REQUEST_SITE_REGISTRATION}', 'ORGANIZATION', false, 101, '{}'),
  ('DEPLOYMENT_REQUESTER', 'إنشاء طلب منطقة انتشار', '{VIEW,CREATE_DEPLOYMENT_REQUEST}', 'ORGANIZATION', false, 102, '{}'),
  ('SITE_REGISTRATION_REQUESTER', 'طلب اعتماد موقع', '{VIEW,REQUEST_SITE_REGISTRATION}', 'ORGANIZATION', false, 103, '{}'),
  ('STATIONING_UNIT_APPROVER', 'اعتماد طلبات الوحدة', '{VIEW,APPROVE}', 'ORGANIZATION', false, 104, '{}'),
  ('STATIONING_OPS_APPROVER', 'اعتماد عمليات الوحدة', '{VIEW,DECIDE_UNIT_OPERATIONS}', 'ORGANIZATION', false, 105, '{}'),
  ('STATIONING_FINAL_APPROVER', 'الاعتماد النهائي للتمركز', '{VIEW,FINAL_APPROVE_STATIONING}', 'ORGANIZATION', false, 106, '{}'),
  ('FYI_DISTRIBUTOR', 'تحديد وحدات العلم', '{VIEW,MANAGE_FYI_DISTRIBUTION}', 'ORGANIZATION', false, 107, '{}'),
  ('STATIONING_ACTIVATOR_NEXT', 'تفعيل التمركز', '{VIEW,ACTIVATE_STATIONING}', 'ORGANIZATION', false, 108, '{}'),
  ('SITE_LINK_MANAGER', 'ربط الوحدات بالمواقع', '{VIEW,MANAGE_SITE_LINKS}', 'ORGANIZATION', false, 109, '{}'),
  ('SITE_SETUP_ADMIN', 'تهيئة المواقع والتمركز', '{VIEW,MANAGE_FACILITIES,MANAGE_SITE_LINKS,CORRECT_STATIONING}', 'ALL', false, 110, '{}'),
  ('UNIT_ACCESS_MANAGER', 'مدير صلاحيات الوحدة', '{MANAGE_ACCESS,REVIEW}', 'ORGANIZATION', false, 111, '{POSTURE_VIEWER,STATIONING_REQUESTER,DEPLOYMENT_REQUESTER,SITE_REGISTRATION_REQUESTER,SITE_LINK_MANAGER}'),
  ('ACCESS_FINAL_APPROVER', 'معتمد طلبات الصلاحية', '{REVIEW,APPROVE}', 'ALL', false, 112, '{}')
on conflict (code) do nothing;
delete from access_request_offer;
insert into access_request_offer(role_code, audience) values
  ('POSTURE_VIEWER', 'EVERYONE'), ('STATIONING_REQUESTER', 'EVERYONE'), ('DEPLOYMENT_REQUESTER', 'EVERYONE'), ('SITE_REGISTRATION_REQUESTER', 'EVERYONE'),
  ('STATIONING_UNIT_APPROVER', 'MANAGER'), ('SITE_LINK_MANAGER', 'MANAGER');

-- ---- TEST holders: nobody below is an administrator except P14 --------------------------------------------------------
insert into membership(id, person_id, organization_id, role_code, valid_from)
select md5('t:m:' || uid || ':' || unit || ':' || role)::uuid, md5('t:person:' || uid)::uuid, md5('t:org:' || unit)::uuid, role, '2026-01-01T00:00:00Z'
  from (values ('p02.access', 'N-A', 'UNIT_ACCESS_MANAGER'), ('p03.final', 'N-A', 'ACCESS_FINAL_APPROVER'), ('p04.sites', 'N-A', 'SITE_SETUP_ADMIN'),
               ('p05.req', 'N-A11', 'STATIONING_REQUESTER'), ('p06.h1', 'N-A11', 'STATIONING_UNIT_APPROVER'), ('p07.h2', 'N-A1', 'STATIONING_UNIT_APPROVER'),
               ('p08.ops', 'N-A', 'STATIONING_OPS_APPROVER'), ('p09.fin', 'N-A', 'STATIONING_FINAL_APPROVER'), ('p10.fyi', 'N-A', 'FYI_DISTRIBUTOR'), ('p10.fyi', 'N-B', 'FYI_DISTRIBUTOR'),
               ('p11.act', 'N-A', 'STATIONING_ACTIVATOR_NEXT'), ('p12.view', 'N-A11', 'POSTURE_VIEWER'), ('p13.other', 'N-B1', 'POSTURE_VIEWER'),
               ('p14.admin', 'N-A', 'SYSTEM_ADMIN')) v(uid, unit, role)
on conflict do nothing;

-- ---- SITE-01 … SITE-08: invented sites on real ground ----------------------------------------------------------------
create temporary table n_sites(code text, name text, kind text, parent text, g geometry) on commit drop;
insert into n_sites values
  ('SITE-01', 'معسكر الاتحاد (وهمي)', 'موقع رئيسي مشترك', null, ST_MakeEnvelope(56.0290, 24.8385, 56.0325, 24.8415, 4326)),
  ('SITE-02', 'مجمع الخدمات (وهمي)', 'موقع رئيسي', null, ST_MakeEnvelope(56.0980, 24.8940, 56.1060, 24.9010, 4326)),
  ('SITE-02A', 'المبنى الإداري (وهمي)', 'موقع فرعي', 'SITE-02', ST_MakeEnvelope(56.0995, 24.8960, 56.1015, 24.8980, 4326)),
  ('SITE-02B', 'موقع الصيانة (وهمي)', 'موقع فرعي', 'SITE-02', ST_MakeEnvelope(56.1025, 24.8960, 56.1045, 24.8980, 4326)),
  ('SITE-03', 'موقع بلا انتشار (وهمي)', 'موقع', null, ST_MakeEnvelope(56.0590, 24.8590, 56.0615, 24.8615, 4326)),
  ('SITE-04', 'موقع مكتمل الانتشار (وهمي)', 'موقع', null, ST_MakeEnvelope(55.9985, 24.8790, 56.0010, 24.8815, 4326)),
  ('SITE-05', 'موقع نقطة فقط (وهمي)', 'نقطة', null, ST_SetSRID(ST_MakePoint(56.1300, 24.8400), 4326)),
  ('SITE-06', 'موقع من أجزاء (وهمي)', 'موقع متعدد الأجزاء', null, ST_GeomFromText('MULTIPOLYGON(((56.0870 24.9190,56.0890 24.9190,56.0890 24.9210,56.0870 24.9210,56.0870 24.9190)),((56.0920 24.9190,56.0940 24.9190,56.0940 24.9210,56.0920 24.9210,56.0920 24.9190)))', 4326)),
  ('SITE-07', 'أرض مشغولة (وهمي)', 'موقع', null, ST_MakeEnvelope(56.0080, 24.8020, 56.0105, 24.8045, 4326)),
  ('SITE-08', 'موقع على أرض وعرة (وهمي)', 'موقع', null, ST_GeomFromText('POLYGON((56.133614 24.758090,56.135173 24.756104,56.133922 24.753811,56.131232 24.754600,56.131000 24.756800,56.133614 24.758090))', 4326));
insert into site(id, code, name, kind, parent_id, lat, lng, created_at, geometry_version, notes)
select md5('t:site:' || code)::uuid, code, name, kind, null, ST_Y(ST_PointOnSurface(g)), ST_X(ST_PointOnSurface(g)), now(),
       case when GeometryType(g) = 'POINT' then null else 1 end, 'FICTIONAL / ACCEPTANCE' from n_sites on conflict do nothing;
update site s set parent_id = md5('t:site:' || n.parent)::uuid from n_sites n where n.code = s.code and n.parent is not null;
insert into site_geometry_version(id, site_id, version, geojson, crs, source, valid_from, geom, geometry_type, reason)
select md5('t:geo:' || code)::uuid, md5('t:site:' || code)::uuid, 1, ST_AsGeoJSON(g)::jsonb, 'EPSG:4326', 'FICTIONAL / ACCEPTANCE', now(), g,
       case GeometryType(g) when 'MULTIPOLYGON' then 'MultiPolygon' else 'Polygon' end, 'بيانات قبول وهمية'
  from n_sites where GeometryType(g) <> 'POINT' on conflict do nothing;
insert into site_responsibility(id, site_id, organization_id, valid_from)
select md5('t:resp:' || v.code)::uuid, md5('t:site:' || v.code)::uuid, md5('t:org:' || v.org)::uuid, '2026-01-01T00:00:00Z'
  from (values ('SITE-02', 'N-A'), ('SITE-03', 'N-A11'), ('SITE-04', 'N-A11'), ('SITE-05', 'N-A11'), ('SITE-06', 'N-A1'), ('SITE-07', 'N-B'), ('SITE-08', 'N-A')) v(code, org)
on conflict do nothing;

-- a site link is an association only
insert into site_link(id, site_id, organization_id, valid_from, reason, created_by)
select md5('t:link:' || v.code || v.org)::uuid, md5('t:site:' || v.code)::uuid, md5('t:org:' || v.org)::uuid, now(), 'بيانات قبول وهمية', md5('t:person:p14.admin')::uuid
  from (values ('SITE-01', 'N-A'), ('SITE-01', 'N-B'), ('SITE-01', 'N-C'), ('SITE-01', 'N-D'), ('SITE-01', 'N-A111'), ('SITE-05', 'N-A111')) v(code, org)
on conflict do nothing;

-- where units are stationed now. شعبة أ1 and شعبة أ3 are stationed nowhere, for the initial-stationing journey.
insert into org_stationing(id, organization_id, site_id, kind, valid_from, origin, reason, recorded_by)
select md5('t:st:' || v.org)::uuid, md5('t:org:' || v.org)::uuid, md5('t:site:' || v.code)::uuid, 'PERMANENT', now() - interval '30 days', 'CORRECTION', 'بيانات قبول وهمية', md5('t:person:p14.admin')::uuid
  from (values ('N-A', 'SITE-01'), ('N-B', 'SITE-01'), ('N-C', 'SITE-01'), ('N-D', 'SITE-01'), ('N-A1', 'SITE-02'), ('N-A11', 'SITE-03'), ('N-A112', 'SITE-04'), ('N-B1', 'SITE-07'), ('N-A114', 'SITE-06'), ('N-A115', 'SITE-05')) v(org, code)
on conflict do nothing;
commit;
