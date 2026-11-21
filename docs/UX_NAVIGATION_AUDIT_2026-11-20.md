# TMRKZ — UX and navigation audit (20 Nov 2026)

Written for: the owner, before any navigation change ships.

The brief on the table: «the application is confusing because the same work can be reached from several pages, the Home does not change by role, and the user may hold several grants at once so the UI cannot read from one `primaryRole`.»

This document is the audit. It does not change code. It ends with a design proposal and seven mock screens for your review. The source this is written against is `HEAD = e26a422` (`main`) with the working-tree changes of the last session in place for the click-through only.

## 1. Page inventory

Every page under `frontend/src/pages/` is recorded as its route, who may open it today, what it is for, and what I recommend. The final column uses the classification the brief asks for.

| Hash | File | Arabic name | For | Who opens today | Recommendation |
|---|---|---|---|---|---|
| `#home` | [HomePage.tsx](frontend/src/pages/HomePage.tsx) | الرئيسية | The role-aware dashboard | Everyone | **KEEP** (role-composed per §12–§14 of the brief) |
| `#allRequests` | [AllRequestsPage.tsx](frontend/src/pages/AllRequestsPage.tsx) | الطلبات | The unified request hub | Everyone, server-scoped | **KEEP** as the one Requests workspace |
| `#requests` | [RequestsPage.tsx](frontend/src/pages/RequestsPage.tsx) | الطلبات الإدارية | The old facilities/reservations list | Everyone with `VIEW`/`CREATE` | **MERGE** into `#allRequests` as a tab «طلبات المرافق» |
| `#review` | [ReviewPage.tsx](frontend/src/pages/ReviewPage.tsx) | صندوق المراجعة | The approval queue | `REVIEW`, `APPROVE`, `FINAL_APPROVE_STATIONING` | **MERGE** into `#allRequests` as a tab «بانتظار قراري» with the decision panel on the right |
| `#newRequest` | [NewRequestPage.tsx](frontend/src/pages/NewRequestPage.tsx) | طلب جديد | A chooser page (type + unit) | `CREATE_RESTATIONING`, `REQUEST_SITE_REGISTRATION` | **DRAWER** — the chooser becomes an action menu on «＋ طلب جديد», no page of its own |
| `#stationing` | [SitesPage.tsx](frontend/src/pages/SitesPage.tsx) | المواقع | The site list + map + details | `VIEW`/`VIEW_SUMMARY`/`MANAGE_FACILITIES` | **KEEP** as the sites workspace |
| `#restationing` | [RestationingPage.tsx](frontend/src/pages/RestationingPage.tsx) | إعادة التمركز | The re-stationing workspace | `CREATE_RESTATIONING` plus every approver on the route | **KEEP** as the single stationing workspace. Rename to «مساحة التمركز» per the brief |
| `#restationing/new?purpose=…` | [DeploymentAreasRequest.tsx](frontend/src/pages/DeploymentAreasRequest.tsx) | محرر الطلب | The map-first editor (ADR-093) | Requesters | **KEEP** as an editor MODE inside «مساحة التمركز», not a distinct screen |
| `#restationing/<legacy-id>` | [RestationingEditor.tsx](frontend/src/pages/RestationingEditor.tsx) | المحرر القديم | Opens saved `SITE_REGISTRATION` / `INITIAL_STATIONING` records | Final approvers of those records | **LEGACY** — never exposed in navigation; mounted only when a saved record of that purpose is opened. Document the condition and retire once the nine records close |
| `#posture` | [PosturePage.tsx](frontend/src/pages/PosturePage.tsx) | الموقف العملياتي | The current-stationing map | `VIEW_OPERATIONAL_POSTURE` | **MERGE** into `#stationing` as a view mode («الموقف»); the dedicated page stays only while the role cannot open `#stationing` at all |
| `#siteSetup` | [SiteSetupPage.tsx](frontend/src/pages/SiteSetupPage.tsx) | تهيئة المواقع | Initial stationing + boundary | `MANAGE_FACILITIES`, `MANAGE_SITE_LINKS`, `CORRECT_STATIONING` | **MERGE** into `#stationing` as an editor MODE launched from a site; keep the hash for deep links |
| `#org` | [OrgPage.tsx](frontend/src/pages/OrgPage.tsx) | الوحدات | The organisation tree | `VIEW`/`MANAGE_ACCESS`/`MANAGE_FACILITIES`/`CONFIGURE` | **KEEP** as the units workspace |
| `#permissions` | [PermissionsPage.tsx](frontend/src/pages/PermissionsPage.tsx) | مركز الصلاحيات | Access policy + role matrix | `MANAGE_ACCESS` | **ADMIN** group |
| `#accessInbox` | [AccessInboxPage.tsx](frontend/src/pages/AccessInboxPage.tsx) | طلبات الصلاحية | Access-request decisions | `MANAGE_ACCESS` and access final approvers | **MERGE** into `#allRequests` as the tab «طلبات الصلاحية» |
| `#requestAccess` | [AccessRequestPage.tsx](frontend/src/pages/AccessRequestPage.tsx) | طلب صلاحية | «طلب صلاحية» for the person themselves | Everyone, including zero access | **KEEP** (it is the zero-access landing) |
| `#calendar` | [CalendarPage.tsx](frontend/src/pages/CalendarPage.tsx) | الإشغال والحجوزات | The reservation calendar | `VIEW`/`VIEW_SUMMARY`/`MANAGE_FACILITIES` | **KEEP** (facilities side) |
| `#workflow` | [WorkflowStudio.tsx](frontend/src/pages/WorkflowStudio.tsx) | مسار الموافقات | Flow studio (ADR-045) | `CONFIGURE`, flag-gated | **ADMIN** |
| `#forms` | [FormStudio.tsx](frontend/src/pages/FormStudio.tsx) | نماذج الطلبات | Form designer | `CONFIGURE` | **ADMIN** |
| `#settings` | [SettingsPage.tsx](frontend/src/pages/SettingsPage.tsx) | إعدادات النظام | The grouped settings | `CONFIGURE` | **ADMIN** |
| `#stationingPolicy` | [StationingPolicyPage.tsx](frontend/src/pages/StationingPolicyPage.tsx) | سياسة التمركز | The distance/area policy | `CONFIGURE` | **MERGE** into `#settings` as a group («سياسة التمركز»). No reason for a separate page |
| `#audit` | [AuditPage.tsx](frontend/src/pages/AuditPage.tsx) | سجل الإجراءات | The event log | `AUDIT` | **ADMIN** group, but reachable from any detail panel's «السجل» link |
| `#docs` | [DocsPage.tsx](frontend/src/pages/DocsPage.tsx) | التوثيق والتشغيل | OKF browser | Everyone | **SUPPORT** |
| `#support` | [SupportPage.tsx](frontend/src/pages/SupportPage.tsx) | مركز الدعم | The person's own support thread | Everyone | **SUPPORT** |
| `#supportConsole` | [SupportConsolePage.tsx](frontend/src/pages/SupportConsolePage.tsx) | لوحة الدعم | The support seat's queue | Seat holders | **SUPPORT** |
| `/` | [LoginPage.tsx](frontend/src/pages/LoginPage.tsx) | تسجيل الدخول | The sign-in form | Public | **KEEP** |

