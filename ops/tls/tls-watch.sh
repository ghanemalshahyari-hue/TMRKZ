#!/bin/sh
# The https entry point (ADR-051) with a certificate watcher (ADR-105): when «الشهادات» in the browser installs a new
# server.crt / server.key (the maintenance worker writes them into TMRKZ_TLS_DIR), nginx reloads them by itself once
# `nginx -t` accepts them; a certificate nginx refuses leaves the running one in use. No Docker socket, no container restart.
set -eu
_sig() { cat /etc/tmrkz-tls/server.crt /etc/tmrkz-tls/server.key 2>/dev/null | md5sum | cut -d' ' -f1; }
_watch() {
  _last="$(_sig)"
  while sleep 5; do
    _now="$(_sig)"
    [ "$_now" = "$_last" ] && continue
    if nginx -t >/dev/null 2>&1; then
      nginx -s reload 2>/dev/null && echo "[tls-watch] certificate changed: nginx reloaded"
    else
      echo "[tls-watch] certificate changed but nginx -t refuses it: the running certificate stays in use" >&2
    fi
    _last="$_now"
  done
}
_watch &
exec /docker-entrypoint.sh "$@"
