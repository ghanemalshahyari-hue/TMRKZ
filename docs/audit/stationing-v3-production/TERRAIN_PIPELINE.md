# Stationing V3: terrain pipeline from Copernicus GLO-30 (4 Nov 2026)

This is the tooling for owner decisions 2 and 3:
- terrain is classified by **slope percent**, derived from the approved elevation data;
- the initial class thresholds are the FAO-style ones;
- Copernicus GLO-30 is the approved **fallback** production source.

Scope rules:
- No terrain class is baked into any product. The class thresholds (`terrain_slope_classification`) are versioned System Administrator policy, which the backend applies at query time.
- The output is an input for **validating administrator-configured distance values**. It never recommends a location.

**What was not touched:**
- no backend source, migration, frontend or prototype file;
- no acceptance or production database: tmrkz-test, tmrkz-clean, tmrkz-load and tmrkz-mover were not touched;
- nothing was downloaded, committed or pushed.

## 1. Source: reused from MOVER, with verified provenance

`ops/terrain/package_source.py` copies the 28 tiles `Copernicus_DSM_COG_10_N22…N26_00_E051…E056_00_DEM.tif` from `MOVER_1 - Copy/map-source/uae/dem/cop30/` into `map-data/terrain/glo30/source/`. That directory is git-ignored by the new `.gitignore` rule `map-data/`.

| Check | Result |
|---|---|
| Provenance hashes | MOVER `map-library/sources/provenance.json` (identical to `map-source/uae/provenance.json`) records sha256, size, URL and the 2026-10-04 retrieval time for each of the 28 tiles |
| Source vs provenance | **28/28 match** (sha256 and size) |
| Copy vs source | **28/28 byte-identical** (813,077,322 bytes) |
| Metadata (rasterio 1.5.2 / GDAL 3.12.2) | 3600×3600 float32, EPSG:4326, 1/3600° (1 arc-second); `AREA_OR_POINT=Point`, so each value is the sample at the cell centre. No nodata tag, deflate COG. Heights are EGM2008, per provenance |
| Release | Not stated in the tile metadata. Recorded as: AWS Open Data bucket `copernicus-dem-30m`, retrieved 2026-10-04 |
| Record | `map-data/terrain/glo30/source/verification.json` and `map-packages/terrain-glo30-2026.11/manifest.json` (`tiles[]`) |

## 2. The two absent cells are open sea

`ops/terrain/check_absent_tiles.py` writes `map-data/terrain/glo30/source/absent-tiles.json`. The AWS bucket returned 404 for these two cells (MOVER `dl.log`). Independent evidence:

