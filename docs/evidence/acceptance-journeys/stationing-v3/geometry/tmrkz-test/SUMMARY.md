# Stationing V3 geometry editing — acceptance on `tmrkz-test` (4 Nov 2026)

**Owner gate:** «GEOMETRY IMPLEMENTATION → `tmrkz-test` ACCEPTANCE GO».

**Result:** 33/33 PASS on the final run (`results.json`, `final-run.log`):
- 0 console errors and 0 external requests;
- 0 long tasks during any drag, measured with a verified instrument.

## Where it ran

| | |
|---|---|
| Environment | `tmrkz-test` (`ACCEPTANCE / V20`): real Keycloak/LDAP sign-in, the real V3 page, the real backend and OpenFGA, the published policy v1 (`ACCEPTANCE-V3-POLICY-1`, maximum footprint 500,000 m²), GLO-30 terrain |
| Backend | `mover/backend:rel-58423ce` (`sha256:203c81ca…6331`), built from C6 `58423ce` |
| Web | `mover/web:rel-9e02088-v3` (`sha256:f56a0753…fda0`), built from `9e02088`: C6 plus the APPROVER-3 fix below |
| Release record | `docs/evidence/acceptance-upgrade/tmrkz-test-geometry-58423ce/summary.txt` |
| Script | `MOVER_URL=http://localhost:8088 node tests/acceptance/restationing-geometry.mjs` (headless Edge, acceptance profile) |

**What the script checks against:**
- every geometry claim against what the server saved;
- move and activation claims also against PostGIS, read in read-only transactions.

**Fictional sites and personas:**

| Case | Persona | Moving unit | Current site |
|---|---|---|---|
| Polygon | `t.requester` | «الخدمات المشتركة» | «موقع RS-2026-0022» (4 vertices) |
| Two-part MultiPolygon | `t.requester` | «قسم الخدمات العامة» | site 05 «مركز التدريب الإداري» (2 parts, a real acceptance site) |
| Four-part MultiPolygon | `t.requester.pm` | «قسم قبول الأداء — موقع من أربعة أجزاء» | `ACC-GEO-MP4` (acceptance fixture) |
| 1,500-vertex polygon | `t.requester.pm` | «قسم قبول الأداء — موقع كثيف الرؤوس» | `ACC-GEO-DENSE` (acceptance fixture) |

- **Approvers:** `t.manager` (L7) and `t.approver` (L6).
- **Activator:** `t.facilities`.
- **Fixtures:** `docs/evidence/acceptance-data/geometry-fixtures/`.

## Results (final run)

**G1 — Polygon, grouped move**
- The saved COPY equals the current site.
- One drag moved it 363 m. Area change 0.0000 %; largest edge change 0.000 m.
- The server accepts the geometry: 89,938 m².
- After reload and reopening, the editor holds the identical geometry.

**G2 — Polygon, vertex edit**
- One vertex moved; the other vertices are identical.
- The live readout and the server both show 111,134 m² (area parity).
- Stored as EDITED; after reload, identical.

**G3 — MultiPolygon copied whole (site 05)**
- Both parts, in order, with identical coordinates.
- Message «نُسخت حدود «مركز التدريب الإداري» كاملة (2 أجزاء) — اسحب أي جزء: كل أجزاء الموقع ستنتقل معاً», and the banner.

**G4 — Grouped move.** Tolerance: the accepted engine's own, 0.5 m for lengths and distances and 0.1 % for area
(`siteGeometry.test.ts`, `footprint.test.ts`).

| Site | PostGIS (WGS84 spheroid) |
|---|---|
| Two parts | Every vertex moved 380.081 m (spread 4.2 mm); distance between part centroids changed by ≤ 0.01 mm; area change 0.00002 % |
| Four parts | Every vertex moved 378.426 m (spread 12.4 mm); all 6 part-centroid distances changed by ≤ 0.05 mm; area change 0.00002 % |

**G5 — Component vertex edit**
- A vertex of part 2 moved; part 1 is byte-identical.
- The shape is still valid; readout «الجزء النشط: 2 · الرأس 1».
- Stored as EDITED; after reload, identical.

