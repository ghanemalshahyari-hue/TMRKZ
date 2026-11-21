# MOVER — Operations guide

## Backup

```sh
sh ops/backup.sh [project] [output-root]     # default project tmrkz-mover → backups/<project>-<UTC stamp>/
```

Produces `db.dump` (pg_dump custom format: business data, identities, roles, delegations, policies, form and
workflow versions, Flowable runtime/history, audit trail), `files.tgz` (attachments and exports), `map-packages.tgz`,
`fingerprint.txt` (row counts + md5 per critical table) and `manifest.json` (SHA-256 of every file). Run it on a quiet
system or accept that the fingerprint reflects the moment after the dump. Copy backups off-host according to the
organisation's retention policy (D-05 open).

## Restore

```sh
sh ops/restore.sh <backup-dir> [target-project] [http-port]
```

Restores into a **clean** project only (it refuses if the target database volume exists), verifies manifest checksums
first, restores the database, then the files volume, then starts the stack.

## Proving restore (AT-30)

```sh
sh ops/verify-restore.sh [source-project]
```

Backs up the source, restores into `<project>-restoretest` on port 18088, compares the 20 table fingerprints and
the SHA-256 of every stored attachment, checks the restored entry point, and removes the throw-away project.
Last run (28 Oct 2026): 20/20 tables identical, 2/2 attachments identical — PASSED.

## Upgrade and rollback

1. `sh ops/backup.sh` and keep the backup until the upgrade is accepted. Then `sh ops/upgrade-check.sh before`.
2. Load the new images (offline bundle) and `docker compose up -d --no-build`. Flyway applies new migrations on
   start; migrations are forward-only and additive by policy.
3. `sh ops/upgrade-check.sh after` — fails if any earlier site, boundary, request, revision, decision, approval
   document, reservation, lock, attachment, audit or package row changed or vanished (columns added by the migration
   are ignored). Verify `/api/v1/system/health`, sign in, run `tests/acceptance/journey.mjs` in a test environment.

**Upgrading to the map workspace (V8, ADR-017).** The database image changes from `postgres:17.11-alpine` to
`postgis/postgis:17-3.5-alpine`, the same PostgreSQL 17.11, so the existing volume is reused. V8 runs
`create extension postgis`, which needs the schema owner or a superuser; with separated database roles a DBA creates
the extension first. Existing point records stay points (no area is assumed for them); sites show «حدود الموقع غير
مسجلة» until a boundary is imported or drawn. On a new, empty volume the image also creates its own optional
extensions (topology, tiger geocoder) in the `mover` database; TMRKZ does not use them.
**Upgrading to V17 and V18 (ADR-028, ADR-031).** Verify every migration path first on a disposable environment:
`EXPECT_PENDING="17" AFTER_SQL=ops/sql/checks/V17-after.sql sh ops/verify-migration-path.sh <old image> <new image> v17`
(the plan must list exactly the expected versions, otherwise nothing is applied; evidence in
`docs/evidence/migration-path/<label>/`). TMRKZ's migration log is Flyway's `flyway_schema_history` (MOVER's
`release_migration_log` has no counterpart here); the backup manifest records the numeric schema version. V18 runs
`create extension postgis_raster` (schema owner or superuser; with separated roles a DBA creates it first), creates the
Stationing foundation tables empty and changes no existing row. The terrain slope data is not part of a migration:
load the approved package as a separate operation with `CONFIRM_TARGET=<project> sh ops/terrain/load-slope.sh <project>
<version>` (about 96 s and 453 MB for GLO-30; the load is one transaction checked by row and cell counts, and the same
product again only re-checks it). Remove it, for a rebuild or a replacement, with `ops/terrain/unload-slope.sh` (same
arguments; it changes no business record). After loading, publish a Stationing policy version that names it. Outbound stationing events are
delivered only when `TMRKZ_STATIONING_OUTBOUND_URL` (and, if the consumer needs one, `TMRKZ_STATIONING_OUTBOUND_TOKEN`
from the secret store) is set; otherwise they wait as PENDING (`tmrkz_stationing_outbox_pending`). The acceptance
environment is upgraded with `EXPECT_PENDING=… sh ops/test-env/upgrade-backend.sh <release image> <label>`, never by
`up.sh`; `up.sh` and `up-offline.sh` refuse a rebuild that would apply migrations unless `TMRKZ_APPLY_MIGRATIONS`
names them.
4. **Rollback:** stop the stack, restore the pre-upgrade backup into a clean project (`ops/restore.sh`) with the
   previous image tags. Do not run an older image against a newer schema.

