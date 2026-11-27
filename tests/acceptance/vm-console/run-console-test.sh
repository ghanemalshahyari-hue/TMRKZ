#!/usr/bin/env bash
# VM_CONSOLE.cmd end to end on this Windows PC (27 Nov 2026): the real console (a working copy of the kit, so nothing is
# written on the USB) with stand-in ssh/scp that reach a test VM container; the PC side really times the app with curl.exe.
#   bash tests/acceptance/vm-console/run-console-test.sh <kit folder holding VM_CONSOLE.cmd + 0_UPDATE_TOOL> <evidence folder>
# Scenario: MOVER's web started without compose.override.yaml (worker-connections 4). Runs H, P (report), W (fix), P again.
set -u
KIT=$1; EV=$2; HERE=$(cd "$(dirname "$0")" && pwd)
export MSYS_NO_PATHCONV=1
WORK="$HERE/work-$$"; mkdir -p "$WORK/kit" "$EV"
cp "$KIT/VM_CONSOLE.cmd" "$WORK/kit/" && cp -r "$KIT/0_UPDATE_TOOL" "$WORK/kit/"
VMC=tmrkz-consoletest-$$
cleanup() { docker rm -fv "$VMC" >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT
pass=0; fail=0
ok() { if grep -qF -- "$2" "$3"; then pass=$((pass + 1)); echo "PASS  $1"; else fail=$((fail + 1)); echo "FAIL  $1 (no «$2» in $(basename "$3"))"; fi; }

docker run -d --name "$VMC" -p 127.0.0.1:19443:19443 -e MOVER_DOCKER=/t/fake-docker.sh -e SCN=/t/scn -e MOVER_CPU_SECONDS=2 \
    python:3.12-slim sleep 3600 >/dev/null || exit 1
docker exec "$VMC" sh -c 'apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq curl openssl >/dev/null 2>&1 && mkdir -p /t/scn /srv/mover/data' || exit 1
for f in fake-docker.sh fake-mover.py; do docker exec -i "$VMC" sh -c "cat > /t/$f" < "$HERE/$f"; done
docker exec "$VMC" sh -c '
  chmod +x /t/fake-docker.sh; : > /srv/mover/compose.yaml; : > /srv/mover/compose.override.yaml
  printf "#!/bin/sh\nexec \"\$@\"\n" > /usr/local/bin/sudo; chmod +x /usr/local/bin/sudo
  cd /t/scn; echo 19001 > web-port; echo 19443 > proxy-port; echo 4 > wc; echo 128 > fix-wc; echo old-sync > services
  printf "mover-web-1 340.0%% 22.0%%\nmover-proxy-1 0.5%% 0.4%%\nmover-old-sync-1 4.0%% 3.0%%\n" > stats
  printf "TNQL_WEB_PROCESSES=4\nTNQL_WEB_CONNECTION_LIMIT=16\nTNQL_WEB_ACTIVE_REQUESTS=3\n" > env
  openssl req -x509 -newkey rsa:2048 -nodes -subj /CN=proxy -keyout /t/k.pem -out /t/c.pem -days 1 >/dev/null 2>&1'
docker exec -d -e BIND=0.0.0.0 -e SCN=/t/scn "$VMC" python3 /t/fake-mover.py 19001
docker exec -d -e BIND=0.0.0.0 -e SCN=/t/scn "$VMC" python3 /t/fake-mover.py 19443 /t/c.pem /t/k.pem
for i in $(seq 1 50); do curl -k -s -o /dev/null https://127.0.0.1:19443/health && break; sleep 0.2; done

W=$(cygpath -w "$WORK"); H=$(cygpath -w "$HERE"); BASH_EXE='C:\Program Files\Git\bin\bash.exe'
printf '@"%s" "%s\\fake-ssh.sh" %%*\r\n' "$BASH_EXE" "$H" > "$WORK/fake-ssh.cmd"
printf '@"%s" "%s\\fake-scp.sh" %%*\r\n' "$BASH_EXE" "$H" > "$WORK/fake-scp.cmd"
printf 'set "PAM_LOGIN=pam-test@vm"\r\nset "PORT=22"\r\nset "VM_PATH=/srv/mover"\r\nset "APP_URL=https://127.0.0.1:19443"\r\nset "SUDO=sudo"\r\n' > "$WORK/kit/my-settings-MOVER.cmd"
console() {   # console NAME KEYS...: one run of the real console with these answers typed in ($APPSET: DUTY / MOVER)
    name=$1; shift; : > "$WORK/in-$name.txt"; for k in "$@"; do printf '%s\r\n' "$k" >> "$WORK/in-$name.txt"; done
    printf '@echo off\r\nset "VM_APP=%s"\r\nset "VM_SSH=%s\\fake-ssh.cmd"\r\nset "VM_SCP=%s\\fake-scp.cmd"\r\nset "VMC=%s"\r\nset "WORK=%s"\r\ncall "%s\\kit\\VM_CONSOLE.cmd" < "%s\\in-%s.txt" > "%s\\console-%s.log" 2>&1\r\n' \
        "${APPSET:-MOVER}" "$W" "$W" "$VMC" "$WORK" "$W" "$W" "$name" "$W" "$name" > "$WORK/run-$name.cmd"
    VMC=$VMC WORK=$WORK timeout 300 cmd.exe /c "$W\\run-$name.cmd"
    tr -d '\f' < "$WORK/console-$name.log" > "$EV/console-$name.log"
}

console H H x 0 0
ok "H sends the helpers from 0_UPDATE_TOOL\\vm-tools" "Done: ~/vm-tools/*.sh are on the VM." "$EV/console-H.log"
docker exec "$VMC" test -f /root/vm-tools/mover-vm.sh && { pass=$((pass + 1)); echo "PASS  helper is on the VM"; } || { fail=$((fail + 1)); echo "FAIL  helper not on the VM"; }

console P1 P x 0 0
ok "P menu entry shown for MOVER" "P   SPEED: why is MOVER slow?" "$EV/console-P1.log"
ok "P times the app from this PC (curl.exe)" "health " "$EV/console-P1.log"
ok "P reports where it saved the report" "Saved: " "$EV/console-P1.log"
R=$(ls "$WORK"/kit/REPORTS/MOVER_SPEED_*.txt 2>/dev/null | head -1)
if [ -n "$R" ]; then
    cp "$R" "$EV/report-before-fix.txt"; pass=$((pass + 1)); echo "PASS  report saved on the kit: REPORTS/$(basename "$R")"
    ok "report has the PC section with numbers" "/health (the bare check)" "$EV/report-before-fix.txt"
    ok "report names the stall first" "1. CAUSE: web's connection limit is 4 per worker" "$EV/report-before-fix.txt"
    ok "report shows web eats CPU" "MOVER web" "$EV/report-before-fix.txt"
else fail=$((fail + 1)); echo "FAIL  no report in REPORTS"; fi
[ ! -e "$WORK/kit/REPORTS/pc-timing.txt" ] && { pass=$((pass + 1)); echo "PASS  the PC timing scratch file is removed"; } || { fail=$((fail + 1)); echo "FAIL  pc-timing.txt left behind"; }
rm -f "$WORK"/kit/REPORTS/MOVER_SPEED_*.txt

console W W YES x 0 0
ok "W names what it fixes" "fixing: the connection-limit stall (worker-connections 4" "$EV/console-W.log"
ok "W reports FIXED" "FIXED" "$EV/console-W.log"

console P2 P x 0 0
R=$(ls "$WORK"/kit/REPORTS/MOVER_SPEED_*.txt 2>/dev/null | head -1)
[ -n "$R" ] && cp "$R" "$EV/report-after-fix.txt"
ok "after W the report no longer finds the stall" "worker-connections 128" "$EV/report-after-fix.txt"
if grep -q "connection limit is" "$EV/report-after-fix.txt" 2>/dev/null; then fail=$((fail + 1)); echo "FAIL  stall still reported"; else pass=$((pass + 1)); echo "PASS  stall gone from the verdict"; fi
# every menu that had a bracket inside an if ( ... ) message (cmd.exe stopped with «. was unexpected at this time» or
# «The syntax of the command is incorrect»): each must now run to its end and return to the menu
console m2 2 x 0 0;          ok "2 checks the update folder and returns" "Not a MOVER kit - no apply_fixes.py" "$EV/console-m2.log"
console mI I x 0 0;          ok "I checks for the release and returns" "No signed release here" "$EV/console-mI.log"
console mF F x 0 0;          ok "F checks for the release and returns" "No signed release here" "$EV/console-mF.log"
console m4 4 no x 0 0;       ok "4 asks and cancels" "Cancelled." "$EV/console-m4.log"
console m6 6 x 0 0;          ok "6 runs MOVER's status" "MOVER's status above is its diagnosis" "$EV/console-m6.log"
console m1 1 x 0 0;          ok "1 shows MOVER's status" "== web stall check" "$EV/console-m1.log"
APPSET=DUTY console d2 2 x 0 0; ok "DUTY 2 checks the bundle and returns" "Not a DUTY bundle - no MANIFEST.sha256" "$EV/console-d2.log"
APPSET=DUTY console d4 4 no x 0 0; ok "DUTY 4 asks and cancels" "Cancelled." "$EV/console-d4.log"
APPSET=DUTY console dP P x 0 0; ok "P is MOVER-only" "The speed report is for MOVER." "$EV/console-dP.log"
bad=$(grep -lE "was unexpected at this time|syntax of the command is incorrect|cannot find the batch label" "$EV"/console-*.log 2>/dev/null)
if [ -z "$bad" ]; then pass=$((pass + 1)); echo "PASS  no cmd.exe error in any console run"; else fail=$((fail + 1)); echo "FAIL  cmd.exe errors in: $bad"; fi
cp "$WORK/ssh-calls.log" "$EV/" 2>/dev/null; cp "$WORK/scp-calls.log" "$EV/" 2>/dev/null
echo; echo "== result: $pass passed, $fail failed"
[ "$fail" = 0 ]
