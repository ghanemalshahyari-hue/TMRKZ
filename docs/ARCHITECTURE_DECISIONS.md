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

*Superseded in part on 2026-11-02 by ADR-027: the requester-decision clause below no longer applies — nobody decides a
request they made, directly or through a delegation, another role, organisation or person record. Kept for history;
decisions recorded before ADR-027 keep their `by_requester` flag and «(مقدم الطلب)» label.*

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

*Amended 2026-11-02 (ADR-029): the page `MapPage` («الخريطة والمرافق», `#map`) is retired; its functions run in
«مساحة التمركز» (`#stationing`) with the same components and server rules, and `#map` redirects there.* *Further amended
the same day: the merge into «مساحة التمركز» was removed by the owner; the page stays retired and `#map` still opens
`#stationing`, but its functions have no screen until the rebuild (components, APIs and data unchanged).*

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

*Amended 2026-11-02 (ADR-029): «نقل المقر» in the ring now opens the stationing panel of ADR-025 (footprint copy dragged
as one object, or a drawn polygon); the point/rectangle `RelocationPanel` of this ADR is removed. Request kind, type,
storage, workflow and effects are unchanged.* *Further amended the same day: with the merge removed, the ring is not
shown on any screen; a relocation is proposed from the stationing popup «طلب تمركز / إعادة تمركز» (ADR-025).*

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

## ADR-025 Map-first stationing workspace: drag a proposed location with configurable distance rules and occupancy — Accepted (2026-10-30)

*Amended 2026-11-02 (owner: rebuild the stationing interaction to the approved polygon prototype). The proposal is a
footprint, not a point: a copy of the registered polygon and the organisation symbol is dragged as one rigid object
(geodesic distance/bearing per vertex, `frontend/src/lib/footprint.ts`, `components/stationing/FootprintEditor.ts`), or a
new polygon is drawn by vertex count (≥ 3) on the map or by per-vertex coordinates, with numbered vertices, edge lengths,
area, vertex editing, undo/redo/reset and a compare view. The registered polygon and symbol stay visible and unchanged;
the map step comes first and a compact details step follows. Server validation, save/submit and approval are unchanged;
activation of an approved relocation is not built. Organisation symbols are on by default in this workspace.*

Owner brief of 30 Oct 2026 (map as the main work surface; choose an organisation and its premises, choose «تمركز /
إعادة تمركز», drag the proposed marker, see the distance, the allowed range and occupied sites, confirm or cancel).

