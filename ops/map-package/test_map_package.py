"""Tests of the map-package format, verifier and installer: python -m pytest ops/map-package -q

Synthetic packages (a few bytes per file) exercise the layout, manifest, checksum, path-safety and install/restore
rules; the component content checks (PMTiles, font, style, terrain, coverage) run on the real package when it has been
built under map-data/packages/ and are skipped otherwise. The optional 3D terrain is tested on synthetic packages with
real Terrain-RGB tiles (the style and "3d terrain consistent" verdicts) and on the real 2026.11.2 package.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import struct
import sys
import tarfile
import zlib
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import install_package as ip  # noqa: E402
import package_format as pf  # noqa: E402
from pmtiles_reader import Reader, lat_to_y, lon_to_x, zxy_to_tileid  # noqa: E402

REAL = HERE.parent.parent / "map-data" / "packages" / "tmrkz-map-2026.11.1"
REAL_3D = HERE.parent.parent / "map-data" / "packages" / "tmrkz-map-2026.11.2"

FILES = {
    "basemap/uae.pmtiles": b"PMTiles\x03basemap",
    "fonts/NotoSansArabic.ttf": b"\x00\x01\x00\x00font",
    "styles/stationing-v3.json": b'{"version": 8}\n',
    "terrain/glo30/analysis/slope_pct_x100_N24E055.tif": b"II*\x00slope",
    "terrain/glo30/analysis/SHA256SUMS": b"sums\n",
    "terrain/glo30/visualization/hillshade.pmtiles": b"PMTiles\x03shade",
    "terrain/glo30/provenance/terrain-manifest.json": b"{}\n",
    "ATTRIBUTION.txt": b"attribution\n",
    "licences/ODbL-1.0-NOTICE.txt": b"odbl\n",
}


def make(dirpath: Path, version: str = "2026.11.1", files: dict | None = None, mutate=None) -> Path:
    """A structurally valid package directory named after its id."""
    files = dict(FILES if files is None else files)
    pid = f"tmrkz-map-{version}"
    root = dirpath / pid
    root.mkdir(parents=True)
    listed = []
    for p, data in files.items():
        (root / p).parent.mkdir(parents=True, exist_ok=True)
        (root / p).write_bytes(data)
        listed.append({"path": p, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data),
                       "component": pf.component_of(p)})
    listed.sort(key=lambda f: f["path"])
    sums = pf.sums_text(listed)
    (root / "SHA256SUMS").write_bytes(sums)
    comps = sorted({f["component"] for f in listed})
    m = {"format": pf.FORMAT, "formatVersion": pf.FORMAT_VERSION, "packageId": pid, "packageVersion": version,
         "createdAt": "2026-11-05T00:00:00Z", "builtBy": {}, "compatibility": {"servedAt": "/map-data/"},
         "coverage": {"bbox": [51.5, 22.6, 56.4, 26.1]},
         "components": [{"id": c, "role": pf.LAYOUT[c][0], "required": pf.LAYOUT[c][1]} for c in comps],
         "attribution": {}, "totals": {"files": len(listed), "bytes": sum(f["size"] for f in listed)},
         "contentSha256": hashlib.sha256(sums).hexdigest(), "files": listed}
    if mutate:
        mutate(m)
    (root / "manifest.json").write_text(json.dumps(m), encoding="utf-8")
    return root


def tar_of(pkg: Path, out: Path, extra=None) -> Path:
    with tarfile.open(out, "w", format=tarfile.USTAR_FORMAT) as tf:
        for p in sorted(pkg.rglob("*")):
            if p.is_file():
                tf.add(p, f"{pkg.name}/{p.relative_to(pkg).as_posix()}")
        if extra:
            extra(tf)
    return out


def ok(path: Path) -> pf.Result:
    return pf.verify(path, full=True, deep=False)


def test_a_valid_package_verifies_as_directory_and_archive(tmp_path):
    pkg = make(tmp_path / "out")
    assert ok(pkg).ok, ok(pkg).problems
    t = tar_of(pkg, tmp_path / "p.tar")
    assert ok(t).ok, ok(t).problems


def test_unexpected_missing_and_changed_files_are_refused(tmp_path):
    pkg = make(tmp_path / "a")
    (pkg / "basemap" / "extra.pmtiles").write_bytes(b"x")
    assert "layout" in " ".join(ok(pkg).problems)
    pkg = make(tmp_path / "b")
    (pkg / "fonts" / "NotoSansArabic.ttf").unlink()
    assert "missing" in " ".join(ok(pkg).problems)
    pkg = make(tmp_path / "c")
    p = pkg / "terrain/glo30/visualization/hillshade.pmtiles"
    p.write_bytes(p.read_bytes()[:-1] + b"X")  # same size, one byte changed
    r = ok(pkg)
    assert not r.ok and r.problems[0].startswith("checksums")
    assert pf.verify(pkg, full=False, deep=False).ok  # a size-only check cannot see it; installs always hash


@pytest.mark.parametrize("bad", ["../evil.txt", "/etc/passwd", "licences/../../x.txt", "C:/x.txt", "licences\\x.txt",
                                 "basemap/other.pmtiles", "terrain/glo30/source/../../../x"])
def test_paths_outside_the_layout_are_refused_in_the_manifest(tmp_path, bad):
    def mutate(m):
        m["files"][0]["path"] = bad
    pkg = make(tmp_path / "o", mutate=mutate)
    r = ok(pkg)
    assert not r.ok and "manifest structure" in r.problems[0]


def test_malformed_manifests_are_refused(tmp_path):
    for i, mutate in enumerate([
        lambda m: m.update(formatVersion=2),
        lambda m: m.update(unexpected=True),
        lambda m: m.update(packageId="tmrkz-map-x"),
        lambda m: m["files"][0].update(size=pf.LIMITS["file_bytes"] + 1),
        lambda m: m["files"][0].update(sha256="ABC"),
        lambda m: m["totals"].update(files=1),
        lambda m: m["components"].pop(0),
        lambda m: m.update(files=m["files"] + [dict(m["files"][0])]),
    ]):
        pkg = make(tmp_path / str(i), mutate=mutate)
        assert not ok(pkg).ok, i
    pkg = make(tmp_path / "dup")
    (pkg / "manifest.json").write_text('{"format": 1, "format": 2}', encoding="utf-8")
    assert "duplicate JSON key" in " ".join(ok(pkg).problems)
    (pkg / "manifest.json").write_text("{not json", encoding="utf-8")
    assert not ok(pkg).ok


def test_archive_members_that_are_not_plain_files_inside_the_package_are_refused(tmp_path):
    pkg = make(tmp_path / "t")

    def link(tf):
        ti = tarfile.TarInfo(f"{pkg.name}/licences/link.txt")
        ti.type, ti.linkname = tarfile.SYMTYPE, "/etc/passwd"
        tf.addfile(ti)

    def hard(tf):
        ti = tarfile.TarInfo(f"{pkg.name}/licences/hard.txt")
        ti.type, ti.linkname = tarfile.LNKTYPE, f"{pkg.name}/ATTRIBUTION.txt"
        tf.addfile(ti)

    def escape(tf):
        data = b"x"
        ti = tarfile.TarInfo(f"{pkg.name}/../escape.txt")
        ti.size = len(data)
        tf.addfile(ti, io.BytesIO(data))

    def second_root(tf):
        data = b"x"
        ti = tarfile.TarInfo("tmrkz-map-2026.11.9/ATTRIBUTION.txt")
        ti.size = len(data)
        tf.addfile(ti, io.BytesIO(data))

    for i, extra in enumerate([link, hard, escape, second_root]):
        t = tar_of(pkg, tmp_path / f"{i}.tar", extra)
        r = ok(t)
        assert not r.ok and r.problems[0].startswith("only regular files"), (i, r.problems)


def test_links_inside_a_package_directory_are_refused(tmp_path):
    pkg = make(tmp_path / "l")
    target = tmp_path / "outside.txt"
    target.write_text("secret")
    try:
        os.symlink(target, pkg / "licences" / "OFL-1.1.txt")
    except (OSError, NotImplementedError):
        pytest.skip("symbolic links cannot be created here")
    assert not ok(pkg).ok


def test_install_plans_by_default_then_installs_keeps_previous_and_restores(tmp_path, capsys):
    root = tmp_path / "maproot"
    a = make(tmp_path / "pa", "2026.11.1")
    b = make(tmp_path / "pb", "2026.11.2", files={**FILES, "ATTRIBUTION.txt": b"attribution, second package\n"})
    assert ip.install(a, root, None, None, deep=False) == 3
    assert not root.exists()  # a plan writes nothing
    assert ip.install(a, root, str(root), None, deep=False) == 0
    assert json.loads((root / "current/manifest.json").read_text())["packageId"] == "tmrkz-map-2026.11.1"
    assert ip.install(a, root, str(root), None, deep=False) == 0  # the same package again: nothing to do
    assert ip.install(b, root, str(root), None, deep=False) == 0
    assert json.loads((root / "current/manifest.json").read_text())["packageId"] == "tmrkz-map-2026.11.2"
    assert json.loads((root / "previous/manifest.json").read_text())["packageId"] == "tmrkz-map-2026.11.1"
    assert ip.restore_previous(root, None, deep=False) == 3
    assert ip.restore_previous(root, str(root), deep=False) == 0
    assert json.loads((root / "current/manifest.json").read_text())["packageId"] == "tmrkz-map-2026.11.1"
    assert json.loads((root / "previous/manifest.json").read_text())["packageId"] == "tmrkz-map-2026.11.2"
    log = [json.loads(l) for l in (root / "history/install-log.jsonl").read_text().splitlines()]
    assert [e["action"] for e in log] == ["install", "install", "restore-previous"]
    assert sorted(p.name for p in root.iterdir()) == ["current", "history", "previous"]


def test_install_from_an_archive_checks_its_sha256(tmp_path):
    root = tmp_path / "maproot"
    t = tar_of(make(tmp_path / "pa"), tmp_path / "a.tar")
    with pytest.raises(ip.Refused):
        ip.install(t, root, str(root), "0" * 64, deep=False)
    assert ip.install(t, root, str(root), pf.sha256_file(t), deep=False) == 0
    assert ok(root / "current").ok


def test_a_corrupted_package_never_replaces_the_active_one(tmp_path):
    root = tmp_path / "maproot"
    good = make(tmp_path / "g", "2026.11.1")
    assert ip.install(good, root, str(root), None, deep=False) == 0
    bad = make(tmp_path / "b", "2026.11.2")
    (bad / "basemap/uae.pmtiles").write_bytes(b"PMTiles\x03basemaX")
    with pytest.raises(ip.Refused):
        ip.install(bad, root, str(root), None, deep=False)
    assert json.loads((root / "current/manifest.json").read_text())["packageId"] == "tmrkz-map-2026.11.1"
    assert not (root / "previous").exists()
    assert sorted(p.name for p in root.iterdir()) == ["current", "history"]


def test_a_failed_swap_is_undone(tmp_path, monkeypatch):
    root = tmp_path / "maproot"
    assert ip.install(make(tmp_path / "a", "2026.11.1"), root, str(root), None, deep=False) == 0
    real = os.replace

    def flaky(src, dst):
        if Path(src).name.startswith(".staging-"):
            raise PermissionError("in use")
        return real(src, dst)

    monkeypatch.setattr(ip.os, "replace", flaky)
    with pytest.raises(ip.Refused, match="restored unchanged"):
        ip.install(make(tmp_path / "b", "2026.11.2", files={**FILES, "ATTRIBUTION.txt": b"other\n"}), root, str(root), None,
                   deep=False)
    monkeypatch.setattr(ip.os, "replace", real)
    assert json.loads((root / "current/manifest.json").read_text())["packageId"] == "tmrkz-map-2026.11.1"
    assert sorted(p.name for p in root.iterdir()) == ["current", "history"]


def test_dangerous_or_foreign_roots_are_refused(tmp_path):
    pkg = make(tmp_path / "p")
    for root in [Path(Path.cwd().anchor), Path.home(), ip.REPO, Path("relative/root")]:
        with pytest.raises(ip.Refused):
            ip.check_root(root, pkg)
    foreign = tmp_path / "foreign"
    foreign.mkdir()
    (foreign / "notes.txt").write_text("x")
    with pytest.raises(ip.Refused, match="never does"):
        ip.check_root(foreign, pkg)
    with pytest.raises(ip.Refused, match="overlap"):
        ip.check_root(pkg / "maproot", pkg)
    busy = tmp_path / "busy"
    busy.mkdir()
    (busy / ".lock").write_text("1")
    with pytest.raises(ip.Refused, match="another operation"):
        ip.install(pkg, busy, str(busy), None, deep=False)


def test_hilbert_tile_ids_match_the_reference_library():
    ref = pytest.importorskip("pmtiles.tile")
    import random
    rnd = random.Random(7)
    for _ in range(5000):
        z = rnd.randint(0, 16)
        x, y = rnd.randrange(1 << z), rnd.randrange(1 << z)
        assert zxy_to_tileid(z, x, y) == ref.zxy_to_tileid(z, x, y)


@pytest.mark.skipif(not REAL.is_dir(), reason="the real package has not been built (map-data/packages)")
def test_the_real_package_passes_every_content_check():
    r = pf.verify(REAL, full=False, deep=True)
    assert r.ok, r.problems
    names = [c[0] for c in r.checks]
    for need in ("basemap readable", "required fonts present", "style local and consistent", "terrain dataset consistent",
                 "geographic coverage", "attribution and licences"):
        assert need in names
    assert "3d terrain consistent" not in names  # 2026.11.1 has no 3D terrain: the optional check does not run


@pytest.mark.skipif(not REAL_3D.is_dir(), reason="the 3D package has not been built (map-data/packages)")
def test_the_real_3d_package_passes_every_content_check():
    r = pf.verify(REAL_3D, full=False, deep=True)
    assert r.ok, r.problems
    v = {n: d for n, _, d in r.checks}
    assert "none missing" in v["3d terrain consistent"] and "3D terrain source" in v["style local and consistent"]


# ---- the optional 3D visual terrain (component terrain-3d) -----------------------------------------------------------

T3D, REC = pf.T3D_FILE, pf.T3D_RECORD
STREET_ATTR = "© OpenStreetMap contributors (ODbL) · Protomaps"
TERRAIN_ATTR = ("produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH "
                "2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved")
SOURCE_TILES = [{"name": f"Copernicus_DSM_COG_10_N{la}_00_E055_00_DEM.tif", "code": f"N{la}E055", "bytes": la,
                 "sha256": hashlib.sha256(str(la).encode()).hexdigest()} for la in (24, 25)]
BOUNDS_3D = [55.0, 24.0, 57.0, 26.0]   # the product's bounds
COVER_3D = [55.5, 24.5, 56.5, 25.5]    # the package's required extent, inside them
RANGE_3D = [0.0, 175.5]                # tile heights: 0, 50, 100 or 150 m plus 0.1 m a column


def png_rgb(rows: bytes, width: int = 256, height: int = 256) -> bytes:
    """An 8-bit RGB PNG of already filtered rows (one filter byte per row)."""
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return (pf.PNG_SIGNATURE + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def terrain_tile(base: float) -> bytes:
    """A 256 px Mapbox Terrain-RGB tile rising 0.1 m a column from `base`."""
    def rgb(h):
        v = round((h + 10000) * 10)
        return bytes(((v >> 16) & 255, (v >> 8) & 255, v & 255))
    return png_rgb((b"\x00" + b"".join(rgb(base + c * 0.1) for c in range(256))) * 256)


def terrain_rgb_pmtiles(path: Path, skip=(), minz=6, maxz=9) -> dict:
    """A small Terrain-RGB PMTiles made like build_terrain_3d's: every tile of BOUNDS_3D at every zoom."""
    writer = pytest.importorskip("pmtiles.writer")
    from pmtiles.tile import Compression, TileType
    w, s, e, n = BOUNDS_3D
    tiles, per = {}, {}
    for z in range(minz, maxz + 1):
        per[str(z)] = 0
        for x in range(lon_to_x(w, z), lon_to_x(e, z) + 1):
            for y in range(lat_to_y(n, z), lat_to_y(s, z) + 1):
                if (z, x, y) not in skip:
                    tiles[zxy_to_tileid(z, x, y)] = terrain_tile(50.0 * ((x + y) % 4))
                    per[str(z)] += 1
    with open(path, "wb") as f:
        wr = writer.Writer(f)
        for tid in sorted(tiles):
            wr.write_tile(tid, tiles[tid])
        wr.finalize({"tile_type": TileType.PNG, "tile_compression": Compression.NONE,
                     "min_lon_e7": round(w * 1e7), "min_lat_e7": round(s * 1e7), "max_lon_e7": round(e * 1e7),
                     "max_lat_e7": round(n * 1e7)}, {"encoding": "mapbox"})
    return {"minzoom": minz, "maxzoom": maxz, "tiles": len(tiles), "tilesPerZoom": per}


