# Stationing V3: offline MapLibre map and Arabic labels (owner decision 5, 4 Nov 2026)

**Status:** this is a reusable module, a development harness and acceptance evidence. **It is not wired into any page.**
The current «مساحة التمركز» page still uses Leaflet, and integration belongs to the production Stationing page work.
Nothing has been committed or pushed.

## 1. Version

- **Choice:** `maplibre-gl` **6.15.0**, published 18 Oct 2026, pinned exactly.
- **Why:** it is the newest stable release that is at least two weeks old. 6.16.0 (25 Oct) is too new.
- **Companion package:** `pmtiles` **4.5.0** (10 Aug 2026), pinned exactly.
- **Not available before this:** TMRKZ had no MapLibre at all. MOVER vendors 4.7.1 (`app/NavMap/src/vendor/maplibre-gl.js`), and its offline style **ships no glyphs**: MOVER draws road labels as DOM chips (`app/NavMap/src/map.js:622`), so MOVER had never proven Arabic labels in MapLibre itself.

## 2. Built-in Arabic shaping and bidi (no right-to-left plugin)

Evidence from the installed package, `frontend/node_modules/maplibre-gl/`:

| Where | What it says or does |
|---|---|
| `src/index.ts:92-94` | `setRTLTextPlugin` is `@deprecated`: "MapLibre shapes Arabic and reorders bidirectional text itself, so nothing has to be loaded for right-to-left languages to be drawn correctly." |
| `src/index.ts:113-114` | `getRTLTextPluginStatus` is deprecated: right-to-left text "always can be" drawn. |
| `src/source/rtl_text_plugin_worker.ts:6` | "MapLibre implements all three itself": shaping, bidi, and styled bidi. |
| `src/symbol/arabic_shaping.ts` | Built-in joining, contextual forms and the lam-alef ligature. |
| `src/symbol/transform_text.ts:2,16` | Uses the built-in `applyArabicShaping` unless a plugin replaces it. |
| `src/symbol/bidi.ts:1` and `src/symbol/shaping.ts:13,190` | The Unicode bidirectional algorithm through `bidi-js` 1.1.0 (MIT), a MapLibre dependency. |
| `src/tile/tile.ts:329` with `src/source/rtl_text_plugin_main_thread.ts:73-75` | Seeing right-to-left text only sets the deprecated status to `requested`. With no plugin URL set, nothing is loaded. |

**Decision:** no right-to-left or shaping plugin was added. The reproducible test (section 5, G-0…G-7) shows the
installed version renders the required labels correctly. The plugin would only be needed if such a test failed.

**Stale comment noted:** `src/render/font_face_manager.ts:102` still says that "shaping across cluster boundaries still
needs the RTL text plugin". The built-in shaping in `transform_text.ts` makes this out of date, and the pixel test
confirms joined letters.

### Finding G-8a: brackets were mirrored twice on a right-to-left document (fixed in the map module, 4 Nov 2026)

