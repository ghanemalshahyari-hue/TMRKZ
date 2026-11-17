# Oracle-only unit replacement — source implementation and evidence, 17 Nov 2026

## Owner decision and non-negotiable boundary

The owner chose **retire and reassign access**, not a guessed name/root mapping. The implementation therefore retires unmatched units without deleting their history and supports later authorised reassignment on Oracle units. It does **not** physically delete organizations, alter person identities, prune affiliations, or fetch people from another application.

No live preview/publication has run. **The retained hierarchy, people, memberships and all other live business rows have not been changed by this implementation.** Current running backend/web artifacts remain the V44 images.

## Source artifact: validated

The source is the existing Oracle-derived Duty mirror, not an unspecified export and not a fresh live Oracle connection:

- Storage key `/var/lib/mover/unit-import/oracle-units-20261110T041708Z.json` inside the private files volume.
- SHA-256 `972d2a56b1b6cbbc1de278daee517fc2e8efbfac1678cd644cab35fb97514db0`.
- Schema `tmrkz-oracle-unit-mirror-v1`; exact six top-level and five unit-only fields; source-column mapping verified.
- **76,848 unique units, 22,516 active**, roots 1, missing parents 0, cycles 0, missing MAIN_UNIT_ID references 0, self-referencing main units 75.
- Exactly **one active Oracle child has a retired source parent**; this drove the navigation correction.
- No people fields, credentials, contact fields or nested person data.
- Source timestamp **2026-11-10T04:17:08Z**. Its separate `sourceSyncedAt` is a **decimal string**, validated and converted rather than assumed to be a JSON number.
- Read-only review found no fresher suitable unit-only mirror in the other local app snapshots. The TMRKZ live Oracle source remains disabled/unreachable and is not marked CONNECTED or successfully synchronised by this work.

## Recovery point: verified

`sh ops/backup.sh tmrkz-mover backups`, the pre-change fingerprint and `sh ops/verify-backup.sh` completed successfully before implementation:

- **Backup:** `backups/tmrkz-mover-20261117T054828Z`
- Manifest checksums and readable business/identity/OpenFGA dumps: pass.
- Clean business restore: 20 table fingerprints equals live.
- Schema after restore: V44.
- Fingerprinted restored rows: **201,963 equals live**.

The backup and current runtime are retained. A publication rollback requires restoring this pre-cutover backup into a clean project; swapping only the backend image would not undo organization publication.

## Source implementation

### Payload/provenance

- `OracleUnitPayload`: confined private `unit-import/` path (including `..` confinement), regular/no-follow-file checks, 32 MiB and 100,000-unit bounds, streaming SHA-256, strict schema/field/column-contract and timestamp checks, text statuses, canonical parent paths, duplicate/orphan/cycle/main-reference checks.
- `V47__oracle_unit_import.sql` (drafted as V45 directly after V44; renumbered V47 so it follows the committed V45 `access_grants_per_role` and V46 `system_admin_restationing_request`, neither of which touches `hr_snapshot`): additive snapshot origin/lineage; `PREVIEWED` distinct from hourly STAGING cleanup; per-preview source hash/contract/structure/effects/actor/expiry/reason; snapshot ownership and committed-payload uniqueness; separate **expected and actual** effects; carried-person-snapshot provenance.
- `V47MigrationIT`, `ops/sql/checks/V47-after.sql`: real V46→V47 lineage and constraint coverage with no assumed production unit totals (the test also runs the after-checks).

### Preview/publication

- `POST /api/v1/hr/unit-imports/preview` and `POST /api/v1/hr/unit-imports/{id}/publish`, both `CONFIGURE` protected. A publication is an idempotent replay of the same stored run, whose response reads the saved actual effects. No remote URL, actor ID, deployment action or person-import argument is accepted.
- A preview stages only Oracle unit rows, a structure fingerprint and aggregate effects; source IDs are not returned. Open business conflicts and identity/code collisions produce an INVALID preview, not a publication.
- Commit takes the HR advisory lock inside the same transaction as staging checks, snapshot promotion and organization projection. It re-reads and compares source metadata/digest, semantic JSON contract, current structure fingerprint and exact impact before writing. Staged unit fields are also compared to the current validated file.
- People, `hr_person`, `hr_snapshot_scope`, affiliation links and other historical references are carried forward unchanged. **No person projection runs.** A file snapshot is explicitly not a live Oracle success and changes no HR source success timestamp.
- `HrProjection.applyOrganizations` is the organizations-only extracted path. Ordinary `HrProjection.apply` retains LOCAL behavior. Unmatched LOCAL retirement is explicitly enabled only for this operation.
- Retirement matches the incoming Oracle snapshot, not the organization's own self-match. Incoming is handled before an absent-unit count, and the exact expected retirement count comes from the pre-publication comparison. Active LOCAL units with the exact same already-stored Unit ID retain their UUID through the existing adoption path.
- Currently valid memberships on retired units are ended with `ORACLE_UNIT_REPLACED`. This preserves history and makes `ops/bootstrap-admin.sh` see no live administrator afterward; future grants are not back-ended. Currently effective site responsibility windows close in place with history. No bulk reassignment occurs.
- Commit rejects unintended open request/re-stationing/stationing effects and mismatched create/update/retire/membership/responsibility counts. Postconditions require every ACTIVE organization to be an HR unit that resolves exactly once to an ACTIVE row in the new published snapshot.
- Expected current-tree cutover at preview is 76,848 staged Oracle organizations, retirement of 1,143 old HR + one LOCAL root, and 22,516 active Oracle units. **This is a precomputed design expectation, not an executed or reported live result; production preview/commit must still prove it.**