**G6 — Invalid edit blocked**
- Immediate warning «الحدود غير صالحة: حدود متقاطعة ذاتياً», and «إرسال للاعتماد» disabled.
- The server refuses it (`details.problems` contains «حدود الموقع المقترح: متقاطعة أو غير صالحة (Self-intersection…)»):
  submission 400, and the request stays a DRAFT.

**G7 — Maximum area, hard block**
- A vertex was pulled out at zoom 12, landing 0 m from the aimed point: 792,077 m² against 500,000 m².
- Immediately: «المساحة تتجاوز الحد الأقصى المعتمد».
- Server: «مساحة الموقع المقترح (792088 م²) تتجاوز الحد الأقصى المعتمد (500000 م²)»; submission 400; still a DRAFT.

**G8 — History**
- Sequence: initial → move → vertex → undo vertex → undo move → redo move → redo vertex → reset → undo.
- Each state was saved and compared with the server: all exact.

**G9 — Redraw only by choice**
- Declined: the copy stays (COPY).
- Accepted: «أُلغيت الحدود السابقة بطلبك», and the new shape is saved as DRAWN with no `copiedFrom`.

**PTR — Pointer released over the map attribution, over the map-source notice, and outside the canvas**
- In each case the drag ends at the release, the move is committed, and the saved site sits where the pointer was released.
- Moves: 744, 902 and 1,219 m; each 1.09 m from the release point. That is a constant half-pixel convention at
  2.17 m/px; the bound is 3 m.
- A pointer moving on afterwards without a button does not move the site.

**Approver and revisions**
- The edited two-part MultiPolygon, with its deployment areas, was submitted (200; route L7 ← L6).
- The approver `t.manager` receives exactly the submitted geometry:
  - type MultiPolygon, 2 parts, «الإرسالات (1)»;
  - revision 1 in the database holds the same geometry.
- The request page now states «الموقع المقترح: مضلع متعدد · 2 أجزاء · 12,889 م² · الإرسال #1» (APPROVER-3).
- The approver returned it; the requester moved the site 112 m on the page and resubmitted.
  - Revision 2 holds the moved MultiPolygon, and revision 1 still holds the first submitted one.
  - Changed: SITE, AVAILABILITY.

**Activation**
- **Setup:** the resubmitted request A and a second request B (another section, «قسم النقل والحركة الإدارية», on the same
  ground) were both fully approved.
- **A activated:**
  - registered «موقع RS-2026-0048» as a MultiPolygon of 2 parts, `ST_Equals` to the last revision, the stored GeoJSON
    identical;
  - «قسم الخدمات العامة» is stationed there.
- **Occupancy re-checked:** B's activation was then refused with «تغيّر إشغال الأرض منذ الاعتماد: موقع RS-2026-0048 — لا
  يُفعّل الطلب.» B stays approved and not activated.
- **Unchanged across the activation:**
  - site links (0 → 0);
  - every site responsibility;
  - the copied site 05 (geometry version 23);
  - every other unit's stationing.

**Not changed by the run:** schema V20, policy v1, terrain, organisations and responsibilities
(`state-final-run-compare.txt`).

## Performance (final run, real page, headless Edge)

Playwright sends the pointer moves. Each drag time includes about 300 ms of settling, and the long-task observer is
cleared before each drag.

| Site | Copy | Grouped drag (30 moves) | Vertex drag (12 moves) | Undo / redo | Invalid drop → verdict | Long tasks > 50 ms |
|---|---|---|---|---|---|---|
| Polygon (4 vertices) | 123 ms | 708 ms | 462 ms | 21 / 25 ms | 1 ms | 0 |
| MultiPolygon, 2 parts (site 05) | 89 ms | 711 ms | 468 ms | 22 / 26 ms | 1 ms | 0 |
| MultiPolygon, 4 parts (`ACC-GEO-MP4`) | 82 ms | 720 ms | 466 ms | 24 / 26 ms | 1 ms | 0 |
| Polygon, 1,500 vertices (`ACC-GEO-DENSE`) | 80 ms | 718 ms | 480 ms | 23 / 26 ms | 2 ms | 0 |

