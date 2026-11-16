#!/usr/bin/env sh
# TMRKZ offline (owner, 16 Nov 2026): this folder IS the offline installation. It carries the images (images/, docker save),
# the newest verified backup with the demo HR data (backups/tmrkz-mover-*/, incl. oracle-hr-demo-data.tgz), the installed
# map (map-data/runtime) and the settings (.env, ops/local/.generated, ops/hr-demo/.generated). Nothing is built or pulled,
# and the application's network has no route out (ops/local/compose.offline.yml).
#   sh ops/local/offline.sh          load missing images, restore the data on a machine that has none, start everything
#   sh ops/local/offline.sh check    prove that the application's network cannot reach the internet
#   sh ops/local/offline.sh stop     stop everything (data kept)
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
HERE="$(pwd -W 2>/dev/null || pwd)"
HR_ENV=ops/hr-demo/.generated/oracle_hr.env
hr() { docker compose -p tmrkz-hr-demo --env-file "$HR_ENV" -f ops/hr-demo/compose.yml "$@"; }
NET=tmrkz-mover_internal

case "${1:-up}" in
  stop)
    [ -f "$HR_ENV" ] && hr stop || true
    docker ps -q --filter label=com.docker.compose.project=tmrkz-mover | xargs -r docker stop >/dev/null
    echo "[offline] stopped (data kept)"; exit 0 ;;
  check)
    echo "[offline] network $NET internal: $(docker network inspect -f '{{.Internal}}' "$NET")"
    if docker run --rm --network "$NET" --entrypoint sh postgis/postgis:17-3.5-alpine \
         -c 'wget -q -T 6 -O /dev/null http://example.com 2>/dev/null || wget -q -T 6 -O /dev/null http://1.1.1.1 2>/dev/null'; then
      echo "[offline] FAIL: a container on the application network reached the internet"; exit 1
    fi
    echo "[offline] ok: no route to the internet from the application network"
    exit 0 ;;
  up) ;;
  *) echo "usage: sh ops/local/offline.sh [up|check|stop]" >&2; exit 2 ;;
esac

# 1. images: loaded from images/ only when missing, each checked against images/SHA256SUMS first
for t in images/*.tar; do
  [ -f "$t" ] || { echo "[offline] no images/ in this folder" >&2; exit 1; }
  docker image inspect "$(cat "$t.id")" >/dev/null 2>&1 && continue
  (cd images && grep " \*\?$(basename "$t")\$" SHA256SUMS | sha256sum -c -) || { echo "[offline] $t is damaged" >&2; exit 1; }
  echo "[offline] loading $t"; docker load -i "$t"
done

# 2. the application network must have no route out; one made earlier by ops/local/up.sh (with a route) is replaced
if docker network inspect "$NET" >/dev/null 2>&1 && [ "$(docker network inspect -f '{{.Internal}}' "$NET")" != true ]; then
  echo "[offline] replacing $NET with an isolated network (containers recreated, data kept)"
  [ -f "$HR_ENV" ] && hr down || true
  docker ps -aq --filter label=com.docker.compose.project=tmrkz-mover | xargs -r docker rm -f >/dev/null
  docker network rm "$NET" >/dev/null
fi

# 3. on a machine without the data: the newest backup that carries the demo HR data
BACKUP="$(ls -d backups/tmrkz-mover-*/ 2>/dev/null | sort | tail -n 1)"; BACKUP="${BACKUP%/}"
RESTORE=""
if [ -z "$(docker volume ls -q --filter name='^tmrkz-mover_db-data$')" ]; then
  [ -n "$BACKUP" ] || { echo "[offline] no data here and no backup in backups/" >&2; exit 1; }
  RESTORE="$BACKUP"; echo "[offline] new machine: restoring $RESTORE"
fi

# 4. the application (ops/local/up.sh: settings, restore, start, readiness, platform accounts) — offline mode
TMRKZ_OFFLINE=1 TMRKZ_RESTORE="$RESTORE" sh ops/local/up.sh

# 5. the demo HR source (ADR-057), its data from the backup on a new machine
if [ -f "$HR_ENV" ]; then
  if [ -z "$(docker volume ls -q --filter name='^tmrkz-hr-demo_oracle-data$')" ] && [ -f "$BACKUP/oracle-hr-demo-data.tgz" ]; then
    (cd "$BACKUP" && sha256sum -c oracle-hr-demo-data.tgz.sha256)
    hr create --pull never
    echo "[offline] restoring the demo HR data"
    docker run --rm -v tmrkz-hr-demo_oracle-data:/data -v "$HERE/$BACKUP:/in:ro" --entrypoint sh postgis/postgis:17-3.5-alpine \
      -c "cd /data && tar xzf /in/oracle-hr-demo-data.tgz"
  fi
  hr up -d --pull never
  echo "[offline] demo HR source started (tmrkz-hr-demo-oracle)"
fi
echo "[offline] TMRKZ is running offline — open $(sed -n 's/^TMRKZ_PUBLIC_URL=//p' .env | tail -n 1) ; check isolation: sh ops/local/offline.sh check"