def style_json(with_3d: bool) -> bytes:
    sources = {"basemap": {"type": "vector", "url": "pmtiles:///map-data/basemap/uae.pmtiles", "attribution": STREET_ATTR},
               "hillshade": {"type": "raster", "url": "pmtiles:///map-data/terrain/glo30/visualization/hillshade.pmtiles",
                             "tileSize": 256, "attribution": TERRAIN_ATTR}}
    layers = [{"id": "land", "type": "background"}]
    if with_3d:
        sources["terrain3d"] = {"type": "raster-dem", "url": "pmtiles:///map-data/" + T3D, "tileSize": 256,
                                "encoding": "mapbox", "attribution": TERRAIN_ATTR}
        layers.append({"id": "terrain3d-shade", "type": "hillshade", "source": "terrain3d"})
    return (json.dumps({"version": 8, "sources": sources, "layers": layers}, ensure_ascii=False, indent=2) + "\n").encode()


def make3d(dirpath: Path, component: bool = True, style_3d: bool | None = None, rec_edit=None, comp_edit=None,
           skip=(), extra=None) -> Path:
    """A package with (or without) the 3D terrain: real Terrain-RGB tiles, their record, a style and manifest that agree
    with them. The other components stay synthetic, so only the style and 3D verdicts are meaningful."""
    style_3d = component if style_3d is None else style_3d
    dirpath.mkdir(parents=True, exist_ok=True)
    files = {**FILES, "styles/stationing-v3.json": style_json(style_3d),
             "terrain/glo30/provenance/terrain-manifest.json": b'{"code": "terrain-glo30", "version": "2026.11"}\n'}
    comp3d = {}
    if component:
        info = terrain_rgb_pmtiles(dirpath / "product.pmtiles", skip)
        product = (dirpath / "product.pmtiles").read_bytes()
        comp3d = {"code": "copernicus-glo30-3d", "encoding": "mapbox", "tileSize": 256, "minZoom": info["minzoom"],
                  "maxZoom": info["maxzoom"], "tiles": info["tiles"], "bounds": BOUNDS_3D, "heightRangeM": RANGE_3D}
        rec = {"code": "copernicus-glo30-3d", "version": "2026.11", "kind": "VISUALIZATION",
               "derivedFrom": {"dataset": "terrain-glo30", "version": "2026.11", "sourceTiles": [dict(t) for t in SOURCE_TILES]},
               "product": {"file": "terrain-rgb.pmtiles", "mapLibre": {"type": "raster-dem", "encoding": "mapbox", "tileSize": 256},
                           "minzoom": info["minzoom"], "maxzoom": info["maxzoom"], "bounds": BOUNDS_3D, "tiles": info["tiles"],
                           "tilesPerZoom": info["tilesPerZoom"], "heightRangeM": RANGE_3D, "bytes": len(product),
                           "sha256": hashlib.sha256(product).hexdigest()},
               "licence": {"modifiedDataAttribution": TERRAIN_ATTR}}
        if rec_edit:
            rec_edit(rec)
        files[T3D], files[REC] = product, (json.dumps(rec, indent=2) + "\n").encode()

    def mutate(m):
        m["coverage"]["bbox"] = COVER_3D
        m["compatibility"]["styleSha256"] = hashlib.sha256(files["styles/stationing-v3.json"]).hexdigest()
        m["attribution"] = {"map": {"street": STREET_ATTR, "terrain": TERRAIN_ATTR},
                            "required": [{"component": "terrain-3d", "text": TERRAIN_ATTR}] if component else []}
        for c in m["components"]:
            if c["id"] == "terrain-provenance":
                c["sourceTiles"] = [dict(t) for t in SOURCE_TILES]
            if c["id"] == "terrain-3d":
                c.update(comp3d)
                if comp_edit:
                    comp_edit(c)
        if extra:
            extra(m)
    return make(dirpath, files=files, mutate=mutate)


