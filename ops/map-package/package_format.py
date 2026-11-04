#!/usr/bin/env python3
"""The TMRKZ offline map package format ("tmrkz-offline-map-package", version 1) and its verifier.

A package is one directory named after its package id (or a tar of that directory) holding the basemap, the map font,
the style, the terrain products, their provenance and the licence notices at FIXED paths, plus `manifest.json` (what
each file is, its size and sha256, provenance, licences, coverage, compatibility) and `SHA256SUMS` (the same checksums
for `sha256sum -c`). README.md beside this file describes the layout and every manifest field.

A package is untrusted until it has passed `verify`: only regular files at the paths of the layout below, nothing else
(no links, no devices, no extra or missing files, no path that leaves the package), sizes within limits, the manifest's
own structure, every checksum, and the content of each component (readable PMTiles, font, style with local URLs only,
terrain products matching their provenance, complete coverage, the required attribution). Nothing in a package is ever
executed. Standard library only, so it runs on an isolated host with any Python 3.9+.

  python ops/map-package/package_format.py <package-dir | package.tar> [--quick]
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import stat
import struct
import sys
import tarfile
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pmtiles_reader import PMTilesError, Reader, tile_centre, zxy_to_tileid  # noqa: E402

FORMAT = "tmrkz-offline-map-package"
FORMAT_VERSION = 1
PACKAGE_ID_RE = re.compile(r"^tmrkz-map-(\d{4}\.\d{2}\.\d{1,3}(?:-[a-z0-9]{1,20})?)$")
SEGMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
CREATED_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
CELL_RE = re.compile(r"^N(\d{2})E(\d{3})$")
ROOT_FILES = ("manifest.json", "SHA256SUMS")

# component → (role, required, the only paths it may hold)
LAYOUT: dict[str, tuple[str, bool, re.Pattern]] = {
    "basemap": ("MAP_VISUALIZATION", True, re.compile(r"^basemap/uae\.pmtiles$")),
    "fonts": ("MAP_VISUALIZATION", True, re.compile(r"^fonts/[A-Za-z0-9-]+\.ttf$")),
    "style": ("MAP_VISUALIZATION", True, re.compile(r"^styles/stationing-v3\.json$")),
    "terrain-analysis": ("BUSINESS_ANALYSIS", True,
                         re.compile(r"^terrain/glo30/analysis/(slope_pct_x100_N\d{2}E\d{3}\.tif|SHA256SUMS)$")),
    "terrain-visualization": ("MAP_VISUALIZATION", True, re.compile(r"^terrain/glo30/visualization/hillshade\.pmtiles$")),
    "terrain-provenance": ("PROVENANCE", True, re.compile(
        r"^terrain/glo30/provenance/(terrain-manifest|build-report|absent-tiles|source-verification)\.json$")),
    "terrain-source": ("PROVENANCE", False,
                       re.compile(r"^terrain/glo30/source/Copernicus_DSM_COG_10_N\d{2}_00_E\d{3}_00_DEM\.tif$")),
    "licences": ("LEGAL", True, re.compile(r"^(ATTRIBUTION\.txt|licences/[A-Za-z0-9.-]+\.txt)$")),
}
REQUIRED_COMPONENTS = tuple(c for c, (_, req, _) in LAYOUT.items() if req)
MANIFEST_KEYS = {"format", "formatVersion", "packageId", "packageVersion", "createdAt", "builtBy", "compatibility",
                 "coverage", "components", "attribution", "totals", "contentSha256", "files"}
FILE_KEYS = {"path", "sha256", "size", "component"}
LIMITS = {"files": 400, "file_bytes": 2 * 1024 ** 3, "total_bytes": 8 * 1024 ** 3, "manifest_bytes": 2 * 1024 ** 2,
          "json_bytes": 16 * 1024 ** 2, "path_chars": 240}
# what ATTRIBUTION.txt must say (ODbL notice, the Copernicus licence's Article 6(b) and 6(c), unofficial road names)
ATTRIBUTION_PHRASES = ("© OpenStreetMap contributors", "Open Database License", "unofficial",
                       "produced using Copernicus WorldDEM-30",
                       "do not incur any liability for any use of the Copernicus WorldDEM-30",
                       "Digital Surface Model", "SIL Open Font License")
LICENCE_FILES = ("licences/ODbL-1.0-NOTICE.txt", "licences/COPERNICUS-DEM-GLO-30-NOTICE.txt", "licences/OFL-1.1.txt")


class PackageError(Exception):
    pass


@dataclass
class Result:
    """Every check run, in order: (name, ok, detail). `ok` is False as soon as one check failed."""
    checks: list = field(default_factory=list)
    manifest: dict | None = None

    def add(self, name: str, ok: bool, detail: str = "") -> bool:
        self.checks.append((name, ok, detail))
        return ok

    @property
    def ok(self) -> bool:
        return all(c[1] for c in self.checks)

    @property
    def problems(self) -> list[str]:
        return [f"{n}: {d}" for n, ok, d in self.checks if not ok]


def sha256_file(path: Path, chunk: int = 4 * 1024 * 1024) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while b := f.read(chunk):
            h.update(b)
    return h.hexdigest()


def sha256_stream(f, chunk: int = 4 * 1024 * 1024) -> str:
    h = hashlib.sha256()
    while b := f.read(chunk):
        h.update(b)
    return h.hexdigest()


def _no_duplicates(pairs):
    seen = {}
    for k, v in pairs:
        if k in seen:
            raise PackageError(f"duplicate JSON key {k!r}")
        seen[k] = v
    return seen


def parse_json(raw: bytes, what: str) -> object:
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=_no_duplicates)
    except (UnicodeDecodeError, json.JSONDecodeError, PackageError) as e:
        raise PackageError(f"{what} is not valid JSON: {e}") from None


def path_problem(p: object) -> str | None:
    """Why a package path is not acceptable, or None: relative POSIX, plain segments, inside the fixed layout."""
    if not isinstance(p, str) or not p:
        return "not a path"
    if len(p) > LIMITS["path_chars"] or "\\" in p or "\0" in p or ":" in p or p.startswith("/"):
        return f"{p!r}: absolute, too long or with forbidden characters"
    segs = p.split("/")
    if any(s in ("", ".", "..") or not SEGMENT_RE.match(s) for s in segs):
        return f"{p!r}: a segment is empty, '.', '..' or has forbidden characters"
    if p not in ROOT_FILES and component_of(p) is None:
        return f"{p!r}: not a path of the package layout"
    return None


def component_of(p: str) -> str | None:
    for c, (_, _, rx) in LAYOUT.items():
        if rx.match(p):
            return c
    return None


def sums_text(files: list[dict]) -> bytes:
    return "".join(f"{f['sha256']}  {f['path']}\n" for f in sorted(files, key=lambda f: f["path"])).encode("utf-8")


def validate_manifest(m: object, r: Result) -> bool:
    """The manifest's structure alone (no file access)."""
    if not isinstance(m, dict):
        return r.add("manifest structure", False, "not a JSON object")
    missing, unknown = MANIFEST_KEYS - m.keys(), m.keys() - MANIFEST_KEYS
    if missing or unknown:
        return r.add("manifest structure", False, f"missing {sorted(missing)}, unknown {sorted(unknown)}")
    probs = []
    if m["format"] != FORMAT or m["formatVersion"] != FORMAT_VERSION:
        probs.append(f"format {m['format']!r} v{m['formatVersion']!r}, expected {FORMAT} v{FORMAT_VERSION}")
    pid = PACKAGE_ID_RE.match(str(m["packageId"]))
    if not pid or m["packageVersion"] != pid.group(1):
        probs.append(f"package id {m['packageId']!r} / version {m['packageVersion']!r}")
    if not isinstance(m["createdAt"], str) or not CREATED_RE.match(m["createdAt"]):
        probs.append("createdAt is not an ISO-8601 UTC time (YYYY-MM-DDThh:mm:ssZ)")
    for k in ("builtBy", "compatibility", "coverage", "attribution", "totals"):
        if not isinstance(m[k], dict):
            probs.append(f"{k} is not an object")
    comps = m["components"] if isinstance(m["components"], list) else []
    ids = [c.get("id") for c in comps if isinstance(c, dict)]
    if len(ids) != len(comps) or len(set(ids)) != len(ids):
        probs.append("components: not objects or duplicate ids")
    for c in comps:
        if not isinstance(c, dict):
            continue
        spec = LAYOUT.get(c.get("id"))
        if spec is None:
            probs.append(f"unknown component {c.get('id')!r}")
        elif c.get("role") != spec[0] or c.get("required") is not spec[1]:
            probs.append(f"component {c['id']}: role/required must be {spec[0]}/{spec[1]}")
    for req in REQUIRED_COMPONENTS:
        if req not in ids:
            probs.append(f"required component {req} missing")
    files = m["files"] if isinstance(m["files"], list) else None
    if files is None or not files or len(files) > LIMITS["files"]:
        probs.append(f"files: not a list of 1..{LIMITS['files']} entries")
        files = []
    seen, total, per = set(), 0, {}
    for f in files:
        if not isinstance(f, dict) or set(f.keys()) != FILE_KEYS:
            probs.append(f"file entry {f!r:.80}: keys must be {sorted(FILE_KEYS)}")
            continue
        why = path_problem(f["path"])
        if why or f["path"] in ROOT_FILES:
            probs.append(f"file path {why or f['path'] + ': reserved'}")
            continue
        if component_of(f["path"]) != f["component"] or f["component"] not in ids:
            probs.append(f"{f['path']}: component {f['component']!r} does not hold this path")
        if not isinstance(f["sha256"], str) or not SHA_RE.match(f["sha256"]):
            probs.append(f"{f['path']}: sha256 is not 64 lowercase hex digits")
        if type(f["size"]) is not int or not 0 <= f["size"] <= LIMITS["file_bytes"]:
            probs.append(f"{f['path']}: size outside 0..{LIMITS['file_bytes']}")
        else:
            total += f["size"]
        if f["path"] in seen:
            probs.append(f"{f['path']}: listed twice")
        seen.add(f["path"])
        per[f["component"]] = per.get(f["component"], 0) + 1
    for c in ids:
        if c in LAYOUT and not per.get(c):
            probs.append(f"component {c} holds no file")
    if total > LIMITS["total_bytes"]:
        probs.append(f"total {total} bytes exceeds {LIMITS['total_bytes']}")
    if m["totals"] != {"files": len(files), "bytes": total}:
        probs.append(f"totals {m['totals']} do not match the files ({len(files)} files, {total} bytes)")
    if not isinstance(m["contentSha256"], str) or not SHA_RE.match(m["contentSha256"]):
        probs.append("contentSha256 is not a sha256")
    bbox = m["coverage"].get("bbox") if isinstance(m["coverage"], dict) else None
    if not (isinstance(bbox, list) and len(bbox) == 4 and all(isinstance(v, (int, float)) for v in bbox)
            and -180 <= bbox[0] < bbox[2] <= 180 and -90 <= bbox[1] < bbox[3] <= 90):
        probs.append("coverage.bbox is not [west, south, east, north]")
    return r.add("manifest structure", not probs, "; ".join(probs[:12]) or f"{len(files)} files, {total} bytes")


