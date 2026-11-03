# Stationing Model V3: production phases P0–P3, stop-gate report (3 Nov 2026)

The design reference is `docs/STATIONING_MODEL_V3_AR.md`, and all owner decisions are closed.

For this work:
- Branch `main` was used, with one worktree.
- Nothing was committed, pushed, deployed or migrated.
- Nothing was written to Oracle.
- No production behaviour was changed.

## 1. P0: ADR-028 / V17 audit

| Item | Finding (evidence) |
|---|---|
| ADR-028 code | Present in `main`, committed in `e25421f`. It covers separation of duties for execution steps: handover, receipt, acknowledgement, closing, and routing to the access managers. Its status line still reads **"Proposed; tested on a disposable database, not deployed"** (`docs/ARCHITECTURE_DECISIONS.md` ADR-028). |
| V17 file | `backend/src/main/resources/db/migration/V17__execution_purpose.sql`. It adds `execution_task.purpose` (`HANDOVER`/`RECEIPT`/`ACKNOWLEDGEMENT`/`TASK`, not null, default `TASK`, with a CHECK) and backfills it from the step key. |
| Tests supporting ADR-028 | `ExecutionIntegrityIT` (EX-1…EX-5), `ExecutionInFlightIT` (IF-1…IF-5) and `V17MigrationIT` (V16 → V17 on a probe database). **Re-run today on the disposable database: 11/11 pass.** The full backend suite passes 174/174, which includes them. |
| **Where V17 is applied** | **The acceptance test database `tmrkz-test_db-data` (fictional data) is now at V17.** Flyway history shows V16 and V17 installed at 2026-11-03 13:01:50 UTC; the backend log shows "Successfully applied 2 migrations … now at version v17". |
| **Cause** | **This working session.** At 13:00:46 UTC, `git pull --ff-only` (reflog) was followed by `sh ops/test-env/up.sh`. That rebuilt the backend image from `964edb2`, and the container was recreated at 13:01:42 UTC. STATUS and ADR-028 had warned against rebuilding the acceptance backend from this revision; I missed it. |
| Effect | V16 adds indexes only. V17 added a column to a table with **0 rows**, so no data changed. **No backup from before the change exists.** |
| Other databases | No production or owner-retained TMRKZ database exists on this machine: there are no `tmrkz-mover` volumes, and the only TMRKZ volumes are `tmrkz-test_*`. The MOVER volumes belong to a different application and were not touched. |
| Drift: files vs databases | Migration files V1–V17 match the acceptance database's history: same versions, all succeeded, and Flyway validation passed at start-up. Retained production databases: none to compare here. The documents said "V17 applied to no retained database", which was **untrue after 13:01**; ADR-028 now carries a dated amendment. |

