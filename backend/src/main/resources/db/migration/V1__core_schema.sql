-- MOVER core schema. All timestamps are timestamptz (stored UTC). Periods are half-open [start, end).
-- Business invariants that must hold under concurrency are enforced here, not only in application code.

create extension if not exists btree_gist;

-- Shared guards -----------------------------------------------------------------------------------------

create function mover_forbid_change() returns trigger language plpgsql as $$
begin
  raise exception '% rows are append-only (attempted %)', tg_table_name, tg_op using errcode = '42501';
end $$;

create function mover_forbid_delete() returns trigger language plpgsql as $$
begin
  raise exception '% rows cannot be deleted; retire them instead', tg_table_name using errcode = '42501';
end $$;

-- Organization structure (independent of sites) ---------------------------------------------------------

create table organization (
  id          uuid primary key,
  code        text not null unique,
  name        text not null,
  parent_id   uuid references organization(id),
  status      text not null default 'ACTIVE' check (status in ('ACTIVE', 'RETIRED')),
  valid_from  timestamptz not null default now(),
  valid_to    timestamptz,
  created_at  timestamptz not null default now(),
  version     int not null default 0
);
create index organization_parent_idx on organization(parent_id);

create function organization_no_cycle() returns trigger language plpgsql as $$
begin
  if new.parent_id is null then return new; end if;
  if new.parent_id = new.id or exists (
      with recursive up(id, parent_id) as (
        select id, parent_id from organization where id = new.parent_id
        union all
        select o.id, o.parent_id from organization o join up on o.id = up.parent_id)
      select 1 from up where up.id = new.id) then
    raise exception 'organization tree cycle' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger organization_no_cycle before insert or update of parent_id on organization
  for each row execute function organization_no_cycle();
create trigger organization_no_delete before delete on organization for each row execute function mover_forbid_delete();

create table person (
  id             uuid primary key,
  employee_no    text not null unique,
  display_name   text not null,
  username       text unique,
  password_hash  text,
  status         text not null default 'ACTIVE' check (status in ('ACTIVE', 'DISABLED')),
  failed_logins  int not null default 0,
  locked_until   timestamptz,
  created_at     timestamptz not null default now()
);
create index person_name_idx on person(lower(display_name));

create table role_def (
  code          text primary key,
  name          text not null,
  permissions   text[] not null,
  scope         text not null check (scope in ('ALL', 'ORGANIZATION', 'SITE', 'ORGANIZATION_AND_SITE')),
  summary_only  boolean not null default false,
  system        boolean not null default false,
  sort_order    int not null default 0,
  updated_at    timestamptz not null default now()
);

-- Sites and reservable resources ------------------------------------------------------------------------

create table site (
  id          uuid primary key,
  code        text not null unique,
  name        text not null,
  kind        text not null,
  parent_id   uuid references site(id),
  status      text not null default 'ACTIVE' check (status in ('ACTIVE', 'RETIRED')),
  capacity    int,
  lat         double precision,
  lng         double precision,
  created_at  timestamptz not null default now(),
  version     int not null default 0
);
create index site_parent_idx on site(parent_id);

create function site_no_cycle() returns trigger language plpgsql as $$
begin
  if new.parent_id is null then return new; end if;
  if new.parent_id = new.id or exists (
      with recursive up(id, parent_id) as (
        select id, parent_id from site where id = new.parent_id
        union all
        select s.id, s.parent_id from site s join up on s.id = up.parent_id)
      select 1 from up where up.id = new.id) then
    raise exception 'site tree cycle' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger site_no_cycle before insert or update of parent_id on site for each row execute function site_no_cycle();
create trigger site_no_delete before delete on site for each row execute function mover_forbid_delete();

-- Which organisation administers a site, over time (never overwritten).
create table site_responsibility (
  id               uuid primary key,
  site_id          uuid not null references site(id),
  organization_id  uuid not null references organization(id),
  valid_from       timestamptz not null,
  valid_to         timestamptz,
  check (valid_to is null or valid_to > valid_from),
  constraint site_responsibility_no_overlap
    exclude using gist (site_id with =, tstzrange(valid_from, valid_to, '[)') with &&)
);
create index site_responsibility_current_idx on site_responsibility(site_id) where valid_to is null;

create table site_geometry_version (
  id          uuid primary key,
  site_id     uuid not null references site(id),
  version     int not null,
  geojson     jsonb not null,
  crs         text not null,
  source      text not null,
  valid_from  timestamptz not null,
  valid_to    timestamptz,
  created_at  timestamptz not null default now(),
  unique (site_id, version)
);
create trigger site_geometry_append_only before update or delete on site_geometry_version
  for each row execute function mover_forbid_change();

