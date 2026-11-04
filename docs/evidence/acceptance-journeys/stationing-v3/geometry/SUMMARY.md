# Stationing V3 — geometry editing (owner gate «GEOMETRY EDITING PHASE — GO», 4 Nov 2026)

> **Superseded by the acceptance on `tmrkz-test`** (`tmrkz-test/SUMMARY.md`, 33/33, 4 Nov 2026). Two measurements on
> this page were corrected there:
> - **"0 long tasks":** the observer was never shown to work in this run. The acceptance run verifies it first.
> - **0.07 m inter-part figure:** it came from a planar centroid computed on absolute coordinates, which loses up to
>   about 1 m to cancellation. PostGIS shows the move is rigid to the millimetre.

**Scope:** grouped MultiPolygon copy and move, Polygon and MultiPolygon vertex editing, and the real-page acceptance of
both. **Status:** committed as `58423ce` and pushed at the owner's request (4 Nov 2026); NOT on `tmrkz-test`. No schema change: the V19/V20 request
content, the revisions and the site geometry versions already hold a Polygon or a MultiPolygon.

## Where it ran

The development environment `tmrkz-v3dev` (`ACCEPTANCE` is not its label):
- **Backend:** built from the working tree (`ops/test-env/dev-v3.sh build`), migrated to V20.
- **Web:** a production-style nginx image of the working tree with the V3 flag and the offline map mount.
- **Sign-in and data:** real Keycloak/LDAP sign-in; fictional data.
- **Why not `tmrkz-test`:** acceptance images are built only from commits, and this phase is uncommitted until the owner
  approves.

**Development sites** (`ops/test-env/dev-v3-geometry-seed.sql`, refused on any database labelled ACCEPTANCE):

| Site | Geometry | Unit |
|---|---|---|
| DEV-MP2 | two-part MultiPolygon | إدارة التقنية |
| DEV-MP4 | four-part MultiPolygon | وحدة الصيانة الإدارية |
| DEV-DENSE | dense polygon, 1,500 vertices | فريق مرافق الشمال |

The Polygon cases use the requester's own unit, «الخدمات المشتركة».

**Script:** `MOVER_URL=http://localhost:8097 node tests/acceptance/restationing-geometry.mjs` (headless Edge). Every
geometry claim is checked against what the server saved. Result: **17/17 PASS, 0 console errors, 0 external requests**
(`results.json`).

## Results

**G1 — Polygon, grouped move**
- Copied exactly: the saved COPY equals the current site, with `copiedFrom` set to it.
- One drag moved it 360 m. Area change 0.0000 %; largest change in any edge length 0.000 m.
- The server accepts the saved geometry: no site-shape problem; area 64,312 m².

**G2 — Polygon, vertex edit**
- «تعديل الحدود»: one vertex moved; the other vertices are identical.
- The live readout showed the active part and vertex, the area and «الحدود صالحة». The page and the server agree on the
  area: 82,316 m² on both.
- Stored as EDITED.
- After reloading the page and reopening the request, the editor held exactly the saved geometry; saving it again left
  it unchanged.

**G3 — MultiPolygon copied whole**
- All 2 parts, in order, with identical coordinates.
- Message «نُسخت حدود … كاملة (2 أجزاء) — اسحب أي جزء: كل أجزاء الموقع ستنتقل معاً», and the same banner on the
  map panel.

**G4 — MultiPolygon, grouped move**
- One drag moved both parts 377 m each.
- Distance between the parts: 321.87 → 321.80 m (geodesic rigid move).
- Area change of each part: 0.0000 %.

**G5 — MultiPolygon, vertex edit**
- Part 2 chosen, one of its vertices moved; part 1 is byte-for-byte unchanged.
- Readout «الجزء النشط: 2 · الرأس 1».
- After reload and reopening, exactly the saved MultiPolygon.

**G6 — Invalid edit**
- A vertex pulled across the opposite edge.
- Immediately: «الحدود غير صالحة: حدود متقاطعة ذاتياً», and «إرسال للاعتماد» disabled.
- Server: «حدود الموقع المقترح: متقاطعة أو غير صالحة (Self-intersection…)»; submission 400.

**G7 — Maximum footprint**
- A vertex pulled out to 243,619 m², against a limit of 200,000 m².
- Immediately: «المساحة تتجاوز الحد الأقصى المعتمد».
- Server: «مساحة الموقع المقترح (243620 م²) تتجاوز الحد الأقصى المعتمد (200000 م²)»; submission 400 (hard block).

