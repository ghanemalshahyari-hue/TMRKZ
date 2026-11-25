#!/bin/sh
# The web straight from the source (docker-compose.override.yml, owner 19 Nov 2026). Copies ./frontend into the container
# and builds it there as the web image did (type check, then the bundle) — no dist/ or node_modules/ is written into the
# folder — with the build dependencies of its image (tmrkz/folder-web), offline. The result is published to the web
# server; it builds again a few seconds after a file under ./frontend changes. A build that fails keeps the published
# version. docs/ (without docs/audit, as in the image) and handoff/ are published too, and refreshed when they change.
# A restart of the container (a reboot, docker compose restart) keeps what is published when ./frontend, docs/ and handoff/
# have not changed since: building takes minutes of every core on a small server (the VM slowness check, 23 Nov 2026).
# TMRKZ_BUILD_ONLY=1 builds once and exits with the result (used when the images are packed).
# docker-compose.override.yml mounts this file over the copy in the image, so a change here needs no new tmrkz-images.tar.
set -u
SRC=/workspace/frontend
WORK=/tmp/tmrkz-web
HTML=/out/html
DOCS=/out/docs
BUILT=/tmp/tmrkz-web.built        # the source state (and build switches) of what is published
DOCS_BUILT=/tmp/tmrkz-docs.built
POLL="${TMRKZ_WORKSPACE_POLL_SECONDS:-3}"
key() { echo "$1 ${VITE_STATIONING_V3:-} ${VITE_FLOW_STUDIO:-}"; }

state() {
  find "$SRC" \( -name node_modules -o -name dist -o -name tsconfig.tsbuildinfo \) -prune -o -type f -print0 2>/dev/null \
    | xargs -0 stat -c '%Y %s %n' 2>/dev/null | sort | md5sum
}
docs_state() {
  find /workspace/docs /workspace/handoff -path /workspace/docs/audit -prune -o -type f -print0 2>/dev/null \
    | xargs -0 stat -c '%Y %s %n' 2>/dev/null | sort | md5sum
}

build() {
  [ -d /modules/node_modules ] || { echo "[web] the build dependencies are missing from this image (/modules/node_modules)"; return 1; }
  if [ "$(sha256sum < "$SRC/package-lock.json")" != "$(cat /modules/.package-lock.sha256 2>/dev/null)" ]; then
    echo "[web] NOTE: frontend/package-lock.json changed since the image was made; a new package needs a new"
    echo "      tmrkz-images.tar, made on a connected machine with: sh ops/local/workspace/pack-images.sh"
  fi
  echo "[web] building ./frontend …"
  rm -rf "$WORK" && mkdir -p "$WORK" || return 1
  tar -C "$SRC" --exclude=./node_modules --exclude=./dist --exclude=./tsconfig.tsbuildinfo -cf - . | tar -C "$WORK" -xf - || return 1
  ln -s /modules/node_modules "$WORK/node_modules"
  if ! (cd "$WORK" && npm run -s build); then echo "[web] BUILD FAILED — the published version is kept"; return 1; fi
  [ "${TMRKZ_BUILD_ONLY:-}" = 1 ] && return 0
  find "$HTML" -mindepth 1 -delete 2>/dev/null
  cp -r "$WORK/dist/." "$HTML/" && echo "[web] published"
}

publish_docs() {
  mkdir -p /tmp/docs-next && find /tmp/docs-next -mindepth 1 -delete
  tar -C /workspace/docs --exclude=./audit -cf - . | tar -C /tmp/docs-next -xf - \
    && mkdir -p /tmp/docs-next/handoff && cp -r /workspace/handoff/. /tmp/docs-next/handoff/ || { echo "[web] docs not copied"; return 1; }
  find "$DOCS" -mindepth 1 -delete 2>/dev/null
  cp -r /tmp/docs-next/. "$DOCS/" && find /tmp/docs-next -mindepth 1 -delete && echo "[web] docs published"
}

trap 'exit 0' TERM INT
# ADR-104: when an update changes this script, the new copy takes over at the next check (no container restart)
SELF="$(md5sum < "$0")"
if [ "${TMRKZ_BUILD_ONLY:-}" = 1 ]; then build; exit $?; fi
last="$(state)"
if [ -f "$HTML/index.html" ] && [ "$(cat "$BUILT" 2>/dev/null)" = "$(key "$last")" ]; then
  echo "[web] ./frontend has not changed since the last build — the published version is kept"
else
  until build; do
    while [ "$(state)" = "$last" ]; do sleep "$POLL" & wait $!; done
    sleep 2; last="$(state)"
  done
  key "$last" > "$BUILT"
fi
docs_last="$(docs_state)"
if [ -n "$(ls -A "$DOCS" 2>/dev/null)" ] && [ "$(cat "$DOCS_BUILT" 2>/dev/null)" = "$docs_last" ]; then
  echo "[web] docs have not changed since they were published — kept"
else
  publish_docs && echo "$docs_last" > "$DOCS_BUILT"
fi
n=0
while :; do
  sleep "$POLL" & wait $!
  if [ "$(md5sum < "$0")" != "$SELF" ]; then echo "[web] this script was updated: running the new copy"; exec sh "$0"; fi
  now="$(state)"
  if [ "$now" != "$last" ]; then sleep 2; last="$(state)"; build && key "$last" > "$BUILT"; fi
  n=$((n + 1))
  if [ "$n" -ge 20 ]; then
    n=0; d="$(docs_state)"
    [ "$d" != "$docs_last" ] && { docs_last="$d"; publish_docs && echo "$d" > "$DOCS_BUILT"; }
  fi
done
