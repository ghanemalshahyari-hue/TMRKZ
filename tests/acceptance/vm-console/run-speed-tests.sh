#!/usr/bin/env bash
# MOVER VM helper speed report / speed fix, end to end on a stand-in VM (27 Nov 2026):
#   bash tests/acceptance/vm-console/run-speed-tests.sh <mover-vm.sh> <evidence folder>
# A python:3.12-slim container (Debian: dash as /bin/sh, mawk, GNU coreutils, as on the Ubuntu VMs) with curl and openssl
# added; the stand-ins in this folder play MOVER's containers, web and TLS proxy. Fictional: no data, nothing kept.
set -u
H=$1; EV=$2; HERE=$(cd "$(dirname "$0")" && pwd)
export MSYS_NO_PATHCONV=1
C=tmrkz-speedtest-$$
cleanup() { docker rm -fv "$C" >/dev/null 2>&1; }
trap cleanup EXIT
docker run -d --name "$C" python:3.12-slim sleep 3600 >/dev/null || exit 1
docker exec "$C" sh -c 'apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq curl openssl >/dev/null 2>&1 && mkdir -p /t' || { echo "could not prepare the test machine"; exit 1; }
for f in fake-docker.sh fake-mover.py speed-scenarios.sh; do docker exec -i "$C" sh -c "cat > /t/$f" < "$HERE/$f"; done
docker exec -i "$C" sh -c 'cat > /t/mover-vm.sh' < "$H"
docker exec "$C" sh -c 'chmod +x /t/fake-docker.sh; ls -l /bin/sh; sh -n /t/mover-vm.sh && echo "syntax ok (dash)"'
docker exec "$C" sh /t/speed-scenarios.sh /t/mover-vm.sh /t/out; rc=$?
mkdir -p "$EV" && docker exec "$C" sh -c 'cd /t/out && tar -cf - .' | tar -xf - -C "$EV"
exit $rc