**G8 — Undo, redo, reset**
- Sequence: copy → grouped move → vertex of part 2 → undo → undo → redo → redo → «استعادة البداية» → undo.
- Each state was saved and compared: moved, copy, moved, edited, copy, edited — all exactly as recorded.

**G9 — Redraw only by choice**
- «رسم حدود جديدة» declined in the confirmation: the copy stays (COPY).
- Accepted: «أُلغيت الحدود السابقة بطلبك», a new shape drawn by a click, saved as DRAWN with no `copiedFrom`.

**Approver view**
- The edited two-part MultiPolygon, with deployment areas added, was submitted (200).
- The unit's approver `t.manager.it` opened it on the page; the request shows exactly the submitted MultiPolygon, held
  by the submitted revision.

**PERF — several-part and dense sites**
- The four-part MultiPolygon and the 1,500-vertex polygon were copied and moved as one, with areas kept.
- Their vertices are editable.

## Performance

Measured on the real page, headless Edge. Playwright sends the pointer moves; each drag time includes about 300 ms of
settling.

| Site | Copy | Grouped drag (pointer moves) | Vertex drag | Long tasks during drags | Undo / redo / reset |
|---|---|---|---|---|---|
| Polygon (4 vertices) | — | 628 ms (24) | 523 ms (16) | 0 | — |
| MultiPolygon, 2 parts | 99 ms | 628 ms (24) | 526 ms (16) | 0 | 11–28 ms |
| MultiPolygon, 4 parts | 86 ms | 708 ms (30) | 465 ms (12) | 0 | 24 ms |
| Dense polygon, 1,500 vertices | 106 ms | 716 ms (30) | 484 ms (12) | 0 | 21 ms |

- **No long task (> 50 ms) during any drag**, the dense polygon included.
- **How it stays responsive:**
  - updates are coalesced to one per animation frame;
  - a rigid move does not re-validate (its validity cannot change);
  - a vertex move tests only the two edges that changed;
  - the full rules run when the pointer is released;
  - nothing in React re-renders the map while the pointer moves.
- **Validation alone** (unit benchmark, `siteGeometry.test.ts`) on a 5,000-vertex boundary: move, full validation and
  vertex test in about 10 ms in total.
- **Correction:** the "validation refresh" figure in `results.json` (≈470 ms) starts before the vertex drag, so it
  includes the drag itself. It is not a validation time.

## Client/server parity

`frontend/src/lib/siteGeometryCases.json` holds 11 shapes:

| Valid (4) | Invalid (7) |
|---|---|
| a square; two parts apart; four parts apart; two parts touching at one corner | a bowtie; a self-crossing part; overlapping parts; parts sharing an edge; a part inside another; a ring without area; too few points |

- **Same verdict:** the client (`siteGeometry.validateSite`) and the server (`RestationingChecks.siteProblem`, PostGIS)
  give the same verdict on every case. Tests: `siteGeometry.test.ts` and `RestationingWorkflowIT.siteGeometryParity`.
- **Same area:** the client now measures area as PostGIS does on the WGS84 spheroid. The fixtures carry PostGIS's own
  areas; the client is within 0.05 %, and the server reproduces them.

## Defects found and fixed during this phase (in the uncommitted work)

1. **Lost copy label.** Switching the editor's mode emitted a committed change while the copy was being loaded, so a
   copied site was saved as DRAWN without `copiedFrom`. Mode and part selection are now presentation only.
2. **Stuck drag.** A drag released over a map overlay (the attribution notice) never ended: the readout froze on its
   live preview and the change was never committed. Drags now follow the pointer at window level, mouse, touch and pen
   alike, as the accepted footprint engine does.
3. **Area mismatch.** The client's spherical area read about 0.4 % above PostGIS's spheroid area; it now matches.
4. **Unreadable geometry.** In the new server check, a Java text block stripped the space in `from (select `, so every
   site was reported as unreadable. Caught by the backend tests before any deployment.

## Regression

Backend 209/209 (206 earlier plus parity, MultiPolygon through activation, invalid MultiPolygon). Frontend 102/102;
build OK.

## Not done in this phase

- Real-touch acceptance: no device; the interactions are touch-compatible.
- The geometry journeys on `tmrkz-test`: they need the owner's commit approval.
- **Visual note, out of scope:** the read-only current MultiPolygon site shows its label once per part.