def comp(m: dict, cid: str) -> dict:
    return next(c for c in m["components"] if c["id"] == cid)


# ---- package access: a directory or a tar, both read through the same small interface ------------------------------

class DirPackage:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.label = str(self.root)

    def scan(self, r: Result) -> dict[str, int] | None:
        """Every file under the root (relative path → size); links, junctions and special files are refused."""
        root = self.root
        try:
            st = os.lstat(root)
        except OSError as e:
            r.add("package present", False, f"{root}: {e.strerror}")
            return None
        if not stat.S_ISDIR(st.st_mode) or _is_link(root):
            r.add("package present", False, f"{root} is not a plain directory")
            return None
        found, bad = {}, []
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            for name in list(dirnames):
                full = Path(dirpath, name)
                if _is_link(full):
                    bad.append(f"{full.relative_to(root).as_posix()}: link or junction")
                    dirnames.remove(name)
            for name in filenames:
                full = Path(dirpath, name)
                rel = full.relative_to(root).as_posix()
                st = os.lstat(full)
                if _is_link(full) or not stat.S_ISREG(st.st_mode):
                    bad.append(f"{rel}: not a regular file")
                elif st.st_nlink > 1 and os.name != "nt":
                    bad.append(f"{rel}: hard link")
                else:
                    found[rel] = st.st_size
        if bad:
            r.add("only regular files", False, "; ".join(bad[:10]))
            return None
        return found

    def read(self, rel: str, limit: int) -> bytes:
        p = self.root / rel
        if p.stat().st_size > limit:
            raise PackageError(f"{rel} is larger than {limit} bytes")
        return p.read_bytes()

    def head(self, rel: str, n: int) -> bytes:
        with open(self.root / rel, "rb") as f:
            return f.read(n)

    def sha256(self, rel: str) -> str:
        return sha256_file(self.root / rel)

    def local(self, rel: str) -> Path | None:
        return self.root / rel