def verdicts(path: Path) -> dict:
    """check name → (ok, detail) of a full, deep verification."""
    return {n: (ok_, d) for n, ok_, d in pf.verify(path, full=True, deep=True).checks}


def reseal(pkg: Path, record: bool = False) -> None:
    """Re-records every size and checksum in the manifest after a change (with `record`, the 3D record's product too)."""
    if record:
        rec = json.loads((pkg / REC).read_bytes())
        data = (pkg / T3D).read_bytes()
        rec["product"].update(sha256=hashlib.sha256(data).hexdigest(), bytes=len(data))
        (pkg / REC).write_bytes((json.dumps(rec, indent=2) + "\n").encode())
    m = json.loads((pkg / "manifest.json").read_bytes())
    for f in m["files"]:
        data = (pkg / f["path"]).read_bytes()
        f.update(sha256=hashlib.sha256(data).hexdigest(), size=len(data))
    m["files"].sort(key=lambda f: f["path"])
    sums = pf.sums_text(m["files"])
    (pkg / "SHA256SUMS").write_bytes(sums)
    m.update(contentSha256=hashlib.sha256(sums).hexdigest(),
             totals={"files": len(m["files"]), "bytes": sum(f["size"] for f in m["files"])})
    (pkg / "manifest.json").write_text(json.dumps(m), encoding="utf-8")


