#!/usr/bin/env bash
# VM simulation (ADR-107): a clean Docker 29 (DinD) with no route out, a TMRKZ folder owned by a non-root «PAM» account, the
# images as 100 MB parts. Fictional: no data, generated secrets only. Given the USB folders it tests exactly what is delivered:
#   bash tests/acceptance/vm-sim/vmsim.sh <TMRKZ folder> <folder with the parts> <evidence folder>
#   e.g. bash tests/acceptance/vm-sim/vmsim.sh F:/<delivery>/2_FIRST_BROWSER_UPDATE/TMRKZ F:/<delivery>/0_IMAGES_IF_NEEDED docs/evidence/vm-sim-adr107
# Uses (pulled on this connected machine if missing): docker:29-dind, node:24.18.1-alpine, alpine:3 for linux/arm64 (T5).
# Everything it creates in Docker (the DinD container, its volume, its network) is removed at the end.
set -u
export MSYS_NO_PATHCONV=1
SRC="${1:?TMRKZ folder}"; PARTS="${2:?folder with tmrkz-images.tar.part-*}"; OUT="${3:?evidence folder}"
HERE="$(cd "$(dirname "$0")" && (pwd -W 2>/dev/null || pwd))"
mkdir -p "$OUT"
D=tmrkz-vmsim29; NET=tmrkz-vmsim-internal
pass=0; fail=0
check() { if [ "$1" = 0 ]; then pass=$((pass+1)); echo "PASS  $2"; else fail=$((fail+1)); echo "FAIL  $2"; fi; }
inside() { docker exec "$D" sh -c "$1"; }
startsh() { inside "cd /data/TMRKZ && $1" > "$OUT/vmsim-$2.log" 2>&1; echo $?; }
signin() { docker run --rm --network "$NET" -e BASE="http://$IP:8088" -e PW="$PW" -v "$HERE/signin-admin.mjs:/s.mjs:ro" node:24.18.1-alpine node /s.mjs; }
cleanup() { docker rm -fv "$D" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; }
trap cleanup EXIT

echo "== setup $(date +%T)  folder: $SRC  parts: $PARTS"
cleanup
docker network create --internal "$NET" >/dev/null
docker run -d --privileged --name "$D" -e DOCKER_TLS_CERTDIR= docker:29-dind >/dev/null
sleep 3
# GNU tools like the VM, sudo for the PAM-account test: the only step with a network
inside 'apk add -q --no-cache bash coreutils gawk sed grep findutils util-linux sudo curl' || { echo "apk failed"; exit 1; }
docker network connect "$NET" "$D" && docker network disconnect bridge "$D"
IP="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$D")"
inside 'wget -q -T 5 -O /dev/null https://registry-1.docker.io/v2/ 2>/dev/null'; [ $? != 0 ]; check $? "no route out of the simulated VM (IP $IP)"
for i in $(seq 60); do inside 'docker info >/dev/null 2>&1' && break; sleep 2; done
inside 'docker info --format "{{.ServerVersion}} {{.Architecture}} {{.Driver}}"; echo "images before: $(docker image ls -q | wc -l)"'
inside 'adduser -D pamuser && adduser -D nosudo && echo "pamuser ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/pam && mkdir -p /data/TMRKZ'
tar -C "$SRC" --exclude=./release --exclude=./.git -cf - . | docker exec -i "$D" tar -xf - -C /data/TMRKZ
(cd "$PARTS" && tar -cf - tmrkz-images.tar.part-* tmrkz-images.tar.parts.sha256 tmrkz-images.tar.sha256) | docker exec -i "$D" tar -xf - -C /data/TMRKZ
inside 'chown -R pamuser /data/TMRKZ; du -sh /data/TMRKZ; ls /data/TMRKZ | tr "\n" " "'; echo

