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

- **Map-first stationing workspace (30 Oct 2026, ADR-025):** `#stationing` with the organisation tree, the map and
  the request panel; drag a proposed location away from the current premises with live distance, the configured allowed
  range (`placement_rule`, V15, no seeded values) and occupied registered boundaries in red; refuse out-of-range or
  occupied points in the browser and again on the server at save, submission and approval; covered organisations
  chosen explicitly; permanent or temporary; draft save and reopen (`#stationing/<requestId>`); occupant identity masked
  by view. The current premises' marker is never changed by a proposal. **Not yet:** activation into the dated
  organisation↔site record after approval, automatic end-of-term return and reminders, a rule editor screen, workflow
  studio changes (phases D–E of the brief).

- **Security and integrity remediation (2 Nov 2026, ADR-026):** after the enterprise acceptance audit
  (`docs/audit/enterprise-launch/REPORT_AR.md` — the report, its evidence and the exploit re-run scripts in
  `tests/acceptance/audit/` are kept outside this public repository because they describe exploit paths; references
  to them below point to the owner's local copy), the four reproduced P0 defects are fixed — escalation through HR
  position seats, self-grants and a permanent bootstrap administrator, hidden-site names/dates in check, submission and
  target answers, unscoped people and delegation lists (scoped managers now search outside their authority by name or
  exact identifier only, and see name + organisation) — and the four P1 defects: earlier approvals carried after the
  relocation proposal moved, stale import previews, an invalid latitude saved as 0, overlapping registered boundaries.
  Backend suite 116/116, frontend 26/26; each regression test was red before its fix; exploit re-runs against the
  rebuilt environments in `docs/audit/enterprise-launch/evidence/`; browser suites offline: map 22/22, journey passed,
  access studio 5/6 (STUDIO-03 stale count of actions since `CLOSE`, 30 Oct). **Not yet:** separation of duties for approvals
  (decided by the owner, not enforced), identity-issue resolution bounded by the target's grants, local provisioning of
  people and controlled unit creation (planned), activation/return of approved stationing.

- **Separation of duties and directory scope (2 Nov 2026, ADR-027):** nobody decides a request they made — directly,
  through a delegation either way, another role, organisation or HR seat, or another person record of the same human;
  a task with no independent holder waits for the access managers on «مهام بانتظار الإسناد». Scoped access managers see,
  search, link, grant, explain and list rosters only for people inside their authority (site-grant bridges by name);
  unlinked sign-ins are scoped and linking is bounded by authority over the person's grants. Boundary overlap along the
  site tree is containment only and re-checked when a site moves. Load tool repaired (directory sign-in, synthetic
  accounts, disposable environment). **Not yet:** separation of duties for execution tasks and closing (owner decision),
  the open items listed in ADR-027, local provisioning and controlled unit creation, scale measurements.

- **Stationing footprint interaction (2 Nov 2026, ADR-025 amendment):** «مساحة التمركز» now proposes a footprint, not a
  point — the registered polygon and organisation symbol are copied and dragged as one rigid object (area kept), or a new
  polygon is drawn by vertex count or typed coordinates; vertex editing, undo/redo/reset, compare, cancel, save and reopen.
  Browser walkthrough 11/11 (`tests/acceptance/stationing-footprint.mjs`). Activation of an approved relocation is not
  built; the owner's hands-on acceptance is pending.

- **One GIS workspace (2 Nov 2026, ADR-029):** «الخريطة والمرافق» is retired; «مساحة التمركز» (`#stationing`) carries all
  of its functions — period and colour mode, backgrounds and layers, site and organisation trees, site details and use
  requests, the on-site menu, boundary and marker editing, imports, map packages and export — and `#map` redirects to
  it. «نقل المقر» opens the polygon stationing panel; the point/rectangle relocation panel and the duplicate stationing
  popup are removed. Inventory and results: `docs/GIS_WORKSPACE_RETIREMENT_AR.md`. Browser: retirement checks 8/8,
  stationing 11/11, map 22/22, admin journey 12/12, resources 3/3, journey passed. **Not yet:** activation of approved
  stationing, site-sharing agreements, touch dragging of the footprint (untested); owner review pending.
  **Superseded the same day (owner decision):** the merge was removed and «مساحة التمركز» is back to its pre-merge
  stationing layout (walkthrough 11/11, merge-removal check 5/5, `docs/GIS_MERGE_REMOVAL_AR.md`). The old page stays
  retired (no navigation entry; `#map` opens `#stationing`), so its facility functions — site details, use requests from
  the map, period and colour mode, layers, boundary and marker editing, imports, map packages, export — have **no screen**
  until the planned rebuild; their components, APIs and data are unchanged. The map, admin-journey (map steps) and
  resources browser suites target the retired page and cannot run until then.

- **Execution integrity (ADR-028): tested on a disposable database on 3 Nov 2026, NOT deployed.** It covers handover,
  receipt, acknowledgement and closing under separation of duties, with migration V17.
  - **Fixed** (committed 3 Nov 2026, not deployed): the workflow-publication bug, where `purpose` was rejected.
  - **Tested:** the backend suite passed 144/144 on a sealed throw-away database, including in-progress and scope
    cases (`ExecutionInFlightIT`) and V17 on older data (`V17MigrationIT`).
  - **Open:**
    - requests approved before ADR-028 can get stuck — a handover assigned to its requester has no recovery in the
      application;
    - closing is never routed;
    - approval stages held only outside their scope are not routed.
  - A recovery workflow is proposed but not built: `docs/audit/main-risk/ADR-028_TEST_RESULTS_AR.md`, with a read-only
    candidate query in `stuck-candidates.sql`.
  - **Do not deploy this revision to data you keep, or rebuild the test environment's backend from it, until the owner
    approves.** Either would apply V17.

- **Stationing V3 after the stop gate (4 Nov 2026, owner decisions 1–6): foundation built and tested, NOT active —
  no page uses it.** Report `docs/audit/stationing-v3-production/CONTINUATION_REPORT.md`; ADR-031, ADR-032, ADR-028
  amendment.
  - **V17:** clean migration path verified on a disposable environment through the release tooling (plan [17], backup,
    133/133 rows unchanged, backfill 0 mismatches, journey PASS); `tmrkz-test` on this machine (found at V16, not V17)
    upgraded to V17 by `ops/test-env/upgrade-backend.sh` (6,340 rows unchanged, journey PASS) and labelled
    `ACCEPTANCE / V17`. The `tmrkz-mover` volume on this machine is owner-retained and untouched. `up.sh` /
    `up-offline.sh` now refuse a rebuild that would apply migrations unless they are named.
  - **V18 `stationing_foundation`:** policy versions, authoritative stationing, site links, outbound outbox, terrain
    slope dataset (+`postgis_raster`). Clean V18 path PASS on a disposable environment.
    - **Applied to `tmrkz-test` on 4 Nov after the owner approved section 9; the database is now `ACCEPTANCE / V18`.**
    - Image and commits: release image `mover/backend:rel-4f7ea08`, built from local commit `4f7ea08` (not pushed).
    - Procedure: plan [18]; backup verified by restore (6,432 rows equal); V18 in 0.268 s.
    - Data: all 6,432 earlier rows unchanged; schema change identical to the clean path; 6 tables, 0 rows.
    - Health and access: journey PASS before and after; OpenFGA model equals the reviewed DSL.
    - Side effects: no outbound delivery, no Oracle access, no terrain rows, no policy published. Evidence:
      `docs/evidence/acceptance-upgrade/tmrkz-test-v18/`.
    - V18 is schema only, and the first production policy is not published (allowances are administrator
      configuration).
  - **Backend:** versioned policy with `terrain_slope_classification` (FAO initial bands) and separate allowances,
    terrain assessment from the slope raster, data correction of stationing, links, read API, outbox with HTTP sender
    (no consumer connected), three new permissions in the OpenFGA model. Full backend suite 185/185.
  - **Terrain:** GLO-30 copied from MOVER with verified hashes, slope product built (Horn, native grid), hillshade
    PMTiles (display only), loader and PostGIS checks pass. DSM, not bare earth; FGIC not used.
    - GLO-30 is approved by the owner as the current source. The licence was checked against the official document
      (COP-DEM-GLO-30-F, Article 6); its raw, derived, no-liability and no-endorsement notices are recorded word for
      word, with the licence reference and date.
    - Loading stays a separate operation after the migration. The loader now checks rows and cells before it commits
      and re-checks an existing load.
    - New `ops/terrain/unload-slope.sh` removes a dataset without touching business records; tested on a disposable
      database.
    - The ROLLING class shows the provisional label «تضاريس متدرجة».
  - **Map:** MapLibre 6.15.0 module with built-in Arabic shaping, packaged font, offline PMTiles, street/terrain modes.
    - Finding G-8a (brackets mirrored twice on `<html dir="rtl">`) is fixed inside the map module: its glyph canvases
      draw left to right. The page direction is unchanged, as the owner decided.
    - 21/21 label checks, 0 external requests; a control run without the fix still shows the upstream defect.
  - **Not built yet:** the re-stationing request workflow (requests, deployment areas, activation, temporary lifecycle,
    drift pause) and the production Stationing page. **Release gates:** real non-production Oracle, real touch device.

- **Stationing V3 production phases P0–P3 (3 Nov 2026): stop gate reached, NOT active.**
  - **Report:** `docs/audit/stationing-v3-production/STOP_GATE_REPORT.md`.
  - **P0 finding:** the acceptance test database `tmrkz-test` is at **V17**. It was migrated at 13:01:50 UTC when this
    session rebuilt the test environment after pulling `964edb2`. V16 adds indexes only; V17 added a column to 0
    rows. No backup from before the change exists. ADR-028 is amended. No production TMRKZ database exists on this
    machine.
  - **Code added:** pure domain logic and read-only adapters in `backend/src/main/java/ae/mover/stationing/` — policy,
    hierarchy and snapshot, drift, routing, terrain, deployment, occupancy, PostGIS geometry, outbound event contract
    and sender, read-access filter. Also an inactive frontend helper, `frontend/src/lib/stationingV3.ts` (the flag is
    off). No schema, no route, no user-visible change.
  - **Tests:** backend 174/174 on a disposable database (30 new, 11 ADR-028); frontend 84/84; build OK.
  - **Open:**
    - V17 approval, and a decision on the acceptance database.
    - **A new owner question:** the terrain classification method for elevation data.
    - Terrain data permission or import approval.
    - Non-production Oracle access.
    - The map renderer ADR.
    - A real touch device.

- **Stationing model V3, revision 2 — FINAL OWNER MODEL, all owner decisions closed (3 Nov 2026): design and isolated prototype for owner review,
  NOT implemented.**
  - **Design:** `docs/STATIONING_MODEL_V3_AR.md` records the owner's decisions:
    - O-02: a site link is separate from stationing, and stationing is separate from facility responsibility.
    - O-03: including a unit from another branch is configurable, with one or more approvals.
    - O-05: the terrain class is the one covering the largest area.
    - O-06: the terrain allowance raises the maximum only.
    - O-07: the route starts from the requesting unit and goes up the Oracle hierarchy.
    - O-08: an occupied deployment area is a hard block.
    - O-09: the first approver is the requesting unit's own, and this is configurable.
    - O-10: a hierarchy change pauses the request and returns it for reconfirmation; the route is then rebuilt from
      the same unit, with history kept.

    It also contains the Oracle, site-contract, workflow, Studio-properties, terrain-source and street-source designs
    and the offline map-package plan.
  - **Prototype:** `prototypes/stationing-ux/restationing.html`, scenarios A–X.
    - The street mode shows Arabic road names drawn offline. They are OpenStreetMap names (ODbL, non-authoritative),
      extracted from MOVER's local PMTiles by `tools/extract_road_names.py`.
    - The terrain relief is still generated and marked "not for production".
  - **Evidence:** `docs/audit/stationing-ux/model-v3/REPORT_AR.md`.
  - **Answered by the owner after the visual comparison (3 Nov 2026):**
    - O-04: deployment distance is measured centre to centre, for both relations.
    - O-13: the second area is labelled «منطقة الانتشار البديلة».
    - O-10b: after a hierarchy change, every stage is decided again.
    - O-14: activation leaves site links untouched.
  - **Closed by the owner the same day:**
    - O-03b: one existing stage may satisfy several conditions and records which; independence is configurable (a
      separate stage and a different human).
    - O-15: a site link is not occupancy; only authoritative records count.
    - O-16: a hierarchy change before activation blocks activation, pauses the request, and the route and approvals
      are rebuilt.
    - O-01: inbound from Oracle; outbound through a read API and an asynchronous outbox/event feed; no write to the
      Oracle hierarchy.
    - O-11: FGIC only with written permission, otherwise Copernicus GLO-30 (a surface model) with owner approval.
    - O-12: local PMTiles with OSM names, offline glyphs and ODbL attribution; official layers only once licensed.
  - **O-05b closed (option C):** a tie for the largest terrain share is decided by the administrator-configured
    `terrain_class_priority`; tied classes without a valid priority block submission. The decision and the policy
    version are written to the audit record (scenario T2).
  - **Owner decisions: none open.**
  - **Evidence:** 101/101 unit tests; 108/108 browser scenario loads (27 × 4 sizes); 44/44 interactions; 3/3 journeys;
    0 external requests; 0 errors.
  - **Ready for the production implementation phase, waiting for the owner's go-ahead.** Plan: §12 of the design
    document. Still not done: no backend, migration, real page, Oracle write or map package.
    - Licences for official terrain and road-name data: FGIC needs written permission; ADSDI road names are for Abu
      Dhabi government entities only; MOVER's NRN/FGIC road copies have no published licence.
  - **Not done:** no backend, migration, real-page, Oracle or map-package change.

- **Stationing domain model V2 (3 Nov 2026): owner-approved design baseline, NOT implemented.**
  - **Design:** `docs/STATIONING_DOMAIN_MODEL_V2_AR.md` (5th revision), with owner decisions D1–D18, the
    conditional-approval corrections A1–A5, the held-start correction A6 and a consistency review. After A6 the owner
    accepted the document and the isolated prototype as the design baseline: no further redesign cycle unless real
    implementation exposes a contradiction. It covers authoritative stationing separate from facility responsibility,
    associated areas with an explicit covered organisation scope, primary and alternative relocation candidates,
    independent activation, cancellation before activation, cancellation of an activated temporary before it starts
    (a pending cancellation holds the scheduled start; rejected late, the temporary takes effect from the decision time;
    its window can expire without a start), temporary overlay, extension (lapses if not activated) and early return.
  - **Prototype (reference and evidence):** isolated, with simulated rules and fictional data:
    `prototypes/stationing-ux/model.html`. Each sensitive action has its own mandatory-reason dialog. Phones get a
    three-height bottom sheet.
  - **Evidence:** 28 unit tests; 25 scenarios plus a measured polygon-drag test (mouse, and touch at 768/390) × 4 sizes
    = 104/104 browser steps with 526 checks and 48 confirmed dialogs, 0 layout issues;
    `docs/audit/stationing-ux/model-v2/PROTOTYPE_REPORT_AR.md`, review set of 17 images in `model-v2/review/`.
  - **For owner review:** two rules derived from A6 (§15 items ز and ح of the model document): an approved extension
    cannot be activated while a cancellation before start is pending or the start is held; an extension activated
    before the hold carries the window to its end.
  - **Not done:** no backend, migration (V18+ waits for ADR-028/V17) or real-page change. The two approved frontend
    fixes of the same day (basemap tiles, overlap predicate) are ADR-030, not part of this model.

- **Basemap tiles and overlap predicate (3 Nov 2026, ADR-030): two owner-approved frontend fixes, built and tested in
  the acceptance environment; committed 3 Nov 2026.**
  - **Basemap:** the installed SVG basemap is drawn as vector tiles instead of one image the browser rasterised again
    on every zoom step (`lib/svgTiles.ts`, `components/map/svgTileLayer.ts`, `MapCanvas`). Packages in another
    structure and raster packages keep the image overlay. Measured in Edge at four sizes and four zoom levels: worst
    frame 67–734 ms before, 14–31 ms after, no frame over 33 ms; boundaries and markers at the same pixels; basemap
    aligned with an independent rendering of the same file. Offline unchanged.
  - **Overlap predicate:** `ringsIntersect` no longer misses identical or coincident rings; its rule (shared area;
    touching is not an overlap) is unchanged and documented with the server rules it differs from.
  - **Environment:** only the `tmrkz-test` web container was rebuilt and recreated (rollback image
    `mover/web:before-basemap-tiles`); backends and databases untouched (V16, no V17). The rebuilt image leaves out
    `docs/audit/enterprise-launch/`, which the previous one served on port 8088.
  - **Open:** owner decision on touching boundaries in the live feedback (the server placement check counts any
    contact); `map-workspace.mjs` updated for the new renderer but not runnable while the facility page has no screen.
    Evidence: `docs/evidence/map-basemap/`.

- **Stationing defect fixes and UX prototype (2 Nov 2026, stationing UX brief):** seven defects of the visual audit are
  fixed in «مساحة التمركز» — touch dragging of the footprint, proposal/validation colours, RTL offsets of vertices and
  edge lengths, overlapping site markers, the organisation page's «على الخريطة» link, organisations without a symbol, and
  keyboard focus/Escape in the site menu (regression 7/7, the 11 polygon scenarios 11/11; `docs/TRACEABILITY.md`). A
  redesigned workspace exists only as an isolated prototype with fictional data (`prototypes/stationing-ux/`), compared
  with the current page in Edge at four sizes (`docs/audit/stationing-ux/redesign/COMPARISON_AR.md`). **Not integrated:**
  the real page keeps its current layout until the owner approves the design; its phone layout still hides the editing
  controls (V-01).

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

The enterprise acceptance audit of 2 Nov 2026 stopped before scale testing. Its P0/P1 findings are fixed (ADR-026);
separation of duties, identity/directory scope and containment-only boundary overlap followed (ADR-027), with an
independent review whose fixable findings were fixed and whose remaining items are listed in ADR-027. The load tool now
signs in through the directory flow against the disposable `tmrkz-load` environment and has completed a smoke workflow;
no measurement exists yet at 1,000 or 7,000 units. Scale phases wait for the owner's explicit approval.