def test_a_package_with_the_3d_terrain_verifies_as_directory_and_archive(tmp_path):
    pkg = make3d(tmp_path / "a")
    v = verdicts(pkg)
    for name in ("manifest structure", "layout complete and exact", "checksums", "style local and consistent",
                 "3d terrain consistent"):
        assert v[name][0], (name, v[name][1])
    assert "none missing" in v["3d terrain consistent"][1] and "within 0.0..175.5 m" in v["3d terrain consistent"][1]
    t = verdicts(tar_of(pkg, tmp_path / "a.tar"))
    assert t["3d terrain consistent"][0] and "after installation" in t["3d terrain consistent"][1]


def test_a_package_without_the_3d_terrain_still_verifies_and_reports_no_3d_check(tmp_path):
    v = verdicts(make3d(tmp_path / "a", component=False))
    assert v["style local and consistent"][0], v["style local and consistent"]
    assert "3d terrain consistent" not in v
    assert ok(make(tmp_path / "plain")).ok


def test_tampered_3d_tiles_are_refused(tmp_path):
    pkg = make3d(tmp_path / "a")
    rd = Reader(pkg / T3D)
    z = rd.header.max_zoom
    raw = rd.tile(z, lon_to_x(56.0, z), lat_to_y(25.0, z))  # the sample tile at the centre of COVER_3D
    data = bytearray((pkg / T3D).read_bytes())
    at = data.index(raw, rd.header.data_offset) + len(raw) // 2
    data[at] ^= 0xFF  # one byte inside the tile's image data
    (pkg / T3D).write_bytes(bytes(data))
    assert not verdicts(pkg)["checksums"][0]          # as shipped: the manifest's sha256 catches it
    reseal(pkg)                                       # the manifest re-sealed, the record not
    v = verdicts(pkg)
    assert v["checksums"][0] and not v["3d terrain consistent"][0]
    assert "record's product sha256" in v["3d terrain consistent"][1]
    reseal(pkg, record=True)                          # everything re-sealed: the tile itself is refused
    v = verdicts(pkg)
    assert v["checksums"][0] and not v["3d terrain consistent"][0]
    assert "CRC" in v["3d terrain consistent"][1] or "inflate" in v["3d terrain consistent"][1]


