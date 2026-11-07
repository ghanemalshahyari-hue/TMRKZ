-- V26: «للعلم» by person, as in the movement programme (owner, 6 Nov 2026; ADR-042). Who is told is who may read: a holder of
-- the for-information role whose scope covers a party of a finally approved request gets a row here, once. The row is the read
-- right, the notice and the record of who read it. organization_id is the holder's unit, for the decision service.
create table request_fyi (
  request_id       uuid not null references request(id),
  person_id        uuid not null references person(id),
  organization_id  uuid not null references organization(id),
  reason           text not null check (reason in ('REQUESTER_UNIT', 'MAIN_UNIT', 'AT_PLACE', 'MAIN_OF_PLACE', 'CHOSEN', 'MAIN_COMMAND')),
  told_at          timestamptz not null,
  first_read_at    timestamptz,
  primary key (request_id, person_id)
);
create index request_fyi_person_idx on request_fyi(person_id);

-- «الجهات الرئيسية للعلم»: chosen explicitly, never inferred. Holders covering one read every finally approved request.
create table fyi_main_command (
  organization_id  uuid primary key references organization(id),
  added_by         uuid not null references person(id),
  added_at         timestamptz not null default now()
);
