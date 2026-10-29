# MOVER — Architecture decision record

Each decision lists the context, the choice, and — where it differs from `handoff/ARCHITECTURE.md` — why.
Status values: **Accepted** (in force), **Provisional** (in force until the named open decision is made).

## ADR-001 Stack and version pinning — Accepted

- Backend: Java 25 LTS (Temurin 25.0.1_8), Spring Boot **4.0.9**, Flowable **8.0.0**, PostgreSQL **17.11**, Flyway 11.14.
- Compatibility evidence: `flowable-dependencies-8.0.0.pom` (Maven Central) declares `spring.boot.version 4.0.2`,
  `spring.framework.version 7.0.3`, `jdk.version 17`. We stay on the same Spring Boot 4.0.x line and take the latest
  patch release (4.0.9) for security fixes; patch releases are API-compatible by Spring's policy. The whole
  acceptance suite runs against this exact combination. Flowable 7.2.0 (Spring Boot 3.5) was the alternative; it was
  not chosen because the 3.x line is at the end of its open-source support window.
- Frontend: React 19.3.1, Vite 7.3.7, TypeScript 5.9.3, Leaflet 1.9.4 (same version as the prototype).
- Images pinned by exact tag: `postgres:17.11-alpine`, `maven:3.9.16-eclipse-temurin-25` (build only),
  `eclipse-temurin:25.0.1_8-jre-alpine`, `node:24.18.1-alpine` (build only), `nginx:1.28.3-alpine`.
  `ops/airgap-bundle.sh` records the resolved image IDs in the offline bundle.

## ADR-002 Modular monolith with JDBC (no JPA) — Accepted

Modules are Java packages with service façades: `security` (identity adapter), `access` (authorisation), `org`,
`facilities`, `forms`, `workflow`, `requests`, `reservations`, `attachments`, `audit`, `outbox`, `reports`, `policy`,
`integrations`, `system`. Data access is plain SQL through Spring `JdbcClient` because the core invariants rely on
PostgreSQL features (range types, exclusion constraints, recursive CTEs, row locks) that should stay visible in the
code. Flyway owns the business schema; Flowable creates its own `ACT_*` tables in the same database.

## ADR-003 Local identity with server-side sessions — Superseded by ADR-015 (2026-10-29)

Proposed: Keycloak. Chosen: the `security` module is a local identity adapter (BCrypt passwords, account lock-out,
opaque session token in an `HttpOnly; SameSite=Strict` cookie, only its SHA-256 stored server-side, idle and absolute
expiry). Reason: the organisation's identity system and its contract are undecided (D-04); a local adapter keeps the
air-gapped deployment self-contained and lets revocation take effect immediately (no long-lived JWT). Replacing it
with OIDC/LDAP (e.g. Keycloak) changes only `AuthService`/`SessionFilter`; the rest of the system consumes `Actor`.

## ADR-004 In-process relationship authorisation instead of OpenFGA — Accepted

Proposed: OpenFGA. Chosen: `AccessService` evaluates, on every HTTP request and inside the same database, the
caller's active memberships and delegations (dated, role-based, organisation and/or site scope, summary-only flag).
Reasons: (1) the source of truth for memberships is the business database, so there is no synchronisation lag
between a membership ending and access being withdrawn — the architecture note itself warns that a reliable sync
path is required and that doubt must deny; (2) lists, searches, counters, exports and reports use one SQL predicate
built from the same grants (`AccessService.requestPredicate`), which a separate tuple store cannot provide without
duplicating data; (3) one fewer stateful service to back up and restore. The module boundary (`AccessContext`)
allows moving to OpenFGA later if relationship complexity grows.

Rules implemented: creator sees own requests; VIEW grants cover a request through its owner, participant
organisations and the organisations administering the requested facilities, or through site scope; info recipients
see a summary after approval; reviewers must hold the task's role with REVIEW (APPROVE for the final stage) and a
scope reaching the task's target organisation; a requester can never decide on their own request.
*Amended 2026-10-29 by ADR-013: the requester may decide when a grant satisfies the stage; actions are independent.*

