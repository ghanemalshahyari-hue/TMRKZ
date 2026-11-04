# Stationing V3 — real-application acceptance on `tmrkz-test` (4 Nov 2026)

Fictional acceptance environment `tmrkz-test` (`ACCEPTANCE / V19`). Everything ran through the real stack:

- backend `mover/backend:rel-99c7ede`;
- web `mover/web:rel-b8f62e8-v3`, then `mover/web:rel-cea09c7-v3` after the fix below;
- real sign-in through Keycloak and LDAP, in the browser and for API sessions;
- OpenFGA in the loop;
- GLO-30 terrain dataset `copernicus-glo30 2026.11`;
- headless Edge.

Prototype results are not used as evidence.

## 1. Acceptance policy — published through the real studio

Script: `tests/acceptance/publish-acceptance-policy.mjs`. Signed in as `t.admin` through Keycloak, then on
`#stationingPolicy`:

1. imported `ops/test-env/acceptance-v3-policy-template.json` with the page's own button;
2. set the owner's remaining decisions in the page;
3. ran «فحص على الخادم» → «القيم صالحة للنشر», no problems;
4. «نشر نسخة جديدة».

No SQL, no direct API publication.

**Published version 1, in force since 2026-11-04T07:54:23Z, open-ended.**

| Field | Published value |
|---|---|
| Routing | start at the requesting unit (`SELF`); L6, L7, L8, L9, L10 approve; final L6 only |
| Stage labels | «اعتماد المستوى L6» … «اعتماد المستوى L10» (neutral, derived from the level) |
| What hierarchy stages rest on (L7–L10) | SCOPE, CLASSIFICATION, DURATION, SITE, DEPLOYMENT — owner model V2 §4.5 as kept by V3 («مراحل الهيكل تعتمد على النطاق والتصنيف والمدة والموقع», the site including the two deployment areas). The final stage rests on every fact |
| Deployment areas | REQUIRED («مطلوبتان») |
| Primary range | 5,000–8,000 m, terrain applies |
| Alternative range | 3,000–5,000 m, terrain applies |
| Allowances (maximum only, MAX_ONLY) | FLAT 0, UNDULATING 500, ROLLING 1,000, HILLY 1,500, MOUNTAINOUS 2,000 m |
| Tie priority | MOUNTAINOUS > HILLY > ROLLING > UNDULATING > FLAT |
| Footprint maximum | 500,000 m² (0.5 km²) |
| Cross-branch | allowed; OTHER_UNIT + SITE_RESPONSIBLE; independent approvals OFF |
| Distance exception (O-17) | enabled, `maxExtraM` 2,000 — ACCEPTANCE TEST VALUE |
| Terrain classification | `copernicus-glo30` `2026.11`; FLAT 0–2 %, UNDULATING 2–10 %, ROLLING «تضاريس متدرجة» 10–15 %, HILLY 15–30 %, MOUNTAINOUS ≥ 30 % |
| Author | مدير النظام التجريبي (`t.admin`) |
| Reference | ACCEPTANCE-V3-POLICY-1 |
| Reason | «سياسة اختبار قبول Stationing V3 — بيانات وهمية، ليست إعدادات إنتاج (ACCEPTANCE TEST POLICY — NOT A PRODUCTION DEFAULT; exception.maxExtra 2 km = ACCEPTANCE TEST VALUE)» |

**Read-back:** 15/15 checks pass, including that no development value or extra field appears (`policy-publication.json`,
`policy-published.json`).

**First publishing run:** `policy-publication-run1.txt`. Its V8 comparison failed only on JSON key order; the values were
correct.

**Audit** (`policy-audit.json`): `STATIONING_POLICY_PUBLISHED`, with the time, the actor's name, the reason, the reference,
the version, the effective date and the old and new value of every field. The audit entry has no actor role or
organisation; that is an observation, not changed here.

**Screenshots:** `P-studio-filled.png`, `P-studio-validated.png`, `P-studio-published.png`.

## 2. Journeys — results

**Run 1** (all journeys, web `rel-b8f62e8-v3`): 43 pass, 4 fail, 5 notes (`run1-all-journeys.txt`, `results.json`).

**Run 2** (the failed journeys A, D and K after the fix, web `rel-cea09c7-v3`, layouts moved 40 km south with
`SHIFT_M=-40000`): 18 pass, 0 fail, 1 note (`results-ADK.json`).

