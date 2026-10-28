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
| R-28 | View/edit/export/approve separated, server-side incl. files, search, updates | per-endpoint checks; shared scope predicate | AT-19, AT-21 | Done |
| R-29 | Dated memberships and delegations | `membership`, `delegation`, evaluated per request | AT-22, AT-23 | Done |
| R-30 | Membership transfer re-aligns tasks with a record | role-pooled tasks + `TASKS_REALIGNED` audit | `transfer` (AT-22) | Done |
| R-31 | Signature with approval per D-02, no PKI mislabel | `SignatureService` (internal attestation; PKI fails closed) | AT-09, AT-27 | Open (D-02) — internal attestation in force |
| R-32 | Info copies after the final decision, per-recipient access check | `OutboxProcessor.notifyInfoRecipients` | `infoCopyAndOutbox` (AT-25) | Done |
| R-33 | Production audit trail, not editable through the API | `audit_event` + append-only triggers; read-only `GET /audit-events` | `auditImmutable` | Done |
| R-34 | Real attachments: content, checksum, scan, scope, versions | `AttachmentService`, `ContentInspector`, content-addressed `FileStore` | `attachments` (AT-34) | Done |
| R-35 | Integration contracts without fake connections | `IntegrationService` registry (NOT_CONNECTED), org-structure file import | `structureImport` (AT-32) | Partial — identity/people/correspondence connectors await D-04 |
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
| AT-24 | `AccessAcceptanceIT.separationOfDuties` | Pass |
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
