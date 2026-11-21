# TMRKZ page review — 20 Nov 2026

Written for: the owner (after the two-restationing-screens note).

## The two «إعادة التمركز» screens

**There are two editor components, by design, after ADR-093.**

- [DeploymentAreasRequest.tsx](frontend/src/pages/DeploymentAreasRequest.tsx) (898 lines) — the **map-first editor** the owner's brief of 29 Oct 2026 asked for: one chain of steps for `DEPLOYMENT_AREAS` and `RESTATIONING`. This is now the only path for **every new** re-stationing or deployment-area request, and for **every saved draft or returned request** of those two purposes.
- [RestationingEditor.tsx](frontend/src/pages/RestationingEditor.tsx) (1,375 lines) — the **legacy editor** that still opens saved `SITE_REGISTRATION` and `INITIAL_STATIONING` requests. Its new-request paths are no longer reached from the UI after ADR-078 (initial stationing moved to «تهيئة المواقع») and ADR-093 (site registration moved there too). The database on :8088 still carries nine such requests (six `SITE_REGISTRATION`, three `INITIAL_STATIONING`), so the editor cannot be deleted without losing the ability to open or amend them.

The routing in [RestationingPage.tsx:179-210](frontend/src/pages/RestationingPage.tsx#L179-L210) states this explicitly: a new request with a flow purpose goes to the map-first editor, a saved request is routed by its stored purpose, and the legacy editor is reached only as a fallback.

**What I did not catch earlier.** The two editors look like duplicates when first opened, and I did not surface the reason on the dashboard rewrite. The owner is right that this should have been called out before I built on top of it. I did not merge them, because that would cost the legacy flow and the saved records that still ride it. If the owner wants to migrate those nine records off the legacy purpose, I will do that as its own step.

## Pages in the application today

| Page | File | Purpose | Notes |
|---|---|---|---|
| Home dashboard | [HomePage.tsx](frontend/src/pages/HomePage.tsx) | Command map; role-aware KPI strip; contextual right panel | Rewritten today to the owner reference. |
| Sites workspace | [SitesPage.tsx](frontend/src/pages/SitesPage.tsx) | The registered sites' map and list | Still single map, no clustering. |
| Operational posture | [PosturePage.tsx](frontend/src/pages/PosturePage.tsx) | The currently-stationed layer | Separate route from the home map. |
| Site setup | [SiteSetupPage.tsx](frontend/src/pages/SiteSetupPage.tsx) | Initial stationing and the site boundary (ADR-078) | Owns «تحديد مواقع التمركز المبدئية». |
| New request | [NewRequestPage.tsx](frontend/src/pages/NewRequestPage.tsx) | The request-type chooser | A short hub, not a form. |
| Re-stationing workspace | [RestationingPage.tsx](frontend/src/pages/RestationingPage.tsx) | The request drawer and route to the right editor | Hosts both editors below. |
| Re-stationing editor (map-first) | [DeploymentAreasRequest.tsx](frontend/src/pages/DeploymentAreasRequest.tsx) | New editor for `RESTATIONING` and `DEPLOYMENT_AREAS` | ADR-093. |
| Re-stationing editor (legacy) | [RestationingEditor.tsx](frontend/src/pages/RestationingEditor.tsx) | Opens saved `SITE_REGISTRATION` and `INITIAL_STATIONING` records | Kept for data continuity; no new path leads here. |
| Deployment areas (standalone) | [DeploymentAreasRequest.tsx](frontend/src/pages/DeploymentAreasRequest.tsx) | Same component, mounted under `#restationing/new?purpose=DEPLOYMENT_AREAS` | Same file as the map-first editor. |
| Admin requests | [AllRequestsPage.tsx](frontend/src/pages/AllRequestsPage.tsx) | The full request overview with filters | Scoped by server. |
| Admin requests (legacy) | [RequestsPage.tsx](frontend/src/pages/RequestsPage.tsx) | The pre-ADR-045 requests list | Still linked from «المزيد»; owner may retire it. |
| Review inbox | [ReviewPage.tsx](frontend/src/pages/ReviewPage.tsx) | The approval queue of a role holder | Role-scoped. |
| Access inbox | [AccessInboxPage.tsx](frontend/src/pages/AccessInboxPage.tsx) | Access-request decisions | `MANAGE_ACCESS` only. |
| Access request | [AccessRequestPage.tsx](frontend/src/pages/AccessRequestPage.tsx) | «طلب صلاحية» for the person themselves | Open to zero access. |
| Calendar | [CalendarPage.tsx](frontend/src/pages/CalendarPage.tsx) | Reservation / scheduling calendar | Facilities side. |
| Org tree | [OrgPage.tsx](frontend/src/pages/OrgPage.tsx) | The one units tree | Read-only for most roles. |
| Permissions studio | [PermissionsPage.tsx](frontend/src/pages/PermissionsPage.tsx) | Access policy and role matrix | `MANAGE_ACCESS`. |
| Workflow studio | [WorkflowStudio.tsx](frontend/src/pages/WorkflowStudio.tsx) | Chart of approval flows (ADR-045) | Behind a flag. |
| Forms studio | [FormStudio.tsx](frontend/src/pages/FormStudio.tsx) | Request form designer | `CONFIGURE`. |
| Settings | [SettingsPage.tsx](frontend/src/pages/SettingsPage.tsx) | Grouped settings (policies, identity, HR, migration) | `CONFIGURE`. |
| Stationing policy | [StationingPolicyPage.tsx](frontend/src/pages/StationingPolicyPage.tsx) | The distance/area policy | Separate from Settings. |
| Audit | [AuditPage.tsx](frontend/src/pages/AuditPage.tsx) | The event log | `AUDIT`. |
| Docs | [DocsPage.tsx](frontend/src/pages/DocsPage.tsx) | In-app documentation browser | OKF. |
| Support | [SupportPage.tsx](frontend/src/pages/SupportPage.tsx) | The person's own support thread | Open to everyone. |
| Support console | [SupportConsolePage.tsx](frontend/src/pages/SupportConsolePage.tsx) | The support seat's queue | Seat holders only. |
| Sign-in | [LoginPage.tsx](frontend/src/pages/LoginPage.tsx) | The sign-in form | Public. |

**Candidates for consolidation.** The following duplicate work I would propose to simplify in a later, bounded step — not now:
- [RequestsPage.tsx](frontend/src/pages/RequestsPage.tsx) and [AllRequestsPage.tsx](frontend/src/pages/AllRequestsPage.tsx) — the legacy and the new requests lists. The legacy page is still in «المزيد»; it can be retired once the new one carries every filter it has.
- [StationingPolicyPage.tsx](frontend/src/pages/StationingPolicyPage.tsx) sits beside the new «إعدادات → السياسات والبيئة»; it can be moved under the same page.
- [RestationingEditor.tsx](frontend/src/pages/RestationingEditor.tsx) can be shrunk to only the saved-record branch once no new call site remains.

I did not change any of these in this review; they are listed so the owner sees the picture.

## Role-aware dashboard

The new dashboard reads the person's permissions and loads **only the data the role will use**:

| Role (by permission) | KPI strip first two cards | Attention rows | Right contextual panel |
|---|---|---|---|
| System administrator (`CONFIGURE`) | «طلبات قيد الاعتماد» · «طلبات معادة للتعديل» | Old reviews · temporary soon to end | «حالة النظام»: sites, units, review, attention map, settings quick-actions |
| Final approver (`APPROVE` / `FINAL_APPROVE_STATIONING` / `APPROVE_HIERARCHY`) | «بانتظار قراري النهائي» · «مهام فائتة الموعد» | Final queue · old reviews · temporary soon to end | «صندوق قراراتك»: queue counts and the review-inbox action |
| Reviewer (`REVIEW`) | «مهام المراجعة» · «فائتة الموعد» | Overdue tasks · old reviews | Review-only actions |
| Access manager (`MANAGE_ACCESS`) | «طلبات صلاحية بانتظار قرارك» · «طلبات معادة للتعديل» | Access queue | Access-inbox + permission-centre actions |
| Requester (`CREATE_RESTATIONING` / `CREATE`) | «طلباتي بانتظار قراري» · «طلبات معادة إليك» | Returned-for-changes | My-requests + new-request actions |
| Auditor / viewer (`AUDIT` / `VIEW*`) | Operational counts only | None | Audit + sites actions |
| Zero access | — | — | Identity card and «طلب صلاحية» button |

The server still enforces every call; this role check is **only to stop the UI from offering a page or a count the person cannot act on** (owner, 20 Nov 2026).

## Changes in this task

- [HomePage.tsx](frontend/src/pages/HomePage.tsx) — rewritten as the three-column command map with the role-aware KPI strip, clickable attention rows that filter the map, and a contextual right panel (`site` / `cluster` / `request` / `none`).
- [CommandMap.tsx](frontend/src/components/workspace/CommandMap.tsx) — new component using MapLibre's own clustering (`cluster: true`), `clusterRadius: 50`, `clusterMaxZoom: 12`; cluster amber-rings when any site inside needs attention; priority labels only from zoom 8; the selected site keeps its label whatever the zoom is; a lightweight tooltip on hover.
- CSS — a dashboard-v2 block in [app.css](frontend/src/styles/app.css) for the wide grid and the clickable rows; the existing theme tokens drive the colours.
- [HomePage.tsx](frontend/src/pages/HomePage.tsx) now zooms **in** when a site is selected (owner fix, same turn): the effect that was auto-fitting all points on every filter change was removing camera on selection.

## Checks

- `tsc -b --noEmit` clean · `npm test` 373/373
- Screenshots on :8088 as the platform administrator at **3440×1440, 1920×1200, 1600×1000 and 1366×768**, plus the cluster-detail view when a cluster is clicked, under [docs/evidence/dashboard-v2/](docs/evidence/dashboard-v2/)
- The admin KPI strip now reads «5 طلبات قيد الاعتماد» (correct) instead of the previous «0 طلبات صلاحية» (wrong)

## Not pushed

Per the brief, nothing is committed. The dashboard change is live on :8088 for your visual review. When you approve, I will commit; if any panel or interaction needs to change first, say what and I will adjust before the commit.

## Owner visual review required
