#!/usr/bin/env python3
"""Terrain business parity of the packaged terrain dataset (owner gate «PRODUCTION MAP PACKAGING», sections 10 and 20).

Compares, for every deployment area the accepted Stationing requests on tmrkz-test hold, the terrain assessment of
  (A) the acceptance database (tmrkz-test, the dataset loaded on 4 Nov 2026 and used for every accepted request), with
  (P) a disposable database loaded by the production loader (ops/terrain/load-slope.sh) from the INSTALLED map package
      (map-data/runtime/current), and with
  (S) what the server stored at each submission (restationing_revision.checks: shares, controlling class, tie,
      allowance, effective ranges, under the locked policy version).

Per geometry it runs the classifier's own SQL (TerrainClassifier: ST_ValueCount(ST_Clip(rast, geom)) per slope value,
the pixel size and the centroid latitude) in both databases, and derives the assessment exactly as the backend does
(TerrainClassifier.classOf, pixelAreaM2, TerrainRule.decide, DeploymentRules.leg) from the policy version the
revision was locked to. It also fingerprints the complete dataset (every raster tile) in both databases.

Read-only in both databases. Usage: python tests/acceptance/map-package-terrain-parity.py [acc-db] [package-db]
Writes docs/evidence/map-package/terrain-parity/{results.json,PARITY.md}; exit 1 on any difference.
"""
from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path

ACC = sys.argv[1] if len(sys.argv) > 1 else "tmrkz-test-db-1"
PKG = sys.argv[2] if len(sys.argv) > 2 else "tmrkz-terrain-parity"
OUT = Path(__file__).resolve().parents[2] / "docs/evidence/map-package/terrain-parity"
SEP = "\x1f"
A, E2 = 6378137.0, 6.69437999014e-3
TIE = 0.01


def q(db: str, sql: str) -> list[list[str]]:
    r = subprocess.run(["docker", "exec", db, "psql", "-X", "-q", "-U", "mover", "-d", "mover", "-At", "-F", SEP,
                        "-v", "ON_ERROR_STOP=1", "-c", "set default_transaction_read_only = on", "-c", sql],
                       capture_output=True, text=True, encoding="utf-8")
    if r.returncode:
        raise SystemExit(f"{db}: {r.stderr.strip()}")
    return [line.split(SEP) for line in r.stdout.splitlines() if line]


