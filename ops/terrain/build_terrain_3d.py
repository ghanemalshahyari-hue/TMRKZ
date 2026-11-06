#!/usr/bin/env python3
"""3D VISUAL TERRAIN product for the offline map (owner brief «TRUE OFFLINE 3D TERRAIN», 6 Nov 2026), derived from the
same approved Copernicus DEM GLO-30 source tiles as the slope analysis, for MapLibre's terrain (a `raster-dem` source
and `setTerrain`) only.

It is NOT the business terrain: the Stationing rules read only the slope analysis product loaded into PostGIS
(ops/terrain/build_terrain.py → load-slope.sh). This product is never loaded into the database and never feeds a rule;
the browser draws the relief from it and reads elevations from it for display (lowest/highest point, profiles).

Product: elevation in metres (GLO-30 heights, EGM2008 geoid, DSM) resampled to Web Mercator 256 px tiles, encoded as
Mapbox Terrain-RGB (height = -10000 + (R·65536 + G·256 + B) · 0.1), PNG RGB, one PMTiles v3 archive, zoom 6–12
(z12 ≈ 35 m a pixel at the UAE's latitude, the source's 30 m). The finest zoom is reprojected from the VRT mosaic of all
source tiles with bilinear resampling; each coarser zoom is the mean of the four children's samples. Where no source tile
exists (the absent open-sea cells) the height is 0 m (sea level). Every tile of the product's bounds exists at every
zoom, so the map never asks for a tile the archive lacks.

Before reading anything it checks every source tile against the sha256 recorded in the terrain manifest. Deterministic:
identical inputs and library versions (ops/terrain/requirements.txt) give a byte-identical archive.

  python ops/terrain/build_terrain_3d.py                       # full product + record map-packages/terrain-3d-glo30-2026.11
  python ops/terrain/build_terrain_3d.py --bbox 55.9,24.7,56.2,25.0 --out <dir> --record ''   # a sample, no record
"""
from __future__ import annotations

import argparse
import io
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.warp import reproject

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_terrain import DEM_MISSING, TILE_RE, build_vrt, lat_to_y, lon_to_x, merc_bounds, sha256  # noqa: E402

PROCESSING_VERSION = "tmrkz-terrain-3d-1.0.0"
ENCODING = "mapbox"                 # MapLibre raster-dem encoding name
ENCODING_RECORD = "MAPBOX_TERRAIN_RGB_0.1M"
BASE_M, STEP_M = -10000.0, 0.1
TILE = 256
ATTRIBUTION = ("produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH "
               "2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved")


def encode(h: np.ndarray) -> np.ndarray:
    """Heights (metres, float) → Terrain-RGB bytes (h, w, 3). NaN (no data) is sea level, 0 m."""
    h = np.where(np.isfinite(h), h, 0.0)
    v = np.clip(np.rint((h - BASE_M) / STEP_M), 0, (1 << 24) - 1).astype(np.uint32)
    return np.dstack([(v >> 16) & 255, (v >> 8) & 255, v & 255]).astype(np.uint8)


def decode(rgb: np.ndarray) -> np.ndarray:
    """Terrain-RGB bytes → heights in metres (the formula MapLibre applies for encoding 'mapbox')."""
    rgb = rgb.astype(np.float64)
    return BASE_M + (rgb[..., 0] * 65536 + rgb[..., 1] * 256 + rgb[..., 2]) * STEP_M


def png_rgb(rgb: np.ndarray) -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    # no gamma, colour-profile or time chunks: the bytes are data, decoded without colour conversion
    Image.fromarray(rgb, "RGB").save(buf, "PNG", compress_level=9)
    return buf.getvalue()


def parent_of(children: dict, x: int, y: int) -> np.ndarray:
    """A parent tile from its four children: the mean of each 2×2 block (a missing child is sea level, 0 m)."""
    full = np.zeros((2 * TILE, 2 * TILE), dtype=np.float32)
    for dy in (0, 1):
        for dx in (0, 1):
            a = children.get((2 * x + dx, 2 * y + dy))
            if a is not None:
                full[dy * TILE:(dy + 1) * TILE, dx * TILE:(dx + 1) * TILE] = a
    return full.reshape(TILE, 2, TILE, 2).mean(axis=(1, 3), dtype=np.float64).astype(np.float32)


