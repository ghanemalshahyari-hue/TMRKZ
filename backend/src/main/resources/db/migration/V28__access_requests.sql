-- V28: asking for permissions, as in the movement programme (owner, 6 Nov 2026; ADR-044). Signing in is not a permission: a person
-- with none sees only the page to ask. A request type of kind ACCESS runs through the same chart, tasks and audit as any request.
-- Three sets are kept apart: what the person asked, what the reviewer advised, and what was finally granted.
alter table request_type drop constraint request_type_kind_check;
alter table request_type add constraint request_type_kind_check
  check (kind in ('NEW_RESERVATION', 'EXTENSION', 'MODIFICATION', 'CANCELLATION', 'EVACUATION', 'RELOCATION', 'ACCESS'));

create table access_request (
  request_id     uuid primary key references request(id),
  person_id      uuid not null references person(id),
  unit_org_id    uuid not null references organization(id),
  requested      text[] not null check (cardinality(requested) > 0),
  recommended    text[],
  granted        text[],
  reason         text not null,
  reviewed_name  text,
  reviewed_at    timestamptz,
  open           boolean not null default true
);
create unique index access_request_one_open on access_request(person_id) where open;
