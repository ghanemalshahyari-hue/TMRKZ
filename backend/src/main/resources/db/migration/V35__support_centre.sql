-- V35: «مركز الدعم», as in TNQL's support centre (owner, 11 Nov 2026; ADR-053). One support case per problem a person reports,
-- its conversation with the support staff, and the support seats (موظف دعم / مشرف دعم) who work the queue. A case carries the
-- screen it was raised from and the browser's own facts, never a request's contents. Every change is an event and an audit row.

create sequence support_case_no;

create table support_seat (
  id            uuid primary key,
  person_id     uuid not null references person(id),
  role          text not null check (role in ('AGENT', 'SUPERVISOR')),
  granted_by    uuid not null references person(id),
  granted_at    timestamptz not null,
  ended_at      timestamptz,
  ended_by      uuid references person(id),
  ended_reason  text,
  check ((ended_at is null) = (ended_by is null))
);
create unique index support_seat_current on support_seat(person_id) where ended_at is null;

create table support_case (
  id                  uuid primary key,
  number              text not null unique,
  requester_id        uuid not null references person(id),
  category            text not null check (category in ('SIGN_IN', 'PERMISSIONS', 'REQUESTS', 'MAP', 'STATIONING', 'DATA',
                                                         'NOTIFICATIONS', 'PERFORMANCE', 'OTHER')),
  priority            text not null check (priority in ('LOW', 'NORMAL', 'HIGH', 'CRITICAL')),
  status              text not null check (status in ('OPEN', 'IN_PROGRESS', 'WAITING_USER', 'RESOLVED', 'CLOSED')),
  title               text not null check (length(title) between 3 and 200),
  screen              text check (screen ~ '^[A-Za-z]{1,40}$'),
  client_info         jsonb,
  assignee_id         uuid references person(id),
  created_at          timestamptz not null,
  updated_at          timestamptz not null,
  response_due        timestamptz not null,
  first_response_at   timestamptz,
  resolved_at         timestamptz,
  closed_at           timestamptz
);
create index support_case_requester on support_case(requester_id, created_at desc);
create index support_case_queue on support_case(status, priority, created_at);

create table support_message (
  id           uuid primary key,
  case_id      uuid not null references support_case(id),
  author_id    uuid not null references person(id),
  from_support boolean not null,
  internal     boolean not null default false,
  body         text not null check (length(body) between 1 and 4000),
  created_at   timestamptz not null,
  check (not internal or from_support)
);
create index support_message_case on support_message(case_id, created_at);

create table support_event (
  id          bigint generated always as identity primary key,
  case_id     uuid not null references support_case(id),
  actor_id    uuid references person(id),
  kind        text not null,
  detail      jsonb,
  created_at  timestamptz not null
);
create index support_event_case on support_event(case_id, id);

-- a notification may point at a page of its own (a support case here): the bell and the desktop toast open it
alter table notification add column link text check (link ~ '^#[A-Za-z]{1,40}(/[0-9a-f-]{36})?$');