def lit(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def dataset(db: str) -> dict:
    rows = q(db, """select d.id, d.code, d.version, d.surface_model, d.slope_encoding, d.slope_sha256, md5(d.manifest::text),
                           (select count(*) from terrain_slope t where t.dataset_id = d.id)
                      from terrain_dataset d where d.code = 'copernicus-glo30' and d.version = '2026.11'""")
    if not rows:
        raise SystemExit(f"{db}: copernicus-glo30 2026.11 not loaded")
    i, code, ver, model, enc, sha, mmd5, tiles = rows[0]
    fp = q(db, f"""select md5(string_agg(md5(rast::bytea), '' order by ST_UpperLeftY(rast) desc, ST_UpperLeftX(rast))),
                          sum(ST_Count(rast, 1, true))
                     from terrain_slope where dataset_id = '{i}'""")[0]
    return {"id": i, "code": code, "version": ver, "surfaceModel": model, "encoding": enc, "slopeSha256": sha,
            "manifestMd5": mmd5, "tiles": int(tiles), "rasterFingerprint": fp[0], "cellsWithValue": int(fp[1])}


def measure(db: str, ds_id: str, geojson: str) -> dict:
    g = q(db, f"""with g as (select ST_SetSRID(ST_GeomFromGeoJSON({lit(geojson)}), 4326) as geom)
                 select ST_IsValid(geom), GeometryType(geom), ST_Area(geom::geography), ST_Y(ST_Centroid(geom)),
                        (select abs(ST_ScaleX(rast)) from terrain_slope where dataset_id = '{ds_id}' limit 1),
                        (select abs(ST_ScaleY(rast)) from terrain_slope where dataset_id = '{ds_id}' limit 1) from g""")[0]
    counts = q(db, f"""with g as (select ST_SetSRID(ST_GeomFromGeoJSON({lit(geojson)}), 4326) as geom)
                      select (vc).value::int, sum((vc).count)::bigint
                        from (select ST_ValueCount(ST_Clip(t.rast, g.geom), 1, true) as vc
                                from terrain_slope t, g where t.dataset_id = '{ds_id}' and ST_Intersects(t.rast, g.geom)) s
                       group by 1 order by 1""")
    return {"valid": g[0] == "t", "type": g[1], "areaM2": float(g[2]), "lat": float(g[3]), "sx": float(g[4]),
            "sy": float(g[5]), "histogram": {int(v): int(n) for v, n in counts}}


def pixel_area(lat: float, sx: float, sy: float) -> float:
    phi = math.radians(lat)
    s = math.sin(phi)
    w = math.sqrt(1 - E2 * s * s)
    return math.radians(sx) * (A / w) * math.cos(phi) * math.radians(sy) * (A * (1 - E2) / (w * w * w))


def class_of(classes: list[dict], v: int) -> str:
    for c in classes:
        lo = round(c["fromPct"] * 100)
        if v >= lo and (c["toPct"] is None or v < round(c["toPct"] * 100)):
            return c["code"]
    raise ValueError(f"slope value {v} outside the classification")


def assess(m: dict, policy: dict, leg_key: str) -> dict:
    """TerrainClassifier.assess + TerrainRule.decide + DeploymentRules.leg, as the backend computes them."""
    sc = policy["terrainSlopeClassification"]
    classes = sc["classes"]
    cells = {c["code"]: 0 for c in classes}
    for v, n in m["histogram"].items():
        cells[class_of(classes, v)] += n
    covered = sum(cells.values())
    px = pixel_area(m["lat"], m["sx"], m["sy"])
    shares = [(c["code"], cells[c["code"]] * px) for c in classes if cells[c["code"]] > 0]
    order = sorted(shares, key=lambda s: -s[1])  # stable, like the Java sort
    top = order[0][1]
    tied = [code for code, a in order if top - a <= TIE]
    prio = policy["terrainClassPriority"]
    if len(tied) == 1:
        winner, tie, resolved = tied[0], False, True
    else:
        ranked = sorted([t for t in tied if t in prio], key=prio.index)
        resolved = len(ranked) == len(tied)
        winner, tie = (ranked[0] if resolved else tied[0]), True
    allowances = policy["terrainAllowancesM"]
    leg = policy[leg_key]
    add = allowances[winner] if leg["terrainApplies"] else 0
    eff_min = leg["minM"] + (add if policy["terrainAppliesTo"] == "MIN_AND_MAX" else 0)
    eff_max = leg["maxM"] + add
    return {"cells": cells, "covered": covered, "percent": {k: round(v * 100.0 / covered, 6) for k, v in cells.items()},
            "controllingClass": winner, "tie": tie, "tied": tied, "resolved": resolved,
            "allowanceM": allowances[winner] if resolved else 0, "effectiveMinM": eff_min, "effectiveMaxM": eff_max}


def tie_polygon(db: str, ds_id: str, lon: float, lat: float, want: set, policy: dict) -> str | None:
    """A rectangle around two horizontally adjacent cell centres whose classes are `want` (pixel-centre rule: exactly
    those two cells are inside), found in a 40 × 40 cell window at lon/lat."""
    classes = policy["terrainSlopeClassification"]["classes"]
    rows = q(db, f"""with t as (select rast from terrain_slope where dataset_id = '{ds_id}'
                                  and ST_Intersects(rast, ST_SetSRID(ST_MakePoint({lon}, {lat}), 4326)) limit 1),
                         w as (select ST_Clip(rast, ST_Expand(ST_SetSRID(ST_MakePoint({lon}, {lat}), 4326), 20 / 3600.0)) as r from t)
                    select (p).x, (p).y, (p).val, ST_X((p).geom), ST_Y((p).geom), ST_PixelWidth(r)
                      from (select ST_PixelAsCentroids(r, 1, true) as p, r from w) s""")
    cells = {(int(x), int(y)): (int(v), float(cx), float(cy), float(px)) for x, y, v, cx, cy, px in rows}
    for (x, y), (v, cx, cy, px) in sorted(cells.items()):
        right = cells.get((x + 1, y))
        if right and {class_of(classes, v), class_of(classes, right[0])} == want:
            m = 0.3 * px
            x0, x1, y0, y1 = cx - m, right[1] + m, cy - m, cy + m
            return json.dumps({"type": "Polygon", "coordinates": [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]})
    return None


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    da, dp = dataset(ACC), dataset(PKG)
    same_ds = {k: da[k] == dp[k] for k in da if k != "id"}
    policies = {int(v): json.loads(p) for v, p in q(ACC, "select version, policy_values::text from stationing_policy_version")}
    revs = q(ACC, """select r.number, v.n, v.policy_version, v.content::text, v.checks::text
                       from restationing_revision v join restationing_request r on r.id = v.request_id
                      order by r.number, v.n""")
    cases, diffs = [], []
    for number, n, pv, content, checks in revs:
        content, checks = json.loads(content), json.loads(checks)
        for leg in checks.get("legs", []):
            t = leg.get("terrain")
            geom = content.get(leg["leg"])
            if not t or not geom:
                continue
            gj = json.dumps(geom)
            ma, mp = measure(ACC, da["id"], gj), measure(PKG, dp["id"], gj)
            pol = policies[int(pv)]
            ra, rp = assess(ma, pol, leg["leg"]), assess(mp, pol, leg["leg"])
            stored = {"cells": {s["code"]: s["cells"] for s in t["shares"]}, "controllingClass": t["controllingClass"],
                      "tie": t["tie"], "tied": t["tied"], "resolved": t["resolved"], "allowanceM": t["allowanceM"],
                      "effectiveMinM": leg["effectiveMinM"], "effectiveMaxM": leg["effectiveMaxM"]}
            keys = ["cells", "controllingClass", "tie", "tied", "resolved", "allowanceM", "effectiveMinM", "effectiveMaxM"]
            s_vs_a = {k: stored[k] == ra[k] for k in keys}
            a_vs_p = {"histogram": ma["histogram"] == mp["histogram"],
                      "pixel": (ma["sx"], ma["sy"], ma["lat"], ma["areaM2"]) == (mp["sx"], mp["sy"], mp["lat"], mp["areaM2"]),
                      **{k: ra[k] == rp[k] for k in keys}}
            case = {"request": number, "revision": int(n), "policyVersion": int(pv), "leg": leg["leg"], "stored": stored,
                    "acceptance": {**ra, "areaM2": ma["areaM2"], "values": len(ma["histogram"])},
                    "package": {**rp, "areaM2": mp["areaM2"], "values": len(mp["histogram"])},
                    "storedEqualsAcceptance": s_vs_a, "acceptanceEqualsPackage": a_vs_p}
            cases.append(case)
            if not all(s_vs_a.values()) or not all(a_vs_p.values()):
                diffs.append(f"{number} rev {n} {leg['leg']}: stored≠acc {[k for k, v in s_vs_a.items() if not v]}, "
                             f"acc≠pkg {[k for k, v in a_vs_p.items() if not v]}")
    # deployment areas of requests not yet submitted (drafts): acceptance vs package only
    drafts = []
    for number, state, content in q(ACC, """select number, state, content::text from restationing_request
                                             where state in ('DRAFT', 'RETURNED_FOR_CHANGES') order by number"""):
        c = json.loads(content)
        for key in ("primary", "alternative"):
            if c.get(key):
                gj = json.dumps(c[key])
                ma, mp = measure(ACC, da["id"], gj), measure(PKG, dp["id"], gj)
                ra, rp = assess(ma, policies[max(policies)], key), assess(mp, policies[max(policies)], key)
                same = ma["histogram"] == mp["histogram"] and ra == rp
                drafts.append({"request": number, "state": state, "leg": key, "controllingClass": ra["controllingClass"],
                               "tie": ra["tie"], "allowanceM": ra["allowanceM"], "covered": ra["covered"], "same": same})
                if not same:
                    diffs.append(f"{number} ({state}) {key}: acceptance and package differ")
    # constructed ties: no accepted request has one, so two polygons each holding exactly two neighbouring cell centres
    # of different classes (equal areas: a tie, resolved by terrain_class_priority) are assessed in both databases
    ties = []
    pol = policies[max(policies)]
    for name, lon, lat, want in (("Hajar mountains", 56.15, 25.15, {"MOUNTAINOUS", "HILLY"}),
                                 ("inland plain", 55.6, 24.4, {"FLAT", "UNDULATING"})):
        gj = tie_polygon(ACC, da["id"], lon, lat, want, pol)
        if gj is None:
            diffs.append(f"no adjacent {sorted(want)} cells found near {lon},{lat}")
            continue
        ma, mp = measure(ACC, da["id"], gj), measure(PKG, dp["id"], gj)
        ra, rp = assess(ma, pol, "primary"), assess(mp, pol, "primary")
        same = ma["histogram"] == mp["histogram"] and ra == rp
        ties.append({"name": name, "geometry": json.loads(gj), "histogram": ma["histogram"], "acceptance": ra, "package": rp,
                     "same": same})
        if not same or not ra["tie"]:
            diffs.append(f"constructed tie {name}: same={same}, tie={ra['tie']}")
    if not all(same_ds.values()):
        diffs.append(f"dataset differs: {[k for k, v in same_ds.items() if not v]}")
    res = {"acceptanceDb": ACC, "packageDb": PKG, "datasets": {"acceptance": da, "package": dp, "same": same_ds},
           "submittedCases": cases, "draftCases": drafts, "constructedTies": ties, "differences": diffs}
    (OUT / "results.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    lines = ["# Terrain business parity — acceptance dataset vs packaged dataset", "",
             f"Acceptance database `{ACC}` (tmrkz-test) vs disposable database `{PKG}` loaded from the installed package "
             "by ops/terrain/load-slope.sh. Generated by tests/acceptance/map-package-terrain-parity.py.", "",
             "## Dataset", "", "| | acceptance | package | same |", "|---|---|---|---|"]
    for k in ("code", "version", "surfaceModel", "encoding", "slopeSha256", "manifestMd5", "tiles", "cellsWithValue",
              "rasterFingerprint"):
        lines.append(f"| {k} | {da[k]} | {dp[k]} | {'yes' if same_ds[k] else '**NO**'} |")
    lines += ["", "## Submitted revisions (S = stored at submission, A = acceptance DB, P = package DB)", "",
              "| Request | Rev | Leg | Cells covered | Shares (FLAT/UND/ROL/HIL/MTN %) | Class S/A/P | Tie | Allowance m | "
              "Effective range m | S=A | A=P |", "|---|---|---|---|---|---|---|---|---|---|---|"]
    for c in cases:
        a, p, s = c["acceptance"], c["package"], c["stored"]
        pc = "/".join(f"{a['percent'][k]:.1f}" for k in ("FLAT", "UNDULATING", "ROLLING", "HILLY", "MOUNTAINOUS"))
        lines.append(f"| {c['request']} | {c['revision']} | {c['leg']} | {a['covered']} | {pc} | {s['controllingClass']}/"
                     f"{a['controllingClass']}/{p['controllingClass']} | {'tie ' + ','.join(a['tied']) if a['tie'] else 'no'} | "
                     f"{s['allowanceM']:.0f}/{a['allowanceM']:.0f}/{p['allowanceM']:.0f} | {a['effectiveMinM']:.0f}–"
                     f"{a['effectiveMaxM']:.0f} | {'yes' if all(c['storedEqualsAcceptance'].values()) else '**NO**'} | "
                     f"{'yes' if all(c['acceptanceEqualsPackage'].values()) else '**NO**'} |")
    lines += ["", f"## Draft deployment areas (A vs P): {sum(d['same'] for d in drafts)}/{len(drafts)} identical", ""]
    lines += ["## Constructed ties (no accepted request has a tie)", "",
              "| Case | Cells (value: count) | Tie | Tied | Resolved by priority | Class A/P | Allowance A/P | A=P |",
              "|---|---|---|---|---|---|---|---|"]
    for t in ties:
        a, p = t["acceptance"], t["package"]
        lines.append(f"| {t['name']} | {t['histogram']} | {a['tie']} | {','.join(a['tied'])} | {a['resolved']} | "
                     f"{a['controllingClass']}/{p['controllingClass']} | {a['allowanceM']:.0f}/{p['allowanceM']:.0f} | "
                     f"{'yes' if t['same'] else '**NO**'} |")
    lines += ["", "## Result", "", f"{len(cases)} submitted legs, {len(drafts)} draft areas, {len(ties)} constructed ties, "
              f"{len(diffs)} differences." + ("" if not diffs else " " + "; ".join(diffs))]
    (OUT / "PARITY.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines[-3:]))
    return 1 if diffs else 0


if __name__ == "__main__":
    sys.exit(main())
