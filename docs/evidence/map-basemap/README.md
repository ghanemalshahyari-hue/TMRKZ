# Basemap rendering fix (ADR-030) — before and after, 3 Nov 2026

Real application, acceptance environment `tmrkz-test` (fictional data), «مساحة التمركز», Microsoft Edge headless, no
internet. **before** = the previous web image (`mover/web:before-basemap-tiles`, one `L.imageOverlay` of the SVG
package); **after** = the rebuilt web image (vector tiles). Only the web container was replaced; backend, database (V16)
and data unchanged. Script: `tests/acceptance/map-basemap.mjs` (read-only: one sign-in, then only looking).

Path, identical for both builds at each size: first view → keyboard pans onto a site with a registered boundary →
two keyboard zoom steps at a time (re-centred) → zoom +0, +2, +4, +6. Frames: four mouse drags and four wheel zooms
per level, each level from a fresh page load.

## Frame times while panning and zooming (worst frame / frames over 50 ms / p95)

| Size | Zoom | Before (image overlay) | After (tiles) |
|---|---|---|---|
| 1920×1080 | 13.5 | 80 ms / 4 / 13.5 ms | 19 ms / 0 / 13.5 ms |
| | 15.5 | 67 / 5 / 13.4 | 18 / 0 / 13.5 |
| | 17.5 | 268 / 12 / 13.6 | 15 / 0 / 13.5 |
| | 19.5 | 734 / 88 / 173.4 | 22 / 0 / 13.5 |
| 1366×768 | 12.5 | 67 / 2 / 13.6 | 20 / 0 / 13.5 |
| | 14.5 | 107 / 3 / 13.9 | 16 / 0 / 13.5 |
| | 16.5 | 120 / 11 / 14.4 | 17 / 0 / 13.5 |
| | 18.5 | 174 / 63 / 145.3 | 23 / 0 / 13.5 |
| 768×1024 | 12.5 | 161 / 10 / 14.0 | 16 / 0 / 13.5 |
| | 14.5 | 147 / 8 / 14.0 | 16 / 0 / 13.4 |
| | 16.5 | 200 / 1 / 13.5 | 19 / 0 / 13.5 |
| | 18.5 | 320 / 69 / 160.0 | 18 / 0 / 13.5 |
| 390×844 | 12 | 80 / 8 / 13.5 | 31 / 0 / 13.5 |
| | 14 | 254 / 12 / 13.5 | 21 / 0 / 13.5 |
| | 16 | 413 / 37 / 93.9 | 18 / 0 / 13.5 |
| | 18 | 627 / 38 / 93.3 | 14 / 0 / 13.5 |

After: no frame over 33 ms at any size or zoom (the budget checked is 0 over 50 ms and p95 ≤ 25 ms). Main-thread time
during the interaction was 1.5–4.5 % in both builds: the old cost was rasterising the huge image, not script. The one-off
read of the 0.94 MB package when the map opens takes 18–24 ms (Node, same engine), once per page.

## Alignment and content

- **Same views, same overlays:** at all 16 views the map reported the same zoom and centre in both builds, and every
  registered boundary and marker sat at the same pixel position (largest difference 0 px) — `compare.json`.
- **Same basemap picture:** before vs after, best offset 0 or ±1 px with a mean difference of 0.0–1.3 luma levels; the
  one view that is a single colour (1920, zoom 19.5: the map sits on a major road) is identical in colour.
- **Against an independent placement:** the same package file rendered by the browser's own SVG engine at the
  Web-Mercator pixel window of the map's reported zoom and centre. 15/16 views match at offset (0,0) or ±1 px in both
  builds. At 390×844, zoom 18, both builds differ from it in the same way: the map's reported centre (`data-view`, from
  `map.getCenter()`) was stale at that one view (the only one with the map pane at its origin). With one keyboard pan
  before each picture, all four 390 views match at (0,0) with a difference of 0.0 — `after-390-pan-first/`.
- **Earlier claim corrected:** the close views at 1920/19.5 and 1366/18.5 are low-contrast because the view lies on a
  road or field, not because the old overlay stopped drawing; both builds draw them, in the same colour.

## Files

- `before/`, `after/` — `results.json` (checks, frame statistics, positions), per view `-map.png` (as seen),
  `-basemap.png` (basemap only) and `-reference.png` (independent placement); `before.log`, `after.log`.
- `compare.json` — before/after rows per size and zoom; `side-by-side/` — eight pictures (zoom +4 and +6 at each size).
- `after-390-pan-first/` — the 390 views with a pan before each picture (`NUDGE=1 FRAMES=0`).
- `regression/` — the stationing browser regressions on the rebuilt app (evidence kept apart from the accepted runs).
