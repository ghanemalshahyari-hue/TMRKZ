-- FICTIONAL ACCEPTANCE DATA — Stationing V3 geometry editing PERFORMANCE fixtures on tmrkz-test (owner gate «GEOMETRY
-- IMPLEMENTATION → tmrkz-test ACCEPTANCE GO», 4 Nov 2026: a four-part MultiPolygon and a polygon of about 1,500
-- vertices). Run only through ops/test-env/provision-acceptance-v3-geometry.sh. Refuses any database not labelled
-- ACCEPTANCE and any schema other than V20. Idempotent: stable fictional ids; what already exists is left as it is and a
-- second run writes nothing. It never overwrites an existing site, boundary, unit or stationing: a code already used by
-- something else, a different boundary under a fixture code, a fixture unit stationed elsewhere or a fixture boundary
-- touching any current boundary stops the run. It does not copy the development seed (dev-v3-geometry-seed.sql).
--
-- Every existing unit already has a current stationing and the building-projects units carry open requests, so each
-- fixture is carried by a NEW fictional LOCAL section of «قسم مشاريع المباني» (HR-T-PM-1), the same kind of local
-- section as T-SS-1/T-SS-2: no HR unit, level, policy, terrain, existing site or existing stationing is changed. A child
-- section changes no requesting unit's own path, so no open request drifts.
\set ON_ERROR_STOP on
begin;

