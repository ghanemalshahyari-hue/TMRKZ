-- «الإعدادات → صلاحيات تهيئة المواقع» (owner brief §3, phase 7; ADR-089): who may set up a site with its unit's initial
-- stationing, besides the system administrator — roles, people, units (with or without the units under them) and levels of
-- the hierarchy. One rule, kept by whoever configures the system. No row: the initial rule, «معتمد عمليات الوحدة» for the
-- units in that role's own reach.
create table site_setup_access (
  id          smallint primary key default 1 check (id = 1),
  rule        jsonb not null,
  reason      text not null,
  updated_by  uuid not null references person(id),
  updated_at  timestamptz not null default now()
);
