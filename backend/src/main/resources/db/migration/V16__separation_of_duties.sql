-- V16 (ADR-027): separation of duties compares humans, not records. A person's sign-in keys — employee number, account
-- and the key claimed by a sign-in an administrator linked — are matched case-insensitively across records, at every
-- decision and task creation. Indexes only: no table, column or data changes.
create index if not exists person_employee_no_lower_idx on person (lower(employee_no));
create index if not exists person_username_lower_idx on person (lower(username)) where username is not null;
create index if not exists identity_link_issue_linked_key_idx on identity_link_issue (lower(claimed_key))
  where resolution = 'LINKED' and claimed_key is not null;
create index if not exists identity_link_issue_resolved_person_idx on identity_link_issue (resolved_person_id)
  where resolution = 'LINKED';
