-- DEVELOPMENT ONLY (tmrkz-v3dev): boundary version 2 of the fictional fixture DEV-REG-P4 — a 4-vertex RECTANGLE
-- (about 303 m x 200 m) instead of the near-square of version 1, so that geometry-old-sequence S6 (drag of vertex 1 by
-- +30,+30 px) changes the area, as the accepted run's site did. Only the fixture of dev-regression-fixtures.sql changes.
\set ON_ERROR_STOP on
begin;
insert into site_geometry_version(id, site_id, version, geojson, crs, source, valid_from, geom, geometry_type, reason)
select md5('dev-reg:sgv:DEV-REG-P4:2')::uuid, s.id, 2, ST_AsGeoJSON(g)::jsonb, 'EPSG:4326', 'بيانات تطوير وهمية', now(), g, 'Polygon',
       'بيانات تطوير وهمية لاختبارات الانحدار (Stationing): مستطيل بأربعة رؤوس'
  from site s, (select ST_GeomFromText('POLYGON((55.9200 25.1600, 55.9230 25.1600, 55.9230 25.1618, 55.9200 25.1618, 55.9200 25.1600))', 4326) g) x
 where s.code = 'DEV-REG-P4' and s.id = md5('dev-reg:site:DEV-REG-P4')::uuid
on conflict do nothing;
update site set geometry_version = 2 where code = 'DEV-REG-P4' and id = md5('dev-reg:site:DEV-REG-P4')::uuid;
select s.code || ' v' || v.version || ' ' || v.geometry_type || ' vertices=' || ST_NPoints(v.geom) || ' area_m2=' || round(ST_Area(v.geom::geography))
  from site s join site_geometry_version v on v.site_id = s.id and v.version = s.geometry_version where s.code = 'DEV-REG-P4';
commit;