@pytest.mark.parametrize("case,rec_edit,comp_edit,expect", [
    ("wrong record sha", lambda r: r["product"].update(sha256="0" * 64), None, "record's product sha256"),
    ("wrong record size", lambda r: r["product"].update(bytes=r["product"]["bytes"] + 1), None, "record's product sha256"),
    ("other source tiles", lambda r: r["derivedFrom"]["sourceTiles"][0].update(sha256="1" * 64), None, "source tiles"),
    ("another dataset", lambda r: r["derivedFrom"].update(version="2027.01"), None, "derives from"),
    ("heights out of range", lambda r: r["product"].update(heightRangeM=[0.0, 10.0]),
     lambda c: c.update(heightRangeM=[0.0, 10.0]), "outside the record's"),
    ("tile size", None, lambda c: c.update(tileSize=512), "tileSize"),
    ("zooms", None, lambda c: c.update(maxZoom=10), "maxZoom"),
    ("not visualization", lambda r: r.update(kind="ANALYSIS"), None, "VISUALIZATION"),
])
def test_a_3d_record_that_does_not_match_the_package_is_refused(tmp_path, case, rec_edit, comp_edit, expect):
    v = verdicts(make3d(tmp_path / "a", rec_edit=rec_edit, comp_edit=comp_edit))
    assert v["checksums"][0], case
    assert not v["3d terrain consistent"][0] and expect in v["3d terrain consistent"][1], (case, v["3d terrain consistent"])


