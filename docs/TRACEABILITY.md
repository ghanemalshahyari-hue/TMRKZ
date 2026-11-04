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
| R-04 | Map and list linked, filters kept | the retired `MapPage.tsx` until 2 Nov 2026; merged into `StationingPage.tsx` (ADR-029), merge removed the same day | screen review | **No screen** until the planned rebuild |
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
Current result: see the run recorded in `docs/evidence/map/results.json` (22/22 on 2 Nov 2026 in the merged workspace of
ADR-029). The merge was removed the same day by owner decision and «الخريطة والمرافق» stays retired, so this suite
(committed version, targeting `#map`) cannot run until the planned rebuild; the rows below record the last results.

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
| MAP-20 | Scope clarification §2 (ADR-024): add a new site by placing a marker on the map, and move an existing site's marker, as a direct audited register edit; authorisation, coordinate/reason validation, retired-site refusal; nothing else touched | `SiteMarkerEditor`, `SiteService.create/moveMarker`, `FacilityController` (`POST /sites/{id}/location`), `MapService.context` (`canManageSites`) | `SiteMarkerIT` (6 tests) | — (pending) | Backend Pass (30 Oct); Edge browser check pending for the consolidated checkpoint |
| MAP-21 | Forwarded owner request (ADR-021, refined 30 Oct after owner review): optional map layer draws every visible responsible/occupant organisation's informational symbol beside the marker (none dropped; strip wraps); each symbol is a button that selects that organisation as the map filter (directory → organisations tab) and the site; independent of availability, only visible assigned orgs, no invented location, nothing written | `OrgSymbolLayer` (per-symbol buttons, `onSelectOrg`), `MapPage` (sets `org` + `tab`), `MapPanels.LayersPanel` (`orgSymbols` toggle), `unitSymbols` lib, `/unit-symbols` lookup | — (UI layer; reuses symbol lookup covered by `AdministrationAcceptanceIT`) | — (pending) | Frontend typecheck/build/tests pass (30 Oct); Edge browser check — including per-symbol organisation+site selection and the uncapped strip — pending for the consolidated checkpoint |

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
| J12 | Ring around the site, «نقل المقر», new location drawn on the map, request submitted, site register unchanged (ADR-023) | `SiteActionMenu` ring, `RelocationPanel` (removed 2 Nov 2026), `RelocationService` | `ReservationAcceptanceIT.relocationRequest` | Passed 2 Nov in the merged workspace (polygon panel); cannot run since the merge removal — a relocation is proposed from «مساحة التمركز» (S4–S11) |

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
| Stationing on the map: drag a proposed location, live distance, allowed range, occupied areas (ADR-025) | `StationingPage`, `StationingPanel`, `PlacementService.evaluate`, `POST /placement/check` | `PlacementIT.range`, `PlacementIT.occupancy`; Chrome journey 30 Oct 2026 | Pass |
| Distance rules as configuration (CONFIGURE, reason, audit) | `placement_rule` (V15), `PlacementService.saveRule` | `PlacementIT.rules` | Pass (API only; no editor screen yet) |
| Covered organisations chosen, branch elsewhere not moved by default | `GET /placement/units`, panel step «الجهات المشمولة» | `PlacementIT.units` | Pass |
| Server re-check at submission and approval; proposal never moves the site | `RequestService` (RELOCATION), `DecisionService.finalizeApproval` | `PlacementIT.serverRecheck` | Pass |
| Temporary stationing: end-of-term return and reminders | — | — | Not implemented (phase D) |

## Enterprise audit remediation (2026-11-02, ADR-026; `docs/audit/enterprise-launch/`)

Each regression test was run red against 6d07014 before its fix. Runtime re-runs of the exploits against the rebuilt
environments: `evidence/P0-verify.json`, `evidence/P1-verify.json`.

| Finding | Fix | Test | Status |
|---|---|---|---|
| P0-1 SYSTEM_ADMIN (or any role beyond authority) through an HR position seat | `HrAdminService.createSeat/deactivateSeat` → `GrantAdminService.requireAuthorityForRole`; no seat for a position the actor holds | `SecurityRemediationIT.seatEscalation`, `.seatSelfGrant` | Pass |
| P0-2 grant to oneself; the 72-hour bootstrap admin made permanent | `GrantAdminService.requireGrantee` (self and `person.bootstrap`) | `SecurityRemediationIT.selfGrant` | Pass |
| P0-3 hidden site named/dated at submission, as target, through a guessed occupant | `PlacementService.evaluate` fails closed, masked conflicts without date/limit; `RelocationService.recheck(ctx, …)`; target visibility at save; `includedOrgIds` validated at check | `PlacementIT.hiddenSiteNeverDisclosed` | Pass |
| P0-4 people directory and delegations ignore the access manager's scope | `OrganizationService.people/delegations`: scoped managers browse only their MANAGE_ACCESS subtrees; a ≥3-character search also finds active outsiders by name or exact employee no./account, returned as name + organisation only | `SecurityRemediationIT.scopedListings`; `access-studio.mjs` STUDIO-06 (cross-organisation grant on a shared site); `audit/p0-verify.mjs` | Pass |
| P1-1 earlier approvals carried after the relocation proposal moved | `RequestService.carriedStages` compares the relocation snapshot | `PlacementIT.materialChangeReapproval` | Pass |
| P1-2 stale import preview silently reverting a newer change; leftover PREVIEWED run | structure fingerprint + 30-minute validity; commit re-validates without a new run | `AdministrationAcceptanceIT.staleImportPreview` | Pass |
| P1-3 invalid latitude saved as 0 | `frontend/src/lib/coords.ts`, `SiteMarkerEditor` | `coords.test.ts`; browser `tests/acceptance/audit/p1-verify.mjs` | Pass |
| P1-4 overlapping registered boundaries accepted | `BoundaryService.overlaps` in `publishVersion` and `checkFor` (site tree exempt; edge ≤ 1 m²; hidden sites unnamed) | `BoundaryOverlapIT` | Pass |
| Refusal reason showed the «no rule» note instead of the occupancy | `PlacementService.Check.refusal()` | `PlacementIT.refusalStatesTheRealReason` | Pass |
| `relocationRequest` failed in the full suite (shared fixture point) | test-only: the proposal gets its own place | `ReservationAcceptanceIT.relocationRequest` | Pass |
| Separation of duties: no self-approval, including via delegation/multiple roles (owner decision 2026-11-02) | ADR-027, see the next table | `SeparationOfDutiesIT` | Pass |
| Identity-issue resolution bounded by the target person's grants | ADR-027, see the next table | `IdentityScopeIT.linkBounded` | Pass |
| Scoped `/identity-issues` list | ADR-027, see the next table | `IdentityScopeIT.issuesScoped` | Pass |
| Local provisioning of people; controlled unit creation in the UI (owner decision 2026-11-02) | — | — | Not implemented (planned) |