Summary of the classification:

- **KEEP** — 7 pages (Home, Requests, Sites, Stationing workspace, Units, Access request, Calendar, Login)
- **MERGE** — 6 pages (Requests-admin + Review + Access-inbox + Posture + Site-setup + Stationing-policy)
- **DRAWER** — 1 page (New request chooser)
- **LEGACY** — 1 page (`RestationingEditor`, kept for data continuity only)
- **ADMIN** — 4 pages (Permissions, Flows, Forms, Settings)
- **SUPPORT** — 3 pages (Docs, Support, Support console)

## 2. Transition map (as it is today)

Observed from a full source grep (`href="#"`, `location.hash =`, `history.replaceState`), from the live app walkthrough on :8088, and from the three helper files `navigation.ts`, `requestPurpose.ts` and `restationingRoute.ts`.

```
Home
 ├─ KPI «طلبات قيد الاعتماد» ───→ #restationing
 ├─ KPI «المواقع» ───────────── → #stationing
 ├─ KPI «الوحدات» ────────────── → #org
 ├─ أحدث التنبيهات «سجل التدقيق» → #audit
 ├─ آخر الطلبات (row click) ─── → (right panel update)   (dashboard v2)
 ├─ attention row (with site ids) → (filter map)         (dashboard v2)
 └─ أزرار «إنشاء طلب إعادة تمركز» / «إضافة تمركز مؤقت» / «عرض الموقع»
         ├─ #restationing/new?purpose=RESTATIONING   (opens full-page editor; map/selection lost)
         ├─ #restationing (list)                     (list loses map context)
         └─ #stationing (same as top-nav «المواقع»)

Top bar
 ├─ الرئيسية ────────── → #home
 ├─ ways cluster (3 tabs) → #siteSetup | #restationing/new | #restationing/new  ← full-page each
 ├─ الطلبات ──────────── → #allRequests
 ├─ المواقع ──────────── → #stationing
 ├─ الوحدات ──────────── → #org
 ├─ الاعتمادات ───────── → #review (or #accessInbox when no REVIEW)
 ├─ التقارير ──────────── → #audit (or #calendar)
 └─ إدارة النظام ──────── → #settings
     المزيد (dropdown)   → every other page, including #requests, #stationingPolicy, #permissions …

NewRequestPage (#newRequest)
 ├─ ACCESS card ───────────→ #requestAccess
 ├─ RESTATIONING card ─────→ #restationing/new?purpose=RESTATIONING
 ├─ DEPLOYMENT_AREAS card → #restationing/new?purpose=DEPLOYMENT_AREAS
 └─ SITE_REGISTRATION card → #restationing/new?purpose=SITE_REGISTRATION   (legacy editor)

AllRequestsPage (#allRequests)
 ├─ row «ACCESS and mine»  → #requestAccess
 ├─ row «ACCESS not mine»  → #accessInbox
 └─ row «stationing»       → #restationing/<id>

Sites (#stationing)
 ├─ select site            → #stationing/site/<id>
 ├─ «طلب إعادة تمركز من هذا الموقع» → #restationing/new?site=<id>    (page switches; selection in Sites is dropped)
 └─ «عرض المواقع» from home → #stationing

OrgPage (#org)
 └─ site tag click          → stationing/site/<id>  (page switch; selected unit is lost)

Restationing (#restationing)
 ├─ drawer «+ طلب جديد»     → setEditing({})  (same page, editor opens)
 ├─ select request          → #restationing/<id>
 ├─ open «بدء طلب»          → map-first editor on the same page
 └─ «الصلاحيات والتدقيق»     → #permissions or #audit                (page switch, workspace lost)

Permissions / Settings / Policy
 └─ cross-links (#settings ↔ #stationingPolicy ↔ #permissions)   each is its own page
```

