-- V32: an optional map symbol for a site (owner, 10 Nov 2026; ADR-048), as MOVER's «رمز يظهر على الخريطة (اختياري)».
-- Display only: it never changes a right, an availability, a rule or the site's shape. One symbol per site; a change replaces
-- it and is recorded in audit_event (SITE_SYMBOL_SET / SITE_SYMBOL_CLEARED). Codes as MOVER stores them: MIL-STD-2525C
-- (15 characters, APP-6 compatible) or APP-6D (20 or 30 digits); tactical graphics and METOC are refused by the server.
create table site_symbol (
  site_id     uuid primary key references site(id),
  sidc        text not null check (sidc ~ '^[A-Z][A-Z-][A-Z-][A-Z-][A-Z0-9-]{6}[A-Z0-9-]{5}$' or sidc ~ '^[0-9]{20}([0-9]{10})?$'),
  standard    text not null check (standard in ('2525C', 'APP6D')),
  updated_by  uuid not null references person(id),
  updated_at  timestamptz not null,
  check ((standard = '2525C') = (sidc !~ '^[0-9]'))
);