| Journey | Result | Request(s) | Route (stages) |
|---|---|---|---|
| A permanent, decided and activated on the real page | PASS (run 2) | RS-2026-0012 (run 1: RS-2026-0001) | 2: L7 الخدمات المشتركة → L6 المؤسسة (final) |
| X exception: normal / within 2 km / too far | PASS | RS-2026-0002, RS-2026-0003 | 3: L7 → «اعتماد استثناء مسافة الانتشار» → L6 |
| B temporary, real scheduler | PASS | RS-2026-0011 | 2: L7 إدارة التقنية → L6 |
| C occupied deployment, hard block | PASS | RS-2026-0004 | refused at submission |
| D terrain: FLAT and a non-zero allowance | PASS (run 2) | RS-2026-0013 (run 1: RS-2026-0005) | 2: L7 → L6 |
| E cross-branch | PASS | RS-2026-0006 | 3: L7 → «موافقة الوحدة من الفرع الآخر» → L6 |
| F return and resubmission, selective re-approval | PASS | RS-2026-0006 | as E |
| G hierarchy change through HR sync | NOT RUN on `tmrkz-test` (no HR source); PASS in `RestationingHrSyncIT` | — | 3 → 3, rebuilt |
| S security refusals by direct API calls | PASS | RS-2026-0007 (rejected at the end) | 2 |
| K boundary cases in the real editor | PASS (run 2) | drafts, see §5 | — |

**Routes from deeper levels.** The acceptance data has requesters and seat holders only at L7 and L6. The longer
ancestry routes were therefore not exercised on this environment: L8 → L7 → L6, and L10 → L9 → L8 → L7 → L6. They are
covered by the backend tests:

- `RestationingWorkflowIT`: L8 → L7 → L6, and a team at L10 whose level does not approve there;
- `RestationingHrSyncIT`: L8 → L7 → L6.

Neither L9 nor a full five-stage route is exercised anywhere yet.