create table resource (
  id                  uuid primary key,
  site_id             uuid not null references site(id),
  code                text not null unique,
  name                text not null,
  kind                text not null,
  policy              text not null check (policy in ('EXCLUSIVE', 'SHARED')),
  parent_resource_id  uuid references resource(id),
  handover_minutes    int not null default 0 check (handover_minutes >= 0),
  capacity            int,
  status              text not null default 'ACTIVE' check (status in ('ACTIVE', 'RETIRED')),
  created_at          timestamptz not null default now()
);
create index resource_site_idx on resource(site_id);
create index resource_parent_idx on resource(parent_resource_id);

create function resource_no_cycle() returns trigger language plpgsql as $$
begin
  if new.parent_resource_id is null then return new; end if;
  if new.parent_resource_id = new.id or exists (
      with recursive up(id, parent_id) as (
        select id, parent_resource_id from resource where id = new.parent_resource_id
        union all
        select r.id, r.parent_resource_id from resource r join up on r.id = up.parent_id)
      select 1 from up where up.id = new.id) then
    raise exception 'resource tree cycle' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger resource_no_cycle before insert or update of parent_resource_id on resource
  for each row execute function resource_no_cycle();
create trigger resource_no_delete before delete on resource for each row execute function mover_forbid_delete();

-- Dated memberships and delegations --------------------------------------------------------------------

create table membership (
  id               uuid primary key,
  person_id        uuid not null references person(id),
  organization_id  uuid not null references organization(id),
  role_code        text not null references role_def(code),
  position_title   text,
  site_scope_id    uuid references site(id),
  valid_from       timestamptz not null,
  valid_to         timestamptz,
  ended_reason     text,
  created_at       timestamptz not null default now(),
  check (valid_to is null or valid_to > valid_from)
);
create index membership_person_idx on membership(person_id);
create index membership_org_idx on membership(organization_id);

create table delegation (
  id             uuid primary key,
  delegator_id   uuid not null references person(id),
  delegate_id    uuid not null references person(id),
  membership_id  uuid not null references membership(id),
  valid_from     timestamptz not null,
  valid_to       timestamptz not null,
  reason         text not null,
  revoked_at     timestamptz,
  revoked_by     uuid references person(id),
  revoke_reason  text,
  created_at     timestamptz not null default now(),
  check (valid_to > valid_from),
  check (delegator_id <> delegate_id)
);
create index delegation_delegate_idx on delegation(delegate_id);

create table user_session (
  id            text primary key,           -- sha-256 of the opaque cookie token; the token itself is never stored
  person_id     uuid not null references person(id),
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  client_ip     text,
  user_agent    text
);
create index user_session_person_idx on user_session(person_id);

-- Map packages (local, licensed, versioned) ------------------------------------------------------------

create table map_package (
  id                uuid primary key,
  code              text not null,
  name              text not null,
  version           text not null,
  data_date         date not null,
  source            text not null,
  license           text not null,
  attribution_html  text not null,
  crs               text not null,
  min_lat           double precision not null,
  min_lng           double precision not null,
  max_lat           double precision not null,
  max_lng           double precision not null,
  format            text not null check (format in ('SVG_OVERLAY', 'GEOJSON')),
  local_path        text not null,
  content_sha256    text not null,
  status            text not null default 'ACTIVE' check (status in ('ACTIVE', 'RETIRED')),
  installed_at      timestamptz not null default now(),
  unique (code, version, format)
);

-- Request types, versioned forms, workflows and policies ------------------------------------------------

create table request_type (
  code         text primary key,
  name         text not null,
  kind         text not null check (kind in ('NEW_RESERVATION', 'EXTENSION', 'MODIFICATION', 'CANCELLATION', 'EVACUATION')),
  multi_sites  boolean not null default true,
  multi_orgs   boolean not null default true,
  sort_order   int not null default 0,
  active       boolean not null default true
);

create table form_definition (
  id                 uuid primary key,
  request_type_code  text not null unique references request_type(code),
  created_at         timestamptz not null default now()
);

create table form_version (
  id            uuid primary key,
  form_id       uuid not null references form_definition(id),
  version       int not null,
  status        text not null check (status in ('DRAFT', 'PUBLISHED', 'RETIRED')),
  schema        jsonb not null,
  created_by    uuid references person(id),
  created_at    timestamptz not null default now(),
  published_by  uuid references person(id),
  published_at  timestamptz,
  unique (form_id, version)
);
create unique index form_version_single_draft on form_version(form_id) where status = 'DRAFT';