class TarPackage:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.label = str(self.path)
        self.tf = tarfile.open(self.path, "r:")  # uncompressed tar only
        self.members: dict[str, tarfile.TarInfo] = {}
        self.top: str | None = None

    def scan(self, r: Result) -> dict[str, int] | None:
        bad, found = [], {}
        for ti in self.tf.getmembers():
            name = ti.name
            top, _, rel = name.partition("/")
            if self.top is None:
                self.top = top
            if top != self.top or not PACKAGE_ID_RE.match(top) or not rel:
                bad.append(f"{name}: outside the single package directory")
                continue
            if not ti.isreg():
                bad.append(f"{name}: not a regular file (links, directories and devices are refused)")
                continue
            if path_problem(rel):
                bad.append(f"{name}: {path_problem(rel)}")
                continue
            if rel in found:
                bad.append(f"{name}: duplicate member")
                continue
            found[rel] = ti.size
            self.members[rel] = ti
        if bad or not found:
            r.add("only regular files", False, "; ".join(bad[:10]) or "empty archive")
            return None
        return found

    def read(self, rel: str, limit: int) -> bytes:
        ti = self.members[rel]
        if ti.size > limit:
            raise PackageError(f"{rel} is larger than {limit} bytes")
        return self.tf.extractfile(ti).read()

    def head(self, rel: str, n: int) -> bytes:
        return self.tf.extractfile(self.members[rel]).read(n)

    def sha256(self, rel: str) -> str:
        return sha256_stream(self.tf.extractfile(self.members[rel]))

    def local(self, rel: str) -> Path | None:
        return None

    def close(self):
        self.tf.close()


