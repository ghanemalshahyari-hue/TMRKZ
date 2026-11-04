# Stationing V3 after the stop gate: continuation report (4 Nov 2026)

This report covers the owner's stop-gate decisions 1–6 of 4 November.

**Gate reached:** the Stationing V3 foundation is built and tested on disposable PostgreSQL. V18 is verified on a clean path but not applied to the acceptance database, and waits for the owner's review of §9.

**Working rules followed:**
- Branch `main`, one worktree.
- No commit, push, reset or stash.
- No Oracle write.
- The owner-retained `tmrkz-mover` database was not touched.

## 0. Repository reality vs the decisions

Three items did not match the decision text. All three were asked and answered on 4 Nov.

| Decision text | Found on this machine | Owner answer |
|---|---|---|
| "keep the current acceptance database at V17" | `tmrkz-test` was at **V16** (no `execution_task.purpose`). The accidental V17 migration in the stop-gate report happened on the clone that made commit `6186016`. | Bring it to V17 by the documented sequence. **Done** (§1.3). |
| "no production/owner-retained database exists on this machine" | A database volume of the production compose project `tmrkz-mover` exists (created 28 Oct, `postgres:17.11`, last run 29 Oct). | Treat it as retained and never touch it. **Untouched.** |
| verify `release_migration_log` | No such table in TMRKZ; it is MOVER's (`app/release/history.py`). | Mapped to Flyway's `flyway_schema_history`, which is TMRKZ's migration log. Recorded in ADR-028 and in OPERATIONS. |

**Docker incident.** The Docker Desktop VM froze twice:
- at 06:10, for about 40 minutes, with a disposable full stack plus a 450 MB raster load running;
- at 06:51, with only the full stack starting.

It is shared with MOVER, MOVER UAT and `tmrkz-test`, and has no `.wslconfig`, so its ceiling is 16 GB; it was at that ceiling. The first freeze recovered on its own. For the second, Docker Desktop was restarted with the owner's approval, and every environment came back.

Since then:
- the disposable stacks run with memory caps;
- heavy jobs run one at a time;
- the restore proof's second stack is skipped (`VERIFY_RESTORE=0`), while the backup with its manifest is still taken.

## 1. Migrations

### 1.1 V17 clean path (decision 1)

Tool: `ops/verify-migration-path.sh`, on the disposable project `tmrkz-migpath` (removed after the run).

| Step | Result |
|---|---|
| Release images | From `mover/backend:1.0.0` (V1–V16) to `mover/backend:rel-6186016` (built from commit `6186016`, V1–V17) |
| Business records before | Fictional seed plus the full journey on the old release: 42 checks pass, with handover and receipt steps |
| Schema before | Flyway history ends at 16; schema dump SHA-256 `5365639a…` |
| Plan | Exactly [17], `V17__execution_purpose.sql`, sha256 `5ca98f17…`. Any other plan is refused with nothing applied. |
| Backup | `ops/backup.sh` with its SHA-256 manifest (schema 16) |
| Migration | Flyway at release start: "Successfully applied 1 migration … now at version v17" (9 ms) |
| Migration log | `flyway_schema_history` version 17, success, checksum −1238489847 |
| Schema after | Only `execution_task.purpose` and its CHECK constraint added |
| Integrity | `upgrade-check` 133/133 earlier rows unchanged; HANDOVER ×1, RECEIPT ×1, 0 mismatches |
| ADR-028 tests | `ExecutionIntegrityIT` 5/5, `ExecutionInFlightIT` 5/5, `V17MigrationIT` 1/1 |
| Compatibility | Full journey on V17: PASS |

Evidence: `docs/evidence/migration-path/v17/`.

### 1.2 Tooling defects found and fixed

- `ops/backup.sh` wrote the schema version as a text maximum: "9" for a V16 database. It now uses the numeric maximum.
- `ops/sql/upgrade-rows.sql` did not fingerprint execution steps. It now does, using the columns that existed before V17.
- New tools:
  - `ops/verify-migration-path.sh`: clean path, refuses an unexpected plan;
  - `ops/test-env/upgrade-backend.sh`: upgrade by release image, reusing the environment's own compose files;
  - `ops/test-env/migration-gate.sh`: sourced by `up.sh` and `up-offline.sh`.

### 1.3 `tmrkz-test` brought to V17 (owner, 4 Nov)

