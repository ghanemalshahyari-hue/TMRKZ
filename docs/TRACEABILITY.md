# MOVER — Requirements and acceptance traceability

Status: **Done** = implemented and verified by an automated test or script; **Done (UI)** = implemented in the
interface and verified by screen review; **Partial** = implemented with a stated gap; **Open** = waits for a named
decision. Backend tests live in `backend/src/test/java/ae/mover/*IT.java`; `journey` = `tests/acceptance/journey.mjs`.

## Requirements R-01 … R-40

| ID | Requirement | Where implemented | Verified by | Status |
|---|---|---|---|---|
| R-01 | Main/sub sites, stable ids, no cycles, no destructive delete | `V1__core_schema.sql` (`site_no_cycle`, `site_no_delete`), `SiteService.retire` | `AdministrationAcceptanceIT.siteTree`, `ReservationAcceptanceIT.fullJourney` | Done |
| R-02 | Organisation structure independent of sites | separate `organization` / `site` trees; `site_responsibility` history | schema; `AccessAcceptanceIT.transfer` | Done |
| R-03 | Many organisations ↔ many facilities over time | `reservation`, `site_responsibility` (dated, non-overlapping), `GET /sites/{id}` occupancy history | `ReservationAcceptanceIT` | Done |
| R-04 | Map and list linked, filters kept | `frontend/src/pages/MapPage.tsx` | screen review | Done (UI) |
| R-05 | Backgrounds only from available data | `MapService` serves installed packages only; caption says illustrative | `AdministrationAcceptanceIT.mapCoverage` | Done |
| R-06 | Works without internet | local font, Leaflet bundled, local map package, strict CSP | journey (AT-29 checks) | Done |
| R-07 | Local map packages with source/licence/coverage/version/date | `map-packages/*/manifest.json`, `map_package`, checksum verification | `mapCoverage` | Done |
| R-08 | Recorded coordinate reference | CRS label in manifest and `site_geometry_version` | — | Open (D-01) |
| R-09 | Permanent site, independent reservations | `reservation` references `resource`; site identity unchanged | `fullJourney` (AT-01) | Done |
| R-10 | Days/hours/continuous periods, time zone, half-open | `unit`, UTC storage, Asia/Dubai display, `[start,end)` ranges | `boundaries` (AT-12) | Done |
| R-11 | Request from map or list, same rules | single `POST /requests`, `origin` recorded | `mapAndListSameRules` (AT-02) | Done |
| R-12 | Configurable request scope (sites/organisations) | policy `multiSites`/`multiOrgs` + per-type flags, checked at submit | `RequestService.doSubmit` | Done |
| R-13 | Transfer, temporary occupancy, extension, modification, cancellation, evacuation | six request types; kinds applied in `DecisionService.finalizeApproval` | `changes`, `evacuation` | Done |
| R-14 | Configurable fields/attachments with restricted rules | `FormSchemas`, `RuleLanguage` (visibleWhen/requiredWhen, typed ops), `RuleEditor`, `FieldRulesDialog`, `FormService.evaluate` | `ruleLanguageRejectsCode`, `versionsArePinned`, `ruleTryIt`; browser RULES-01, RULES-02 | Done |
| R-15 | Published, immutable form versions | `form_version` + immutability trigger; draft → validate → publish | `versionsArePinned` (AT-13) | Done |
| R-16 | Pending request is not a reservation | reservations only in `finalizeApproval` | `fullJourney` (AT-03) | Done |
| R-17 | Reservation only after approval, atomically | shared Flowable/JDBC transaction | AT-09/10/11 | Done |
| R-18 | No overlapping active exclusive reservations | `reservation_lock` exclusion constraints | AT-10/12/36 | Done |
| R-19 | Explicit colours (orange pending, green approved, red reserved) | map/calendar layers | screen review | Done (UI) |
| R-20 | Routing by type/properties, previewable before publish | stage `condition` (typed rules), `POST /workflow-versions/{id}/simulate` | `versionsArePinned` | Done |
| R-21 | Sequence, parallel, conditions; ALL/ANY; final authority kept | `BpmnCompiler`, `WorkflowValidator` (final stage APPROVE-only, not conditional) | AT-06/07/08 | Done |
| R-22 | Running requests keep their workflow version | process definition id pinned at submission | `versionsArePinned` (AT-14) | Done |
| R-23 | Return/edit with reason; earlier revision kept; policy-driven re-approval | `DecisionService` (reason ≥ 5), `request_revision`, `carriedStages` | AT-05, AT-15 | Done |
| R-24 | Execution/receipt tasks with owners, conditions, due dates | `execution_task`, workflow `execution` templates | `fullJourney`, journey | Done |
| R-25 | Closing independent of reservation period | `ExecutionService.close` never touches reservations | `fullJourney` (AT-18), journey | Done |
| R-26 | Permissions by action and scope (organisation, site, resource relation) | `AccessContext`, scoped grants (`RawGrant.spec`, `membership_scope_target`), OpenFGA co-decision (ADR-018) | `AccessAcceptanceIT`, `AuthorizationIT` | Done |
| R-27 | Summary view without occupant data or attachments | `RequestViews` (fields absent), `SiteService`, reservations list | `summaryOnly` (AT-20) | Done |
| R-28 | View/edit/export/approve separated, server-side incl. files, search, updates | independent actions (`Permission`, `V2__independent_actions.sql`), per-endpoint checks, shared scope predicate | AT-19, AT-21, `independentActions` | Done |
| R-29 | Dated memberships and delegations | `membership`, `delegation`, evaluated per request | AT-22, AT-23 | Done |
| R-30 | Membership transfer re-aligns tasks with a record | role-pooled tasks + `TASKS_REALIGNED` audit | `transfer` (AT-22) | Done |
| R-31 | Signature with approval per D-02, no PKI mislabel | `SignatureService` (internal attestation), `ApprovalSigner` + `SigningJobs` (certificate + seal, ADR-020) | AT-09, AT-27, `SigningIT`, `ApprovalSignerTest` | Done (mechanism) — enterprise provider not connected |
| R-32 | Info copies after the final decision, per-recipient access check | `OutboxProcessor.notifyInfoRecipients` | `infoCopyAndOutbox` (AT-25) | Done |
| R-33 | Production audit trail, not editable through the API | `audit_event` + append-only triggers; read-only `GET /audit-events` | `auditImmutable` | Done |
| R-34 | Real attachments: content, checksum, scan, scope, versions | `AttachmentService`, `ContentInspector`, content-addressed `FileStore` | `attachments` (AT-34) | Done |
| R-35 | Integration contracts without fake connections | `IntegrationService` registry (measured status), org-structure file import, read-only HR mirror (ADR-014) | `structureImport` (AT-32), `HrSyncAcceptanceIT` | Partial — HR mirror implemented, enterprise Oracle not connected; identity and correspondence pending |
| R-36 | Indicators with definitions | `ReportService.kpis` | `reportsAreScoped` | Done |
| R-37 | 7,000 organisations / 200,000 people | synthetic dataset + exploratory load | `docs/PERFORMANCE.md` | Open (D-03) — exploratory only |
| R-38 | Isolated deployment, nothing fetched at run time | compose, `ops/airgap-bundle.sh`, CSP, local assets | journey (AT-29) | Done |
| R-39 | Backup and tested restore | `ops/backup.sh`, `ops/restore.sh`, `ops/verify-restore.sh` | AT-30 run | Done |
| R-40 | Documented requirements, decisions, tests, gaps | this file, `STATUS.md`, `ARCHITECTURE_DECISIONS.md` | — | Done |

