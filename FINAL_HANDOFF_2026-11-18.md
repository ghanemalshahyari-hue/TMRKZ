# TMRKZ — FINAL HANDOFF (release TMRKZ 2026.11.20.1, written 20 Nov 2026)

The file keeps the name the closure brief asked for (`FINAL_HANDOFF_2026-11-18.md`); the release it describes was closed on
20 November 2026. One source of truth: GitHub `ghanemalshahyari-hue/TMRKZ`, branch `main`. The local development folder, the
VM folder and the transfer package are all copies of that `main`; a folder that differs from it is brought back to it, never
the other way round (section «Source of truth» below).

## Release identity

| | |
|---|---|
| Release | **TMRKZ 2026.11.20.1** (the map packages use the same `year.month.n` scheme: `tmrkz-map-2026.11.2`) |
| Source (the release commit) | `<<RELEASE_SHA>>` |
| Final `main` (adds only this record) | `<<FINAL_SHA>>` |
| Schema (Flyway) | **V54** (`V54__integration_settings.sql`; V52, V53 from phases 7–8) |
| Architecture of the transfer images | **linux/amd64** (the Ubuntu server); the development Mac runs the same source on linux/arm64 |
| Images in the transfer file | `tmrkz/folder-backend:1`, `tmrkz/folder-web:1`, `postgis/postgis:17-3.5-alpine`, `tmrkz/keycloak:26.7.5-2`, `openfga/openfga:v1.8.16`, `osixia/openldap:1.5.0`, `nginx:1.28.3-alpine`, `nginx:1.27-alpine` |
| Image file | `tmrkz-images-2026.11.20.1-linux-amd64.tar` — SHA-256 `<<IMAGES_SHA256>>` |
| Folder package | `TMRKZ-2026.11.20.1-folder.zip` — SHA-256 `<<ZIP_SHA256>>` |
| Built | `<<BUILT_AT>>` on the development Mac (Docker Desktop, `DOCKER_DEFAULT_PLATFORM=linux/amd64`) |
| Map package expected on the server | `tmrkz-map-2026.11.2` with `terrain-3d` (content SHA-256 `5fde671f…`, archive `21e1558c…`, ADR-047) — **not** in this package |

The deployment method is the folder installation (ADR-091, `RUN.md`): `docker-compose.yml` + `docker-compose.override.yml`
read together, the images loaded once from the image file, the backend and the web built from the folder's source inside their
containers. There is no separate `tmrkz:<version>` application image: the application is the folder's source plus the two
builder images in the image file. This is the project's one deployment architecture; the release record `RELEASE-2026.11.20.1.json`
inside the package names the source SHA, the schema, the image tags and the build time.

## What changed since the owner's last push (85ee93d)

