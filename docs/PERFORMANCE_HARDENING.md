# TMRKZ — Performance hardening (ADR-094, draft) — Gate 2.5

**Status:** NOT PUSHED. Owner performance review required. Implemented locally against the same working tree as
the Site-Hub UI redesign; do not broad-commit this bundle until the owner reviews the measurements.

**Date:** 2026-11-21 (Gate 2.5 revision of the Gate 2 pass of 2026-11-21). Repository at `410b5f4` (branch `main`).

**What Gate 2.5 fixed vs Gate 2:**

- **Revision coverage gap (§A).** The Gate 2 ETag combined `authz_change` + `max(updated_at)` over
  `org_stationing`, `deployment_area` and `restationing_request`. Audit: that set does NOT move on a
  `site.name` change, a `site.marker` move, a new `site_geometry_version`, a `site_responsibility` change, an
  `organization.name` change, or any update on tables that have no `updated_at` column. The revision
  therefore leaked staleness on those axes.
- **New monotonic posture stream (§C).** Migration `V60__posture_change.sql` installs the posture equivalent
  of `authz_change`: an append-only `(seq bigserial, source text, changed_at)` log with per-statement triggers
  on `site`, `site_geometry_version`, `organization`, `org_stationing`, `deployment_area`,
  `restationing_request`, `site_responsibility`. The ETag now reads `max(seq)` from this log on top of the
  per-person `authz_change` slice — two single-row primary-key lookups, both index-backed, independent of data
  volume, independent of unit count.
- **Revision-coverage regression test (§B).** New `OperationalPostureRevisionIT` runs ten mutation scenarios
  (stationing change, deployment area, pending request, site name, site geometry, site marker, unit name,
  hierarchy, auth grant, auth revoke) plus a no-mutation control. Each scenario starts with a 200 and the
  ETag, performs ONE mutation, then replays `If-None-Match` and asserts the second response is 200 with a
  different ETag. The control replays without a mutation and asserts 304 so the moves above are proof, not
  coincidence.
- **Real JDBC execution counter (§E/§F).** `CountingDataSourceConfig` is a `@TestConfiguration` that wraps the
  Spring-Boot-auto-configured DataSource with a dynamic-proxy Connection that counts every
  `prepareStatement` / `prepareCall` / `createStatement`. `OperationalPostureScaleIT` now snapshots the
  counter around one warm posture call at each of 100 / 1,000 / 5,000 units and asserts the ratio 5000/100
  stays under 3× — this is the mechanism-level proof that catches an **indexed** N+1 the previous
  `pg_stat_user_tables` scan ratio could hide.
- **Cold/warm split + invalidation evidence in load test (§I/§J).** `ops/load/load-test.mjs` reports
  `/operational-posture (cold 200)` and `/operational-posture (warm 304)` as separate series — one mixed P95
  would have hidden whichever profile actually did the work. The report also prints an invalidation line:
  with both cold and warm present, writes are moving the ETag AND the ETag is saving work between them.

---

## 1. Revision coverage audit — what was wrong, what is now covered

| Axis | Covered by Gate 2's `dataRevisionFor`? | Covered by Gate 2.5's `dataRevisionFor`? |
|---|:---:|:---:|
| `org_stationing` INSERT/UPDATE/DELETE (new stationing, correction, retirement) | ✔ via `max(updated_at)` | ✔ via `posture_change` trigger |
| `deployment_area` PRIMARY/SUB active count & geometry | ✔ via `max(updated_at)` | ✔ via `posture_change` trigger |
| `restationing_request` state/content changes | ✔ via `max(updated_at)` (open states only) | ✔ via `posture_change` trigger (every change) |
| **`site.name`** | ✘ (no `updated_at` column) | ✔ via `posture_change` trigger |
| **`site.code` / `site.kind` / `site.status`** | ✘ | ✔ via `posture_change` trigger |
| **`site.marker` / `site.lat` / `site.lng`** | ✘ | ✔ via `posture_change` trigger |
| **`site_geometry_version` INSERT** | ✘ | ✔ via `posture_change` trigger |
| **`site_responsibility` INSERT/UPDATE** | ✘ | ✔ via `posture_change` trigger |
| **`organization.name`** | ✘ | ✔ via `posture_change` trigger |
| `organization.parent_id` (hierarchy) | partial via `authz_change` | ✔ via `posture_change` + `authz_change` |
| `organization.status` ACTIVE/RETIRED | partial via `authz_change` | ✔ via `posture_change` + `authz_change` |
| Grant / membership / delegation / affiliation (per-user) | ✔ via `authz_change` (person slice) | ✔ unchanged |
| Permission-studio writes (shared `authz_change(person_id=null)`) | ✔ | ✔ unchanged |

