#!/bin/sh
# The backend straight from the source (docker-compose.override.yml, owner 19 Nov 2026). Copies ./backend into the container
# and builds it there — nothing (no target/) is written into the folder — with the Maven repository of its image
# (tmrkz/folder-backend), offline. Then it runs the application and builds again a few seconds after a file under
# backend/src/main or backend/pom.xml changes. A build that fails keeps the running version and prints why.
# TMRKZ_BUILD_ONLY=1 builds once and exits with the result (used when the images are packed).
set -u
SRC=/workspace/backend
WORK=/tmp/tmrkz-backend
JAR=/tmp/mover-backend.jar
POLL="${TMRKZ_WORKSPACE_POLL_SECONDS:-3}"
PID=""

# what the source looks like now: every file's time, size and name (a save, a new file and a deleted file all change it)
state() { find "$SRC/pom.xml" "$SRC/src/main" -type f -print0 2>/dev/null | xargs -0 stat -c '%Y %s %n' 2>/dev/null | sort | md5sum; }

build() {
  echo "[backend] building ./backend …"
  rm -rf "$WORK" && mkdir -p "$WORK/src" && cp "$SRC/pom.xml" "$WORK/" && cp -r "$SRC/src/main" "$WORK/src/" || return 1
  if ! (cd "$WORK" && mvn -B -q -o -Dmaven.test.skip=true package); then
    echo "[backend] BUILD FAILED — the running version is kept (a new dependency in pom.xml needs a new tmrkz-images.tar,"
    echo "          made on a connected machine with: sh ops/local/workspace/pack-images.sh)"
    return 1
  fi
  cp "$WORK/target/mover-backend.jar" "$JAR.new" && mv "$JAR.new" "$JAR"
  echo "[backend] build ready"
}
start() { java $JAVA_OPTS -jar "$JAR" & PID=$!; }
stop() { [ -n "$PID" ] && { kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; }; PID=""; }
trap 'stop; exit 0' TERM INT

if [ "${TMRKZ_BUILD_ONLY:-}" = 1 ]; then build; exit $?; fi
last="$(state)"
until build; do
  while [ "$(state)" = "$last" ]; do sleep "$POLL" & wait $!; done
  sleep 2; last="$(state)"
done
start
while :; do
  sleep "$POLL" & wait $!
  now="$(state)"
  if [ "$now" = "$last" ]; then
    if ! kill -0 "$PID" 2>/dev/null; then echo "[backend] the application stopped; starting it again in 15 s"; sleep 15; start; fi
    continue
  fi
  sleep 2; last="$(state)"   # several files are often saved together
  if build; then echo "[backend] restarting with the new build"; stop; start; fi
done
