# Local offline startup and Oracle profile — 16 Nov 2026

## Scope and requested import

The requested scope was **all units and only already-linked people**, not all Oracle personnel. Duty's configured Oracle endpoint was inspected through its own settings path. Duty and MOVER were not modified.

No source-selection answer was available when the configured Duty endpoint could not be reached. The conservative result is: **Duty's credentials saved with sync disabled, no substitution of the synthetic demo, and no import claimed.**

This is a local operational record, not production-readiness evidence. No Oracle credentials, connection strings, tokens, passwords or personnel rows are included here. No architectural or business-logic change is introduced by this record.

## Runtime actually started

- Application: `http://localhost:8088` (web, backend, Keycloak and OpenFGA healthy).
- Source revision: `733b4aa4e2805749a5a2dd8d7c43406eaed323a8` on `main`.
- Backend: `mover/backend:local-733b4aa4-v44`, packaged without network access from the existing compiled classes at that revision and the existing Spring Boot dependency jars. Flyway V41–V44 is included.
- Archive: `images/mover_backend_local-733b4aa4-v44.tar`; SHA-256 `974389feaeb9489774bb29e6f45f40cbf5e9748e6799c2adbfec5c6581339e86`.
- The original supplied backend image is retained as `mover/backend:offline-v40`. The web remains the supplied `mover/web:1.0.0` image; no new frontend release was claimed.
- `ops/local/compose.offline.yml` selects the local backend image; the archive is included in the offline image loader and `images/SHA256SUMS`.
- `ops/local/offline.sh check`: `tmrkz-mover_internal` is isolated and has no route to the internet.

The local synthetic Oracle instance is healthy with its restored demo data. It is **not connected to TMRKZ as a substitute for Duty's configured source**.

## Defects found during the operational run and their disposition

1. `ops/init-env.sh` and `ops/platform-accounts.sh` had CRLF line endings, which the host `/bin/sh` rejects. Their line endings were normalised to LF; their commands were unchanged.
2. The stand-in CA bind mount stayed `0770` on the shared filesystem, so Keycloak's non-root user could not enumerate it. `ops/local/up.sh` now copies only the public CA to a user-owned local truststore and mounts that; private-key permissions were not relaxed. Keycloak became healthy. The failed diagnostics are preserved in the session output.
3. The first repackaged executable jar omitted `BOOT-INF/classes/` directory entries. It failed before Spring/Flyway with `ClassNotFoundException`, so it applied no migration. The packaging was corrected, and a separate isolated smoke check then loaded `ae.mover.MoverApplication` on Java 25 before the image was used with the business database. The final archive hash above supersedes that failed package attempt.
4. `npm test` could not start tests in this host because the copied `frontend/node_modules` has Windows Rollup packages but not `@rollup/rollup-linux-x64-gnu`. No dependency deletion or internet installation was performed. No fresh frontend test or build result is claimed; the supplied web image remains in use.

## Backup, migration and preservation evidence

Verified recovery point before the source/profile change:

`backups/tmrkz-mover-20261116T105445Z`

`sh ops/verify-backup.sh` passed:

- 7 manifest files match SHA-256;
- all three database dumps are readable archives;
- the business database restores with the identical 20-table fingerprint and schema V40.

After the executable-jar smoke check:

- Flyway validated 44 migrations in 43 ms and applied V41–V44 in 66 ms.
- 201,940 pre-migration row fingerprints from `ops/sql/upgrade-rows.sql` were compared: **0 changed/missing, 0 new matches in that restricted fingerprint set** (it does not represent every table in the database).
- The platform OIDC sign-in completed through the normal Keycloak flow; `CONFIGURE` and the normal request-protection header were required for HR changes. No roles, sessions or cookies were injected.

## Oracle configuration status and the unperformed import

The old demo sync was paused through the authorised HR administration API. Duty's read-only Oracle settings were re-entered through that API, encrypted under TMRKZ's own HR settings key (no encrypted Duty ciphertext was reused, and no repository secret was added).

Read-back confirms: source exists, password is set, settings decrypt correctly, **`enabled=false`**, scheduler not running, `lastConnectionOk=false`.

The configured `POST /hr/source/test` returned **`ok=false`, `failure=UNREACHABLE`** after 56 ms. Duty's own source attempt also returned `TNS:no listener`. Its endpoint is distinct from the supplied demo's `FREEPDB1` service.

**Blocked / not performed:** metadata validation, publishing a mapping against this source, enabling its source, and importing all units plus linked people. No new units or people were imported in this operation. The last sync failure recorded in the restored run history was for the earlier source profile, not an import from Duty.

The pre-existing **synthetic** snapshot remains unchanged at 1,143 units and 200,567 people (176,567 active); there are 10 linked people under `hr_linked_person`. This retained snapshot is not evidence of a new import or of only-linked people in that old snapshot. The pending unlinked-person cleanup was **not** run.

Before the requested import can proceed, the Duty listener/network path must be restored, and the owner must confirm the source for this restored installation. A mapping must be validated against that source's live metadata; the demo mapping must not be reused silently. Mixing source identities from a different oracle hierarchy with the retained synthetic hierarchy must not be done without an explicit migration/owner decision.

## Verification not performed here

- No claim of browser-tested UI: the in-app browser could not attach (`browser guest not attached / webview not ready`).
- No fresh frontend tests/build: missing Linux Rollup native dependency described above.
- No enterprise LDAP, remote Oracle, enterprise PKI or production readiness claim.
