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
  *Amended 16 Nov 2026 (ADR-060, owner): the rank («الرتبة», optional) is now mappable, as MOVER shows it; health, passport
  and contact data still cannot be.*
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

**Amendment — the single-click deployment area footprint is a policy value (owner decision, 2026-11-05).**

- The initial footprint a single map click gives a deployment area is `deploymentAreaDefault`
  `{"shape": "SQUARE" | "CIRCLE", "areaM2": number}` in the versioned policy, never a size in client code. The client
  draws CIRCLE as a regular 16-vertex polygon of that area.
- **No migration.** It is the last, nullable component of `StationingPolicy`. The stored-document reader ignores
  unknown keys and leaves absent ones null, so a version stored before it reads null, meaning «غير محددة» (not
  configured).
- **Validation.** The shape is required and 0 < area ≤ 25 km². The upper bound only guards against a mistyped value;
  it is not a footprint maximum, since deployment areas have none.
- **Values.** No production value is assumed: the System Administrator sets it in «سياسة التمركز». A change appears
  as one changed key in the version's audited changes. Requesters read it from `GET /stationing/policy`.

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
    «(صلاحية مُلغاة — يقررها المعتمد النهائي)» acting for the requesting unit. Both are confirmed by OpenFGA.
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
    «(صلاحية مُلغاة — يقررها المعتمد النهائي)», with the same separation of duties.

  It stays off unless the System Administrator enables `exception.allowed` in the policy. The question was raised
  because the model document (§7, §8) and the prototype carried the exception while §13.1 did not list it.
- **Permissions / OpenFGA.** New actions CREATE_RESTATIONING, ACTIVATE_STATIONING and
  «(صلاحية مُلغاة — يقررها المعتمد النهائي)». The generated model gains their relations (`docs/authz/model.fga` regenerated;
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
- **Four separate rights, granted to no existing role:** «(صلاحية مُلغاة)»,
  «(صلاحية مُلغاة — يُفعَّل بتفعيل التمركز)», «(صلاحية مُلغاة)», «(صلاحية مُلغاة)».
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

## ADR-036 Production offline map package: one verified package, a staged install, served read-only — Accepted on `tmrkz-test` (2026-11-05)

**Context.** Owner gate «PRODUCTION MAP PACKAGING PHASE — GO»: the accepted Stationing V3 map ran from the git-ignored
working folder `map-data/`, mounted raw into the acceptance web container. It must become one deterministic, documented
offline package, installed and verified without internet access. The gate also requires:
- MOVER's proven data pattern reused (PMTiles, MapLibre, local fonts, provenance and checksum manifests);
- OpenStreetMap road names kept as unofficial labels;
- GLO-30 kept as a DSM with its licence notices;
- business analysis kept apart from visualization;
- no migration, no change of Stationing behaviour.

**Decision.**
- **Format `tmrkz-offline-map-package` v1 (`ops/map-package/`).** Modelled on MOVER's `mover-offline-map-package`
  (file list with path, sha256, size, component and required flag):
  - one directory named after the package id, with fixed paths per component;
  - `manifest.json` (provenance, licences, coverage, compatibility, style checksum, every file) and `SHA256SUMS`;
  - the roles are kept apart: BUSINESS_ANALYSIS (slope), MAP_VISUALIZATION (basemap, font, style, hillshade),
    PROVENANCE, LEGAL;
  - the 776 MB of source tiles are an optional archival component, listed with their checksums in every package.
- **Untrusted until verified (`package_format.py`, standard library only).** A package is refused unless:
  - it holds only regular files at layout paths, with nothing extra, missing, linked or escaping;
  - its sizes and manifest structure are within limits;
  - every sha256 matches;
  - every component's content checks out: readable PMTiles, a TrueType font, a style with local URLs only, terrain
    matching its provenance, complete coverage, the required attribution.
- **Deterministic build (`build_package.py`):**
  - every input is checked against its recorded checksum first;
  - the style is exported from the application's own `offlineStyle.ts`;
  - the build report is copied without run timings;
  - the archive is a sorted USTAR with a fixed owner, mode and time (`SOURCE_DATE_EPOCH`).
- **Staged install with recovery (`install_package.py`):**
  - plan by default; `--confirm` with the same root carries it out;
  - verify in full, copy to staging, verify again, then rename `current` → `previous` and staging → `current`;
  - `previous/` and `history/` (log and manifests) allow `restore-previous` without any download;
  - dangerous or foreign roots are refused.
- **Serving:**
  - the map root is mounted read-only at `/srv/tmrkz-map` (`TMRKZ_MAP_ROOT`; acceptance `map-data/runtime`);
  - nginx serves only `current/` under `/map-data/`, with ranges, GET only and links not followed;
  - the slope analysis and source tiles are not served;
  - the application's paths are fixed (`mapPackage.ts`), so a new package needs no new build;
  - the map font now comes from the package.
- **Readiness (`readiness.py`):**
  - the package checks;
  - the database: the dataset is loaded with the same slope product, and the policy in force names that version;
  - the served package: the same manifest bytes, ranges, font, analysis hidden;
  - one failure is NOT READY; an unasked section is INCOMPLETE.
- **Air-gap bundle:** carries the tools and, with `MAP_PACKAGE`, the archive; `install.sh` installs the map before
  starting the stack.
- **Map display polish (same gate):** one label per logical site (MAP-2, `c6d63ad`).

**Not changed.**
- MapLibre 6.15.0, no right-to-left plugin, the map-only bracket fix;
- the terrain classes and thresholds;
- the database load path (`ops/terrain/load-slope.sh`, now pointed at the installed package);
- the schema (V20).

**Verified (5 Nov 2026, `docs/evidence/map-package/SUMMARY.md`).**
- **Package:** `tmrkz-map-2026.11.1` (41 files, 583,757,776 bytes, archive `8233ac8b…`); every input checked against
  its recorded checksum.
- **Reproducible:** the terrain products rebuilt from the 28 source tiles give the same archive byte for byte.
- **Installed on `tmrkz-test`** from the archive (verified, staged, verified again, swapped).
- **Refusals and recovery:**
  - corrupted archives are refused with the active package unchanged;
  - a live swap and `restore-previous` work;
  - map-package tests 18 passed.
- **Readiness:** READY 20/20. Its first run found two defects in the readiness tool itself (psql echo, label), fixed in
  `bc6279d` and `a950d7a`.
- **Terrain parity:** 0 differences between the acceptance dataset and a database loaded from the package by the
  production loader: dataset fingerprint, 54 submitted legs (stored = recomputed), drafts, constructed ties.
- **Real page:** 27/27 with the external network unavailable (0 external requests, 0 console errors); one label per
  MultiPolygon site; geometry drag 723 ms with no long task.
- **Open:**
  - `rasterio` for the terrain loader on an isolated host;
  - the open-sea cells' colour in terrain mode;
  - long tasks during a cold page load;
  - the assessment `processing` field.

**Operational amendment — shared-folder map serving on the local installation (17 Nov 2026).**
- The package format, read-only mount and MapLibre engine are unchanged. On `vboxsf`, mode `0770` is retained and `chmod` is ignored; Nginx also fails `sendfile(2)` on this mount. `ops/local/up.sh` derives the map mount's numeric group and applies `compose.map-access.yml` / `map-worker.sh`: the non-root worker keeps that group through Nginx's `initgroups`, and `/map-data/` streams with `sendfile off`. The override preserves the image command and needs no image rebuild, migration or map-content change.
- Verified by `TMRKZ_OFFLINE=1 sh ops/local/up.sh web`, a web restart, full/ranged byte comparisons and the readiness tool's package/served checks (22 passes of 23 total; the one failure is no Stationing policy in force). The verification browser cannot provide WebGL2, so interactive canvas acceptance remains unverified; see `docs/evidence/map-delivery-20261117.md`.


## ADR-037 Two lasting platform accounts and one empty local installation — Accepted (2026-11-06)

**Context.** The owner chose to restart from an empty system, as on a first launch, with one application run like
production and no test accounts. Every earlier environment on the development machine was removed without a backup:
`tmrkz-mover`, `tmrkz-test`, `tmrkz-clean`, `tmrkz-load` and `tmrkz-v3dev`. The owner also chose two accounts that stay
active after deployment: «admin» (super administrator) and «developer», with the same rights. A person normally signs
in only when the directory login equals one active HR record (ADR-015/016). The bootstrap administrator (V7) is
temporary by design.

**Decision.**
- A platform account is a local Keycloak user of the `tmrkz` realm holding the realm role `tmrkz-platform`, never a
  directory user. The role travels in the ID token claim `tmrkz_roles`; the client's scope mapping lets only this role
  appear. TMRKZ accepts the account only when the installation also names the login in `TMRKZ_PLATFORM_ACCOUNTS`
  (compose default `admin,developer`). The manual directory path never qualifies.
- Its first sign-in creates a LOCAL person (`employee_no` `PLATFORM-<login>`) linked with method `PLATFORM` (V21). The
  person holds lasting «مدير النظام» and «مدقق السجلات» grants, made current again at every sign-in. The HR projection
  changes only HR people, so connecting HR or the directory never disables them. While they exist, the bootstrap
  administrator is refused, because an administrator exists.
- Revocation happens in the provider (remove the role or the user) or in the installation (remove the login from
  `TMRKZ_PLATFORM_ACCOUNTS`). The linked identity is then refused with `PLATFORM_REVOKED`. A conflict
  (`PLATFORM_CONFLICT`) is refused and audited, not placed on the review list.
- Passwords live only in the installation's `.env` (`TMRKZ_PLATFORM_ADMIN_PASSWORD`,
  `TMRKZ_PLATFORM_DEVELOPER_PASSWORD`). `ops/init-env.sh` generates random ones. `ops/platform-accounts.sh` creates the
  users, sets the passwords and assigns the role; it refuses a login a directory user already holds. The values chosen
  for the development machine are not in the repository.
- `ops/local/up.sh` runs the single local installation: project `tmrkz-mover` on :8088, built from the working tree,
  empty. Until the enterprise directory is configured, a local stand-in OpenLDAP holds only the users container and no
  people (`ops/local/compose.local-directory.yml`). The web image may opt into the Stationing V3 pages through
  `TMRKZ_STATIONING_V3` (default false). The offline map root comes from `TMRKZ_MAP_ROOT`.

**Consequences.**
- The fictional acceptance environment and its evidence history remain in the repository, but no environment runs
  them. `sh ops/test-env/up.sh` recreates it when needed.
- The weak passwords chosen for the development machine must be replaced in `.env` and set again with
  `ops/platform-accounts.sh` before any real deployment. The accounts are a deliberate break-glass path, so the
  Keycloak brute-force protection (5 failures) applies to them.
- Tests: `EnterpriseSignInIT.platformAccounts`. The test asserts creation, rights, refusal without the role, refusal of
  a login the installation does not name, renewal of an ended grant, a second account, revocation and audit.

## ADR-038 True offline 3D terrain: a display-only Terrain-RGB component and MapLibre's own terrain — Proposed, awaiting the owner's visual review (2026-11-06)

**Context.** Owner brief «TRUE OFFLINE 3D TERRAIN + TERRAIN-CONFORMING STATIONING UX» (6 Nov 2026, with two reference
images): the Stationing map must become real 3D terrain, fully offline, and every re-stationing geometry must lie on the
ground. That covers the current site, the proposed site, the primary and alternative deployment areas, occupied ground
and the other registered sites. The brief also asks for directional connectors with distance chips, cards on the
ground, terrain analysis with an elevation profile, and drawing and dragging in 3D. The installed package
`tmrkz-map-2026.11.1` carries only a grey hillshade PNG (no elevations), so true terrain was not possible with it.

**Decision.**
- **A separate VISUALIZATION product** (`ops/terrain/build_terrain_3d.py`, record `map-packages/terrain-3d-glo30-2026.11/`):
  - built from the same 28 approved GLO-30 source tiles, each checked against the terrain manifest's sha256;
  - elevations reprojected to Web Mercator 256 px tiles (bilinear at z12, mean of four children below), z6–12;
  - encoded as Mapbox Terrain-RGB at 0.1 m, PNG, one PMTiles archive (5,932 tiles, 208,669,916 bytes, sha256
    `c31bf31a…`); deterministic.
  - It never enters the database and never feeds a rule. The slope analysis (`terrain-analysis`, `9a91d9af…`) is
    unchanged and remains the only terrain input of Stationing rules.
- **Package `tmrkz-map-2026.11.2`**, format v1 with an OPTIONAL component `terrain-3d` (`visualization-3d/terrain-rgb.pmtiles` +
  its record). The verifier checks:
  - the record against the file and against the terrain provenance;
  - coverage: every z12 tile inside the bounds is present;
  - a decoded PNG sample with every CRC checked, and heights within the recorded range;
  - the style source rule: a `terrain3d` source exists exactly when the component does.

  `readiness.py --require-terrain-3d` FAILs a package without the component and range-checks the served file.
  2026.11.1 still verifies unchanged; an older installer refuses the new component. The build tree was not clean, so a
  release build must be repeated from a commit.
- **MapLibre's own terrain** (`components/map/maplibre/terrain3d.ts`):
  - a `raster-dem` source; `setTerrain` with exaggeration 1 (no visual exaggeration, §30);
  - a display-only elevation tint and shade, placed below roads and labels for the background in use;
  - a dark sky; camera pitch 55°.
  - Fill and line layers are draped by MapLibre itself. Markers and labels stand at the terrain height and fade when a
    ridge hides them.
  - No tilted image, no canvas transform, no extrusion.
- **Presentation only:**
  - the 2D/3D switch never touches the request, the edited geometry, its parts or its history (no Z coordinates, no
    migration);
  - drawing, dragging and click placement use MapLibre's terrain-aware pointer position, so in 3D a vertex is the ground
    point under the pointer.
- **Information on the ground** (`components/workspace/terrainCards.ts`):
  - one card per geometry on a stem, compact or expanded when selected, lifted clear of the editor's grab handle;
  - one chip per connector, in one order only: current → proposed (information only, no verdict), proposed → primary,
    primary → alternative;
  - arrowheads on every connector; no range rings.
- **Terrain analysis** (`components/workspace/TerrainPanel.tsx`), from two sources shown apart:
  - SERVER (authoritative): the existing `POST /stationing/terrain/assess` (read only) gives the class, shares,
    allowance and ranges. `TerrainAssessment` gains `meanSlopePct`/`maxSlopePct`: descriptive, from the same counted
    cells, read by no rule; the persisted check fields are unchanged;
  - ELEVATION tiles (display only): lowest, highest and centre height, and a profile of the selected connector.
  - A leg's verdict comes from the server's check when it checked exactly this geometry, otherwise a preview built from
    the server's analysis by the same rule as `DeploymentRules.leg`. Any disagreement is shown, never hidden.
- **Colours:** primary deployment amber (was green, which clashed with the green proposed site), alternative purple,
  current blue, occupied red. 3D uses brighter variants with translucent fills, stronger outlines and a halo on the
  selection.

**Consequences.**
- The production deployment-area default stays unset.
- The development environment `tmrkz-v3dev` uses fictional sites on real Hajar-foothill relief
  (`ops/test-env/dev-3d-terrain-seed.sql`) and the labelled acceptance initial area (policy `DEV-3D`).
- Evidence: `docs/evidence/terrain-3d/` (`tests/acceptance/terrain-3d.mjs`).
- Not deployed to any installation, not committed: awaiting the owner's visual review.

**Owner review, 6 Nov 2026 (direction accepted provisionally).**
- **Colours, permanent:** current BLUE, proposed GREEN, primary AMBER/ORANGE, alternative PURPLE, occupied/invalid
  RED — the same meanings in 2D and 3D.
- **Package:** `tmrkz-map-2026.11.1` stays immutable. `2026.11.2` is a development candidate until it is rebuilt from
  committed source and proven: deterministic rebuild, checksums, provenance, verify, install, rollback, readiness.
- **No new rule:** elevation and the profile are information only. No elevation threshold or new approval condition.
- **3D framing:** the camera fits all geometries with their real terrain heights at the target tilt and re-centres them
  (`fit3d`). It was checked on the owner's portrait (1080 × 1920) and landscape (1920 × 1080) screens with no geometry
  hidden by a ridge. A connector chip slides along its connector to stay clear of the cards.
- **«الانحدار» (owner request):** an optional layer colouring the ground by the policy's slope classes, green (flat)
  to red (steepest), to judge the ground while choosing where to draw:
  - computed in the browser from the 3D elevation tiles (custom tile protocol, Horn slope, z12, policy thresholds);
  - display only and off by default; the server's class of a drawn area remains the authoritative one;
  - its red and orange share hues with the occupied and primary meanings, so it sits under every geometry outline and
    carries its own legend.

## ADR-039 «الانحدار» as three colours inside the shapes being placed — Proposed, awaiting the owner's visual acceptance (2026-11-06)

**Context.** Owner, during the review of ADR-038: not the slope over the whole map; inside the drawn re-stationing site
only, changing as it moves, in green, orange and red.

**Decision.**
- The whole-map layer of ADR-038 (custom tile protocol, five colours, off by default) is removed.
- `lib/terrainRgb.ts` `slopeZones` cuts the shape into runs of one colour along its own edges; `SlopeInside` draws them
  as a GeoJSON fill under the outlines, so MapLibre drapes them like every other request geometry. A vector overlay was
  chosen over an image source because it needs no second draping path.
- It follows every drag frame, vertex edit and pointer move while drawing; on by default from the new-site step, in 2D
  and 3D, with the «الانحدار» button to switch it off. Coloured (owner): the site and the deployment areas being placed
  in the request. Never coloured: the current site and what is already deployed. The legend's sentence and shares are
  about the shape being edited.
- The limits are the administrator's (owner): `slopeDisplay` (`greenBelowPct`, `redFromPct`) in the versioned Stationing
  policy, checked and published like every other value, under «طبيعة الأرض» in «سياسة التمركز». They are independent of
  the slope classes, so changing them changes no rule. Absent (every version before it): 10 and 30.
- Wording: the owner set the red sentence «مسموح مع الحذر من الانحدار» and the red legend word «مرتفع أو منخفض شديد».
  The rest is this ADR's default: green «مناسب للتمركز هنا» and «مناسب», orange «ممكن، مع الحذر من الانحدار» and «بحذر».

**Unchanged.** Display only: computed in the browser, nothing sent or saved, no rule reads it and it blocks nothing.
The sentence follows the colour with the most ground, moving or at rest, so it always matches what is painted; the
server's class stays in the terrain panel and can differ, because its classes and the display limits are separate.

**Site names and symbols on the map (owner, same review).** A request's current site is one object: the request draws
its boundary, the registered-sites layer its symbol and one name saying «الموقع الحالي» (it was drawn twice, with two
names and a mixed outline). Every name stands on a white plate, with what it is and its unit count under it. Every site
keeps a location symbol at every zoom (the marker used to vanish past zoom 14.5). Unit symbols on the map are not part
of this.

**Open owner choices.** The initial 10 and 30 are this ADR's default, not an owner value. Measured limits and the options
for narrow steep ground: `docs/evidence/terrain-3d/slope-inside/README.md`.

## ADR-040 One terrain value on a maximum, in an amount or a percentage — Proposed, awaiting the owner's acceptance (2026-11-06)

**Context.** Owner, on «سياسة التمركز»: no row per terrain class. Tick «إضافة طبيعة الأرض تنطبق» and give one number (km, m or a percentage) that gives more on ground that is not flat, for distance and for area, by the ground of the place being moved to.

**Decision.**
- `StationingPolicy.TerrainExtra` (`ABSOLUTE` in metres or m², or `PERCENT` of the maximum), on each leg (`Leg.terrainExtra`) and on the footprint (`footprintTerrainExtra`).
- It applies to every class but the first of the classification (the one from 0 %). So undulating ground already gets it. It only adds; the minimum never moves.
- A leg is judged by the ground of its deployment area, the site by the ground of the proposed place, never by where the unit is now.
- The footprint's maximum now depends on the terrain, so the check on the server reads the class of the proposed place when the policy has this value. With no terrain answer it stays the base maximum.

**Earlier versions.** A leg with no `terrainExtra` keeps its allowance per class (ADR-038 and before), so a request stays on the rules of its version. `terrainAllowancesM` is only required by such a leg. The page no longer edits it.

**Limit.** A shape that moves from flat ground to a hill gets its larger maximum after the drop, when the server's class arrives; the server's check on save decides.

## ADR-041 The workflow studio as a logical flow chart, with places found per request — Proposed, awaiting the owner's acceptance (2026-11-06)

**Context.** Owner: remove the studio and start again as a real logical flow chart that can be redrawn easily, with what happens on yes or no, for an organisation of many levels and thousands of units: who is responsible at each step, requests that must pass one place, a final approval, and who is told at the end. The old studio was an ordered list of stages.

**Decision.**
- **Editor:** React Flow (`@xyflow/react` 12.10.1, MIT, bundled, no network). Chosen over bpmn-js because it suits a builder for non-specialists, and BPMN is produced by our compiler anyway. Research was directional (blogs and vendor pages), so the choice was proven by `tests/acceptance/flow-studio.mjs`, not by the sources.
- **Definition:** an additive `graph` (`nodes`, `edges`) in the versioned definition. Step types: start, approval (approved and optional rejected line), decision (yes and no), notify, parallel, join, approved end, rejected end. Approval steps are derived as the definition's `stages`, so tasks, route views and carried approvals are unchanged.
- **Engine:** compiled to BPMN for Flowable (`BpmnCompiler.compileGraph`), still with only fixed `moverWf` expressions. A rejected line sets `outcome_<key>` and completes the step; a rejected end terminates the whole process and writes `request_flow_end`, which closes the request with nothing approved or reserved.
- **Places (`PlaceResolver`):** the unit of the requester, UP n levels, AT_LEVEL, FIXED, RESPONSIBLE, RESOURCE_ORG, ANY. A step whose selector finds no unit stays open to any holder of the role in scope; it is never skipped, and the check reports those units.
- **Responsibilities (V23):** a duty and rules «every unit under X → Y». The nearest rule above a unit wins, so a few rules cover any number of units.
- **A step going to a unit binds to that unit (`task_assignment.strict_place`):** only those who hold the role at that very unit may decide it, even when the role's reach is all units. Without this, a chosen unit meant nothing for the roles whose scope is ALL (found when a reviewer of one unit decided a step of another). Tasks of definitions from before the chart keep the role's reach.
- **Publishing rules (`GraphValidator`):** one start; no loops (a request returns to its requester through «إعادة للتصحيح», on every approval); nothing unreachable; parallel branches close before the final approval; no path to an approved end without a final approval by a role with APPROVE; no approval or rejection after it. Publishing opens only after a clean check with no edit since.
- **Try it:** on a real unit and sample values: the route lit on the chart, the unit and number of holders per step, what a rejection would do, and which units find nobody.
- **One approval climbing the hierarchy (owner, same day):** an approval step may carry `chain`, so a flow need not know how many levels exist. It runs one after another from the requester's parent (or the unit itself) and stops at the main unit, the first of chosen levels, the top, a number of approvals, or one unit. A branch with no flagged unit stops at its top. A requesting unit at or above the stop has nothing to climb and the step is passed. Units with no holder are skipped by default; if there are units to climb and nobody holds the role in any of them, the step stays open to the role and is never approved by nobody. A rejection at any unit ends the climb. It cannot be the final approval. `hr_unit.is_main` (V24) comes from the source through the mapping, and levels offered are those in the published snapshot, never a fixed list.
- **Questions about the requesting unit:** `requesterIsMain`, `requesterHasParent`, `requesterLevel`.

**Kept.** Every published version stays as it is, and running requests stay on theirs. A definition from before opens as the chart it means. The old screen is in git history.

**Limits.**
- A main unit with a holder of the role signs in the climb. The movement programme stops below the main unit; the owner's decision is pending (`docs/reports/mover-permissions-study.html`, decision 3).
- A chart cannot loop back to an earlier step.
- A step moved in a parallel branch is not reordered by the layout beyond layers; «ترتيب تلقائي» is a starting point.
- After a separation-of-duties reassignment a person may be chosen who does not hold the role at the unit; not exercised.
- Notices are in-app only.
- Chart steps other than «by scope» count a person at a unit their grant names, not at every unit below it (ADR-042).

## ADR-042 Approvals found by a grant's scope, and for-information by place, as in the movement programme — Proposed, awaiting the owner's acceptance (2026-11-06)

**Context.** Owner: study how the movement programme (`~/Desktop/mover`, read only) places its approvals and «mimic everything». Asked which way to go on each open question, the owner answered that the answers are in the programme itself. Study: `docs/reports/mover-permissions-study.html`. The owner's own additions: a scope may be chosen by levels, and for-information reaches a unit at the place while its main unit is elsewhere, naming both.

