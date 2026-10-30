-- V13: explicit referral for study, recorded communication of decisions and administrative completion
-- (owner brief of 30 Oct 2026 §5, ADR-022). Existing decisions, requests and roles keep their meaning.

-- A completeness review may refer a request onward for study (REFER) instead of the generic forward approval; both
-- move the request to the next configured stage, only APPROVE at the final stage approves it.
alter table decision drop constraint decision_decision_check;
alter table decision add constraint decision_decision_check
  check (decision in ('APPROVE', 'REFER', 'RETURN', 'REJECT', 'CARRIED_FORWARD'));

-- Who communicated a decision, to whom, when, through which channel and which document/revision. Append-only; the
-- information recipients of a request stay separate (request_info_org) and get no task.
create table decision_communication (
  id                  uuid primary key,
  request_id          uuid not null references request(id),
  decision_id         uuid references decision(id),
  revision            int not null,
  outcome             text not null check (outcome in ('APPROVED', 'REJECTED', 'RETURNED', 'CLOSED')),
  recipient_kind      text not null check (recipient_kind in ('ORGANIZATION', 'PERSON', 'OTHER')),
  recipient_org_id    uuid references organization(id),
  recipient_person_id uuid references person(id),
  recipient_text      text check (recipient_text is null or length(recipient_text) <= 200),
  channel             text not null check (channel in ('IN_APP', 'INTERNAL_MAIL', 'OFFICIAL_LETTER', 'HAND_DELIVERY', 'OTHER')),
  reference           text check (reference is null or length(reference) <= 120),
  document_revision   int,
  document_sha256     text,
  communicated_at     timestamptz not null,
  recorded_by         uuid not null references person(id),
  recorded_by_name    text not null,
  recorded_at         timestamptz not null,
  note                text check (note is null or length(note) <= 2000),
  check ((recipient_kind = 'ORGANIZATION') = (recipient_org_id is not null)),
  check ((recipient_kind = 'PERSON') = (recipient_person_id is not null)),
  check (recipient_kind <> 'OTHER' or length(coalesce(recipient_text, '')) >= 2)
);
create index decision_communication_request on decision_communication(request_id, communicated_at);
create trigger decision_communication_append_only before update or delete on decision_communication
  for each row execute function mover_forbid_change();

-- Approval does not close a request: administrative completion is a separate action with a statement.
alter table request add column completion_statement text;
alter table request add column completion_reference text;
alter table request add column completed_by uuid references person(id);

-- Closing is its own right (CLOSE). It goes to the facilities review role that already runs execution and receipt;
-- an access manager can add it to other roles through the policy studio. The requester no longer closes by default.
update role_def set permissions = array_append(permissions, 'CLOSE')
where code = 'FACILITIES_REVIEWER' and not ('CLOSE' = any(permissions));
