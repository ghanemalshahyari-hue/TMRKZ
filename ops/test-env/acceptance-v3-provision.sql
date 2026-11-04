-- FICTIONAL ACCEPTANCE DATA for Stationing V3 on tmrkz-test (owner decision D4, 4 Nov 2026). Run only through
-- ops/test-env/provision-acceptance-v3.sh. Idempotent: what already exists is left as it is. It publishes NO policy:
-- submissions stay refused («لا توجد سياسة تمركز نافذة») until the owner supplies the terrain allowance values.
-- Everything written here is identified as fictional acceptance data and is not a production default. The terrain
-- dataset is loaded separately (ops/terrain/load-slope.sh); this file never loads it.
\set ON_ERROR_STOP on
begin;

do $$
begin
  if coalesce(shobj_description((select oid from pg_database where datname = current_database()), 'pg_database'), '') not like 'ACCEPTANCE%' then
    raise exception 'refused: the database is not labelled ACCEPTANCE';
  end if;
  if (select max(version::int) from flyway_schema_history where success and version is not null) < 19 then
    raise exception 'refused: migration V19 is not applied';
  end if;
  if exists (select 1 from stationing_policy_version) then
    raise notice 'a Stationing policy exists; this provisioning neither reads nor changes it';
  end if;
end $$;

create temp table provisioned(item text primary key, n integer) on commit drop;

-- 1. hierarchy levels of the fictional HR units in the published snapshot (Oracle sends them in production): the
--    organisation L6, its departments L7, then L8–L10 down the projects branch; the two LOCAL sections have no HR level
with v(ext, level) as (values ('T-ORG', 6), ('T-GA', 7), ('T-IT', 7), ('T-PM', 7), ('T-SS', 7), ('T-PM-1', 8),
                               ('T-PM-1-1', 9), ('T-PM-1-1-1', 10)),
     upd as (update hr_unit h set level = v.level from v
              where h.external_id = v.ext and h.snapshot_id = (select id from hr_snapshot where status = 'PUBLISHED')
                and h.level is distinct from v.level
             returning 1)
insert into provisioned select 'hr_levels_set', count(*) from upd;

-- 2. roles holding exactly the three Stationing V3 actions and the seat approval (no VIEW, nothing else)
with ins as (
  insert into role_def(code, name, permissions, scope, summary_only, sort_order) values
    ('ACC_V3_RESTATIONING_REQUESTER', 'مقدم طلب إعادة تمركز (بيانات قبول وهمية)', '{CREATE_RESTATIONING}', 'ORGANIZATION', false, 960),
    ('ACC_V3_UNIT_APPROVER', 'معتمد إعادة التمركز في الوحدة (بيانات قبول وهمية)', '{APPROVE}', 'ORGANIZATION', false, 961),
    ('ACC_V3_DISTANCE_EXCEPTION', 'معتمد استثناء مسافة الانتشار (بيانات قبول وهمية)', '{APPROVE_DEPLOYMENT_DISTANCE_EXCEPTION}', 'ALL', false, 962),
    ('ACC_V3_STATIONING_ACTIVATOR', 'مفعّل التمركز (بيانات قبول وهمية)', '{ACTIVATE_STATIONING}', 'ORGANIZATION', false, 963)
  on conflict (code) do nothing
  returning 1)
insert into provisioned select 'roles_created', count(*) from ins;

-- 3. explicitly selected fictional users and their seats (the seat is the unit itself)
with v(username, org, role) as (values
       ('t.requester', 'HR-T-SS', 'ACC_V3_RESTATIONING_REQUESTER'),
       ('t.requester2', 'HR-T-IT', 'ACC_V3_RESTATIONING_REQUESTER'),
       ('t.manager', 'HR-T-SS', 'ACC_V3_UNIT_APPROVER'),
       ('t.manager.it', 'HR-T-IT', 'ACC_V3_UNIT_APPROVER'),
       ('t.manager.ga', 'HR-T-PM', 'ACC_V3_UNIT_APPROVER'),
       ('t.approver', 'HR-T-ORG', 'ACC_V3_UNIT_APPROVER'),
       ('t.approver2', 'HR-T-ORG', 'ACC_V3_DISTANCE_EXCEPTION'),
       ('t.facilities', 'HR-T-ORG', 'ACC_V3_STATIONING_ACTIVATOR')),
     ins as (
       insert into membership(id, person_id, organization_id, role_code, position_title, valid_from, follows_affiliation)
       select gen_random_uuid(), p.id, o.id, v.role, 'بيانات قبول وهمية — إعادة التمركز (Stationing V3)', now(), false
         from v join person p on p.username = v.username join organization o on o.code = v.org
        where not exists (select 1 from membership m where m.person_id = p.id and m.organization_id = o.id and m.role_code = v.role
                            and m.valid_to is null)
       returning 1)