**Decision.**
- **The climb:** starts at the requester's parent, as a unit never approves its own request, and ends below the main unit, which only groups its units and is never a station. A level where the requester is the only holder is passed. A level with nobody refuses the request before it is sent, unless the flow chooses to skip such levels.
- **Levels in a scope (V25, the owner's addition):** a unit target with descendants may carry `levels`, kept as levels and worked out from the published HR snapshot when the grant is read (`GrantSource.reach`). `RawGrant.spec()` gives everything else plain units, so scope checks and OpenFGA tuples need no new concept. Not offered to a final approver.
- **A step «by scope» (`orgFrom: BY_SCOPE`):** stands on the requesting unit and goes to those whose grant of the role reaches it, the nearest grant only (`PlaceResolver.scope`), so a branch can have its own approver. The first valid approval closes it.
- **No approver, three outcomes:** nobody holds the role under the main unit: the command has no such step and the request goes on, except that a final approval is never passed. Someone does but not for this unit: refused before sending (`WorkflowService.scopeProblem`). The approver is lost later: the step waits for the access managers (`TaskRealignment.separate`), not for nobody.
- **By time (V27):** a command may name periods and receiving units for «معتمد عمليات الوحدة». The nearest command up to the main unit that has any decides, in Dubai time. The routed unit's own people act, among those whose grant reaches it. A time no period covers refuses the request. The units are pinned on the task (`scope_orgs`), so a later edit affects new requests only. A receiving unit must lie inside the command.
- **Independent of earlier approvals, with no switch:** in a chart, nobody who approved another step, or whom they acted for, decides a by-scope or final step (`SeparationOfDuties.earlierApprovers`, compared by the human). Levels of a climb do not bar each other. Definitions from before the chart are unchanged.
- **Where a grant is held:** a chart step going to a unit counts the units a grant names; a grant naming units no longer counts at its home organisation. Before this, custom scopes had no effect on chart steps.
- **The matrix and «تعيين»:** `UnitMatrix.tsx`: a unit's people in rows and the roles in columns, saved at once. A role that approves, and for-information, has a button reading how many units it covers (`UnitsDialog.tsx`). The tree starts at the main units the granter may reach, as does the search. A new unit starts as «الوحدة فقط»; a final approver takes a whole unit or every unit. A changed scope ends the old grant and makes the new one together (`GrantAdminService.replace`), so history stays.
- **For information (V26, `PlaceInfo`):** on final approval, each holder of `FYI_RECEIVER` whose scope covers a party gets one row in `request_fyi`: who is told is who may read, and it records who read it. The parties: the requesting unit and its main unit, the units at the place (stationed, linked or responsible; walking up the sites, the first level with units answers) and their main units, the units the requester chose, and the main commands chosen explicitly (`fyi_main_command`). The role gives nothing before the final approval whatever its scope, and only the summary after it. Others at an informed unit see nothing by it. A re-stationing activated at a place sends the same parties a notice naming the unit and its main unit.
- **Roles as data:** `ops/policy/approval-roles.json`, published through the role policy.

**Not copied.** Movement stages, provision, routes, movement windows and the operational picture: outside TMRKZ's administrative scope.

**Not built yet, though they are in the programme.** Duty permits, the page access table, the ten separate rights of an access manager, adding a party to for-information by hand, the final approver's structured return, and rank and condition rules on dynamic permissions.

**Limits.**
- A grant limited by both organisation and site is matched by its organisation when finding the nearest; the site is still enforced when deciding.
- Re-stationing keeps its own stages and seats; only the notice is shared.
- A changed hierarchy reaches a levels grant at once in the database and in OpenFGA within the 5-minute reconcile; not exercised.

## ADR-043 Light and dark colours, chosen by the person; one palette with the sign-in pages — Proposed, awaiting the owner's acceptance (2026-11-06)

**Context.** Owner: choose between dark and light, with one set of colours in and out of sign-in. Inside was a dark navy console with light pages, and sign-in was sand and brown. First built with a teal light theme; the owner then chose: the sand of the sign-in page, across the whole application, and the dark one as built.

**Decision.**
- **The choice:** a switch in the top bar and on both sign-in pages, kept in the browser (`tmrkz-theme`), the same key on the application and on the identity page. With no choice, the sand. It is set on `<html data-theme>` before the first paint (`lib/theme.ts`, and `theme.js` on the identity page, because the page's security policy allows no inline script).
- **One palette:** light is the sand: beige ground, cream panels, brown primary buttons, and the sign-in page has its original values. Dark is navy and teal. `signin.css` and the Keycloak `tmrkz.css` use the same values. The colours of the two themes are in `theme.css`.
- **The older stylesheets stay as they are:** `prototype.css` must remain verbatim, so `ops/tools/gen-theme.py` generates `theme.generated.css`, overriding their fixed colours per theme: surfaces and text follow the theme, greys warm up and the teal accent becomes brown in the sand, and a saturated colour that means something, such as a status, stays. Run it after changing a stylesheet.
- **Measured, not judged:** `tests/acceptance/theme-contrast.mjs` measures the contrast of all visible text on the real pages in both themes, against WCAG AA.

**Kept from the original sign-in page, changed once:** the small labels of its guidance notes are brown rather than gold, because gold on white was too faint to read. **Limits.** Maps keep their own colours in both themes, and the unit symbols keep theirs. Text inside maps and drawings is not in the measure, and a gradient is measured by its most opaque colour. Measured on what the pages show with this data; a state not on screen, such as an open dialog, is not measured.

## ADR-044 Asking for permissions, through the same request engine — Proposed, awaiting the owner's acceptance (2026-11-06)

**Context.** Owner: anyone can sign in but sees nothing, then asks for permissions; build it as in the movement programme, or say if there is a better idea used widely. There, a person with no access reaches only the page to ask; a request is not a grant; a local reviewer advises and only the final approval grants; what was asked, advised and granted are kept apart.

**Decision.**
- **The same engine, not a separate one (the better idea put to the owner):** the programme has its own table and fixed route for this. Here a request type of kind `ACCESS` runs through the same chart, tasks, notices and audit as any request, so its path is drawn in «مسار الموافقات» and can change without code. Only its form and its effect are its own.
- **No permission, one page:** a person with none has only «طلب صلاحية», whatever the address (`App.tsx`). The server was already refusing the rest.
- **Asking (`AccessRequestService`, V28):** for themselves, at their unit from HR, from a fixed list: مقدم الطلب، معتمد السلسلة الهرمية، معتمد عمليات الوحدة، للعلم. One open request per person. It needs a type of kind `ACCESS` with an active path; only one such type exists.
- **Deciding:** the reviewer's list is advice and grants nothing; the final approver's list grants. Both may differ from what was asked. The ordinary decision checks apply: the person may not decide their own, nor anyone who approved earlier decide the final.
- **Granting:** on final approval, the roles granted become grants at the person's unit with each role's own default reach (`GrantAdminService.applyAccessRequest`). Wider reach is given afterwards with «تعيين».
- **Roles as data:** `مدير صلاحيات الوحدة` (manage access and review, over the unit and its branches) and `معتمد طلبات الصلاحية` (review and approve, over everything), in `ops/policy/approval-roles.json`. The reviewer reads no other request.
- **No reviewer:** a review step of `مدير صلاحيات الوحدة` with nobody, or only the applicant, is passed and goes to the final approval, which is told so.
- **Kept apart:** permission requests appear in no request list, count or report, and their tasks only on «طلبات الصلاحية».

**Differs from the programme.** If HR moves the person while the request waits, the programme re-routes it to the new unit's reviewer. Here the approval is refused and says where they moved; the reviewer rejects it and the person asks again.

**Amended 2026-11-06 (owner, V29).** As in the programme (`self_requestable_keys`, `grantable_keys`):
- **What is shown is a setting.** `access_request_offer`: for each role the system administrator chooses «تظهر لأي شخص جديد» or «يضيفها مدير صلاحيات الوحدة فقط», or leaves it out (button «الصلاحيات المعروضة للطلب» on this type, needs `CONFIGURE`). It starts with the four earlier roles shown to everyone. At least one must be shown to everyone. Roles of scope `ALL` and roles holding `CONFIGURE` or `MANAGE_ACCESS` can never be offered. This narrows the programme, whose final administrator can grant any non-system key.
- **Extras.** The manager's list appears only in review; adding is advice like the rest, and the final approver sees and may grant it. The programme's list comes from each reviewer's authority; here it is this one setting.
- **No deadline.** The owner asked what the deadline does. It never decided anything: it raises a late notice and a count. The programme's access requests have none, so this type shows no deadline on its cards or step, raises no late notice and counts in no late report. The hidden `slaDays` value stays because the shared validator needs it.
- **Sign-in is unchanged.** First sign-in links to the one HR person whose domain account equals the directory login, with no list of names to maintain; a person with no match goes to the review list. This install's stand-in directory holds no people, so it has not run with people from Oracle.

**Limits.** A person with no HR unit cannot ask. Exercised with fictional people in the temporary environment; people from Oracle cannot sign in yet.

## ADR-045 One request engine: access, site bootstrap, initial stationing, deployment areas, stages, FYI, posture — Proposed, for owner review (2026-11-07)

**Context.** The owner's brief wants TMRKZ usable from a nearly empty installation: ACCESS → SITES → LINKS → INITIAL STATIONING → DEPLOYMENT AREAS → RE-STATIONING → APPROVALS → FYI → ACTIVATION → READ-ONLY POSTURE, as one application, with MOVER's button behaviour. Audit found that V3 re-stationing had no unit operations stage and no chosen FYI, that deployment areas keyed on a request and were never read back, that nothing could say which actions a unit had, and that sites, links and corrections had server paths with no page.

**Decision.**
- **One engine.** `restationing_request.purpose` carries RESTATIONING, INITIAL_STATIONING, DEPLOYMENT_AREAS and SITE_REGISTRATION through the same revisions, return, selective re-approval, hierarchy drift, route and activation. The same editor serves all four. No second workflow.
- **Separate permissions for separate requests.** «(صلاحية مُلغاة)», `CREATE_RESTATIONING`, `REQUEST_SITE_REGISTRATION`, `DECIDE_UNIT_OPERATIONS`, `FINAL_APPROVE_STATIONING`, `MANAGE_FYI_DISTRIBUTION`, `VIEW_OPERATIONAL_POSTURE`. Existing ones are reused otherwise (`docs/STATIONING_REQUESTER_AUDIT.md`). No new OpenFGA structure: the generator adds relations per permission.
- **Stages are policy, holders are grants.** `StationingPolicy.approvalStages` (`unitOperations`, `finalByPermission`, `fyiBeforeActivation`), null on every earlier version, so a request stays on the rules of its pinned version. No level, person or holder is named in code.
- **Deployment areas belong to a unit's stationing record.** `deployment_area.organization_id` and `stationing_id`, one row per unit. Two units sharing a site hold different areas; approving one never touches the other. A permanent move and a correction retire the areas with the record; an extension carries them forward.
- **Eligibility is the server's.** `GET /request-hub`: NO_STATIONING, DEPLOYMENT_MISSING, DEPLOYMENT_REQUEST_PENDING, DEPLOYMENT_COMPLETE per unit, with each action's reason. A right the person lacks yields no action. Every operation checks again.
- **A re-stationing needs a stationing.** The server refuses to submit one for a unit stationed nowhere; such a unit asks for initial stationing, on a registered site.
- **Site registration.** Nothing changes before activation. An overlap with a registered site is reported and blocks (except the chosen parent), then checked again at activation. Activation registers the site once, with the requesting unit as its responsible context and one link; a link is not stationing.
- **FYI.** `restationing_fyi`: chosen units, audited, notified. People affiliated to them read that one request. No membership is written.
- **Posture.** `GET /operational-posture` returns the units the right reaches with their site, kind, own areas and a request's state. A unit outside the reach at the same site is counted, never named. It opens no action.
- **Access requests.** The offered list stays the system administrator's (ADR-044). A request carries a scope (`UNIT`, `UNIT_TREE`, `UNITS`, `SITES`); `ALL` cannot be asked for and only a global access manager may give it at the final approval. A reviewer recommends for or against; a return is the same request, sent again. The final approval checks the person, the unit, the permissions and the scope against today.
- **Bootstrap.** «تهيئة المواقع والتمركز» uses the existing audited paths with a written reason: `MANAGE_FACILITIES`, `MANAGE_SITE_LINKS`, `CORRECT_STATIONING`. A site may name no responsible organisation, and then only a manager of everything may register it.

**Choices made without the owner, each reversible.**
- `SITE_REGISTRATION` names the requesting unit as responsible, since approved humans identified it; no separate field.
- A final access approver grants from the offered lists, not any non-system role as MOVER's administrator can.
- A site that is only a marker measures deployment from its point: the client sends a one-metre footprint as reference, and the server measures from the register.
- Initial stationing is permanent, because a temporary one needs a permanent base to return to.
- A deployment request is one unit at a time.

**Not changed.** Oracle's hierarchy, sites independent of it, link not stationing, no movement of descendants, no distance rule current→proposed, the map editor, no best-site logic. Light and dark themes both stay: the brief asks for the dark design and the owner earlier asked for the sand light theme by choice; the chooser keeps both.

**Migration.** V30. Proved on a throwaway database by `ops/sql/checks/V30-upgrade-check.sh` (clean path, and upgrade path with legacy rows, every row kept). Applied to `tmrkz-mover` on the owner's direct instruction of 7 Nov 2026 after a verified backup.

**FYI access (owner correction, 7 Nov 2026).** Reading is per request and per chosen unit, through `restationing_fyi`; it writes no grant. A person with no permission opens it by its address and from their own page. It ends when a holder ends it with a reason, when the person leaves the unit in HR, and when the request is cancelled before activation or lapses. Parents, children and siblings of the chosen unit inherit nothing.

**Flow Studio's page has its own rollout (owner, 7 Nov 2026).** The workflow engine is not affected. `TMRKZ_FLOW_STUDIO_UI` (default false) builds the page in; :8088 was built with it true because the owner uses that page there. «الصلاحيات المعروضة للطلب» is also in «مركز الصلاحيات», so it does not depend on the studio.

**Limits.** See `docs/evidence/stationing-next/MORNING_HANDOFF_AR.md`.


## ADR-046 Each stationing request type has its own path on «مسار الموافقات» (owner, 7 Nov 2026)

**Decision.** The four stationing request types appear beside «طلب صلاحيات» on the page. Each has its own path: the Oracle levels that approve, the last level, where the path starts, and whether unit operations, a separate final approval and the FYI step follow. It is saved as a draft, tried on a unit (which also counts who could decide each stage now, as a guide), and activated with a reason (`stationing_route_version`, V31). The chart is drawn from those settings and is read-only: only `ACCESS` uses a hand-drawn graph.

**In force.** A request pins the version in force when it is first sent (`restationing_request.route_version_id`); returning and resending keeps it. A type with no activated version follows the stationing policy's route as before, so V31 changes nothing until someone activates a path. Distances, terrain and footprint stay in the stationing policy: a request still needs a policy in force.

**Not decided here.** No levels or holders are seeded. A path names levels and stages, never people; who decides is what the grants say. Cross-branch stages remain policy settings.

## ADR-047 The map package and its records come from a clean build on the current host (owner, 7 Nov 2026)

**Decision.** `tmrkz-map-2026.11.2` is built from a clean commit on the current host, twice, and installed only when both builds are identical. The earlier Windows build is not used and is not needed. This settles the open question in `docs/STATUS.md` of which build host defines the record.

**Consequence.** The terrain records now hold the new checksums, with the earlier ones kept under `buildRecord.earlierBuild`. The slope product is the dataset already loaded on :8088 (`8905e73c…`), not the `9a91d9af…` accepted in `2026.11.1`. Pixel and nodata counts are equal in all 28 cells; pixel-by-pixel equality with the Windows build cannot be shown.

**Rejected.** Reloading the business terrain (it stays unchanged on :8088), and keeping the old records while installing different bytes (the builder refuses that, correctly).

## ADR-048 «موقع جديد» follows MOVER's step-by-step card; the site list sits on the right (owner, 10 Nov 2026)

**Decision.** Adding a site in «تهيئة المواقع والتمركز» works as MOVER's «المواقع» drawer does (`app/NavMap/src/places-ui.js`, «موقع جديد», MOVER owner direction of 1 Nov 2026: simple enough for a child): three steps — «البيانات», «الرسم», «الحفظ» — with one numbered question per card. Step 1 asks the name and code, the type (quick choices «معسكر», «موقع قيادة», «منطقة داخلية», «بوابة», or «نوع آخر…»), where it lies («موقع رئيسي» or «داخل موقع آخر», chosen from the registered sites) and, optionally, the responsible unit. Step 2 chooses «منطقة لها حدود» or «نقطة واحدة», then draws on the map or types the coordinates (one corner per line; the boundary is recorded with method `COORDINATES`). Step 3 reviews everything, including the area, and asks the reason. «التالي» refuses to go on and says why until the step is complete. The finish card offers the site's card, another site, or closing. The site list has a search box. On this page the site list is on the right and the card on the left (`OperationalWorkspace swapSides`).

**What stays TMRKZ's.** Saving is the direct, audited register entry of ADR-045: the server checks `MANAGE_FACILITIES` for the responsible unit (or everywhere when there is none) and creates the site and its boundary as one act. MOVER sends a new place for approval; TMRKZ's setup does not, and its site registration request remains the approved path for everyone else. MOVER's usage and visibility scopes, aliases, gate details and symbols are not part of a TMRKZ site and were not copied. Units based at the site are still set from its card («تثبيت»), after saving.

**Also.** 3D on this page tilts the camera even when there is no site to frame, as on «الموقف».

**Later the same day (owner, 10 Nov 2026).** The steps sit in the site list, directly under «＋ إضافة موقع», and the site's own card stays on the left. No code is asked: the server gives the next `S-0001`-style code under a transaction lock and keeps a code typed through the API (no migration). The responsible unit is chosen from the unit hierarchy (`OrgTree`, loaded one level at a time, with a search across every branch). Drawing is free: as many corners as needed, closed on the first point, a double click, Enter or «إنهاء الرسم» (`SiteEditor` target 0; the re-stationing editor keeps its count). «اكتب الإحداثيات» is a table, one point per row, in any coordinate format — automatic detection, decimal degrees, degrees and minutes, degrees-minutes-seconds, UTM, MGRS, Arabic digits — chosen or detected; a row takes its position from the map, moves up or down, has a point inserted after it or is removed, and the points are joined in order; changing the format rewrites the rows without moving a point. The coordinate mathematics is MOVER's `app/NavMap/src/coords.js` (same owner), ported as `lib/coordFormats.ts` with MOVER's PROJ and `mgrs` golden vectors. The side panels move to the other side, widen and fold to a strip (`OperationalWorkspace panels`, remembered per browser), and every card folds on its title.

**The site symbol (V32, owner approval of 10 Nov 2026).** «رمز يظهر على الخريطة (اختياري)» in step 2, as in MOVER: MOVER's curated MIL-STD-2525C catalogue drawn offline by the bundled milsymbol, a search, «بدون رمز» and a code typed by hand. Stored in `site_symbol` (code, standard, who and when); changed or cleared from the site's card with a reason (`PUT /sites/{id}/symbol`, audited `SITE_SYMBOL_SET` / `SITE_SYMBOL_CLEARED`); drawn on the map in place of the plain site mark. Display only. **Not offered, and refused by the server:** MOVER's tactical graphics and control measures (route points, checkpoints, gates, supply and fuel points — the `G…` codes, APP-6D set 25) and METOC, which fall under the scope exclusion of tactical graphics; they can be reconsidered only by an explicit owner decision that they serve the facility register.

**Final arrangement (owner, 10 Nov 2026, evening).** The data on the left, the work on the right: the site list («المواقع», its search and «لا مواقع بعد») is the left panel; the right panel is «تهيئة الموقع» with «＋ إضافة موقع», and under it either the steps, filling the panel's whole height with «التالي» kept at its foot, or the chosen site's card (data, boundary, symbol, «تثبيت», links). This supersedes the earlier placements in this ADR.

## ADR-049 «إضافة مستخدم» in «مصفوفة الوحدات», as in TNQL (owner, 11 Nov 2026)

**Decision.** The access manager adds a user to a unit the way TNQL's access workspace does (`app/static/js/admin-access-workspace.js`, «إضافة مستخدم»): choose the unit, press «إضافة مستخدم», then either search the HR mirror by military number or User ID and read the HR card, or add a User ID without HR («إضافة رقم المستخدم بدون ربط الموارد»). Saving puts the person in the unit **with no permission**; the matrix shows the empty row, highlighted and focused, and the cells are ticked afterwards through the existing grant rules (owner's choices: "Also add by User ID without HR", "Add with no permissions").

**How.** V33 adds `unit_member` (person, unit, `acting`, who and when, ended with a reason). An entry grants nothing; it makes the person a member of the unit for the matrix and for the manager's directory (`DirectoryScope.MEMBER`, the people search). A User ID without HR is a LOCAL person `USER-<login>` whose first directory sign-in under exactly that login links to it (`IdentityService.localUser`, link method `LOCAL_USER`, V33); an HR match always comes first; the placeholder name takes the directory's display name. Endpoints: `GET /access/unit-members/lookup`, `POST /access/unit-members`, `POST /access/unit-members/{personId}/end`. Audit: `UNIT_MEMBER_ADDED`, `UNIT_MEMBER_ENDED`, `LOCAL_USER_CREATED`.

**Bounds (no escalation).** The HR search finds only people already inside the manager's directory; unknown, inactive and outside give the same 404, so the search reveals nothing (TNQL's rule). A User ID held by an HR person is refused (search for them instead); one held by an account outside the manager's reach, by a platform account or by the temporary first administrator is refused, so nobody takes over another manager's account. Ending an entry never ends a grant.

**Changed from the earlier rule.** Until now everyone outside HR was refused at sign-in. A User ID added here is the one exception, and it is visible: the row is marked «بدون موارد», the account holds only what an access manager granted, and its creation is audited.

**Not done (TNQL has them).** Editing the account card (name, rank, phones), «حساب نشط» as a switch, bulk add/remove of one permission over ticked rows, the staged «حفظ التعديلات» with one audit reference per batch (TMRKZ saves each cell at once, as before), and HR live lookup against Oracle (TMRKZ reads its hourly HR mirror).

## ADR-050 Desktop notifications, as in TNQL (owner, 11 Nov 2026)

**Decision.** Windows toasts from the browser, exactly TNQL's way (`tnql-desktop-notifications.js`, `sw.js`): a service worker at `/sw.js` (root scope, no caching) draws them; the page polls `GET /api/v1/notifications/desktop-feed?since=N` every 30 s and when the tab becomes visible. No Web Push: the installation is isolated and the browser's push service is unreachable.

**Rules taken from TNQL.** Permission is asked on the first click or key press, never by a banner; an unanswered prompt is asked again after 7 days; a refusal is respected. On grant one confirmation toast: «تم تفعيل إشعارات سطح المكتب. ستصلك التنبيهات هنا.». The cursor is kept per person in the browser; the first poll only reads the current number (no replay); at most 5 per poll, oldest first; the cursor moves before drawing, and the tag `tmrkz-<person>-<seq>` makes several tabs replace instead of stacking. While the page is visible and focused nothing is drawn. The title is always «تمركز — إشعار جديد» and the body a fixed lock-screen-safe line per kind; the notification's own text, request number and names never appear in a toast. `requireInteraction` for kinds that ask the person to act (returned, overdue, assigned, re-aligned, routed). A click focuses an open window and opens the target (the request list, or the re-stationing request of an information copy). On a shared PC another person's sign-in closes the previous toasts, and the sign-in page closes all.

**How.** V34 gives each notification an increasing `seq` (ids are uuids); `DesktopFeed` builds the answer; `frontend/public/sw.js`, `lib/desktopNotifications.ts` (started in `App` for the signed-in person), nginx serves `/sw.js` with `no-cache` and `Service-Worker-Allowed: /`, icon `notify-icon-192.png` (the application icon as PNG).

**Limits.** Browsers allow this only in a secure context: on the server itself `http://localhost` works; other PCs need the application served over **https**. TNQL's optional native Windows agent (`tnql-notify-agent.ps1`) and its in-page SSE channel with sounds are not reproduced. TMRKZ creates no notification when a request starts waiting for someone's approval (TNQL's main «لديك إجراء مطلوب»); approvers see such tasks in «المراجعة», not as a toast, until that is added.

## ADR-051 https served by TMRKZ itself, as TNQL; the certificate from the internal CA by request (owner, 11 Nov 2026)

**Decision.** TMRKZ serves https itself, the way TNQL does (`compose.yaml` service `proxy`, profile `tls`, `tools/offline_release/proxy/mover.conf.template`), instead of relying on a reverse proxy the organisation would have to provide (owner's choice "Built-in, like TNQL"). The certificate comes from the organisation's internal CA (the same Active Directory Certificate Services hierarchy TNQL trusts) through a certificate request made on the server, so the private key never leaves it (owner's choice "CSR for the internal CA").

**How.** Service `proxy` in `docker-compose.yml`, profile `tls`: the web image's nginx (no further image in the offline bundle) with `ops/tls/proxy.conf.template`; TLS 1.2/1.3, HSTS, session tickets off, plain http on port 80 only redirects; `server.crt`/`server.key` from `TMRKZ_TLS_DIR` (default `ops/tls/private`, never committed). Steps: `ops/tls/make-csr.sh` (RSA 2048 by default for the «Web Server» template; DNS and IP names in subjectAltName; an existing key is never replaced), `ops/tls/install-cert.sh` (PEM, DER or PKCS#7; refuses another key, a missing name, no server authentication, expiry, or no chain to the given root; installs the certificate with its issuing CAs), `ops/tls/enable.sh` (copies `.env`, sets `TMRKZ_PUBLIC_URL=https://…`, `MOVER_SECURE_COOKIE=true`, `COMPOSE_PROFILES=tls`, `MOVER_HTTP_BIND=127.0.0.1`, `TMRKZ_HTTPS_PORT`, and the new address in Keycloak's client through `ops/keycloak/set-public-url.sh`, because the realm took the address at its first start). The web entry point passes the original scheme on (`X-Forwarded-Proto` map) so Keycloak and the backend see https. `ops/local/up.sh` checks readiness on the local port, since an https name may resolve only in the organisation's DNS.

**Why not the organisation's proxy.** It remains possible (`docs/INSTALL_AIRGAPPED.md`), but it adds a device and a team to every install and upgrade; TNQL already runs its own on the same network.

**Checked.** `ops/tls/test-tls.sh` with a throw-away test CA (root and issuing CA, as AD CS): 18/18 — the request, the three refusals, DER and PKCS#7 input, the chain without the root, trust through the CA only, TLS 1.1 refused and 1.3 offered, the application, backend and identity provider through https, HSTS and the redirect. Not yet: the real certificate, the organisation's DNS name, and a browser sign-in over https (they need the issued certificate).

## ADR-052 Switching to the enterprise directory after the first start (owner, 11 Nov 2026)

**Decision.** The second step of the real-environment setup connects TMRKZ to the organisation's Active Directory. The owner chose to copy TNQL's directory settings; on this PC TNQL has none (`LDAP_ENABLED=False`, `KEYCLOAK_ENABLED=False` in its `mover-state/config/.env`), so only the organisation's CA chain was taken (TNQL's `ca-certs/ghq-ca-chain.crt`: one root and three issuing CAs, split into `ops/keycloak/truststores/organisation-ca-0N.pem`, git-ignored). Server, service account and users DN come from the organisation.

**How.** Keycloak took the directory settings once, at its first start, from the stand-in directory. `ops/keycloak/set-directory.sh` points the federation «enterprise-directory» and its username and employee-number mappers at the directory in `.env` (Active Directory: vendor `ad`, `sAMAccountName`, `objectGUID`, RDN `cn`, classes `person, organizationalPerson, user`). It first runs Keycloak's own tests through its truststore — the connection with the directory's certificate verified, then the service account's bind — and changes nothing unless both pass and `CONFIRM=yes` is given; `ldap://` without StartTLS is refused. `ops/local/up.sh` leaves the stand-in out once `.env` names a real directory, so the backend's manual sign-in and Keycloak use the organisation's CA (`TMRKZ_TRUSTSTORE_DIR`, default `ops/keycloak/truststores`). The backend already reads `objectGUID` as binary.

**Checked.** Rehearsal against the stand-in (tests only, `ALLOW_STANDIN=yes`, never applied): right password PASS/PASS and nothing changed; wrong password «FAIL bind»; unknown host «FAIL connection»; applying to the stand-in refused. The update commands re-applied with the stand-in's own values left every value of the federation and mappers as it was.

**Open.** The directory's address, the read-only service account and its password, the users DN and the employee-number attribute, from the organisation's IT; then the three commands in the `.env` block; a first directory sign-in; and the identity link to the HR mirror (step 3).

## ADR-053 «مركز الدعم» and «لوحة الدعم», as TNQL's support centre (owner, 11 Nov 2026)

**Decision.** The owner asked for TNQL's support and AI capabilities and chose the order "support + knowledge first" (assistant later). «مركز الدعم» (open to everyone signed in, also to someone with no permission yet) has the doors «ابحث في دليل تمركز» and «أبلغ عن مشكلة», and «بلاغاتي». A case has a number `SUP-YYYY-NNNN`, a category (9), a priority with a response time (critical 1 h, high 4 h, normal 24 h, low 72 h, as TNQL), the screen the person came from and the browser's own facts — never a request's contents. «لوحة الدعم» is for support seats («موظف دعم», «مشرف دعم»): the queue by priority and response time, take, assign (supervisor), priority, public reply or internal note, resolve with a written solution, close; the person confirms or reopens. «مقاعد الدعم» are given by a configuration administrator (supervisors) or a supervisor (agents).

**How.** V35: `support_seat`, `support_case`, `support_message`, `support_event`, and `notification.link` so the bell and the desktop toast open the case (`#support/<id>`, `#supportConsole/<id>`). `SupportService`/`SupportController` (`/api/v1/support/...`), `/me` carries `supportSeat`. New, reply, update and resolution notifications reach the right people and, through ADR-050, become toasts with fixed text. Every step is a case event and an audit row.

**Not done (TNQL has them).** Attachments and screen recordings, «تحدث مع الدعم» chat, 15-category taxonomy and diagnostics, AI drafts for agents (phase 2 with the assistant), tutorial videos (phase 3).

## ADR-054 «دليل تمركز»: TMRKZ's knowledge bundle in TNQL's OKF format (owner, 11 Nov 2026)

**Decision.** OKF is TNQL's knowledge-bundle format (not a model): Markdown documents with a front matter and a manifest pinning each document's sha256 and provenance. TMRKZ ships its own bundle (`backend/src/main/resources/okf/`, 11 Arabic documents written from the actual screens and ADRs: sign-in, refused sign-in, desktop notifications, add user, permissions matrix, new site, re-stationing, request access, support report, offline map, support console). `ops/knowledge/okf.py` validates it (fields, audience against the real `Permission` names, manifest hashes, secret patterns) and writes the manifest.

**How.** `KnowledgeService` loads the bundle once and serves only documents whose bytes match the manifest, that are `current` and `verified-current`; the search is deterministic and offline as TNQL's (Arabic normalisation: diacritics, tatweel, alef forms, ى/ي, ة/ه, Arabic-Indic digits, the article and joined prepositions; weighted title, keyword and body matches), each hit cites its `tmrkz://okf/...` resource. Documents are filtered by audience (`all`, a permission held anywhere, `SUPPORT_SEAT`). `/api/v1/help/search|index|doc|status`. The UI renders Markdown into React elements, never HTML.

**Next (phase 2).** The assistant dock on the site's own model server (Ollama is installed on this PC with no model) answering from this bundle and tools that respect the person's permissions, with masking, audit and switches, as TNQL.

## ADR-055 Approval stamps «ختم عمليات الوحدة» and «ختم الاعتماد النهائي», as TNQL's (owner, 11 Nov 2026)

**Decision.** A stationing request shows TNQL's two stamps once their stages are approved: a navy round stamp for «اعتماد عمليات الوحدة» (main unit on the top arc, the approving unit on the bottom, «اعتماد عمليات الوحدة», approver, position or role, request number, date and time in Arabic-Indic digits) and a wine rounded rectangle for «الاعتماد النهائي» (approving unit, main unit, «معتمد نهائياً», approver, position, number, date — time). «بالنيابة» when decided through a delegation. «طباعة سجل الاعتماد» prints the request's facts under both stamps with a watermark of the state, through the browser (no PDF, ADR-020).

**How.** `GET /restationing-requests/{id}/stamps` (same visibility as the request): the current route's UNIT_OPERATIONS and FINAL stages approved, the approver's name, role and unit as recorded in the audit at that moment, the position from the HR affiliation. `ApprovalStamps.tsx` draws them as SVG.

**Scope.** Visual only: the record of the approval is the audit, and the stamp is never the certificate seal of ADR-020. TNQL's stamps sit on movement orders, routes and convoy tables; none of those were ported — «الاعتماد النهائي» here is the stationing request's final approval. TNQL's «استوديو الوثائق» (stamp size, ink, offsets) is not reproduced.

**Also (owner, 11 Nov 2026).** «النموذج الأولي المعتمد» is removed from «التوثيق والتشغيل» and the concept prototype is no longer served (`frontend/Dockerfile`); the file stays in the repository as the preserved concept. Switches: the generated theme colour covered the on state in both themes; `theme.css` now shows on in the accent with a white knob and off with an edge.

## ADR-056 «المساعد الذكي» and the floating «الدعم», as TNQL's; the model on the site's own server (owner, 11 Nov 2026)

**Decision.** Every signed-in screen carries TNQL's two floating buttons (`movable-fab.js`): «الدعم» opens a drawer (the guide, a quick report, a link to «مركز الدعم») and «المساعد الذكي» opens a dock with «اسأل» and «شرح الشاشة», the screen's name, the model's state, and «لم تُحل؟ افتح بلاغاً للدعم». Both can be dragged anywhere; the spot is kept in this browser as a fraction of the free space (double-click puts it back); a drag never clicks. The owner: "ollama only we will use it locally but in airgapped I will link it, see how it's built in mover".

**How.** As TNQL's `ai_provider.py` (`openai_compatible`): `AssistantService` calls `{TMRKZ_AI_BASE_URL}/chat/completions` with `TMRKZ_AI_MODEL` and an optional `TMRKZ_AI_API_KEY`; off unless `TMRKZ_AI_ENABLED=true`. This PC: Ollama at `http://host.docker.internal:11434/v1` with `qwen2.5:7b` (the model TNQL's own tests use); the isolated network: the organisation's server, by changing the address only. The model only phrases language over the verified guides the person may see (ADR-054) and the question; it has no tools, reads no request and cannot act; its answer is shown with the guides it was given as sources and rendered as Markdown into React elements. Off, unreachable or busy, the dock answers from the guide itself (TNQL's deterministic fallback). Limits as TNQL's: 64 KB request, 256 KB response, 4 calls at once, 60 s. Each question is audited (`ASSISTANT_ASKED`: screen, mode, sources, length, model, time), never its text.

**Not done (TNQL has them).** Voice (`faster_whisper`), guarded actions with preview and confirm, request-scoped answers through MCP tools with masking, saved conversations, «الوضع التشغيلي» tab.

## ADR-057 A demo Oracle HR source, as TNQL's; the parent from an ID path (owner, 11 Nov 2026)

**Decision.** For the real-environment walkthrough the owner chose "use the demo one like mover": TNQL's `oracle_hr/build_oracle_hr.py` and `reference_structure.py` are copied into `ops/hr-demo/` and run against a real Oracle Database Free (`gvenzl/oracle-free:23-slim`, container `tmrkz-hr-demo-oracle` on the application's internal network, `FREEPDB1`). The data is TNQL's: 100 % synthetic, fixed seed, its reference organisation and 200,000 people. Changes for TMRKZ: generated secrets in `ops/hr-demo/.generated/` (git-ignored), the read-only account `TMRKZ_HR` reads `HR_ENV_UNITS_AI` and `HR_PRS_EMPLOYEES_ALL` only — the medical view exists as in TNQL and is not granted, because TMRKZ never reads health data. Never in production.

**Compatibility found.** TNQL's own sync takes a unit's parent from an ID path when the source has no direct parent column (`hr_organisation.parent_hr_id`, «\1\2\3»); TMRKZ's mapping could not. New transform `path_parent` (parent field only; a root or a self-reference gives no parent). In the demo the parent is `MAIN_UNIT_ID` itself, so the demo mapping uses it directly.



**Amendment (11 Nov 2026, found while applying V37).** After the first sync (08:27, 21 s) every hourly sync of the 200,000-person demo failed or hung: the duplicate-number check and the projection counted each person's number with a per-row subquery, and on rows just staged (no statistics yet) the planner chose plans that never finished. Six such queries were still running after up to 98 minutes, holding a lock that stopped V37; they only read the mirror and their callers were gone, so they were cancelled. Fix: the checks and `HrProjection.UNIQUE_NUMBER` are one grouped pass, and a run analyses `hr_unit`/`hr_person` right after staging. `HrSyncAcceptanceIT` and `RestationingHrSyncIT` pass; on :8088 the first sync after the fix took 17.7 s.

## ADR-058 «إدارة الصلاحيات والوحدات» and the approver of a station, as TNQL's (owner, 11 Nov 2026)

**Owner.** "memic exactly how mover is dealing with the roles with units and the assignment … نحتاج معتمد السلسلة الهرمية اذا احتاج ويمكن انه يعتمد حتى ادنى مستوى في حال لا يوجد اي معتمد سلسله هرمية لديهم و كذلك معتمد عمليات الوحدة و الاعتماد النهائي … اسحب بالضبط الصلاحيات وكيفيه اعطاء المستخدمين وكيف شاشة المستخدمين تعمل ف عدل على الموجود", then "memic the page exactly". Read from TNQL's code (`utils._unit_chain_approvers_all`, `workflow/service._chain_station`, `admin/access_workspace.py`, `admin-access-workspace.js`) and its tutorial screens.

**The approver of a station (`Stations`).** One rule for every step going to a unit — a chart's climbing approval, its other unit steps, and a re-stationing hierarchy seat: (1) the station's own approvers: a grant of the role at the unit (its home when it names no unit, a unit it names, a level it names reaching it), a position seat there, their delegates; (2) only when it has none, the nearest unit above it, below the main unit, whose approver's grant covers its branch («هذا المستوى ومع أبنائه»). Own and inherited are never mixed, so a higher approver cannot sign early where a level has its own (TNQL's cursor-exact gate), and the main unit is never a station nor inherited from. The approver who inherits a vacant level signs it in his own name and then signs his own level; in re-stationing that one case is excepted from "one human decides one stage" (`RestationingService.inheritedBy`), every other separation stays. A level nobody approves, not even from above, keeps TMRKZ's outcomes (refused before sending, skipped when the flow says so, open to the role). Not taken from TNQL: a holder over everything signing any station — TMRKZ's ALL-reach roles were never held at other units' steps, and its «open to the role» already covers the empty case. The studio simulation names the inherited approver ("— يعتمدها معتمد «X»"); the stationing path simulator counts it.

**Final approval** (`FINAL_APPROVER`, `ACCESS_FINAL_APPROVER`, `FINAL_APPROVER`) is given and taken by a global access manager only, whatever a scoped role's grantable list says (`GrantAdminService.FINAL_ROLES`).

