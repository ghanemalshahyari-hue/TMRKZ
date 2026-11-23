-- HR people TMRKZ no longer keeps (ADR-065, owner decision of 16 Nov 2026: HR people come in one by one, as MOVER).
--
-- Before ADR-065 every HR employee was copied into TMRKZ as a person with an affiliation. From V41 the sync reads only the
-- linked people (view hr_linked_person, the one definition) and never touches anyone else. This script removes, on an EXISTING
-- installation, the HR-projected people who are NOT linked AND whom NOTHING refers to: every foreign key to person is checked
-- (found in the catalogue, so a table added later is covered), plus the references without a key (the audit trail, local
-- notes, task realignment history, authorisation tuples). A referenced person is never removed. With them go their
-- affiliations, and the mirror rows (hr_person) of HR people TMRKZ does not hold. Units are untouched.
--
-- DRY RUN is the default: it only prints counts and changes nothing. Only with the setting tmrkz.prune_apply = on does it
-- delete, in one transaction, after waiting for a running HR sync or one-person import to end, and it records one audit event
-- (HR_UNLINKED_PRUNED). Re-runnable: a second run finds nothing left to remove.
--
--   ops/hr-prune-unlinked.sh                    dry run on the compose project tmrkz
--   ops/hr-prune-unlinked.sh --apply            for real, AFTER a verified backup (ops/backup.sh, ops/verify-backup.sh)
--
-- Output, one line per step: hr_people_unlinked, hr_people_kept_referenced, hr_people_to_remove, affiliations_to_remove,
-- mirror_rows_to_remove, applied (1 when deleted, 0 on a dry run).

create or replace function pg_temp.tmrkz_hr_prune(apply boolean) returns table(step text, n bigint) language plpgsql as $fn$
declare
  r record;
  unlinked bigint;
  removable bigint;
  affiliations bigint;
  mirror bigint;
begin
  -- never at the same time as the HR sync or a one-person import (HrSyncService.LOCK_KEY)
  perform pg_advisory_xact_lock(23728913890560082);
  create temp table if not exists tmrkz_prune_candidate(id uuid primary key, external_id text) on commit drop;
  truncate tmrkz_prune_candidate;
  insert into tmrkz_prune_candidate(id, external_id)
    select p.id, p.source_external_id from person p
    where p.source = 'HR' and not exists (select 1 from hr_linked_person l where l.id = p.id);
  select count(*) into unlinked from tmrkz_prune_candidate;

  -- every foreign key to person, except the affiliation that is removed with the person
  for r in select c.conrelid::regclass as tbl, a.attname as col
           from pg_constraint c
           join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
           where c.contype = 'f' and c.confrelid = 'person'::regclass
             and not (c.conrelid = 'affiliation'::regclass and a.attname = 'person_id')
  loop
    execute format('delete from tmrkz_prune_candidate pc where exists (select 1 from %s t where t.%I = pc.id)', r.tbl, r.col);
  end loop;
  -- references without a foreign key
  delete from tmrkz_prune_candidate pc
    where exists (select 1 from audit_event e where e.entity_type = 'PERSON' and e.entity_id = pc.id::text);
  delete from tmrkz_prune_candidate pc where exists (select 1 from audit_event e where e.actor_person_id = pc.id);
  delete from tmrkz_prune_candidate pc
    where exists (select 1 from local_metadata m where m.entity_type = 'PERSON' and m.entity_id = pc.id);
  delete from tmrkz_prune_candidate pc
    where exists (select 1 from task_reassignment t where pc.id = any(t.departed) or pc.id = any(t.holders));
  delete from tmrkz_prune_candidate pc where exists (select 1 from authz_tuple t where t.person_id = pc.id);
  delete from tmrkz_prune_candidate pc where exists (select 1 from authz_change t where t.person_id = pc.id);

  select count(*) into removable from tmrkz_prune_candidate;
  select count(*) into affiliations from affiliation a join tmrkz_prune_candidate pc on pc.id = a.person_id;
  select count(*) into mirror from hr_person h
    where not exists (select 1 from person p where p.source = 'HR' and p.source_external_id = h.external_id
                        and not exists (select 1 from tmrkz_prune_candidate pc where pc.id = p.id));

  step := 'hr_people_unlinked'; n := unlinked; return next;
  step := 'hr_people_kept_referenced'; n := unlinked - removable; return next;
  step := 'hr_people_to_remove'; n := removable; return next;
  step := 'affiliations_to_remove'; n := affiliations; return next;
  step := 'mirror_rows_to_remove'; n := mirror; return next;

  if apply then
    delete from affiliation a using tmrkz_prune_candidate pc where a.person_id = pc.id;
    delete from person p using tmrkz_prune_candidate pc where p.id = pc.id;
    delete from hr_person h
      where not exists (select 1 from person p where p.source = 'HR' and p.source_external_id = h.external_id);
    update hr_snapshot s set person_count = (select count(*) from hr_person h where h.snapshot_id = s.id),
                             active_person_count = (select count(*) from hr_person h where h.snapshot_id = s.id and h.active)
      where s.status in ('PUBLISHED', 'SUPERSEDED');
    insert into audit_event(actor_name, action, entity_type, entity_label, detail)
      values ('host operator', 'HR_UNLINKED_PRUNED', 'HR_SNAPSHOT', 'ops/hr-prune-unlinked.sql',
              jsonb_build_object('people', removable, 'keptReferenced', unlinked - removable, 'affiliations', affiliations,
                                 'mirrorRows', mirror));
  end if;
  step := 'applied'; n := case when apply then 1 else 0 end; return next;
end $fn$;

select step, n from pg_temp.tmrkz_hr_prune(coalesce(current_setting('tmrkz.prune_apply', true), '') = 'on');