**What happens:**
1. MapLibre mirrors brackets and guillemets in right-to-left runs itself (`src/symbol/bidi.ts:107-109`, Unicode rule L4), which is correct.
2. It then draws each glyph with TinySDF on a detached canvas that never sets `direction` (`@mapbox/tiny-sdf/index.js:31-32,57`), so the canvas inherits `inherit`.
3. Chromium/Edge resolves that from the **document element**. On `<html dir="rtl">`, which is what `frontend/index.html` sets today, the browser mirrors the lone bracket glyph a second time.
4. Result: «شارع (١٩)» is drawn as «شارع )١٩(», and «الجميرا» in guillemets is drawn with them pointing outwards.

Arabic letters, digits, the Arabic comma and question mark are not affected; only characters with the Unicode
"mirrored" property are.

**Evidence:**
- `overlay-labels-dir-rtl.png` (defect) beside `overlay-labels-dir-split.png` (correct).
- Check G-8a reproduces it; G-8b passes with the workaround.
- The general shaping score could not see this: brackets are a small part of a label. G-8 therefore scores a bracket-heavy sample against a correct reference and a double-mirrored one.

**Owner decision, 4 Nov 2026:** do not change the whole application's page direction to fix brackets: the blast radius
is too large. Isolate the problem to the component that has it and fix it there. A global direction change is not
approved at this gate and would need a full visual regression first.

**Isolated:** the defect is in one place only, MapLibre's glyph rasteriser. The label layout is already right: MapLibre's
bidi and its L4 mirroring produce the correct visual order. The page's own text, which the browser lays out, is not
affected. Only the single-glyph canvas inherits a direction it should not have, because a glyph already placed in visual
order has no direction of its own.

**Local fix:** `frontend/src/components/map/maplibre/glyphDirection.ts`, `drawGlyphsLeftToRight(map)`.
- It wraps the map's own glyph-rasteriser factory (`Style.glyphManager.createRasterizer`, maplibre-gl 6.15.0) so each new glyph canvas gets `ctx.direction = 'ltr'`.
- A new style brings a new glyph manager; the `styledata` event catches it before any of its glyphs are drawn.
- `OfflineMapLibre` calls it for every map. Nothing outside the map's glyph canvases changes: `<html dir="rtl">` stays as it is in `frontend/index.html`.
- Unit tests: `glyphDirection.test.ts` (3).

**Verified in headless Edge** (`maplibre-labels.mjs`):
- **G-8a**, on the application's `<html dir="rtl">` with the fix: PASS, r = 0.932, margin 0.274.
- **G-8b**, the earlier workaround document (`<html dir="ltr">`, `<body dir="rtl">`) as a cross-check: the identical score.
- **G-8c**, the control: the same right-to-left document without the fix (`?glyphfix=off`) still reproduces the double mirror, r = 0.648. This is recorded as an upstream known defect; it will report "CHANGED" once MapLibre or TinySDF sets the direction itself, and the fix can then be retired.
- G-1…G-6 pass on both documents with identical scores.
- `overlay-labels-dir-rtl.png` now shows «شارع (١٩)، دبي!» and «الجميرا» with the brackets and guillemets the right way round on the right-to-left document.

**Not done:**
- No change to the page direction.
- No RTL plugin: the defect was in rasterising, not shaping.
- No glyph PBFs.
- An upstream report to MapLibre/TinySDF (`ctx.direction = 'ltr'` while rasterising) remains worthwhile; it needs no change here.

## 3. Fonts offline

- **Approach:** the style's `font-faces` property (style spec 26.5.1) points at the **application's own** `frontend/public/fonts/NotoSansArabic.ttf`.
  - The style has **no `glyphs` URL and no sprite**.
  - MapLibre registers the file through the browser's CSS Font Loading API under a private family name, and draws each glyph locally (TinySDF).
- **Font coverage:** Noto Sans Arabic 2.012 (SIL OFL 1.1, `FONT-LICENSE.txt`) contains 1,561 code points.
  - It covers Arabic `0600–06FF`, the presentation forms (A: 631 of 688; B: 141 of 144), Latin A–Z/a–z, Western and Arabic-Indic digits, and punctuation.
  - **No second font is needed.** Test F-1 checks every character of every drawn label against this file's character map (`docs/evidence/maplibre-labels/font-cmap.json`).
- **No glyph build:** no glyph PBFs, glyph generator or glyph server. Nothing is exposed outside the application package.

## 4. Module, harness and data

- **Module** `frontend/src/components/map/maplibre/`:
  - `offlineStyle.ts`: the offline style:
    - street and terrain groups in one style;
    - labels from `name:ar` → `name` → `name:en` (or English first);
    - route numbers from `ref`, on a shield drawn in code;
    - attribution «© OpenStreetMap contributors (ODbL) · Protomaps — أسماء الطرق من OpenStreetMap وليست أسماء رسمية»;
    - the Copernicus licence's Article 6(b) notice word for word ("produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved"), with the DSM limitation in the mode notice;
    - `setBasemapMode`, which changes only the visibility of grouped basemap layers.
  - `setup.ts`: the one-time page setup:
    - registers `pmtiles://`;
    - **sets the MapLibre worker URL explicitly** from `maplibre-gl/dist/maplibre-gl-worker.mjs?url`.
  - `OfflineMapLibre.tsx`: the React component:
    - the mode prop and the notice;
    - `onReady(map)` and `addOverlayLayer(map, layer, 'below-labels' | 'top')` (the overlay slot: above the background, below the labels, or on top).
  - `offlineStyle.test.ts`: six unit tests, including validation against the official style spec.
- **Harness** `prototypes/maplibre-offline/`:
  - a Vite page with its own config;
  - `map-data/` is served with HTTP range requests.
- **Data** (`map-data/`, git-ignored):
  - `basemap/uae.pmtiles`: a byte-identical copy of MOVER's. SHA-256 `17de2d52a6fca1b633fbe2bbfa7265a9287980c59391274fd97427506b73028f`; Protomaps Basemap 4.14.9; OSM replication 2026-06-25.
  - The terrain pipeline's `terrain/glo30/visualization/hillshade.pmtiles`: PNG, z6–12, display only.

**Two integration findings for the page work:**
1. **Worker URL in production builds.** MapLibre 6 computes its worker URL at run time from `import.meta.url` with a variable file name, so a production build does not emit the worker file by itself. `setup.ts` imports it as an asset and calls `setWorkerUrl`. The harness production build emits `assets/maplibre-gl-worker-<hash>.mjs` (518.8 kB).
2. **Dev-server pre-bundling.** In the Vite dev server, pre-bundling `maplibre-gl` broke the worker: a 404 on `.vite/deps/maplibre-gl-worker.mjs`, then "Outdated Optimize Dep" reloads. The harness sets `optimizeDeps.exclude: ['maplibre-gl']`. `frontend/vite.config.ts` will need the same line when the module is wired; it was not edited here.

The MapLibre bundle is about 1 MB minified (harness build 1,307 kB, 371 kB gzip). The page should load it on demand.

## 5. Acceptance (`node tests/acceptance/maplibre-labels.mjs`)

**Setup:**
- Headless Edge through playwright-core; the test starts the harness itself.
- Every request that is not to `127.0.0.1:5197` is aborted and counted.
- Chromium's resolver maps every other host name to "not found" (`--host-resolver-rules`).
- Evidence: `docs/evidence/maplibre-labels/` (`results.json`, `glyphs-*.json` and pictures).

**How the shaping and order check works (G-1…G-8):**
1. Each sample is drawn by MapLibre: built-in shaping and bidi, glyphs from the local font.
2. The same text is drawn by the browser's own text engine on a 2D canvas, in the same font file and with an explicit direction. This is the correct reference.
3. Both pictures are cropped to their ink, resampled to 240×48 and compared by correlation.
4. A label passes when:
   - it matches the correct reference with r ≥ 0.80;
   - it beats every broken reference by ≥ 0.08 — isolated letters, isolated letters forced left to right, and logical order forced left to right; for the bracket sample, the double-mirrored picture;
   - its aspect ratio is within 15%.
5. Three deliberately broken candidates must fail this test: MapLibre given isolated letters, MapLibre given reversed order, and canvas text with neither shaping nor bidi.

Results of the final run (Edge, 1366×900, scale 1):

| Check | Result | Measured |
|---|---|---|
| G-0 No right-to-left plugin configured or loaded | PASS | MapLibre 6.15.0; deprecated status `requested` (right-to-left text seen, no plugin URL, nothing loaded); no rtl-text script requested |
| G-1 Arabic (4 road names) | PASS | r = 0.922–0.960; margin over broken ≥ 0.661 |
| G-2 English (2) | PASS | r = 0.877, 0.978 |
| G-3 Mixed Arabic + Latin (2) | PASS | r = 0.962, 0.988; margin ≥ 0.54 |
| G-4 Route numbers (E 11, D 94) | PASS | r = 0.935, 0.962 |
| G-5 Punctuation (brackets, Arabic comma, guillemets, «؟», «!») | PASS | r = 0.869 / 0.936 on the RTL document, 0.985 / 0.971 with the workaround |
| G-6 Arabic-Indic and Western numerals | PASS | r = 0.988, 0.946 |
| G-7 The check rejects broken text | PASS | Broken candidates r = 0.277, 0.223, 0.051: all rejected |
| G-8a Bracket mirroring on `<html dir="rtl">` with the module fix | PASS | r = 0.932; margin 0.274 |
| G-8b Bracket mirroring on `<html dir="ltr">` and `<body dir="rtl">` (cross-check) | PASS | r = 0.932; margin 0.274 |
| G-8c Control: `<html dir="rtl">` without the fix | **KNOWN-DEFECT** (upstream) | r = 0.648; margin −0.336 |
| M-1 Arabic road names on the UAE basemap (Dubai, z14) | PASS | 62 of 67 placed road labels Arabic |
| M-2 Route-number shields | PASS | 17 placed: D90, D71, D92, D86, E11, D72 … |
| M-3 English road names (English label language) | PASS | 53 placed |
| M-4 Collisions (z16, Dubai, the version-pinned collision grid) | PASS | 37 placed label features, 22 boxes and 114 circles, 0 overlaps |
| M-5 Zoom 8→10→12→13→14→15→16→17→15→12→9 | PASS | Idle at every step; labels at every zoom (2–107); 0 map errors |
| M-6 Street mode (Hatta, z12) | PASS | OSM notice and attribution; overlay drawn |
| M-7 Terrain mode | PASS | GLO-30 hillshade drawn (luma σ 13.8 → 33.0); DSM notice and Copernicus attribution; camera, overlay and selected state unchanged |
| M-8 Back to street mode | PASS | Identical camera, overlay and selection |
| F-1 Font coverage | PASS | 328 distinct drawn labels; every character is in the packaged Noto Sans Arabic file |
| A-1 Air gap | PASS | **0 external requests** (279 local; the only font request is `/fonts/NotoSansArabic.ttf`) |
| A-2 Console or page errors | PASS | none |

**Totals (4 Nov 2026, after the local fix):** 21 PASS, 0 FAIL, 0 external requests; G-8c is the control that keeps the upstream defect visible (section 2). The earlier run gave 20 PASS with G-8a as a known defect.

**Data limitation:** OSM maps tidal khors (خور البطين، خور الراحة) and mostly dry mountain wadi beds (Hatta) alike as
`water/river`, and the tiles carry no intermittent flag. The style draws river areas fainter in both modes. The
official water layers remain subject to licensing (V3 §10).

## 6. Ready-to-paste ADR

```
ADR-0xx — Offline MapLibre map for Stationing V3 (owner decision 5, 4 Nov 2026)

Context. The production Stationing V3 map needs vector roads, Arabic/Latin labels, offline PMTiles, styling, several
layers, a terrain background, polygons and good zoom behaviour, with no internet in the isolated deployment. MOVER
already serves a UAE PMTiles basemap with MapLibre. The owner chose MapLibre over a Leaflet canvas renderer and
corrected the assumption that MapLibre needs a right-to-left plugin.

Decision.
1. maplibre-gl 6.15.0 and pmtiles 4.5.0, exact pins (newest stable releases at least two weeks old on 4 Nov 2026),
   in the frontend; MapLibre is loaded only by the Stationing V3 map.
2. No right-to-left or shaping plugin: 6.15.0 shapes Arabic and orders bidirectional text itself (src/index.ts:92-94,
   symbol/arabic_shaping.ts, symbol/bidi.ts via bidi-js). setRTLTextPlugin is never called.
3. Fonts: the style's `font-faces` names the packaged Noto Sans Arabic file (OFL); no glyphs URL, no glyph PBFs, no
   sprite. Every label character must be in that font (acceptance F-1).
4. Data: the basemap and the hillshade are local PMTiles read with HTTP range requests from the application origin
   (`pmtiles://`), registered once with the MapLibre worker URL set explicitly from the packaged worker file.
5. Street and terrain modes are two layer groups of one style; a mode switch changes only their visibility, so page
   overlays, feature state and the camera are untouched. Page layers go through addOverlayLayer (above the background,
   below labels, or on top).
6. Attribution: OSM/ODbL with «أسماء الطرق من OpenStreetMap وليست أسماء رسمية»; Copernicus GLO-30 with
   «نموذج سطح DSM وليس تضاريس رسمية». OSM names are never shown as official names.

Consequences. About 1 MB more JavaScript for the Stationing page (load on demand) plus a 519 kB worker asset; the dev
server must not pre-bundle maplibre-gl (optimizeDeps.exclude). Shaping and order are verified objectively against the
browser's own text engine in the same font (tests/acceptance/maplibre-labels.mjs), including deliberately broken
inputs that the check rejects. Real touch hardware and the owner's manual check remain release gates.

Alternatives. Leaflet canvas renderer (rejected by the owner, decision 5); @mapbox/mapbox-gl-rtl-text (deprecated,
unnecessary in 6.15.0); server-built SDF glyph PBFs (unnecessary with font-faces; kept as a fallback only if a future
test shows a font-faces failure).
```
