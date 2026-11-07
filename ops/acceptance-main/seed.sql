-- ACCEPTANCE / FICTIONAL — temporary acceptance data INSIDE the one application on :8088 (owner decision, 7 Nov 2026). Run only by
-- ops/acceptance-main/provision.sh, which pauses the HR sync first and records what it creates; ops/acceptance-main/cleanup.sh
-- removes exactly those rows. Tokens: __NS__ (id namespace of this run), __PFX__ (the code prefix, ACC-20261107-…). Every
-- person, unit and site says «اختبار قبول — وهمي». Holders here are TEST assignments, never production values. Real Oracle
-- identities, units, sites and permissions are not read, changed or granted anything.
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
  ('N-A116', 'شعبة السهل', 'N-A11', 9, false),
  ('N-A120', 'شعبة مصفوفة الأزرار', 'N-A11', 9, false),
  ('N-A117', 'شعبة الجزأين', 'N-A11', 9, false),
  ('N-A118', 'شعبة الأجزاء الأربعة', 'N-A11', 9, false),
  ('N-A119', 'شعبة الرؤوس الكثيفة', 'N-A11', 9, false),
  ('N-B', 'القيادة الرئيسية ب', null, 6, true),
  ('N-B1', 'إدارة ب1', 'N-B', 7, false),
  ('N-C', 'القيادة الرئيسية ج', null, 6, true),
  ('N-D', 'القيادة الرئيسية د', null, 6, true);
insert into hr_unit(snapshot_id, external_id, code, name, parent_external_id, status_raw, active, level, is_main)
select (select id from hr_snapshot where status = 'PUBLISHED'), '__PFX__' || x, '__PFX__' || x, n || ' — اختبار قبول — وهمي', case when p is null then null else '__PFX__' || p end, '1', true, lvl, main from n_units on conflict do nothing;
insert into organization(id, code, name, parent_id, status, valid_from, source, source_external_id)
select md5('__NS__:org:' || x)::uuid, '__PFX__' || x, n || ' — اختبار قبول — وهمي', case when p is null then null else md5('__NS__:org:' || p)::uuid end, 'ACTIVE', '2026-01-01T00:00:00Z', 'HR', '__PFX__' || x
  from n_units order by lvl on conflict do nothing;

create temporary table n_people(uid text, emp text, name text, unit text) on commit drop;
insert into n_people values
  ('p01.new', '__PFX__P01', 'مستخدم جديد — اختبار قبول — وهمي', 'N-A111'),
  ('p02.access', '__PFX__P02', 'مدير صلاحيات الوحدة — اختبار قبول — وهمي', 'N-A1'),
  ('p03.final', '__PFX__P03', 'معتمد الصلاحيات النهائي — اختبار قبول — وهمي', 'N-A'),
  ('p04.sites', '__PFX__P04', 'مدير المواقع — اختبار قبول — وهمي', 'N-A'),
  ('p05.req', '__PFX__P05', 'مقدم الطلبات — اختبار قبول — وهمي', 'N-A11'),
  ('p06.h1', '__PFX__P06', 'معتمد المستوى الأول — اختبار قبول — وهمي', 'N-A11'),
  ('p07.h2', '__PFX__P07', 'معتمد المستوى الثاني — اختبار قبول — وهمي', 'N-A1'),
  ('p08.ops', '__PFX__P08', 'معتمد عمليات الوحدة — اختبار قبول — وهمي', 'N-A'),
  ('p09.fin', '__PFX__P09', 'المعتمد النهائي — اختبار قبول — وهمي', 'N-A'),
  ('p10.fyi', '__PFX__P10', 'موزع العلم — اختبار قبول — وهمي', 'N-A'),
  ('p11.act', '__PFX__P11', 'مفعّل التمركز — اختبار قبول — وهمي', 'N-A'),
  ('p12.view', '__PFX__P12', 'متابع الموقف — اختبار قبول — وهمي', 'N-A11'),
  ('p13.other', '__PFX__P13', 'متابع من فرع آخر — اختبار قبول — وهمي', 'N-B1'),
  ('p14.admin', '__PFX__P14', 'مدير المنصة — اختبار قبول — وهمي', 'N-A'),
  -- no permission at all: one in the unit chosen for information, one in its parent, who must not inherit it
  ('p15.fyi', '__PFX__P15', 'موظف في وحدة العلم — اختبار قبول — وهمي', 'N-B1'),
  ('p17.new', '__PFX__P17', 'مستخدم جديد ثانٍ — اختبار قبول — وهمي', 'N-A120'),
  ('p16.branch', '__PFX__P16', 'موظف في الجهة الأعلى — اختبار قبول — وهمي', 'N-B');