## ADR-005 Workflow studio compiles a typed definition to BPMN; Flowable embedded — Accepted

The studio edits a typed JSON definition (stages, ALL/ANY completion, reviewer slots by role and organisation source,
typed conditions, SLA, final signed stage, execution templates). Publishing validates it, compiles it to BPMN 2.0
(`BpmnCompiler`: exclusive gateway → parallel multi-instance user task → merge per stage) and deploys it to the
embedded Flowable engine. The only expressions in generated BPMN call the fixed `moverWf` bean with stage-key
literals; administrators never write expressions, scripts or SQL (AT-33). Requests start the exact process
definition id pinned at submission, so new versions never affect running instances (AT-14). `bpmn-js` was not
adopted: a free-form BPMN editor would allow constructs and expressions the rule language forbids; the generated
BPMN is downloadable for review.

Flowable shares the application's `DataSource` and transaction manager: completing the final task, inserting the
reservation locks, the decision, the approval document, the audit row and the outbox event commit or roll back
together (proved by AT-10, AT-11, AT-27).

## ADR-006 Reservations: scope locks under exclusion constraints — Accepted (D-08 default)

A reservation inserts **X** locks on its resource and all descendants and **I** (intent) locks on all ancestors, each
over `[start, end + handover)`. Two exclusion constraints forbid X/X and X/I overlaps on the same resource; I/I is
allowed. Booking two sibling halls works; booking the parent hall over either is refused (AT-36). Periods are
half-open; equal end/start do not overlap unless a handover buffer is configured (AT-12). Open-ended (permanent)
reservations use an unbounded range, never an artificial far date. Shared-policy resources take no exclusive locks;
capacity rules for shared resources are an open item (see STATUS).

## ADR-007 Approval signing modes kept separate — Provisional (D-02)

`INTERNAL_ATTESTATION` (default): the approver re-enters their password; the server computes the SHA-256 of a
canonical approval document bound to the revision hash and stores an HMAC evidence over (mode, person, capacity,
document hash, time) using `MOVER_ATTESTATION_KEY`. The UI and API label it «توثيق داخلي — ليس توقيعاً رقمياً بشهادة».
`PKI`: provider interface with no provider connected; it fails closed with `503 SIGNATURE_PROVIDER_UNAVAILABLE` and
records nothing (AT-27).

## ADR-008 Plain PostgreSQL instead of PostGIS — Provisional (D-01, D-07)