- The plan was exactly [17].
- Backup `backups/tmrkz-test-20261104T031947Z` (git-ignored).
- 6,340 earlier rows fingerprinted and unchanged.
- V17 applied in 16 ms.
- Backfill on the real acceptance rows: HANDOVER ×169, RECEIPT ×169, ACKNOWLEDGEMENT ×1, 0 mismatches.
- Journey PASS.
- Labelled with a database comment: `ACCEPTANCE / V17 — fictional acceptance data only …`.
- This is acceptance evidence, not production migration evidence.
- Evidence: `docs/evidence/acceptance-upgrade/tmrkz-test-v17/`.

One incident: the first attempt used the online compose files, but the environment runs the offline variant. Compose stopped the backend and failed to recreate the network. No data was touched; the database stayed at V16. The backend was reattached and started, and the tool now reuses the environment's own compose files. The second attempt passed.

**Migration gate (dry check):** `up.sh` now refuses on `tmrkz-test` with "would apply migration(s) [18]" (exit 3), and proceeds only with `TMRKZ_APPLY_MIGRATIONS="18"`.

### 1.4 V18 `stationing_foundation`: the next valid number

The stop-gate proposal S1–S6 was reviewed against what the code now writes.

| Proposal | Decision | Reason |
|---|---|---|
| S3 `stationing_policy_version` | **Created** | Versioned administrator policy, pinned per request |
| S2 `org_stationing` | **Created** | Authoritative stationing; nothing existing records it |
| S2 `site_link` | **Created** | Owner concept §1.4.2 / §6, published in the feed |
| S6 `stationing_outbox` | **Created** | `outbox_event` cannot carry it: its processor marks every row as a delivered notification |
| S5 `terrain_dataset`, `terrain_slope` | **Created** (+`postgis_raster`) | Decision 3; data loaded by the tool, not by the migration |
| S6 `stationing_outbox_audit` | Dropped | Replays go to `audit_event` |
| S2 `site_occupancy` | Dropped | Approved use is already recorded as reservations, so occupancy is "stationing that stays plus active reservations" |
| S1 site source columns | Deferred | Nothing writes them until a site-system adapter exists; events carry `siteExternalId` null meanwhile |
| S1 `organization.level` | Deferred | The level is read from the published HR snapshot |
| S4 request tables, S5 `deployment_area` | Deferred to the request workflow | Their shape follows the implemented lifecycle; no table before its behaviour |

Clean V18 path (`docs/evidence/migration-path/v18/`):
1. From `rel-6186016` (V17) to `mover/backend:v18-wip-20261104` (working tree).
2. Journey on V17: 42 checks.
3. Plan exactly [18].
4. Backup (schema 17).
5. V18 applied in 283 ms.
6. 133/133 earlier rows unchanged.
7. 6 tables, 0 rows, `postgis_raster` 3.5.7, append-only trigger, overlap exclusion, V14/V15 rows unchanged, 0 mismatches.
8. Journey on V18 PASS.

## 2. Database objects (V18)

- **`stationing_policy_version`**
  - Columns: version, previous_id, policy_values jsonb, effective_from (never backdated), reason (5 characters minimum), reference, created_by, created_at.
  - An append-only trigger refuses UPDATE and DELETE.
- **`org_stationing`**
  - Columns: organisation, site, PERMANENT or TEMPORARY, base, valid_from/valid_to, planned_end, origin CORRECTION or REQUEST, request_id, reason, reference, end_reason, recorded and ended by.
  - A GiST exclusion allows at most one permanent and one temporary stationing per unit at any time.
- **`site_link`**
  - Columns: site, organisation, validity, source, reason, created and ended by, ended_reason.
  - At most one open link per site and unit.
- **`stationing_outbox`**
  - Columns: seq, event_id (unique), event_type, organization_id, payload, state PENDING/DELIVERED/FAILED, attempts, available_at, last_error, delivered_at.
- **`terrain_dataset`** and **`terrain_slope`**
  - Raster tiles of slope percent, encoded as uint16 floor(% × 100) with 65535 as no data.

## 3. OpenFGA and permissions

Three new actions; the generated OpenFGA model gains their relations. `docs/authz/model.fga` was regenerated, the diff adds lines only, and `AuthorizationIT.modelPublished` passes.

| Action | Used by | Scope |
|---|---|---|
| `CORRECT_STATIONING` | Data correction of a unit's permanent stationing | The unit's organisation scope |
| `MANAGE_SITE_LINKS` | Create and end site links | The unit's organisation scope |
| `REPLAY_STATIONING_EVENTS` | Replay a FAILED outbound event | Every organisation, from a non-delegated grant, with a reason, audited |