def _is_link(p: Path) -> bool:
    if os.path.islink(p):
        return True
    isj = getattr(os.path, "isjunction", None)
    if isj and isj(p):
        return True
    try:
        attrs = getattr(os.lstat(p), "st_file_attributes", 0)
        return bool(attrs & 0x400)  # FILE_ATTRIBUTE_REPARSE_POINT
    except OSError:
        return False


def open_package(path: Path):
    p = Path(path)
    if p.is_file() and p.suffix == ".tar":
        return TarPackage(p)
    return DirPackage(p)


# ---- verification ---------------------------------------------------------------------------------------------------

def verify(path: Path, full: bool = True, deep: bool = True) -> Result:
    """Verifies a package directory or tar. `full` hashes every file; `deep` also checks each component's content."""
    r = Result()
    pkg = open_package(path)
    try:
        _verify(pkg, r, full, deep)
    except (PackageError, PMTilesError, OSError, tarfile.TarError, KeyError, ValueError) as e:
        r.add("package readable", False, f"{type(e).__name__}: {e}")
    finally:
        if isinstance(pkg, TarPackage):
            pkg.close()
    return r


def _verify(pkg, r: Result, full: bool, deep: bool) -> None:
    found = pkg.scan(r)
    if found is None:
        return
    r.add("package present", True, pkg.label)
    if "manifest.json" not in found:
        r.add("manifest present", False, "no manifest.json at the package root")
        return
    m = parse_json(pkg.read("manifest.json", LIMITS["manifest_bytes"]), "manifest.json")
    if not validate_manifest(m, r):
        return
    r.manifest = m
    if isinstance(pkg, DirPackage) and pkg.root.name not in (m["packageId"], "current", "previous") \
            and not pkg.root.name.startswith(".staging-"):
        r.add("package directory name", False, f"{pkg.root.name!r} is neither the package id nor an install slot")
        return
    if isinstance(pkg, TarPackage) and pkg.top != m["packageId"]:
        r.add("package directory name", False, f"archive directory {pkg.top!r} is not the package id {m['packageId']!r}")
        return
    listed = {f["path"]: f for f in m["files"]}
    extra = sorted(set(found) - set(listed) - set(ROOT_FILES))
    missing = sorted(set(listed) - set(found))
    if not r.add("layout complete and exact", not extra and not missing and "SHA256SUMS" in found,
                 f"unexpected {extra[:8]}, missing {missing[:8]}" if extra or missing else
                 ("no SHA256SUMS" if "SHA256SUMS" not in found else f"{len(found)} files, none unexpected")):
        return
    sizes = [p for p, f in listed.items() if found[p] != f["size"]]
    if not r.add("file sizes", not sizes, f"size differs: {sizes[:8]}" if sizes else "every size as listed"):
        return
    sums = pkg.read("SHA256SUMS", LIMITS["manifest_bytes"])
    if not r.add("SHA256SUMS matches the manifest", sums == sums_text(m["files"])
                 and hashlib.sha256(sums).hexdigest() == m["contentSha256"],
                 "SHA256SUMS differs from the manifest's file list or contentSha256" if sums != sums_text(m["files"])
                 or hashlib.sha256(sums).hexdigest() != m["contentSha256"] else f"contentSha256 {m['contentSha256']}"):
        return
    if full:
        bad = [p for p, f in sorted(listed.items()) if pkg.sha256(p) != f["sha256"]]
        if not r.add("checksums", not bad, f"sha256 differs: {bad[:8]}" if bad else f"all {len(listed)} files"):
            return
    if deep:
        content_checks(pkg, m, r)


