#!/usr/bin/env sh
# Generates /etc/nginx/conf.d/embedding.conf from the database setting.
# The web container's background poller (map-worker.sh) handles this automatically;
# this script can also be run inside the web container for immediate effect, followed
# by «nginx -s reload».
set -eu
OUT="${1:-/etc/nginx/conf.d/embedding.conf}"

ORIGINS=""
if command -v wget >/dev/null 2>&1; then
  ORIGINS="$(wget -qO- --timeout=3 http://backend:8080/api/v1/system/embedding/csp 2>/dev/null || true)"
elif command -v curl >/dev/null 2>&1; then
  ORIGINS="$(curl -sf --max-time 3 http://backend:8080/api/v1/system/embedding/csp 2>/dev/null || true)"
fi

if [ -n "$ORIGINS" ] && [ "$ORIGINS" != "'none'" ]; then
  FA="'self' $ORIGINS"
else
  FA="'none'"
fi

cat > "$OUT" <<NGINX
# Auto-generated embedding CSP (do not edit — managed by the admin UI)
map \$uri \$tmrkz_frame_ancestors {
    default "$FA";
}
NGINX
echo "$FA"