## Acceptance tests AT-01 … AT-36

| AT | Test | Result |
|---|---|---|
| AT-01 | `ReservationAcceptanceIT.fullJourney` | Pass |
| AT-02 | `WorkflowAcceptanceIT.mapAndListSameRules` | Pass |
| AT-03 | `ReservationAcceptanceIT.fullJourney`; journey | Pass |
| AT-04 | `WorkflowAcceptanceIT.serverSideRequired` | Pass |
| AT-05 | `WorkflowAcceptanceIT.returnAndResubmit`; journey | Pass |
| AT-06 | `ReservationAcceptanceIT.fullJourney`; journey | Pass |
| AT-07 | `WorkflowAcceptanceIT.parallelStages` | Pass |
| AT-08 | `WorkflowAcceptanceIT.parallelStages` | Pass |
| AT-09 | `ReservationAcceptanceIT.fullJourney`; journey | Pass |
| AT-10 | `ReservationAcceptanceIT.concurrentApprovals` (two threads, one 200, one 409, no partial effects) | Pass |
| AT-11 | `ReservationAcceptanceIT.allOrNothing` | Pass |
| AT-12 | `ReservationAcceptanceIT.boundaries` (touching allowed; 60-min handover blocks) | Pass |
| AT-13 | `WorkflowAcceptanceIT.versionsArePinned` | Pass |
| AT-14 | `WorkflowAcceptanceIT.versionsArePinned` | Pass |
| AT-15 | `WorkflowAcceptanceIT.returnAndResubmit`, `restartStagesPolicy`; journey | Pass |
| AT-16 | `ReservationAcceptanceIT.changes` | Pass |
| AT-17 | `ReservationAcceptanceIT.changes`, `evacuation` | Pass |
| AT-18 | `ReservationAcceptanceIT.fullJourney`; journey | Pass |
| AT-19 | `AccessAcceptanceIT.outOfScope` | Pass |
| AT-20 | `AccessAcceptanceIT.summaryOnly` | Pass |
| AT-21 | `AccessAcceptanceIT.exportRight` (incl. right withdrawn after creation) | Pass |
| AT-22 | `AccessAcceptanceIT.transfer` | Pass |
| AT-23 | `AccessAcceptanceIT.delegationRevoked` (same session) | Pass |
| AT-24 | `AccessAcceptanceIT.requesterDecision` — revised by the owner decision of 2026-10-29: the requester may decide a stage only through a grant that satisfies it (recorded `by_requester`); without APPROVE they are refused | Pass |
| AT-25 | `AccessAcceptanceIT.infoCopyAndOutbox`; journey | Pass |
| AT-26 | `ReservationAcceptanceIT.idempotentApproval`; journey | Pass |
| AT-27 | `AdministrationAcceptanceIT.signatureProviderUnavailable`; constraint failures inside the transaction (AT-10/11) leave no trace | Pass (database crash mid-commit relies on PostgreSQL atomicity; not fault-injected) |
| AT-28 | `AccessAcceptanceIT.infoCopyAndOutbox` (event re-queued and re-processed) | Pass |
| AT-29 | journey: local assets, CSP without external origins, no fetchable external URLs, local font/map | Pass for the application; host egress blocking is an environment control (see INSTALL_AIRGAPPED) |
| AT-30 | `ops/verify-restore.sh` (clean project, 20 table fingerprints, attachment SHA-256) | Pass |
| AT-31 | `AdministrationAcceptanceIT.mapCoverage` | Pass |
| AT-32 | `AdministrationAcceptanceIT.structureImport` | Pass |
| AT-33 | `WorkflowAcceptanceIT.ruleLanguageRejectsCode` | Pass |
| AT-34 | `WorkflowAcceptanceIT.attachments` | Pass |
| AT-35 | `WorkflowAcceptanceIT.staleRevision` | Pass |
| AT-36 | `ReservationAcceptanceIT.parentChildScope` | Pass |


