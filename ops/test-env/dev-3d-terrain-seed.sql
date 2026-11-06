-- DEVELOPMENT ONLY (tmrkz-v3dev; never tmrkz-test or tmrkz-mover): FICTIONAL sites on real relief for the 3D terrain
-- view (owner brief «TRUE OFFLINE 3D TERRAIN», 6 Nov 2026). The coordinates are generic open terrain of the Hajar
-- foothills chosen from the GLO-30 elevations (a plain at about 380 m with slopes up to about 900 m within 7 km), not
-- any real facility; every name says «وهمي». Re-running replaces them.
--   docker exec -i tmrkz-v3dev-db-1 psql -U mover -d mover -v ON_ERROR_STOP=1 -f - < ops/test-env/dev-3d-terrain-seed.sql
-- Needs ops/test-env/dev-v3-seed.sql first (fictional levels, roles, policy v1) and the slope analysis loaded.
\set ON_ERROR_STOP on
begin;

do $$
begin
  if coalesce(shobj_description((select oid from pg_database where datname = current_database()), 'pg_database'), '') like 'ACCEPTANCE%' then
    raise exception 'refused: this is the acceptance database; development data only';
  end if;
end $$;

-- unit null: a registered reference site with no unit stationed (grey on the map)
create temp table g(code text, name text, unit text, geom geometry) on commit drop;
insert into g values
  ('D3-CUR', 'موقع السهل الغربي (وهمي)', 'HR-T-SS', ST_GeomFromText('POLYGON((56.030653 24.841874, 56.033651 24.840311, 56.033284 24.837239, 56.030885 24.835636, 56.027689 24.835571, 56.026540 24.838343, 56.027446 24.841137, 56.030653 24.841874))', 4326)),
  ('D3-OCC', 'موقع المنحدر الجنوبي (وهمي)', 'HR-T-IT', ST_GeomFromText('POLYGON((56.008880 24.805203, 56.010924 24.803470, 56.009527 24.801342, 56.007052 24.800627, 56.005564 24.802609, 56.006155 24.805003, 56.008880 24.805203))', 4326)),
  ('D3-REF1', 'موقع وادي الشرق (وهمي)', null, ST_GeomFromText('POLYGON((56.086000 24.874074, 56.088448 24.872724, 56.087397 24.870249, 56.084545 24.870176, 56.083928 24.872613, 56.086000 24.874074))', 4326)),
  ('D3-REF2', 'موقع الكتف الجنوبي (وهمي)', null, ST_GeomFromText('POLYGON((56.133614 24.758090, 56.135173 24.756104, 56.133922 24.753811, 56.131232 24.754695, 56.130926 24.757228, 56.133614 24.758090))', 4326)),
  ('D3-MP2', 'موقع من جزأين على السهل (وهمي)', 'HR-T-PM-1', ST_GeomFromText('MULTIPOLYGON(((56.030000 24.903074, 56.032355 24.901697, 56.031281 24.899395, 56.028603 24.899249, 56.027787 24.901655, 56.030000 24.903074)),
      ((56.037943 24.904671, 56.038658 24.902734, 56.036408 24.902251, 56.035999 24.904131, 56.037943 24.904671)))', 4326)),
  ('D3-MP4', 'موقع من أربعة أجزاء (وهمي)', 'HR-T-PM-1-1', ST_GeomFromText('MULTIPOLYGON(((56.089051 24.920956, 56.089121 24.918980, 56.087019 24.919107, 56.086914 24.920988, 56.089051 24.920956)),
      ((56.094051 24.920956, 56.094121 24.918980, 56.092019 24.919107, 56.091914 24.920988, 56.094051 24.920956)),
      ((56.089051 24.924956, 56.089121 24.922980, 56.087019 24.923107, 56.086914 24.924988, 56.089051 24.924956)),
      ((56.094051 24.924956, 56.094121 24.922980, 56.092019 24.923107, 56.091914 24.924988, 56.094051 24.924956)))', 4326)),
  ('D3-DENSE', 'موقع كثيف الرؤوس (وهمي)', 'HR-T-PM-1-1-1', (
    select ST_SetSRID(ST_MakePolygon(ST_AddPoint(l, ST_StartPoint(l))), 4326)
      from (select ST_MakeLine(ST_MakePoint(56.1120 + 0.0024 * (1 + 0.05 * sin(12 * t)) * cos(t),
                                            24.8940 + 0.0021 * (1 + 0.05 * sin(12 * t)) * sin(t)) order by t) as l
              from (select 2 * pi() * i / 1500 as t from generate_series(0, 1499) i) s) x));

delete from org_stationing where site_id in (select id from site where code in (select code from g));
delete from site_geometry_version where site_id in (select id from site where code in (select code from g));
delete from site_responsibility where site_id in (select id from site where code in (select code from g));
delete from site where code in (select code from g);
insert into site(id, code, name, kind, lat, lng, created_at, geometry_version)
select gen_random_uuid(), code, name, 'موقع تطوير', ST_Y(ST_PointOnSurface(geom)), ST_X(ST_PointOnSurface(geom)), now(), 1 from g;
insert into site_geometry_version(id, site_id, version, geojson, crs, source, valid_from, geom, geometry_type, reason)
select gen_random_uuid(), s.id, 1, ST_AsGeoJSON(g.geom)::jsonb, 'EPSG:4326', 'بيانات تطوير وهمية', now(), g.geom,
       case GeometryType(g.geom) when 'MULTIPOLYGON' then 'MultiPolygon' else 'Polygon' end,
       'بيانات تطوير وهمية لعرض طبيعة الأرض ثلاثية الأبعاد'
  from g join site s on s.code = g.code;
insert into site_responsibility(id, site_id, organization_id, valid_from)
select gen_random_uuid(), s.id, coalesce(o.id, (select id from organization where code = 'HR-T-GA')), now()
  from g join site s on s.code = g.code left join organization o on o.code = g.unit;

-- each unit's current permanent stationing becomes its new fictional site (reference sites have none)
update org_stationing set valid_to = now(), end_reason = 'CORRECTED', ended_at = now()
 where organization_id in (select o.id from g join organization o on o.code = g.unit) and valid_to is null;
insert into org_stationing(id, organization_id, site_id, kind, valid_from, origin, reason, recorded_by)
select gen_random_uuid(), o.id, s.id, 'PERMANENT', now(), 'CORRECTION', 'بيانات تطوير وهمية لعرض طبيعة الأرض ثلاثية الأبعاد',
       (select id from person where username = 't.admin')
  from g join organization o on o.code = g.unit join site s on s.code = g.code;

-- the requesters also READ every unit's stationing, so the other units' sites show as occupied ground (development only)
insert into role_def(code, name, permissions, scope, summary_only, sort_order) values
  ('DEV_VIEW_ALL', 'اطلاع على كل الوحدات (تطوير)', '{VIEW}', 'ORGANIZATION', false, 954)
on conflict (code) do nothing;
insert into membership(id, person_id, organization_id, role_code, valid_from, follows_affiliation)
select gen_random_uuid(), p.id, o.id, 'DEV_VIEW_ALL', now() - interval '1 day', false
  from person p, organization o
 where p.username in ('t.requester', 't.manager.ga') and o.code = 'HR-T-ORG'
   and not exists (select 1 from membership m where m.person_id = p.id and m.organization_id = o.id and m.role_code = 'DEV_VIEW_ALL');

-- policy version 2 for development: the owner's ACCEPTANCE values (ops/test-env/acceptance-v3-policy-template.json, 4 Nov
-- 2026) with the labelled acceptance initial area of a click-placed deployment area (SQUARE 90,000 m², 5 Nov 2026).
-- NOT production values: production keeps the deployment-area default unset.
insert into stationing_policy_version(id, version, previous_id, policy_values, effective_from, reason, reference, created_by, created_at)
select gen_random_uuid(), (select max(version) + 1 from stationing_policy_version), (select id from stationing_policy_version order by version desc limit 1), $$
{
  "maxFootprintAreaM2": 500000,
  "deploymentRequirement": "REQUIRED",
  "primary": {"minM": 5000, "maxM": 8000, "terrainApplies": true},
  "alternative": {"minM": 3000, "maxM": 5000, "terrainApplies": true},
  "terrainSlopeClassification": {"datasetCode": "copernicus-glo30", "datasetVersion": "2026.11", "classes": [
    {"code": "FLAT", "label": "مستوٍ / شبه مستوٍ", "fromPct": 0, "toPct": 2},
    {"code": "UNDULATING", "label": "متموّج", "fromPct": 2, "toPct": 10},
    {"code": "ROLLING", "label": "تضاريس متدرجة", "fromPct": 10, "toPct": 15},
    {"code": "HILLY", "label": "تلال", "fromPct": 15, "toPct": 30},
    {"code": "MOUNTAINOUS", "label": "جبلي / شديد التضرس", "fromPct": 30, "toPct": null}]},
  "terrainAllowancesM": {"FLAT": 0, "UNDULATING": 500, "ROLLING": 1000, "HILLY": 1500, "MOUNTAINOUS": 2000},
  "terrainClassPriority": ["MOUNTAINOUS", "HILLY", "ROLLING", "UNDULATING", "FLAT"],
  "terrainAppliesTo": "MAX_ONLY",
  "exception": {"allowed": false, "maxExtraM": 0},
  "crossBranch": {"allowed": true, "authorities": ["OTHER_UNIT", "SITE_RESPONSIBLE"], "independent": false},
  "routing": {"startAt": "SELF", "levels": [
    {"level": 10, "approves": false, "label": "الفريق", "finalStage": false, "dependsOn": []},
    {"level": 9, "approves": true, "label": "اعتماد الوحدة", "finalStage": false, "dependsOn": ["SCOPE"]},
    {"level": 8, "approves": true, "label": "اعتماد القسم", "finalStage": false, "dependsOn": ["SCOPE", "SITE"]},
    {"level": 7, "approves": true, "label": "اعتماد الإدارة", "finalStage": false, "dependsOn": ["SCOPE", "SITE", "DURATION"]},
    {"level": 6, "approves": true, "label": "الاعتماد النهائي", "finalStage": true, "dependsOn": []}]},
  "deploymentAreaDefault": {"shape": "SQUARE", "areaM2": 90000}
}
$$::jsonb, now(), 'قيم قبول تجريبية لبيئة التطوير (عرض طبيعة الأرض ثلاثية الأبعاد) — ليست قيم الإنتاج',
       'DEV-3D · قيمة قبول تجريبية — ليست قيمة إنتاجية معتمدة', (select id from person where username = 't.admin'), now()
 where not exists (select 1 from stationing_policy_version where reference like 'DEV-3D%');

select s.code || ' ' || v.geometry_type || ' parts=' || ST_NumGeometries(v.geom) || ' area_m2=' || round(ST_Area(v.geom::geography)) || ' valid=' || ST_IsValid(v.geom)
  from site s join site_geometry_version v on v.site_id = s.id where s.code in (select code from g) order by 1;
commit;
