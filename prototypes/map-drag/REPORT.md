# TMRKZ — Map interaction rebuild: prototype comparison & recommendation

**Status: decision gate. Nothing in production was changed. Awaiting your hands-on test and approval before any migration.**

## الخلاصة (Arabic TL;DR)

بُني نموذجان معزولان تماماً (لا يمسّان كود الإنتاج): **أ = Leaflet الحالي بعد إعادة هندسة التفاعل**، و**ب = MapLibre GL
(WebGL)**. كلاهما يعمل **دون إنترنت**، ببيانات وهمية متطابقة، وقِيست الأرقام فعلياً في المتصفح (Edge).

- المشكلة الأساسية ليست المحرك، بل **نمط التفاعل الحالي**: تحديث حالة React وإعادة بناء أيقونة في **كل حركة ماوس**،
  و**ارتداد العلامة** عند حدّ النطاق. قِسنا ذلك: النمط الحالي ينفّذ **٨٤ تحديث حالة أثناء سحبة واحدة**، بينما المُحسّن و«ب»
  ينفّذان **١ فقط** (عند الإفلات).
- على جهازك السريع، الإطارات ثابتة (~75f/s، صفر تعثّر) في كل الحالات، فالفرق المقيس ليس في زمن الإطار بل في **العمل
  المهدور** و**سلوك الحد** (ارتداد مقابل حدّ ناعم يتبع المؤشر ويتحوّل أحمر).
- **التوصية: اعتماد إعادة هندسة التفاعل داخل Leaflet أولاً (النموذج أ-المُحسّن)** — فائدة فورية، مخاطرة شبه معدومة، لا هجرة.
  الإبقاء على MapLibre (ب) كخيار لاحق إن احتجنا فعلاً إلى آلاف العناصر الحية أو خلفيات متجهة. **القرار النهائي لك بعد تجربتك
  بنفسك.**

---

## 1. What was built (isolated, not production)

Everything lives under `prototypes/map-drag/` and touches **no** production code, backend, or API. Two prototypes,
one shared scene (`src/data.ts`, fictional), identical geo math copied from `frontend/src/lib/geo.ts`, a live metrics
HUD, and a Playwright/Edge driver (`drive.mjs`) that scripts a drag and records **measured** numbers.

| | Prototype **A** — Leaflet 1.9.4 (current engine) | Prototype **B** — MapLibre GL JS 6 (WebGL) |
|---|---|---|
| What it tests | the current engine with the interaction **re-architected**; a live `الحالي`↔`المُحسّن` toggle | a WebGL engine with the **same** isolation architecture |
| Facilities drawn as | one Canvas layer (`circleMarker`), not DOM markers | one GPU `circle` layer |
| Range / occupied / line | Canvas polygons / polyline | GPU `fill`/`line` sources |
| Editing (footprint) | — (not needed for the drag) | **Terra Draw** lazy-loaded on demand |

## 2. Diagnosis of the current workspace drag (from the code)

In `frontend/src/components/stationing/StationingPanel.tsx`:

- **A React re-render on every pointer move.** `marker.on('drag')` calls `setLive({...})` each tick (line ~276) → the
  whole ~700-line panel re-renders per move.
- **A DOM icon rebuild on every render.** A dependency-less effect (lines ~299–309) calls `setIcon(L.divIcon(...))` on
  the distance chip and the bubble on *every* render → DOM replacement per drag tick.
- **The bounce.** `clampToRange` + `marker.setLatLng(p)` (lines ~252–258) forces the marker back inside the range during
  the gesture instead of letting it follow the pointer.
- In `MapCanvas.tsx`, `clearLayers()` + full marker rebuild runs whenever `selectedSiteId`/`layers`/`features` change
  (lines ~196–262) — fine for data refresh, wasteful if touched mid-interaction.

These are the four behaviours the prototypes remove.

## 3. How it was measured (no invented numbers)

- Frame time = `requestAnimationFrame` interval **sampled only during the gesture**; long tasks from
  `PerformanceObserver`. State-updates/server-calls during the drag are counters incremented by the prototype itself.
- The driver runs **headed Microsoft Edge** (real GPU for MapLibre), viewport 1440×900, blocks every non-`localhost`
  request, and reads `window.__proto.metrics.snapshot()` after each scripted drag. Raw data: `evidence/results.json`.
- Scripted drag crosses the allowed-range boundary **and** sweeps an occupied zone, at 10 / 100 / 1000 facilities.

## 4. Measured results (Edge, headed, your machine)

