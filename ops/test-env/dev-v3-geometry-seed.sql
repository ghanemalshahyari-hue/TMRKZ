-- DEVELOPMENT ONLY (tmrkz-v3dev; never tmrkz-test or tmrkz-mover): fictional current sites of several geometry kinds for the
-- Stationing V3 geometry editing (owner, 4 Nov 2026) — a two-part MultiPolygon (إدارة التقنية), a four-part MultiPolygon
-- (وحدة الصيانة الإدارية) and a dense polygon of about 1,500 vertices (فريق مرافق الشمال). Re-running replaces them.
--   docker exec -i tmrkz-v3dev-db-1 psql -U mover -d mover -v ON_ERROR_STOP=1 -f - < ops/test-env/dev-v3-geometry-seed.sql
\set ON_ERROR_STOP on
begin;

do $$
begin
  if coalesce(shobj_description((select oid from pg_database where datname = current_database()), 'pg_database'), '') like 'ACCEPTANCE%' then
    raise exception 'refused: this is the acceptance database; development data only';
  end if;
end $$;

create temp table g(code text, name text, unit text, geom geometry) on commit drop;
insert into g values
  ('DEV-MP2', 'موقع تطوير من جزأين (وهمي)', 'HR-T-IT', ST_SetSRID(ST_GeomFromText(
    'MULTIPOLYGON(((55.4500 25.3000, 55.4520 25.3000, 55.4520 25.3018, 55.4500 25.3018, 55.4500 25.3000)),
                  ((55.4535 25.3004, 55.4549 25.3004, 55.4549 25.3016, 55.4535 25.3016, 55.4535 25.3004)))'), 4326)),
  ('DEV-MP4', 'موقع تطوير من أربعة أجزاء (وهمي)', 'HR-T-PM-1-1', ST_SetSRID(ST_GeomFromText(
    'MULTIPOLYGON(((55.4700 25.3000, 55.4716 25.3000, 55.4716 25.3014, 55.4700 25.3014, 55.4700 25.3000)),
                  ((55.4726 25.3000, 55.4736 25.3000, 55.4736 25.3010, 55.4726 25.3010, 55.4726 25.3000)),
                  ((55.4700 25.3024, 55.4712 25.3024, 55.4712 25.3034, 55.4700 25.3034, 55.4700 25.3024)),
                  ((55.4722 25.3022, 55.4738 25.3022, 55.4730 25.3036, 55.4722 25.3022)))'), 4326)),
  ('DEV-DENSE', 'موقع تطوير كثيف الرؤوس (وهمي)', 'HR-T-PM-1-1-1', (
    select ST_SetSRID(ST_MakePolygon(ST_AddPoint(l, ST_StartPoint(l))), 4326)
      from (select ST_MakeLine(ST_MakePoint(55.4900 + 0.0012 * (1 + 0.04 * sin(12 * t)) * cos(t),
                                            25.3010 + 0.0011 * (1 + 0.04 * sin(12 * t)) * sin(t)) order by t) as l
              from (select 2 * pi() * i / 1500 as t from generate_series(0, 1499) i) s) x));

-- the sites and their boundaries
delete from org_stationing where site_id in (select id from site where code in (select code from g));
delete from site_geometry_version where site_id in (select id from site where code in (select code from g));
delete from site_responsibility where site_id in (select id from site where code in (select code from g));
delete from site where code in (select code from g);
insert into site(id, code, name, kind, lat, lng, created_at, geometry_version)
select gen_random_uuid(), code, name, 'موقع تطوير', ST_Y(ST_Centroid(geom)), ST_X(ST_Centroid(geom)), now(), 1 from g;
insert into site_geometry_version(id, site_id, version, geojson, crs, source, valid_from, geom, geometry_type, reason)
select gen_random_uuid(), s.id, 1, ST_AsGeoJSON(g.geom)::jsonb, 'EPSG:4326', 'بيانات تطوير وهمية', now(), g.geom,
       case GeometryType(g.geom) when 'MULTIPOLYGON' then 'MultiPolygon' else 'Polygon' end,
       'بيانات تطوير وهمية لتحرير الهندسة'
  from g join site s on s.code = g.code;
insert into site_responsibility(id, site_id, organization_id, valid_from)
select gen_random_uuid(), s.id, o.id, now() from g join site s on s.code = g.code join organization o on o.code = g.unit;

-- each unit's current permanent stationing becomes the new site
update org_stationing set valid_to = now(), end_reason = 'CORRECTED', ended_at = now()
 where organization_id in (select o.id from g join organization o on o.code = g.unit) and valid_to is null;
insert into org_stationing(id, organization_id, site_id, kind, valid_from, origin, reason, recorded_by)
select gen_random_uuid(), o.id, s.id, 'PERMANENT', now(), 'CORRECTION', 'بيانات تطوير وهمية لتحرير الهندسة',
       (select id from person where username = 't.admin')
  from g join organization o on o.code = g.unit join site s on s.code = g.code;

select s.code || ' ' || v.geometry_type || ' parts=' || ST_NumGeometries(v.geom) || ' points=' || ST_NPoints(v.geom) || ' valid=' || ST_IsValid(v.geom)
  from site s join site_geometry_version v on v.site_id = s.id where s.code in (select code from g) order by 1;
commit;