**Roles given to a unit (V36 `unit_grant`, «موروثة من الوحدة»).** Every current and future member (HR posting or «إضافة مستخدم») holds the role at the unit while both last; `GrantSource` reads it like a seat, so the decision service follows (triggers on `unit_grant` and `unit_member`). Only roles that decide and manage nothing (requesting, reading, the requester's own steps: VIEW, VIEW_SUMMARY, CREATE, EDIT, EXECUTE, CLOSE and the request-creating stationing actions); approvals are always a named person's grant. Ended, never deleted; audited `UNIT_GRANT_ADDED/ENDED`.

**The page.** «مركز الصلاحيات» opens on «إدارة الصلاحيات والوحدات», TNQL's layout: hero «ابحث أولاً، ثم اعمل داخل نطاق صغير» with «مركز الإدارة الحالي» (the existing studio, which has the way back); four counters (units in reach, people, active, 25 rows a page); 01 «مركز المهام والبحث» (units | people, each with its path); 02 the unit tree with sub-units and people, inner search with paths; 03 the unit — «مساحة العمل» (person cards, 👁 why each permission holds, ✎ to the matrix), «إدارة الصلاحيات» (the matrix), «مصفوفة التدقيق» (the unit's changes with the batch reference); 04 «ملف الوحدة» with the inherited roles and «منح لكل أعضاء الوحدة». Matrix cells: a tick (direct), ✓ inherited from the unit or an HR seat, ⌛ temporary (a grant with an end, a delegation received), 🔒 locked with its reason (one's own row, a system account, a role this manager may not give here, final approval). Ticks are pending: «لا تعدل معلّقاً», amber outline, «N تعديلاً معلقاً», «تراجع», bulk «إضافة/إزالة صلاحية» over chosen rows; «حفظ التعديلات» reviews them (`/preview`: refusals, counts, a fingerprint of the touched cells), «تأكيد» applies all or nothing (`/apply`: ≤60, row lock on the unit, 409 when a cell changed since the review) under one 12-character audit reference written on every grant made or ended and on `ACCESS_BATCH_SAVED`. «تعيين» columns (unit operations, final approval, for-information, other approvals) still save at once through the units dialog, as TNQL's. The time periods of unit operations and the main for-information bodies moved under the matrix; the old «مصفوفة الوحدات» tab is gone (`UnitMatrix.tsx` → `AccessWorkspace.tsx`, `UnitRouting.tsx`).

**Not done here (TNQL has them; all built next in ADR-059).** The ten separate rights of an access manager and delegating them; duty permits as the temporary source; «معتمد التوفر» per department (movement-specific); the account card (system role, profile, delete); the whole-unit acknowledgement on bulk selection; HR availability filtering of approvers.


## ADR-059 The rest of TNQL's access workspace: an access manager's rights, duty permits, the account card, «معتمد التوفر», HR absence (owner, 11 Nov 2026)

**Owner.** "finish the missing one in one go" — the items ADR-058 listed as not done. Read from TNQL's `access_administration.py`, `temporary_access/service.py`, `admin/access_workspace.py` and `utils.unit_chain_approvers`.

**«مسؤول إدارة الوصول والصلاحيات» (`AccessRights`, V37 `membership.access_rights`, `sponsor_id`).** A grant of a role that manages access carries its own subset of TNQL's ten rights: البحث عن الموظفين (LOOKUP: the HR card in «إضافة مستخدم», people search), مراجعة طلبات الصلاحية (REVIEW: who a permission request's review step goes to), منح الصلاحيات (GRANT: giving and ending grants, the staged save, roles given to a unit), إدارة الملحقين (ANNEXED: adding and removing users of a unit), تفويض إدارة الصلاحيات (DELEGATE), اعتماد نهائي لطلبات الصلاحيات (FINALIZE: a tied grant of «معتمد طلبات الصلاحية» over the same units, made and ended with it), إدارة صلاحية المناوبة (DUTY), توجيه المهام بانتظار الإسناد (ROUTING: assigning tasks waiting for an approver — TNQL's «توجيه طلبات التوفير» in TMRKZ's terms), إدارة اعتماد عمليات الوحدة حسب الوقت (UNIT_OPERATIONS), إلحاق الوحدات وتعيين مهام التوفير (ATTACH: which departments a unit provides). DUTY and ROUTING start ticked, as TNQL's. No list means every right: every grant made before V37, a seat, a role given to a unit, a global manager's — nothing existing lost a right. A right is held where one grant managing access there carries it; rights of different grants are never combined. **Delegation**: a manager who is not global gives a role that manages access only through a grant carrying DELEGATE whose rights include every right handed on and whose end is not before the new one's (an open-ended delegation under an ending grant is refused); the new grant records its sponsor. Only its issuer or a global manager edits or ends it; ending a grant ends what was delegated from it and its tied final step; editing it moves its delegations over unless now wider. Not self, inside the directory, as every grant.

**Duty permits (V37 `duty_permit`).** Issued by a holder of DUTY at the unit, for a role they may give there (never one that manages access or a system role), to someone else in their reach, for one window of at most seven days, with a reason; the holder is notified (bell and desktop, `DUTY_PERMIT`) and activates it from «صلاحياتي» once the duty starts (15 minutes early at most). Only then, and only inside the window, is it a grant (`GrantSource`), at the unit with the role's reach — additive: the unit's own approvers keep theirs, and the permit holder counts among the station's own (ADR-058). Ended early by its holder, issuer or a DUTY holder; ⌛ in the matrix; «تصاريح المناوبة» tab in the unit; audited `DUTY_PERMIT_ISSUED/ACTIVATED/ENDED`. TNQL's permits are movement duty permits; TMRKZ keeps the general mechanism only.

