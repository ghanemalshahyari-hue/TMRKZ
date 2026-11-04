#!/usr/bin/env python3
"""Terrain products for Stationing V3 from Copernicus DEM GLO-30 (owner decisions 2 and 3, 4 Nov 2026).

ANALYSIS product (feeds the terrain rule of deployment validation):
  slope in PERCENT on the native 1-arc-second grid of each source tile (no resampling), Horn's 3x3 method with
  latitude-correct metric spacing per row from the WGS 84 ellipsoid, read through a VRT mosaic of all source tiles so
  tile borders use the real neighbouring samples.
  Encoding (the backend depends on it exactly): uint16, value = min(65534, floor(slope_percent * 100)),
  nodata = 65535 where any sample of the 3x3 window is missing (outer mosaic border, the absent open-sea tiles).
  No terrain class is baked in: the class thresholds are versioned System Administrator policy and are applied by the
  backend at query time.

VISUALIZATION product (display only, never an input to a business rule):
  hillshade on the same grid, then Web Mercator 256 px PNG tiles packaged as one PMTiles archive for a MapLibre
  raster source.

Usage:
  python ops/terrain/build_terrain.py                       # all tiles, analysis + visualization + package manifest
  python ops/terrain/build_terrain.py --only N24E055,N24E056 --no-visualization
Deterministic: identical inputs and versions give byte-identical outputs (see test_build_terrain.py).
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
import re
import sys
import time
from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.transform import Affine, from_bounds
from rasterio.warp import reproject
from rasterio.windows import Window

PROCESSING_VERSION = "tmrkz-terrain-1.0.0"
SLOPE_ENCODING = "SLOPE_PERCENT_X100_FLOOR_U16"
SLOPE_NODATA = 65535
SLOPE_MAX = 65534
DEM_MISSING = -32768.0          # value of the VRT where no source tile exists
HILLSHADE_AZIMUTH = 315.0       # degrees clockwise from north
HILLSHADE_ALTITUDE = 45.0       # degrees above the horizon
TILE_RE = re.compile(r"Copernicus_DSM_COG_10_(N|S)(\d\d)_00_(E|W)(\d\d\d)_00_DEM\.tif$")

# WGS 84
WGS84_A = 6378137.0
WGS84_F = 1 / 298.257223563
WGS84_E2 = WGS84_F * (2 - WGS84_F)
MERC_R = 6378137.0
MERC_HALF = math.pi * MERC_R

GTIFF_SLOPE = dict(driver="GTiff", dtype="uint16", count=1, nodata=SLOPE_NODATA, tiled=True, blockxsize=256,
                   blockysize=256, compress="deflate", predictor=2, zlevel=6)
GTIFF_SHADE = dict(driver="GTiff", dtype="uint8", count=1, nodata=0, tiled=True, blockxsize=256, blockysize=256,
                   compress="deflate", zlevel=6)


# ---------------------------------------------------------------------------------------------------------- algorithm
def spacing(lat_deg: np.ndarray | float, step_deg: float) -> tuple[np.ndarray, np.ndarray]:
    """Metric size of one grid step at latitude lat: dx = dλ·N(φ)·cosφ (east-west), dy = dφ·M(φ) (north-south)."""
    phi = np.radians(np.asarray(lat_deg, dtype=np.float64))
    s = np.sin(phi)
    w = np.sqrt(1.0 - WGS84_E2 * s * s)
    n = WGS84_A / w                              # prime vertical radius of curvature
    m = WGS84_A * (1.0 - WGS84_E2) / (w * w * w)  # meridional radius of curvature
    d = math.radians(step_deg)
    return d * n * np.cos(phi), d * m


def horn(z: np.ndarray, dx: np.ndarray, dy: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Horn's 3x3 gradient. z: (h+2, w+2) elevations in metres with NaN for missing samples, row 0 = north.
    dx, dy: (h,) metric spacing of each output row. Returns dz/dx (east) and dz/dy (north), NaN where any of the nine
    samples is missing (NaN propagates through the arithmetic; nothing is extrapolated)."""
    a, b, c = z[:-2, :-2], z[:-2, 1:-1], z[:-2, 2:]
    d, f = z[1:-1, :-2], z[1:-1, 2:]
    g, h, i = z[2:, :-2], z[2:, 1:-1], z[2:, 2:]
    gx = ((c + 2.0 * f + i) - (a + 2.0 * d + g)) / (8.0 * dx[:, None])
    gy = ((a + 2.0 * b + c) - (g + 2.0 * h + i)) / (8.0 * dy[:, None])
    return gx, gy


