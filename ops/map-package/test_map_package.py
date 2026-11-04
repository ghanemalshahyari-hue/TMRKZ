"""Tests of the map-package format, verifier and installer: python -m pytest ops/map-package -q

Synthetic packages (a few bytes per file) exercise the layout, manifest, checksum, path-safety and install/restore
rules; the component content checks (PMTiles, font, style, terrain, coverage) run on the real package when it has been
built under map-data/packages/ and are skipped otherwise.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import sys
import tarfile
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import install_package as ip  # noqa: E402
import package_format as pf  # noqa: E402
from pmtiles_reader import zxy_to_tileid  # noqa: E402

REAL = HERE.parent.parent / "map-data" / "packages" / "tmrkz-map-2026.11.1"

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
