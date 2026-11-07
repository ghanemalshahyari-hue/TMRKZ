-- What a person may ask for is a setting of the system administrator, not a fixed list (ADR-044, as in the movement programme).
-- EVERYONE: shown to any person on the page to ask. MANAGER: not shown to them; the unit's access manager adds it during review.
create table access_request_offer (
  role_code text primary key,
  audience  text not null check (audience in ('EVERYONE', 'MANAGER'))
);

insert into access_request_offer(role_code, audience) values
  ('REQUESTER', 'EVERYONE'),
  ('CHAIN_APPROVER', 'EVERYONE'),
  ('UNIT_OPERATIONS_APPROVER', 'EVERYONE'),
  ('FYI_RECEIVER', 'EVERYONE');
