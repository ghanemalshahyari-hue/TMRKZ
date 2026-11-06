#!/usr/bin/env python3
"""Builds the TMRKZ offline map package from verified local sources (ops/map-package/sources.json): the UAE street
basemap, the map font, the application's style, the Copernicus GLO-30 terrain products with their provenance, the
optional 3D visual terrain (component terrain-3d, display only), and the licence notices. Nothing is downloaded.

Before copying anything it checks every input against its recorded checksum: the basemap and the font against
sources.json; the 28 GLO-30 source tiles, the slope analysis files and the hillshade against the terrain manifest
(map-packages/terrain-glo30-2026.11/manifest.json); the 3D terrain's Terrain-RGB archive against its record
(map-packages/terrain-3d-glo30-2026.11/manifest.json), whose source tiles must be the terrain manifest's. With
--no-terrain-3d the package has no 3D terrain and its style no `terrain3d` source. The package is assembled in a
temporary directory, verified in full
(package_format.verify) and only then renamed into place. With --archive it also writes a deterministic tar (sorted
members, fixed owner, mode and time) and its .sha256.

Deterministic: the same inputs, revision and SOURCE_DATE_EPOCH give byte-identical files, manifest and tar. Without
SOURCE_DATE_EPOCH the creation time is the build time, which changes only manifest.json (createdAt).

  python ops/map-package/build_package.py [--out map-data/packages] [--archive] [--with-source] [--no-terrain-3d]
         [--terrain-derived DIR] [--terrain-source DIR] [--version 2026.11.2]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(HERE))
import package_format as pf  # noqa: E402
from pmtiles_reader import Reader  # noqa: E402

TOOL_VERSION = "1.1.0"


def fail(msg: str) -> None:
    print(f"[build] FAILED: {msg}", file=sys.stderr)
    sys.exit(1)


def rel(p: str | Path) -> Path:
    p = Path(p)
    return p if p.is_absolute() else REPO / p


def git(*args: str) -> str:
    try:
        return subprocess.run(["git", "-C", str(REPO), *args], capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def created_at() -> str:
    epoch = os.environ.get("SOURCE_DATE_EPOCH")
    t = datetime.fromtimestamp(int(epoch), timezone.utc) if epoch else datetime.now(timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def strip_timings(o):
    """The terrain build report without its run timings ('seconds'), the only part that differs between rebuilds."""
    if isinstance(o, dict):
        return {k: strip_timings(v) for k, v in o.items() if k != "seconds"}
    if isinstance(o, list):
        return [strip_timings(v) for v in o]
    return o


def dumps(o) -> bytes:
    return (json.dumps(o, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def lf(raw: bytes) -> bytes:
    """A git-tracked text file as git stores it (.gitattributes: eol=lf), whatever the working tree's line endings: a
    record written or checked out with CRLF on Windows packages to the same bytes as on Linux."""
    return raw.replace(b"\r\n", b"\n")


def check_inputs(src: dict, derived: Path, source: Path, with_source: bool, terrain3d: bool) -> dict:
    """Every input against its recorded checksum; returns what the manifest records about them."""
    out: dict = {}
    bm = src["basemap"]
    p = rel(bm["path"])
    if not p.is_file() or pf.sha256_file(p) != bm["sha256"]:
        fail(f"basemap {p} missing or not the recorded sha256 {bm['sha256']}")
    rd = Reader(p)
    meta = rd.metadata()
    if meta.get("version") != bm["version"]:
        fail(f"basemap metadata version {meta.get('version')} ≠ recorded {bm['version']}")
    out["basemap"] = (p, rd, meta)
    print(f"[build] basemap ok: {p.name} sha256 {bm['sha256'][:12]}…, Protomaps {meta.get('version')}")
    for f in src["fonts"]:
        fp = rel(f["path"])
        if not fp.is_file() or pf.sha256_file(fp) != f["sha256"]:
            fail(f"font {fp} missing or not the recorded sha256")
    print(f"[build] fonts ok: {len(src['fonts'])}")
    t = src["terrain"]
    tm_path = rel(t["manifest"])
    tm = json.loads(tm_path.read_text(encoding="utf-8"))
    out["terrain_manifest"] = (tm_path, tm)
    bad = []
    tiles = tm["tiles"]
    for tile in tiles:
        tp = source / tile["name"]
        if not tp.is_file() or tp.stat().st_size != tile["bytes"] or pf.sha256_file(tp) != tile["sha256"]:
            bad.append(tile["name"])
    if bad:
        fail(f"source tiles missing or not as recorded in {tm_path.name}: {bad[:5]}")
    extra = sorted({p.name for p in source.glob("Copernicus_DSM_COG_10_*.tif")} - {x["name"] for x in tiles})
    if extra:
        fail(f"source directory holds tiles the terrain manifest does not list: {extra[:5]}")
    print(f"[build] terrain source ok: {len(tiles)} GLO-30 tiles match the recorded sha256 ({sum(x['bytes'] for x in tiles)} bytes)")
    ana = tm["products"]["analysis"]
    adir = derived / "analysis"
    for f in ana["files"]:
        if pf.sha256_file(adir / f["name"]) != f["sha256"]:
            fail(f"slope file {f['name']} differs from the terrain manifest")
    if pf.sha256_file(adir / "SHA256SUMS") != ana["slopeSha256"]:
        fail("analysis SHA256SUMS does not give the recorded slope product checksum")
    hv = tm["products"]["visualization"]["files"][0]
    if pf.sha256_file(derived / "visualization" / hv["name"]) != hv["sha256"]:
        fail("hillshade differs from the terrain manifest")
    print(f"[build] terrain derived ok: {len(ana['files'])} slope files (product {ana['slopeSha256'][:12]}…), hillshade {hv['sha256'][:12]}…")
    absent = json.loads((source / "absent-tiles.json").read_text(encoding="utf-8"))
    cells = {a["cell"]: a.get("verdict") for a in absent.get("absent_cells", [])}
    if cells != {a["cell"]: a["verdict"] for a in tm["absentCells"]}:
        fail("absent-tiles.json disagrees with the terrain manifest's absent cells")
    if terrain3d:
        out["terrain3d"] = check_terrain_3d_input(src, tm)
    return out


def check_terrain_3d_input(src: dict, tm: dict) -> tuple:
    """The 3D visual terrain: the product against its record (size, sha256, PMTiles header), the record's source tiles
    against the terrain manifest (the same 28 GLO-30 tiles as the slope analysis)."""
    t3 = src.get("terrain3d")
    if not t3:
        fail("sources.json has no terrain3d entry (build with --no-terrain-3d for a package without the 3D terrain)")
    rec_path = rel(t3["record"])
    rec_raw = lf(rec_path.read_bytes())
    rec = json.loads(rec_raw.decode("utf-8"))
    prod, df = rec["product"], rec["derivedFrom"]
    pp = rel(t3["derived"]) / prod["file"]
    if not pp.is_file() or pp.stat().st_size != prod["bytes"] or pf.sha256_file(pp) != prod["sha256"]:
        fail(f"3D terrain {pp} missing or not the size/sha256 of its record {rec_path} ({prod['sha256'][:12]}…)")
    if rec.get("kind") != "VISUALIZATION" or prod["mapLibre"] != {"type": "raster-dem", "encoding": "mapbox", "tileSize": 256}:
        fail(f"{rec_path}: not a VISUALIZATION product with a raster-dem/mapbox/256 MapLibre source")
    if (df["dataset"], df["version"]) != (tm["code"], tm["version"]):
        fail(f"{rec_path} derives from {df['dataset']} {df['version']}, the terrain manifest is {tm['code']} {tm['version']}")
    key = lambda t: (t["name"], t["sha256"], t["bytes"])  # noqa: E731
    if sorted(map(key, df["sourceTiles"])) != sorted(map(key, tm["tiles"])):
        fail(f"{rec_path}: its source tiles are not the terrain manifest's {len(tm['tiles'])} GLO-30 tiles")
    h = Reader(pp).header
    if (h.tile_type, h.tile_compression, h.min_zoom, h.max_zoom, h.addressed_tiles) != \
            ("png", "none", prod["minzoom"], prod["maxzoom"], prod["tiles"]):
        fail(f"{pp.name} header ({h.tile_type}, z{h.min_zoom}-{h.max_zoom}, {h.addressed_tiles} tiles) differs from its record")
    print(f"[build] terrain 3d ok: {pp.name} sha256 {prod['sha256'][:12]}… ({prod['bytes']} bytes, {prod['tiles']} tiles "
          f"z{prod['minzoom']}-{prod['maxzoom']}), record {rec_path.name} from the same {len(df['sourceTiles'])} source tiles")
    return pp, rec_raw, rec


def assemble(src: dict, derived: Path, source: Path, with_source: bool, stage: Path, version: str,
             terrain3d: bool = True) -> dict:
    inputs = check_inputs(src, derived, source, with_source, terrain3d)
    pid = f"tmrkz-map-{version}"
    files: list[dict] = []

    def put(relpath: str, data: bytes | None = None, copy_from: Path | None = None):
        dst = stage / relpath
        dst.parent.mkdir(parents=True, exist_ok=True)
        if copy_from is not None:
            shutil.copyfile(copy_from, dst)
        else:
            dst.write_bytes(data)
        files.append({"path": relpath, "component": pf.component_of(relpath)})

    bm_path, rd, meta = inputs["basemap"]
    tm_path, tm = inputs["terrain_manifest"]
    put("basemap/uae.pmtiles", copy_from=bm_path)
    fonts = []
    for f in src["fonts"]:
        name = Path(f["path"]).name
        put(f"fonts/{name}", copy_from=rel(f["path"]))
        raw = rel(f["path"]).read_bytes()
        fonts.append({"file": f"fonts/{name}", "styleName": f["styleName"], "fullName": pf.ttf_name(raw, 4),
                      "family": pf.ttf_name(raw, 1), "version": pf.ttf_name(raw, 5), "covers": f["covers"],
                      "licence": f["licence"], "licenceFile": "licences/OFL-1.1.txt"})
    style_tmp = stage / "styles" / "stationing-v3.json"
    style_tmp.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["node", str(HERE / "export_style.mjs"), str(style_tmp)] + ([] if terrain3d else ["--no-terrain-3d"]),
                   check=True, stdout=subprocess.DEVNULL)
    files.append({"path": "styles/stationing-v3.json", "component": "style"})
    style = json.loads(style_tmp.read_text(encoding="utf-8"))
    ana = tm["products"]["analysis"]
    for f in sorted(ana["files"], key=lambda f: f["name"]):
        put(f"terrain/glo30/analysis/{f['name']}", copy_from=derived / "analysis" / f["name"])
    put("terrain/glo30/analysis/SHA256SUMS", copy_from=derived / "analysis" / "SHA256SUMS")
    put("terrain/glo30/visualization/hillshade.pmtiles", copy_from=derived / "visualization" / "hillshade.pmtiles")
    t3 = None
    if terrain3d:
        t3_path, t3_raw, t3 = inputs["terrain3d"]
        put(pf.T3D_FILE, copy_from=t3_path)
        put(pf.T3D_RECORD, t3_raw)
    put("terrain/glo30/provenance/terrain-manifest.json", copy_from=tm_path)
    report = json.loads((derived / "build-report.json").read_text(encoding="utf-8"))
    put("terrain/glo30/provenance/build-report.json", dumps(strip_timings(report)))
    put("terrain/glo30/provenance/absent-tiles.json", copy_from=source / "absent-tiles.json")
    put("terrain/glo30/provenance/source-verification.json", copy_from=source / "verification.json")
    if with_source:
        for t in sorted(tm["tiles"], key=lambda t: t["name"]):
            put(f"terrain/glo30/source/{t['name']}", copy_from=source / t["name"])
    put("licences/ODbL-1.0-NOTICE.txt", copy_from=rel(src["licences"]["odbl"]))
    put("licences/COPERNICUS-DEM-GLO-30-NOTICE.txt", copy_from=rel(src["terrain"]["notice"]))
    put("licences/OFL-1.1.txt", copy_from=rel(src["fonts"][0]["licenceFile"]))
    lic = tm["licence"]
    street, terrain_attr = style["sources"]["basemap"]["attribution"], style["sources"]["hillshade"]["attribution"]
    put("ATTRIBUTION.txt", attribution_text(pid, meta, src, tm, street, terrain_attr, with_source, terrain3d).encode("utf-8"))

    for f in files:
        p = stage / f["path"]
        f["sha256"], f["size"] = pf.sha256_file(p), p.stat().st_size
    files.sort(key=lambda f: f["path"])
    sums = pf.sums_text(files)
    (stage / "SHA256SUMS").write_bytes(sums)

    h = rd.header
    grid = src["terrain"]["grid"]
    present = sorted(t["code"] for t in tm["tiles"])
    hv = tm["products"]["visualization"]["files"][0]
    hr = Reader(stage / "terrain/glo30/visualization/hillshade.pmtiles").header
    revision = git("rev-parse", "HEAD")
    # the tools and records the package is made from: map tools, terrain tools, the style source, the terrain records
    tree = ["ops/map-package", "ops/terrain", "frontend/src/components/map/maplibre",
            Path(src["terrain"]["manifest"]).parent.as_posix()]
    if terrain3d:
        tree.append(Path(src["terrain3d"]["record"]).parent.as_posix())
    dirty = bool(git("status", "--porcelain", "--", *tree))
    components = [
        {"id": "basemap", "role": "MAP_VISUALIZATION", "required": True,
         "title": "UAE street basemap (offline vector tiles)",
         "format": "PMTiles v3, Mapbox Vector Tiles, Protomaps basemap schema",
         "source": {"product": meta.get("name"), "version": meta.get("version"), "data": src["basemap"]["data"],
                    "builder": f"planetiler {meta.get('planetiler:version')} ({meta.get('planetiler:githash', '')[:12]})",
                    "builtAt": meta.get("planetiler:buildtime"),
                    "osmReplication": f"{meta.get('planetiler:osm:osmosisreplicationtime')} (sequence {meta.get('planetiler:osm:osmosisreplicationseq')})",
                    "obtainedFrom": src["basemap"]["obtainedFrom"]},
         "tiles": {"type": h.tile_type, "compression": h.tile_compression, "minZoom": h.min_zoom, "maxZoom": h.max_zoom,
                   "bounds": list(h.bounds), "addressedTiles": h.addressed_tiles,
                   "layers": sorted(l["id"] for l in meta.get("vector_layers", []))},
         "licence": {"id": "ODbL-1.0", "file": "licences/ODbL-1.0-NOTICE.txt"},
         "roadNames": "OpenStreetMap names, shown as unofficial map labels; not UAE-government authoritative road "
                      "names. No official road-name layer is included."},
        {"id": "fonts", "role": "MAP_VISUALIZATION", "required": True, "title": "Map label font (MapLibre font-faces)",
         "fonts": fonts},
        {"id": "style", "role": "MAP_VISUALIZATION", "required": True, "title": "Stationing V3 map style",
         "file": "styles/stationing-v3.json",
         "generator": "frontend/src/components/map/maplibre/offlineStyle.ts buildOfflineStyle (street mode, Arabic "
                      "labels) with the served paths of mapPackage.ts, exported by ops/map-package/export_style.mjs",
         "use": "the application builds the same style in code; this copy and its checksum record which style the "
                "package was made for", "layers": len(style["layers"])},
        {"id": "terrain-analysis", "role": "BUSINESS_ANALYSIS", "required": True,
         "title": "Slope analysis (the only terrain input of a business rule)",
         "dataset": {"code": src["terrain"]["datasetCode"], "version": tm["version"], "surfaceModel": "DSM",
                     "encoding": tm["processing"]["slope"]["encoding"], "processingVersion": tm["processing"]["version"],
                     "slopeSha256": ana["slopeSha256"], "files": len(ana["files"]),
                     "cellsTotal": ana["cells"]["total"], "cellsNoData": ana["cells"]["nodata"]},
         "format": ana["format"],
         "use": "loaded into PostGIS (terrain_dataset, terrain_slope) by ops/terrain/load-slope.sh; the backend "
                "classifies slope with the administrator's versioned policy. Not served to browsers."},
        {"id": "terrain-visualization", "role": "MAP_VISUALIZATION", "required": True,
         "title": "Hillshade (display only, never a business input)", "format": hv["format"],
         "minZoom": hr.min_zoom, "maxZoom": hr.max_zoom, "tiles": hr.addressed_tiles, "bounds": list(hr.bounds),
         "processingVersion": tm["processing"]["version"]},
        *([terrain3d_component(t3, tm)] if terrain3d else []),
        {"id": "terrain-provenance", "role": "PROVENANCE", "required": True,
         "title": "Copernicus DEM GLO-30 provenance",
         "product": tm["source"]["product"], "instance": tm["source"]["instance"], "surfaceModel": "DSM",
         "limitation": tm["limitation"], "fgic": tm["source"]["fgic"], "publisher": tm["source"]["publisher"],
         "resolution": tm["source"]["resolution"], "crs": tm["source"]["crs"],
         "grid": {"lat": grid["lat"], "lon": grid["lon"]}, "presentCells": present,
         "absentCells": [{"cell": a["cell"], "verdict": a["verdict"]} for a in tm["absentCells"]],
         "sourceTiles": [{"name": t["name"], "code": t["code"], "bytes": t["bytes"], "sha256": t["sha256"],
                          "retrievedAt": t.get("retrievedAt")} for t in sorted(tm["tiles"], key=lambda t: t["name"])],
         "sourceBytes": sum(t["bytes"] for t in tm["tiles"]),
         "sourceTilesIncluded": with_source,
         "processing": {"version": tm["processing"]["version"], "tool": tm["processing"]["tool"]},
         "licence": {"title": lic["title"], "instance": lic["instance"], "url": lic["url"],
                     "documentSha256": lic["documentSha256"], "checkedOn": lic["checkedOn"],
                     "file": "licences/COPERNICUS-DEM-GLO-30-NOTICE.txt"}},
        {"id": "licences", "role": "LEGAL", "required": True, "title": "Attribution and licence notices",
         "notices": {"ATTRIBUTION.txt": "what each component requires",
                     "licences/ODbL-1.0-NOTICE.txt": "OpenStreetMap, ODbL 1.0",
                     "licences/COPERNICUS-DEM-GLO-30-NOTICE.txt": "Copernicus WorldDEM-30 licence, Article 6 (a)-(d)",
                     "licences/OFL-1.1.txt": "Noto Sans Arabic, SIL Open Font License 1.1"}},
    ]
    if with_source:
        components.append({"id": "terrain-source", "role": "PROVENANCE", "required": False,
                           "title": "Unmodified GLO-30 source tiles (archival; not needed at run time)",
                           "attribution": lic["requiredAttribution"]})
    manifest = {
        "format": pf.FORMAT, "formatVersion": pf.FORMAT_VERSION, "packageId": pid, "packageVersion": version,
        "createdAt": created_at(),
        "builtBy": {"tool": "ops/map-package/build_package.py", "toolVersion": TOOL_VERSION,
                    "sourceRevision": revision, "sourceTreeClean": not dirty},
        "compatibility": {**src["compatibility"], "styleSha256": next(f["sha256"] for f in files if f["component"] == "style"),
                          "terrainEncoding": tm["processing"]["slope"]["encoding"]},
        "coverage": {"name": src["coverage"]["name"], "bbox": src["coverage"]["bbox"], "basis": src["coverage"]["basis"],
                     "basemapBounds": list(h.bounds),
                     "terrainGrid": f"N{grid['lat'][0]}-N{grid['lat'][1]} × E{grid['lon'][0]:03d}-E{grid['lon'][1]:03d}"},
        "components": components,
        "attribution": {"file": "ATTRIBUTION.txt", "map": {"street": street, "terrain": terrain_attr},
                        "required": [
                            {"component": "basemap", "text": "© OpenStreetMap contributors (ODbL) · Protomaps"},
                            {"component": "terrain-analysis", "text": lic["modifiedDataAttribution"], "basis": "Copernicus licence Art. 6(b)"},
                            {"component": "terrain-visualization", "text": lic["modifiedDataAttribution"], "basis": "Copernicus licence Art. 6(b)"},
                            *([{"component": "terrain-3d", "text": lic["modifiedDataAttribution"], "basis": "Copernicus licence Art. 6(b)"}]
                              if terrain3d else []),
                            {"component": "terrain-provenance", "text": lic["noLiability"], "basis": "Copernicus licence Art. 6(c)"},
                            {"component": "fonts", "text": "Noto Sans Arabic © 2022 The Noto Project Authors — SIL Open Font License 1.1"}]
                        + ([{"component": "terrain-source", "text": lic["requiredAttribution"], "basis": "Copernicus licence Art. 6(a)"}] if with_source else [])},
        "totals": {"files": len(files), "bytes": sum(f["size"] for f in files)},
        "contentSha256": hashlib.sha256(sums).hexdigest(),
        "files": [{"path": f["path"], "sha256": f["sha256"], "size": f["size"], "component": f["component"]} for f in files],
    }
    (stage / "manifest.json").write_bytes(dumps(manifest))
    return manifest


def terrain3d_component(rec: dict, tm: dict) -> dict:
    prod = rec["product"]
    return {"id": "terrain-3d", "role": "MAP_VISUALIZATION", "required": False,
            "title": "3D visual terrain (Terrain-RGB elevation tiles; display only, never a business input)",
            "code": rec["code"], "version": rec["version"], "file": pf.T3D_FILE, "record": pf.T3D_RECORD,
            "format": prod["format"], "encoding": prod["mapLibre"]["encoding"], "tileSize": prod["mapLibre"]["tileSize"],
            "minZoom": prod["minzoom"], "maxZoom": prod["maxzoom"], "tiles": prod["tiles"], "bounds": prod["bounds"],
            "heightRangeM": prod["heightRangeM"], "processingVersion": rec["processing"]["version"],
            "derivedFrom": f"{tm['code']} {tm['version']}: the same {len(rec['derivedFrom']['sourceTiles'])} GLO-30 source "
                           "tiles as terrain-analysis (terrain-provenance.sourceTiles)",
            "use": "display only: MapLibre terrain (raster-dem source, setTerrain) and displayed elevations; never an input "
                   "to a business rule and never loaded into PostGIS (the slope analysis, terrain-analysis, is)"}


def attribution_text(pid, meta, src, tm, street, terrain_attr, with_source, terrain3d=False) -> str:
    lic = tm["licence"]
    lines = [
        f"TMRKZ offline map package {pid} — attribution and notices",
        "",
        "STREET BASEMAP (basemap/uae.pmtiles)",
        "  © OpenStreetMap contributors. Contains information from OpenStreetMap, made available under the",
        "  Open Database License (ODbL) 1.0 (licences/ODbL-1.0-NOTICE.txt).",
        f"  Tiles: {meta.get('name')} {meta.get('version')}, built with planetiler from OpenStreetMap (replication",
        f"  {meta.get('planetiler:osm:osmosisreplicationtime')}) and Natural Earth.",
        "  Road and place names are OpenStreetMap names shown as unofficial map labels; they are not UAE-government",
        "  authoritative road names.",
        f"  On the map: {street}",
        "",
        "TERRAIN (terrain/glo30/)",
        f"  Source: {tm['source']['product']} ({lic['instance']}), {tm['source']['publisher']}.",
        f"  Licence: {lic['title']} ({lic['url']}; checked {lic['checkedOn']}, sha256 {lic['documentSha256']}).",
        f"  Derived products (slope analysis, hillshade{', 3D terrain' if terrain3d else ''}), Article 6(b): "
        f"{lic['modifiedDataAttribution']}",
        f"  Article 6(c): {lic['noLiability']}",
        f"  {lic['noEndorsement']}",
    ]
    if terrain3d:
        lines += [f"  3D terrain ({pf.T3D_DIR}/): Terrain-RGB elevation tiles from the same GLO-30 source tiles, for the",
                  "  map's 3D view and displayed elevations only; never an input to a business rule."]
    if with_source:
        lines.append(f"  Unmodified source tiles (terrain/glo30/source), Article 6(a): {lic['requiredAttribution']}")
    lines += [
        f"  {tm['limitation']}",
        f"  {tm['source']['fgic']}",
        f"  On the map: {terrain_attr}",
        "  Full notices: licences/COPERNICUS-DEM-GLO-30-NOTICE.txt",
        "",
        "MAP FONT (fonts/NotoSansArabic.ttf)",
        "  Noto Sans Arabic, © 2022 The Noto Project Authors, SIL Open Font License 1.1 (licences/OFL-1.1.txt).",
        "",
    ]
    return "\n".join(lines)


def write_tar(pkg_dir: Path, manifest: dict, out: Path) -> str:
    """A deterministic USTAR archive of the package directory: files only, sorted, root:root, 0644, mtime = createdAt."""
    mtime = int(datetime.strptime(manifest["createdAt"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp())
    pid = manifest["packageId"]
    names = ["manifest.json", "SHA256SUMS"] + [f["path"] for f in manifest["files"]]
    tmp = out.with_name(out.name + ".partial")
    with tarfile.open(tmp, "w", format=tarfile.USTAR_FORMAT) as tf:
        for n in names:
            p = pkg_dir / n
            ti = tarfile.TarInfo(f"{pid}/{n}")
            ti.size, ti.mtime, ti.mode, ti.uid, ti.gid, ti.uname, ti.gname = p.stat().st_size, mtime, 0o644, 0, 0, "", ""
            with open(p, "rb") as f:
                tf.addfile(ti, f)
    os.replace(tmp, out)
    digest = pf.sha256_file(out)
    out.with_name(out.name + ".sha256").write_bytes(f"{digest}  {out.name}\n".encode("utf-8"))  # LF on every host
    return digest


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sources", default=str(HERE / "sources.json"))
    ap.add_argument("--out", default="map-data/packages")
    ap.add_argument("--version", default=None, help="package version (default: sources.json packageVersion)")
    ap.add_argument("--terrain-derived", default=None, help="directory with analysis/, visualization/, build-report.json")
    ap.add_argument("--terrain-source", default=None, help="directory with the GLO-30 tiles, absent-tiles.json, verification.json")
    ap.add_argument("--with-source", action="store_true", help="include the 28 unmodified GLO-30 tiles (archival)")
    ap.add_argument("--no-terrain-3d", action="store_true",
                    help="no 3D visual terrain: no terrain-3d component and no terrain3d source in the style")
    ap.add_argument("--archive", action="store_true", help="also write <package-id>.tar and .tar.sha256")
    ap.add_argument("--replace", action="store_true", help="replace an existing build output of the same id")
    a = ap.parse_args(argv)
    src = json.loads(Path(a.sources).read_text(encoding="utf-8"))
    version = a.version or src["packageVersion"]
    derived = rel(a.terrain_derived or src["terrain"]["derived"])
    source = rel(a.terrain_source or src["terrain"]["source"])
    out = rel(a.out)
    pid = f"tmrkz-map-{version}"
    if not pf.PACKAGE_ID_RE.match(pid):
        fail(f"package id {pid} does not match {pf.PACKAGE_ID_RE.pattern}")
    final = out / pid
    if final.exists() and not a.replace:
        fail(f"{final} exists (use --replace to rebuild it)")
    out.mkdir(parents=True, exist_ok=True)
    work = out / f".partial-{os.getpid()}"
    shutil.rmtree(work, ignore_errors=True)
    stage = work / pid  # the verifier requires the directory to carry the package id
    stage.mkdir(parents=True)
    started = time.time()
    try:
        manifest = assemble(src, derived, source, a.with_source, stage, version, terrain3d=not a.no_terrain_3d)
        r = pf.verify(stage)
        pf.print_result(r)
        if not r.ok:
            fail("the assembled package does not verify; nothing was published")
        if final.exists():
            shutil.rmtree(final)
        os.replace(stage, final)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    print(f"[build] package {pid}: {manifest['totals']['files']} files, {manifest['totals']['bytes']} bytes, "
          f"contentSha256 {manifest['contentSha256']}, manifest sha256 {pf.sha256_file(final / 'manifest.json')}")
    print(f"[build] → {final} ({time.time() - started:.0f} s)")
    if a.archive:
        tar = out / f"{pid}.tar"
        digest = write_tar(final, manifest, tar)
        print(f"[build] archive {tar} sha256 {digest} ({tar.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
