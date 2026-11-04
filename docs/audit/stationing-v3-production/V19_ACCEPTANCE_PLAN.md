# V19 on the acceptance database: the plan for owner review (not executed)

Prepared 4 Nov 2026. **Nothing in this plan has been applied to `tmrkz-test`.** It follows the V18 process as approved:
release image from a local commit, verified backup, exact plan, proven invariants, recovery only on failure.

## 1. What V19 is

`backend/src/main/resources/db/migration/V19__restationing_request.sql`, sha256 `dfb474245396a5be6c2e647b337768790b6307052f59d63210ad114c8dac4ddf`
(ADR-033).

| Object | Content | Starts |
|---|---|---|
| `restationing_request` | the 11 states of Model V3 §3, content, pinned policy version, route number and path, hierarchy snapshot, returned/paused records, final approver, activation | empty |
| `restationing_stage` | the stages of every route generation, the conditions each satisfies, the facts each rests on, the decision with any delegation | empty |
| `restationing_revision` | one row per submission: content, changed facts, decisions invalidated or carried, checks and terrain audit | empty |
| `deployment_area` | the deployment areas of activated requests | empty |
| sequence `restationing_request_no` | request numbers `RS-<year>-<nnnn>` | — |
| `org_stationing_request_fk` | the foreign key `org_stationing.request_id → restationing_request` (V18 left it open) | — |

V19 changes no existing row. It loads no data and publishes no policy. The owner's decision O-17 (the distance
exception, option B) changes no schema.

**Clean path:** `docs/evidence/migration-path/v19/`, run on the disposable project `tmrkz-migpath`, from
`mover/backend:rel-4f7ea08` (V18) to the working-tree image. Results: see §8.

## 2. Prerequisites that need the owner's approval

**P1. Local commits (no push).** Two commits on `main`, in this order:
- **C1 — V18 acceptance evidence.** `docs/evidence/acceptance-upgrade/tmrkz-test-v18/` and the documentation written
  after commit `4f7ea08` about the V18 application (CONTINUATION_REPORT §13, STATUS, TRACEABILITY, ADR-031 amendment).
- **C2 — the re-stationing workflow (V19).**
  - The V19 migration and `ops/sql/checks/V19-after.sql`.
  - The backend workflow: `RestationingContent`, `RestationingChecks`, `RestationingService`, `RestationingController`,
    `RestationingScheduler`, and `HrSnapshotPublished` with its one-line publication in `HrSyncService`.
  - The three permissions and their labels, the regenerated `docs/authz/model.fga`, and the regenerated OpenAPI.
  - The page behind `VITE_STATIONING_V3`: `RestationingPage`, `RestationingEditor`, the CSS, the lazy route, and the
    API client and types.
  - `frontend/vite.dev.config.mjs`, the development-server-only map-data middleware.
  - The development environment, `ops/test-env/dev-v3.sh` and `dev-v3-seed.sql`, with illustrative values labelled as
    development only.
  - Tests: `RestationingWorkflowIT`, `tests/acceptance/restationing-journey.mjs`.
  - ADR-033, O-17 in the model document, STATUS, TRACEABILITY.

  **Left uncommitted, as before:** the Stationing V2 prototype A8 work and the enterprise-audit folders.

**P2. Release image from C2.** Built from `git archive <C2>` (backend/pom.xml, backend/src, backend/Dockerfile,
map-packages), tagged `mover/backend:rel-<C2 short sha>`. Recorded: commit SHA, tag, image id, V19 checksum inside the
image (must equal §1), build time, and the uncommitted files outside the archive.

## 3. Application (the equivalent of V18 §9 step 1)

```sh
EXPECT_PENDING="19" AFTER_SQL=ops/sql/checks/V19-after.sql sh ops/test-env/upgrade-backend.sh mover/backend:rel-<C2> tmrkz-test-v19
```

The tool, in order; any refusal or failure before the image swap leaves the database untouched:
1. Target identity: the database comment must start with `ACCEPTANCE` (today `ACCEPTANCE / V18 …`).
2. Records the schema version (must be 18), the schema fingerprint and the Flyway history.
3. Plan: the migrations in the image minus those applied must be exactly `[19]`, otherwise it refuses.
4. Backup with manifest (`ops/backup.sh`), then `ops/upgrade-check.sh before`. Every earlier row is fingerprinted:
   6,432 at V18, plus any added since.