insert into hr_person(snapshot_id, external_id, employee_number, domain_account, full_name, unit_external_id, status_text, active)
select (select id from hr_snapshot where status = 'PUBLISHED'), '__PFX__' || uid, emp, uid, name, '__PFX__' || unit, 'في الخدمة', true from n_people on conflict do nothing;
insert into person(id, employee_no, display_name, username, status, source, source_external_id)
select md5('__NS__:person:' || uid)::uuid, emp, name, uid, 'ACTIVE', 'HR', '__PFX__' || uid from n_people on conflict do nothing;
insert into affiliation(id, person_id, organization_id, valid_from)
select md5('__NS__:aff:' || uid)::uuid, md5('__NS__:person:' || uid)::uuid, md5('__NS__:org:' || unit)::uuid, '2026-01-01T00:00:00Z' from n_people on conflict do nothing;

-- ---- offers: the four shown to new people are the owner's and stay as they are. Manager extras are added for this run only. ---
insert into access_request_offer(role_code, audience) values
  ('POSTURE_VIEWER', 'MANAGER'), ('STATIONING_UNIT_APPROVER', 'MANAGER'), ('SITE_LINK_MANAGER', 'MANAGER') on conflict do nothing;

-- ---- TEST holders: nobody below is an administrator except P14 --------------------------------------------------------
insert into membership(id, person_id, organization_id, role_code, valid_from)
select md5('__NS__:m:' || uid || ':' || unit || ':' || role)::uuid, md5('__NS__:person:' || uid)::uuid, md5('__NS__:org:' || unit)::uuid, role, '2026-01-01T00:00:00Z'
  from (values ('p02.access', 'N-A', 'UNIT_ACCESS_MANAGER'), ('p03.final', 'N-A', 'ACCESS_FINAL_APPROVER'), ('p04.sites', 'N-A', 'SITE_SETUP_ADMIN'),
               ('p05.req', 'N-A11', 'STATIONING_REQUESTER'), ('p06.h1', 'N-A11', 'STATIONING_UNIT_APPROVER'), ('p07.h2', 'N-A1', 'STATIONING_UNIT_APPROVER'),
               ('p08.ops', 'N-A', 'STATIONING_OPS_APPROVER'), ('p09.fin', 'N-A', 'STATIONING_FINAL_APPROVER'), ('p10.fyi', 'N-A', 'FYI_DISTRIBUTOR'), ('p10.fyi', 'N-B', 'FYI_DISTRIBUTOR'),
               ('p11.act', 'N-A', 'STATIONING_ACTIVATOR'), ('p12.view', 'N-A11', 'POSTURE_VIEWER'), ('p13.other', 'N-B1', 'POSTURE_VIEWER'),
               ('p14.admin', 'N-A', 'SYSTEM_ADMIN')) v(uid, unit, role)
on conflict do nothing;

-- ---- SITE-01 … SITE-08: invented sites on real ground ----------------------------------------------------------------
create temporary table n_sites(code text, name text, kind text, parent text, g geometry) on commit drop;
insert into n_sites values
  ('__PFX__SITE-01', 'معسكر الاتحاد — اختبار قبول — وهمي', 'موقع رئيسي مشترك', null, ST_MakeEnvelope(56.0290, 24.8385, 56.0325, 24.8415, 4326)),
  ('__PFX__SITE-02', 'مجمع الخدمات — اختبار قبول — وهمي', 'موقع رئيسي', null, ST_MakeEnvelope(56.0980, 24.8940, 56.1060, 24.9010, 4326)),
  ('__PFX__SITE-02A', 'المبنى الإداري — اختبار قبول — وهمي', 'موقع فرعي', 'SITE-02', ST_MakeEnvelope(56.0995, 24.8960, 56.1015, 24.8980, 4326)),
  ('__PFX__SITE-02B', 'موقع الصيانة — اختبار قبول — وهمي', 'موقع فرعي', 'SITE-02', ST_MakeEnvelope(56.1025, 24.8960, 56.1045, 24.8980, 4326)),
  ('__PFX__SITE-03', 'موقع بلا انتشار — اختبار قبول — وهمي', 'موقع', null, ST_MakeEnvelope(56.0590, 24.8590, 56.0615, 24.8615, 4326)),
  ('__PFX__SITE-04', 'موقع مكتمل الانتشار — اختبار قبول — وهمي', 'موقع', null, ST_MakeEnvelope(55.9985, 24.8790, 56.0010, 24.8815, 4326)),
  ('__PFX__SITE-05', 'موقع نقطة فقط — اختبار قبول — وهمي', 'نقطة', null, ST_SetSRID(ST_MakePoint(56.1300, 24.8400), 4326)),
  ('__PFX__SITE-06', 'موقع من أجزاء — اختبار قبول — وهمي', 'موقع متعدد الأجزاء', null, ST_GeomFromText('MULTIPOLYGON(((56.0870 24.9190,56.0890 24.9190,56.0890 24.9210,56.0870 24.9210,56.0870 24.9190)),((56.0920 24.9190,56.0940 24.9190,56.0940 24.9210,56.0920 24.9210,56.0920 24.9190)))', 4326)),
  ('__PFX__SITE-07', 'أرض مشغولة — اختبار قبول — وهمي', 'موقع', null, ST_MakeEnvelope(56.0080, 24.8020, 56.0105, 24.8045, 4326)),
  ('__PFX__SITE-08', 'موقع على أرض وعرة — اختبار قبول — وهمي', 'موقع', null, ST_GeomFromText('POLYGON((56.133614 24.758090,56.135173 24.756104,56.133922 24.753811,56.131232 24.754600,56.131000 24.756800,56.133614 24.758090))', 4326));
