# Release record: offline map package `tmrkz-map-2026.11.2`

**Status (owner decision of 7 Nov 2026):** the official candidate, built from committed source (`81144726c3aec4968186a1195a5dd98ad0db0696`, `sourceTreeClean: true`) on the current host. The earlier Windows build is not used. Installed on the one application on :8088. Owner visual review is pending.

This directory is the git record of the package (format `tmrkz-offline-map-package` v1, ADR-036, `ops/map-package/README.md`). The data itself (43 files, 793,768,171 bytes) is never committed.

| File | Content |
|---|---|
| `tmrkz-map-2026.11.2.manifest.json` | the package's own `manifest.json`, byte for byte (sha256 `d87be47eb7b7a8b24e12cc1230b84e3d5368ba7a8d1af242cb4f59bdaaf66411`) |
| `SHA256SUMS` | every file's sha256; its own sha256 is the package's `contentSha256` `5fde671fa8bc555bc273838642399058ea74fc024f2d805f6063d240e9febe97` |
| `ARCHIVE.sha256` | the deterministic archive `tmrkz-map-2026.11.2.tar` (793,835,520 bytes): `21e1558c54719646c4cdb9d219fb43f16597d5a602a4458ca60202879a423fc9` |

## How it was proven

- **Inputs:** the basemap, the font and the 28 GLO-30 source tiles match their recorded checksums; the builder refuses otherwise.
- **Terrain products:** built twice with `ops/map-package/build-terrain-clean.sh`, each from a fresh clone with its own copy of the sources. Every product file is byte-identical; only `build-report-3d.json` differs, by its run time, and it is not packaged.
- **Package:** built twice with `ops/map-package/build-package-clean.sh`, each from a fresh clone and its own terrain build. 47 files compared with `compare-builds.py`, none differ, and the archives have the same sha256.
- **Install:** verified as untrusted, installed with the staged swap, restored to the previous package, installed again. `readiness.py --require-terrain-3d` gives READY, 23 checks, each time on `tmrkz-map-2026.11.2`.
- **Previous package:** `tmrkz-map-2026.11.0`, the same build without `terrain-3d`, made so that a real package can be restored. It is not the accepted `2026.11.1`.

## The business terrain

The slope product is `8905e73c…`, the dataset already loaded in PostGIS, which was not reloaded. It differs in bytes from `9a91d9af…`, the Windows build accepted in `2026.11.1`. For all 28 cells the pixel and nodata counts are equal, and one cell built on linux/amd64 gave the same bytes as linux/arm64. **Pixel-by-pixel equality with the Windows build cannot be shown, because that build is not available here.** `map-packages/terrain-glo30-2026.11/manifest.json` keeps the earlier checksums under `buildRecord.earlierBuild`.

## The 3D visual terrain

Component `terrain-3d` (role MAP_VISUALIZATION, not required) is display only: it never feeds a business rule and is never loaded into PostGIS.

| File | Bytes | sha256 |
|---|---|---|
| `terrain-rgb.pmtiles` | 208,737,275 | `f9f4c38780b7c92d1989f79b2247874bb472a16f6a8ebe649a55a1322835241c` |
| `terrain-3d-manifest.json` | 11,477 | `039e63195b171eed3b3c6ca12e6d42d07502b6cf6324cc8ff8e6228f64cd9636` |