insert into provisioned select 'seats_granted', count(*) from ins;

-- 4. a boundary only for a site the starting stationing uses and that has none at all (about 240 m around its
--    marker), and only where it touches no current boundary; existing point or polygon records are never replaced
with need as (
       select s.id, s.lat, s.lng from site s
        where s.code in ('00', '01', '02', '03', '05', '06', '08', '10') and s.geometry_version is null and s.lat is not null
          and not exists (select 1 from site_geometry_version g where g.site_id = s.id)),
     geo as (select n.id, ST_SetSRID(ST_MakeEnvelope(n.lng - 0.0012, n.lat - 0.0011, n.lng + 0.0012, n.lat + 0.0011), 4326) as g
               from need n),
     free as (select geo.* from geo
               where not exists (select 1 from site s2 join site_geometry_version g2 on g2.site_id = s2.id and g2.version = s2.geometry_version
                                  where s2.id <> geo.id and ST_Intersects(g2.geom, geo.g))),
     ins as (
       insert into site_geometry_version(id, site_id, version, geojson, crs, source, valid_from, geom, geometry_type, original_format,
                                         reason, created_by)
       select gen_random_uuid(), f.id, 1, ST_AsGeoJSON(f.g)::jsonb, 'EPSG:4326', 'حدود قبول وهمية (Stationing V3)', now(), f.g, 'Polygon',
              'ACCEPTANCE', 'بيانات قبول وهمية لاختبار إعادة التمركز', (select id from person where username = 't.admin')
         from free f
       returning site_id),
     upd as (update site set geometry_version = 1, version = version + 1 where id in (select site_id from ins) returning 1)
insert into provisioned select 'boundaries_added', count(*) from upd;

-- 5. where each fictional unit is stationed at the start (a recorded fact, origin CORRECTION; no outbound event is
--    written for acceptance provisioning)
with v(org, site) as (values ('HR-T-ORG', '00'), ('HR-T-GA', '01'), ('HR-T-SS', '02'), ('T-SS-1', '05'), ('T-SS-2', '08'),
                             ('HR-T-PM', '03'), ('HR-T-PM-1', '03'), ('HR-T-PM-1-1', '10'), ('HR-T-PM-1-1-1', '10'), ('HR-T-IT', '06')),
     ins as (
       insert into org_stationing(id, organization_id, site_id, kind, valid_from, origin, reason, reference, recorded_by)
       select gen_random_uuid(), o.id, s.id, 'PERMANENT', now(), 'CORRECTION', 'تمركز أولي — بيانات قبول وهمية (Stationing V3)',
              'ACCEPTANCE-V3', (select id from person where username = 't.admin')
         from v join organization o on o.code = v.org join site s on s.code = v.site
        where not exists (select 1 from org_stationing x where x.organization_id = o.id and x.valid_to is null)
       returning 1)
insert into provisioned select 'stationing_recorded', count(*) from ins;

insert into audit_event(actor_person_id, actor_name, action, entity_type, entity_id, entity_label, detail, reason)
select null, 'النظام', 'ACCEPTANCE_DATA_PROVISIONED', 'ACCEPTANCE_DATA', 'stationing-v3', 'بيانات قبول وهمية — Stationing V3',
       (select jsonb_object_agg(item, n) from provisioned), 'قرار المالك D4 (4 نوفمبر 2026)؛ لا سياسة منشورة'
 where :'apply' = 'on' and (select sum(n) from provisioned) > 0;

select item || '=' || n from provisioned order by item;
select 'policy_versions=' || count(*) from stationing_policy_version;

\if :apply
commit;
\else
rollback;
\endif
