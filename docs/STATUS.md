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
  - Review fixes (ADR-016) — TNQL's two sign-in paths on one page (automatic through Keycloak, manual username and
    password checked by the directory over TLS), `auth_time` required on every sign-in, a limited first-administrator
    path proven by a clean installation, and task assignment with access-manager choice and uncapped candidate scans.
  - Step 4 done — administrative map workspace (ADR-017, `docs/MAP_WORKSPACE_COMPLETION_AR.md`): PostGIS boundaries
    with versions, provenance and conflict refusal; GeoJSON/KML import with preview and whole-file publication;
    drawing and editing (Leaflet-Geoman Free, vertex table, coordinate entry); the map-first workspace with
    organisation and site trees loaded per level, real backgrounds and layers, coverage per viewport, period and
    resource availability with partial occupancy, a request drawer that keeps the selection, boundary versions pinned in
    revisions and approval documents; the map package manager; the fabricated shapes around points removed. MAP-01 …
    MAP-18 pass (backend and Edge browser, acceptance environment without internet egress). Migrated in place from the
    earlier release's data with every earlier row unchanged.
  - Step 3 done — OpenFGA and the permissions studio (ADR-018): TMRKZ's own OpenFGA 1.8.16 confirms every action the
    grants allow (both must allow; refused if it cannot answer), tuples kept current by a transactional outbox with
    per-actor freshness before sensitive actions, a generated and reviewed model (`docs/authz/model.fga`); scoped
    grants with explicit organisation sets, sites, resources, AND/OR and explicit ALL; access managers bounded by their
    own authority and grantable roles; a versioned role policy (draft, impact, publication with the model id pinned,
    recorded rollback); «مركز الصلاحيات» with plain-Arabic scopes and "what can this person do and why".
  - Step 5 in progress — visual rule editor done: visibility and requirement conditions of form fields, the stages a
    field change restarts, and stage conditions of workflows are built from lists (all / any / not, typed operators,
    literal values) with a plain-Arabic sentence; "try it" evaluates the unsaved form on the server
    (`POST /forms/evaluate`) and the workflow simulation takes sample values. Per-resource parent/child relation
    (blocking or independent, re-locking existing bookings or refusing the change) and an optional shared-use limit
    enforced atomically at approval (ADR-019), with «إعداد الموارد وعلاقاتها» in the site panel. Open in step 5:
    explicit migration of running requests to a new version.
  - Step 6 done for the mechanism (ADR-020): in PKI mode the approval document is signed by the approver's
    certificate and sealed by the organisation (DSS 6.5.1, JAdES), validated against trust anchors and in-network CRLs
    (revoked, expired, untrusted refused), outside the decision transaction; the decision publishes it only if the
    approval and the reservations commit, otherwise the attempt is kept as unpublished. "Verify now" re-validates a
    published document. Proven with a fictional PKI; the enterprise provider, its certificates and a TSA are not
    connected.
  - Step 7 open — isolated bundle with UI and load acceptance. See the PA matrix in `TRACEABILITY.md`.

