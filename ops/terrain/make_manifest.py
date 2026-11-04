#!/usr/bin/env python3
"""Writes the terrain package manifest (map-packages/terrain-glo30-<version>/manifest.json) from the source
verification, the absent-tile evidence and the build report. The large files stay in map-data/ (git-ignored); the
manifest carries their names, sizes and checksums.

  python ops/terrain/make_manifest.py      # after package_source.py, check_absent_tiles.py and build_terrain.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_terrain import (HILLSHADE_ALTITUDE, HILLSHADE_AZIMUTH, PROCESSING_VERSION, SLOPE_ENCODING,  # noqa: E402
                           SLOPE_MAX, SLOPE_NODATA)

LIMITATION = ("Copernicus GLO-30 is a Digital Surface Model (DSM), not bare-earth DTM; it may include buildings, "
              "infrastructure and vegetation. It is not official UAE bare-earth terrain.")
# Article 6 of the licence below, checked against the official PDF on 2026-11-04 (owner next-gate decision): (a) is
# the notice for distributing the source tiles unmodified, (b) the notice for adapted or modified data such as the
# slope analysis and the hillshade, (c) the no-liability sentence every distribution notice carries, (d) no endorsement.
ATTRIBUTION = ("© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the "
               "European Union and ESA; all rights reserved")
MODIFIED = "produced using Copernicus WorldDEM-30 " + ATTRIBUTION
NO_LIABILITY = ("The organisations in charge of the Copernicus programme by law or by delegation do not incur any "
                "liability for any use of the Copernicus WorldDEM-30")
LICENCE = {
    "title": "Licence for Copernicus DEM instance COP-DEM-GLO-30-F Global 30m Full, Free & Open — Licence for the use "
             "of the Copernicus WorldDEM-30",
    "instance": "COP-DEM-GLO-30-F",
    "url": "https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/DEM/resources/license/"
           "License-COPDEM-30.pdf",
    "documentSha256": "9cd37d37ea654bbcaf0a2e059e6a3a5b5f76072824d8dd860ccf274ada8951bd",
    "documentDate": "2020-10-29 (PDF creation and modification date)",
    "checkedOn": "2026-11-04",
    "grants": "Article 4: reproduction, distribution, communication to the general public, adaptation, modification "
              "and combination; Article 5: free of charge",
}


def write_manifest(source: Path, out: Path, package: Path, report: dict | None = None) -> Path:
    ver = json.loads((source / "verification.json").read_text(encoding="utf-8"))
    absent_p = source / "absent-tiles.json"
    absent = json.loads(absent_p.read_text(encoding="utf-8")) if absent_p.exists() else None
    if report is None:
        report = json.loads((out / "build-report.json").read_text(encoding="utf-8"))
    package.mkdir(parents=True, exist_ok=True)
    m = {
        "code": "terrain-glo30",
        "name": "طبيعة الأرض — Copernicus GLO-30 (نموذج سطح DSM)",
        "version": package.name.rsplit("-", 1)[-1],
        "kind": "TERRAIN",
        "status": "Approved fallback production terrain source (owner decision 3, 4 Nov 2026)",
        "source": {
            "product": "Copernicus DEM GLO-30",
            "instance": LICENCE["instance"],
            "dataset": "Copernicus_DSM_COG_10 Cloud Optimized GeoTIFF tiles (AWS Open Data bucket copernicus-dem-30m)",
            "publisher": ver.get("publisher"),
            "surfaceModel": "DSM",
            "release": "not stated in the tile metadata; tiles retrieved 2026-10-04 by MOVER (see tiles[].retrievedAt)",
            "resolution": "1 arc-second (1/3600 degree, about 30 m)",
            "crs": "EPSG:4326",
            "heights": ver.get("format"),
            "gridConvention": "AREA_OR_POINT=Point: each value is the sample at the cell centre",
            "reusedFrom": "MOVER dataset, verified against " + ver.get("provenance_file", ""),
            "fgic": "FGIC data is not used. A future FGIC dataset would be a separate, versioned terrain dataset.",
        },
        "limitation": LIMITATION,
        "licence": {
            **LICENCE,
            "requiredAttribution": ATTRIBUTION,
            "requiredAttributionUse": "Article 6(a): distributing or communicating the source tiles unmodified",
            "modifiedDataAttribution": MODIFIED,
            "modifiedDataAttributionUse": "Article 6(b): the derived products of this package (slope analysis, "
                                          "hillshade) and anything computed from them, including the map attribution",
            "noLiability": NO_LIABILITY,
            "noLiabilityUse": "Article 6(c): in every licence or notice that covers distributing the data, modified "
                              "or not",
            "noEndorsement": "Article 6(d): nothing may suggest that the Copernicus programme, the licensor or the "
                             "provider (Airbus Defence and Space GmbH) endorses this system",
            "moverRecordedTerms": ver.get("license_terms"),
        },
        "coverage": {"tiles": "N22-N26 x E051-E056", "present": len(ver["tiles"]),
                     "absent": [c["cell"] for c in absent["absent_cells"]] if absent else []},
        "absentCells": absent["absent_cells"] if absent else "not checked",
        "tiles": [{"name": t["tile"], "code": t["code"], "bytes": t["bytes"], "sha256": t["sha256"],
                   "provenanceMatch": t["provenance_match"], "retrievedAt": t["retrieved_at"]} for t in ver["tiles"]],
        "processing": {
            "version": PROCESSING_VERSION,
            "tool": "ops/terrain/build_terrain.py (Python, rasterio/GDAL, numpy; ops/terrain/requirements.txt)",
            "mosaic": "VRT of all source tiles; borders read the real neighbouring samples",
            "slope": {
                "algorithm": "Horn 3x3 gradient on the native grid, no resampling",
                "spacing": "per output row from the WGS 84 ellipsoid: dx = dλ·N(φ)·cosφ, dy = dφ·M(φ), φ = row centre",
                "unit": "percent (100·|∇z|)",
                "encoding": SLOPE_ENCODING,
                "value": f"min({SLOPE_MAX}, floor(slope_percent × 100)) as uint16",
                "nodata": f"{SLOPE_NODATA} where any of the nine samples is missing (outer mosaic border, cells next "
                          "to the absent open-sea tiles); nothing is extrapolated",
                "classes": "none baked in: the half-open class thresholds are versioned System Administrator policy "
                           "(terrain_slope_classification) applied by the backend at query time",
            },
            "hillshade": {"azimuthDeg": HILLSHADE_AZIMUTH, "altitudeDeg": HILLSHADE_ALTITUDE, "zFactor": 1,
                          "use": "display only; never an input to a business rule"},
        },
        "products": {
            "analysis": {
                "use": "business rule input (slope classification of deployment areas)",
                "directory": "map-data/terrain/glo30/analysis",
                "format": "GeoTIFF uint16, EPSG:4326, tiled 256, deflate + predictor 2, one file per source tile",
                "files": [{"name": k, "sha256": v, **_cells(report, k)} for k, v in sorted(report["slope_files"].items())],
                "cells": {"total": sum(t["pixels"] for t in report["tiles"].values()),
                          "nodata": sum(t["nodata"] for t in report["tiles"].values()),
                          "definition": "the loader checks these counts in PostGIS before it commits"},
                "sha256sums": "SHA256SUMS",
                "slopeSha256": report["slope_sha256"],
                "slopeSha256Definition": "sha256 of the analysis SHA256SUMS file (sorted 'sha256  name' lines); the "
                                         "loader stores it in terrain_dataset.slope_sha256",
            },
        },
    }
    if report.get("hillshade"):
        h = report["hillshade"]
        m["products"]["visualization"] = {
            "use": "display only (MapLibre raster source); never an input to a business rule",
            "directory": "map-data/terrain/glo30/visualization",
            "files": [{"name": h["file"], "format": "PMTiles v3, PNG (grey + alpha) 256 px, Web Mercator",
                       "minzoom": h["minzoom"], "maxzoom": h["maxzoom"], "tiles": h["tiles"], "bytes": h["bytes"],
                       "sha256": h["sha256"]}],
            "contours": "not produced",
        }
    (package / "manifest.json").write_text(json.dumps(m, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (package / "LICENSE-NOTICE.txt").write_text(
        "Copernicus DEM GLO-30 (" + LICENCE["instance"] + ") — notices\n\n"
        "Licence: " + LICENCE["title"] + "\n" + LICENCE["url"] + "\n"
        "Document sha256 " + LICENCE["documentSha256"] + ", dated " + LICENCE["documentDate"] + "; checked "
        + LICENCE["checkedOn"] + ".\n\n"
        f"Source tiles, unmodified (Article 6(a)):\n{ATTRIBUTION}.\n\n"
        f"Derived products in this package — slope analysis and hillshade (Article 6(b)):\n\"{MODIFIED}\"\n\n"
        f"Liability (Article 6(c)):\n\"{NO_LIABILITY}\"\n\n"
        "No endorsement (Article 6(d)): this system is not endorsed by the Copernicus programme, the licensor or "
        "the provider.\n\nLimitation: " + LIMITATION + " FGIC data is not used.\n", encoding="utf-8")
    return package / "manifest.json"


def _cells(report: dict, name: str) -> dict:
    code = name.removeprefix("slope_pct_x100_").removesuffix(".tif")
    t = report["tiles"][code]
    return {"pixels": t["pixels"], "nodata": t["nodata"]}


if __name__ == "__main__":
    print(write_manifest(Path("map-data/terrain/glo30/source"), Path("map-data/terrain/glo30"),
                         Path(sys.argv[1] if len(sys.argv) > 1 else "map-packages/terrain-glo30-2026.11")))
