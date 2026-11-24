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
# Default embedding CSP — the background poller overwrites it when the backend reports allowed origins
cat > /etc/nginx/conf.d/embedding.conf <<'NGINX'
map $uri $tmrkz_frame_ancestors {
    default "'none'";
}
NGINX

# Poll the backend every 30 s for embedding-origin changes; reload nginx when they differ
_embedding_poll() {
  _prev="'none'"
  while sleep 30; do
    _fa="$(wget -qO- --timeout=3 http://backend:8080/api/v1/system/embedding/csp 2>/dev/null || true)"
    if [ -n "$_fa" ] && [ "$_fa" != "'none'" ]; then
      _new="'self' $_fa"
    else
      _new="'none'"
    fi
    [ "$_new" = "$_prev" ] && continue
    cat > /etc/nginx/conf.d/embedding.conf <<CONF
map \$uri \$tmrkz_frame_ancestors {
    default "$_new";
}
CONF
    nginx -s reload 2>/dev/null && _prev="$_new"
  done
}
_embedding_poll &

exec /docker-entrypoint.sh "$@"
