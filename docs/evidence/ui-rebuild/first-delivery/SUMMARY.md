# UI rebuild — first delivery (owner brief «FULL APPLICATION UI REBUILD», §32), 5 Nov 2026

**Status:** built in the real frontend, run against `tmrkz-test`, **uncommitted**, awaiting the owner's visual review. It
is not deployed to `tmrkz-test`, which still serves `mover/web:rel-8400e58-v3` (the earlier interface).

**Scope of this delivery:** the application shell, the Stationing / re-stationing operational workspace and the home
page. The visual target was `C:\Users\ADMIN\Downloads\TMRKZ Smart Positioning Platform.png`; its layout was rebuilt in
React/CSS, never used as an image.

## How it ran

- The Vite development server ran against `tmrkz-test` with real Keycloak/LDAP sign-in:
  `cd frontend && MOVER_API=http://localhost:8088 VITE_STATIONING_V3=true npx vite --config vite.dev.config.mjs --port 5180`.
- The map was served from the installed offline package (`map-data/runtime/current`).
- Fictional data only. One new draft, RS-2026-0056 «اختبار الواجهة الجديدة — لقطات C/D/E (بيانات قبول وهمية)، مسودة لا
  تُرسل», was never submitted; reruns reuse it (`REUSE_DRAFT=RS-2026-0056`).

## Results

| Check | Result |
|---|---|
| Frontend unit tests | 119/119 (17 new: no band on the re-stationing leg, ranges from checks, route strip from the request route, permission-hidden actions, hierarchy from server data); type check and build OK; MapLibre outside the entry chunk |
| Browser (`REUSE_DRAFT=RS-2026-0056 node tests/acceptance/ui-rebuild.mjs`, headless Edge) | 22/22 (`results.json`) |
| Console errors / external requests | 0 / 0 |

The browser run covered:
- **Layout:**
  - right-to-left shell at 1920×1080, 1366×768, 1024×768 and 390×844;
  - the three columns and the approval strip on screen at desktop and laptop sizes;
  - the tablet rail and collapsible context panel;
  - bottom sheets on the phone.
- **Geometry editing:** a two-part MultiPolygon copied, dragged 476 m and saved by the server.
- **Deployment legs:**
  - leg 1 «6.2 كم — ضمن 5–8 كم»;
  - leg 2 «4 كم — ضمن 3–5 كم (حتى 5.5 كم مع الأرض)».
- **Approval strip:** identical to the server's route («مقدم الطلب ← اعتماد المستوى L7 ← اعتماد المستوى L6 ← التفعيل»).
- **Map mode:** street → terrain → street, with the hillshade fetched from the package.
- **Organisation tree:** in the server's order, with the requesting unit highlighted.
- **Permissions:** filtered correctly for the requester, auditor and manager personas.

## Business rule (owner brief §2–§3, §10–§11, §18, §29)

- **Re-stationing has no distance restriction.** Current site → proposed site is a neutral dashed line with
  «المسافة: X كم», and the checks card says «للعلم فقط، لا قيد على مسافة إعادة التمركز». No ring, limit or colour
  verdict is drawn on it.
- **Distance bands exist only for deployment,** from the server's checks under the locked policy:
  - leg 1 around the proposed site («نطاق مسافة الانتشار الرئيسية»);
  - leg 2 around the primary area («نطاق مسافة الانتشار البديلة»).
- **Wording:** «استثناء مسافة إعادة التمركز» appears nowhere; the exception is «استثناء مسافة الانتشار».
- **The reference image's 5 km and 10 km rings around the move were not copied.**

## Against the reference image

**Matches:**
- the dark navy/teal shell with الرئيسية / الطلبات / المواقع / الوحدات / التقارير, search, notifications and identity;
- five action cards on the left;
- the dominant map in a rounded frame, with a floating legend, hatched deployment areas and dashed bands;
- the organisation tree, linked sites and quick links on the right;
- the approval strip along the bottom of the map.

**Differs:**
- no rings on the re-stationing move (business rule);
- the fictional current site usually lies near the proposed one, so the move line is short;
- with a request open, the right panel opens on «الطلب»;
- the page is denser than the image (real checks, actions, lifecycle);
- no «التفعيل المتحكم به» toggle: activation is an independent server action, shown as a button to its holder.

## Defects found and fixed in the new interface