create table workflow_definition (
  id                 uuid primary key,
  request_type_code  text not null unique references request_type(code),
  created_at         timestamptz not null default now()
);

create table workflow_version (
  id                     uuid primary key,
  workflow_id            uuid not null references workflow_definition(id),
  version                int not null,
  status                 text not null check (status in ('DRAFT', 'PUBLISHED', 'RETIRED')),
  definition             jsonb not null,
  bpmn_xml               text,
  deployment_id          text,
  process_definition_id  text,
  created_by             uuid references person(id),
  created_at             timestamptz not null default now(),
  published_by           uuid references person(id),
  published_at           timestamptz,
  unique (workflow_id, version)
);
create unique index workflow_version_single_draft on workflow_version(workflow_id) where status = 'DRAFT';

create table policy_version (
  id            uuid primary key,
  version       int not null unique,
  status        text not null check (status in ('DRAFT', 'PUBLISHED', 'RETIRED')),
  settings      jsonb not null,
  created_by    uuid references person(id),
  created_at    timestamptz not null default now(),
  published_by  uuid references person(id),
  published_at  timestamptz
);

-- Published definitions are immutable; the only permitted transition is PUBLISHED -> RETIRED.
create function mover_published_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'DRAFT' then
      raise exception 'published % cannot be deleted', tg_table_name using errcode = '42501';
    end if;
    return old;
  end if;
  if old.status <> 'DRAFT' then
    if (to_jsonb(new) - 'status') is distinct from (to_jsonb(old) - 'status')
       or not (new.status = old.status or (old.status = 'PUBLISHED' and new.status = 'RETIRED')) then
      raise exception 'published % is immutable', tg_table_name using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger form_version_immutable before update or delete on form_version
  for each row execute function mover_published_immutable();
create trigger workflow_version_immutable before update or delete on workflow_version
  for each row execute function mover_published_immutable();
create trigger policy_version_immutable before update or delete on policy_version
  for each row execute function mover_published_immutable();

-- Reservations ----------------------------------------------------------------------------------------

create table reservation (
  id                uuid primary key,
  resource_id       uuid not null references resource(id),
  organization_id   uuid not null references organization(id),
  request_id        uuid,
  request_revision  int,
  source            text not null check (source in ('APPROVAL', 'SEED_IMPORT')),
  period_start      timestamptz not null,
  period_end        timestamptz,                -- null = open-ended (permanent use by documented decision)
  status            text not null check (status in ('ACTIVE', 'CANCELLED', 'RELEASED')),
  purpose           text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  version           int not null default 0,
  check (period_end is null or period_end > period_start)
);
create index reservation_resource_idx on reservation(resource_id);
create index reservation_period_idx on reservation using gist (tstzrange(period_start, period_end, '[)'));

-- Scope locks: a reservation takes X locks on its resource and every descendant, and I (intent) locks on
-- every ancestor. X conflicts with X and with I; I never conflicts with I. Overlap is decided by Postgres
-- inside the committing transaction, so two concurrent approvals cannot both succeed.
create table reservation_lock (
  id              bigserial primary key,
  reservation_id  uuid not null references reservation(id),
  resource_id     uuid not null references resource(id),
  kind            text not null check (kind in ('X', 'I')),
  period          tstzrange not null,
  constraint reservation_lock_exclusive exclude using gist (resource_id with =, period with &&) where (kind = 'X'),
  constraint reservation_lock_intent exclude using gist (resource_id with =, period with &&, kind with <>)
);
create index reservation_lock_reservation_idx on reservation_lock(reservation_id);

create table reservation_change (
  id               uuid primary key,
  reservation_id   uuid not null references reservation(id),
  request_id       uuid,
  change_kind      text not null,
  previous_start   timestamptz,
  previous_end     timestamptz,
  new_start        timestamptz,
  new_end          timestamptz,
  previous_status  text,
  new_status       text,
  effective_at     timestamptz not null,
  created_by       uuid references person(id),
  created_at       timestamptz not null default now()
);
create trigger reservation_change_append_only before update or delete on reservation_change
  for each row execute function mover_forbid_change();

-- Requests, revisions, tasks, decisions -----------------------------------------------------------------

create sequence request_number_seq;

