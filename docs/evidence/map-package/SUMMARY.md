# Stationing V3 production map package — acceptance on `tmrkz-test` (4–5 Nov 2026)

**Owner gate:** «PRODUCTION MAP PACKAGING PHASE — GO». **Decision record:** ADR-036. **Tools:** `ops/map-package/`.

**Result:** the production-form offline map package `tmrkz-map-2026.11.1` is built, verified, reproducible and
installed. `tmrkz-test` runs from it:
- readiness READY 20/20;
- the real page 27/27, with 0 external requests and 0 console errors;
- terrain business parity with 0 differences;
- schema still V20, Stationing data unchanged.

## Commits (local; not pushed)

| Commit | Concern |
|---|---|
| `c6d63ad` MAP-2 | one label per logical site, a MultiPolygon included (`labelPoint`, `requestFeatures`) |
| `8400e58` MAP-1 | package format, build, verify, install/recover, readiness, nginx serving, compose mount, air-gap bundle, package paths in the application, ADR-036 |
| `bc6279d` MAP-1 fix | readiness: psql quiet (its `SET` echo spoiled the database comparison; found by the first readiness run) |
| `a950d7a` MAP-1 fix | readiness: a missing file is reported as «required files present» |
| MAP-EVIDENCE | this evidence, the release record, STATUS, TRACEABILITY, ADR-036 status, LICENSES, test scripts |

## Package contents (`map-packages/tmrkz-map-2026.11.1/` holds the record; the data stays in git-ignored `map-data/`)

| Component | Role | Files | Bytes | Source / version | sha256 |
|---|---|---|---|---|---|
| `basemap` | MAP_VISUALIZATION | `basemap/uae.pmtiles` | 123,069,269 | Protomaps Basemap 4.14.9 (planetiler 0.10.2, OSM replication 2026-06-25T04:00Z, Natural Earth); copy of MOVER's | `17de2d52…3028f` |
| `fonts` | MAP_VISUALIZATION | `fonts/NotoSansArabic.ttf` | 192,144 | Noto Sans Arabic Regular («Noto Sans Arabic Regular» for MapLibre) | `146b2193…1868d` |
| `style` | MAP_VISUALIZATION | `styles/stationing-v3.json` | 14,024 | exported from `offlineStyle.ts`, 19 layers, URLs only under `/map-data/` | `3c6247a1…c8cc` (`compatibility.styleSha256`) |
| `terrain-analysis` | BUSINESS_ANALYSIS | 28 `slope_pct_x100_*.tif` + `SHA256SUMS` | 331,762,245 | GLO-30 slope, `tmrkz-terrain-1.0.0`, uint16 %×100 | product `9a91d9af…92682` |
| `terrain-visualization` | MAP_VISUALIZATION | `hillshade.pmtiles` | 128,653,915 | PNG z6–12, 5,598 tiles, display only | `a033c248…e84f` |
| `terrain-provenance` | PROVENANCE | terrain manifest, build report (no timings), absent-tile evidence, source verification | — | 28 source tiles listed with sha256 and retrieval time; N25E053 and N26E052 open sea | — |
| `licences` | LEGAL | `ATTRIBUTION.txt`, ODbL notice, Copernicus Article 6 notice, OFL 1.1 | — | — | — |

**Totals:** 41 files, 583,757,776 bytes, contentSha256 `e836825bcb5e08ba4bf31ee5cfe619d55f1d52f83f9224efe224d1ad9b539515`.

**Archive:** `tmrkz-map-2026.11.1.tar`, 583,823,360 bytes, sha256
`8233ac8b9416f59a915454a9cd7b1745a31701aae661ceba5523fbd466d2b6f5`. The manifest's sha256 is `4329a755…0bca`.

**Not included: the 776 MB of GLO-30 source tiles.** They are an optional archival component (`--with-source`), not
needed at run time. Every package lists them with their checksums; the verified copies stay in `map-data/terrain/glo30/source`.

**Licence and attribution:**
- **OpenStreetMap:** ODbL 1.0. The road names are presented as unofficial labels («أسماء الطرق من OpenStreetMap
  وليست أسماء رسمية»), and no official road-name layer is included.
- **Copernicus:**
  - the licence document is identified with its sha256 (`9cd37d37…51bd`, checked 2026-11-04);
  - Article 6(b) applies to the derived products and the map attribution;
  - Article 6(c) no-liability and 6(d) no-endorsement notices are included;
  - Article 6(a) applies to the source tiles, when included;
  - GLO-30 is identified as a DSM, not UAE bare-earth terrain, with no FGIC data.
- **Font:** SIL OFL 1.1.

## Build, reproducibility and install

- **Inputs checked before packaging** (`release-build.txt`):
  - the basemap and the font against `ops/map-package/sources.json`;
  - the 28 source tiles (813,077,322 bytes), the 28 slope files and the hillshade against the terrain manifest.
  - **Nothing was downloaded.**
- **Verification:** the package directory and the archive both pass all 12 checks:
  - layout, sizes, SHA256SUMS, checksums;
  - basemap readable, fonts, style local, terrain consistent;
  - coverage (hillshade z12: 4,003 tiles over the 28 land cells, 0 missing), attribution.
