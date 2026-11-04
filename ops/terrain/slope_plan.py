#!/usr/bin/env python3
"""Verifies the slope analysis product before a load and prints the load plan as shell assignments:
SLOPE_SHA256 (sha256 of SHA256SUMS), FILES, BYTES, TILES (expected PostGIS rows for the tile size, empty tiles kept),
CELLS (all cells) and VALID (cells with a value), which the loader checks in PostGIS before it commits. The cell counts
come from the manifest's per-file build counts, checked against each file's size; a file the manifest does not count is
read. Exits 1 when a file is missing, changed, or the manifest names a different product checksum or cell count.

  python ops/terrain/slope_plan.py map-data/terrain/glo30/analysis map-packages/terrain-glo30-2026.11/manifest.json 256
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import rasterio

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_terrain import SLOPE_ENCODING, SLOPE_NODATA, sha256  # noqa: E402


def main(argv: list[str]) -> int:
    d, manifest, tile = Path(argv[0]), Path(argv[1]), int(argv[2]) if len(argv) > 2 else 256
    sums = d / "SHA256SUMS"
    if not sums.exists():
        print(f"echo 'no SHA256SUMS in {d}' >&2; exit 1")
        return 1
    m = json.loads(manifest.read_text(encoding="utf-8")) if manifest.exists() else {}
    counted = {f["name"]: f for f in m.get("products", {}).get("analysis", {}).get("files", []) if "pixels" in f}
    files, nbytes, tiles, cells, valid = 0, 0, 0, 0, 0
    for line in sums.read_text(encoding="utf-8").splitlines():
        digest, name = line.split("  ", 1)
        p = d / name
        if not p.exists() or sha256(p) != digest:
            print(f"echo 'slope file missing or changed: {name}' >&2; exit 1")
            return 1
        with rasterio.open(p) as r:
            if r.dtypes[0] != "uint16" or r.nodata != SLOPE_NODATA or r.crs.to_epsg() != 4326:
                print(f"echo 'unexpected encoding in {name}' >&2; exit 1")
                return 1
            tiles += math.ceil(r.width / tile) * math.ceil(r.height / tile)
            c = counted.get(name)
            if c is not None and c["pixels"] != r.width * r.height:
                print(f"echo 'manifest counts {c['pixels']} cells for {name}, the file has {r.width * r.height}' >&2;"
                      " exit 1")
                return 1
            nodata = c["nodata"] if c is not None else int((r.read(1) == SLOPE_NODATA).sum())
            cells += r.width * r.height
            valid += r.width * r.height - nodata
        files += 1
        nbytes += p.stat().st_size
    product = sha256(sums)
    if m:
        named = m.get("products", {}).get("analysis", {}).get("slopeSha256")
        if named and named != product:
            print(f"echo 'manifest names slope product {named}, files give {product}' >&2; exit 1")
            return 1
        if m.get("processing", {}).get("slope", {}).get("encoding") not in (None, SLOPE_ENCODING):
            print("echo 'manifest encoding differs' >&2; exit 1")
            return 1
    print(f"SLOPE_SHA256={product}\nFILES={files}\nBYTES={nbytes}\nTILES={tiles}\nCELLS={cells}\nVALID={valid}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
