-- FICTIONAL development values for the Stationing V3 work in progress (ops/test-env/dev-v3.sh seed). Only for the
-- disposable development project tmrkz-v3dev; never for the acceptance or production database. Every value below is
-- illustrative: levels, approver seats, the starting stationing, site boundaries and the policy are NOT owner or
-- production values (the production policy and its allowances are the System Administrator's).
begin;

-- 1. levels of the fictional units in the published HR snapshot (Oracle sends them in production; L6 top … L10)
update hr_unit h set level = v.level
  from (values ('T-ORG', 6), ('T-GA', 7), ('T-IT', 7), ('T-PM', 7), ('T-SS', 7), ('T-PM-1', 8), ('T-PM-1-1', 9),
               ('T-PM-1-1-1', 10)) as v(ext, level)
 where h.external_id = v.ext and h.snapshot_id = (select id from hr_snapshot where status = 'PUBLISHED');

-- 2. simple fictional boundaries (about 240 m squares) around the sites' markers, as boundary version 1
insert into site_geometry_version(id, site_id, version, geojson, crs, source, valid_from, geom, geometry_type, original_format, reason)
select gen_random_uuid(), s.id, 1, ST_AsGeoJSON(b.g)::jsonb, 'EPSG:4326', 'حدود تطوير وهمية', now(), b.g, 'Polygon', 'DEV', 'بيئة تطوير'
  from site s
  cross join lateral (select ST_SetSRID(ST_MakeEnvelope(s.lng - 0.0012, s.lat - 0.0011, s.lng + 0.0012, s.lat + 0.0011), 4326) as g) b
 where s.lat is not null and s.geometry_version is null;
update site s set geometry_version = 1 where geometry_version is null and exists (select 1 from site_geometry_version g where g.site_id = s.id);

-- 3. where each fictional unit is stationed now (a data correction record)
insert into org_stationing(id, organization_id, site_id, kind, valid_from, origin, reason, reference, recorded_by)
select gen_random_uuid(), o.id, s.id, 'PERMANENT', now() - interval '30 days', 'CORRECTION', 'تمركز أولي لبيئة التطوير', 'DEV',
       (select id from person where username = 't.admin')
  from (values ('HR-T-ORG', '00'), ('HR-T-GA', '01'), ('HR-T-SS', '02'), ('HR-T-PM', '03'), ('HR-T-PM-1', '03'),
               ('HR-T-IT', '06'), ('HR-T-PM-1-1', '10'), ('HR-T-PM-1-1-1', '10')) as v(org, site)
  join organization o on o.code = v.org
  join site s on s.code = v.site
 where not exists (select 1 from org_stationing x where x.organization_id = o.id and x.valid_to is null);

-- 4. roles and seats: who requests, who approves at which unit (the seat is the unit itself), who decides the distance
--    exception, who activates
insert into role_def(code, name, permissions, scope, summary_only, sort_order) values
  ('DEV_RESTATIONING_REQUESTER', 'مقدم طلب إعادة تمركز (تطوير)', '{VIEW,CREATE_RESTATIONING}', 'ORGANIZATION', false, 950),
  ('DEV_RESTATIONING_APPROVER', 'معتمد إعادة التمركز في الوحدة (تطوير)', '{VIEW,APPROVE}', 'ORGANIZATION', false, 951),
  ('DEV_DISTANCE_EXCEPTION', 'معتمد استثناء مسافة الانتشار (تطوير)', '{VIEW,APPROVE_DEPLOYMENT_DISTANCE_EXCEPTION}', 'ALL', false, 952),
  ('DEV_STATIONING_ACTIVATOR', 'مفعّل التمركز (تطوير)', '{VIEW,ACTIVATE_STATIONING}', 'ORGANIZATION', false, 953)
on conflict (code) do nothing;
insert into membership(id, person_id, organization_id, role_code, valid_from, follows_affiliation)
select gen_random_uuid(), p.id, o.id, v.role, now() - interval '1 day', false
  from (values ('t.requester', 'HR-T-SS', 'DEV_RESTATIONING_REQUESTER'),
               ('t.manager.ga', 'HR-T-PM-1', 'DEV_RESTATIONING_REQUESTER'),
               ('t.requester2', 'HR-T-IT', 'DEV_RESTATIONING_REQUESTER'),
               ('t.manager', 'HR-T-SS', 'DEV_RESTATIONING_APPROVER'),
               ('t.manager.ga', 'HR-T-PM', 'DEV_RESTATIONING_APPROVER'),
               ('t.manager.it', 'HR-T-IT', 'DEV_RESTATIONING_APPROVER'),
               ('t.approver', 'HR-T-ORG', 'DEV_RESTATIONING_APPROVER'),
               ('t.approver2', 'HR-T-GA', 'DEV_DISTANCE_EXCEPTION'),
               ('t.facilities', 'HR-T-ORG', 'DEV_STATIONING_ACTIVATOR')) as v(username, org, role)
  join person p on p.username = v.username
  join organization o on o.code = v.org
 where not exists (select 1 from membership m where m.person_id = p.id and m.organization_id = o.id and m.role_code = v.role);

-- 5. a policy version with ILLUSTRATIVE development values (needs the terrain dataset loaded by load-slope.sh first)
insert into stationing_policy_version(id, version, policy_values, effective_from, reason, reference, created_by, created_at)
select gen_random_uuid(), 1, $$
{
  "maxFootprintAreaM2": 200000,
  "deploymentRequirement": "REQUIRED",
  "primary": {"minM": 5000, "maxM": 8000, "terrainApplies": true},
  "alternative": {"minM": 3000, "maxM": 5000, "terrainApplies": true},
  "terrainSlopeClassification": {"datasetCode": "copernicus-glo30", "datasetVersion": "2026.11", "classes": [
    {"code": "FLAT", "label": "مستوٍ / شبه مستوٍ", "fromPct": 0, "toPct": 2},
    {"code": "UNDULATING", "label": "متموّج", "fromPct": 2, "toPct": 10},
    {"code": "ROLLING", "label": "تضاريس متدرجة", "fromPct": 10, "toPct": 15},
    {"code": "HILLY", "label": "تلال", "fromPct": 15, "toPct": 30},
    {"code": "MOUNTAINOUS", "label": "جبلي / شديد التضرس", "fromPct": 30, "toPct": null}]},
  "terrainAllowancesM": {"FLAT": 0, "UNDULATING": 500, "ROLLING": 1000, "HILLY": 2000, "MOUNTAINOUS": 3000},
  "terrainClassPriority": ["UNDULATING", "FLAT", "ROLLING", "HILLY", "MOUNTAINOUS"],
  "terrainAppliesTo": "MAX_ONLY",
  "exception": {"allowed": true, "maxExtraM": 1000},
  "crossBranch": {"allowed": true, "authorities": ["OTHER_UNIT"], "independent": false},
  "routing": {"startAt": "SELF", "levels": [
    {"level": 10, "approves": false, "label": "الفريق", "finalStage": false, "dependsOn": []},
    {"level": 9, "approves": true, "label": "اعتماد الوحدة", "finalStage": false, "dependsOn": ["SCOPE"]},
    {"level": 8, "approves": true, "label": "اعتماد القسم", "finalStage": false, "dependsOn": ["SCOPE", "SITE"]},
    {"level": 7, "approves": true, "label": "اعتماد الإدارة", "finalStage": false, "dependsOn": ["SCOPE", "SITE", "DURATION"]},
    {"level": 6, "approves": true, "label": "الاعتماد النهائي", "finalStage": true, "dependsOn": []}]}
}
$$::jsonb, now(), 'قيم تطوير توضيحية لبيئة العرض فقط — ليست قيم الإنتاج', 'DEV-1', (select id from person where username = 't.admin'), now()
 where not exists (select 1 from stationing_policy_version);

commit;
