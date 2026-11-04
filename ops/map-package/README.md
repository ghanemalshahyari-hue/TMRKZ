# TMRKZ offline map package

The Stationing V3 map runs from one offline package: the UAE street basemap, the map font, the style, and the Copernicus
GLO-30 terrain products with their provenance and licence notices. Its format is `tmrkz-offline-map-package`,
version 1; ADR-036 records why it looks like this.

The package is built from local, verified sources, installed with a staging copy and a directory swap, served read-only
by the web entry point, and checked by a readiness tool. Nothing is fetched from the internet at any stage.

The data files (about 584 MB) are never committed to git. Only these tools and the release record
`map-packages/tmrkz-map-<version>/` (manifest and checksums) are.

## Layout

```
tmrkz-map-2026.11.1/                         package root, named after the package id
  manifest.json                              what every file is (below)
  SHA256SUMS                                 the same checksums, for `sha256sum -c`
  ATTRIBUTION.txt                            what each component requires to be shown or kept
  licences/ODbL-1.0-NOTICE.txt               OpenStreetMap, Open Database License 1.0
  licences/COPERNICUS-DEM-GLO-30-NOTICE.txt  Copernicus WorldDEM-30 licence, Article 6 (a)-(d), word for word
  licences/OFL-1.1.txt                       Noto Sans Arabic, SIL Open Font License 1.1
  basemap/uae.pmtiles                        MAP_VISUALIZATION: street basemap (Protomaps schema, OSM)
  fonts/NotoSansArabic.ttf                   MAP_VISUALIZATION: the map's label font
  styles/stationing-v3.json                  MAP_VISUALIZATION: the style the application builds
  terrain/glo30/visualization/hillshade.pmtiles   MAP_VISUALIZATION: hillshade, display only
  terrain/glo30/analysis/slope_pct_x100_<cell>.tif + SHA256SUMS
                                             BUSINESS_ANALYSIS: slope, loaded into PostGIS; never served to browsers
  terrain/glo30/provenance/terrain-manifest.json   PROVENANCE: the terrain record (map-packages/terrain-glo30-2026.11)
  terrain/glo30/provenance/build-report.json       PROVENANCE: the build report, without run timings
  terrain/glo30/provenance/absent-tiles.json       PROVENANCE: evidence for the two open-sea cells
  terrain/glo30/provenance/source-verification.json PROVENANCE: the source tiles against MOVER's provenance
  [terrain/glo30/source/Copernicus_DSM_COG_10_*.tif]  optional, archival only (--with-source); not needed at run time
```

No other path is accepted. The verifier refuses any file outside this layout, any link, junction or special file, and
any path with `..`, a leading `/`, a backslash or a drive letter.

The two data roles are kept apart:
- **Business analysis:** `terrain-analysis`, the slope that the backend classifies with the versioned policy.
- **Map visualization:** everything the browser draws.

## Manifest (`manifest.json`)

| Field | Content |
|---|---|
| `format`, `formatVersion` | `tmrkz-offline-map-package`, `1` |
| `packageId`, `packageVersion` | `tmrkz-map-<YYYY.MM.n>`, the version part |
| `createdAt` | UTC build time, or `SOURCE_DATE_EPOCH` when set (reproducible builds) |
| `builtBy` | tool, tool version, git revision, whether the map tools' tree was clean |
| `compatibility` | application, served path (`/map-data/`), MapLibre 6.15.0, PMTiles 4.5.0, terrain schema (Flyway V18+), terrain encoding, `styleSha256` |
| `coverage` | required extent `bbox` [west, south, east, north] and its basis, the basemap bounds, the terrain grid |
| `components[]` | one entry per component: `id`, `role`, `required`, and what it is (below) |
| `attribution` | `ATTRIBUTION.txt`, the attribution the map shows per mode, and the required texts per component |
| `totals` | number of files and bytes |
| `contentSha256` | sha256 of `SHA256SUMS`, which covers every file |
| `files[]` | `path`, `sha256`, `size`, `component` for every file except `manifest.json` and `SHA256SUMS` |

| Component | Role | Required | Records |
|---|---|---|---|
| `basemap` | MAP_VISUALIZATION | yes | Protomaps version, planetiler build, OSM replication, origin, tile type/zooms/bounds/layers, ODbL, unofficial road names |
| `fonts` | MAP_VISUALIZATION | yes | file, MapLibre font name, full name, family, version, coverage, OFL |
| `style` | MAP_VISUALIZATION | yes | file, generator (`offlineStyle.ts`), layers |
| `terrain-analysis` | BUSINESS_ANALYSIS | yes | dataset code, version, DSM, encoding, processing version, slope product sha256, cell counts |
| `terrain-visualization` | MAP_VISUALIZATION | yes | format, zooms, tiles, bounds, processing version |
| `terrain-provenance` | PROVENANCE | yes | product, instance, DSM limitation, no FGIC, grid, present and open-sea cells, the 28 source tiles with sha256 and retrieval time, processing, licence document and its sha256 |
| `licences` | LEGAL | yes | the notice files |
| `terrain-source` | PROVENANCE | no | the unmodified tiles (Article 6(a)), only in an archival build |

