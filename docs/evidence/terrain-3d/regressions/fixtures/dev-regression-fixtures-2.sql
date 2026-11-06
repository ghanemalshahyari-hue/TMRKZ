-- DEVELOPMENT ONLY (tmrkz-v3dev): two more FICTIONAL fixtures for the Stationing browser regressions, 6 Nov 2026.
--   DEV-SS-4 at DEV-REG-MP2E: a MultiPolygon of two EQUAL squares (200 m, 100 m apart) — geometry-two-methods SITE-B
--            measures the moved site's centre as the plain mean of its vertices, which equals the editor's area-weighted
--            anchor only when the parts are alike (as on tmrkz-test);
--   DEV-REG-REF: a registered reference site with no unit, 2 km west of DEV-REG-MP2 — ui-rebuild REF-CLICK needs a
--            registered site other than the request's own in view at zoom 13 (tmrkz-test's Dubai sites were dense).
-- Nothing existing is changed. Stable ids; a second run writes nothing.
\set ON_ERROR_STOP on
begin;
do $$
begin
  if coalesce(shobj_description((select oid from pg_database where datname = current_database()), 'pg_database'), '') like 'ACCEPTANCE%' then
    raise exception 'refused: this is the acceptance database; development data only';
  end if;
end $$;
create temp table fx(org_code text, org_name text, site_code text, site_name text, geom geometry, stationed boolean) on commit drop;
insert into fx values
  ('DEV-SS-4', 'قسم اختبار جزأين متساويين (وهمي)', 'DEV-REG-MP2E', 'موقع اختبار الانحدار — جزآن متساويان (وهمي)', ST_GeomFromText(
    'MULTIPOLYGON(((55.9500 25.0500, 55.9520 25.0500, 55.9520 25.0518, 55.9500 25.0518, 55.9500 25.0500)),
                  ((55.9530 25.0500, 55.9550 25.0500, 55.9550 25.0518, 55.9530 25.0518, 55.9530 25.0500)))', 4326), true),
  ('DEV-SS-3', null, 'DEV-REG-REF', 'موقع مرجعي لاختبار الانحدار (وهمي)', ST_GeomFromText(
    'POLYGON((55.9792 25.1006, 55.9808 25.1006, 55.9808 25.1020, 55.9792 25.1020, 55.9792 25.1006))', 4326), false);
alter table fx add column org_id uuid, add column site_id uuid;
update fx set org_id = md5('dev-reg:org:' || org_code)::uuid, site_id = md5('dev-reg:site:' || site_code)::uuid;
do $$
declare r record;
begin
  for r in select * from fx loop
    if not ST_IsValid(r.geom) then raise exception 'fixture % not valid', r.site_code; end if;
    if exists (select 1 from site where code = r.site_code and id <> r.site_id) then raise exception 'site code % taken', r.site_code; end if;
    if exists (select 1 from site s join site_geometry_version v on v.site_id = s.id and v.version = s.geometry_version
                where s.id <> r.site_id and v.geom is not null and ST_DWithin(v.geom::geography, r.geom::geography, 1000)) then
      raise exception 'fixture % is within 1 km of an existing boundary', r.site_code;
    end if;
  end loop;
end $$;
insert into organization(id, code, name, parent_id, status, valid_from, source)
select org_id, org_code, org_name, (select id from organization where code = 'HR-T-SS'), 'ACTIVE', '2026-01-01T00:00:00Z', 'LOCAL'
  from fx where org_name is not null on conflict do nothing;
insert into site(id, code, name, kind, lat, lng, created_at, geometry_version)
select site_id, site_code, site_name, 'موقع تطوير وهمي (اختبارات الانحدار)', ST_Y(ST_PointOnSurface(geom)), ST_X(ST_PointOnSurface(geom)), now(), 1
  from fx on conflict do nothing;
insert into site_geometry_version(id, site_id, version, geojson, crs, source, valid_from, geom, geometry_type, reason)
select md5('dev-reg:sgv:' || site_code)::uuid, site_id, 1, ST_AsGeoJSON(geom)::jsonb, 'EPSG:4326', 'بيانات تطوير وهمية', now(), geom,
       case GeometryType(geom) when 'MULTIPOLYGON' then 'MultiPolygon' else 'Polygon' end, 'بيانات تطوير وهمية لاختبارات الانحدار (Stationing)'
  from fx on conflict do nothing;
insert into site_responsibility(id, site_id, organization_id, valid_from)
select md5('dev-reg:resp:' || site_code)::uuid, site_id, org_id, '2026-01-01T00:00:00Z' from fx on conflict do nothing;
insert into org_stationing(id, organization_id, site_id, kind, valid_from, origin, reason, reference, recorded_by)
select md5('dev-reg:stn:' || org_code)::uuid, org_id, site_id, 'PERMANENT', now(), 'CORRECTION',
       'تمركز أولي — بيانات تطوير وهمية لاختبارات الانحدار (Stationing)', 'DEV-REGRESSION', (select id from person where username = 't.admin')
  from fx where stationed and not exists (select 1 from org_stationing x where x.organization_id = fx.org_id and x.valid_to is null)
on conflict do nothing;
select fx.site_code || ' ' || v.geometry_type || ' parts=' || ST_NumGeometries(v.geom) || ' area_m2=' || round(ST_Area(v.geom::geography))
       || ' unit=' || coalesce((select o.code from org_stationing x join organization o on o.id = x.organization_id where x.site_id = s.id and x.valid_to is null), 'none')
  from fx join site s on s.id = fx.site_id join site_geometry_version v on v.site_id = s.id and v.version = s.geometry_version order by 1;
commit;
