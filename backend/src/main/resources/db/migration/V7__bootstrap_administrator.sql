-- V7: first administrator of an empty installation. Setting up the HR source needs an administrator, and a person
-- normally needs an HR record to sign in. The host operator breaks that circle once: ops/bootstrap-admin.sh registers a
-- directory login (usable for 24 hours, only while no active system administrator exists). Its first verified sign-in
-- creates a temporary local administrator (72 hours). When the HR mirror later contains the same person, the next
-- sign-in moves the link to the HR record and ends the temporary grant.
create table bootstrap_admin (
  login         text primary key,
  requested_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  used_at       timestamptz,
  person_id     uuid references person(id)
);

alter table person add column bootstrap boolean not null default false;

alter table identity_link drop constraint identity_link_method_check;
alter table identity_link add constraint identity_link_method_check check (method in ('ENTERPRISE_KEY', 'ADMINISTRATOR', 'BOOTSTRAP'));