- **Workspace.** `#stationing` (`StationingPage`): navy top bar with search, «شجرة الجهات» on the right (lazy, server
  scoped, level badge per row, the selected organisation's linked sites under it), the map in the middle with layer
  chips (allowed range, occupied areas, organisation symbols, sites — remembered per person), a distance-measuring tool
  and a scale bar, and the request panel on the left. The existing `MapCanvas`, `OrgSymbolLayer`, background packages
  and relocation request (ADR-023) are reused; the main map page and its ring are unchanged.
- **Proposal, not a register edit.** The proposed point is a separate draggable marker; the current premises' marker is
  never moved (that remains the ADR-024 register edit). Options: kind (premises or temporary work area), level (main or
  branch premises), permanent or temporary (start and end), the organisations covered (branches at the current
  premises pre-selected; a branch elsewhere is listed with its own site and never moved by default), a new location or
  a registered site, an optional drawn footprint that follows the marker, coordinates typed instead of dragging.
- **Rules are configuration.** `placement_rule` (V15): action, optional level, optional organisation (with or without
  branches), minimum and maximum metres, measure (centre-to-centre or edge-to-edge). The most specific active rule
  applies. No rule is seeded in production; without one the distance is shown with «لا توجد قاعدة مسافة مهيأة». Saving a
  rule needs CONFIGURE, a reason and is audited (`PLACEMENT_RULE_SAVED`). While dragging, a centre-measured rule keeps the
  marker inside the range (with a small margin for the sphere/ellipsoid difference).
- **Occupancy.** `POST /placement/check` intersects the proposal with every registered boundary (not only its centre)
  and the chosen registered site, for the requested period: an exclusive booking or a shared resource at its limit
  blocks; shared use below the limit is allowed and noted; bookings of the moving organisation and the organisations it
  covers never block. A site the actor may not see is reported as «منطقة مشغولة غير ظاهرة لك» without id or occupants;
  occupants are named only with a full view.
- **Server re-check.** The same evaluation runs when the proposal is saved (stored as `check_status`, distance, rule and
  rule version), at submission (refused with the Arabic reason) and at approval (a site booked after submission refuses
  the decision). A temporary stationing carries its end into the request period.
- **Not built in this step.** Activation of an approved stationing into the dated organisation↔site record, automatic
  end-of-term return with reminders (phase D), a rule editor screen (rules are managed through the API), the visual
  workflow-editor changes of phase E. The scope exclusions of `docs/SCOPE_CLARIFICATION_AR.md` §2 remain: no movement of
  forces, no tactical graphics, unit symbols stay informational and are not dragged.
- **Verified.** `PlacementIT` on real PostgreSQL/PostGIS with OpenFGA; the browser journey in Chrome against the
  acceptance environment with fictional data (`ops/test-env/stationing-demo.sql`).
- *Amended 2026-11-02 (owner acceptance of the optimised drag, working tree): the proposed marker follows the pointer
  without being clamped back into the range; outside the range or over an occupied area it turns red and «متابعة» stays
  disabled. The chip/bubble are updated in place once per animation frame and React state is committed only on drop.
  The server checks at save, submission and approval are unchanged. A hidden site is never named in any answer (ADR-026).*

## ADR-026 Security and integrity remediation after the enterprise acceptance audit — Accepted (2026-11-02)

- **Context.** The enterprise acceptance audit (`docs/audit/enterprise-launch/REPORT_AR.md`) reproduced, against the
  running application, four security defects (P0) and four integrity defects (P1). The owner approved P0/P1 remediation
  (2 Nov 2026) with test-first fixes and evidence, without weakening authorization, before any scale testing.
- **Decision (P0).**
  1. *Position seats are grants.* `POST /position-seats` and its withdrawal apply the same authority as
     `POST /memberships` (`GrantAdminService.requireAuthorityForRole`: grantable roles, ALL scope and system actions only
     for a global access manager). A seat for an HR position the actor holds is refused (indirect self-grant).
  2. *No self-grant.* Nobody grants a role to themselves, and the identity created by `ops/bootstrap-admin.sh`
     (`person.bootstrap`) receives no grant beyond its 72-hour one; the lasting administrator is the person's HR record.
  3. *Hidden sites stay hidden everywhere.* `PlacementService.evaluate` fails closed (no access context = no names); a
     masked conflict carries no availability date and no shared-limit distinction, and masked shared use is not reported;
     the re-check at submission and approval runs with the actor's context; `includedOrgIds` are validated at the
     interactive check as at save; a hidden registered site cannot be chosen as the target (404).
  4. *(Revised by ADR-027: the cross-organisation name search below was withdrawn; bridges replace it.)*
     *Directory and delegations follow authority — search, don't list.* `GET /people` and `GET /delegations` list
     everyone only for a global access manager. For a scoped one, browsing and terms shorter than 3 characters return
     only people affiliated with, or granted in, organisations inside their MANAGE_ACCESS subtrees (with employee number,
     account and status); a search of 3 or more characters also finds active people outside by name, or by an *exact*
     employee number or account, returned as name and organisation only. This keeps cross-organisation grants on a
     shared site possible (access studio STUDIO-06) without exposing the directory; the grant itself is still refused
     when the role, organisation or site is outside the manager's authority. Delegations: those on grants inside the
     subtrees, plus the manager's own. *Residual:* a scoped manager can confirm that a named person exists elsewhere.
- **Decision (P1).**
  1. *Material relocation changes need full re-approval.* The relocation snapshot (geometry, organisation, level,
     duration, covered units, target) joined the structural keys of the change-impact policy (D-06); a returned request
     whose proposal moved goes through every stage again. Unchanged resubmissions still carry earlier approvals.
  2. *Import previews are bound to the structure they were made against.* A preview stores a fingerprint of every unit's
     code/name/parent/status and is valid for 30 minutes; commit refuses a changed structure or an expired preview and
     re-validates without recording another run (a commit no longer leaves a committable PREVIEWED run behind).
  3. *Typed coordinates are taken as a pair.* `lib/coords.parseCoordinates` never fills a missing or invalid axis with 0;
     the site editor keeps the typed text visible, shows the error and cannot save while the pair is invalid.
  4. *Registered boundaries do not overlap except along the site tree.* Every boundary registration (drawing,
     coordinates, import publication — all through `BoundaryService.publishVersion`) and the validation preview refuse an
     overlap above 1 m² with an active site that is neither an ancestor nor a descendant; a shared edge is allowed; a site
     the editor may not see is not named.
  5. *Refusal messages state the real reason.* Submission/approval errors use `PlacementService.Check.refusal()` (range
     problem, else the first blocking conflict) instead of the first informational message.
- **Consequences.** No schema change and no data migration (Flyway untouched). Grants/seats created before the fix are not
  removed automatically — the review queries in the audit report list them. Previews created before the fix carry no
  fingerprint and must be previewed again. Existing overlapping boundaries are not re-checked; only new registrations.
- **Not done (open).** Separation of duties for approvals (owner decision of 2 Nov 2026 prohibits self-approval by
  default, including through delegation or multiple roles) is decided but **not yet enforced** — ADR-013's requester
  decision remains in the code until it is implemented. Resolving an identity issue (`IdentityService.resolveIssue`) does
  not compare the target person's existing grants with the resolver's authority (code-level risk, not reproduced). The
  `/identity-issues` list is not scoped (its rows carry no organisation). Site-level authorised sharing does not exist,
  so no overlap exception is made for it. Local provisioning of people and controlled unit creation (owner decision 1)
  are planned, not built.
- **Verified.** `SecurityRemediationIT`, `PlacementIT.hiddenSiteNeverDisclosed/materialChangeReapproval/refusalStatesTheRealReason`,
  `AdministrationAcceptanceIT.staleImportPreview`, `BoundaryOverlapIT`, `frontend/src/lib/coords.test.ts`; each was run
  red before its fix. Full backend suite 116/116 on PostgreSQL + PostGIS with OpenFGA. Exploit re-runs against the
  rebuilt acceptance and disposable environments: `docs/audit/enterprise-launch/evidence/P0-verify.json`, `P1-verify.json`.
  Browser suites on the rebuilt offline environment: map 22/22, journey passed, access studio 5/6 (STUDIO-03 is a
  stale count from before this change; STUDIO-06 — a cross-organisation grant — passes under the search rule above).

## ADR-027 Separation of duties, identity and directory scope, containment-only boundary overlap — Accepted (2026-11-02)

- **Context.** Owner decision of 2 Nov 2026: self-approval is prohibited by default, including indirectly, and enforced
  in the server; cross-organisation work only through explicit, scoped permissions; the load tool must use the current
  sign-in; the fixes are verified independently before any scale test. Builds on ADR-026; ADR-013's requester-decision
  clause is withdrawn.
- **Decision — separation of duties (`access/SeparationOfDuties`, `access/PersonKeys`).**
  1. Nobody decides (approve, refer, return, reject — any stage) a request they made. *They* is the human: the creator's
     person record and every record sharing one of its sign-in keys — employee number, account, the HR domain account of
     the published snapshot, or the key claimed by a sign-in an administrator linked to the record (case-insensitive).
  2. A grant received through a delegation acts for its delegator: the requester's authority delegated to a deputy does
     not decide the request; the requester as deputy of someone else does not either. A deputy with an approval grant of
     their own still decides through it.
  3. Enforced in the server at every path: task list, request detail actions, approval document, certificate signing and
     the decision (checked before the assignment, so a task assigned to the requester still refuses them), with error
     code `SEPARATION_OF_DUTIES` (403). There is no switch; relaxing the rule needs an owner decision and a code change.
  4. *No independent holder.* When a new review task could be taken only by the requester (`TaskSync` →
     `TaskRealignment.separate`), or its last independent holder leaves (`realign`), the task waits for the access
     managers of its organisation (`task_reassignment`, reason `SEPARATION_OF_DUTIES`), who are notified — the requester
     excluded. The requester never sees or resolves the routing of their own request, is never a candidate and cannot be
     assigned; a sole remaining holder is assigned only if independent. The access managers grant the role to an
     independent person and assign the task on the new screen «مهام بانتظار الإسناد» (`components/TaskRoutings.tsx`).
- **Decision — identity and directory scope (`access/DirectoryScope`).**
  1. A scoped access manager reaches *members* (affiliated with, or holding a current grant homed in, an organisation of
     their MANAGE_ACCESS authority) and *bridges* (a current grant on a site that authority administers — the explicit,
     scoped form of cross-organisation work, set up by a manager whose authority covers the person). Members are shown
     with identifiers, bridges by name and organisation only. The ≥3-character outside search of ADR-026 is withdrawn: an
     outsider is found neither by name nor by an exact identifier. Global access managers reach everyone.
  2. The same reach bounds `GET /people`, `POST /memberships` (grantee), `GET /access/explain` (an ended grant no longer
     relates someone), the employee numbers shown among task candidates, and the unlinked sign-ins.
  3. *Unlinked sign-ins.* A scoped manager sees only those whose claimed key belongs to one of their members; key-less or
     unmatched sign-ins are for global managers. Linking hands the sign-in the person's roles, so it requires authority
     over every current and future grant of that person, never targets the linker or the bootstrap identity, and never
     links a sign-in to anyone but the person whose key it claims.
  4. Ending a grant (`POST /memberships/{id}/end`) requires the authority to give it, as for a position seat.
- **Decision — boundary overlap (`facilities/SiteOverlapRule`).** The register has no site-level sharing (organisations
  share one site through a SHARED resource, which needs no overlapping boundaries). The only exemption is the site tree,
  and only as containment: where a site meets an ancestor's boundary it lies inside it, and where it meets a descendant's
  boundary it contains it; a site straddling its ancestor's boundary is refused. Moving a site in the tree re-checks it
  and its descendants, so the exemption can neither be gained nor left behind by a move.
- **Decision — load tool.** `ops/load/load-test.mjs` signs in through `POST /auth/directory/login` only, refuses the
  acceptance environment and needs an explicit target; `ops/load/up-load-env.sh` starts the disposable project
  `tmrkz-load` (port 8099) with synthetic directory accounts and HR records (`ops/load/synthetic-identities.sql`, shared
  password generated under `ops/test-env/.generated/`). `SMOKE=1` takes one request through every stage, each decided by
  a different synthetic person. No sign-in endpoint was restored and no bypass added.
- **Migration.** `V16__separation_of_duties.sql`: indexes only (case-insensitive employee number and account, linked
  claimed keys). No table, column or data change.
- **Consequences.** A requester holding an approval role now waits for another holder; organisations where one person is
  the only holder of a stage's role see that stage routed to their access managers. A scoped access manager can no longer
  find people of other organisations unless a site grant relates them; the first cross-organisation grant is made by a
  manager whose authority covers the person. A child site boundary drawn across its parent's boundary is refused.
- **Independent review (same day).** A separate read-only review of every control found further paths; fixed here:
  the organisation detail roster (employee numbers, grant sites) is shown only for an organisation inside the reader's
  own VIEW or MANAGE_ACCESS scope, never for an ancestor shown as context, and a grant's site only when visible; a
  relocation's origin/target site is unnamed for a reader who may not see it; the access explanation covers members only
  and names a target only when visible; a bridge is found by name only (not by identifier fragments); every self check
  (grant, link, position seat, delegation) compares humans through `PersonKeys`, which also ties a bootstrap identity to
  the HR record that replaces it (`bootstrap_admin.login`); a delegation is never to the bootstrap identity and never of
  MANAGE_ACCESS, CONFIGURE or VIEW_SOURCE_IDENTIFIERS (administration is granted by an access manager, not delegated —
  an owner may revisit this); a stage a requester decided before this ADR is never carried into a resubmission; site
  coordinates must be finite numbers (NaN passed the range check); boundary registrations and tree moves are serialised
  by a transaction-level advisory lock. Concurrent final approvals over overlapping resource trees now row-lock the trees
  in id order before inserting scope locks (`ReservationService.lockTrees`), so the later one gets the reservation
  conflict instead of a database deadlock (a latent race the added checks made visible in MAP-13).
- **Not changed (recorded as open).** Execution tasks and closing are not covered by separation of duties (the receipt
  task belongs to the requester by design; owner decision needed for handover and closing). `/requests/{id}/boundaries`
  and the approval document's site codes at summary level; availability probing by window, and occupant guessing through
  one's own ancestor organisations in `/placement/check`; the audit log is not scoped by organisation; a manager limited
  to sites can list their home organisation's grants; revoking someone else's delegation needs only organisation scope;
  task candidates match on employee numbers; import commit has no lock against a concurrent HR sync; numeric strings
  such as "007" and "7" compare equal in the change policy; `infoOrgIds` is not a material key.
- **Verified.** `SeparationOfDutiesIT` (8), `IdentityScopeIT` (8), `BoundaryOverlapIT` (3), revised `AccessAcceptanceIT`
  (AT-24) and `SecurityRemediationIT`; the phase-1/2 tests were run red first (15 failing assertions,
  `docs/audit/enterprise-launch/evidence/phase2-red.log`); the review-finding tests were written with their fixes. Full
  backend suite 133/133; browser: SoD and assignment screen 12/12, journey passed, map 21/22 (MAP-19 order-dependent),
  access studio 5/6 (stale STUDIO-03); P0 exploit re-runs all FIXED; load tool smoke workflow passed.

## ADR-028 Execution integrity: handover, receipt, acknowledgement and closing — Accepted for the non-production path; V17 verified on a clean path and applied to the acceptance database, not to any retained database (2026-11-03, amended 2026-11-04)

- **Context.** Owner decisions of 2 Nov 2026 on the steps after approval, completing ADR-027 ("Not changed": execution
  tasks and closing were outside separation of duties).
- **Decision.**
  1. Separation of duties covers every approval decision; an approval stage whose role nobody holds goes to the access
     managers (`NO_HOLDER`) instead of being skipped (`TaskRealignment.separate`).
  2. The requester *acknowledges* completing their own work (`ACKNOWLEDGEMENT`, audited as `EXECUTION_ACKNOWLEDGED`,
     "not an approval").
  3. A handover is never performed by the requester, directly or through a delegation; the *receipt* confirms a
     completed handover and is never done by the human who handed over (`SeparationOfDuties.step`,
     `ExecutionService.doComplete`).
  4. The receipt belongs to the authorised receiving party: the step's role, organisation and order after the handover,
     checked against the human, not the record.
  5. Closing needs an independent holder of the right; the requester cannot close their own request
     (`SEPARATION_OF_DUTIES`) and does not see the action (`ExecutionService.doClose`, `RequestViews`). The controlled
     automatic transition the owner listed as an alternative is **not built**.
  6. No silent bypass: an execution step without an independent party, or without anyone, goes to the access managers
     (`TaskRealignment.separateExecution`, `DecisionService.finalizeApproval`).
  - Storage: migration `V17__execution_purpose.sql` adds `execution_task.purpose` (`HANDOVER`, `RECEIPT`,
    `ACKNOWLEDGEMENT`, `TASK`) and fills existing steps from their keys; workflow definitions accept an optional `purpose`.
- **Status — not verified.** The code compiles (main and tests, 2 Nov 2026) but `ExecutionIntegrityIT` (EX-1…EX-5) and
  the backend suite have **not run**: the owner stopped the run, and later briefs forbade migrations. Until they pass,
  do not deploy this revision to data you keep (V17 would be applied) and do not rebuild the acceptance environment's
  backend from it.
- *Amended 2026-11-03 (owner approval: fix the publication bug, test on a disposable database).*
  - **Fix.** `WorkflowValidator` rejected `purpose` on execution steps, so a definition using it could not be
    published and EX-4 failed. It now accepts `purpose` and refuses a value outside the four purposes instead of
    letting it fall back to the key's purpose.
  - **Run.** The backend suite ran on a sealed disposable database: its own container names, an `--internal`
    network, PostgreSQL on tmpfs, OpenFGA in memory, Maven offline. Probes showed the retained databases, the host
    and the internet unreachable. Result: **144/144**, including EX-1…EX-5.
  - **New tests.** `ExecutionInFlightIT` (IF-1…IF-5) covers requests approved before ADR-028 and role and
    organisational scope. `V17MigrationIT` migrates a separate probe database to V16, adds steps as older code wrote
    them, migrates to V17 and drops it.
  - **Gaps the tests record** (`docs/audit/main-risk/ADR-028_TEST_RESULTS_AR.md`):
    - a handover assigned to its requester before ADR-028 cannot be completed by anyone;
    - closing is never routed;
    - an approval stage whose role is held only outside the request's scope is not routed.
  - **Recovery.** An application-level workflow is proposed (read-only scan → audited routing → authorised
    assignment; a CLOSING routing kind needs a migration), **not built**.
  - **Still not deployed.** V17 has been applied to no retained database. Committed and pushed on 3 Nov 2026 at the
    owner's request.
- *Amended 2026-11-03 (P0 audit for Stationing V3, recorded as found):* the statement above is no longer true for the
  **acceptance test environment** (`tmrkz-test`, fictional data).
  - **What happened:** at 13:00:46 UTC a working session fast-forwarded `main` to `964edb2` and ran
    `sh ops/test-env/up.sh`. That rebuilt the backend image, and the backend recreated at 13:01:42 UTC migrated
    `tmrkz-test_db-data` from V15 to V17 at 13:01:50 UTC (Flyway log: "Successfully applied 2 migrations … now at
    version v17").
  - **Effect:** V16 adds indexes only. V17 added `execution_task.purpose` to a database with 0 execution tasks, so no
    rows changed. No backup from before the change exists.
  - **Still true:** no production or owner-retained TMRKZ database exists on this machine (no `tmrkz-mover` volumes),
    and no other database was touched.
  - **Not decided:** keeping the acceptance database at V17, or restoring it to V15 by rebuilding the fictional
    environment, is the owner's decision.
- *Amended 2026-11-04 (owner stop-gate decision 1: V17 approved for the non-production / acceptance path).*
  - **Which machine.** The amendment above describes the clone that made commit `6186016`. On the machine where this
    amendment was written, `tmrkz-test` was still at **V16** (no `execution_task.purpose`, no `up.sh` run on 3 Nov), and
    a database volume of the production compose project `tmrkz-mover` exists (created 28 Oct, last run 29 Oct). The
    owner decided: bring this `tmrkz-test` to V17 by the documented sequence; treat `tmrkz-mover` as retained (never
    touched).
  - **Clean migration path (disposable `tmrkz-migpath`, `ops/verify-migration-path.sh`):** pre-V17 release image
    `mover/backend:1.0.0` (V1–V16) → `mover/backend:rel-6186016` (built from commit `6186016`, V1–V17). Fictional seed
    plus the full journey on the old release (42 checks) → schema dump → plan exactly [17] → backup with SHA-256
    manifest (schema 16) → `upgrade-check before` (133 rows) → start of the new release, Flyway "Successfully applied 1
    migration … now at version v17" (9 ms) → `flyway_schema_history` 17 successful → schema diff only the `purpose`
    column and its CHECK → `upgrade-check after` PASS (133/133 unchanged) → data: handover → HANDOVER ×1, receipt →
    RECEIPT ×1, 0 mismatches → journey on V17 PASS. Evidence `docs/evidence/migration-path/v17/`. TMRKZ's migration log
    is `flyway_schema_history` (MOVER's `release_migration_log` has no counterpart here).
  - **ADR-028 tests:** `ExecutionIntegrityIT` 5/5, `ExecutionInFlightIT` 5/5, `V17MigrationIT` 1/1 (disposable database).
  - **Acceptance database:** `tmrkz-test` upgraded with `ops/test-env/upgrade-backend.sh` (plan [17], backup
    `backups/tmrkz-test-20261104T031947Z`, 6,340 rows fingerprinted and unchanged, V17 in 16 ms, HANDOVER ×169,
    RECEIPT ×169, ACKNOWLEDGEMENT ×1, 0 mismatches, journey PASS) and labelled `ACCEPTANCE / V17` (database comment).
    This is acceptance evidence, not production migration evidence. Evidence `docs/evidence/acceptance-upgrade/tmrkz-test-v17/`.
  - **Tooling found and fixed on the way:** `ops/backup.sh` recorded the schema version as text maximum ("9" for a V16
    database), now numeric; `ops/sql/upgrade-rows.sql` now fingerprints execution steps (columns before V17).
  - **Backup verified before any migration (added for the V18 acceptance approval).** `ops/verify-backup.sh`:
    - checks every file against its manifest SHA-256 and that every dump is readable;
    - restores the business database, as `ops/restore.sh` does, into a throw-away PostGIS container;
    - requires table counts equal to the backup's fingerprint, the manifest's schema version, and rows equal to the
      live fingerprint taken right after the backup.

    `upgrade-backend.sh` runs it after the backup and refuses to swap the image when it fails. It also refuses a
    database whose comment does not say ACCEPTANCE, and it logs the image revision label and the schema fingerprint.
    Proven on the V16 backup `tmrkz-test-20261104T031947Z`: PASS, 6,340 restored rows equal. A changed file and a
    differing live fingerprint are both refused.
  - **Still not authorised:** applying V17 to a real retained or production database without backup, plan, the release
    tooling and verification.

## ADR-029 One GIS workspace: «مساحة التمركز» replaces «الخريطة والمرافق» — Accepted (2026-11-02)

- **Context.** Owner decision of 2 Nov 2026, after the polygon stationing interaction (ADR-025 amendment) was accepted:
  «مساحة التمركز» is the official and only main GIS workspace and «الخريطة والمرافق» is retired once its functions are
  inventoried and the required ones preserved. The two map pages each had a site menu and a request entry. The full
  inventory is in `docs/GIS_WORKSPACE_RETIREMENT_AR.md`.
- **Decision.**
  1. `#stationing` (`StationingPage`) carries every function of the retired page with the same components and server
     rules: context bar with period tools and colour mode, background and layer panels, names, legend, coverage note,
     neutral state on a failed refresh, aborted and sequenced viewport requests, viewport summary and the per-person
     saved context (same key, cleared at sign-out); a collapsible directory with organisations (the stationing tree with
     levels and linked sites, plus an optional map filter with or without branches) and sites (`SiteTree` with row menus
     and the selection's path revealed); site details with resources, occupants, boundary version, use requests and
     changes to an existing use; and facility tools as the server allows (add a site at a marker, move a marker, edit a
     boundary, import boundaries, map packages, export).
  2. One on-site menu: the server-decided `SiteActionMenu` (ring on the desktop map, card from a tree row, bottom sheet on
     phones). «طلب استخدام» opens the request drawer docked beside the map; «نقل المقر» opens the stationing panel with
     the chosen published relocation type (`StationingPanel.typeCode`). The stationing page's own popup — a duplicate
     entry decided on the client — is removed; its items moved to the details panel and the context bar.
  3. The organisation of a stationing request is the one chosen from the tree, the search or its symbol when it is
     linked to the site; otherwise the site's responsible organisation. A click on the map never re-fits the map; only an
     organisation chosen from the tree or the search fits the map to its sites.
  4. Routes: `#map`, `#map/…` and unknown routes open `#stationing` (address replaced); `#stationing/<requestId>` still
     reopens a draft; the brand link, the no-access card and «على الخريطة» on the organisation page lead to
     `#stationing`; «طلب جديد» opens the drawer there. The map keeps a full working height; the heading and context bar
     scroll away above it.
  5. Removed: `pages/MapPage.tsx`, `components/map/RelocationPanel.tsx` (the point/rectangle proposal of ADR-023,
     superseded by the footprint panel), the navigation entry, the `map` view and the page-only CSS. Kept: every shared
     component (including `OrgTree`, used by the permission pickers), API, table, permission and geographic data.
- **Not changed.** Backend, database, OpenAPI, permissions and workflows. Activation of an approved relocation and
  site-sharing agreements remain not built (ADR-025); nothing was invented for them.
- **Verified** (Edge, offline `tmrkz-test`, only the web container rebuilt): `gis-workspace.mjs` 8/8 (navigation, legacy
  route, no errors, sites and resources against the server, symbols, organisation-page link, facility tools against
  `/map/context` and `canManage` for three roles, «نقل المقر» against `/request-actions` for two roles);
  `stationing-footprint.mjs` 11/11 with the same measurements as the accepted run; `map-workspace.mjs` 22/22 ported to
  `#stationing`; `admin-journey.mjs` 12/12 (J12 now on the footprint panel; it rejects its own open-ended relocation so
  later runs find free windows); `resources.mjs` 3/3; `journey.mjs` passed; access studio 5/6 (stale STUDIO-03, as
  before); frontend 30/30, type check and build. The backend suite was not re-run: no backend code changed, and a run
  would build and migrate the untested ADR-028 work (V17).
- *Amended 2026-11-02 (owner: the merge made the stationing workspace significantly worse; remove it). Decision items 1–3
  and the layout part of 4 are withdrawn: `StationingPage`, `stationing.css`, `map.css` and `StationingPanel` are back to
  their state before this ADR (the 11-step polygon acceptance), and the map, admin-journey and resources suites are back to
  their committed versions. Kept from this ADR: the retirement of «الخريطة والمرافق» (no page, no navigation entry),
  `#map`/unknown routes opening `#stationing`, the brand, no-access and organisation-page links pointing there, and the
  removal of `MapPage.tsx` and `RelocationPanel.tsx`. One pre-merge item is not restored: «عرض التفاصيل» in the stationing
  popup, which opened the retired page. Consequence: the facility functions of the retired page (site details and
  resources, use requests started from the map, period and colour mode, layers, boundary and marker editing, imports, map
  packages, export) have no screen until the owner's rebuild; their components, APIs and data are unchanged. Verified:
  `stationing-footprint.mjs` 11/11 with the accepted measurements; merge-removal check `stationing-layout.mjs` 5/5
  (`docs/evidence/stationing-unmerge/`); frontend 30/30, type check, build. Report: `docs/GIS_MERGE_REMOVAL_AR.md`.*

## ADR-030 Basemap drawn as vector tiles; overlap predicate that does not miss coincident geometry — Accepted (2026-11-03)

- **Context.** Owner approval of 3 Nov 2026 of two narrowly scoped fixes in the real frontend, after the Stationing V2
  prototype showed both: (A) the map lagged while zooming — `MapCanvas` drew the installed SVG basemap package as one
  `L.imageOverlay`, an image tens of thousands of pixels wide at the zoom of site and polygon editing that the browser
  rasterises again after every zoom step; (B) `ringsIntersect` (`lib/footprint.ts`) missed identical and coincident
  rings — no strict edge crossing, and the single vertex it tested lies on the other ring's boundary. Nothing else of
  Stationing V2 is integrated; no backend, API, database, permission, workflow or polygon-editor change.
- **Decision — basemap.** `lib/svgTiles.ts` reads an SVG_OVERLAY package once into its drawing layers (background, the
  filled `<g>` groups, the stroked road classes), each shape with its bounding box; `components/map/svgTileLayer.ts`
  draws it as a Leaflet grid layer of 256-px canvas tiles in the same `background` pane, each tile in its own task and
  only with the shapes that touch it, in the file's colours, widths, fill rules and order, clipped to the viewBox, under
  the same linear mapping between the projected coverage corners that `L.imageOverlay` uses. Only the plain structure of
  the regional package is accepted (absolute M/L/Z data, `preserveAspectRatio="none"`, no text, transforms, curves,
  styles, images or nested groups); any other SVG — such as the acceptance campus plan — and every RASTER_IMAGE package
  stay an image overlay, so no package looks different. The file is fetched from the same local URL as before
  (`/api/v1/map/packages/{id}/content`); nothing else is requested; offline unchanged. The shown layer carries
  `data-background="<package id>"` for tests whatever the renderer.
- **Decision — overlap predicate (conflict semantics documented first).**
  - Documented rules before the change: `ringsIntersect` — "whether two rings share any area"; the boundary register
    (`SiteOverlapRule`, ADR-026) refuses an overlap above 1 m² and allows a shared edge; the stationing occupancy check
    (`POST /placement/check`, ADR-025) uses `ST_Intersects`, so any contact — also a shared edge or vertex — is a hit,
    and it is the authoritative check after every drop, at save, submission and approval.
  - The predicate keeps its rule (interiors overlap): crossing edges, containment (also with shared edges), partly
    coincident edges on the same side and identical rings (any start vertex, orientation or extra collinear vertex) are
    an overlap; a shared edge, a shared stretch of edge from opposite sides, a shared vertex and a near miss are not.
  - Method, no special case for equal coordinates: both rings in one local metric plane; (1) a proper crossing of two
    edges, else (2) each boundary cut at the other ring's vertices that lie on it, every piece classified by its
    midpoint — inside the other polygon is an overlap — else (3) boundaries that coincide entirely. Coincidence
    tolerance 1 mm (`ON_EDGE_M`), a geometric tolerance, not a business one; bounding boxes reject far rings first.
  - Not changed: the server rules, `pointInRing`, `kinks`, the editor. The pre-existing difference stays and is an
    open owner decision: the live feedback does not mark a proposal that only touches an occupied boundary, the server
    check does.
- **Verified.** Edge headless against `tmrkz-test` with only the web container rebuilt (database V16, backend
  untouched); evidence `docs/evidence/map-basemap/` (README, `compare.json`, side-by-side pictures).
  - Frames (`tests/acceptance/map-basemap.mjs`, 1920×1080, 1366×768, 768×1024, 390×844, four zoom levels each up to
    the zoom of polygon editing, mouse pans and wheel zooms): before, the worst frames were 67–734 ms with up to 88
    frames over 50 ms at close zoom (p95 up to 173 ms); after, the worst frame is 14–31 ms, no frame over 33 ms, p95
    13.4–13.5 ms at every size and zoom (16/16 within the budget).
  - Alignment: the same 16 views in both builds, every boundary and marker at the same pixel (0 px); basemap pictures
    before vs after within ±1 px; against an independent Web-Mercator rendering of the same file 15/16 views at (0,0)
    or ±1 px in both builds — the 16th (390×844, zoom 18) differs identically in both because the map's reported centre
    was stale there, and matches at (0,0) after one keyboard pan. No external request, no console error.
  - Unit tests: `svgTiles.test.ts` 23 (the installed package read in full; 18 structures and the acceptance plan
    refused; tile placement equal to the overlay mapping; culling), `footprint.test.ts` 24 overlap cases in both
    argument orders; frontend 80/80 (78 + 2 skipped in the image build, which has no repository files), type check
    and build; prototype 28/28 and type check with the new predicate.
  - Browser regressions on the rebuilt app (read-only, evidence in `docs/evidence/map-basemap/regression/`):
    `stationing-fixes.mjs` 7/7, `stationing-layout.mjs` 5/5, `stationing-footprint.mjs` S1–S10 10/10 (S11, which saves a draft, skipped so the
    environment's data stays unchanged; S10 confirms no request was created).
- **Not done.** `map-workspace.mjs` now checks the shown background through `data-background` instead of the overlay
  `<img>`; it cannot run while «الخريطة والمرافق» has no screen (ADR-029), so that change is not executed. The web
  image is built from a context without `docs/audit/enterprise-launch/` (the previous image served that report under
  `/docs/` on port 8088); a `Dockerfile.dockerignore` entry would make this permanent — not changed, outside this
  approval. The live feedback/placement difference for touching boundaries is left to the owner. The isolated
  prototype keeps its own `svgBasemap.ts`.

## ADR-031 Stationing V3 foundation: versioned policy with slope classification, authoritative stationing, links, outbound outbox, terrain slope dataset — Accepted for acceptance development (2026-11-04)

- **Context.** Owner stop-gate decisions of 4 Nov 2026 (`docs/STATIONING_MODEL_V3_AR.md`, stop-gate report
  `docs/audit/stationing-v3-production/STOP_GATE_REPORT.md`): V17 approved for the non-production path; terrain classes
  from SLOPE PERCENT of the approved DEM with the FAO gradients as the initial versioned policy; Copernicus GLO-30 (a
  DSM) as the fallback production terrain source; MapLibre as the renderer; real Oracle and real touch remain release
  gates. "Prefer the minimum schema that supports the approved model; every persisted field maps to an owner-approved
  requirement."
- **Schema review of the stop-gate proposal S1–S6.**
  - Kept: S3 `stationing_policy_version`; S2 `org_stationing` and `site_link`; S5 `terrain_dataset` + `terrain_slope`;
    S6 `stationing_outbox`.
  - Deferred (no behaviour writes them yet): S4 re-stationing request tables and S5 `deployment_area` — with the request
    workflow, so their shape follows the implemented lifecycle; S1 `site.source_system/external_id/source_version` —
    until a site-system adapter exists (events carry `siteExternalId` null meanwhile); S1 `organization.level` — the
    hierarchy reads the level from the PUBLISHED HR snapshot (`OrganizationHierarchy`).
  - Dropped: S2 `site_occupancy` — approved use is already recorded as reservations, so occupancy is the query
    "stationing that stays ∪ active reservations"; S6 `stationing_outbox_audit` — replays go to `audit_event`.
  - Not reused: `outbox_event` (its processor treats every pending row as an in-app notification and would mark an
    external delivery DONE); `policy_version` (global settings without effective date, reason or reference).
- **Decision — policy.** One complete value set per version (`StationingPolicy`), append-only (trigger), with author,
  reason, reference, effective time (never backdated) and the previous version; the version in force is the newest
  whose effective time has come, so a newer version also supersedes an older scheduled one. Publishing needs CONFIGURE
  over every organisation and is audited with the previous and new value of every changed key.
  `terrain_slope_classification` = the approved dataset (code, version) + contiguous half-open bands [from, to) from 0
  with an open last band, labels in Arabic, thresholds with at most two decimals below 655.34 %; initial values
  `StationingPolicyDefaults.FAO_SLOPE_CLASSES` (FLAT 0–2, UNDULATING 2–10, ROLLING 10–15, HILLY 15–30, MOUNTAINOUS 30+).
  Allowances are a separate map; every class needs an explicit value (0 is explicit; none is assumed). MIN_AND_MAX is
  never publishable (the minimum stays, O-06). A dataset change is a new policy version.
- **Decision — terrain.** The analysis product is slope percent on the native 1″ grid (Horn, latitude-correct
  spacing; ops/terrain), stored as uint16 floor(% × 100), 65535 = no data, in `terrain_slope` (PostGIS raster, 256×256
  tiles). Classification happens at query time: `ST_ValueCount(ST_Clip(rast, polygon))` (pixel-centre rule) per value,
  each value into one band compared in hundredths of a percent, the class with the most cells governs, a tie goes to
  `terrain_class_priority` or blocks (TerrainRule), no-data cells are not counted and are reported. The assessment
  returns everything the audit keeps: dataset, surface model, encoding, processing version, method, policy version,
  classification, shares, covered and estimated cells, controlling class, tie, tied, resolved, priority, allowance and
  the effective ranges of both legs. Hillshade and contours are display-only.
- **Decision — stationing and links.** `org_stationing` (PERMANENT/TEMPORARY with base, validity, planned end,
  origin CORRECTION/REQUEST, reason, reference, end reason; GiST exclusion: one permanent and at most one temporary per
  unit at any time) and `site_link` (never stationing or occupancy). In this foundation a stationing is written only by
  a data correction (CORRECT_STATIONING in the unit's scope; the open record ends CORRECTED, history kept); request
  activation comes with the workflow.
- **Decision — outbound.** `stationing_outbox` row in the same transaction as the change (`tmrkz.stationing.v1`,
  event id derived from the change, `orgCode` added so a local unit without an Oracle id is identifiable); delivery in
  sequence per unit (a unit's next event waits behind an undelivered one, failed included), back-off, FAILED after 10
  attempts or at once on a permanent refusal, replay only by REPLAY_STATIONING_EVENTS over every organisation from a
  non-delegated grant, with a reason, audited. HTTP destination configured by `TMRKZ_STATIONING_OUTBOUND_URL` (+ optional
  token from the environment); without it nothing is sent and events stay PENDING (metric
  `tmrkz_stationing_outbox_pending`). No consumer is connected.
- **Decision — permissions / OpenFGA.** New actions CORRECT_STATIONING, MANAGE_SITE_LINKS, REPLAY_STATIONING_EVENTS;
  the generated OpenFGA model gains their relations (docs/authz/model.fga regenerated). Policy publication reuses
  CONFIGURE (ALL); reads reuse VIEW (scope-filtered and OpenFGA-confirmed). Activation, extension, early return,
  cancellation-before-start and distance-exception actions come with the request workflow.
- **API.** `GET /stationing/policy`, `GET|POST /stationing/policy/versions`, `POST /stationing/terrain/assess`,
  `GET /terrain/datasets`, `GET /stationing/current`, `GET /stationing/organizations/{id}/history`,
  `POST /stationing/corrections`, `GET|POST /site-links`, `POST /site-links/{id}/end`, `GET /stationing/outbox`,
  `POST /stationing/outbox/{eventId}/replay`.
- **Verified.**
  - Clean V18 path (`ops/verify-migration-path.sh`, disposable `tmrkz-migpath`): `mover/backend:rel-6186016` (V17) →
    `mover/backend:v18-wip-20261104` (working tree): journey on V17 (42 checks) → plan exactly [18] → backup (schema
    17) → `upgrade-check before` (133 rows) → V18 applied in 283 ms → `upgrade-check after` PASS (133/133 unchanged) →
    6 tables, 0 rows, `postgis_raster` 3.5.7, append-only trigger, overlap exclusion, V14/V15 rows unchanged,
    0 mismatches → journey on V18 PASS. Evidence `docs/evidence/migration-path/v18/`.
  - Backend on a disposable PostgreSQL 17 + PostGIS with OpenFGA in the loop: `StationingFoundationIT` 7/7 (append-only
    history; policy validation, effective dating, audit of previous/new values; terrain on a synthetic raster — 1.99 %
    FLAT, 2.00 % UNDULATING, no-data excluded, tie blocked without priority, resolved with priority, pinned version
    unchanged; terrain on the real GLO-30 fixture N24E055 — FLAT 2737, UNDULATING 2261, ROLLING 177, HILLY 484,
    MOUNTAINOUS 741 of 6,400 cells, exactly the pipeline's pixel-centre counts; correction with scope, history and
    same-transaction event; links never stationing; read contract by VIEW scope; HTTP test transport with idempotency
    key and sequence per unit, retry, parking, audited replay), `StationingRulesTest` 32/32 (4 new for slope bands),
    `StationingAdaptersIT` 2/2, `AuthorizationIT` 10/10 (regenerated `docs/authz/model.fga` equals the generator),
    focused run 62/62 with the ADR-028 classes; full suite 185/185 (174 before + 11 new).
  - Terrain data (`docs/audit/stationing-v3-production/TERRAIN_PIPELINE.md`): 28 GLO-30 tiles equal MOVER's recorded
    SHA-256 and copied byte-identical; N25E053 and N26E052 confirmed open sea; slope product 317 MB, manifest SHA-256
    `9a91d9af6153baf943713eceb33db22366dbe97fb5840774f0e54cd390992682`, rebuild byte-identical; PostGIS on a disposable
    container: default `ST_Clip` is pixel-centre (fixture counts exact; all-touched 6,561), loader refuses another
    product under an existing version (exit 4), full load 6,300 tiles in 96 s / 453 MB, a 2,754-cell share query in
    167 ms; `python -m pytest ops/terrain` 12/12.
  - Frontend (new permission names) 90/90 tests, build OK.
- **Not done.** Request workflow (S4, deployment areas, activation, temporary lifecycle, drift pause, the remaining
  actions), the production page, real Oracle, real touch. The acceptance database is at V17; V18 waits for the owner's
  review of the plan (`docs/audit/stationing-v3-production/CONTINUATION_REPORT.md`). Copernicus licence text to be
  checked against the current licence before the package is redistributed.
- **Amended 2026-11-04 (owner next-gate decision).**
  - **V18 and the acceptance database.** V18 stays unapplied to `tmrkz-test` until the owner has reviewed section 9 of
    the continuation report itself; `up.sh` keeps refusing [18]. V18 is schema only.
  - **Terrain load.** Loading is a separate, explicit operation after the migration. `ops/terrain/load-slope.sh`:
    - checks the rows, all cells and the cells with a value against the manifest's per-file build counts before it
      commits; a failed load exits 1 with nothing kept;
    - re-checks an existing load of the same product (exit 5 if damaged);
    - refuses `tmrkz-mover`.
  - **Terrain removal.** New `ops/terrain/unload-slope.sh` removes a dataset in one repeatable-read transaction. It
    proves that policy versions, stationing, links, outbox and audit are unchanged, and is refused while the policy
    version in force, or a scheduled one, names the dataset.
  - **Copernicus.** Approved as the current source. The licence was checked against the official document
    (COP-DEM-GLO-30-F, Article 6). Its notices are recorded word for word, with the licence reference and date, in the
    manifest and in `terrain_dataset.manifest`: raw 6(a), derived 6(b), no liability 6(c), no endorsement 6(d). The
    MapLibre terrain attribution is the 6(b) notice. GLO-30 is recorded as a DSM, not a bare-earth DTM; no FGIC data.
  - **ROLLING label.** It shows the owner's provisional UI label «تضاريس متدرجة» (previously «متموّج بشدة»). The code
    `ROLLING` and the thresholds are unchanged.
  - **First policy.** Not published: allowances remain administrator configuration.
  - **Verified.**
    - Disposable PostGIS with V18 and a two-tile real subset: 12 load and removal steps, evidence
      `docs/evidence/terrain-load/loader-checks-2026-11-04.txt`.
    - `python -m pytest ops/terrain`: 13/13.
- **Applied to the acceptance database (owner approval of section 9, 4 Nov 2026).**
  - **Image.** Local commits `21f6689` (release safety) and `4f7ea08` (this foundation), not pushed. Release image
    `mover/backend:rel-4f7ea08` (id `sha256:d63e22aa…5ba0e`) is built from `git archive` of `4f7ea08`. The V18 sha256
    `183c357f…bf87` is identical in the image, the commit and the clean path.
  - **Application** (`ops/test-env/upgrade-backend.sh` on `tmrkz-test`):
    - the ACCEPTANCE label was checked;
    - plan [18];
    - backup `tmrkz-test-20261104T053841Z`, verified by restore (6,432 rows equal);
    - V18 in 0.268 s.
  - **Invariants proved:**
    - 6,432 earlier rows unchanged, including the 6,340 of the V17 acceptance;
    - the schema change is identical to the clean path (452 lines added, 0 removed);
    - 6 tables, 0 rows; `V18-after.sql` 0 mismatches;
    - journey PASS before and after; health UP;
    - the OpenFGA model equals `docs/authz/model.fga` (7 types, 306 relations);
    - no outbound URL, outbox empty; the Oracle source disabled with no route;
    - 0 terrain rows, 0 policy versions.
  - **Result.** Database comment `ACCEPTANCE / V18`. Evidence `docs/evidence/acceptance-upgrade/tmrkz-test-v18/`.

## ADR-032 Offline MapLibre map for Stationing V3, Arabic labels without a right-to-left plugin — Accepted, module not yet wired (2026-11-04)

- **Context.** Owner stop-gate decision 5 (4 Nov 2026): MapLibre for the production Stationing V3 map (vector roads,
  labels, offline PMTiles, styling, layers, terrain, polygons, zoom), no switch of the main map to a Leaflet canvas, no
  RTL plugin unless a reproducible test proves the installed version cannot render the Arabic labels, fully offline
  fonts, no CDN. TMRKZ had no MapLibre (MOVER vendors 4.7.1 and draws road labels as HTML chips, so MapLibre's own
  Arabic rendering had not been proven there).
- **Decision.**
  1. `maplibre-gl` 6.15.0 and `pmtiles` 4.5.0, exact pins (newest stable at least two weeks old on 4 Nov 2026), loaded
     only by the Stationing V3 map (`frontend/src/components/map/maplibre/`, not referenced by any route yet).
  2. No right-to-left or shaping plugin: 6.15.0 shapes Arabic and orders bidirectional text itself (`src/index.ts:92-94`
     deprecates `setRTLTextPlugin`; `symbol/arabic_shaping.ts`, `symbol/bidi.ts` via `bidi-js` 1.1.0, MIT).
  3. Fonts: the style's `font-faces` names the packaged `NotoSansArabic.ttf` (OFL; Arabic, presentation forms, Latin,
     both digit systems); no glyph server, glyph PBFs or sprite.
  4. Data: basemap (`uae.pmtiles`, Protomaps schema, OSM/ODbL, copied from MOVER with its SHA-256) and the GLO-30
     hillshade (`hillshade.pmtiles`, display only) read with range requests from the application origin (`pmtiles://`);
     the MapLibre worker URL is set explicitly from the packaged worker file. Large data stays in git-ignored
     `map-data/`.
  5. Street and terrain modes are two layer groups of one style; switching changes only their visibility, so overlays,
     selection and camera stay (measured).
  6. Attribution: OSM/ODbL with «أسماء الطرق من OpenStreetMap وليست أسماء رسمية»; Copernicus GLO-30 with «نموذج سطح DSM
     وليس تضاريس رسمية». OSM names are never presented as official names.
- **Verified** (`tests/acceptance/maplibre-labels.mjs`, headless Edge, evidence `docs/evidence/maplibre-labels/`): 20
  PASS, 0 FAIL, 0 external requests, no console error. Shaping/order checked objectively against the browser's own
  rendering in the same font (Arabic r = 0.92–0.96, English 0.88/0.98, mixed 0.96/0.99, route numbers 0.94/0.96,
  punctuation 0.87–0.99, numerals 0.95/0.99; three deliberately broken inputs rejected at r = 0.05–0.28); on the real
  basemap 62/67 Dubai road labels Arabic, 53 English in English mode, 17 route shields, no overlap among 37 placed
  labels at z16, zoom 8→17→9 without errors; terrain mode on the GLO-30 hillshade with the DSM notice; frontend
  90/90 tests, build OK, app bundle unchanged by MapLibre (not imported yet).
- **Open finding G-8a (integration decision).** On `<html dir="rtl">` (today's `frontend/index.html`) mirrored
  characters — brackets and «» — are mirrored twice: MapLibre mirrors them (correct), then TinySDF rasterises each
  glyph on a canvas that inherits the document direction. «شارع (١٩)» shows as «شارع )١٩(». Verified workaround:
  `<html dir="ltr">` + `<body dir="rtl">` (G-8b passes). Not applied: it changes the whole application's document
  direction and needs a visual check; alternatives are an upstream fix or glyph PBFs for mirrored punctuation only.
- **Consequences / not done.** About 1 MB more JavaScript for the Stationing page (load on demand) plus a 519 kB
  worker; the dev server needs `optimizeDeps.exclude: ['maplibre-gl']`. OSM tags dry wadi beds like tidal creeks
  (drawn fainter; telling them apart needs licensed official layers). `docs/sbom/frontend-production-packages.txt`
  not regenerated (MapLibre is not in the production bundle yet). Real touch hardware and the owner's manual check
  remain release gates.
- **Amended 2026-11-04 (owner next-gate decision): G-8a fixed in the map module, page direction unchanged.**
  - **Owner decision.** Do not change the whole application's direction to fix brackets. Isolate the problem to the
    component and fix it locally; a global change needs a full visual regression first and is not approved.
  - **Isolated.** The label layout is correct. The defect is only in MapLibre's glyph rasteriser: the TinySDF canvas is
    created without a direction, and Chromium resolves "inherit" from the document element.
  - **Fix.** `drawGlyphsLeftToRight(map)` (`glyphDirection.ts`) wraps the map's own
    `Style.glyphManager.createRasterizer` so each glyph canvas draws left to right. It is re-applied on `styledata`
    for a new style, and `OfflineMapLibre` applies it. `<html dir="rtl">` stays.
  - **Verified** (headless Edge):
    - G-8a passes on `<html dir="rtl">` (r 0.932), identical to the left-to-right-document cross-check G-8b;
    - the G-8c control without the fix still reproduces the defect (r 0.648);
    - 21 PASS, 0 FAIL, 0 external requests; 3 unit tests.
  - **Dependency.** The fix relies on an internal of maplibre-gl 6.15.0 (`createRasterizer`). On an upgrade the label
    test shows any change: G-8a fails, or G-8c reports CHANGED once upstream sets the direction itself and the fix can
    be retired.
  - **Not done.** No RTL plugin was added.

## ADR-033 Stationing V3 re-stationing request workflow on the server; first page behind the V3 flag — Development, not on the acceptance database (2026-11-04)

- **Context.** After V18 reached `tmrkz-test` (ADR-031), the owner directed the next gate: the real re-stationing
  workflow of Model V3, following the approved rules without reinterpretation (`docs/STATIONING_MODEL_V3_AR.md` §1,
  §3, §7; the prototype `prototypes/stationing-ux/src/v3/domain.ts` `check`/`perform` is the behavioural reference).
  The generic request engine was mapped first. It cannot carry this workflow, because it is built around facility
  reservations:
  - `request` allows six statuses and needs a form version and a facility;
  - the stages are frozen per published Flowable process, so a hierarchy walk of variable length cannot be expressed;
  - the side effects run inside the final decision.

  Its separation-of-duties and access pieces are reused: PersonKeys, SeparationOfDuties, delegated grants,
  AccessContext with the OpenFGA second decision, and audit.
- **Decision — own lifecycle tables (V19 `restationing_request`).**
  - `restationing_request`: the 11 states of §3, the content (units, other-branch decisions, the one proposed site, the
    deployment areas, written exceptions, reason), the pinned policy version, the route number, the route path, the
    hierarchy snapshot, returned/paused records, the final approver and the activation.
  - `restationing_stage`: the stages of every route generation, with satisfied conditions, the facts each rests on, and
    the decision with any delegation.
  - `restationing_revision`: one row per submission, with the facts that changed and the decisions invalidated or
    carried, plus the checks and terrain audit.
  - `deployment_area`: written on activation.
  - `org_stationing.request_id` gains its foreign key.
  - Extension, early return and cancellation before start come with their behaviour (not in V19).
- **Decision — submission.** Only the requester submits, holding CREATE_RESTATIONING for the requesting unit.
  - The policy version in force is pinned at the first submission.
  - Server checks block submission on:
    - units outside the requesting unit's branch unless explicitly included and the policy allows it;
    - a footprint over `maxFootprintAreaM2`;
    - occupied ground under the site or any deployment area (O-08);
    - an incomplete deployment pair;
    - a leg out of range (centre to centre, O-04, terrain allowance on the maximum, O-06);
    - an exception without a written reason, or an unresolved terrain tie (O-05b);
    - a missing decision for another-branch units at a site the requester's branch is responsible for (O-03);
    - a reason under 5 characters;
    - a route without its final stage.
  - Occupied ground comes from authoritative records only: the effective stationing of units that stay, plus active
    reservations. A site every unit leaves is free, and a link never occupies (O-15).
  - The route is `RouteDerivation` from the requesting unit (O-07, O-09, O-03b). A distance-exception stage is added
    before the final stage when a leg needs it.
- **Decision — decisions.**
  - A hierarchy or cross-branch stage is decided through APPROVE held in that unit's own approver seat: a grant anchored
    at the unit, not an ALL or ancestor grant. The exception stage is decided through
    APPROVE_DEPLOYMENT_DISTANCE_EXCEPTION acting for the requesting unit. Both are confirmed by OpenFGA.
  - Never the requester's human, nor a grant delegated by them. One human decides at most one stage of the current
    route, which also gives O-03b independence.
  - Return and reject need a reason. A return keeps the request; resubmission needs a reason and takes again only the
    decisions resting on a changed fact (V2 D18). Later decided stages that are unaffected are CARRIED.
- **Decision — hierarchy change (O-10, O-10b, O-16).** After every HR publication (`HrSnapshotPublished`), and every
  minute, a request in review or approved-not-activated whose requesting unit's path differs from its snapshot is paused
  with the owner's wording.
  - A decision or an activation on a drifted request pauses it and is refused.
  - Confirmation, with a reason, rebuilds the route from the same unit as a new route number with every stage
    undecided. The earlier route stays with its decisions.
- **Decision — activation.** A separate act: ACTIVATE_STATIONING over every moving unit, by a human who is neither the
  requester nor the final approver (D1), and not on their delegation.
  - Activations are serialised (advisory lock), and the site and areas are checked against occupied ground again.
  - It registers the proposed site (code = request number, boundary version 1, no responsibility).
  - Permanent: it ends the current stationing (SUPERSEDED), cancels a later scheduled temporary, and writes the new
    permanent stationing with `STATIONING_ACTIVATED`.
  - Temporary: it overlays the preserved base, as `TEMPORARY_STATIONING_SCHEDULED` or `STARTED`.
  - It writes the deployment areas and the outbox in the same transaction. Site links and responsibility are never
    touched (O-14).
  - Temporaries start at their start and return at their end automatically: `TEMPORARY_STATIONING_ENDED`, base
    untouched, areas retired.
- **Owner decision O-17 (4 Nov 2026, option B): the distance exception.** A deployment leg beyond the final allowed
  range (policy and terrain allowance) may proceed only by exception:
  - up to the setting's `exception.maxExtra`; beyond that it is refused;
  - with a written reason, recorded in the revision and in the submission audit;
  - through a separate stage before the final stage, decided only by a holder of
    APPROVE_DEPLOYMENT_DISTANCE_EXCEPTION, with the same separation of duties.

  It stays off unless the System Administrator enables `exception.allowed` in the policy. The question was raised
  because the model document (§7, §8) and the prototype carried the exception while §13.1 did not list it.
- **Permissions / OpenFGA.** New actions CREATE_RESTATIONING, ACTIVATE_STATIONING and
  APPROVE_DEPLOYMENT_DISTANCE_EXCEPTION. The generated model gains their relations (`docs/authz/model.fga` regenerated;
  additions only).
- **API.** `GET|POST /restationing-requests`, `GET /restationing-requests/{id}`, `PUT …/{id}/content`, `GET …/{id}/checks`,
  `POST …/{id}/submit`, `POST …/{id}/decision`, `POST …/{id}/activate` (`docs/api/openapi.json` regenerated: 164
  operations).
- **Page (behind `VITE_STATIONING_V3=true`; normal builds unchanged).** «إعادة التمركز»:
  - the visible requests;
  - the request on the offline MapLibre map: current sites, the proposed site, both deployment areas, and the allowed
    distance bands as guidance;
  - the route with satisfied conditions, earlier routes and revisions;
  - the server checks with terrain shares and allowance;
  - decide, activate, submit or resubmit, as the server allows.

  First editor: requesting unit, explicit units, permanent or temporary, a copied boundary moved by clicking (or a new
  shape), the two areas, the reason, and the server's checks before submitting. Vertex editing and the fuller journey of
  §4 are not done.
- **Development environment.** `ops/test-env/dev-v3.sh` runs the disposable project `tmrkz-v3dev` on :8097: fictional
  data, the backend from the working tree, memory caps. `dev-v3-seed.sql` holds illustrative levels, seats, starting
  stationing, boundaries and a policy marked as development values; the two GLO-30 tiles over the fictional sites are
  loaded with the checked loader. It is never the acceptance or production database. The frontend dev server serves
  `map-data/` locally for development only.
- **Verified.**
  - `RestationingWorkflowIT` 10/10 on disposable PostgreSQL with OpenFGA: permanent journey with separation of duties
    (including a second record of the same human), return with selective re-approval, hierarchy pause and rebuild,
    activation refused on drift and on ground taken since approval, temporary schedule/start/return, checks,
    cross-branch inclusion (O-03, O-03b), policy version locking, visibility.
  - `tests/acceptance/restationing-journey.mjs` 15/15 against `tmrkz-v3dev` through the real Keycloak/LDAP sign-in.
  - The page checked headless in Edge, with no console errors.
  - Full backend suite on a disposable database: 195/195 (185 before + 10 new).
- **Applied to the acceptance database (owner D1/D2, 4 Nov 2026).**
  - Commits: local commits `685d902` and `7152d53` (no push).
  - Gate before application: full suite on C2 195/195; frontend 93/93.
  - Release image `mover/backend:rel-7152d53` (`sha256:b4a8f1c3…a8bfd`), with V19 `dfb47424…4ddf`.
  - Procedure: plan [19]; backup verified by restore; V19 in 44 ms.
  - Invariants: 6,552 rows unchanged; schema change identical to the clean path; 4 tables, 0 rows, sequence and
    foreign key; journey PASS; OpenFGA 357 relations; no side effects. Result: `ACCEPTANCE / V19`.
  - **D4 fictional acceptance data, no policy** (`ops/test-env/provision-acceptance-v3.sh`): levels, single-action roles
    and seats for selected fictional users, starting stationing, the one missing boundary; the GLO-30 dataset loaded
    separately. The page stays hidden there (D3). Submissions stay refused until the owner supplies the terrain
    allowance values.
- **Acceptance policy and the policy studio (owner decisions, 4 Nov 2026).**
  - **Decided by the owner for the acceptance policy only, «ACCEPTANCE TEST POLICY — NOT A PRODUCTION DEFAULT»:**
    - base ranges 5–8 km and 3–5 km;
    - terrain allowances on the maximum: FLAT 0, UNDULATING 500, ROLLING 1,000, HILLY 1,500, MOUNTAINOUS 2,000 m;
    - tie priority MOUNTAINOUS > HILLY > ROLLING > UNDULATING > FLAT;
    - maximum footprint 0.5 km²;
    - cross-branch inclusion allowed, with OTHER_UNIT and SITE_RESPONSIBLE as conditions, without independence
      (O-03b).
  - **Distance exception:** disabled, because there is no owner value for `maxExtraM`.
  - **Set by the owner in the app:** the routing levels (approving levels, labels, the facts each rests on, the final
    level) and the deployment requirement. Nothing was assumed for them.
  - **The «سياسة التمركز» studio** (behind the V3 flag, System Administrator only) starts from the version in force
    or the approved initial slope classes and imports values from a JSON file. The acceptance values live in
    `ops/test-env/acceptance-v3-policy-template.json`, never in code. Before publishing, the server checks them
    (`POST /stationing/policy/validate`, a dry run) and lists the levels Oracle sends
    (`GET /stationing/hierarchy-levels`). Publishing remains the versioned, audited API.
  - **On `tmrkz-test`** (owner approval of the sequence): a backend release without migrations, the web image built
    with `--build-arg STATIONING_V3=true` (sets `VITE_STATIONING_V3` for the bundle only; off by default), and the offline map packages mounted read-only
    under `/map-data/` (`ops/test-env/compose.v3-maps.yml`). The earlier images are kept for recovery.
- **Owner final acceptance settings and the real-application acceptance (4 Nov 2026).** This supersedes the two
  «disabled / set by the owner» points above for the acceptance policy only.
  - **Settings:**
    - L6–L10 approve, final L6, ancestry routing from the requesting unit's own approver;
    - deployment areas REQUIRED;
    - distance exception enabled with `maxExtraM` 2,000, an ACCEPTANCE TEST VALUE measured beyond the terrain-adjusted
      maximum; beyond it is a hard refusal;
    - local sections without an HR level do not request.
  - **Published** as version 1 through the studio (no SQL). The hierarchy stages rest on scope, classification,
    duration, site and deployment, from the owner model (V2 §4.5).
  - **MultiPolygon decision:** the owner-approved target is copying the complete MultiPolygon (every part, shape, area
    and relative position) and moving it as one rigid group, followed by «تعديل الحدود» / «رسم حدود جديدة». It is never
    reduced to its largest part, merged, hulled or turned into one Polygon. Until grouped movement is built, the editor
    falls back to «رسم حدود جديدة» and says why. A Point has no footprint to copy.
  - **Acceptance result:** journeys A, X, B, C, D, E, F and S passed on `tmrkz-test`. G was proven through the HR sync
    path in `RestationingHrSyncIT`, because no HR source is attached there.
  - **Defects found by the acceptance, fixed in local commit `cea09c7`:**
    - the web image served MapLibre's `.mjs` worker with a non-JavaScript type, so the map was blank;
    - the misleading copy fallback.
  - Evidence: `docs/evidence/acceptance-journeys/stationing-v3/SUMMARY.md`.
- **Owner confirmations after the acceptance (4 Nov 2026).** The verdict: functionally accepted, NOT production
  ready.
  - **Commit history:** `cea09c7` stays as a separate commit; no history rewrite.
  - **Stage facts:**
    - L7–L10 rest on scope, classification, duration, site and deployment;
    - L6 (final) rests on the same facts plus the completion of every earlier requirement (hierarchy, cross-branch,
      distance exception);
    - a deployment-only change re-takes the hierarchy stages that rest on it, and the cross-branch decision stays
      CARRIED.
  - **Stage labels:** «اعتماد المستوى Lx» is accepted. The unit and the approver are shown as separate data, never
    inside the fixed stage label.
  - **G and Oracle:** journey G through the application's HR sync is accepted for now; real non-production Oracle
    stays a release gate.
  - **Geometry:** MultiPolygon target unchanged (grouped copy-and-move, the draw fallback is temporary). Point: no
    invented footprint.
  - **Before production readiness:** fix the label overlap and the policy audit gap (stable identity, role,
    organisation, time, version/reference). Test routes below L7 in the real application.
  - **Accepted for now:** a controlled terrain-tie scenario before final closure is preferred but not blocking. The
    six acceptance-test drafts are accepted, with no delete feature.
- **Batch after the confirmations (4 Nov 2026): local commit `57d7820`, deployed to `tmrkz-test` and re-checked.**
  - **Stage label:** a hierarchy stage's label is the level's configured label alone. The page shows «الجهة: …» and
    the decider as separate lines, and the list shows the current stage with its unit.
  - **Policy audit:** `STATIONING_POLICY_PUBLISHED` records the publisher's role and organisation (the CONFIGURE grant
    that allowed it), the stable person ID, employee number and username, the time, version and reference. The audit
    API also returns the actor's person ID.
  - **Map labels:** they no longer overlap. Collision avoidance with variable anchors, priority proposed site >
    primary > alternative > current site; a label that cannot fit waits for a closer zoom. A MultiPolygon current site
    is drawn with every part.
  - **Single-action users:** `GET /restationing-requests/units` lists exactly where «طلب إعادة التمركز» acts, so a
    requester without a view right can choose units. The app shell asks for sites, request types and the organisation
    tree only with a right their endpoints accept. The general tree stays a view right.
  - **Deeper routes:** fictional L8–L10 accounts and seats (`ops/test-env/provision-acceptance-v3-deep-routes.sh`).
    Routes of 3, 4 and 5 stages pass in the real application; the five-stage one was decided on the page by five
    different people (`docs/evidence/acceptance-journeys/stationing-v3/ROUTES-L8-L10.md`).
  - **Deployment:** backend `mover/backend:rel-57d7820`, no migration, 6,841 rows unchanged; web
    `mover/web:rel-57d7820-v3`.
  - **Re-check on the real page:** 15/15 and 0 console errors.
  - **Still to fix:** a long mixed Arabic/Latin site label wraps and splits the request number.
- **Not done.** Extensions, early return, cancellation before start; grouped MultiPolygon copy-and-move; vertex
  editing; production build of the page and packaging of the map data; a controlled terrain-tie acceptance scenario;
  real non-production Oracle and touch (release gates).

## ADR-034 Stationing V3 lifecycle: cancellation before activation, cancellation before start, early return, extension — Accepted on the acceptance database (V20, 2026-11-04)

**Context.** The owner's acceptance verdict (functionally accepted, not production ready) puts the missing lifecycle
first. The rules are the owner-approved model kept by V3 (`docs/STATIONING_DOMAIN_MODEL_V2_AR.md` §4.6–4.7: D9, D10,
D12, D16, A4, A5, A6). Plan: `docs/audit/stationing-v3-production/LIFECYCLE_PLAN.md`.

**Decision.**
- **Migration V20 (schema only):**
  - a request kind EXTENSION, with `parent_request_id`;
  - the states CANCELLATION_PENDING, CANCELLED_BEFORE_ACTIVATION, START_HELD_PENDING_CANCELLATION,
    TEMPORARY_WINDOW_EXPIRED_WITHOUT_START, EXTENSION_ACTIVATED and LAPSED_NOT_ACTIVATED (with the lapse time and
    reason);
  - the table `restationing_action`, with at most one open action per request;
  - `org_stationing.start_held_at`, and the end reason WINDOW_EXPIRED.
- **Four separate rights, granted to no existing role:** DECIDE_PRE_ACTIVATION_CANCELLATION,
  ACTIVATE_TEMPORARY_EXTENSION, DECIDE_EARLY_RETURN, DECIDE_BEFORE_START_CANCELLATION.
  - The last is the model's DECIDE_TEMPORARY_BEFORE_START_CANCELLATION, shortened because OpenFGA limits a relation
    name to 50 bytes: the generated `…_contains` relation would have 51.
  - The OpenFGA model is regenerated; its longest relation is 46 bytes.
- **Who asks and who decides:**
  - asking needs the requester (the same human) or «طلب إعادة التمركز» for the requesting unit;
  - the decider is another human (PersonKeys; a delegation counts for its delegator) holding the action's right over
    every moving unit;
  - holders of these rights see the requests they act on.
- **Cancellation before activation:** from review, return, pause or approval. It blocks decisions and activation. Once
  approved it becomes CANCELLED_BEFORE_ACTIVATION; if rejected, the recorded state resumes.
- **Cancellation before start:**
  - Approved: the records keep their dates with an empty window (CANCELLED); the scheduler never starts the temporary.
  - Still pending at the start: the scheduler holds the start (START_HELD_PENDING_CANCELLATION, `start_held_at`). A
    held record is out of "in force" (read contract, current sites, occupancy, other-branch units).
  - Refused after the start: the temporary takes effect from the decision, not backdated, and the end does not move.
  - Window ended first: TEMPORARY_WINDOW_EXPIRED_WITHOUT_START, and the action is NO_LONGER_ACTIONABLE.
- **Early return:**
  - Approved: in one transaction, ENDED_EARLY now, with the planned and actual end recorded, and the deployment areas
    retired.
  - Not from a temporary that has not started.
  - A natural end overtakes a pending early return (SUPERSEDED).
- **Extension:**
  - Its own request: it is submitted with the route derived from the requesting unit, and its checks cover the new end
    and the reason.
  - Its own activation, never by its requester or final approver.
  - On activation, the open record closes at the current effective end (SUPERSEDED) and a following record runs to the
    new end; earlier dates are never edited.
  - An extension not activated when the stationing ends, is cancelled or never starts becomes LAPSED_NOT_ACTIVATED.
- **The page** offers only what the server's `can` allows: asking each action, deciding the pending one, the extension
  draft, and the history of actions and extensions.

**Verified.**
- `RestationingLifecycleIT` 8/8 on PostgreSQL + PostGIS with OpenFGA. It covers every transition, the separation by
  human, the wrong right, the held start, the refusal after the start, the window expiry, the early return, the
  extension and the lapse.
- Full backend suite 206/206; `AuthorizationIT` with the regenerated model; frontend 94/94; build OK.

**On the acceptance database (owner approval, 4 Nov 2026).**
- **Commits:** local commit `86a58db` (functional), then `d05a7c2`. The latter fixes a defect found while preparing the
  run: the page's access rule did not list the four rights.
- **Migration:** V20 applied with the guarded procedure:
  - plan [20], backup verified by restore, 51 ms;
  - 6,878 earlier rows unchanged; the Stationing fingerprint equal on 7 tables;
  - schema change identical to the clean path; OpenFGA 425 relations.

  Result: `ACCEPTANCE / V20` (`docs/evidence/acceptance-upgrade/tmrkz-test-v20/`).
- **Fictional accounts:** four single-action accounts hold the rights
  (`ops/test-env/provision-acceptance-v3-lifecycle.sh`).
- **Journeys on the real page with the real scheduler:** extension, early return, cancellation before start, held
  start refused after the start, window expiry and cancellation before activation all pass
  (`docs/evidence/acceptance-journeys/stationing-v3/LIFECYCLE.md`).

**Not done.**
- D11 end-of-temporary reminders.
- Showing the time of the effective end in the lifecycle panel.

## ADR-035 Stationing V3 geometry editing: a MultiPolygon copied whole and moved as one, vertex editing — Accepted on `tmrkz-test` (2026-11-04; see the amendment)

**Context.** Owner gate «GEOMETRY EDITING PHASE — GO»:
- the final behaviour for a current site of several parts is to copy the complete MultiPolygon and move it as one rigid
  group;
- vertex editing is an advanced mode;
- the server stays authoritative;
- undo, redo and reset follow the accepted footprint engine;
- no new MultiPolygon operation may be invented.

**Decision.**
- **No migration.** The V19 request content (`site.geometry`), the submitted revisions and the site geometry versions
  already hold a Polygon or a MultiPolygon.
- **Rules (`lib/siteGeometry`):**
  - a Polygon stays a Polygon, and a MultiPolygon keeps every part in order;
  - the site moves as one rigid object: every vertex keeps its geodesic offset from an anchor shared by all parts (the
    accepted engine's `offsetsOf`/`rebuild`);
  - a vertex edit changes one existing vertex of one part;
  - nothing is added, removed, split, merged, hulled, holed or converted.
- **Map editor (`SiteEditor`, MapLibre):**
  - **move:** the normal journey, with no handles; one grouped drag from any part;
  - **vertices:** the advanced mode; choose a part, then drag one of its vertices;
  - **history:** undo, redo and reset as `SiteHistory`;
  - **responsiveness:** updates coalesced to animation frames, and cheap validation while dragging;
  - **pointer:** followed at window level, for mouse, touch and pen.
- **Copy and redraw:**
  - «نسخ حدود الموقع الحالي» copies a MultiPolygon whole;
  - «رسم حدود جديدة» replaces it only after the requester confirms;
  - a Point still has no footprint to copy.
- **Server (`RestationingChecks.siteProblem`):** accepts one valid Polygon or MultiPolygon, refuses any part without area
  and repairs nothing.
  - Activation registers the submitted geometry with its own type.
  - Saved edits and submissions audit the site's type, part count, area and SHA-256.
  - The revisions hold the geometry itself.
- **Parity:** client and server validity agree on the shared cases (`siteGeometryCases.json`). The client's area is the
  PostGIS geography area (WGS84 spheroid) within 0.05 %.

**Verified.**
- Unit tests: frontend 102/102 (`siteGeometry.test.ts` 8).
- Backend: `RestationingWorkflowIT` 15/15 (parity, MultiPolygon through activation, invalid MultiPolygon); full suite
  209/209.
- Real page on the development environment: G1–G9, approver view and performance 17/17, 0 console errors, 0 external
  requests (`docs/evidence/acceptance-journeys/stationing-v3/geometry/SUMMARY.md`).

**Not done.**
- The journeys on `tmrkz-test` (owner approval). Committed as `58423ce`.
- Real touch.

**Amendment — accepted on `tmrkz-test` (2026-11-04, owner gate «GEOMETRY IMPLEMENTATION → `tmrkz-test` ACCEPTANCE GO»).**
- **Release:**
  - backend `mover/backend:rel-58423ce`, built from C6 `58423ce`, no migration (Flyway V20);
  - web `mover/web:rel-9e02088-v3`.
- **Performance fixtures:** a four-part MultiPolygon and a 1,500-vertex polygon, provisioned by the acceptance-only,
  idempotent `ops/test-env/provision-acceptance-v3-geometry.sh`.
- **Product defect found and fixed (`9e02088`):** the request summary now states «الموقع المقترح». It gives the type,
  part count, area and the submission that holds it, so an approver reads them without counting drawn shapes.
- **Real-page result, 33/33:**
  - G1–G9;
  - the pointer released over the attribution, over another map control and outside the canvas;
  - the approver's view, with return and resubmission: revision 1 keeps the first geometry;
  - activation registers the submitted MultiPolygon exactly, and a second approved request on the now-occupied ground is
    refused at activation. Site links, responsibilities, the copied site and other units' stationing are unchanged.
- **Grouped move:** rigid to millimetres per PostGIS, against the engine's 0.5 m tolerance.
- **Performance:** 0 long tasks over 50 ms on all four sites, measured with a verified instrument.
- **Evidence:** `docs/evidence/acceptance-journeys/stationing-v3/geometry/tmrkz-test/SUMMARY.md`.
- **Still open:** real touch; production map packaging; the final production-readiness audit. Geometry editing is
  accepted on `tmrkz-test`; Stationing V3 is not production-ready.