def test_a_missing_finest_zoom_3d_tile_is_refused(tmp_path):
    gap = (9, lon_to_x(55.3, 9), lat_to_y(24.4, 9))   # inside the bounds, not the sample tile
    v = verdicts(make3d(tmp_path / "a", skip={gap}))
    assert not v["3d terrain consistent"][0] and "misses 1 of" in v["3d terrain consistent"][1]


def test_a_missing_3d_record_or_an_extra_file_beside_it_is_refused(tmp_path):
    pkg = make3d(tmp_path / "a")
    (pkg / REC).unlink()                                         # listed but absent
    r = ok(pkg)
    assert not r.ok and r.problems[0].startswith("layout complete and exact") and REC in r.problems[0]
    pkg = make3d(tmp_path / "b")
    (pkg / REC).unlink()                                         # neither present nor listed
    m = json.loads((pkg / "manifest.json").read_bytes())
    m["files"] = [f for f in m["files"] if f["path"] != REC]
    (pkg / "manifest.json").write_text(json.dumps(m), encoding="utf-8")
    reseal(pkg)
    r = ok(pkg)
    assert not r.ok and "must hold exactly" in r.problems[0]
    pkg = make3d(tmp_path / "c")
    (pkg / pf.T3D_DIR / "dem_mosaic.vrt").write_text("<VRTDataset/>")  # on disk, unlisted
    r = ok(pkg)
    assert not r.ok and r.problems[0].startswith("layout complete and exact") and "dem_mosaic.vrt" in r.problems[0]
    m = json.loads((pkg / "manifest.json").read_bytes())         # listed as well
    m["files"].append({"path": pf.T3D_DIR + "/dem_mosaic.vrt", "sha256": "0" * 64, "size": 0, "component": "terrain-3d"})
    (pkg / "manifest.json").write_text(json.dumps(m), encoding="utf-8")
    reseal(pkg)
    r = ok(pkg)
    assert not r.ok and "manifest structure" in r.problems[0] and "not a path of the package layout" in r.problems[0]


