#!/usr/bin/env python3
"""Copies the Copernicus GLO-30 tiles TMRKZ reuses from the MOVER dataset, verifying each against MOVER's recorded
provenance (sha256 and size) and the copy byte for byte. Never downloads anything.

  python ops/terrain/package_source.py --from "C:/Users/ADMIN/Desktop/MOVER_1 - Copy/map-source/uae/dem/cop30" \
      --provenance "C:/Users/ADMIN/Desktop/MOVER_1 - Copy/map-library/sources/provenance.json"

Writes map-data/terrain/glo30/source/verification.json; exits 1 if any tile fails verification.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

import rasterio

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_terrain import TILE_RE, sha256, tile_code  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="src", required=True)
    ap.add_argument("--provenance", required=True)
    ap.add_argument("--to", default="map-data/terrain/glo30/source")
    a = ap.parse_args(argv)
    src, dst = Path(a.src), Path(a.to)
    dst.mkdir(parents=True, exist_ok=True)
    prov = json.loads(Path(a.provenance).read_text(encoding="utf-8"))
    entries = {os.path.basename(p["url"]): p for p in prov if "DSM_COG_10" in p.get("url", "")}
    tiles, ok = [], True
    for f in sorted(p for p in src.glob("*.tif") if TILE_RE.search(p.name)):
        s = sha256(f)
        e = entries.get(f.name)
        match = bool(e) and e.get("sha256") == s and e.get("size_bytes") == f.stat().st_size
        target = dst / f.name
        if not target.exists() or sha256(target) != s:
            shutil.copyfile(f, target)
        identical = sha256(target) == s
        with rasterio.open(target) as d:
            meta = dict(width=d.width, height=d.height, dtype=d.dtypes[0], crs=str(d.crs), nodata=d.nodata,
                        resolution_deg=d.res[0], bounds=list(d.bounds), area_or_point=d.tags().get("AREA_OR_POINT"),
                        compress=d.profile.get("compress"))
        tiles.append(dict(tile=f.name, code=tile_code(f), bytes=target.stat().st_size, sha256=s,
                          provenance_sha256=e and e.get("sha256"), provenance_match=match, copy_identical=identical,
                          url=e and e.get("url"), retrieved_at=e and e.get("retrieved_at"), metadata=meta))
        ok &= match and identical
        print(f"{f.name}  {s}  provenance={'OK' if match else 'MISMATCH'}  copy={'OK' if identical else 'DIFF'}")
    first = next(iter(entries.values()), {})
    report = dict(provenance_file=str(Path(a.provenance)).replace("\\", "/"), tiles=tiles,
                  provenance_entries_without_file=sorted(set(entries) - {t["tile"] for t in tiles}),
                  publisher=first.get("publisher"), license_terms=first.get("license_terms"),
                  format=first.get("format"), limitations=first.get("limitations"), all_verified=ok)
    (dst / "verification.json").write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"{len(tiles)} tiles, all verified: {ok}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