Published form, workflow and policy versions are immutable, and running requests stay on their pinned versions, so
configuration changes never require data migration of in-flight requests.

## Monitoring (local only)

- Health: `GET /api/v1/system/health`, `GET /actuator/health` (backend network).
- Metrics: `GET /actuator/prometheus` on the backend (not published through `web`). Useful series:
  `http_server_requests_seconds` (API latency by URI/status), `mover_auth_failures_total{reason}` (failed sign-ins),
  `mover_api_errors_total{code}` (incl. `FORBIDDEN`, `RESERVATION_CONFLICT`), `mover_outbox_delivered_total`,
  `mover_outbox_failures_total`, and `GET /api/v1/system/info` → `outboxPending`.
- Review backlog: `GET /api/v1/reports/kpis` (overdue reviews and execution tasks, with definitions).
- Logs are written to stdout with a `traceId` per request (also returned as `X-Trace-Id`). Attachment content,
  passwords, session tokens and attestation keys are never logged.

## Secrets and key rotation

- `.env` holds `MOVER_DB_PASSWORD`, `MOVER_ATTESTATION_KEY`, `TMRKZ_HR_SETTINGS_KEY`, `TMRKZ_OIDC_CLIENT_SECRET`,
  `TMRKZ_KEYCLOAK_DB_PASSWORD`, `TMRKZ_KEYCLOAK_ADMIN_PASSWORD`, `TMRKZ_OPENFGA_DB_PASSWORD`, `TMRKZ_OPENFGA_API_TOKEN`
  (the OpenFGA preshared key) and the directory settings; permissions 600; never committed. `sh ops/init-env.sh` adds
  keys introduced by later versions to an existing `.env` without changing the others.
