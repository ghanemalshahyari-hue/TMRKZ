# TMRKZ — stationing workspace UX prototype (Stage 2 of the 2 Nov 2026 brief)

An isolated, reversible prototype of a redesigned «مساحة التمركز». It changes the **presentation and interaction
model only**: it drives the application's own polygon engine (`frontend/src/components/stationing/FootprintEditor.ts`),
geodesy (`frontend/src/lib/geo.ts`, `footprint.ts`, `coords.ts`) and the frontend's design-system styles
(`prototype.css`, `app.css`, `stationing.css`, the local Arabic font) and imports them without modifying them.

**Nothing here is part of the application.** No route, menu entry, build or container includes it; it talks to no
server; it is not integrated into the real stationing page and must not be until the owner approves the design.

## Run

```sh
# from the repository root, after `cd frontend && npm install` (the prototype borrows frontend/node_modules)
node frontend/node_modules/vite/bin/vite.js --config prototypes/stationing-ux/vite.config.mjs   # http://127.0.0.1:5194/
cd frontend && npx tsc --noEmit -p ../prototypes/stationing-ux/tsconfig.json                    # type check
cd frontend && npx vitest run --config ../prototypes/stationing-ux/vite.config.mjs              # clustering / label tests
```

The headed side-by-side comparison with the current page is `docs/audit/stationing-ux/redesign/compare-run.mjs`
(see `docs/audit/stationing-ux/redesign/COMPARISON_AR.md`).

## What is simulated

| In the prototype | In the application |
|---|---|
| 21 fictional organisations, 38 fictional sites (seeded shapes), symbols from the test catalogue | HR-synchronised organisations, registered geometry from PostGIS |
| Range (1–6 km), occupancy and shape checks run locally in the engine | The server re-checks distance, overlap and conflicts after every drop and again atomically on submission |
| «حفظ كمسودة» keeps the draft in this browser (`localStorage`, key `tmrkz.proto.stationing.drafts`) | A draft is a relocation request on the server, with audit |
| «إرسال للاعتماد» shows a notice only | Submission starts the approval workflow; the registered site never changes before approval |
| Every action is available (one fictional requester) | Each action is authorised on the server (OpenFGA, separation of duties) |
| The app frame (icon rail on tablets, menu on phones) is a frame-level suggestion | The application shell is unchanged |

## Files

- `src/Workspace.tsx` — map-first workspace: clustering, collision-aware names, one search, collapsible hierarchy,
  contextual cards (site / organisation / sites at one point), layers and legend popovers, bottom sheet on narrow screens.
- `src/Editor.tsx` — contextual relocation editor around the unchanged engine: floating toolbar, two modes (move the
  registered boundary / draw a new one), live readout, range rings with names, decluttered map tags, details step, drafts.
- `src/layout.ts` (+ `layout.test.ts`) — pure screen-space clustering and label placement.
- `src/data.ts` — the fictional data set; `src/symbols.tsx` — offline unit symbols (milsymbol, as in the application).

## Stationing domain model V2 page (3 Nov 2026)

`model.html` (`src/model/`) is a second, separate page: the owner-approved stationing domain model V2
(`docs/STATIONING_DOMAIN_MODEL_V2_AR.md`) as a simulated state machine — current/temporary stationing, associated areas,
primary and alternative relocation candidates, activation, cancellation, extension, early return — with simulated
people, permissions and time. Open `http://127.0.0.1:5194/model.html#s=1` … `#s=18` for the owner's eighteen scenarios.
Unit tests: `src/model/domain.test.ts` (run with the vitest command above). Browser evidence and report:
`docs/audit/stationing-ux/model-v2/`. It adds no dependency and is not integrated. Scenarios 19–22 (3 Nov, second pass)
add cancellation before start and the reservation / covered-scope / exception flows; sensitive actions open their own
reason dialogs (`src/model/dialog.tsx`); phones get a three-height bottom sheet. `window.__stationingModel` is a
prototype-only test hook for the browser evidence.

**Basemap tiles (`src/svgBasemap.ts`, both pages):** the regional SVG basemap is drawn as vector tiles — parsed once,
each tile drawing only the shapes that touch it — instead of one `L.imageOverlay` the browser re-rasterised on every
zoom step (measured up to 160–200 ms frames; now ≤ 14 ms). Same picture and georeferencing. The application's
`MapCanvas` received the same fix, with a strict reader of the package structure, on 3 Nov 2026 (ADR-030).

## Stationing model V3 page (3 Nov 2026; revision 2 = the owner's FINAL model, supersedes the V2 relocation candidates)

`restationing.html` (`src/v3/`) is a third, separate page for the owner brief «COMPLETE STATIONING / RE-STATIONING /
DEPLOYMENT REDESIGN» (`docs/STATIONING_MODEL_V3_AR.md`): ONE re-stationing site per request, the two DEPLOYMENT areas
(primary + alternative) of a stationing context with radial guidance bands, a fictional Oracle TEST extract (L6–L10)
projected by parent links, TMRKZ sites (one from a fictional external site system) separate from the hierarchy,
selectable scope (co-located, distributed, excluded child, unrelated occupants), permanent/temporary lifecycles,
return-for-edit with fact-based invalidation, hierarchy-derived routing, a versioned administrator policy with the
owner's open decisions O-01…O-12 as visible switches, and two offline map modes drawn from the local GeoJSON package
(«الشوارع» road hierarchy; «طبيعة الأرض» land cover with hillshade and contours of a GENERATED illustrative elevation
field — the repository has no terrain data; not for production). Revision 2 adds site links separate from stationing, configurable cross-branch approvals, routing from the requesting unit, pause on hierarchy change, hard-blocked occupied deployment areas, largest-area terrain class, and offline Arabic road names (OpenStreetMap, non-authoritative; `src/v3/data/README.md`). Scenarios: `http://127.0.0.1:5194/restationing.html#s=A` … `#s=X` (W = the owner's open distance-method question).

- `src/v3/domain.ts` — the pure state machine and guards; `fixtures.ts` — fictional world; `scenarios.ts` — A–S as
  action lists; `measure.ts` — the three distance methods and band outlines; `basemap.ts` — the two map modes;
  `App.tsx`, `cards.tsx`, `v3.css` — the page. The real polygon engine (`FootprintEditor`) is used unchanged, one
  instance at a time (site, primary or alternative).
- Unit tests: `src/v3/domain.test.ts` (vitest command above). Browser evidence: `docs/audit/stationing-ux/model-v3/`
  (`v3-run.mjs`, `REPORT_AR.md`, `screenshots/`). `window.__v3` is a prototype-only test hook.

## Removing it

Delete `prototypes/stationing-ux/` and `docs/audit/stationing-ux/redesign/` (and `model-v2/`, `model-v3/`). Nothing else references them.
