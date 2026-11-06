# Release record: offline map package `tmrkz-map-2026.11.2`

> **DEVELOPMENT CANDIDATE — NOT THE RELEASE ARTEFACT (owner, 6 Nov 2026).**
> - **Source:** this build came from uncommitted source (`sourceTreeClean: false`).
> - **Use so far:** it is installed only in the development root `map-data/runtime-3d`. The accepted package
>   `tmrkz-map-2026.11.1` stays immutable and stays installed on the owner's environment.
> - **Release:** after the owner's visual acceptance and the commit, `2026.11.2` is rebuilt from the committed source.
>   That rebuild replaces the checksums below and must prove: deterministic rebuild, archive checksum, manifest,
>   GLO-30 provenance, the 3D component's checksum, unchanged business slope data, verify, install, rollback and
>   readiness.

This directory is the git record of the offline map package `tmrkz-map-2026.11.2` (format
`tmrkz-offline-map-package` v1, ADR-036, `ops/map-package/README.md`). The data itself (43 files, 792,440,943 bytes) is
never committed.

| File | Content |
|---|---|
| `tmrkz-map-2026.11.2.manifest.json` | the package's own `manifest.json`, byte for byte (sha256 `c2d7ab626576587dd161477c8b51749ba26d1a3835d31cfc9f1e9a2a8a4762a4`) |
| `SHA256SUMS` | every file's sha256; its own sha256 is the package's `contentSha256` `c4c0efaf2b151328e5336015ec525a2b5afe1c0353f52351e1d8a8202023b922` |
| `ARCHIVE.sha256` | the deterministic archive `tmrkz-map-2026.11.2.tar` (792,514,560 bytes): `1f8509a670181f123120d3e974cf6713fe1387159bb19c30e595b53aa6e96700` |

## What changed from 2026.11.1

The package adds the optional component **`terrain-3d`** (role MAP_VISUALIZATION, not required). It is the 3D visual
terrain for MapLibre terrain (`raster-dem`, `setTerrain`) and displayed elevations. It is display only: it never feeds
a business rule and is never loaded into PostGIS. The business terrain, `terrain-analysis` (slope product
`9a91d9af…`), is unchanged and kept separate.

The component holds exactly two files under `terrain/glo30/visualization-3d/`:

| File | Bytes | sha256 |
|---|---|---|
| `terrain-rgb.pmtiles` | 208,669,916 | `c31bf31acfa2661b9f8c3cce15618a88afe52df223695278a29161ae581df8a7` |
| `terrain-3d-manifest.json` | 11,477 | `87bfcf2e883cc3c321b30ba0b76d3ce8f4ad01707c9f963a744815a64f0c1255` |

- **`terrain-rgb.pmtiles`:** PMTiles v3, PNG RGB 256 px, Mapbox Terrain-RGB
  (`height = -10000 + (R*65536 + G*256 + B) * 0.1`).
  - Zoom 6–12, 5,932 tiles.
  - Bounds [50.9998611, 22.0001389, 56.9998611, 27.0001389].
  - Heights −16.2 … 2,629.1 m (EGM2008, DSM).
  - Built by `ops/terrain/build_terrain_3d.py` (`tmrkz-terrain-3d-1.0.0`) from the same 28 GLO-30 source tiles as the
    slope analysis.
- **`terrain-3d-manifest.json`:** the product record `map-packages/terrain-3d-glo30-2026.11/manifest.json`, with line
  endings as git stores it (LF; git blob `1e5e22c3…`).

Everything else is the same as in 2026.11.1. 39 of the 41 files are byte-identical. Two differ:
- **`styles/stationing-v3.json`:** the style now has the source `terrain3d`
  (`pmtiles:///map-data/terrain/glo30/visualization-3d/terrain-rgb.pmtiles`, raster-dem, mapbox, 256, Copernicus
  Article 6(b) attribution). It also has two hidden layers, `terrain3d-relief` and `terrain3d-shade`: 21 layers instead
  of 19, `styleSha256` `e2efffe7…`. Built with `--no-terrain-3d`, the same frontend source gives 2026.11.1's style
  byte for byte (`3c6247a1…`).
- **`ATTRIBUTION.txt`:** the package id; the 3D terrain is listed among the Article 6(b) derived products and described
  as display only.

The manifest also changes:
- `attribution.required` gains a `terrain-3d` entry with the Copernicus Article 6(b) text;
- `builtBy.toolVersion` is `1.1.0`.

## Where the package lives

- **The build output:** `map-data/packages/` (git-ignored), beside 2026.11.1, which is kept.
- **The development map root:** `map-data/runtime-3d/current`, installed on 2026-11-06 from the archive with
  `--expect-sha256`.

