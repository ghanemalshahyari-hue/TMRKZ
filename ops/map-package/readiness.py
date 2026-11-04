#!/usr/bin/env python3
"""Production readiness of the offline map: is the installed map package complete and is it the one Stationing uses?

  python ops/map-package/readiness.py --root <map-root> [--url http://localhost:8088] [--db-container <name>]
                                      [--expect-package tmrkz-map-2026.11.1] [--quick]

Package (from <map-root>/current, package_format.verify): package present, manifest valid, required files present (no
file missing or unexpected), checksums valid (every file
hashed unless --quick), basemap readable, required fonts present, style local, terrain dataset consistent, geographic
coverage complete, attribution and licence notices present.

Database (--db-container, read-only): the terrain dataset the package carries is loaded (terrain_dataset row with the
same slope product checksum and its tiles), and the Stationing policy in force names exactly that dataset version.

Served (--url): the web entry point serves this package — the same manifest bytes, PMTiles answered with ranges, the map
font — and does not serve the business slope analysis.

Every required check must pass: one failure makes the result NOT READY (exit 1). Checks that were not asked for are
reported as NOT CHECKED and make the result INCOMPLETE (exit 2); nothing required is ever downgraded to a warning.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import package_format as pf  # noqa: E402

PKG_CHECKS = {  # verifier check → readiness question
    "package present": "package present",
    "manifest structure": "manifest valid",
    "layout complete and exact": "required files present",
    "file sizes": "checksums valid",
    "SHA256SUMS matches the manifest": "checksums valid",
    "checksums": "checksums valid",
    "basemap readable": "basemap readable",
    "required fonts present": "required fonts present",
    "style local and consistent": "style local",
    "terrain dataset consistent": "terrain dataset present",
    "geographic coverage": "geographic coverage valid",
    "attribution and licences": "attribution/licence present",
}


def psql(container: str, sql: str) -> str:
    out = subprocess.run(["docker", "exec", container, "psql", "-X", "-q", "-U", "mover", "-d", "mover", "-At", "-v",
                          "ON_ERROR_STOP=1", "-c", "set default_transaction_read_only = on", "-c", sql],
                         capture_output=True, text=True, encoding="utf-8")
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or f"psql exit {out.returncode}")
    return out.stdout.strip()


def fetch(url: str, rng: str | None = None) -> tuple[int, bytes, dict]:
    req = urllib.request.Request(url, headers={"Range": rng} if rng else {})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, b"", dict(e.headers or {})


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", required=True, help="the map root (its current/ is the active package)")
    ap.add_argument("--url", help="the web entry point, e.g. http://localhost:8088")
    ap.add_argument("--db-container", help="PostgreSQL container of the same environment (read-only queries)")
    ap.add_argument("--expect-package", help="the package id this environment must run")
    ap.add_argument("--quick", action="store_true", help="sizes instead of full checksums and content checks")
    a = ap.parse_args(argv)
    root = Path(a.root).resolve()
    cur = root / "current"
    results: list[tuple[str, str, str]] = []  # (question, PASS|FAIL|NOT CHECKED, detail)

    def add(q, ok, detail):
        results.append((q, "PASS" if ok else "FAIL", detail))

    r = pf.verify(cur, full=not a.quick, deep=not a.quick)
    for name, ok, detail in r.checks:
        add(PKG_CHECKS.get(name, name), ok, detail)
    if not r.checks or r.checks[0][0] != "package present" or not r.checks[0][1]:
        if not any(q == "package present" for q, _, _ in results):
            add("package present", False, f"no package at {cur}")
    m = r.manifest
    if m and a.expect_package:
        add("expected package", m["packageId"] == a.expect_package, f"{m['packageId']} (expected {a.expect_package})")
    ds = next((c["dataset"] for c in (m or {}).get("components", []) if c["id"] == "terrain-analysis"), None)

    if a.db_container and ds:
        try:
            row = psql(a.db_container, f"""select d.slope_sha256, d.surface_model, d.slope_encoding,
                    (select count(*) from terrain_slope t where t.dataset_id = d.id)
               from terrain_dataset d where d.code = '{ds['code']}' and d.version = '{ds['version']}'""")
            if not row:
                add("terrain dataset loaded", False, f"{ds['code']} {ds['version']} is not loaded (ops/terrain/load-slope.sh)")
            else:
                sha, model, enc, tiles = row.split("|")
                add("terrain dataset loaded", sha == ds["slopeSha256"] and model == "DSM" and enc == ds["encoding"]
                    and int(tiles) > 0, f"{ds['code']} {ds['version']}: product {sha[:12]}… "
                    f"({'same as' if sha == ds['slopeSha256'] else 'DIFFERENT from'} the package), {model}, {enc}, {tiles} tiles")
            pol = psql(a.db_container, """select version, policy_values->'terrainSlopeClassification'->>'datasetCode',
                        policy_values->'terrainSlopeClassification'->>'datasetVersion'
                   from stationing_policy_version where effective_from <= now() order by version desc limit 1""")
            if not pol:
                add("terrain version expected", False, "no Stationing policy in force")
            else:
                v, code, ver = pol.split("|")
                add("terrain version expected", (code, ver) == (ds["code"], ds["version"]),
                    f"policy v{v} in force names {code} {ver}; the package carries {ds['code']} {ds['version']}")
        except (RuntimeError, OSError, ValueError) as e:
            add("terrain dataset loaded", False, f"database query failed: {e}")
    else:
        for q in ("terrain dataset loaded", "terrain version expected"):
            results.append((q, "NOT CHECKED", "no --db-container given" if not a.db_container else "no package manifest"))

    if a.url and m:
        base = a.url.rstrip("/") + m["compatibility"]["servedAt"].rstrip("/")
        try:
            st, body, _ = fetch(base + "/manifest.json")
            add("served package is the installed one", st == 200 and body == (cur / "manifest.json").read_bytes(),
                f"GET /map-data/manifest.json → {st}, {'identical to' if body == (cur / 'manifest.json').read_bytes() else 'DIFFERENT from'} {cur / 'manifest.json'}")
            for path, magic in (("basemap/uae.pmtiles", b"PMTiles"), ("terrain/glo30/visualization/hillshade.pmtiles", b"PMTiles")):
                st, body, h = fetch(f"{base}/{path}", "bytes=0-126")
                add(f"served {path}", st == 206 and body.startswith(magic), f"range request → {st}, {len(body)} bytes, "
                    f"{h.get('Content-Range', 'no Content-Range')}")
            for f in next(c for c in m["components"] if c["id"] == "fonts")["fonts"]:
                st, body, _ = fetch(f"{base}/{f['file']}")
                add(f"served {f['file']}", st == 200 and body == (cur / f["file"]).read_bytes(), f"GET → {st}, {len(body)} bytes")
            probe = next(p["path"] for p in m["files"] if p["component"] == "terrain-analysis" and p["path"].endswith(".tif"))
            st, _, _ = fetch(f"{base}/{probe}", "bytes=0-7")
            add("business analysis not served", st in (403, 404), f"GET /map-data/{probe} → {st}")
        except (urllib.error.URLError, OSError) as e:
            add("served package is the installed one", False, f"{base}: {e}")
    else:
        results.append(("served package is the installed one", "NOT CHECKED", "no --url given"))

    print(f"[readiness] offline map: root {root}" + (f", package {m['packageId']} ({m['contentSha256']})" if m else ""))
    for q, verdict, detail in results:
        print(f"  [{verdict}] {q}: {detail}")
    failed = [q for q, v, _ in results if v == "FAIL"]
    unchecked = [q for q, v, _ in results if v == "NOT CHECKED"]
    if failed:
        print(f"[readiness] NOT READY: {len(failed)} failed ({', '.join(dict.fromkeys(failed))})")
        return 1
    if unchecked:
        print(f"[readiness] INCOMPLETE: not checked: {', '.join(unchecked)}")
        return 2
    print(f"[readiness] READY: {len(results)} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