def encode_slope(gx: np.ndarray, gy: np.ndarray) -> np.ndarray:
    """uint16 = min(65534, floor(slope_percent * 100)); 65535 = no data. slope_percent = 100·|∇z|."""
    with np.errstate(invalid="ignore"):
        v = np.floor(np.hypot(gx, gy) * 10000.0)
    out = np.full(v.shape, SLOPE_NODATA, dtype=np.uint16)
    ok = np.isfinite(v)
    out[ok] = np.minimum(v[ok], SLOPE_MAX).astype(np.uint16)
    return out


def hillshade(gx: np.ndarray, gy: np.ndarray, azimuth=HILLSHADE_AZIMUTH, altitude=HILLSHADE_ALTITUDE) -> np.ndarray:
    """Lambertian shade for display: uint8 1..255, 0 = no data. Not used by any rule."""
    az, alt = math.radians(azimuth), math.radians(altitude)
    with np.errstate(invalid="ignore"):
        shade = (-gx * math.sin(az) * math.cos(alt) - gy * math.cos(az) * math.cos(alt) + math.sin(alt)) \
            / np.sqrt(1.0 + gx * gx + gy * gy)
        v = 1.0 + np.round(254.0 * np.clip(shade, 0.0, 1.0))
    out = np.zeros(v.shape, dtype=np.uint8)
    ok = np.isfinite(v)
    out[ok] = v[ok].astype(np.uint8)
    return out


# ------------------------------------------------------------------------------------------------------------ mosaic
def tile_code(path: Path) -> str:
    m = TILE_RE.search(path.name)
    if not m:
        raise ValueError(f"not a GLO-30 tile name: {path.name}")
    return f"{m.group(1)}{m.group(2)}{m.group(3)}{m.group(4)}"


def build_vrt(sources: list[Path], vrt_path: Path) -> dict:
    """Writes a VRT mosaic of the source tiles (same grid; integer offsets are asserted). Missing cells read as
    DEM_MISSING. Returns the mosaic grid description."""
    infos = []
    for p in sources:
        with rasterio.open(p) as d:
            infos.append((p, d.transform, d.width, d.height, d.crs, d.dtypes[0]))
    res = infos[0][1].a
    if any(abs(t.a - res) > 1e-15 or abs(t.e + res) > 1e-15 for _, t, *_ in infos):
        raise ValueError("source tiles have different resolutions; the mosaic needs one grid")
    x0 = min(t.c for _, t, *_ in infos)
    y0 = max(t.f for _, t, *_ in infos)
    x1 = max(t.c + w * res for _, t, w, *_ in infos)
    y1 = min(t.f - h * res for _, t, _, h, *_ in infos)
    width, height = round((x1 - x0) / res), round((y0 - y1) / res)
    parts = []
    for p, t, w, h, crs, _ in infos:
        xo, yo = (t.c - x0) / res, (y0 - t.f) / res
        if abs(xo - round(xo)) > 1e-6 or abs(yo - round(yo)) > 1e-6:
            raise ValueError(f"{p.name} is not aligned with the mosaic grid")
        rel = os.path.relpath(p, vrt_path.parent).replace(os.sep, "/")
        parts.append(f'    <SimpleSource><SourceFilename relativeToVRT="1">{rel}</SourceFilename><SourceBand>1</SourceBand>'
                     f'<SrcRect xOff="0" yOff="0" xSize="{w}" ySize="{h}"/>'
                     f'<DstRect xOff="{round(xo)}" yOff="{round(yo)}" xSize="{w}" ySize="{h}"/></SimpleSource>')
    wkt = CRS.from_epsg(4326).to_wkt().replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    xml = (f'<VRTDataset rasterXSize="{width}" rasterYSize="{height}">\n'
           f'  <SRS dataAxisToSRSAxisMapping="2,1">{wkt}</SRS>\n'
           f'  <GeoTransform>{x0!r}, {res!r}, 0.0, {y0!r}, 0.0, {-res!r}</GeoTransform>\n'
           f'  <VRTRasterBand dataType="Float32" band="1">\n    <NoDataValue>{DEM_MISSING!r}</NoDataValue>\n'
           + "\n".join(parts) + "\n  </VRTRasterBand>\n</VRTDataset>\n")
    vrt_path.parent.mkdir(parents=True, exist_ok=True)
    vrt_path.write_text(xml, encoding="utf-8")
    return dict(x0=x0, y0=y0, res=res, width=width, height=height)