echo "== T1 damaged part $(date +%T)"
inside 'cd /data/TMRKZ && cp tmrkz-images.tar.part-03 /tmp/p03 && head -c 41000000 /tmp/p03 > tmrkz-images.tar.part-03'
rc=$(startsh "TMRKZ_IP=$IP TMRKZ_PORT=8088 sh start.sh" t1)
grep -q 'only these parts: tmrkz-images.tar.part-03(41000000 bytes)' "$OUT/vmsim-t1.log"; check $? "T1 a cut part is named (rc=$rc): $(grep -m1 'only these parts' "$OUT/vmsim-t1.log")"
inside 'cp /tmp/p03 /data/TMRKZ/tmrkz-images.tar.part-03 && chown pamuser /data/TMRKZ/tmrkz-images.tar.part-03'

echo "== T2 missing part $(date +%T)"
inside 'mv /data/TMRKZ/tmrkz-images.tar.part-07 /tmp/p07'
rc=$(startsh "TMRKZ_IP=$IP TMRKZ_PORT=8088 sh start.sh" t2)
grep -q 'send these parts: tmrkz-images.tar.part-07(missing)' "$OUT/vmsim-t2.log"; check $? "T2 a missing part is named (rc=$rc)"
inside 'mv /tmp/p07 /data/TMRKZ/tmrkz-images.tar.part-07'

echo "== T3 account without Docker and without sudo $(date +%T)"
inside 'ls -l /data/TMRKZ/.env'
rc=$(startsh "su nosudo -c 'cd /data/TMRKZ && sh start.sh'" t3)
[ "$rc" != 0 ] && grep -q 'permission denied: the account nosudo cannot use Docker' "$OUT/vmsim-t3.log"; check $? "T3 no sudo: says how to run it as root (rc=$rc)"

echo "== T4 PAM account with sudo: fresh offline start from the parts $(date +%T)"
t0=$(date +%s)
rc=$(startsh "su pamuser -c 'cd /data/TMRKZ && TMRKZ_IP=$IP TMRKZ_PORT=8088 sh start.sh'" t4)
echo "   start.sh took $(( $(date +%s) - t0 )) s"
[ "$rc" = 0 ] && grep -q 'runs again as root' "$OUT/vmsim-t4.log" && grep -q 'TMRKZ is running' "$OUT/vmsim-t4.log"; check $? "T4 sudo re-run, parts loaded, everything started (rc=$rc)"
inside 'cd /data/TMRKZ && docker compose ps -a --format "table {{.Service}}\t{{.Status}}"'
n=$(inside 'cd /data/TMRKZ && docker compose ps --format "{{.Service}} {{.Health}}" | grep -c " unhealthy"'); [ "$n" = 0 ]; check $? "T4 no unhealthy service"
inside 'docker image ls --format "{{.Repository}}:{{.Tag}} {{.Size}}"; for i in $(docker image ls -q); do docker image inspect -f "{{.Os}}/{{.Architecture}}" $i; done | sort | uniq -c'
inside 'cd /data/TMRKZ && docker compose exec -T backend pg_restore --version'; check $? "T4 pg_restore in the running backend"
PW="$(inside "sed -n 's/^TMRKZ_PLATFORM_ADMIN_PASSWORD=//p' /data/TMRKZ/.env" | tr -d '\r')"
signin; check $? "T4 admin signs in (Keycloak → TMRKZ → /api/v1/me)"

echo "== T5 an image for the wrong processor $(date +%T)"
docker pull -q --platform linux/arm64 alpine:3 >/dev/null && docker save --platform linux/arm64 alpine:3 | docker exec -i "$D" docker load -q >/dev/null
WEBID="$(inside 'docker image inspect -f {{.Id}} tmrkz/folder-web:1')"
inside 'docker tag alpine:3 tmrkz/folder-web:1'
rc=$(startsh "TMRKZ_IP=$IP TMRKZ_PORT=8088 sh start.sh" t5)
[ "$rc" != 0 ] && grep -q 'not made for this machine.s processor (amd64): tmrkz/folder-web:1 (arm64)' "$OUT/vmsim-t5.log"; check $? "T5 arm64 image refused before Compose (rc=$rc)"
inside "docker tag $WEBID tmrkz/folder-web:1 && docker image rm alpine:3 >/dev/null"

