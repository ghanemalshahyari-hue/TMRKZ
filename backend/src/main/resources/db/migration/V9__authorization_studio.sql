-- V9: OpenFGA as co-decider, scoped grants and versioned access policy (ADR-018).
-- The business database stays the source of truth for grants; OpenFGA receives tuples through the outbox below.

-- ---- scoped grants -------------------------------------------------------------------------------------------
-- ROLE: the role's scope applied to the membership's organisation/site (the behaviour of every existing row).
-- CUSTOM: explicit targets in membership_scope_target, combined AND (default) or OR, or an explicit ALL.
alter table membership add column scope_mode text not null default 'ROLE' check (scope_mode in ('ROLE', 'CUSTOM'));
alter table membership add column scope_combine text not null default 'AND' check (scope_combine in ('AND', 'OR'));
alter table membership add column scope_all boolean not null default false;
alter table membership add column granted_by uuid references person(id);
alter table membership add check (scope_mode = 'CUSTOM' or not scope_all);

create table membership_scope_target (
  membership_id        uuid not null references membership(id),
  kind                 text not null check (kind in ('ORGANIZATION', 'SITE', 'RESOURCE')),
  target_id            uuid not null,
  include_descendants  boolean not null default true,
  primary key (membership_id, kind, target_id),
  check (kind <> 'RESOURCE' or not include_descendants)
);

-- Targets are fixed with the grant: a different scope is a new grant, so history shows who held what and when.
create function membership_scope_target_frozen() returns trigger language plpgsql as $$
begin
  raise exception 'scope targets are fixed once granted; end the grant and create a new one' using errcode = 'P0001';
end $$;
create trigger membership_scope_target_no_update before update or delete on membership_scope_target
  for each row execute function membership_scope_target_frozen();

-- ---- versioned access policy ---------------------------------------------------------------------------------
-- One draft at most, one published version; earlier versions are kept for comparison and restoration.
create table access_policy_version (
  id             uuid primary key,
  version        int not null unique,
  status         text not null check (status in ('DRAFT', 'PUBLISHED', 'SUPERSEDED', 'DISCARDED')),
  roles          jsonb not null,
  note           text,
  based_on       uuid references access_policy_version(id),
  restored_from  uuid references access_policy_version(id),
  fga_model_id   text,
  created_by     uuid references person(id),
  created_at     timestamptz not null default now(),
  published_by   uuid references person(id),
  published_at   timestamptz
);
create unique index access_policy_one_draft on access_policy_version((true)) where status = 'DRAFT';
create unique index access_policy_one_published on access_policy_version((true)) where status = 'PUBLISHED';

create function access_policy_version_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'policy versions are never deleted' using errcode = 'P0001';
  end if;
  if old.status <> 'DRAFT' and (new.roles is distinct from old.roles or new.version <> old.version) then
    raise exception 'published policy versions are immutable' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger access_policy_version_immutable before update or delete on access_policy_version
  for each row execute function access_policy_version_guard();

-- Roles a holder of MANAGE_ACCESS through this role may hand out (global access managers may grant any role).
alter table role_def add column grantable_roles text[] not null default '{}';
alter table role_def add column policy_version int;

-- ---- authorisation outbox, OpenFGA mirror and sync state -----------------------------------------------------
-- Every change that can alter a decision appends a row in the same transaction (triggers below). The sync worker
-- applies changes to OpenFGA and records the highest sequence applied; sensitive actions are refused while a change
-- concerning the actor (or the shared structure) is not yet applied.
create table authz_change (
  seq         bigserial primary key,
  person_id   uuid,
  source      text not null,
  created_at  timestamptz not null default now()
);
create index authz_change_person_idx on authz_change(person_id, seq);

create table authz_tuple (
  object     text not null,
  relation   text not null,
  subject    text not null,
  condition  jsonb,
  person_id  uuid,
  kind       text not null check (kind in ('STRUCTURE', 'GRANT')),
  primary key (object, relation, subject)
);
create index authz_tuple_person_idx on authz_tuple(person_id) where person_id is not null;

create table authz_sync_state (
  id                integer primary key check (id = 1),
  store_id          text,
  model_id          text,
  model_hash        text,
  applied_seq       bigint not null default 0,
  tuples            integer not null default 0,
  last_success_at   timestamptz,
  last_duration_ms  integer,
  last_error        text,
  last_error_at     timestamptz
);
insert into authz_sync_state(id) values (1);

create function authz_note_person() returns trigger language plpgsql as $$
declare
  pid uuid;
begin
  if tg_table_name = 'membership' then
    pid := coalesce(new.person_id, old.person_id);
  elsif tg_table_name = 'delegation' then
    pid := coalesce(new.delegate_id, old.delegate_id);
  elsif tg_table_name = 'membership_scope_target' then
    select person_id into pid from membership where id = coalesce(new.membership_id, old.membership_id);
  end if;
  insert into authz_change(person_id, source) values (pid, tg_table_name);
  return null;
end $$;

-- Shared changes name what they affect: 'structure' (organisation/site/resource relations) or 'grants' (every holder).
create function authz_note_shared() returns trigger language plpgsql as $$
begin
  insert into authz_change(person_id, source) values (null, tg_table_name || ':' || tg_argv[0]);
  return null;
end $$;

create trigger membership_authz after insert or update on membership
  for each row execute function authz_note_person();
create trigger delegation_authz after insert or update on delegation
  for each row execute function authz_note_person();
create trigger membership_scope_target_authz after insert on membership_scope_target
  for each row execute function authz_note_person();

create trigger organization_authz after insert or update of parent_id on organization
  for each statement execute function authz_note_shared('structure');
create trigger organization_status_authz after update of status on organization
  for each statement execute function authz_note_shared('grants');
create trigger site_authz after insert or update of parent_id on site
  for each statement execute function authz_note_shared('structure');
create trigger site_responsibility_authz after insert or update on site_responsibility
  for each statement execute function authz_note_shared('structure');
create trigger resource_authz after insert or update of site_id on resource
  for each statement execute function authz_note_shared('structure');
create trigger role_def_authz after insert or update on role_def
  for each statement execute function authz_note_shared('grants');
create trigger person_authz after update of status on person
  for each statement execute function authz_note_shared('grants');
create trigger position_seat_authz after insert or update on position_seat
  for each statement execute function authz_note_shared('grants');
create trigger affiliation_authz after insert or update or delete on affiliation
  for each statement execute function authz_note_shared('grants');

-- Roles holding MANAGE_ACCESS below the global level may hand out every role without administrative actions,
-- which keeps what existing access managers could do while excluding configuration and source identifiers.
update role_def r set grantable_roles = coalesce((select array_agg(x.code order by x.sort_order, x.code) from role_def x
  where not (x.permissions && array['MANAGE_ACCESS','CONFIGURE','VIEW_SOURCE_IDENTIFIERS']) and x.scope <> 'ALL'), '{}')
where 'MANAGE_ACCESS' = any(r.permissions) and r.scope <> 'ALL';

insert into authz_change(person_id, source) values (null, 'V9:grants');