## Build (connected or isolated build host)

```sh
SOURCE_DATE_EPOCH=<seconds> python ops/map-package/build_package.py --archive
python ops/map-package/package_format.py map-data/packages/tmrkz-map-2026.11.1
```

The build reads the inputs listed in `sources.json` and checks each one against its recorded checksum before copying:
- the basemap and the font against `sources.json`;
- the 28 GLO-30 source tiles, the slope files and the hillshade against
  `map-packages/terrain-glo30-2026.11/manifest.json`.

It writes the style with `export_style.mjs`, which needs Node and `frontend/node_modules`. It then verifies the
assembled package in full and only then renames it into `map-data/packages/`.

With `--archive` it also writes a deterministic `tmrkz-map-<v>.tar`:
- sorted members, files only;
- owner root:root, mode 0644, modification time = `createdAt`.

It writes the archive's `.sha256` beside it. With the same inputs, revision and `SOURCE_DATE_EPOCH`, every file, the
manifest and the tar are byte-identical.

## Install (target host: Python 3.9+, standard library only)

```sh
python3 ops/map-package/install_package.py install --package tmrkz-map-2026.11.1.tar --root /srv/tmrkz/map \
        --expect-sha256 "$(cut -d' ' -f1 tmrkz-map-2026.11.1.tar.sha256)"                    # plan, exit 3
python3 ops/map-package/install_package.py install ... --confirm /srv/tmrkz/map                 # carry it out
```

The map root holds only:
- `current/`: the active package; the only directory the web entry point serves;
- `previous/`: the package the last install replaced, kept whole;
- `history/`: `install-log.jsonl` and a copy of every installed or replaced manifest.

The installer refuses any other root:
- a relative path;
- a filesystem root, the home or repository directory;
- a link;
- a directory holding anything else;
- a root that overlaps the package;
- a root another install has locked.

The install sequence:
1. Verify the package in full: layout, every sha256, every component's content.
2. Copy only the listed files into `.staging-*` on the same disk.
3. Verify the staged copy in full again.
4. Rename `current` → `previous`, then `.staging-*` → `current`.

If anything fails before step 4, the active package is untouched. If the second rename fails, the first is undone.

**Serving:** the web entry point mounts the map root read-only at `/srv/tmrkz-map` (`TMRKZ_MAP_ROOT` in `.env`;
acceptance: `map-data/runtime`, `ops/test-env/compose.v3-maps.yml`). nginx serves `current/` under `/map-data/`:
- with range requests;
- without following links;
- GET only;
- never serving `previous/`, `history/`, the slope analysis or the source tiles.

On a Linux host, a swap takes effect immediately. On Windows/Docker Desktop, a rename can fail while nginx holds a file
open. The installer then restores the active package and says so; stop the web container for the swap.

## Recovery

```sh
python3 ops/map-package/install_package.py restore-previous --root /srv/tmrkz/map               # plan
python3 ops/map-package/install_package.py restore-previous --root /srv/tmrkz/map --confirm /srv/tmrkz/map
python3 ops/map-package/install_package.py status --root /srv/tmrkz/map [--full]
```

`restore-previous` verifies `previous/` in full, then exchanges it with `current/`. Running it again undoes the
restore. If `previous/` is gone, reinstall the earlier archive: every release keeps its `.tar` and `.sha256` with the
release record. `history/` holds the manifest of every package that was ever active. Recovery never needs a download.

## Terrain business data

The package carries the slope analysis. Loading it into PostGIS is a separate, audited operation with the existing
loader, from the installed package:

```sh
TERRAIN_DIR=/srv/tmrkz/map/current/terrain/glo30/analysis \
TERRAIN_MANIFEST=/srv/tmrkz/map/current/terrain/glo30/provenance/terrain-manifest.json \
  sh ops/terrain/load-slope.sh <db-container|compose-project> 2026.11          # plan; CONFIRM_TARGET=... to load
```

When the same product is already loaded, the loader re-checks it and changes nothing. It needs Python with `rasterio`
(`ops/terrain/requirements.txt`).

## Readiness

```sh
python ops/map-package/readiness.py --root /srv/tmrkz/map --url http://localhost:8088 --db-container <db> \
       --expect-package tmrkz-map-2026.11.1
```

It answers each question with PASS or FAIL:
- package present, manifest valid, checksums valid;
- basemap readable, required fonts present, style local;
- terrain dataset present and consistent, geographic coverage valid, attribution and licence notices present;
- the terrain dataset is loaded with the same slope product, and the policy in force names that version;
- the web entry point serves this exact manifest, answers PMTiles with ranges, serves the font, and hides the analysis.

**Result:** READY (exit 0); NOT READY on any failure (exit 1); INCOMPLETE when a section was not asked for (exit 2).

## Tests

`python -m pytest ops/map-package -q` checks:
- layout, manifest, checksums;
- path traversal, links and foreign archive members;
- oversized and malformed manifests;
- plan-by-default, install, keep previous, restore;
- archive sha256, corrupted packages, undone swaps, dangerous roots;
- the PMTiles tile ids against the reference library;
- the content checks on the real package.
