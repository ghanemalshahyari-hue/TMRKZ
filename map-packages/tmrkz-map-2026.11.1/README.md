# Release record: offline map package `tmrkz-map-2026.11.1`

This directory is the git record of the production offline map package (format `tmrkz-offline-map-package` v1,
ADR-036, `ops/map-package/README.md`). The data itself (41 files, 583,757,776 bytes) is never committed.

| File | Content |
|---|---|
| `tmrkz-map-2026.11.1.manifest.json` | the package's own `manifest.json`, byte for byte (sha256 `4329a7556444f282d911c9e5a4ba4f7d9550804155b98d8706b02121a6b50bca`) |
| `SHA256SUMS` | every file's sha256; its own sha256 is the package's `contentSha256` `e836825bcb5e08ba4bf31ee5cfe619d55f1d52f83f9224efe224d1ad9b539515` |
| `ARCHIVE.sha256` | the deterministic archive `tmrkz-map-2026.11.1.tar` (583,823,360 bytes): `8233ac8b9416f59a915454a9cd7b1745a31701aae661ceba5523fbd466d2b6f5` |

**Where the package lives:**
- the build output `map-data/packages/` (git-ignored);
- the acceptance map root `map-data/runtime/current`.

**How it was built:** `SOURCE_DATE_EPOCH=1793832114 python ops/map-package/build_package.py --archive`, at revision
`8400e58` with a clean map-tool tree. Rebuilding the terrain products from the 28 GLO-30 source tiles gives the same
archive byte for byte (`docs/evidence/map-package/reproducibility.txt`).

To check a copy against this record:

```sh
sha256sum -c ARCHIVE.sha256                                             # beside the archive
python ops/map-package/package_format.py tmrkz-map-2026.11.1.tar        # full verification
cmp tmrkz-map-2026.11.1.manifest.json <(tar -xOf tmrkz-map-2026.11.1.tar tmrkz-map-2026.11.1/manifest.json)
```

**Contents:**
- the UAE street basemap: Protomaps Basemap 4.14.9 from OpenStreetMap, replication 2026-06-25;
- the Noto Sans Arabic map font;
- the Stationing V3 style;
- the Copernicus GLO-30 slope analysis (product `9a91d9af…`) and hillshade (`a033c248…`), with their provenance;
- the ODbL, Copernicus Article 6 and OFL notices.

The manifest copy is deliberately not named `manifest.json`: the backend's built-in map-package scan
(`MapPackageService.installBuiltin`) reads `map-packages/*/manifest.json` and would look for the 41 data files here.

The 776 MB of GLO-30 source tiles are listed with their checksums but are not included (an optional archival
component).