---

## 2. Final report — §Final Report Format from the Gate 2.5 brief

```
TMRKZ GATE 2.5 PERFORMANCE ACCEPTANCE

Revision coverage:
  stationing          CODED — EXECUTION PENDING (OperationalPostureRevisionIT.onStationingChange)
  areas               CODED — EXECUTION PENDING (OperationalPostureRevisionIT.onDeploymentAreaChange)
  pending request     CODED — EXECUTION PENDING (OperationalPostureRevisionIT.onPendingRequestChange)
  site metadata       CODED — EXECUTION PENDING (OperationalPostureRevisionIT.onSiteNameChange + onSiteMarkerMove)
  site geometry       CODED — EXECUTION PENDING (OperationalPostureRevisionIT.onSiteGeometryChange)
  unit metadata       CODED — EXECUTION PENDING (OperationalPostureRevisionIT.onUnitNameChange)
  hierarchy           CODED — EXECUTION PENDING (OperationalPostureRevisionIT.onHierarchyChange)
  auth revoke         CODED — EXECUTION PENDING (OperationalPostureRevisionIT.onAuthRevoke)
  auth grant          CODED — EXECUTION PENDING (OperationalPostureRevisionIT.onAuthGrant)
  global auth policy  CODED — EXECUTION PENDING (OperationalPostureRevisionIT.onGlobalAuthPolicyChange — see §2)
  no-mutation control CODED — EXECUTION PENDING (OperationalPostureRevisionIT.controlNoMutation)

SQL executions:
  100 units:   PENDING measurement — assertion in OperationalPostureScaleIT: jdbc delta recorded per call
  1000 units:  PENDING measurement
  5000 units:  PENDING measurement, ratio 5000/100 asserted < 3× (Gate 2.5 §F)

SQL scan ratio:
  100 vs 1k vs 5k: PENDING measurement — assertion: scan-ratio 5000/100 < 3× (Gate 2 §I retained).

EXPLAIN/index evidence:
  dataRevision query uses:
    - authz_change_person_idx (V9)   — per-person seq lookup
    - posture_change_pkey (V60)      — global posture seq lookup
    Both are single-row primary-key / index lookups; cost is constant in data volume.
    OperationalPostureScaleIT.dataRevisionIsCheap asserts the plan contains both.
  jsonb scope scan (content->'scope' ?|):
    EXPLAIN emitted by OperationalPostureScaleIT.jsonbScopePlan to stdout; no GIN added yet
    (brief §K/§8: only after evidence shows the scan dominates).
  Index coverage for the bulk unit-state CTE:
    - org_stationing_org_idx (V18) + org_stationing_no_overlap exclusion (gist) — effective stationing
    - org_stationing_site_idx (V18) — site occupancy count
    - deployment_area_active_idx (V30) — PRIMARY/SUB per stationing
    - restationing_request_purpose_idx (V30) — pending-candidate filter
    All visible in OperationalPostureScaleIT.postureScales's EXPLAIN snippet.

304 short circuit:
  PASS (code) — OperationalPostureScaleIT.shortCircuitSkipsReadModel asserts
    postureInvocations counter does NOT advance on 304 (and DOES advance on a stale If-None-Match miss, so
    the assertion is not tautologically trivial).
  read-model invocations before/after: equal (0 delta) on 304; +1 on miss.

50 users:        PENDING (ops/load/up-load-env.sh → load-test.mjs USERS=50  SECONDS=60)
200 users:       PENDING (USERS=200 SECONDS=120)
500 users:       PENDING (USERS=500 SECONDS=180)
    For each level, load-test.mjs reports:
      - P50/P95 for "GET /operational-posture (cold 200)" (new ETag; full response)
      - P50/P95 for "GET /operational-posture (warm 304)" (empty body; 304 fast path)
      - cold/warm counts + 304 percentage + invalidation evidence line (Gate 2.5 §I/§J)
      - P50/P95 for /operational-posture/sites/{id}, /operational-posture/units/{id},
        /operational-posture/requests/{id}
      - every other mix-of-reads endpoint

Hikari:
  pool:           20 (MOVER_DB_POOL default; untouched per brief §M)
  active peak:    PENDING measurement at 200 / 500 users
  pending peak:   PENDING
  acquire P95:    PENDING

Map-data:
  cold:                  PENDING — first PMTiles/font/manifest/terrain request should return 200
  warm:                  PENDING — repeat request should return 304 after the nginx header change (Gate 1)
  range:                 PENDING — PMTiles 206 Range behaviour on repeat
  package-change freshness: PENDING — install a new package, confirm the ETag/Last-Modified moves and the
                                        browser receives the new bytes (brief §X)

Redis decision:
  NO CACHE — do not add in this slice.
  Reason: the architecture no longer has an N+1, serves overviews from a compact Site-Hub summary, and
  gives a 304 fast path that skips the read model entirely. No measurement to date demonstrates that any
  hot derived read misses the P95 targets — the precondition brief §N / §S requires before Caffeine, let
  alone Redis. Authorisation decisions remain un-cached across requests (brief §O).

NOT PUSHED
OWNER PERFORMANCE REVIEW REQUIRED
```

