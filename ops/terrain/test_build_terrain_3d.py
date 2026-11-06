"""Tests of the 3D visual terrain build (ops/terrain/build_terrain_3d.py): python -m pytest ops/terrain -q

The fixture follows test_build_terrain.py: two small synthetic GLO-30-named tiles (60 x 60 samples at 1"), a terrain
manifest that records their sha256, and a full build of the Terrain-RGB PMTiles and its record from them.
"""
from __future__ import annotations

import hashlib
import io
import json
import sys
from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.crs import CRS
from rasterio.transform import Affine

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_terrain as bt  # noqa: E402
import build_terrain_3d as b3  # noqa: E402

RES = 1 / 3600
N = 60
PLANE = (100.0, 1.0)  # heights: 100 m at the western edge, rising 1 m a sample to the east


def digest(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def fixture(tmp_path: Path) -> tuple[Path, Path]:
    """Two adjacent source tiles forming one east-rising plane, and a terrain manifest listing them."""
    src = tmp_path / "src"
    src.mkdir()
    z = np.tile((PLANE[0] + np.arange(2 * N, dtype=np.float64) * PLANE[1])[None, :], (N, 1))
    tiles = []
    for i, code in enumerate(("N24E054", "N24E055")):
        name = f"Copernicus_DSM_COG_10_N24_00_E{code[-3:]}_00_DEM.tif"
        prof = dict(driver="GTiff", dtype="float32", count=1, width=N, height=N, crs=CRS.from_epsg(4326),
                    transform=Affine(RES, 0, 54.0 + i * N * RES, 0, -RES, 24.0 + N * RES / 2))
        with rasterio.open(src / name, "w", **prof) as d:
            d.write(z[:, i * N:(i + 1) * N].astype(np.float32), 1)
        tiles.append({"name": name, "code": code, "bytes": (src / name).stat().st_size, "sha256": digest(src / name)})
    tm = {"code": "terrain-glo30", "version": "test", "tiles": tiles, "absentCells": [], "limitation": "fixture",
          "licence": {"title": "t", "instance": "i", "url": "u", "documentSha256": "0" * 64,
                      "modifiedDataAttribution": "m", "noLiability": "n"}}
    tmj = tmp_path / "terrain-manifest.json"
    tmj.write_text(json.dumps(tm), encoding="utf-8")
    return src, tmj


def test_terrain_rgb_round_trip_within_half_a_step_and_no_data_is_sea_level():
    rng = np.random.default_rng(11)
    h = rng.uniform(-430.0, 8850.0, size=(64, 64))
    h[0, 0], h[0, 1], h[0, 2] = np.nan, np.inf, -np.inf
    rgb = b3.encode(h)
    assert rgb.dtype == np.uint8 and rgb.shape == (64, 64, 3)
    back = b3.decode(rgb)
    finite = np.isfinite(h)
    assert np.max(np.abs(back[finite] - h[finite])) <= 0.05 + 1e-9
    assert np.allclose(back[~finite], 0.0, atol=1e-9)        # NaN (no source tile) and infinities are sea level
    assert np.allclose(b3.decode(b3.encode(np.array([[0.0, -16.2, 2629.1]]))), [[0.0, -16.2, 2629.1]], atol=1e-9)
    from PIL import Image
    png = b3.png_rgb(rgb)                                    # the PNG keeps every byte (no colour conversion)
    im = Image.open(io.BytesIO(png))
    assert im.mode == "RGB" and np.array_equal(np.asarray(im), rgb)


def test_a_parent_tile_is_the_mean_of_each_2x2_block_of_its_four_children():
    t, half = b3.TILE, b3.TILE // 2
    ramp = np.arange(t * t, dtype=np.float32).reshape(t, t)
    kids = {(2, 4): ramp, (3, 4): np.full((t, t), 10, np.float32), (2, 5): np.full((t, t), 20, np.float32)}
    p = b3.parent_of(kids, 1, 2)                             # children (2,4) (3,4) (2,5) (3,5); (3,5) is missing
    assert p.shape == (t, t) and p.dtype == np.float32
    assert p[0, 0] == pytest.approx((0 + 1 + t + t + 1) / 4)
    assert np.allclose(p[:half, :half], ramp.reshape(half, 2, half, 2).mean(axis=(1, 3)))
    assert np.all(p[:half, half:] == 10) and np.all(p[half:, :half] == 20)
    assert np.all(p[half:, half:] == 0)                      # a missing child is sea level


def test_the_build_is_deterministic_and_draws_the_source_heights(tmp_path):
    src, tmj = fixture(tmp_path)
    runs = []
    for k in ("a", "b"):
        out, rec = tmp_path / k / "out", tmp_path / k / "record"
        assert b3.main(["--source", str(src), "--terrain-manifest", str(tmj), "--out", str(out), "--record", str(rec),
                        "--minzoom", "10", "--maxzoom", "12"]) == 0
        runs.append((out, rec))
    (oa, ra), (ob, rb) = runs
    assert digest(oa / "terrain-rgb.pmtiles") == digest(ob / "terrain-rgb.pmtiles")
    assert digest(ra / "manifest.json") == digest(rb / "manifest.json")
    rep_a, rep_b = (json.loads((o / "build-report-3d.json").read_text(encoding="utf-8")) for o in (oa, ob))
    assert {k: v for k, v in rep_a.items() if k != "seconds"} == {k: v for k, v in rep_b.items() if k != "seconds"}
    record = json.loads((ra / "manifest.json").read_text(encoding="utf-8"))
    assert record["product"]["sha256"] == digest(oa / "terrain-rgb.pmtiles")
    assert record["derivedFrom"]["sourceTiles"] == sorted(json.loads(tmj.read_text())["tiles"], key=lambda t: t["name"])
    assert record["product"]["mapLibre"] == {"type": "raster-dem", "encoding": "mapbox", "tileSize": 256}
    assert sum(rep_a["tilesPerZoom"].values()) == rep_a["tiles"] and set(rep_a["tilesPerZoom"]) == {"10", "11", "12"}
    top = PLANE[0] + (2 * N - 1) * PLANE[1]
    assert -0.05 <= rep_a["minHeightM"] and rep_a["maxHeightM"] <= top + 0.05
    # the finest tile over the mosaic's centre decodes to the plane's heights (0 m outside the mosaic)
    from PIL import Image
    from pmtiles.reader import MmapSource, Reader
    with open(oa / "terrain-rgb.pmtiles", "rb") as f:
        r = Reader(MmapSource(f))
        raw = r.get(12, bt.lon_to_x(54.0 + N * RES, 12), bt.lat_to_y(24.0, 12))
        assert r.header()["tile_type"].name == "PNG"
    h = b3.decode(np.asarray(Image.open(io.BytesIO(raw))))
    assert h.min() >= -0.05 and PLANE[0] < h.max() <= top + 0.05


def test_a_source_tile_that_differs_from_the_terrain_manifest_is_refused(tmp_path):
    src, tmj = fixture(tmp_path)
    tm = json.loads(tmj.read_text(encoding="utf-8"))
    assert len(b3.check_sources(src, tm)) == 2
    tm["tiles"][0]["sha256"] = "0" * 64
    with pytest.raises(SystemExit, match="not as recorded"):
        b3.check_sources(src, tm)
