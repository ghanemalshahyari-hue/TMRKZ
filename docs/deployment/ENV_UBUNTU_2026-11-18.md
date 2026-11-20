# `.env` on the Ubuntu server — TMRKZ 2026.11.20.1 (written 20 Nov 2026)

TMRKZ runs from its folder (ADR-091): `docker-compose.yml` + `docker-compose.override.yml`, the settings in `.env`, the data in
`data/`. `sh start.sh` creates `.env` on a new checkout (`ops/init-env.sh` generates every secret) and asks only for the IP
address and the port. **Everything a person can enter on a screen is not in `.env`**: the enterprise directory and the
enterprise Keycloak are entered in «إعدادات النظام ← إعدادات التكامل» (ADR-092), the HR (Oracle) source in «مصدر الموارد
البشرية». No real value appears below; `<…>` is a placeholder.

**A server that already runs TMRKZ keeps its `.env`.** `start.sh` adds the keys a newer version needs and changes no existing
value. The only keys this release introduces are marked *new*.

## TMRKZ application

| Variable | Purpose | Example / placeholder | Required? |
|---|---|---|---|
| `TMRKZ_IP` | the IP address people open (asked by `start.sh`) | `10.0.0.5` | yes (`start.sh`) |
| `TMRKZ_PORT` | the port people open; the only published port | `8088` | yes (`start.sh`) |
| `TMRKZ_PUBLIC_URL` | **the one address** every sign-in address derives from: `http://IP:PORT` written by `start.sh`, or `https://<name>` written by `ops/tls/enable.sh` and then kept (ADR-092) | `http://10.0.0.5:8088` | yes (written) |
| `MOVER_HTTP_PORT` | the same port for the `ops/*.sh` tools (written by `start.sh`) | `8088` | written |
| `MOVER_SECURE_COOKIE` | `true` with https only | `false` | yes |
| `MOVER_ATTESTATION_KEY` | key of the internal approval attestation (32+ chars) | generated | yes (generated) |
| `TMRKZ_HR_SETTINGS_KEY` | TMRKZ's own key for every secret saved on a screen: the HR source password, the directory's service password, the Keycloak client secret (ADR-092). **Rotating it makes those saved secrets unreadable on purpose; they are re-entered.** | generated | yes (generated) |
| `TMRKZ_PLATFORM_ACCOUNTS` | the lasting platform logins | `admin,developer` (default) | no |
| `TMRKZ_PLATFORM_ADMIN_PASSWORD`, `TMRKZ_PLATFORM_DEVELOPER_PASSWORD` | their passwords; set again on every start by `keycloak-setup` | generated — **change to the owner's** | yes |
| `TMRKZ_STATIONING_V3` | the stationing screens (`true` on every installation since ADR-040) | `true` | yes |
| `TMRKZ_FLOW_STUDIO_UI` | the flow studio in the menu | `false` | no |
| `TMRKZ_AI_ENABLED`, `TMRKZ_AI_BASE_URL`, `TMRKZ_AI_MODEL`, `TMRKZ_AI_API_KEY` | «المساعد الذكي» against the site's own model server (ADR-056); off by default | `false` | no |
| `TMRKZ_STATIONING_OUTBOUND_URL`, `TMRKZ_STATIONING_OUTBOUND_TOKEN` | outbound stationing events to another system; empty = none | — | no |
| `TMRKZ_MAP_GID` | numeric group of a shared map folder (`ops/local/map-worker.sh`) | `0` | no |

## Database

| Variable | Purpose | Example / placeholder | Required? |
|---|---|---|---|
| `MOVER_DB_PASSWORD` | the application's PostgreSQL password **in the image-built installation only**; the folder installation (override) runs the database with no password on the internal network (ADR-091, `ops/local/workspace/pg_hba.conf`). Kept for the `ops/*.sh` tools. | generated | yes (generated) |
| `TMRKZ_KEYCLOAK_DB_PASSWORD`, `TMRKZ_OPENFGA_DB_PASSWORD` | the identity and authorisation databases' owners (same server) | generated | yes (generated) |