Reused permissions:
- `CONFIGURE` over every organisation publishes policy.
- `VIEW` reads stationing and links, scope-filtered and OpenFGA-confirmed.
- `CREATE`, `REVIEW` and `APPROVE` may read the policy and assess terrain.

The activation, extension, early-return, cancellation-before-start and distance-exception actions come with the request workflow.

## 4. API endpoints (`docs/api/openapi.json` regenerated, 11 new paths)

| Endpoint | Purpose |
|---|---|
| `GET /stationing/policy` | Version in force, scheduled versions, FAO initial classes |
| `GET /stationing/policy/versions` | History with previous and new value per changed key |
| `POST /stationing/policy/versions` | Publish (System Administrator) |
| `POST /stationing/terrain/assess` | Class shares, controlling class, tie, priority, allowance, effective ranges, all audit fields; optional pinned `policyVersion` |
| `GET /terrain/datasets` | Loaded datasets with provenance |
| `GET /stationing/current` | Read contract: current stationing in VIEW scope |
| `GET /stationing/organizations/{id}/history` | Full history (404 outside scope) |
| `POST /stationing/corrections` | Data correction (writes the event in the same transaction) |
| `GET /site-links`, `POST /site-links`, `POST /site-links/{id}/end` | Links |
| `GET /stationing/outbox`, `POST /stationing/outbox/{eventId}/replay` | Operators |

Outbound delivery:
- It is a POST of `tmrkz.stationing.v1` with `Idempotency-Key`, in sequence per unit, with back-off; events are parked as FAILED after 10 attempts or immediately on a permanent refusal.
- It is configured by `TMRKZ_STATIONING_OUTBOUND_URL` (now in `docker-compose.yml`, empty by default).
- No consumer is connected; events stay PENDING and are counted in `tmrkz_stationing_outbox_pending`.

## 5. Production UI status

- **Not wired.** The Stationing page is unchanged and no route uses the new API.
- **Ready for integration:** the MapLibre base map module (§7) and the API above.
- **Missing first:** the re-stationing request API (next gate).
- Frontend changes so far: the three permission names (`types.ts`, `labels.ts`) and `maplibre-gl` and `pmtiles` as dependencies (not in the app bundle).

## 6. Terrain processing results (decisions 2 and 3)

Full report: `TERRAIN_PIPELINE.md`.

**Source.**
- 28 Copernicus GLO-30 tiles (N22–N26, E051–E056) were reused from MOVER and match its recorded SHA-256 and size. The copies are byte-identical (813 MB), in git-ignored `map-data/`.
- Nothing was downloaded.
- N25E053 and N26E052 are open sea: every GLO-30 edge facing them is 0 m, and the matching SRTM cells peak at −11 and −9 m.

**Analysis product.**
- Slope percent on the native 1″ grid, by Horn's method with latitude-correct spacing, over a VRT mosaic so tile borders use real neighbours.
- Built in 164 s; 317 MB; SHA256SUMS sha256 `9a91d9af…2682`.
- Maximum slope 314%, so no clamping.
- A rebuild is byte-identical.
- No class is baked in: the backend classifies at query time from the policy.

**Visualization product.** `hillshade.pmtiles`, zoom 6–12, 128.7 MB, display only.

**Manifest.** `map-packages/terrain-glo30-2026.11/manifest.json`. It records:
- the source, product, each tile with its sha256, resolution, attribution, processing version and derived checksums;
- the explicit statement that GLO-30 is a **DSM, not bare earth, and not official UAE terrain**;
- that FGIC is not used.

**PostgreSQL.**
- Loader `ops/terrain/load-slope.sh`: 6,300 tiles in 96 s, 453 MB.
- `ST_Clip` counts by pixel centre: the fixture counts are exact; the all-touched mode gives 6,561.
- A different product under an existing version is refused (exit 4).
- A 2,754-cell share query runs in 167 ms.

**Business rule on real data.** `StationingFoundationIT.terrainOnRealFixture`: FLAT 2737, UNDULATING 2261, ROLLING 177, HILLY 484 and MOUNTAINOUS 741 of 6,400 cells, so FLAT governs.

**Arabic labels for the classes:**