| scene | frames | mean ms | p95 ms | worst ms | mean fps | janky >25ms | long tasks | **state-updates / drag** | server calls / drag |
|---|---|---|---|---|---|---|---|---|---|
| A-opt · 10 | 165 | 13.34 | 13.4 | 13.5 | 75 | 0 | 0 | **1** | 1 |
| A-opt · 100 | 170 | 13.34 | 13.5 | 13.7 | 75 | 0 | 0 | **1** | 1 |
| A-opt · 1000 | 162 | 13.34 | 13.4 | 13.6 | 75 | 0 | 0 | **1** | 1 |
| **A-naive · 100** | 175 | 13.34 | 13.5 | 13.6 | 75 | 0 | 0 | **84** | 1 |
| B (MapLibre) · 10 | 170 | 13.34 | 13.5 | 14.3 | 75 | 0 | 0 | **1** | 1 |
| B (MapLibre) · 100 | 166 | 13.34 | 13.4 | 14.3 | 75 | 0 | 0 | **1** | 1 |
| B (MapLibre) · 1000 | 160 | 13.34 | 13.5 | 13.5 | 75 | 0 | 0 | **1** | 1 |

Screenshots: `evidence/<scene>-{1-start,2-drag,3-drop,4-panzoom}.png`. GIFs: `evidence/a-opt-n100.gif`,
`a-naive-n100.gif`, `b-n100.gif`.

### What the numbers do and do **not** say (honest reading)

- **Frame time does not separate the options on your hardware.** Your display runs ~75 Hz and the GPU has headroom, so
  every optimised variant — and even the naive one in this synthetic harness — holds ~13.3 ms/frame with **0 dropped
  frames** at 10, 100 and 1000 facilities. I will not claim a 60-vs-X fps win that the data does not show.
- **The decisive measured difference is wasted work and boundary behaviour:**
  - Naive = **84 committed-state updates in one drag** (one per pointer move); optimised / MapLibre = **1** (on drop).
    In the real app each of those 84 is a full panel re-render **plus** two `divIcon` DOM rebuilds — the churn that
    degrades on slower machines and under the heavier real React tree, and the most likely source of the "not smooth"
    feel. My synthetic naive commit is lighter than the real one, so this is a **floor**, not the full cost.
  - Naive **could not leave the allowed range** in the test (`crossed-out = —`): the snap-back held it in — the bounce.
    Optimised / MapLibre let the marker follow the pointer out and turn red (`crossed-out = ✓`), blocking only
    *confirmation*. This is the behaviour you asked to test, and it is the clearest felt difference.
- **MapLibre scales flat 10→1000 on the GPU** — as expected. **Leaflet-opt also scales flat here**, because facilities
  are a single Canvas layer rather than 1000 DOM markers; so Leaflet is not disadvantaged at 1000 on this machine.

## 5. Offline verification

Both prototypes are bundled by Vite; **no CDN or tile server at runtime**. The driver blocked every non-`localhost`
request and recorded **0** external attempts (`evidence/results.json` → `"external": []`). Prototype B uses an empty
MapLibre style (background colour only), so it needs **no glyphs, sprite or remote tiles**; its web worker is served
from our own origin (`setWorkerUrl` → a local hashed asset). A real local basemap (PMTiles / the installed map package)
was intentionally left out of the prototypes, and the existing offline map in the app was **not** touched.

Integration issues found and fixed while making B work offline (relevant to any future migration):
1. MapLibre v6 ESM has no default export → namespace import.
2. The web worker 404s under a Vite production build → `maplibregl.setWorkerUrl(import('.../maplibre-gl-worker.mjs?url'))`.
3. MapLibre's CSS sets `position: relative` on the container and overrode ours → the map collapsed to 0 height →
   markers clipped/unclickable. Fixed with an `#id` rule. These are exactly the "MapLibre has more moving parts
   offline" costs the research flagged.

## 6. Library comparison (condensed; full notes from live-queried sources)

