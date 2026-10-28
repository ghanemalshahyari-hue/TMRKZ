-- Synthetic volume for exploratory measurement (decision D-03 open): 7,000 organisations, 200,000 people with
-- dated memberships, and 60 load-test accounts. Fictional data only; run against a dedicated perf environment.
-- Usage: psql -v load_password='...' -f ops/load/synthetic.sql
create extension if not exists pgcrypto;

-- 1 root, 20 sectors, 280 departments, 6,699 sections
insert into organization(id, code, name, parent_id, valid_from)
select md5('syn-org-' || g)::uuid, 'SYN-' || g, 'جهة اصطناعية ' || g,
       case when g = 1 then null
            when g <= 21 then md5('syn-org-1')::uuid
            when g <= 301 then md5('syn-org-' || (2 + (g - 22) % 20))::uuid
            else md5('syn-org-' || (22 + (g - 302) % 280))::uuid end,
       '2026-01-01T00:00:00Z'
from generate_series(1, 7000) g
on conflict do nothing;

insert into person(id, employee_no, display_name)
select md5('syn-p-' || g)::uuid, 'SYN-P-' || g, 'شخص اصطناعي ' || g
from generate_series(1, 200000) g
on conflict do nothing;

insert into membership(id, person_id, organization_id, role_code, valid_from)
select md5('syn-m-' || g)::uuid, md5('syn-p-' || g)::uuid, md5('syn-org-' || (1 + g % 7000))::uuid,
       case when g % 50 = 0 then 'ORG_MANAGER' else 'REQUESTER' end, '2026-01-01T00:00:00Z'
from generate_series(1, 200000) g
on conflict do nothing;

-- Load-test accounts in the demo "shared services" organisation (so they see demo facilities).
insert into person(id, employee_no, display_name, username, password_hash)
select md5('load-' || g)::uuid, 'LOAD-' || g, 'حساب قياس ' || g, 'load' || g, crypt(:'load_password', gen_salt('bf', 10))
from generate_series(1, 60) g
on conflict do nothing;

insert into membership(id, person_id, organization_id, role_code, valid_from)
select md5('load-m-' || g)::uuid, md5('load-' || g)::uuid, (select id from organization where code = 'SS'),
       case when g <= 50 then 'REQUESTER' else 'FACILITIES_REVIEWER' end, '2026-01-01T00:00:00Z'
from generate_series(1, 60) g
on conflict do nothing;

analyze;