def read_with_halo(vrt: rasterio.io.DatasetReader, col: int, row: int, w: int, h: int) -> np.ndarray:
    """Elevations for the window plus one sample on every side, float64, NaN outside the mosaic or where missing."""
    out = np.full((h + 2, w + 2), np.nan, dtype=np.float64)
    c0, r0 = max(col - 1, 0), max(row - 1, 0)
    c1, r1 = min(col + w + 1, vrt.width), min(row + h + 1, vrt.height)
    data = vrt.read(1, window=Window(c0, r0, c1 - c0, r1 - r0)).astype(np.float64)
    data[data <= DEM_MISSING] = np.nan
    out[r0 - (row - 1):r0 - (row - 1) + data.shape[0], c0 - (col - 1):c0 - (col - 1) + data.shape[1]] = data
    return out


def process_tile(vrt, grid: dict, src: Path, slope_path: Path, shade_path: Path | None, strip: int = 600) -> dict:
    with rasterio.open(src) as s:
        t, w, h = s.transform, s.width, s.height
    col, row = round((t.c - grid["x0"]) / grid["res"]), round((grid["y0"] - t.f) / grid["res"])
    prof = dict(GTIFF_SLOPE, width=w, height=h, crs=CRS.from_epsg(4326), transform=t)
    counts = np.zeros(65536, dtype=np.int64)
    shade_dst = None
    with rasterio.open(slope_path, "w", **prof) as dst:
        if shade_path is not None:
            shade_dst = rasterio.open(shade_path, "w", **dict(GTIFF_SHADE, width=w, height=h, crs=CRS.from_epsg(4326),
                                                               transform=t))
        try:
            for r in range(0, h, strip):
                sh = min(strip, h - r)
                z = read_with_halo(vrt, col, row + r, w, sh)
                lat = t.f - (r + np.arange(sh) + 0.5) * grid["res"]     # centre of each output row
                dx, dy = spacing(lat, grid["res"])
                gx, gy = horn(z, dx, dy)
                enc = encode_slope(gx, gy)
                counts += np.bincount(enc.ravel(), minlength=65536)
                dst.write(enc, 1, window=Window(0, r, w, sh))
                if shade_dst is not None:
                    shade_dst.write(hillshade(gx, gy), 1, window=Window(0, r, w, sh))
        finally:
            if shade_dst is not None:
                shade_dst.close()
    nodata = int(counts[SLOPE_NODATA])
    return dict(pixels=int(w * h), nodata=nodata, clamped=int(counts[SLOPE_MAX]))


# ------------------------------------------------------------------------------------------------- hillshade tiling
def lon_to_x(lon, z):
    return int(math.floor((lon + 180.0) / 360.0 * (1 << z)))


