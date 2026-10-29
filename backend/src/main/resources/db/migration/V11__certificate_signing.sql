-- V11: certificate signatures and organisation seals on approval documents (D-02, PA-22/PA-23, ADR-020).
-- Signing happens outside the decision transaction: the document is frozen in a signing job, signed by the provider,
-- validated, and only then published by the decision (which re-checks permission, revision and availability).

create table signing_job (
  id                 uuid primary key,
  request_id         uuid not null references request(id),
  revision           int not null,
  task_id            uuid not null references task_assignment(id),
  signer_person_id   uuid not null references person(id),
  organization_id    uuid references organization(id),
  document_sha256    text not null,
  canonical          jsonb not null,
  provider           text not null,
  status             text not null check (status in ('PENDING', 'SIGNED', 'FAILED', 'PUBLISHED', 'UNPUBLISHED')),
  failure_code       text,
  failure_message    text,
  signed_document    bytea,
  decision_id        uuid references decision(id),
  unpublished_reason text,
  created_at         timestamptz not null default now(),
  signed_at          timestamptz,
  published_at       timestamptz,
  closed_at          timestamptz
);
-- One live job per person, task and frozen document: repeating "sign" returns it instead of signing twice.
create unique index signing_job_once on signing_job(task_id, signer_person_id, revision, document_sha256)
  where status in ('PENDING', 'SIGNED', 'PUBLISHED');
create index signing_job_request_idx on signing_job(request_id);

-- Evidence of each signature as validated when it was produced; never changed afterwards.
create table signature_evidence (
  id              uuid primary key,
  signing_job_id  uuid not null references signing_job(id),
  kind            text not null check (kind in ('PERSON', 'SEAL')),
  signature_id    text,
  certificate     text not null,
  subject         text,
  issuer          text,
  serial          text,
  not_before      timestamptz,
  not_after       timestamptz,
  signing_time    timestamptz,
  indication      text not null,
  sub_indication  text
);
create trigger signature_evidence_append_only before update or delete on signature_evidence
  for each row execute function mover_forbid_change();

-- Every validation (at signing, and each later verification) with its outcome; append-only.
create table validation_report (
  id              uuid primary key,
  signing_job_id  uuid not null references signing_job(id),
  validated_at    timestamptz not null,
  validated_by    uuid references person(id),
  passed          boolean not null,
  summary         jsonb not null
);
create trigger validation_report_append_only before update or delete on validation_report
  for each row execute function mover_forbid_change();

alter table approval_document add column signing_job_id uuid references signing_job(id);
