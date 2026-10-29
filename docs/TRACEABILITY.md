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
| R-14 | Configurable fields/attachments with restricted rules | `FormSchemas`, `RuleLanguage` (visibleWhen/requiredWhen, typed ops) | `ruleLanguageRejectsCode`, `versionsArePinned` | Partial — studio UI edits fields, kinds, visibility, requirement and change policy; rule conditions are edited through the API (UI editor not built) |
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
| R-26 | Permissions by action and scope (organisation, site, resource relation) | `AccessContext`, role scopes incl. ORGANIZATION_AND_SITE | `AccessAcceptanceIT` | Done |
| R-27 | Summary view without occupant data or attachments | `RequestViews` (fields absent), `SiteService`, reservations list | `summaryOnly` (AT-20) | Done |
| R-28 | View/edit/export/approve separated, server-side incl. files, search, updates | independent actions (`Permission`, `V2__independent_actions.sql`), per-endpoint checks, shared scope predicate | AT-19, AT-21, `independentActions` | Done |
| R-29 | Dated memberships and delegations | `membership`, `delegation`, evaluated per request | AT-22, AT-23 | Done |
| R-30 | Membership transfer re-aligns tasks with a record | role-pooled tasks + `TASKS_REALIGNED` audit | `transfer` (AT-22) | Done |
| R-31 | Signature with approval per D-02, no PKI mislabel | `SignatureService` (internal attestation; PKI fails closed) | AT-09, AT-27 | Open (D-02) — internal attestation in force |
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
| PA-07 | LDAP right/wrong/down, untrusted TLS, no demo fallback | — | — | Open | — | Phase 2; enterprise LDAP and CA required |
| PA-08 | Withdrawn membership/delegation blocks the next action, export and attachments | `AccessService.load` per request | AT-21, AT-23 | Partial | `sh ops/test-backend.sh` | Same-session revocation proven for local grants; OpenFGA path pending (Phase 3) |
| PA-09 | Tasks move to a single substitute; ambiguous cases go to the access manager | `position_seat`, `TaskRealignment`, `HrProjection` grant ending | `HrSyncAcceptanceIT.transferRealignsTasks` | Pass | `sh ops/test-backend.sh` | Tasks are role-pooled: with several remaining holders the pool continues (recorded POOL_CONTINUES) instead of asking the access manager to choose |
| PA-10 | View without edit, edit without approve, administration without content | `Permission`, `AccessContext.mayModify`, `V2__independent_actions.sql`, `Bootstrap.seedRoles` | `AccessAcceptanceIT.independentActions` | Pass | `sh ops/test-backend.sh` | — |
| PA-11 | Organisation/subtree/explicit-set scopes, org∩site intersection, access-manager bounds | `Grant.covers`, `OrganizationService.addMembership` (MANAGE_ACCESS over the organisation) | `AccessAcceptanceIT` | Partial | `sh ops/test-backend.sh` | Explicit organisation sets, OR policies and permission-subset bounds come with the studio (Phase 3) |
| PA-12 | Availability check outside scope reveals no existence, name or requests | `SiteService.requireVisibleResources`, `MapService.check` | `AccessAcceptanceIT.availabilityOutOfScope` | Pass | `sh ops/test-backend.sh` | — |
| PA-13 | Requester with the right APPROVE may approve their stage; without it refused | `AccessContext.taskGrant`, `DecisionService.doDecide` (`by_requester`) | `AccessAcceptanceIT.requesterDecision` | Pass | `sh ops/test-backend.sh` | — |
| PA-14 | Main sites (no parent) and sub-sites on the map and occupancy | `MapService.features/grid`, `SiteService.list` (CONTEXT ancestors) | `AdministrationAcceptanceIT.mainSitesShown` | Pass | `sh ops/test-backend.sh` | — |
| PA-15 | Real boundary import; invalid CRS/geometry refused; previous version kept | — | — | Open | — | Phase 4 (PostGIS) |
| PA-16 | Saved geometry reopens unchanged; no fixed shape around a point | — | — | Open | — | Phase 4 |
| PA-17 | Shared site with independent sub-resources; configured parent/child blocking | `reservation_lock` scope locks (ADR-006) | AT-36 | Partial | `sh ops/test-backend.sh` | Per-resource configurable parent/child relation pending (Phase 5) |
| PA-18 | Pending request reserves nothing; two concurrent approvals, one wins | `DecisionService.finalizeApproval`, exclusion constraints | AT-03, AT-10 | Pass | `sh ops/test-backend.sh` | — |
| PA-19 | Multi-resource request rolls back entirely on one conflict | shared transaction | AT-11 | Pass | `sh ops/test-backend.sh` | — |
| PA-20 | Open-ended, hour and day periods; boundaries and handover | `[start,end)`, unbounded ranges | AT-12 | Pass | `sh ops/test-backend.sh` | — |
| PA-21 | New forms/workflows leave running requests; rule editor tested from the UI | pinned versions | AT-13, AT-14 | Partial | `sh ops/test-backend.sh` | Visual rule editor pending (Phase 5) |
| PA-22 | Person signature and organisation seal with real certificates; revoked/expired/untrusted fail | — | — | Open | — | Phase 6; enterprise provider and certificates required |
| PA-23 | Provider outage, version change or conflict after signing: no misleading reservation/document | PKI mode fails closed | AT-27 | Partial | `sh ops/test-backend.sh` | DSS signing job pending (Phase 6) |
| PA-24 | Summary view withholds fields and attachments server-side | `RequestViews`, VIEW_SUMMARY | AT-20 | Pass | `sh ops/test-backend.sh` | — |
| PA-25 | Full journey from the UI only, with real sign-in | — | — | Open | — | Needs Keycloak/LDAP (Phase 2) and a browser-driven journey |
| PA-26 | That journey injects no cookie/role and calls no API for transitions | — | — | Open | — | Current `journey.mjs` is API-driven; replaced in Phase 7 |
| PA-27 | No internet needed during the journey with egress blocked | CSP, local assets | journey (AT-29) | Partial | `node tests/acceptance/journey.mjs` | Host egress block not yet tested |
| PA-28 | 7,000 organisations / 200,000 people; 20 then 50 concurrent users incl. writes | — | — | Open | — | Phase 7 |
| PA-29 | P50/P95/P99, errors, queues, resources, hardware declared | — | — | Open | — | Phase 7 |
| PA-30 | Backup/restore/rollback, migration from the current version, rights and documents verified after restore | `ops/verify-restore.sh`, Flyway V2 | AT-30 | Partial | `sh ops/verify-restore.sh` | Identity/authorization stores join the backup set when introduced |