It is not installed in the acceptance root `map-data/runtime`.

## How it was built

```sh
SOURCE_DATE_EPOCH=1793923200 python ops/map-package/build_package.py --archive     # createdAt 2026-11-06T00:00:00Z
```

**Build state:**
- The build ran at revision `79e3ec9`.
- `builtBy.sourceTreeClean` is **false**. The working tree held uncommitted work:
  - the 3D builder, its record and this tooling;
  - the frontend style changes;
  - other changes outside the map tools.

  A release build should be repeated from a commit.
- A second build with `--replace` gave the same archive sha256 and the same manifest bytes.

## Verification (2026-11-06)

`python ops/map-package/package_format.py map-data/runtime-3d/current`:

```
  [PASS] package present: map-data\runtime-3d\current
  [PASS] manifest structure: 43 files, 792440943 bytes
  [PASS] layout complete and exact: 45 files, none unexpected
  [PASS] file sizes: every size as listed
  [PASS] SHA256SUMS matches the manifest: contentSha256 c4c0efaf2b151328e5336015ec525a2b5afe1c0353f52351e1d8a8202023b922
  [PASS] checksums: all 43 files
  [PASS] basemap readable: PMTiles v3 mvt z0-15, bounds [51.1303709, 22.451649, 56.689453, 26.332807], Protomaps 4.14.9, 263479 tiles, sample tiles z0 66803 B and z12 248 B
  [PASS] required fonts present: Noto Sans Arabic Regular for ['Noto Sans Arabic Regular']
  [PASS] style local and consistent: 21 layers, 4 URLs, all under /map-data/, 3D terrain source 'terrain3d'
  [PASS] terrain dataset consistent: copernicus-glo30 2026.11 (DSM, tmrkz-terrain-1.0.0), 28 slope files, product 9a91d9af6153…, 28 source tiles listed
  [PASS] geographic coverage: required [51.5, 22.6, 56.4, 26.1] inside the basemap [51.1303709, 22.451649, 56.689453, 26.332807]; terrain grid N22-N26 × E051-E056: 28 present, 2 open sea (N25E053, N26E052); hillshade z12: 4003 tiles over present cells, 0 missing
  [PASS] attribution and licences: ATTRIBUTION.txt and 3 licence notices
  [PASS] 3d terrain consistent: copernicus-glo30-3d 2026.11 PMTiles png z6-12, 5932 tiles, bounds [50.9998611, 22.0001389, 56.9998611, 27.0001389]; z12: 4278 tiles inside the bounds, none missing; samples 12/2661/1762 (coverage centre) 256x256 RGB 0.0..0.0 m, z12 id 19360715 (largest) 256x256 RGB 738.1..1505.0 m, within -16.2..2629.1 m; mapbox 256 px; record product c31bf31acfa2…, 28 source tiles as terrain-provenance
[map-package] VALID
```

`python ops/map-package/readiness.py --root map-data/runtime-3d --require-terrain-3d --expect-package tmrkz-map-2026.11.2`
gave the same package answers as PASS, plus:

```
  [PASS] expected package: tmrkz-map-2026.11.2 (expected tmrkz-map-2026.11.2)
  [PASS] 3d terrain present: component terrain-3d (terrain/glo30/visualization-3d/terrain-rgb.pmtiles) present
  [NOT CHECKED] terrain dataset loaded: no --db-container given
  [NOT CHECKED] terrain version expected: no --db-container given
  [NOT CHECKED] served package is the installed one: no --url given
[readiness] INCOMPLETE: not checked: terrain dataset loaded, terrain version expected, served package is the installed one
```

**Not yet verified:**
- No database or web entry point was checked against this package.
- The browser's 3D view was not tested with it.

The archive itself also verifies in full (`package_format.py tmrkz-map-2026.11.2.tar`: VALID; PMTiles content is
checked after installation).

## To check a copy against this record

```sh
sha256sum -c ARCHIVE.sha256                                             # beside the archive
python ops/map-package/package_format.py tmrkz-map-2026.11.2.tar        # full verification
cmp tmrkz-map-2026.11.2.manifest.json <(tar -xOf tmrkz-map-2026.11.2.tar tmrkz-map-2026.11.2/manifest.json)
```

An installer older than this record's tools refuses the package, because it does not know the component `terrain-3d`.
Install it with `ops/map-package/install_package.py` of the same revision. Packages without the component, such as
2026.11.1, verify unchanged with the new tools.

The manifest copy is deliberately not named `manifest.json`. The backend's built-in map-package scan
(`MapPackageService.installBuiltin`) reads `map-packages/*/manifest.json` and would look for the 43 data files here.

The 776 MB of GLO-30 source tiles are listed with their checksums but are not included (an optional archival
component).
