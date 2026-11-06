# True offline 3D terrain — report (6 Nov 2026)

Owner briefs «TRUE OFFLINE 3D TERRAIN + TERRAIN-CONFORMING STATIONING UX» and the owner's review of the same day.
Decision record: ADR-038 (`docs/ARCHITECTURE_DECISIONS.md`). State: committed and pushed on the owner's instruction.
It is **not deployed** to the owner's installation (:8088 keeps the earlier UI and map package `tmrkz-map-2026.11.1`).
The **owner's visual acceptance is still pending**.

## 1. What the owner sees

- **2D | 3D** on the re-stationing map:
  - 3D is MapLibre's real terrain from offline elevation tiles (Copernicus GLO-30), at true height (exaggeration 1),
    tilted 55°;
  - every request geometry is draped on the ground by MapLibre itself, in one colour language for both modes:
    current BLUE, proposed GREEN, primary AMBER/ORANGE, alternative PURPLE, occupied/invalid RED.
- **Connectors**, in one order only, with arrowheads and distance chips:
  - current → proposed: information only («للعلم فقط»), no limit and no verdict;
  - proposed → primary and primary → alternative: the policy range, the terrain allowance, the effective range and
    the verdict.
- **Cards** stand on their geometry on a stem: compact, or expanded when selected. A chip slides along its connector
  to stay clear of the cards. Selecting a geometry frames it over its terrain; «الحدود والمناطق» frames the whole
  request, tilted, on portrait and landscape screens.
- **«تحليل طبيعة الأرض»** at the top of the right column:
  - from the SERVER (authoritative): class, shares of each class, mean slope, allowance, base and effective range,
    verdict;
  - from the elevation tiles (display only): lowest, highest and centre height, height difference, and the elevation
    profile of the selected connector.
- **Drawing and editing in 3D** use the same editor as 2D: drag, click placement, «رسم حدود جديدة» with numbered
  vertices, live edge lengths and closing, vertex editing, undo, redo and reset.
- **«الانحدار»** (owner request during the review): an optional layer colouring the ground by the policy's slope
  classes, green (flat) to red (steepest), to judge the ground before drawing. It is display only; the server's class
  of the drawn area is the one the rules use.

Screens: `owner-review/2D-request.png` and `owner-review/3D-request.png` show the identical request in both modes.
The other screens and recordings are in this folder and in `review/` (see `README.md`).

## 2. Business terrain and visual terrain are kept apart

| | Business terrain | Visual terrain |
|---|---|---|
| Product | slope analysis `copernicus-glo30 2026.11` (unchanged, `9a91d9af…`) | Terrain-RGB `copernicus-glo30-3d` (new, `c31bf31a…`, 5,932 tiles, 209 MB) |
| Built by | `ops/terrain/build_terrain.py` | `ops/terrain/build_terrain_3d.py` (same 28 source tiles, sha256-checked) |
| Used by | the server's classification, allowance and verdict (PostGIS) | MapLibre terrain, displayed heights, profile, «الانحدار» colours |
| Rules | the only terrain input of a rule | never an input to a rule; no elevation rule was added |

## 3. Map package

- `tmrkz-map-2026.11.1` is unchanged and remains the accepted package.
- `tmrkz-map-2026.11.2` adds the optional component `terrain-3d`. The verifier, builder and readiness checks were
  extended; the 39 other files are byte-identical.
- 2026.11.2 is a **development candidate**: it was built from uncommitted source and is installed only in the
  development root. After the owner's visual acceptance it must be rebuilt from this commit and proven: deterministic
  rebuild, checksums, provenance, verify, install, rollback and readiness.

## 4. Verification (measured)

| Check | Result |
|---|---|
| Real browser `tests/acceptance/terrain-3d.mjs` (headless Edge on the GPU, fictional unsaved request, outside traffic refused) | see `results.json` |
| Owner review items `tests/acceptance/terrain-3d-review.mjs` (§3 slopes and bearings, §4 MultiPolygon, §5 «رسم حدود جديدة», §6 mountain → plain, «الانحدار») | 9/9 — `review/results.json` |
| Backend `StationingFoundationIT` / `RestationingWorkflowIT` (real PostgreSQL + PostGIS) | 9/9 / 15/15 |
| Frontend unit tests, type check, production build | 160/160, clean, built |
| `ops/map-package` + `ops/terrain` pytest | 52 passed, 1 skipped (symlinks cannot be created on this Windows host) |
| Earlier Stationing browser regressions, rerun on the recreated development environment | section 5 |