### Problems the map makes visible

1. **Three entry points reach the same editor** — `#newRequest` → card, top-bar `ways` tab, Sites action, and Home card. Each one does a page switch and loses whatever the person was looking at.
2. **Sites → re-stationing starts a fresh editor page and drops the selected site** on the Sites side. The user has to re-find the site to «return» to it.
3. **Review desk is a separate destination** even though its content is a request a person could open from the Requests workspace with a decision panel.
4. **Access requests ride two hashes** depending on whether the row is mine — the user cannot tell beforehand which page they will land on.
5. **StationingPolicy is a separate page** although the owner groups it under Settings mentally.
6. **Attention rows on Home only filter the map; they do not also change the right panel.** The three questions the brief wants answered are not all answered on one click.
7. **Three «way» tabs in the top bar duplicate three actions** inside «مساحة إعادة التمركز», which is already in the top bar.

## 3. Walk-through evidence

I signed in on :8088 as the platform administrator, visited every hash, and captured each page (screenshots under `docs/evidence/ux-audit/`). Headings observed:

- `#home` — «منصة إدارة التمركز والمواقع والاعتمادات» (the new dashboard renders).
- `#allRequests` — «الطلبات».
- `#requests` — «الطلبات الإدارية» (duplicates the first line of `#allRequests` conceptually).
- `#review` — «هذا القسم خارج صلاحياتك الحالية» for the platform admin. Admins have no `REVIEW` grant on purpose; this is correct, but the top-bar «الاعتمادات» should hide itself for admins instead of taking them to a refusal page.
- `#restationing`, `#stationing`, `#siteSetup` — render an operational layout without a heading tag.
- `#posture`, `#newRequest`, `#accessInbox`, `#requestAccess` — «خارج صلاحياتك الحالية» for the admin.
- `#org` — «الهيكل التنظيمي».
- `#permissions` — opens on «ابحث أولاً، ثم اعمل داخل نطاق صغير».
- `#stationingPolicy` — «سياسة التمركز» renders stand-alone.
- `#settings` — «إعدادات النظام» with the grouped headings.
- `#audit` — «سجل الإجراءات».
- `#calendar` — «الإشغال عبر الزمن».
- `#docs` — «التوثيق والتشغيل».

