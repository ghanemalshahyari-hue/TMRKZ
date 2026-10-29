# MOVER — Exploratory performance measurement

**This is not a capacity acceptance.** Decision D-03 (concurrent users, request rates, file sizes) is open; these
numbers describe one run on known hardware and data so that a real target can be compared later.

## Setup (28 October 2026)

| Item | Value |
|---|---|
| Host | Windows 11 workstation, Docker Desktop 4.77 (Linux VM), 32 vCPU, 15.5 GB RAM available to Docker |
| Stack | compose project `tmrkz-mover-perf`: postgres 17.11, backend (Spring Boot 4.0.9, Flowable 8.0.0, JDK 21 at measurement time, default JVM flags), nginx 1.28 |
| Data | demo dataset + `ops/load/synthetic.sql`: **7,005 organisations, 200,071 people, 200,073 dated memberships** (DB 115 MB); loaded in 21 s |
| Load | `ops/load/load-test.mjs`: 50 concurrent signed-in users for 60 s through nginx; each loops over 6 read endpoints and every 5th loop creates and submits a request (writes go through Flowable) |

## Results — 50 concurrent users, 60 s

| Endpoint | Requests | P50 ms | P95 ms | Max ms | Errors |
|---|---:|---:|---:|---:|---:|
| GET /requests | 13,982 | 65 | 167 | 287 | 0 |
| GET /map/features | 13,982 | 21 | 55 | 172 | 0 |
| GET /sites | 13,982 | 14 | 38 | 116 | 0 |
| GET /tasks | 13,982 | 9 | 29 | 97 | 0 |
| GET /availability/grid (7 days) | 13,982 | 38 | 87 | 184 | 0 |
| GET /me | 13,982 | 14 | 42 | 115 | 0 |
| POST /requests | 2,776 | 51 | 118 | 204 | 0 |
| POST /requests/{id}/submit | 2,776 | 40 | 74 | 205 | 0 |

Total 89,445 requests, **1,487 req/s, error rate 0.00 %**. Resident memory after the run: backend 531 MiB,
PostgreSQL 342 MiB, nginx 33 MiB.

## Single-call timings at volume (admin, warm)

| Call | Size | Time |
|---|---:|---:|
| Sign-in (BCrypt cost 12) | – | 0.21 s |
| GET /organizations/tree (7,005 nodes) | 1.5 MB | 0.10 s |
| GET /people?q=… (search across 200,071) | 1.7 KB | 0.15 s |
| GET /people?size=200&page=500 | 30 KB | 0.17 s |
| GET /requests?size=200&status=SUBMITTED (2,776 in review) | 123 KB | 0.01 s |
| GET /reports/kpis (full range) | 3 KB | 0.01 s |

## Observations

- Request list latency grows with the number of submitted requests visible to the caller; the scope predicate and
  indexes keep it under 0.2 s P95 at ~2,800 open requests per scope.
- The full organisation tree is acceptable at 7,000 nodes but should move to lazy loading for larger structures.
- Sign-in cost is dominated by BCrypt by design.
- Not measured: attachment upload throughput, concurrent final approvals at scale (correctness is proven by AT-10),
  long-running soak, failover. Re-run with the agreed D-03 profile on the target hardware.

## Map layers at a declared site volume (29 October 2026)

Separate from the organisation tree volume above: `backend/src/test/java/ae/mover/MapScaleIT.java` loads **10,000 sites**
in a 1° × 1° area, each with a registered 12-vertex polygon boundary and one exclusive resource, plus **2,000 active
reservations** with their scope locks, then calls `GET /map/features` for one day as a user who sees every site
(ALL scope). Same workstation, PostgreSQL 17.11 + PostGIS 3.5.7 in Docker, warm cache, 5 calls per viewport after a
warm-up; times measured by the test's HTTP client in the same JVM (no nginx). `sh ops/test-backend.sh`.

| Viewport | Sites returned | Boundaries sent | Response | Median | Max |
|---|---:|---:|---:|---:|---:|
| City, 0.1° × 0.1° | 100 | 100 | 103 KB | 17 ms | 19 ms |
| District, 0.3° × 0.3° | 900 | 900 | 927 KB | 40 ms | 51 ms |
| Region, 0.5° × 0.5° | 2,500 | 0 (markers only, > 1,500) | 1.7 MB | 57 ms | 64 ms |
| Whole area, 1° × 1° | 5,000 (capped) | 0 | 3.4 MB | 144 ms | 151 ms |

Loading the 10,000 sites, boundaries and reservations took 1.6 s. The viewport query uses both spatial indexes
(`site_marker_idx`, `site_geometry_geom_idx`; asserted from the plan). Above 1,500 sites in one viewport the response
carries markers only and a message asking to zoom in; above 5,000 the list is capped. These are single-user timings,
not a capacity statement; the concurrent load test (PA-28/29) has not been repeated with map data.