echo "== T6 a backend that does not compile $(date +%T)"
inside 'printf "package ae.mover;\nclass Broken { int x = ; }\n" > /data/TMRKZ/backend/src/main/java/ae/mover/Broken.java'
inside 'cd /data/TMRKZ && docker compose rm -sf backend >/dev/null 2>&1'   # a first start: no earlier build in the container
t0=$(date +%s)
rc=$(startsh "TMRKZ_IP=$IP TMRKZ_PORT=8088 sh start.sh" t6)
echo "   reported after $(( $(date +%s) - t0 )) s"
[ "$rc" != 0 ] && grep -q 'does not compile' "$OUT/vmsim-t6.log" && grep -q 'Broken.java' "$OUT/vmsim-t6.log"; check $? "T6 compile error named with the compiler's line (rc=$rc)"
inside 'rm /data/TMRKZ/backend/src/main/java/ae/mover/Broken.java'

echo "== T7 restart after the fix: images already loaded, no reload $(date +%T)"
t0=$(date +%s)
rc=$(startsh "TMRKZ_IP=$IP TMRKZ_PORT=8088 sh start.sh" t7)
echo "   start.sh took $(( $(date +%s) - t0 )) s"
[ "$rc" = 0 ] && grep -q 'images already loaded' "$OUT/vmsim-t7.log"; check $? "T7 restart (rc=$rc)"
signin; check $? "T7 admin signs in again"

echo "== T8 the USB helper: check, install, cleanup $(date +%T)"
inside 'mkdir -p /data/tmrkz-incoming && chown pamuser /data/tmrkz-incoming'
(cd "$PARTS" && tar -cf - tmrkz-images.tar.part-* tmrkz-images.tar.parts.sha256 tmrkz-images.tar.sha256) | docker exec -i "$D" tar -xf - -C /data/tmrkz-incoming
docker exec -i "$D" sh -c 'cat > /data/tmrkz-incoming/tmrkz-vm.sh' < "$SRC/ops/vm/tmrkz-vm.sh"
inside 'cp /data/TMRKZ/start.sh /data/tmrkz-incoming/start.sh; head -c 1000 /data/tmrkz-incoming/tmrkz-images.tar.part-05 > /tmp/p5 && cp /data/tmrkz-incoming/tmrkz-images.tar.part-05 /tmp/p5full && cp /tmp/p5 /data/tmrkz-incoming/tmrkz-images.tar.part-05; chown -R pamuser /data/tmrkz-incoming'
inside 'docker tag nginx:1.27-alpine tmrkz/folder-backend:1.2-pgrestore'   # an old, unused tag like the VM's
inside "su pamuser -c 'sh /data/tmrkz-incoming/tmrkz-vm.sh check /data/tmrkz-incoming'" > "$OUT/vmsim-t8-check.log" 2>&1
grep -q '^RESEND tmrkz-images.tar.part-05 (1000 bytes, damaged)' "$OUT/vmsim-t8-check.log"; check $? "T8 helper names the part to resend"
inside 'cp /tmp/p5full /data/tmrkz-incoming/tmrkz-images.tar.part-05 && chown pamuser /data/tmrkz-incoming/tmrkz-images.tar.part-05'
inside "su pamuser -c 'sh /data/tmrkz-incoming/tmrkz-vm.sh install /data/tmrkz-incoming /data/TMRKZ'" > "$OUT/vmsim-t8-install.log" 2>&1
grep -q 'DONE' "$OUT/vmsim-t8-install.log" && inside 'ls /data/TMRKZ/backups/start.sh.before-* >/dev/null'; check $? "T8 helper installs the checked parts and start.sh (as root, previous start.sh kept)"
inside "su pamuser -c 'sh /data/tmrkz-incoming/tmrkz-vm.sh cleanup /data/tmrkz-incoming'" > "$OUT/vmsim-t8-cleanup.log" 2>&1
grep -q 'removed tmrkz/folder-backend:1.2-pgrestore' "$OUT/vmsim-t8-cleanup.log" && inside 'docker image inspect tmrkz/folder-backend:1 >/dev/null'; check $? "T8 cleanup removes the old tag and keeps the running images"

echo "== result: $pass passed, $fail failed $(date +%T)"
[ "$fail" = 0 ]