def test_the_style_and_the_3d_terrain_must_agree(tmp_path):
    v = verdicts(make3d(tmp_path / "a", component=False, style_3d=True))   # the style names terrain3d, no component
    assert not v["style local and consistent"][0]
    assert "needs the terrain-3d component" in v["style local and consistent"][1]
    v = verdicts(make3d(tmp_path / "b", component=True, style_3d=False))   # the component, no style source
    assert not v["style local and consistent"][0]
    assert "has no 'terrain3d' source" in v["style local and consistent"][1]


def serve_map_root(root: Path, hide=()):
    """A local stand-in for the web entry point: current/ under /map-data/, with byte ranges, never the analysis."""
    import http.server
    import threading

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            rel = self.path.split("?")[0]
            p = root / "current" / rel[len("/map-data/"):]
            if not rel.startswith("/map-data/") or "/analysis/" in rel or rel[len("/map-data/"):] in hide or not p.is_file():
                return self.send_error(404)
            data, rng = p.read_bytes(), self.headers.get("Range")
            if rng:
                a, _, b = rng[len("bytes="):].partition("-")
                a, b = int(a), min(int(b), len(data) - 1)
                body = data[a:b + 1]
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {a}-{b}/{len(data)}")
            else:
                body = data
                self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def for_readiness(m: dict) -> None:
    """The two manifest entries readiness reads beyond the verifier: the terrain dataset and the font files."""
    for c in m["components"]:
        if c["id"] == "terrain-analysis":
            c["dataset"] = {"code": "copernicus-glo30", "version": "2026.11"}
        if c["id"] == "fonts":
            c["fonts"] = [{"file": "fonts/NotoSansArabic.ttf"}]