**«بطاقة الحساب».** From the person's name in the matrix or the card icon: who (source HR or local, sign-in linked, HR absence), units (posted, added, acting), current grants with rights and delegation, system roles (a global manager gives or takes them here), duty permits, the account's history. «إيقاف الحساب / تفعيل الحساب» (V37 `person.access_disabled`): switched off here whatever HR says — `GrantSource` gives the person nothing, grants stay and return when switched on; by a global manager or GRANT over one of the person's units, never one's own or a system account. A local account's name is edited here (an HR record is edited in HR). «حذف الحساب» of a local account by a global manager only: never a deletion — the audit refers to it — every grant, unit entry, delegation and permit ends and the account is switched off. Not taken: TNQL's guide-author flag (TMRKZ's guides are a verified OKF bundle, ADR-054), operations threshold and joint-operations control (movement-specific).

**«معتمد التوفر» per providing department (V37 `provider_unit`).** A department is a role `AVAILABILITY_<code>` «معتمد التوفر — …» (VIEW, REVIEW), added by a global manager from the unit file and published as a new role policy version like every role (refused while another draft is open); the unit access manager may give it. ATTACH marks which departments a unit provides. In the matrix all departments share one column of chips saved at once: «فعالة» (granted at a providing unit), «احتياطية» (granted where the unit does not provide it — only a global manager gives that), «غير ممنوحة». A chart step takes the new place «الوحدة المزوّدة (معتمد التوفر)» (`PROVIDER`): the units providing the step role's department under the requester's main unit, or else every providing unit, or open to the role when none.

**HR absence (V37 `hr_person.leave_status`, `person.hr_unavailable`).** New optional mapping field «حالة الإجازة أو الغياب (فارغ = متاح)»; any value means away now. As TNQL: the person still counts as appointed — nothing is inherited past them — but a step does not go to them and they cannot act on it (`Stations.people` vs `appointed`); a level whose appointed approvers are all away waits (for a delegate, or for the access managers through «مهام بانتظار الإسناد»), it is neither refused nor skipped.

**Bulk on a whole unit.** A staged change reaching every member of the unit (more than one) needs an explicit «أؤكد أن هذا التعديل يشمل كل مستخدمي الوحدة» (server-side `wholeUnit`), as TNQL's.

## ADR-060 «مسار الاعتماد» as a ladder of levels; MOVER's people list, separate identity columns and resizable panels (owner, 16 Nov 2026)

**«مسار الاعتماد» on «سياسة التمركز»** (owner: "redesign this card as it seems unclear"). The table of typed level numbers (a level could be typed twice or out of order) is replaced by `components/RoutingLadder.tsx`: 1 «من يعتمد أولاً؟» as two option cards; 2 one row per level the HR hierarchy has, in the order a request climbs (deepest first, as the studio's «مسار الموافقات»), each with a «يعتمد» switch (a level that starts approving is named «اعتماد المستوى Lx» if blank), its stage name, «اجعلها المرحلة النهائية» (one level; it approves) and the facts that re-open its approval as toggle chips; levels above the final level are drawn dashed, «لا يصل إليه الطلب»; a configured level the hierarchy no longer has is flagged with a delete button; a repeated level counts by its first entry, as `RouteDerivation.derive`, and «إزالة التكرار» drops the rest; 3 «معاينة المسار» for a unit at a chosen level, computed as the server derives it, followed by the stages after the hierarchy and «التفعيل». Helpers in `lib/stationingRoute.ts` (`ladder`, `patchLevel`, `switchApproves`, `makeFinal`, `withoutDuplicates`, `previewRoute`). Values and their server validation are unchanged.

**«مساحة العمل» as MOVER's** (owner: "make sure it looks like mover"): «إضافة مستخدم» on its own row above the search as a secondary button; the pager below the list, and only when there is more than one page; each card shows the name, a gold identity line «الرقم · المنصب», «رقم الـU · N صلاحية فعّالة», at most three direct and two inherited badges (+N for the rest) and only MOVER's two buttons: the eye («عرض الصلاحيات الفعّالة») and the pen, which opens the account card (MOVER's «فتح نموذج التعديل المعتمد»).

**Separate identity columns in «إدارة الصلاحيات»** (owner: «العامود يتم فصله الرقم الرتبة الاسم المنصب»), as MOVER's table: الرقم العسكري | الرتبة العسكرية | الاسم | رقم الـU | المنصب. Matrix rows carry `rank` (V38 `hr_person.rank_name`, new optional mapping field «الرتبة»), `position` (`hr_person.position_title`, else the person's affiliation title) and `username`. On this installation mapping version 2 maps «الرتبة» → `GRADE_NAME` (16 Nov 2026, after the verified backup `backups/tmrkz-mover-20261116T044016Z`); the following sync gave all 200,000 demo people a rank.

**Resizable panels** (owner: "make the ability to modify the width of the card"): dividers between the unit tree, the middle panel and the unit file (`role="separator"`; drag, arrow keys — Shift for larger steps — and double-click to reset); the tree 220–760 px, the file 220–680 px, the middle never below 420 px; kept per viewer in this browser (`tmrkz-aw-widths`), never on the server. Below 1,280 px the earlier stacked layout applies.

**Later the same day (owner):** «حفظ الصلاحيات لا يحتاج تأكيد» — «حفظ التعديلات» checks on the server and saves in one step (one audit reference, as before); the bar stays only when the server refuses a line, or when a change reaches every member of the unit (the server-side `wholeUnit` acknowledgement is kept). The six identity columns are pinned at MOVER's fixed widths (36/100/100/164/120/140 px, narrower in a panel under 900 px, unpinned under 600 px) with an accent edge, so the permission columns scroll under them instead of hiding the number and rank. The unit tree keeps its open branches when the page refreshes (it used to drop their children and leave them marked open and empty), and a unit chosen from a search opens the tree down to it and scrolls to it, as MOVER's `revealUnit`, from the unit file's new `trail` (ancestor ids, the top first).

## ADR-061 «معتمد السلسلة الهرمية» as TNQL's; a unit's users are those added, not every HR employee (owner, 16 Nov 2026)

**«معتمد السلسلة الهرمية»** (owner: «لم تقم ببنائها بنفس تنقل … أعد البناء جميع الخيارات»; TNQL `can_approve_requests`, its dialog in `admin-access-workspace.js` 3089-3418 and `multi-unit-grant`). It is no longer a staged tick (which wrote a role-scope grant and so silently covered every unit below): its matrix cell is «تعيين» / «N وحدة», saved at once («⚡فوري» in the header, a «?» with TNQL's help text), through TNQL's dialog — title «تعيين معتمد السلسلة الهرمية», «الشخص — الوحدة», the tree «الهيكل التنظيمي / ضع علامة لإضافة الوحدة» from the main units, main units not tickable, the table # | الوحدة | الوحدات المغطاة | نطاق الاعتماد, two options only: «هذا المستوى فقط» (the default) and «هذا المستوى ومع جميع الوحدات التابعة» («X + N تابعة (حيث لا معتمد مباشر)»), TNQL's two explanations, «المحدد:», «حفظ التعيين», a question before closing with unsaved changes and before withdrawing from every unit, and «النطاق المحفوظ» for a stored scope it no longer offers. The server (`GrantAdminService.create`) refuses for this role every unit, chosen levels and sites («معتمد السلسلة الهرمية يُعيَّن على مستوى بعينه…») and a main unit («الوحدة الرئيسية ليست مستوى في السلسلة الهرمية — اختر مستوى تحتها»); a grant with no unit chosen — an approved access request among them — is «هذا المستوى فقط». Grants already stored are kept as they are (role scope = with the units below), as TNQL kept its. Routing is unchanged: `Stations` already gives a level its own approvers first and the nearest «مع التابعة» approver above only where it has none. Not yet built from TNQL: the per-unit «تجاوز المستوى عند عدم وجود معتمد معيّن», a requester-only level blocking instead of passing, and duty-permit holders added on top without suppressing inheritance.

**A unit's users** (owner: «لا تضيف بشكل آلي — تم إضافتهم من خلال طلب الصلاحيات أو البحث بنفس نظام تنقل»). The access workspace no longer lists every HR employee of a unit: a person is a user of a unit only through «إضافة مستخدم» (a `unit_member` row), an approved access request (final approval now writes that row, audited `UNIT_MEMBER_ADDED` with the request) or a direct grant there; an HR posting, a position seat or a sign-in alone lists no one. Counts, the tree, the people search, the unit file and the whole-unit check use that set; platform accounts are hidden from managers who are not global. An HR transfer moves a non-acting entry to the new unit (`HR_TRANSFER`); a departure leaves the person listed as inactive. Unchanged on purpose: approvals, position seats, unit grants and notifications still read HR affiliation, so routing does not depend on who has been added. Differs from TNQL, which also creates an account at a person's first sign-in: the owner's rule is request or search only.

**Demo HR, deeper levels** (owner, same day; ADR-057). `ops/hr-demo/extend_levels.py` adds to the demo Oracle only, under random existing units of levels 5–9, 4–5 new branches of 3–6 units per level down to level 12 or 13, and 3 synthetic people per level of each branch with 1–2 levels left empty; codes `DX…`, ids from 990001, `--remove` takes them away. Run on 16 Nov 2026 (seed 231232628): 128 units, 72 people; then, because the owner looked in a branch that had none, `--each-main` (seed 457821597) added 4–5 such branches inside every main unit: 916 units, 495 people. After the sync TMRKZ has 1,143 units on levels 1–13 and none of the 567 new people is a user.

## ADR-062 Hierarchy approval skips units with no hierarchy approver and goes on to unit operations (owner decision, 16 Nov 2026)

**Decision (final, replaces any rule that held a request because a level of the climb had no hierarchy approver).** In a climbing approval step such as «اعتماد مستويات الوحدة» (`chain`: `from=PARENT`, `stop=MAIN_UNIT`, `skipEmpty=true`; the main unit is never a station), each unit of the climb is decided in this order: (1) its own valid hierarchy approver; (2) else the nearest valid hierarchy approver above whose grant covers it (ADR-058, kept); (3) else, with `skipEmpty`, the unit is **skipped** — not blocked, not waiting for an access manager, not open to any holder of the role, not handed to unit operations, not implied approved. After the climb the flow always continues to its next step («اعتماد عمليات الوحدة» where the published flow has it), then «الاعتماد النهائي», which is never skipped. A holder of unit operations only is never a hierarchy approver.

**Two different things.** A *hierarchy unit skipped* is one unit inside a climbing step with no hierarchy approver; a *workflow stage skipped* is a whole step bypassed (its condition false, or carried from an earlier revision). A climbing step may contain approved units, inherited approvals and skipped units, and still end. When every unit of the climb is skipped the step has no slot and ends at once (shown «COMPLETE» with its skipped units, drawn as passed, never with a check mark).

**Defect fixed.** `WorkflowRuntime.slots` added `ROLE|*` when every unit of a `skipEmpty` climb was empty, opening the step to every holder of the role; removed. Non-climbing steps whose place finds no unit keep `ROLE|*`; climbs with `skipEmpty=false` are unchanged (the request is refused before sending while a unit has nobody).

**Record (V39 `request_route_skip`).** Written by `WorkflowRuntime.recordSkippedUnits` when the process reaches the step for a request revision, in the process transaction, idempotent on (request, revision, step, unit): unit id, its **name and level as they were then**, order in the climb, `reason_code` `NO_HIERARCHY_APPROVER`, reason «تم تجاوز هذه الجهة لعدم وجود معتمد للسلسلة الهرمية», workflow version, time. Never recomputed from today's hierarchy; a returned and resubmitted request records its new revision's route separately (a step carried to the new revision records nothing new). One grouped audit event `HIERARCHY_LEVEL_SKIPPED` (revision, step, workflow version, the units with level, order and reason code) when something new is recorded — never on reading.

**Shown.** Request detail: every step carries `skipped` (`organizationId`, `organizationName`, `level`, `order`, `reasonCode`, `reason`; a summary view keeps the count and reasons without names); the page lists each skipped unit muted amber with «⤼», «تم التجاوز» and «لا يوجد معتمد للسلسلة الهرمية», and a note «تم تجاوز N جهات في السلسلة الهرمية لعدم وجود معتمد» opening to the names. The studio simulator marks each skipped unit «تم التجاوز — لا يوجد معتمد» before publishing; the option reads «تجاوز الجهات التي لا يوجد بها معتمد» with its explanation, and is on for every new climbing step. No published flow was changed (this installation has none with a climb); running requests stay on their workflow version.

**Found while building it.** An approver given «هذا المستوى فقط» at a level above the requesting unit (ADR-061) could hold the step but not open the request, so the decision failed (404 on the request view after deciding). A person who holds an open task of the request, or decided one, at a unit their grant reaches now sees that request in full (`RequestViews.stationTask`, confirmed by OpenFGA as the task itself) — the station approver sees what they decide, as TNQL's; nothing else gains visibility.

**Tests.** `WorkflowGraphIT` HSKIP-01…10 (`hskipOneEmptyLevel`, `hskipAllEmpty`, `hskipInherited`, `hskipOtherStagesUnchanged`, `hskipRevisionsAndHistory`) and the updated `skipsEmptyUnits`; frontend `RouteTimeline.test.ts` (skipped units visible with the reason, never approved, inherited approver not skipped, summary count, order climb → unit operations → final).

## ADR-063 One set of approval roles drives the stationing path (owner decision, 16 Nov 2026)

**Found.** The stationing engine found a hierarchy level's approver by the generic `APPROVE`, held by «المعتمد النهائي» (granted over every unit on this installation), «صاحب الاعتماد» and «معتمد طلبات الصلاحية» — so a final approver became the inherited approver of every level and no level could ever be skipped — while «معتمد السلسلة الهرمية» (VIEW, REVIEW) signed none, and «معتمد عمليات الوحدة» lacked `DECIDE_UNIT_OPERATIONS`. The unpublished stationing draft (ADR-045) duplicated the three approval roles.

**Decision (owner: «MOVER-style roles»).** The MOVER-style roles drive the stationing path: «معتمد السلسلة الهرمية» signs hierarchy levels only, through the new action `APPROVE_HIERARCHY` (stationing stages `HIERARCHY` and `CROSS_BRANCH`; OpenFGA relations generated, `docs/authz/model.fga` regenerated); «معتمد عمليات الوحدة» gains `DECIDE_UNIT_OPERATIONS`; «المعتمد النهائي» gains `FINAL_APPROVE_STATIONING`. A final approver is never a hierarchy approver. The draft's three duplicate approval roles (`CHAIN_APPROVER`, `UNIT_OPERATIONS_APPROVER`, `FINAL_APPROVER`) are removed; its other roles are published together with «تفعيل التمركز» (`STATIONING_ACTIVATOR`, the activation right had no role): role-policy version 3, published 16 Nov 2026 (nobody receives a role by publishing). «مدير صلاحيات الوحدة» may also give the three stationing request roles and «متابعة الموقف العملياتي».

**Same day, smaller.** «＋ موقع داخل «المعسكر»» on the chosen camp (row and card) opens «موقع جديد» with «يقع داخل» it and the map on it; a double click finishes a free drawing (the two clicks of a double click no longer add a near-duplicate corner); one shared units tree on every page (`components/tree/UnitTree.tsx`); the empty unit-symbol label no longer wraps word by word.

## ADR-064 The main unit is the unit whose MAIN_UNIT_ID is its own ID (owner rule, 16 Nov 2026)

**Owner.** «قاعدة تحديد الوحدة الرئيسية: الوحدة الرئيسية = وحدة يشير فيها حقل MAIN_UNIT_ID إلى معرّفها نفسه (MAIN_UNIT_ID = ID). لا يعتمد التحديد على الاسم ولا على أي FLAG. UTP_ID مرجع لنوع/مستوى تنظيمي وليس الأب المباشر» — "make sure you apply this one … so that it will know which is the main unit when we do the request".

**Decision.** The HR contract has a unit field `main_external_unit_id` («معرف الوحدة الرئيسية (MAIN_UNIT_ID)»); on import a unit is a main unit exactly when it equals the unit's own ID (`HrMapping.isMain`), and `hr_unit` keeps the reference as read (`main_external_id`, V40). The flag field `is_main` is gone from the contract: a mapping that still names it is refused with «علم الوحدة الرئيسية لا يُعتمد عليه …», so a sync never runs on the flag again (it failed closed on :8088 until mapping version 3 was published). A unit's name never decides. Since a main unit would be its own parent, MAIN_UNIT_ID cannot also be the parent: a mapping that reads the parent from the same column is refused unless it is the ID path (`UNIT_PATH` with `path_parent`, ADR-057). Everything that asks for «الوحدة الرئيسية» keeps reading `hr_unit.is_main` — the climbing approval that stops below it (ADR-041), the station rule (ADR-058), «معتمد السلسلة الهرمية» refused on a main unit (ADR-061), the main unit of the requester and of the place in «للعلم» — so a request now knows its main unit from the data.

**Demo source (ADR-057).** TNQL's builder had MAIN_UNIT_ID as the parent, the flag on the ten agreed level-6 main units, and a name path. `ops/hr-demo/main_unit_rule.py` converted the running demo in place, once, checking that the tree and the main units stay the same: UNIT_PATH is the ID path, MAIN_UNIT_ID is the unit's main unit (itself on the ten, the nearest one above below them, empty above every main unit — the root is not a main unit, UAT BUG-33), the flag a meaningless default on 99 % of rows; the rows as they were are kept in `ops/hr-demo/.generated/units-before-main-rule.csv`. `reference_structure.py`, `build_oracle_hr.py` and `extend_levels.py` build that shape from now on. With the application network isolated, the Oracle driver comes from `ops/hr-demo/.generated/wheels`. :8088: HR mapping version 3 (parent ← `UNIT_PATH` by `path_parent`, main unit ← `MAIN_UNIT_ID`).

**Tests.** `HrMappingTest.mainUnitIsTheSelfReference` (self-reference is main; the flag and the name never decide; the parent still from the path; the flag field and MAIN_UNIT_ID as parent refused); `HrSyncAcceptanceIT`, `RestationingHrSyncIT` unchanged and passing.

## ADR-065 HR people come in one by one, as MOVER (owner decision, 16 Nov 2026)

**Owner.** "Connecting to Oracle gave all access and imported them (the HR people) into the app — this is wrong. It should be like MOVER: when we connect to Oracle it should not import them unless I want to import a specific person." MOVER (read, never changed): no copy of all HR people; only people already users of the application are refreshed from Oracle, by their IDs (`app/hr_people_sync.py`, `hr_reconciliation.reconcile_one`); a person becomes a user only by an access manager importing ONE person (live lookup, nothing saved; «استيراد» re-reads that one person and creates the account with no permission, `hr_people.import_account`) or by their own first sign-in (live Oracle shows one ACTIVE person with that account, `provision_zero_access_user`); moved in HR → unit updated, grants tied to the old unit ended; left service → deactivated, never deleted.

**Decision.** Connecting HR copies nobody. The hourly sync still reads the **whole unit tree** (owner's deliberate difference from MOVER: every unit stays visible for stationing; unchanged), but of the person view only TMRKZ's **linked people**, by their source identifiers. A person enters TMRKZ only one at a time, with no permission.

**Linked people — one definition** (V41 view `hr_linked_person`, read by the sync and by the clean-up): an HR-sourced `person` that has an `identity_link` (signed in once; never removed, so anyone who used the application stays linked), or an active `unit_member`, or a current or future `membership`, or a delegation given or received that is neither revoked nor over, or a duty permit not ended and not over, or a current support seat, or an open `access_request`, or an open affiliation on the position of an active `position_seat`.

**What changed.**
- *Sync* (`HrSyncService`): the linked people's identifiers are recorded as the snapshot's scope (V41 `hr_snapshot_scope`) and read from the person view in batches of at most 1,000 (`HrSourceAdapter.Session.select`, a prepared `WHERE <id> IN (?, …)`; identifiers come only from the published mapping and the view metadata, `HrMapping.Compiled.in/equalsIgnoreCase`, every value a bind parameter); a returned row TMRKZ did not ask for is never stored. The projection (`HrProjection`) applies the whole tree and **only the people in the scope**: create/adopt/update, leave, rank, transfer (affiliation, grants that no longer fit, the unit entry, tasks realigned), inactive or vanished from the view → disabled, never deleted. Nobody outside the scope is updated or marked departed, so the 200,000 people copied before this change are left alone until the clean-up removes them.
- *Protections adapted, not weakened.* An empty unit view is refused as before; an empty person view is refused when TMRKZ has linked people and the view returns nobody at all (a cheap one-row probe, only when none of them came back). The people count is no longer compared with the previous snapshot (before ADR-065 it held every HR person; now the linked ones); what that check protected — many people disabled at once by a broken source — is now weighed directly: the active linked people this run would mark departed, against the source's existing `drop_percent`/`drop_minimum`, refused (`LARGE_DROP`) unless an authorised manual run explains it. Units keep the previous-snapshot comparison; as before, the very first snapshot is compared with nothing. Duplicate employee numbers are still found among the staged rows; a second HR record carrying a linked person's number is now caught where a link is made — the live lookup returns every record holding the key and an import or sign-in with more than one is refused (never linked automatically, as before). The staleness rule for linking a person already in TMRKZ is unchanged. A linked person missing from the view is listed as `NOT_IN_SOURCE` (count `linkedNotInSource`).
- *Live lookup, nothing saved* (`HrPeopleService.find`): exact employee number, or domain account ignoring case, through the published mapping, at most 20 rows, read-only session as the sync's; writes nothing (not even the mirror). «إضافة مستخدم» (`UnitMemberService.lookup`) searches TMRKZ first as before and, when the person is not in TMRKZ, asks HR live: one ACTIVE record whose HR unit is inside the manager's reach (a global manager: anyone), otherwise the same «not found». The card then has no `personId` and `importOnSave`; the dialog says «غير موجود في تمركز بعد: عند الحفظ يُستورد سجله وحده من الموارد البشرية، بلا أي صلاحية».
- *Import one person* (`HrPeopleService.importOne`, `POST /access/unit-members` with `employeeNo`): the person is re-read live; that one row is stored in the published snapshot (and its scope) and projected by the sync's own rules (`HrProjection.applyPerson`: person and affiliation); then the unit entry; no grant of any kind; audited `HR_PERSON_IMPORTED` (`via` `UNIT_MEMBER`, the unit) with `UNIT_MEMBER_ADDED`. An employee number held by another HR record or another TMRKZ record is refused before anything is written. Never at the same time as a sync: the sync's advisory lock is tried, and while a sync runs the import is refused with «يجري الآن تحديث بيانات الموارد البشرية؛ أعد المحاولة بعد قليل». Adding a User ID without HR now also asks HR live, so an HR employee is never added as a local account.
- *First sign-in* (`IdentityService.hrMatch`): when no person in TMRKZ holds the key, HR is asked live by the sign-in's enterprise key (the domain account, or the employee number when `link-key` is `EMPLOYEE_NUMBER`); exactly one ACTIVE record → that one person is imported (`via` `SIGN_IN`) with no permission and no unit (a user of no unit; the zero-access page offers the access request) and linked. Inactive → `INACTIVE`, several records → `AMBIGUOUS`, none → `NO_MATCH`, HR unreachable or a sync running → new reason `SOURCE_UNAVAILABLE` («تعذر التحقق من سجلك في الموارد البشرية الآن؛ أعد المحاولة بعد قليل»; V41 widens the check, login page and review list labels added). Platform accounts, local User IDs and the first administrator are unchanged; a temporary first administrator still moves to their HR record, now imported live.
- *HR page*: the published copy and the runs read «… من مستخدمي تمركز» for people.

**Existing installation clean-up** (`ops/hr-prune-unlinked.sql`, `ops/hr-prune-unlinked.sh`; NOT run on :8088 — the owner runs it after a backup). Dry run by default (`ops/hr-prune-unlinked.sh`): prints `hr_people_unlinked`, `hr_people_kept_referenced`, `hr_people_to_remove`, `affiliations_to_remove`, `mirror_rows_to_remove`, `applied`. With `--apply` (setting `tmrkz.prune_apply=on`), in one transaction, after taking the HR lock: removes the HR-sourced people who are not linked and whom nothing refers to — every foreign key to `person` found in the catalogue (so later tables are covered), plus the references without a key (audit trail as entity or actor, local notes, task realignment history, authorisation tuples and changes) — with their affiliations, and the mirror rows of HR people TMRKZ does not hold; recounts the snapshots; one audit event `HR_UNLINKED_PRUNED`. Re-runnable; a referenced person is never removed.

**Stayed.** The unit import, the mapping contract, the read-only Oracle session, the projection's identity rules, `hr_person` as the published mirror every screen reads, transfers moving the unit entry (ADR-061), seats and unit grants (now reaching only people added to the application).

**Consequences to watch.** Everything that reads HR affiliation now sees linked people only: FYI recipients by HR affiliation, position-seat holders, a station's appointed approvers (ADR-058/059: an HR seat holder who never signed in or was never added no longer counts, so a level may now inherit from above or be skipped), the people search in task reassignment and identity-issue linking (only people in TMRKZ), unit counts. The access workspace lists were already added-people-only (ADR-061). Name search in the live lookup (MOVER's ≥3 characters) is not built.

**ACCEPTANCE ONLY — OWNER DECISION PENDING.** The linked criteria beyond the owner's words (current/future grants only; open access request only, no "recent" window; support seats and position-seat occupants included); the departure check reusing the source's `drop_percent`/`drop_minimum`; a sign-in or import refused (not queued) while a sync runs; a key held by more than one HR record never linked automatically, even if only one is active; the 20-row limit (MOVER's).

**Tests.** `HrLinkedPeopleIT` LP-1 (connecting HR projects the 5 units and nobody; one import → the next run reads exactly that person), LP-2 (a linked person's transfer moves affiliation and unit entry, rank and leave update, left service and vanished from the view are disabled; an unlinked person's change creates nothing), LP-3 (live lookup by number and by User ID in any case, manager's reach, inactive and unknown answered alike; person, mirror, affiliation, unit entry, scope and audit counts unchanged), LP-4 (import creates exactly one person, no grant or delegation, the unit entry, the affiliation, one mirror row, `HR_PERSON_IMPORTED`; linked; adding again changes nothing; an inactive person is not imported; the next sync reads them), LP-5 (first sign-in imports one zero-access person with no unit; the next sign-in is the same person; inactive, unknown and ambiguous refused, nobody created, each on the review list), LP-6 (clean-up dry run changes nothing; applied, it removes the unreferenced copy with its affiliation and mirror rows, keeps a once-added, a signed-in and an audited person; re-runnable). `HrSyncAcceptanceIT` updated: PA-01 (no people until imported), PA-03 (protections over twenty imported people: failing row, empty view, half of them leaving refused, override), PA-05/PA-09/PA-RANK (people imported through «إضافة مستخدم» before the transfer, seat and rank checks). Test isolation: the classes that configure a test HR source switch it off after each test (`HrSyncAcceptanceIT`, `HrLinkedPeopleIT`, `RestationingHrSyncIT`), and `UnitMemberIT` runs its no-HR cases with every source off — an enabled source is now asked live, and a test source is reachable only from its own test context.

## ADR-066 Zero access enforced by the server; nearest scope decides; requests belong to the unit (owner decisions, 16 Nov 2026)

**Owner.** On the LDAP first-login specification: «request page and support only» for a person with no permission; «Nearest scope wins» for unit operations and the final approval; a first sign-in holds nothing — "how he gave full access unit this is wrong … it should be like MOVER".

**Zero access, by the server (`ZeroAccessFilter`).** A signed-in person who holds no permission at all reaches only: signing in and out, `GET /me`, the access-request page (their requests, the roles offered, submit, resubmit), their own duty permits (to activate one — until then it gives nothing, ADR-059), «مركز الدعم» with its guides, and their notifications. Every other call is refused with `NO_EFFECTIVE_ACCESS` (403). Withdrawn: a request sent to them «للعلم» opening by its address (7 Nov) and the assistant (11 Nov). The page shows who they are — name, number, rank, position, unit, main unit (ADR-064), user ID, source — and one line: «لم تقدم طلب صلاحية» / «طلبك بانتظار مراجعة مسؤول الصلاحيات» / «أعيد طلبك للتعديل» / «تم اعتماد بعض الصلاحيات» / «تم اعتماد الصلاحيات وتفعيلها» / «تم الرفض».

**Nothing from HR alone.** A unit grant («موروثة من الوحدة», V36) reaches the users added to the unit (`unit_member`), no longer everyone HR posts there; a position seat applies only to a person who is a user of the application. With ADR-065 a person is a user only once imported or signed in, and then holds nothing until granted.

**Nearest scope decides (`Stations.nearestGrants`, `RawGrant.nearness`).** «اعتماد عمليات الوحدة» and «الاعتماد النهائي» of a stationing request are decided only by the grants named nearest the requesting unit: the unit itself, then the nearest unit above; at the same unit a list of levels before the whole branch; a grant over everything last. People who may not decide the request (its requesters, someone who decided another stage) are left out first, so the next nearest decides rather than nobody. The others covering the unit still see the request but have no turn («بانتظار اعتمادي» and the decision agree, both from `requireDecider`). The route simulator counts only the nearest. The generic workflow engine already routes by the nearest scope (ADR-042) and is unchanged.

**The request belongs to the requesting unit.** Anyone who holds the request's right for the requesting unit edits and sends it; the person who started it is kept for the history, and one who no longer holds the right no longer edits it. Everyone who submitted a revision counts as a requester for separation of duties: none of them decides or activates it.

**FYI recipients.** «تحديد وحدات العلم» reaches the users added to the chosen units as well as those HR posts there (with ADR-065 HR posts only imported people).

**Tests.** `StationingNextIT.nearestScopeDecides` (a holder over the top unit has no turn; the nearest decides unit operations and final); `fyiReadsOneRequestOnly` and `initialStationing` (a person with no permission is refused the FYI request with `NO_EFFECTIVE_ACCESS`, keeps «طلب صلاحية» and support, the assistant is closed; recipients holding any permission read it as before); `AccessAdminIT.dutyPermits` (a permit is activated by a holder who has nothing else).

**Access requests (V43).** What was asked, recommended and granted stay apart: the access manager's recommended scope is kept in `recommended_scope` and no longer overwrites the scope the final approval writes. A review step passed because the unit has no access manager (or only the applicant) is recorded for the revision (`request_route_skip`, `NO_ACCESS_MANAGER`, «لا يوجد مسؤول صلاحيات لهذه الوحدة — انتقل الطلب إلى الاعتماد النهائي»), audited once (`ACCESS_REVIEW_SKIPPED`) and shown to the final approver instead of being inferred. At a decision the person's unit is read again: when it changed, nothing is granted and the refusal is audited in its own transaction (`ACCESS_REQUEST_UNIT_CHANGED`, «الوحدة تغيرت أثناء طلب الصلاحية»). A person with no HR posting asks for their added unit (ADR-061). «الصلاحيات المتاحة للطلب»: the system administrator sets, per offered role, the description the person reads and the scopes it may be asked with and their default (`access_request_offer.description/scope_modes/default_scope`); the page offers only the scopes all chosen roles allow, and the server refuses any other. Per-role scopes on one request and a preview of the effective permissions before approval are not built (the request keeps one scope for its roles, as before).

**Tests (access requests).** `WorkflowGraphIT` asking-with-scope (advised scope kept apart), asking-without-reviewer (skip recorded with its reason and audited once; a move refuses, grants nothing and is audited), offer (description, scopes, default validated; a scope the role does not allow is refused); frontend `accessScopes.test.ts`.

**Unit responsibilities and personal permissions (§19–22).** A role whose permissions decide a stage of somebody else's request (`Permission.STAGE_DECISIONS`: approve, recommend, hierarchy, unit operations, final, FYI distribution, activation and the lifecycle decisions) is a responsibility of the unit — a seat its current holder occupies; every other role is a personal permission. «إدارة الصلاحيات والوحدات» shows the two apart (a marked chip; «مسؤوليات/مقاعد الوحدة» and «صلاحيات الشخص» in the person's view). Open tasks already follow whoever holds the seat now: pooled tasks are re-read at view and decision time, and a task assigned to a person whose grant ends goes back to the current holders (`GrantAdminService.end` → `TaskRealignment.realign`, SEAT-01), as an HR transfer already did (PA-09). A separate seat entity with its own history of holders is not built: the grant history is that history. Tests: `AccessWorkspaceIT` finalIsGlobal (seat flag), `SeparationOfDutiesIT` endedGrantReleasesAssignedTask.

## ADR-067 «موقع جديد» registers the site, its initial stationing and deployment areas in one save (full acceptance, 16 Nov 2026)

**Owner.** Full end-to-end acceptance specification of 16 Nov 2026: in «تهيئة المواقع والتمركز» a site-setup administrator registers, in ONE atomic, audited save, the site, its initial stationing and each stationed unit's primary and alternative deployment areas. Until now the site was saved alone (ADR-048) and a unit was stationed afterwards from the site's card («تثبيت», one correction per unit) with no way to place its areas except a deployment request.

**Who.** A person who holds `MANAGE_FACILITIES` and `CORRECT_STATIONING` each through an ALL-scope grant — «تهيئة المواقع والتمركز» `SITE_SETUP_ADMIN` — checked by `SiteSetupService.admin` (`AccessContext.canEverywhere`, so OpenFGA confirms both). Anyone else gets 403 from both endpoints and keeps the three steps of the site alone (ADR-048) and, for stationing, «＋ طلب جديد»; nothing in the request path changed. The page mirrors the gate from `me.grants` (`lib/siteSetupFlow.isSetupAdmin`) only to decide what to show.

**Steps (six, administrator only).** «البيانات» and «الرسم» as before; «التمركز الابتدائي» — the shared `components/tree/UnitTree.tsx` with ticks (`data-setup-unit`), a unit stationed somewhere shown but not tickable («متمركزة في «…»»), optional (no unit: the site alone, straight to the review); «منطقة الانتشار الرئيسية» and «منطقة الانتشار البديلة» — one step per area, the chosen units as chips, each area placed by one click with the policy's `deploymentAreaDefault` or drawn, then dragged and edited, its distance chip centre to centre with the range of the policy in force (preview from the server's terrain analysis; for a leg without terrain, from the policy's own range); «مراجعة وحفظ» — the site summary, one line per unit, the server's check per unit in the existing `DeploymentCheckCard`, the reason, one call. `data-testid` `setup-step-3` … `setup-step-6`, `setup-save`. The request editor's `AreaControls`, `VertexRow` and `AREA_LOOK` moved unchanged to `components/stationing/AreaControls.tsx` (a `tabs` prop, default true, lets the setup draw one area per step); the page reuses its one `SiteEditor`, switching what it holds (site ↔ a unit's area) and drawing the rest of the plan faintly underneath (`setup-plan`). The six-step strip stays on one line: the current step is named, the others by number (`.sw-steps.many`).

**Endpoint.** `POST /api/v1/site-setup` — body: `site` and `boundary` exactly as `/sites/with-boundary` takes them (`boundary` null: a site that is one point, at its `location`), `units: [{organizationId, primary, alternative}]` (GeoJSON polygons in WGS 84, as the request editor sends them), `reason` (≥5), optional `reference`, `effectiveFrom` (default now, never in the future, as a correction); optional `Idempotency-Key` (`IdempotencyService`, as submit and decision: the same key and body return the first save, never a second site). Answer: `{site, units:[{organizationId, name, stationingId, areas:{PRIMARY, ALTERNATIVE}}], policyVersion, effectiveFrom}`. `POST /api/v1/site-setup/check` — the same rules, nothing kept: `{ok, problems, policyVersion, deploymentRequirement, units:[{organizationId, name, ok, problems, legs}]}` with each leg in the shape of a request's checks; the site is registered and rolled back inside it, so the site register's own rules (overlap with registered sites, parent, code) answer too.

**One transaction** (`SiteSetupService.setup`): the activation lock (`tmrkz.restationing.activation`, so occupied ground cannot change underneath) and the units' rows; then every problem at once and nothing written — reason, date, each unit exists, is active, appears once and is stationed nowhere (no record in force or scheduled, none ending after `effectiveFrom`), a policy in force when any unit is stationed, and per unit the pair rule of the policy's `deploymentRequirement` (`DeploymentRules.pair`) and both legs through `RestationingChecks.deploymentLeg` — the leg every request is checked with, now package-wide instead of duplicated: shape, terrain, occupied ground (sites of other units stationed now, active reservations; a hard block, O-08), the range of the policy in force (O-04/O-06); then the site and its boundary through `BoundaryService.createWithBoundary` (or `SiteService.create`), with their own `SITE_CREATED` / `SITE_BOUNDARY_PUBLISHED` as every site; each unit's `PERMANENT` stationing with origin `SETUP` and no request, its `STATIONING_CORRECTED` outbox event (the event a correction writes), its two areas with origin `SETUP` on that stationing record; ONE audit event `SITE_SETUP_BOOTSTRAPPED` on the site (who; site and code; units with their stationing and area ids; `effectiveFrom`; reference; policy version; the key; the reason); and the FYI notices of an activation (`PlaceInfo.noticeStationed`). No per-unit `STATIONING_CORRECTED` audit. Any refusal — of the site, a unit, an area, the database — rolls everything back: no half site.

**Distance exception.** The setup has no approval route, so an area that would need a distance exception is refused with that reason («… والاستثناء لا يُمنح في التهيئة») instead of being accepted on a written reason; it can be placed later by a deployment request, which routes the exception.

**Schema (V42).** `org_stationing.origin` gains `SETUP` (a request is still required for `REQUEST`, and a `SETUP` row names none; the two V18 checks, created unnamed, are found by what they say and replaced). `deployment_area.origin` (`REQUEST` default, `SETUP`); `request_id` is required exactly for `REQUEST`; a `SETUP` area always has its unit and stationing record. No reader filters on the origin — the operational posture, the stationing register (`/stationing/current`), the request hub's states and home counts, `RestationingChecks.activeAreas/effectiveStationing`, the retirement of areas on a permanent move or a correction, an extension carrying areas forward, the outbox — so a `SETUP` row reads exactly as an activated one (tested on posture, hub, register and a correction retiring the areas).

**ACCEPTANCE ONLY — OWNER DECISION PENDING.** Whether deployment areas are mandatory in setup: the setup follows the policy in force's `deploymentRequirement` — REQUIRED: both areas for every unit stationed in setup; OPTIONAL: none or both, never one alone. No value is written in code; with no policy in force a unit cannot be stationed (the site alone still can).

**Open owner questions.** (1) One pair of areas shared by several units: the data model is per unit (`deployment_area.organization_id`, ADR-045), so the setup takes one pair per unit; a shared pair would be copied per unit or need a model change. (2) The re-stationing footprint maximum (`maxFootprintAreaM2`) is not applied to the setup's site: the request path applies it neither to a site registered by request nor to an area, and the setup follows it. (3) Whether consumers should receive a distinct event type for a setup rather than `STATIONING_CORRECTED`. (4) Whether a setup administrator may record a distance exception.

**Tests.** `SiteSetupIT` SETUP-01 (two units, four areas, origin SETUP, one audit, two events, resend with the same key), 02 (a stationed unit: nothing written), 03 (out of range; over an occupied site; the review writes nothing), 04 (facilities only, unit-scoped holder of both, a stationing requester: 403; the three-step creation unchanged), 05 (hub, posture, register; a correction retires the areas), 06 (REQUIRED refuses a unit without areas; OPTIONAL: none accepted on a point site, one alone refused); `siteSetupFlow.test.ts` (who sees six steps, step order, the policy's rule, units and areas, review lines, body, page leg). Unchanged and passing: `StationingNextIT`, `RestationingWorkflowIT`, `StationingFoundationIT`.

## ADR-068 One employment context: the directory before Oracle, Oracle after (LDAP first login, 16 Nov 2026)

**Owner.** LDAP first-login specification §1–8, 25, 26 (16 Nov 2026): "A normal employee must NOT require an administrator to manually create their account before first login"; TMRKZ must work before Oracle is activated; the Unit ID is the same in LDAP and Oracle and is the join ("Do NOT create a second unit merely because the text name varies"); LDAP must not create units; an unknown Unit ID fails safely with «تم التحقق من هويتك، لكن وحدتك التنظيمية غير مهيأة في النظام»; once Oracle is authoritative it wins and `IDENTITY_ORG_SOURCE_MISMATCH` is logged.

**Statements (§43).** Authentication: LDAP proves identity. Organisational source: LDAP until Oracle HR is enabled; Oracle thereafter. Authorization: TMRKZ/OpenFGA grants permissions. Unit identity: stable Unit ID.

**The mode rule, in one place (`security/EmploymentContextResolver.mode`).** Oracle (Mode B) is in force while an `hr_source` is enabled AND a snapshot is published; otherwise the directory (Mode A) — including a source configured but never synced, and a source switched off. Health is not re-judged per request: a stale or unreachable Oracle fails closed through ADR-065's refusals (`STALE_SOURCE`, `SOURCE_UNAVAILABLE`) and never hands the placement back to the directory.

**The context (`EmploymentContextResolver.of/unitOf`).** `{personId, username, employeeNo, displayName, rank, position, unitExternalId, statedUnitName, unitOrgId, unitName, unitConfigured, unitOrigin, mainUnitExternalId, mainUnitName, source LDAP|ORACLE, observedAt}`. Unit — Oracle: the HR posting (affiliation), else the unit an access manager added (ADR-061). Directory: the Unit ID stated at the latest sign-in, matched to exactly ONE active organisation with that `source_external_id` (never by name; none or several = not resolved; never created); a Unit ID TMRKZ does not hold gives `unitConfigured=false` and the added unit or none; no Unit ID stated (attribute not configured) gives an open posting from an earlier Oracle period, else the added unit — exactly the behaviour before this decision. Rank and position: Oracle's record in Mode B, the directory's in Mode A. Main unit: the directory's main Unit ID (by ID) in Mode A, else the nearest MAIN_UNIT_ID = ID unit above (ADR-064). Read by `IdentityService` at sign-in and by `AccessRequestService` (`mine` and its identity card, submit, resubmit, inbox, the unit-changed check at the decision).

**Mode A first sign-in (`IdentityService.directoryPerson`).** After the unchanged order (linked identity, HR match, local User ID, first administrator), only when the HR match found nobody (`NO_MATCH`, or `STALE_SOURCE` for want of a fresh mirror) and the identity states no platform role: the same person signing in through the other path (manual directory ↔ identity provider) is linked to the record their first sign-in made (same login); otherwise a LOCAL person is created — the directory's employee number (placeholder `DIR-<login>` when the entry has none, never shown), display name, login — linked with the new method `DIRECTORY` (V44), with NO grant, NO unit entry and no local password; audited `IDENTITY_PROVISIONED_FROM_DIRECTORY` (login, grants 0, Unit ID stated / resolved). A login, employee number or HR account (published mirror) another TMRKZ record holds is refused to the review list with the new reason `DIRECTORY_CONFLICT` (V44; login page and review list labels): never a second record. No enterprise key stays `NO_KEY`. The person then reaches only «طلب صلاحية» (`ZeroAccessFilter`, ADR-066). A login the host operator registers as first administrator after its holder already signed in holding nothing: the identity moves to the temporary administrator (the directory record stays, unlinked and empty).

**What the directory states (`person_directory_profile`, V44).** Login, employee number, display name, rank, position, Unit ID, unit name, main Unit ID, issuer, `observed_at`; written at every sign-in of everyone but platform accounts and the temporary administrator. A path that reads no employment attribute keeps what an earlier sign-in recorded. Never a password, bind credential or token (`LdapProperties`/`OidcProperties.toString` now hide their secrets).

**Configuration — names only, empty = not read.** Manual path: `LDAP_ATTR_UNIT_ID`, `LDAP_ATTR_UNIT_NAME`, `LDAP_ATTR_MAIN_UNIT_ID`, `LDAP_ATTR_RANK`, `LDAP_ATTR_POSITION`. Provider path: `TMRKZ_OIDC_CLAIM_UNIT_ID`, `TMRKZ_OIDC_CLAIM_UNIT_NAME`, `TMRKZ_OIDC_CLAIM_MAIN_UNIT_ID`, `TMRKZ_OIDC_CLAIM_RANK`, `TMRKZ_OIDC_CLAIM_POSITION`; the employee number is the existing `TMRKZ_OIDC_EMPLOYEE_NUMBER_CLAIM`. A value that is not a plain attribute or claim name stops the backend at start. Keycloak: a new installation's realm carries the five ID-token claims `tmrkz_unit_id`, `tmrkz_unit_name`, `tmrkz_main_unit_id`, `tmrkz_rank`, `tmrkz_position`; `ops/keycloak/set-employment-attributes.sh` (dry run by default, `CONFIRM=yes` applies, idempotent) creates, updates or removes the federation's read-only attribute mappers from the `LDAP_ATTR_*` values and adds the five claims to a realm imported before this decision. The directory mappers are not in the realm file because Keycloak refuses an empty LDAP attribute name at import. Not run against :8088.

**Oracle activated (§25).** The sync still copies nobody (ADR-065). A unit TMRKZ held under the same Unit ID becomes Oracle's at the sync (`HrProjection.organizations` adopts a LOCAL unit carrying that `source_external_id`, audited `HR_UNITS_ADOPTED`): no second node. A person the directory created moves at their next sign-in (`IdentityService.toOracle`): looked up live by the sign-in's enterprise key as a first sign-in is; exactly one ACTIVE record is imported onto the SAME person (the projection adopts a LOCAL record with that employee number; when the directory's number differs or was a placeholder, Oracle's is taken first unless another record holds it), so grants, requests and history stay; audited `HR_PERSON_IMPORTED`. The same for a first provider sign-in of a person the manual path created (`hrMatch`). HR unreachable, no record, several, inactive, or the record already another person's: the person stays as they are, signed in, audited `IDENTITY_SOURCE_TRANSITION_DEFERRED`, and Oracle gives them no unit (or the added one). New sign-ins nobody holds are refused again unless Oracle has their record (ADR-065): the directory rule applies only while Oracle is not in force.

**Disagreement (§26).** With Oracle in force, the directory's Unit ID is compared at every sign-in with Oracle's (`hr_person.unit_external_id`): a difference is audited `IDENTITY_ORG_SOURCE_MISMATCH` (`directoryUnitId`, `oracleUnitId`, `decidedBy` ORACLE) once per change of the pair (`person_directory_profile.org_mismatch`), never blocks the sign-in, and the person sees Oracle's unit only.

**Page.** `/access-requests/mine` `identity` adds `sourceCode`, `unitConfigured`, `unitOrigin`, `statedUnitId`/`statedUnitName` (only when not configured) and `observedAt`; source «الدليل المؤسسي» or «الموارد البشرية». `AccessRequestPage.IdentityCard` (`lib/identityCard.ts`) shows a unit not configured as received, marked «غير مهيأة في النظام», with the owner's sentence; submit and resubmit refuse with `details.reason = UNIT_NOT_CONFIGURED`. Once a unit carries that Unit ID, the stored statement resolves without a new sign-in.

**ACCEPTANCE ONLY — OWNER DECISION PENDING.** (1) Mode B = an enabled source with a published snapshot; an unreachable or stale Oracle never falls back to the directory. (2) Directory people are source LOCAL with link method `DIRECTORY` (not a new person source), so HR's existing adoption by employee number moves them. (3) The `DIR-<login>` placeholder when the entry has no employee number. (4) An unconfigured directory unit falls back to a unit an access manager added the person to. (5) Units made before Oracle carry no Unit ID today (only Oracle-imported units do; the integration import has code, name and parent): how a pre-Oracle unit gets its Unit ID is open, and until then the directory resolves only units that carry one.

**Tests.** `DirectorySignInIT` (in-memory directory over StartTLS, fictional attributes): AUTH-01/SOURCE-01 `firstSignInBeforeOracle`, AUTH-02 `unknownUnit`, AUTH-03/AUTH-04 `zeroAccessReachesNothing`, `bootstrapAdministrator` adapted (before Oracle an unregistered first sign-in holds nothing; the registered login still becomes the temporary administrator, then moves to its HR record). `EnterpriseSignInIT` `firstSignInFromClaimsBeforeOracle` (claims; a platform-looking or conflicting identity gets no record); its other tests now run with Oracle in force. `EmploymentContextIT` `directoryThenOracle` (SOURCE-01…04 on the Oracle-compatible test source). Frontend `identityCard.test.ts`.

## ADR-069 Unit-owned requests and unit-owned approval seats; the final access approval role by role, with a preview (owner decision, 16 Nov 2026)

**Owner.** «LDAP FIRST LOGIN + ZERO ACCESS + UNIT-OWNED REQUESTS + UNIT-OWNED APPROVAL SEATS» — the final version of the specification ADR-066 and ADR-068 implemented: two rules at once — RULE A, an operational request belongs to the organisational unit (the submitter is history); RULE B, an approval responsibility belongs to a seat of the unit and a person is only its current holder. This decision closes what ADR-066 left open (per-role scopes and a preview at the final access approval) and what the final text adds (§23, §24, §33, §36).

**Statements (§43).**
- **Authentication:** LDAP proves identity.
- **Organisational source:** LDAP until Oracle HR is enabled; Oracle thereafter (ADR-068).
- **Authorization:** TMRKZ/OpenFGA grants permissions.
- **Operational request ownership:** unit-owned, person-submitted (`restationing_request.requesting_unit_id` is the owner, fixed at creation; `requester_id` is history).
- **Approval responsibility:** unit responsibility, human holder (a role whose permissions decide somebody else's stage — `Permission.STAGE_DECISIONS` — is a seat; its holder is resolved at view and decision time).
- **Unit identity:** stable Unit ID (`organization.source_external_id`), never the name.

**The final access approval, role by role (§14).** The final approver sends `grants`: for each role its own scope in the grant/target/levels model every grant uses — `ROLE` (the role's default reach at the person's unit) or `CUSTOM` with targets: a unit alone, a unit with its descendants, a unit with chosen levels under it (`GrantSource.reach`), chosen sites — and `validFrom`/`validTo`. No second scope engine: `GrantAdminService.planAccessGrants` builds the very `RawGrant` the final step writes (`writePlanned`), and its wording is `describe()`, the same text every grant list shows. Bounds: only roles offered, asked or advised; the whole system and the final-approval roles from a global access manager only (as every grant, ADR-058 — now also on the one-scope path); a scoped decider (an access manager's «اعتماد نهائي» companion) only inside the units their own grant of the task's role covers; «معتمد السلسلة الهرمية» as TNQL's (one level, alone or with what lies below it, never a main unit); levels that find no unit, a start in the past, an end before the start and a duplicate role are listed as problems. The requested / recommended / granted sets stay apart (V28), and what was granted role by role is kept exactly (`access_request.granted_detail`, V45). The old one-scope body still works for API callers.

**«الصلاحيات التي ستصبح فعالة» (§15).** `POST /access-requests/{id}/preview` (only for the holder of the open final step) returns, per role: role, unit responsibility or personal permission, anchor units, scope text, descendants, levels, units covered today, validity, «اعتماد عمليات الوحدة حسب الوقت» set on a command above or inside the anchors (shown, never changed), and what blocks it; plus a fingerprint of the person, the unit and the normalised grants. The approval must carry that fingerprint; anything changed after the preview is refused (409 `STALE_REVISION`). The page («طلبات الصلاحية») edits each role with the same «تعيين» dialog as the access workspace, fed by `GET /access-requests/{id}/scope-tree` (the person's main-unit branch with HR levels, for whoever holds a step of the request — a final approver needs no other right to read it), and «اعتماد وتفعيل» is enabled only on an unchanged, problem-free preview.

**The person moves while asking (§24).** Before anything is advised or granted the person's unit is read again from the one employment context. When it changed, the SAME request — number, history, earlier revisions — starts over at the current unit as a new revision: the old unit's open steps are cancelled, advice and any scope tied to the old unit are cleared («وحدتي» / «وحدتي والتابعة» read the same), the request's owner moves first so the route is derived from the current unit (its nearest access manager, or straight to the final approval, recorded), audited `ACCESS_REQUEST_UNIT_CHANGED` «الوحدة تغيرت أثناء طلب الصلاحية». The step's holder triggers it explicitly (`REROUTE`, «إعادة التوجيه إلى الوحدة الحالية») and an `APPROVE` on a moved person reroutes instead of granting. A returned request resubmitted after a move moves with the person the same way. Operational requests are unaffected (RULE A).

**Seats when the holder moves (§20, §23).** The existing safe HR rule (V3): every grant that follows the posting (`follows_affiliation`, the default) ends when the person leaves its unit's branch (`HR_TRANSFER`); an explicit cross-organisation grant stays. Before it, `SeatRelease.release` ends the seats the person held for the unit they left — reason `SEAT_UNIT_LEFT`, audited `UNIT_SEAT_RELEASED`, with what hangs on them (a tied final step, delegations) — so the history tells a seat released to its unit from a personal permission ending. Nothing is moved to the new unit. Open steps are resolved again: re-stationing stages by the current holders at view and decision time; generic tasks by `TaskRealignment`. Before Oracle (Mode A) a sign-in whose directory Unit ID resolves to another unit applies the same consequences (`SeatRelease.directoryMove`: the old user entry ends, a user of the new unit, seats released, grants that follow the posting end with `DIRECTORY_UNIT_CHANGED`, realignment, audited `IDENTITY_UNIT_CHANGED`). Personal permissions follow their configured policy: with the default they end with the move; a requester's submitted request stays with the unit that submitted it.

**Smaller items.** The review step passed for want of an access manager now reads «تم التجاوز — لا يوجد مسؤول صلاحيات يغطي الوحدة» (§33). The zero-access status line says «بانتظار الاعتماد النهائي» once the request reaches the final step (§7). «الصلاحيات المتاحة للطلب» gains a fourth choice: shown for information and not requestable (`SHOWN`, V45; §36) — listed on the page without a tick, addable by the reviewer.

**Not built / open.** A seat as an entity with its own holders table (the grant history is the holders' history, as ADR-066 said). Anchors outside the person's main-unit branch at the final approval (a global access manager does it in the access workspace). The final approver's «كل الوحدات» is not offered in this editor. The production catalogue of requestable roles is the owner's (acceptance broadened it only for the run).

**Tests.** `WorkflowGraphIT` finalApproverSetsEachRole (ACCESS-01/02/03/05/06: four asked, three advised, two granted; unit operations at «SECC» levels 6 and 7; the preview's text equals the written grants'; no fingerprint or a changed choice → 409; the whole system and empty levels listed), movedBeforeFinalIsRerouted (ACCESS-07), askingWithoutReviewer (ACCESS-04, the owner's words), shownNotRequestable (§36); `StationingNextIT` seatSurvivesHolderChange (SEAT-01…04 on «اعتماد عمليات الوحدة»); `RestationingHrSyncIT` transfersThroughHrSync (seat released by an HR transfer and taken by the next holder; OWN-01 the requester's transfer leaves the request with its unit); `DirectorySignInIT` directoryMoveReleasesSeats (§23 before Oracle); frontend `finalGrants.test.ts`.

## ADR-070 Manual platform sign-in and direct enterprise LDAP — Accepted, deployment verification pending (17 Nov 2026)

**Owner.** The owner reviewed the two TNQL-style sign-in buttons and required the manual form to support the existing local platform accounts as well as enterprise LDAP identities, using the direct user-bind approach of the other working applications. The requested enterprise user must be able to sign in manually; automatic enterprise sign-in was not selected because it still requires the approved read-only directory service-bind credential.

**Supersedes narrowly.** ADR-037's statement that «the manual directory path never qualifies» for a platform account is superseded only for the dedicated platform-password client below. ADR-016's service-search/user-bind remains a supported enterprise profile. This decision does not restore the removed demo login, a general TMRKZ-password account, or an automatic fallback between credential stores.

**Automatic and platform manual.**

- The `tmrkz-web` client remains authorization-code + PKCE only; its direct grant stays disabled. The automatic button and its state, nonce, browser binding, token verification and fresh/step-up `auth_time` checks do not change.
- `admin` and `developer`, named by the installation's existing `TMRKZ_PLATFORM_ACCOUNTS`, may instead use the manual form. They are handled first and exclusively by a new confidential backend-only `tmrkz-platform-password` client, not by their passwords against TMRKZ or LDAP. No browser redirect flow or service account is enabled on that client, and the browser client is unchanged.
- `ops/keycloak/set-platform-password-client.sh` manages the client idempotently; its secret comes from `.env` generated by `ops/init-env.sh`, never the source. Only the existing platform realm role is mapped into `tmrkz_roles`. New realm imports contain the same client.
- `OidcClient.platformPassword` verifies the returned ID token using the provider keys and requires issuer, dedicated audience, expiry, username matching the submitted platform login, the installation allow-list and the provider's `tmrkz-platform` role. A bad platform password never retries the same name against LDAP. A non-allow-listed name never enters the platform-password client. Losing the provider role refuses entry.
- The resulting `Identity` goes through the unchanged `IdentityService.resolve`; its TMRKZ session is provider-backed, not mislabeled DIRECTORY. Identity continuity, permanent platform grants, provider logout and normal OIDC step-up remain in force.
- **Measured protocol detail.** Real Keycloak 26.7.5 direct-password-grant ID tokens omit `auth_time`. For *this synchronous grant alone*, a freshly issued and verified `iat` is the password verification time: the token can be obtained only after Keycloak checks the submitted password, and its `iat` must be no earlier than the attempt (with the same 60-second clock-skew and future checks). If an `auth_time` is emitted, it is mandatory and must also be fresh. No authorization-code or step-up response may substitute `iat` for `auth_time`; a stale direct-grant `iat` is refused.

**Direct enterprise LDAP.** `LdapProperties.directBindPattern` accepts exactly one `{username}` marker and no controls. When set, `DirectoryAuthenticator` performs the user's own UPN/DN bind over LDAPS or StartTLS, then uses that same authenticated connection to locate exactly one matching entry and read the stable UUID, login, name and configured employment attributes. Without a direct pattern, the previous service-bind unique-search followed by the user's own bind remains unchanged. Missing/duplicate entries, empty/rejected credentials, missing UUID, unreadable required identity attributes, an unavailable directory, untrusted CA and wrong hostname are refusals, not opportunities to try another mechanism. Direct reauthentication uses the linked login plus UUID; no plaintext password, bind secret or provider token is added to `person_directory_profile` or audit details. JSSE endpoint identification is applied explicitly to both LDAPS and StartTLS wrapping sockets.

**Independent manual configuration and isolation.**

- `TMRKZ_MANUAL_LDAP_*` overrides affect only the backend manual authenticator; base `LDAP_*` still configures the shared/federated directory when no override exists. Keycloak's current local platform users and existing stand-in are not replaced merely to activate direct manual LDAP. `application.yml` selects the manual override then the shared value.
- `ops/keycloak/configure-manual-direct.py` imports only public CA certificates and non-secret endpoint/direct-bind metadata from protected local staging, updates only generated `TMRKZ_MANUAL_*`/relay values, and stores no enterprise-user password. `ops/local/compose.enterprise-manual.yml` is selected automatically by `ops/local/up.sh` when a manual override is present.
- The application network remains `internal: true`. `ops/local/compose.enterprise-manual.yml` adds no outgoing network to the backend. It resolves the one approved directory DNS name to the internal bridge gateway through the backend's `extra_hosts`. `tmrkz-mover-ldap-relay-1` (Nginx stream, host network namespace) listens only on that gateway's directory port and forwards the opaque TLS stream to one fixed upstream. The relay does not terminate TLS, does not listen on a wildcard LAN address and is not a general outbound proxy. General application-network internet isolation remains independently checkable with `sh ops/local/offline.sh check`.

**Authorization and HR.** Directory authentication is not role assignment. Current Oracle/HR source mode and linking rules are unchanged. If the requested enterprise account has no HR match, the narrow remaining setup is the existing **User ID without HR** registration for that exact login, followed by zero business/administrator grants. It is never renamed into, or made a replacement for, the protected `developer` platform account. Automatic enterprise/federated sign-in still needs an approved read-only LDAP service-bind DN and credential, exact-account verification and `set-directory.sh`.

**Rejected shortcuts.** No TMRZ password hashes; no generic LDAP-then-local or local-then-LDAP fallback; no anonymous bind or disabled hostname/TLS verification; no invented local enterprise account; no privileged role merely for sign-in; no copying another product's OIDC secret as an LDAP credential; no direct-grant enablement on the browser client; no general internet route for application containers; no compiled-artifact text patch presented as a source build.

**Verification and limits at acceptance of the source/configuration changes.**

- A refresh backup before changes passed checksum, dump-readability, clean V44 restore and 20-table fingerprint checks. Real Keycloak accepted the existing `developer` through the new client and returned the correct user, dedicated audience, platform role and fresh `iat`; `auth_time` was absent as recorded above.
- The fixed relay passed a trusted LDAPS handshake, correct-host verification and wrong-host refusal. A disposable container on `tmrkz-mover_internal` completed CA-checked anonymous root-DSE `ldapsearch` through it with no user credentials. The listener is gateway-only; the ordinary internet-egress check still passes.
- Current browser: automatic local developer reaches the signed-in application; both manual and return controls work. The backend/web images are unchanged, so the new manual behavior is not represented as deployed. TypeScript, helper/JSON syntax, Compose validation, browser-helper syntax and OpenAPI generation pass.
- `EnterpriseSignInIT.manualPlatformAccounts`, `DirectorySignInIT.wrongHostname` and the new `DirectDirectorySignInIT` are written but **not run**. Docker could not obtain the absent Maven/JDK 25 image because this host has no external DNS route; there is no offline builder/dependency cache. Vitest likewise started no tests because the exact Linux Rollup native package 4.65.1 is absent. A proper source build and those focused tests must precede deployment. Subsequent work must deploy the built artifacts, test both platform accounts and the enterprise user's real password in the manual UI, then record the account's actual identity/HR outcome without exposing credentials. Full evidence: `docs/evidence/manual-sign-in-20261117.md`.

**Built and tested (17 Nov 2026, ADR-074).** The backend this decision describes was rebuilt from its tests and text when the folder was merged; `EnterpriseSignInIT.manualPlatformAccounts`, `DirectorySignInIT.wrongHostname` and `DirectDirectorySignInIT` now run and pass. Deployment on :8088 and a real Keycloak/LDAP check remain open.

## ADR-071 Enterprise automatic Keycloak, independent from local platform identity — Accepted, activation pending (17 Nov 2026)

**Owner correction.** ADR-070 preserved TMRKZ's automatic *local* Keycloak topology rather than matching Duty. The owner explicitly requires the same operational idea as the other applications' Keycloak button. Review of Duty's `keycloak_auth.py`/login route and active client metadata confirms that its automatic button uses a confidential authorization-code client in the **external enterprise realm**; ordinary manual direct LDAP is separate and its optional password grant is disabled.

**Decision.** Preserve TMRKZ's stronger browser protocol (authorization code + PKCE S256, nonce, browser-bound single-use state, signed ID-token issuer/audience/expiry/nonce checks and fresh `auth_time`), but configure automatic sign-in for a **new dedicated TMRKZ client in external enterprise Keycloak**. Do not copy Duty's `MNAWB` client secret/registration, turn TMRKZ's existing browser client into a password-grant client, or import TMRKZ's local realm into the enterprise realm. `TMRKZ_ENTERPRISE_OIDC_ISSUER`, `_INTERNAL_URL`, `_CLIENT_ID` and `_CLIENT_SECRET` select that provider only when supplied.

**Three distinct authentication routes.** (1) Automatic external enterprise SSO. (2) Manual `admin`/`developer`, verified by the local platform-password client with the independent local issuer's signature/role/allow-list checks. (3) Manual enterprise direct LDAP from ADR-070. The local Keycloak instance is retained for the two lasting platform accounts, not as a substitute for enterprise automatic SSO. External directory federation through the existing enterprise IdP means this route does NOT require TMRKZ itself to obtain the previously blocking read-only LDAP service bind. Direct manual LDAP is unaffected.

**Explicit provider separation.** `OidcProperties` adds independent platform issuer/back-channel/browser values and stable local defaults. `OidcClient` chooses the provider's authorization/token/JWKS endpoints, client ID/secret, callbacks and expected issuer/audience independently, with **separate key caches**. `IdentityService.platform` requires the approved local issuer **in addition to** the role and installation allow-list. A foreign enterprise role cannot create/renew lasting platform rights. Local platform password authentication no longer depends on the enterprise browser configuration.

**Defaults cannot cross providers, even when Compose supplies empty values.** `TMRKZ_LOCAL_OIDC_*` holds actual local issuer/back-channel/client credentials; platform values may explicitly override them but never default to the newly supplied enterprise provider when local inputs exist. Direct property-based single-provider tests keep their previous one-provider fallback. Both `application.yml` and the record constructor normalize present-but-empty settings. `OidcPropertiesTest` covers this invariant.

**Attempts and session operations.** Automatic start targets only the external provider. Local platform step-up is selected from the session's stored issuer and targets only the local provider. Logout likewise chooses the session's own provider/endpoint and token; a local direct-password logout needs its direct client/token hint rather than an unnecessarily required browser client. Directory sessions still use directory reauthentication and local session logout. No provider outage falls back to the other provider.

**No migration.** The existing `oidc_login.purpose` check permits only `LOGIN`/`REAUTH`. An initial implementation using `REAUTH_PLATFORM` was therefore rejected during review. The flow now retains `REAUTH` and places the provider choice in a generated nonce namespace (`enterprise.`/`platform.`). The complete nonce is sent to and verified exactly against the chosen provider's signed ID token; the server-stored/marked attempt selects correct callback exchange and JWKS checks. `V4__enterprise_identity.sql` is unchanged.

**External client and connectivity contract.** Registration needs a confidential authorization-code client with implicit/direct grant/service account disabled, PKCE S256, exact TMRKZ callback and post-logout URIs, `openid profile`, supported signed-ID-token algorithms, `preferred_username`, `auth_time`, and explicitly approved employee/employment claim mappings. Enterprise realm roles do not become TMRKZ business roles. Exact public issuer/back-channel routing and Java trust need staging verification; localhost HTTP remains development-only, not production HTTPS readiness. If an isolated back channel cannot reach this client, its approved TLS forwarding path must be as narrowly scoped as the manual LDAP relay rather than adding broad egress. It is not active before client registration.

**Identity, HR and roles.** Existing local identity links and platform people are retained. Enterprise identity linking follows issuer+subject, then the established unique-HR/local-user/bootstrap/review rules; username alone does not prove identities at two issuers are one person. The requested employee may be added only under the already approved supported User-ID-without-HR path if needed, without a privileged role. Successful SSO is never an administrative grant.

**Evidence and limits at acceptance of this source change.** Static review found and corrected the nonce/purpose constraint conflict, empty-compose fallback bug, unnecessarily strict manual-only logout condition, and duplicate test-login/callback assertion gaps. `DualProviderSignInIT` adds different issuers and signing keys, local step-up/logout, external wrong-role and wrong-key refusal; `OidcPropertiesTest` covers empty overrides and provider separation. These tests are **not executed** because the documented Java 25/Maven and Linux Rollup toolchains are still absent after exhaustive searches of the other applications. Compose/YAML/JSON, TypeScript, helper syntax and OpenAPI checks pass. Current running backend/web images are unchanged; no dedicated external client has been registered and no real U-account sign-in is claimed. Full record: `docs/evidence/enterprise-keycloak-topology-20261117.md`.

**Built and tested (17 Nov 2026, ADR-074).** Rebuilt with ADR-070's backend; `DualProviderSignInIT` and `OidcPropertiesTest` now run and pass. The external client is still not registered.

## ADR-072 Oracle-only active hierarchy by authorised unit-file replacement; retain history — Source accepted, cutover gated (17 Nov 2026)

**Owner decision.** Replace current active units with Oracle units from another application, and **retire and reassign access** rather than preserve administration through name/root mapping. The source is the validated Oracle-derived Duty mirror dated 10 Nov 2026 (76,848 units / 22,516 active), not an arbitrary export or a live Oracle connection. Real parentage derives from the canonical ID path, main units from self-reference, and active from the source status. No people, credentials or person-contact data are imported.

**Preserve identity and history.** Organizations are never physically deleted to perform this cutover. Match only the already stored stable external Unit ID; never infer from a name, row position or root. New Oracle units are created, matches are updated/adopted with the same UUID, and unmatched HR/LOCAL units become RETIRED only for this explicitly authorised replacement. Ordinary HR sync leaves unrelated LOCAL units alone. People, identities, affiliations, HR mirror scope, requests, decisions, responsibilities history and audit records remain linked to their original UUIDs. The previous person mirror rows and scope are carried into the new snapshot; **no person projection runs**. Currently valid memberships on retired units end with `ORACLE_UNIT_REPLACED` instead of remaining apparently live, which also permits the existing audited bootstrap/reassignment path. Currently effective site responsibility closes as historical evidence; nothing is reassigned implicitly.

**Honest dedicated lineage.** V47 (drafted as V45; renumbered to follow the committed V45/V46) adds immutable import-preview/provenance instead of pretending the artifact is a live `hr_sync_run`. It records source hash/schema/contract/timestamp, preview actor/expiry/structure fingerprint/effects/reason, committed actor/timestamp, separate expected and actual effects, and source snapshot for carried people. `PREVIEWED` is distinct from hourly STAGING cleanup. A snapshot's default remains `ORACLE_SYNC` with both original lineage fields; a file unit snapshot has no fictitious sync run or mapping. The disabled enterprise connector and its success timestamp are unchanged; `liveOracleRead` remains false.

**Guarded publication.** A CONFIGURE actor previews only aggregate source/effect counts. Publish takes the existing HR advisory lock, rereads the private payload, verifies digest/size/source timestamps and semantic column contract, rechecks the current structure fingerprint and exact impact, compares staged fields, then carries people forward, publishes and projects organizations in the same transaction. Payload changes, stale previews, identity/code collisions, unaddressed open work, projection-count mismatch or failure roll back all published effects. Replaying a run returns the saved actual outcome without second writes. Postconditions require each active organization to resolve to one active Oracle unit; active children beneath retired ancestors retain their real parent IDs but become navigation roots, and normal trees contain ACTIVE units by default. Explicit AUDIT-gated history is not a grant.

**Evidence and release gate.** The staged file's hash and hierarchy are validated, and a fresh backup `backups/tmrkz-mover-20261117T054828Z` passed archive, clean-restore and 201,963-row fingerprint checks against V44. Main-source type-checking succeeded only as a Java 21 diagnostic, never as a release build. An isolated internal PostgreSQL rehearsal applied 44 migrations then the import migration (draft number V45, now V47) once and reported `mismatches=0`. `OracleUnitImportIT` (17 scenarios) and `V47MigrationIT` are written but **not compiled or run**: the approved Java 25/Maven builder and populated dependency cache remain unavailable. `ops/test-backend.sh` now fails early, creates no test resources and attempts no pulls in that situation. No live unit preview or publication has occurred. Required evidence and the affected-auth/full-suite release gates are in `docs/evidence/oracle-unit-replacement-20261117.md`.

**Built and tested (17 Nov 2026, ADR-074).** The missing `HrProjection` part and the ordinary tree's ACTIVE filter were rebuilt; the migration is V47; `OracleUnitImportIT` (17) and `V47MigrationIT` now run and pass, after five fixes in the copied code. No live preview or publication has been made.

## ADR-073 «مدير النظام» submits «طلب إعادة تمركز» for any unit (owner decision, 17 Nov 2026)

**Owner.** "I want the ability like admin to اعاده تمركز طلب اعاده تمركز"; asked which, the owner chose *submit «طلب إعادة تمركز»* (through the approvals, not a direct move) and *built into «مدير النظام»* (every system administrator, not a grant to one account). Until now the protected role held configuration, access, facilities and source identifiers only (V2, owner decision of 29 Oct), and no one could give the administrator a request right (a grant to oneself is refused).

**Decision.** `SYSTEM_ADMIN` gains exactly one operational permission, `CREATE_RESTATIONING`, over its existing ALL scope: `Bootstrap.seedRoles` for a new installation, V46 for an existing one (the role row and an open policy draft; published policy versions are immutable and stay as published — the system role is outside publication). Nothing else changes: the request belongs to the unit chosen as requesting unit (RULE A, ADR-069), goes through the hierarchy, unit operations, final approval and activation like anyone's, records the administrator as its submitter, and is never decided or activated by them (separation of duties, unchanged). Initial stationing, deployment areas and site registration stay with their own roles (403). By RULE A a holder of the request right for a unit sees and edits that unit's re-stationing requests, so the administrator now sees and may edit and send any unit's.

**Numbering.** Written first as ADR-070; renumbered when the folder version was merged (ADR-074). V46's header comment still says ADR-070 and is left so: V46 is applied on :8088 and Flyway checksums the whole file.

**Smaller items.** `RestationingService.reach`: a grant over everything is confirmed once (`canEverywhere`) instead of once per unit (1,144 units on :8088 → the editor's unit list in 70 ms). «طلب جديد»: the hub lists the first 300 units; the re-stationing card is now available when any stationed unit is in reach beyond them, and when the list is cut short its button opens the editor (site first) instead of scrolling to the list.

**Tests.** `StationingNextIT` systemAdministratorRequestsRestationing (the administrator's permissions; every unit in reach; the hub card; a request for another unit is that unit's, sent, refused to the administrator's decision, decided by the hierarchy; initial stationing and deployment areas refused). Unchanged and passing: `RestationingWorkflowIT`, `AccessAdminIT`, `AccessWorkspaceIT`, `DirectorySignInIT`, `EnterpriseSignInIT`. Deployed on :8088 (V46) after the verified backup `backups/tmrkz-mover-20261117T075129Z`.

## ADR-074 The folder version merged into main: the access screens as the folder has them, the missing backend rebuilt (owner decision, 17 Nov 2026)

**Owner.** After a page-by-page comparison of `main` (6954fea) with the working folder: "use the one from folder merge it to git"; asked how, since the folder's backend changes had not been copied, the owner chose "Rebuild the missing backend" (the backend reconstructed from the copied tests and decision texts, then tested).

**What the folder held.** Work done on 16–17 Nov by another agent in a VirtualBox VM that shares this folder (no JDK/Maven there, so none of it had been compiled or run), based on `733b4aa`: the decisions now numbered ADR-070, ADR-071 and ADR-072 (written as ADR-069/070/071 — renumbered because `main` already had ADR-069), the sign-in wording «الدخول الآلي برقم الــــ U», `nginx.conf` `sendfile off`, the ops changes for the local password client, the manual enterprise LDAP relay and shared-folder map access, the Oracle unit import (migration drafted as V45, now **V47** — V45 and V46 were taken), tests and evidence. Its changes to existing backend files were missing.

**The access screens (owner's choice).** The folder's `AccessInboxPage`, `AccessRequestPage`, `AccessOfferDialog`, `UnitsDialog`, `PermissionsPage`, `client.ts` and `app.css` are those of `733b4aa`: the final access approver sets one scope for all activated roles, with no «الصلاحيات التي ستصبح فعالة» preview; «الصلاحيات المتاحة للطلب» offers two audiences (no «تظهر للاطلاع ولا تُطلب»); the button reads «الصلاحيات المعروضة للطلب». They replace ADR-069's role-by-role screen. The server keeps ADR-069's API (per-role `grants`, `/preview`, `/scope-tree`, `SHOWN`) and still accepts the one-scope body these screens send. `frontend/src/lib/finalGrants.ts` and its test, used only by the replaced screen, are removed. ADR-069's paragraphs on that screen, its evidence screenshots and `tests/acceptance/acc69-ldap-first-login.mjs` describe the replaced screen.

**Rebuilt backend.** *Sign-in (ADR-070, ADR-071):* `OidcProperties` (local / platform / enterprise providers; empty values mean "not supplied"; the automatic provider is the enterprise one only when its issuer is supplied, otherwise the whole local set), `OidcClient` (a provider per attempt through the nonce namespace, separate key caches, `platformPassword` with the direct-grant `iat` rule, logout and step-up by the session's own provider), `IdentityService.platform` (also requires the local issuer), `AuthController` (allow-listed names only through the password client, never LDAP; others never reach it), `LdapProperties` (`directBindPattern`, `TMRKZ_MANUAL_LDAP_*`), `DirectoryAuthenticator` (direct user bind, then exactly one entry on the same connection; HTTPS endpoint identification on LDAPS and StartTLS sockets), `application.yml`; tests `EnterpriseSignInIT.manualPlatformAccounts` and `DirectorySignInIT.wrongHostname` added. Deviations from the decision text: the manual-over-shared LDAP precedence is applied in `LdapProperties` (a Spring placeholder cannot skip a present-but-empty Compose value); with a manual URL the shared bind credential is never carried over (stricter); an invalid bind pattern stops start-up. *Oracle unit import (ADR-072):* `HrProjection.applyOrganizations(snapshot, cycleUnits, retireUnmatchedLocal)` returning `OrganizationResult` — the organisation part alone, the ordinary hourly sync unchanged (it passes `false`); `updated` counts distinct organisations; the ordinary unit tree lists ACTIVE units (an ACTIVE child of a retired parent is a root there with `parentId` null; `roots` and `?includeRetired=true` — AUDIT — show the real parent). Fixed in the copied code: the HR lock was session-level (`pg_try_advisory_xact_lock` now), `role_def.permissions` read as jsonb, the code-collision check skipped LOCAL units with no Unit ID, the payload stream was closed before its digest was read (every valid file was refused), and `HrSyncService.finish` was given an immutable map on two refusal paths.

**Left out.** `ops/local/compose.offline.yml`'s pins to `mover/backend:local-733b4aa4-v44` and `mover/web:local-733b4aa4-tnql-login` (machine-local images; a V44 backend on the V46 database) — the file stays as on `main`. `.zcode/` (the other tool's plans). The enterprise audit folders (standing rule). V46's header still reads ADR-070 (applied on :8088; Flyway checksums the file).

**Tests.** Sign-in classes 65/65 and Oracle/HR classes 73/73 in their own runs; the full backend suite on the merged tree 353/353 (from a clean build, test database limit raised to 500 connections); frontend type check clean and 297/297 (39 files); `ops/tools/gen-openapi.py` 261 operations / 239 paths.

**Not verified here.** The real Keycloak password client (`ops/keycloak/set-platform-password-client.sh`) and the manual enterprise LDAP relay on :8088; the real 76,848-unit file; the folder's access screens in a browser acceptance run. Open (from the rebuild): PREVIEWED unit snapshots are never pruned; the preview counts expiring memberships with the database clock and the publication with the application clock (a membership ending in between rolls the publication back safely).

## ADR-075 «مدير النظام» sees neither «طلب صلاحية» nor «طلب جديد» (owner decision, 17 Nov 2026)

**Owner.** Shown «طلب جديد» as the administrator saw it (a re-stationing card, a «طلب صلاحية» card and the first 300 of 1,144 units, almost all «بلا تمركز معتمد»): "remove it and remove the pages that related to it"; and of «طلب صلاحية» (the administrator's identity card, «لا توجد لك وحدة في سجل الموارد البشرية», the roles offered): "why this one, I see it".

**Decision (navigation only; the server is unchanged).** A person holding «مدير النظام» (`SYSTEM_ADMIN`) is not offered «طلب صلاحية» — they manage access and cannot be granted a role by themselves — nor «طلب جديد» when their only request right is the role's own «طلب إعادة التمركز» (ADR-073). Their re-stationing request starts from «إعادة التمركز»: the panel's «＋ طلب جديد» opens the editor directly, and the home page's «＋ طلب جديد» is not shown. A request right from any other grant keeps «طلب جديد»; everyone else, and a person with no permission at all (who still sees only «طلب صلاحية» and support, ADR-066), is unchanged. `lib/navigation.ts` `setGrantFacts`, `newRequestHref`; the page for all other people is unchanged.

**Tests.** `lib/adminNavigation.test.ts` (administrator alone; administrator who also requests; requester; no permission).

## ADR-076 «تهيئة المواقع» is the site with its stationing: the responsible unit is the stationed unit; «مدير النظام» sets it up (owner decisions, 17 Nov 2026)

**Owner.** «معسكر البانه» was created by the administrator with «الجهة المسؤولة: الشرطة» and no stationing: the administrator held no «تهيئة المواقع والتمركز» and so had the three steps of the site alone (ADR-067). Asked how units should be stationed there, the owner chose "Give admin site setup"; and: «تهيئة المواقع والتمركز هي نفسها تهيئة المواقع، فعند تحديد الوحدة المسؤولة هي الوحدة المتمركزة».

**Decisions.**
- `SYSTEM_ADMIN` gains `MANAGE_SITE_LINKS` and `CORRECT_STATIONING` over its ALL scope (Bootstrap for a new installation, V48 for an existing one, as V46): the system administrator has the six-step «موقع جديد» (`SiteSetupService.admin`) and «تثبيت التمركز» on a site's card. It still reads no request content and decides nothing.
- In the six-step setup the unit chosen as «الجهة المسؤولة» is the stationed unit: it heads «التمركز الابتدائي», ticked and not removable while it is responsible (other units may be added); a change of responsible unit replaces it; one already stationed elsewhere is not stationed again and the page says where it is (`siteSetupFlow.withResponsible`). Its deployment areas follow the policy in force, as every unit's. The server is unchanged (the save stations the units it is sent). The three-step path of a facilities manager without corrections is unchanged: there the responsible unit still only manages the site.
- A site saved before this decision («معسكر البانه») is stationed from its card («تثبيت»), by the administrator.

**Tests.** `SiteSetupIT` SETUP-07 (the system administrator's six-step save stations its unit with both areas; «تثبيت» stations another; no VIEW, no APPROVE); `siteSetupFlow.test.ts` (the responsible unit heads the plan and keeps its areas; replaced on change; not stationed when stationed elsewhere).

## ADR-077 «ملف الوحدة» removed from «إدارة الصلاحيات والوحدات» (owner decision, 17 Nov 2026)

**Owner.** Of the card «04 ملف الوحدة» (the unit's name, level, parent, manager and counts; «صلاحيات موروثة من عضوية الوحدة»; «منح لكل أعضاء الوحدة»; «إدارات التوفير التي تزوّدها الوحدة»): "remove this card".

**Decision.** The card and its divider are removed; the workspace is two panels (the unit tree and the unit's work area). Nothing on the server changes: existing unit grants («موروثة من الوحدة», V36) and providing departments keep their effect and their API, but are no longer edited from this page. `tests/acceptance` scripts that open `aw-file` describe the removed card.

## ADR-078 Fewer stationing permissions and roles: one request right, the final approver decides the excess and the lifecycle, initial stationing only in site setup (owner decisions, 17 Nov 2026)

**Owner.** Eight decisions on the stationing permissions, and an addition the same day on «إدارة الصلاحيات والوحدات», which still showed too many roles as columns:
1. «طلب تمركز أولي» is removed: a unit's first stationing is recorded only in «تهيئة المواقع» (ADR-067, ADR-076: the responsible unit chosen for a site is the stationed unit).
2. «طلب منطقة انتشار» and «طلب إعادة التمركز» are one permission, «طلب إعادة التمركز ومناطق الانتشار».
3. «اعتماد استثناء مسافة الانتشار» is neither a permission nor a stage: a request beyond the policy's range is flagged on every stage and its final approver decides it with the normal decisions.
4. The four lifecycle permissions are removed: the requester starts each action, the request's final approver decides it, the activation right activates an approved extension; whoever started an action never decides it.
5. «إدارة المرافق» and «إدارة روابط المواقع» are not roles of their own: they are part of «معتمد عمليات الوحدة» (within its grant) and of «مدير النظام» (everything); the roles «ربط الوحدات بالمواقع» and «إنشاء طلب منطقة انتشار» are emptied.
6. «تصحيح التمركز» stays with site setup only («مدير النظام», «تهيئة المواقع والتمركز»), never with requesters.
7. «إعادة إرسال أحداث التمركز» is part of «مدير النظام».
8. «إنشاء طلبات التمركز» holds VIEW, CREATE_RESTATIONING and REQUEST_SITE_REGISTRATION.
Addition: the stationing requester is displayed «مقدم الطلب»; MOVER's facilities roles («مقدم الطلب» REQUESTER, «مراجع المرافق», «مدير الجهة», «صاحب الاعتماد», «اطلاع محدود») and the partial duplicates («إنشاء طلب منطقة انتشار», «طلب اعتماد موقع», «ربط الوحدات بالمواقع») are emptied, renamed so they cannot be confused, their grants ended with a recorded reason, no longer offered; the access-workspace matrix shows only unit roles that give something, in the owner's order, never «مدير النظام», «مدقق السجلات» or «تهيئة المواقع والتمركز»; empty roles leave the other role pickers too.

**Actions (`Permission`).** Removed: «(صلاحية مُلغاة)», `CREATE_RESTATIONING`, «(صلاحية مُلغاة — يقررها المعتمد النهائي)», «(صلاحية مُلغاة)», «(صلاحية مُلغاة — يُفعَّل بتفعيل التمركز)», «(صلاحية مُلغاة)», «(صلاحية مُلغاة)» (25 actions remain; the OpenFGA model is generated from the list, so its 119 relations of those seven go with them — `docs/authz/model.fga` regenerated, `AuthorizationIT` compares it with the generator). `Permission.RETIRED` names each removed action and what replaced it (only `CREATE_RESTATIONING` → `CREATE_RESTATIONING`); `Permission.parse` and `Permission.current` read stored names without ever failing. `STAGE_DECISIONS` keeps approve, recommend, hierarchy, unit operations, final, FYI and activation.

**Requests.**
- `POST /restationing-requests` with purpose `INITIAL_STATIONING` is refused for everyone (400, «طلب التمركز الأولي أُلغي بقرار المالك: يُسجَّل التمركز الأولي للوحدة مع موقعها من «تهيئة المواقع».»); an old one is still read, checked and cancelled, never edited or sent again (`can.edit`/`can.submit` false). `GET /request-hub/units/{id}/sites` (its site picker) is removed. «طلب جديد» offers re-stationing, deployment areas and site registration; a unit stationed nowhere reads «لا تمركز حالي للوحدة؛ يُسجَّل تمركزها الأولي من «تهيئة المواقع».». «مسار الموافقات» sets a path for those three types.
- `CREATE_RESTATIONING` opens, edits and sends re-stationing and deployment-area requests for the requesting unit (`RestationingService.createPermission`); `REQUEST_SITE_REGISTRATION` site registration. The home page counts units without stationing or areas over the posture's reach and the request right's reach (a grant over everything aside, so «مدير النظام»'s home is unchanged).
- **Beyond the range.** A leg between the policy's maximum and maximum + `exception.maxExtraM` still needs a written reason; the route has no exception stage (`RouteDerivation.Kind` has no `EXCEPTION`). The request view carries `exceedsPolicy` — per leg the distance, the allowed maximum, the excess and the reason, from the last submitted revision's checks — and each list row a boolean; everyone who sees the request sees «يتجاوز المسموح» with the excess. The final stage (the configured final approval, or the hierarchy's final level when the path has none) decides it with approve / return for changes / reject, and its audit records the excess it covered. The final stage depends on every fact, so a changed deployment area is decided again. Beyond the margin is still a hard refusal, as is the site footprint.
- **Lifecycle (`RestationingLifecycle`).** Cancellation before activation, cancellation before start, early return and an extension are started by whoever holds the request's right for the requesting unit now (RULE A, ADR-066/069) and decided by the nearest holder of `FINAL_APPROVE_STATIONING` covering the requesting unit (`Stations.nearestGrants`, as the final stage itself), the human who started it left out first and refused (`SEPARATION_OF_DUTIES`), nor acting on that human's delegation. An extension is its own request decided on its route; `ACTIVATE_STATIONING` activates it, never by its requester or final approver.

**Roles (data).** «مقدم الطلب» `STATIONING_REQUESTER`: VIEW, CREATE_RESTATIONING, REQUEST_SITE_REGISTRATION. «معتمد عمليات الوحدة»: + MANAGE_FACILITIES, MANAGE_SITE_LINKS. «مدير النظام»: + REPLAY_STATIONING_EVENTS (Bootstrap; V49). Emptied and renamed: REQUESTER «مقدم الطلب (مرافق — غير مستخدم)», FACILITIES_REVIEWER, ORG_MANAGER, APPROVER, LIMITED_VIEWER «… (مرافق — غير مستخدم)»; DEPLOYMENT_REQUESTER, SITE_REGISTRATION_REQUESTER, SITE_LINK_MANAGER «… (مكرر — غير مستخدم)». `ops/policy/*.json` carry the new definitions (the emptied duplicates are no longer in them). A role without actions is never given — grant, access-request approval, unit grant, seat or duty permit (`GrantAdminService.requireGivable`) — nor offered for request (`AccessRequestService.OFFERABLE`). The access-workspace matrix (`AccessWorkspaceService.Role.column`): not the system role, not an emptied role, not a role over everything holding a whole-system action (configuration, audit, source identifiers, stationing corrections, event replay — so «مدقق السجلات» and «تهيئة المواقع والتمركز» go, «معتمد طلبات الصلاحية» stays); order «مقدم الطلب»، «معتمد السلسلة الهرمية»، «معتمد عمليات الوحدة»، «المعتمد النهائي»، «تحديد وحدات العلم»، «للعلم»، «تفعيل التمركز»، «متابعة الموقف العملياتي»، «مدير صلاحيات الوحدة»، «معتمد طلبات الصلاحية», then any other unit role. The grant dialog, the dated-membership form, the offer dialog, the grantable-roles dialog and the final access approval hide empty roles (`lib/rolePicker.ts`); the role catalogue keeps them, marked «بلا صلاحيات».

**A new installation.** Bootstrap seeds «مدير النظام» and «مدقق السجلات», and MOVER's five facilities roles emptied with their new names. `tmrkz.access.legacy-facility-roles` (`TMRKZ_LEGACY_FACILITY_ROLES`, default false) seeds them with their old actions instead: set for the backend tests, which still exercise MOVER's facilities reservation engine with them, and the fictional acceptance environment (`ops/test-env/compose.data.yml`). It changes nothing on a database that already has the roles.

**An existing installation (V49, `V49__stationing_permissions_simplified.sql`).** One transaction; on a new database every statement finds nothing.
1. Every role (`role_def`): the removed actions dropped, `CREATE_RESTATIONING` turned into `CREATE_RESTATIONING` (so a role the administrator built keeps the deployment request); the role-specific definitions above; the eight roles emptied and renamed; grantable lists without them, «مقدم الطلب» in the facilities requester's place.
2. Their grants end with «أُفرغ الدور بقرار المالك (ADR-078، ترحيل V49)…»: memberships (`valid_to`, `ended_reason`), the delegations of those memberships (`revoked_at`, `revoke_reason`), unit grants and duty permits (their `ended_by` must name a person, so it is the one who gave them, and the reason says the migration ended them), position seats made inactive.
3. Offers: «مقدم الطلب» takes the facilities requester's audience if it had none; the eight roles are no longer offered.
4. When a policy version is published and a role changed: a new PUBLISHED version holding the roles now in force («تبسيط صلاحيات التمركز وتقليص الأدوار بقرار المالك (ADR-078، ترحيل V49)», based on the one it supersedes, no publisher — as version 1), the previous one SUPERSEDED, `role_def.policy_version` set; an open draft keeps its place after it (renumbered, based on it) and its roles get the same changes, so its impact keeps comparing like with like. Published versions are immutable and keep the names they were published with.
5. An undecided distance-exception stage of a request still on its way (draft, in review, returned, paused, cancellation pending) is taken off its route: its final stage decides it now. A decided one stays as history.
6. One audit event `ACCESS_ROLES_SIMPLIFIED` (roles before and after, every grant ended, stages removed), and an `authz_change` so every holder's tuples are worked out again; the role_def trigger notes it too.

**History stays readable.** A role still naming a removed action (by hand, or an old seed) gives nothing for it and never fails a request (`GrantSource`, `GrantAdminService`); a draft naming one is refused («صلاحية أُلغيت بقرار المالك (ADR-078)»); restoring a version from before the decision translates its actions (`Permission.current`) and records what it translated (`POLICY_RESTORED.detail.retiredPermissionsTranslated`); a stage of an old request routed to a removed action is decided by nobody (a refusal, never an error) and the request view, list and visibility read it. OpenFGA: the model hash changes, so the next start writes the new model; the sync deletes the tuples of the removed relations (OpenFGA does not check deletes against the model).

**Choices made without the owner, each reversible.**
- «مدير النظام» can now open a deployment-area request for any unit: it holds CREATE_RESTATIONING (ADR-073) and the two are one right. Its «طلب جديد» stays hidden (ADR-075).
- "Larger than the policy allows": the policy has no maximum size for a deployment area, so only the distance excess is flagged; a site beyond `maxFootprintAreaM2` and a distance beyond the exception margin stay hard refusals.
- The lifecycle decider is the final approver of the requesting unit (`FINAL_APPROVE_STATIONING`) even where the path ends at a hierarchy level with no configured final approval. The one who asked but no longer holds the request right can no longer start an action (RULE A).
- «مقدم الطلب» takes REQUESTER's place in the offer and in grantable lists.
- Whole-system roles are recognised by their actions, never by their names.

**Not changed.** The site-setup flow and its distance rule (no exception in setup), activation and its separation of duties, the hierarchy, unit-operations and final stages, FYI, the generic workflow engine, MOVER's facilities engine (still tested, with the legacy roles). `tests/acceptance/restationing-acceptance.mjs` (sections X and the lifecycle), `full26-verify-grants.mjs` and `main-8088-extra.mjs` describe the rules before this decision; the fictional seeds under `ops/test-env` and `ops/acceptance-main` are updated.

**After deploy.** Nothing to run by hand: Flyway applies V49, the backend writes the new OpenFGA model and the sync applies the grants. Take the usual verified backup first; rebuild the web image with the backend. Check: `select code, name, permissions from role_def order by sort_order`; the latest `access_policy_version`; `select detail from audit_event where action = 'ACCESS_ROLES_SIMPLIFIED'`; the matrix columns in «إدارة الصلاحيات والوحدات».

**Tests.** `PermissionSimplificationIT` (V49 on :8088-shaped data in a rolled-back transaction: roles, grants ended with the reason, offers, the recorded version and the carried draft, the old exception stage, the audit; a second run changes nothing; a version from before the decision restored with today's actions); `StationingNextIT` initialStationingIsSiteSetup (no card or action, refused for everyone, set up by «تثبيت», then the unit's deployment request through every stage), oldInitialStationingRequestStaysReadable, systemAdministratorRequestsRestationing (deployment areas allowed, site registration refused, REPLAY_STATIONING_EVENTS), aPathForEachType (three types); `RestationingWorkflowIT` checks (no exception stage, flagged for every stage with the excess, the final approver returns, approves and rejects, audited); `RestationingLifecycleIT` (started by any requester of the unit, refused to others; decided by the nearest final approver, never by who started it nor a wider holder; extension activated with «تفعيل التمركز»); `StationingRulesTest` (no exception kind; the final stage decides); `SiteSetupIT` (the requester's new rights still get 403 on setup); frontend `rolePicker.test.ts`, `permissionLabels.test.ts`, `requestPurpose.test.ts`, `adminNavigation.test.ts`, `siteSetupFlow.test.ts`, `workspace.test.ts`. Full backend suite 357/357 (from a clean build); frontend type check clean, 316/316 (43 files); OpenAPI 260 operations / 238 paths (the site picker's endpoint removed).

## ADR-079 TMRKZ with MOVER's identity and HR settings; the earlier military number; Active Directory searched from its root (owner, 17 Nov 2026)

**Owner.** "Import the same settings as we did in mover app … for Oracle, for LDAP, for everything there on the setting … the only difference is how the app works … from login, how Keycloak works, how both buttons work, how the LDAP, how sign in, how we add the people. So I add the people by number, it will fetch its user"; for Oracle: "just build the same setting where we go and add the IP address, the SID, the user name and password same as mover"; and approval to share MOVER's local sandboxes (a read-only Oracle account, test accounts and one service account in its directory, both containers on TMRKZ's isolated network).

**What MOVER has on this PC (read only, `703cf1ec`).** Directory: `mover-ldap` (Samba AD), StartTLS with «MOVER Dev LDAP CA», base `DC=mover,DC=local`, each person binds as `user@mover.local` (no service account), attributes `MilNumber`/`MilRankName`/`MilOccupation`/`MilCurrentUnitName`. Keycloak: disabled here. Oracle: no connection saved and its stored test password belongs to another machine; the intended source is the sandbox `mover-oracle-hr` (FREEPDB1) with `HR_ENV_UNITS_AI`/`HR_PRS_EMPLOYEES_ALL`; mapping v1 as in `docs/MOVER_SETTINGS_PARITY_AR.md`.

**Decision — configuration, not a second model.** TMRKZ's existing settings already have MOVER's fields (Oracle: host or address, port, service name or SID, user, password, two views; the one-by-one people of ADR-065; the two sign-in buttons of ADR-070/071). They are filled with MOVER's values: `.env` names MOVER's directory in TMRKZ's keys (`LDAP_URL`, `LDAP_START_TLS`, `LDAP_USERS_DN`, `LDAP_DIRECT_BIND_PATTERN={username}@mover.local`, AD vendor/attributes, MOVER's attribute names for rank, position and unit name); Keycloak's federation points at the same directory (`set-directory.sh`, `set-employment-attributes.sh`), with a read-only service account because Keycloak searches; «مصدر الموارد البشرية» holds the sandbox with a read-only account and MOVER's mapping. `ops/local/use-mover-sources.sh` and `ops/local/mover-settings.mjs` repeat it on this kind of machine; on the isolated server the administrator types MOVER's values into the same screens.

**Kept different, on purpose.** TMRKZ reads the whole unit tree hourly (ADR-065, owner) where MOVER imports units on demand every 3 h; a unit from the directory is joined by Unit ID only, never by name (owner's specification), where MOVER matches `MilCurrentUnitName`; the automatic button needs a TMRKZ client in the enterprise Keycloak (ADR-071), never MOVER's client; TMRKZ connects with JDBC thin (MOVER defaults to thick with Instant Client 19.28).

**Two code changes found by using MOVER's sources.**
- *The earlier military number.* MOVER's live lookup accepts the new number or the old one (`NEW_MILITARY_NO = :n OR MILITARY_NUMBER = :n`). `HrPeopleService.find` now matches `employee_number` or `legacy_employee_number` (when mapped), and «إضافة مستخدم» finds a person already in TMRKZ by either (`UnitMemberService.lookup`). MOVER's last fallback (`LIKE '%-n'` for digits) is not built.
- *Active Directory searched from its root.* With MOVER's base `DC=mover,DC=local`, Samba AD returns continuation references to its other partitions; JNDI with referrals ignored raised «Unprocessed Continuation Reference(s)» after the entries and every manual sign-in answered `DIRECTORY_UNAVAILABLE`. `DirectoryAuthenticator` now treats `PartialResultException` as the end of this domain's entries (Spring LDAP's `ignorePartialResultException` for AD). The enterprise AD searched from its root behaves the same way.

**Data shape of the local sandbox.** `HR_AI` (TNQL's synthetic data, used for the acceptance run so no real person appears) is the older shape: its parent is `MAIN_UNIT_ID`, its path holds names and no unit is its own main unit, so the local mapping takes the parent from `MAIN_UNIT_ID` and leaves the main-unit field out; MOVER's rule (`SORT_ORDER` path, main unit when `MAIN_UNIT_ID = ID`) applies to `HRPROD` and the server. Both sandboxes call the numbers `NEW_MIL_NO`/`MIL_NUMBER`.

**Acceptance (owner's specification «LDAP FIRST LOGIN + ZERO ACCESS + UNIT-OWNED REQUESTS + UNIT-OWNED APPROVAL SEATS», re-run on V49 with ADR-074's screens).** `tests/acceptance/acc79-mover-settings.mjs`, headless Edge on :8088, synthetic HR_AI people, 71/71 — `docs/evidence/mover-settings/SUMMARY_AR.md`. The final access approval has one scope for all roles and no preview screen (ADR-074, owner); the preview is checked through the API and unit-operations levels through the «تعيين» dialog.

**Tests.** `HrLinkedPeopleIT` LP-3 (the lookup by the earlier number finds the same person and writes nothing); `DirectorySignInIT` with an AD-style referral entry under the search base (every directory sign-in searches through a continuation reference); unchanged and passing: `UnitMemberIT`, `HrSyncAcceptanceIT`, `EmploymentContextIT`, `DirectDirectorySignInIT`, `EnterpriseSignInIT`, `DualProviderSignInIT`.

## ADR-080 The three ways of stationing as top-bar tabs; the dark theme in graphite and sand (owner, 17 Nov 2026 — phase 1, review pending)

**Owner.** The brief «إعادة تنظيم التمركز والمواقع ومناطق الانتشار», phase 1 (one screen at a time, shown on :8088, then stop). On the first version (a page of three large cards): "the colours are too much colourful … and the dark theme is too much blue … other than green and dark blue"; «تهيئة موقع (معسكر)» becomes «تحديد مواقع التمركز المبدئية» with «بدء التحديد»; and "instead of putting them in a page, just put them on the top as a tab … you can click, that's it … also put the symbols".

**Decision.** No page in between: the three ways are tabs of the top bar right after «الرئيسية», each with its symbol and its description as tooltip — «تحديد مواقع التمركز المبدئية» (`#siteSetup`), «طلب مناطق انتشار» and «طلب إعادة تمركز» (the request editor with its purpose; never mixed). A tab shows only to whoever may take that way (`lib/stationingHub.ts` `hubWays`, `navigation.ts` `primaryNav`). They replace the entries «تهيئة المواقع» and «إعادة التمركز»; the list of re-stationing requests stays in «المزيد». The two request tabs open one view at two addresses, so the highlight follows the address (`activeEntry(view, links, hash)`). The phase-1 page `StationingHubPage` was built, shown and removed the same day.

**Dark theme.** Navy and teal become warm graphite and the light theme's sand: `theme.css` (base and `--tz-*` variables), `signin.css` (the sign-in page's dark variables) and `ops/tools/gen-theme.py` (dark: teal → sand, navy surfaces → graphite, cyan-grey lines and bluish greys → warm; the ink on a teal fill → `#241a0b`), regenerated into `theme.generated.css`. Status colours and map symbols keep their meaning; the 3D view switch and terrain chips use the accent instead of a fixed blue. Light is unchanged.

**Tests.** Frontend `stationingHub.test.ts` (ways, rights, order, highlight); 318 tests; `tests/acceptance/stationing-hub-phase1.mjs` 6/6 on :8088 in both themes. Contrast in the new dark theme was checked on the shown screens by eye, not yet with `tests/acceptance/theme-contrast.mjs`.

## ADR-081 «تحديد مواقع التمركز المبدئية»: the unit first, three steps; symbols searched by name; the unit search as a hierarchy; a double click finishes the drawing; a lighter 3D without a GPU (owner, 17 Nov 2026 — phase 2, review pending)

**Owner.** Phase 2 of the brief «إعادة تنظيم التمركز والمواقع ومناطق الانتشار»: the setup of a site and its unit's initial stationing only, without «which units are stationed here» and without deployment areas. On the first version: the symbol row "is not clear … the person who wants to click here, he knows that this is for a symbol"; for the search, "check on the internet what the best way … he doesn't know the code, he will search by name"; "when I search for the unit, it will show as a hierarchy view … from the start to the end … I might want the parent"; "fix the rendering slowness for the 3D map"; "when I finish and double click on the map, it should finish the drawing".

**Decision — the steps.** «بيانات الموقع» (the unit first; one already stationed is stopped, its stationing changes by a re-stationing request), «تحديد الموقع والحدود», «مراجعة وحفظ» (`INITIAL_STEPS`, `initialProblem`). The save stays unconnected until the owner accepts the screen; the server's setup still requires the policy's area pair, so the backend step changes it to the site and the unit's initial stationing.

**Decision — symbols by name.** A field that says what it is (a large preview, «لم يُختر رمز بعد», «اختيار رمز») opens a picker window in the pattern of common icon pickers: one search box first, tabs for all, most used, favourites and recent (kept per user in the browser), categories with counts, a grid of large symbols with their names, Enter takes the first. 88 standard symbols in ten categories (MIL-STD-2525C codes, each validated by milsymbol; the earlier 15 codes kept). The search (`lib/symbolSearch.ts`) works on names, keywords, category and the English name, with Arabic normalisation, prefix and light-ending stripping, a synonym dictionary where a synonym of several words matches only as a whole, matching from the start of a word, and a one-typo allowance used only when nothing matches as typed (so «دروع» never brings «درون», «قيادة» never «عيادة»). The code is typed only by whoever may configure.

**Decision — the unit search.** Results are a tree: each unit found under its chain of parents from the top (`TreeHit.chain`, `searchForest`), marked «مطابق»; a parent or a child is chosen the same way, and «+» opens the branch.

**Decision — the drawing.** A double click finishes. The first click of a double click places a corner under the pointer, so the second click and the `dblclick` reached that corner's marker (whose events are kept from the map so it can be dragged) and the map's handler never ran. The corner marker now finishes the drawing on a double click; on an empty spot the result has the last corner, on the last corner none is added.

**Decision — 3D speed.** In the tilted view MapLibre keeps up to 9.3 zoom levels of tiles towards the horizon; 3D now keeps 4 and at most twice the flat view's tile count (`setSourceTileLodParams`), restored in 2D. When the browser reports a software renderer (`softwareRendering`: SwiftShader, llvmpipe, a VM's display adapter), the 3D is lighter: no colour tint, sky or fog, canvas at 0.7 resolution; the heights and the shade stay, because without the shade the tilted map read as flat. The scale bar is removed in 3D (it was recomputed every frame over the terrain). Measured: software average frame 155 → 110 ms, p95 326 → 215 ms; GPU at the screen's refresh rate before and after (`docs/evidence/stationing-redesign/phase2/map3d-perf.md`).

**Tests.** Frontend 331 (45 files), incl. `symbolSearch.test.ts` (synonyms, exclusions, typo), `tree.test.ts` (`searchForest`), `siteWizard.test.ts`; `tests/acceptance/initial-site-phase2.mjs` 15/15 on :8088 in both themes (a double click on an empty spot and on the last corner, symbol searches, hierarchy search, nothing saved, nothing outside localhost); `tests/acceptance/map3d-perf.mjs`.

**Addendum — phase 2 accepted and connected (owner «next», 17 Nov 2026).** «حفظ الموقع والتمركز المبدئي» calls `POST /site-setup` with the site, its boundary and the chosen unit without areas. `SiteSetupService.evaluate` stations a unit sent without areas whatever the policy requires (the pair rule and the policy in force apply only to areas that are sent); the hub then answers `DEPLOYMENT_MISSING` and «طلب مناطق انتشار» asks for them. `SiteSetupIT` SETUP-06 states the new rule. The right to save is unchanged (`SiteSetupService.admin`) until phase 7.

**Addendum — the site list and the site's card (owner, 17 Nov 2026; interface for review).** Inside sites sit under their camp's arrow at any depth. The card shows the facts and three actions; «تعديل» edits data, symbol and boundary in one form with one reason (existing endpoints, each only when changed); «إجراءات أخرى» keeps correction and links. Deletion is shown, not connected: the administrator deletes with a reason (the site retired from list and map, kept in the audit; the unit's initial stationing and its areas end; inside sites first), others ask and the administrator decides. The server's present `retire` has none of these rules; the backend step follows the owner's answer on them.

## ADR-082 «طلب مناطق انتشار» as its own screen; «الفرعية»; the main area solid, the sub-area dashed (owner brief §4, 17 Nov 2026 — phase 3, review pending)

**Owner brief §4.** After an approved stationing, «طلب مناطق انتشار» starts from the current approved site, never from a new starting point; the main area, then the sub-area; distances, rules and terrain from the existing stationing policy; the main area with a solid outline and a transparent fill in its colour, the sub-area dashed with a lighter fill and its own colour; «منطقة الانتشار الفرعية» instead of «البديلة» in the interface (ALTERNATIVE may stay internal). §8: small chips, details behind «ⓘ».

**Decision.** A new request of this purpose opens `DeploymentAreasRequest` (an existing one still opens in `RestationingEditor`). The eligible units come from the request hub; one eligible unit starts the request at the main area. The area is edited with the request editor's `SiteEditor` (placed with the policy's `deploymentAreaDefault` or drawn; a double click finishes), measured centre to centre as the server measures (main from the site, sub-area from the main area); the chips judge against the policy's base range and leave terrain to the server's check. `EditorLook.dashed` draws the sub-area dashed and lighter in the editor; `RequestMap` draws the areas with transparent fills (the hatch is no longer shown) and the sub-area dashed, so every map of a request reads the same way. The interface's «البديلة»/«البديل» became «الفرعية»/«الفرعي» in every frontend string; server messages follow in the backend step.

**Not yet.** «إرسال للاعتماد» is not connected: the backend step saves the draft with `purpose DEPLOYMENT_AREAS`, runs the server's checks and submits it through the existing route, and renames the server's messages.

**Tests.** `deploymentAreasFlow.test.ts`; `tests/acceptance/deployment-areas-phase3.mjs` 10/10 on :8088 (synthetic requester, both themes, nothing sent).

## ADR-083 The sign-in page's notes kept in the settings (owner, 17 Nov 2026 — review pending)

**Owner.** On «إرشادات الدخول»: "make the ability that I can change it in the setting … like notification … I can either add more or [remove]".

**Decision (interface first).** A section of «إعدادات النظام» edits the board: heading, the line under it, up to eight notes — each guidance or «تنبيه مهم», with a small label, a title, a text, optional dates and hidden or shown — their order, and the last line, beside a preview of the board as it shows today (notices first, hidden and out-of-date notes left out). It starts from the three notes the page shows now. The board is read before anyone signs in, so it holds no personal or sensitive information. Not yet connected: the backend step stores the board (an audited configuration value), serves it without sign-in, and the sign-in page reads it with the present notes as the fallback.

**Tests.** `signInNotes.test.ts`; the settings part of `tests/acceptance/site-card-review.mjs`.

**Addendum to ADR-081 — the owner's deletion rules (17 Nov 2026).** A deleted site is erased completely (not retired): its row, boundary, symbol, links; a unit's initial stationing there and that stationing's areas are removed and the unit is back to no stationing; its inside sites go with it, named in a warning before the confirmation. One audit line of the deletion itself (actor, time, reason, what went with it) is kept; the owner was asked to say if even that must go. Only the administrator deletes; others ask, and the administrator approves or refuses. The backend step replaces the present `retire` for this screen with that delete, in one transaction, refused while any request in progress refers to the site or its units (to be shown to the owner).

**Addendum to ADR-082 — second version (owner, 17 Nov 2026).** The steps on the right, the context on the left (`swapSides`, as the setup screen). The first step lists the person's units by camp (`campTree`): each camp where one of them is stationed, its main camp above it, its units in the organisation's order; units the person may not ask for are left out and units stationed nowhere are folded together. A camp is chosen in the list or on the map; its one eligible unit starts the request. The request's header names the camp first.

**Addendum to ADR-082 — third version (owner, 17 Nov 2026).** Lists of units are trees and start folded. The camp and its unit are one choice, shown in the list and on the map, and only «التالي» moves on. The view changes only when a camp is chosen from the list (a deliberate exception to framing each step). Placing and drawing show an arrow and distance to the pointer. Shapes: square, circle, free drawing, and the sub-area as a copy of the main area; handles are phase 5. The slope inside the areas and both arrows with the policy range's verdict are on the map. Sending stays unconnected until the owner accepts the screen.

## ADR-084 Shape tools as Word's on every stationing map (owner brief §7, reference panel 5; 17 Nov 2026)

**Decision.** One toolbar for areas and sites: select (the frame and its handles), move, ready shapes of a size the screen chooses (the policy's initial area; for a sub-area the main area's; for a new site the current site's within the maximum), free drawing, vertices, undo, redo, reset, delete. The frame is computed in metres on a local plane (`lib/shapeTransform.ts`): corners scale evenly from the opposite corner, sides move one side only, the round handle turns the shape around the frame's centre; the editor records each drag as one change (`SiteEditor.startResize`, `startRotate`). The frame's angle restarts upright after a new shape, an undo or a reset. «ضبط المساحة على المسموح» scales the whole shape evenly to the maximum (`scaleToArea`). The pointer guide (`PointerGuide`) draws the arrow and distance from where a shape is measured, in the verdict's colour.

## ADR-085 A fluid layout: the window's width and height, maps that follow their container (owner, 18 Nov 2026)

**Owner.** «PROFESSIONAL FLUID RESPONSIVE LAYOUT PASS»: the dashboard stayed narrow and centred on a wide screen and left the lower half empty; resizing did not reflow; no fixed-width website, no stretched text, no filler cards.

**Decision.** No width cap on the home page; the dashboard is a grid that takes the window's height on a desktop (header and indicators at their size, the map and the lists the rest; lists scroll inside their cards and show more rows on a taller window); breakpoints 1600 px (three columns, the map wider from 2200 px) and 1180 px (two columns, then one). Indicator cards share one row on a desktop and lose their second line on a laptop. MapLibre maps observe their container (`ResizeObserver` → `map.resize()` once a frame) so a panel, a breakpoint or fullscreen resizes the canvas without recreating the map or refitting the view. Work-screen side columns use `clamp()` to grow modestly; the new-request steps column has a floor so its strip and tools fit. Typography is unchanged.

**Addendum to ADR-085 — visual polish (owner, 18 Nov 2026).** One spacing scale, three radii, flat themed surfaces, borders for structure and shadows only for floating layers, colour only where it means something. The indicators form one divided strip; lists are rows on hairlines; the map panel has no inner frame. A short request list switches the home grid to two columns (`is-compact`) so empty space goes to the map, not to an empty panel. The rules sit in one final section of `shell.css`, after the layout rules, and change looks, not structure.

## ADR-086 Deleting a site: erased completely by the administrator, requested by others (owner decisions, 17 Nov 2026)

**Owner.** "Add an option to delete this camp for the admin … the others can ask for delete and only the admin will approve"; on the rules: erased completely; a unit stationed there loses its initial stationing and areas; inside sites deleted together after a warning naming them.

**Decision.** `SiteDeletionService` erases the site and every site inside it in one transaction: deployment areas, links, stationing records (a `STATIONING_REMOVED` event per unit stationed there now), symbol, resources, responsibility, boundary versions, the sites. One audit line keeps who, when, why and what went with it. A request (`site_deletion_request`, V50) keeps a copy of the site's code and name, so it reads after the site is gone; one open request per site; the setup administrators are notified, and the requester on the decision. Nothing that another record still needs is erased: an approved request's site (its `site_id` is required once activated), a request in progress for a unit stationed there, areas a request made, bookings and requests on its resources, old relocation requests, permissions or seats scoped to it, a temporary stationing elsewhere returning there — the deletion is then refused with each reason. Sites, boundary versions and resources keep refusing deletes everywhere else; only a transaction that sets `tmrkz.site_erase` may delete them (V50 replaces those three triggers, nothing else).

## ADR-087 The maximum footprint is decided by the final approver, not refused (owner, 17 Nov 2026)

**Decision.** As a distance beyond the range (ADR-078), a proposed site larger than the policy's maximum is a flag, not a refusal: the checks say `areaOverMax`, every stage sees it, the submission's audit line records the area and the maximum, and the final approver accepts it with the request or returns it for the unit to reorganise the area. The requester may also bring the shape within the maximum in one click (`SiteEditor.scaleToArea`). The policy keeps the value; only its effect changes.

## ADR-088 The deployment areas' own area limits in the stationing policy (owner brief §9, 18 Nov 2026)

**Decision.** `StationingPolicy.Leg` gains optional `minAreaM2` and `maxAreaM2` (written only when set, so versions published before them read back unchanged and compare without spurious changes). The leg check refuses an area outside them, the same check for a request and for the setup; publishing refuses a minimum above the maximum. Unlike the proposed site's footprint (ADR-087), these are hard limits: the brief says the shape is free within them.

## ADR-089 Who may set up sites is a rule in the settings (owner brief §3, phase 7; 18 Nov 2026)

**Owner.** «من يستطيع تهيئة المواقع؟ لا تكون Hard-coded … الإعدادات → صلاحيات تهيئة المواقع … الدور، الأشخاص، الوحدات، نطاق الوحدات، المستويات. الإعداد الافتراضي المبدئي: عمليات الوحدة».

**Decision.** One rule (`site_setup_access`, V52) kept by whoever configures the system: roles, people, units (each with or without the units under it) and levels (1 = the top). A person may set up a site with a unit's initial stationing when they hold a role of the rule acting for that unit (not through a delegation) or are named, the unit is inside the chosen units (none: any) and at a chosen level (none: any). The system administrator («تهيئة المواقع والتمركز», ADR-067) always may. With no saved rule: «معتمد عمليات الوحدة» in that role's own reach.

**How the save works.** `SiteSetupService.setup` and `check` keep the administrator's path unchanged; anyone else goes through `scoped`: at least one unit, every unit allowed, the site's responsible unit allowed (the first unit when none is named), an inside site only under a site whose responsible unit the rule covers. The write then runs with the person's context plus one grant of facility management for that unit (`AccessContext.plus`, no OpenFGA confirmer: the rule is the decision, checked just before). `/me` carries `siteSetup` so the tab shows for people the rule allows.

**Consequences.** Changing the rule is audited (`SITE_SETUP_ACCESS_SAVED`) with a reason. The rule decides who may record an initial stationing; it grants nothing else (no facility management outside that save). A role a person holds through a delegation does not count.

## ADR-090 Partial approval of a request's parts, inside the existing route (owner brief §6, phase 8; 18 Nov 2026)

**Owner.** «إعادة التمركز تتكون من أجزاء … يمكن للمراجع أن يعتمد جزءاً، يعيد جزءاً للتعديل … الموقع والرئيسية يحتفظان بحالة معتمد ولا يعاد اعتمادهما عند تعديل الفرعية … إذا عدّل مقدم الطلب جزءاً سبق اعتماده، يعاد فتح الاعتماد لذلك الجزء فقط»; and «لا تعيد بناء Workflow engine».

**Decision.** A re-stationing's parts are the new site, the main area and the sub-area (a deployment-area request's, its two areas). The decision of a stage may be given part by part (`parts`: APPROVE or CHANGES, with optional notes): any CHANGES makes the stage's decision RETURN (the reason, when none is written, names the parts and notes; `returned.parts` lists them); all approved makes it APPROVE. What each stage decided on each part is kept with the part's fingerprint (`restationing_request.part_reviews`, V53). Back at that stage, a part it approved and that is unchanged is kept and cannot be decided again; an approved part changed since is reopened; a returned part changed since waits for a decision. Other stages decide for themselves; the route, its carry-over by facts (ADR-046) and the final approval are unchanged.

**Consequences.** The whole-request buttons stay for every request; the part panel is shown to the stage that decides now. The audit line of the stage's decision records the parts.

## ADR-091 TMRKZ runs from its folder: data in `data/`, source mounted, one image file (owner, 19 Nov 2026)

**Owner.** «add it in the folder data and mount it also make sure you mount the source code … no need to images»; «I will directly do docker load then docker compose up … will ask me which ip adress to use and which port»; «remove the db password for now … unless I tell you»; the automatic sign-in shows Keycloak's own credentials page, «check how we built it in MOVER».

**Decision.**
- `docker-compose.override.yml`, which plain `docker compose` reads in the folder (project `tmrkz-mover`), runs the installation from the folder. The database, the files and the local directory live in `./data` (bind mounts, git-ignored). The backend and the web are built from `./backend` and `./frontend` inside their containers (`tmrkz/folder-backend:1`, `tmrkz/folder-web:1`, which carry Maven or Node and the dependencies) and rebuilt about 25 s after a saved change; a failed build keeps the running version. No image is built for a code change.
- One image file, `tmrkz-images.tar` with its `.sha256`, made on a connected machine by `ops/local/workspace/pack-images.sh`, which proves that both images build the folder's source with no network. `start.sh` asks for the IP address and the port (`TMRKZ_IP`, `TMRKZ_PORT` in `.env`), loads the file when an image is missing or the file changed, and starts everything; on a new checkout it also writes `.env` (`ops/init-env.sh`) and the local directory's CA and password.
- The one-shot `keycloak-setup` service runs on every start and does what `set-public-url.sh`, `platform-accounts.sh` and `set-platform-password-client.sh` did: the sign-in return address, the `tmrkz-web` secret from `.env`, the login theme, the local directory's bind password from `.env`, and the platform accounts with their manual-sign-in client.
- No database password: `ops/local/workspace/pg_hba.conf` (trust) applies to whatever cluster is in `data/db`. The database is reachable only on the `internal` network, which has no route out. To be revisited before the enterprise launch.
- The realm's login theme is `keycloak.v2`, Keycloak's own credentials page as in MOVER; `TMRKZ_KEYCLOAK_LOGIN_THEME=tmrkz` brings back TMRKZ's page.
- The TMRKZ sign-in page: the chevron brand mark (88 px) and «تمـــــركـــــز» with TMRKZ spread across its width; the backdrop's empty pill and bottom icon row are removed in both themes.
- Removed: `ops/local/up.sh`, `ops/local/offline.sh`, `ops/local/compose.{offline,local-directory,map-access,enterprise-manual}.yml` and `.env.example` (`ops/init-env.sh` writes `.env`). The enterprise-LDAP relay (ADR-070) is the `ldap-relay` service under the profile `enterprise-ldap`.

**Consequences.** `RUN.md` is the procedure: transfer, first start, daily use, code changes, importing a database, the relay, the prompt for the VM's AI agent. Tools that name their Compose files with `-f` (`ops/test-env`, `ops/verify-migration-path.sh`, `ops/airgap-bundle.sh`) keep the image-built application. A machine whose data is still in the Docker volume `tmrkz-mover_db-data` starts with an empty `data/db`; `start.sh` says so and `RUN.md` section 6 moves it. Verified on a Docker-in-Docker machine with no network and no images, from the unzipped folder: the images loaded, every service healthy, six sign-in paths, `developer`, the maps with no external request. The enterprise LDAP relay is not tested in this layout.

## ADR-092 «إعدادات التكامل»: the directory and the enterprise Keycloak entered in the application, as MOVER; one address everywhere (owner, 20 Nov 2026)

**Owner.** From the VM: the sign-in against the enterprise directory failed on the relay's placeholder name, the OIDC issuer and
return address had been edited by hand in `docker-compose.override.yml`, and the manual-LDAP settings lived in `.env`. «Make it
everywhere the same in local, remote and so on so that I don't get confused»; «fix the issue for LDAP — you didn't use the same as
how MOVER works»; «you didn't add in the UI that I can change these variables — I want the ability to change them»; «the
Keycloak wasn't built the same as we want».

**What MOVER does (read-only review of `~/Desktop/mover`, 20 Nov 2026).** The directory: `ldap3`, a direct connection to the
AD host named as in its certificate, each person binds as `user@LDAP_DOMAIN` (no service account, no relay), the entry found on
that connection by `userPrincipalName` under `LDAP_BASE_DN`, TLS verified against the CA file `LDAP_CA_CERT_PATH`, LDAPS or
StartTLS. Keycloak: MOVER builds none; it is an OIDC client (authorization code + PKCE) of the organisation's Keycloak —
`KEYCLOAK_SERVER_URL`, `_REALM`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_INTERNAL_URL`, `_ISSUER` (default `<server>/realms/<realm>`),
`_REDIRECT_URI`, `_CA_FILE`. An administrator page «إعدادات التكامل» edits both with «اختبار الاتصال» (the secured channel
and an optional bind; the discovery document and its issuer), writing `.env`, applied at the next restart.

**Decision.**
- `integration_setting` (V54) keeps two sections, DIRECTORY and OIDC: the values as JSON, the secret (service-account
  password, client secret) encrypted with TMRKZ's own key (`TMRKZ_HR_SETTINGS_KEY`, as the HR source), who saved and when.
  `IntegrationSettingsService` turns the directory section (MOVER's fields: server, port, LDAPS/StartTLS, domain, base DN,
  attributes, CA PEM, timeout) into `LdapProperties` — `{username}@domain` as the direct-bind pattern, or the service account
  when no domain is given — and the Keycloak section into the automatic provider of `OidcProperties`
  (`withAutomatic`; back channel = internal address or server address + `/realms/<realm>`; issuer as MOVER). Both are in force
  the moment they are saved (a version counter renews the cached properties and the key caches) and take precedence over
  `.env`; nothing saved, or a section switched off, leaves `.env` in force. The platform accounts' local Keycloak is never
  changed by the screen: an enterprise issuer cannot become the platform issuer (ADR-071 holds).
- `DirectoryAuthenticator` and `OidcClient` read the settings in force on every call. The trust is the CA folder plus the
  pasted certificates (`Trust`): only those for the directory; the runtime's CAs as well for the HTTPS calls to Keycloak.
  `test` / `probe` run with unsaved values: TLS handshake with host-name check, service bind or a person's own sign-in; the
  discovery document, the issuer it states, the key set. Nothing typed for a test is stored; results and audit rows carry
  no credential.
- `IntegrationSettingsController` under `/settings/integration/{directory,oidc}` (GET, PUT, DELETE, POST `/test`), CONFIGURE
  only. The screen `IntegrationSettings` in «إعدادات النظام»: both sections, the derived address and bind description, an
  «Active Directory (كما في MOVER)» preset (`sAMAccountName`, `objectGUID`, `user`, `MilNumber`, `MilRankName`,
  `MilOccupation`, `MilCurrentUnitName`), the `.env` values on request, «العودة إلى إعدادات ملف البيئة».
- One address: `TMRKZ_PUBLIC_URL` (written by `start.sh` as `http://IP:PORT`, kept when `ops/tls/enable.sh` set `https://…`)
  is the only source of Keycloak's hostname, the local issuer, the callback and the signed-out page in
  `docker-compose.override.yml`. The backend joins `edge` and reaches the directory and the enterprise Keycloak directly, as
  MOVER; the servers stay on the network with no route out. The relay (`ldap-relay`, `extra_hosts`,
  `ops/keycloak/configure-manual-direct.py`, `TMRKZ_MANUAL_LDAP_*`) is removed: it was the placeholder name the VM failed on.
- `.env` keys stay readable for installations configured before the screen (`LDAP_*`, `TMRKZ_ENTERPRISE_OIDC_*`).

**Not done here.** The VM's own copy (hand-edited compose, relay keys in `.env`, the AD chain under `ops/keycloak/truststores`)
is replaced by taking this version and entering the values on the screen; its empty home page after a bootstrap sign-in is a
data state (the bootstrap registration was used once, then the people were deleted: no membership remains), not a code
defect — register the login again (OPERATIONS «First administrator»). No real directory or enterprise Keycloak was reached
from this machine.

**Tests.** `IntegrationSettingsIT` INT-01 (the directory saved on the screen signs people in at once ahead of an unconfigured
environment; tests of unsaved values: service bind, wrong password, untrusted CA, a person's sign-in; validation; blank
password keeps the stored one; switched off → `.env`; cleared) and INT-02 (Keycloak: discovery probe, issuer mismatch,
validation, saved → `/auth/status` configured and reachable, the automatic start goes to the saved realm, the platform
issuer untouched, cleared); unchanged and passing: `DirectorySignInIT`, `DirectDirectorySignInIT`, `DualProviderSignInIT`,
`EnterpriseSignInIT`, `SignInNotesIT`; frontend `integrationSettings.test.ts`.

## ADR-093 One map-first editor for every normal re-stationing task; release closure (owner brief «FINAL RELEASE CLOSURE», 20 Nov 2026)

**Owner.** Sections 3–9 of the closure brief: there must not be two substantially different experiences for the same normal
re-stationing task; saved drafts, the site-page start and temporary moves still opened the old editor; existing requests are
not editors; deployment-area drafts must open their own request; the old editor leaves normal navigation.

**Decision.**
- `DeploymentAreasRequest` (purpose RESTATIONING or DEPLOYMENT_AREAS) is the one editor. It takes `requestId` (a saved draft
  or a returned request: read as saved through `requestIntoFlow`, opened at its first open step, nothing written by opening;
  the content it has no control for — occupants, distance exceptions, a site registration — is named on the review step and
  saved back unchanged) and `preselectSite` (a start from the Sites page: that site is the choice, its one eligible unit
  ticked, the editor at «الموقع الجديد», nothing saved). The kind (دائم/مؤقت) is chosen with the units; a temporary move asks
  for its start and planned end before «التالي» (`flowStepProblem`), and the server's lifecycle (ADR-034: start, planned end,
  return, extension, cancellation, scheduler) is untouched. An untouched new site is saved with its recorded `copiedFrom` and
  `shape`.
- `RestationingPage`: a new RESTATIONING or DEPLOYMENT_AREAS request, with or without `?site=` / `?unit=`, opens the map-first
  editor; «تعديل الطلب» on a draft or a returned request opens `OpenSavedRequest`, which reads the request once and opens the
  map-first editor for those two purposes; a request address (`#restationing/<id>`, a link, a notification, the back button)
  always opens the read-only workspace and leaves any editor; the hash handler now clears the editor (a deep link opened
  while an editor was up used to stay in it).
- `RestationingEditor` remains only for a legacy purpose: a new «طلب اعتماد موقع» (SITE_REGISTRATION, still creatable from
  «طلب جديد») and the editing of a saved request of a legacy purpose (SITE_REGISTRATION; INITIAL_STATIONING made before
  ADR-078). No RESTATIONING or DEPLOYMENT_AREAS path reaches it. Audit of every entry: `navigation.ts` (the administrator's
  «＋ طلب جديد»), `stationingHub.ts` (the two tabs), `NewRequestPage` (the hub's cards and per-unit actions), the Sites page
  (`newRequestFromSiteHash`), `RequestDrawer` «طلب جديد», `HomePage` and the drawer's request links (read-only workspace),
  `RequestPanel` «تعديل الطلب».

**Tests.** frontend `deploymentAreasFlow.test.ts` (18: the temporary rule, `requestIntoFlow`, `isFlowPurpose`);
`tests/acceptance/editor-unification.mjs` 18/18 on :8088 (U-01…U-17: from a site; an old-way temporary draft with occupants
and an exception opens as saved, opening writes nothing, a save changes only the reason; a deployment-areas draft; a request
under review read-only); `tests/acceptance/partial-approval-roundtrip.mjs` (owner brief §16–§17, see STATUS);
`restationing-phase4.mjs` 16/16 (`SAVE=0`), `deployment-areas-phase3.mjs`, `responsive-layout.mjs` 16/16,
`stationing-hub-phase1.mjs` 6/6 after the change.

## ADR-096 Request-health diagnostic center for the system administrator (owner, 20 Nov 2026)

**Owner.** «The system today only replays failed stationing events. There is no central page that says: this request is waiting here, this is why, and this is the safe way to repair it. Also keep `SYSTEM_ADMIN` from reading the request as if they were an approver.»

**Decision.**
- **New route** `#requestHealth` under إدارة النظام. Three read-only endpoints, every one audited: `GET /api/v1/system/request-health/summary` (for the admin home widget), `GET /api/v1/system/request-health?q=...&health=...&state=...` (list), `GET /api/v1/system/request-health/{number|id}` (diagnose one request). Permission required: `CONFIGURE`.
- **Scanner.** `RequestHealthService.scan()` runs every five minutes, reads every open request (`UNDER_REVIEW`, `RETURNED_FOR_CHANGES`, `PAUSED_HIERARCHY_CHANGED`, `APPROVED_NOT_ACTIVATED`) and classifies it as `HEALTHY` / `WAITING_REQUESTER` / `WARNING` / `STUCK` with a reason code. The result is kept in memory only; no new table.
- **Diagnosis** reads the request row, its current route's stages, the stationing outbox and the local seat holders; returns the undecided-stage pointer, how long since the last decision, whether the seat has a valid current holder, and a reason that names the cause: `FAILED_EVENT`, `HIERARCHY_CHANGED`, `NO_HOLDER`, `NO_PROGRESS` / `NO_PROGRESS_LONG`, `RETURNED`, `NOT_ACTIVATED`, `WAITING_DECISION`.
- **Repair hints.** The service NEVER mutates the request. A diagnosis returns the names of existing endpoints the administrator may call under their current permissions, for example `POST /api/v1/stationing/outbox/{eventId}/replay` (requires `REPLAY_STATIONING_EVENTS`) or `/#permissions` to assign a missing seat (requires `MANAGE_ACCESS`). Separation of Duties stays: the administrator never decides on behalf of an approver, never flips a state by hand.
- **Home widget.** Admins see a compact «صحة النظام» card on the dashboard (stuck/warning counts + outbox failed + people without a local unit + an open-the-page link). Other roles never see it.

**Also in this change (same release, V59).**
- A `DEVELOPER` role: every current permission, scope `ALL`. The `developer` platform login carries it in addition to `SYSTEM_ADMIN` and `AUDITOR`, so «developer» can send requests and act on every screen while the real role boundaries are being drawn. The owner marked this as temporary («later we will change it»).

**Tests.** Backend: `IntegrationSettingsIT` 2/2, `DirectorySignInIT` 10/10, `HrOnDemandIT` 4/4 all green after the change. Frontend: `tsc -b --noEmit` clean; build succeeds. Evidence `docs/evidence/request-health/`.

**Limits (open, not blockers).**
- The scanner reads from PostgreSQL every five minutes; on an installation with hundreds of thousands of open requests the read would need an index on `(state, updated_at)` or a sampled scan. :8088 holds twelve open requests at writing.
- The «NO_HOLDER» detection uses a per-stage-unit seat count; nested seat delegation is not yet traced. The fix is the same table the access manager uses; this will be the next addition if a real stuck request surfaces on :8088.

## ADR-095 The AI model is configured from the settings, and the assistant never answers from a preprogrammed template (owner, 20 Nov 2026)

**Owner.** «still missing all the .env — i want to change everything here, even the AI model, and so on. Why do you make the response from AI already programmed? Remove that, only use OKF, no preprogrammed answers.»

**Decision.**
- «إعدادات التكامل» gains an «المساعد الذكي» section (V58 extends `integration_setting.kind` with `ASSISTANT`): enabled toggle, server base URL, model name, API key (write-only, AES-GCM through `HrSettingsCipher`), timeout; one «اختبار الاتصال» button opens the server's `/models` endpoint before anything is saved. `IntegrationSettingsService.assistant()` returns the saved values when the section is on, otherwise the `TMRKZ_AI_*` values of the environment; the view also discloses what `.env` holds so the administrator sees both sides.
- `AssistantService` no longer holds `@Value` fields; it reads the live settings for every question through `IntegrationSettingsService.assistant()`. The scheduler, the status badge and every ask follow the saved settings without a restart. The `TMRKZ_AI_*` values stay as the fallback and are collected by the new `AssistantEnv` bean so tests can rebind them.
- The assistant never returns a preprogrammed answer. The only text presented as an answer is the model's reply to the OKF documents the person may see. When the assistant is off, unreachable, busy, or no OKF document matched, the response's `answer` is null (mode `OFF`, with `degraded` naming the reason), and the screen says the assistant is not available; the matching OKF documents remain as links the person can open, but their body is no longer shown as prose. The badge on the floating button becomes «غير مُفعَّل» instead of «الدليل فقط».

**Tests.** `AssistantServiceTest` AI-1 (model sees the OKF documents, the reasoning tags are stripped, auth header carried, URL from the Assistant record), AI-2 (500/empty answer throws; the status endpoint reads live). `IntegrationSettingsIT` unchanged (the directory and Keycloak paths); the new assistant path is covered end to end in a later step.

**Limits.** The `.env` values that are not integrations (database password, cryptographic keys, Keycloak admin, platform passwords, port, public URL, trust store, feature flags) stay in `.env` because they are read before the application opens the database or they would break the running server. The settings screen's new «قيم ملف البيئة» block states each of them where its section is relevant.

## ADR-094 Oracle is not a dependency: units on demand and on the source's own schedule, people on demand, the directory sign-in suffices, the main unit's tree, the empty system (owner, 20 Nov 2026)

**Owner.** The final picture of 20 Nov 2026: a fake Oracle HR (about 30,000 units in an irregular tree, main units at varying
depths, about 200,000 people) and a fake directory holding the same people (username, name, rank, number, unit, main unit);
TMRKZ starts empty; «استيراد الوحدات الآن» from the settings, then «المزامنة التلقائية» every 24 hours by default or off;
no full people sync — a person is fetched at first sign-in, when searched for, when added by number, and refreshed after
24 hours on the next need; browsing, requests, approvals, stationing and maps never depend on Oracle; the first sign-in
while Oracle is unreachable: «the person will use LDAP to sign in … LDAP has enough and he can enter the app … make it an
option that I can toggle»; the zero-access person sees only their own things and asks for a role within their own main
unit's tree; an empty system shows nothing in the middle; a migration center for an older PostgreSQL where the current
record wins and conflicts are only reported (decision A).

**Decision (this step; the fake sources, the empty-system checks and the migration center follow in their own steps).**
- `hr_source` (V55): `auto_sync` (off on a new installation; an installation that synced hourly keeps `enabled` as its
  value), `sync_interval_hours` (24; 1–720), `people_sync` (off: people are never read in bulk), `directory_sign_in_suffices`
  (on). The scheduler ticks every minute and runs when the source's own schedule is due (`HrSyncService.due`), never on an
  environment interval; `TMRKZ_HR_SYNC_INTERVAL_SECONDS` is no longer read. «استيراد الوحدات الآن» is the manual run.
- The run reads the whole unit tree and, with `people_sync` off, carries the linked people's records forward unchanged from
  the published snapshot (`peopleCarried`); `HrPeopleService.refreshIfStale` refreshes one person from HR live on the next
  need when the last answer is older than 24 hours (`person.hr_fetched_at`): at sign-in (`IdentityService.resolve`), and
  wherever `importOne` runs. HR not answering changes nothing and refuses nothing. With `people_sync` on, the earlier
  behaviour (linked people refreshed in every run) remains for an installation that wants it.
- A directory sign-in that HR cannot confirm now (HR not answering, or its data stale beyond the policy; HR answering that
  it does not know the key is still refused and reviewed) enters as a zero-access person from the directory's attributes — name, number, rank, unit (ADR-068) — with `person.hr_match_pending`, audited
  `IDENTITY_HR_MATCH_PENDING`, shown on «طلب صلاحية» and as `/me.hrMatch = PENDING`; the next sign-in that HR answers adopts
  the HR record onto them (`toOracle`, `IDENTITY_HR_MATCHED`). Ambiguous, inactive or already linked records are still
  refused and reviewed. The toggle off restores the earlier rule (no new account until HR confirms).
- The scope a person may ask for in «طلب صلاحية», and the scope the server accepts, is their main unit's tree
  (`AccessRequestService.mainUnitOf`: the nearest unit upward the published snapshot marks `is_main`; without HR data, the
  person's own unit) — never another main unit's.
- The home shows nothing in the middle while no unit, site, stationing, request or waiting card exists (`homeEmpty`); the
  top navigation and the pages the person may open stay. Only real local data fills the middle.
- «إعدادات التكامل» carries a live state per section (`GET /settings/integration/status`): يعمل / غير متصل / غير مهيأ.

**Step 2 (20 Nov 2026, the owner's «NEXT DEVELOPMENT PHASE» brief; V57).**
- «معاينة الوحدات» (`POST /hr/units/preview`, `HrSyncService.previewUnits`): the unit view is read exactly as an import
  reads it — same mapping, same conversions — and nothing is written: no run, no snapshot, no unit. It states the source's
  count of units, active ones, main units (MAIN_UNIT_ID pointing to itself), roots, the distribution by level, the count of
  the person view, and the validation problems an import would report (no key or name, duplicate keys, a parent or a main
  unit the source does not hold), with samples. The last result stays on `hr_source.last_preview` so the screen states
  «في المصدر مقابل محلياً»; it is audited `HR_UNITS_PREVIEWED` and counts as a connection test.
- The status (`GET /hr/status`) adds the last attempt, the last successful import's local changes (added / changed /
  deactivated from the projection's counts), the source's state as last tested, the local main units, and
  `personRefreshHours`. Before the first import the panel says «لم يتم استيراد الوحدات» and offers, in order:
  اختبار الاتصال (read-only), معاينة الوحدات (read-only), استيراد الوحدات الآن.
- «تحديث بيانات الشخص بعد» (`hr_source.person_refresh_hours`, 24 by default, 0 = never automatically): the period
  `HrPeopleService.refreshIfStale` honours; the manual refresh is `POST /me/hr-refresh` (open to zero access: it is how a
  person gets matched) and `HrPeopleService.refreshNow`. `/me` carries `hrFetchedAt` and `hrStale`; «بياناتي» on
  «طلب صلاحية» shows the HR state (بانتظار تحديث HR / مطابق / بيانات قديمة) and the refresh button.
- The scope tree of «طلب صلاحية» begins at the main unit and highlights and reveals the person's own unit
  (`AccessMine.identity.unitId`, `UnitTree` `selected`/`trail`/`reveal`).
- `GET /system/state` (open to zero access): the counts of units, sites, current stationings, requests and people, and
  `empty`. While the installation is empty the operational screens — المواقع المسجلة, الموقف, إعادة التمركز's start
  workspace, تهيئة المواقع — render `EmptyCentre` instead of a map frame: no MapLibre instance is created. The settings are
  grouped «السياسات والبيئة» / «الهوية والدخول» / «مصدر الموارد البشرية» / «ترحيل البيانات».

- **A new installation could not start** (found while standing up the empty installation, 20 Nov 2026): since ADR-078 the
  facilities roles are seeded without permissions, and `Bootstrap.seedRequestTypes` still published MOVER's default
  facilities workflows, whose final stage names `APPROVER` — the validator refuses a final stage whose role lacks APPROVE,
  so the application failed at startup on any database created after 17 Nov 2026. The bootstrap now publishes those
  workflows only with `tmrkz.access.legacy-facility-roles=true` (tests, the fictional acceptance environment) and otherwise
  leaves them as drafts the studio shows. `ops/hr-demo/empty-install.sh` stands up the temporary empty installation
  (project `tmrkz-empty`, :8098, synthetic directory and demo Oracle) that `tests/acceptance/hr-on-demand-journey.mjs` runs
  against; both are removed after use.

**Step 3 — «مركز ترحيل قاعدة البيانات» (20 Nov 2026; V56, `ae.mover.system.DbMigration*`, `DbMigrationCenter.tsx`).**
The data of an older TMRKZ PostgreSQL comes into the current database; the current database is never replaced and never
restored over. The source is a connection (host, port, database, schema, read-only account) or a `pg_dump -Fc` archive
(uploaded, or placed in `data/files/migration-inbox`) restored into an isolated staging database `tmrkz_staging_<id>` with
`pg_restore --no-owner --no-privileges`, dropped afterwards. The source's Flyway version must be at most the current one.
The preview groups the tables by category (organisations, sites, people/accounts, grants/roles, stationing, deployment
areas, requests, approval history, attachments, support, other) and states per table New / Identical / Changed /
Conflict / Unsupported, with the conflicting records' current and source values. **Rule A (owner):** the current record
wins; a conflict is only reported, and an administrator may decide TAKE_SOURCE per record and must confirm each table
that has conflicts before the run. Never migrated: sessions, logins, throttles, bootstrap logins, outbox, idempotency,
Flowable tables, integration settings, HR mirror tables, OpenFGA tuples and sync state, `db_migration` itself; secret
columns (password, hash, secret, token, ciphertext, private key, credential, api key, key id) are stripped from comparison
and transfer. The run needs a current verified backup (`ops/verify-backup.sh` writes `verify-result.txt`; the screen shows
the backup's time, its verification, the source fingerprint and the preview fingerprint) and refuses when the source
changed since the preview; it runs in dependency order (organisations and people before memberships). Every step is
audited (`DB_MIGRATION_PREVIEWED/VALIDATED/RUN/ABANDONED/DUMP_UPLOADED`). Limits: `pg_restore` must be in the backend image
(`ops/local/workspace/pack-images.sh` adds postgresql-client-17; the image has not been rebuilt yet), uploads are capped
by the 25 MB multipart limit, grants need an OpenFGA rebuild after migration, attachments arrive without their files.
Tests: `DbMigrationIT` DB-MIGRATION-01, `DbMigrationDumpTest`; frontend `dbMigration.test.ts`. Operations:
`docs/OPERATIONS.md` «Migration center»; the VM's `db.db` file is identified first by `docs/deployment/MIGRATION_SOURCE_CHECK.md`.

**Not changed.** Sign-in paths (ADR-070/071/092), the review list for ambiguous identities, the HR projection's rules,
the access workflow (REQUESTED → RECOMMENDED → GRANTED).

**Tests.** `HrOnDemandIT` OD-01 (units now; one person fetched on demand; the next run carries them; refreshed after a day on
the next need; HR down changes nothing; the schedule due from the source's own interval; `people_sync` on keeps the old
way), OD-02 (the scope is the main unit's tree), OD-03 (the directory sign-in admitted when HR is down, placed in its unit,
matched when HR answers; the toggle off refuses as before), OD-04 (the preview writes nothing — no run, snapshot or unit —
and states six units, four main units, a duplicate and an orphan; the status states source against local; the person
refresh period saved as 0; `/system/state` and `/me/hr-refresh` answer); `HrSyncAcceptanceIT`, `HrLinkedPeopleIT`, `DirectorySignInIT`,
`EnterpriseSignInIT`, `AccessAcceptanceIT`, `UnitMemberIT`, `EmploymentContextIT` unchanged; frontend `homeEmpty.test.ts`.


## ADR-095 Activation is part of final approval; FYI is a per-unit configuration; the matrix drops to eight roles (owner, 21 Nov 2026)

**Decision.** The owner's correction on 21 Nov 2026 removes two moving parts from the stationing lifecycle and replaces
«تحديد وحدات العلم» as a per-request human action with «تحديد وحدات العلم» as a per-unit configuration under the owning
unit's access manager. The administrative matrix now exposes EIGHT canonical roles — not ten:

1. مقدم الطلب (STATIONING_REQUESTER)
2. معتمد السلسلة الهرمية (CHAIN_APPROVER)
3. معتمد عمليات الوحدة (UNIT_OPERATIONS_APPROVER)
4. المعتمد النهائي (FINAL_APPROVER)
5. للعلم (FYI_RECEIVER)
6. متابعة الموقف العملياتي (POSTURE_VIEWER)
7. مدير صلاحيات الوحدة (UNIT_ACCESS_MANAGER)
8. معتمد طلبات الصلاحية (ACCESS_FINAL_APPROVER)

FYI_DISTRIBUTOR and STATIONING_ACTIVATOR are DELETED outright. The permissions they used to carry
(MANAGE_FYI_DISTRIBUTION, ACTIVATE_STATIONING) are REMOVED from the application and pruned from every
stored access_policy_version so a restore cannot bring either back.

**Why.** The two deleted roles never surfaced a decision anyone could refuse: the activator could not decline a
finally-approved request without breaking the owner's rule that approval is the gate; the FYI distributor merely picked
recipients from a list anyone with access could enumerate from the organisation tree. Collapsing both into the natural
places they belong (final approval and unit configuration) removes an entire step from the operator's day without
losing audit shape — every former event still writes the same `RESTATIONING_ACTIVATED` and `RESTATIONING_FYI_DISTRIBUTED`
audits, just carried by the final approver's transaction rather than a separate human action.

**How it works now.**

- *Final approval → activation.* The final approver's APPROVE on the last stage triggers the same server checks that a
  standalone activation used to apply — hierarchy drift refusal, geography re-check, atomic conflict prevention — and
  records the activated stationing INSIDE THE SAME TRANSACTION. The request moves from UNDER_REVIEW directly to
  ACTIVATED_PERMANENT (or TEMPORARY_SCHEDULED / ACTIVE_TEMPORARY for a temporary purpose) without ever surfacing
  APPROVED_NOT_ACTIVATED to any UI. An approved extension's activation runs the same way inside the final approver's
  transaction (D10).
- *FYI → unit configuration.* A new table `unit_fyi_target(owning_unit_id, target_unit_id, include_descendants)` holds
  the FYI recipients per owning unit, maintained by the unit's access manager («مدير صلاحيات الوحدة») through the access
  workspace. After activation the service reads this list, expands `include_descendants` to the subtree, writes the
  `restationing_fyi` rows and notifies the recipients — all inside the same transaction. The notification shape and the
  `RESTATIONING_FYI_DISTRIBUTED` audit are unchanged; only the trigger and the chooser moved.

**Separation of duties.** Final approval still obeys SOD against the hierarchy stages and the requester, as before. The
previous D1 rule — «the final approver cannot activate» — is retired by construction: activation is the final approver's
own act. The requester is excluded from activating by the same flow.

**Data changes (V62 migration).** The migration ENDS every live grant pointing at FYI_DISTRIBUTOR or STATIONING_ACTIVATOR,
strips MANAGE_FYI_DISTRIBUTION and ACTIVATE_STATIONING from every remaining role's permissions and from every stored
access_policy_version, DELETES the two role_def rows, creates `unit_fyi_target`, and writes one audit event naming
everything removed. An `authz_change` notice makes every holder's decisions be reconsidered on the next request.

**API compatibility.** `POST /restationing-requests/{id}/activate` is retained as an idempotent no-op: a client that
still calls it after a final approval receives the request's current view without side effects. The three FYI endpoints
(`GET /fyi-options`, `POST /fyi`, `POST /fyi/{unit}/end`) are REMOVED: the configuration lives under the unit, not the
request.

**Not changed.** The eight canonical roles' columns stay in the same order the owner approved. The approval chain
climbs the hierarchy as before. The posture read model, the map workspace, the access workspace («إدارة الصلاحيات
والوحدات»), the audit trail and the sign-in paths are unchanged.

**Tests.** `MatrixColumnsIT` is updated to the EIGHT-role invariant and BANNED now includes FYI_DISTRIBUTOR and
STATIONING_ACTIVATOR. `RestationingTestBase.approvedPermanent` asserts `ACTIVATED_PERMANENT` directly after the final
APPROVE. The remaining stationing ITs (`RestationingWorkflowIT`, `RestationingLifecycleIT`, `RestationingHrSyncIT`,
`StationingNextIT`) still carry the pre-ADR-095 two-step assertions and are being migrated as part of this change
(tracked in STATUS.md).

## ADR-097 Migration Center accepts MOVER SQLite and imports its units into the organization tree (owner, 21 Nov 2026)

**Withdrawn (owner, 23 Nov 2026) — see ADR-098.** The import was removed and V66 deletes the units it brought in: TMRKZ does not use MOVER's database.

**Decision.** The owner asked (21 Nov 2026, after reviewing the Full Real Acceptance report) to extend
«مركز ترحيل قاعدة البيانات» so an administrator can upload a MOVER SQLite file (the old legacy app's database)
and bring the MOVER units into TMRKZ's `organization` tree in one pass. This augments ADR-094: the pg_dump path
for an older TMRKZ stays as it was; a new, focused SQLite path lives beside it and only imports units.

**Scope.** Exactly one MOVER table is read: `units(id, name, parent_unit_id, level, hr_unit_id, hr_source, hr_status,
manager_id, is_final_command, unit_operations_approval_unit_id, display_alias)`. Nothing else is read, nothing is
written back to the SQLite file (opened with `PRAGMA query_only = true`). Rows that already exist in TMRKZ are left
ALONE (owner rule A from ADR-094: the current record is never changed).

**Mapping (MOVER → TMRKZ).**
- `units.id` → `organization.source_external_id` (as text); `source = 'MOVER'`. The pair is unique per source
  and is the identity for idempotent re-import.
- `units.hr_unit_id` → part of `organization.code`: `MOVER-HR-<hr_unit_id>` when present, else `MOVER-U-<id>`.
- `units.name` → `organization.name` verbatim.
- `units.parent_unit_id` → `organization.parent_id` via the same (`source`, `source_external_id`) lookup; a parent
  that was not imported in this pass is left NULL so the administrator can rewire manually (no fabricated parents).
- `units.hr_status = 1` → `ACTIVE`; otherwise `RETIRED`.
- Everything else (`manager_id`, `is_final_command`, `unit_operations_approval_unit_id`, `display_alias`, `level`)
  is read for the preview UI but not written: TMRKZ represents managers and operations seats through the access
  workspace (ADR-013/095), not through columns on `organization`.

**Isolation and safety.** The sqlite-jdbc driver (`org.xerial:sqlite-jdbc:3.47.1.0`, Apache-2.0) opens the inbox file
with `PRAGMA query_only = true`, so no WAL is written and no row of the SQLite file is modified. The import runs in a
Spring transaction so either every chosen row lands or none does. The caller needs `CONFIGURE` (today: `SYSTEM_ADMIN`).
The inbox folder is the same size-limited folder the pg_dump path already uses.

**Data changes (V65).** `organization.source` check extended from `(LOCAL, HR)` to `(LOCAL, HR, MOVER)`. No row is
created by the migration itself. Rollback is a check-constraint change only; the data rows a successful import creates
stay as regular `organization` rows that can be retired through the normal path.

**Audit.** Each run writes one `MOVER_UNITS_IMPORTED` event (file name, SHA-256, counts). Each code-conflict row
writes one `MOVER_UNIT_CONFLICT_SKIPPED`. Both are system events (the actor is the signed-in administrator).

**API.**
- `POST /api/v1/settings/db-migration/mover-units/preview { "file": "<inbox filename>" }` → verdict per unit (NEW /
  EXISTING / CODE_CONFLICT). No writes.
- `POST /api/v1/settings/db-migration/mover-units/commit { "file": "<inbox filename>" }` → inserts every NEW row, in
  parent-before-child order. Returns created / existing / skipped / conflicts.

**UI.** A new section «استيراد وحدات MOVER من SQLite» renders under `CONFIGURE` in the Settings page, below the
existing Migration Center. File picker reads from the browser's local disk (not a VM). The preview shows a per-row
table with Arabic pills (جديدة / موجودة مسبقاً / تعارض رمز) before the administrator commits.

**Oracle .dmp is deferred.** The owner asked for Oracle file upload too. Oracle data-pump `.dmp` files are not
self-describing: importing one requires `impdp` running inside an Oracle instance with the DATA_PUMP_DIR directory
privilege, an impdp-compatible target schema and, usually, the same Oracle major version as the source. Doing that
safely in TMRKZ needs a dedicated staging Oracle container (licensed image) and a different set of magic-bytes checks.
It is tracked as a stage-2 follow-up; this ADR covers SQLite only.

**Tests.** `MoverUnitImportIT` 4/4 green on real PostgreSQL + OpenFGA: imports a synthesised MOVER SQLite into an
empty organization tree, verifies codes and parent chain, re-imports as a no-op, rejects a pg_dump file, rejects a
SQLite that lacks a `units` table, and rejects a caller without `CONFIGURE`.

## ADR-098 TMRKZ does not use MOVER's database; every setting is in `.env` (owner, 23 Nov 2026)

**Owner.** «why do i see mover db ??? it should not do that anything related to mover remove it i said i want to be the same not using the same db»; «make sure everything is available to be edited» (the `.env`, the AI settings).

**Decision.**
- The MOVER SQLite import of ADR-097 is removed: its service, its two endpoints, the settings section, the SQLite driver and the SQLite file type of the migration center's inbox (commits 74891ec and 56b60ee reverted; V65 stays because it is applied).
- V66 deletes the units imported from MOVER (`organization.source = 'MOVER'`), which nothing but each other refers to, and restores the check to `LOCAL` or `HR`. The guard that units are never deleted is switched off only for that statement. The permission store is told that the structure changed, so their tuples leave OpenFGA on the next sync. On the VM's database V66 removes 254 units (rehearsed on a copy; it runs there at the next start); on this PC's it removed none.
- MOVER's database files were removed from the TMRKZ folder they had been copied into (`data/files/migration-inbox/transport_requests*.db`). The VM agent's rules (`RUN.md`, appendix A) forbid reading, copying or importing MOVER's data. TMRKZ's units and people come only from its own HR source and directory.
- `.env` lists every setting the Compose files read (69), in sections with a note each, including the AI assistant (`TMRKZ_AI_*`). Values that were not written before are the defaults the application already used, so the effective configuration is unchanged. `MOVER_DEMO_*`, which nothing read, are gone.
- `RUN.md` sections 1–3: the zip made in Command Prompt, sent to the VM through PAM (`scp`/`sftp` on port 4422), unzipped beside the previous folder, which is kept until the new one works.
- No «mover» in what the owner sees («in the docker file i see some mover data»): TMRKZ's names from its first working name are renamed. The Compose project and containers are `tmrkz` (`tmrkz-db-1`, …), the database and its owner `tmrkz`, the images `tmrkz/backend` and `tmrkz/web`, the container paths `/var/lib/tmrkz` and `/opt/tmrkz`, the settings `TMRKZ_DB_PASSWORD`, `TMRKZ_ATTESTATION_KEY`, `TMRKZ_HTTP_PORT`, `TMRKZ_HTTP_BIND` and `TMRKZ_SECURE_COOKIE`. The application's name in its logs is `tmrkz` (`Started TmrkzApplication`), the API title «TMRKZ API», and two settings texts no longer say «كما في MOVER».
- An existing installation moves by itself on its next start. `ops/init-env.sh` (run by `start.sh`) renames the five `.env` keys and keeps their values. `start.sh` replaces the `tmrkz-mover-*` containers, keeping `./data`. `db-init` renames the database and its owner before the backend connects; a temporary administrator does the owner's rename, because a role cannot rename itself, and is removed again. Every step checks what is done, so an interrupted start completes on the next one. The backend reads the new names first and the old ones still (the backend tests' own database keeps its names).

**Consequences.** The Java package `ae.mover`, the build's file name and the internal request header keep the old name: nobody sees them, and renaming them would touch every source file. Verified on this PC: V54–V66 applied to its database, backend and web healthy, the six sign-in paths, `developer`, the map files; V66 rehearsed on a copy of the VM's database (254 MOVER units removed, the unit guard back on).

## ADR-099 A small server: background tabs ask nothing, a restart does not rebuild (owner, 23 Nov 2026)

**Owner.** After the slowness check of the other application on the VM — 4 cores, each about 3× slower than the office PC's, taken by background work and by browser tabs asking the server on their own: «fix the same here in the actual app and push».

**Decision.**
- Three screens stop asking the server from a tab in the background, as the navigation counts already did (ADR-094 §N, `lib/visibilityPoll`): the bell's notifications (every 30 s), «المراجعة» (every 30 s: the list of up to 200 requests, the open request and its map) and the permission service's state (every 10 s). Back in front they refresh once («المراجعة» on the window's focus, as before). Desktop notifications keep asking in the background, which is their purpose (ADR-050).
- The folder run (ADR-091) built the backend (Maven) and the web (type check and bundle) at every container start, also after a reboot with nothing changed. Each script now records which source state its build came from, inside the container; a restart with the same source starts the last build at once, and docs are copied again only when they changed. A recreated container (a new image, a changed setting) builds once, as before. A saved change still rebuilds a few seconds later.
- The backend's source check every 3 s lists the files with `find -printf` instead of one `stat` per file (about 3× cheaper). The web image's `find` cannot print, so its check is unchanged.
- `docker-compose.override.yml` mounts both scripts from the folder over the copies in the images, so an installation gets them with the folder, without a new `tmrkz-images.tar`.

**Checked and kept.** The backend health check is `select 1` every 10 s; the permission synchronisation compares 1,552 tuples every 5 minutes; nginx serves the page files itself with year-long caching (no page file goes through the application). A TMRKZ nobody uses took about 5 % of one core on this PC over 120 s.

**Consequences.** The polling existed since the first implementation (28–30 Oct) and the rebuild at start since the folder run (19 Nov); neither showed on the 32-core PC. Verified on this PC: `docker compose restart backend web-build` without a build (backend healthy in 7 s, page and API 200); a touched backend file rebuilt and restarted; the web container's type check and bundle; `visibilityPoll.test.ts`.

## ADR-100 Directory sign-in never needs a service account; Active Directory's own names are accepted (owner, 24 Nov 2026)

**Owner.** «how did you build the ldap service as i cant sign in no one can ??? it should allow anyone who have ldap and ldap
credential as everytime the app fails as it ask for bind».

**What was wrong.**
- `docker-compose.yml` required `LDAP_BIND_DN`, `LDAP_BIND_CREDENTIAL`, `LDAP_URL` and `LDAP_USERS_DN` for Keycloak (`${…:?}`). As
  soon as `.env` named a real directory without a service account, `docker compose up` stopped with «set LDAP_BIND_DN
  (read-only service account)» and nothing started.
- The manual sign-in bound as the person only when a direct-bind pattern or, on the screen, «نطاق الدخول» was given; otherwise
  the backend and the screen required a service account («بلا نطاق دخول يلزم حساب خدمة للقراءة»).
- After a person's own `user@domain` bind, their entry was searched with the configured names only. `.env` still carries the
  standard directory's `uid` / `entryUUID` / `inetOrgPerson` (ADR-098 wrote every key); Active Directory has none of them, so a
  correct password found no entry and everybody got «wrong username or password».
- A login typed `DOMAIN\user` or `user@domain` was refused outright.

**Decision.**
- No service account is required anywhere. `LdapProperties` takes `domain` (`LDAP_DOMAIN`, MOVER's name) → `{username}@domain`;
  with no pattern, no domain and no complete service account, the domain is the `DC=` parts of the users DN
  (`OU=Staff,DC=corp,DC=example` → `corp.example`), which is how Active Directory accepts `sAMAccountName@dnsDomain`. A complete
  service account without a domain keeps the search-first profile of ADR-016 unchanged; an explicit domain or pattern wins as
  before. A wrong guess is only a refused bind: the directory checks every password.
- With a `{username}@domain` pattern (Active Directory), `DirectoryAuthenticator` after the person's own bind finds their one
  entry by the configured login attribute, `sAMAccountName` or the `userPrincipalName` they bound with, of the configured class
  or any `person`; reads `objectGUID` (binary) / `entryUUID` when the configured identifier is absent and `sAMAccountName` when
  the configured login is absent; and accepts `DOMAIN\user` and `user@<this domain>` as `user`. Still exactly one entry, still
  the uniform refusal, still TLS-verified, still never an empty password; the direct-bind DN check (ADR-070) and the
  service-search profile are unchanged.
- «إعدادات التكامل»: the service account is optional («لا يلزم»); with «نطاق الدخول» empty the screen shows the domain derived from
  the search base; a service account name without its password, or a search base with no `DC=` and no domain, is the problem
  named before a save.
- `docker-compose.yml`: Keycloak's `LDAP_*` are optional, the backend reads `LDAP_DOMAIN`; `ops/init-env.sh` writes
  `LDAP_DOMAIN=` and marks the service account optional.

**Not changed.** Keycloak's own page (the automatic button against the local realm) can look people up in a directory only with
a service account — Keycloak has no bind-as-the-person mode. Without one, people use «إدخال رقم الـــــ U وكلمة المرور يدويا»
(this ADR), or the enterprise Keycloak saved in «إعدادات التكامل» (ADR-092); the local realm serves `admin` and `developer`. An
existing realm keeps its federation; a new realm imported with an empty service account has not been tried.

**Tests.** `ActiveDirectoryDirectBindTest` (new, no database): a fictional StartTLS directory that behaves as AD does (binds as
`user@dnsDomain`, `user` objects with `sAMAccountName`, `userPrincipalName`, binary `objectGUID`, no `uid`/`entryUUID`) — no
service account and the `.env` leftovers `uid`/`entryUUID`/`inetOrgPerson` sign in `jdoe`, `CORP\jdoe`, `jdoe@corp.test`,
`jdoe@CORP.TEST` and an account whose UPN differs from its `sAMAccountName`; step-up by identifier; wrong password, unknown
login, another domain, empty password and a filter-shaped login refused alike; the AD preset with `MilNumber`; the derivation
rules. Unchanged and passing: `DirectorySignInIT`, `DirectDirectorySignInIT`, `IntegrationSettingsIT`; frontend
`integrationSettings.test.ts`.

## ADR-101 Unit management, level management, employee number admin, screen transitions, Oracle absence proof (24 Nov 2026)

**Context.** System administrators need to manage organisational units, levels and employee numbers directly in TMRKZ without
depending on Oracle HR, and page transitions from console views left content invisible.

**Decision.** Accepted.
- **Unit management:** `CONFIGURE` holders create, rename, reparent and retire units from the directory page; retirement refused
  when active children or members remain; cycle prevention by a DB trigger.
- **Level management:** `organization_level` table (V67, levels 1–20); CRUD from the directory page; a level with active units
  cannot be deleted; units can be assigned a level.
- **Employee number admin:** `PUT /people/{id}/employee-no` lets a system admin set an employee number without HR resources;
  uniqueness enforced, audited.
- **Oracle absence proof:** `EmploymentContextResolver.mode()` reads only local tables; `IdentityService.resolve()` calls
  `toOracle()` only as a post-sign-in step. `OracleAbsenceIT` overrides the connection factory with a throwing stub — zero calls
  during login when HR is not in force.
- **Screen transitions:** `.tz-app.is-page` sets `height: auto; overflow: visible`; scroll reset targets both `window` and
  `#main`.

**Tests.** `OracleAbsenceIT` 2/2, `EmploymentContextIT` 1/1, `DbMigrationIT` 1/1 (V67), `AdministrationAcceptanceIT` 8/8,
`AuthorizationIT` 10/10; frontend 405/405.

## ADR-102 Management centre, CLI recovery engine, AI context, GIS cursor fix, administrator lifecycle, embedding allowlist (24 Nov 2026)

**Context.** The V3 engineering brief (§1–§12) calls for a browser management centre, a CLI recovery/bootstrap engine, an
embedding frame-ancestors allowlist, an administrator add/revoke lifecycle, bounded AI conversation context, a GIS cursor
alignment fix and Arabic operational documentation.

**Decision.** Accepted.
- **`ops/tmrkzctl.sh`** (§1): 8 modes — `doctor` (images, mounts, .env, ports, disk, database, TLS, services, caches),
  `setup`, `status`, `verify`, `update` (staged, path-traversal and content-safe, backup-before-update), `rollback` (delegates
  to `verify-restore.sh`), `backup`, `inventory`. All read-only except `update` and `rollback`.
- **Management centre** (§3): `ManagementCenter.tsx` in the existing settings page, CONFIGURE-gated. Five sections: system
  status (counts, schema version, server time), TLS certificate metadata, embedding allowlist CRUD, backup info, CLI reference.
  `GET /api/v1/system/management` aggregates the data from one endpoint.
- **Embedding allowlist** (§4): `system_setting` table (V68), `GET/PUT /api/v1/system/embedding`, strict `https://host[:port]`
  validation, audit-logged changes. The UI stores the allowed origins; nginx integration via `gen-csp-embedding.sh` is prepared
  but not wired into the live reload — `frame-ancestors` remains `'none'` until the operator deploys.
- **Administrator lifecycle** (§6): `GET/POST/DELETE /api/v1/administrators`, `AdminLifecycle.tsx` in settings.
  Add by directory username (must have signed in once), remove with confirmation (last admin protected), audit-logged.
- **AI conversation context** (§7): `AssistantService.PriorTurn`, bounded to 6 prior turns, sent as alternating user/assistant
  messages before the current question. Frontend sends the conversation history from `FloatingAssist.tsx`.
- **GIS cursor alignment** (§8): `.maplibregl-map, .leaflet-container { zoom: calc(1 / 0.9); }` in `map.css` counter-zooms
  `html{zoom:.9}` from `prototype.css` inside map containers so pointer coordinates match the WebGL canvas.
- **Arabic documentation:** `docs/ADMIN_UI_QUICK_START_AR.md`, `docs/VM_BOOTSTRAP_AR.md`, `docs/VM_QUICK_START_AR.md`.
- **No new dependencies.** All changes reuse existing images and libraries.

**Tests.** `DbMigrationIT` 1/1 (V68), `AdministrationAcceptanceIT` 8/8; frontend build clean; deployment to :8088 verified.

## ADR-103 Authorisation and identity regressions of the VM incident report; verified administrator management (25 Nov 2026)

**Context.** A VM incident report (24–25 Nov 2026; the server was not inspected from development) diagnosed «expired
permissions», pushed every `authz_tuple` holder whose `valid_to` was in the past to 2099, copied an administrator's mirror rows
to another person, inserted an HR row by hand and removed the HR uniqueness refusal at `UnitMemberService` line 253. The owner
asked for the decision path to be reviewed and every symptom reproduced with synthetic identities before changing code.

**Findings (reproduced on `e30c1c1`).**
- The business database is the only source of truth: `GrantSource` reads memberships, delegations, responsibility seats, unit
  grants and duty permits (each only for an ACTIVE person not switched off, on an ACTIVE unit). `authz_tuple` is the mirror of
  what OpenFGA holds; `AuthzSync` rewrites it from the grants and its full reconciliation undoes any hand edit.
- An open-ended grant is stored in the mirror with `valid_to = valid_from` and `open_ended = true` (`AuthzTuples`); the OpenFGA
  condition is `now >= valid_from && (open_ended || now < valid_to)`. The report's «expired» rows were open-ended, valid grants.
- «رقم المستخدم هذا مستخدم لحساب خارج نطاقك» was raised for any existing account whose employee number did not start with
  `USER-` — every account made by a first directory sign-in (ADR-068: the directory's number or `DIR-login`), even for the
  global administrator — and for a removed account. The scope bound itself was right.
- «سجل الشخص غير نشط في مصدر الموارد البشرية» was the message for any non-ACTIVE person, including a local account removed by
  «حذف الحساب», for which no way back existed except SQL.
- ADR-102's «＋ مدير جديد» inserted a `membership_scope_target` of kind `ALL`, which the table refuses: every add failed (500).
- The request hub listed the first 300 units of the reach in tree order, retired ones included: with 23,674 units a stationed
  unit further down — the only kind «طلب مناطق انتشار» is made for — was never offered.

**Decision.** Accepted.
- `UnitMemberService.requireAddableAccount`: an existing account is a user account when LOCAL and made here (`USER-`) or by
  the person's own directory sign-in (identity link `DIRECTORY`); system accounts, other records, removed accounts and accounts
  outside the reach each get their own message. HR identity uniqueness (the line-253 refusal) is kept.
- `AuthService` names the cause of a refused sign-in: `ACCOUNT_REMOVED` (removed in TMRKZ) or `HR_INACTIVE`.
- «إعادة الحساب» (`POST /access/workspace/people/{id}/reinstate`): a global manager, with a reason, audited
  (`PERSON_REINSTATED`); only the account returns, no grant.
- «مديرو النظام» rebuilt (`AdministratorService`; `/administrators`, `/administrators/resolve`, `/administrators/{id}/end`):
  two verified lookups — the employee number asked live from Oracle HR (no fallback record; unconfigured or unreachable HR is a
  clear refusal) or a directory account the directory verified by a previous sign-in (no service account, ADR-100) — shown with a
  confirmation fingerprint, granted only with that fingerprint and a reason through `GrantAdminService.create` (self-grant,
  bootstrap identity, audit, outbox); configuration AND global access management required; held on a LOCAL root unit first; the
  last effective administrator and platform accounts are not removed; an advisory lock serialises the check and the change.
- Request hub: ACTIVE units only; every unit holding a stationing now and the units above it first, then the rest in tree order
  up to 300; `unitsShown`/`unitsTotal` stated. `requestableUnits`: ACTIVE units only.
- `ops/diagnose.sh`: the read-only, redacted procedure for the VM (release and local drift, whether a source edit was compiled,
  mirror consistency including hand edits, identities, HR synchronisation, error codes, units). No production repair is
  automated: a correction is proposed, reviewed, backed up and made through audited application paths.

**Tests.** `AuthzMirrorIT` 3/3, `UnitMemberIdentityIT` 4/4, `RequestHubReachIT` 1/1, `AdministratorLifecycleIT` 4/4 (six of
these failed on `e30c1c1` as reproductions). With the affected classes: `UnitMemberIT` 4/4, `AccessAdminIT` 7/7,
`AdministrationAcceptanceIT` 8/8, `AuthorizationIT` 10/10, `RequesterScopeIT` 9/9, `PostureViewerScopeIT` 7/7,
`OperationalPostureScaleIT` 5/5, `SiteMarkerIT` 8/8, `EmploymentContextIT` 1/1, `DirectorySignInIT` 10/10, `HrLinkedPeopleIT`
6/6, `HrOnDemandIT` 4/4, `SignInNotesIT` 1/1. Pre-existing and unchanged by this work (the same failures on an untouched
`e30c1c1` extract): `RestationingWorkflowIT` 8, `StationingNextIT` 9, `SiteSetupIT` 1 — they still expect
«APPROVED_NOT_ACTIVATED» after ADR-095 merged activation into the final approval.

## ADR-104 One TMRKZ folder everywhere; the browser «مركز التحديث» applies signed releases through a restricted worker (25 Nov 2026)

**Context.** The VM installs `/data/TMRKZ` (assets, backend, certs, data, the two Compose files plus
`docker-compose.dc-hosts.yml`, .env, frontend, map-data, map-packages, map-runtime, ops, README, RUN, start.sh, tests). The owner
requires one folder, one source, one repository, the same images, libraries, build, start scripts and mounts on every machine —
only machine settings, addresses, credentials, certificates and data differ — and routine updates from the browser by choosing
the same TMRKZ folder, PAM being kept for the first set-up and emergencies.

**Decision.** Accepted.
- `ops/update/managed-paths.conf` classifies every path: `protected` (never read or written by an update: `.env`, `certs/`,
  `data/`, `backups/`, `map-data/`, `map-runtime/`, `ops/local/.generated/`, any extra `docker-compose.*.yml`, the image
  archive), `dev` (never transferred: tests, prototypes, audit and evidence), `config` (the two Compose files: shown, written only
  when selected explicitly, one container restart), `app` and `docs`.
- `ops/update/make-release.sh` signs the list of app/config/docs files with their SHA-256 (Ed25519 with `openssl`; the key stays
  on the machine that makes releases; its public key is installed once as `ops/local/.generated/release-trust.pub`).
  `--package` also writes the one-time transfer tar (app + docs only), the Compose files apart, and `SHA256SUMS`.
- `ops/update/UpdateWorker.java` is the Compose service `maintenance` in the existing image `tmrkz/folder-backend:1` (Java and the
  offline Maven libraries), internal network only, no Docker socket, no shell offered. It verifies the signature; classifies with
  the installed rules plus a hard-coded protected list; compares (added, modified, deleted, locally modified since the last
  update, too large, new npm dependency); after approval re-checks every staged file, builds the backend offline when its sources
  change (nothing is applied if it does not build), backs up to `backups/updates/<id>/`, applies (in place for files
  bind-mounted one by one), verifies that the backend restarted with the new build and the web was republished, and rolls back
  by itself when verification fails; a finished update is rolled back on request. `data/`, `.env` and the generated secrets are
  also mounted read-only into it.
- Backend broker `ae.mover.update` (`/updates/*`): global administrator only, step-up for approve and rollback; it accepts only
  the compared files with their signed SHA-256 and audits received/approved/rollback and each outcome once;
  `/system/liveness` (public) gives the backend's start time. Frontend «مركز التحديث» (settings): folder picker, SHA-256 in the
  browser (a built-in implementation where `crypto.subtle` is missing on plain http), selection (Compose and locally modified
  files never preselected), upload of the differing files only, approval with a reason, progress through the backend restart,
  history and rollback.
- Only what changed restarts: the backend and the web rebuild themselves on source changes (ADR-091); `backend-run.sh` and
  `web-run.sh` run their new copy when an update changes them; nginx reloads a changed `nginx.conf` after `nginx -t`.
- `start.sh`: an installation whose images are loaded starts without `tmrkz-images.tar` or its checksum; an extra
  `docker-compose.*.yml` not named in `COMPOSE_FILE` stops the start with the exact lines to add (before, it was silently left
  out and the containers would have been recreated without it).
- Found by the end-to-end run and fixed: `start.sh` now takes its own Compose project from the configuration (it counted only
  «tmrkz» as its own on the port), waits for `keycloak-setup` and runs it once more after a transient Keycloak error (a sign-in
  right after start was refused); a release that would delete more than a tenth of the installation flags every deletion
  `MASS_DELETION` and never preselects it; the page follows `APPROVED`/`ROLLBACK_REQUESTED`; the worker's heartbeat has its own
  thread.
- No new dependency, no new image, no PowerShell. Owner guide: `docs/UPDATE_CENTER_AR.md`.

**Tests.** `UpdateCenterIT` 3/3; frontend `sha256.test.ts` (FIPS 180-4 vectors) within 407/407; the worker compiles with
`-Xlint:all` in the image; end to end `tests/acceptance/update-center.mjs` on a throw-away installation laid out like the VM
(Compose project `tmrkz-vmsim`, started by `start.sh` without the image archive and with a third Compose file) — results in
`docs/STATUS.md` and `docs/evidence/update-center/`.

## ADR-105 Certificates and configuration import from the browser; directory lookup before a first sign-in; release acceptance (25 Nov 2026)

**Context.** The owner's «Final Completion and Release Acceptance» brief (25 Nov 2026) accepted ADR-103/104 provisionally and
asked to complete: browser certificate import and validation for the existing certificate folder and the VM's configuration
(chains, expiry, host names, private-key matching, service-specific trust for https, Keycloak, LDAP; preview, explicit
application, health checks, recovery; never exposing a key); import of a compatible application's configuration file (MOVER's
`.env` names) mapped to the integration sections, with missing values and conflicts shown, tested before applying, never touching
database credentials, signing keys or unrelated machine settings; administrator lookup of a directory account before its first
sign-in where an authorised lookup exists, the limitation explained otherwise; classification of the 18 failing tests; Update
Center security and reliability; UI and map regression; a minimal one-time bootstrap package. No new dependency or image, no
PowerShell, one folder, main only.

**Decision.** Accepted.
- **Certificates («الشهادات»).** `CertificateInspector` reads PEM (certificates; PKCS#8, PKCS#1 and SEC1 keys; encrypted keys),
  DER, PKCS#7 and PKCS#12 with the JDK and the Bouncy Castle 1.86 the signature library already brings (no new dependency). Checks:
  key ↔ certificate by a signature made and verified (any key type), validity (expired / not yet / 30 days), server use (EKU),
  host name against the alternative names (one-label wildcards, IP names), chain to a root with PKIX (the root the only anchor;
  revocation not checked: offline), key strength. `CertificateService` (global administrators only):
  - `DIRECTORY` and `OIDC` trust: each service its own CA list in its saved section of «إعدادات التكامل» (ADR-092), applied at once.
    Before applying, a live protected connection to that server is made with the new list (chain and host name); a list that
    breaks a connection working now is refused. After applying, the same connection is made again; the previous list returns by
    itself when it fails. Restore on request. ADD (merge) or REPLACE.
  - `HTTPS`: the backend checks and stages `server.crt` (leaf + issuing CAs), `ca-chain.pem` and, when uploaded, `server.key`
    (owner-only file) in the update volume; the maintenance worker re-checks (staged certificate = the one checked, key matches,
    valid now, the folder is still TMRKZ_TLS_DIR and is `ops/tls/…` or `certs/…`), backs up to `backups/certificates/<id>/`,
    installs atomically, and — when https is on — waits until the https entry point serves the new certificate, else restores
    the backup (`FAILED_ROLLED_BACK`); `APPLIED_INACTIVE` when https is off. The proxy reloads by itself (`ops/tls/tls-watch.sh`:
    `nginx -t` then reload; a refused certificate leaves the running one) — no Docker socket anywhere.
  - Inventory: the worker lists, every 30 s or on request, the folders the running configuration uses (TMRKZ_TLS_DIR,
    TMRKZ_TRUSTSTORE_DIR, `certs/`), certificates as PEM, a key only as its public-key fingerprint, permissions and which
    certificate it matches. Any listed certificate can be the source of an import.
  - Never in a response, log or audit entry: a private key. Staged keys are deleted at the end of the request, on discard, or
    after one hour without approval.
- **Configuration import («استيراد ملف إعدادات»).** `IntegrationImportService` parses a dotenv file in memory (quotes, `export`,
  comments), maps LDAP_* / KEYCLOAK_* / AI_* (MOVER's names, verified against its configuration code) and TMRKZ's own names to the
  directory, Keycloak and assistant sections, and compares each with the value in force: NEW, SAME, CONFLICT, missing CA file. A
  CA path is resolved by file name in the certificate folders the worker lists. Secrets are compared on the server and shown
  only as ••••. Database URLs and passwords, secret, signing and encryption keys, OpenFGA, the local identity provider and its
  bootstrap, platform passwords and tokens are «never imported» (names only); this application's own return address is «not
  applicable»; everything else «unused». Conflicts, the other application's Keycloak client (registered for it, not for TMRKZ)
  and any section the file cannot complete are never preselected. Applying needs a passed live test of that exact selection and
  goes through each section's own audited save; `.env` is never written.
- **Directory lookup before a first sign-in.** `DirectoryAuthenticator.lookupMode()`: `SERVICE_ACCOUNT` when the directory in force
  has a read-only account; `OWN_ACCOUNT` with ADR-100's direct bind — the administrator, signed in with the directory, types their
  own directory password for that one search (throttled like a step-up, never stored or audited; the bound entry must still carry
  their linked stable identifier); `UNAVAILABLE` otherwise, explained on the screen. The entry found is shown for confirmation;
  on confirmation the person is created through the unchanged `IdentityService.resolve` exactly as their first sign-in would
  (HR record in Oracle mode; else LOCAL linked `DIRECTORY` by the directory's stable identifier), so their later sign-in lands on
  the same record. A TMRKZ record already holding the login or number is refused for review. Least privilege, confirmation
  fingerprint, audit and the last-administrator rule unchanged.
- **Update Center hardening.** Free space checked before receiving a file and before applying (`TMRKZ_UPDATE_MIN_FREE_MB`); an
  interrupted upload leaves nothing staged and says so; `TMRKZ_UPDATE_DEPLOY_MINUTES` configurable.
- **Bootstrap.** `make-release.sh --bootstrap <commit>` writes `release/bootstrap/`: only the app/docs files changed since the
  machine's commit (plus `ops/update/`), the signed full list, the Compose files for review, the public key, `bootstrap.sh`,
  `INSTALL.txt`, `SHA256SUMS`. `bootstrap.sh check|apply|restore`: checksums, signature, every file against the signed list,
  protected paths refused, backup of every file touched, Compose files only with `--with-config` after the diff, the public key
  installed once (another key already trusted stops it), the baseline written; restore returns every file exactly.
- **Defects the acceptance runs found and fixed:**
  - «المزيد» in the top bar opened a menu nobody could see: the bar clips what leaves it (it hides the items that do not
    fit), and the menu opens below it — reported by the owner the same day. The menu is now placed in the window under its
    button (`TopNavigation.tsx`); the navigation test checks that each menu item is the element actually on top (the earlier
    automated click had passed through the hidden item).
  - On phones the «الدعم»/«المساعد الذكي» buttons sat half under the bottom sheet tabs; they rise above them
    (`floatingAssist.css`).
  - «مركز التحديث» reset the file selection to its defaults after each upload, dropping a change the administrator had
    chosen by hand (a flagged one); the defaults are now made once per update (`UpdateCenter.tsx`).
  - A decision that needs a recent sign-in (applying an update or a certificate, rolling back, restoring) only showed a
    passing notice; it now asks to confirm the identity in place and continues (`StepUpNotice.tsx`, the same two ways as
    «الاعتماد»).
- **Owner requests the same day:** «إعدادات النظام» reorganised — a side menu of seven groups with search and live status
  badges, status cards that open their group, one group at a time or «الكل» (still the default, so every section stays where
  it was reachable) (`SettingsPage.tsx`); every map page opens on the whole country, as «الموقف العملياتي», instead of a
  zoomed-in place, with «الخريطة كاملة» beside the map's own controls to return to it — data is no longer framed on load,
  choosing a site, unit or request still brings it into view (`OfflineMapLibre` `fullView`, `RequestMap`, `SitesMap`,
  `CommandMap`).
- **The 18 failing tests** were expectations from before ADR-095 and the posture summary (ADR-094 Gate 2 §C); updated to the
  designed behaviour without weakening any check (`docs/evidence/regression-18/CLASSIFICATION.md`). Found on the way and NOT
  fixed (owner's choice of table): the FYI designations the final approval reads (`fyi_designation`) cannot be set from the
  application (the screen writes `fyi_main_command`).

**Tests.** `CertificateInspectorTest` 5/5, `CertificateCenterIT` 2/2, `IntegrationImportIT` 1/1, `AdministratorDirectoryLookupIT`
1/1, `AdministratorOwnLookupIT` 1/1, the stationing classes 40/40; the full backend suite has 20 failures, all identical on an
untouched `8800b58` (42 there) and recorded as open. Frontend 411/411. Browser on a throw-away installation laid out like the VM:
`release-acceptance.mjs` 40/40, `ui-regression.mjs` 48/48, `update-center.mjs` 33/33; `bootstrap-test.sh` 9/9. Details and
the acceptance matrix: `docs/STATUS.md`; guide with screenshots: `docs/guide/TMRKZ_FINAL_DELIVERY_GUIDE.html`.

## ADR-106 Final USB delivery: VM compatibility check, areas stopped at their farthest distance, one FYI source, the 20 remaining tests (25 Nov 2026)

**Context.** The owner's «Final USB Delivery and Complete Illustrated Handover» brief (25 Nov 2026) asked to verify the
release; prepare the USB (bootstrap package, the guide, START_HERE.txt, checksums, acceptance and recovery records, and the
signed files for the first browser update; no secret, data, certificate, cache, image archive or map dataset); complete the
illustrated offline guide in Arabic; verify the VM layout without assuming its files match `e30c1c1` («the existing VM has had
local modifications»), explaining how compatibility is checked before applying; resolve the FYI inconsistency (ADR-105) from
the implementation and its data; investigate all 20 remaining backend failures without weakening a security or
authorisation test. The same day the owner reported: a new request page chose the location and moved to the next step by
itself («it also happened everywhere»); a 14.8 km measuring line from a registered site; and «منطقة الانتشار الفرعية لا يسمح له
بالرسم عن الحد، فقط يضع السهم عند أقصى مسافة ممكنة مع نسبة التغيير في طبيعة الأرض».

**Decision.** Accepted.
- **VM compatibility before applying.** `make-release.sh --bootstrap <commit>` also writes `BASE.tsv` (git's id of every
  released or removed file as at `<commit>`), `KNOWN.tsv` (every version of those files ever committed, with commit and date)
  and `BASE-COMMIT.txt`. `bootstrap.sh check` computes the same id of each machine file without git (`blob <size>\0` + bytes,
  sha1; checked equal to `git hash-object` under dash), and places every released file that differs from the release, and
  every file the release removes: as at that commit (also when copied from Windows with CRLF line ends), an earlier committed
  version (named with its commit), or CHANGED ON THIS MACHINE. `apply` stops before replacing or removing a file changed on the
  machine (or a Compose file changed there, with `--with-config`) until the operator chooses `--keep-local` (left as it is) or
  `--overwrite-local` (replaced; the machine's version in the backup). The baseline the Update Center compares with now records
  a released file as signed, a file of an earlier release as installed (so the first browser update replaces it as an
  ordinary update), and a kept hand edit as a mark no file has — the Update Center then shows it «معدّل على هذا الجهاز» and never
  preselects it (before, a file that differed had no baseline entry, so a hand edit could be replaced unflagged). `BASE.tsv`
  and `KNOWN.tsv` are covered by `SHA256SUMS`, not by the release signature: they only decide what is reported and when to
  stop, never what is installed (every installed file is still checked against the signed list).
- **Deployment areas stop at their farthest distance (owner).** The farthest an area may be is its leg's base maximum, what the
  ground adds (the leg's own extra, else a slope class's allowance — the server's `StationingPolicy.terrainAddM`) and the
  exception margin when the policy gives one (ADR-078). While an area is placed, moved, drawn or edited, the editor uses the most
  any ground can add: the pointer's arrow stops there and says so; a ready shape or copy is placed no farther along the click's
  bearing; a drag stops; each drawn corner is placed within the circle (so the drawn shape and its centre are within it); a
  vertex, resize or rotation that would take the centre beyond it is not made (`SiteEditor.setReach`). Once placed, the
  server's read-only terrain assessment of that shape gives the ground's own maximum (`effectiveMaxM`); an area beyond it is
  brought back along its bearing (a few times at most, each step nearer) and the panel says why. A saved area opened as it was
  is never moved. The server's check on save is unchanged.
- **A site setup boundary above the policy's maximum footprint is refused** (`SiteSetupService.evaluate`, with or without
  units). The setup has no approver to decide it, unlike a request's proposed site (ADR-087). A 271 km² boundary had been
  registered against a 0.5 km² maximum, and every area was then measured from its far edge. The setup editor draws such a
  boundary red. The registered site itself is left as it is (the owner redraws it).
- **Pages never choose or move by themselves (owner).** A new «طلب مناطق انتشار» / «طلب إعادة تمركز» opens at step 1 with nothing
  chosen (an explicitly opened unit or site is preselected, and still «التالي» moves on); «الموقف العملياتي» no longer zooms when
  units load or on its first filter run — only «الحدود والمناطق» or a choice moves the view.
- **One FYI source (V69).** From the implementation and its data: `fyi_main_command` (V26, ADR-042) is the one the screen writes,
  audits and the migration centre carries; `fyi_designation` (V64) was read by the re-stationing final approval and written by
  nothing. `fyi_main_command` is authoritative and gains «وما دونها» (`include_descendants`); V69 copies every `fyi_designation`
  row into it (union, idempotent, audited once as `FYI_MAIN_COMMAND_MERGED`) and keeps the old table, superseded.
  `FyiMainCommands` is the one reader of both distributions; changes stay with a global access manager, audited with who, when
  and reason. Evidence: `docs/evidence/regression-18/FYI-RESOLUTION.md`.
- **The 20 remaining backend failures** (`docs/evidence/regression-18/REMAINING-20.md`): 11 obsolete expectations of documented
  design changes (ADR-095 activation at final approval; ADR-094 V55 people not read in bulk; the assistant OFF mode; the V64
  access-request offer list) and 9 test fixture or measurement defects (a fixture violating `unit_member_check1`; a summary URL
  that never existed; role definitions leaking between test classes through the shared database; the posture scan gate
  reading a server-wide counter instead of its own transaction's). No application defect among them; no test deleted, skipped
  or loosened; no bound raised; three scope assertions strengthened (`WorkflowGraphIT.askingWithScope` now proves the 403 comes
  from the scope rule, for a role that is on the offer list).
- **Found, not changed (owner's decision):** the posture reach asks OpenFGA once per reached unit (`RestationingService.reach`):
  about 0.2 s at 100 units, 1.6 s at 1,000 and 9 s at 5,000 on the development machine; its SQL stays at 5–6 scans and under
  30 ms. A faster confirmation (an OpenFGA batch check, or one confirmation per grant subtree) changes how authorisation is
  confirmed and is left for the owner.
- **Release hygiene.** `gen-openapi.py` writes LF on every platform (it wrote CRLF on Windows, so the release hashed bytes
  differing from the commit).