- **Owner continuation prompt and owner brief of 30 Oct 2026 (ADR-021, ADR-022):**
  - On-site menu (prompt §3) — done: marker/boundary click, Enter/Space, phone bottom sheet, tree and list «طلب»
    buttons, server-decided actions (`GET /sites/{id}/request-actions`), explicit type and resource handoff, nothing
    written by selecting. Browser MAP-19 passes alone and passed in one full run; in the last full run (30 Oct,
    81 s, 21/22) it failed once at «Enter on the refocused marker after Escape» — an intermittent failure inside the
    full suite whose cause is not yet found (a marker-focus fix on redraw is in place). Recorded, not rerun to green.
  - Map workspace layout (brief §2) — done: the request is docked in the map's left column (no floating form over the
    map), bottom drawer on phones, collapsible directory, draft kept across navigation as a minimised bar.
  - Review and decision workflow (brief §5) — done: referral for study (`REFER`), return for correction and final
    rejection with mandatory reasons, «what changed» between submissions, recorded communication of decisions
    (append-only), administrative completion with a statement under the separate `CLOSE` right, plain-language states.
  - Unit symbols (prompt §6, map brief §10) — done: V12 catalog and assignments as HR-safe local metadata, approved
    standard as a policy setting, CONFIGURE-only checked assignments, symbols in directory rows, organisation details
    and request summaries, Arabic legend, fallback mark «لم يحدد رمز الوحدة»; milsymbol 3.0.4 (MIT) bundled, loaded
    lazily from the local build. An optional toggleable map layer «رموز الجهات المرتبطة بالمواقع» (off by default,
    `OrgSymbolLayer`, ADR-021 refined 30 Oct) draws every visible responsible/occupant organisation's symbol beside each
    marker (none dropped; the strip wraps), each its own button; clicking one selects that organisation as the map
    filter (directory switches to the organisations tab) and the site, opening its actions. Informational only,
    independent of availability colours, never replacing geometry, writes nothing. Frontend typecheck/build/tests pass;
    browser check MAP-21 (now including per-symbol organisation+site selection and the uncapped strip) pending for the
    consolidated checkpoint — the owner's own hands-on run on localhost:8088.
  - MOVER administrative integration — contract drafted (`docs/MOVER_ADMIN_INTEGRATION.md`), not implemented.
  - Relocation of an organisation's premises (owner request of 30 Oct, ADR-023) — done: two-option ring around the
    site on the desktop map, «نقل المقر» panel with the organisation (whole or section with branches), the new location
    drawn on the map (dashed outline and arrow), the configured review and decision, the move recorded at closing; the
    site register is never changed by a proposal. Main-unit skip rule and automatic registration of the new site are
    not implemented (`docs/STATIONING_REQUEST_DESIGN_AR.md`). Deployment planning, moving groups with preserved
    spacing, tactical graphics and operational movement integration are not built (scope exclusion).
  - Direct marker management on the map (owner scope clarification of 30 Oct, `docs/SCOPE_CLARIFICATION_AR.md`
    function 2, ADR-024) — done: adding a new site by placing a marker on the map, and moving an existing site's
    marker, as a direct audited facility-register edit (`MANAGE_FACILITIES`, reason + audit), separate from the
    relocation request. `SiteMarkerEditor`, `POST /sites`, `POST /sites/{id}/location`; `SiteMarkerIT` (6 tests pass),
    frontend typecheck/build/tests pass; the browser MAP-20 check is pending for the consolidated checkpoint (not yet
    run). It never touches boundaries, resources, responsibility or reservations, and selecting or
    panning writes nothing. This closes the one in-scope geographic function the map interface had left out; the gap
    "a facilities administrator registers a new site separately" (ADR-023) is now served by this action.
  - Not started: tiled offline backgrounds (prompt §7), scoped explicit denies and delegations in the studio (§8),
    governed migration of running requests (§9), the browser PKI journey (§10), Node failure diagnostics (§13), load
    measurement (§14), release bundle and restore (§15).

Test evidence: backend acceptance tests on PostgreSQL + PostGIS with OpenFGA in the loop (including the map criteria,
a 10,000-site measurement and the authorisation suite), 21 browser checks for MAP-01 … MAP-18 and 6 for the permissions
studio in Microsoft Edge, a 40-check end-to-end journey through nginx, a restore verification, an upgrade check of
earlier data, and 17 frontend tests — see `TRACEABILITY.md`.

## Known limitations