**Safe deployment sequence for V17** (needs the owner's explicit approval; not started):
1. **Decide the acceptance database first.** Either keep it at V17, or restore V15 by rebuilding the fictional environment with `down -v` and `up` from a pre-V16 build. Both are the owner's call.
2. **Target an owner-retained database:**
   1. stop the application;
   2. take a full backup with `ops/backup.sh` (business, identity and authorisation databases, attachments, SHA-256 manifest);
   3. run `ops/verify-restore.sh` on a copy;
   4. apply V16 and V17 on a production-like copy, then run `ExecutionIntegrityIT` and `ExecutionInFlightIT` against it;
   5. deploy;
   6. check `flyway_schema_history`, `execution_task.purpose` counts and ADR-028 acceptance.
3. **Afterwards:** apply the stuck-request recovery from `docs/audit/main-risk/` only if the owner approves. It is a separate change.
4. **Gate for Stationing:** only after V17 is approved and deployed is the next free migration number chosen for Stationing V3. That number is not reserved now.

## 2. Code added (P1–P2): pure logic and read-only adapters, no schema

Package `backend/src/main/java/ae/mover/stationing/`. Nothing in it is wired into a user-visible path.

| File | What it implements (owner decision) |
|---|---|
| `StationingPolicy`, `Fact` | The V3 policy value set with validation: `max_restationing_footprint_area`, `stationing_areas_requirement`, legs, terrain classes and allowances, `terrain_class_priority`, MAX_ONLY or MIN_AND_MAX, exception, cross-branch with independence, routing levels. The non-configurable owner rules are fixed (O-04, O-05, O-07, O-08, O-10b). |
| `OrgUnit`, `OrgHierarchy`, `OrganizationHierarchy` | The **current** Oracle hierarchy over the existing projection (`organization` plus the level from the PUBLISHED `hr_unit` snapshot). Read-only. |
| `HierarchySnapshot` | The **request-submission snapshot**: requesting unit and path, local and Oracle ids. It is distinct from the current state. |
| `HierarchyDrift`, `RestationingState` | Drift detection. Requests in UNDER_REVIEW or APPROVED_NOT_ACTIVATED pause, and activation is refused on drift with «تغير الهيكل التنظيمي بعد تقديم الطلب» (O-10, O-16). |
| `RouteDerivation` | The route runs from the requesting unit up the Oracle ancestors, using the configured levels, with SELF or PARENT start and the final stage closing it (O-07, O-09). Cross-branch requirements can be satisfied by an existing stage, recorded in `satisfies`. With independence, a separate stage applies the different-human rule (O-03, O-03b). A distance-exception stage is added when required. |
| `TerrainRule` | The largest area wins; a tie goes to `terrain_class_priority`; tied classes without a priority block (O-05, O-05b). |
| `DeploymentRules` | Leg check centre to centre with the terrain allowance on the maximum only (O-04, O-06), the exception band, the deployment pair rule, and the maximum footprint. |
| `OccupancyRule` | Only stationing, approved use and reservation occupy a site; links are not an input (O-08, O-15). A vacated site is not a conflict. |
| `GeoMeasure`, `PostgisGeoMeasure` | PostGIS geodesic centroid distance (the same expression as today's CENTER measure), area and intersection. No table is read or written. |
| `StationingEvent`, `StationingEventSender` | The outbound contract `tmrkz.stationing.v1` with the required fields and an idempotent event id, and a sender with retry, back-off, FAILED after 10 attempts, failure reason, audited replay that needs permission, and no silent drop (O-01). Ledger and destination are interfaces: **no destination is connected**. |
| `StationingReadAccess` | The read-contract filter through the existing `Grant.covers` scope with VIEW. |

**Frontend (P3, inactive):** `frontend/src/lib/stationingV3.ts`.
- It holds the build-time flag `STATIONING_V3_ENABLED`, **false by default**, the owner wording, the guidance band and the simple initial area.
- It is **not wired into any route.** The real page is not changed.

**Not built in P1, deliberately:**
- A site-source adapter and a map-source abstraction: the existing `SiteService` and `MapPackageService` already serve as the adapters, and the source and external-id fields need schema.
- The UI port of the prototype: the real page needs the V3 API, and the V3 API needs the schema.

## 3. Tests

| Layer | Run | Result |
|---|---|---|
| Unit (Java) | `StationingRulesTest`: routing, cross-branch shared and independent, drift, terrain incl. ties, legs, pair rule, footprint, occupancy, event contract, sender, read scope, policy validation | **28/28** |
| Integration (Java, disposable PostgreSQL 17 + PostGIS + in-memory OpenFGA) | `StationingAdaptersIT`: hierarchy path over the HR projection, drift after a projection-only parent change, PostGIS centre distance (8.05 km), area, intersection | **2/2** |
| ADR-028 | `ExecutionIntegrityIT`, `ExecutionInFlightIT`, `V17MigrationIT` | **11/11** |
| Full backend suite | `sh ops/test-backend.sh` | **174/174** (144 before plus 30 new) |
| Frontend | `npm test` and `npm run build` | **84/84**, build OK |
| Prototype (reference) | Unit tests and the four-size browser matrix, unchanged since the O-05b closure | 101/101; 108/108 |

**Not yet tested, and required before production:**
- **Real Oracle:** the hierarchy tests use HR-shaped rows inserted in the test database. That is a fixture, **not a real Oracle read**.
- **Not built yet:** the OpenFGA relations for the new actions, the read API endpoint, and the outbox persistence.
- **Pending the page:** the real Stationing page in a browser, real touch, offline map assets, and accessibility.

## 4. Remaining blockers

1. **V17:** the owner's approval to deploy it, and a decision on the acceptance database now at V17 (section 1).
2. **Terrain classes from a DEM (a new question, not decided):**
   - Copernicus GLO-30 is an elevation surface. It has **no terrain classes.**
   - Deriving classes such as "flat / rolling / rugged" from it needs a classification method, for example slope bands with thresholds, that the owner or administrator has not defined. I have not chosen one.
   - **Owner question:** how should terrain classes be derived from the approved elevation data (method and thresholds), or which classified dataset should be used?
3. **Terrain data import:** waiting for FGIC written permission, or the owner's approval to import GLO-30.
   - Files: 28 tiles `Copernicus_DSM_COG_10_N22…N26_E051…E056_DEM.tif`, **776 MB** raw (a copy exists in MOVER; nothing copied). N25E053 and N26E052 do not exist (sea).
   - Preprocessing: mosaic, clip to the UAE, hillshade and slope with `gdaldem`, and contours. Then build the class polygons once the method in item 2 is approved, load them into PostGIS, and package the tiles.
   - Attribution: the DLR/Airbus notice, plus "produced using Copernicus WorldDEM-30" on modified data, plus the licence's no-endorsement and no-liability notices.
   - Limitation: it is a **DSM (surface)**, not bare earth.
4. **Oracle test access:** a non-production Oracle address, read-only credentials, the service name or SID, and network reachability.
5. **Map renderer and offline labels** (technical decision for an ADR; no business rule involved):
   - **Option A: MapLibre (as in MOVER).**
     - It needs local glyph PBFs for the font stacks, in 256-codepoint ranges including the Arabic blocks and presentation forms; built deterministically with a pinned tool such as `@maplibre/font-maker` or `fontnik` from Noto Sans Arabic (OFL, already in `frontend/public/fonts`).
     - It needs the RTL text plugin (`@mapbox/mapbox-gl-rtl-text`) served locally.
     - Its licence, version, and coverage of the Arabic presentation forms must be checked before adoption (not yet verified).
   - **Option B: keep Leaflet** and render PMTiles on canvas (e.g. `protomaps-leaflet`). The browser does the text shaping, so no glyphs or RTL plugin are needed; the prototype proves the canvas label path.
   - Both need new npm dependencies, which means a download, so they are not added yet.
6. **Real touch device:** the owner has to provide or nominate one.
7. **Owner manual acceptance** on the owner's own application environment.

## 5. Proposed migration structure (after V17 is deployed; number to be chosen then)

Every migration ships with:
- a forward script;
- a compatibility note;
- a backup procedure (`ops/backup.sh`);
- validation queries;
- a rollback or recovery plan;
- a test on a production-like copy.

**No reinterpretation of old records.** The V14/V15 `request_relocation` and `placement_rule` rows stay as they are, read by the current page.

| Migration | Content |
|---|---|
| S1 — sites and hierarchy | `site.source_system`, `site.external_id`, `site.source_version` (unique per source); `organization.level`, projected by `HrProjection` (G-O1) |
| S2 — links, stationing, occupancy | `site_link` (site, org, validity, source, reason, created_by); `org_stationing` (org, site, PERMANENT/TEMPORARY, state, validity, planned_end, base_id, request_id, end_reason; one current permanent per org); `site_occupancy` (approved use), with reservations read as an occupancy source |
| S3 — policy | `stationing_policy_version` (version, status, effective_from, author, reason, reference, values jsonb); submitted requests pin a version |
| S4 — requests | re-stationing request tables: requesting unit, kind and period, scope units, other-branch decisions, proposed site geometry, primary and alternative deployment geometry, exceptions, `hierarchy_snapshot`, `route_history`, pause |
| S5 — deployment and terrain | `deployment_area` (stationing context, role, geometry, validity, request); `terrain_dataset` and `terrain_zone` (class code, geometry, provenance), empty until the data is approved |
| S6 — outbound | `stationing_outbox` (event_id unique, type, payload, state, attempts, available_at, last_error, delivered_at) and `stationing_outbox_audit` |

## 6. Proposed OpenFGA and permission changes (to review against existing roles before adding)

| Need | Proposal |
|---|---|
| Create a request | **Reuse** `CREATE` in the requesting unit's scope |
| Approval seats and cross-branch authorities | **Reuse** `APPROVE` on the seat's unit (task assignment as today) |
| Policy (Studio) | **Reuse** `CONFIGURE` |
| Site links and facility responsibility | **Reuse** `MANAGE_FACILITIES` (to confirm with the owner) |
| Activation, independent of the final approver | **New** `ACTIVATE_STATIONING` (and `ACTIVATE_TEMPORARY_EXTENSION`) |
| Early return; cancellation before start | **New** `DECIDE_EARLY_RETURN` and `DECIDE_TEMPORARY_BEFORE_START_CANCELLATION` (V2 D9–D12, A4) |
| Distance exception | **New** `APPROVE_DEPLOYMENT_DISTANCE_EXCEPTION` |
| Stationing data correction | **New** `CORRECT_STATIONING`, or `MANAGE_FACILITIES` if the owner prefers |
| Outbound event replay | **New** `REPLAY_STATIONING_EVENTS`, an operator role, non-delegable |
| Read API consumers | A service-account role with **`VIEW`** in its organisation scope (no new permission) |

Each new permission is mirrored in the OpenFGA model with the same scope semantics, and tested for:
- requester scope, parent scope and cross-branch inclusion;
- independent approver identity;
- final approver versus activator;
- System Administrator and site administrator;
- read API consumers.

## 7. STOP

The stop gate is reached: no migration is created, V17 is not deployed, and nothing is committed or pushed.

Owner decisions needed to continue:
1. **V17:** approval to deploy it, and a decision on the acceptance database now at V17.
2. **Terrain classification method** for the elevation data (section 4, item 2).
3. **Terrain data:** FGIC permission, or approval to import GLO-30.
4. **Oracle:** non-production access details.
5. **Map renderer:** MapLibre with glyphs and the RTL plugin, or Leaflet canvas, as an ADR.
6. **Real touch device:** the device for acceptance testing.
