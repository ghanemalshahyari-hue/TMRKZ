# MOVER — Exploratory performance measurement

**This is not a capacity acceptance.** Decision D-03 (concurrent users, request rates, file sizes) is open; these
numbers describe one run on known hardware and data so that a real target can be compared later.

## Setup (28 October 2026)

| Item | Value |
|---|---|
| Host | Windows 11 workstation, Docker Desktop 4.77 (Linux VM), 32 vCPU, 15.5 GB RAM available to Docker |
| Stack | compose project `tmrkz-mover-perf`: postgres 17.11, backend (Spring Boot 4.0.9, Flowable 8.0.0, JDK 21, default JVM flags), nginx 1.28 |
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