## Map workspace MAP-01 … MAP-19 (`docs/MAP_WORKSPACE_COMPLETION_AR.md` §8; MAP-19 from the owner continuation prompt §3)

History: the run of 29 Oct after the first on-site menu change had 17 pass / 5 fail (MAP-11, MAP-12a, MAP-12b, MAP-17,
MAP-19); causes fixed on 30 Oct (panel action list stuck on the type step, request drawer covering the panel,
marker focus lost on redraw, status banner over the zoom buttons, a harness date window reused every 200 minutes).
Current result: see the run recorded in `docs/evidence/map/results.json`.

Backend tests run on real PostgreSQL 17.11 + PostGIS 3.5 (`sh ops/test-backend.sh`). Browser tests drive Microsoft Edge
with clicks and the keyboard against the acceptance environment started without internet egress
(`sh ops/test-env/up-offline.sh && node tests/acceptance/map-workspace.mjs`); sign-in uses the real Keycloak page and the
manual directory path. The API is used there only to prepare data and cross-check the screen (listed separately in
`docs/evidence/map/results.json`). Run of 29 Oct 2026: backend 70/70, browser 21/21 checks, 0 external requests, 0 console
errors; screenshots in `docs/evidence/map/`.

| MAP | Scenario (short) | Code | Backend test | Browser check | Result | Notes |
|---|---|---|---|---|---|---|
| MAP-01 | A remote-branch organisation found by search and by the lazy tree filters the right authorised sites; no people are downloaded | `OrganizationService.roots/branchChildren/search/requireVisibleBranch`, `MapService.features` (`orgId`, relations), `OrgTree` | `MapWorkspaceAcceptanceIT.organisationBranchFilter` | MAP-01, MAP-01b | Pass | 4-level branch: one site (responsible); out-of-scope search empty; 0 `/people` calls |
| MAP-02 | Main site without parent, then a sub-site: selection, zoom, path and details stay in step | `SiteService.children/search/path`, `SiteTree`, `MapPage.select` | `MapWorkspaceAcceptanceIT.siteTreeAndPath` | MAP-02 | Pass | Ancestor outside scope shown as context only; marker focus + Enter selects |
| MAP-03 | A point-only site shows a marker and «حدود الموقع غير مسجلة», no generated polygon | V8 (legacy points stay points), `MapCanvas` (no shape from points), `SiteDetailPanel` | `MapWorkspaceAcceptanceIT.pointOnlySite` | MAP-03 | Pass | Dashed marker, no path for the site |
| MAP-04 | Irregular polygon and MultiPolygon imported, saved and reloaded: same boundary and version | `GeoInput` (GeoJSON, KML), `BoundaryService.preview/publish`, `ImportDialog` | `MapWorkspaceAcceptanceIT.importBoundaries` | MAP-04 | Pass | Stored coordinates equal the file; polygon with a hole and two-part MultiPolygon drawn after reload |
| MAP-05 | Unknown CRS, invalid geometry and undeclared formats: clear refusal, nothing published | `GeoInput.normaliseCrs/format`, `BoundaryService.checkClean` (PostGIS validity), whole-file rejection | `MapWorkspaceAcceptanceIT.importRejections` | MAP-05 | Pass | No CRS, EPSG:9999, latitude-first URN, self-intersection, UTM numbers declared as degrees, `.shp`, `.txt` |
| MAP-06 | Draw then cancel, edit vertices then save, two concurrent edits: no save on cancel, no overwrite | `BoundaryEditor` (Geoman Free, vertex table, undo, start over), `BoundaryService.save` (`GEOMETRY_STALE`) | `MapWorkspaceAcceptanceIT.drawEditConflict` | MAP-06 | Pass | Cancel leaves the version; click-drawing + table edit saves; stale save refused (409) |
| MAP-07 | Switch between two installed backgrounds; show/hide zones and labels independently; missing source stated | `MapPackageService`, `BackgroundPanel`, `LayersPanel`, `MapCanvas` panes | `MapWorkspaceAcceptanceIT.packageManager` | MAP-07a, MAP-07 | Pass | Regional road map and an uploaded, reviewed facility plan; «لم تثبت حزمة صور جوية» |
| MAP-08 | Viewport outside coverage and partly covered: message for the selected package, no substitute background | `MapService.coverage` (viewport, zoom, package) | `MapWorkspaceAcceptanceIT.coverage`, `AdministrationAcceptanceIT.mapCoverage` | MAP-08 | Pass | FULL / PARTIAL (≈74 %) / NONE / ZOOM_OUT_OF_RANGE / NO_PACKAGE |
| MAP-09 | Hours, days and open periods: map colours and API agree with known reservations at the boundaries | `MapService.period/locks` (half-open, handover), `periodQuery` | `MapWorkspaceAcceptanceIT.periodBoundaries` | MAP-09 | Pass | 12:00 after a booking ending 12:00 is free; handover extends; open period reaches later bookings |
| MAP-10 | Shared site with an exclusive sub-resource: one booking does not block an independent resource; partial occupancy shown | `MapService` resource states, PARTIAL, all occupants | `MapWorkspaceAcceptanceIT.sharedSitePartial` | MAP-10 | Pass | Exclusive room blocked, sibling free, shared use by two organisations |
| MAP-11 | A request started on the map keeps organisation, resources and period; returning to the map loses nothing | `WizardPrefill`, drawer layout, minimise, selection-change banner (`RequestWizard`) | `MapWorkspaceAcceptanceIT.mapRequestReview` | MAP-11 | Pass | New map selection shown as a difference and applied only on confirmation |
| MAP-12 | Submit, return and edit: under review without a final reservation; nothing hidden on cancel | `RequestService.doSubmit` (boundary snapshot), `RequestViews.boundaries`, review map | `MapWorkspaceAcceptanceIT.mapRequestReview` | MAP-12a, MAP-12b | Pass | No reservation or lock while under review; closing the drawer creates nothing |
| MAP-13 | Two concurrent approvals of conflicting exclusive requests: exactly one succeeds; the map follows the server | `DecisionService.finalizeApproval`, exclusion constraints (ADR-006) | `MapWorkspaceAcceptanceIT.concurrentApprovals`, AT-10 | MAP-13 | Pass | Two approvers click at once in two browsers; the other sees «تعذر تثبيت الحجز» |
| MAP-14 | Boundary edited after approval: the request and its document keep the original version, the map shows the new one | revision `boundaries`, `DecisionService.canonical` (boundaryVersions), `BoundaryService.pinned` | `MapWorkspaceAcceptanceIT.boundaryPinnedAfterApproval` | MAP-14 | Pass | Document and review show version N, map N+1 |
| MAP-15 | Summary viewer, facility manager and requester see nothing outside their scope in API, search, layers, counts or print | `MapService.requestViewer`, `SiteService`, `BoundaryService.export` (EXPORT), `MapService.check` (pending count) | `MapWorkspaceAcceptanceIT.roleScopes` | MAP-15 | Pass | Out-of-scope answers equal unknown ones; no request counts without full VIEW |
| MAP-16 | Slow, reversed or failed responses and a scope change: nothing stale shown as current; no forced re-zoom | `MapPage` (abort + sequence), neutral `UNKNOWN_STYLE`, `MapCanvas` (no fit on data), per-request access | `MapWorkspaceAcceptanceIT.scopeChangeInSession` | MAP-16 | Pass | Late answer never shown; failure → neutral; removed scope → site and details gone |
| MAP-17 | Phone width and keyboard: select and complete a request without dragging, hidden buttons or horizontal scrolling | `map.css` (single column, bottom-sheet drawer), focusable markers and trees | — | MAP-17 | Pass | 390×844; sign-in, selection, request and submission by keyboard |
| MAP-18 | Internet blocked with acceptance packages local: backgrounds, boundaries, request and review work | local packages, CSP, `compose.offline.yml` | — | MAP-18 (all steps) | Pass | 0 external browser requests; backend has no egress (`up-offline.sh`) |
| MAP-19 | Owner prompt §3: one click on a site opens two actions at the site; same command from tree, list and panel; type and resources handed over explicitly; nothing written | `SiteActionMenu`, `MapCanvas` (SiteHit, background click), `MapPage.startRequest`, `SiteRequestActions`, `RequestWizard` (no silent type/parent) | `MapWorkspaceAcceptanceIT.siteRequestActions` | MAP-19 | Pass (30 Oct) | Backend: published types, open-end rule, no-CREATE and no-resource reasons, 404 outside view, no rows written |