def lat_to_y(lat, z):
    s = math.sin(math.radians(lat))
    return int(math.floor((0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * (1 << z)))


def merc_bounds(z, x, y):
    size = 2 * MERC_HALF / (1 << z)
    minx = -MERC_HALF + x * size
    maxy = MERC_HALF - y * size
    return minx, maxy - size, minx + size, maxy


def png_la(gray: np.ndarray) -> bytes:
    from PIL import Image
    alpha = np.where(gray > 0, 255, 0).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(np.dstack([gray, alpha]), "LA").save(buf, "PNG", compress_level=9)
    return buf.getvalue()


def downsample(children: dict, x: int, y: int) -> np.ndarray | None:
    """Parent tile from its four children: mean of the valid (non-zero) shade values of each 2x2 block."""
    full = np.zeros((512, 512), dtype=np.float64)
    valid = np.zeros((512, 512), dtype=np.float64)
    found = False
    for dy in (0, 1):
        for dxx in (0, 1):
            a = children.get((2 * x + dxx, 2 * y + dy))
            if a is None:
                continue
            found = True
            full[dy * 256:(dy + 1) * 256, dxx * 256:(dxx + 1) * 256] = a
            valid[dy * 256:(dy + 1) * 256, dxx * 256:(dxx + 1) * 256] = a > 0
    if not found:
        return None
    s = full.reshape(256, 2, 256, 2).sum(axis=(1, 3))
    n = valid.reshape(256, 2, 256, 2).sum(axis=(1, 3))
    out = np.zeros((256, 256), dtype=np.uint8)
    np.divide(s, n, out=s, where=n > 0)
    out[n > 0] = np.clip(np.round(s[n > 0]), 1, 255).astype(np.uint8)
    return out if out.any() else None


def build_hillshade_pmtiles(shade_vrt: Path, bounds: tuple, out: Path, minzoom: int, maxzoom: int) -> dict:
    from pmtiles.tile import Compression, TileType, zxy_to_tileid
    from pmtiles.writer import Writer
    lon0, lat0, lon1, lat1 = bounds
    level: dict = {}
    tiles: dict[int, bytes] = {}
    merc = CRS.from_epsg(3857)
    with rasterio.open(shade_vrt) as src:
        z = maxzoom
        for y in range(lat_to_y(lat1, z), lat_to_y(lat0, z) + 1):
            for x in range(lon_to_x(lon0, z), lon_to_x(lon1, z) + 1):
                dst = np.zeros((256, 256), dtype=np.uint8)
                reproject(rasterio.band(src, 1), dst, src_nodata=0, dst_nodata=0, dst_crs=merc,
                          dst_transform=from_bounds(*merc_bounds(z, x, y), 256, 256), resampling=Resampling.bilinear)
                if dst.any():
                    level[(x, y)] = dst
        for z in range(maxzoom, minzoom - 1, -1):
            for (x, y), a in level.items():
                tiles[zxy_to_tileid(z, x, y)] = png_la(a)
            if z > minzoom:
                parents = {(x >> 1, y >> 1) for (x, y) in level}
                nxt = {}
                for (px, py) in sorted(parents):
                    a = downsample(level, px, py)
                    if a is not None:
                        nxt[(px, py)] = a
                level = nxt
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "wb") as f:
        w = Writer(f)
        for tid in sorted(tiles):
            w.write_tile(tid, tiles[tid])
        w.finalize({
            "tile_type": TileType.PNG, "tile_compression": Compression.NONE,
            "min_lon_e7": int(lon0 * 1e7), "min_lat_e7": int(lat0 * 1e7),
            "max_lon_e7": int(lon1 * 1e7), "max_lat_e7": int(lat1 * 1e7),
            "center_zoom": minzoom + 2, "center_lon_e7": int((lon0 + lon1) / 2 * 1e7),
            "center_lat_e7": int((lat0 + lat1) / 2 * 1e7),
        }, {
            "name": "TMRKZ hillshade (display only) — Copernicus GLO-30 DSM",
            "description": "Visualization product. Never an input to a business rule; terrain classes come from the "
                           "slope analysis product.",
            "attribution": "produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space "
                           "GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved",
            "type": "overlay", "format": "png", "version": PROCESSING_VERSION,
            "hillshade": {"azimuth_deg": HILLSHADE_AZIMUTH, "altitude_deg": HILLSHADE_ALTITUDE, "z_factor": 1},
        })
    return dict(tiles=len(tiles), minzoom=minzoom, maxzoom=maxzoom)


def build_shade_vrt(paths: list[Path], vrt_path: Path) -> None:
    """VRT over the native hillshade tiles (uint8, nodata 0) for the Web Mercator warp."""
    infos = []
    for p in paths:
        with rasterio.open(p) as d:
            infos.append((p, d.transform, d.width, d.height))
    res = infos[0][1].a
    x0 = min(t.c for _, t, *_ in infos)
    y0 = max(t.f for _, t, *_ in infos)
    x1 = max(t.c + w * res for _, t, w, _ in infos)
    y1 = min(t.f - h * res for _, t, _, h in infos)
    width, height = round((x1 - x0) / res), round((y0 - y1) / res)
    parts = []
    for p, t, w, h in infos:
        rel = os.path.relpath(p, vrt_path.parent).replace(os.sep, "/")
        parts.append(f'    <SimpleSource><SourceFilename relativeToVRT="1">{rel}</SourceFilename><SourceBand>1</SourceBand>'
                     f'<SrcRect xOff="0" yOff="0" xSize="{w}" ySize="{h}"/>'
                     f'<DstRect xOff="{round((t.c - x0) / res)}" yOff="{round((y0 - t.f) / res)}" xSize="{w}" ySize="{h}"/></SimpleSource>')
    wkt = CRS.from_epsg(4326).to_wkt().replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    vrt_path.write_text(
        f'<VRTDataset rasterXSize="{width}" rasterYSize="{height}">\n  <SRS dataAxisToSRSAxisMapping="2,1">{wkt}</SRS>\n'
        f'  <GeoTransform>{x0!r}, {res!r}, 0.0, {y0!r}, 0.0, {-res!r}</GeoTransform>\n'
        f'  <VRTRasterBand dataType="Byte" band="1">\n    <NoDataValue>0</NoDataValue>\n' + "\n".join(parts)
        + "\n  </VRTRasterBand>\n</VRTDataset>\n", encoding="utf-8")