- Keys restored with a backup: `MOVER_ATTESTATION_KEY` (re-verifies attestation evidence), `TMRKZ_HR_SETTINGS_KEY`
  (decrypts the stored HR source password), `TMRKZ_OIDC_CLIENT_SECRET` (the realm's client secret) and the Keycloak and
  database passwords. They are not in the backup set: keep them in the organisation's key vault and restore `.env`
  from there before running `ops/restore.sh`. A backup contains the business database, the identity database
  (`keycloak.dump`), attachments and map packages, each with a SHA-256 in `manifest.json`.
- Rotating `MOVER_ATTESTATION_KEY` affects only new attestations. Keep the retired key in the organisation's key
  vault to re-verify evidence on historical approval documents.
- Production hardening: create a restricted runtime database role (DML on business tables, no DDL, no `TRUNCATE`)
  and run migrations with a separate owner role; keep the audit table's triggers owned by that owner.

## Authorisation decisions (OpenFGA)

- TMRKZ runs its own OpenFGA 1.8.16 (`openfga`, with `openfga-migrate` run once per start) on its own database
  `openfga` (owner `openfga`, created by `db-init`). It is not published on any port; only the backend calls it with
  the preshared key. Do not point TMRKZ at another application's OpenFGA or store.
- Mapping from TNQL's settings: `OPENFGA_API_URL` → fixed internal `http://openfga:8080`; `OPENFGA_API_TOKEN` →
  `TMRKZ_OPENFGA_API_TOKEN`; `OPENFGA_STORE_ID` → optional `TMRKZ_OPENFGA_STORE_ID` (empty: the store is created once
  and recorded in the business database); `OPENFGA_MODEL_ID` → not configured: the model id is pinned per published
  policy version.
- State: «مركز الصلاحيات ← خدمة القرار» or `GET /api/v1/access/status` (store, model, applied/latest change, pending
  changes, tuples, last success, last error). While OpenFGA is unavailable, sensitive actions are refused with
  `AUTHZ_UNAVAILABLE`; nothing falls back to allowing. Pending changes are applied within seconds and before any
  sensitive action of the person concerned.
- Repair: «إعادة بناء بيانات الصلاحيات» (global access manager) or `POST /api/v1/access/rebuild` writes every tuple from
  the database into a new store, switches to it and deletes the old store.
- Backup and restore include `openfga.dump`. A backup without it restores cleanly: the backend creates a new store and
  rebuilds the tuples from the restored grants.

## Certificate signatures and seals (DSS)

- Settings → «نمط التوقيع»: «توقيع بشهادة المعتمد وختم الجهة (PKI)». In this mode each final approval is signed by the
  approver's certificate and sealed by the approver's organisation, validated, then published by the decision.
- Provider: `TMRKZ_SIGNING_PROVIDER=PKCS12_DIRECTORY` with read-only mounts at `/etc/tmrkz/signing/keystores`
  (`person-<employee number>.p12`, `seal-<organisation code>.p12`), `/etc/tmrkz/signing/keystore-password` (secret file),
  `/etc/tmrkz/signing/trust` (CA certificates, PEM) and `/etc/tmrkz/signing/crl` (CRLs, refreshed inside the network
  before they expire). With `NONE` (default) PKI mode refuses approvals with `SIGNATURE_PROVIDER_UNAVAILABLE`.
- Status: «الإعدادات ← التكاملات ← التوقيع الرقمي بشهادة وختم الجهة» (trust anchors, CRLs, published documents).
- Keys never enter the database, logs or backups; the key stores and their password belong to the organisation's
  vault. Backups include the signed documents, the evidence and the validation reports (business database).

## HR source (read-only mirror)

- `TMRKZ_HR_SETTINGS_KEY` (in `.env`, 32+ characters, generated by `ops/init-env.sh`) encrypts the stored Oracle
  password. Back it up with the database: without it the stored settings cannot be read and must be re-entered.
  Rotating it is deliberate: re-enter the password afterwards.
- Settings → HR source: enter the host (no credentials or path), port, service name or SID, the read-only account,
  and the two view names. Save, then **Test connection**. Create the mapping draft, **Discover columns**, review it,
  then **Publish**. Publishing refuses columns the views do not report.
- The schedule runs every `TMRKZ_HR_SYNC_INTERVAL_SECONDS` (default 3600) once the source is enabled. **Refresh now**
  uses the same path; only one run can be active across instances. An empty result is never published. A drop above
  the source's threshold needs a manual run with a written reason, which is audited.
- The status panel shows the last success, data age against the source's maximum age, counts, the next run and the
  last runs. Raw source identifiers in run issues are shown only to holders of VIEW_SOURCE_IDENTIFIERS.
- Migration from TNQL: see `docs/TNQL_COMPATIBILITY.md`. Re-enter the password in TMRKZ; never copy TNQL's token or key.

## HR source: units on demand, people on demand (ADR-094)

- **Units.** «إعدادات النظام ← مصدر الموارد البشرية ← استيراد الوحدات الآن» reads the whole unit tree from Oracle into the
  local database (the only time Oracle is needed for the tree). «المزامنة التلقائية للوحدات» repeats it every N hours
  (24 by default) or stays off; the schedule is the source's own setting, not an environment variable.
- **People.** Never synced in bulk. A person is fetched from Oracle at first sign-in, when searched for, or when added by
  number («إضافة مستخدم»), and refreshed on the next need when the last answer is older than 24 hours. A run carries the
  known people forward unchanged. «تحديث الأشخاص المرتبطين في كل مزامنة» restores the earlier every-run refresh if wanted.
- **Oracle down.** Browsing, requests, approvals, stationing and maps never ask Oracle. A refresh that cannot reach it
  changes nothing. With «الدخول بالدليل يكفي» on (the default), a person the directory verifies enters with no permission
  even when Oracle does not answer, marked «بانتظار مطابقة HR», and is matched to their HR record at a later sign-in; off,
  a new account waits until Oracle confirms it (the earlier rule).
- **Scope.** A person asks for a role within their own main unit's tree only.

## Sign-in (Keycloak + enterprise directory)

- **One address.** `TMRKZ_PUBLIC_URL` in `.env` is the address people open (`sh start.sh` writes `http://IP:PORT` from the IP
  address and port it asks for; `ops/tls/enable.sh` writes `https://<name>` and `start.sh` then keeps it). Every sign-in
  address derives from it: Keycloak's hostname, the local realm's issuer, the callback `/api/v1/auth/oidc/callback` and the
  signed-out page. Nothing else names the address (ADR-092).
- **«إعدادات النظام ← إعدادات التكامل» (ADR-092), as MOVER's integration settings page.** After signing in as `admin` or
  `developer`, whoever holds CONFIGURE enters, tests and saves:
  - *the enterprise directory* of the manual form — server (the DNS name the certificate was issued for), LDAPS or
    StartTLS and the port, the sign-in domain (each person binds as `user@domain`, as MOVER; or, with no domain, a
    read-only service account that finds the entry first), the search base, the attribute names (an «Active Directory»
    preset fills MOVER's: `sAMAccountName`, `objectGUID`, `user`, `MilNumber`, `MilRankName`, `MilOccupation`,
    `MilCurrentUnitName`), the organisation's CA certificate pasted as PEM, the timeout;
  - *the Keycloak of the automatic button* — the server address the browser opens, the realm, TMRKZ's client ID and
    secret, the internal address when the back channel differs, the issuer when it is not `<server>/realms/<realm>`,
    the return address (empty: `TMRKZ_PUBLIC_URL` + callback), the CA certificate of an internal PKI.
  «اختبار الاتصال» uses the values on the screen as they are, before any save: the protected channel with the certificate
  chain and host name checked, the service bind or a person's own sign-in for the directory; the realm's discovery
  document, the issuer it states and the key set for Keycloak. Nothing typed for a test is stored. A save is in force at
  once (no restart), is audited, and the secrets are encrypted with `TMRKZ_HR_SETTINGS_KEY`, never shown again. A section
  switched off, or «العودة إلى إعدادات ملف البيئة», puts the `.env` values back in force; the screen shows those too.
  The backend reaches the directory and the enterprise Keycloak directly through the `edge` network (no relay); the
  database, Keycloak, OpenFGA and the local directory stay on the network with no route out.
- **`.env` still works** for an installation configured before the screen existed: `LDAP_URL` (`ldaps://…`, or `ldap://…`
  with `LDAP_START_TLS=true`), `LDAP_USERS_DN`, `LDAP_DIRECT_BIND_PATTERN={username}@domain` or `LDAP_BIND_DN` +
  `LDAP_BIND_CREDENTIAL`, `LDAP_USERNAME_ATTRIBUTE`, `LDAP_UUID_ATTRIBUTE`, `LDAP_USER_OBJECT_CLASS`, `LDAP_ATTR_*`,
  CA files in `ops/keycloak/truststores/`; and `TMRKZ_ENTERPRISE_OIDC_ISSUER`, `_INTERNAL_URL`, `_CLIENT_ID`,
  `_CLIENT_SECRET` for the enterprise Keycloak. The saved screen values take precedence over them.
- **Keycloak's own federation** (`LDAP_*` read by the `keycloak` service, `ops/keycloak/set-directory.sh`) matters only
  when TMRKZ's *local* Keycloak is the automatic provider. With the enterprise Keycloak entered on the screen, the
  automatic button goes there, exactly as MOVER's button does, and the local Keycloak serves the two platform accounts only.
- The administration console of the local Keycloak is not served through the web entry point. Reach it from the host only,
  for example `docker compose exec keycloak /opt/keycloak/bin/kcadm.sh …`. The bootstrap account `tmrkz-bootstrap` uses
  `TMRKZ_KEYCLOAK_ADMIN_PASSWORD`: replace it with a named administrator after the first start.
- First sign-in links a person automatically only when the directory login equals exactly one active HR domain account
  (`TMRKZ_OIDC_LINK_KEY=DOMAIN_ACCOUNT`), or, with `EMPLOYEE_NUMBER`, when the directory attribute mapped to the
  `employee_number` claim equals the HR employee number. Anything else appears under «الهيكل التنظيمي» → sign-ins
  waiting for review, where a MANAGE_ACCESS holder links or dismisses it with a reason.
- The sign-in page offers both paths, as in TNQL: automatic (Keycloak) and manual. Manual verifies the allow-listed
  platform accounts through their dedicated local Keycloak client (ADR-070) and every other login through the directory.
  Five failed manual attempts lock a login name for 15 minutes. A rejected platform password does not fall through to LDAP.
- **First administrator of an empty installation:** run `sh ops/bootstrap-admin.sh <directory-login>` on the host
  within 24 hours of that person's first sign-in. It works only while no active system administrator exists. The
  person becomes a temporary administrator for 72 hours, enough to configure the HR source and grant rights. When the
  HR mirror contains them, their next sign-in moves to the HR record and the temporary grant ends. Business rights
  otherwise come only from memberships and responsibility seats. A used registration is not reused: if the people were
  deleted afterwards, register the login again (or `update bootstrap_admin set used_at = null, expires_at = now() + interval '24 hours'`).
- **Lasting platform accounts (ADR-037):** «admin» and «developer» are local Keycloak users with the realm role
  `tmrkz-platform`, set on every start by the `keycloak-setup` service of the folder installation from
  `TMRKZ_PLATFORM_ADMIN_PASSWORD` and `TMRKZ_PLATFORM_DEVELOPER_PASSWORD` (image-built installation:
  `sh ops/platform-accounts.sh [project]`). They sign in manually through the restricted client of
  `ops/keycloak/set-platform-password-client.sh`, with local Keycloak step-up/logout, and hold every administrative
  right. HR and the directory never disable them. To revoke one, remove its role in Keycloak or drop it from
  `TMRKZ_PLATFORM_ACCOUNTS`.
- **Single local installation (ADR-091):** `sh start.sh` asks for the IP address and the port and starts `tmrkz-mover`
  from this folder (`docker-compose.override.yml`; data in `data/`; the procedure in `RUN.md`). Until a directory is
  entered, it uses a stand-in directory with no people; the platform accounts are set on every start.

### Registering TMRKZ's client in the enterprise Keycloak (ADR-071)

As MOVER: TMRKZ is a client of the organisation's Keycloak; it never imports its realm there. Ask the Keycloak team for a
**confidential authorization-code client** in the approved realm:

- exact callback `TMRKZ_PUBLIC_URL` + `/api/v1/auth/oidc/callback` and post-logout `TMRKZ_PUBLIC_URL` + `/?signed-out=1`
  (the screen shows the callback it will use);
- standard flow enabled; implicit/direct grant/service accounts disabled; client authentication by secret; PKCE S256;
  `openid profile`;
- signed ID tokens with `sub`, `iat`, `exp`, `nonce`, `auth_time`, `preferred_username` and the approved employee or
  employment claim mappings. Do **not** map `tmrkz_roles` onto the enterprise client.

Then enter the server address, realm, client ID and secret (and the CA, if internal) in «إعدادات التكامل», press
«اختبار الاتصال» (the discovery document must state the expected issuer) and save. The platform accounts' local Keycloak,
keys, callbacks and privileges are untouched: an enterprise role never becomes a TMRKZ right.

- Organisation structure comes from the HR mirror. The CSV import in «إعدادات النظام» remains for local organisations.

## Map workspace: boundaries and map packages

**Who may do what** (checked on the server): viewing the map needs VIEW, VIEW_SUMMARY or MANAGE_FACILITIES over the
site; drawing, editing and importing boundaries need MANAGE_FACILITIES over the site's responsible organisation;
uploading, activating and disabling map packages needs MANAGE_FACILITIES over the whole scope («مدير الخرائط»);
exporting boundaries (GeoJSON) needs EXPORT; request badges and counts need a full VIEW grant.

**Boundaries.** «استيراد حدود المواقع» accepts GeoJSON (`.geojson`, `.json`) and KML (`.kml`). Each shape names its site
with `site_code` (GeoJSON property, KML `ExtendedData`); a file for one site can be imported from that site's panel. The
CRS comes from the file (`crs` member; KML is WGS 84 by definition) or is chosen in the dialog: EPSG:4326/CRS84
(longitude, latitude), EPSG:3857, EPSG:32640 or EPSG:32639. `urn:ogc:def:crs:EPSG::4326` is refused because it puts
latitude first. The preview lists every shape with its linked site, type, vertices, area and current version; any
problem rejects the whole file. Publishing needs a reason and creates one new version per site. A version saved
elsewhere in the meantime aborts the publication (`GEOMETRY_STALE`). To import a Shapefile or GeoPackage, convert it on
a workstation with GDAL, naming the source CRS explicitly, for example
`ogr2ogr -f GeoJSON -s_srs EPSG:32640 -t_srs EPSG:4326 -lco RFC7946=YES sites.geojson sites.shp`, check `site_code`,
then import the GeoJSON. «تحرير سجل الموقع — الحدود» draws or edits one site: click to draw, drag vertices, or type
them in the table; «تراجع» undoes, «البدء برسم جديد» replaces, «إلغاء دون حفظ» discards everything.

**Map packages.** Built-in packages live in `map-packages/` (image). «مدير الخرائط» uploads further packages as a ZIP
with `manifest.json` and one background file at the root:

```json
{ "code": "campus-plan", "name": "مخطط المرفق", "version": "2026.11", "dataDate": "2026-11-01",
  "source": "…", "license": "…", "attributionHtml": "…", "crs": "EPSG:4326 …", "kind": "FACILITY_PLAN",
  "minZoom": 14, "maxZoom": 19, "coverage": { "minLat": 0, "minLng": 0, "maxLat": 0, "maxLng": 0 },
  "files": [ { "role": "overlay", "format": "SVG_OVERLAY", "path": "plan.svg", "sha256": "…" } ] }
```

`kind` is ROADS, AERIAL or FACILITY_PLAN; `format` is SVG_OVERLAY or RASTER_IMAGE (PNG/JPEG), optionally with a GEOJSON
`source` file. The package is checked (checksums, safe names, size and compression limits, SVG without scripts or
external references), stored on the files volume, previewed by the manager and activated or disabled with a reason.
PMTiles, MBTiles and XYZ tile sets are refused (no renderer). Uploaded packages are part of `ops/backup.sh` (files
volume). Never upload imagery without a licence; the map states when no aerial imagery is installed.

## Acceptance test environment (fictional)

`sh ops/test-env/up.sh` starts a separate compose project `tmrkz-test` with a fictional OpenLDAP (StartTLS, test CA),
a fictional HR mirror, people, grants and facilities. Users and the generated shared password are listed in
`ops/test-env/README.md`. Never point it at real data. `sh ops/test-env/up-offline.sh` restarts the same project with an
internal-only network (no internet egress; only the web entry point published) and checks that the backend cannot
reach an external address. If the fictional directory is ever rebuilt, `sh ops/test-env/relink.sh` resets the
fictional identity links (TMRKZ otherwise refuses, correctly, to link new directory accounts to linked HR records).

## Running the tests

```sh
sh ops/test-backend.sh                                        # backend acceptance tests on throw-away PostgreSQL + PostGIS and OpenFGA
sh ops/test-backend.sh AuthorizationIT,AccessAcceptanceIT     # only the classes a change affects
sh ops/test-env/up.sh && node tests/acceptance/journey.mjs     # real sign-in (Keycloak + LDAP) and the journey
sh ops/test-env/check-untrusted-tls.sh                       # directory with an untrusted certificate is refused
sh ops/test-env/clean-install.sh                             # empty database: first administrator and first configuration
sh ops/test-env/up-offline.sh && (cd tests/acceptance && npm ci) && node tests/acceptance/map-workspace.mjs
                                                              # MAP-01 … MAP-18 in Microsoft Edge, no internet egress
(cd frontend && npm ci && npm test && npm run build)          # frontend unit tests and type-checked build
node tests/acceptance/access-studio.mjs                       # permissions studio in Microsoft Edge (STUDIO-01 … 06)
node tests/acceptance/rule-editor.mjs                         # visual rule editor in Microsoft Edge (RULES-01 … 04)
node tests/acceptance/resources.mjs                           # resource relation and shared-use limit (RES-01 … 03)
node tests/acceptance/signing.mjs                             # certificate signature and seal (SIGN-01, SIGN-02)
python ops/tools/gen-openapi.py                               # regenerate docs/api/openapi.json from the controllers
```

## Migration center (ADR-094)

«الإعدادات → ترحيل البيانات → مركز ترحيل قاعدة البيانات» brings the data of an **older** TMRKZ database into the current
one; the current database is never replaced. CONFIGURE only; every step is audited (`DB_MIGRATION_PREVIEWED`,
`DB_MIGRATION_VALIDATED`, `DB_MIGRATION_RUN`, `DB_MIGRATION_ABANDONED`, `DB_MIGRATION_DUMP_UPLOADED`) with who, the source
(never its password), the detected schema version, the source fingerprint, the categories and tables chosen, the conflict
decisions, counts, start/end and result.

Flow: choose the source → schema version check → table analysis → preview by category → choose tables and decide
conflicts → validate (dependency order) → backup gate → migrate → report.

- **Sources.** A live PostgreSQL connection (read-only: the driver's read-only flag plus
  `default_transaction_read_only=on`; the role needs SELECT only), or a `pg_dump -Fc` file uploaded on the screen
  (limit `tmrkz.migration.max-upload-bytes`, 25 MB by default — the servlet multipart limit applies too) or placed in
  `data/files/migration-inbox/` (`tmrkz.migration.inbox`). A dump is checked (the `PGDMP` magic, its SHA-256) and
  restored by `pg_restore --no-owner --no-privileges` into an isolated staging database `tmrkz_staging_<id>` on the
  application's own server with the application's datasource credentials; the staging database is dropped when the
  migration finishes, fails or is abandoned. **The folder-backend image must be rebuilt** (`ops/local/workspace/pack-images.sh`
  now installs `postgresql-client-17` in its own cached layer) before the dump source works; until then the screen says
  that `pg_restore` is missing and the staging database is dropped again.
- **Refused sources:** the current database itself (same host, port, database and schema as the datasource), a source
  whose last successful Flyway version is newer than the current one, a database without `flyway_schema_history`.
- **What is compared and carried.** Only the business tables both sides share, with a single-column primary key.
  Never read or written (category «لا تُرحَّل»): Flowable (`act_*`), `flyway_schema_history`, `user_session`, `oidc_login`,
  `login_throttle`, `bootstrap_admin`, `outbox_event`, `stationing_outbox`, `idempotency_record`, `integration_setting`,
  `sign_in_board`, `hr_*` (staging and the HR source secrets), `authz_*` (the OpenFGA mirror and store state),
  `local_metadata`, `db_migration` itself. `password_hash` and any column named like a secret, token, ciphertext or
  key id are stripped even from tables that are migrated. Rows travel as text, shared columns only; a column added by a
  later migration takes its default; generated columns are skipped.
- **Conflicts (decision A).** A row with the same stable id and different content is a conflict. The current record
  wins by default; the preview lists each conflict (first 200 per table) with the differing columns, current beside
  source, and the administrator decides per record: KEEP, or TAKE_SOURCE (the current row's shared columns are updated
  from the source). Validation refuses while a chosen table with conflicts has neither its KEEP default confirmed nor
  every listed record decided. Conflicts beyond the listed 200 stay on the current record.
- **Backup gate.** The commit stays closed until `backups/<project>-<stamp>/manifest.json` (written by `ops/backup.sh`;
  `./backups` is mounted read-only at `/var/lib/mover/backups`) is newer than `tmrkz.migration.backup-max-age-hours`
  (24) and either `verify-result.txt` beside it says `PASS` (`ops/verify-backup.sh` now writes it) or the administrator
  ticks, on the record, that `sh ops/verify-backup.sh <dir>` passed.
- **Fingerprint.** Per shared table the source's row count, highest key and latest stamp are taken at the preview and
  again at the commit; a difference refuses the commit (the row ends FAILED, «fingerprintChanged») and a new preview is
  required.
- **The commit** inserts the new rows of the chosen tables in dependency order (foreign keys of the current database,
  topological; a cycle is refused; a self-referencing table inserts parents before children) and applies the
  TAKE_SOURCE updates, inside one transaction, with `on conflict do nothing` as the safety net; serial sequences are
  advanced afterwards. Any failure rolls everything back and records FAILED with the reason.
- **Limits.** Tables keyed by a serial (`audit_event`, `reservation_lock`, `terrain_slope`) collide by number with the
  current database and mostly arrive as conflicts. Attachment and map-package rows arrive without their files
  (`files.tgz`, `map-packages.tgz` of the old backup are copied by hand). After migrating memberships or grants run the
  OpenFGA rebuild (`POST /api/v1/access/rebuild`). The request runs synchronously; a very large source takes minutes.
