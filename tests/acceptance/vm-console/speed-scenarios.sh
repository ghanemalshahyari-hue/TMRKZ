#!/bin/sh
# Inside the test container (Debian: /bin/sh is dash and awk is mawk, as on the Ubuntu VMs):
#   sh /t/speed-scenarios.sh /t/mover-vm.sh /t/out
# Each scenario sets one cause up with the stand-ins (fake-docker.sh, fake-mover.py, a /proc whose CPU counters move
# during the sample) and checks that `speedreport` names it first, or that `speedfix` repairs it.
set -u
H=$1; OUT=$2; mkdir -p "$OUT"
pass=0; fail=0; port=18000
openssl req -x509 -newkey rsa:2048 -nodes -subj /CN=proxy -keyout /t/k.pem -out /t/c.pem -days 1 >/dev/null 2>&1
mkdir -p /srv/mover/data && : > /srv/mover/compose.yaml && : > /srv/mover/compose.override.yaml
head -c 3000000 /dev/zero > /srv/mover/data/transport_requests.db

PIDS=""
stop_servers() { [ -n "$PIDS" ] && kill $PIDS 2>/dev/null; PIDS=""; }
trap stop_servers EXIT
scenario() {     # scenario NAME: a fresh scenario folder and a fresh web + proxy
    stop_servers; NAME=$1; SCN=/t/scn/$NAME; export SCN; rm -rf "$SCN"; mkdir -p "$SCN/proc"
    port=$((port + 2)); echo $port > "$SCN/web-port"; echo $((port + 1)) > "$SCN/proxy-port"
    python3 /t/fake-mover.py $port & PIDS="$PIDS $!"
    python3 /t/fake-mover.py $((port + 1)) /t/c.pem /t/k.pem & PIDS="$PIDS $!"
    printf 'mover-web-1 12.0%% 8.1%%\nmover-proxy-1 0.5%% 0.4%%\nmover-old-sync-1 4.0%% 3.0%%\ntnql-app 3.0%% 5.0%%\n' > "$SCN/stats"
    printf 'TNQL_WEB_PROCESSES=4\nTNQL_WEB_CONNECTION_LIMIT=512\nTNQL_WEB_ACTIVE_REQUESTS=3\n' > "$SCN/env"
    echo old-sync > "$SCN/services"
    echo "0.50 0.40 0.30 1/200 1234" > "$SCN/proc/loadavg"
    printf 'MemTotal: 16000000 kB\nMemAvailable: 9000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n' > "$SCN/proc/meminfo"
    cpu 10 0 0
    i=0; while [ $i -lt 50 ] && ! curl -s -o /dev/null "http://127.0.0.1:$port/health"; do sleep 0.1; i=$((i + 1)); done
}
cpu() {          # cpu BUSY IOWAIT STEAL (percent over the sample): two /proc/stat lines, 1000 jiffies apart
    idle=$((100 - $1 - $2)); user=$(($1 - $3))
    A="cpu 50000 0 20000 400000 1000 0 0 0 0 0"
    B="cpu $((50000 + user * 10)) 0 20000 $((400000 + idle * 10)) $((1000 + $2 * 10)) 0 0 $(($3 * 10)) 0 0"
}
run() {          # run ACTION [ARG]: $SCN/proc/stat is a pipe that gives line A, then line B (the sample's two reads)
    rm -f "$SCN/proc/stat"; mkfifo "$SCN/proc/stat"
    # the pause lets the first read close before line B is offered (else B can land in the first read and be lost)
    ( printf '%s\n' "$A" > "$SCN/proc/stat"; sleep 0.5; printf '%s\n' "$B" > "$SCN/proc/stat" ) & W=$!
    OUTF="$OUT/$NAME-$1.txt"
    MOVER_DOCKER=/t/fake-docker.sh MOVER_PROC="$SCN/proc" MOVER_CPU_SECONDS=1 sh "$H" "$1" /srv/mover "${2:-}" > "$OUTF" 2>&1
    RC=$?
    kill $W 2>/dev/null
}
ok()  { if grep -qF -- "$2" "$OUTF"; then pass=$((pass + 1)); echo "PASS  $NAME: $1"; else fail=$((fail + 1)); echo "FAIL  $NAME: $1 (no «$2» in $OUTF)"; fi; }
no()  { if grep -qF -- "$2" "$OUTF"; then fail=$((fail + 1)); echo "FAIL  $NAME: $1 («$2» in $OUTF)"; else pass=$((pass + 1)); echo "PASS  $NAME: $1"; fi; }
first() { l=$(grep -A1 '^== VERDICT' "$OUTF" | tail -1); case "$l" in *"$2"*) pass=$((pass + 1)); echo "PASS  $NAME: $1";; *) fail=$((fail + 1)); echo "FAIL  $NAME: $1 (first finding: $l)";; esac; }
pc() {           # pc HEALTH_TOTAL PAGE_TOTAL: what VM_CONSOLE.cmd measures from the PC
    f=/t/pc-$NAME.txt; : > "$f"
    for i in 1 2 3 4 5 6 7; do echo "health 0.010 0.030 $1 $1 200" >> "$f"; done
    for i in 1 2 3 4 5; do echo "page 0.010 0.030 $2 $2 200" >> "$f"; done
    PCF=$f
}

scenario healthy; pc 0.040 0.090; run speedreport "$PCF"
ok "runs to the end" "== VERDICT"; ok "PC timings read" "/health (the bare check)"; ok "names MOVER containers" "MOVER web"
ok "says nothing is slow" "Nothing slow inside the server"; no "no cause invented" "CAUSE:"; ok "page profile off is explained" "MOVER_PAGE_PROFILE is not 1"
ok "database file listed" "data/transport_requests.db"; ok "TLS proxy timed" "through the TLS proxy, /health"
[ "$RC" = 0 ] && { pass=$((pass + 1)); echo "PASS  $NAME: exit 0"; } || { fail=$((fail + 1)); echo "FAIL  $NAME: exit $RC"; }