def build(vrt_path: Path, bounds: tuple, out: Path, minzoom: int, maxzoom: int, log=print) -> dict:
    from pmtiles.tile import Compression, TileType, zxy_to_tileid
    from pmtiles.writer import Writer
    lon0, lat0, lon1, lat1 = bounds
    merc = CRS.from_epsg(3857)
    tiles: dict[int, bytes] = {}
    level: dict = {}
    lo, hi = math.inf, -math.inf
    z = maxzoom
    xs = range(lon_to_x(lon0, z), lon_to_x(lon1 - 1e-9, z) + 1)
    ys = range(lat_to_y(lat1 - 1e-9, z), lat_to_y(lat0, z) + 1)
    t0 = time.time()
    with rasterio.open(vrt_path) as src:
        for n, y in enumerate(ys):
            for x in xs:
                dst = np.full((TILE, TILE), np.nan, dtype=np.float32)
                reproject(rasterio.band(src, 1), dst, src_nodata=DEM_MISSING, dst_nodata=np.nan, dst_crs=merc,
                          dst_transform=from_bounds(*merc_bounds(z, x, y), TILE, TILE), resampling=Resampling.bilinear)
                dst = np.where(np.isfinite(dst), dst, np.float32(0.0))
                level[(x, y)] = dst
                lo, hi = min(lo, float(dst.min())), max(hi, float(dst.max()))
            if n % 10 == 0:
                log(f"[terrain-3d] z{z}: row {n + 1}/{len(ys)} ({time.time() - t0:.0f} s)")
    counts = {}
    for z in range(maxzoom, minzoom - 1, -1):
        for (x, y), a in level.items():
            tiles[zxy_to_tileid(z, x, y)] = png_rgb(encode(a))
        counts[z] = len(level)
        log(f"[terrain-3d] z{z}: {len(level)} tiles ({time.time() - t0:.0f} s)")
        if z > minzoom:
            level = {(px, py): parent_of(level, px, py) for (px, py) in sorted({(x >> 1, y >> 1) for (x, y) in level})}
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".partial")
    with open(tmp, "wb") as f:
        w = Writer(f)
        for tid in sorted(tiles):
            w.write_tile(tid, tiles[tid])
        w.finalize({
            "tile_type": TileType.PNG, "tile_compression": Compression.NONE,
            "min_lon_e7": int(round(lon0 * 1e7)), "min_lat_e7": int(round(lat0 * 1e7)),
            "max_lon_e7": int(round(lon1 * 1e7)), "max_lat_e7": int(round(lat1 * 1e7)),
            "center_zoom": minzoom + 4, "center_lon_e7": int(round((lon0 + lon1) / 2 * 1e7)),
            "center_lat_e7": int(round((lat0 + lat1) / 2 * 1e7)),
        }, {
            "name": "TMRKZ 3D terrain (display only) — Copernicus GLO-30 DSM",
            "description": "Visualization product for MapLibre terrain. Never an input to a business rule; terrain classes "
                           "come from the slope analysis product.",
            "attribution": ATTRIBUTION, "type": "baselayer", "format": "png", "version": PROCESSING_VERSION,
            "encoding": ENCODING, "tileSize": TILE, "minzoom": minzoom, "maxzoom": maxzoom,
        })
    tmp.replace(out)
    return dict(tiles=len(tiles), tilesPerZoom={str(k): v for k, v in sorted(counts.items())}, minzoom=minzoom,
                maxzoom=maxzoom, bounds=[lon0, lat0, lon1, lat1], minHeightM=round(lo, 1), maxHeightM=round(hi, 1))


def check_sources(source: Path, terrain_manifest: dict) -> list[Path]:
    """Every source tile the terrain manifest lists, at its recorded size and sha256; nothing else in the directory."""
    tiles, bad = terrain_manifest["tiles"], []
    for t in tiles:
        p = source / t["name"]
        if not p.is_file() or p.stat().st_size != t["bytes"] or sha256(p) != t["sha256"]:
            bad.append(t["name"])
    if bad:
        raise SystemExit(f"[terrain-3d] source tiles missing or not as recorded: {bad[:5]}")
    extra = sorted({p.name for p in source.glob("*.tif") if TILE_RE.search(p.name)} - {t["name"] for t in tiles})
    if extra:
        raise SystemExit(f"[terrain-3d] source directory holds tiles the terrain manifest does not list: {extra[:5]}")
    return sorted(source / t["name"] for t in tiles)


