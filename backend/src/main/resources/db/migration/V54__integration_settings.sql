-- V54: «إعدادات التكامل» (owner, 20 Nov 2026; ADR-092) — the enterprise directory (LDAP) and the automatic sign-in's
-- Keycloak, as MOVER's integration settings page: kept by whoever configures the system, applied without a restart,
-- and ahead of the .env values. The secrets (a test account's password, the client secret) are encrypted with TMRKZ's own
-- key (TMRKZ_HR_SETTINGS_KEY, as the HR source); the CA certificates are public and kept in clear.
create table integration_setting (
  kind              text primary key check (kind in ('DIRECTORY', 'OIDC')),
  settings          jsonb not null,
  secret_ciphertext text,
  secret_key_id     text,
  updated_by        uuid references person(id),
  updated_at        timestamptz not null default now()
);