| Class | Slope | Label |
|---|---|---|
| FLAT | 0–2% | «مستوٍ / شبه مستوٍ» |
| UNDULATING | 2–10% | «متموّج» |
| ROLLING | 10–15% | «تضاريس متدرجة» (owner's provisional UI label, §12) |
| HILLY | 15–30% | «تلال» |
| MOUNTAINOUS | 30%+ | «جبلي / شديد التضرس» |

For ROLLING, this report first proposed «متموّج بشدة». On 4 Nov the owner replaced it with the provisional UI label «تضاريس متدرجة» (§12). The labels are policy values the administrator can change; the code `ROLLING` and the thresholds stay.

## 7. Map labels (decision 5)

Full report: `MAPLIBRE_LABELS.md`; ADR-032.

**Setup.**
- `maplibre-gl` 6.15.0 and `pmtiles` 4.5.0, exact pins.
- Built-in Arabic shaping and bidi were confirmed in the installed source, so there is **no RTL plugin**.
- Fonts use `font-faces` with the packaged Noto Sans Arabic (OFL); there are no glyph PBFs and no CDN.

**Results** (`tests/acceptance/maplibre-labels.mjs`, headless Edge): **20 PASS, 0 FAIL, 0 external requests.**
- Arabic, English, mixed text, route numbers, punctuation and numerals all score r = 0.87–0.99 against the browser's own rendering.
- Broken inputs are rejected (r ≤ 0.28).
- No label collisions at z16; zoom 8→17→9 without errors.
- Street and terrain modes work, and switching keeps the overlays, the selection and the camera.

**Finding G-8a.** On `<html dir="rtl">`, brackets and «» were mirrored twice. The document-direction workaround was not applied. Following the owner's decision, the fix is local to the map module (§12).

## 8. Oracle status (decision 4)

- No real Oracle access and no credentials; nothing was requested or stored, and no Oracle write.
- Development uses the HR-shaped fixture and the HR projection (`StationingAdaptersIT`, `StationingRulesTest` hierarchy fixtures).
- **Real non-production Oracle acceptance remains a release gate.** It covers: stable unit id, parent, multi-level ancestry, missing parent, reparenting, inactive unit, snapshot, drift and route rebuild.

## 9. Plan: applying V18 to the acceptance database (for owner review; not executed)

1. `EXPECT_PENDING="18" AFTER_SQL=ops/sql/checks/V18-after.sql sh ops/test-env/upgrade-backend.sh <V18 release image> tmrkz-test-v18`.
   - The image is built from the reviewed revision, not `v18-wip`.
   - The step plans exactly [18], takes a backup, fingerprints before, swaps the backend image only (the environment keeps its offline compose files), then checks the history, fingerprints after, the V18 checks and health.
2. Optionally load the terrain package into `tmrkz-test` with `CONFIRM_TARGET=tmrkz-test sh ops/terrain/load-slope.sh tmrkz-test 2026.11`.
   - It adds about 453 MB to the acceptance database.
   - The owner may prefer to load it only in a dedicated acceptance run.
3. Publish a first policy version in the acceptance environment. It needs the administrator's allowance values: none are assumed.
4. Rollback: `ops/restore.sh <backup>` into a clean project with the V17 release image.

## 10. Tests by layer

| Layer | Run | Result |
|---|---|---|
| Backend unit | `StationingRulesTest` | 32/32 (4 new for slope bands) |
| Backend on PostgreSQL + PostGIS + OpenFGA | `StationingFoundationIT` 7, `StationingAdaptersIT` 2, `AuthorizationIT` 10, `ExecutionIntegrityIT` 5, `ExecutionInFlightIT` 5, `V17MigrationIT` 1 | 62/62 (focused) |
| Backend full suite | `sh ops/test-backend.sh` | **185/185** (174 before + 11 new) |
| Migration paths | `verify-migration-path.sh` V17 and V18 | PASS / PASS |
| Acceptance DB upgrade | `upgrade-backend.sh` V17 + journey | PASS |
| Terrain pipeline | `python -m pytest ops/terrain`; `verify-postgis.sh` | 12/12; 3/3 checks |
| Frontend | `npm test`; `npm run build` | 90/90; OK |
| Map labels (browser) | `maplibre-labels.mjs` | 20/20, 0 external requests |
| Browser, production Stationing page | — | Not applicable yet (page not integrated) |

## 11. Unresolved technical blockers and open items

1. **Owner review of §9** before V18 reaches the acceptance database.
2. **Request workflow (next gate).** S4 request tables, deployment areas, submission with pinned policy, hierarchy snapshot and terrain audit, stages with the existing seats and separation of duties, activation, temporary lifecycle and drift pause; then the production page on MapLibre.
3. **G-8a.** Resolved locally on 4 Nov, with no global direction change (§12).
4. **Copernicus licence text.** Checked against the official licence on 4 Nov and recorded word for word (§12).
5. **Docker VM capacity.** It is shared and has a 16 GB ceiling. Full stacks next to MOVER and MOVER UAT need memory caps or a larger `.wslconfig`; that is a host decision.
6. **Release gates, by owner decision:** real non-production Oracle, a real touch device, and FGIC only if licensed later (as a separately versioned dataset change).

## 12. Owner next-gate decisions (4 Nov 2026) and what changed

**V18 on the acceptance database: held.** The owner and reviewer have seen only a summary of §9, so V18 stays unapplied to `tmrkz-test` until §9 itself has been reviewed. Section 9 above is unchanged, word for word, for that review. `up.sh` keeps refusing [18]. The V18 file and its disposable-path evidence stay as built.

**Decisions that narrow §9 if it is approved:**
- V18 is schema only. The terrain load is not part of V18 (§9 step 2); it is a separate, explicit operation afterwards.
- No first production terrain or deployment policy is published (§9 step 3). Allowances remain owner and administrator configuration.

**Terrain load** (`TERRAIN_PIPELINE.md` §5–6):
- **Checks before commit:** the loader checks rows, all cells and the cells with a value against the manifest's build counts. A failed load exits 1 with nothing kept, so it can simply be run again.
- **Re-run:** the same product again re-checks the loaded data; a damaged load exits 5.
- **Removal:** the new `ops/terrain/unload-slope.sh` removes a dataset in one transaction that proves the business tables unchanged. It is refused while the policy in force or a scheduled one names the dataset.
- **Retained project:** both tools refuse `tmrkz-mover`.
- **Tested:** on a disposable PostGIS with a two-tile real subset, 12 steps. Evidence: `docs/evidence/terrain-load/loader-checks-2026-11-04.txt`.

**Copernicus GLO-30:**
- Approved as the current source.
- The licence was checked against the official PDF (COP-DEM-GLO-30-F, dated 29 Oct 2020, sha256 `9cd37d37…51bd`).
- The manifest and `LICENSE-NOTICE.txt` now carry Article 6 word for word: 6(a) for raw tiles, 6(b) "produced using Copernicus WorldDEM-30 …" for the slope, classification and hillshade, the 6(c) no-liability sentence and 6(d) no endorsement.
- Also recorded: the product id, the 28 source tile ids with their original sha256, the processing version, the derived checksums and per-file cell counts, and the licence reference and date.
- The map's terrain attribution is now the 6(b) text exactly.
- GLO-30 stays recorded as a DSM, not a bare-earth DTM. No FGIC data.

**Brackets (G-8a):**
- **No global direction change.** The page keeps `<html dir="rtl">`.
- **Isolated:** the defect is only in MapLibre's glyph rasteriser. The label layout is correct; each glyph's offscreen canvas inherited the page direction and mirrored brackets a second time.
- **Local fix:** `drawGlyphsLeftToRight(map)` (`frontend/src/components/map/maplibre/glyphDirection.ts`) makes this map's glyph canvases draw left to right.
- **Results:**
  - G-8a passes on the right-to-left page (r 0.932), the same score as the cross-check G-8b;
  - the control G-8c, without the fix, still reproduces the defect (r 0.648);
  - 21 PASS, 0 FAIL, 0 external requests.

**ROLLING label:** shows «تضاريس متدرجة», a presentation change only. The code `ROLLING` and the thresholds are unchanged.

**MapLibre:** 6.15.0 stays, with no RTL plugin, the packaged local font and zero external requests.

**Release gates, unchanged:** real non-production Oracle read acceptance and real touch-device acceptance. They do not block development and are mandatory before production activation.

**Tests run for these changes:**

| Layer | Run | Result |
|---|---|---|
| Backend, focused, disposable database | `StationingRulesTest`, `StationingFoundationIT` | 39/39 |
| Terrain pipeline | `python -m pytest ops/terrain` | 13/13 (1 new) |
| Terrain load and removal | disposable PostGIS, two-tile subset | 12/12 steps |
| Map module unit tests | `glyphDirection.test.ts`, `offlineStyle.test.ts` | 9/9 |
| Map labels in headless Edge | `maplibre-labels.mjs` | 21 PASS, 0 FAIL; G-8c control |
| Frontend | `npm test`; `npm run build` | 93/93 (3 new); build OK |

Nothing was committed or pushed. `tmrkz-test` remains at V17, and `tmrkz-mover` was not touched.
