-- V44: one employment context, the directory before Oracle and Oracle after (LDAP first-login specification §1-8, 25, 26;
-- owner, 16 Nov 2026; ADR-068). While no HR source is enabled with a published snapshot, the directory says who a person is
-- and where they work, and a first directory sign-in creates the person with NO permission and NO unit entry. Once Oracle is
-- in force it decides the organisational placement, and a disagreement with the directory is audited.

-- What the directory (or the identity provider's claims taken from it) stated at the person's latest sign-in. The attribute
-- and claim names are installation settings (LDAP_ATTR_*, TMRKZ_OIDC_CLAIM_*); one that is not configured is stored as null.
-- A unit is joined by its Unit ID only (organization.source_external_id), never by its name, and is never created from here.
-- No password, bind credential or token is ever kept.
create table person_directory_profile (
  person_id              uuid primary key references person(id),
  issuer                 text not null,
  username               text,
  employee_number        text,
  display_name           text,
  rank                   text,
  position               text,
  unit_external_id       text,
  unit_name              text,
  main_unit_external_id  text,
  observed_at            timestamptz not null,
  -- the directory/Oracle Unit ID pair last audited as IDENTITY_ORG_SOURCE_MISMATCH, so a disagreement is audited once per change
  org_mismatch           text
);
create index person_directory_profile_unit_idx on person_directory_profile(unit_external_id) where unit_external_id is not null;
comment on table person_directory_profile is 'What the directory stated at the latest sign-in (ADR-068); never a password or token';

-- A person created by their own first directory sign-in while Oracle is not in force is linked with its own method.
alter table identity_link drop constraint identity_link_method_check;
alter table identity_link add constraint identity_link_method_check
  check (method in ('ENTERPRISE_KEY', 'ADMINISTRATOR', 'BOOTSTRAP', 'PLATFORM', 'LOCAL_USER', 'DIRECTORY'));

-- A directory sign-in whose login or employee number another TMRKZ record already holds never gets a second record: it waits
-- on the review list for an access manager.
alter table identity_link_issue drop constraint identity_link_issue_reason_check;
alter table identity_link_issue add constraint identity_link_issue_reason_check
  check (reason in ('NO_KEY', 'NO_MATCH', 'AMBIGUOUS', 'INACTIVE', 'STALE_SOURCE', 'ALREADY_LINKED', 'SOURCE_UNAVAILABLE',
                    'DIRECTORY_CONFLICT'));
