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

## Sign-in (Keycloak + enterprise directory)

- Fill in `.env`: `LDAP_URL` (`ldaps://…`, or `ldap://…` with `LDAP_START_TLS=true`), `LDAP_BIND_DN` and
  `LDAP_BIND_CREDENTIAL` (a read-only service account), `LDAP_USERS_DN`, and optionally `LDAP_USERNAME_ATTRIBUTE`
  (default `uid`; `sAMAccountName` for Active Directory with `LDAP_VENDOR=ad`, `LDAP_UUID_ATTRIBUTE=objectGUID`,
  `LDAP_USER_OBJECT_CLASSES=person, organizationalPerson, user`). Put the organisation's CA certificates (PEM) in
  `ops/keycloak/truststores/`. Certificate validation is never disabled.
- `TMRKZ_PUBLIC_URL` is the address users open (behind the organisation's TLS proxy in production, then set
  `MOVER_SECURE_COOKIE=true`). The realm is created from these values on the first start only; later changes are made
  in the Keycloak administration console.
- The administration console is not served through the web entry point. Reach it from the host only, for example
  `docker compose exec keycloak /opt/keycloak/bin/kcadm.sh …`, or a temporary SSH tunnel to `keycloak:8080/auth/admin/`.
  The bootstrap account `tmrkz-bootstrap` uses `TMRKZ_KEYCLOAK_ADMIN_PASSWORD`: replace it with a named administrator
  after the first start.
- First sign-in links a person automatically only when the directory login equals exactly one active HR domain account
  (`TMRKZ_OIDC_LINK_KEY=DOMAIN_ACCOUNT`), or, with `EMPLOYEE_NUMBER`, when the directory attribute mapped to the
  `employee_number` claim equals the HR employee number. Anything else appears under «الهيكل التنظيمي» → sign-ins
  waiting for review, where a MANAGE_ACCESS holder links or dismisses it with a reason.
- The sign-in page offers both paths, as in TNQL: automatic (Keycloak) and manual (username and password checked by the
  directory; the backend uses the same `LDAP_*` settings and CA folder). Five failed manual attempts lock a login name
  for 15 minutes.
- **First administrator of an empty installation:** run `sh ops/bootstrap-admin.sh <directory-login>` on the host
  within 24 hours of that person's first sign-in. It works only while no active system administrator exists. The
  person becomes a temporary administrator for 72 hours, enough to configure the HR source and grant rights. When the
  HR mirror contains them, their next sign-in moves to the HR record and the temporary grant ends. Business rights
  otherwise come only from memberships and responsibility seats.
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
python ops/tools/gen-openapi.py                               # regenerate docs/api/openapi.json from the controllers
```
