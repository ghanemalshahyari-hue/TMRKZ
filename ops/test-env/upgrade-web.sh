#!/usr/bin/env sh
# Swaps the ACCEPTANCE environment's web entry point to another web image, and (for the Stationing V3 page) mounts the
# git-ignored offline map packages under /map-data/ (ops/test-env/compose.v3-maps.yml). Only the web container changes;
# the database and the backend are untouched. The previous image is kept for recovery:
#   sh ops/test-env/upgrade-web.sh <web-image> <label>                 # e.g. mover/web:rel-<sha>-v3
#   MAPS=0 sh ops/test-env/upgrade-web.sh mover/web:1.0.0 <label>      # recovery: the earlier image, no map mount
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
IMAGE="${1:?web image}"
LABEL="${2:?label}"
P="${P:-tmrkz-test}"
case "$P" in tmrkz-mover|tmrkz-mover-*) echo "refused: $P is an owner-retained production project" >&2; exit 2;; esac
IDENT="$(docker exec "$P-db-1" psql -U mover -d mover -At -c "select shobj_description(oid, 'pg_database') from pg_database where datname = 'mover'")"
case "$IDENT" in ACCEPTANCE*) ;; *) echo "refused: $P is not labelled ACCEPTANCE" >&2; exit 2;; esac
docker image inspect "$IMAGE" >/dev/null
EV="docs/evidence/acceptance-upgrade/$LABEL"
mkdir -p "$EV"
. ops/test-env/prepare.sh
OVR="$EV/compose.web-image.yml"
printf 'services:\n  web:\n    image: ${TMRKZ_WEB_IMAGE}\n' > "$OVR"
WD="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$P-web-1" | tr '\\\\' '/')"
CFG="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$P-web-1" | tr '\\\\' '/')"
FILES=""
for f in $(echo "$CFG" | tr ',' ' '); do
  case "$f" in *compose.v3-maps.yml|*compose.web-image.yml) continue;; esac
  FILES="$FILES -f ${f#"$WD/"}"
done
[ "${MAPS:-1}" = 1 ] && FILES="$FILES -f ops/test-env/compose.v3-maps.yml"
log() { echo "[web] $*" | tee -a "$EV/run.log"; }
: > "$EV/run.log"
log "project $P: web $(docker inspect -f '{{.Config.Image}} {{.Image}}' "$P-web-1") → $IMAGE $(docker image inspect -f '{{.Id}}' "$IMAGE")"
log "image revision: $(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}} flag {{index .Config.Labels "tmrkz.stationing-v3"}}' "$IMAGE" 2>/dev/null)"
# shellcheck disable=SC2086
TMRKZ_WEB_IMAGE="$IMAGE" docker compose -p "$P" $FILES -f "$OVR" up -d --no-build --no-deps web >> "$EV/run.log" 2>&1
i=0
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$P-web-1" 2>/dev/null)" = healthy ] \
   && [ "$(docker inspect -f '{{.Config.Image}}' "$P-web-1")" = "$IMAGE" ]; do
  i=$((i + 1)); [ $i -gt 60 ] && { log "web not healthy on $IMAGE"; exit 1; }; sleep 2
done
log "web healthy on $IMAGE; mounts: $(docker inspect -f '{{range .Mounts}}{{.Destination}} {{end}}' "$P-web-1")"
log "health $(curl -s -o /dev/null -w '%{http_code}' "${TMRKZ_PUBLIC_URL:-http://localhost:8088}/healthz"), map package $(curl -s -o /dev/null -w '%{http_code}' -H 'Range: bytes=0-15' "${TMRKZ_PUBLIC_URL:-http://localhost:8088}/map-data/basemap/uae.pmtiles")"