def test_readiness_requires_the_3d_terrain_when_asked_and_checks_that_it_is_served(tmp_path, capsys):
    import readiness
    plain, with3d = tmp_path / "plain-root", tmp_path / "3d-root"
    assert ip.install(make(tmp_path / "p", mutate=for_readiness), plain, str(plain), None, deep=False) == 0
    assert ip.install(make3d(tmp_path / "q", extra=for_readiness), with3d, str(with3d), None, deep=False) == 0
    capsys.readouterr()
    assert readiness.main(["--root", str(plain), "--quick"]) == 2                          # not asked: no 3D question
    assert "3d terrain present" not in capsys.readouterr().out
    assert readiness.main(["--root", str(plain), "--quick", "--require-terrain-3d"]) == 1  # asked, absent: NOT READY
    assert "[FAIL] 3d terrain present" in capsys.readouterr().out
    srv = serve_map_root(with3d)
    try:
        url = f"http://127.0.0.1:{srv.server_address[1]}"
        assert readiness.main(["--root", str(with3d), "--quick", "--require-terrain-3d", "--url", url]) == 2
        out = capsys.readouterr().out
        assert "[PASS] 3d terrain present" in out and f"[PASS] served {T3D}: range request → 206" in out, out
    finally:
        srv.shutdown()
    srv = serve_map_root(with3d, hide={T3D})
    try:
        url = f"http://127.0.0.1:{srv.server_address[1]}"
        assert readiness.main(["--root", str(with3d), "--quick", "--url", url]) == 1        # carried but not served
        assert f"[FAIL] served {T3D}: range request → 404" in capsys.readouterr().out
    finally:
        srv.shutdown()


def test_the_png_decoder_unfilters_every_filter_type_like_pillow():
    import random
    rnd = random.Random(5)
    w, h = 37, 25                                   # odd sizes; noise and ramps so every predictor matters
    px = bytes(rnd.randrange(256) if i % 5 else (i * 7) % 256 for i in range(w * h * 3))
    stride, rows, prev = w * 3, bytearray(), bytes(w * 3)
    for y in range(h):
        line, ft = px[y * stride:(y + 1) * stride], y % 5
        rows.append(ft)
        for i in range(stride):
            a, b, c = (line[i - 3] if i >= 3 else 0), prev[i], (prev[i - 3] if i >= 3 else 0)
            p = a + b - c
            pred = [0, a, b, (a + b) // 2,
                    a if abs(p - a) <= abs(p - b) and abs(p - a) <= abs(p - c) else b if abs(p - b) <= abs(p - c) else c][ft]
            rows.append((line[i] - pred) & 255)
        prev = line
    png = png_rgb(bytes(rows), w, h)
    assert pf.png_rgb8(png) == (w, h, px)
    image = pytest.importorskip("PIL.Image")
    assert image.open(io.BytesIO(png)).tobytes() == px            # the fixture itself is a valid PNG
    buf = io.BytesIO()
    image.frombytes("RGB", (w, h), px).save(buf, "PNG", compress_level=9)
    assert pf.png_rgb8(buf.getvalue()) == (w, h, px)             # and Pillow's own encoding decodes the same
    buf = io.BytesIO()
    image.frombytes("RGB", (w, h), px).convert("RGBA").save(buf, "PNG")
    with pytest.raises(pf.PackageError, match="colour type 6"):
        pf.png_rgb8(buf.getvalue())
    assert pf.terrain_rgb_range(bytes((1, 134, 160)) * 2) == pytest.approx((0.0, 0.0))
