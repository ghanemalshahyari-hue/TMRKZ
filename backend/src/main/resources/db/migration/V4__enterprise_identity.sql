-- V4: enterprise sign-in (OIDC from Keycloak, passwords verified by LDAP inside Keycloak). TMRKZ stores no passwords
-- for enterprise users; it links an identity (issuer, subject) to the HR person on a stable enterprise key.

create table identity_link (
  id          uuid primary key,
  person_id   uuid not null references person(id),
  issuer      text not null,
  subject     text not null,
  method      text not null check (method in ('ENTERPRISE_KEY', 'ADMINISTRATOR')),
  linked_by   uuid references person(id),
  linked_at   timestamptz not null default now(),
  unique (issuer, subject),
  unique (person_id, issuer)
);

-- Sign-ins that could not be linked automatically wait here for an authorised decision; nothing is linked by name.
create table identity_link_issue (
  id                   uuid primary key,
  issuer               text not null,
  subject              text not null,
  claimed_key          text,
  display_name         text,
  reason               text not null check (reason in ('NO_KEY', 'NO_MATCH', 'AMBIGUOUS', 'INACTIVE', 'STALE_SOURCE', 'ALREADY_LINKED')),
  attempts             int not null default 1,
  first_seen_at        timestamptz not null default now(),
  last_seen_at         timestamptz not null default now(),
  resolved_at          timestamptz,
  resolved_by          uuid references person(id),
  resolved_person_id   uuid references person(id),
  resolution           text check (resolution in ('LINKED', 'DISMISSED'))
);
create unique index identity_link_issue_open on identity_link_issue(issuer, subject) where resolved_at is null;

-- One authorisation request in flight: single use, short lived, bound to the browser that started it.
create table oidc_login (
  state_hash      text primary key,
  browser_hash    text not null,
  code_verifier   text not null,
  nonce           text not null,
  purpose         text not null check (purpose in ('LOGIN', 'REAUTH')),
  return_to       text not null,
  session_id      text,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null
);

-- When the person last authenticated interactively (OIDC auth_time), for sensitive actions; the ID token is kept
-- server-side only to end the provider session on logout.
alter table user_session add column authenticated_at timestamptz;
alter table user_session add column issuer text;
alter table user_session add column id_token text;
update user_session set authenticated_at = created_at where authenticated_at is null;