Key results:
- **§6 (R1):** the same alternative area, kept 5.8 km from the primary, was dragged from a mountain flank to a plain.
  The class went from MOUNTAINOUS to FLAT, the allowance from 2,000 m to 0, the effective maximum from 7,000 m to
  5,000 m, and the verdict from ضمن النطاق to خارج النطاق.
- **Proposed site:** dragged from the mountain to the plain, it changed from MOUNTAINOUS to FLAT and from 585–936 m
  to 371–379 m, with still no distance rule.
- **§4 (R3):** pressing one part of the two-part MultiPolygon moves both by the same vector (difference 0.1 m). Each
  part drapes on its own ground, and part order and the stored 2D geometry are unchanged.
- **2D ↔ 3D:** every coordinate, the part order and the undo history are identical after switching.
- **Requests:** zero request writes (the only POSTs are the read-only `/stationing/terrain/assess`), zero external
  requests, zero console errors.

## 5. Earlier regressions on the recreated development environment

The earlier Stationing browser suites ran against the recreated development environment: the working-tree UI on
:5197 and `tmrkz-v3dev` on :8097, headless. Missing fixtures were recreated as fictional development data, labelled
«وهمي» / DEV-REGRESSION (`regressions/fixtures/`).

| Script | Result | Notes |
|---|---|---|
| `geometry-old-sequence.mjs` — old editor, Polygon S4–S9 | **8/8** | 4-vertex fixture DEV-REG-P4 v2 |
| `geometry-old-mp-point.mjs` — MultiPolygon B and Point C | **12/12** | |
| `geometry-two-methods.mjs` — two placement methods, both deployment areas | **10/10** | expectation updated (below) |
| `ui-rebuild.mjs` | **44/46** (final checkpoint below) | STEP1 and CLICK-SELECT expect the step wording «اختر الموقع الحالي»; since the committed 5 Nov rebuild (2d60e9d) it reads «اختر الموقع الحالي من الخريطة». An older expectation, not a regression of this work |
| `maplibre-labels.mjs` | **21/21** | G-8c is the deliberate known-defect control |
| `geometry-interaction.mjs` | 4 pass, then stops at C | the script predates the restored old editor (2d60e9d): the shape now closes at «عدد الرؤوس» 4, and «تعديل الحدود» / «استعادة البداية» no longer exist |
| `geometry-polygon-parity.mjs` | 2 pass, then stops at P-VERTEX | same: «تعديل الحدود» is now «تعديل الرؤوس» (covered by old-sequence S6) |
| `stationing-footprint.mjs` | not run | it tests the retired «مساحة التمركز» page (`#stationing` is now the Sites page); old-sequence replays S4–S9 |
| `restationing-geometry.mjs`, `restationing-acceptance.mjs`, `restationing-journey.mjs` | not run | they use the old form UI. They also need the acceptance-only accounts t.seat.l8–l10, t.lc.* and t.requester.pm, and they submit, approve and ACTIVATE (which would re-station the fictional units) |
| `map-package.mjs`, `map-package-terrain-parity.py` | not run | they need the deleted `tmrkz-test` requests by id and its database |

Found and fixed by these reruns:
- The «no write before save» checks counted `POST /stationing/terrain/assess`: a read-only computation, with request
  counts and the audit unchanged. The checks now exempt exactly that endpoint; the database row checks stay.
- After a deployment area moved without saving, the connector chip and the area panel still showed the range of the
  last saved check, while the terrain panel showed the new ground. All three now use one rule: the server's check
  when it covered exactly this geometry, otherwise the server's analysis of the area where it now is. «تحقق الخادم»
  still reports the last save. `geometry-two-methods.mjs` now expects the range of the server's analysis of the
  area's current place (brief §25), not the last save.
- The terrain panel's `data-leg` attribute collided with `ui-rebuild.mjs`'s deployment-leg selector; it is now
  `data-profile-leg`.
- «مفتاح الخريطة» never actually folded (`hidden` lost to `display: flex`); it now folds, and folds by itself in 3D
  so it cannot cover the cards.

The recordings of these reruns stay local (about 200 MB); screenshots, results and logs are in git.

## 6. Open items

- The owner's visual acceptance.
- Rebuild of `tmrkz-map-2026.11.2` from the committed source.
- Deployment to an installation; installation of the package on the accepted environment.
- From the owner's earlier terrain list:
  - not built: a ± allowance as an administrator setting;
  - not built: a per-class rule (allowed / justification / not allowed).
- MapLibre advises separate elevation sources for terrain and for the shade/tint (rendering quality). This is a
  warning, not an error, and is not done.
- No real touch device was used, and the earlier acceptance environment no longer exists.
