-- DEVELOPMENT ONLY (tmrkz-v3dev): FICTIONAL fixtures for re-running the Stationing browser regressions written for the
-- deleted acceptance environment (tmrkz-test), 6 Nov 2026. Three fictional LOCAL sections of «الخدمات المشتركة»
-- (HR-T-SS), the same kind of section as T-SS-1/T-SS-2 of ops/test-env/stationing-demo.sql, each stationed at its own
-- fictional site on generic open ground near the Al Madam plain, about 20 km or more from every D3-* site:
--   DEV-SS-1 at a two-part MultiPolygon (geometry-old-mp-point B, geometry-two-methods SITE-B, geometry-interaction B,
--            ui-rebuild G-*, the ui-rebuild draft);
--   DEV-SS-2 at a marker-only site (Point; geometry-old-mp-point C, geometry-interaction C, ui-rebuild G-DRAW-*). Its code
--            «0-DEV-PT» sorts before «00» so that the first stationed site ui-rebuild picks is a marker site, as site 08
--            was on tmrkz-test (t.requester reads every unit here through DEV_VIEW_ALL);
--   DEV-SS-3 at a four-vertex Polygon (geometry-old-sequence S6 counts four handles).
-- Nothing existing is changed: no D3-* site, no HR unit, no policy, no existing stationing. Stable ids; a second run
-- writes nothing (on conflict do nothing).
--   docker exec -i tmrkz-v3dev-db-1 psql -U mover -d mover -v ON_ERROR_STOP=1 -f - < dev-regression-fixtures.sql
\set ON_ERROR_STOP on
begin;

create temp table fx(org_code text, org_name text, site_code text, site_name text, geom geometry) on commit drop;
insert into fx values
  ('DEV-SS-1', 'قسم الخدمات العامة (وهمي)', 'DEV-REG-MP2', 'موقع اختبار الانحدار من جزأين (وهمي)', ST_GeomFromText(
    'MULTIPOLYGON(((56.0000 25.1000, 56.0030 25.1000, 56.0030 25.1027, 56.0000 25.1027, 56.0000 25.1000)),
                  ((56.0045 25.1008, 56.0057 25.1008, 56.0057 25.1019, 56.0045 25.1019, 56.0045 25.1008)))', 4326)),
  ('DEV-SS-2', 'قسم النقل والحركة الإدارية (وهمي)', '0-DEV-PT', 'موقع اختبار الانحدار — علامة فقط (وهمي)',
    ST_SetSRID(ST_MakePoint(55.9550, 25.1350), 4326)),
  ('DEV-SS-3', 'قسم اختبار المضلع الرباعي (وهمي)', 'DEV-REG-P4', 'موقع اختبار الانحدار — مضلع رباعي (وهمي)', ST_GeomFromText(
    'POLYGON((55.9200 25.1600, 55.9224 25.1600, 55.9224 25.1622, 55.9200 25.1622, 55.9200 25.1600))', 4326));
alter table fx add column org_id uuid, add column site_id uuid;
update fx set org_id = md5('dev-reg:org:' || org_code)::uuid, site_id = md5('dev-reg:site:' || site_code)::uuid;

do $$
declare r record;
begin
  if coalesce(shobj_description((select oid from pg_database where datname = current_database()), 'pg_database'), '') like 'ACCEPTANCE%' then
    raise exception 'refused: this is the acceptance database; development data only';
  end if;
  if not exists (select 1 from organization where code = 'HR-T-SS') or not exists (select 1 from person where username = 't.admin') then
    raise exception 'refused: HR-T-SS or t.admin missing';
  end if;
  for r in select * from fx loop
    if not ST_IsValid(r.geom) then raise exception 'fixture % not valid', r.site_code; end if;
    if exists (select 1 from organization where code = r.org_code and id <> r.org_id) then raise exception 'unit code % taken', r.org_code; end if;
    if exists (select 1 from site where code = r.site_code and id <> r.site_id) then raise exception 'site code % taken', r.site_code; end if;
    if exists (select 1 from org_stationing x where x.organization_id = r.org_id and x.valid_to is null and x.site_id <> r.site_id) then
      raise exception 'unit % stationed elsewhere', r.org_code;
    end if;
    if exists (select 1 from site s join site_geometry_version v on v.site_id = s.id and v.version = s.geometry_version
                where s.id <> r.site_id and v.geom is not null and ST_DWithin(v.geom::geography, r.geom::geography, 5000)) then
      raise exception 'fixture % is within 5 km of an existing boundary', r.site_code;
    end if;
  end loop;
end $$;

insert into organization(id, code, name, parent_id, status, valid_from, source)
select org_id, org_code, org_name, (select id from organization where code = 'HR-T-SS'), 'ACTIVE', '2026-01-01T00:00:00Z', 'LOCAL'
  from fx on conflict do nothing;

insert into site(id, code, name, kind, lat, lng, created_at, geometry_version)
select site_id, site_code, site_name, 'موقع تطوير وهمي (اختبارات الانحدار)', ST_Y(ST_PointOnSurface(geom)), ST_X(ST_PointOnSurface(geom)), now(),
       case when GeometryType(geom) = 'POINT' then null else 1 end
  from fx on conflict do nothing;

insert into site_geometry_version(id, site_id, version, geojson, crs, source, valid_from, geom, geometry_type, reason)
select md5('dev-reg:sgv:' || site_code)::uuid, site_id, 1, ST_AsGeoJSON(geom)::jsonb, 'EPSG:4326', 'بيانات تطوير وهمية', now(), geom,
       case GeometryType(geom) when 'MULTIPOLYGON' then 'MultiPolygon' else 'Polygon' end,
       'بيانات تطوير وهمية لاختبارات الانحدار (Stationing)'
  from fx where GeometryType(geom) <> 'POINT' on conflict do nothing;

insert into site_responsibility(id, site_id, organization_id, valid_from)
select md5('dev-reg:resp:' || site_code)::uuid, site_id, org_id, '2026-01-01T00:00:00Z' from fx on conflict do nothing;

insert into org_stationing(id, organization_id, site_id, kind, valid_from, origin, reason, reference, recorded_by)
select md5('dev-reg:stn:' || org_code)::uuid, org_id, site_id, 'PERMANENT', now(), 'CORRECTION',
       'تمركز أولي — بيانات تطوير وهمية لاختبارات الانحدار (Stationing)', 'DEV-REGRESSION',
       (select id from person where username = 't.admin')
  from fx
 where not exists (select 1 from org_stationing x where x.organization_id = fx.org_id and x.valid_to is null)
on conflict do nothing;

select fx.org_code || ' «' || fx.org_name || '» at ' || fx.site_code || ' ' || coalesce(v.geometry_type, 'Point (marker only)')
       || ' parts=' || coalesce(ST_NumGeometries(v.geom), 0) || ' vertices=' || coalesce(ST_NPoints(v.geom), 1)
       || ' area_m2=' || coalesce(round(ST_Area(v.geom::geography))::text, '-')
       || ' stationed=' || exists (select 1 from org_stationing x where x.organization_id = fx.org_id and x.site_id = fx.site_id and x.valid_to is null)
  from fx join site s on s.id = fx.site_id left join site_geometry_version v on v.site_id = s.id and v.version = s.geometry_version
 order by 1;
commit;
