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

## ADR-004 In-process relationship authorisation instead of OpenFGA — Amended by ADR-018 (2026-10-29)

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

## ADR-006 Reservations: scope locks under exclusion constraints — Accepted (D-08 default); amended by ADR-019

A reservation inserts **X** locks on its resource and all descendants and **I** (intent) locks on all ancestors, each
over `[start, end + handover)`. Two exclusion constraints forbid X/X and X/I overlaps on the same resource; I/I is
allowed. Booking two sibling halls works; booking the parent hall over either is refused (AT-36). Periods are
half-open; equal end/start do not overlap unless a handover buffer is configured (AT-12). Open-ended (permanent)
reservations use an unbounded range, never an artificial far date. Shared-policy resources take no exclusive locks;
capacity rules for shared resources are an open item (see STATUS).

## ADR-007 Approval signing modes kept separate — Provisional (D-02); PKI mode implemented by ADR-020

`INTERNAL_ATTESTATION` (default): the approver re-enters their password; the server computes the SHA-256 of a
canonical approval document bound to the revision hash and stores an HMAC evidence over (mode, person, capacity,
document hash, time) using `MOVER_ATTESTATION_KEY`. The UI and API label it «توثيق داخلي — ليس توقيعاً رقمياً بشهادة».
`PKI`: provider interface with no provider connected; it fails closed with `503 SIGNATURE_PROVIDER_UNAVAILABLE` and
records nothing (AT-27).

## ADR-008 Plain PostgreSQL instead of PostGIS — Superseded by ADR-017 (2026-10-29)

