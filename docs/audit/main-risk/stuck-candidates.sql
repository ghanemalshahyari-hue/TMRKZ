-- Read-only: requests that ADR-028 could leave stuck once deployed (owner brief of 3 Nov 2026). Works on the V16 schema
-- (before V17), so it can be run on a database before any upgrade. Run it read-only, for example:
--   docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' <db container> psql -U mover -d mover < stuck-candidates.sql
-- Approximation: the requester is request.created_by (the application also treats other accounts of the same human as
-- the requester) and holders are counted through memberships only (not delegations or seats). A row is a candidate to
-- review, not proof that nobody can act; the application-level scan in the recovery proposal makes the exact decision.
with req as (
  select r.id, r.number, r.created_by from request r where r.status = 'APPROVED'
), live as (
  select m.person_id, m.role_code, m.organization_id from membership m
  where m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
)
select 'S-2 handover assigned to its requester' as category, q.number, e.name as step, e.role_code
from execution_task e join req q on q.id = e.request_id
where e.status = 'OPEN' and e.key = 'handover' and e.assigned_person_id = q.created_by
union all
select 'S-1 open handover its requester holds the role for', q.number, e.name, e.role_code
from execution_task e join req q on q.id = e.request_id
where e.status = 'OPEN' and e.key = 'handover' and e.assigned_person_id is null
  and exists (select 1 from live l where l.person_id = q.created_by and l.role_code = e.role_code)
union all
select 'S-3 approved file, no open step, requester holds CLOSE', q.number, null, null
from req q
where not exists (select 1 from execution_task e where e.request_id = q.id and e.status = 'OPEN')
  and exists (select 1 from live l join role_def d on d.code = l.role_code where l.person_id = q.created_by and 'CLOSE' = any(d.permissions))
union all
select 'S-4 receipt waiting for an open handover', q.number, e.name, e.role_code
from execution_task e join req q on q.id = e.request_id
where e.status = 'OPEN' and e.key = 'receipt'
  and exists (select 1 from execution_task h where h.request_id = q.id and h.key = 'handover' and h.status = 'OPEN')
union all
select 'S-6 custom step keyed handover/receipt/relocated outside the built-in templates', q.number, e.name, e.role_code
from execution_task e join req q on q.id = e.request_id
join request r on r.id = q.id join request_type t on t.code = r.type_code
where e.status = 'OPEN' and e.key in ('handover', 'receipt', 'relocated')
  and not (t.kind = 'NEW_RESERVATION' and e.key in ('handover', 'receipt'))
  and not (t.kind = 'EVACUATION' and e.key = 'handover')
  and not (t.kind = 'RELOCATION' and e.key = 'relocated')
order by 1, 2;
