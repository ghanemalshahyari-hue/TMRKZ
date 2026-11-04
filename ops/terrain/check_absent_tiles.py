#!/usr/bin/env python3
"""Evidence that a 1°x1° cell absent from the GLO-30 tile set is open sea, not missing land coverage.

For each absent cell inside the mosaic extent: (1) the GLO-30 neighbour edges facing it (sea is 0 m in GLO-30),
(2) the optional SRTM 1" (AWS 'skadi' composite) tile of the same cell, whose ocean is bathymetry-like negative values,
and (3) a control: the same SRTM test on a present tile known to contain land.

  python ops/terrain/check_absent_tiles.py --srtm "C:/Users/ADMIN/Desktop/MOVER_1 - Copy/map-source/uae/dem/srtm"
Writes map-data/terrain/glo30/source/absent-tiles.json; exits 1 if any absent cell shows land.
"""
from __future__ import annotations

import argparse
import gzip
import json
import sys
from pathlib import Path

import numpy as np
import rasterio

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_terrain import TILE_RE, tile_code  # noqa: E402

NAME = "Copernicus_DSM_COG_10_N{lat:02d}_00_E{lon:03d}_00_DEM.tif"


def edge(source: Path, lat: int, lon: int, side: str):
    p = source / NAME.format(lat=lat, lon=lon)
    if not p.exists():
        return None
    with rasterio.open(p) as d:
        a = d.read(1)
    e = {"north": a[0, :], "south": a[-1, :], "west": a[:, 0], "east": a[:, -1]}[side]
    return dict(tile=p.name, side=side, samples=int(e.size), min_m=float(e.min()), max_m=float(e.max()),
                share_exactly_0=float(np.mean(e == 0)), share_above_2m=float(np.mean(e > 2)))


def srtm(dirpath: Path | None, code: str):
    if dirpath is None:
        return None
    p = dirpath / f"{code}.hgt.gz"
    if not p.exists():
        return None
    raw = gzip.open(p).read()
    n = int(round((len(raw) // 2) ** 0.5))
    a = np.frombuffer(raw, ">i2").reshape(n, n)
    v = a[a != -32768]
    return dict(file=p.name, size=n, min_m=int(v.min()), max_m=int(v.max()), samples_above_0m=int((v > 0).sum()),
                voids=int((a == -32768).sum()))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="map-data/terrain/glo30/source")
    ap.add_argument("--srtm", default=None)
    ap.add_argument("--control", default="N25E052", help="present tile with land, to prove the SRTM test sees land")
    a = ap.parse_args(argv)
    source, sdir = Path(a.source), (Path(a.srtm) if a.srtm else None)
    present = {tile_code(p) for p in source.glob("*.tif") if TILE_RE.search(p.name)}
    lats = sorted({int(c[1:3]) for c in present})
    lons = sorted({int(c[4:7]) for c in present})
    out, land = [], False
    for lat in range(lats[0], lats[-1] + 1):
        for lon in range(lons[0], lons[-1] + 1):
            code = f"N{lat:02d}E{lon:03d}"
            if code in present:
                continue
            edges = [e for e in (edge(source, lat - 1, lon, "north"), edge(source, lat + 1, lon, "south"),
                                 edge(source, lat, lon - 1, "east"), edge(source, lat, lon + 1, "west")) if e]
            s = srtm(sdir, code)
            edge_land = any(e["share_above_2m"] > 0 for e in edges)
            srtm_land = s is not None and s["samples_above_0m"] > 0
            verdict = "LAND_POSSIBLE" if (edge_land or srtm_land) else "OPEN_SEA"
            land |= verdict != "OPEN_SEA"
            out.append(dict(cell=code, verdict=verdict, glo30_neighbour_edges=edges, srtm=s))
            print(code, verdict)
    report = dict(absent_cells=out, control=dict(tile=a.control, srtm=srtm(sdir, a.control)),
                  note="GLO-30 is distributed only for cells containing land; the AWS bucket returned 404 for these "
                       "cells (MOVER dl.log). Evidence above is independent of that.")
    (source / "absent-tiles.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    return 1 if land else 0


if __name__ == "__main__":
    sys.exit(main())