### Navigation and OpenAPI

- `GET /organizations/tree` defaults to ACTIVE units. `includeRetired=true` additionally requires `AUDIT` while preserving scope predicates; history/direct-reference data remains retained.
- Real Oracle parent IDs remain unchanged. An ACTIVE unit beneath a retired ancestor becomes a navigation root only when needed; it is not assigned an invented parent and a retired ancestor grants no authority.
- `ops/tools/gen-openapi.py` was corrected to parse nested annotations and `throws` signatures and to name the controller/path on unsupported signatures. Existing annotated parameters that were omitted are now documented. Generated contract: **261 operations / 239 paths** (259 / 237 on the 733b4aa base; regenerated after the merge, ADR-074), including both unit-import endpoints and `includeRetired`.

## Checks actually performed

### Passed

- Payload checks above, including exact hash/unit counts/timestamp/tree/status path and MAIN_UNIT_ID checks.
- Main backend **diagnostic type-check** against the preserved runtime dependency jars with `-source 21 -target 21 -proc:none`: pass after fixing row-map UUID and query usage. This is **not** a Java 25 compilation or deployable build.
- Disposable, internal-network-only PostgreSQL/Flyway check:
  - `MIGRATIONS_APPLIED_TO_V44=44`;
  - `MIGRATIONS_APPLIED_TO_V45=1` on the same fresh V44 database (the import migration under its draft number V45; now V47, after the committed V45/V46);
  - `snapshot_origin=1`, `nullable_snapshot_lineage=2`, `snapshot_lineage_violations=0`, `snapshot_guards=3`, `preview_status_guard=1`, `unit_import_table=1`, `unit_import_columns=21`;
  - final **`mismatches=0`**.
- The test source/business/helper files were mounted to a disposable helper (root only inside that temporary helper), PostgreSQL stayed on an internal network, no pull was attempted, and test resources were removed. Production application services remain non-root.
- `sh -n ops/test-backend.sh`, `git diff --check` on changed artifacts, OpenAPI generation and parser assertions: pass.

### Written but unexecuted test suites

- `OracleUnitImportIT`: **17 scenarios** (including parameterized malformed payloads) using real HTTP/service/projection paths, generated synthetic payloads, and a generated 20,257-unit file. Tests cover auth/field refusal, hash and staged-row changes, impact/stale gates, idempotent replay, all preservation effects, bootstrap recovery, retired-parent navigation, rollback after projection and batch publication.
- `V47MigrationIT` (drafted as `V45MigrationIT`): V46 lineage followed by only V47, the `V47-after.sql` checks, lineage-guard rejection, repeated previews, owned snapshots, in-place publication and duplicate-publication refusal.
- Neither Java/JUnit suite has been compiled or executed: the approved Java 25/Maven builder and test dependency cache are absent. Static review by the test author additionally identified and led to fixes for JSON contract comparison, source self-retirement, postcondition aliases and idempotent actual-result storage.
- The unrelated current dual-provider authentication changes in the same working tree were included in the diagnostic main-source type-check, but their separate JUnit suites are also **not run** and are not accepted here.

### Offline gate exercised

`sh ops/test-backend.sh OracleUnitImportIT,V45MigrationIT` (now `V47MigrationIT`) returned **exit 2** before creating test containers: `maven:3.9.16-eclipse-temurin-25` and the approved populated Maven cache are missing. It attempts no pull/download. The live schema remains V44.

Early disposable-helper failures were retained rather than hidden:
1. Helper mismatch: Flyway's current `MigrateResult` type required `migrationsExecuted`.
2. Nested bind mounts with read-only parents were replaced by one prepared mount.
3. The first DB connection immediately after its initial readiness probe was refused during PostGIS initialization restart; the runner now waits three seconds after readiness, as the existing test runner does.
4. The first structural-check log was empty because `docker exec` omitted `-i`; the corrected check connects and returns `mismatches=0`.

## Exact release gate / what is not done

1. Supply the approved **offline Maven/Java 25 builder image and populated Maven dependency cache**, plus any required runtime packaging inputs, through the authorised local channel. Do not use the Java 21 diagnostic source output as a release artifact.
2. Run focused import/migration/HR/identity tests, the existing affected auth suites and the complete backend suite in the now-offline test runner. Restore and rehearse the actual 14.2 MB payload on a clean backup clone; measure timing and preservation.
3. Only then build/start a verified backend offline, run the authenticated preview and compare exact effects, and perform the authorised commit. Use the limited existing bootstrap/admin-reassignment path afterward and verify OpenFGA revocation and normal administration on Oracle-scoped grants.
4. Verify the updated active trees, history views, normal sign-in and scopes in a current WebGL2-capable browser. Live-Oracle connectivity remains a separate blocked integration; this source is a dated mirror, not an hourly live refresh.

There is therefore **no current active-tree cutover or completed Oracle-import acceptance claim in this record**. Full details and source provenance/index: ADR-072, `docs/STATUS.md`, `docs/TRACEABILITY.md`, and this evidence file.
