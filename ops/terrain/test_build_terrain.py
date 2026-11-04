"""Tests of the terrain build: python -m pytest ops/terrain -q"""
from __future__ import annotations

import hashlib
import math
import sys
from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.crs import CRS
from rasterio.transform import Affine

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_terrain as bt  # noqa: E402

RES = 1 / 3600


def plane_rows(step: float, rows=5, cols=5) -> np.ndarray:
    """Elevation rising by `step` metres per row towards the SOUTH (row index), as float64 with no halo trimming."""
    return np.tile((np.arange(rows, dtype=np.float64) * step)[:, None], (1, cols))


def slope_of(z: np.ndarray, dx=12.5, dy=12.5) -> np.ndarray:
    h = z.shape[0] - 2
    gx, gy = bt.horn(z, np.full(h, dx), np.full(h, dy))
    return bt.encode_slope(gx, gy)


@pytest.mark.parametrize("step,expected", [(0.0, 0), (0.25, 200), (1.25, 1000), (5.625, 4500)])
def test_exact_planes(step, expected):
    # with dy = 12.5 m these steps are exactly 0 %, 2 %, 10 % and 45 % and every intermediate value is representable
    assert np.all(slope_of(plane_rows(step)) == expected)


def test_just_below_two_percent_stays_below_the_threshold():
    v = slope_of(plane_rows(0.0199 * 12.5))
    assert np.all((v >= 198) & (v <= 199))     # floor, never rounded up into [2 %, …)


def test_east_west_plane_is_the_same_slope():
    z = np.tile((np.arange(5, dtype=np.float64) * 1.25)[None, :], (5, 1))
    assert np.all(slope_of(z) == 1000)


def test_diagonal_plane_combines_both_gradients():
    r, c = np.mgrid[0:5, 0:5].astype(np.float64)
    z = r * 0.75 + c * 1.0                      # 6 % south, 8 % east → 10 %
    assert np.all(slope_of(z) == 1000)


def test_clamp_and_nodata():
    assert np.all(slope_of(plane_rows(1000.0)) == bt.SLOPE_MAX)
    z = plane_rows(0.25, 6, 6)
    z[0, 0] = np.nan
    v = slope_of(z)
    assert v[0, 0] == bt.SLOPE_NODATA          # the only output window that contains the missing sample
    assert np.count_nonzero(v == bt.SLOPE_NODATA) == 1 and np.all(v[v != bt.SLOPE_NODATA] == 200)


def test_latitude_spacing_matches_an_independent_geodesic():
    from pyproj import Geod
    g = Geod(ellps="WGS84")
    for lat in (0.0, 22.5, 24.0, 26.9):
        dx, dy = bt.spacing(lat, RES)
        _, _, ew = g.inv(54.0, lat, 54.0 + RES, lat)
        _, _, ns = g.inv(54.0, lat - RES / 2, 54.0, lat + RES / 2)
        assert abs(float(dx) - ew) < 1e-3 and abs(float(dy) - ns) < 1e-3
    dx0, dy0 = bt.spacing(0.0, RES)
    assert abs(float(dx0) - 30.922) < 0.001 and abs(float(dy0) - 30.715) < 0.001


def test_hillshade_is_display_shading():
    flat = bt.hillshade(np.zeros((2, 2)), np.zeros((2, 2)))
    assert np.all(flat == 1 + round(254 * math.sin(math.radians(45))))
    lit = bt.hillshade(np.array([[0.5]]), np.array([[-0.5]]))     # rising to the south-east: faces north-west
    dark = bt.hillshade(np.array([[-0.5]]), np.array([[0.5]]))
    assert lit[0, 0] > flat[0, 0] > dark[0, 0]
    assert bt.hillshade(np.array([[np.nan]]), np.array([[0.0]]))[0, 0] == 0


def write_tile(path: Path, x0: float, y0: float, data: np.ndarray) -> None:
    prof = dict(driver="GTiff", dtype="float32", count=1, width=data.shape[1], height=data.shape[0],
                crs=CRS.from_epsg(4326), transform=Affine(RES, 0, x0, 0, -RES, y0))
    with rasterio.open(path, "w", **prof) as d:
        d.write(data.astype(np.float32), 1)


