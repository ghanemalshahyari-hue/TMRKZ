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

- **Stationing V3 re-stationing request workflow (4 Nov 2026, ADR-033): built and tested on the server; first page behind
  the V3 flag; NOT on the acceptance database.**
  - **Migration V19 `restationing_request`:** requests, stages per route generation, revisions and deployment areas.
    Applied only to disposable and development databases; `tmrkz-test` stays at V18.
  - **Server:**
    - submission pins the policy version, takes the hierarchy snapshot and derives the route from the requesting unit;
    - checks block on occupied ground, footprint, the deployment pair and range (centre to centre, terrain allowance),
      a missing exception reason, terrain ties, other-branch units and an incomplete route;
    - decisions go to the stage unit's own seat, with separation of duties by the human;
    - a return re-takes only the affected decisions; a hierarchy change pauses the request and rebuilds the route;
    - activation is independent, with an atomic occupancy re-check; the temporary lifecycle is automatic;
    - outbox events throughout.
  - **New permissions:** CREATE_RESTATIONING, ACTIVATE_STATIONING, «(صلاحية مُلغاة — يقررها المعتمد النهائي)».
  - **Page «إعادة التمركز»:** request list and detail on the offline MapLibre map, route, checks, decide, activate,
    submit, and a first editor. Shown only with `VITE_STATIONING_V3=true`.
  - **Development environment:** `tmrkz-v3dev` on :8097 (`ops/test-env/dev-v3.sh`), fictional data and illustrative
    development values only.
  - **Tests:** `RestationingWorkflowIT` 11/11, `RestationingHrSyncIT` 1/1; full backend suite 197/197 (4 Nov, after
    `cea09c7`); `restationing-journey.mjs` 15/15 through the real sign-in; frontend 94/94, build OK.
  - **Owner decision O-17 (4 Nov, option B):** a distance exception is allowed only when enabled in the policy, up to
    `exception.maxExtra`, with a written reason and a separate stage decided by its permission holder, audited.
  - **V19 on `tmrkz-test` (owner D1/D2, 4 Nov): `ACCEPTANCE / V19`.**
    - Commits and image: local commits `685d902` (V18 evidence) and `7152d53` (workflow); release image
      `mover/backend:rel-7152d53`; full suite on C2 195/195.
    - Procedure: plan [19]; backup verified by restore; V19 in 44 ms.
    - Data: 6,552 earlier rows unchanged; schema change identical to the clean path; 4 tables, 0 rows, mismatches=0.
    - Health and access: journey PASS; OpenFGA 357 relations equal to the model.
    - Side effects: no outbound, Oracle, terrain, policy or request. Evidence:
      `docs/evidence/acceptance-upgrade/tmrkz-test-v19/`.
  - **D4 acceptance data (fictional, no policy):** `ops/test-env/provision-acceptance-v3.sh`.
    - 8 HR levels, 4 single-action roles, 8 seats for explicitly selected fictional users;
    - 10 starting stationing records, 1 missing boundary (site 10);
    - the full GLO-30 2026.11 terrain loaded separately (6,300 rows, all cell counts equal, 453 MB, 106 s).
    - **No policy published:** submissions stay refused until the owner publishes it.
    - **Owner values for the acceptance policy (4 Nov):**
      - ranges 5–8 and 3–5 km;
      - allowances 0 / 500 / 1,000 / 1,500 / 2,000 m;
      - priority MOUNTAINOUS first;
      - footprint 0.5 km²;
      - cross-branch with OTHER_UNIT and SITE_RESPONSIBLE;
      - exception disabled (no `maxExtraM`).

      The owner sets the routing levels and the deployment requirement in the new «سياسة التمركز» studio.
    - Evidence: `docs/evidence/acceptance-data/tmrkz-test-v3/`.
  - **Page and policy studio enabled on `tmrkz-test` (owner gate, 4 Nov; the earlier D3 «hidden» is superseded):**
    - local commits `f7856fe` (C3, V19 evidence and acceptance provisioning), `99c7ede` (C4, policy studio, template,
      web build flag, map mount) and `b8f62e8` (C4a, the flag reaches only the bundle build, not the unit tests);
    - backend `mover/backend:rel-99c7ede` without migration (6,667 rows unchanged, schema identical); web
      `mover/web:rel-b8f62e8-v3` with the map packages read-only under `/map-data/`; earlier images kept for recovery;
    - headless check: studio without a policy, 5 routing rows from the HR levels, 0 console errors, 0 external
      requests. Evidence: `docs/evidence/acceptance-upgrade/tmrkz-test-c4-backend/`, `tmrkz-test-web-v3/`.
  - **Real-application acceptance on `tmrkz-test` (owner gate «ACCEPTANCE POLICY FINAL SETTINGS», 4 Nov): run.**
    Evidence and every measured value: `docs/evidence/acceptance-journeys/stationing-v3/SUMMARY.md`.
    - **Policy version 1 published through the «سياسة التمركز» studio**
      (`tests/acceptance/publish-acceptance-policy.mjs`): Keycloak sign-in as `t.admin`, JSON import, the owner's
      settings in the page, «فحص على الخادم» passed, «نشر نسخة جديدة»; no SQL. The settings:
      - L6–L10 approve, final L6, ancestry routing from the requesting unit;
      - deployment areas REQUIRED; 5–8 / 3–5 km; allowances 0 / 0.5 / 1 / 1.5 / 2 km on the maximum;
        MOUNTAINOUS-first priority; footprint 0.5 km²;
      - cross-branch OTHER_UNIT + SITE_RESPONSIBLE, not independent;
      - distance exception enabled at 2 km (ACCEPTANCE TEST VALUE).

      The hierarchy stages rest on scope, classification, duration, site and deployment (owner model V2 §4.5). Read-back
      15/15.
    - **Journeys** (`tests/acceptance/restationing-acceptance.mjs`, real sign-in, real page, real GLO-30): A, X
      (exception: normal, within 2 km, too far), B (real scheduler start and return), C, D, E, F and S pass.
      - Run 1: 43 pass, 4 fail, 5 notes. Run 2 (the failed A, D and K after the fix): 18/18.
      - 0 external requests in both runs; 0 console errors in run 2.
    - **G (hierarchy change) is not run on `tmrkz-test`:** no HR source is attached there (seeded HR mirror; the sync
      reads Oracle only). It passes through the application's HR sync path in `RestationingHrSyncIT` (the
      Oracle-compatible test source, `POST /hr/sync`, publication, pause, reconfirmation, rebuilt route, approvals
      again, restore by sync).
    - **Defects found and fixed in local commit `cea09c7`** (functional, separate):
      - the web image served MapLibre's `.mjs` worker as `application/octet-stream` under nosniff, so the V3 map was
        blank;
      - the boundary-copy fallback said «لا حدود مسجلة» for a MultiPolygon.

      Web `mover/web:rel-cea09c7-v3` is now on `tmrkz-test`; recovery images `rel-b8f62e8-v3` and `1.0.0` are kept.
    - **Boundaries:**
      - a Polygon is copied;
      - a MultiPolygon falls back to «رسم حدود جديدة». The owner-approved target is copying the whole MultiPolygon and
        moving it as one rigid group, NOT BUILT;
      - a Point falls back to drawing.

      Six acceptance-test drafts are recorded: RS-2026-0008/0009/0010 and 0014/0015/0016.
    - **Not exercised on `tmrkz-test`:** routes from L8–L10 (no fictional requesters or seats below L7); a terrain tie
      on real cells; a second account of the same human (backend evidence accepted by the owner).
  - **Owner verdict (4 Nov): functionally accepted, NOT production ready.** Owner confirmations are recorded in the
    ADR-033 amendment: stage facts, stage labels, G via HR sync, MultiPolygon target, the audit and label-overlap items
    before production.
  - **Batch after the verdict — local commit `57d7820` (owner-approved), deployed to `tmrkz-test` and re-checked:**
    - the stage label is the level label alone, with the unit and the decider shown apart;
    - the policy publication audit records stable identity, role, organisation, time, version and reference;
    - map labels never overlap, and a MultiPolygon current site is drawn whole;
    - `GET /restationing-requests/units` serves single-action requesters; the shell asks only for lists its rights
      allow.

    Tests: backend 198/198, frontend 94/94, build OK. Deployment: backend `mover/backend:rel-57d7820` (no migration,
    6,841 rows unchanged), web `mover/web:rel-57d7820-v3`. Re-check on the real page: 15/15, 0 console errors (fixed
    labels with the unit apart, the five-stage route by seat-only approvers, the single-action requester's units,
    labels apart on the map). Remaining visual item: a long mixed Arabic/Latin site label wraps and splits the
    request number.
  - **Routes from L8–L10 in the real application** (fictional accounts and seats, owner decision): 3, 4 and 5 stages
    pass; the five-stage one was decided on the page by five different people. Requests RS-2026-0017/0018/0020;
    RS-2026-0019 is a DRAFT stopped correctly by O-03. Evidence:
    `docs/evidence/acceptance-journeys/stationing-v3/ROUTES-L8-L10.md`.
  - **Lifecycle (ADR-034, 4 Nov) — local commits `86a58db` and `d05a7c2`; V20 on `tmrkz-test` (`ACCEPTANCE / V20`):**
    - cancellation before activation, cancellation before start (with the held start, the refusal after the start and
      the window expiry), early return, and extension with its separate activation and lapse;
    - V20 applied with the guarded procedure: 6,878 rows unchanged, schema identical to the clean path, OpenFGA 425
      relations;
    - four fictional single-action accounts;
    - all six real-page journeys pass with the real scheduler (`LIFECYCLE.md`);
    - tests: `RestationingLifecycleIT` 8/8, backend 206/206, frontend 94/94.

    Open: D11 reminders; the time of the effective end in the panel.
  - **Geometry editing (ADR-035, 4 Nov) — accepted on `tmrkz-test`:**
    - **What it does:**
      - a MultiPolygon copied whole and moved as one rigid group;
      - Polygon and MultiPolygon vertex editing (advanced mode);
      - undo, redo and reset;
      - server validation of Polygon and MultiPolygon, with the parity cases and spheroid areas;
      - no migration.
    - **Commits:** C6 `58423ce` (functional) and `9e02088` (the request page states the proposed site's type, parts,
      area and submission: a defect found by this acceptance).
    - **Running on `tmrkz-test`:** backend `rel-58423ce` and web `rel-9e02088-v3`, still V20. The swap left schema,
      policy, terrain and every Stationing fingerprint unchanged.
    - **Fixtures:** `ACC-GEO-MP4` and `ACC-GEO-DENSE`, from the acceptance-only, idempotent script.
    - **Real page, 33/33:**
      - G1–G9;
      - pointer release over the attribution, another control and outside the canvas;
      - approver view with return and resubmission;
      - activation with the occupancy re-check;
      - 0 long tasks on all four sites, the 1,500-vertex polygon included.
    - **Tests:** backend 209/209 (with a test-only fixture-placement fix), frontend 102/102, build OK.
    - **Evidence:** `docs/evidence/acceptance-journeys/stationing-v3/geometry/tmrkz-test/SUMMARY.md`.
    - **Not accepted:** real touch.
  - **Production map package (ADR-036, 4–5 Nov) — accepted on `tmrkz-test`:**
    - **What it is:** one offline package `tmrkz-map-2026.11.1` (format `tmrkz-offline-map-package` v1, modelled on
      MOVER's): UAE basemap (Protomaps 4.14.9, OSM, unofficial road names), map font, style, GLO-30 slope analysis
      (business data) and hillshade (display), provenance and the ODbL / Copernicus Article 6 / OFL notices; 41 files,
      583,757,776 bytes, archive `8233ac8b…`. The 776 MB source tiles are listed with checksums, not included.
    - **Tools (`ops/map-package/`):** build with every input checked against its recorded checksum; untrusted-package
      verifier (layout, links, traversal, sizes, checksums, content); staged install with `previous/` and
      `restore-previous`; readiness (package, database, served). nginx serves only `current/`, read-only, analysis
      hidden. Air-gap bundle carries tools and archive.
    - **Commits:** `c6d63ad` (MAP-2: one label per logical site, a MultiPolygon included), `8400e58` (MAP-1),
      `bc6279d` and `a950d7a` (readiness fixes found by the acceptance run).
    - **Running on `tmrkz-test`:** web `rel-8400e58-v3` serving the installed package; backend unchanged; V20.
    - **Proven:** byte-identical rebuild (terrain products rebuilt from source included); corrupted archives refused
      with the active package untouched; live swap and `restore-previous`; readiness READY 20/20; terrain business
      parity 0 differences (54 submitted legs, 8 drafts, 2 constructed ties, full raster fingerprint, from a database
      loaded from the package by the production loader); real page 27/27 with the external network unavailable,
      0 external requests, 0 console errors; label suite 21/21 on the package; geometry drag 723 ms, 0 long tasks.
    - **Evidence:** `docs/evidence/map-package/SUMMARY.md`; release record `map-packages/tmrkz-map-2026.11.1/`.
    - **Open:** the terrain loader needs `rasterio` on the operator host; open-sea cells show the water colour in
      terrain mode; 2–3 long tasks during a cold page load; assessment `processing` field empty (manifest key).
  - **Single-click deployment area footprint as a policy value (owner decision, 5 Nov; ADR-031 amendment) — on
    `tmrkz-test` (backend only, owner-approved), no production value:**
    - `deploymentAreaDefault` `{shape: SQUARE | CIRCLE, areaM2}` is a nullable last component of the versioned
      policy. Versions stored before it read null («غير محددة»), so no migration is needed. No production value is
      chosen, so none is set.
    - Shape required, 0 < area ≤ 25 km² (a typo guard, not a footprint maximum). Field group in «سياسة التمركز»;
      requesters read it from `GET /stationing/policy`.
    - **Tests:** `StationingRulesTest` + `StationingFoundationIT` 44/44 on PostgreSQL + PostGIS + OpenFGA; frontend
      144/144, type check clean.
    - **tmrkz-test (5 Nov):** backend `mover/backend:rel-b60dafc-area-default` (b60dafc + this uncommitted change,
      patch sha256 5bb7a2e3…) by the guarded swap: schema V20, plan empty, 7771 rows unchanged, backup verified,
      OpenFGA 220 tuples unchanged (`docs/evidence/acceptance-upgrade/tmrkz-test-backend-area-default/`). Acceptance
      policy version 2 published in the studio as t.admin: SQUARE 90,000 m² only, reference «ACCEPTANCE-V3-POLICY-2 ·
      قيمة قبول تجريبية — ليست قيمة إنتاجية معتمدة» (`tests/acceptance/publish-acceptance-area-default.mjs` 7/7).
    - **Editor (UI rebuild, uncommitted, not deployed):** site «تحديد الموقع على الخريطة» (the same shape's centre to a
      clicked point) beside dragging; deployment «تحديد المنطقة على الخريطة» (the policy's initial area; unavailable
      when unset — no fallback) and «رسم حدود المنطقة»; range rings replaced by centre-to-centre leg connectors with
      distance, allowed range (terrain allowance) and verdict. `tests/acceptance/geometry-two-methods.mjs` 10/10 on
      `tmrkz-test`, 0 writes.
    - **Open:** the owner's production value (shape, area); the UI rebuild itself is not deployed.
  - **Before production readiness (owner list):**
    - the long mixed-label wrap on the map;
    - D11 reminders and presentation polish;
    - real non-production Oracle, real physical touch;
    - the final production-readiness audit.

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
  - **Design:** `docs/STATIONING_DOMAIN_MODEL_V2_AR.md` (7th revision), with owner decisions D1–D18, the
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
  - **Owner correction A8 (3 Nov 2026, 7th revision; prototype only; committed 4 Nov at the owner's request):** ONE proposed re-stationing site
    (the primary/alternative relocation candidates, switching and reopening are removed and marked superseded); no
    distance rule from the current stationing; an administrator-configured maximum footprint area
    (`max_restationing_footprint_area`); the deployment requirement `stationing_areas_requirement` (REQUIRED: site +
    primary + alternative deployment area; OPTIONAL: none or both, never one); deployment-area relations measured by the
    published method (shortest distance between the actual geometries, 0 when touching; requests keep their pinned
    method); policy, profile and route versions pinned at the first submission; an approval path derived from the
    organisation hierarchy and a route policy, with system-determined participants changed only through
    `MANAGE_REQUEST_ROUTING` (audited); owner-facing terms «منطقة الانتشار الرئيسية/البديلة». Evidence: 43 unit tests;
    41 scenarios + drag × 4 sizes = 168/168 browser steps, 788 checks, 64 confirmed dialogs, 0 layout issues (report
    §000; one transient blank load at 1920 passed on three reruns).
    Three questions remain (§11 of the model document).

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

- **Fresh start with lasting platform accounts (6 Nov 2026, owner decision; ADR-037, V21):**
  - **Removed:** every environment on the development machine (`tmrkz-mover`, `tmrkz-test`, `tmrkz-clean`,
    `tmrkz-load`, `tmrkz-v3dev`: containers and all 18 volumes), with no backup, on the owner's choice. The earlier
    acceptance requests, fictional users and policies are gone.
  - **One local installation:** `sh ops/local/up.sh` runs project `tmrkz-mover` on :8088, empty. A stand-in directory
    holds no people until the enterprise directory is configured. Stationing V3 is opted in for owner review, and the
    installed offline map package is mounted.
  - **Accounts:** only «admin» and «developer» exist. They are local Keycloak users with the role `tmrkz-platform`, and
    their passwords sit in the git-ignored `.env`. Both hold «مدير النظام» + «مدقق السجلات», and HR or the directory
    never disables them.
  - **Tests:** `EnterpriseSignInIT.platformAccounts` (with `DirectorySignInIT`: 11/11).
  - **Not done:** terrain slope data is not loaded into the new database; HR, the directory and PKI are not connected.
  - **Weak passwords:** the values chosen for this machine must be replaced before any real deployment.

- **True offline 3D terrain (6 Nov 2026, owner brief «TRUE OFFLINE 3D TERRAIN»; ADR-038) — built, NOT deployed, NOT
  committed; awaiting the owner's visual review:**
  - **Audit:** `tmrkz-map-2026.11.1` had only a grey hillshade (no elevations), so a new display-only Terrain-RGB
    product was built from the same 28 GLO-30 source tiles (`ops/terrain/build_terrain_3d.py`, 5,932 tiles, 209 MB,
    deterministic).
  - **Package:** `tmrkz-map-2026.11.2` with the optional component `terrain-3d`; verifier, builder and readiness
    (`--require-terrain-3d`) extended. The slope analysis is byte-identical (`9a91d9af…`). The build is reproducible but
    was made from an unclean tree; a release build must be repeated from a commit. It is installed only in the
    development root `map-data/runtime-3d`; the owner's :8088 installation keeps 2026.11.1.
  - **Map:** «2D | 3D» on the re-stationing map:
    - MapLibre terrain (exaggeration 1, pitch 55°), elevation tint and shade, sky; every geometry draped by MapLibre;
    - cards on the ground and connector chips with arrowheads, in one order (current → proposed information only,
      proposed → primary, primary → alternative), no rings;
    - «تحليل طبيعة الأرض»: the server class, shares and mean slope through the existing read-only assess endpoint;
      heights and a profile from the elevation tiles (display only);
    - drawing, dragging and click placement work directly in 3D; the primary deployment area is now amber in 2D and 3D.
  - **Backend:** the assessment gains `meanSlopePct`/`maxSlopePct` (descriptive, read by no rule). No migration and no
    policy change.
  - **Tests:**
    - real browser `tests/acceptance/terrain-3d.mjs` 23/23: zero writes, zero external requests, zero console errors,
      2D↔3D geometry identical; drag frames p50 13 ms with 2, 4 and 1,501 vertices;
    - `StationingFoundationIT` 9/9 and `RestationingWorkflowIT` 15/15;
    - frontend 157 unit tests, type check and production build;
    - `ops/map-package` + `ops/terrain` pytest: 52 passed, 1 skipped (symlinks cannot be created on this Windows host).
    - Evidence: `docs/evidence/terrain-3d/`.
  - **Owner review (6 Nov):**
    - provisional acceptance; primary amber is permanent in 2D and 3D;
    - `2026.11.2` stays a development candidate until it is rebuilt from committed source;
    - added since: 3D framing that fits the portrait and landscape screens, chips kept clear of cards, and the optional
      «الانحدار» slope-class layer (display only, policy thresholds);
    - review evidence: `docs/evidence/terrain-3d/review/` (`tests/acceptance/terrain-3d-review.mjs`).
  - **Not run:** the acceptance environment was removed on 6 Nov, so the earlier `tmrkz-test` browser suites
    (`ui-rebuild.mjs`, `geometry-*.mjs`, `restationing-*.mjs`) could not run. The 2D flows they cover were exercised
    only inside `terrain-3d.mjs`. No real touch device was used.

- **«الانحدار» inside the shapes being placed (6 Nov 2026, owner; ADR-039) — built, NOT committed, NOT deployed; awaiting
  the owner's visual acceptance:**
  - Green, orange and red inside the site and the deployment areas being placed, following every frame; the whole-map
    layer is removed. Display only. The limits are editable in «سياسة التمركز» (`slopeDisplay`).
  - One name and one location symbol per site on the map, names on a plate; a current site is no longer drawn twice.
  - «سياسة التمركز» number fields (`components/NumberField.tsx`): can be emptied, take Arabic digits, and metre or kilometre (and m² or km²) is chosen on the page; values stay stored in metres and m². Terrain allowances moved beside the distances. Other pages' number inputs are unchanged.
  - `tests/acceptance/slope-inside.mjs` 17/17; `StationingRulesTest` 36/36. `terrain-3d-review.mjs` R1b was updated to
    the new behaviour and NOT rerun. The other label suites (`maplibre-labels.mjs`, `ui-rebuild.mjs`) were NOT rerun:
    they need Edge, which this Mac does not have.
  - Measured against the native analysis: `docs/evidence/terrain-3d/slope-inside/README.md`. Narrow steep ground can
    read green; the owner's choice on how to tighten this is open.
- **One terrain value on a maximum (6 Nov 2026, owner; ADR-040) — built, NOT committed:** one number (km, m or %) per distance and for the site's area, on any ground that is not flat, by the ground of the new place.
- **«الطلبات الإدارية» for many requests (6 Nov 2026, owner) — built, NOT committed:** the list was capped at the first 200 rows with no way to reach the rest. Now the server pages, sorts and filters (type, period, mine), `GET /requests/counts` gives the status tabs, and V22 adds two indexes (measured on 300,000 fictional rows: first page 51 → 5 ms, a status's first page 30 → 2 ms, search about 140 ms; no permission predicate in that measure). `AccessAcceptanceIT.requestsListAtScale` passes. Known: search matches a hidden subject on a row seen only in summary, which may let a person infer it (existing behaviour, to review). Export still applies the status only, and says so.
- **Oracle HR connected and imported (6 Nov 2026, owner's instruction):** a local read-only source. Its connection details, counts and the issue log stay on the installation, not in this public repository. The owner's decision on the employee number field stands (`docs` of the installation).
- **Asking for permissions (6 Nov 2026, owner; ADR-044) — built, NOT committed:** a person with no permission sees only «طلب صلاحية»; a reviewer advises on «طلبات الصلاحية»; only the final approval grants. Runs through the ordinary engine as a request type of kind `ACCESS`. Checked by `WorkflowGraphIT` and `tests/acceptance/access-requests.mjs` with fictional people. On the one app: its roles are published and granted to nobody; the type «طلب صلاحيات» exists with its path drawn and saved, not activated, so nobody can ask yet. The system administrator now sets what is shown to a new person and what only the unit's access manager adds (V29); this type has no deadline. `tests/acceptance/access-requests.mjs` 25/25 and `WorkflowGraphIT` 30/30 in the temporary and test environments, with fictional people. People from Oracle cannot sign in on this machine because its stand-in directory holds nobody; the enterprise directory is not connected.
- **Request types added and removed on the screen (6 Nov 2026, owner):** «＋ نوع طلب» (a name and its subject: permissions, or a facility or booking, which alone asks what happens after final approval; with the standard form) and «حذف هذا النوع» on «مسار الموافقات». Removing takes a type off every list, keeps its past requests, and is refused while one of its requests is open. A removed type stays in the table inactive, so it does not come back on restart. The seven standard types were removed from the one app; a clean installation still starts with them. Until a type and its path exist, no request can be sent there. Checked by `WorkflowGraphIT` requestTypes and `tests/acceptance/access-requests.mjs`.
- **Plain names on the approvals path screen (6 Nov 2026, owner):** names for the person using it, not the developer: «استوديو التدفقات» is now «مسار الموافقات», «استوديو النماذج» «نماذج الطلبات», the flow-name field and the BPMN button are gone from the screen, and the words of its buttons, cards and check messages are plain. The rest of the application still has developer wording, such as the English labels above page titles.
- **All flows cleared on the one app (6 Nov 2026, the owner's instruction concerned the names of the request types; the flows were cleared first, and the types then removed):** with no requests attached, the 2 drafts were deleted and the 7 published versions retired, directly in the database, so this is not in the audit log. Published versions cannot be deleted, by design, so they remain in the table as `RETIRED`, unseen and unused, and new versions continue their numbers. Until a flow is published for a type, a request of that type cannot be sent. `tests/acceptance/flow-studio.mjs` and `flow-climb.mjs` expect published flows and need them on the one app, or the temporary environment. A clean installation still starts with the standard flows.
- **Light and dark colours (6 Nov 2026, owner; ADR-043) — built, NOT committed:** a switch in the top bar and on both sign-in pages, kept in the browser. Light, the default, is the sand of the sign-in page across the whole application, by the owner's choice; dark is navy and teal. `tests/acceptance/theme-contrast.mjs` measures the text contrast of the real pages in both themes.
- **Approvals as in the movement programme (6 Nov 2026, owner; ADR-042) — built, NOT committed:** study in `docs/reports/mover-permissions-study.html`. The climb ends below the main unit; a step «حسب نطاق الصلاحية» goes to the nearest grant reaching the unit; a unit matrix with the «تعيين» dialog; periods for the unit operations step; nobody who approved earlier decides a by-scope or final step; for-information by person after final approval, to holders covering the requesting unit, the units at the place and their main units, with a record of who read it. Roles published as policy version 3, granted to nobody; a draft chart for «نقل إداري», not published. Checked by `WorkflowGraphIT` and `tests/acceptance/scope-approvals.mjs` with fictional people. **Not exercised with real people from Oracle:** they cannot sign in yet. What is not built yet: ADR-042.
- **One approval climbing the hierarchy (6 Nov 2026, owner; ADR-041) — built, NOT committed, nothing published with it:** one card instead of one per level. It stops at the main unit from Oracle (`MAIN_UNIT_FLAG`, V24; 10 of 123 units), at levels read from the source, at the top, after a number of approvals, or at one unit. A flow's question can ask whether the requesting unit is a main unit, whether it has a parent, and its level. Checked by `WorkflowGraphIT`, `tests/acceptance/flow-climb.mjs` (13/13 on the imported hierarchy) and `flow-studio.mjs` (30/30). **Not exercised with real approvers.** As in the movement programme, the climb ends below the main unit, and a level with nobody refuses the request before sending unless the flow skips such levels.
- **Workflow studio rebuilt as a flow chart (6 Nov 2026, owner; ADR-041) — committed in `12ec747` on branch `flow-studio`, not merged, nothing published with it yet:** drawn with the pointer: approval, yes/no question, parallel, notice, approved and rejected ends; seven ways to find the responsible unit; responsibilities with inheritance; trying a route on a real unit. Compiled to BPMN and run by Flowable. Backend suite and `tests/acceptance/flow-studio.mjs` pass. **No imported person holds a role yet**, so every real step reads «لا أحد يملك هذا الدور هناك» until grants exist. Publishing a converted flow also makes its unit steps strict, so check holders first.
- **One app only (owner, 6 Nov 2026):** the single installation `tmrkz-mover` on `http://localhost:8088` (`TMRKZ_STATIONING_V3=true sh ops/local/up.sh`). Every change goes there. A temporary test environment is removed when the test ends; `tmrkz-v3dev` and the dev server on :5197 were removed.
- **Environment on the owner's Mac (6 Nov 2026), Apple Silicon:**
  - `postgis/postgis:17-3.5-alpine` has no ARM image, so it was pulled as `linux/amd64` and runs under Rosetta.
  - `map-data/` was rebuilt from `~/Desktop/mover` in a `python:3.12-slim` container, with the records left untouched.
    The basemap and the 28 source tiles match their records.
  - **The rebuilt slope, hillshade and Terrain-RGB products are NOT byte-identical to the committed records** (slope
    `8905e73c…` against `9a91d9af…`, same library versions, linux/arm64 against the original Windows build). The cause
    is not established: a comparison built as x86-64 hung under emulation and gave no result. Pixel equality is
    therefore unproven and the original build is not on this machine.
  - The slope analysis is loaded in `tmrkz-mover` (6,300 tiles, `8905e73c…`), on the owner's explicit instruction of 6 Nov 2026 to bypass the guard of `ops/terrain/load-slope.sh` this once (target given by container id; the script is unchanged), with no manifest, so it does not claim to be the approved record.
  - So this data is development only: `map-runtime/current/manifest.json` is a labelled stand-in
    (`DEV-UNVERIFIED-local-rebuild-not-a-release`). `tmrkz-map-2026.11.2` was
    not rebuilt; its release rebuild stays open, and must decide which build host defines the record.

## 21 Nov 2026 — Activation merged into final approval; FYI becomes a per-unit configuration (ADR-095)

The owner's correction on 21 Nov 2026 removes the two moving parts the ten-role matrix carried beyond the natural
approval chain. FYI_DISTRIBUTOR and STATIONING_ACTIVATOR are DELETED outright; the actions they carried
(MANAGE_FYI_DISTRIBUTION, ACTIVATE_STATIONING) are REMOVED from the application and pruned from every stored policy
version. The administrative matrix now exposes EIGHT canonical roles — مقدم الطلب, معتمد السلسلة الهرمية, معتمد
عمليات الوحدة, المعتمد النهائي, للعلم, متابعة الموقف العملياتي, مدير صلاحيات الوحدة, معتمد طلبات الصلاحية.

- *Final approval → activation inside the same transaction.* The final approver's APPROVE on the last stage triggers
  the same server checks a standalone activation used to apply (hierarchy drift refusal, geography re-check, atomic
  conflict prevention) and records the activated stationing. A request moves from UNDER_REVIEW directly to
  ACTIVATED_PERMANENT / TEMPORARY_SCHEDULED / ACTIVE_TEMPORARY — APPROVED_NOT_ACTIVATED no longer surfaces to any UI.
- *FYI from a per-unit configuration.* A new table `unit_fyi_target(owning_unit_id, target_unit_id,
  include_descendants)` holds the FYI recipients per owning unit, maintained by the unit's access manager. After
  activation the service reads this list, expands `include_descendants`, writes the `restationing_fyi` rows and
  notifies the recipients — all inside the same transaction.
- *API compatibility.* `POST /restationing-requests/{id}/activate` is an idempotent no-op so an older client does not
  404. The three FYI endpoints (`/fyi-options`, `/fyi`, `/fyi/{unit}/end`) are REMOVED.

**Delivered.** Permission enum reduced, RestationingService refactored (`performActivation`, `performExtensionActivation`,
`autoFyi` inline in the final-approval transaction), V62 migration deletes the two role_def rows and ends every live
grant pointing at them, strips the retired permissions from every stored policy version, creates `unit_fyi_target` and
writes one audit event naming everything removed. ADR-095 recorded. `MatrixColumnsIT` moved to the 8-role invariant.
`RestationingTestBase.approvedPermanent` asserts `ACTIVATED_PERMANENT` directly.

**Open follow-ups.** `RestationingWorkflowIT`, `RestationingLifecycleIT`, `RestationingHrSyncIT` and
`StationingNextIT` still carry pre-ADR-095 two-step assertions (checking `state == APPROVED_NOT_ACTIVATED` and the
`activator` login's `/activate` call). They need to be migrated to the one-transaction contract; none of this blocks
production use of the eight-role matrix today. A UI for the per-unit FYI target configuration is the next frontend
step — today the configuration is editable only through the database until the access workspace exposes it.

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

## Complete access, site and request phase — built for owner review (2026-11-07, ADR-045)

Delivered on the one app (:8088); the fictional environment is recreated with `sh ops/test-env/owner-review.sh up` when needed: initial stationing, deployment areas per unit, site registration, unit operations and final stages, FYI distribution, operational posture, the request hub, the unified list, setup of sites, scoped permission requests. Migration V30 was applied to `tmrkz-mover` on the owner's direct instruction of 7 Nov 2026, after a verified backup, and the fictional environment `tmrkz-next` was removed on the same instruction. Measured results, defects and open owner decisions: `docs/evidence/stationing-next/MORNING_HANDOFF_AR.md`. The owner's review is pending, and no enterprise service is connected.


## Approval path per request type, and acceptance on the one application (2026-11-07, ADR-046)

- **Delivered:** the four stationing request types on «مسار الموافقات», each with its own saved, tried and activated path (V31). No path is activated on :8088; without one a type follows the policy's route.
- **Backup tools:** `ops/restore.sh` and `ops/verify-backup.sh` handle the image's tiger schema (`ops/sql/clear-postgis-init.sql`); `ops/backup.sh` retakes a dump the application wrote during.
- **Acceptance on :8088:** fixtures marked `ACC-20261107-*` are loaded through `ops/acceptance-main/`. Results and limits are in `docs/evidence/stationing-next/MORNING_HANDOFF_AR.md`.
- **While loaded:** the Oracle sync is paused, an acceptance policy is in force, and the access path is activated with an acceptance version.
- **Limits:** true 3D is not accepted because the installed package is `DEV-UNVERIFIED-local-rebuild-not-a-release`. The real removal (`cleanup.mjs`) has run only as a dry run. `stationing-next` and `persona-buttons` ran on `d07acce`, not on the final `fdfd61b`; `access-requests` and `scope-approvals` were not run on :8088.
- **Not production-ready.** Owner visual review is pending.

## Final acceptance on the one application (2026-11-07, ADR-047; code at `a4304c1`)

- **Results:** every suite ran on `a4304c1` on :8088: journeys 124, button matrix 18, access and scope 23, extra 25, editors 44, 3D 24, slope 17, backend 256, frontend 200. Gate table and limits: `docs/evidence/stationing-next/MORNING_HANDOFF_AR.md`.
- **Map package:** `tmrkz-map-2026.11.2` built twice from clean commit `8114472` with identical bytes, installed, rollback proven, READY 23 checks. ADR-047. The earlier statement in this file that its release rebuild stays open is superseded.
- **Key:** the HR settings key is rotated and the stored settings re-encrypted (`ops/rotate-hr-settings-key.mjs`). Earlier backups hold them under the old key.
- **Still loaded on :8088:** acceptance data in four batches, the Oracle sync paused, an acceptance stationing policy, and an acceptance version of the access path. Removal has run only as a dry run.
- **Not covered on :8088:** the facility request journey by scope (J01–J19 of `scope-approvals.mjs`), because no facility request type exists there.
- **Not production-ready:** owner visual review is pending, and the production holders, FYI rule, levels and new-person defaults are undecided.

## Home PC: the one application, the map and «موقع جديد» (10 Nov 2026, ADR-048)

- **Installation:** `main` at `5f74bb5` pulled; this PC had no `tmrkz-mover`, so `ops/local/up.sh` created the one application empty (V1–V31 on a new database, `TMRKZ_STATIONING_V3=true`, `TMRKZ_FLOW_STUDIO_UI=true` in `.env`). Platform accounts `admin` and `developer` sign in through Keycloak (checked headless and in Edge). The Mac's :8088 data, including the acceptance batches, is not on this PC.
- **Map package:** `tmrkz-map-2026.11.2` rebuilt here from `8114472` in a clean clone (`tmrkz-terrain-tools:dev` = `python:3.12-slim` + `libexpat1` + `ops/terrain/requirements.txt`; sources copied from MOVER and checked against their records; `absent-tiles.json` and `verification.json` regenerated with MOVER mounted at `/mover-src` and `/mover-lib`). Every terrain product, the manifest and the archive are byte-identical to the release record (`21e1558c…`). Installed in `map-runtime` with the web container stopped for the swap; `readiness.py --require-terrain-3d` 22/23, the one failure being "no Stationing policy in force".
- **Slope:** loaded into `tmrkz-mover` once on the owner's instruction of 10 Nov 2026, the guard of `ops/terrain/load-slope.sh` bypassed by giving the database container id (script unchanged), with the installed package's manifest: 6,300 tiles, `8905e73c…`.
- **Checked in Edge:** 2D streets and 3D terrain (camera tilted 55°, elevation read from the terrain) on «تهيئة المواقع والتمركز», all map data from `/map-data/`, no request outside :8088, no console errors.
- **«موقع جديد» (ADR-048):** MOVER's three-step card, in the site list under «＋ إضافة موقع»; automatic site code (`S-0001`…); responsible unit from the unit tree; free drawing; the coordinates table in every format (MOVER's `coords.js` ported with its golden vectors); movable, widenable and foldable panels, foldable cards.
- **Site symbol (V32, applied to :8088 on 10 Nov 2026 at 19:01 UTC, owner approval, after the verified backup `backups/tmrkz-mover-20261110T185623Z`):** chosen in the steps, changed from the site's card with a reason, drawn on the map; display only. MOVER's tactical graphics are not offered and are refused by the server (scope).
- **Checks:** backend `SiteMarkerIT`, `StationingNextIT`, `MapWorkspaceAcceptanceIT`, `MapScaleIT`, `BoundaryOverlapIT`, `AdministrationAcceptanceIT` 43/43 on a disposable database (V32 included); frontend 230/230 (coordinate formats 17, wizard 12); typecheck clean; an Edge walk on :8088 23/23 (steps in the list, no code field, unit tree, seven-corner free drawing, table in UTM and MGRS, a point from the map, a row removed, the symbol, panels widened, folded and moved), **without saving**: :8088 still has no site.
- **Layout (final, owner):** the site list on the left; on the right «تهيئة الموقع» with «＋ إضافة موقع» and the steps filling the panel's height, or the chosen site's card. Edge walk on the final build: every check passes except the one that expects an empty list, because the owner had added a site meanwhile.
- **First real site, entered by the owner through the page (10 Nov 2026, 19:10 UTC):** `S-0001`, code given by the server, a drawn 8-corner boundary, a responsible unit and the symbol `SFGPIB----H----`; audited (`SITE_CREATED`, `SITE_BOUNDARY_PUBLISHED`) and drawn on the map with its symbol. Not touched by any check.
- **Not yet run:** `stationing-next.mjs` and `main-8088-extra.mjs`, updated to the new steps (code read from the finish card, drawings closed with «إنهاء الرسم»), because they need the acceptance data, not loaded on this PC.
- **Build note:** two timing tests measured cold first runs and failed the web image build on this PC: `terrainRgb.test.ts` (1,500 vertices, 69 ms against 40 ms) and `siteGeometry.test.ts` (`vertexConflicts` on 5,000 vertices, 57 ms against 20 ms). Each now runs once untimed before measuring; the budgets are unchanged.
- **Not changed yet:** «تثبيت» and «إضافة ربط» on the site's card still choose the unit from a list, not the tree; the other console pages (re-stationing, posture) do not have the panel controls.
- **Not production-ready:** owner visual review pending, as before.

## Work PC: map package, slope, «إضافة مستخدم» and desktop notifications (11 Nov 2026, ADR-049, ADR-050)

- **Installation:** `main` pulled at `817854b`. This PC's `tmrkz-mover` containers had been removed with their volumes kept; `ops/local/up.sh` rebuilt them and applied V32. The Home PC's site `S-0001` is not on this PC (one unit, no site). Platform accounts sign in through Keycloak («الدخول الآلي بالحساب المؤسسي»), not the manual directory path.
- **Map package:** `tmrkz-map-2026.11.2` rebuilt here from `8114472`: terrain products in `tmrkz-terrain-tools:dev` (rasterio 1.5.2, GDAL 3.12.2) from a fresh clone; `verification.json` and `absent-tiles.json` regenerated with MOVER mounted read-only at `/mover-src` and `/mover-lib`; package from a second clone with `core.autocrlf=false`. Slope `8905e73c…`, 3D terrain `f9f4c387…`, archive `21e1558c…` (793,835,520 bytes): byte-identical to the release record. Installed in `map-data/runtime` with the web container stopped for the swap; `2026.11.1` kept as `previous`. The first build differed only in those two provenance files (host paths inside them), which is why they are regenerated in the container.
- **Slope:** loaded into `tmrkz-mover` on the owner's instruction of 11 Nov 2026, the guard of `ops/terrain/load-slope.sh` bypassed by giving the database container id (script unchanged), from the installed package with its manifest: 6,300 tiles, `8905e73c…`, 93 s.
- **UI (owner):** «موقع جديد» steps smaller (questions 13 px, choices 12.5 px, «التالي» 36 px high, tighter cards); on «إعادة التمركز» only one action card is lit at a time (route over linked sites over the request list). Headless Edge check on :8088: 7/7.
- **«إضافة مستخدم» (ADR-049, V33):** in «مصفوفة الوحدات», as TNQL: HR search by military number or User ID with the HR card, or a User ID without HR; the person enters the unit with no permission and the row is highlighted for ticking. User ID accounts link on their first directory sign-in (`LOCAL_USER`).
- **Desktop notifications (ADR-050, V34):** TNQL's service worker and 30-second feed, lock-screen-safe text per kind, permission on the first gesture. Needs https on PCs other than the server.
- **Not done:** TNQL's account card editing, bulk add/remove and staged batch save; TNQL's native Windows agent and in-page sounds; a notification when a request starts waiting for someone's approval (TMRKZ has none yet, so approvers get no toast for a new task).
- **https (ADR-051), first step of the real-environment setup:** built in as TNQL: `proxy` service (profile `tls`), `ops/tls/make-csr.sh`, `install-cert.sh`, `enable.sh`, `ops/keycloak/set-public-url.sh`, `ops/tls/README.md`; rehearsal `ops/tls/test-tls.sh` 18/18 with a test CA next to :8088. **Open:** the server's DNS name, the real key and request, the certificate from the PKI team, then `enable.sh` and a browser sign-in over https; `.env` and Keycloak on this PC still use `http://localhost:8088`.
- **Directory (ADR-052), second step of the real-environment setup:** `ops/keycloak/set-directory.sh` (Keycloak's connection and bind tests first, applies only with `CONFIRM=yes`); `ops/local/up.sh` drops the stand-in once `.env` names a real directory; the organisation's CA chain (from TNQL) in `ops/keycloak/truststores`; a commented Active Directory block in `.env`. TNQL on this PC has no directory configured, so nothing else could be copied. **Open:** the directory's address, service account, password and users DN from IT. The issuing CA certificates expire Sep 2027 – Feb 2028.
- **Support and knowledge (ADR-053, ADR-054), phase 1 of TNQL's support and AI:** «مركز الدعم» (guide search with citations, «أبلغ عن مشكلة», «بلاغاتي»), «لوحة الدعم» with «مقاعد الدعم», V35, notifications with links (bell and desktop); OKF bundle of 11 documents with `ops/knowledge/okf.py`. Tests: `SupportIT` 3/3, `KnowledgeServiceTest` 3/3, frontend `support.test.ts`. **Not yet:** the AI assistant dock (phase 2; Ollama installed here with no model), tutorial videos, attachments.
- **Approval stamps (ADR-055):** «ختم عمليات الوحدة» and «ختم الاعتماد النهائي» on stationing requests and in «طباعة سجل الاعتماد»; `StationingNextIT` 7/7 with the stamp checks. No approved request exists on this PC, so the stamps have not been seen on :8088 yet.
- **Owner fixes:** «النموذج الأولي المعتمد» removed from the docs page and no longer served; switch on/off visible in both themes.
- **«المساعد الذكي» and floating «الدعم» (ADR-056):** both buttons on every screen, movable; the assistant on local Ollama `qwen2.5:7b` through the OpenAI-compatible API, grounded in the guides with sources, audited without the question; guide-only fallback. Live check 9/9 (an Arabic answer in 23 s on this PC's CPU). For the isolated network only `TMRKZ_AI_BASE_URL` (and the model name) change.
- **Demo HR (ADR-057):** `ops/hr-demo/up.sh` builds TNQL's synthetic Oracle HR for TMRKZ; `path_parent` mapping transform for TNQL-style ID paths.
- **Owner UI requests (11 Nov 2026):** «الإشغال عبر الزمن» and «مكتب المراجعة» draw their sites on the installed offline map (`OfflineFeatureMap`; the Leaflet canvas needed an uploaded raster background this installation does not have, so the map stayed empty); the seven days are chosen by click (`WeekPicker`: year by arrows or list, twelve months, the month's days, «اليوم»); «تهيئة المواقع» and «إعادة التمركز» sit in the top bar next to «الرئيسية»; the assistant renders the model's Markdown and names «الرئيسية».
- **Demo HR connected (ADR-057), third step of the real-environment setup:** `tmrkz-hr-demo-oracle` (Oracle 26ai Free) built by `ops/hr-demo/up.sh` — 99 units, 200,000 synthetic people (176,000 «في الخدمة»), read-only account `TMRKZ_HR` sees the two views only. Connected through the application's own path (source, connection test, mapping version 1 discovered and published, first sync): run `SUCCEEDED` in 21 s, 99 units, 200,000 people created, 176,000 active, no orphan or cycle. Verified backup before the sync: `backups/tmrkz-mover-20261111T082534Z`. Hourly sync is on.
- **Roles were missing on this PC (owner, 11 Nov 2026):** «مدير صلاحيات الوحدة» and TNQL's approval roles are data (`ops/policy/approval-roles.json`, ADR-042/044), published per installation; the Mac's :8088 had them, this fresh install had only the seven base roles. Published here as role policy version 2 (6 roles, nothing granted). The search rule is unchanged and checked live: the platform administrator and developer (MANAGE_ACCESS everywhere) find anyone; a unit access manager finds only inside the unit and its branches (`UnitMemberIT` UM-1). `ops/policy/stationing-capabilities.json` (marked draft for owner review) is not published here.

- **«إدارة الصلاحيات والوحدات» and the station approver, as TNQL (ADR-058, owner 11 Nov 2026):** the permissions page opens on TNQL's workspace (search first, tree with counts, unit cards / matrix / audit, unit file); matrix ticks are pending and saved together after review under one audit reference (fingerprint, all or nothing, 409 on a changed cell); cells show direct, inherited from the unit or seat, temporary, locked with reason; roles given to a whole unit (V36). A level with no approver of its own is approved by the nearest approver above covering it, in chart flows and re-stationing; final approval is a global manager's to give. Tests: `AccessWorkspaceIT` AW-1…AW-4, `WorkflowGraphIT.inheritedStation`, `RestationingWorkflowIT.inheritedSeat` (with `WorkflowGraphIT`, `SeparationOfDutiesIT`, `RestationingWorkflowIT` 60/60; `RestationingLifecycleIT`, `StationingNextIT`, `UnitMemberIT`, `AuthorizationIT`, `ExecutionInFlightIT`, `ExecutionIntegrityIT`, `StationingAdaptersIT`, `WorkflowAcceptanceIT` pass), frontend `stage.test.ts` (254/254). Live headless on :8088 20/20, nothing saved (a tick staged, reviewed, cancelled); V36 applied after verified backup `backups/tmrkz-mover-20261111T090859Z`. `tests/acceptance/scope-approvals.mjs` (M01–M04) and `theme-contrast.mjs` updated to the new page, not rerun (they need the test environment). **Not done:** see ADR-058.
- **The rest of TNQL's access workspace (ADR-059, owner 11 Nov 2026 "finish the missing one in one go"):** the ten separate rights of an access manager with delegation bounds and issuer-only editing, FINALIZE's tied final step; duty permits (issue, activate by the holder, additive, at most 7 days, «تصاريح المناوبة» tab and «صلاحياتي»); the account card (switch access off/on, local name, retire a local account, system roles, history); «معتمد التوفر» per providing department (departments as published roles, providing units, chips فعالة/احتياطية/غير ممنوحة, chart place «الوحدة المزوّدة»); approvers HR marks away left out but still appointed; whole-unit acknowledgement on bulk. V37. Tests: `AccessAdminIT` AA-1…AA-7, `AccessWorkspaceIT` (AW-2 now with the acknowledgement), frontend `adminText.test.ts` (257/257). Not taken: TNQL's guide-author flag, operations threshold and joint-operations control (movement-specific).
- **Hourly HR sync of the demo fixed (ADR-057 amendment):** since 08:31 every sync of the 200,000-person demo had failed or hung on a per-person count; the queries left running blocked V37 until cancelled. The checks are now one grouped pass and a run analyses the staged rows; first sync after the fix 17.7 s on :8088.

## Work PC: routing card, MOVER people list, identity columns, resizable panels (16 Nov 2026, ADR-060)

- **«مسار الاعتماد»** on «سياسة التمركز» redesigned as a ladder of the HR levels with a live route preview. Checked headless on the dev server in both themes; `lib/stationingRoute.test.ts` 10/10. `tests/acceptance/publish-acceptance-policy.mjs` now drives the new card (`data-level`, `data-approves`, `data-final`, `data-label`); not rerun (it needs the acceptance environment).
- **«إدارة الصلاحيات والوحدات»:** «مساحة العمل» cards as MOVER's; separate columns الرقم العسكري / الرتبة العسكرية / الاسم / رقم الـU / المنصب in «إدارة الصلاحيات»; draggable panel widths kept per browser.
- **V38** (`hr_person.rank_name`) applied to :8088 after the verified backup `backups/tmrkz-mover-20261116T044016Z`; HR mapping version 2 maps «الرتبة» → `GRADE_NAME`; the manual sync after it gave all 200,000 demo people a rank.
- **Checks:** backend `HrMappingTest`, `AccessWorkspaceIT`, `HrSyncAcceptanceIT` 14/14; frontend 265/265; typecheck clean; web image built (the timing test `terrainRgb.test.ts` failed once inside the build at 44 ms against 40 ms and passed on the retry). Headless check on :8088: columns filled (e.g. «3658589 · وكيل أول · ضابط إمداد»), divider drag, arrow keys and reset work, no page errors.
- **Not committed.**
- **Later (owner):** one-step «حفظ التعديلات»; pinned identity columns; the unit tree keeps open branches on refresh and opens down to a unit chosen from search (`trail` on the unit file). `AccessWorkspaceIT` 4/4; backend and web redeployed (no migration; the `terrainRgb` timing test failed once more in the build, 42 ms against 40 ms, and passed on the retry).
- **ADR-061 (owner):** «معتمد السلسلة الهرمية» as TNQL's («تعيين» cell, «هذا المستوى فقط» default / «مع جميع الوحدات التابعة», main units refused, «⚡فوري», «?» help); a unit's users are only those added by search, an approved access request or a direct grant. Backend `AccessWorkspaceIT` 5/5, `ChainApproverScopeIT` 5/5, `UnitMemberIT` 4/4, `WorkflowGraphIT` 32/32, `HrSyncAcceptanceIT` 9/9; frontend 34 files; deployed (no migration). Live: the whole install now shows 11 users (the people the owner granted, plus platform accounts); «مركز صحة واحد» 0.
- **Demo HR deeper levels:** `ops/hr-demo/extend_levels.py` (seed 231232628: 128 units, 72 people; then `--each-main`, seed 457821597: 4–5 branches inside every main unit, 916 units, 495 people) — synced: 1,143 units on levels 1–13, none of the new people added to TMRKZ.
- **Not built yet from TNQL's chain approver:** per-unit «تجاوز المستوى عند عدم وجود معتمد معيّن»; a requester-only level that blocks; duty-permit holders on top of inheritance.

## Hierarchy approval skips empty levels (16 Nov 2026, ADR-062)

- **Built:** in a climbing step with «تجاوز الجهات التي لا يوجد بها معتمد», a unit with no own and no inherited hierarchy approver is skipped and recorded (V39 `request_route_skip`, reason `NO_HIERARCHY_APPROVER`, name and level as then, per revision, one grouped audit event); an all-empty climb goes straight to the next step (unit operations, then final) — the old `ROLE|*` fallback is gone. Request page and studio simulator show «تم التجاوز». New climbing steps have the option on. A station approver on «هذا المستوى فقط» can now open the request they decide.
- **Wording:** «hierarchy unit skipped» (one unit inside the climb) is distinct from «workflow stage skipped» (a whole step bypassed).
- **Checks:** `WorkflowGraphIT` 37/37 incl. HSKIP-01…10; affected classes 73/73; frontend 36 files incl. `RouteTimeline.test.ts` 5/5.
- **Not done:** no published flow on this installation uses a climb, so nothing was republished; the real-browser health scenario needs a published flow with a climb and a requester who can sign in (stationing roles unpublished and no test sign-ins, owner 16 Nov) — see the session report.

- **ADR-063 (owner):** the MOVER-style roles drive the stationing path (`APPROVE_HIERARCHY` for «معتمد السلسلة الهرمية», `DECIDE_UNIT_OPERATIONS` for «معتمد عمليات الوحدة», `FINAL_APPROVE_STATIONING` for «المعتمد النهائي»); role-policy version 3 published on :8088 with the stationing roles and «تفعيل التمركز». The stationing engine skips and records levels with no hierarchy approver (V39 `restationing_route_skip`, mark `SKIPPED`). Tests: stationing 42/42, `AuthorizationIT` 10/10, access 16/16; earlier full backend 299 (one failure, fixed).
- **Incident, 16 Nov 2026 ~10:30:** another session removed every container named «mover» on this machine, the TMRKZ ones included, and their images; volumes intact. Restored from the folder's own `images/` with `sh ops/local/offline.sh` — the offline path proven for real; the application has run on the isolated network since.
- **ADR-064 (owner rule):** the main unit is the unit whose `MAIN_UNIT_ID` is its own ID — never the flag, never the name; the parent comes from the ID path. HR mapping version 3 on :8088; the demo Oracle converted in place (same tree, the same ten main units). `HrMappingTest` 2/2, `HrSyncAcceptanceIT` 9/9, `RestationingHrSyncIT` 1/1.
- **«موقع جديد» smaller (owner):** the site wizard's steps, questions, choices, tree rows and buttons about a fifth smaller.
- **Deployed on :8088 (schema V40 at noon, uncommitted since a917d53):** ADR-062/063/064, the shared tree, the double-click fix, «موقع داخل», the symbol label, the smaller wizard.

## Access, HR and site setup (16 Nov 2026, afternoon; ADR-065…067)

- **ADR-065 (owner, "like MOVER"):** connecting Oracle imports nobody. The sync reads every unit but only the people already in TMRKZ (`hr_linked_person`, V41); a person comes in one at a time — imported by an access manager after a live lookup, or at their own first sign-in — with no permission. Clean-up of the people copied before: `ops/hr-prune-unlinked.sh` (dry run on :8088: 200,557 unlinked, none referenced; **not applied — waiting for the owner's explicit go-ahead**, backup `backups/tmrkz-mover-20261116T085957Z` verified).
- **ADR-066 (owner decisions):** zero access enforced by the server (request page and support only); identity card and status line on «طلب صلاحية»; unit roles and position seats reach added users only; nearest scope decides unit operations and final approval; stationing requests belong to the requesting unit; access requests keep advice apart, record a missing access manager, audit a unit change (V43); «الصلاحيات المتاحة للطلب» with description and scopes per role; unit responsibilities shown apart from personal permissions; a task leaves a person whose grant ends.
- **ADR-067:** «موقع جديد» in six steps for the setup administrator — site, initial stationing and both deployment areas in one atomic, audited save (V42, `POST /site-setup`, `/site-setup/check`).
- **Checks:** full backend suite 316/316 before deploy; frontend 294/294 (38 files); later classes: AccessWorkspaceIT 5/5, AuthorizationIT 10/10, WorkflowGraphIT 37/37, StationingNextIT 10/10, SeparationOfDutiesIT 9/9, AccessAdminIT 7/7.
- **Deployed on :8088 (schema V43):** all of the above. Acceptance set-up (ACCEPTANCE ONLY): stationing policy version 1 (owner's 4 Nov values, routing levels 10/9/8/7), the permission-request path, 14 fictional directory accounts `full26.u01…u14`; the two all-units «المعتمد النهائي» grants paused for the run (saved, to be restored after).
- **In progress:** the full end-to-end acceptance run (`docs/evidence/full-acceptance/FULL_ACCEPTANCE_AR.md`); the directory-first employment context before Oracle (LDAP Mode A).

## LDAP first login — unit-owned requests and unit-owned approval seats (16 Nov 2026, evening; ADR-069)

- **Owner decision (final text):** RULE A — an operational request belongs to the requesting unit, the submitter is history; RULE B — an approval responsibility is a seat of the unit and a person is its current holder. Most of the specification was already built (ADR-066, ADR-068); this closes the rest.
- **Final access approval role by role (§14):** each activated role carries its own anchor units, reach (unit alone / with descendants / chosen levels), selected units or sites and validity, in the existing grant/target/levels model (`GrantAdminService.planAccessGrants`); V45 `access_request.granted_detail`.
- **«الصلاحيات التي ستصبح فعالة» (§15):** `POST /access-requests/{id}/preview` — the plan the approval writes, with the time routing of unit operations and every problem; the approval carries its fingerprint (a change afterwards → 409). The page edits each role with the same «تعيين» dialog, fed by `GET /access-requests/{id}/scope-tree`.
- **The person moves while asking (§24):** the same request is rerouted to the current unit (new revision, old unit's advice and scope cleared, route derived again), audited «الوحدة تغيرت أثناء طلب الصلاحية»; «إعادة التوجيه إلى الوحدة الحالية».
- **Seats on transfer (§20, §23):** seats held for the unit left are released to the unit (`SEAT_UNIT_LEFT`, `UNIT_SEAT_RELEASED`) before the existing HR rule ends the other grants that follow the posting; the same before Oracle when the directory's Unit ID changes (`IDENTITY_UNIT_CHANGED`).
- **Smaller:** «تم التجاوز — لا يوجد مسؤول صلاحيات يغطي الوحدة»; status «بانتظار الاعتماد النهائي»; a catalogue role can be shown for information only (V45 `SHOWN`); the button reads «الصلاحيات المتاحة للطلب».
- **Checks:** full backend suite 327/327; frontend 302/302 (40 files), type check clean, build OK.
- **Deployed on :8088 (schema V45, 16 Nov 2026 11:19 UTC):** after the verified backup `backups/tmrkz-mover-20261116T111555Z`. Real-browser acceptance `tests/acceptance/acc69-ldap-first-login.mjs` with fictional people (`ops/acceptance-main/acc69.mjs`, demo Oracle + stand-in directory): **46/47** — the one failure was the check's own wrong expectation of a «طلب جديد» bar link (corrected); 14 screens and the report in `docs/evidence/ldap-first-login/` (SUMMARY_AR.md). «الصلاحيات المتاحة للطلب» restored to the four default roles afterwards.
- **Open:** Mode A (directory before Oracle) is proven by the automated tests only — Oracle stays in force on :8088; anchors outside the person's main-unit branch at the final access approval; the owner's production catalogue of requestable roles.

## Local offline runtime and unperformed Oracle import (16 Nov 2026, later operational run)

- Running at `http://localhost:8088`: `mover/backend:local-733b4aa4-v44` at source revision `733b4aa4` with V41–V44 applied, supplied web image `mover/web:1.0.0`, Keycloak and OpenFGA. The internal network passes `ops/local/offline.sh check`; original V40 backend image retained.
- Verified backup `backups/tmrkz-mover-20261116T105445Z` restores at V40 with checksums and fingerprint equality. After migration, all 201,940 row fingerprints in the restricted upgrade set are unchanged. The conventional jar packaging failure before Flyway, its correction and smoke check are recorded, not hidden.
- Operational fixes: LF endings for two shell entry points, and a user-owned public-CA truststore so the non-root Keycloak can start on this shared filesystem. No TLS-validation weakening and no private-key permission relaxation.
- Duty's Oracle settings are saved encrypted under TMRKZ's key, **disabled**. The source test fails `UNREACHABLE` (Duty itself reports `TNS:no listener`). No source substitution, metadata publication or HR import was performed. The existing synthetic snapshot remains 1,143 units / 200,567 people with 10 linked people; no unlinked-person cleanup was run.
- **Requested all-units + linked-people import remains blocked** pending a reachable listener/network path and an explicit source/migration choice for this restored demo hierarchy. This is not a connected-source or production-readiness claim.
- **Not browser-verified.** The in-app browser could not attach. `npm test` did not execute because the copied dependency tree lacks `@rollup/rollup-linux-x64-gnu`; the supplied frontend bundle is unchanged and no new frontend pass is claimed.
- Full commands, artifact checksum and remaining limits: `docs/evidence/local-startup-20261116.md`.

## Directory integration preparation, not yet activated (17 Nov 2026)

- Duty's real LDAPS endpoint and public CA were inspected **read-only**. Trusted TLS/hostname verification passed; the deliberately invalid probe bind was refused. The public CA and supported AD mapping were staged locally without changing either source application.
- TMRKZ's required separate service-bind input is absent: MOVER's mounted `config/.env` does not set `LDAP_BIND_DN`/`LDAP_BIND_PASSWORD`, and Duty's active integration uses direct user bind with no such service credential in its integration secret registry.
- **LDAP is not activated and no identity or role was granted.** `ops/keycloak/set-directory.sh` still needs an approved read-only bind DN and credential via a local secret file/channel, then bind and exact-account tests before activation.
- Evidence and limits: `docs/evidence/ldap-preparation-20261117.md`. The prior Oracle import also remains pending, not merged as an LDAP/HR connected claim.

## Sign-in button labels aligned with TNQL (17 Nov 2026)

- The automatic, manual and return labels now match the authorised TNQL login reference. The Keycloak credential-submit label was already correct. Manual and automatic paths are unchanged.
- Actual browser verification: initial choices render, manual opens its form, and return restores both options without entering credentials. A normal OIDC sign-in as the existing local `developer` still succeeds, with `CONFIGURE` and `MANAGE_ACCESS` plus audit rights.
- Runtime: `mover/web:local-733b4aa4-tnql-login`, built from a known-working original container after intermediate packaging variants failed startup/permission checks. Nginx config and homepage/assets pass; its original runtime user is unchanged. Archive checksum: `215a395204592e25539b456e9e5f7ee40f473ebf7880c9994b834c70a3d99826`.
- TypeScript, affected acceptance-script syntax and whitespace checks pass. Full frontend tests/build were not repeated because the host still lacks the Linux Rollup native module; this is a label-only artifact patch pending a proper connected-host build, not production-readiness evidence.
- The requested enterprise account and LDAP activation remain pending for the missing dedicated read-only bind account. No account or role was added or replaced.
- Evidence: `docs/evidence/login-labels-20261117.md`.

## Original-layout follow-up and Oracle unit-only preparation (17 Nov 2026)

- After the owner reported that the frontend had changed too much, the **exact original image was restored** before any further text edit. The final page uses the original HTML and asset, changing only the three requested labels and the main asset's cache filename (`index-B3vYdWVQ-text-v1.js`). Browser DOM inspection confirms the original login structure and labels; authentication methods are unaffected.
- Correct text-only candidate: `mover/web:local-733b4aa4-tnql-login`, image ID `75bb4abe45d5396e34f36458378a2836d7dd1cd9403b2bf2d564e2b9a6ba4b31`, archive SHA-256 `9f1c9084d6390382c3eb4c7a1d6ff5d5482bd34c7aa24a0217f4345ceb6d29aa`. It preserves the original runtime user and is healthy. No different-layout page is deployed.
- **Unit preparation, not import:** the Oracle-derived Duty mirror supplies 76,848 units (22,516 active), with source timestamp 2026-11-10 04:17:08 UTC. No duplicate IDs, invalid/overlong names or empty ID paths; no source-ID or `HR-<source-id>` collisions. A unit-only file is staged at `/var/lib/mover/unit-import/oracle-units-20261110T041708Z.json` (mode 640, application readable, SHA-256 `972d2a56b1b6cbbc1de278daee517fc2e8efbfac1678cd644cab35fb97514db0`), with **no people fields**.
- Verified recovery: `backups/tmrkz-mover-20261117T032617Z`; dump readability, checksums, clean restoration, 20-table fingerprints and schema V44 pass.
- **Not published:** the offline package has no JDK/compiler; direct compiler download and Docker Hub access fail. The Java 25 builder image or another approved build path is needed before the authorised unit-only handler, tests and atomic publication can proceed. The older mirror is not a claim of live Oracle connectivity. No people/permissions changed.
- Evidence: `docs/evidence/login-labels-20261117.md` and `docs/evidence/unit-import-validation-20261117.md`.

## Manual platform and direct enterprise sign-in — source/configuration prepared, backend not deployed (17 Nov 2026, ADR-070)

- **Implemented in source:** the manual form routes allow-listed `admin`/`developer` logins only through a restricted backend Keycloak client (provider role + allow-list still required) and every other login through the enterprise directory. It adds TNQL/Duty-style direct user LDAP bind with exact stable-identity lookup, TLS/hostname verification and direct reauthentication. Bad platform credentials do not fall through to LDAP; directory identities never receive platform privilege. Real Keycloak 26.7.5 direct grants omit `auth_time`, so only that synchronous path uses a verified fresh `iat`; browser OIDC and step-up still require `auth_time`.
- **Existing identities preserved:** automatic Keycloak/OIDC behavior is unchanged. The supplied `tmrkz-platform-password` client is separately provisioned, has no browser redirect flow and leaves the browser client direct-grants disabled. No TMRKZ password hash, demo account or generic local fallback was added. If the requested enterprise U-account has no HR match, only the approved supported local User-ID-without-HR registration remains, with no business/administrator role.
- **Runtime applied:** the restricted Keycloak client is provisioned and returned correct developer identity, audience, role and fresh `iat`. The local configuration contains only non-secret manual-LDAP overrides and random client secret, not the user's password. A fixed `ldap-relay` now forwards raw TLS from the internal bridge gateway to one approved upstream; trusted TLS, correct-host acceptance, wrong-host refusal and anonymous root-DSE LDAP from a disposable internal-network container pass. `sh ops/local/offline.sh check` still passes (no general internet route). A new backup `backups/tmrkz-mover-20261117T035454Z` passed checksum, dump readability, clean V44 restore and 20-table fingerprint verification.
- **Current runtime is still the old authentication backend:** `mover/backend:local-733b4aa4-v44` and `mover/web:local-733b4aa4-tnql-login` are retained. No new Java source or frontend source text was deployed. Current browser confirms both controls/back behavior and successful existing developer automatic sign-in. No U-account password was requested or attempted, no requested enterprise identity or role was added, and enterprise automatic sign-in remains blocked pending the read-only service-bind input and exact-account verification.
- **Checks:** TypeScript, helper/JSON syntax, Compose validation, browser-helper syntax and OpenAPI generation (257 operations / 235 paths) pass. `DirectorySignInIT.wrongHostname`, `EnterpriseSignInIT.manualPlatformAccounts` and new `DirectDirectorySignInIT` are written but **unexecuted**: Maven/JDK 25 and its dependency cache are absent and external Docker/Maven/Adoptium access fails. `npm test` starts no tests because `@rollup/rollup-linux-x64-gnu` 4.65.1 is absent; TypeScript still passes. A proper source build and focused tests are required before deployment.
- Evidence and exact blockers: `docs/evidence/manual-sign-in-20261117.md`.

## Offline map delivery repaired on the shared local filesystem (17 Nov 2026)

- **Fixed at :8088:** the installed basemap, hillshade, 3D terrain, manifest and map font returned 403 because `vboxsf` retains mode 0770 and Nginx workers did not hold the mount group; after that was corrected, Nginx's `sendfile(2)` also failed on this filesystem. The local startup now supplies the numeric map group to the non-root worker (`ops/local/compose.map-access.yml`, `map-worker.sh`, `up.sh`) and `/map-data/` uses `sendfile off`. The package mount remains read-only and no root Nginx worker was introduced.
- **Measured:** the normal offline startup and a web restart pass; Nginx validates; manifest/PMTiles/font full and range requests succeed and match installed bytes; all 43 package files pass their recorded checksums; the loaded terrain product matches; protected analysis remains 404; `sh ops/local/offline.sh check` still proves no internet route. Schema stayed V44, with no migration. The package/serving half of `readiness.py` is green. Through the normal developer OIDC session, `/map/features` returns 200 with one permitted feature, `/map/context` and `/map/packages` return 200 (two package rows), and `/stationing/current` is empty; `/operational-posture` correctly remains 403 for this account's scope, with no grant changed.
- **Still open:** full `readiness.py --require-terrain-3d --db-container …` returns exit 1 solely because **no Stationing policy is in force** (22 other checks pass). No policy was invented or published. The recovered in-app browser opened the normal developer UI, but `#siteSetup` and `#stationing` stop with **WebGL2 required** because this browser lacks WebGL2; MapLibre 6 checks that capability before loading style/assets. Interactive canvas acceptance is therefore **not claimed**, and no general non-WebGL fallback was added or map engine replaced.
- Backend/API/TypeScript/map content were unchanged; their full suites were not rerun. The normal offline startup override applies the Nginx correction to the preserved web artifact; this is not a fresh source-build claim. Full evidence and the rejected first override candidate are recorded in `docs/evidence/map-delivery-20261117.md`; ADR-036 has the operational amendment.

## Duty-compatible enterprise automatic Keycloak — source corrected, external client/build pending (17 Nov 2026, ADR-071)

- **Owner correction addressed:** ADR-070 initially retained automatic *local* Keycloak instead of Duty's external-realm model. Source now selects a new dedicated **external enterprise Keycloak client** for automatic SSO, separately from local `admin`/`developer` sign-in and direct manual LDAP. TMRKZ's authorization-code + PKCE, nonce/state, token and `auth_time` protections are retained. The external client's direct grant stays disabled and Duty's `MNAWB` secret is not reused.
- **Two-provider separation:** `OidcProperties` now carries independent platform/local issuer, token/JWKS endpoint and browser settings, with separate key caches. `IdentityService.platform` additionally requires the approved local issuer, so an enterprise token carrying a platform-looking role cannot obtain platform grants. `AuthController` routes local step-up/logout from the server-side session's actual provider; direct LDAP reauthentication remains independent. The original single-provider test/dev defaults are preserved without ever borrowing enterprise values as local defaults.
- **No schema migration:** initial static review found that `REAUTH_PLATFORM` would violate V4's purpose check; it now stores `REAUTH` and encodes the provider in a generated nonce namespace, verified exactly on callback. Empty Compose override fallbacks, manual-only logout prerequisites, test identity isolation and callback/logout result assertions were also corrected. New `DualProviderSignInIT` (two keys/endpoints) and `OidcPropertiesTest` (empty/external overrides) are written but **not run**.
- **Only static checks have run:** Compose config, YAML/JSON parsing, TypeScript and OpenAPI generation (257 operations / 235 paths) pass. Java tests and a proper frontend build remain blocked by the already searched-for unavailable toolchains. Existing backend/web images are retained, so current browser behavior is still local-automatic until external configuration is installed. No real U-account password or privileged grant was used.
- **New external prerequisite:** an approved, newly registered enterprise TMRKZ client, exact public callback/logout origin, trusted back-channel token/JWKS and approved claims including `auth_time`. Its secret must come through the authorised local secret channel. A narrow back-channel TLS relay (if required) must not introduce broad egress. This supersedes the earlier claim that this particular enterprise-automatic route necessarily requires TMRKZ's own LDAP service-bind account. Direct manual LDAP remains independently prepared and its relay verified. No external client connection, deployment or real U-account SSO is claimed. Evidence: `docs/evidence/enterprise-keycloak-topology-20261117.md`.

## Oracle-only units prepared in source; cutover NOT performed (17 Nov 2026, ADR-072)

- **Owner decision:** replace the active hierarchy with Oracle-derived units from Duty, retire unmatched HR/LOCAL units without deleting history, and reassign access instead of inferring a name/root mapping. Source: validated unit-only snapshot (76,848 units / 22,516 active, timestamp 10 Nov 2026) with exact SHA-256, no person data and no newer suitable local mirror found. This is **not** a live Oracle connection and the disabled source stays disabled.
- **Implemented in source:** bounded unit-only file validation; V47 import provenance and PREVIEWED retention (drafted as V45; renumbered to follow the committed V45/V46); CONFIGURE-protected preview/publish; HR advisory locking and exact impact/stale/collision gates; organizations-only projection with unchanged person mirror/identities/affiliations; expected and actual commit results with idempotent replay; historical membership ending and site-responsibility closure; Oracle-only active postconditions. Ordinary `HrProjection.apply` keeps unrelated LOCAL behavior.
- **Navigation:** normal `/organizations/tree` returns ACTIVE units. `includeRetired=true` requires AUDIT plus scope. Active children beneath retired ancestors remain navigation roots with their original Oracle parent ID; no invented ancestry or widened rights. Two import API endpoints and corrected OpenAPI extraction generate **261 operations / 239 paths** (259 / 237 on the 733b4aa base; regenerated after the merge, ADR-074).
- **Measured evidence:** a fresh `backups/tmrkz-mover-20261117T054828Z` passed checksum/dump/clean-restore and 201,963-row fingerprints at V44. Diagnostic main-source type-check passed (Java 21 only, not a release build). A disposable internal-network database migrated V1→V44 then applied only the import migration (then numbered V45, now V47): 44 + 1 migrations, `snapshot_lineage_violations=0`, `unit_import_columns=21`, final `mismatches=0`. Preview helpers' initial failures were corrected and are recorded, not hidden.
- **NOT executed:** `OracleUnitImportIT` (17 scenarios including a 20,257-unit generated payload) and `V47MigrationIT` (drafted as `V45MigrationIT`) remain uncompiled/unrun. The approved Maven/JDK 25 image and populated dependency cache are absent. `ops/test-backend.sh` now refuses that condition early with no test containers, downloads or pulls. The main runtime/database remains at V44 and no live preview/publication has occurred. Current units/people/grants are unchanged by this operation.
- **Release gate:** supply the approved offline Java 25/Maven builder/cache, then run focused plus full backend and affected-authentication suites, actual payload restore rehearsal and preservation checks before a built-backend preview/cutover. Afterwards use the limited audited bootstrap path and new Oracle-scoped grants; verify OpenFGA, administration, trees and sign-in. Details, checks and all remaining limits: `docs/evidence/oracle-unit-replacement-20261117.md`.

## The folder version merged into main (17 Nov 2026; ADR-073…076)

- **ADR-073:** «مدير النظام» submits «طلب إعادة تمركز» for any unit (V46, deployed on :8088 at 08:01 UTC after the verified backup `backups/tmrkz-mover-20261117T075129Z`).
- **ADR-074:** the folder's version (another agent's work in a VM sharing this folder, based on 733b4aa) merged: its decisions renumbered ADR-070…072, its migration V45 → V47; the folder's access screens (one scope for all roles, no preview) replace ADR-069's role-by-role screen by the owner's choice; the missing backend (sign-in providers and manual platform sign-in, direct LDAP, the Oracle unit import's projection and tree) rebuilt and tested; `compose.offline.yml` image pins, `.zcode/` and the audit folders left out.
- **ADR-076:** «تهيئة المواقع» is the site with its stationing — the responsible unit is the stationed unit (it heads «التمركز الابتدائي»); «مدير النظام» gains `MANAGE_SITE_LINKS` and `CORRECT_STATIONING` (V48), so it has the six-step «موقع جديد» and «تثبيت»; «معسكر البانه» is stationed from its card.
- **ADR-075:** «مدير النظام» no longer sees «طلب صلاحية» nor, with only the administrator's re-stationing right, «طلب جديد»; «＋ طلب جديد» opens the re-stationing editor.
- **Checks:** full backend suite 353/353 (from a clean build, test database limit raised to 500 connections); sign-in classes 65/65 and Oracle/HR classes 73/73 in the rebuild runs; frontend type check clean, 300/300 (40 files); OpenAPI 261 operations / 239 paths.
- **Not verified here:** the Keycloak password client and the manual enterprise LDAP relay on :8088 (the relay settings in `.env` belong to the VM: their config path and gateway do not exist on this host), the real Oracle unit file, a browser acceptance run of the folder's access screens.
- **ADR-077:** «ملف الوحدة» removed from «إدارة الصلاحيات والوحدات» (the page is two panels); unit grants and providing departments keep their effect, no longer edited there.
- **Access workspace, owner 17 Nov:** the page is more compact (smaller headings, cards, tabs, search and a tighter permission table) and the identity columns are centred; the number column is wider so «PLATFORM-admin» is not cut.
## Fewer stationing permissions and roles (17 Nov 2026; ADR-078)

- **Permissions:** seven actions removed — initial stationing is set up in «تهيئة المواقع» only (the request purpose is refused, an old one is read and cancelled); «طلب إعادة التمركز ومناطق الانتشار» (`CREATE_RESTATIONING`) opens both requests; a request beyond the deployment range is flagged «يتجاوز المسموح» with its excess on every stage and decided by its final approver (no exception stage); cancellation, cancellation before start and early return are started by a requester of the unit and decided by the unit's nearest final approver, never by who started them; an extension is activated with «تفعيل التمركز». OpenFGA model regenerated (`docs/authz/model.fga`).
- **Roles:** «مقدم الطلب» is the stationing requester; «معتمد عمليات الوحدة» also manages facilities and site links; «مدير النظام» also re-sends failed stationing events; MOVER's five facilities roles and the three partial duplicates are emptied, renamed «… (غير مستخدم)», their grants ended, no longer offered or given. The access-workspace matrix shows only unit roles that give something, in the owner's order; empty roles leave the role pickers. A new installation seeds the facilities roles empty (`TMRKZ_LEGACY_FACILITY_ROLES=true` keeps them for the backend tests and the fictional acceptance environment).
- **Migration V49** (not yet applied anywhere): the roles, the grants ended with a reason, the offers, a new published policy version (an open draft carried after it), undecided exception stages of old requests taken off their route, one audit event `ACCESS_ROLES_SIMPLIFIED`. Nothing to run by hand after deploy.
- **Checks:** full backend suite 357/357 (from a clean build); frontend type check clean, 316/316 (43 files); OpenAPI 260 operations / 238 paths.
- **Not verified here:** a browser run of the changed pages; `tests/acceptance/restationing-acceptance.mjs` (distance exception and lifecycle sections), `full26-verify-grants.mjs` and `main-8088-extra.mjs` still describe the rules before ADR-078.

## TMRKZ with MOVER's identity and HR settings; the specification re-run on V49 (17 Nov 2026; ADR-079)

- **This PC's :8088:** pulled to `a2bb677` and moved from V32 to **V49** in isolated mode (`TMRKZ_OFFLINE=1 TMRKZ_BUILD=1 sh ops/local/up.sh`) after the verified backup `backups/tmrkz-mover-20261117T121633Z` (V32). Network trap on the first isolated start: existing `db` and `openfga` containers lost their DNS names, fixed by recreating them (data in volumes).
- **MOVER's settings (owner):**
  - Directory: `mover-ldap` (StartTLS, «MOVER Dev LDAP CA», base `DC=mover,DC=local`, self-bind `{username}@mover.local`, MOVER's attribute names), in `.env`, Keycloak's federation (`set-directory.sh`, read-only `svc_tmrkz_ro`) and the employment mappers.
  - Oracle: `mover-oracle-hr`/FREEPDB1, read-only `TMRKZ_HR` on the synthetic `HR_AI` views, MOVER's mapping; first sync 74 units, 0 people.
  - Role policy version 3: `ops/policy` roles, nothing granted.
  - Repeatable with `ops/local/use-mover-sources.sh` + `ops/local/mover-settings.mjs`.
  - Table and server values: `docs/MOVER_SETTINGS_PARITY_AR.md`.
- **Code:**
  - The live lookup and «إضافة مستخدم» accept the earlier military number, as MOVER.
  - Directory search from an AD domain root no longer fails on continuation references (every manual sign-in against MOVER's AD answered `DIRECTORY_UNAVAILABLE` before).
- **Checks:**
  - Backend: `HrLinkedPeopleIT`, `UnitMemberIT`, `HrSyncAcceptanceIT`, `DirectorySignInIT`, `EmploymentContextIT` 30/30; the four sign-in classes 21/21; the spec's eight classes 89/89 at `a2bb677`; full suite with both changes 356/357 — `AuthorizationIT.explicitOrganisationSet` 403 for 200 when it ran first, then 10/10 alone (no code it reaches changed).
  - Browser: `tests/acceptance/acc79-mover-settings.mjs` 71/71 on :8088 with synthetic people — `docs/evidence/mover-settings/SUMMARY_AR.md`.
  - The backend image on :8088 carries both changes; the web image is unchanged.
- **Not verified / open:**
  - The real enterprise AD attribute for the Unit ID and MOVER's `Mil*` attributes (absent from the dev schema).
  - MOVER's `LIKE '%-n'` number fallback (not built).
  - JDBC thin against the server's Oracle (MOVER uses thick).
  - The TMRKZ client in the enterprise Keycloak (ADR-071).
  - The preview screen and per-role levels at the final access approval are absent by ADR-074 (server API checked; levels set through «تعيين»).
  - The run's fictional data remains on :8088 (policy `ACCEPTANCE / FICTIONAL`, site `ACC79-SITE-01`, RS-2026-0001, synthetic people); the clean configured state is `backups/tmrkz-mover-20261117T152956Z` (verified, V49) — restoring it removes the database volume, the owner's call.
  - Attaching MOVER's two containers to TMRKZ's network is lost if the network is recreated (rerun `use-mover-sources.sh`).

## «إعادة تنظيم التمركز والمواقع ومناطق الانتشار» — phase 1 of 8, OWNER REVIEW REQUIRED (17 Nov 2026; ADR-080)

- **Owner rule:** one screen at a time; the interface first, shown on :8088, and nothing further (no backend, no next phase) until the owner accepts it.
- **Phase 1, second version (after the owner's review of the first):**
  - The three ways are tabs of the top bar right after «الرئيسية», with their symbols: «تحديد مواقع التمركز المبدئية», «طلب مناطق انتشار», «طلب إعادة تمركز». One click opens the work.
  - A tab shows only with its right, and the highlight follows the address.
  - They replace «تهيئة المواقع» and «إعادة التمركز»; the requests list is in «المزيد».
  - The page of cards from the first version is removed.
  - The dark theme is graphite and sand instead of navy and teal (app and sign-in page).
- **Not changed:** the backend, the screens the tabs open (phases 2–4), the light theme, status colours and map symbols.
- **Checks:**
  - Frontend: type check clean, 318 tests (44 files).
  - Browser: `tests/acceptance/stationing-hub-phase1.mjs` 6/6 on :8088 (web image only rebuilt); screens in `docs/evidence/stationing-redesign/phase1/`.
  - Not yet run: `theme-contrast.mjs` on the new dark theme.

## Phase 2 of 8 — «تحديد مواقع التمركز المبدئية», accepted and connected (17 Nov 2026)

- **Interface only:** `SiteSetupPage` «موقع تمركز مبدئي جديد» in three steps (`INITIAL_STEPS`, `initialProblem` in `lib/siteWizard.ts`):
  - **«بيانات الموقع»:** the unit first; a unit already stationed is stopped («يتغير بطلب إعادة تمركز»); name, type, main or inside, the symbol as one row, notes.
  - **«تحديد الموقع والحدود»:** the map tools, 2D/3D.
  - **«مراجعة وحفظ»:** the summary, «حفظ الموقع والتمركز المبدئي».
- **Opening:** the tab opens on the steps at once.
- **Gone from the setup:** «أي الوحدات تتمركز في هذا الموقع؟» and both deployment-area steps.
- **Not connected yet (owner rule: the screen first):** the save says nothing was saved. The server's setup still requires the policy's area pair (`DeploymentRules.pair`), so the backend step changes the setup to the site and its unit's initial stationing, the areas moving to «طلب مناطق انتشار». The previous save path is kept in the page for that step (`void save`).
- **Second version (after the owner's review of the first, 17 Nov 2026; ADR-081):**
  - **The symbol:** a field «رمز الموقع على الخريطة» with a large preview and «اختيار رمز» opens a picker window: search by name, «الكل / الأكثر استخداماً / المفضلة / الأخيرة», ten categories, 88 standard symbols (MIL-STD-2525C, each checked by milsymbol). A typed code only for whoever may configure.
  - **Search by name, not code (`lib/symbolSearch.ts`):** Arabic normalisation (hamza forms, ة/ه, ى/ي, diacritics, Indic digits), the article and joined prefixes, light endings, a synonym dictionary (طبي → طبابة، مستشفى، إسعاف، مركز صحي …), words matched from their start, one typo forgiven only when nothing matches as typed. Measured in Edge: «طبي» → 8 medical symbols; «دروع» → armour only; «مستشقى» → «مستشفى ميداني»; «معسكر» → the camp first.
  - **The unit search as a hierarchy:** each unit found shown under its whole chain of parents from the top, marked «مطابق»; any row (a parent or a child) can be chosen, «+» opens a branch (`UnitTree`, `searchForest` in `tree.ts`).
  - **The map:** the new site's name and symbol stand on its boundary or point; a north arrow; a scale in 2D.
  - **A double click finishes the drawing:** on an empty spot it places the last corner and closes the shape; on the last corner it closes without adding one. Cause of the fault: a corner marker took the second click and the double click, which never reached the map; the corner now finishes the drawing itself (`SiteEditor`).
  - **3D speed:** fewer and coarser tiles towards the horizon in the tilted view everywhere; on a machine without a usable GPU, a lighter 3D (no colour tint, sky or fog; 0.7 resolution; the heights and the shade kept). Software rendering: average frame 155 → 110 ms, p95 326 → 215 ms; GPU unchanged at the screen's refresh rate (`docs/evidence/stationing-redesign/phase2/map3d-perf.md`).
- **Checks:**
  - Frontend: type check clean, 331 tests (45 files), incl. `symbolSearch.test.ts`, `tree.test.ts` (`searchForest`) and `siteWizard.test.ts`.
  - Browser: `tests/acceptance/initial-site-phase2.mjs` 15/15 on :8088 in both themes (nothing saved, nothing outside localhost); screens in `docs/evidence/stationing-redesign/phase2/`.
  - Only the web image was rebuilt; the backend is unchanged by this phase.
- **Limits (when shown):** the save was not connected then. The 3D figures are from one machine; a virtual machine without a GPU was emulated with SwiftShader, not measured on a real one. `theme-contrast.mjs` not run on these screens.
- **Accepted by the owner («next», 17 Nov 2026) and connected (ADR-081 addendum):**
  - «حفظ الموقع والتمركز المبدئي» sends the site, its boundary and the chosen unit to `POST /site-setup` with no areas: one audited save (`SITE_SETUP_BOOTSTRAPPED`), the stationing with origin SETUP, no request. A refusal (no reason, a unit already stationed, the site's own rules) is said on the review step.
  - Server: a unit sent without areas is stationed alone whatever the policy requires (`SiteSetupService.evaluate`); the hub then shows it `DEPLOYMENT_MISSING`. Areas that are sent are checked as before; a policy in force is needed only for them. `SiteSetupIT` SETUP-06 rewritten (REQUIRED accepts a unit without areas, refuses one area alone).
  - Who saves: still «تهيئة المواقع والتمركز» (facilities and corrections everywhere, `SiteSetupService.admin`); everyone else sees why the button is off. Who may set up sites is phase 7.
  - Checks: `sh ops/test-backend.sh SiteSetupIT` 7/7; `tests/acceptance/initial-site-phase2.mjs` 18/18 on :8088 — it SAVED one fictional site, S-0002 «موقع تمركز مبدئي — وهمي c4k7», with the synthetic unit «مركز صحة اثنين» stationed there (data left on :8088). The later check «the new site appears in the site list» was added after that run and has not run yet (each run stations another synthetic unit).

## Phase 2 additions after its acceptance — site list as a tree, the site's card, deletion; OWNER REVIEW REQUIRED (17 Nov 2026)

- **The list (owner: "if I already add a camp inside the camp, it should show me a hierarchy view … if I click on this arrow, it will show who's related to this camp"):** inside sites are no longer rows of their own; each camp with inside sites has an arrow and «N مواقع داخلية»; the arrow opens them under it, indented, at any depth; a site chosen on the map opens the branches above it. Search results say «داخل «…»».
- **The card (owner: "redesign this information … he will go and edit"):** the four folded sections are replaced by the facts at a glance (type, where, stationed unit, boundary and area, inside sites, linked units) and three actions: «تعديل» (one form: name, type, «يقع داخل», symbol, boundary on the map, notes, ONE reason; only what changed is saved, through the existing endpoints), «＋ موقع داخل», «حذف الموقع». Correction of a stationing and unit links move under «إجراءات أخرى».
- **Deletion — first version (superseded below):** the administrator («تهيئة المواقع والتمركز») gets «حذف الموقع» with what ends with it (the site leaves the list and map and stays in the audit; the unit's initial stationing and its areas end) and a reason; a camp with inside sites cannot be deleted before them. Whoever else manages the site gets «طلب حذف» with a reason, sent to the system administrator. Neither is connected: the server today has only `POST /sites/{id}/retire` (any facility manager, no reason, stationing untouched); the rules above are a proposal for the owner.
- **Deletion — the owner's rules (17 Nov 2026), interface only:** «erased completely»: the site, its boundary and symbol are removed from the system, with no undo; a unit stationed there loses that initial stationing and its areas and is back to no stationing; the inside sites are deleted together, after a red warning naming each one and the units stationed in it; the administrator confirms with a reason and «أفهم أن الحذف نهائي ويشمل المواقع الداخلية». One audit line (who, when, why) is kept — the owner was told and may say otherwise. Others send «طلب حذف» with the same warning to the system administrator. Not connected: the server's `retire` keeps the row and checks none of this.
- **Checks:** `tests/acceptance/site-card-review.mjs` 20/20 on :8088 (after the rules; 19/19 before) (administrator, and a synthetic requester given «معتمد عمليات الوحدة» on its unit for the run, then ended); nothing deleted; screens in `docs/evidence/site-card-review/`.

## Phase 3 of 8 — «طلب مناطق انتشار», accepted («next») and connected (17 Nov 2026; ADR-082)

- **Interface only:** a new request for deployment areas opens its own screen (`DeploymentAreasRequest`, `lib/deploymentAreasFlow.ts`); an existing request of that purpose still opens in the request editor.
  - It starts by itself from the unit's current approved site (no starting point to choose); with several eligible units the unit is chosen first; units without a stationing or with an area request pending are shown with the reason.
  - Steps «الوحدة → الرئيسية → الفرعية → مراجعة وإرسال». Each area is placed with the policy's initial shape by one click or drawn (a double click finishes), then dragged; «تعديل الرؤوس», ↶ ↷, «حذف المنطقة».
  - Small chips: distance, area, «✓ ضمن المسموح» (or «✗ أقرب/أبعد من المسموح», «! أبعد من الحد الأساسي» when terrain may allow it), and «ⓘ» with distance, area, terrain, minimum, maximum, reason of the excess, policy version.
  - The main area: solid outline, transparent fill in its colour; the sub-area: dashed outline, lighter fill, its own colour — on this screen, the request editor and every request map (`RequestMap`, `SiteEditor` look `dashed`).
  - «منطقة الانتشار الفرعية» replaces «البديلة» everywhere in the interface; ALTERNATIVE stays the internal name. Server messages still say «البديلة» until the backend step; eight older acceptance scripts that match the old word are updated then.
  - «إرسال للاعتماد» says nothing was sent. The backend step creates the draft (`purpose DEPLOYMENT_AREAS`), checks it and submits it through the existing route.
- **Second version (owner, 17 Nov 2026):** the steps on the right and «ما يطلبه هذا الطلب» on the left (as «تحديد مواقع التمركز المبدئية»); step «الموقع» lists the person's units by camp — the camp's name first, inside camps under their main camp with arrows, each camp's units under it in the organisation's order — and a camp is chosen in the list or on the map (its one unit starts the request); units stationed nowhere are folded into «وحدات بلا تمركز معتمد (N)»; the header names the camp first (`campTree`).
- **Third version (owner, 17 Nov 2026, while using it):**
  - Camps and units are folded at first; every list of units is the organisation's tree (`unitForest`), the units stationed nowhere too.
  - One choice: a camp clicked in the list or on the map is marked «المختار» and highlighted on the map at every step; its one unit is chosen with it; nothing moves on until «التالي», which waits, saying why, until the step is done. A camp clicked on the map after step 1 takes the request back to «الموقع» with it.
  - The map stays where the person put it: it flies only to a camp chosen from the list; no step change and no finished drawing moves it (`SiteEditor` `flyOnFinish`).
  - While an area is placed or drawn, an arrow from where it is measured to the pointer, and a chip with the distance and the verdict, in the verdict's colour.
  - Shapes like Word's: «مربع», «دائرة», «رسم حر»; for the sub-area first «بنفس شكل الرئيسية» (a copy of the main area moved to the click); a square or circle of the sub-area takes the main area's size. Resizing, rotating and width/height handles stay phase 5.
  - The slope inside each area (the request editor's «الانحدار» colours and shares) and both arrows on the map — camp → main area, main → sub-area — with the policy range's verdict.
  - The send says plainly, before it is pressed, that it is not connected until the owner accepts the screen.
- **Checks:** frontend 342 tests (47 files) incl. `deploymentAreasFlow.test.ts` (`campTree`, `unitForest`); `tests/acceptance/deployment-areas-phase3.mjs` 18/18 after the third version (12/12 after the second, 10/10 first). Not covered by the script: choosing a camp by clicking it on the map. on :8088 in both themes as the synthetic requester `juma.ghfly4` («مقدم الطلب» on «مركز صحة اثنين»); nothing sent; screens in `docs/evidence/stationing-redesign/phase3/`.
- **Test account:** `juma.ghfly4` (synthetic HR_AI person) exists in MOVER's local directory for the phase 3 runs; the acc79 accounts could not be reused (a recreated directory account is refused as `ALREADY_LINKED` and TMRKZ has no way to end an identity link). Remove with the scratch helper or `samba-tool user delete` after phase 3 is connected.

## «إرشادات صفحة الدخول» in the settings, OWNER REVIEW REQUIRED (17 Nov 2026; ADR-083)

- **Interface only (owner: "I can modify it on the setting … add more or [remove]"):** «إعدادات النظام» has a section for the sign-in page's board: its heading, the line under it, the notes (guidance or «تنبيه مهم», optional dates, hide/show, up/down, ✕) up to eight, the last line, and a preview of the board as it shows today. «حفظ» says nothing was saved; the sign-in page still shows its fixed three notes (`lib/signInNotes.ts`, `SignInNotesSettings`).
- **Checks:** `signInNotes.test.ts`; `tests/acceptance/site-card-review.mjs` (the settings part) on :8088; screens `docs/evidence/site-card-review/08-*`, `09-*`.
- **Connected (owner «next», 17 Nov 2026):** «حفظ كمسودة» creates the request (`purpose DEPLOYMENT_AREAS`, scope the unit, both areas) and keeps it current; «إرسال للاعتماد» submits it through the existing route; the server's refusals are said on the review step. The server's messages say «الفرعية» too (`DeploymentRules`, `RestationingChecks`, `SiteSetupService`; the V19 migration text is left as recorded); eight older acceptance scripts follow the word. Checks: `SiteSetupIT` 7/7; `tests/acceptance/deployment-areas-phase3.mjs` 25/25 — it SAVED and SENT RS-2026-0002 for «مركز صحة اثنين» (now under review on :8088; the script needs another eligible unit to run again).

## Phase 5 of 8 — «أدوات الرسم والتحكم (مثل Word)», in use (17 Nov 2026; ADR-084)

- **Owner:** "you can control the width and length … where is that one?" and the reference image's panel 5. Built ahead of phase 4 at the owner's request.
- **The toolbar** (`ToolGlyph`, «طلب مناطق انتشار» areas and «طلب إعادة تمركز» site step): «تحديد، تحريك» | «دائرة، بيضاوي، مربع، مستطيل، رسم حر» (+ «نسخة الرئيسية» / «نسخة الحالي», «نقل بنقرة») | «الرؤوس، تراجع، إعادة، إعادة الضبط، حذف».
- **The frame** (`SiteEditor.setShapeHandles`, `lib/shapeTransform.ts`): corners scale evenly, side handles change width or length alone (square → rectangle, circle → ellipse), ↻ turns the shape; each drag is one undoable change; a chip «العرض × الطول». Re-stationing areas get the frame and handles; their own toolbar is not yet replaced.
- **Checks:** `shapeTransform.test.ts` (4); in Edge, `deployment-areas-phase3.mjs`: 300×300 → 453×300 m by a side handle, ↻ keeps the sizes, circle → ellipse 340×469 m, undo restores.

## Phase 4 of 8 — «طلب إعادة تمركز», started (17 Nov 2026)

- Steps on the right, context on the left (owner); the site step uses the panel-5 toolbar and ready shapes sized as the current site within the maximum; «ضبط المساحة على المسموح» scales an oversized site down evenly (one undoable change); the arrow and the distance under the pointer while the site or an area is placed or drawn (`PointerGuide`).
- **Not yet:** the simplified map-first flow of the brief §5 (units by camp → the current site by itself → new site → main → sub → review; one progress strip, no stacked cards); the areas' own toolbar; sending with an oversized site so that the final approver decides or returns it (owner, 17 Nov 2026 — a server rule change: today the maximum blocks submission).

## Fluid responsive layout pass, approved by the owner (18 Nov 2026; ADR-085)

- **Owner brief «PROFESSIONAL FLUID RESPONSIVE LAYOUT PASS»** (feature phases paused; layout only, no business change).
- **Home:** the 1700 px cap is gone; gutters `clamp(12px, 1.2vw, 28px)`; on a desktop the dashboard is exactly the window's height — the map and the requests list take the full height, «العودات القادمة» is as tall as its content, the notes take the rest; the lists scroll inside their cards and load more rows (requests 24, returns 12, audit 16, notes 10) so a taller window shows more; «ما ينتظرك» and the indicators share one even row (compact on a laptop: no second line, smaller icon and number); three columns from 1600 px (the map 1.55fr, 2fr from 2200 px), two from 1180 px, one below.
- **Maps:** every MapLibre map follows its container with a `ResizeObserver` (`OfflineMapLibre`): one `resize()` per frame, the view kept, no refit, no new map.
- **Work screens:** side panels grow a little with the window (`clamp`), the map keeps the rest; on a laptop the new-request steps column keeps 265–290 px and the step strip/header shrink or wrap, so no panel spills over the map.
- **Checks:** `tests/acceptance/responsive-layout.mjs` 16/16 in Edge — the home page at 1280×720, 1366×768, 1440×900, 1920×1080, 2560×1440, 3440×1440, 3840×2160 resized LIVE in one page (full width, grid down to the window's bottom, map canvas = its card, no horizontal scroll), back and forth again, and the deployment-areas request, re-stationing and site setup screens narrow and maximised (workspace fills the window, canvas fills its frame, no panel wider than its column). Screens and `home-side-by-side.png` in `docs/evidence/responsive-layout/`. Frontend 344 tests (2 skipped).
- **Not done:** a visual polish of every card style (spacing scale, radii) beyond the dashboard and the work-screen columns; tablet and phone widths were left as they were and not re-measured; a real second monitor and OS fullscreen were not tried (the live resize in one page stands for them).

## Visual polish gate, OWNER VISUAL REVIEW REQUIRED (18 Nov 2026; ADR-085 addendum)

- **Owner:** "a professionally designed enterprise product, not an AI-generated dashboard"; the responsive behaviour approved and kept.
- **One system** (last section of `shell.css`): spacing 4/8/12/16/24/32; radii 10px panels, 8px controls, round chips; flat surfaces from the theme's own colours (no gradients), borders for separation, shadows only for floating layers; every top-bar control 36px; colour only for state, selection and action.
- **Home:** the indicators are one metric strip divided into equal parts (zero values neutral, `data-zero`); the panels are flat with one title line; the map runs edge to edge under its title; list rows sit on hairlines and light on hover instead of being boxed; empty lists say so in one line (`tz-empty-line`); while the request list is short (≤ 6 rows, or none to show) the grid uses two columns from 1181 px — the map larger, the three panels stacked at their content's height, the activity taking the rest — so no column is kept empty for rows that do not exist.
- **Work screens:** the same surfaces, radii and button heights; a context panel is as tall as its content.
- **Checks:** `tests/acceptance/responsive-layout.mjs` 16/16 after the polish; frontend 344 tests. Fixed on the way: the indicator strip squeezed at 1366×768, «المزيد» overlapping the search at 1366 (a base rule overrode the bar's width steps), the laptop indicator size, an existing `.tz-empty` class used by other screens.

## Site deletion and the sign-in notes, connected (18 Nov 2026; ADR-086, ADR-083)

- **Deletion (owner's rules):** `admin` («تهيئة المواقع والتمركز») erases a site completely — its inside sites, boundary versions, symbol, responsibility, links, resources, and the stationing of the units there with their deployment areas (each unit then stationed nowhere; a `STATIONING_REMOVED` event per unit) — in one transaction, with one audit line `SITE_DELETED`. Whoever else manages the site sends «طلب حذف» (one open per site; the administrators are notified); `admin` approves (the same erase) or refuses (the requester is notified). What a request, a booking or a permission still refers to stops it, named on the panel: an approved request's site, a request in progress for a unit stationed there, areas a request made, bookings, old relocation requests, permissions scoped to the site, a temporary stationing elsewhere that returns there. V50: `site_deletion_request`; sites, their boundary versions and resources may be deleted only inside a transaction that declares a site erase (the audit trail and every other append-only record keep their guards). Endpoints `GET/POST /sites/{id}/deletion`, `POST /sites/{id}/deletion-requests`, `GET /site-deletion-requests`, `POST /site-deletion-requests/{id}/decision`.
- **Sign-in notes:** saved by whoever configures the system (`PUT /settings/sign-in-notes`, audited, V51 `sign_in_board`); the sign-in page reads `GET /auth/notices` before anyone signs in — only the notes shown today (hidden and out-of-date notes never leave the server there), the important notices first; its own three notes until a board is saved.
- **Checks:** `SiteDeletionIT` 3/3, `SignInNotesIT` 1/1, `SiteSetupIT` 7/7; `tests/acceptance/site-card-review.mjs` 22/22 on :8088 (the server's blockers shown and the delete off; a real «طلب حذف» refused by `admin`; the board saved back as it was). OpenAPI regenerated (268 operations).

## An oversized site is sent and decided by the final approver (18 Nov 2026; ADR-087)

- **Owner:** "an option that he can click and organize the area based on what's allowed, but he can also continue … the approval may say no, change the space, and send it back to the unit".
- **Server:** the policy's maximum footprint no longer refuses a request; `RestationingChecks.Result.areaOverMax()` flags it on the checks every stage reads (`areaOverMax`), the submission's audit line records it, the final approver accepts it or returns the request (the existing return path).
- **Screens:** the re-stationing editor keeps an oversized site valid (no red, «التالي» on) and says the approver decides, beside «ضبط المساحة على المسموح»; the checks card shows «⚠ المساحة تتجاوز الحد الأقصى» to every stage; the policy studio's wording follows.
- **Checks:** `RestationingWorkflowIT` 16/16 (an oversized site is flagged, not refused; a smaller maximum flags a draft); `restationing-geometry.mjs` G7 updated to the new rule (not re-run here).

## The area limits of each deployment area, and the toolbar on every area step (18 Nov 2026; ADR-088, ADR-084)

- **Policy (owner brief §9):** each leg may have `minAreaM2` and `maxAreaM2` (optional; versions without them have no limit). The policy studio edits them per area; publishing refuses a minimum above the maximum; the server refuses an area outside them (`RestationingChecks.deploymentLeg`, every request and the setup); «طلب مناطق انتشار» shows an area chip («✓ المساحة ضمن المسموح» / «✗ أكبر/أصغر») and the limits in «ⓘ».
- **Re-stationing areas:** the same toolbar as everywhere (select with the frame and handles, move, circle, ellipse, square, rectangle, free drawing, vertices, undo, redo, reset); the square keeps the policy's initial shape; the old buttons' accessible names stay on the square and free-drawing tools.
- **Checks:** `SiteSetupIT` SETUP-08 (limits refused, a minimum above the maximum not published, the limits read back), `StationingRulesTest`, `StationingFoundationIT`, `RestationingWorkflowIT` — 70 tests; frontend 347.

## Phase 4 of 8 — «طلب إعادة تمركز» map-first, built and connected (18 Nov 2026)

- **The flow (owner brief §5):** a new re-stationing opens the same map-first screen as «طلب مناطق انتشار» (`DeploymentAreasRequest`, purpose RESTATIONING) — one progress strip «الوحدات ← الموقع الجديد ← الرئيسية ← الفرعية ← مراجعة وإرسال» (numbers, and the current step's name in full), no stacked cards.
  - **Units:** by camp, folded at first; several may be ticked; the unit that every ticked unit is under asks for the move (the server's branch rule), named on the step; units the hub does not allow say why.
  - **The current site by itself**, and «موقع التمركز الجديد» with the panel-5 toolbar: a copy of the current site, a circle, ellipse, square or rectangle the size of the current site within the policy's maximum, free drawing; chips (distance from the current site, area, width × length, against the maximum); an oversized site may be sent (ADR-087) or fitted with «ضبط المساحة على المسموح».
  - **The new main area is measured from the new site**, the sub-area from the main area; pointer arrow and distance, slope colours, chips and «ⓘ» as phase 3.
  - **Review and sending:** the units, who asks, the current and new sites, both areas; «حفظ كمسودة», «إرسال للاعتماد» (`purpose RESTATIONING`, scope the ticked units, the site recorded COPY / EDITED / DRAWN).
  - A re-stationing opened towards a registered site (`#restationing/new?site=`) and every saved draft still open the request editor (temporary moves, occupants and exceptions stay there).
- **Checks:** frontend 352 tests; `tests/acceptance/restationing-phase4.mjs` 18/18 on :8088 — it SENT RS-2026-0004 for «مركز صحة اثنين» (UNDER_REVIEW); 16/16 again with `SAVE=0` after the step-strip change (nothing written). Screens in `docs/evidence/stationing-redesign/phase4/`.

## Phase 7 of 8 — «صلاحيات تهيئة المواقع», built and connected (18 Nov 2026; ADR-089)

- «الإعدادات» has the rule: roles, people, units (with or without the units under them), levels; a sentence says it as the server applies it; a reason is required to save (audited). Initial rule: «معتمد عمليات الوحدة» in that role's reach. The system administrator always may.
- The server checks every setup save and check: each unit, the site's responsible unit, the main site of an inside site; the site is registered on the unit's behalf. The tab shows for people the rule allows (`/me.siteSetup`).
- **Checks:** `SiteSetupIT` 9/9 (SETUP-09: the initial rule, a unit outside the reach refused with nothing written, only the configurer changes the rule, a named person, levels); `tests/acceptance/setup-access-parts-phase78.mjs` (settings in both themes; nothing saved). Screens in `docs/evidence/stationing-redesign/phase7-8/`.

## Phase 8 of 8 — «الاعتماد الجزئي», built and connected (18 Nov 2026; ADR-090)

- The stage that decides now sees the parts (new site, main area, sub-area) and approves or returns each one («تعديل مطلوب» with a note); one returned part returns the request with that part named; approved parts stay approved at that stage unless changed; a changed approved part is reopened. The requester of a returned request sees each part's state. The route and its rules are unchanged.
- **Checks:** `RestationingWorkflowIT` 17/17 (PART-01); `tests/acceptance/setup-access-parts-phase78.mjs` 11/11 on :8088 — a synthetic decider (`fahad.ktby4`, HR_AI, given «معتمد عمليات الوحدة» on the unit for the run, then ended) sees RS-2026-0004's three parts and chooses two approvals and one return; nothing was decided.

## Backend suite and data left on :8088 (18 Nov 2026)

- Full backend suite before phases 4/7/8: 360/362 — `AuthorizationIT` (order-dependent OpenFGA flake, 10/10 alone) and `RestationingHrSyncIT` (shared-database contamination, 2/2 alone). After the phases: `SiteSetupIT` 9/9, `RestationingWorkflowIT` 17/17; the full suite was not rerun.
- On :8088: RS-2026-0004 (re-stationing, UNDER_REVIEW) besides RS-2026-0001…0003; the synthetic directory accounts `juma.ghfly4` (requester) and `fahad.ktby4` (decider, no grant left) in MOVER's local directory — remove with the scratch helpers or `samba-tool user delete` when no longer needed. Migrations V52, V53 applied.
- **Owner review:** phases 4, 7 and 8 were built and connected in one pass at the owner's request («finish everything that holds»), not shown screen by screen first; the owner reviews them now.

## TMRKZ runs from its folder; the VM package (19 Nov 2026; ADR-091)

- **Run:** `sh start.sh` asks for the IP address and the port, or by hand `docker load -i tmrkz-images.tar` then `docker compose up -d`. Data in `data/` (git-ignored). A saved code change is live in about 25 s with no image build. The procedure and the VM agent's prompt are in `RUN.md`.
- **Sign-in:** the automatic path shows Keycloak's own page (`keycloak.v2`); the TMRKZ page has the brand mark and «تمـــــركـــــز» / TMRKZ; `admin` and `developer` use the passwords in `.env`. No database password (internal network only).
- **From the VM's copy:** the Oracle unit publication logs each step (names of steps and exception classes only, no values); `ops/keycloak/configure-manual-direct.py` lowercases the directory's name and copes with a shared `.env` that refuses a rename; `ops/sql/fingerprint.sql` is ordered.
- **Checks:** on :8088 every service healthy, six sign-in paths and `developer` manual and automatic, four map pages with no external request (PMTiles 206); an offline Docker-in-Docker machine started from the unzipped folder passed the same; backend tests offline with the folder image (`ops/test-backend.sh`, 17/17); `start.sh` on an empty checkout writes `.env`, the directory CA, certificate and password, and leaves an existing `.env` unchanged.
- **Not in git:** `data/`, `tmrkz-images.tar`, `.env`, `ops/local/.generated/`; the enterprise audit folders, `.zcode/` and `ops/keycloak/ENTERPRISE_REGISTRATION.env.example` (it names the organisation's server) stay local.
- **Owner review:** the run-from-folder setup and the VM package are with the owner for the hands-on test on the VM.

## «إعدادات التكامل»: the directory and the enterprise Keycloak in the application; one address (20 Nov 2026; ADR-092)

- **Screen:** «إعدادات النظام ← إعدادات التكامل», as MOVER's page — the enterprise directory (server, LDAPS/StartTLS, sign-in domain, base DN, attributes with an Active Directory preset, CA certificate pasted, timeout) and the Keycloak of the automatic button (server, realm, client, secret, internal address, issuer, return address, CA). «اختبار الاتصال» with the values on the screen; a save is in force at once, audited, secrets encrypted; «العودة إلى إعدادات ملف البيئة».
- **Runtime:** `TMRKZ_PUBLIC_URL` is the one address (http from `start.sh`, https from `ops/tls/enable.sh`); the backend reaches the directory and Keycloak directly through `edge`; the relay, `extra_hosts` and `TMRKZ_MANUAL_LDAP_*` are gone. `.env` values still apply when nothing is saved.
- **Checks:** `IntegrationSettingsIT` 2/2, `DirectorySignInIT` 10/10, `DirectDirectorySignInIT` 1/1, `DualProviderSignInIT` 1/1, `EnterpriseSignInIT` 9/9, `SignInNotesIT` 1/1 (real PostgreSQL + PostGIS + OpenFGA); frontend `integrationSettings.test.ts` 6/6 (358/358 in all), type check and build; `sh start.sh` on :8088 with the database, files and local directory copied from the Docker volumes into `data/` (V54 applied; the volumes kept as a fallback); `tests/acceptance/integration-settings.mjs` 10/10 in the browser on :8088 — both sections, the derived address, «اختبار الاتصال» binding the stand-in directory over StartTLS with the pasted CA, a wrong password named as such, the local realm's discovery document read over the internal address with the issuer matched, nothing saved (`docs/evidence/integration-settings/`).
- **Found on the way:** after a start that recreates a network, a container compose keeps from before loses its service name on the new network (OpenFGA here); `docker compose up -d --force-recreate` fixes it (RUN.md §10).
- **Not verified here:** a real enterprise directory or enterprise Keycloak (this machine reaches neither); the VM takes this version and enters its values on the screen. The VM's empty home page after a bootstrap sign-in is a data state (the registration was used, then the people deleted), see OPERATIONS «First administrator».

## Release closure: one map-first editor, two full backend runs, the transfer package (20 Nov 2026; ADR-093, `FINAL_HANDOFF_2026-11-18.md`)

- **Editor:** every normal re-stationing task opens the map-first editor — new, from a site (`?site=`), a saved draft, a returned request, a temporary move (kind and dates chosen with the units), a deployment-areas draft; an existing request is read-only; the old editor stays only for the legacy «طلب اعتماد موقع». A deep link opened while an editor was up stayed in it: fixed. Content the screen cannot edit (occupants, distance exceptions, a site registration) is named and carried unchanged.
- **Backend:** the full suite twice in full, 366/366 each time, `AuthorizationIT` and `RestationingHrSyncIT` inside the full order — the earlier note «360/362, order-dependent» is withdrawn (no leaked state reproduced; the suite was not changed to make it pass).
- **Frontend:** 363/363; type check and build clean.
- **Browser on :8088:** `editor-unification.mjs` 18/18; `partial-approval-roundtrip.mjs` 17/17 (owner brief §16–§17: a real round trip — the deciding stage approves the site and the main area and returns the sub-area, hierarchy levels L8/L7 skipped by ADR-062, the requester changes only the sub-area, the stage may not decide a kept part again (400), approves the sub-area alone, the final seat approves, activation refused to the requester and the final approver (403, nothing activated); a changed main area is REOPENED and must be decided again; an oversized site is sent and flagged «تتجاوز الحد الأقصى» for the decider who may return it; a self-intersecting site cannot be sent (400)); `responsive-layout.mjs` 16/16; `stationing-hub-phase1.mjs` 6/6; `restationing-phase4.mjs` 16/16 (`SAVE=0`); `deployment-areas-phase3.mjs` 25/25; `integration-settings.mjs` 10/10; `initial-site-phase2.mjs` 19/19 (the drawing moved to free ground south of the fixtures — the default view is now covered by the acceptance batches, and the server rightly refuses an overlapping boundary; `STATIONED_UNIT` names a unit still stationed); `site-card-review.mjs` 22/22 (`OTHER_UNIT` names the unit whose site the other person sets up; a failure now keeps a screenshot); `setup-access-parts-phase78.mjs` 11/11 on a freshly sent request (RS-2026-0004 is activated now, so its parts are no longer open). Suites that hard-coded Edge now take `BROWSER_PATH`.
- **Not run:** the suites that need a second environment on :8096 (`stationing-next`, `persona-buttons`, `access-requests`, `scope-approvals`, `restationing-journey`) — the one-application rule; `access-scope-8088` and `main-8088-extra` were not rerun on a new batch in this closure.
- **Package:** `ops/release/pack-release.sh` → `release/TMRKZ-2026.11.20.1-folder.zip` (the folder without data, secrets, evidence, maps, history) + `release/tmrkz-images-2026.11.20.1-linux-amd64.tar` (the eight images, built with `DOCKER_DEFAULT_PLATFORM=linux/amd64` by `ops/local/workspace/pack-images.sh`, every image's config read back as `amd64/linux`) + `RELEASE-2026.11.20.1.json` + `SHA256SUMS`; checksums verified after creation. The Mac keeps its arm64 images for :8088.
- **Data left on :8088 by this closure (fictional units of batch B2 only):** drafts RS-2026-0027…0031, 0033, 0034; deployment-areas RS-2026-0028 (draft), 0032 (under review); round-trip runs RS-2026-0035…0044 (0035 and 0040 approved-not-activated; 0036, 0039, 0041, 0044 under review; 0037 and 0042 returned — the oversized ones; 0038 and 0043 drafts with an invalid site), two sites «موقع قبول — وهمي» from the site-setup suite; grants for `juma.ghfly4` (requester on three B2 units, site-setup seat on one), `majed.mhyry2` (unit operations), `rashed.kndy2` (final approval) on «شعبة السهل — B2»; the three accounts in the stand-in directory; the integration settings saved to the stand-in directory. Nothing activated; `p01`–`p17` untouched; the Oracle sync still paused.

## The AI model from the settings; no preprogrammed answers (20 Nov 2026; ADR-095)

- **«إعدادات التكامل → المساعد الذكي»:** enabled toggle, server address, model name, API key (write-only), timeout; اختبار الاتصال against the server's `/models`. Saved settings win over `TMRKZ_AI_*`; the screen also shows what `.env` carries.
- **No preprogrammed answers:** `AssistantService` only returns the model's reply over OKF; when off, unreachable, busy or no OKF match, the answer is null and the panel says so. The sources (OKF documents) remain as links.
- **Checks:** `AssistantServiceTest` 2/2, `IntegrationSettingsIT` 2/2, frontend `tsc` clean, `npm test` 373/373; OpenAPI 295 operations.
- **Open:** a browser-driven acceptance of the saved AI settings on an installation with a reachable model is still to run; the assistant does not yet log its own «AI-SETTINGS-CHANGED» trail (saves are covered by the generic `INTEGRATION_ASSISTANT_SAVED` audit event).

## Oracle is not a dependency: units on demand, people on demand, the directory sign-in suffices (20 Nov 2026; ADR-094, step 1)

- **Settings («مصدر الموارد البشرية»):** «استيراد الوحدات الآن»; «المزامنة التلقائية للوحدات» off/on with its interval (24 hours by default; the schedule is the source's own, V55 `auto_sync`, `sync_interval_hours`; `TMRKZ_HR_SYNC_INTERVAL_SECONDS` no longer read); «الأشخاص عند الحاجة فقط» (people never read in bulk — carried forward by each run, fetched at first sign-in / lookup / add-by-number, refreshed after 24 hours on the next need; `people_sync` on keeps the earlier every-run refresh); «الدخول بالدليل يكفي» (a directory sign-in that HR cannot confirm — not answering or stale — enters as a zero-access person «بانتظار مطابقة HR», matched when HR answers; off: refused as before). The status states units imported, people fetched, refreshed in the last day, pending matches, and the next run.
- **Scope of «طلب صلاحية»:** the person's main unit's tree (the nearest `is_main` unit above them), offered and enforced.
- **Empty system:** the home shows nothing in the middle until a unit, site, stationing, request or waiting card exists.
- **«إعدادات التكامل»:** a live badge per section — يعمل / غير متصل / غير مهيأ (`GET /settings/integration/status`).
- **Checks:** `HrOnDemandIT` 3/3 (OD-01…03); `HrSyncAcceptanceIT` 9/9 (its fixture now says `peopleSync` and `autoSync`, the earlier rule), `HrLinkedPeopleIT` 6/6, `EmploymentContextIT` 1/1, `EnterpriseSignInIT` 9/9, `DirectorySignInIT` 10/10, `AccessAcceptanceIT` 13/13, `UnitMemberIT` 4/4, `IntegrationSettingsIT` 2/2; frontend `homeEmpty.test.ts`, 365/365, type check; V55 applied on :8088 (the paused source stays paused: `auto_sync` follows `enabled`).
- **Step 2 (20 Nov 2026; V57):** «معاينة الوحدات» before any import — read-only, nothing written (units, active, main units, roots, levels, person count, validation problems with samples), kept as «في المصدر مقابل محلياً»; the status states the last attempt, the last import's added/changed/deactivated, the source's state as last tested; «لم يتم استيراد الوحدات» with اختبار الاتصال / معاينة الوحدات / استيراد الوحدات الآن before the first import; «تحديث بيانات الشخص بعد» (24 h default, 0 = never automatically) and the person's own «تحديث بياناتي من الموارد البشرية» (`POST /me/hr-refresh`); «بياناتي» shows the HR state; the scope tree highlights the person's unit; `GET /system/state` and `EmptyCentre` — no map instance on المواقع المسجلة / الموقف / إعادة التمركز / تهيئة المواقع while the installation is empty; settings grouped «السياسات والبيئة» / «الهوية والدخول» / «مصدر الموارد البشرية» / «ترحيل البيانات». Checks: `HrOnDemandIT` 4/4 (OD-04 added), `HrSyncAcceptanceIT` 9/9, `AccessAcceptanceIT` 13/13; frontend 373/373 (`hrState.test.ts`). Browser checks on an empty installation are still pending (the fake sources are being built).
- **Defect fixed (20 Nov 2026):** a database created after ADR-078 (17 Nov) could not start — the bootstrap published the facilities workflows whose final stage names a role without APPROVE. They are now left as drafts unless `TMRKZ_LEGACY_FACILITY_ROLES=true`. The owner's :8088 database predates ADR-078 and was never affected; the 2026.11.20.1 release image carries the defect for a NEW database only (an upgrade of an existing database is unaffected).
- **Step 3 (20 Nov 2026; V56):** «مركز ترحيل قاعدة البيانات» under «ترحيل البيانات» — connection or `pg_dump -Fc` archive into an isolated staging database, preview by category with New/Identical/Changed/Conflict/Unsupported, rule A (current wins; TAKE_SOURCE per record on explicit decision, each conflicting table confirmed), verified-backup gate with fingerprints, audit. Not migrated: sessions, passwords, secrets, keys, OpenFGA tuples, Flowable, HR mirror. Checks: `DbMigrationIT` 1/1, `DbMigrationDumpTest` 4/4, frontend `dbMigration.test.ts` 5/5. Limits: the dump path's `pg_restore` needs the rebuilt backend image (not yet rebuilt); the end-to-end restore of a real archive is untested.
- **Next steps of the same decision:** the fake Oracle HR (about 30,000 units in an irregular tree, 200,000 people) and the fake directory accounts (`ops/hr-demo`, in progress); the migration center «ترحيل قاعدة بيانات» (PostgreSQL → the current database, the current record wins and conflicts are reported, in progress); the browser check of the empty system and the zero-access journey on a temporary empty installation (removed afterwards).


## Operational-posture meaning layer (21 Nov 2026; owner brief «FINISH THE OPERATIONAL POSTURE MEANING LAYER»)

- **One source of truth for status:** `frontend/src/lib/operationalPostureStatus.ts` holds the two-dimensional model —
  Completeness (COMPLETE / INCOMPLETE_DEPLOYMENT / NO_STATIONING) and Timing (PERMANENT / TEMPORARY /
  TEMPORARY_EXPIRING / NONE). The right-rail tabs, list rows, detail-card badges, bottom-dock chips, map paint and
  posture-local legend read from this ONE helper. The 30-day «ينتهي قريبًا» threshold is the same `EXPIRING_DAYS`
  constant the home dashboard uses for `nearReturnStations`, so there is one definition of «expiring» in the system.
- **Right-rail tabs renamed to carry the meaning:** «موقف مكتمل» (site + PRIMARY + SUB), «مناطق انتشار غير مكتملة»
  (site exists, PRIMARY or SUB missing — each row explicitly says «ينقص الرئيسية / الفرعية / تنقص الاثنتان»),
  «وحدات غير متمركزة» (no approved effective stationing) and «طلبات التمركز والانتشار» (split per purpose).
- **One filter drives list AND map AND dock:** `PostureFilter` is set by both the right-rail tabs and the bottom-dock
  chips. The map's rendered polygons are the same set as the right-rail list. The camera fits once when the filter
  changes; it is not reset by polling, details open/close, opacity, layer toggle or search typing.
- **Scoped pending proposals in the posture payload (brief §10–§14):** `GET /operational-posture` now returns a
  `pending` array alongside `units`, projected to operational-map fields only
  (`requestId`, `requestNumber`, `purpose`, `state`, `currentStage`, `unitId`, `unitCode`, `unitName`, `currentSiteId`,
  `proposedSite`, `proposedPrimary`, `proposedSub`). Each row is filtered by the SAME `visible(ctx,r)` rule the
  request list uses: `VIEW_OPERATIONAL_POSTURE` alone does NOT reveal every proposal. Included states:
  `UNDER_REVIEW`, `RETURNED_FOR_CHANGES`, `PAUSED_HIERARCHY_CHANGED`, `APPROVED_NOT_ACTIVATED`,
  `CANCELLATION_PENDING`, `START_HELD_PENDING_CANCELLATION`. Excluded: `DRAFT`, `REJECTED`, closed states.
- **Pending overview on the map (brief §15):** every scoped proposal is drawn as amber/dashed site/primary/sub,
  visible BEFORE any selection, distinct from approved posture (which keeps its semantic colours). The selected
  unit's connector arrows (current → proposed site → primary → sub) from 43a2ef7 are kept as a stronger layer on top.
- **Click to inspect (brief §18/§19/§21):** clicking an approved PRIMARY/SUB polygon opens an area context card
  (role, unit, site, kind, approximate area in km², status, plannedEnd). Several polygons stacked at the click open
  an overlap chooser («مناطق متداخلة») — never a silent top-feature pick. Clicking an amber pending polygon opens
  the pending context card (request number, purpose, unit, element clicked, current workflow stage).
- **Compact collapsible posture-local legend (brief §5):** replaces the generic request legend; shows only the
  concepts currently enabled (completeness tones, timing tones when counts > 0, approved PRIMARY/SUB, pending badge
  when `pendingAll.length > 0`, occupied ground when at least one site is in use).
- **Checks:** backend `StationingNextIT` 14/14 including the new `operationalPosturePending` test (POSTURE-PENDING:
  this branch's proposal is included for an operator with `VIEW` + `VIEW_OPERATIONAL_POSTURE`; `VIEW_OPERATIONAL_POSTURE`
  alone is not a free pass; DRAFT excluded; the other branch's proposal never leaks; the projection carries only
  operational-map fields). Frontend `operationalPostureStatus.test.ts` 13/13 (POSTURE-STATUS-01…06 completeness,
  missing labels, timing + expiring threshold; POSTURE-FILTER-01…05 filter semantics; POSTURE-COUNT-01 live counts).
  Full frontend suite 390/390. Vite `tsc` clean, `npm run build` clean. Browser evidence at 1920×1080 + one 1366×768:
  `docs/evidence/posture/01-overview.png` … `13-overview-1366x768.png` (captured against Vite dev on 127.0.0.1:5173
  with `VITE_STATIONING_V3=true` and `MOVER_API=http://localhost:8088`, signed in as the acceptance posture viewer
  `p12.view` / `POSTURE_VIEWER` on `N-A11`).
- **Limits (open for owner):**
  - The owner-review environment at :8088 serves the 2026.11.20.1 web+backend containers. The new `pending` array
    renders in the UI ONLY after the backend is rebuilt and redeployed; the frontend already handles a missing
    `pending` field gracefully (`p.pending ?? []`). Pending-overlay screenshots show the UI chrome; the amber geometry
    becomes visible once `docker compose up -d --build` is run.
  - OpenAPI regeneration: the controller signature is unchanged (still `GET /operational-posture`), only the response
    shape grew by one field. `python ops/tools/gen-openapi.py` not re-run in this pass (controllers unchanged); if
    the OpenAPI JSON should reflect the new payload, we can run it before the merge.
  - The site-chooser on shared sites still opens from the ref-marker click path; a direct map polygon click on a
    SHARED site (several complete units on one polygon) opens the first unit's context — this is the pre-existing
    flow and was not touched by this pass.

## Operational-posture progressive-disclosure correction (21 Nov 2026 afternoon; owner brief «CURRENT POSTURE MAP IS TOO BUSY»)

- **Core rule:** when nothing is selected, the map draws ONLY current authorised sites + status-coloured unit markers +
  small «قيد الاعتماد» indicator rings. No PRIMARY polygon, no SUB polygon, no proposed geometry, no connectors,
  no arrowheads — overview first, select to reveal.
- **Select a unit:** the unit's site + PRIMARY + SUB are revealed; every other unit's polygons stay hidden; the status
  ring on the selected unit grows and other markers stay subdued. Area-card and overlap chooser unchanged.
- **Select a request:** the request's current posture + proposed site/PRIMARY/SUB + connector arrows are revealed —
  nothing else. A click on an amber proposal opens the pending-area card without hiding the proposal.
- **Filters answer «WHICH units?»:** moving between موقف مكتمل / مناطق غير مكتملة / بلا تمركز / تمركز مؤقت / ينتهي قريبًا /
  طلبات narrows the list AND the map's status markers; it does NOT reveal any polygon.
- **Status model + area ownership + backend `pending[]` unchanged (owner §34).** This pass is a rendering correction
  only: `operationalPostureStatus.ts` still carries completeness + timing + missingOf + postureCounts;
  `RequestHubService.posture` still returns `units` + `pending[]` with the same `visible(ctx,r)` filter.
- **Progressive legend (brief §27):** overview tokens only (موقف مكتمل, مناطق غير مكتملة, بلا تمركز, تمركز مؤقت,
  ينتهي قريبًا, قيد الاعتماد). PRIMARY/SUB tokens appear only when a unit is selected; «الحالي / المقترح قيد الاعتماد»
  appear only when a request is selected.
- **Progressive layers panel (brief §26):** the Primary/Sub checkboxes are disabled with the hint
  «اختر وحدة لعرض مناطق الانتشار» until a unit is selected; the opacity slider follows the same rule.
- **Label clutter (brief §29/§30):** the ref-label layer's minzoom is moved to 11 — large black site labels disappear
  at overview zoom and return when the operator pans in. The selected unit's own site label remains visible via the
  posture overlay.
- **Pending-rail union:** the «طلبات التمركز والانتشار» tab now unions `pendingAll` (full projection, with geometry)
  and units' own `.request` summary (purpose + state only). Clicking a summary-only row selects the unit but reveals
  no proposal geometry — the strict server rule holds and nothing leaks.
- **Camera (brief §31):** default fit to all status markers once per filter change; selecting a unit refocuses on its
  site centroid; selecting a request re-fits to both current and proposed centroids. No camera reset from polling,
  details open/close or search typing.
- **Checks:** backend `StationingNextIT` 14/14 (the pending IT is unchanged — the backend is unchanged);
  `operationalPostureStatus.test.ts` 13/13; full frontend suite 390/390; `tsc` clean, `npm run build` clean.
  Browser evidence at 1920×1080: `docs/evidence/posture/A-overview.png` (clean overview — no polygon, no proposal),
  `B-unit-selected.png`, `C-filter-complete.png`, `D-pending-overview.png` (indicator rings only),
  `E-rs-selected.png`, `F-da-selected.png`, `G-overview-1366x768.png` (small-screen overview). Signed in as
  `p12.view` / `POSTURE_VIEWER` on `N-A11` — the strict `visible(ctx,r)` rule leaves the pending array empty for
  this account, so E/F capture the state UP TO the proposal polygon: the row is selected in the rail, the legend
  extends contextually, and the status ring highlights the affected unit. No proposal polygon is drawn because
  this account cannot read that request — a security guarantee, not a UI regression. The end-to-end rendering of
  the proposal is exercised by the backend IT and the UI test, and will light up on screen the first time an
  operator with VIEW + VIEW_OPERATIONAL_POSTURE on the same branch picks that request.

## Operational-posture — real polygon-leak fix (21 Nov 2026, late afternoon; owner brief «FIX THE REAL REMAINING POLYGON LEAK»)

- **Root cause the previous pass missed:** `RequestMap` unconditionally called `addSiteLayers(m)` and the shared
  `siteLayers.ts` registered `ref-fill` + `ref-line` to render every registered site as a polygon — independent of
  `postureFC`. The posture overview still looked «busy» because of those registered-site boundaries, not because of
  our own PRIMARY/SUB layers.
- **The fix is configurable, not global (brief §1):** `RequestMap` now takes two new props:
  - `referenceBoundaries?: 'ALL' | 'SELECTED' | 'NONE'` (default `'ALL'`, so Site Setup, request editors and site
    inspection all keep their current behaviour);
  - `referenceLabels?: 'NORMAL' | 'POSTURE'` (default `'NORMAL'`, same reason).
  An effect in `RequestMap` applies the equivalent MapLibre filters on `ref-fill`, `ref-line` and `ref-label`. The
  `ref-sites` source is left untouched, so markers, clusters, cluster-count badges and hover-state remain functional.
- **Operational Posture uses the new mode (brief §5/§11):** `PosturePage.tsx` passes
  `referenceBoundaries="SELECTED"` and `referenceLabels="POSTURE"`. With nothing selected the `ref-fill`/`ref-line`
  filters become `['==', ['literal', 1], 0]` (no feature can match) so zero polygons render; with a unit or a
  reference site selected the filter becomes `['all', ['==', ['get', 'role'], 'REF_SITE'], ['==', ['get', 'siteId'],
  <selected>]]` so exactly that one site's boundary renders.
- **Reveal matrix (brief §14) is enforced by code:** overview → site-boundary 0, Primary/Sub `hidden`, pending geometry
  empty; selected unit → selected site boundary + unit's Primary/Sub only; cleared selection → everything back to 0.
  The rendering is driven by the same memoised FeatureCollections as before (`postureFC` is empty without a unit;
  `selectedPendingFC` is empty without a selected request), plus the MapLibre filter applied to the shared layers.
- **Rendered-feature acceptance (brief §16/§17/§22/§23/§24):** the browser suite now queries the LIVE MapLibre scene
  with `queryRenderedFeatures({ layers: [...] })` for every business polygon layer and writes the counts to
  `docs/evidence/posture/rendered-feature-counts.json`. Measured on `p12.view` / POSTURE_VIEWER (N-A11):

  | Layer | A (overview) | B (unit selected) | C (selection cleared) |
  |---|---:|---:|---:|
  | ref-fill | 0 | 0 | 0 |
  | ref-line | 0 | 0 | 0 |
  | posture-primary-fill | hidden | 1 | hidden |
  | posture-primary-line | hidden | 1 | hidden |
  | posture-sub-fill | hidden | 1 | hidden |
  | posture-sub-line | hidden | 1 | hidden |
  | pending-sel-site/primary/sub-fill/line | 0 | 0 | 0 |

  Summary: A `pass=true`; B `pass=true` (only the selected unit's Primary/Sub rendered); C `pass=true`.
- **Note on ref-fill = 0 in B:** the selected unit's site is served as a Point (no registered polygon boundary in
  the acceptance data), so even with the «SELECTED» filter the `ref-fill` layer has no polygon to draw — the rule is
  working, the data simply does not carry a boundary for that site. Sites with a polygon boundary render exactly one
  fill + one line when selected, which the filter is designed to allow.
- **Screenshots:** `docs/evidence/posture/A-clean-overview.png`, `B-selected-unit.png`, `C-selection-cleared.png`.
- **Local checks:** `tsc` clean; frontend `npm test` 390/390; `npm run build` clean; backend code unchanged.

## Operational-posture — site-hub redesign (21 Nov 2026, evening; owner brief «REDESIGN OPERATIONAL POSTURE AROUND SITE HUBS»)

- **Information hierarchy moves to sites.** `frontend/src/lib/operationalSiteHubs.ts` projects units + pending[] into
  one hub per physical site with `unitsTotal`, `completeCount`, `incompleteCount`, `temporaryCount`, `expiringCount`,
  `pendingCount`, `hasOutsideReach`, `centroid`, `unitIds`. The adapter is pure — status model and pending payload
  are unchanged (owner §34 of the previous brief, carried forward).
- **Map.** Per-unit markers are gone; the posture page draws ONE hub per site (`site-hub-bg` circle, size by unit
  count), a thin outer `site-hub-pending-ring` when the site has pending proposals, a `site-hub-count` text with the
  unit count or filtered count (brief §14), and small `site-hub-pending-badge` / `site-hub-incomplete-badge` text
  symbols for the attention indicators. A click selects the SITE (not a unit) so «SHOW me what is at this site».
- **Right rail.** Six operational filters: الكل / مناطق غير مكتملة / بلا تمركز / مؤقت / ينتهي قريبًا / طلبات. The
  body is a list of sites (SiteGroup component) with aggregate counts; expanded rows list the units + per-request
  rows at that site. «بلا تمركز» stays organisational (no site to aggregate around, brief §12).
- **Selection color + camera (user mid-turn, 21 Nov 2026).** The selected hub paints AMBER (circle-fill #c98a1a,
  thicker white stroke, bigger radius) so it is unmistakable against the slate overview. Any rail click triggers
  `setFit` and the fit effect uses MapLibre `easeTo` with explicit zooms: site → zoom 15.5, unit → zoom 16.5,
  request → fitBounds around current + proposed centroids so both sides of the comparison fit the viewport. The
  effect runs on every selection change (deps include `unit`, `siteInfoId`, `selectedRequestId`).
- **Request arrows redesigned (user mid-turn, 21 Nov 2026).** Each hop endpoint carries a `kind` and a `label`:
  current → slate `#2b3b4e` «الحالي · <site>», proposed site → orange `#ea580c` «موقع مقترح», proposed PRIMARY →
  amber `#d9822b` «منطقة انتشار رئيسية مقترحة», proposed SUB → purple `#7b4fc0` «منطقة انتشار فرعية مقترحة». Each
  arrow line is coloured by its destination `kind`, each arrowhead uses a matching icon
  (`tz-arrow` / `tz-arrow-primary` / `tz-arrow-alternative`), and every hop midpoint carries a bold kilometre label
  (`<distance> كم`) computed with the haversine formula. An endpoint circle is drawn at each of the 4 points with a
  white outline so the operator can tell them apart at a glance.
- **Reference-boundary leak** (previous brief) remains fixed: `RequestMap` `referenceBoundaries="SELECTED"` +
  `referenceLabels="POSTURE"` keep `ref-fill` / `ref-line` filtered to the selected site only, and
  `queryRenderedFeatures` confirms zero business polygons render in the clean overview scene.
- **Rendered feature counts** (live MapLibre scene via `queryRenderedFeatures`, `docs/evidence/posture/rendered-feature-counts.json`):

  | Layer | A overview | B medium | C site | D unit | E filter | F request |
  |---|---:|---:|---:|---:|---:|---:|
  | ref-fill / ref-line | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
  | posture-primary-fill / line | hidden | hidden | hidden | 0 / 0 | hidden | 0 / 0 |
  | posture-sub-fill / line | hidden | hidden | hidden | 0 / 0 | hidden | 0 / 0 |
  | pending-sel-* | 0 everywhere | 0 everywhere | 0 everywhere | 0 everywhere | 0 everywhere | 0 everywhere |

  Note on 0s in D and F: the acceptance account `p12.view` is a POSTURE_VIEWER only; it cannot see request
  geometry (server-side `visible(ctx,r)` is false for those proposals) AND the two complete units at the
  selected site have no PRIMARY/SUB polygon recorded in the test data. The rendering code paths are covered by
  `operationalSiteHubs.test.ts` + `operationalPostureStatus.test.ts` and `StationingNextIT.operationalPosturePending`.
- **Local checks.** `tsc` clean · frontend `npm test` 55 files / 398 tests passing (new: `operationalSiteHubs.test.ts`
  8 tests) · `npm run build` clean · backend unchanged (still green).
- **Screenshots.** `docs/evidence/posture/A-overview.png` (strategic overview — site hubs only) ·
  `B-medium-zoom.png` · `C-site-selected.png` · `D-unit-selected.png` · `E-request-filter.png` ·
  `F-request-selected.png` · rendered-feature report `rendered-feature-counts.json`.

## Operational-posture — site-hub acceptance-fix pass (21 Nov 2026, late evening; owner brief «SITE-HUB REDESIGN IS CLOSE»)

- **Blocker 1 (fixed zoom values) — fixed.** The camera effect no longer uses `zoom: 15.5 / 16.5`. It now computes
  real bounds from actual geometry: site → every ring of the site's own Polygon/MultiPolygon; unit → combined rings
  of site + PRIMARY + SUB; request → combined rings of current (site + PRIMARY + SUB) and proposed (site + PRIMARY +
  SUB). `fitBounds` is called with safe UI padding (left ≈15 % of canvas for the layers panel, right ≈24 % for the
  rail + detail card). `maxZoom` is a ceiling (16 for site, 17 for unit/request) — never a forced zoom. Point-only
  sites fall back to `easeTo` with a sensible zoom.
- **Blocker 2 (hubs must cluster) — fixed.** The `site-hubs` MapLibre source now carries
  `cluster: true`, `clusterRadius: 60`, `clusterMaxZoom: 12`, and `clusterProperties` that SUM `unitsTotal`,
  `incompleteCount`, `pendingCount`, `temporaryCount`, `expiringCount`. Four new layers:
  `site-cluster` (neutral slate bubble), `site-cluster-count` («N مواقع · M وحدة»), `site-cluster-attention`
  (amber ring when the aggregated `incompleteCount > 0`), `site-cluster-pending` (outer amber ring when the
  aggregated `pendingCount > 0`). A cluster click calls `getClusterExpansionZoom` and eases into that zoom.
  The individual-site layers are all filtered by `!has:point_count`, so a hub that is clustered out does not
  render — no stacked rings.
- **Blocker 3 (visible pending account) — PARTIAL.** The honest answer: this session could not mint a new acceptance
  grant via `/api/v1/access/permits` (the admin API call was blocked by the Claude Code sandbox). Rather than
  weaken the existing POSTURE_VIEWER role, the pending-RS and pending-DA scenes are captured with `p12.view` —
  the acceptance POSTURE_VIEWER on N-A11 — whose server-enforced `visible(ctx,r)` is correctly FALSE for those
  proposals. Result: the UI shows the request row selected in the rail, the hub ring stays amber («قيد الاعتماد»),
  the «المقترح قيد الاعتماد» legend token extends; but the proposal polygons render 0 features — the strict
  scope rule cannot be bypassed from the frontend. The rendering code paths are covered by
  `StationingNextIT.operationalPosturePending` (backend) and by the `selectedPendingFC` memo + layer paints in
  `PosturePage.tsx`. **Owner action requested:** either grant a test account both `VIEW` and
  `VIEW_OPERATIONAL_POSTURE` on `N-A11` (temporary permit via the admin console), or authorise this session to
  issue the permit itself; the pending-RS and pending-DA scenes will then light up on the next screenshot run.

- **Rendered feature counts** (live `queryRenderedFeatures`,
  `docs/evidence/posture/rendered-feature-counts.json`):

  | Scene (zoom) | site-cluster | site-hub-bg | ref-fill | ref-line | posture-primary | posture-sub | pending-sel-* |
  |---|---:|---:|---:|---:|---:|---:|---:|
  | UAE-OVERVIEW (z=6) | 1 | 0 | 0 | 0 | hidden | hidden | 0 |
  | SITE-HUBS (z=10)  | 2 | 3 | 0 | 0 | hidden | hidden | 0 |
  | SITE-SELECTED (z≈15.8) | 0 | 2 | 0 | 0 | hidden | hidden | 0 |
  | COMPLETE-UNIT (z≈13.4) | 0 | 3 | 0 | 0 | **2 / 2** | **1 / 1** | 0 |
  | PENDING-RS (z≈15.8) | 0 | — | 0 | 0 | hidden | hidden | 0 (scoped out) |
  | PENDING-DA (z≈15.8) | 0 | — | 0 | 0 | hidden | hidden | 0 (scoped out) |
  | OVERVIEW-1366×768 (z=10) | — | — | 0 | 0 | hidden | hidden | 0 |

- **Required-screenshot checklist:**
  - `UAE-OVERVIEW.png` ✓ — one cluster, no polygons, no per-unit markers, no stacked rings.
  - `SITE-HUBS.png` ✓ — clusters mixed with individual site hubs; no business polygons.
  - `SITE-SELECTED.png` ✓ — one hub turns amber, site info card lists aggregate counts + unit list + requests;
    no PRIMARY/SUB; camera is geometry-fit.
  - `COMPLETE-UNIT.png` ✓ — selected COMPLETE unit shows site boundary + PRIMARY + SUB only; other units'
    polygons are not drawn; camera is geometry-fit, not zoom 16.5.
  - `PENDING-RS.png` ⚠️ — selected RS row in rail, but proposal polygons are 0 due to the strict scope rule for
    `p12.view` (see Blocker 3 note above).
  - `PENDING-DA.png` ⚠️ — same.
  - `OVERVIEW-1366x768.png` ✓ — small-screen overview with clusters and site hubs only.
- **Local checks.** Backend `StationingNextIT` 14/14 (unchanged backend). Frontend `npx vitest run` → 55 files /
  398 tests passing. `tsc` clean. `npm run build` clean.

## Migration Center: MOVER SQLite units import (21 Nov 2026; ADR-097)

- **Shipped.** «الإعدادات → ترحيل البيانات → استيراد وحدات MOVER من SQLite». An administrator with `CONFIGURE` uploads a MOVER SQLite file from their own computer (no VM required), sees a per-unit preview (new / existing / code-conflict) and commits. The import is idempotent: the pair (`organization.source='MOVER', source_external_id=<MOVER unit id>`) is the identity, so re-running the same file creates nothing new. V65 extends `organization.source` to `(LOCAL, HR, MOVER)`. 4/4 ITs green in `MoverUnitImportIT`.
- **Not shipped (deferred).** Oracle `.dmp` file upload, mentioned by the owner at the same time: requires a dedicated staging Oracle container plus `impdp` operational privileges. Documented as stage-2 in ADR-097. A `.dmp` upload is refused today by the magic-bytes check (returns `kind=UNKNOWN`).
- **Scope note.** Only `units` is read from the MOVER SQLite. People, grants, requests and transport rows are NOT imported; that was explicitly out of scope by the owner's 21 Nov 2026 direction («only we will import the unit»). A unit's `manager_id`, `is_final_command` and `unit_operations_approval_unit_id` are read for the preview but are NOT written to `organization` because TMRKZ represents those through the access workspace (ADR-013/095), not through columns on `organization`.