Sites carry a point location and append-only `site_geometry_version` GeoJSON with an explicit CRS label. The map
needs only bounding-box filtering of a few thousand points, which plain columns handle. PostGIS (and a decision on
the organisation's coordinate reference, D-01) should be introduced when real boundary geometries are imported.

## ADR-009 Local map packages — Accepted

`map-packages/<name>/manifest.json` declares source, licence, attribution, coverage, CRS, version and per-file
SHA-256. On start-up the backend registers packages whose checksums verify; the UI draws only installed packages and
reports areas outside their coverage (AT-31). No tile server or CDN is contacted at run time.

## ADR-010 Transactional outbox and in-app notifications — Accepted

Business transactions write `outbox_event` rows; a worker (`OutboxProcessor`, `FOR UPDATE SKIP LOCKED`) turns them
into notifications in its own transaction with unique keys, so redelivery never duplicates effects (AT-28). Failures
back off exponentially and park as FAILED after 10 attempts. External correspondence is not connected (D-04).

## ADR-011 Jackson 2 for stored documents, Jackson 3 for HTTP — Accepted

Spring Boot 4 serialises HTTP with Jackson 3; Flowable 8 and our stored-document handling use Jackson 2.
`JacksonConfig` registers a Jackson 3 serializer that writes Jackson 2 trees as raw JSON (regression-tested).

## ADR-012 Short polling instead of SSE — Accepted

The UI refreshes counters and notifications by polling scoped endpoints. Each poll is a normal authorised request,
so withdrawn access stops updates immediately without channel re-evaluation logic.

## ADR-013 Independent actions, configuration separate from content, requester decisions — Accepted (2026-10-29)

Owner decisions in `docs/ADMIN_PRODUCTION_IMPLEMENTATION_PROMPT_AR.md` §2 and §7. The action set is
`VIEW, VIEW_SUMMARY, CREATE, EDIT, REVIEW, APPROVE, EXPORT, EXECUTE, MANAGE_FACILITIES, MANAGE_ACCESS, CONFIGURE, AUDIT,
VIEW_SOURCE_IDENTIFIERS`; none implies another.

- **CREATE vs EDIT.** CREATE composes and submits a new request (a never-submitted draft); revising a returned request
  is EDIT. Both must still cover the owner organisation at the time of the action (`AccessContext.mayModify`).
- **Configuration vs content.** The protected `SYSTEM_ADMIN` role holds `CONFIGURE, MANAGE_ACCESS, MANAGE_FACILITIES,
  VIEW_SOURCE_IDENTIFIERS` only. It no longer reads request content, exports, audits or decides; a person who needs
  those rights receives them explicitly through another membership. `MANAGE_FACILITIES` gives the facility record
  (registry, geometry, occupancy) within its scope; `MANAGE_ACCESS` administers memberships, delegations and roles
  within the organisations it covers.
- **Requester decisions.** The previous absolute separation-of-duties rule (ADR-004) is replaced: the requester is
  held to exactly the same stage rule as anyone else (role, REVIEW or APPROVE for the final stage, scope over the
  target). Stage order is unchanged. The decision row records `by_requester` and the history shows «(مقدم الطلب)».
- **Migration.** `V2__independent_actions.sql` keeps the effective behaviour of existing custom roles (CREATE → +EDIT,
  CONFIGURE → +MANAGE_ACCESS/+MANAGE_FACILITIES, summary-only VIEW → VIEW_SUMMARY) and narrows `SYSTEM_ADMIN` as decided.
- **Scope fixes delivered with this ADR.** Availability checks resolve every resource against the caller's scope
  first; an out-of-scope id and an unknown id give the same 404 (PA-12). Main sites (no parent) are drawn and listed in
  occupancy like sub-sites; ancestors outside scope are returned only as `view: CONTEXT` (code, name, parent) so the
  tree stays readable without revealing location, resources or occupant (PA-14).

ADR-004 (in-process authorisation) remains in force until OpenFGA is introduced in phase 3 of the production
programme; the action model above is the contract the OpenFGA model must reproduce.

## ADR-014 Read-only HR mirror compatible with TNQL — Accepted (2026-10-29)

Owner decision: organisations and people come from the same Oracle views as TNQL, read only, hourly. Details and the
mapping to the reference files are in `docs/TNQL_COMPATIBILITY.md`.

- **Contract.** Canonical fields are fixed in `HrMapping`; source columns come from a published, immutable mapping
  version (`hr_mapping_version`, trigger-enforced). Publishing requires every required field to be mapped to a column
  that the view metadata actually reports. Health, passport, contact, rank and similar data cannot be mapped.
- **Reading.** `HrSourceAdapter` opens one `SET TRANSACTION READ ONLY` transaction, reads metadata with
  `SELECT * ... WHERE 1 = 0` and streams `SELECT "col", ... FROM view` in batches, then rolls back. Identifiers are
  pattern checked and taken from metadata. The JDBC thin driver `ojdbc10` 19.27.0.0 was chosen for the widest server
  range (11.2-21c); the enterprise database version is still to be confirmed.
- **Snapshots.** Each run loads a STAGING snapshot (`hr_unit`, `hr_person`), validates keys, duplicates, orphans,
  cycles and ambiguous employee numbers, applies the drop protection, then in one transaction marks it PUBLISHED and
  projects it. Readers always see one complete version; earlier snapshots are kept for diagnosis (three by default).
- **Projection.** Organisations and people are matched by source id (`source`, `source_external_id`). HR fields are
  read-only outside the projection (database triggers; the API answers `HR_FIELD_READ_ONLY`). Local additions live in
  `local_metadata`, `site_responsibility`, `membership` and `position_seat`, and survive every sync. HR affiliation is
  dated and separate from grants (`affiliation`).
- **Changes of affiliation.** A transfer ends grants that `follow_affiliation` and no longer contain the new
  organisation. Leaving the service ends all grants and delegations and deletes sessions. Access is re-evaluated on
  every request, so the next action is already refused. Responsibility seats (`position_seat`) give a role to whoever
  holds an HR position in an organisation. Open tasks are role-pooled, so `TaskRealignment` records each task an
  affected person could act on and can no longer act on: it notifies the sole new holder, or routes the task to the
  organisation's access managers when nobody is left. Past decisions are never re-attributed.
- **One run at a time.** A PostgreSQL advisory lock (shared by the schedule and the manual button) plus a busy flag;
  a run that finds the lock taken is SKIPPED; a run left RUNNING after a crash is closed as INTERRUPTED.
- **Testing.** The acceptance suite runs this exact code against fictional views behind a SELECT-only login role. The
  connection to the enterprise Oracle is a separate, still-open integration step.

## ADR-015 Enterprise sign-in through Keycloak federating LDAP; no local or demo sign-in — Accepted (2026-10-29)

Supersedes ADR-003 (local identity adapter). Owner decision: Keycloak with LDAP; one production configuration.

- **Flow.** The backend runs the OpenID Connect Authorization Code flow with PKCE (S256) as a confidential client
  (`OidcClient`). Each attempt is single use, expires in ten minutes and is bound to the starting browser by an HttpOnly
  `TMRKZ_OIDC` cookie (SameSite=Lax, path limited to the callback). The ID token is verified against the provider's
  published keys, issuer, audience/azp, expiry and the attempt's nonce. The browser never holds provider tokens; TMRKZ
  issues its own opaque HttpOnly session as before, and authorisation is still evaluated from the database on every
  request, so revocation needs no token expiry.
- **Directory.** Keycloak federates the enterprise LDAP read-only (`editMode READ_ONLY`), verifies passwords there,
  uses StartTLS or LDAPS with certificate validation against the CA folder mounted as its truststore, and applies brute-
  force lockout (5 failures, increasing wait up to 15 minutes). TMRKZ stores no passwords.
- **Linking.** `identity_link (issuer, subject)` → person. First sign-in links automatically only on a stable key
  matching exactly one active HR person while the HR mirror is within its age policy: `DOMAIN_ACCOUNT` (default, as
  TNQL: the directory login equals the HR domain account) or `EMPLOYEE_NUMBER` (a directory attribute mapped to the
  `employee_number` claim). No key, no match, several matches, an inactive record, a stale mirror or a person already
  linked records an `identity_link_issue` for an access manager, who links or dismisses it with a reason. A directory
  account grants no business right by itself.
- **No fallback.** The local password form, the demo user switch, the demo flag and the demo dataset are removed from
  the production build. When the provider is not configured or does not answer, the sign-in page says so. Fictional
  directory users and data exist only in the separate test environment (`ops/test-env`, compose project `tmrkz-test`).
- **Step-up for approval.** The internal attestation requires an interactive authentication at the provider within
  `TMRKZ_REAUTH_MAX_AGE_SECONDS` (default 300). Otherwise the decision is refused with `REAUTHENTICATION_REQUIRED`,
  nothing is recorded, and the UI starts a step-up (`prompt=login`, `max_age=0`) for the same session and person.
- **Deployment.** `tmrkz/keycloak:26.7.5-1` is built from the pinned `quay.io/keycloak/keycloak:26.7.5` with the TMRKZ
  theme baked in (Arabic RTL, local font and assets). The realm (`ops/keycloak/realm/tmrkz-realm.json`) is imported on
  first start with values from the environment. Keycloak has its own database and owner in the same PostgreSQL server.
  It is reached through the web entry point under `/auth`; the admin console and the master realm are not served there.
- **One sign-in page.** Opening TMRKZ without a session goes straight to the provider's sign-in page, which holds the
  username and password, laid out like the TNQL sign-in page. TMRKZ shows its own page, in the same design, only when
  sign-in cannot start or was refused, with the reason and a way back.