def make_pair(src: Path, n=60) -> None:
    """Two adjacent synthetic tiles forming one east-rising plane of 10 % at about 24° N."""
    dx, _ = bt.spacing(24.0, RES)
    cols = np.arange(2 * n, dtype=np.float64) * float(dx) * 0.10
    z = np.tile(cols[None, :], (n, 1))
    write_tile(src / "Copernicus_DSM_COG_10_N24_00_E054_00_DEM.tif", 54.0, 24.0 + n * RES / 2, z[:, :n])
    write_tile(src / "Copernicus_DSM_COG_10_N24_00_E055_00_DEM.tif", 54.0 + n * RES, 24.0 + n * RES / 2, z[:, n:])


def digest(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def test_tile_borders_use_the_real_neighbours_and_the_mosaic_edge_is_nodata(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    make_pair(src)
    assert bt.main(["--source", str(src), "--out", str(tmp_path / "out"), "--package", "", "--no-visualization"]) == 0
    with rasterio.open(tmp_path / "out/analysis/slope_pct_x100_N24E054.tif") as a, \
            rasterio.open(tmp_path / "out/analysis/slope_pct_x100_N24E055.tif") as b:
        left, right = a.read(1), b.read(1)
        assert a.nodata == bt.SLOPE_NODATA and a.dtypes[0] == "uint16" and a.crs == CRS.from_epsg(4326)
    inner = np.concatenate([left[1:-1, 1:], right[1:-1, :-1]], axis=1)
    # 10 % to within the row-to-row latitude change of dx over a 60" tile (a few hundredths of a percent)
    assert np.all(np.abs(inner.astype(int) - 1000) <= 3)
    assert np.all(left[1:-1, -1] == inner[:, left.shape[1] - 2])   # the shared border is computed like the interior
    assert np.all(left[0, :] == bt.SLOPE_NODATA) and np.all(left[:, 0] == bt.SLOPE_NODATA)
    assert np.all(right[:, -1] == bt.SLOPE_NODATA)


def test_build_is_deterministic(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    make_pair(src)
    outs = []
    for k in ("a", "b"):
        out = tmp_path / k
        assert bt.main(["--source", str(src), "--out", str(out), "--package", "", "--minzoom", "11",
                        "--maxzoom", "13"]) == 0
        outs.append(out)
    for name in ("analysis/slope_pct_x100_N24E054.tif", "analysis/slope_pct_x100_N24E055.tif", "analysis/SHA256SUMS",
                 "visualization/hillshade.pmtiles"):
        assert digest(outs[0] / name) == digest(outs[1] / name), name


def test_load_plan_counts_cells_and_refuses_a_manifest_that_disagrees(tmp_path, capsys):
    import json

    import make_manifest
    import slope_plan

    src = tmp_path / "src"
    src.mkdir()
    make_pair(src)
    out = tmp_path / "out"
    assert bt.main(["--source", str(src), "--out", str(out), "--package", "", "--no-visualization"]) == 0
    capsys.readouterr()
    report = json.loads((out / "build-report.json").read_text(encoding="utf-8"))
    analysis = out / "analysis"

    def plan(manifest: Path) -> tuple[int, dict]:
        rc = slope_plan.main([str(analysis), str(manifest), "16"])
        lines = capsys.readouterr().out.splitlines()
        return rc, dict(line.split("=", 1) for line in lines if "=" in line and not line.startswith("echo"))

    rc, read = plan(tmp_path / "absent.json")           # no manifest: the nodata cells are read from the files
    assert rc == 0 and int(read["CELLS"]) == 2 * 60 * 60
    assert int(read["VALID"]) == 2 * 60 * 60 - sum(t["nodata"] for t in report["tiles"].values())
    files = [{"name": k, "sha256": v, **make_manifest._cells(report, k)} for k, v in report["slope_files"].items()]
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"products": {"analysis": {"files": files}}}), encoding="utf-8")
    rc, counted = plan(manifest)                         # manifest build counts: the same plan
    assert rc == 0 and counted == read
    files[0]["pixels"] += 1
    manifest.write_text(json.dumps({"products": {"analysis": {"files": files}}}), encoding="utf-8")
    assert plan(manifest)[0] == 1