| Area | Limitation | Planned handling |
|---|---|---|
| Studio UI | Rule conditions are edited visually (forms and workflow stages); groups nest two levels deep in the editor (the language allows six, which the API still accepts). Running requests stay on their versions; there is no action to migrate them to a newer version. | Add an explicit, audited migration action if the owner needs one. |
| Shared resources | Resources with policy `SHARED` take no exclusive locks. An optional limit of simultaneous approved uses is enforced at approval (ADR-019); there is no headcount capacity (the owner set no default). | Add headcount-based capacity only if the owner asks for it. |
| Geometry | PostGIS boundaries (ADR-017). Import accepts GeoJSON and KML; Shapefile and GeoPackage are converted outside the application with an explicit CRS. Supported CRS: EPSG:4326/CRS84, 3857, 32639, 32640. | Add further formats or CRS only with converters and tests; organisation CRS decision D-01. |
| Map backgrounds | Renderers for SVG and PNG/JPEG overlays georeferenced by corner bounds. No aerial imagery is installed (the map says so). PMTiles, MBTiles and XYZ tiles are refused at upload. | Install licensed enterprise packages through the map manager; a tile renderer needs its own decision (D-07). |
| Map volume | 10,000 sites: city viewport 17 ms, district (900 sites) 40 ms; above 1,500 sites in one viewport only markers are sent, above 5,000 the list is capped with a message (`PERFORMANCE.md`). | Clustering if enterprise data needs it. |
| Audit | Append-only at database level; no cryptographic hash chain. Database superusers can still alter data. | Optional sealing job and separation of the DB owner from the application role in production. |
| Authorisation | OpenFGA confirms point decisions; lists and counts are filtered by the SQL predicate of the same grants (OpenFGA cannot filter rows). No explicit deny rules: grants are additive. Background jobs (information copies, task realignment) use the database evaluation only. Delegations are still created on the organisation page. | Add deny rules only if the owner asks for them; move delegation into the studio. |
| Database roles | The application connects as the schema owner. | Production: separate migration owner and a restricted runtime role (documented in OPERATIONS). |
| Malware scanning | Built-in checks (type sniffing, EICAR, macros, active PDF content); no AV engine. | Connect an internal scanner (e.g. ClamAV) behind `ContentInspector`. |
| Notifications | In-app only. | Correspondence connector after D-04. |
| SLA timers | Overdue review tasks are detected every minute and notified; no automatic escalation/reassignment. | Add escalation rules to the workflow definition. |
| Request closing | Closing needs the `CLOSE` right (facilities review role by default) and a completion statement; evidence is a reference text, not an uploaded file. | Add evidence attachments to the completion if the owner asks. |
| Org tree UI | The map and the permissions studio use lazily loaded organisation and site trees with search (ADR-017/018). The organisation page and the request form's organisation list still load the whole visible tree (7,000 nodes ≈ 1.5 MB, ~0.1 s). | Move those two screens to the lazy endpoints. |
| High availability | Single instance per service in compose; no HA or failover tested. | Out of scope until D-03/D-05 targets are set. |

## Integrations not connected (never simulated as connected)

| Connector | Status | Note |
|---|---|---|
| Enterprise identity (Keycloak + LDAP) | Tested with the fictional directory of the test environment | Production needs the enterprise LDAP URL, a read-only bind account, the users' DN and the CA (ADR-015). |
| Organisation structure | FILE_IMPORT | Validated import with preview; automatic sync waits for D-04. |
| HR source (organisations and people) | NOT_CONNECTED until a sync succeeds | Read-only Oracle mirror implemented and tested on fictional views (ADR-014); enterprise address, account and mapping pending. |
| Correspondence | NOT_CONNECTED | No external message is sent or claimed. |
| PKI signature provider | Tested with the fictional PKI of the test environment; enterprise provider NOT_CONNECTED | Production needs the provider (HSM or signing service), the approvers' and seals' certificates, the CA chain and the CRL distribution; a TSA for B-T signatures. PKI mode fails closed until then. |
| Malware scanner | BUILT_IN only | See limitations. |

## Open decisions (from the handoff) and how the build handles them

| ID | Decision | Current handling |
|---|---|---|
| D-01 | Coordinate reference / format | Boundaries stored in EPSG:4326 (GeoJSON order); input CRS from the file or an explicit declaration (4326, 3857, 32639, 32640), transformed in PostGIS; nothing inferred from numbers or wording. |
| D-02 | Internal attestation vs PKI | Owner chose certificate signature + seal (§2). PKI mode implemented with DSS (ADR-020) and proven with a test PKI; internal attestation remains selectable and labelled as such until the enterprise provider is connected. |
| D-03 | Concurrency, rates, file sizes | Exploratory measurement only (`PERFORMANCE.md`); attachment limit 10 MB by policy. |
| D-04 | Identity, structure, correspondence systems | Local adapter + file import; other connectors NOT_CONNECTED. |
| D-05 | RPO/RTO, retention, SLAs | Backup/restore tooling and a measured restore; no time objective promised. |
| D-06 | Invalidation of approvals on field changes | Per-field policy (descriptive / restart named stages / full re-approval); structural changes always full. |
| D-07 | Aerial imagery sources | Only installed packages: the illustrative regional road map; packages uploaded and reviewed through the map manager. No imagery fabricated or fetched; «لم تثبت حزمة صور جوية» is shown. |
| D-08 | Parent resource booking | Explicit resources with hierarchical scope locks (parent blocks children, siblings independent). |
| D-09 | Execution/receipt stages and owners | Configurable execution templates per workflow; demo defaults declared in the workflow definition. |

## Readiness statement

The system passes its automated acceptance suite and a measured restore, but **operational readiness for production
is not claimed**: it still needs the open decisions above, a production hardening review (TLS termination,
database roles, secrets management, host egress controls), capacity targets (D-03) and a load test against them.