scenario stall; echo 4 > "$SCN/wc"; run speedreport
first "names the connection-limit stall first" "CAUSE: web's connection limit is 4 per worker"; ok "points to the fix" "FIX: menu W"
ok "shows gunicorn settings" "gunicorn: 4 processes x 128 threads, worker-connections 4"

scenario cpu; cpu 96 0 0; printf 'mover-web-1 381.0%% 30.0%%\nmover-reminders-1 9.0%% 2.0%%\ntnql-app 5.0%% 5.0%%\n' > "$SCN/stats"; run speedreport
first "names the full CPU first" "CAUSE: the server's CPU is full (busy 96%"; ok "names the biggest user" "MOVER web 381%"

scenario steal; cpu 60 0 25; run speedreport
ok "names VMware steal" "the VMware host takes 25% of this VM's CPU"

scenario disk; cpu 40 30 0; run speedreport
ok "names disk wait" "the CPUs wait for the disk 30%"

scenario readiness; echo 1.3 > "$SCN/ready-delay"; run speedreport
first "names the slow readiness/database check" "CAUSE: the readiness check (database and services)"

scenario network; pc 1.200 2.500; run speedreport "$PCF"
first "names the network between PC and server" "CAUSE: the way between your PC and the server"

scenario proxy; echo 0.6 > "$SCN/proxy-delay"; run speedreport
ok "names the slow TLS proxy" "the TLS proxy adds"

scenario hung; echo 0.7 > "$SCN/health-delay"; run speedreport
ok "names stuck web threads" "web answers even its bare check slowly"

scenario logs
{
  for i in 1 2 3 4 5 6; do echo "WARNING MOVER-PAGE-PROFILE method=GET route=/center status=200 queue_ms=2400.0 app_ms=900.0 cpu_ms=700.0 sql_count=40 sql_ms=150.0 sql_max_ms=20.0 openfga_count=2 openfga_ms=30.0 openfga_ops={'check': 2} jinja_ms=200.0 bytes=50000 pre_write_ms=0.0 write_wait_ms=0.0 write_hold_ms=0.0 write_txns=0 gate_wait_ms=0.0 commit_ms=0.0"; done
  for i in 1 2 3; do echo "WARNING MOVER-PAGE-PROFILE method=GET route=/requests/<int:request_id> status=200 queue_ms=5.0 app_ms=1300.0 cpu_ms=300.0 sql_count=300 sql_ms=1100.0 sql_max_ms=90.0 openfga_count=1 openfga_ms=10.0 openfga_ops={'check': 1} jinja_ms=80.0 bytes=40000 pre_write_ms=0.0 write_wait_ms=0.0 write_hold_ms=0.0 write_txns=0 gate_wait_ms=0.0 commit_ms=0.0"; done
  echo "WARNING ADMISSION refused (timeout): queue full or wait over 30 s"; echo "WARNING ADMISSION refused (queue full): queue full or wait over 30 s"
  echo "sqlite3.OperationalError: database is locked"; echo "Traceback (most recent call last):"
  echo '10.0.0.5 - - [27/Nov/2026:08:00:00 +0400] "GET /center HTTP/1.1" 503 120 "-" "Mozilla"'
} > "$SCN/web.log"
echo "web 2" > "$SCN/restarts"; run speedreport
ok "route table: queue-heavy page" "GET /center - mostly waiting for a free slot (queue)"
ok "route table: SQL-heavy page" "GET /requests/<int:request_id> - mostly database (SQL)"
ok "counts «server busy» refusals" "web refused 2 requests in the last hour"; ok "counts «database is locked»" "1 writes failed with «database is locked»"
ok "names the slowest page" "the slowest page: GET /center - mostly waiting for a free slot (queue), 3300 ms on average (6 times"
ok "counts errors" "web logged 1 errors"; ok "counts 5xx" "1 answers in the last hour were server errors"; ok "names restarts" "web (2)"
no "never prints a log line" "Traceback (most recent"; no "never prints a client address" "10.0.0.5"

scenario fixstall; echo 4 > "$SCN/wc"; echo 128 > "$SCN/fix-wc"; run speedfix
ok "names what it fixes" "fixing: the connection-limit stall (worker-connections 4"; ok "recreates web" "worker-connections 128"; ok "reports FIXED" "FIXED"
grep -q 'compose up -d --no-deps --force-recreate web' "$SCN/calls" && { pass=$((pass + 1)); echo "PASS  $NAME: web recreated from both compose files (no -f)"; } || { fail=$((fail + 1)); echo "FAIL  $NAME: web not recreated"; }

scenario fixhung; echo 2.2 > "$SCN/health-delay"; run speedfix
ok "finds web stuck" "fixing: web is stuck"; ok "reports FIXED after restart" "FIXED"

scenario fixnothing; run speedfix
ok "changes nothing when web is fine" "NOTHING TO FIX in web"
grep -q 'compose up' "$SCN/calls" && { fail=$((fail + 1)); echo "FAIL  $NAME: web was recreated"; } || { pass=$((pass + 1)); echo "PASS  $NAME: web left alone"; }

scenario webdown; rm -f "$SCN/web-port"; run speedreport
ok "says web is not running" "web is not running here"
[ "$RC" = 1 ] && { pass=$((pass + 1)); echo "PASS  $NAME: exit 1"; } || { fail=$((fail + 1)); echo "FAIL  $NAME: exit $RC"; }

echo; echo "== result: $pass passed, $fail failed"
[ "$fail" = 0 ]