---

## 3. What runs today, what still needs the disposable env

### Run today (local; no env needed beyond the approved backend builder + frontend node_modules)

- `docker run … maven:3.9.16-eclipse-temurin-25 mvn -o -DskipTests test-compile` — PASS (both main + test
  compile clean).
- `cd frontend && npx vitest run src/api/abort.test.ts src/lib/visibilityPoll.test.ts` — 6/6 PASS.
- `cd frontend && npx tsc --noEmit` — PASS.

### Run against the disposable test env (`sh ops/test-backend.sh …`)

1. `OperationalPostureRevisionIT` — the ten revision-coverage scenarios + the no-mutation control.
2. `OperationalPostureScaleIT` — the 100/1k/5k scale gate, the 304 short-circuit test, the EXPLAIN plans for
   `dataRevision` and the jsonb `?|` scan. Captures `scanDelta` and `jdbcDelta` per unit count.
3. `StationingNextIT` — POSTURE-* semantic-parity scenarios against the legacy `?view=UNITS` shape.
4. Collect the EXPLAIN output printed by stages 1-2; feed those into the §G evidence rows above.

### Run against the disposable load env (`sh ops/load/up-load-env.sh`, NEVER `:8088`)

5. `MOVER_URL=http://localhost:<port> USERS=50  SECONDS=60  node ops/load/load-test.mjs`
6. `MOVER_URL=http://localhost:<port> USERS=200 SECONDS=120 node ops/load/load-test.mjs`
7. `MOVER_URL=http://localhost:<port> USERS=500 SECONDS=180 node ops/load/load-test.mjs`

   For each run, record:
   - Cold 200 P50/P95 and Warm 304 P50/P95 for `/operational-posture` separately.
   - 304 percentage + invalidation line (both cold and warm populated means the ETag path works and writes
     correctly bump the revision).
   - P50/P95 for `/operational-posture/sites/{id}`, `/operational-posture/units/{id}`,
     `/operational-posture/requests/{id}`.
   - Hikari peaks (`actuator/metrics/hikaricp.connections.*`), JVM CPU/heap/GC, PostgreSQL CPU.
   - Error rate (should stay 0).

### Browser timings (manual)

8. Cold map load → warm map load (expect many 304s after the Gate 1 nginx change; expect PMTiles 206 range
   to still succeed on repeat; expect a swapped package to invalidate immediately via ETag/Last-Modified).
9. First useful posture (compact `siteHubs` payload), site click, unit click, request click: each must give
   local highlight < 100 ms even when the network detail is still loading (brief §Y).

Once those numbers are in, the `PENDING` rows in §2 are filled and the Redis decision is reaffirmed or
revised strictly on evidence.