Sites carry a point location and append-only `site_geometry_version` GeoJSON with an explicit CRS label. The map
needs only bounding-box filtering of a few thousand points, which plain columns handle. PostGIS (and a decision on
the organisation's coordinate reference, D-01) should be introduced when real boundary geometries are imported.
*Superseded:* boundaries are now registered and imported, so PostGIS is in use (ADR-017).

## ADR-009 Local map packages — Accepted; amended by ADR-017 (review, activation, managed packages)

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

## ADR-016 Two sign-in paths as in TNQL, authentication time, first administrator, task assignment — Accepted (2026-10-29)

Owner decisions after the review of `c96cb4b`.

- **Two paths on one page.** The sign-in page has TNQL's layout: «الدخول الآلي بالحساب المؤسسي» goes through Keycloak
  (ADR-015), and «إدخال اسم المستخدم وكلمة المرور يدوياً» opens the username and password form in the same card. The
  manual form is checked by the enterprise directory itself: the service account finds exactly one entry, then the
  person's own bind proves the password (`DirectoryAuthenticator`). The channel is always LDAPS or StartTLS, trusting
  only the CA folder with host-name checking, and credentials are never sent before it is secured. Empty passwords are
  refused, since they would be an unauthenticated bind. Failures are throttled per login name (5 in 15 minutes) and per
  address. The identity is (`urn:tmrkz:directory`, directory UUID) and is linked by the same rules as the provider path.
  This is not the removed local password login: TMRKZ stores and checks no password.
- **Authentication time.** Every authorisation request sends `max_age` (12 hours for sign-in, 0 for a step-up), so
  `auth_time` is mandatory (OIDC Core 3.1.2.1). A missing value is refused, as is one in the future or older than the
  requested age; a step-up must have authenticated after it began. `iat` is never used instead. The realm's client
  includes Keycloak's `basic` scope, which carries `auth_time`. A step-up for a directory session re-binds with the
  password.
- **First administrator.** `ops/bootstrap-admin.sh <login>` (host operator, 24 hours, only while no active system
  administrator exists) lets that directory login's first verified sign-in become a temporary local administrator for
  72 hours, so the HR source can be configured on an empty installation. When the HR mirror later contains the person,
  the identity moves to the HR record and the temporary grant ends. Everything is audited; `ops/test-env/clean-install.sh`
  proves the path on an empty database.
- **Task assignment.** After a transfer or departure, a task whose role and scope have exactly one remaining holder is
  assigned to that person. With none or several it waits for the organisation's access managers, who assign it from a
  searchable, paged list of authorised people (`/task-reassignments`). Candidates are scanned in keyset pages with no cap
  before the scope check. An assigned task can be decided only by its assignee.

## ADR-017 Administrative map workspace on PostGIS; registered boundaries only — Accepted (2026-10-29)

Owner's completion brief `docs/MAP_WORKSPACE_COMPLETION_AR.md` (MAP-01 … MAP-18). Supersedes ADR-008 and amends ADR-009.

- **Database.** Image `postgis/postgis:17-3.5-alpine` (PostgreSQL 17.11, PostGIS 3.5.7, GEOS 3.14.1, PROJ 9.8.1 with
  network access disabled). Same PostgreSQL release as the earlier `postgres:17.11-alpine`, so an existing volume is
  upgraded in place; migration V8 creates the extension (owner or superuser needed — with separated roles the DBA runs
  `create extension postgis` before migrating). Proven on the acceptance environment's V7 data: every one of the 130
  earlier rows unchanged (`ops/upgrade-check.sh`, `ops/sql/upgrade-rows.sql`).
- **Marker ≠ boundary.** `site.lat/lng` stays the display marker (indexed `site.marker`). A boundary is a
  `site_geometry_version` of type Polygon or MultiPolygon in EPSG:4326, GeoJSON axis order (x = longitude,
  y = latitude), with its original input, original CRS, transformation, reason, author and import job. Legacy point
  rows stay points ("حدود الموقع غير مسجلة"); nothing is ever generated around a point, and the fixed-offset shapes of
  the earlier map are removed.
- **Versions and concurrency.** Versions are append-only. `site.geometry_version` is compared and set under a row lock:
  a save based on another version is refused with `GEOMETRY_STALE` (409) and nothing is overwritten.
- **Input.** GeoJSON and KML only (Shapefile/GeoPackage are converted outside with an explicit CRS). The CRS comes from
  the file or an explicit declaration — never from the numbers. Supported: EPSG:4326/CRS84, 3857, 32639, 32640;
  `urn:ogc:def:crs:EPSG::4326` (latitude first) is refused as ambiguous. Validity, transformation and area are computed
  in PostGIS; invalid shapes are reported (self-intersection, nested shells, holes outside) and never repaired. An
  import is previewed with a per-shape report and published as a whole or not at all.
- **Drawing.** Leaflet stays; Leaflet-Geoman **Free 2.20.2 (MIT)** is loaded on demand for free features only (draw a
  polygon by clicks, drag vertices). Undo, start-over, coordinate entry and a vertex table are implemented in the
  application, so no dragging is required (WCAG 2.2 2.5.7). The editor is a separate mode bound to the site it was
  opened for; selecting or panning never edits a record.
- **Map contract.** `/map/features` takes the viewport (`bbox`, `zoom`), a half-open period (`from`, `to`) or an open
  one (`open=true`), selected resources, an organisation (with or without sub-organisations) and the selected
  background. It returns visible sites only, their current boundary and version, each resource's state for the period
  (FREE, BLOCKED from X/I scope locks with handover, SHARED_IN_USE), site availability FREE/PARTIAL/BUSY/NO_RESOURCES,
  occupants (all, not the first), responsibility vs use relations, and the request layer only for a full VIEW grant.
  Coverage is computed for that viewport, zoom and package (FULL, PARTIAL with fraction, NONE, ZOOM_OUT_OF_RANGE).
  Above 1,500 sites in a viewport boundaries are omitted, above 5,000 the list is capped, with a message.
- **Trees.** Organisation and site trees load one level at a time (`/organizations/roots`, `/{id}/children`,
  `/sites/tree`) and search the whole permitted scope with paths (`/organizations/search`, `/sites/search`); no people
  are loaded for the map. Out-of-scope items answer exactly like missing ones.
- **Requests.** A map request opens a drawer beside the map, prefilled with organisation, resources and period; the
  drawer can be minimised and a later map selection is shown as a difference before it is applied. Each submitted
  revision stores the boundary versions of its sites; the approval document names them, and later edits of the site
  record do not change what the request, the reviewer and the document show. Final approval keeps the atomic conflict
  check of ADR-006. Request types say whether open-ended use is allowed (`request_type.open_end_allowed`).
- **Packages.** Built-in packages ship in the image; further packages are uploaded as a ZIP with `manifest.json`
  (source, licence, date, coverage, zoom range, CRS, version, SHA-256 per file) by a map manager (facilities
  administration over the whole scope), read in memory with size, entry-count and ratio limits and flat safe names,
  checked per renderer (SVG without scripts, handlers or external references; PNG/JPEG by signature), stored on the
  files volume, previewed by the manager only, then activated or disabled with a reason. PMTiles, MBTiles and XYZ have
  no renderer and are refused. No aerial imagery is installed; the map says so instead of offering it.
- **Session.** The map remembers per person only identifiers and view settings (never data), validates them against the
  server on return, and forgets them at sign-out; the module-level package cache was removed.

## ADR-018 OpenFGA as co-decider, scoped grants and the permissions studio — Accepted (2026-10-29)

Owner decisions in `docs/ADMIN_PRODUCTION_IMPLEMENTATION_PROMPT_AR.md` §2 (Keycloak with LDAP, and OpenFGA) and §7
(permissions studio). Amends ADR-004: the business database stays the source of truth and the in-process evaluation is
kept, but it no longer decides alone.

- **Two deciders, both must allow.** For a person acting over HTTP, every action the grants allow is checked again in
  OpenFGA 1.8.16 (TMRKZ's own service, store and PostgreSQL database; preshared key; no playground) with the model id
  in force and `HIGHER_CONSISTENCY`: `require`/`requireAny` ("holds the action somewhere"), `canFor` (acting for an
  organisation), the explicit ALL scope, reading a request (full, summary, information copy), downloading an
  attachment, deciding a review task (its role, REVIEW and APPROVE for the final stage, its target organisation) and
  completing an execution task. OpenFGA can only narrow a decision. If it does not answer, the action is refused with
  `AUTHZ_UNAVAILABLE` (503); if it refuses what the grants allow, the action is refused and logged. Background work
  (information copies, task realignment candidates) uses the database evaluation only.
- **Lists keep one SQL predicate.** Lists, searches, counts, map layers, reports and exports are filtered by the SQL
  predicate built from the same grants (ADR-004 reason 2); OpenFGA cannot filter rows. A test asserts that list,
  detail and OpenFGA agree for every scope shape.
- **Model.** Generated from the action list (`ae.mover.authz.AuthzModel`; reviewed copy `docs/authz/model.fga`, a test
  fails if they differ). Each grant (membership, delegation, responsibility seat holder) is an object `grant:<id>`
  whose single `holder` tuple carries the condition `grant_scope`: validity window, role, and the grant's own site or
  resource limit. Organisations and sites have `<action>_here` and `<action>_tree` (followed through `parent`); a site
  inherits from the organisation that administers it; `system` holds ALL grants and "held somewhere". Requests are not
  stored: their creator, related organisations, sites, resources and information recipients are contextual tuples of
  each check. Because the site limit of an AND grant is evaluated on that grant's own holder tuple, a site reached by
  another grant can never complete it.
- **Outbox.** Database triggers append `authz_change` rows in the same transaction as any change to memberships,
  delegations, scope targets, roles, seats, affiliations, person status and the organisation/site/resource structure.
  The sync worker (own transactions, advisory lock, every 2 s, full reconciliation every 5 min) derives the tuples
  from the same `GrantSource` the in-process evaluation reads, diffs them against the mirror `authz_tuple` and writes
  only the difference. Before the first OpenFGA check of an HTTP request, pending changes concerning the actor (or
  shared ones) are applied; if that is impossible the action is refused with `AUTHZ_SYNC_PENDING` (503). Validity
  windows travel as conditions, so an ending grant stops in OpenFGA without waiting for a sync. "Rebuild" writes every
  tuple into a new store from the database and then switches to it (repairs a store changed or restored on its own).
- **Scoped grants.** A grant keeps its role's scope (`scope_mode = ROLE`) or names explicit targets (`CUSTOM`):
  organisations (alone or with branches), sites (alone or with sub-sites), resources, or an explicit ALL. With both an
  organisation and a site/resource limit the grant is their intersection (AND, default) or, by explicit choice, their
  union (OR). Targets are fixed once granted (trigger); a new scope is a new grant. A resource grant reaches requests
  for that resource and the record of the site that holds it, never its sibling resources' requests.
- **Authority of access managers.** A grant is accepted only if one of the granter's own MANAGE_ACCESS grants lists the
  role as grantable (`role_def.grantable_roles`, edited in the studio) and reaches the grant's organisation and every
  target. The explicit ALL scope and roles with CONFIGURE or VIEW_SOURCE_IDENTIFIERS are reserved to a global access
  manager (MANAGE_ACCESS with ALL). Ending grants and revoking delegations also require MANAGE_ACCESS over the grant's
  organisation (previously any MANAGE_ACCESS sufficed — fixed).
- **Versioned policy.** The role catalogue is a sequence of `access_policy_version` rows (one draft, one published,
  earlier ones kept; published rows immutable). Draft → validation → impact (actions added or withdrawn, holders,
  persons) → publication with a note by a global access manager; the OpenFGA model id in force is pinned on the
  version; `role_def` is the published projection. Restoring an earlier version publishes a new version that names its
  origin; roles created after it remain defined without actions. Every step is audited.
- **Studio.** «مركز الصلاحيات»: versions and action matrix, grants per organisation with the scope in plain Arabic,
  a scope builder with lazily loaded trees, "what can this person do and why" for the published policy and the draft
  with OpenFGA's answer beside each action, and the decision service's state. Organisation access managers see the
  policy read-only and can only pick what their own scope shows.
- **Not done.** No explicit deny rules (grants are additive). Time-bound delegation is still created on the
  organisation page. The authorisation database is backed up and restored with the others (`openfga.dump`); a backup
  without it is rebuilt from the restored grants.

## ADR-019 Parent/child relation per resource and an optional shared-use limit — Accepted (2026-10-29)

Owner decisions in `docs/ADMIN_PRODUCTION_IMPLEMENTATION_PROMPT_AR.md` §2 ("the blocking or sharing relation is set per
resource, not a fixed rule for all sites"; "no default capacity") and §9. Amends ADR-006.

- **Relation.** `resource.child_blocking` (default true = the earlier behaviour for every existing resource). When a
  parent's relation is "independent", the scope-lock traversal does not cross the edge to its children in either
  direction: booking the parent no longer X-locks them, and booking a child no longer I-locks the parent or anything
  above it. The same traversal serves the final approval, period changes, the availability preview and the map.
- **Changing it.** A facility manager over the site's organisation changes the relation, handover time, name or kind
  (`PUT /resources/{id}`). If the relation or handover changes, the locks of every reservation on the resource's
  ancestors, itself and its descendants are rebuilt in the same transaction; if the new rule makes approved bookings
  overlap, the exclusion constraints refuse it and nothing changes (409 with an explanation).
- **Shared-use limit.** `resource.shared_limit` is null (no limit) unless set, and only for SHARED resources. At final
  approval the resource row is locked (serialising approvals of the same resource) and
  `resource_shared_peak(resource, period, excluding)` — the highest number of overlapping active reservations in the
  period — must stay below the limit, otherwise the approval is refused as a reservation conflict with nothing
  recorded. A limit below the uses already approved from now on is refused. The map shows a shared resource at its
  limit as unavailable with the reason.
- **Interface.** «إعداد الموارد وعلاقاتها» in the site panel (facility managers): resources with policy, handover,
  relation and limit; add a resource; edit with server-side refusal shown in place.

## ADR-020 Certificate signature of the approver and seal of the organisation with DSS — Accepted (2026-10-29)

Owner decisions in `docs/ADMIN_PRODUCTION_IMPLEMENTATION_PROMPT_AR.md` §2 ("digital signature with a certificate and an
electronic seal, both verifiable") and §10. Implements the PKI mode of ADR-007; internal attestation stays available
and is never labelled as a certificate signature.

- **Library.** Digital Signature Service 6.5.1 (European Commission, LGPL-2.1): `dss-jades`, `dss-validation`,
  `dss-token`, `dss-utils-apache-commons`, `dss-crl-parser-x509crl`, `dss-policy-jaxb` (BouncyCastle 1.86, jose4j). DSS is
  neither a certificate nor a trust provider nor an HSM.
- **Format.** The canonical approval document (the same canonical JSON whose SHA-256 the document carries) is signed as
  JAdES-BASELINE-B, JSON serialisation, enveloping: first the approver's certificate, then the organisation's seal as a
  parallel signature, so adding the seal leaves the person's signature intact. JSON is used rather than PAdES because
  the document is canonical JSON and Arabic text in a generated PDF would need a shaping engine the stack does not have.
- **Validation.** Both signatures are validated with DSS's default policy against the organisation's trust anchors and
  the CRLs distributed inside the network (no OCSP, AIA or other network access). Only `TOTAL_PASSED` is accepted;
  revoked, expired (checked before signing), untrusted and missing certificates are refused with an Arabic reason.
  Every validation (at signing and each later "verify now") is kept in `validation_report`; the evidence of each
  signature (certificate, subject, issuer, serial, validity, indication) in `signature_evidence`; both append-only.
- **Transactions.** Signing is outside the decision transaction (§10): `POST /tasks/{id}/signing` checks the task as a
  decision would, freezes the document in a `signing_job` (idempotent per person, task, revision and document hash),
  has the provider sign, validates, and records the outcome in its own transaction. The decision
  (`signingJobId`) re-checks permission, assignment, revision and the frozen hash inside the transaction that commits
  the decision, the reservations, Flowable, the audit and the outbox; the job becomes PUBLISHED only if that commits.
  If the decision fails (e.g. a reservation conflict), the job is recorded UNPUBLISHED with the reason and no approval
  document exists. A signature of another revision or task is never published. A provider outage stops the approval
  with `SIGNATURE_PROVIDER_UNAVAILABLE`; there is no fallback to the internal attestation.
- **Provider.** `SigningProvider` hands DSS keys without exporting them. `PKCS12_DIRECTORY` (key stores
  `person-<employeeNo>.p12` and `seal-<organisationCode>.p12`, one password from a secret file, CA and CRLs in mounted
  folders) serves the acceptance environment and organisations with soft certificates. An enterprise HSM or signing
  service (PKCS#11 or remote) is a further implementation of the same interface once its details are known.
- **Not done.** No time-stamp authority (signatures are B-level with the signing time claimed by the server; a TSA
  inside the network would make them B-T). No OCSP. No assessment against the UAE Trusted List or TDRA guidance —
  that depends on the enterprise provider's services and policy. The fictional test PKI proves the mechanism, not a
  trust level.

## ADR-021 On-site request menu and informational unit symbols — Accepted (2026-10-29, completed 2026-10-30)

Owner continuation prompt (`docs/OWNER_CONTINUATION_PROMPT.md` §3 and §6).

- **On-site menu.** A click, tap, Enter or Space on a site's marker or registered boundary selects it and opens a
  compact menu anchored there (`SiteActionMenu`); on phones it is a bottom sheet. It follows the site while the map
  pans, stays inside the map, and closes on Escape (focus returns to the marker), a click on the empty map or outside,
  a different selection, the boundary editor, or a chosen action. The site tree and the organisation's site list open
  the same menu from a «طلب» button; the side panel shows the same action list. All paths call one command
  (`MapPage.startRequest`).
- **Server decides the actions.** `GET /sites/{id}/request-actions` (`SiteRequestActions`) derives «طلب استخدام مؤقت»
  from the active NEW_RESERVATION types and «طلب استخدام مفتوح المدة» only from those with an open end allowed, using
  the create call's own predicates (a CREATE grant acting for some organisation, a visible site, active resources) and
  a published workflow per type. Unavailable actions carry the reason; a site outside the view is 404. Reading it
  writes nothing.
- **Explicit type and resources.** The selected type code goes to the drawer; the wizard no longer picks the first
  type (from the list it asks). A multi-resource site preselects no resource (the parent is never claimed silently);
  the drawer lists the site's resources first and shows site, type, resources and period on every step.
- **Unit symbols.** The UI shows them in the organisation directory (map and organisation page), the organisation
  details and the request summary, with an Arabic legend and an assignment panel with live preview for CONFIGURE. V12 adds `unit_symbol_catalog` and `org_unit_symbol`, local metadata
  keyed by the organisation id that the HR publication never writes. The approved standard and edition are a policy
  setting (`unitSymbolStandard`: APP6-D, APP6-E, 2525-D, 2525-E; null blocks assignment). CONFIGURE assigns from the
  catalog or a manual SIDC checked for shape (20/30 digits, reality, friend, symbol set 10 or 11), with expected
  version, reason and audit; lookups return only organisations the reader may see. Rendering uses milsymbol 3.0.4
  (MIT, pinned; 3.0.5 was two days old), loaded lazily from the local bundle. A symbol grants nothing.
- **Optional map layer (added 2026-10-30, forwarded owner request).** `OrgSymbolLayer` adds a toggleable layer «رموز
  الجهات المرتبطة بالمواقع» (off by default) that draws the identity symbol of each visible site's responsible
  organisation — and of the organisations using it in the period — as a small clickable strip beside the marker, never
  instead of the facility marker or its geometry. It reuses the existing lookup and renderer, shows only organisations
  the actor may see that have an approved assignment, keeps the symbol's standard colours independent of availability
  and request state, and never invents a location. Symbol identity stays informational: no unit/formation is dragged
  to a position and no size/type is inferred (scope exclusion, `docs/SCOPE_CLARIFICATION_AR.md` §2).
- **Refined 2026-10-30 (owner review).** Two points from the owner's review replace the first cut, which selected only
  the site and capped the strip at three symbols. (1) Every visible organisation with an approved symbol is now drawn —
  responsible plus each occupant — and none is silently dropped; the strip wraps when a site carries many. (2) Each
  symbol is its own button, and clicking (or Enter/Space on) it selects **both** that organisation — applied as the
  map's organisation filter, with the directory switched to the organisations tab so the selection is visible there —
  **and** the site, opening the site's existing actions (same command as the marker). This makes a symbol a working
  tool, not only a picture. It still writes nothing, invents no location, and leaves symbol identity informational.
  Revealing a nested organisation's exact tree node on filter-apply is a later refinement (the context bar and the
  organisation's site list already reflect the applied filter).

## ADR-022 Docked request panel, referral, decision communication and administrative completion — Accepted (2026-10-30)

Owner brief of 30 Oct 2026 (map-centred administrative workspace, review and decision workflow).

- **Layout.** The request form is never a floating form over the map: beside the map it is docked in the map's left
  column (the site details return when it is minimised); on phones and away from the map it is the bottom drawer, and
  a draft survives navigation to the request register as a minimised bar. The organisation directory on the right is
  collapsible. The on-site menu remains the compact action bar of the selected facility.
- **Referral.** A non-final stage refers a request onward for study with the decision `REFER` (V13); `APPROVE` at the
  final stage approves. The final stage cannot refer. Change-impact carry-forward and reports count `REFER` like a
  forward approval. `RETURN` (correction) and `REJECT` (final) keep their mandatory reasons.
- **What changed.** `GET /requests/{id}/changes` compares two submitted revisions from the immutable snapshots
  (`RevisionChanges`); the reviewer sees each changed field, before and after, with the requester's reason.
- **Communication.** `decision_communication` (append-only) records who communicated which outcome to whom (an
  organisation, a person or a named other), by which channel, when, with which document revision and hash
  (`CommunicationService`). Recording needs REVIEW, APPROVE or CLOSE over the request (OpenFGA-confirmed); reading
  needs the full view. Information recipients stay a separate list without tasks.
- **Completion.** Approval no longer leads to closing by the requester: closing is its own right `CLOSE` (new action;
  the generated OpenFGA model gains `close` relations, `docs/authz/model.fga` regenerated), held by the facilities
  review role by default (V13 and bootstrap) and assignable through the policy studio, and it needs a completion
  statement (and an optional evidence reference), stored on the request and in the audit trail.
- **Record summary.** The request document opens with reference, requesting organisation (with its unit symbol),
  facility/resource, type, plain-language state (completeness review, referred for study, returned, finally rejected,
  approved awaiting completion, closed), current stage, who holds it, last action and next action.

## ADR-023 Relocation of an organisation's premises and the two-option ring — Accepted (2026-10-30)

Owner request of 30 Oct 2026 (two options around the site; draw the new location; then move).

- **Ring.** On the desktop map a click on a site shows two options as a ring around it: «طلب استخدام» (opens the card
  with the published use types) and «نقل المقر». Phones keep the bottom sheet; tree and list rows keep the card.
- **Request.** Request kind `RELOCATION` (V14), type `ORG_RELOCATION` «نقل مقر جهة» seeded by the bootstrap with its
  form and workflow (organisation endorsement → completeness → study and decision; execution «تنفيذ النقل» by the
  requester). The proposal — organisation (whole or a section with its branches), current site, proposed name and
  location drawn on the map (rectangle, polygon or point, validated in PostGIS) — lives in `request_relocation`,
  editable with the draft, copied into every submitted revision and compared by «what changed».
- **Effects.** Approval books nothing. Closing (CLOSE right, completion statement) records that the move was carried
  out. The site register is never changed by a proposal; a facilities administrator registers a new site separately.
- **Not built.** Deployment planning, moving groups with preserved spacing, tactical graphics and operational
  movement integration (scope exclusion, `docs/STATIONING_REQUEST_DESIGN_AR.md` §1).

## ADR-024 Direct marker management on the map: add a site at a point, move a site's marker — Accepted (2026-10-30)

Owner scope clarification of 30 Oct 2026 (`docs/SCOPE_CLARIFICATION_AR.md`, function 2): "add a marker for a new
location, or drag an existing marker to reposition it." The backend already stored a site's point (`site.lat/lng`) and
accepted it on `POST /sites` / `PUT /sites/{id}`, but no UI ever called them — `BoundaryEditor` is polygon-only and no
marker could be placed or dragged. This was an in-scope administrative/geographic function left out of the map
interface, not an excluded capability.

- **A register edit, not a request.** Placing or moving a marker is a direct, audited edit of the facility register,
  under the same authority as boundary editing (`MANAGE_FACILITIES` on the responsible organisation) and the same
  "reason + audit" contract. It is **not** a reservation and **not** an approval workflow; it is distinct from the
  relocation request (ADR-023), which stays approval-based and only records its move at closing.
- **Server.** `SiteService.create` (unchanged) stores a new site at its clicked point. `SiteService.moveMarker` +
  `POST /sites/{id}/location` update only `lat/lng` (version bump), validate the coordinate range, require a reason of
  at least five characters, refuse a retired site, and audit `SITE_MARKER_MOVED` (or `SITE_MARKER_SET` when the site
  had no marker) with the old and new coordinates. The boundary, resources, responsibility and every reservation are
  untouched. `MapService.context` adds `canManageSites` (= `MANAGE_FACILITIES`), the same value as `canEditBoundaries`;
  no permission was changed.
- **UI.** `SiteMarkerEditor` (CREATE and MOVE) places one draggable marker on its own layer; the marker is dragged or
  its coordinates typed, and nothing is written until an explicit save. Selecting or panning the map writes nothing
  (the existing invariant). Entry points: «إضافة موقع جديد بعلامة» beside the map, and «تحرير سجل الموقع — نقل العلامة /
  تحديد العلامة» in the site detail panel.
- **Verified.** `SiteMarkerIT` (create at a point, move with audit and version bump, set on a marker-less site,
  coordinate/reason validation, viewer and other-organisation manager forbidden, retired-site refusal) on real
  PostgreSQL/PostGIS with OpenFGA in the loop (6 tests pass); frontend typecheck, build and unit tests pass. The MAP-20
  browser check (Edge, offline acceptance env) is pending for the consolidated checkpoint — not yet run.
- **Not changed / not built.** No existing function or approved permission changed. The scope exclusions in
  `docs/SCOPE_CLARIFICATION_AR.md` §2 remain: no unit/formation dragging to deployment positions, no tactical graphics,
  no operational movement. A drawn/placed marker is an administrative register point, never an approved booking.
