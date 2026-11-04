#!/usr/bin/env python3
"""Small real-data slope fixture for the backend integration tests (backend/src/test/resources/terrain/).

A 160x160 clip of the slope ANALYSIS product (same encoding), written as a GeoTIFF and as PostGIS raster WKB in hex,
one 64x64 tile per line, so a test inserts it with plain JDBC: insert into terrain_slope (dataset_id, rast)
values (?, ?::raster). Also writes the expected class cell counts of one test rectangle under the pixel-centre rule
(PostGIS ST_Clip default) and under the all-touched rule, for the FAO default half-open classes.

  python ops/terrain/make_fixture.py
"""
from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_terrain import GTIFF_SLOPE, SLOPE_NODATA, sha256  # noqa: E402

SRC = Path("map-data/terrain/glo30/analysis/slope_pct_x100_N24E055.tif")
OUT = Path("backend/src/test/resources/terrain")
ROW0, COL0, SIZE, TILE = 3200, 2780, 160, 64        # Jebel Hafeet foothills, N24E055 tile
RECT_ROWS = (3210.25, 3290.25)                       # rectangle edges a quarter pixel from cell centres
RECT_COLS = (2790.25, 2870.25)
FAO = [("FLAT", 0, 200), ("UNDULATING", 200, 1000), ("ROLLING", 1000, 1500), ("HILLY", 1500, 3000),
       ("MOUNTAINOUS", 3000, None)]                  # initial policy, x100 units, half-open [min, max)
PT_16BUI, HASNODATA = 6, 0x40


def wkb_hex(a: np.ndarray, ulx: float, uly: float, res: float) -> str:
    """PostGIS raster WKB (version 0, little endian), one 16BUI band with nodata 65535."""
    h, w = a.shape
    head = struct.pack("<BHHddddddiHH", 1, 0, 1, res, -res, ulx, uly, 0.0, 0.0, 4326, w, h)
    band = struct.pack("<BH", HASNODATA | PT_16BUI, SLOPE_NODATA) + a.astype("<u2").tobytes()
    return (head + band).hex().upper()


def counts(values: np.ndarray) -> dict:
    v = values[values != SLOPE_NODATA]
    return {n: int(((v >= lo) & ((v < hi) if hi is not None else True)).sum()) for n, lo, hi in FAO}


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    with rasterio.open(SRC) as d:
        t, res = d.transform, d.transform.a
        a = d.read(1, window=Window(COL0, ROW0, SIZE, SIZE))
        wt = d.window_transform(Window(COL0, ROW0, SIZE, SIZE))
        lon_c = lambda col: (t.c + (col + 0.5) * res)      # noqa: E731 cell centre (= 55 + col/3600)
        lat_c = lambda row: (t.f - (row + 0.5) * res)      # noqa: E731
        tif = OUT / "slope-fixture-N24E055.tif"
        with rasterio.open(tif, "w", **dict(GTIFF_SLOPE, width=SIZE, height=SIZE, crs=d.crs, transform=wt)) as o:
            o.write(a, 1)
    lines = []
    for ty in range(0, SIZE, TILE):
        for tx in range(0, SIZE, TILE):
            sub = a[ty:ty + TILE, tx:tx + TILE]
            lines.append(wkb_hex(sub, wt.c + tx * res, wt.f - ty * res, res))
    hexf = OUT / "slope-fixture.hexwkb"
    hexf.write_text("\n".join(lines) + "\n", encoding="ascii")
    # rectangle in lon/lat; cell (row, col) centre is at lon 55 + col/3600, lat 25 - row/3600
    west, east = 55 + RECT_COLS[0] / 3600, 55 + RECT_COLS[1] / 3600
    north, south = 25 - RECT_ROWS[0] / 3600, 25 - RECT_ROWS[1] / 3600
    rows = np.arange(ROW0, ROW0 + SIZE)
    cols = np.arange(COL0, COL0 + SIZE)
    centre_r = (lat_c(rows) < north) & (lat_c(rows) > south)
    centre_c = (lon_c(cols) > west) & (lon_c(cols) < east)
    touch_r = (lat_c(rows) - res / 2 < north) & (lat_c(rows) + res / 2 > south)
    touch_c = (lon_c(cols) + res / 2 > west) & (lon_c(cols) - res / 2 < east)
    centre = counts(a[np.ix_(centre_r, centre_c)])
    touched = counts(a[np.ix_(touch_r, touch_c)])
    polygon = {"type": "Polygon", "coordinates": [[[round(west, 10), round(south, 10)], [round(east, 10), round(south, 10)],
                                                    [round(east, 10), round(north, 10)], [round(west, 10), round(north, 10)],
                                                    [round(west, 10), round(south, 10)]]]}
    meta = {
        "source": "Copernicus GLO-30 slope analysis product, tile N24E055, rows 3200-3359, cols 2780-2939",
        "encoding": "SLOPE_PERCENT_X100_FLOOR_U16 (uint16 = min(65534, floor(slope_percent*100)), nodata 65535)",
        "bbox": [wt.c, wt.f - SIZE * res, wt.c + SIZE * res, wt.f],
        "srid": 4326, "size": [SIZE, SIZE], "tile": TILE, "tiles": len(lines),
        "files": {tif.name: sha256(tif), hexf.name: sha256(hexf)},
        "testPolygon": polygon,
        "classes": [{"code": n, "min": lo, "max": hi} for n, lo, hi in FAO],
        "expectedCellsPixelCentre": centre, "expectedCellsTotalPixelCentre": int(sum(centre.values())),
        "expectedCellsAllTouched": touched, "expectedCellsTotalAllTouched": int(sum(touched.values())),
        "allFixtureCells": counts(a),
        "attribution": "produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH "
                       "2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved",
        "limitation": "DSM, not bare-earth terrain. Test data only.",
    }
    (OUT / "slope-fixture.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({k: meta[k] for k in ("bbox", "files", "testPolygon", "expectedCellsPixelCentre",
                                            "expectedCellsTotalPixelCentre", "expectedCellsAllTouched",
                                            "expectedCellsTotalAllTouched")}, indent=1, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