insert into site(id, code, name, kind, parent_id, lat, lng, created_at, geometry_version, notes)
select md5('__NS__:site:' || replace(code, '__PFX__', ''))::uuid, code, name, kind, null, ST_Y(ST_PointOnSurface(g)), ST_X(ST_PointOnSurface(g)), now(),
       case when GeometryType(g) = 'POINT' then null else 1 end, 'ACCEPTANCE / FICTIONAL' from n_sites on conflict do nothing;
update site s set parent_id = md5('__NS__:site:' || replace(n.parent, '__PFX__', ''))::uuid from n_sites n where n.code = s.code and n.parent is not null;
insert into site_geometry_version(id, site_id, version, geojson, crs, source, valid_from, geom, geometry_type, reason)
select md5('__NS__:geo:' || replace(code, '__PFX__', ''))::uuid, md5('__NS__:site:' || replace(code, '__PFX__', ''))::uuid, 1, ST_AsGeoJSON(g)::jsonb, 'EPSG:4326', 'ACCEPTANCE / FICTIONAL', now(), g,
       case GeometryType(g) when 'MULTIPOLYGON' then 'MultiPolygon' else 'Polygon' end, 'اختبار قبول — وهمي'
  from n_sites where GeometryType(g) <> 'POINT' on conflict do nothing;
insert into site_responsibility(id, site_id, organization_id, valid_from)
select md5('__NS__:resp:' || v.code)::uuid, md5('__NS__:site:' || v.code)::uuid, md5('__NS__:org:' || v.org)::uuid, '2026-01-01T00:00:00Z'
  from (values ('SITE-02', 'N-A'), ('SITE-03', 'N-A11'), ('SITE-04', 'N-A11'), ('SITE-05', 'N-A11'), ('SITE-06', 'N-A1'), ('SITE-07', 'N-B'), ('SITE-08', 'N-A')) v(code, org)
on conflict do nothing;

-- a site link is an association only
insert into site_link(id, site_id, organization_id, valid_from, reason, created_by)
select md5('__NS__:link:' || v.code || v.org)::uuid, md5('__NS__:site:' || v.code)::uuid, md5('__NS__:org:' || v.org)::uuid, now(), 'اختبار قبول — وهمي', md5('__NS__:person:p14.admin')::uuid
  from (values ('SITE-01', 'N-A'), ('SITE-01', 'N-B'), ('SITE-01', 'N-C'), ('SITE-01', 'N-D'), ('SITE-01', 'N-A111'), ('SITE-05', 'N-A111')) v(code, org)
on conflict do nothing;

-- where units are stationed now. شعبة أ1 and شعبة أ3 are stationed nowhere, for the initial-stationing journey.
insert into org_stationing(id, organization_id, site_id, kind, valid_from, origin, reason, recorded_by)
select md5('__NS__:st:' || v.org)::uuid, md5('__NS__:org:' || v.org)::uuid, md5('__NS__:site:' || v.code)::uuid, 'PERMANENT', now() - interval '30 days', 'CORRECTION', 'اختبار قبول — وهمي', md5('__NS__:person:p14.admin')::uuid
  from (values ('N-A', 'SITE-01'), ('N-B', 'SITE-01'), ('N-C', 'SITE-01'), ('N-D', 'SITE-01'), ('N-A1', 'SITE-02'), ('N-A11', 'SITE-03'), ('N-A112', 'SITE-04'), ('N-B1', 'SITE-07'), ('N-A120', 'SITE-03'), ('N-A114', 'SITE-06'), ('N-A115', 'SITE-05')) v(org, code)