The two take-aways for the owner:

1. **Admin's top bar offers pages the admin is refused from.** The «الاعتمادات» entry opens a refusal; it must be hidden for admins. The current code already has the hook for this (`restriction(view, can, summaryOnly)`), it just isn't applied to the admin case (admins hold `CONFIGURE` but not `REVIEW`).
2. **Three places reach the same stationing editor** from the admin's own navigation: the top-bar way tabs («تحديد مواقع التمركز المبدئية», «طلب مناطق انتشار», «طلب إعادة تمركز»), «المواقع» and «مساحة إعادة التمركز» under «المزيد». That's the owner's «too many ways» complaint, exactly.

## 4. Proposed mental model

Four workspaces and one administration area. **Opening a workspace never asks the person to pick a sub-page; the workspace itself is the page.** Picking a row inside it updates panels, never swaps pages.

```
الرئيسية           (role-composed dashboard)
الطلبات            (one Requests workspace: tabs = my turn · mine · stationing · access · facilities · fyi · all)
التمركز            (one Stationing workspace: tabs = posture · requests · sites · setup — editor opens IN PLACE)
الوحدات            (one Units workspace; a site tag opens a side panel, not a page switch)

المزيد
 ├─ إدارة النظام     (Permissions · Settings · Policy · Flows · Forms · Audit)
 └─ الدعم والتوثيق   (Support · My tickets · Docs)
```

The **Posture**, **Site setup**, **Access inbox**, **Review desk**, **Requests-admin** and **New request** pages are not entries of their own; they are **modes or tabs** inside the four workspaces.

## 5. Proposed top navigation

```
[ تمركز logo ]   الرئيسية   الطلبات   التمركز   الوحدات   المزيد ▾           🔔  ❔  🌓  profile
                                                                                                 ┌─────────┐
                                                                                                 │ +  إنشاء │
                                                                                                 └─────────┘
  «المزيد» opens:
   ┌───────────────────────────┐
   │ إدارة النظام              │
   │   مركز الصلاحيات          │
   │   إعدادات النظام          │
   │   سياسة التمركز           │
   │   مسار الموافقات          │
   │   نماذج الطلبات           │
   │   سجل الإجراءات           │
   │ ───────────────────────── │
   │ الدعم والتوثيق            │
   │   مركز الدعم              │
   │   لوحة الدعم              │
   │   التوثيق                 │
   └───────────────────────────┘

  «+ إنشاء» is a global action (visible only to roles that may create):
   ┌───────────────────────────┐
   │ إعادة تمركز               │
   │ مناطق انتشار              │
   │ تهيئة موقع                │
   │ طلب صلاحية                │
   └───────────────────────────┘
```

