# True offline 3D terrain — real-browser evidence (6 Nov 2026, ADR-038)

Owner brief «TRUE OFFLINE 3D TERRAIN + TERRAIN-CONFORMING STATIONING UX». Everything here comes from the real page
(`#restationing/new`) in Microsoft Edge (headless, drawing with the machine's GPU through ANGLE Direct3D 11). Every
request outside the application's own origins is refused and counted. No mockup, no generated image.

- **Environment:** development project `tmrkz-v3dev`:
  - backend built from the working tree; the Vite dev server on :5197 with `TMRKZ_MAP_ROOT=map-data/runtime-3d`;
  - map package `tmrkz-map-2026.11.2` installed there (the owner's installation on :8088 is untouched);
  - the full GLO-30 slope analysis loaded;
  - fictional sites on real Hajar-foothill relief (`ops/test-env/dev-3d-terrain-seed.sql`);
  - development policy `DEV-3D`: the owner's acceptance values with the labelled acceptance initial area of 90,000 m²,
    not a production value.
- **The request:** a NEW fictional request as `t.requester`, never saved:
  - current site «موقع السهل الغربي (وهمي)» on the plain at about 380 m;
  - the re-stationing site placed on the mountain (585–936 m) with «تحديد الموقع على الخريطة»;
  - primary area on undulating/hilly ground and alternative on a mountain flank, both with «تحديد المنطقة على الخريطة».
- **Script:** `node tests/acceptance/terrain-3d.mjs`. Results with every detail: `results.json`.

| File | What it shows |
|---|---|
| `A-2d-request.png` | The same request in 2D (accepted flat map; primary area now amber) |
| `B-3d-request.png` | 3D, same geometries: real terrain, the four areas draped, arrows, distance chips, cards, terrain panel |
| `C-3d-proposed-site-analysis.png` | 3D, the proposed site selected: the green polygon bending over the ridge; the server class (جبلي), shares, mean slope; heights 585–936 m; distance for information only |
| `D-3d-deployment-legs.png` | 3D, primary + alternative: the leg chip carries its rule (4.51 كم · الفعّال 3–7 كم · ضمن النطاق); the panel shows base 3–5 كم, +2 كم (جبلي), effective 3–7 كم |
| `E-2d-to-3d-rotate.webm/.gif` | 2D → 3D, then a slow rotation with the right mouse button: the polygons stay on the ground |
| `F-drag-mountain-to-plain.webm/.gif`, `F-after-drag-on-plain.png` | The proposed site dragged in 3D from the mountain onto the plain. It re-drapes; class MOUNTAINOUS → FLAT and heights 585–936 m → 371–379 m are read again on the drop |
| `G-draw-edit-on-terrain.webm/.gif`, `G-drawn-on-terrain.png` | An area drawn on the terrain in 3D (four clicks, the vertices are the clicked ground points), one vertex dragged, then undo, redo and reset |

Checks (23/23 on the final run; see `results.json` for the exact figures):
- **T01–T04:** 3D from the installed package, MapLibre terrain at exaggeration 1, pitch 55°, rotation.
- **T05–T08:** draped fills for current, proposed, primary, alternative and occupied ground; vertex heights spread over
  the mountain; cards standing on their ground points.
- **T09–T13:** three connectors in one order with arrowheads (the move is information only); the policy allowance and
  effective maximum exactly as the policy in force for the server's class; the elevation profile.
- **T14:** 2D → 3D → 2D leaves every coordinate and the undo history unchanged.
- **T15–T17:** dragging, drawing and editing in 3D.
- **T18:** a two-part MultiPolygon on the terrain.
- **T19:** drag timings with 2, 4 and 1,501-vertex sites.
- **T20–T23:** zero request writes (database rows compared; the only POSTs are the read-only
  `/stationing/terrain/assess`), zero external requests, the elevation tiles only from `/map-data/`, zero console errors.

Limits of this evidence:
- **Renderer:** headless Edge on one laptop GPU (Intel UHD), not a touch device or the owner's machine.
- **Elevations:** the heights shown are display values from the 35 m Terrain-RGB tiles (median 2.6 m, worst 23 m from
  the source on steep slopes). The classes and verdicts come from the server.

Owner review of 6 Nov 2026:
- `owner-review/` — the identical request in 2D and 3D;
- `review/` — the review items (`tests/acceptance/terrain-3d-review.mjs`, 9/9: R1 mountain → plain, R1b «الانحدار»,
  R2 two bearings, R3 MultiPolygon, R4 «رسم حدود جديدة»);
- `regressions/` — the earlier Stationing suites rerun on the recreated development environment;
- `REPORT.md` — the summary for the owner.