create table request (
  id                     uuid primary key,
  number                 text not null unique,
  type_code              text not null references request_type(code),
  status                 text not null check (status in ('DRAFT', 'SUBMITTED', 'RETURNED', 'REJECTED', 'APPROVED', 'CLOSED')),
  origin                 text not null check (origin in ('MAP', 'LIST')),
  owner_org_id           uuid not null references organization(id),
  created_by             uuid not null references person(id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  submitted_at           timestamptz,
  decided_at             timestamptz,
  closed_at              timestamptz,
  version                int not null default 0,
  current_revision       int not null default 0,
  draft                  jsonb not null,
  period_start           timestamptz,
  period_end             timestamptz,
  target_reservation_id  uuid references reservation(id),
  form_version_id        uuid not null references form_version(id),
  workflow_version_id    uuid references workflow_version(id),
  policy_version_id      uuid references policy_version(id),
  process_instance_id    text,
  last_note              text
);
create index request_status_idx on request(status);
create index request_owner_idx on request(owner_org_id);
create index request_creator_idx on request(created_by);
create index request_period_idx on request using gist (tstzrange(period_start, period_end, '[)'));

alter table reservation add constraint reservation_request_fk foreign key (request_id) references request(id);
alter table reservation_change add constraint reservation_change_request_fk foreign key (request_id) references request(id);

-- Current working set of resources / organisations (queried for scope and map layers).
create table request_resource (
  request_id   uuid not null references request(id),
  resource_id  uuid not null references resource(id),
  primary key (request_id, resource_id)
);
create index request_resource_resource_idx on request_resource(resource_id);

create table request_participant (
  request_id       uuid not null references request(id),
  organization_id  uuid not null references organization(id),
  relation         text not null check (relation in ('PARTICIPANT', 'INFO')),
  primary key (request_id, organization_id, relation)
);
create index request_participant_org_idx on request_participant(organization_id);

-- Immutable snapshot of each submission.
create table request_revision (
  id                   uuid primary key,
  request_id           uuid not null references request(id),
  revision             int not null,
  data                 jsonb not null,
  period_start         timestamptz,
  period_end           timestamptz,
  form_version_id      uuid not null references form_version(id),
  workflow_version_id  uuid not null references workflow_version(id),
  policy_version_id    uuid not null references policy_version(id),
  submitted_by         uuid not null references person(id),
  submitted_at         timestamptz not null,
  reason               text,
  content_sha256       text not null,
  carried_stages       text[] not null default '{}',
  unique (request_id, revision)
);
create trigger request_revision_append_only before update or delete on request_revision
  for each row execute function mover_forbid_change();

create table task_assignment (
  id                   uuid primary key,
  request_id           uuid not null references request(id),
  revision             int not null,
  flowable_task_id     text unique,
  process_instance_id  text not null,
  stage_key            text not null,
  stage_name           text not null,
  role_code            text not null references role_def(code),
  target_org_id        uuid references organization(id),
  final                boolean not null,
  requires_signature   boolean not null,
  status               text not null check (status in ('OPEN', 'APPROVED', 'RETURNED', 'REJECTED', 'CLOSED_BY_POLICY', 'CANCELLED')),
  created_at           timestamptz not null,
  due_at               timestamptz not null,
  closed_at            timestamptz,
  overdue_notified     boolean not null default false
);
create index task_assignment_request_idx on task_assignment(request_id);
create index task_assignment_open_idx on task_assignment(role_code, due_at) where status = 'OPEN';

create table decision (
  id                 uuid primary key,
  request_id         uuid not null references request(id),
  revision           int not null,
  task_id            uuid references task_assignment(id),
  stage_key          text not null,
  stage_name         text not null,
  actor_person_id    uuid not null references person(id),
  actor_name         text not null,       -- identity and capacity captured at decision time
  actor_role_code    text not null,
  actor_role_name    text not null,
  actor_org_id       uuid references organization(id),
  actor_org_name     text,
  via_delegation_id  uuid references delegation(id),
  decision           text not null check (decision in ('APPROVE', 'RETURN', 'REJECT', 'CARRIED_FORWARD')),
  reason_code        text,
  note               text,
  carried_from       uuid references decision(id),
  decided_at         timestamptz not null
);
create index decision_request_idx on decision(request_id);
create trigger decision_append_only before update or delete on decision
  for each row execute function mover_forbid_change();

create table approval_document (
  id                uuid primary key,
  request_id        uuid not null references request(id),
  revision          int not null,
  decision_id       uuid not null references decision(id),
  canonical         jsonb not null,
  sha256            text not null,
  signature_mode    text not null check (signature_mode in ('INTERNAL_ATTESTATION', 'PKI')),
  signer_person_id  uuid not null references person(id),
  signer_name       text not null,
  signer_role       text not null,
  signed_at         timestamptz not null,
  evidence          text not null
);
create trigger approval_document_append_only before update or delete on approval_document
  for each row execute function mover_forbid_change();

create table execution_task (
  id                      uuid primary key,
  request_id              uuid not null references request(id),
  key                     text not null,
  name                    text not null,
  role_code               text not null references role_def(code),
  target_org_id           uuid references organization(id),
  due_at                  timestamptz not null,
  evidence_required       boolean not null,
  status                  text not null check (status in ('OPEN', 'DONE')),
  completed_by            uuid references person(id),
  completed_at            timestamptz,
  note                    text,
  evidence_attachment_id  uuid,
  overdue_notified        boolean not null default false,
  created_at              timestamptz not null default now()
);
create index execution_task_request_idx on execution_task(request_id);

-- Attachments: real content, content-addressed on the local volume --------------------------------------

create table attachment (
  id             uuid primary key,
  request_id     uuid not null references request(id),
  field_id       text not null,
  version        int not null,
  file_name      text not null,
  content_type   text not null,
  size_bytes     bigint not null,
  sha256         text not null,
  storage_key    text,
  scan_status    text not null check (scan_status in ('PENDING', 'CLEAN', 'REJECTED')),
  scan_detail    text,
  uploaded_by    uuid not null references person(id),
  uploaded_at    timestamptz not null default now(),
  superseded_by  uuid references attachment(id)
);
create index attachment_request_idx on attachment(request_id, field_id);

-- Audit trail (append-only at the database level) ------------------------------------------------------

create table audit_event (
  id                 bigserial primary key,
  occurred_at        timestamptz not null default now(),
  actor_person_id    uuid,
  actor_name         text,
  actor_role         text,
  actor_org          text,
  via_delegation_id  uuid,
  action             text not null,
  entity_type        text not null,
  entity_id          text,
  entity_label       text,
  detail             jsonb not null default '{}'::jsonb,
  reason             text,
  revision           int,
  tx_id              bigint not null default txid_current(),
  trace_id           text
);
create index audit_event_entity_idx on audit_event(entity_type, entity_id);
create index audit_event_time_idx on audit_event(occurred_at desc);
create trigger audit_event_append_only before update or delete on audit_event
  for each row execute function mover_forbid_change();
create trigger audit_event_no_truncate before truncate on audit_event
  for each statement execute function mover_forbid_change();

-- Transactional outbox, notifications, idempotency, exports, integrations ------------------------------

create table outbox_event (
  id              bigserial primary key,
  aggregate_type  text not null,
  aggregate_id    text not null,
  event_type      text not null,
  payload         jsonb not null,
  created_at      timestamptz not null default now(),
  available_at    timestamptz not null default now(),
  attempts        int not null default 0,
  delivery_state  text not null default 'PENDING' check (delivery_state in ('PENDING', 'DONE', 'FAILED')),
  processed_at    timestamptz,
  last_error      text
);
create index outbox_pending_idx on outbox_event(available_at, id) where delivery_state = 'PENDING';

create table notification (
  id               uuid primary key,
  person_id        uuid not null references person(id),
  outbox_event_id  bigint references outbox_event(id),
  kind             text not null,
  title            text not null,
  body             text not null,
  request_id       uuid references request(id),
  created_at       timestamptz not null default now(),
  read_at          timestamptz,
  unique (outbox_event_id, person_id, kind)
);
create index notification_person_idx on notification(person_id, created_at desc);

create table idempotency_record (
  person_id     uuid not null references person(id),
  idem_key      text not null,
  operation     text not null,
  request_hash  text not null,
  status_code   int,
  response      jsonb,
  created_at    timestamptz not null default now(),
  primary key (person_id, idem_key)
);

create table export_job (
  id            uuid primary key,
  requested_by  uuid not null references person(id),
  kind          text not null,
  filter        jsonb not null,
  status        text not null check (status in ('READY', 'FAILED')),
  row_count     int not null default 0,
  storage_key   text,
  created_at    timestamptz not null default now()
);

create table integration_run (
  id          uuid primary key,
  connector   text not null,
  status      text not null check (status in ('PREVIEWED', 'INVALID', 'COMMITTED', 'FAILED')),
  payload     jsonb not null,
  result      jsonb not null,
  started_by  uuid references person(id),
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);