- **Reproducibility (`reproducibility.txt`):**
  - The terrain products were rebuilt from the source tiles in 165.9 s: slope product, 28 files and hillshade
    byte-identical; only the build report's run timings differ.
  - Package A (original products) and B (rebuilt products) have the same contentSha256.
  - B2 (rebuilt products, same revision and clean tree) has the identical manifest and the identical archive
    `8233ac8b…`.
  - Only manifest metadata can differ between builds: `createdAt` without `SOURCE_DATE_EPOCH`, `sourceRevision`,
    `sourceTreeClean`.
- **Install on `tmrkz-test`** (`docs/evidence/acceptance-upgrade/tmrkz-test-map-package-8400e58/`):
  - plan (exit 3), then `--confirm` from the archive with `--expect-sha256`;
  - archive verified (12/12), staged copy verified again (12/12), then swapped into `map-data/runtime/current`.

## Recovery (`recovery/`)

| Step | Result |
|---|---|
| R1 corrupted archive (one byte flipped), expected sha256 given | refused: archive sha256 `15c9d5ff…` ≠ `8233ac8b…` |
| R2 same archive, no expected sha256 | refused by the package's own checksums (`slope_pct_x100_N23E054.tif`) |
| R3 after both | active package unchanged and valid in full; nothing staged left behind |
| R4 second package (`tmrkz-map-2026.11.1-rehearsal`) installed while nginx served the first | swap worked live on Windows/Docker Desktop; the page served the new manifest at once; the release kept whole in `previous/` |
| R5 `restore-previous` (plan, then confirm) | release active again, both slots valid in full; history log has install, install, restore-previous |
| R6 | the rehearsal (a test artefact) removed from `previous/` by hand; readiness READY 20/20 |

## Serving and readiness

**Web entry point:** `mover/web:rel-8400e58-v3` (`sha256:ef1ef2fd…`), built from `git archive` of `8400e58`.
- **Mount:** `map-data/runtime` → `/srv/tmrkz-map`, read-only.
- **Before:** the raw working folder was mounted. There was no manifest, and the slope analysis was downloadable (200).
- **After:** the manifest is served (200), basemap ranges answer 206, and the analysis returns 404.

**Readiness** (`readiness.py --root map-data/runtime --url … --db-container … --expect-package …`): READY, 20 checks.
- package present, manifest valid, required files present, checksums (41 files);
- basemap readable, fonts, style local, terrain dataset;
- coverage, attribution, expected package;
- the terrain dataset loaded with the same product, and policy v1 naming copernicus-glo30 2026.11;
- the served manifest identical to the installed one, basemap and hillshade served with ranges, the font served;
- the analysis not served.

**Negative cases** (`readiness-negative.txt`):

| Case | Result |
|---|---|
| A required font deleted | NOT READY (exit 1) |
| The database and web sections not asked for | INCOMPLETE (exit 2) |
| An empty root | NOT READY (exit 1) |

## Terrain business parity (`terrain-parity/PARITY.md`, `results.json`)

**How:** a disposable PostGIS was loaded from the installed package by the production loader
(`ops/terrain/load-slope.sh`; 112 s; 6,300 rows; 362,880,000 cells, 362,779,204 with a value). It was compared with
the `tmrkz-test` dataset that every accepted request used, then removed.

**Results:**
- **Dataset:** identical code, version, DSM, encoding, slope product, manifest and cell count. The raster fingerprint
  over all 6,300 tiles is `a9f676e6…` in both.
- **54 submitted legs** (24 requests, 39 distinct geometries; FLAT, UNDULATING, MOUNTAINOUS):
  - what the server stored at submission equals the acceptance recomputation;
  - that equals the package recomputation;
  - the comparison covers cell shares, controlling class, tie, allowance and effective range.
- **8 draft deployment areas:** acceptance and package identical.
- **2 constructed ties** (no accepted request has one), identical in both databases:
  - HILLY/MOUNTAINOUS resolves by priority to MOUNTAINOUS (+2,000 m);
  - FLAT/UNDULATING resolves to UNDULATING (+500 m).
- **The loader on `tmrkz-test`, pointed at the installed package:** «same product already loaded and checked; nothing
  to do».
- **Terrain classes and thresholds:** unchanged. FLAT <2 %, UNDULATING 2–10 %, ROLLING 10–15 %, HILLY 15–30 %,
  MOUNTAINOUS ≥30 %, from policy v1.

## Real page (`browser/`, `tests/acceptance/map-package.mjs`, final run 27/27)

**Setup:**
- headless Edge against `http://localhost:8088`;
- the external network unavailable to the browser (all names resolve to nothing but the loopback, all other traffic
  to a dead proxy); the probe shows OpenStreetMap, 1.1.1.1 and unpkg all blocked.