def content_checks(pkg, m: dict, r: Result) -> None:
    files = {f["path"]: f for f in m["files"]}
    cov = m["coverage"]
    w, s, e, n = cov["bbox"]

    # basemap: a readable PMTiles of vector tiles that covers the required extent
    def basemap():
        bm = comp(m, "basemap")
        p = pkg.local("basemap/uae.pmtiles")
        if p is None:
            return r.add("basemap readable", True, "checked after installation (archive)")
        rd = Reader(p)
        h, meta = rd.header, rd.metadata()
        b = h.bounds
        probs = []
        if h.tile_type != "mvt":
            probs.append(f"tile type {h.tile_type}, expected mvt")
        if not (b[0] <= w and b[1] <= s and b[2] >= e and b[3] >= n):
            probs.append(f"bounds {b} do not cover {cov['bbox']}")
        if h.max_zoom < 14:
            probs.append(f"max zoom {h.max_zoom} < 14")
        if meta.get("version") != bm["source"]["version"]:
            probs.append(f"metadata version {meta.get('version')} ≠ manifest {bm['source']['version']}")
        z0 = rd.tile(0, 0, 0)
        lon, lat = (w + e) / 2, (s + n) / 2
        import math
        z = 12
        x = int((lon + 180) / 360 * (1 << z))
        y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * (1 << z))
        z12 = rd.tile(z, x, y)
        if not z0 or not z12:
            probs.append("a sample tile (z0, z12 at the coverage centre) is missing")
        layers = sorted(l["id"] for l in meta.get("vector_layers", []))
        for need in ("earth", "water", "roads", "places", "buildings", "landuse", "boundaries"):
            if need not in layers:
                probs.append(f"layer {need} missing")
        return r.add("basemap readable", not probs, "; ".join(probs) or
                     f"PMTiles v3 mvt z{h.min_zoom}-{h.max_zoom}, bounds {list(b)}, Protomaps {meta.get('version')}, "
                     f"{h.addressed_tiles} tiles, sample tiles z0 {len(z0)} B and z12 {len(z12)} B")

    def fonts():
        probs, names = [], []
        for c in comp(m, "fonts")["fonts"]:
            raw = pkg.read(c["file"], 64 * 1024 * 1024)
            if raw[:4] not in (b"\x00\x01\x00\x00", b"true", b"OTTO"):
                probs.append(f"{c['file']}: not a TrueType/OpenType font")
                continue
            fam = ttf_name(raw, 4) or ""
            if c["fullName"] != fam:
                probs.append(f"{c['file']}: font full name {fam!r}, manifest {c['fullName']!r}")
            names.append(fam)
        style = parse_json(pkg.read("styles/stationing-v3.json", LIMITS["json_bytes"]), "style")
        need = set((style.get("font-faces") or {}).keys())
        have = {c["styleName"] for c in comp(m, "fonts")["fonts"]}
        if need - have:
            probs.append(f"the style uses fonts the package lacks: {sorted(need - have)}")
        return r.add("required fonts present", not probs, "; ".join(probs) or f"{', '.join(names)} for {sorted(need)}")

    def style():
        raw = pkg.read("styles/stationing-v3.json", LIMITS["json_bytes"])
        st = parse_json(raw, "style")
        probs, urls = [], []
        def walk(o):
            if isinstance(o, dict):
                for k, v in o.items():
                    if k in ("url", "tiles", "sprite", "glyphs"):
                        urls.extend(v if isinstance(v, list) else [v])
                    walk(v)
            elif isinstance(o, list):
                for v in o:
                    walk(v)
        walk(st)
        served = m["compatibility"]["servedAt"].rstrip("/")
        for u in urls:
            u2 = u[len("pmtiles://"):] if isinstance(u, str) and u.startswith("pmtiles://") else u
            if not isinstance(u2, str) or not u2.startswith(served + "/"):
                probs.append(f"URL {u!r} is not a local package URL under {served}/")
            elif u2[len(served) + 1:] not in files:
                probs.append(f"URL {u!r} names a file the package does not hold")
        if st.get("version") != 8:
            probs.append("not a MapLibre style (version 8)")
        attr = m["attribution"]["map"]
        src = st.get("sources", {})
        if src.get("basemap", {}).get("attribution") != attr["street"] or \
                src.get("hillshade", {}).get("attribution") != attr["terrain"]:
            probs.append("the style's source attributions differ from the manifest's map attribution")
        if hashlib.sha256(raw).hexdigest() != m["compatibility"]["styleSha256"]:
            probs.append("style checksum differs from compatibility.styleSha256")
        return r.add("style local and consistent", not probs, "; ".join(probs[:6]) or
                     f"{len(st.get('layers', []))} layers, {len(urls)} URLs, all under {served}/")

    def terrain():
        ta, tv, tp = comp(m, "terrain-analysis"), comp(m, "terrain-visualization"), comp(m, "terrain-provenance")
        ds = ta["dataset"]
        probs = []
        tm = parse_json(pkg.read("terrain/glo30/provenance/terrain-manifest.json", LIMITS["json_bytes"]), "terrain manifest")
        sums = pkg.read("terrain/glo30/analysis/SHA256SUMS", 1024 * 1024)
        if hashlib.sha256(sums).hexdigest() != ds["slopeSha256"]:
            probs.append("analysis SHA256SUMS does not give the dataset's slopeSha256")
        if tm.get("products", {}).get("analysis", {}).get("slopeSha256") != ds["slopeSha256"]:
            probs.append("terrain manifest names a different slope product")
        listed = {}
        for line in sums.decode("utf-8").splitlines():
            h, _, name = line.partition("  ")
            listed[name] = h
        tifs = {p.rsplit("/", 1)[1]: f["sha256"] for p, f in files.items()
                if f["component"] == "terrain-analysis" and p.endswith(".tif")}
        if listed != tifs:
            probs.append("analysis SHA256SUMS does not list exactly the analysis files of the package")
        tmf = {f["name"]: f["sha256"] for f in tm.get("products", {}).get("analysis", {}).get("files", [])}
        if tmf != tifs:
            probs.append("analysis files differ from the terrain manifest's derived checksums")
        hv = next(iter(tm.get("products", {}).get("visualization", {}).get("files", [])), {})
        if hv.get("sha256") != files["terrain/glo30/visualization/hillshade.pmtiles"]["sha256"]:
            probs.append("hillshade differs from the terrain manifest's derived checksum")
        if tm.get("version") != ds["version"] or tm.get("processing", {}).get("version") != ds["processingVersion"]:
            probs.append("dataset or processing version differs from the terrain manifest")
        if tm.get("source", {}).get("surfaceModel") != "DSM" or ds["surfaceModel"] != "DSM":
            probs.append("the surface model must be recorded as DSM")
        src = {t["name"]: t["sha256"] for t in tp["sourceTiles"]}
        if src != {t["name"]: t["sha256"] for t in tm.get("tiles", [])}:
            probs.append("source tile list differs from the terrain manifest")
        for p, f in files.items():
            if f["component"] == "terrain-source" and src.get(p.rsplit("/", 1)[1]) != f["sha256"]:
                probs.append(f"{p}: source tile checksum differs from the recorded one")
        for p in tifs:
            raw = pkg.head(f"terrain/glo30/analysis/{p}", 8)
            if raw[:4] not in (b"II*\x00", b"MM\x00*"):
                probs.append(f"{p}: not a TIFF")
        return r.add("terrain dataset consistent", not probs, "; ".join(probs[:6]) or
                     f"{ds['code']} {ds['version']} ({ds['surfaceModel']}, {ds['processingVersion']}), "
                     f"{len(tifs)} slope files, product {ds['slopeSha256'][:12]}…, {len(src)} source tiles listed")

    def coverage():
        tp, tv = comp(m, "terrain-provenance"), comp(m, "terrain-visualization")
        present, absent = tp["presentCells"], [a["cell"] for a in tp["absentCells"]]
        lat0, lat1, lon0, lon1 = tp["grid"]["lat"][0], tp["grid"]["lat"][1], tp["grid"]["lon"][0], tp["grid"]["lon"][1]
        grid = {f"N{la:02d}E{lo:03d}" for la in range(lat0, lat1 + 1) for lo in range(lon0, lon1 + 1)}
        probs = []
        if set(present) | set(absent) != grid or set(present) & set(absent):
            probs.append("present and absent cells do not partition the declared grid")
        if any(a["verdict"] != "OPEN_SEA" for a in tp["absentCells"]):
            probs.append("an absent cell is not confirmed open sea")
        slope_cells = {p.rsplit("_", 1)[1][:-4] for p, f in files.items()
                       if f["component"] == "terrain-analysis" and p.endswith(".tif")}
        if slope_cells != set(present):
            probs.append(f"slope files cover {len(slope_cells)} cells, {len(present)} present")
        # every land cell is drawn: each tile of the hillshade's finest zoom whose centre lies in a present cell exists
        p = pkg.local("terrain/glo30/visualization/hillshade.pmtiles")
        detail = ""
        if p is not None:
            rd = Reader(p)
            h = rd.header
            ids, z = rd.tile_ids(), h.max_zoom
            want = gaps = 0
            cells = {(int(c[1:3]), int(c[4:7])) for c in present}
            from pmtiles_reader import lat_to_y, lon_to_x
            for x in range(lon_to_x(lon0, z), lon_to_x(lon1 + 1, z) + 1):
                for y in range(lat_to_y(lat1 + 1, z), lat_to_y(lat0, z) + 1):
                    lon, lat = tile_centre(z, x, y)
                    if (int(lat // 1), int(lon // 1)) in cells:
                        want += 1
                        gaps += zxy_to_tileid(z, x, y) not in ids
            if gaps:
                probs.append(f"hillshade misses {gaps} of {want} z{z} tiles over present cells")
            b = h.bounds
            if not (b[0] <= lon0 + 1e-3 and b[1] <= lat0 + 1e-3 and b[2] >= lon1 + 1 - 1e-3 and b[3] >= lat1 + 1 - 1e-3):
                probs.append(f"hillshade bounds {b} do not cover the grid")
            if h.tile_type != "png" or (h.min_zoom, h.max_zoom) != (tv["minZoom"], tv["maxZoom"]):
                probs.append("hillshade tile type or zooms differ from the manifest")
            detail = f"; hillshade z{z}: {want} tiles over present cells, {gaps} missing"
        bm = comp(m, "basemap")["tiles"]["bounds"]
        if not (bm[0] <= w and bm[1] <= s and bm[2] >= e and bm[3] >= n):
            probs.append("basemap bounds in the manifest do not cover the required extent")
        return r.add("geographic coverage", not probs, "; ".join(probs) or
                     f"required {cov['bbox']} inside the basemap {bm}; terrain grid N{lat0}-N{lat1} × E{lon0:03d}-E{lon1:03d}: "
                     f"{len(present)} present, {len(absent)} open sea ({', '.join(absent)}){detail}")

    def licences():
        probs = []
        att = pkg.read("ATTRIBUTION.txt", 1024 * 1024).decode("utf-8")
        for phrase in ATTRIBUTION_PHRASES:
            if phrase not in att:
                probs.append(f"ATTRIBUTION.txt lacks {phrase!r}")
        for f in LICENCE_FILES:
            if f not in files:
                probs.append(f"{f} missing")
        if files.get(LICENCE_FILES[1]) and "Article 6" not in pkg.read(LICENCE_FILES[1], 1024 * 1024).decode("utf-8") \
                and "6(a)" not in pkg.read(LICENCE_FILES[1], 1024 * 1024).decode("utf-8"):
            probs.append("Copernicus notice lacks the Article 6 notices")
        return r.add("attribution and licences", not probs, "; ".join(probs) or
                     f"ATTRIBUTION.txt and {len(LICENCE_FILES)} licence notices")

    for check in (basemap, fonts, style, terrain, coverage, licences):
        try:
            check()
        except (PackageError, PMTilesError, KeyError, TypeError, ValueError, StopIteration) as ex:
            r.add(check.__name__, False, f"{type(ex).__name__}: {ex}")


def ttf_name(raw: bytes, name_id: int) -> str | None:
    """A name from a TrueType 'name' table (Windows Unicode records first)."""
    try:
        num = struct.unpack_from(">H", raw, 4)[0]
        for i in range(num):
            tag, _, off, ln = struct.unpack_from(">4sIII", raw, 12 + 16 * i)
            if tag == b"name":
                _, count, strings = struct.unpack_from(">HHH", raw, off)
                best = None
                for j in range(count):
                    pid, eid, lid, nid, l2, o2 = struct.unpack_from(">6H", raw, off + 6 + 12 * j)
                    if nid != name_id:
                        continue
                    s = raw[off + strings + o2: off + strings + o2 + l2]
                    if pid == 3:
                        return s.decode("utf-16-be")
                    if pid == 1 and best is None:
                        best = s.decode("latin-1")
                return best
    except struct.error:
        return None
    return None


def print_result(r: Result, out=sys.stdout) -> None:
    for name, ok, detail in r.checks:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}: {detail}", file=out)


def main(argv: list[str]) -> int:
    import argparse
    ap = argparse.ArgumentParser(description="Verifies a TMRKZ offline map package (directory or tar).")
    ap.add_argument("package")
    ap.add_argument("--quick", action="store_true", help="sizes only, no checksums and no content checks")
    a = ap.parse_args(argv)
    r = verify(Path(a.package), full=not a.quick, deep=not a.quick)
    pid = r.manifest["packageId"] if r.manifest else "?"
    print(f"[map-package] verify {a.package} ({pid})")
    print_result(r)
    print(f"[map-package] {'VALID' if r.ok else 'INVALID'}")
    return 0 if r.ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
