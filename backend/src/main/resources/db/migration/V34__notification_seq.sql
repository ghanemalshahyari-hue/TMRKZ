-- V34: desktop notifications as in TNQL (owner, 11 Nov 2026; ADR-050). The browser keeps a cursor of what it already showed
-- (TNQL's since_id); notification ids are uuids, so each notification also gets an increasing number. The uuid stays the key.
alter table notification add column seq bigint generated always as identity;
create unique index notification_seq on notification(seq);
create index notification_person_seq on notification(person_id, seq);
