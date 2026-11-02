# TMRKZ — map interaction prototypes

## Symbol-first interaction prototype (`flow.html`) — the product-concept prototype

The accepted product flow, isolated and polished (Leaflet + milsymbol, fictional data, no production code):
**click an organisation SYMBOL → compact contextual toolbar → drag a copy of THAT org's symbol → live distance /
availability (no snap-back) → drop → minimal confirmation card**. Progressive disclosure: no request details until a
position is chosen. Covers A–H: symbol click, action menu, dragging the org's own symbol, the original kept visible as
«الموقع الحالي», live distance + red out-of-range/occupied feedback, drop, a minimal card, Escape to cancel/restore,
a shared-facility picker, and permission-gated actions.

```sh
cd prototypes/map-drag && npm install && npm run dev   # http://127.0.0.1:5190/flow.html
node open-flow.mjs                                      # opens it in Edge, left open
HEADLESS=1 node flow-probe.mjs                          # scripted A–H walkthrough + screenshots in evidence/flow-*.png
```

Server-authoritative checks, permissions, workflows and the engine are unchanged — this is an interaction prototype
for acceptance, not an integration. Decision gate: the owner tries it in the browser before any production change.

---

# map-drag performance prototypes (A vs B)

Isolated prototypes for the owner's map-interaction rebuild brief. **Nothing here touches production code**
(`frontend/src`, backend, API). It exists only to compare two engines and one interaction architecture, in the
browser, with real measurements, before any decision to migrate.

- **Prototype A — Leaflet 1.9.4 (current engine), interaction re-architected.** A live toggle:
  - **الحالي (naive)** reproduces the current workspace pattern: a committed-state update **and** an icon rebuild
    (`setIcon`) on *every* pointer move, and the marker snapping back at the range boundary (the "bounce").
  - **المُحسّن (opt)** is the proposed architecture: one imperative interaction layer, `requestAnimationFrame`-
    coalesced; **no** committed-state update and **no** server call during the gesture; text mutated in place (no
    `setIcon`); a **soft boundary** — the marker follows the pointer and turns red, and confirmation is blocked,
    instead of snapping back. Facilities drawn as one Canvas layer, not DOM markers.
- **Prototype B — MapLibre GL JS 6 (WebGL), same isolation architecture.** Facilities, occupied zones and the
  allowed range are GPU layers (one draw call each, count-independent). The proposal is a draggable DOM marker;
  only a thin line source and the marker's own text change during the drag. **Terra Draw** is loaded lazily, only
  for the optional footprint polygon, so the core demo never depends on the adapter's MapLibre-v6 status.

Both use **identical fictional data** (`src/data.ts`), identical geo math (copied from `frontend/src/lib/geo.ts`
so they agree to the metre), the same scene extent and the same initial zoom.

## Offline

All JS/CSS is bundled by Vite; there is **no CDN or tile server at runtime**. Prototype B uses an empty MapLibre
style (a plain background colour) so it needs no glyphs, sprite or remote tiles. The driver blocks every non-
`localhost` request and records any attempt in `evidence/RESULTS.md` — a clean run proves the air-gap.

A real local basemap (PMTiles / the installed map package) is intentionally **out of scope** here and the existing
offline map in the app is left untouched; adding one to B is listed as follow-up work in the decision gate.

## Run it yourself

```sh
cd prototypes/map-drag
npm install
npm run dev            # http://127.0.0.1:5190
```

Open and drag the green marker:

- A optimised, 100 sites: `http://127.0.0.1:5190/?p=a&n=100&mode=opt`
- A current-pattern, 100 sites: `http://127.0.0.1:5190/?p=a&n=100&mode=naive`
- B (MapLibre), 1000 sites: `http://127.0.0.1:5190/?p=b&n=1000`

`?p=a|b` engine · `?n=10|100|1000` facilities · `?mode=naive|opt` (A only). The HUD (top-left) shows live FPS and,
after each drag, measured frame times, long tasks, state-updates-during-drag and server-calls-during-drag.

## Measure it (Microsoft Edge, no download)

```sh
npm run build && npm run preview     # serves the production bundle on :5191
node drive.mjs                        # headed by default; HEADLESS=1 for CI
```

Writes `evidence/*.png`, `evidence/*.gif`, `evidence/results.json` and `evidence/RESULTS.md`. Frame times are rAF
intervals sampled **during the scripted gesture**; long tasks come from `PerformanceObserver`. No number is invented.
