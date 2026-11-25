-- V69: one source for the units informed after a final approval (owner brief 25 Nov 2026, item 5).
--
-- Before V69 there were two lists:
--   fyi_main_command (V26, ADR-042)  «الجهات الرئيسية للعلم» — written by the screen of that name (PUT/DELETE
--                                     /access/fyi-mains, global access managers only, audited), read by PlaceInfo at the
--                                     final approval of every request other than an access request;
--   fyi_designation  (V64, ADR-095 B2) read by the re-stationing final approval (RestationingService.autoFyi) and written
--                                     by nothing in the application.
-- An administrator's choice therefore never reached a re-stationing request. From V69 the authoritative list is
-- fyi_main_command, the one the application writes, audits and carries in the migration centre; it gains V64's
-- include_descendants choice. Every row of fyi_designation is copied into it (union: a unit in either list stays, and
-- «وما دونها» from either list stays). fyi_designation is kept, unchanged, for history; no code reads or writes it.
-- The statements are idempotent: run again, they change nothing and record nothing.

alter table fyi_main_command add column if not exists include_descendants boolean not null default false;

-- a row copied from fyi_designation may have no recorded author (set_by is optional there); the application always sets it
alter table fyi_main_command alter column added_by drop not null;

with src as (
  select d.unit_id,
         bool_or(d.include_descendants) as include_descendants,
         (array_agg(d.set_by order by d.set_at, d.id))[1] as set_by,
         min(d.set_at) as set_at
    from fyi_designation d
   group by d.unit_id),
moved as (
  insert into fyi_main_command(organization_id, include_descendants, added_by, added_at)
  select s.unit_id, s.include_descendants, s.set_by, s.set_at from src s
  on conflict (organization_id) do update set include_descendants = true
   where excluded.include_descendants and not fyi_main_command.include_descendants
  returning organization_id, include_descendants, (xmax = 0) as inserted)
insert into audit_event(action, entity_type, entity_id, entity_label, detail, reason)
select 'FYI_MAIN_COMMAND_MERGED', 'POLICY', 'V69', 'الجهات الرئيسية للعلم — مصدر واحد',
       jsonb_build_object(
         'migration', 'V69',
         'from', 'fyi_designation',
         'into', 'fyi_main_command',
         'rows', jsonb_agg(jsonb_build_object('organization', m.organization_id, 'includeDescendants', m.include_descendants,
                                              'change', case when m.inserted then 'ADDED' else 'INCLUDE_DESCENDANTS' end)
                           order by m.organization_id)),
       'One list for every final approval: the re-stationing FYI units are read from «الجهات الرئيسية للعلم».'
  from moved m
having count(*) > 0;

comment on column fyi_main_command.include_descendants is
  'V69: true = the unit and its active descendant units at the moment of the final approval («وما دونها»); false = the unit only.';
comment on column fyi_main_command.added_by is
  'Who added the unit. Null only for a row copied by V69 from fyi_designation without a recorded author.';
comment on table fyi_main_command is
  '«الجهات الرئيسية للعلم» (ADR-042; one source since V69): the units informed after every final approval — the parties of '
  'PlaceInfo for requests and the units RestationingService.autoFyi informs for re-stationing, deployment areas and site '
  'registration. Changed only through /access/fyi-mains by an access manager whose scope is everything; each change audited '
  'as FYI_MAIN_COMMAND_ADDED / _CHANGED / _REMOVED with who, when and reason.';
comment on table fyi_designation is
  'Superseded at V69 by fyi_main_command: its rows were copied there (audit FYI_MAIN_COMMAND_MERGED). Kept unchanged for '
  'history; no application code reads or writes it.';