| | MapLibre GL JS | Terra Draw | OpenLayers | Leaflet + Geoman-free (current) |
|---|---|---|---|---|
| Version / license | 6.16.0 · BSD-3 | 1.39.0 · MIT (+ Leaflet & MapLibre adapters) | 10.11.0 · BSD-2 | 1.9.4 (2023) · BSD-2 / MIT |
| Core size (min+gz) | ~289 KB | ~45 KB | ~84 KB (tree-shakeable) | ~42 KB + ~72 KB |
| Rendering | WebGL (count-independent drag) | geometry only (host adapter draws) | Canvas 2D | DOM + SVG/Canvas |
| Offline | feasible, **most packaging work** (local style/glyphs/sprite/PMTiles) | inherits base map | feasible | **already fully local, lowest effort** |
| Editing | needs Terra Draw / maplibre-gl-draw | its job (point/polygon/rect/translate/vertex) | native Draw/Modify/Translate | Geoman (already covers needs) |
| Arabic/RTL | native in-engine bidi shaping | n/a | manual | plain DOM/CSS (works) |
| Accessibility | features not in DOM (per-feature a11y gap) | pointer-only | same canvas gap | **best: markers are DOM, focus/ARIA** |
| React | react-map-gl v8 | imperative (no official wrapper) | community wrappers | react-leaflet (mature) |

Decision-relevant trade-offs: WebGL's only decisive advantage is **count-independent smoothness with hundreds+ of live
features redrawn during a drag** — which this harness shows your current need does **not** yet hit. Against that:
migration cost (`[lng,lat]` flip, sources+layers model, Geoman→Terra Draw, re-doing overlays, re-validating MAP-01…18),
a larger offline asset burden, and the loss of per-feature DOM accessibility. Terra Draw also has a **Leaflet adapter**,
so better polygon editing is available **without** leaving Leaflet.

## 7. Against your checklist

| Your step | Result |
|---|---|
| 1 Run both in headed Edge | ✓ `drive.mjs` ran headed |
| 2 Compare naive / opt / MapLibre, identical conditions | ✓ same scene, zoom, data |
| 3 FPS, frame time, drag latency, renders, long tasks, network | ✓ measured (table §4; "renders" = committed-state updates: 84 vs 1) |
| 4 10 / 100 / 1000 markers | ✓ |
| 5 Offline with assets | ✓ 0 external requests |
| 6 Screenshots, GIFs, report | ✓ `evidence/` + this file |
| 7 Marker follows pointer across boundary & occupied | ✓ opt/B soft-follow + red; naive bounces (shown) |
| 8 Pan/zoom/selection vs drag don't interfere | ✓ pan+zoom step ran after each drag without disturbing the proposal; marker drag and map pan are separate gestures |
| 9 Leave running / URLs | ✓ see below |

## 8. Recommendation

1. **Adopt the interaction re-architecture inside Leaflet first (Prototype A "optimised").** It removes the per-move
   React churn, the per-move `setIcon`, and the bounce; keeps the shipped, acceptance-tested engine, the offline map,
   Geoman, and DOM accessibility; and carries near-zero regression risk. This is the change that makes the drag *feel*
   immediate, and it is a small, contained edit to `StationingPanel.tsx` (not a migration).
2. **Keep MapLibre (B) as a staged option, not now.** Choose it only if a real need appears for hundreds-plus of live
   features redrawn during interaction, or vector basemaps. If/when we do, Terra Draw's Leaflet adapter lets us upgrade
   editing first, independently.

### Remaining problems / honest gaps

- I could **not** reproduce frame drops on your machine; the win I measured is wasted-work + the bounce, not fps. If the
  jank you feel persists after the Leaflet re-architecture, the next suspect is the full React tree (heavier than the
  prototype stub) and `MapCanvas` rebuilds — measurable next with the real app under the Chrome profiler.
- The prototypes have **no real basemap** (blank background) and **no server validation** (a 160 ms stub). The current
  offline image basemap and the real PostGIS checks are untouched and would carry over unchanged.
- MapLibre's offline packaging (local style/glyphs/sprite/PMTiles) is real work not done here.
- Measurements are from one machine/session; p95/worst are from a single scripted drag per scene.

## 9. Try it yourself — the drag is yours to judge

Local test server is running (production build, offline):

- **A, optimised, 100:** http://127.0.0.1:5191/?p=a&n=100&mode=opt
- **A, current pattern (bounce), 100:** http://127.0.0.1:5191/?p=a&n=100&mode=naive
- **A, optimised, 1000:** http://127.0.0.1:5191/?p=a&n=1000&mode=opt
- **B, MapLibre, 100:** http://127.0.0.1:5191/?p=b&n=100
- **B, MapLibre, 1000:** http://127.0.0.1:5191/?p=b&n=1000

If the server is down, restart from `prototypes/map-drag/`: `npm run preview` (:5191) or `npm run dev` (:5190).
Drag the green marker; cross the dashed ring and a red square; compare `الحالي` vs `المُحسّن`; pan and zoom while
dragging. **This work is not complete until you have tried the drag yourself and accepted a direction.**