- **ADR-092 — «إعدادات التكامل».** The enterprise directory and the enterprise Keycloak are entered on the screen
  («إعدادات النظام ← إعدادات التكامل»), as MOVER's integration-settings page: MOVER's fields, «اختبار الاتصال» with the
  values on the screen, secrets encrypted and never shown, in force at once and ahead of `.env`, «العودة إلى إعدادات ملف
  البيئة». The relay, its placeholder host name (what the VM's sign-in failed on), `extra_hosts`, the `TMRKZ_MANUAL_LDAP_*`
  keys and `ops/keycloak/configure-manual-direct.py` are gone; the backend reaches the directory and Keycloak directly, as
  MOVER does. `TMRKZ_PUBLIC_URL` is the one address every sign-in address derives from; `start.sh` writes it and keeps an
  https value.
- **ADR-093 — one map-first editor.** Every normal re-stationing task (new, from a site, saved draft, returned request,
  temporary move, deployment-areas draft) opens the map-first editor; existing requests open read-only; the old editor
  remains only for the legacy «طلب اعتماد موقع». A deep link opened while an editor was up now leaves the editor (defect found
  and fixed by the new browser check).
- Release tooling: `ops/release/pack-release.sh`, `ops/acceptance-main/standin-ldap-accounts.sh`, the browser checks
  `tests/acceptance/editor-unification.mjs`, `tests/acceptance/partial-approval-roundtrip.mjs`,
  `tests/acceptance/integration-settings.mjs`; `docs/deployment/ENV_UBUNTU_2026-11-18.md`; this file.

## Final test counts

| Suite | Result |
|---|---|
| Backend, full suite, real PostgreSQL + PostGIS + OpenFGA (`sh ops/test-backend.sh`) | **366 / 366**, run twice in full (`AuthorizationIT` 10/10 and `RestationingHrSyncIT` 2/2 inside the full order both times; the earlier «order-dependent» note is withdrawn — no leaked state reproduced in two complete ordered runs) |
| Frontend (`npm test`) | **363 / 363**; `tsc` clean; `npm run build` clean |
| Browser on :8088 (Chrome on the Mac, the same scripts run with Edge on the PC) | editor unification 18/18 · partial approval and policy excess 17/17 · responsive layout 16/16 (1280×720 … 3840×2160) · stationing hub 6/6 · re-stationing phase 4 16/16 (`SAVE=0`) · deployment areas phase 3 25/25 · site setup phase 2 19/19 (drawn on free ground south of the fixtures; `STATIONED_UNIT` names a unit still stationed) · site card 22/22 (`OTHER_UNIT` names the unit whose site the other person sets up) · parts screen (phase 7–8) 11/11 on a freshly sent request · integration settings 10/10 |

Evidence: `docs/evidence/editor-unification/`, `docs/evidence/partial-approval/`, `docs/evidence/integration-settings/`,
`docs/evidence/responsive-layout/`, `docs/evidence/stationing-redesign/`, `docs/evidence/site-card-review/`.

**Not run (they need a second environment, which the one-application rule forbids):** `stationing-next.mjs`,
`persona-buttons.mjs`, `access-requests.mjs`, `scope-approvals.mjs`, `restationing-journey.mjs` (they want `tmrkz-test` /
`tmrkz-next` on :8096). Their :8088 equivalents on an acceptance batch (`access-scope-8088.mjs`, `main-8088-extra.mjs`) were
not rerun in this closure; the hierarchy skips, unit-operations and final stages, separation of duties and activation refusal
are covered by `partial-approval-roundtrip.mjs` (PA-01, PA-10, PA-11) and by the backend suite (`RestationingWorkflowIT`,
`SeparationOfDutiesIT`, `AuthorizationIT`, `StationingNextIT`).

## Source of truth and reconciliation (the owner's priority of 20 Nov)

- `main` at `<<FINAL_SHA>>` is the application. The local Mac folder is a checkout of it (plus git-ignored `data/`, `.env`,
  `tmrkz-images.tar`, `ops/*/.generated`). The VM folder was a copy of `85ee93d` with hand edits: the OIDC issuer and the return
  address in `docker-compose.override.yml`, relay keys in `.env`, an AD certificate chain under `ops/keycloak/truststores/`, an
  `https-certs/` folder, a `db.db` / `TMRKZ-database-backup.backup` file. **None of those edits is needed any more.** On the VM:
  unzip this release over a fresh folder, keep only `data/` and `.env` from the old one (remove the `TMRKZ_MANUAL_LDAP_*`,
  `COMPOSE_PROFILES=enterprise-ldap` and relay lines from `.env`), start, and enter the directory and Keycloak on the screen.
  A `git diff` of the old folder against `main` shows nothing else that is newer only on the VM: the owner's VM handoff listed
  configuration edits and data, no source change.
- MOVER (`ghanemalshahyari-hue/mover`, `main` at `c9a1998e`, 20 Nov 2026) is the reference for LDAP and Keycloak behaviour; the
  local MOVER checkout equals it (its `ldap_service.py`, `oidc.py`, `integration_settings.py` are identical to `origin/main`).
  Parity: direct bind as `user@domain` to the host named in its certificate, LDAPS or StartTLS, a CA file (here pasted as PEM),
  host-name verification never switchable off, a confidential authorization-code client of the enterprise Keycloak with
  server/realm/client/secret/internal address/issuer/return address/CA, «اختبار الاتصال» (secured channel + optional bind; the
  discovery document and its issuer), secrets never rendered back. **Deliberate difference:** MOVER writes `.env` and needs a
  restart; TMRKZ saves on the server and applies at once (the folder installation's backend cannot rewrite the host's `.env`,
  and compose would have to be re-run), and still reads `.env` when nothing is saved. The screen shows the `.env` values.
- The `db.db` on the VM (516,251 bytes, the same size as `TMRKZ-database-backup.backup`) is in all likelihood a PostgreSQL
  `pg_dump` custom-format file, not SQLite; `RUN.md` §6 restores a PostgreSQL folder or Docker volume, and `ops/restore.sh` a
  `ops/backup.sh` bundle. No converter was built (the closure brief forbids new features); check the file's first bytes:
  `PGDMP` = pg_dump custom format, `SQLite format 3` = SQLite.

## WHAT TO COPY TO UBUNTU

### REQUIRED

- `release/TMRKZ-2026.11.20.1-folder.zip` — the folder: source (`backend/`, `frontend/`), `docker-compose.yml`,
  `docker-compose.override.yml`, `start.sh`, `ops/` (scripts, Keycloak realm and themes, migration tools), `map-packages/`
  (the package register: manifests only), `docs/`, `RUN.md`, `README.md`, `FINAL_HANDOFF_2026-11-18.md`.
- `release/tmrkz-images-2026.11.20.1-linux-amd64.tar` — the eight images (about 1 GB).
- `release/RELEASE-2026.11.20.1.json` and `release/SHA256SUMS`.

### ALREADY ON SERVER / DO NOT COPY AGAIN

- The map package `tmrkz-map-2026.11.2` (`map-runtime/current`, with `terrain-3d`): **Maps are not required to be recopied if
  the destination already has the verified installed map package.** The same holds for the terrain, which is part of it.
- The persisted database `data/db`, the uploads `data/files`, the stand-in directory `data/ldap-*`.
- The server's `.env` (secrets, platform passwords, port): kept; `start.sh` adds what a newer version needs.

### NEVER COPY FROM THE DEV PC

- `.git`, `frontend/node_modules`, `tests/acceptance/node_modules`, `backend/target`, `frontend/dist`;
- `data/` of the development machine (its database holds the acceptance scenario), `backups/`, `.env`;
- `docs/evidence/` screenshots, `ops/local/.generated/`, `ops/acceptance-main/.generated/`, `ops/test-env/.generated/`
  (certificates, passwords, synthetic fixtures), `map-data/` (this machine's local map copy);
- the arm64 `tmrkz-images.tar` of the Mac.

The pack script (`ops/release/pack-release.sh`) leaves all of these out by construction.

## UBUNTU STEPS

```sh
# 1. backup the running installation (database, identity, authorisation, files; manifest with checksums)
cd ~/TMRKZ && sh ops/backup.sh            # → backups/tmrkz-mover-<stamp>/ ; keep it
sh ops/verify-backup.sh backups/tmrkz-mover-<stamp>
# 2. copy the release files to the server (USB), then verify them
cd ~/transfer && sha256sum -c SHA256SUMS
# 3. the new folder beside the old one; the old one stays for rollback
mkdir -p ~/TMRKZ-2026.11.20.1 && cd ~/TMRKZ-2026.11.20.1 && unzip -q ~/transfer/TMRKZ-2026.11.20.1-folder.zip
cp ~/transfer/tmrkz-images-2026.11.20.1-linux-amd64.tar ./tmrkz-images.tar
sha256sum tmrkz-images.tar > tmrkz-images.tar.sha256
# 4. the server's settings and data: .env kept (minus the relay keys), data/ moved (not copied) — stop the old folder first
(cd ~/TMRKZ && docker compose stop)
cp ~/TMRKZ/.env .env && sed -i '/^TMRKZ_MANUAL_LDAP_/d; /^COMPOSE_PROFILES=enterprise-ldap/d' .env
mv ~/TMRKZ/data ./data
ln -s ~/TMRKZ/map-runtime ./map-runtime        # or set TMRKZ_MAP_ROOT in .env to the installed map root
# 5. load the images and start (start.sh asks for the IP address and the port; Flyway upgrades the schema to V54 at the backend's start)
sh start.sh
# 6. check
docker compose ps                               # db, keycloak, openfga, backend, web-build, web, openldap healthy; db-init, openfga-migrate, keycloak-setup exited 0
curl -s http://127.0.0.1:8088/api/v1/system/health
curl -s http://127.0.0.1:8088/api/v1/auth/status  # {"configured":true,"reachable":true,"manual":true}
docker compose exec -T db psql -U mover -d mover -Atc "select max(version::int) from flyway_schema_history where success"   # 54
# 7. sign in as admin; «إعدادات النظام ← إعدادات التكامل»: the directory, «اختبار الاتصال», «حفظ»; then Keycloak the same way
# 8. smoke: the map opens offline, a request list, «طلب إعادة تمركز» opens the map-first editor
# 9. keep ~/TMRKZ (old folder) and the backup until the release is accepted
```

`.env` changes: `docs/deployment/ENV_UBUNTU_2026-11-18.md`. Nothing new to add by hand; the relay keys are removed.

## Database backup before upgrade, Flyway, health checks

- `sh ops/backup.sh` dumps the three databases (`db.dump`, `keycloak.dump`, `openfga.dump`), the files and the map packages,
  with a manifest of SHA-256 and the record fingerprint; `sh ops/verify-backup.sh <dir>` restores it into a throw-away
  database and compares.
- Flyway runs at the backend's start: V54 adds `integration_setting` (one table); V52/V53 (phases 7–8) add
  `site_setup_access` and `restationing_request.part_reviews`. Migrations are forward-only: **there is no `flyway undo`**;
  rollback is the restore of the pre-upgrade backup (below).
- Health: `GET /api/v1/system/health` (backend), `docker compose ps` (every service's own health check),
  `GET /api/v1/auth/status` (sign-in paths), `GET /healthz` on the web entry point.

## ROLLBACK

1. `cd ~/TMRKZ-2026.11.20.1 && docker compose stop`
2. If the schema was upgraded (V54) and the old version must run again: restore the pre-upgrade backup into the old folder's
   database — `cd ~/TMRKZ && sh ops/restore.sh backups/tmrkz-mover-<stamp>` (it restores all three databases and the files;
   read its header: it refuses a running stack). V52–V54 are not reversible in place.
3. If the schema was not upgraded (the backend never started): `mv ~/TMRKZ-2026.11.20.1/data ~/TMRKZ/data` is enough.
4. `cd ~/TMRKZ && docker compose up -d` — the old images are still loaded (`tmrkz/folder-backend:1` of the old file is
   replaced by the new load; keep the old `tmrkz-images.tar` to `docker load -i` it again if needed).
5. Check `docker compose ps` and `/api/v1/system/health`.

## EXTERNAL SERVER CHECKS (need the real enterprise network; not verified from the development machine)

- the real AD: the DNS name on its certificate, the CA chain to paste, the sign-in domain, the base DN, the `MilNumber` /
  `MilRankName` / `MilOccupation` / `MilCurrentUnitName` attributes and the Unit-ID attribute (ADR-068) — entered on the screen
  and proved by «اختبار الاتصال» with a real login;
- the enterprise Keycloak: a confidential client registered by the Keycloak team with the callback the screen shows; the
  discovery document's issuer; the CA if internal;
- the enterprise Oracle: address, service name, read-only account, the two views and the column mapping («مصدر الموارد
  البشرية»), JDBC thin connectivity through the server's network;
- TLS for the public name (`ops/tls/`), if https is used.

## Known test and acceptance data on the development :8088 (NOT to be migrated)

- The acceptance run `ACC-20261107-034737` (batches b2, b3, b4): fictional units, sites (`ACC-…` codes, «— اختبار قبول —
  وهمي»), personas `p01`…`p19` per batch, the acceptance stationing policy, the activated access path; the Oracle sync paused
  (`hr_source.enabled = false`); removal only when the owner says (`node ops/acceptance-main/cleanup.mjs`).
- Requests RS-2026-0001 … RS-2026-0004 (0004 activated) from the earlier phases; from this closure, on the fictional unit
  «شعبة السهل — اختبار قبول B2 — وهمي» (and «شعبة أ1», «شعبة أ4»): drafts RS-2026-0027…0031, 0033, 0034, the deployment-areas
  requests RS-2026-0028 (draft), 0032 (under review), the round-trip requests RS-2026-0035 and 0040 (approved, not activated), 0036, 0039, 0041, 0044 (under review), 0037 and 0042 (returned: the oversized ones), 0038 and 0043 (drafts with an invalid site that could not be sent); two sites «موقع قبول — وهمي» drawn south of the fixtures by the site-setup suite.
- Synthetic sign-in accounts in the stand-in directory of this Mac (`data/ldap-*`, never in the package): `juma.ghfly4`,
  `majed.mhyry2`, `rashed.kndy2` (HR_AI synthetic people; `ops/acceptance-main/standin-ldap-accounts.sh`), the batch personas.
  `fahad.ktby4` does not exist here (it lived in MOVER's dev directory, which is not on this machine); nothing of MOVER's
  directory was touched. The grants given for the runs stay on the fictional units only.
- The integration settings saved on this Mac's :8088 point at the stand-in directory (`openldap`): local only, in `data/db`.

Production on Ubuntu keeps its own `data/`; this database is not imported.

## Clean-repository check before the push

Scanned the changed and untracked set for passwords, `.env`, Oracle/LDAP/Keycloak secrets, private keys, internal production
hosts, real employee numbers, real people in screenshots, database dumps and large binaries: none in the commit. The real
hosts, IP and person named in the owner's VM handoff were kept out of the repository on purpose (the settings are entered on the
screen). `release/` (the transfer package, about 1.1 GB) is git-ignored and documented here with its checksums.
