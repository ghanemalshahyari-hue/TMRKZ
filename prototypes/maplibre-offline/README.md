# Offline MapLibre harness (Stationing V3, owner decision 5)

This development page runs the **not-yet-wired** frontend module `frontend/src/components/map/maplibre/` with the
frontend's installed packages (`maplibre-gl` 6.15.0 and `pmtiles` 4.5.0, exact pins). It is not part of the
application or of any map package.

## Data (local, git-ignored under `map-data/`)

| File | Source | Licence |
|---|---|---|
| `map-data/basemap/uae.pmtiles` | Protomaps Basemap 4.14.9, a byte-for-byte copy of MOVER's `app/NavMap/data/uae.pmtiles`, SHA-256 `17de2d52a6fca1b633fbe2bbfa7265a9287980c59391274fd97427506b73028f` | ODbL 1.0, © OpenStreetMap contributors; Protomaps |
| `map-data/terrain/glo30/visualization/hillshade.pmtiles` | the terrain pipeline's display-only hillshade from Copernicus GLO-30 (`ops/terrain/`) | Copernicus DEM licence; DSM, not official terrain |
| `frontend/public/fonts/NotoSansArabic.ttf` | already in the application (Arabic, its presentation forms, Latin, both digit sets) | SIL OFL 1.1 (`FONT-LICENSE.txt`) |

To copy the basemap: `mkdir -p map-data/basemap && cp "<MOVER>/app/NavMap/data/uae.pmtiles" map-data/basemap/`. Then
check that the SHA-256 matches the one above.

## Run

```sh
node frontend/node_modules/vite/bin/vite.js --config prototypes/maplibre-offline/vite.config.mjs   # http://127.0.0.1:5197
```

- `/?page=map`: the street/terrain map with a fictional test overlay.
  - Query options: `hillshade=/map-data/terrain/glo30/visualization/hillshade.pmtiles&kind=raster`, `labels=ar|en`, `center=lng,lat`, `zoom=n`.
  - `dir=split` (on either page) puts `dir="ltr"` on `<html>` and `dir="rtl"` on `<body>`, the integration workaround for the double bracket mirror (`docs/audit/stationing-v3-production/MAPLIBRE_LABELS.md` §2).
- `/?page=glyphs`: the shaping and order check (MapLibre against the browser's own text engine, in the same font).

The acceptance check is `node tests/acceptance/maplibre-labels.mjs`. It starts this harness itself, uses headless
Edge and stores its evidence in `docs/evidence/maplibre-labels/`.
