# MOVER — Delivery status, limits and open decisions

Date: 29 October 2026 · Version 1.0.0

## Delivered

- **Phase 1 – foundation:** project structure, containers, PostgreSQL schema and migrations, local sign-in with
  server-side sessions, people and dated memberships, organisations and sites (independent trees), Arabic RTL UI,
  local attachment storage, fictional demo data, health checks.
- **Phase 2 – complete booking journey:** request from map or list, versioned forms, review/return/reject, sequential
  and parallel (ALL/ANY) stages, signed (internally attested) approval, atomic conflict-free reservation, info copies,
  execution/handover/receipt tasks, closure, audit trail. AT-01…AT-12 pass.
- **Phase 3 – enterprise configuration:** workflow studio (typed definition → BPMN on Flowable, simulation of impact,
  pinned versions), form studio, change-impact policy on resubmission (D-06 conservative default), delegation and
  membership transfer, roles/permissions matrix with scopes and summary-only views, export rights, organisation
  structure import with preview, extension/modification/cancellation/evacuation, parent/child scope locking.
- **Phase 4 – operational readiness (initial):** offline bundle script, licence/component register, backup, restore
  and automated restore verification, local Prometheus metrics, exploratory load measurement, operations guide.
- **Maintenance update (29 Oct 2026):** backend runtime/toolchain uplifted to Java 25 LTS (Temurin 25) in Maven build,
  runtime image, and backend test runner image.

- **Administrative production programme (from 29 Oct 2026, `docs/ADMIN_PRODUCTION_IMPLEMENTATION_PROMPT_AR.md`):**
  - Step 1 done — independent actions (EDIT separate from CREATE; access, facility and configuration administration
    separate from content), requester decisions under the same stage rule, availability checks confined to scope,
    main sites on the map and occupancy (ADR-013, PA-10/12/13/14).
  - Step 2a done — read-only HR mirror with the TNQL contract (ADR-014, `docs/TNQL_COMPATIBILITY.md`): versioned
    column mapping validated against view metadata, hourly single-run sync with staging, drop protection and atomic
    publish, stable projection with read-only HR fields and local additions, dated affiliations, responsibility seats,
    grant ending and task realignment on transfer or departure, administration panel (PA-01…PA-06, PA-09).
    The connection to the enterprise Oracle is not made: it needs the address, a read-only account and the approved
    mapping.
  - Step 2b done — enterprise sign-in only (ADR-015): Keycloak 26.7.5 federating LDAP read-only over StartTLS with
    certificate validation, OIDC Authorization Code + PKCE with browser-bound single-use state, identity linking on
    the HR domain account with a review list for anything ambiguous, step-up before approval, and the TMRKZ sign-in
    theme. The local password form, the demo switch and the demo data are gone from the production build; fictional
    users and data live in the separate test environment `ops/test-env` (PA-07, PA-08).
  - Steps 3–7 open — OpenFGA and the permissions studio, PostGIS boundaries and the map manager, visual rule editor,
    DSS signatures and seals, isolated bundle with UI and load acceptance. See the PA matrix in `TRACEABILITY.md`.

Test evidence: 46 backend acceptance tests, a 29-check end-to-end journey through nginx, a restore verification, and
17 frontend tests — see `TRACEABILITY.md`.

## Known limitations

| Area | Limitation | Planned handling |
|---|---|---|
| Studio UI | Rule conditions (`visibleWhen`, `requiredWhen`, stage `condition`, `affectsStages`) are validated and enforced by the server but edited through the API; the studio shows that a condition exists. | Add a structured rule editor. |
| Shared resources | Resources with policy `SHARED` take no exclusive locks; capacity accounting is not implemented. | Define capacity rules, then add a capacity check in the same transaction. |
| Geometry | Points only, plain PostgreSQL; no boundary polygons or spatial index (ADR-008). | Introduce PostGIS with the CRS decision (D-01). |
| Audit | Append-only at database level; no cryptographic hash chain. Database superusers can still alter data. | Optional sealing job and separation of the DB owner from the application role in production. |
| Database roles | The application connects as the schema owner. | Production: separate migration owner and a restricted runtime role (documented in OPERATIONS). |
| Malware scanning | Built-in checks (type sniffing, EICAR, macros, active PDF content); no AV engine. | Connect an internal scanner (e.g. ClamAV) behind `ContentInspector`. |
| Notifications | In-app only. | Correspondence connector after D-04. |
| SLA timers | Overdue review tasks are detected every minute and notified; no automatic escalation/reassignment. | Add escalation rules to the workflow definition. |
| Org tree UI | The tree endpoint returns the whole visible tree (7,000 nodes ≈ 1.5 MB, ~0.1 s); the UI renders it fully. | Switch the tree to lazy loading via `/organizations/{id}/children` for very large structures. |
| High availability | Single instance per service in compose; no HA or failover tested. | Out of scope until D-03/D-05 targets are set. |

## Integrations not connected (never simulated as connected)

| Connector | Status | Note |
|---|---|---|
| Enterprise identity (Keycloak + LDAP) | Tested with the fictional directory of the test environment | Production needs the enterprise LDAP URL, a read-only bind account, the users' DN and the CA (ADR-015). |
| Organisation structure | FILE_IMPORT | Validated import with preview; automatic sync waits for D-04. |
| HR source (organisations and people) | NOT_CONNECTED until a sync succeeds | Read-only Oracle mirror implemented and tested on fictional views (ADR-014); enterprise address, account and mapping pending. |
| Correspondence | NOT_CONNECTED | No external message is sent or claimed. |
| PKI signature provider | NOT_CONNECTED | PKI mode fails closed (`SIGNATURE_PROVIDER_UNAVAILABLE`). |
| Malware scanner | BUILT_IN only | See limitations. |

## Open decisions (from the handoff) and how the build handles them

| ID | Decision | Current handling |
|---|---|---|
| D-01 | Coordinate reference / format | Generic import with explicit CRS label; demo uses EPSG:4326 points; nothing inferred from wording. |
| D-02 | Internal attestation vs PKI | Internal attestation in force and labelled as such; PKI mode wired to fail closed. |
| D-03 | Concurrency, rates, file sizes | Exploratory measurement only (`PERFORMANCE.md`); attachment limit 10 MB by policy. |
| D-04 | Identity, structure, correspondence systems | Local adapter + file import; other connectors NOT_CONNECTED. |
| D-05 | RPO/RTO, retention, SLAs | Backup/restore tooling and a measured restore; no time objective promised. |
| D-06 | Invalidation of approvals on field changes | Per-field policy (descriptive / restart named stages / full re-approval); structural changes always full. |
| D-07 | Aerial imagery sources | Only the installed illustrative basemap; no imagery fabricated or fetched. |
| D-08 | Parent resource booking | Explicit resources with hierarchical scope locks (parent blocks children, siblings independent). |
| D-09 | Execution/receipt stages and owners | Configurable execution templates per workflow; demo defaults declared in the workflow definition. |

## Readiness statement

The system passes its automated acceptance suite and a measured restore, but **operational readiness for production
is not claimed**: it still needs the open decisions above, a production hardening review (TLS termination,
database roles, secrets management, host egress controls), capacity targets (D-03) and a load test against them.