Scale (separate from the organisation tree volume): `MapScaleIT` — 10,000 sites with boundaries and 2,000 reservations;
see `docs/PERFORMANCE.md`. Migration from the earlier release: V7 acceptance data upgraded in place, 130/130 earlier rows
unchanged (`ops/upgrade-check.sh`, ADR-017).

## Administrative journey through the UI (owner brief of 30 Oct 2026 §11)

`node tests/acceptance/admin-journey.mjs` drives Microsoft Edge against the acceptance environment, each persona signed
in through the directory sign-in page; the API only cross-checks. Evidence: `docs/evidence/admin-journey/`.

| Check | Scenario | Code | Backend test | Result |
|---|---|---|---|---|
| J1 | Select a facility on the map, open the docked request, nothing written; repeated click → one request | `SiteActionMenu`, `RequestWizard` (docked), idempotent submit | `MapWorkspaceAcceptanceIT.siteRequestActions` | Pass |
| J2 | Completeness review returns for correction with a reason | `DecisionService` RETURN | `ReservationAcceptanceIT.administrativePath` | Pass |
| J3 | Requester corrects and resubmits under the same reference | `RequestWizard`, `RequestService.submit` | same | Pass |
| J4 | Reviewer sees what changed, refers for study | `RevisionChanges`, `RevisionChangesBlock`, `REFER` | same | Pass |
| J5 | Organisation stage refers to the final decision | workflow stages | same | Pass |
| J6 | Final rejection needs a reason; approval with attestation | `DecisionDialog`, `DecisionService` | same | Pass |
| J7 | Communication of the decision recorded with the document revision | `CommunicationService`, `CommunicationLog` | same | Pass |
| J8 | Handover, receipt, completion statement and closing under `CLOSE`; history retained | `ExecutionService.close`, `ClosureForm` | `ReservationAcceptanceIT.fullJourney/administrativePath` | Pass |
| J9 | Out-of-scope requester gets 404 for the request and its communications | `AccessContext`, `CommunicationService` | — | Pass |
| J10 | Draft kept across navigation to the register; closing without saving writes nothing | docked/minimised wizard | — | Pass |
| J11 | Phone: tapping a facility opens a bottom sheet with both actions on screen | `SiteActionMenu` sheet | — | Pass |
| J12 | Ring around the site, «نقل المقر», new location drawn on the map, request submitted, site register unchanged (ADR-023) | `SiteActionMenu` ring, `RelocationPanel`, `RelocationService` | `ReservationAcceptanceIT.relocationRequest` | Pass |

