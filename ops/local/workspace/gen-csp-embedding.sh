#!/usr/bin/env sh
# Generates /etc/nginx/conf.d/embedding.conf from the database setting.
# Called by web-run.sh before each nginx reload, and by the backend after saving embedding origins.
# Without a database setting, frame-ancestors stays 'none'.
set -eu
OUT="${1:-/etc/nginx/conf.d/embedding.conf}"

# read the allowed origins from the backend API if available
ORIGINS=""
if command -v curl >/dev/null 2>&1; then
  ORIGINS="$(curl -sf --max-time 3 http://backend:8080/api/v1/system/embedding/csp 2>/dev/null || true)"
fi

if [ -n "$ORIGINS" ] && [ "$ORIGINS" != "'none'" ]; then
  FA="'self' $ORIGINS"
else
  FA="'none'"
fi

cat > "$OUT" <<EOF
# Auto-generated embedding CSP (do not edit — managed by the admin UI)
# frame-ancestors: $FA
EOF
echo "$FA"