Changes from the current top bar:
- Four work entries, not seven.
- The three «ways» currently inlined in the top bar come into the global **＋ إنشاء** menu — same actions, no middle page.
- «إدارة النظام» is folded into «المزيد» (the brief §20 asks exactly this).
- The top bar hides entries the person's role cannot open; the current refusal pages for the admin's «الاعتمادات» disappear.

## 6. Proposed Home — three variants

The dashboard already reads live permissions and decides what to render; the proposal below sharpens the three distinct shapes.

### 6.1 Home — Requester (holds `CREATE_RESTATIONING` and/or `CREATE`)

```
┌───────────── Hero: اسم · مقدم طلب · وحدتي ──────────────┐

 [ 3  طلباتي بانتظار قراري ]  [ 1  طلبات معادة إليك ]
 [ 2  التمركز المؤقت لوحدتي ] [ 5  مواقع وحدتي ] [ 192 الوحدات ] [ +  إنشاء طلب ]

┌───────────────┬───────────────────────────┬────────────────┐
│ ما يحتاجك     │          الخريطة          │ تفاصيل         │
│  • 1 مُعاد   │   (مواقع وحدتي + طلباتي)   │  (ملخص ما أختاره) │
│  • 1 بانتظار │                            │                  │
│    قراري     │                            │                  │
│              │                            │                  │
│ طلباتي        │                            │  ─── أزرار:     │
│  RS-0045 …   │                            │   • ＋ إعادة تمركز │
│  RS-0033 …   │                            │   • عرض الموقع    │
└───────────────┴───────────────────────────┴────────────────┘
```

CURRENT: this person today sees a chooser («طلب جديد»), a map that is not their units, and no sense of «my» work.
PROPOSED: the person sees only their own work and their own units on the map; `+ إنشاء` is one click.
WHY: the brief §12 requires per-capability data. A requester's Home shows requests the requester owns, not a stationing-wide queue.

### 6.2 Home — Unit Operations / Approver (`DECIDE_UNIT_OPERATIONS` or `FINAL_APPROVE_STATIONING`)

```
┌───────────── Hero: اسم · صاحب اعتماد عمليات الوحدة ──────────────┐

 [ 4  بانتظار قراري ]  [ 2  فائتة الموعد ]
 [ 5  قيد الاعتماد ]    [ 3  مواقع تحتاج انتباه ] [ 64 متمركزة ] [ 82 المواقع ]

┌───────────────┬───────────────────────────┬────────────────┐
│ ما يحتاج قراري │          الخريطة          │ صندوق قراراتك   │
│  • 4 تنتظر    │  (علامات الطلبات التي قراري │  (عند تحديد    │
│    قراري      │   يفصل فيها بشعلة عنبرية)  │   طلب: مسار،   │
│  • 2 فائتة    │                            │   القرار)      │
│              │                            │                  │
│ آخر طلبات ...│                            │                  │
└───────────────┴───────────────────────────┴────────────────┘
```

CURRENT: the approver opens «صندوق المراجعة» as a separate page; the map does not show which requests are theirs.
PROPOSED: the dashboard emphasises the queue, and selecting a row updates the map (highlighted sites) AND the right panel (decision context).
WHY: the brief §9 wants the review desk folded into one workspace; one click on the row is enough.

### 6.3 Home — System administrator (`CONFIGURE`, without operational grants)