**Update (same day, after the owner's decision):** routes from L8, L9 and L10 were then provisioned and pass on
this environment, the five-stage one decided on the page by five different people (`ROUTES-L8-L10.md`).

**A — permanent**

- Draft checks pass, with no exception needed.
- Submitted on the page; policy version 1 locked.
- The ancestry route has no unrelated unit.
- Each stage was approved on the page by its own seat holder: «مدير الخدمات المشتركة» (`t.manager`), then «صاحب الاعتماد التجريبي» (`t.approver`).
- Activated on the page by the independent activator «مراجع المرافق التجريبي».
- The new authoritative stationing (origin REQUEST) appears in the read contract.
- Site links are unchanged (O-14).

**X — distance exception**

| Case | Measured | Result |
|---|---|---|
| Normal (FLAT) | primary 6,004 m in 5,000–8,000 | OK, no exception stage |
| Within maxExtra | primary 9,005 m; effective maximum 8,000, exception maximum 10,000 | NEEDS_EXCEPTION |
| Too far | primary 10,606 m, beyond 10,000 | OUT_OF_RANGE |

- **Within maxExtra:**
  - without a reason, the check asks for one;
  - with a reason, a separate stage sits immediately before the final stage;
  - the reason is in the submitted content and in the audit entry `RESTATIONING_SUBMITTED` of RS-2026-0002;
  - the L6 seat holder without the permission is refused with 403;
  - `t.approver2`, who holds «اعتماد استثناء مسافة الانتشار», decides it;
  - then the final stage: APPROVED_NOT_ACTIVATED.
- **Too far:** refused at submission (400) even with a reason. No exception stage.

**C — occupied deployment.** A deployment area over site 01 «المقر الإداري» is refused by the checks and at submission
(O-08).

**D — terrain** (real GLO-30 cells)

| Case | Measured | Result |
|---|---|---|
| FLAT | area 8 km south of the run-2 layout: FLAT 100 % | +0 m, range stays 5,000–8,000 |
| Non-zero allowance (Hajar foothills) | MOUNTAINOUS 67.4 %, HILLY 17.4 %, ROLLING 9.2 %, UNDULATING 5.9 % → MOUNTAINOUS +2,000 m | primary 9,205 m, accepted in 5,000–10,000 (base 5,000–8,000); the minimum is unchanged, so the allowance applies to the maximum only |

- In the D request, the alternative area is UNDULATING +500 m: 3,496 m, accepted in 3,000–5,500.
- Run 1 also showed a non-zero allowance applied automatically in journey A: UNDULATING +500 m, range 5,000–8,500.
- D1 failed in run 1 because the test assumed the ground near the acceptance sites was flat, when real GLO-30 data
  classifies it UNDULATING. The test now searches for a FLAT area instead of assuming one.
- An exact area tie on real cells is not practical to construct. The tie, the priority and the block are proven on a
  synthetic raster (`StationingFoundationIT`, `StationingRulesTest`).

**E + F — cross-branch, then return**

- Another branch's unit (إدارة المشاريع) is never moved implicitly.
- Explicit inclusion adds one stage of that unit, satisfying OTHER_UNIT and SITE_RESPONSIBLE. The same unit is
  responsible for its site, and independence is OFF.
- The final stage returned the request. The requester moved the alternative area and resubmitted:
  - changed = DEPLOYMENT only;
  - the L7 decision (it rests on DEPLOYMENT) was taken again;
  - the cross-branch decision was CARRIED (it rests on SCOPE and SITE);
  - the request completed: APPROVED_NOT_ACTIVATED.

**B — temporary**

- Approved and activated as TEMPORARY_SCHEDULED: start 08:06:17Z, end 08:09:17Z.
- At 08:07:04Z the real 60-second scheduler had started it. The authoritative stationing showed «مكتب التقنية»
  PERMANENT (kept) and «موقع RS-2026-0011» TEMPORARY until 08:09:17Z.
- At its end it returned automatically: TEMPORARY_RETURNED, the temporary record ended RETURNED, and «مكتب التقنية»
  PERMANENT is again the only stationing.
- No test clock: the real scheduler ran.

**S — security** (direct API calls; the page buttons are not relied on)

| Attempt | Result |
|---|---|
| The requester approves their own request | 403 SEPARATION_OF_DUTIES |
| The seat holder delegates the seat to the requester (real `POST /delegations`), who then approves | 403 SEPARATION_OF_DUTIES; delegation revoked afterwards |
| A user of another branch reads the request | 404 |
| The same user decides on it | 404 |
| Another unit's approver decides | 404 |
| The final approver decides before the current stage | 403 |
| Activation before final approval | 400 |
| Close the security request | REJECTED |

A second account of the same human: accepted by the owner as backend/OpenFGA evidence (`RestationingWorkflowIT`).

**G — hierarchy change.** Not run on `tmrkz-test`:

- its HR source is disabled, with no connection settings;
- its HR mirror was loaded by `ops/test-env/seed.sql`;
- the synchronisation reads Oracle only (JDBC thin);
- direct SQL is not used as equivalent evidence.

`RestationingHrSyncIT` drives the application's own path on PostgreSQL + OpenFGA:

1. the Oracle-compatible test source of `HrSyncAcceptanceIT` (read-only views) moves L8 SEC from DEPT_A to DEPT_B;
2. the administrator's `POST /hr/sync` runs the same `HrSyncService` as the hourly sync, projects the change and
   publishes the snapshot;
3. the request is paused immediately after the sync returns: «تغير الهيكل التنظيمي بعد تقديم الطلب»,
   `RESTATIONING_PAUSED` audited;
4. the next decision and activation are refused;
5. reconfirmation needs a reason;
6. the new route SEC → DEPT_B → TOP is derived from the same requesting unit;
7. the earlier route SEC → DEPT_A → TOP is kept with its two decisions;
8. every stage is decided again, and activation stays blocked until the last one;
9. activation then succeeds;
10. the hierarchy is restored through the same sync.

Result: 1/1 PASS.

## 3. Map and browser

Checked on the real page, run 2:

- **Street mode:** the basemap, current site, proposed site, both deployment areas and the guidance rings are drawn.
  1,342 distinct colours in the middle of the map; a blank map has one. The legend names every layer.
- **Terrain mode:** GLO-30 hillshade with the notice «Copernicus GLO-30 — نموذج سطح DSM وليس تضاريس رسمية» and the
  Copernicus attribution; 1,142 colours. Switching back to street mode keeps the request selected.
- **Labels:** Arabic labels shape correctly, with the bracket the right way round («موقع RS-2026-0001 (الحالي)»).
- **Requests:** 0 external requests in both runs. 0 console errors in run 2.
- **Observation:** at the zoom that fits both sites, the labels of the proposed site and the two deployment areas
  overlap.

Screenshots: `MAP-street.png`, `MAP-terrain.png`, and the centre crops.

## 4. Defects found and fixed — commit `cea09c7`

This commit is functional and separate from the evidence commit.

1. **Blank map in the web image.**
   - Cause: nginx served MapLibre 6's ES-module worker (`.mjs`) as `application/octet-stream`. Under
     `X-Content-Type-Options: nosniff` the browser refused it («Worker failed to load» on every V3 page), so the map
     drew nothing.
   - Why earlier checks missed it: the Vite development server serves `.mjs` correctly, and the first check (MAP1)
     looked at the legend only.
   - Fix: `frontend/nginx.conf` serves `.mjs` assets as `text/javascript`, with the same cache and nosniff headers.
   - The map check now also requires drawn pixels.
2. **Misleading copy fallback.**
   - Cause: «نسخ حدود الموقع الحالي» said «لا حدود مسجلة» for a MultiPolygon current site, which does have boundaries.
   - Fix: it now states that the boundaries have several parts and that grouped copying is not built yet. A Point
     says it has no footprint. Both point to «رسم حدود جديدة», which is now the draw button's label. The geometry is
     never reduced, merged or hulled. Unit test added.
3. **Checks:** frontend 94/94; build OK.
4. **New image:** `mover/web:rel-cea09c7-v3`, `sha256:5c7eeaa1be30064f0c41aa98a17dd6db5b4828b0a2dfdc03c8b26c12fae97c3f`,
   built from `git archive cea09c7`. Swapped with `upgrade-web.sh`; the worker is now served as `text/javascript`.
   Evidence: `docs/evidence/acceptance-upgrade/tmrkz-test-web-v3-cea09c7/`.
5. **Recovery images kept:** `mover/web:rel-b8f62e8-v3`, `mover/web:1.0.0`.

## 5. Boundary cases (K) and the acceptance-test drafts

| Current site | Observed in the real editor (run 2) |
|---|---|
| Polygon (الخدمات المشتركة, its site from journey A) | copied: «نُسخت حدود «موقع RS-2026-0012» — انقر على الخريطة حيث تريد نقلها» |
| MultiPolygon (site 05 «مركز التدريب الإداري», moving unit قسم الخدمات العامة, requested by HR unit الخدمات المشتركة) | not copied: «حدود «مركز التدريب الإداري» متعددة الأجزاء؛ نسخها مجموعةً واحدة لم يُنفَّذ بعد — استخدم «رسم حدود جديدة»». The owner-approved grouped copy-and-move is implementation work |
| Point (site 06 «مكتب التقنية») | not copied: «مسجل نقطةً بلا حدود، فلا شيء يُنسخ — استخدم «رسم حدود جديدة»». Nothing is synthesised |

**Acceptance-test drafts.** These are NOT business requests. Each one's reason reads «مسودة اختبار قبول — سلوك نسخ
الحدود (…) — بيانات وهمية، ليست طلب عمل». There are six, three per run:

| Run | Polygon | MultiPolygon | Point |
|---|---|---|---|
| 1 | RS-2026-0008 (`a8c06e2d…`) | RS-2026-0009 (`27934ab5…`) | RS-2026-0010 (`ce496c2b…`) |
| 2 | RS-2026-0014 (`36bdf7c4…`) | RS-2026-0015 (`78d37e4a…`) | RS-2026-0016 (`17174597…`) |

Full IDs are in `results.json` and `results-ADK.json`.

## 6. State left on `tmrkz-test`

**Policy:** version 1, as above.

**16 requests:**

| State | Requests |
|---|---|
| Activated permanent (الخدمات المشتركة moved twice) | RS-2026-0001, RS-2026-0012 |
| Approved, not activated | RS-2026-0002, RS-2026-0005, RS-2026-0006, RS-2026-0013 |
| Rejected | RS-2026-0007 |
| Temporary returned | RS-2026-0011 |
| Drafts (refused checks) | RS-2026-0003, RS-2026-0004 |
| Acceptance-test drafts | the six above |

The fictional HR hierarchy is unchanged; journey G did not run here.