| Cell | GLO-30 neighbour edges facing the cell | SRTM 1″ tile of the same cell (MOVER copy) | Verdict |
|---|---|---|---|
| N25E053 | N24E053 north row, N26E053 south row, N25E052 east column, N25E054 west column: 4 × 3,600 samples, **all exactly 0 m** (GLO-30's ocean value) | min −79 m, **max −11 m**, 0 samples above 0 m | **Open sea** |
| N26E052 | N25E052 north row, N26E051 east column, N26E053 west column: **all exactly 0 m** | min −87 m, **max −9 m**, 0 samples above 0 m | **Open sea** |
| Control: N25E052 (contains land, e.g. Das Island) | — | max +43 m, 12,737 samples above 0 m | Shows that the test does detect land |

There is no missing land coverage. The regional basemap package only covers central Dubai, so it could not be used for this check.

## 3. Analysis product: slope percent

Built by `ops/terrain/build_terrain.py`, `PROCESSING_VERSION = tmrkz-terrain-1.0.0`.

**Grid and neighbourhood:**
- **Grid:** the native grid of each source tile. Nothing is resampled. The output cell geometry is the same as the source tile's, centred on each DEM sample.
- **Mosaic:** a VRT (`analysis/dem_mosaic.vrt`) of all 28 tiles, so pixels on tile borders use the real neighbouring samples. The offsets are asserted to be whole pixels.

**Slope:**
- **Method:** Horn's 3×3 gradient: dz/dx = ((c+2f+i) − (a+2d+g)) / (8·dx), and dz/dy = ((a+2b+c) − (g+2h+i)) / (8·dy).
- **Spacing:** computed per output row from the WGS 84 ellipsoid:
  - dx = Δλ·N(φ)·cosφ;
  - dy = Δφ·M(φ);
  - φ is the latitude of the row centre;
  - all three window rows use the centre row's dx.
- **Slope percent:** 100·hypot(dz/dx, dz/dy), computed in float64.

**Encoding** (the contract with the backend, `SLOPE_PERCENT_X100_FLOOR_U16`):
- each value is a uint16 equal to `min(65534, floor(slope_percent × 100))`;
- 65535 means no data;
- with these values, the half-open class boundaries [0,2) [2,10) [10,15) [15,30) [30,∞) become [0,200) [200,1000) [1000,1500) [1500,3000) [3000,65535).
- Values are floored, never rounded, so a slope of 1.99% is stored as 198 or 199 and can never cross into [2%, …).

**No data:** a cell is no data when any of its nine samples is missing. That happens only on the outer border of the mosaic and next to the two absent sea cells: 100,796 cells (0.028%). Nothing is extrapolated. No cell reached the clamp: the maximum is 31,449, i.e. 314%.

**Sea:** sea cells in the present tiles have elevation 0, so their slope is 0, the FLAT class. That is the DSM as published.

**Output:** `analysis/slope_pct_x100_<tile>.tif` for each of the 28 tiles: GeoTIFF uint16, EPSG:4326, 256 tiles, deflate with predictor 2; 317 MB in total. **Product checksum** (the sha256 of `analysis/SHA256SUMS`):

**`9a91d9af6153baf943713eceb33db22366dbe97fb5840774f0e54cd390992682`**

The loader recomputes it and stores it in `terrain_dataset.slope_sha256`.

**Determinism:** the full build takes 164 s; rebuilding a real tile (N24E055) gave the identical sha256 `3cdf14c7…`, and the synthetic test builds two runs and compares their bytes.

## 4. Visualization product: display only

- Hillshade on the same grid (azimuth 315°, altitude 45°, z-factor 1; grey 1–255, 0 means no data). It is warped bilinearly to Web Mercator at zoom 12, then pyramided to zoom 6 by averaging.
- Format: PNG grey plus alpha, 256 px, in one PMTiles v3 archive written with the python `pmtiles` 3.8.1 writer: `visualization/hillshade.pmtiles`.
- Size: 5,598 tiles, 128,653,915 bytes, sha256 `a033c248…f84f`. Building it took 95 s.
- It is meant for a MapLibre `raster` source. The PMTiles metadata says it is a display product.
- Contours: not produced.
- **The hillshade never feeds a business rule. Terrain classes come only from the slope analysis product.**

## 5. Loading into PostGIS: `ops/terrain/load-slope.sh`

The loader writes into the schema that migration V18 must create exactly:
- `terrain_dataset (id, code, version, surface_model DSM|DTM, slope_encoding, manifest jsonb, slope_sha256, loaded_at, unique(code, version))`;
- `terrain_slope (rid, dataset_id, rast)`, with a GiST index on `ST_ConvexHull(rast)`.

**A separate operation (owner, 4 Nov 2026).** V18 creates the schema only. Loading the slope data is an explicit operation after the migration, never part of it, and it can be removed and rebuilt without touching any Stationing business record.

**Target:** there is no default target. It must be a running container or a compose project whose `db` service is running. The owner-retained production project `tmrkz-mover` is refused (exit 2).

**Plan first:** the dry run prints:
- the target and its schema version (from `flyway_schema_history`);
- the files, bytes and product checksum;
- the expected row count;
- the expected cells, all and with a value;
- whether the schema is present, and whether the dataset is already loaded.

It then exits 3 without changing anything. It loads only when `CONFIRM_TARGET` equals the target.

**Verification:** `ops/terrain/slope_plan.py` checks every file against `SHA256SUMS`, checks the uint16 / 65535 / EPSG:4326 encoding, and checks that the product checksum is the one named in the manifest. It takes the expected cells from the manifest's per-file build counts (`pixels`, `nodata`), after checking each file's width × height against them; a file the manifest does not count is read. GLO-30 2026.11: 362,880,000 cells, of which 362,779,204 hold a value (100,796 nodata at the mosaic border and beside the two open-sea cells).

**The load:**
- `raster2pgsql` 3.5.7 runs from the local `postgis/postgis:17-3.5-alpine` image, offline, with the options `-a -e -k -Y -F -s 4326 -t 256x256 -N 65535`, writing into a temporary staging table.
- One `psql --single-transaction` run inserts the dataset row (with the full package manifest) and the tiles.
- In the same transaction, a `DO` block checks the row count, all cells (Σ width × height), the cells with a value (Σ `ST_Count(rast, 1, true)`), SRID 4326, one band, `16BUI` and nodata 65535; any mismatch raises and rolls the whole load back (exit 1, nothing kept).
- Empty tiles are kept, so the row count is deterministic.

**Restartable and idempotent:** the load is one transaction, so an interrupted or failed load leaves nothing and is simply run again. Loading the same `(code, version)` with the same product re-runs the checks on the loaded rows and changes nothing (exit 0); a damaged load fails them (exit 5: remove it and load again). A different product under an existing `(code, version)` is refused with exit 4.

**Provenance:** the dataset row stores the whole package manifest: source product and instance, every source tile with its sha256, processing version, the derived files with their sha256 and cell counts, the product checksum and the licence notices. Nothing references a dataset except its tiles; requests and audit keep the dataset code, version and product checksum as values.

**Removal: `ops/terrain/unload-slope.sh`.** Same target rules, dry run first (exit 3), `CONFIRM_TARGET` to act. One repeatable-read transaction deletes the dataset's tiles and its row, counts the Stationing business tables (policy versions, stationing, site links, outbox) and the audit log before and after, and rolls back if any count differs. It is refused (exit 4) while the policy version in force, or one scheduled after it, names the dataset, unless `ALLOW_POLICY_REFERENCE=1` for removing and reloading the same product.

**Measured on a disposable container** (`tmrkz-terrain-probe`, created and removed by this work, with the two tables created by the SQL above):

| Item | Result |
|---|---|
| Dry run | Plan printed, exit 3. Without arguments: usage, exit 2 |
| Load | **96 s**, 6,300 rows (28 files × 15 × 15 tiles) |
| Size | `terrain_slope`: 453 MB including TOAST; the whole database is 472 MB |
| Re-run | "same product already loaded", exit 0 |
| Different product under an existing version | **Not run.** The Docker engine became unreachable right after the re-run (see section 6) |

## 6. PostGIS checks

The Docker engine stopped answering right after the first load (see the continuation report, Docker incident). After the restart, `ops/terrain/verify-postgis.sh <disposable-container>` ran all three checks; the probe container was then removed:
1. The fixture's hex WKB loads with plain SQL; the default `ST_Clip` (PostGIS 3.5: `touched = false`) gives exactly the **pixel-centre** counts in section 7 (6,400 cells), and `touched = true` gives the all-touched 6,561.
2. The loader exits 4 for a different product under an existing (code, version).
3. Class shares for a fictional polygon of 2,754 cells on the full 2026.11 dataset: 167 ms.

**Load safeguards (4 Nov 2026, after the owner's next-gate decision).** These ran on a disposable PostGIS 17 / 3.5 container with the V18 schema and a two-tile subset of the real product: N24E052 and N24E055, giving 450 rows and 25,920,000 cells, 25,919,999 of them with a value. The container was removed afterwards. Log: `docs/evidence/terrain-load/loader-checks-2026-11-04.txt`.

| Step | Result |
|---|---|
| Plan | Rows and cells printed, exit 3 |
| `tmrkz-mover` as target (load and removal) | Refused, exit 2 |
| Manifest nodata off by 7 | Load fails its cell check, rolled back: 0 datasets, 0 tiles; exit 1 |
| Load | 450 rows, 25,920,000 cells, 25,919,999 with a value; 8 s |
| Same product again | Checks re-run, nothing changed, exit 0 |
| One tile deleted, same product again | "449 rows, expected 450", exit 5 |
| Removal while policy version 1 (in force) names the dataset | Refused, exit 4 |
| Removal with `ALLOW_POLICY_REFERENCE=1` | Dataset and tiles gone; policy versions, outbox and audit counts 1/1/1 before and after |
| Reload (rebuild) | Same product checksum, all checks pass |
| Removal of a version that is not loaded | Nothing to do, exit 0 |

The full 2026.11 product was not reloaded with the new cell check; its expected counts come from the build report.

## 7. Backend fixture: `backend/src/test/resources/terrain/`

`ops/terrain/make_fixture.py` writes the fixture: 143 KB in total, real data, the same encoding.

**Files:**
- `slope-fixture-N24E055.tif`: a 160×160 clip of N24E055 (rows 3200–3359, columns 2780–2939; Jebel Hafeet foothills), bbox 55.772083–55.816528 E, 24.066806–24.111250 N. sha256 `414844af…4324`.
- `slope-fixture.hexwkb`: the same data as PostGIS raster WKB in hex, nine 64×64 tiles, one per line. A test loads each line with `insert into terrain_slope (dataset_id, rast) values (?, ?::raster)`. sha256 `097eb042…be0e`.
- `slope-fixture.json`: the bbox, checksums, attribution, test polygon and expected counts.

**Test rectangle** (lon/lat): W 55.7750694444, E 55.7972916667, S 24.0860416667, N 24.1082638889. Its edges lie a quarter pixel from the cell centres, so the two inclusion rules give different counts. Expected cells per FAO default class:

| Rule | FLAT [0,2) | UNDULATING [2,10) | ROLLING [10,15) | HILLY [15,30) | MOUNTAINOUS [30,∞) | Total |
|---|---|---|---|---|---|---|
| **Pixel centre** (ST_Clip default) | **2737** | **2261** | **177** | **484** | **741** | **6400** |
| All touched | 2790 | 2297 | 190 | 505 | 779 | 6561 |

With this rectangle FLAT governs, at 42.8%.

## 8. Tests

`python -m pytest ops/terrain -q`: **13/13 pass**. They cover:
- exact planes of 0%, 2%, 10% and 45%;
- a slope just below 2%, which stays below the threshold;
- the east-west and diagonal gradients;
- the clamp at 65534 and nodata only in the affected window;
- dx and dy against an independent pyproj geodesic, within 1 mm at 0°, 22.5°, 24° and 26.9°;
- hillshade shading;
- tile borders using the real neighbours, with the mosaic edge as nodata;
- byte-identical outputs over two runs (slope tiles, SHA256SUMS, PMTiles);
- the load plan's cell counts, read from the files and from manifest build counts alike, and its refusal of a manifest whose cell count disagrees with a file.

Pinned versions are in `ops/terrain/requirements.txt`.

## 9. Licence and attribution

**Approved by the owner on 4 Nov 2026** as the current terrain source, subject to the current Copernicus attribution obligations. FGIC data is not used.

**Licence checked on 4 Nov 2026** against the official document:
- Title: *Licence for Copernicus DEM instance COP-DEM-GLO-30-F Global 30m Full, Free & Open — Licence for the use of the Copernicus WorldDEM-30*.
- Source: `https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/DEM/resources/license/License-COPDEM-30.pdf`.
- sha256 `9cd37d37…51bd`, dated 29 Oct 2020.
- Article 4 grants reproduction, distribution, communication to the public and adaptation. Article 5 makes it free.

Article 6 sets the notices. They are recorded word for word in `manifest.json` (`licence`) and `LICENSE-NOTICE.txt`:

| Use | Notice |
|---|---|
| Raw source tiles, distributed unmodified (6(a)) | "© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved." |
| Derived products: slope analysis, classification results, hillshade, and the map attribution (6(b)) | "produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved" |
| Every licence or notice covering distribution, modified or not (6(c)) | "The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30" |
| No endorsement (6(d)) | Nothing may suggest the Copernicus programme, the licensor or Airbus endorses this system |

The MapLibre terrain mode now shows the 6(b) notice word for word as its attribution (`TERRAIN_ATTRIBUTION`); the DSM limitation stays in the mode notice.

**Recorded per dataset** in `manifest.json`, and also stored in `terrain_dataset.manifest`:
- the product and instance (`COP-DEM-GLO-30-F`);
- the 28 source tile ids with their original sha256;
- the processing version (`tmrkz-terrain-1.0.0`);
- the derived files with their sha256 and cell counts;
- the product checksum (`9a91d9af…2682`);
- the attribution texts, and the licence reference and date.

It states that GLO-30 is a **DSM, not a bare-earth DTM**, and not official UAE terrain.
