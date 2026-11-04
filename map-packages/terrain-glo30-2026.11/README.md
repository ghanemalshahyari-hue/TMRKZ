# Terrain package: Copernicus GLO-30 (DSM), version 2026.11

On 4 Nov 2026 the owner approved this package as the fallback production terrain source for Stationing V3 (owner decision 3).

**Limitation:** Copernicus GLO-30 is a Digital Surface Model (DSM), not a bare-earth terrain model (DTM). Its values can include buildings, infrastructure and vegetation. It is not official UAE bare-earth terrain. FGIC data is not used.

The large files are kept out of git, under `map-data/terrain/glo30/` (listed in `.gitignore`). This directory holds only:
- `manifest.json`: provenance, licence, every source tile with its sha256, the processing parameters and the derived checksums;
- `LICENSE-NOTICE.txt`: the licence's Article 6 notices, word for word (checked against the official licence on
  4 Nov 2026): 6(a) for the unmodified source tiles, 6(b) "produced using Copernicus WorldDEM-30 …" for the derived
  slope and hillshade, the 6(c) no-liability sentence and the 6(d) no-endorsement rule.

| Product | Use | Files |
|---|---|---|
| Analysis | The **only** business input: slope in percent, which the backend classifies at query time using the administrator's versioned `terrain_slope_classification` policy | `analysis/slope_pct_x100_<tile>.tif` (uint16 = min(65534, floor(slope % × 100)), nodata 65535), plus `SHA256SUMS` |
| Visualization | **Display only**, never an input to a rule | `visualization/hillshade.pmtiles` (PNG grey + alpha, zoom levels 6–12) |

## Rebuild

To rebuild offline from the verified MOVER copy, run:

```sh
python ops/terrain/package_source.py --from "<MOVER>/map-source/uae/dem/cop30" --provenance "<MOVER>/map-library/sources/provenance.json"
python ops/terrain/check_absent_tiles.py --srtm "<MOVER>/map-source/uae/dem/srtm"
python ops/terrain/build_terrain.py              # about 3 minutes; deterministic
python ops/terrain/make_fixture.py               # backend test fixture
```

## Load into PostGIS

The load needs migration V18. Run it without `CONFIRM_TARGET` first to print the plan only; it changes nothing:

```sh
sh ops/terrain/load-slope.sh <db-container|compose-project> 2026.11
```

When the plan is right, run it again with the same target in `CONFIRM_TARGET` to load:

```sh
CONFIRM_TARGET=<same> sh ops/terrain/load-slope.sh <db-container|compose-project> 2026.11
```

The load is a separate operation after the migration and one transaction. It checks the rows, all cells and the cells
with a value against this manifest before it commits, so a failed or interrupted load leaves nothing. Running it again
for the same product re-checks the loaded data and changes nothing.

To remove the dataset, for a rebuild or a replacement, use the same plan-then-confirm form. Business records are never
touched:

```sh
CONFIRM_TARGET=<same> sh ops/terrain/unload-slope.sh <db-container|compose-project> 2026.11
```

Details and measurements: `docs/audit/stationing-v3-production/TERRAIN_PIPELINE.md`.