1. The console overflowed the screen; it is now pinned to the screen height.
2. The «انقر على الخريطة لوضع…» hint swallowed map clicks; it is now click-through except its cancel button.
3. An out-of-range deployment row hid the policy range; the range is now always shown.
4. The step buttons' accessible names collided with «منطقة الانتشار الرئيسية»; they are now «الخطوة n».
5. Old `restationing.css` rules overrode the dark console; the superseded rules were removed and the policy page's
   rules kept.

## Screenshots (this folder, the running application)

| Scene | Desktop 1920 | Laptop 1366 | Tablet 1024 | Phone 390 |
|---|---|---|---|---|
| A home | `A-home-desktop.png` | `A-home-laptop.png` | `A-home-tablet.png` | `A-home-mobile.png` |
| B request selected | `B-request-desktop.png` | `B-request-laptop.png` | `B-request-tablet.png`, `B-request-tablet-context-collapsed.png` | `B-request-mobile.png`, `…-requests-sheet.png`, `…-details-sheet.png` |
| C new request, placing the site | `C-new-request-site-desktop.png` | `C-editor-laptop.png` | `C-editor-tablet.png` | `C-editor-mobile.png`, `C-editor-form-sheet-mobile.png` |
| D primary deployment with its band | `D-primary-placing-desktop.png`, `D-primary-placed-band-desktop.png` | `D-primary-placing-laptop.png` | `D-primary-placing-tablet.png` | — |
| E alternative deployment | `E-alternative-placed-desktop.png` | `E-alternative-placing-laptop.png` | `E-alternative-placing-tablet.png` | — |
| F under review with the strip | `F-under-review-desktop.png`, `F-hierarchy-panel-desktop.png` | `F-under-review-laptop.png` | `F-under-review-tablet.png` | `F-under-review-mobile.png` |
| G terrain mode | `G-terrain-desktop.png` | `G-terrain-laptop.png` | `G-terrain-tablet.png` | `G-terrain-mobile.png` |

## Not done in this delivery

- **Login page (§23):** production sign-in is the Keycloak theme under `ops/keycloak`, which was kept out of this
  delivery, and the in-app copy must stay identical to it.
- **Other pages (§22):** they keep their light content under the new dark top bar until the design is approved.
- **Occupied ground in red hatch (§9):** the server returns conflict names, not geometries, so nothing can be drawn
  without a backend change.

## Before this can be committed and deployed

**Existing acceptance scripts expect the old wording.** They still need updating, and their runs against the new
interface have not happened yet.

| Script | Old expectation | New wording |
|---|---|---|
| `restationing-acceptance.mjs` MAP1 and `restationing-geometry.mjs` APPROVER-2 | legend «الموقع المقترح» and «النطاق المسموح» | «موقع إعادة التمركز» and «نطاق مسافة الانتشار» |
| `stationing-layout.mjs` | active navigation item «مساحة التمركز» | «المواقع» |

The geometry script's pointer-release cases need a recheck, because the floating legend now covers the map's
bottom-left.

**Other notes:**
- **Default landing:** an empty address now opens `#home`; `#map` and unknown routes still open the Stationing
  workspace.
- **Backend:** no change. The client now also calls the existing `/stationing/current` and `/site-links`.
- **Not run:** the backend suite (no backend change) and the existing Stationing acceptance scripts against the new
  interface.

## Files

**Changed:**
- `frontend/src/App.tsx`, `main.tsx`, `icons.ts`;
- `api/client.ts`, `api/types.ts`;
- `lib/app.tsx`, `lib/requestMap.ts`, `lib/requestMap.test.ts`;
- `pages/RestationingPage.tsx`, `pages/RestationingEditor.tsx`, `pages/restationing.css`.

**Added:**
- `components/shell/TopNavigation.tsx`;
- `components/workspace/`: `OperationalWorkspace`, `ActionRail`, `RequestDrawer`, `OrgContextPanel`,
  `LinkedSitesPanel`, `ApprovalRouteStrip`, `MapFrame` (legend and mode switcher), `DeploymentCheckCard`,
  `RequestMap`, `MapOverview`, `StatePill`;
- `lib/navigation.ts`, `lib/workspace.ts`, `lib/workspace.test.ts`;
- `pages/HomePage.tsx`, `styles/shell.css`;
- `tests/acceptance/ui-rebuild.mjs`.

The package paths of the map module (`mapPackage.ts`) are used unchanged by `components/workspace/RequestMap.tsx`.