on conflict do nothing;
-- ---- the map suites: a plain, two parts, four parts, a dense outline and an empty reference site, on real relief ------------------
create temporary table n_map(code text, name text, unit text, g geometry) on commit drop;
insert into n_map values
  ('D3-CUR', 'موقع السهل الغربي — اختبار قبول — وهمي', 'N-A116', ST_GeomFromText('POLYGON((56.030653 24.841874, 56.033651 24.840311, 56.033284 24.837239, 56.030885 24.835636, 56.027689 24.835571, 56.026540 24.838343, 56.027446 24.841137, 56.030653 24.841874))', 4326)),
  ('D3-MP2', 'موقع من جزأين على السهل — اختبار قبول — وهمي', 'N-A117', ST_GeomFromText('MULTIPOLYGON(((56.030000 24.903074, 56.032355 24.901697, 56.031281 24.899395, 56.028603 24.899249, 56.027787 24.901655, 56.030000 24.903074)),
      ((56.037943 24.904671, 56.038658 24.902734, 56.036408 24.902251, 56.035999 24.904131, 56.037943 24.904671)))', 4326)),
  ('D3-MP4', 'موقع من أربعة أجزاء — اختبار قبول — وهمي', 'N-A118', ST_GeomFromText('MULTIPOLYGON(((56.089051 24.920956, 56.089121 24.918980, 56.087019 24.919107, 56.086914 24.920988, 56.089051 24.920956)),
      ((56.094051 24.920956, 56.094121 24.918980, 56.092019 24.919107, 56.091914 24.920988, 56.094051 24.920956)),
      ((56.089051 24.924956, 56.089121 24.922980, 56.087019 24.923107, 56.086914 24.924988, 56.089051 24.924956)),
      ((56.094051 24.924956, 56.094121 24.922980, 56.092019 24.923107, 56.091914 24.924988, 56.094051 24.924956)))', 4326)),
  ('D3-DENSE', 'موقع كثيف الرؤوس — اختبار قبول — وهمي', 'N-A119', (
    select ST_SetSRID(ST_MakePolygon(ST_AddPoint(l, ST_StartPoint(l))), 4326)
      from (select ST_MakeLine(ST_MakePoint(56.1120 + 0.0024 * (1 + 0.05 * sin(12 * t)) * cos(t),
                                            24.8940 + 0.0021 * (1 + 0.05 * sin(12 * t)) * sin(t)) order by t) as l
              from (select 2 * pi() * i / 1500 as t from generate_series(0, 1499) i) s) x)),
  ('D3-REF1', 'موقع وادي الشرق — اختبار قبول — وهمي', null, ST_GeomFromText('POLYGON((56.086000 24.874074, 56.088448 24.872724, 56.087397 24.870249, 56.084545 24.870176, 56.083928 24.872613, 56.086000 24.874074))', 4326));
insert into site(id, code, name, kind, lat, lng, created_at, geometry_version, notes)
select md5('__NS__:site:' || code)::uuid, '__PFX__' || code, name, 'موقع', ST_Y(ST_PointOnSurface(g)), ST_X(ST_PointOnSurface(g)), now(), 1, 'ACCEPTANCE / FICTIONAL' from n_map;
insert into site_geometry_version(id, site_id, version, geojson, crs, source, valid_from, geom, geometry_type, reason)
select md5('__NS__:geo:' || code)::uuid, md5('__NS__:site:' || code)::uuid, 1, ST_AsGeoJSON(g)::jsonb, 'EPSG:4326', 'ACCEPTANCE / FICTIONAL', now(), g,
       case GeometryType(g) when 'MULTIPOLYGON' then 'MultiPolygon' else 'Polygon' end, 'اختبار قبول — وهمي' from n_map;
insert into site_responsibility(id, site_id, organization_id, valid_from)
select md5('__NS__:resp:' || code)::uuid, md5('__NS__:site:' || code)::uuid, md5('__NS__:org:' || coalesce(unit, 'N-A'))::uuid, '2026-01-01T00:00:00Z' from n_map;
insert into org_stationing(id, organization_id, site_id, kind, valid_from, origin, reason, recorded_by)
select md5('__NS__:st:' || unit)::uuid, md5('__NS__:org:' || unit)::uuid, md5('__NS__:site:' || code)::uuid, 'PERMANENT', now() - interval '30 days', 'CORRECTION', 'اختبار قبول — وهمي', md5('__NS__:person:p14.admin')::uuid
  from n_map where unit is not null;
-- a temporary stationing with an end date, for the posture's temporary state
insert into org_stationing(id, organization_id, site_id, kind, base_id, valid_from, planned_end, origin, reason, recorded_by)
select md5('__NS__:st:N-A120:t')::uuid, md5('__NS__:org:N-A120')::uuid, md5('__NS__:site:SITE-02')::uuid, 'TEMPORARY', md5('__NS__:st:N-A120')::uuid, now() - interval '3 days', '2027-03-31T00:00:00Z', 'CORRECTION', 'اختبار قبول — وهمي', md5('__NS__:person:p14.admin')::uuid;
commit;
