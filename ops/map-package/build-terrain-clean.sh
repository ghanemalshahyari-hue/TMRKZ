#!/usr/bin/env sh
# One independent, clean build of the terrain products from a commit (owner decision of 7 Nov 2026): a fresh clone of HEAD, its own copy of
# the verified source tiles, a pinned container. Refuses a dirty working tree. Run it twice and compare with compare-builds.py.
#   sh ops/map-package/build-terrain-clean.sh <empty-work-dir>
set -eu
cd "$(dirname "$0")/../.."
W="${1:?an empty work directory}"
[ -z "$(git status --porcelain)" ] || { echo "[build] the working tree is not clean; commit first" >&2; exit 1; }
[ ! -e "$W" ] || { echo "[build] $W exists" >&2; exit 1; }
git clone -q --no-hardlinks . "$W"
mkdir -p "$W/map-data/terrain/glo30" "$W/map-data/basemap"
cp -R map-data/terrain/glo30/source "$W/map-data/terrain/glo30/source"
cp map-data/basemap/uae.pmtiles "$W/map-data/basemap/uae.pmtiles"
docker run --rm -v "$(cd "$W" && pwd)":/src -w /src tmrkz-terrain-tools:dev sh -c '
  python ops/terrain/build_terrain.py --package ""
  python ops/terrain/build_terrain_3d.py
'
git -C "$W" rev-parse HEAD > "$W/BUILT_FROM"
echo "[build] terrain products built from $(cat "$W/BUILT_FROM")"