```
┌───────────── Hero: اسم · مدير النظام ──────────────┐

 [ 5  طلبات قيد الاعتماد (نظامياً) ]  [ 2  طلبات معادة للتعديل ]
 [ الدليل: يعمل ]  [ Keycloak: يعمل ]  [ HR: 192 وحدة · آخر مزامنة اليوم ]  [ ترحيل: لا يوجد انتظار ]

┌───────────────┬───────────────────────────┬────────────────┐
│ ما يحتاج النظام │          الخريطة          │ حالة النظام    │
│  • مدير دون    │ (المواقع · التمركزات)     │  192 وحدة ·    │
│    وحدة        │                            │   82 موقع       │
│  • اتصال HR مر │                            │                  │
│    هو          │                            │  ─── إجراءات:    │
│                │                            │   • الإعدادات   │
│                │                            │   • الصلاحيات   │
│ أحدث الأحداث  │                            │   • التكاملات   │
└───────────────┴───────────────────────────┴────────────────┘
```

CURRENT: admin's dashboard still shows operational KPIs the admin never touches (temporary stationing, overdue approval queues).
PROPOSED: admin's dashboard emphasises integration state, HR sync and configuration warnings; operational counts are present but smaller and informational.
WHY: the brief §12 (CONFIGURE) explicitly asks for this.

## 7. Proposed unified screens

### 7.1 Requests workspace — selected request

```
الطلبات                                                       [ + إنشاء ]
┌─ Tabs ───────────────────────────────────────────────────────────────┐
│ بانتظار قراري (4)  طلباتي (3)  تمركز (25)  صلاحية (6)  مرافق  للعلم  │
└────────────────────────────────────────────────────────────────────┘

┌──────────────┬─────────────────────────────────┬──────────────────────┐
│  LIST        │  REQUEST DETAIL                 │  MAP / ACTIONS       │
│              │                                 │                      │
│  RS-0044 ●  │  RS-2026-0044                   │  (مواقع الحالي وا    │
│  (قيد الاعت) │  شعبة السهل → موقع الرويس       │   لمقترح على الخري   │
│              │                                 │   طة)                │
│  RS-0043    │  الحالة: قيد الاعتماد            │                      │
│  (مؤقت)     │  المرحلة: اعتماد عمليات الوحدة   │                      │
│              │                                 │  ─── أزرار:         │
│  RS-0042    │  (ملخص المحتوى + أزرار القرار)  │   • اعتماد           │
│  (مُعاد)    │                                 │   • إعادة            │
│              │                                 │   • فتح الطلب كاملًا │
└──────────────┴─────────────────────────────────┴──────────────────────┘
```

CURRENT: `#review`, `#allRequests`, `#requests`, `#accessInbox` are four pages for one piece of work.
PROPOSED: one Requests workspace, tabs switch the queue; selection updates the detail and map panels; «فتح الطلب كاملًا» is the one page-switch button, for a full editor view.
WHY: the brief §8 and §9 ask for exactly this mental model.

### 7.2 Stationing workspace — site selected

```
التمركز                                                       [ + إنشاء ]
┌─ Tabs ──────────────────────────────────────────────────────┐
│  الموقف    الطلبات    المواقع    التهيئة                   │
└────────────────────────────────────────────────────────────┘

┌──────────────┬───────────────────────────────────┬──────────────────────┐
│  SITES       │  MAP (selected site highlighted)  │  SITE DETAILS         │
│  (filtered   │                                   │                       │
│  by tab)     │                                   │  موقع الرويس           │
│              │                                   │  منطقة الرويس         │
│  • الرويس •  │                                   │  (متمركز حالياً)       │
│  • السهل     │                                   │                       │
│  • كيف الرؤ  │                                   │  ─── أزرار:           │
│              │                                   │   • إعادة تمركز       │
│              │                                   │   • تهيئة الموقع      │
│              │                                   │   • فتح الموقع كاملاً │
└──────────────┴───────────────────────────────────┴──────────────────────┘
```

### 7.3 Stationing workspace — editor open in place

