-- V40: the main unit is told by the data, not by a flag (owner, 16 Nov 2026). In the HR source a unit's MAIN_UNIT_ID points to
-- its main unit, and to its own ID on the main unit itself; that self-reference is the only reliable sign. The flag column the
-- source also carries is set to one default value on nearly every row and is no longer read (HrMapping refuses it), and the
-- unit's name never decides. hr_unit keeps the reference as read; is_main is now derived on import: main_external_id = external_id.
-- Rows staged before V40 keep is_main as it was until the next synchronisation replaces the snapshot.
alter table hr_unit add column main_external_id text;
comment on column hr_unit.main_external_id is 'MAIN_UNIT_ID as read from HR: the unit''s main unit; equal to external_id on a main unit';
comment on column hr_unit.is_main is 'derived on import: main_external_id = external_id (owner, 16 Nov 2026); never a source flag';