# -------------------------------------------------------------------------------------------------------- packaging
def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 22), b""):
            h.update(b)
    return h.hexdigest()


def write_sums(files: list[Path], sums_path: Path) -> str:
    """SHA256SUMS (sorted, 'sha256  name' lines, LF). Its own sha256 is the product checksum the loader records."""
    lines = sorted(f"{sha256(p)}  {p.name}\n" for p in files)
    sums_path.write_bytes("".join(lines).encode("utf-8"))
    return sha256(sums_path)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", default="map-data/terrain/glo30/source")
    ap.add_argument("--out", default="map-data/terrain/glo30")
    ap.add_argument("--package", default="map-packages/terrain-glo30-2026.11", help="manifest directory ('' to skip)")
    ap.add_argument("--only", default="", help="comma-separated tile codes, e.g. N24E055 (default: all)")
    ap.add_argument("--no-visualization", action="store_true")
    ap.add_argument("--minzoom", type=int, default=6)
    ap.add_argument("--maxzoom", type=int, default=12)
    args = ap.parse_args(argv)
    source, out = Path(args.source), Path(args.out)
    sources = sorted(p for p in source.glob("*.tif") if TILE_RE.search(p.name))
    if not sources:
        print(f"no GLO-30 tiles in {source}", file=sys.stderr)
        return 2
    only = {c.strip() for c in args.only.split(",") if c.strip()}
    analysis, vis = out / "analysis", out / "visualization"
    analysis.mkdir(parents=True, exist_ok=True)
    started = time.time()
    grid = build_vrt(sources, analysis / "dem_mosaic.vrt")      # always the full mosaic: borders use real neighbours
    report = dict(processing_version=PROCESSING_VERSION, encoding=SLOPE_ENCODING, grid=grid, tiles={})
    slope_files, shade_files = [], []
    with rasterio.open(analysis / "dem_mosaic.vrt") as vrt:
        for src in sources:
            code = tile_code(src)
            if only and code not in only:
                continue
            sp = analysis / f"slope_pct_x100_{code}.tif"
            hp = None if args.no_visualization else vis / "hillshade_native" / f"hillshade_{code}.tif"
            if hp is not None:
                hp.parent.mkdir(parents=True, exist_ok=True)
            t0 = time.time()
            report["tiles"][code] = process_tile(vrt, grid, src, sp, hp)
            report["tiles"][code]["seconds"] = round(time.time() - t0, 2)
            slope_files.append(sp)
            if hp is not None:
                shade_files.append(hp)
            print(f"[terrain] {code}: {report['tiles'][code]}", flush=True)
    report["slope_sha256"] = write_sums(slope_files, analysis / "SHA256SUMS")
    report["slope_files"] = {p.name: sha256(p) for p in slope_files}
    if shade_files:
        t0 = time.time()
        build_shade_vrt(shade_files, vis / "hillshade_native" / "hillshade_mosaic.vrt")
        b = (grid["x0"], grid["y0"] - grid["height"] * grid["res"], grid["x0"] + grid["width"] * grid["res"], grid["y0"])
        pm = vis / "hillshade.pmtiles"
        report["hillshade"] = build_hillshade_pmtiles(vis / "hillshade_native" / "hillshade_mosaic.vrt", b, pm,
                                                      args.minzoom, args.maxzoom)
        report["hillshade"].update(file=pm.name, sha256=sha256(pm), bytes=pm.stat().st_size,
                                   seconds=round(time.time() - t0, 1))
    report["seconds"] = round(time.time() - started, 1)
    (out / "build-report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    if args.package and not only:
        from make_manifest import write_manifest  # same directory
        write_manifest(source, out, Path(args.package), report)
    print(f"[terrain] slope product SHA256SUMS sha256 = {report['slope_sha256']}  ({report['seconds']} s)")
    return 0


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.exit(main())
