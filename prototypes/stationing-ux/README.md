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

## Removing it

Delete `prototypes/stationing-ux/` and `docs/audit/stationing-ux/redesign/`. Nothing else references them.