5. **Backup verification** (`ops/verify-backup.sh`): checksums, readable dumps, and a restore into a throw-away PostGIS
   whose counts, schema version and rows equal the live fingerprint. If it fails: stop, nothing applied.
6. Swaps the backend image only, keeping the environment's own compose files; Flyway applies V19 on start.
7. Flyway history, schema after, `upgrade-check after`, `V19-after.sql` (must print `mismatches=0`), health.

**Immediately before step 1**, recorded as for V18:
- health;
- a journey run on V18;
- the comparison of the current rows with the V18 after-state.

## 4. Checks after the application (every one must pass)

1. `flyway_schema_history` records 19 as successful.
2. The V19 schema change on `tmrkz-test` is identical to the clean path's, ignoring pg_dump's random `\restrict` key.
3. `V19-after.sql`: 4 tables, 0 rows, the sequence, the foreign key, `mismatches=0`.
4. `upgrade-check`: every earlier row present and unchanged. The V18 Stationing tables still hold 0 rows.
5. The acceptance journey passes.
6. Backend health is UP.
7. The authorisation model OpenFGA holds equals the regenerated `docs/authz/model.fga`: 7 types and 357 relations
   (306 at V18, plus 17 for each of the three new actions).
8. No outbound delivery, no Oracle access, no terrain rows, no policy version, no re-stationing request created.
9. The web image is unchanged, so the page stays hidden (see D3).

If all pass, the database comment becomes `ACCEPTANCE / V19 …`. If any fails: no further phase, evidence kept, and the
recovery decision in §6.

## 5. Explicitly not part of this change

- No terrain load (still a separate operation).
- No policy publication. Without a policy, a submission on `tmrkz-test` is refused with «لا توجد سياسة تمركز نافذة».
- No development values in `tmrkz-test`: no levels, seats, starting stationing or boundaries from `dev-v3-seed.sql`.
- No new role grants.
- No change to `tmrkz-mover`, MOVER or any other project.

## 6. Recovery (only on failure, unusable database, or the owner's order)

`ops/restore.sh backups/tmrkz-test-<timestamp>` into a clean project with the V18 image `mover/backend:rel-4f7ea08`,
after keeping the failure evidence. Then prove: Flyway at 18, the data fingerprint equals the backup, the V18 journey
passes. A successful V19 is never rolled back.

## 7. Decisions for the owner

| # | Decision | Recommendation |
|---|---|---|
| D1 | Approve local commits C1 and C2 as listed in §2, no push | Yes: the release image must come from a commit |
| D2 | Approve applying V19 to `tmrkz-test` by §3–§5 | Yes, after D1 |
| D3 | The page on `tmrkz-test`: keep it hidden (web image unchanged), or rebuild the web image with `VITE_STATIONING_V3=true` for acceptance viewing | Keep hidden until D4: without D4 it cannot submit anything |
| D4 | Acceptance data for exercising the workflow on `tmrkz-test`: HR levels on the fictional units (today none), approver seats and the three new permissions for fictional users, a starting stationing per unit, site boundaries, the terrain load, and a published policy with the administrator's allowance values | Decide separately. Each item is acceptance data or administrator configuration that this plan does not assume |

Until D4, V19 on `tmrkz-test` is schema only. The workflow can be seen working on the development environment
`tmrkz-v3dev` (fictional development values), not on the acceptance database.

## 8. Clean-path results (disposable `tmrkz-migpath`)

| Step | Result |
|---|---|
| Images | from `mover/backend:rel-4f7ea08` (V18, `sha256:d63e22aa…5ba0e`) to the working-tree image `mover/backend:v3-dev` (`sha256:82684eec…7ad7`) |
| Business records before | Fictional seed plus the full journey on V18: 42 passing lines, `Journey PASSED` |
| Schema before | Flyway 18 «stationing foundation»; schema sha256 `01de62d5…41f4` |
| Plan | Exactly `[19]`, `V19__restationing_request.sql` sha256 `dfb47424…4ddf` |
| Backup | `backups/tmrkz-migpath-20261104T064038Z`, manifest schema 18 |
| Migration | "Successfully applied 1 migration … now at version v19" in 34 ms |
| Earlier rows | `upgrade-check` PASS: all 133 present and unchanged |
| `V19-after.sql` | tables=4 rows=0 sequence=1 request_fk=1 v18_rows=0 mismatches=0 |
| Journey after | PASS on V19 |

The release image of P2 will be built from commit C2, not from this working-tree image. The V19 file it carries must
have the same sha256.