## Production acceptance PA-01 … PA-30 (`docs/ADMIN_PRODUCTION_IMPLEMENTATION_PROMPT_AR.md` §15)

Matrix: requirement → code → test → result → evidence → remaining limit. «Blocked» names the enterprise input that
is missing; nothing is simulated as connected. Evidence lists the command whose output was observed.

| PA | Requirement (short) | Code | Test | Result | Evidence | Remaining limit |
|---|---|---|---|---|---|---|
| PA-01 | Oracle read with the TNQL contract, no DML/DDL | `HrSourceAdapter` (read-only transaction, metadata, streamed SELECT), `HrConnectionFactory` | `HrSyncAcceptanceIT.readOnlyContract` | Pass (fictional views, SELECT-only role) | `sh ops/test-backend.sh` | Enterprise Oracle not connected: needs address, read-only account, DB version |
| PA-02 | Incompatible metadata/mapping refused without guessing | `HrMapping.metadataProblems/compile`, `HrAdminService.publish` | `HrSyncAcceptanceIT.contractMismatch` | Pass | `sh ops/test-backend.sh` | — |
| PA-03 | Full sync, then partial/empty/large-drop result keeps the valid copy | `HrSyncService.protect/discard`, staging snapshots | `HrSyncAcceptanceIT.protections` | Pass | `sh ops/test-backend.sh` | — |
| PA-04 | No overlapping runs, safe resume, hourly schedule | advisory lock, `recoverInterrupted`, `@Scheduled` 3600 s | `HrSyncAcceptanceIT.noOverlap` | Pass | `sh ops/test-backend.sh` | — |
| PA-05 | Stable organisation/person identity across rename and transfer | `HrProjection` (match by source id), `affiliation` | `HrSyncAcceptanceIT.identityAndLocalAdditions` | Pass | `sh ops/test-backend.sh` | — |
| PA-06 | Original HR fields not editable; local additions survive sync | V3 triggers `*_hr_read_only`, `local_metadata` | `HrSyncAcceptanceIT.identityAndLocalAdditions` | Pass | `sh ops/test-backend.sh` | — |
| PA-07 | LDAP right/wrong/down, untrusted TLS, no demo fallback | `DirectoryAuthenticator`, `LoginThrottle`, `OidcClient` (auth_time with max_age), `IdentityService`, Keycloak realm (LDAP READ_ONLY, StartTLS, truststore) | `DirectorySignInIT` (right/wrong/unknown/empty password, throttling, ambiguity, untrusted CA, step-up, bootstrap); `EnterpriseSignInIT` (forged/replayed tokens, auth_time missing/old/future/pre-step-up, linking, no local or demo sign-in); journey (both paths against Keycloak + OpenLDAP); `check-untrusted-tls.sh`; `clean-install.sh` | Pass (test directory) | `sh ops/test-backend.sh`; `node tests/acceptance/journey.mjs`; `sh ops/test-env/check-untrusted-tls.sh`; `sh ops/test-env/clean-install.sh` | Enterprise LDAP, bind account and CA not yet provided |
| PA-08 | Withdrawn membership/delegation blocks the next action, export and attachments | `AccessService.load` per request; step-up before approval; outbox triggers + `AuthzSync` (per-actor freshness before sensitive actions), validity windows as OpenFGA conditions | AT-21, AT-23, `EnterpriseSignInIT.noLocalSignInAndStepUp`, `AuthorizationIT.revocationInSession` (same session refused; tuples removed; OpenFGA refuses) | Pass | `sh ops/test-backend.sh` | — |
| PA-09 | Tasks move to a single substitute; ambiguous cases go to the access manager | `TaskRealignment` (sole holder assigned; none or several → access-manager choice; keyset pages, no cap), V6 assignment columns, `/task-reassignments` | `HrSyncAcceptanceIT.transferRealignsTasks`, `soleSubstituteAmongManyCandidates` (2,100 out-of-scope holders), `severalCandidatesGoToAccessManager` | Pass | `sh ops/test-backend.sh` | — |
| PA-10 | View without edit, edit without approve, administration without content | `Permission`, `AccessContext.mayModify`, `V2__independent_actions.sql`, `Bootstrap.seedRoles`; same actions in the OpenFGA model | `AccessAcceptanceIT.independentActions` (now with OpenFGA confirming every allowed action) | Pass | `sh ops/test-backend.sh` | — |
| PA-11 | Organisation/subtree/explicit-set scopes, org∩site intersection, access-manager bounds | `RawGrant.spec`, `Grant.covers/coversSite/actsFor`, `AccessService.requestPredicate`, `AuthzTuples` (site limit on the grant's own holder tuple), `GrantAdminService.requireAuthority` (grantable roles, targets within the granter's own grant, ALL and system actions global only), studio grants tab | `AuthorizationIT.explicitOrganisationSet/organisationAndSiteIntersection/organisationOrSite/resourceGrant/grantAuthorityBounds` (detail, list and OpenFGA agree); browser STUDIO-02, STUDIO-06 | Pass | `sh ops/test-backend.sh`; `node tests/acceptance/access-studio.mjs` | No explicit deny rules (grants are additive) |
| PA-12 | Availability check outside scope reveals no existence, name or requests | `SiteService.requireVisibleResources`, `MapService.check` | `AccessAcceptanceIT.availabilityOutOfScope` | Pass | `sh ops/test-backend.sh` | — |
| PA-13 | Requester with the right APPROVE may approve their stage; without it refused | `AccessContext.taskGrant`, `DecisionService.doDecide` (`by_requester`) | `AccessAcceptanceIT.requesterDecision` | Pass | `sh ops/test-backend.sh` | — |
| PA-14 | Main sites (no parent) and sub-sites on the map and occupancy | `MapService.features/grid`, `SiteService.list/children/search` (CONTEXT ancestors) | `AdministrationAcceptanceIT.mainSitesShown`, `MapWorkspaceAcceptanceIT.siteTreeAndPath`; browser MAP-02 | Pass | `sh ops/test-backend.sh`; `node tests/acceptance/map-workspace.mjs` | — |
| PA-15 | Real boundary import; invalid CRS/geometry refused; previous version kept | V8, `GeoInput`, `BoundaryService.preview/publish`, `ImportDialog` | `MapWorkspaceAcceptanceIT.importBoundaries/importRejections`; browser MAP-04, MAP-05 | Pass (GeoJSON, KML) | `sh ops/test-backend.sh`; `node tests/acceptance/map-workspace.mjs` | Shapefile/GeoPackage converted outside the application (documented); organisation CRS decision D-01 still open |
| PA-16 | Saved geometry reopens unchanged; no fixed shape around a point | `BoundaryService.save/version`, `MapCanvas` (registered boundaries only), `BoundaryEditor` | `MapWorkspaceAcceptanceIT.importBoundaries/pointOnlySite/drawEditConflict`; browser MAP-03, MAP-04, MAP-06 | Pass | `sh ops/test-backend.sh`; `node tests/acceptance/map-workspace.mjs` | — |
| PA-17 | Shared site with independent sub-resources; configured parent/child blocking | `reservation_lock` scope locks (ADR-006) with `resource.child_blocking` (ADR-019), `ReservationService.relock`, `resource_shared_peak` + row lock at approval, `SiteService.updateResource`, `MapService` resource states, `ResourceSettings` | AT-36, `ReservationAcceptanceIT.configurableParentChildRelation/sharedUseLimit` (incl. two concurrent approvals for the last place: exactly one wins), `MapWorkspaceAcceptanceIT.sharedSitePartial`; browser MAP-10, RES-01 … RES-03 | Pass | `sh ops/test-backend.sh ReservationAcceptanceIT`; `node tests/acceptance/resources.mjs` | No headcount capacity (none requested) |
| PA-18 | Pending request reserves nothing; two concurrent approvals, one wins | `DecisionService.finalizeApproval`, exclusion constraints | AT-03, AT-10 | Pass | `sh ops/test-backend.sh` | — |
| PA-19 | Multi-resource request rolls back entirely on one conflict | shared transaction | AT-11 | Pass | `sh ops/test-backend.sh` | — |
| PA-20 | Open-ended, hour and day periods; boundaries and handover | `[start,end)`, unbounded ranges | AT-12 | Pass | `sh ops/test-backend.sh` | — |
| PA-21 | New forms/workflows leave running requests; rule editor tested from the UI | pinned versions; `RuleEditor` (forms: visibility, requirement, affected stages; workflows: stage conditions), server "try it" and simulation with sample values | AT-13, AT-14, `WorkflowAcceptanceIT.ruleTryIt`; browser RULES-01 … RULES-04 (rules authored by clicks, tried on the server, published, enforced on submission, stage skipped/run in simulation) | Pass | `sh ops/test-backend.sh WorkflowAcceptanceIT`; `node tests/acceptance/rule-editor.mjs` | No action to migrate running requests to a newer version (they keep theirs) |
| PA-22 | Person signature and organisation seal with real certificates; revoked/expired/untrusted fail | `ApprovalSigner` (DSS 6.5.1 JAdES, person then seal as parallel signatures, trust anchors + CRL), `Pkcs12DirectoryProvider`, `signature_evidence`, `validation_report`, verification endpoint | `ApprovalSignerTest` (TOTAL_PASSED for both; revoked, expired, untrusted, missing, path traversal refused), `SigningIT.signAndPublish/revokedRefused`; browser SIGN-01, SIGN-02 | Pass (fictional PKI) | `sh ops/test-backend.sh SigningIT,ApprovalSignerTest`; `node tests/acceptance/signing.mjs` | Enterprise provider, certificates, CRL distribution and TSA not connected; no UAE Trusted List assessment |
| PA-23 | Provider outage, version change or conflict after signing: no misleading reservation/document | signing job outside the decision transaction; publication inside it; `SigningJobs.unpublished`; no fallback | AT-27, `SigningIT.conflictAfterSigning/revisionChangedAfterSigning/providerOutage` | Pass | `sh ops/test-backend.sh SigningIT` | — |
| PA-24 | Summary view withholds fields and attachments server-side | `RequestViews`, VIEW_SUMMARY | AT-20 | Pass | `sh ops/test-backend.sh` | — |
| PA-25 | Full journey from the UI only, with real sign-in | Real sign-in available (Keycloak + LDAP); journey still API-driven after sign-in | journey | Partial | `node tests/acceptance/journey.mjs` | Browser-driven journey (clicks) pending |
| PA-26 | That journey injects no cookie/role and calls no API for transitions | — | — | Open | — | Current `journey.mjs` is API-driven; replaced in Phase 7 |
| PA-27 | No internet needed during the journey with egress blocked | CSP, local assets, `ops/test-env/compose.offline.yml` (internal-only network) | journey (AT-29); browser MAP-18 with every external request blocked, stack without egress | Pass (acceptance environment) | `sh ops/test-env/up-offline.sh`; `node tests/acceptance/map-workspace.mjs` | Production host egress rules still to be verified on the enterprise host (docs/INSTALL_AIRGAPPED.md) |
| PA-28 | 7,000 organisations / 200,000 people; 20 then 50 concurrent users incl. writes | — | — | Open | — | Phase 7 |
| PA-29 | P50/P95/P99, errors, queues, resources, hardware declared | — | — | Open | — | Phase 7 |
| PA-30 | Backup/restore/rollback, migration from the current version, rights and documents verified after restore | `ops/backup.sh` (business, identity and authorisation databases, attachments, map packages, SHA-256 manifest), `ops/restore.sh`, `ops/verify-restore.sh`, Flyway V2–V9 (V9 applied in place on the acceptance data), `AuthzSync.rebuild` | AT-30 on the test environment (20 table fingerprints, identity realm/users/clients, attachment SHA-256); `AuthorizationIT.openFgaCoDecidesAndFailsClosed` (rebuild from the database) | Partial | `sh ops/verify-restore.sh tmrkz-test` | Rollback to an earlier application version not yet exercised; restore with `openfga.dump` not yet run end to end; keys come from the organisation's vault |