The data lives in `data/db` (PostgreSQL 17 + PostGIS), `data/files` (uploads), `data/ldap-data` + `data/ldap-config` (the
stand-in directory). Flyway upgrades the schema at the backend's start (this release: V54).

## OpenFGA

| Variable | Purpose | Example / placeholder | Required? |
|---|---|---|---|
| `TMRKZ_OPENFGA_API_TOKEN` | the preshared key between TMRKZ and its own OpenFGA | generated | yes (generated) |

The store and model are TMRKZ's own (`openfga-migrate`, the backend's `AuthzSync`); nothing is entered by hand.

## LDAP / directory

Enter the enterprise directory on the screen: **إعدادات النظام ← إعدادات التكامل ← الدليل المؤسسي** (server, LDAPS or
StartTLS, the sign-in domain `user@domain` as MOVER, the search base, the attributes — the «Active Directory» preset —,
the CA certificate pasted as PEM, «اختبار الاتصال», «حفظ»). It is in force at once and ahead of these `.env` keys, which remain
for an installation configured before the screen existed:

| Variable | Purpose | Example / placeholder | Required? |
|---|---|---|---|
| `LDAP_URL` | `ldaps://<host>:636`, or `ldap://<host>:389` with StartTLS | written by `start.sh` as the stand-in `ldap://openldap:389` while no directory is entered | written |
| `LDAP_START_TLS` | `true` for `ldap://` | `true` | written |
| `LDAP_BIND_DN`, `LDAP_BIND_CREDENTIAL` | a read-only service account (the stand-in's admin, written by `start.sh`) | — | written |
| `LDAP_USERS_DN` | the search base | `DC=example,DC=local` | written |
| `LDAP_DIRECT_BIND_PATTERN` | `{username}@<domain>` for a self-bind directory | — | no |
| `LDAP_VENDOR`, `LDAP_USERNAME_ATTRIBUTE`, `LDAP_UUID_ATTRIBUTE`, `LDAP_USER_OBJECT_CLASS`, `LDAP_USER_OBJECT_CLASSES`, `LDAP_EMPLOYEE_NUMBER_ATTRIBUTE` | Active Directory: `ad`, `sAMAccountName`, `objectGUID`, `user`, `person, organizationalPerson, user`, the number attribute | defaults for a standard directory | no |
| `LDAP_ATTR_UNIT_ID`, `LDAP_ATTR_UNIT_NAME`, `LDAP_ATTR_MAIN_UNIT_ID`, `LDAP_ATTR_RANK`, `LDAP_ATTR_POSITION` | the directory attributes carrying the employment context before Oracle is in force (ADR-068); empty = not read | — | no |
| `LOCAL_LDAP_ADMIN_PASSWORD` | the stand-in directory's own admin password (written by `start.sh`) | generated | written |
| `TMRKZ_TRUSTSTORE_DIR` | the folder of CA files (PEM) the backend and the local Keycloak trust; `start.sh` points it at the stand-in's CA; the screen's pasted CA is trusted in addition | `./ops/local/.generated/truststore` | written |

## Keycloak

Enter the enterprise Keycloak on the screen: **إعدادات التكامل ← الدخول الآلي (Keycloak)** (the server address the browser
opens, the realm, TMRKZ's confidential client ID and secret, the internal address when the back channel differs, the CA).
The local Keycloak (platform accounts `admin`, `developer`) needs nothing entered:

| Variable | Purpose | Example / placeholder | Required? |
|---|---|---|---|
| `TMRKZ_KEYCLOAK_ADMIN_PASSWORD` | the local Keycloak's bootstrap administrator | generated | yes (generated) |
| `TMRKZ_OIDC_CLIENT_SECRET` | the local realm's browser client `tmrkz-web` (set again on every start) | generated | yes (generated) |
| `TMRKZ_PLATFORM_OIDC_CLIENT_SECRET`, `TMRKZ_PLATFORM_OIDC_CLIENT_ID` | the backend-only client of the manual platform sign-in (ADR-070) | generated / `tmrkz-platform-password` | yes (generated) |
| `TMRKZ_KEYCLOAK_LOGIN_THEME` | `keycloak.v2` (Keycloak's own page, as MOVER) or `tmrkz` | `keycloak.v2` | no |
| `TMRKZ_ENTERPRISE_OIDC_ISSUER`, `_INTERNAL_URL`, `_CLIENT_ID`, `_CLIENT_SECRET` | the enterprise Keycloak **by file** (ADR-071); the screen's values take precedence | — | no |
| `TMRKZ_PLATFORM_OIDC_ISSUER`, `_INTERNAL_URL`, `TMRKZ_PLATFORM_BROWSER_*` | a separate platform realm; normally empty | — | no |
| `TMRKZ_OIDC_LINK_KEY` | `DOMAIN_ACCOUNT` (the login equals the HR domain account) or `EMPLOYEE_NUMBER` | `DOMAIN_ACCOUNT` | no |
| `TMRKZ_OIDC_CLAIM_UNIT_ID`, `_UNIT_NAME`, `_MAIN_UNIT_ID`, `_RANK`, `_POSITION` | the ID-token claims carrying the employment context (ADR-068); empty = not read | — | no |

## Oracle / HR

Nothing in `.env`. The Oracle HR source (address, port, service name or SID, read-only user and password, the two views,
the column mapping) is entered in **إعدادات النظام ← مصدر الموارد البشرية** and protected with `TMRKZ_HR_SETTINGS_KEY`.

| Variable | Purpose | Example / placeholder | Required? |
|---|---|---|---|
| `TMRKZ_HR_SYNC_INTERVAL_SECONDS` | the hourly unit sync's interval | `3600` | no |

## Map / terrain paths

| Variable | Purpose | Example / placeholder | Required? |
|---|---|---|---|
| `TMRKZ_MAP_ROOT` | the offline map root the web entry point serves (`current/` = the installed package) | `./map-runtime` (default) | no |

The map package already installed on the server (`tmrkz-map-2026.11.2`, with `terrain-3d`, ADR-047) stays where it is; the
application transfer carries no map data. `map-packages/` (the backend's package register) is part of the folder.

## TLS

| Variable | Purpose | Example / placeholder | Required? |
|---|---|---|---|
| `COMPOSE_PROFILES` | `tls` switches the https entry point on (`ops/tls/enable.sh` writes it) | — | https only |
| `TMRKZ_TLS_DIR` | `server.crt` + `server.key` issued for the public name | `./ops/tls/private` | https only |
| `TMRKZ_HTTPS_PORT`, `TMRKZ_HTTP_REDIRECT_PORT` | the https port and the redirecting plain port | `443`, `80` | https only |
| `MOVER_HTTP_BIND` | `127.0.0.1` with https, so the plain port is local only | `0.0.0.0` | https only |

With https, `TMRKZ_PUBLIC_URL=https://<name>` is written by `ops/tls/enable.sh` and `start.sh` keeps it.

## Runtime / performance

| Variable | Purpose | Example / placeholder | Required? |
|---|---|---|---|
| `JAVA_OPTS` (compose, not `.env`) | `-XX:MaxRAMPercentage=60 -Duser.timezone=UTC -Dfile.encoding=UTF-8` | fixed in the override | — |
| `MOVER_SESSION_ABSOLUTE_HOURS` | the session's absolute limit | `12` | no |
| `TMRKZ_REAUTH_MAX_AGE_SECONDS`, `TMRKZ_LOGIN_MAX_AGE_SECONDS` | step-up and sign-in freshness | `300`, `43200` | no |

## What changes on Ubuntu for this release

- **New (ADR-092):** nothing to add by hand. `TMRKZ_PUBLIC_URL` is now the one source of every sign-in address; `start.sh`
  writes it. The relay keys `TMRKZ_MANUAL_LDAP_*`, `COMPOSE_PROFILES=enterprise-ldap`, `TMRKZ_MANUAL_LDAP_DNS_NAME`,
  `TMRKZ_MANUAL_LDAP_RELAY_GATEWAY` and `TMRKZ_MANUAL_LDAP_RELAY_CONFIG` are **no longer read**: remove them from `.env`, and
  enter the directory on the screen instead.
- **Reused from the server's current `.env`:** every generated secret, the platform passwords, the port. Keep them: the
  saved screen secrets are readable only with the same `TMRKZ_HR_SETTINGS_KEY`.
