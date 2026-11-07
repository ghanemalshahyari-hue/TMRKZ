#!/usr/bin/env sh
# One independent, clean build of the map package from a commit: a fresh clone of HEAD and the terrain products of one clean terrain build
# (build-terrain-clean.sh). Refuses a dirty working tree. Run it twice, each with its own terrain build, and compare with compare-builds.py.
#   sh ops/map-package/build-package-clean.sh <empty-work-dir> <terrain-build-dir>
set -eu
cd "$(dirname "$0")/../.."
W="${1:?an empty work directory}"
T="${2:?a clean terrain build}"
[ -z "$(git status --porcelain)" ] || { echo "[build] the working tree is not clean; commit first" >&2; exit 1; }
[ ! -e "$W" ] || { echo "[build] $W exists" >&2; exit 1; }
git clone -q --no-hardlinks . "$W"
mkdir -p "$W/map-data/basemap"
cp map-data/basemap/uae.pmtiles "$W/map-data/basemap/uae.pmtiles"
cp -R "$T/map-data/terrain" "$W/map-data/terrain"
(cd "$W/frontend" && npm ci --silent --no-audit --no-fund >/dev/null 2>&1)
EPOCH="$(git log -1 --format=%ct)"
(cd "$W" && SOURCE_DATE_EPOCH="$EPOCH" python3 ops/map-package/build_package.py --archive)
git -C "$W" rev-parse HEAD > "$W/BUILT_FROM"
echo "[build] package built from $(cat "$W/BUILT_FROM")"
