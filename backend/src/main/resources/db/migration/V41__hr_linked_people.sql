-- V41: HR people come in one by one, as MOVER (owner decision, 16 Nov 2026; ADR-065). Connecting to Oracle no longer copies every
-- HR employee into TMRKZ. The hourly sync still reads the whole unit tree, but of the people only those already in the application
-- ("linked people"); a person enters TMRKZ only when an access manager imports that one person («إضافة مستخدم») or at the person's
-- own first sign-in, with no permission either way.

-- 1. Linked people: HR people who are users of TMRKZ. The ONE definition, read by the sync (HrSyncService) and by the clean-up of an
--    existing installation (ops/hr-prune-unlinked.sql). Someone who ever signed in stays linked (identity links are never removed),
--    so a departure of anyone who used the application is always seen.
create view hr_linked_person as
select p.id, p.source_external_id as external_id
from person p
where p.source = 'HR' and p.source_external_id is not null
  and (exists (select 1 from identity_link il where il.person_id = p.id)
       or exists (select 1 from unit_member um where um.person_id = p.id and um.ended_at is null)
       or exists (select 1 from membership m where m.person_id = p.id and (m.valid_to is null or m.valid_to > now()))
       or exists (select 1 from delegation d where (d.delegator_id = p.id or d.delegate_id = p.id)
                    and d.revoked_at is null and d.valid_to > now())
       or exists (select 1 from duty_permit dp where dp.person_id = p.id and dp.ended_at is null and dp.valid_to > now())
       or exists (select 1 from support_seat ss where ss.person_id = p.id and ss.ended_at is null)
       or exists (select 1 from access_request ar where ar.person_id = p.id and ar.open)
       or exists (select 1 from affiliation a
                  join position_seat ps on ps.organization_id = a.organization_id and ps.position_id = a.position_id and ps.active
                  where a.person_id = p.id and a.valid_to is null));
comment on view hr_linked_person is 'HR people who are users of TMRKZ: the only people the HR sync reads (ADR-065)';

-- 2. The people a run (or a one-person import) asked HR for. Only these can be updated, moved or marked departed by the snapshot:
--    someone HR did not return is departed only if they were asked for, never because the sync no longer reads them.
create table hr_snapshot_scope (
  snapshot_id  uuid not null references hr_snapshot(id) on delete cascade,
  external_id  text not null,
  primary key (snapshot_id, external_id)
);

-- 3. A first sign-in refused because HR could not be asked (unreachable, or a sync holding the mirror at that moment).
alter table identity_link_issue drop constraint identity_link_issue_reason_check;
alter table identity_link_issue add constraint identity_link_issue_reason_check
  check (reason in ('NO_KEY', 'NO_MATCH', 'AMBIGUOUS', 'INACTIVE', 'STALE_SOURCE', 'ALREADY_LINKED', 'SOURCE_UNAVAILABLE'));
