-- V42 (owner's full end-to-end acceptance specification, 16 Nov 2026; ADR-067): «موقع جديد» in «تهيئة المواقع والتمركز»
-- registers, in ONE audited save, the site, its initial stationing and each stationed unit's primary and alternative
-- deployment areas. Until now a stationing was written only by an activated request (REQUEST) or by a data correction
-- (CORRECTION), and a deployment area only by an activated request (request_id NOT NULL). The setup administrator's
-- direct save is a third, explicit origin: SETUP. Nothing existing changes meaning: every earlier row is REQUEST or
-- CORRECTION as before, and every reader (posture, register, hub, checks, outbox) reads a SETUP row exactly as an
-- activated one (none of them filters on the origin).

-- 1. org_stationing: SETUP joins CORRECTION as an origin needing no request; REQUEST still needs one, and a SETUP row never
--    names one. V18 created both checks unnamed, so they are found by what they say (the only two that mention the origin).
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'org_stationing'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) like '%origin%' loop
    execute format('alter table org_stationing drop constraint %I', c.conname);
  end loop;
end $$;
alter table org_stationing add constraint org_stationing_origin_check
  check (origin in ('CORRECTION', 'REQUEST', 'SETUP'));
alter table org_stationing add constraint org_stationing_origin_request_check
  check ((origin in ('CORRECTION', 'SETUP') or request_id is not null) and (origin <> 'SETUP' or request_id is null));
comment on column org_stationing.origin is
  'REQUEST: an activated request (request_id set); CORRECTION: an audited data correction (CORRECT_STATIONING); SETUP: «تهيئة المواقع والتمركز», the site, its initial stationing and areas saved together (ADR-067, V42)';

-- 2. deployment_area: an area of a SETUP stationing has no request. origin says which; request_id is required exactly for REQUEST.
alter table deployment_area add column origin text not null default 'REQUEST';
alter table deployment_area add constraint deployment_area_origin_check check (origin in ('REQUEST', 'SETUP'));
alter table deployment_area alter column request_id drop not null;
alter table deployment_area add constraint deployment_area_origin_request_check
  check ((origin = 'REQUEST') = (request_id is not null));
-- a SETUP area always belongs to the unit's stationing record it was written with (one active area per role per record
-- stays enforced by deployment_area_active_idx; request rows keep deployment_area_request_role_unit_key)
alter table deployment_area add constraint deployment_area_setup_owner_check
  check (origin = 'REQUEST' or (organization_id is not null and stationing_id is not null));
comment on column deployment_area.origin is
  'REQUEST: written by an activated request (request_id set); SETUP: written with the unit''s SETUP stationing by «تهيئة المواقع والتمركز» (ADR-067, V42)';