def record(terrain_manifest: dict, report: dict, product: Path, out_dir: Path) -> Path:
    """The product's record (git-tracked): what it was made from, how, and its checksum."""
    lic = terrain_manifest["licence"]
    rec = {
        "code": "copernicus-glo30-3d",
        "name": "3D visual terrain (Terrain-RGB) from Copernicus DEM GLO-30",
        "version": terrain_manifest["version"],
        "kind": "VISUALIZATION",
        "status": "display only — never an input to a business rule (the slope analysis of copernicus-glo30 is)",
        "derivedFrom": {"dataset": terrain_manifest["code"], "version": terrain_manifest["version"],
                        "manifest": "map-packages/terrain-glo30-2026.11/manifest.json",
                        "sourceTiles": [{"name": t["name"], "code": t["code"], "bytes": t["bytes"], "sha256": t["sha256"]}
                                        for t in sorted(terrain_manifest["tiles"], key=lambda t: t["name"])],
                        "absentCells": terrain_manifest["absentCells"]},
        "limitation": terrain_manifest["limitation"],
        "processing": {
            "version": PROCESSING_VERSION,
            "tool": "ops/terrain/build_terrain_3d.py (Python, rasterio/GDAL, numpy, Pillow, pmtiles; ops/terrain/requirements.txt)",
            "mosaic": "VRT of all source tiles (the same grid as the slope analysis)",
            "finestZoom": "bilinear reprojection of the mosaic to Web Mercator 256 px tiles",
            "coarserZooms": "mean of the four children's samples",
            "noData": "the absent open-sea cells are sea level (0 m)",
            "encoding": ENCODING_RECORD,
            "formula": "height_m = -10000 + (R*65536 + G*256 + B) * 0.1",
            "verticalDatum": "EGM2008 geoid (as the source), metres",
        },
        "product": {
            "file": product.name,
            "format": "PMTiles v3, PNG (RGB) 256 px Terrain-RGB, Web Mercator",
            "mapLibre": {"type": "raster-dem", "encoding": ENCODING, "tileSize": TILE},
            "minzoom": report["minzoom"], "maxzoom": report["maxzoom"], "bounds": report["bounds"],
            "tiles": report["tiles"], "tilesPerZoom": report["tilesPerZoom"],
            "heightRangeM": [report["minHeightM"], report["maxHeightM"]],
            "bytes": product.stat().st_size, "sha256": sha256(product),
        },
        "licence": {"title": lic["title"], "instance": lic["instance"], "url": lic["url"],
                    "documentSha256": lic["documentSha256"], "modifiedDataAttribution": lic["modifiedDataAttribution"],
                    "noLiability": lic["noLiability"]},
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    p = out_dir / "manifest.json"
    p.write_text(json.dumps(rec, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    return p


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", default="map-data/terrain/glo30/source")
    ap.add_argument("--terrain-manifest", default="map-packages/terrain-glo30-2026.11/manifest.json")
    ap.add_argument("--out", default="map-data/terrain/glo30/visualization-3d")
    ap.add_argument("--record", default="map-packages/terrain-3d-glo30-2026.11", help="record directory ('' to skip)")
    ap.add_argument("--bbox", default="", help="west,south,east,north for a sample (default: the whole mosaic)")
    ap.add_argument("--minzoom", type=int, default=6)
    ap.add_argument("--maxzoom", type=int, default=12)
    a = ap.parse_args(argv)
    tm = json.loads(Path(a.terrain_manifest).read_text(encoding="utf-8"))
    sources = check_sources(Path(a.source), tm)
    print(f"[terrain-3d] {len(sources)} source tiles match the terrain manifest")
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    grid = build_vrt(sources, out / "dem_mosaic.vrt")
    full = (grid["x0"], grid["y0"] - grid["height"] * grid["res"], grid["x0"] + grid["width"] * grid["res"], grid["y0"])
    bounds = tuple(float(v) for v in a.bbox.split(",")) if a.bbox else tuple(round(v, 7) for v in full)
    started = time.time()
    product = out / "terrain-rgb.pmtiles"
    report = build(out / "dem_mosaic.vrt", bounds, product, a.minzoom, a.maxzoom)
    report.update(processing_version=PROCESSING_VERSION, encoding=ENCODING_RECORD, file=product.name,
                  sha256=sha256(product), bytes=product.stat().st_size, seconds=round(time.time() - started, 1))
    (out / "build-report-3d.json").write_text(json.dumps(report, indent=1), encoding="utf-8", newline="\n")
    if a.record and not a.bbox:
        print(f"[terrain-3d] record -> {record(tm, report, product, Path(a.record))}")
    print(f"[terrain-3d] {product}: {report['tiles']} tiles, {report['bytes']} bytes, sha256 {report['sha256']} "
          f"({report['seconds']} s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