```
التمركز  ·  طلب إعادة تمركز جديد (مسودة)                   [ ← إلغاء ]
┌─ Step tracker ──────────────────────────────────────────────────┐
│ الوحدة · الموقع الحالي · الموقع الجديد · مناطق الانتشار · إرسال │
└────────────────────────────────────────────────────────────────┘

┌────────────┬───────────────────────────────┬─────────────────────┐
│  STEP      │  MAP (editable)               │  CONTEXT (same site │
│  QUESTION  │                               │   stays selected    │
│            │                               │   from before entry │
│  «اختر     │  (شكل الحدود يُنسخ ويُنقل)    │   into editor)       │
│   الوحدة»  │                               │                     │
│            │                               │  ─── الخطوة الحالية │
│            │                               │                     │
└────────────┴───────────────────────────────┴─────────────────────┘
```

CURRENT: opening the editor swaps the whole application shell; the selected site in Sites is lost; «العودة» goes back to the top of the Sites list.
PROPOSED: the editor opens inside the stationing workspace; the step tracker replaces the tabs; the map remains the same object; «← إلغاء» returns to the same site on the same tab.
WHY: the brief §10 and §17 (master → detail) and §18 (preserve context).

## 8. What this does not change

- No server rule changes; every tab filter is still a server-scoped read. Clusters, counts and lists are drawn only from data the person was already allowed to see (brief §23).
- The empty-installation rule (ADR-094) stays: with no units, no sites, no stationings, nothing is drawn in the middle and no map instance is created (brief §24).
- `RestationingEditor` stays in the codebase for the nine saved `SITE_REGISTRATION` / `INITIAL_STATIONING` records; it is not exposed in any menu and does not render for a new request. If those records close or are migrated to the new purposes, it can be retired in one later step.

## 9. Implementation plan (for your approval, in this order)

1. Consolidate the three top-bar «way» tabs into a global «＋ إنشاء» menu. Remove the three tabs from the top bar; they still work from the menu.
2. Add tabs inside `#allRequests`: «بانتظار قراري»/«طلباتي»/«تمركز»/«صلاحية»/«مرافق»/«للعلم»/«الكل». Add a detail panel on the right. Keep `#review` and `#accessInbox` as deep-link redirects into the right tab for backward compatibility.
3. Add tabs inside `#stationing`: «الموقف»/«الطلبات»/«المواقع»/«التهيئة». `#posture`, `#siteSetup` and `#restationing` remain as deep-link redirects; the editor opens IN PLACE (brief §4).
4. Move «سياسة التمركز» under `#settings` as a group («سياسة التمركز»). Keep `#stationingPolicy` as a redirect.
5. Hide top-bar entries the signed-in person cannot open (the admin's «الاعتمادات» disappears for an admin without a review grant).
6. Replace the Home's `href="#"` quick-action buttons with calls that preserve the workspace context (e.g. «عرض الموقع» from Home opens `#stationing` with that site pre-selected, not the first row).

Each step is small and testable on its own; each keeps the backend untouched.

## 10. Risks

- Deep-link bookmarks. `#review`, `#accessInbox`, `#posture`, `#siteSetup`, `#stationingPolicy`, `#newRequest` will be in users' bookmarks; they must redirect, never 404.
- Keyboard and screen-reader users rely on top-level landmarks; tabs inside a workspace must announce themselves correctly.
- A tabbed Requests workspace that opens a detail panel on selection still needs a «فتح الطلب كاملًا» page for workflows a panel cannot host (full form editor, policy exception dialog).

## 11. Not implemented

Nothing in this document is in code yet. The current working tree holds the role-aware dashboard and the integration/HR work from the earlier sessions. The nine screens produced for the walkthrough are at `docs/evidence/ux-audit/`.

## OWNER UX REVIEW REQUIRED

Please mark which parts of §4, §5, §6 and §7 you approve, and whether the §9 order is the one you want. I will not touch navigation until you confirm.