Final checkpoint (2026-11-02, rebuilt offline acceptance environment): backend 116/116 (`evidence/remediation-final-full.log`),
frontend typecheck + 26/26 + production build, `map-workspace.mjs` 22/22 with 0 external requests, `journey.mjs` passed
(41 checks), `access-studio.mjs` 5/6 — STUDIO-03 expects 13 actions while 14 exist since `CLOSE` was added on 30 Oct
(7d21b10); a stale expectation unrelated to this remediation, left unchanged. Before the map suite, the two open-ended
stationing-demo bookings in the fictional environment were ended on 31 Dec 2026 (`testenv-demo-window.sql`), because
the suite cannot find a free window while they are open-ended.

## Separation of duties, identity and directory scope (2026-11-02, ADR-027)

Each test was run red against the code before ADR-027 (`docs/audit/enterprise-launch/evidence/phase2-red.log`: 15 failing
assertions), then green.

| Requirement | Code | Test | Status |
|---|---|---|---|
| The requester decides no stage of their own request (approve, refer, return, reject), whatever roles they hold | `SeparationOfDuties.Independence.require` in `DecisionService.doDecide/signForTask/approvalDocument`; `myTasks`, `RequestViews` actions | `SeparationOfDutiesIT.requesterNeverDecides`; `AccessAcceptanceIT.requesterDecision` (AT-24 revised) | Pass |
| Delegation both ways: requester as deputy; requester's authority delegated to a deputy | grants through a requester's delegation excluded | `SeparationOfDutiesIT.delegationBothWays` | Pass |
| Approval role in another organisation or through an HR position seat | person-level check, any grant source | `SeparationOfDutiesIT.otherAssignments` | Pass |
| Another person record of the same human (linked sign-in claiming the requester's key) | `PersonKeys.samePeople` | `SeparationOfDutiesIT.alternateRecord` | Pass |
| No independent holder: routed to access managers, requester neither notified, shown, candidate nor assignable | `TaskSync` → `TaskRealignment.separate/route/pending/candidates/assign` | `SeparationOfDutiesIT.noIndependentApprover` | Pass |
| Last independent holder leaves: routed, never handed to the requester | `TaskRealignment.realign/holders` | `SeparationOfDutiesIT.departureLeavesOnlyRequester` | Pass |
| A task row assigned to the requester still refuses them | check before assignment | `SeparationOfDutiesIT.assignedTaskStillRefusesRequester` | Pass |
| Assignment screen for routed tasks | `frontend/src/components/TaskRoutings.tsx` (#permissions/tasks) | `tests/acceptance/audit/sod-browser.mjs` (12/12) | Pass |
| Unlinked sign-ins scoped to the manager's members | `IdentityService.issues/visibility` | `IdentityScopeIT.issuesScoped` | Pass |
| Linking bounded by authority over the person's grants; never self, bootstrap, or a person other than the key's owner | `IdentityService.requireLinkable` | `IdentityScopeIT.linkBounded` | Pass |
| No cross-organisation search by name or identifier; site-grant bridges with name + organisation only | `DirectoryScope`, `OrganizationService.people` | `IdentityScopeIT.directoryStrict`, `SecurityRemediationIT.scopedListings` | Pass |
| Grants only to people in the manager's reach; ending a grant needs the authority to give it | `GrantAdminService.requireGrantee/end` | `IdentityScopeIT.grantsBounded`; `AuthorizationIT.grantAuthorityBounds` (fixture given an HR affiliation) | Pass |
| Access explanation only for people in reach; an ended grant no longer relates someone | `AccessPolicyService.explain` | `IdentityScopeIT.explainScoped` | Pass |
| Boundary overlap along the tree only as containment; a move can neither gain nor leave an overlap | `SiteOverlapRule`, `SiteService.update` | `BoundaryOverlapIT.treeExemptionIsContainment` | Pass |
| Load tool signs in through the supported directory flow, synthetic accounts, disposable environment | `ops/load/load-test.mjs`, `up-load-env.sh`, `synthetic-identities.sql` | `SMOKE=1` run (`evidence/load-smoke.log`) | Pass |
| Review H1: organisation roster only inside the reader's scope; grant sites only when visible | `OrganizationService.detail` | `IdentityScopeIT.rosterAndExplainBounded` | Pass |
| Review M5: explanation for members only; targets named only when visible; bridges found by name only | `AccessPolicyService.explain`, `OrganizationService.people` | `IdentityScopeIT.rosterAndExplainBounded` | Pass |
| Review M7/M1: self checks compare humans (grant, link, seat, delegation); bootstrap tied to its HR record; no delegation to bootstrap or of administration rights | `PersonKeys.same`, `GrantAdminService`, `IdentityService`, `HrAdminService.holdsPosition`, `OrganizationService.delegate` | `IdentityScopeIT.aliasesAndDelegations` | Pass |
| Review: a stage the requester decided before ADR-027 is not carried into a resubmission | `RequestService.carriedStages` | `SeparationOfDutiesIT.legacySelfDecisionNotCarried` | Pass |
| Review P1: NaN coordinates refused | `SiteService.validate` | `IdentityScopeIT.nanCoordinates` | Pass |
| Review M2: relocation origin/target unnamed for a reader who may not see the site | `RelocationService.masked` | — (no dedicated test) | Code only |
| Review P2: boundary registrations and tree moves serialised | `SiteOverlapRule.serialise` | — (race not reproduced in a test) | Code only |
| Concurrent final approvals: conflict, not deadlock | `ReservationService.lockTrees` | `map-workspace.mjs` MAP-13; `ReservationAcceptanceIT` | Pass |

Final checkpoint (2026-11-02, ADR-027, rebuilt offline acceptance environment and clean install): backend 133/133
(`evidence/final-backend-full.log`); frontend typecheck + 26/26; `journey.mjs` passed (41); `sod-browser.mjs` 12/12;
`audit/p0-verify.mjs` all FIXED; clean installation passed; `map-workspace.mjs` 21/22 — MAP-19 fails at a client-side
keyboard step only in full-suite order (3 of 3 runs) and passes alone (2 of 2, `final-map19-only-*.log`); `access-studio.mjs`
5/6 (STUDIO-03 stale count of actions) with one Leaflet `_leaflet_pos` page error during navigation (a map animation after
the map was removed; not seen in earlier runs). Load tool: `SMOKE=1` passed and a 5-user, 15-second run had 0 errors
(`evidence/load-smoke.log`, `load-small.log`) on the disposable `tmrkz-load` environment.

## Stationing footprint interaction (2026-11-02, ADR-025 amendment)

| Owner step | Code | Evidence (`tests/acceptance/stationing-footprint.mjs`, `docs/evidence/stationing/`) | Status |
|---|---|---|---|
| Open «مساحة التمركز»; select an organisation from the tree and from its map symbol (shared sites: one symbol per organisation) | `StationingPage` (symbols on by default; symbol pick kept over the responsible organisation) | S1, S2 | Pass |
| Registered symbol and polygon visible; proposal is a copy, original unchanged | `StationingPanel` reference layer, `FootprintEditor.startMove` | S3, S4 | Pass |
| Drag the whole polygon and symbol together, shape and area kept; drag again after drop | `FootprintEditor.startBodyDrag`, `lib/footprint.moveRigid` | S5; `footprint.test.ts` (rigid move keeps area, also at 60°N) | Pass |
| Edit vertices; undo, redo, reset | `FootprintEditor.setVertex/undo/redo/reset` | S6 | Pass |
| Draw a new polygon by vertex count; numbered vertices, edge lengths, area, validity | `FootprintEditor.startDraw/addVertex`, `lib/footprint.kinks/areaM2` | S7 | Pass |
| Precise coordinates per vertex | panel vertex table, `lib/coords.parseCoordinates` | S8 | Pass |
| Compare old and proposed | `FootprintEditor.compare` | S9 | Pass |
| Cancel without changing authoritative data | panel cancel; boundary version and request count checked | S10 | Pass |
| Save and reopen the preview as a draft | `StationingPanel.run(false)`, `#stationing/<id>` | S11 | Pass |

During ADR-029 the proposal started from the shared site menu («نقل المقر»); after the merge was removed it starts again
from the stationing popup «طلب تمركز / إعادة تمركز». Last run (2 Nov 2026, after the merge removal): 11/11 with the
accepted measurements.

## One GIS workspace — retirement of «الخريطة والمرافق» (2026-11-02, ADR-029)

*Superseded the same day: the merge was removed by owner decision. The table below records the merged workspace's
results; the merge-removal acceptance follows it.*

| Owner acceptance item | Code | Evidence | Status |
|---|---|---|---|
| 1. Only «مساحة التمركز» in the navigation | `lib/app.NAV`, `App` | `gis-workspace.mjs` G1, `docs/evidence/gis-workspace/g01-navigation.png` | Pass |
| 2. The old route redirects | `App.viewFromHash` (`#map`, `#map/…`, unknown → `#stationing`) | G2, `g02-legacy-redirect.png` | Pass |
| 3. The workspace opens without errors | `StationingPage` | G3 (console errors 0 in every suite) | Pass |
| 4. Existing sites and facilities remain accessible | `SiteTree`, `SiteDetailPanel`, organisation page link | G4, G6; MAP-02, MAP-03, MAP-10 | Pass |
| 5. Organisational symbols work | `OrgSymbolLayer`, `StationingPage.followOrg` | G5; S2 | Pass |
| 6. Polygon drawing and relocation still work | `StationingPanel`, `FootprintEditor` | S4–S11; J12; MAP-06 (boundary editing) | Pass |
| 7. The 11 stationing steps pass | — | `stationing-footprint.mjs` 11/11 | Pass |
| 8. Site management permissions unchanged | server flags in `/map/context`, `site.canManage`, `/sites/{id}/request-actions` | G7 (three roles), G8 (two roles); MAP-07a, MAP-04–06, MAP-15; `resources.mjs` 3/3 | Pass |
| 9. Request creation and approvals still work | `SiteActionMenu`, `RequestWizard` drawer, review desk | MAP-11, MAP-12a/b, MAP-13, MAP-14; `admin-journey.mjs` J1–J12; `journey.mjs` | Pass |
| 10. No API, component or database dependency broken | backend and OpenAPI unchanged; shared components kept | all suites above against the unchanged backend; frontend 30/30, type check, build | Pass |

## Removal of the GIS merge (2026-11-02, owner decision; ADR-029 amendment)

| Owner verification item | Evidence (`stationing-footprint.mjs` S1–S11; merge-removal check U1–U5, `docs/evidence/stationing-unmerge/`) | Status |
|---|---|---|
| 1. «مساحة التمركز» opens correctly | S1, U1 | Pass |
| 2. The legacy page is absent from navigation | U2 (and `#map` opens `#stationing`) | Pass |
| 3. Back to the simpler pre-merge layout | U3 (no context bar, period tools, old toolbar, facility tools, two-tab directory, side column, legend, coverage note); `before-*.png` / `after-*.png` | Pass |
| 4. Organisations and their symbols | S2 | Pass |
| 5. Registered polygons visible | S3, S4 | Pass |
| 6. Full-polygon dragging | S5 (area difference 0٪ after two drags) | Pass |
| 7. New polygon drawing and coordinate entry | S7, S8 | Pass |
| 8. Vertex editing, undo, redo, reset | S6, S8 | Pass |
| 9. Comparison and draft saving | S9, S11 | Pass |
| 10. Cancel changes no registered data | S10 (boundary version and request count unchanged) | Pass |
| 11. No merge-only controls or panels | U3, U4 (stationing popup, no ring or details panel), U5 (no facility tools for the facilities administrator) | Pass |

Frontend type check, 30/30 unit tests and production build pass. Merge-removal check: `tests/acceptance/stationing-layout.mjs`
(5/5); report `docs/GIS_MERGE_REMOVAL_AR.md`.

## Stationing defect fixes (2026-11-02, stage 1 of the stationing UX brief)

Defect numbers are those of `docs/audit/stationing-ux/VISUAL_AUDIT_AR.md`. Regression suite:
`tests/acceptance/stationing-fixes.mjs` (Edge, test environment, evidence in `docs/evidence/stationing-fixes/`).

| Defect | Fix | Regression test | Status |
|---|---|---|---|
| V-02 touch dragging moved the map, not the proposal | `FootprintEditor` starts the body drag from a capture-phase `pointerdown` (mouse, touch, pen); `touch-action:none` on the proposal (`stationing.css`) | F-02 (390×844, touch events) | Pass |
| V-03 proposal and validation colours missing | `stationing.css`: self-referential `--green`/`--red` removed, the design-system tokens apply | F-03 | Pass |
| V-04 vertices, edge lengths and proposal symbol shifted in RTL | `stationing.css`: explicit `left:0;top:0` for `.stw-prop-sym`, `.stw-orig-sym`, `.stw-vtx`, `.stw-edge` | F-04 (offset 0 px) | Pass |
| V-06 overlapping site markers unreachable | `StationingPage.onSiteHit` asks which site when markers share a spot; `map.css`: the empty part of a marker no longer catches clicks | F-06 | Pass |
| V-09 «على الخريطة» did not select the organisation | `lib/stationingLink` (`#stationing/site/<id>/org/<id>`), `OrgPage`, deep-link handling in `StationingPage`, `StationOrgTree.revealPath` | F-09; `stationingLink.test.ts` (3) | Pass |
| V-15 organisations without a symbol missing on the map | `OrgSymbolLayer` draws a neutral mark; `map.css` keeps the strip left-to-right | F-15 | Pass |
| V-16 keyboard: menu focus and Escape | `StationingPage`: the menu takes the focus; Escape closes it and returns the focus to the marker | F-16 | Pass |

Results (2 Nov 2026): F-02…F-16 7/7, the 11 accepted polygon scenarios `stationing-footprint.mjs` 11/11, layout check
`stationing-layout.mjs` 5/5, frontend type check and 33/33 unit tests. Backend, API and database unchanged.

## Execution integrity (2026-11-03, ADR-028; `docs/audit/main-risk/ADR-028_TEST_RESULTS_AR.md`)

Run on a sealed disposable database (owner approval of 3 Nov 2026). The backend suite passed 144/144.

| Requirement | Code | Test | Status |
|---|---|---|---|
| Handover never by the requester; receipt after it, by the receiving party, not by the one who handed over | `SeparationOfDuties.step`, `ExecutionService.doComplete` | EX-1 | Pass |
| Requester's own work is an acknowledgement, not an approval | `ExecutionService.doComplete` | EX-2 | Pass |
| Closing needs an independent holder of CLOSE | `ExecutionService.doClose`, `RequestViews` | EX-3, IF-3 | Pass (no routing for closing: gap) |
| A step only the requester holds, or nobody holds, goes to the access managers; never assigned to the requester | `TaskRealignment.separateExecution`, `assign` | EX-4 | Pass (failed before the `WorkflowValidator` fix) |
| An approval stage nobody holds is routed at submission | `TaskRealignment.separate` | EX-5 | Pass |
| Workflow definitions accept a valid `purpose` and refuse others | `WorkflowValidator` | EX-4 (publication) | Pass |
| Requests approved before ADR-028 | — | IF-1 (recovered by an audited grant), IF-2 (assigned to the requester: stuck) | Pass; gap recorded |
| Role and organisational scope of execution steps | `executionGrant`, `separateExecution` | IF-4 | Pass |
| Approval stage held only outside its scope | `TaskRealignment.roleHeld` (scope-blind) | IF-5 | Pass; gap recorded |
| V17 on existing steps: key-based purpose; later inserts get TASK; CHECK enforced | `V17__execution_purpose.sql` | V17-1 | Pass |

## Basemap tiles and overlap predicate (2026-11-03, ADR-030; owner approval of two frontend fixes)

Evidence: `docs/evidence/map-basemap/` (before = previous web image, after = rebuilt one; `compare.json`, side-by-side
pictures). Browser script `tests/acceptance/map-basemap.mjs` (Edge, headless, test environment, read-only).

| Requirement | Code | Test | Status |
|---|---|---|---|
| Basemap does not lag while panning and zooming (1920×1080, 1366×768, 768×1024, 390×844) | `lib/svgTiles.ts`, `components/map/svgTileLayer.ts`, `MapCanvas` background effect | `map-basemap.mjs` B3 (frames at four zoom levels) | Pass: after, worst frame 14–31 ms, 0 frames over 50 ms at 16/16 levels (before: up to 734 ms, 88 frames) |
| Basemap content and meaning unchanged; packages not in the plain structure keep the image overlay | `parseSvgTiles` (strict), fallback in `MapCanvas` | `svgTiles.test.ts` (real package read in full; 19 rejected structures incl. the acceptance plan); `map-basemap.mjs` B1 | Pass: 23/23 unit; B1 16/16 (same colour as the independent rendering) |
| GIS alignment of the basemap | `tileWindow` (same linear mapping as `L.imageOverlay`), viewBox clip | `svgTiles.test.ts` (tile placement = overlay mapping); `map-basemap.mjs` B2 (best offset against an independent Web-Mercator rendering of the same file) | Pass: 15/16 at (0,0) or ±1 px in both builds; 390×844 zoom 18 stale reported centre in both builds, (0,0) after one pan |
| Boundary and marker positions unchanged | overlay code untouched | `compare.json` (before/after positions at the same views) | Pass: 16/16 views, largest difference 0 px |
| Offline; no external requests | same local package URL | `map-basemap.mjs` B4 | Pass: 0 external requests, 0 console errors |
| Overlap predicate: conflict semantics documented, identical and coincident geometry not missed, touching unchanged | `lib/footprint.ringsIntersect` | `footprint.test.ts` (24 cases × both argument orders: disjoint, crossing, contained, identical ×5, partly coincident ×2, vertex touch ×2, boundary touch ×3, near miss ×2, 1 cm overlap, concave ×2, degenerate ×2) | Pass |
| Polygon editor, permissions, data behaviour, stationing redesign | not changed (no backend, API, database or editor change; Stationing V2 not integrated) | `stationing-fixes.mjs`, `stationing-layout.mjs`, `stationing-footprint.mjs` (S1–S10) | Pass: 7/7, 5/5, S1–S10 10/10 (S11 saves a draft: skipped) |

## Stationing model V3 rev. 2 — final owner model (2026-11-03; prototype only, not integrated)

- **Design:** `docs/STATIONING_MODEL_V3_AR.md`.
- **Evidence:** `docs/audit/stationing-ux/model-v3/REPORT_AR.md`.
  - Unit tests: `prototypes/stationing-ux/src/v3/domain.test.ts`.
  - Browser: `v3-run.mjs`, run in Edge at four sizes.
- **Status meaning:** "Pass" means the simulated prototype. In production every row is **Not implemented**.

| Final brief § | Requirement | Prototype code | Test | Status |
|---|---|---|---|---|
| 1, 3 | Oracle hierarchy, levels from Oracle; hierarchy ≠ location | `fixtures.ts` extract, `ancestors`, `pathOf` | A, B | Pass |
| 2, 4, 39 | Sites not from Oracle; four separate concepts (hierarchy, `SiteLink`, `Stationing`, `Responsibility`); external site source; Oracle change rewrites no link | `domain.ts` types, `LINK_SITE`/`UNLINK_SITE`, `CORRECT_STATIONING`, `SET_RESPONSIBILITY`, `ORACLE_SYNC` | C, X, "stationing is corrected only by its own action" | Pass (O-14, O-15 owner: a link is not occupancy) |
| 5 | One map object per site; contextual card with stationed and linked units and their relations | `App` pins, `SiteCard` | C; pins = site records in all scenarios | Pass |
| 6–9, 11–12 | One site; selectable scope; co-located move with one drag; consolidation; exclusion; drag-first | `presetScope`, `ScopeStep`, `FootprintEditor` (unchanged) | D–G; drag ×4 sizes; journey | Pass |
| 10 (O-03) | Other-branch unit never moved automatically; inclusion configurable with one or more authorities; explicit and audited | `crossBranch`, `deriveRoute` CROSS_BRANCH stages | D, H | Pass (O-03b owner: shared stage with `satisfies`, or independent stage and human) |
| 13–15 | No re-stationing distance rule; red occupied geography; configurable maximum area, blocks | `validate`, `conflictRings` | "no distance rule", conflict drop ×4 sizes, maximum-area test | Pass |
| 16–17 | Permanent and temporary lifecycles, expiry return, extension | `activate`, `tick`, extensions | I, J, K, L | Pass |
| 18–22 | Two deployment areas in the same request; REQUIRED/OPTIONAL; guidance bands; place, drag and resize | `validate`, `legCheck`, `bandOutline`, `DeployStep` | P, Q; place/drag/resize ×4 sizes | Pass (label O-13 owner: «البديلة») |
| 24 (O-05) | Largest-area terrain class with shares shown | `terrainShares`, `terrainClassOf` | S | Pass (O-05b: tie decided by `terrain_class_priority`; no valid priority → blocked) |
| 25–26 (O-06) | Allowance extends the maximum only; configurable, versioned, reasoned, referenced | `legCheck`, `PolicyVersion.reference` | T, policy lock and effective date | Pass |
| 27, 48 (O-04) | Distance method: owner chose centre → centre after the visual comparison | `measure.ts` (`CENTROID_TO_CENTROID` policy default), `compare.ts`, `CompareCard` | W, method tests | Pass (owner decision 2026-11-03) |
| 28–29 (O-07, O-09) | Route from the requesting unit upward; first approver configurable | `requestingUnit`, `deriveRoute` | N, "the route belongs to the requesting unit" | Pass |
| 30 (O-10) | Hierarchy change → pause, return for reconfirmation, rebuild, history kept | `ORACLE_SYNC`, `PAUSED_HIERARCHY_CHANGED`, `routeHistory` | O, "elsewhere does not pause" | Pass (O-10b restart all; O-16 activation blocked and paused) |
| 31 (O-08) | Occupied deployment area is a HARD block | `validate.deployConflicts`, engine `busy` | R; blocked-area interaction | Pass |
| 33 | Returned request reuses the same request; selective invalidation | `reconcile`, revisions | M | Pass |
| 23, 35, 37–38 | Official terrain first (not synthetic in production); street names from approved data, never fabricated | `basemap.ts` labels, `data/road-names.json` (OSM, labelled non-authoritative) | U, V; street names at z16 ×4 sizes | Prototype: OSM names labelled non-official; O-11/O-12 owner: FGIC only with permission, Copernicus with approval; offline glyph pipeline designed, not built |
| 36 | Mode switch keeps request, selection, geometry and camera | `basemap.setMode` | layer switch ×4 sizes (`proposalUnchanged`) | Pass |
| O-15 | A site link is not occupancy; authoritative occupancy (stationing, approved use, reservation) blocks geography | `Occupancy`, `occupancyAt`, `conflictRings` | "O-15 — a linked-only site does not occupy…" (J vs K) | Pass |
| O-16 | Hierarchy drift before activation: activation blocked, request paused, rebuilt and re-approved | `ORACLE_SYNC`, `check(ACTIVATE)` drift guard | Y; "activation is refused on drift…" | Pass |
| O-01 | Outbound contract: outbox/event feed with stable IDs, effective time, source/version, audit ref; no Oracle write | `OutboxEvent`, `emit`, `LinksCard` outbox table | "O-01 — the outbox carries…" | Pass (delivery and read API designed, not built) |
| O-03b | One stage satisfies several conditions (`satisfies`), or an independent stage decided by a different human | `deriveRoute`, `crossBranch.independent` | Z; "when the policy requires independence…" | Pass |
| O-05b | Tie for the largest share: highest tied class in the administrator's `terrain_class_priority`; tied classes without a priority block submission; decision and policy version audited | `terrainClassOf`, `PolicyValues.terrainPriority`, `terrainAudit`, policy-panel priority editor | T2; "O-05b — a tie … decided by …", "… BLOCK submission", "… written to the audit record" | Pass |

## Stationing V3 production preparation (2026-11-03, P1–P3; no schema, not active)

Report: `docs/audit/stationing-v3-production/STOP_GATE_REPORT.md`. Run with
`sh ops/test-backend.sh StationingRulesTest,StationingAdaptersIT`.

| Owner decision | Production code | Test | Status |
|---|---|---|---|
| O-07, O-09 route from the requesting unit; levels configured | `stationing/RouteDerivation` | `StationingRulesTest` routing (4) | Pass (unit) |
| O-03, O-03b cross-branch, shared `satisfies`, independent human | `RouteDerivation.derive` / `mayDecide` | cross-branch (4) | Pass (unit) |
| O-10, O-16 drift: pause, activation refused | `HierarchyDrift`, `HierarchySnapshot`, `OrganizationHierarchy` | drift (4); `StationingAdaptersIT` (HR-shaped fixture, not real Oracle) | Pass |
| O-05, O-05b, O-06 terrain and ties, maximum only | `TerrainRule`, `DeploymentRules.leg` | terrain (4) | Pass (unit) |
| O-04 centre to centre; pair rule; maximum footprint | `PostgisGeoMeasure`, `DeploymentRules` | deployment (4); `StationingAdaptersIT` PostGIS | Pass |
| O-08, O-15 authoritative occupancy only | `OccupancyRule` | occupancy (1) | Pass (unit) |
| O-01 outbound contract and sender | `StationingEvent`, `StationingEventSender` | outbound (5) | Pass (unit; no destination connected, no persistence) |
| Read API scope | `StationingReadAccess` (existing `Grant.covers`) | read scope (1) | Pass (unit; endpoint not built) |
| Policy validation | `StationingPolicy.problems` | policy (2) | Pass |
| UI inactive | `frontend/src/lib/stationingV3.ts` | `stationingV3.test.ts` (4) | Pass (flag off; not routed) |


## Stationing V3 foundation (2026-11-04, ADR-031/ADR-032, migration V18; owner stop-gate decisions 1–6)

Report: `docs/audit/stationing-v3-production/CONTINUATION_REPORT.md`. Run with
`sh ops/test-backend.sh StationingRulesTest,StationingFoundationIT,StationingAdaptersIT,AuthorizationIT`,
`python -m pytest ops/terrain`, `node tests/acceptance/maplibre-labels.mjs`.

| Owner decision / requirement | Production code | Test | Status |
|---|---|---|---|
| D1 V17 clean path through the release mechanism (schema, backup/plan, migration, history, schema after, integrity, ADR-028, compatibility) | `ops/verify-migration-path.sh`, `ops/sql/checks/V17-after.sql`, `ops/backup.sh` (numeric schema version), `ops/sql/upgrade-rows.sql` (+execution steps) | `docs/evidence/migration-path/v17/`; `ExecutionIntegrityIT` 5, `ExecutionInFlightIT` 5, `V17MigrationIT` 1 | Pass |
| D1 acceptance DB brought to V17 (owner, 4 Nov), labelled ACCEPTANCE / V17 | `ops/test-env/upgrade-backend.sh` | `docs/evidence/acceptance-upgrade/tmrkz-test-v17/` (6,340 rows unchanged, journey PASS) | Done (acceptance only) |
| D1 check migration gates before `up.sh` | `ops/test-env/migration-gate.sh` (sourced by `up.sh`, `up-offline.sh`) | dry check: refuses [18] with exit 3, allows only `TMRKZ_APPLY_MIGRATIONS="18"` | Pass |
| Next gate (owner, 4 Nov): V18 not applied to `tmrkz-test` until section 9 of the report is reviewed | (no change to `tmrkz-test`) | — | Section 9 approved on 4 Nov |
| V18 on `tmrkz-test` from a local commit (owner approval of section 9): ACCEPTANCE label, verified backup, plan [18], schema and data invariants, journey, OpenFGA, no outbound/Oracle/terrain/policy side effects | commits `21f6689`, `4f7ea08`; image `mover/backend:rel-4f7ea08`; `ops/verify-backup.sh`, `ops/test-env/upgrade-backend.sh` | `docs/evidence/acceptance-upgrade/tmrkz-test-v18/summary.txt` | Done: `ACCEPTANCE / V18` |
| Minimum schema, next valid number (V18) | `V18__stationing_foundation.sql` (5 tables + raster extension) | clean V18 path `docs/evidence/migration-path/v18/` (133/133 unchanged, journey PASS) | Pass (disposable); acceptance DB waits for review |
| Versioned policy with author, reason, reference, effective date, previous/new values; pinned version | `StationingPolicyStore`, `stationing_policy_version` (append-only trigger) | `StationingFoundationIT.schema`, `.policyVersions`, `.terrainClasses` (pinned v1) | Pass |
| D2 slope percent from the DEM, FAO initial classes, half-open bands, thresholds as policy | `StationingPolicy.SlopeClassification`, `StationingPolicyDefaults`, `TerrainClassifier.classOf` | `StationingRulesTest` slope bands (4); `StationingFoundationIT.terrainClasses` | Pass |
| Next gate: ROLLING shows the provisional label «تضاريس متدرجة»; code and thresholds unchanged | `StationingPolicyDefaults.FAO_SLOPE_CLASSES` | `StationingRulesTest`, `StationingFoundationIT` | Pass |
| D2 class ≠ allowance; allowance maximum only; no invented allowance | `StationingPolicy.terrainAllowancesM`, `problems()` | slope bands; `minAndMaxIsNeverPublishableTheMinimumStays` | Pass |
| D2 largest share, priority tie, block without priority; full audit fields | `TerrainClassifier.assess` → `TerrainRule` | `StationingFoundationIT.terrainClasses` | Pass |
| D3 GLO-30 reused from MOVER with provenance, sea cells, DSM limitation, derived products separate | `ops/terrain/*`, `map-packages/terrain-glo30-2026.11/manifest.json` | `pytest ops/terrain` 13; `ops/terrain/verify-postgis.sh` (pixel centre exact, refusal exit 4, 167 ms) | Pass |
| Next gate: Copernicus licence notices (raw 6(a), derived 6(b), no liability 6(c), no endorsement 6(d)); dataset/product id, source tiles, original and derived checksums, processing version, licence reference and date | `ops/terrain/make_manifest.py` → `manifest.json` `licence`, `LICENSE-NOTICE.txt`; `offlineStyle.ts` `TERRAIN_ATTRIBUTION` | official licence PDF sha256 `9cd37d37…51bd` checked 2026-11-04; `maplibre-labels.mjs` M-7 (attribution shown) | Pass |
| Next gate: terrain load separate from V18, restartable, idempotent, validated by row and cell counts, provenance-aware, removable and rebuildable without touching business records | `ops/terrain/load-slope.sh`, `ops/terrain/slope_plan.py`, `ops/terrain/unload-slope.sh` | `docs/evidence/terrain-load/loader-checks-2026-11-04.txt` (12 steps); `test_load_plan_counts_cells_and_refuses_a_manifest_that_disagrees` | Pass (disposable, two-tile subset) |
| D3 real data reaches the business rule | `terrain_slope` + `TerrainClassifier` | `StationingFoundationIT.terrainOnRealFixture` (6,400 cells as expected) | Pass |
| Authoritative stationing by data correction; history kept | `StationingRegister.correct`, `org_stationing` (exclusion) | `StationingFoundationIT.correctionAndReadContract` | Pass |
| O-15 link ≠ stationing/occupancy | `StationingRegister.link/endLink`, `site_link` | `StationingFoundationIT.linksAreNotStationing` | Pass |
| O-01 outbox in the same transaction; sender test transport; sequence per unit; replay audited | `StationingOutbox`, `HttpStationingDestination`, `StationingOutboxProcessor` | `StationingFoundationIT.outboundDelivery` | Pass (no consumer connected) |
| O-01 read API filtered by VIEW scope, OpenFGA-confirmed | `StationingController` `/stationing/current`, `/organizations/{id}/history`, `/site-links` | `StationingFoundationIT` (other branch sees nothing / 404) | Pass |
| OpenFGA: CORRECT_STATIONING, MANAGE_SITE_LINKS, REPLAY_STATIONING_EVENTS | `Permission`, generated `AuthzModel`, `docs/authz/model.fga` | `AuthorizationIT.modelPublished` | Pass |
| D5 MapLibre, built-in Arabic shaping, offline fonts, street/terrain, zero egress | `frontend/src/components/map/maplibre/` (not wired) | `tests/acceptance/maplibre-labels.mjs` 21 PASS, 0 external requests; `offlineStyle.test.ts` 6 | Pass |
| Next gate: brackets fixed locally, no global page-direction change | `glyphDirection.ts` `drawGlyphsLeftToRight`, called by `OfflineMapLibre` | `maplibre-labels.mjs` G-8a PASS on `<html dir="rtl">`, G-8b cross-check, G-8c control (defect without the fix); `glyphDirection.test.ts` 3 | Pass |

| Re-stationing request (ADR-033): one site, explicit units, permanent/temporary, policy pinned at submission, hierarchy snapshot | V19, `RestationingService.create/edit/submit`, `RestationingContent` | `RestationingWorkflowIT.permanentJourney`, `restationing-journey.mjs` | Pass (development) |
| O-07/O-09/O-03b route from the requesting unit; seat-exact decisions; separation of duties by the human | `RouteDerivation`, `RestationingService.requireDecider` | `permanentJourney` (requester refused, same human and second record refused), `checks` (exception stage by its permission) | Pass |
| O-08/O-15/O-04/O-06/O-05b submission checks: occupied ground, vacated site, footprint, deployment pair and range, exception reason, terrain | `RestationingChecks` | `checks` | Pass |
| V2 D18 return for changes: only affected decisions re-taken, others carried | `RestationingService.reconcile` | `returnAndSelectiveReapproval` | Pass |
| O-10/O-10b/O-16 hierarchy change: pause, refusal, rebuild with every stage, earlier route kept; activation refused on drift | `pauseIfDrifted`, `RestationingScheduler` (+`HrSnapshotPublished`) | `hierarchyChangePausesAndRebuilds`, `activationRefusedOnDrift` | Pass |
| D1/O-14 independent activation: site, stationing, deployment areas, outbox in one transaction, links untouched, occupancy re-checked | `RestationingService.activate` | `permanentJourney`, `activationRefusedWhenGroundTakenSinceApproval` | Pass |
| V2 D7 temporary overlay, automatic start and return | `runTemporaryLifecycle` | `temporaryLifecycle` | Pass |
| O-03/O-03b cross-branch inclusion: never implicit; explicit inclusion adds the other unit's approval with what it satisfies | `RestationingChecks`, `RouteDerivation` | `crossBranchInclusion` | Pass |
| Policy version locked at submission; drafts checked against the version in force | `RestationingService.submit/checks` | `policyVersionLocked` | Pass |
| O-17 (owner, 4 Nov, option B) distance exception: only when enabled, up to `maxExtra`, written reason, separate stage by its permission, audited; beyond the maximum refused | `DeploymentRules.leg`, `RestationingChecks.leg`, `RouteDerivation` (`X:distance`), `RestationingService.submit` (audit) | `checks` (margin needs a reason; exception stage decided only by its holder), out-of-range refusal | Pass |
| V19 clean migration path (V18 release → V19): plan [19], backup, rows unchanged, checks, journey | `ops/verify-migration-path.sh`, `ops/sql/checks/V19-after.sql` | `docs/evidence/migration-path/v19/` (133/133 unchanged, mismatches=0, journey PASS) | Pass (disposable); acceptance plan `V19_ACCEPTANCE_PLAN.md` awaits the owner |
| Page «إعادة التمركز» on MapLibre (behind `VITE_STATIONING_V3`) | `frontend/src/pages/RestationingPage.tsx`, `RestationingEditor.tsx` | headless Edge check on `tmrkz-v3dev` | Development |
| D4 real non-production Oracle | — | — | Release gate (not available) |
| D6 real touch device | — | — | Release gate (not available) |
