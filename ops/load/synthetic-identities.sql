-- Synthetic load-test identities — DISPOSABLE LOAD ENVIRONMENT ONLY (compose project tmrkz-load, ops/load/up-load-env.sh),
-- on top of the fictional acceptance data. Never load into a production or acceptance database.
-- They sign in exactly like everyone else: the fictional directory verifies the password (ops/load/up-load-env.sh adds
-- the same accounts there) and TMRKZ links each account to its HR record by the domain account. No sign-in endpoint,
-- password column or bypass is involved.
-- :count requesters load.0001… in «الخدمات المشتركة», and one person per later stage of the default reservation workflow
-- (facilities review, organisation approval, final approval), so no requester ever decides their own request (ADR-027).
-- Usage: psql -v count=50 -f ops/load/synthetic-identities.sql   (re-running changes nothing)
begin;
create temporary table load_people(uid text, emp text, name text, unit text, role text) on commit drop;
insert into load_people
select 'load.' || lpad(g::text, 4, '0'), 'LOAD-' || lpad(g::text, 4, '0'), 'حساب قياس ' || g, 'SS', 'REQUESTER'
from generate_series(1, :count) g;
insert into load_people values
  ('load.r.fac', 'LOAD-R-FAC', 'مراجع مرافق للقياس', 'SS', 'FACILITIES_REVIEWER'),
  ('load.r.mgr', 'LOAD-R-MGR', 'مدير جهة للقياس', 'SS', 'ORG_MANAGER'),
  ('load.r.apr', 'LOAD-R-APR', 'صاحب اعتماد للقياس', 'GA', 'APPROVER');

insert into hr_person(snapshot_id, external_id, employee_number, domain_account, full_name, unit_external_id, status_text, active)
select md5('t:snapshot')::uuid, 'P-' || uid, emp, uid, name, 'T-' || unit, 'في الخدمة', true from load_people
on conflict do nothing;
insert into person(id, employee_no, display_name, username, status, source, source_external_id)
select md5('load:person:' || uid)::uuid, emp, name, uid, 'ACTIVE', 'HR', 'P-' || uid from load_people
on conflict do nothing;
insert into affiliation(id, person_id, organization_id, valid_from)
select md5('load:aff:' || uid)::uuid, md5('load:person:' || uid)::uuid, md5('t:org:T-' || unit)::uuid, '2026-01-01T00:00:00Z'
from load_people
on conflict do nothing;
insert into membership(id, person_id, organization_id, role_code, valid_from)
select md5('load:m:' || uid)::uuid, md5('load:person:' || uid)::uuid, md5('t:org:T-' || unit)::uuid, role, '2026-01-01T00:00:00Z'
from load_people
on conflict do nothing;
commit;