## Authorisation and permissions studio (ADR-018, owner brief §7)

Backend tests run with a throw-away OpenFGA 1.8.16 next to PostgreSQL + PostGIS (`sh ops/test-backend.sh`); browser checks
drive Microsoft Edge against the acceptance environment with the real directory sign-in
(`node tests/acceptance/access-studio.mjs`, evidence in `docs/evidence/access/`).

| Requirement (§7) | Code | Test | Result |
|---|---|---|---|
| OpenFGA model published and tested; reviewed copy equals the generator | `AuthzModel`, `docs/authz/model.fga`, `AuthzSync.ready` | `AuthorizationIT.modelPublished` | Pass |
| Grants in the business database, transactional outbox to tuples | V9 triggers (`authz_change`), `AuthzSync` (diff against `authz_tuple`) | `AuthorizationIT.revocationInSession` | Pass |
| Model id pinned per policy version | `AccessPolicyService.install` (`fga_model_id`) | `AuthorizationIT.policyVersions` | Pass |
| Doubt denies: OpenFGA refusing or unreachable refuses the action; no fallback | `Authorization.decide/check`, `AUTHZ_UNAVAILABLE`, `AUTHZ_SYNC_PENDING` | `AuthorizationIT.openFgaCoDecidesAndFailsClosed` | Pass |
| Revocation or transfer applied before the next sensitive action | `Authorization.fresh` (pending changes of the actor applied first) | `AuthorizationIT.revocationInSession`; AT-21, AT-23 | Pass |
| AND by default, explicit OR, explicit sets with per-organisation branches, site/resource scopes, explicit ALL | `RawGrant.spec`, `Grant`, `AuthzTuples`, `GrantsStudio` | `AuthorizationIT` (5 scope tests); STUDIO-02 | Pass |
| Independent grants add up without borrowing scope from one another | holder condition per grant | `AuthorizationIT.organisationAndSiteIntersection` (second grant does not complete the first) | Pass |
| Access manager cannot grant outside their authority | `GrantAdminService.requireAuthority`, `role_def.grantable_roles` | `AuthorizationIT.grantAuthorityBounds`; STUDIO-06 | Pass |
| Roles, drafts, versions, action matrix; impact; authorised publication; change log; recorded rollback | `AccessPolicyService`, `PolicyStudio` | `AuthorizationIT.policyVersions`; STUDIO-01, STUDIO-04, STUDIO-05 | Pass |
| "What can this person see or do, and why", before publication, with OpenFGA's answer | `AccessPolicyService.explain`, `Authorization.preview`, `ExplainPanel` | `AuthorizationIT.explain`; STUDIO-03 | Pass |
| Lazy tree selection and search in the studio | `OrgPick`/`SitePick` over `/organizations/roots|children|search`, `/sites/tree|search` | STUDIO-02, STUDIO-06 | Pass |
| System administration separate from request content | ADR-013 roles; studio shows administrators as such | `AccessAcceptanceIT.independentActions` | Pass |
| Raw HR identifiers withheld from ordinary users | VIEW_SOURCE_IDENTIFIERS (ADR-014) | `HrSyncAcceptanceIT` | Pass (unchanged) |
| Explicit deny rules | — | — | Not implemented: no deny rule is configured; grants are additive |

