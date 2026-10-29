-- V12: informational unit identity symbols (docs/MAP_WORKSPACE_COMPLETION_AR.md §10, ADR-021).
-- Local metadata keyed by the stable organisation id. The HR mirror never writes these tables, so the hourly
-- publication keeps every assignment. Symbols are number-based SIDCs rendered locally (milsymbol); nothing here is
-- inferred from an organisation's name or HR level, and no assignment grants any right.

-- Approved symbols the institution offers for selection (empty in a new installation).
create table unit_symbol_catalog (
  code           text primary key check (code ~ '^[A-Z0-9_-]{2,40}$'),
  standard       text not null check (standard in ('APP6', '2525')),
  edition        text not null check (edition in ('D', 'E')),
  sidc           text not null check (sidc ~ '^[0-9]{20}([0-9]{10})?$'),
  name_ar        text not null check (length(name_ar) between 2 and 120),
  description_ar text check (description_ar is null or length(description_ar) <= 300),
  active         boolean not null default true,
  created_by     uuid references person(id),
  created_at     timestamptz not null default now()
);

-- The symbol assigned to an organisation: standard and edition recorded with it, source and who set it.
create table org_unit_symbol (
  organization_id uuid primary key references organization(id),
  standard        text not null check (standard in ('APP6', '2525')),
  edition         text not null check (edition in ('D', 'E')),
  sidc            text not null check (sidc ~ '^[0-9]{20}([0-9]{10})?$'),
  description_ar  text not null check (length(description_ar) between 2 and 200),
  source          text not null check (source in ('CATALOG', 'MANUAL')),
  catalog_code    text references unit_symbol_catalog(code),
  version         int not null default 1,
  updated_by      uuid not null references person(id),
  updated_at      timestamptz not null,
  check ((source = 'CATALOG') = (catalog_code is not null))
);
