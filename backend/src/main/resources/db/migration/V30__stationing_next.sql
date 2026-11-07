-- Complete access, site bootstrap and request phase (ADR-045). PREPARED FOR OWNER REVIEW: applied only to disposable
-- development and test databases until the owner approves it for retained data.
--   * one request engine carries four purposes: re-stationing, initial stationing, deployment areas and site registration;
--   * configured stages after the hierarchy: unit operations and final approval, each decided through its own permission;
--   * post-final FYI distribution: units chosen by a holder, read access to that one request only;
--   * deployment areas belong to a unit's stationing record, never to the site, so units sharing a site differ;
--   * a permission request carries a scope, a recommendation to reject, and can be returned for changes;
--   * a site may carry descriptive notes.

-- 1. purposes of a request ----------------------------------------------------------------------------------------
alter table restationing_request add column purpose text not null default 'RESTATIONING'
  check (purpose in ('RESTATIONING', 'INITIAL_STATIONING', 'DEPLOYMENT_AREAS', 'SITE_REGISTRATION'));
create index restationing_request_purpose_idx on restationing_request(purpose, state);

-- 2. configured stages decided through a permission, like the distance exception -----------------------------------
alter table restationing_stage drop constraint restationing_stage_kind_check;
alter table restationing_stage add constraint restationing_stage_kind_check
  check (kind in ('HIERARCHY', 'CROSS_BRANCH', 'EXCEPTION', 'UNIT_OPERATIONS', 'FINAL'));
alter table restationing_stage drop constraint restationing_stage_check;
alter table restationing_stage add constraint restationing_stage_unit_check
  check ((kind in ('EXCEPTION', 'UNIT_OPERATIONS', 'FINAL')) = (unit_id is null));

-- 3. FYI distribution: not a vote, and it gives no lasting right ----------------------------------------------------
alter table restationing_request add column fyi_done_at timestamptz;
alter table restationing_request add column fyi_done_by uuid references person(id);
alter table restationing_request add column fyi_note text;
alter table restationing_request add constraint restationing_request_fyi_check
  check ((fyi_done_at is null) = (fyi_done_by is null));
create table restationing_fyi (
  request_id       uuid not null references restationing_request(id),
  organization_id  uuid not null references organization(id),
  selected_by      uuid not null references person(id),
  selected_at      timestamptz not null,
  -- read access to this one request ends when a holder ends it; a new selection opens it again
  ended_at         timestamptz,
  ended_by         uuid references person(id),
  end_reason       text,
  primary key (request_id, organization_id),
  check ((ended_at is null) = (ended_by is null) and (ended_at is null) = (end_reason is null))
);
create index restationing_fyi_org_idx on restationing_fyi(organization_id);

-- 4. deployment areas belong to a unit's stationing record ----------------------------------------------------------
alter table deployment_area add column organization_id uuid references organization(id);
alter table deployment_area add column stationing_id uuid references org_stationing(id);
alter table deployment_area drop constraint deployment_area_request_id_role_key;

-- each existing area, once for every unit its request stationed, on that unit's latest record of the request's chain
create temporary table deployment_area_units on commit drop as
select distinct on (a.id, s.organization_id)
       a.id as area_id, s.organization_id,
       (select x.id from org_stationing x
         where x.organization_id = s.organization_id and x.site_id = a.site_id
           and (x.request_id = a.request_id
                or x.request_id in (select e.id from restationing_request e where e.parent_request_id = a.request_id))
         order by x.valid_from desc limit 1) as stationing_id,
       row_number() over (partition by a.id order by s.organization_id) as n
  from deployment_area a
  join org_stationing s on s.request_id = a.request_id and s.site_id = a.site_id
 order by a.id, s.organization_id;

update deployment_area a set organization_id = u.organization_id, stationing_id = u.stationing_id
  from deployment_area_units u where u.area_id = a.id and u.n = 1;

insert into deployment_area(id, request_id, site_id, role, geom, state, valid_from, valid_to, created_at, organization_id, stationing_id)
select gen_random_uuid(), a.request_id, a.site_id, a.role, a.geom, a.state, a.valid_from, a.valid_to, a.created_at, u.organization_id, u.stationing_id
  from deployment_area_units u join deployment_area a on a.id = u.area_id where u.n > 1;

-- an area of a stationing that has ended was left active by earlier versions: it retires with that stationing, kept in history
update deployment_area a set state = 'RETIRED', valid_to = greatest(s.valid_to, a.valid_from)
  from org_stationing s
 where s.id = a.stationing_id and a.state = 'ACTIVE' and s.valid_to is not null and s.valid_to <= now();

alter table deployment_area add constraint deployment_area_request_role_unit_key unique (request_id, role, organization_id);
create unique index deployment_area_active_idx on deployment_area(stationing_id, role) where state = 'ACTIVE' and stationing_id is not null;
create index deployment_area_org_idx on deployment_area(organization_id) where state = 'ACTIVE';

-- 5. a permission request: scope, recommendation, return ------------------------------------------------------------
alter table access_request add column requested_scope jsonb;
alter table access_request add column granted_scope jsonb;
alter table access_request add column recommend_reject boolean not null default false;
alter table access_request add column review_note text;

-- 6. a site's descriptive notes -------------------------------------------------------------------------------------
alter table site add column notes text;