| Area | Result |
|---|---|
| Package only | basemap, hillshade and font under `/map-data/`; no glyph or sprite server; every map file answered (206 for ranges, 200 for the font) |
| Street mode | at Dubai z14: highways, major and minor roads, water and buildings drawn; at z8 only the major network (minor roads from z13) |
| Labels | 127 Arabic road and place labels; route shields; English fallback («Al Asayel Street», «Red Line Metro»); mixed («12a شارع»); site labels with brackets and Latin/digits; ODbL attribution and the unofficial-names notice |
| One label per MultiPolygon | RS-2026-0048 (activated two-part site, current and proposed) at z14–z17: every name drawn at most once, one label point per site; RS-2026-0049 (current site `ACC-GEO-MP4`, 4 parts) at z17: one name |
| Terrain mode | the hillshade group shown and the street group hidden; UAE z7, east z8, Hajar z11 and Liwa z10 read from the packaged hillshade (43 range requests, all 206); DSM notice and Copernicus 6(b) attribution |
| State | street → terrain → street on RS-2026-0043 (two-part site, both areas, both deployment bands): the request, unit/site facts, overlay layers and data, and the camera all unchanged |

**Glyph shaping and order (`labels/`, the existing label suite on the harness, which now serves the installed
package):** 21/21:
- Arabic, English, mixed, route numbers;
- brackets, Arabic comma, guillemets «», question mark;
- Arabic-Indic and Western numerals;
- the map-only bracket fix;
- 328 distinct labels covered by the packaged font;
- 0 external requests.

G-8c, the upstream double mirror without the fix, is reproduced only in its control.

## Performance (real page; long-task instrument verified first: a 120 ms page task is recorded as 120 ms)

| Measurement | Result | Long tasks > 50 ms |
|---|---|---|
| Initial map load: full page load of a request until the map is idle | 950 ms (runs: 508–950 ms) | 2–3 during the page load (51–117 ms: application start and map creation) |
| Opening a request from the list | 265 ms | 0 |
| Street → terrain / terrain → street, until idle | 375 ms / 83 ms | 0 / 0 |
| Zoom sweep z10→z16→z11, 10 steps idle each (label placement included) | 6,852 ms | 0 |
| 8 pans of 180 × 90 px, idle each | 3,573 ms | 0 |
| Deployment bands at z10 | 838 ms | 0 |
| Grouped drag of a two-part site in the editor (30 moves, not saved) | 723 ms | 0 (accepted geometry phase: 708–720 ms, 0) |

The geometry editing performance accepted in the previous phase has not regressed.

## Not changed

- Schema V20, policy v1, terrain dataset;
- organisations, responsibilities, sites, geometry versions;
- the Stationing fingerprints across the swap (`state-swap-compare.txt`: only the web mount and what it serves changed);
- the backend image (`rel-58423ce`), MapLibre 6.15.0, no right-to-left plugin;
- `tmrkz-mover` and MOVER UAT, not touched.

**During the acceptance runs (`state-acceptance-compare.txt`):**
- one draft, RS-2026-0056 «اختبار الواجهة الجديدة — لقطات C/D/E (بيانات قبول وهمية)، مسودة لا تُرسل», was created by
  the parallel UI-rebuild work;
- its edits and the sign-ins are in the audit;
- this gate's checks saved nothing.

## Test-only corrections during this gate (no product change)

- **`map-package.mjs` run 1** (`browser-run1.log`, 24/26). After an in-app jump to a second request, the script read
  the previous page's map and summary before the application re-rendered: state checks on the wrong request, opening
  time 18 ms. Every request is now opened on a fresh document, and the script waits for that request's number. The
  opening time is measured as a click in the list.
- **Same run.** The bands view was centred on the previous camera, and the editor's site was looked up in the wrong
  source. Both are now located from the request's own features (`rs`, `rs-edit-fill`). A rigid drag keeps the area
  readout, so movement is now judged by the site's screen position.
- **Run 2** (`browser-run2.log`, 25/26). The z16 label check was centred on the whole request, whose deployment areas
  lie kilometres away. The label checks are now centred on the site.
- **`maplibre-labels.mjs`.** It accepts `LABELS_OUT`, so this run's evidence is kept apart from the accepted label
  evidence.

## Unresolved production-map items

1. **Terrain loader dependencies.** `ops/terrain/load-slope.sh` needs Python with `rasterio` (`slope_plan.py`). The
   installer and readiness use the standard library only. An isolated production host needs `rasterio` from the
   offline bundle, or the load run from a build host against the target database.
2. **Open-sea cells in terrain mode.** The two open-sea cells (N25E053, N26E052) have no GLO-30 tiles and show the
   water colour, while the rest of the sea shows flat hillshade grey. It is cosmetic and not new; the derived products
   were not altered here.
3. **Initial page load.** It has 2–3 long tasks (application start and map creation); interaction has none.
4. **Assessment metadata.** `TerrainClassifier` reads `manifest ->> 'processingVersion'`, which the terrain manifest
   records as `processing.version`, so each assessment's `processing` field is empty. This is business audit
   metadata, outside this gate; it is reported, not changed.
5. **Not a production release.** Real touch, D11 reminders, real non-production Oracle and the final
   production-readiness audit remain. Stationing V3 is not production-ready.