**How each figure is measured:**
- **Copy:** from the click to the copied site being shown, including the server round trip.
- **Undo, redo and the undo of the invalid drop (24 ms everywhere):** measured in the page, from the click to the next
  frame after the readout changed.
- **Validation feedback:** measured from the pointer release to the last readout change. It is 0 ms after a valid
  vertex drop because the live readout is already final when the pointer is released.
- **Invalid drop:** a vertex dropped across the opposite edge. The full rules run on release; the verdict appeared 1–2 ms
  after the release on every site, and the undo restored «الحدود صالحة».
- **Long-task instrument:** verified first. A deliberate 120 ms page task is recorded as 120 ms (INSTRUMENT).
  - Lesson: a busy loop injected by the driver is not attributed as a page task at all.
  - Consequence: the development run's "0 long tasks" was never instrument-checked. The figures above replace it.

Validation was not weakened for any of this.

## Parity

The shared suite is unchanged and green, with no new divergence:
- `siteGeometryCases.json`: 11 cases;
- `siteGeometry.test.ts`, within frontend 102/102;
- `RestationingWorkflowIT.siteGeometryParity`, within backend 209/209.

The server's area matches the page's on every real-page case: G2 111,134 m² on both, G7 792,077 against 792,088 m².

## Defects found by this gate

**Product: one defect, fixed in a separate functional commit (`9e02088`), then rebuilt, redeployed and rerun**
- **APPROVER-3:** the request summary did not state the proposed site's type, part count or submission. The approver saw
  the parts only as drawn shapes, and the submission count only in a collapsed list.
- **Fix:** the summary now carries «الموقع المقترح».
- **Evidence:** the failure on `58423ce` is in `run2-on-58423ce-partial.log`.

**Test-only corrections (no product change)**
- **Backend `RestationingTestBase`:** each test now gets a cell of its own. With random placement, a test's layout
  occasionally landed on another test's leftover ground in the shared test database (`permanentJourney`, 1 run in 3).
- **Script, PTR:** each case starts from the copied position. Run 1 started PTR2 and PTR3 on top of the control where
  PTR1 had left the site, so the press landed on the control and the site moved 0 m.
- **Script, G5:** the vertex moves away from the other part. Site 05's parts are 30 m apart, and a fixed direction made
  them overlap; the server then correctly refused the submission.
- **Script, centroids:** computed about a local origin. On absolute coordinates the shoelace sums lost about 10⁻⁶°
  (0.1–1 m), which failed G4 by measurement alone. PostGIS shows the product's move is rigid to the millimetre.
- **Script, instrument:** the long-task check runs as a page task (above).

## Requests this gate left on `tmrkz-test`

All are identified «… (بيانات قبول وهمية)».

| Run | Requests | Result |
|---|---|---|
| Run 1 on `58423ce` | RS-2026-0032 … 0041 | 10 drafts |
| Run 2 on `58423ce` (partial) | RS-2026-0042, 0044 | 2 drafts |
| Run 2 on `58423ce` (partial) | RS-2026-0043 | UNDER_REVIEW (resubmitted, not activated) |
| Final run | 9 requests from RS-2026-0045 to 0055 (all except 0048 and 0051) | 9 drafts |
| Final run | RS-2026-0048 | ACTIVATED_PERMANENT («قسم الخدمات العامة» now at «موقع RS-2026-0048») |
| Final run | RS-2026-0051 | APPROVED_NOT_ACTIVATED (the occupancy re-check case) |

Because of RS-2026-0048, the current site of «قسم الخدمات العامة» is now the activated two-part site, no longer site 05.
Site 05 itself is unchanged.

## Not accepted here

- Real physical touch: no device. The interactions use pointer events at window level for mouse, touch and pen alike.
- Duplicate label on a read-only MultiPolygon: later polish; the renderer is not changed in this phase.