create temp table fx(org_code text, org_name text, site_code text, site_name text, geom geometry) on commit drop;
insert into fx values
  ('T-PM-1-G4', 'قسم قبول الأداء — موقع من أربعة أجزاء (بيانات قبول وهمية)', 'ACC-GEO-MP4',
   'موقع قبول الأداء — أربعة أجزاء (وهمي)', ST_SetSRID(ST_GeomFromText(
    'MULTIPOLYGON(((55.4000 25.2290, 55.4016 25.2290, 55.4016 25.2304, 55.4000 25.2304, 55.4000 25.2290)),
                  ((55.4026 25.2290, 55.4036 25.2290, 55.4036 25.2300, 55.4026 25.2300, 55.4026 25.2290)),
                  ((55.4000 25.2314, 55.4012 25.2314, 55.4012 25.2324, 55.4000 25.2324, 55.4000 25.2314)),
                  ((55.4022 25.2312, 55.4038 25.2312, 55.4030 25.2326, 55.4022 25.2312)))'), 4326)),
  ('T-PM-1-G1500', 'قسم قبول الأداء — موقع كثيف الرؤوس (بيانات قبول وهمية)', 'ACC-GEO-DENSE',
   'موقع قبول الأداء — 1500 رأس (وهمي)', (
    select ST_SetSRID(ST_MakePolygon(ST_AddPoint(l, ST_StartPoint(l))), 4326)
      from (select ST_MakeLine(ST_MakePoint(55.4200 + 0.0012 * (1 + 0.04 * sin(12 * t)) * cos(t),
                                            25.2300 + 0.0011 * (1 + 0.04 * sin(12 * t)) * sin(t)) order by t) as l
              from (select 2 * pi() * i / 1500 as t from generate_series(0, 1499) i) s) x));
alter table fx add column org_id uuid, add column site_id uuid;
update fx set org_id = md5('t:org:' || org_code)::uuid, site_id = md5('t:site:' || site_code)::uuid;

do $$
declare r record;
begin
  if coalesce(shobj_description((select oid from pg_database where datname = current_database()), 'pg_database'), '') not like 'ACCEPTANCE%' then
    raise exception 'refused: the database is not labelled ACCEPTANCE';
  end if;
  if (select max(version::int) from flyway_schema_history where success and version is not null) <> 20 then
    raise exception 'refused: these fixtures are defined for schema V20 (found V%)',
      (select max(version::int) from flyway_schema_history where success and version is not null);
  end if;
  if not exists (select 1 from organization where code = 'HR-T-PM-1' and source = 'HR') then
    raise exception 'refused: the HR unit HR-T-PM-1 (قسم مشاريع المباني) is missing';
  end if;
  if not exists (select 1 from person where username = 't.admin') then
    raise exception 'refused: the fictional recorder t.admin is missing';
  end if;
  for r in select * from fx loop
    if not ST_IsValid(r.geom) then
      raise exception 'refused: fixture % is not valid (%)', r.site_code, ST_IsValidReason(r.geom);
    end if;
    if exists (select 1 from organization where code = r.org_code and id <> r.org_id) then
      raise exception 'refused: unit code % already belongs to another unit', r.org_code;
    end if;
    if exists (select 1 from site where code = r.site_code and id <> r.site_id) then
      raise exception 'refused: site code % already belongs to another site', r.site_code;
    end if;
    if exists (select 1 from site s join site_geometry_version v on v.site_id = s.id and v.version = s.geometry_version
                where s.id = r.site_id and not ST_Equals(v.geom, r.geom)) then
      raise exception 'refused: site % already has a different boundary; it is not overwritten', r.site_code;
    end if;
    if exists (select 1 from org_stationing x where x.organization_id = r.org_id and x.valid_to is null and x.site_id <> r.site_id) then
      raise exception 'refused: unit % is stationed elsewhere; its stationing is not changed', r.org_code;
    end if;
    if exists (select 1 from site s join site_geometry_version v on v.site_id = s.id and v.version = s.geometry_version
                where s.id <> r.site_id and v.geom is not null and ST_Intersects(v.geom, r.geom)) then
      raise exception 'refused: fixture % touches an existing current boundary', r.site_code;
    end if;
  end loop;
end $$;

create temp table provisioned(item text primary key, n integer) on commit drop;

-- 1. the fictional local sections (the authorisation structure follows through the organisation trigger)
with ins as (
  insert into organization(id, code, name, parent_id, status, valid_from, source)
  select fx.org_id, fx.org_code, fx.org_name, (select id from organization where code = 'HR-T-PM-1'), 'ACTIVE',
         '2026-01-01T00:00:00Z', 'LOCAL'
    from fx
  on conflict do nothing
  returning code)
insert into provisioned select 'units_added: ' || coalesce(string_agg(code, ', ' order by code), '-'), count(*) from ins;

-- 2. the sites and their first boundary
with ins as (
  insert into site(id, code, name, kind, lat, lng, created_at, geometry_version)
  select fx.site_id, fx.site_code, fx.site_name, 'موقع قبول وهمي (أداء تحرير الهندسة)', ST_Y(ST_Centroid(fx.geom)),
         ST_X(ST_Centroid(fx.geom)), now(), 1
    from fx
  on conflict do nothing
  returning code)
insert into provisioned select 'sites_added: ' || coalesce(string_agg(code, ', ' order by code), '-'), count(*) from ins;

with ins as (
  insert into site_geometry_version(id, site_id, version, geojson, crs, source, valid_from, geom, geometry_type,
                                    original_format, reason, created_by)
  select md5('t:sgv:' || fx.site_code || ':1')::uuid, fx.site_id, 1, ST_AsGeoJSON(fx.geom)::jsonb, 'EPSG:4326',
         'حدود قبول وهمية (أداء تحرير الهندسة)', now(), fx.geom,
         case GeometryType(fx.geom) when 'MULTIPOLYGON' then 'MultiPolygon' else 'Polygon' end, 'ACCEPTANCE',
         'بيانات قبول وهمية — أداء تحرير الهندسة (Stationing V3)', (select id from person where username = 't.admin')
    from fx
  on conflict do nothing
  returning site_id)
insert into provisioned select 'boundaries_added', count(*) from ins;

with ins as (
  insert into site_responsibility(id, site_id, organization_id, valid_from)
  select md5('t:resp:' || fx.site_code)::uuid, fx.site_id, fx.org_id, '2026-01-01T00:00:00Z' from fx
  on conflict do nothing
  returning 1)
insert into provisioned select 'responsibilities_added', count(*) from ins;

-- 3. each section is stationed at its own fixture (a recorded fact, origin CORRECTION; no outbound event)
with ins as (
  insert into org_stationing(id, organization_id, site_id, kind, valid_from, origin, reason, reference, recorded_by)
  select md5('t:stn:' || fx.org_code)::uuid, fx.org_id, fx.site_id, 'PERMANENT', now(), 'CORRECTION',
         'تمركز أولي — بيانات قبول وهمية (أداء تحرير الهندسة)', 'ACCEPTANCE-V3-GEOMETRY',
         (select id from person where username = 't.admin')
    from fx
   where not exists (select 1 from org_stationing x where x.organization_id = fx.org_id and x.valid_to is null)
  on conflict do nothing
  returning 1)
insert into provisioned select 'stationings_added', count(*) from ins;

insert into audit_event(actor_person_id, actor_name, action, entity_type, entity_id, entity_label, detail, reason)
select null, 'النظام', 'ACCEPTANCE_DATA_PROVISIONED', 'ACCEPTANCE_DATA', 'stationing-v3-geometry-performance',
       'بيانات قبول وهمية — أداء تحرير الهندسة', (select jsonb_object_agg(item, n) from provisioned),
       'بوابة المالك (4 نوفمبر 2026): موقع من أربعة أجزاء ومضلع بنحو 1500 رأس على tmrkz-test'
 where :'apply' = 'on' and (select sum(n) from provisioned) > 0;

select item || ' = ' || n from provisioned order by item;
select 'total_changes = ' || sum(n) from provisioned;
select fx.site_code || ' ' || v.geometry_type || ' parts=' || ST_NumGeometries(v.geom) || ' vertices=' || ST_NPoints(v.geom)
       || ' valid=' || ST_IsValid(v.geom) || ' area_m2=' || round(ST_Area(v.geom::geography)) || ' unit=' || o.code
       || ' stationed=' || exists (select 1 from org_stationing x where x.organization_id = o.id and x.site_id = s.id and x.valid_to is null)
  from fx join site s on s.id = fx.site_id join site_geometry_version v on v.site_id = s.id and v.version = s.geometry_version
  join organization o on o.id = fx.org_id order by 1;

\if :apply
commit;
\else
rollback;
\endif
