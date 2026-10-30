-- Fictional stationing demo data — TEST ENVIRONMENT ONLY (ops/test-env). Never load into a production database.
-- Applied on top of seed.sql for the map stationing journey (ADR-025): example distance rules (the owner configures the
-- real ones in «إعدادات النظام»), two fictional sections of «الخدمات المشتركة», one approved booking that makes site 05
-- occupied, and an illustrative boundary for site 05 so the occupied area is drawn. Re-running changes nothing.
-- Usage: docker exec -i tmrkz-test-db-1 psql -U mover -d mover < ops/test-env/stationing-demo.sql
begin;

insert into placement_rule(id, name, action, station_level, organization_id, include_descendants, min_m, max_m, measure, active)
values
  (md5('t:rule:relocate')::uuid, 'قاعدة تجريبية — التمركز (١–٦ كم)', 'RELOCATE', null, null, true, 1000, 6000, 'CENTER', true),
  (md5('t:rule:work-area')::uuid, 'قاعدة تجريبية — منطقة العمل المؤقتة (حتى ٣ كم)', 'WORK_AREA', null, null, true, 0, 3000, 'CENTER', true)
on conflict do nothing;

-- two fictional sections of SS: one works at the current premises (site 02), one elsewhere (site 08)
insert into organization(id, code, name, parent_id, status, valid_from, source)
values
  (md5('t:org:T-SS-1')::uuid, 'T-SS-1', 'قسم الخدمات العامة', md5('t:org:T-SS')::uuid, 'ACTIVE', '2026-01-01T00:00:00Z', 'LOCAL'),
  (md5('t:org:T-SS-2')::uuid, 'T-SS-2', 'قسم النقل والحركة الإدارية', md5('t:org:T-SS')::uuid, 'ACTIVE', '2026-01-01T00:00:00Z', 'LOCAL')
on conflict do nothing;
insert into reservation(id, resource_id, organization_id, source, period_start, period_end, status, purpose)
values (md5('t:demo:ss1-at-02')::uuid, md5('t:res:R-02')::uuid, md5('t:org:T-SS-1')::uuid, 'SEED_IMPORT',
        '2026-01-01T00:00:00Z', null, 'ACTIVE', 'قسم الخدمات العامة في مركز الخدمات (بيانات تجريبية)')
on conflict do nothing;
insert into reservation_lock(reservation_id, resource_id, kind, period)
select md5('t:demo:ss1-at-02')::uuid, md5('t:res:R-02')::uuid, 'X', tstzrange('2026-01-01T00:00:00Z', null, '[)')
where not exists (select 1 from reservation_lock where reservation_id = md5('t:demo:ss1-at-02')::uuid);
-- site 08 stays with SS; the second section uses it through a booking
insert into reservation(id, resource_id, organization_id, source, period_start, period_end, status, purpose)
values (md5('t:demo:ss2-at-08')::uuid, md5('t:res:R-08')::uuid, md5('t:org:T-SS-2')::uuid, 'SEED_IMPORT',
        '2026-01-01T00:00:00Z', null, 'ACTIVE', 'قسم النقل في مبنى الخدمات الغربية (بيانات تجريبية)')
on conflict do nothing;
insert into reservation_lock(reservation_id, resource_id, kind, period)
select md5('t:demo:ss2-at-08')::uuid, md5('t:res:R-08')::uuid, 'X', tstzrange('2026-01-01T00:00:00Z', null, '[)')
where not exists (select 1 from reservation_lock where reservation_id = md5('t:demo:ss2-at-08')::uuid);

-- site 05 occupied by another organisation until mid-2027 (its sub-rooms are locked with it)
insert into reservation(id, resource_id, organization_id, source, period_start, period_end, status, purpose)
values (md5('t:demo:05-busy')::uuid, md5('t:res:R-05')::uuid, md5('t:org:T-GA')::uuid, 'SEED_IMPORT',
        '2026-01-01T00:00:00Z', '2027-06-30T20:00:00Z', 'ACTIVE', 'إشغال تجريبي لإظهار منطقة محجوزة')
on conflict do nothing;
insert into reservation_lock(reservation_id, resource_id, kind, period)
select md5('t:demo:05-busy')::uuid, r.id, 'X', tstzrange('2026-01-01T00:00:00Z', '2027-06-30T20:00:00Z', '[)')
from resource r where r.id in (md5('t:res:R-05')::uuid, md5('t:res:R-05A')::uuid, md5('t:res:R-05B')::uuid)
  and not exists (select 1 from reservation_lock where reservation_id = md5('t:demo:05-busy')::uuid);

-- illustrative boundary of site 05 (about 900 m × 800 m around its marker)
insert into site_geometry_version(id, site_id, version, geojson, crs, source, valid_from, original_format, reason)
select md5('t:geom:05')::uuid, md5('t:site:05')::uuid, 1,
       '{"type":"Polygon","coordinates":[[[55.3255,25.1725],[55.3345,25.1725],[55.3345,25.1797],[55.3255,25.1797],[55.3255,25.1725]]]}'::jsonb,
       'EPSG:4326', 'DRAWN', now(), 'GEOJSON', 'حدود تجريبية لعرض المنطقة المحجوزة'
where not exists (select 1 from site_geometry_version where site_id = md5('t:site:05')::uuid);
update site set geometry_version = 1 where id = md5('t:site:05')::uuid and geometry_version is null;

commit;