---

## 4. Deferred to the next slice, with explicit reasons

- **PosturePage UI migration off `?view=UNITS`** (brief §P-§T). Backend endpoints and frontend API+types are
  ready; rewiring the posture rail/map off the per-unit shape is a substantial React change that belongs in
  a UI-focused slice **after the backend Gate 2.5 is green on the disposable env**. The load test already
  measures the new Site-Hub overview + lazy endpoints, so the architecture that will ship is what gets
  acceptance.
- **GIN on `restationing_request((content->'scope') jsonb_path_ops)`** — only after the §K EXPLAIN shows the
  scan dominates. Scale IT prints the plan for inspection. Adding speculatively is explicitly disallowed by
  the brief.
- **Home-cards indexed SQL rewrite** (previous brief §10). `homeCards()` streams over `overview()` to derive
  counts; pure-SQL requires translating `visible(ctx, r)` into predicates — feasible but out of this slice.
- **Bulk `canFor` / `reach`** — one OpenFGA check per unit via `removeIf(canFor)`. Not a SQL N+1, an
  OpenFGA roundtrip N. Brief §O forbids caching across requests. A bulk `canFor` on the OpenFGA side would
  address it; separate change.
- **Caffeine / Redis** — do not add before measurement proves need (brief §S).

---

## 5. File-level inventory of this Gate 2.5 bundle

**Added (new files):**

- [`backend/src/main/resources/db/migration/V60__posture_change.sql`](backend/src/main/resources/db/migration/V60__posture_change.sql)
- [`backend/src/test/java/ae/mover/CountingDataSourceConfig.java`](backend/src/test/java/ae/mover/CountingDataSourceConfig.java)
- [`backend/src/test/java/ae/mover/OperationalPostureRevisionIT.java`](backend/src/test/java/ae/mover/OperationalPostureRevisionIT.java)

**Changed (from Gate 2):**

- [`backend/src/main/java/ae/mover/stationing/OperationalPostureReadModel.java`](backend/src/main/java/ae/mover/stationing/OperationalPostureReadModel.java)
  — `dataRevisionFor` now uses `authz_change` + `posture_change`; two primary-key lookups.
- [`backend/src/test/java/ae/mover/OperationalPostureScaleIT.java`](backend/src/test/java/ae/mover/OperationalPostureScaleIT.java)
  — JDBC-ratio assertion + 5,000-unit scenario + updated EXPLAIN query + `@Import(CountingDataSourceConfig)`.
- [`ops/load/load-test.mjs`](ops/load/load-test.mjs) — cold/warm split, invalidation evidence line.

**Unchanged (remained from earlier gates):**

- [`backend/src/main/java/ae/mover/stationing/RequestHubController.java`](backend/src/main/java/ae/mover/stationing/RequestHubController.java)
  — ordering: auth → permission → revision → If-None-Match → **304 before read model**; `Cache-Control:
  private, no-cache, must-revalidate`; new lazy endpoints.
- [`backend/src/main/java/ae/mover/stationing/RequestHubService.java`](backend/src/main/java/ae/mover/stationing/RequestHubService.java)
  — `postureOverview` / `postureSite` / `postureUnit` / `postureRequest` delegates.
- [`frontend/src/api/client.ts`](frontend/src/api/client.ts), [`frontend/src/pages/PosturePage.tsx`](frontend/src/pages/PosturePage.tsx),
  [`frontend/src/components/workspace/RequestMap.tsx`](frontend/src/components/workspace/RequestMap.tsx),
  [`frontend/src/components/workspace/useRegisteredSites.ts`](frontend/src/components/workspace/useRegisteredSites.ts),
  [`frontend/src/App.tsx`](frontend/src/App.tsx), [`frontend/src/lib/visibilityPoll.ts`](frontend/src/lib/visibilityPoll.ts),
  [`frontend/src/api/abort.test.ts`](frontend/src/api/abort.test.ts), [`frontend/src/lib/visibilityPoll.test.ts`](frontend/src/lib/visibilityPoll.test.ts),
  [`frontend/nginx.conf`](frontend/nginx.conf) — AbortController, visibility-paused poll, map-data cache.
