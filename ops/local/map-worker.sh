#!/bin/sh
# Nginx rebuilds its workers' supplementary groups from /etc/group. On shared filesystems such as vboxsf,
# gid-based bind-mount permissions survive only when the nginx account belongs to the mount's group.
set -eu
GID="${TMRKZ_MAP_GID:-0}"
case "$GID" in
  ''|*[!0-9]*) echo "[map-worker] TMRKZ_MAP_GID must be a numeric group id" >&2; exit 1 ;;
esac
if [ "$GID" -gt 0 ]; then
  if getent group tmrkzmap >/dev/null; then
    ACTUAL="$(getent group tmrkzmap | cut -d: -f3)"
    [ "$ACTUAL" = "$GID" ] || { echo "[map-worker] tmrkzmap group id changed; recreate the web container" >&2; exit 1; }
  else
    addgroup -g "$GID" -S tmrkzmap
  fi
  id -Gn nginx | tr ' ' '\n' | grep -qx tmrkzmap || addgroup nginx tmrkzmap
fi
exec /docker-entrypoint.sh "$@"
