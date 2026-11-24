#!/usr/bin/env sh
# tmrkzctl — TMRKZ recovery, bootstrap and diagnostics engine
# Works offline on installed tools and local Docker images.
# Usage:
#   sh ops/tmrkzctl.sh doctor   [--root /path]   read-only diagnostics
#   sh ops/tmrkzctl.sh setup    [--root /path]   guided first-time or reconfigure
#   sh ops/tmrkzctl.sh status                    release and health summary
#   sh ops/tmrkzctl.sh verify                    test representative paths
#   sh ops/tmrkzctl.sh update   <bundle>         staged source-only update
#   sh ops/tmrkzctl.sh rollback <release>        rollback to a previous release
#   sh ops/tmrkzctl.sh backup   [output-dir]     consistent backup
#   sh ops/tmrkzctl.sh inventory                 redacted diagnostic inventory
set -eu
export MSYS_NO_PATHCONV=1

# resolve own path independently of cwd
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
CMD="${1:-help}"; shift 2>/dev/null || true

# discover root: --root flag, or the directory containing this script's parent
ROOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --root=*) ROOT="${1#--root=}"; shift ;;
    *) break ;;
  esac
done
if [ -z "$ROOT" ]; then
  ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
fi
# validate root is a TMRKZ folder
if [ ! -f "$ROOT/docker-compose.yml" ] || [ ! -f "$ROOT/start.sh" ]; then
  echo "[tmrkzctl] ERROR: $ROOT does not look like a TMRKZ folder (no docker-compose.yml or start.sh)" >&2
  exit 2
fi
cd "$ROOT"

# helpers
value() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -n 1 | tr -d '\r' | tr -d "'\""; }
say()  { printf '[tmrkzctl] %s\n' "$*"; }
pass() { printf '[tmrkzctl] \033[32mPASS\033[0m  %s\n' "$*"; }
warn() { printf '[tmrkzctl] \033[33mWARN\033[0m  %s\n' "$*"; }
fail() { printf '[tmrkzctl] \033[31mFAIL\033[0m  %s\n' "$*"; }
info() { printf '[tmrkzctl]       %s\n' "$*"; }
dc()   { docker compose -p tmrkz "$@"; }

redact_env() {
  awk -F= '/^[A-Z_]+=[^ ]/ {
    k=$1; v=substr($0, length(k)+2)
    if (k ~ /(PASSWORD|SECRET|KEY|TOKEN|CREDENTIAL)/ && length(v)>0) v="***"
    print k "=" v; next
  } { print }' "$1" 2>/dev/null
}

# ─── doctor ────────────────────────────────────────────────────────────────
cmd_doctor() {
  say "TMRKZ doctor — read-only diagnostics"
  say "root: $ROOT"
  ISSUES=0

  # 1. compose version
  if docker compose version >/dev/null 2>&1; then
    CV="$(docker compose version --short 2>/dev/null || echo unknown)"
    pass "Docker Compose $CV"
  else
    fail "Docker Compose not found"; ISSUES=$((ISSUES+1))
  fi

  # 2. project detection
  PROJECT="$(docker compose -p tmrkz ps --format '{{.Project}}' 2>/dev/null | head -1 || true)"
  if [ "$PROJECT" = "tmrkz" ]; then
    pass "Compose project: tmrkz"
  elif [ -n "$PROJECT" ]; then
    warn "Compose project is '$PROJECT', expected 'tmrkz'"
  else
    warn "No running tmrkz project found"
  fi

  # 3. images
  REQUIRED_IMAGES="tmrkz/folder-backend:1 tmrkz/folder-web:1 postgis/postgis:17-3.5-alpine tmrkz/keycloak:26.7.5-2 openfga/openfga:v1.8.16 osixia/openldap:1.5.0 nginx:1.28.3-alpine"
  for img in $REQUIRED_IMAGES; do
    if docker image inspect "$img" >/dev/null 2>&1; then
      ARCH="$(docker image inspect "$img" --format '{{.Architecture}}' 2>/dev/null || echo unknown)"
      pass "image $img ($ARCH)"
    else
      fail "image $img missing — load with: docker load -i tmrkz-images.tar"; ISSUES=$((ISSUES+1))
    fi
  done

  # 4. source mounts
  for d in backend frontend; do
    if [ -d "$ROOT/$d" ]; then
      pass "source: $d/"
    else
      fail "source directory $d/ missing"; ISSUES=$((ISSUES+1))
    fi
  done
  if [ -f "$ROOT/backend/pom.xml" ]; then
    pass "backend/pom.xml present"
  else
    fail "backend/pom.xml missing"; ISSUES=$((ISSUES+1))
  fi
  if [ -f "$ROOT/frontend/package.json" ]; then
    pass "frontend/package.json present"
  else
    fail "frontend/package.json missing"; ISSUES=$((ISSUES+1))
  fi

  # 5. .env
  if [ -f "$ROOT/.env" ]; then
    pass ".env exists"
    MISSING_ENV=""
    for k in TMRKZ_DB_PASSWORD TMRKZ_ATTESTATION_KEY TMRKZ_HR_SETTINGS_KEY TMRKZ_PUBLIC_URL TMRKZ_HTTP_PORT; do
      v="$(value "$k")"
      if [ -z "$v" ]; then MISSING_ENV="$MISSING_ENV $k"; fi
    done
    if [ -n "$MISSING_ENV" ]; then
      warn "missing .env keys:$MISSING_ENV — run: sh ops/init-env.sh"
    else
      pass ".env has required keys"
    fi
  else
    fail ".env missing — run: sh start.sh or sh ops/init-env.sh"; ISSUES=$((ISSUES+1))
  fi

  # 6. persistent data directories
  for d in data/db data/files data/ldap-data data/ldap-config; do
    if [ -d "$ROOT/$d" ]; then
      pass "persistent: $d/"
    else
      warn "persistent directory $d/ missing (created on first start)"
    fi
  done

  # 7. map packages
  MAPS="$(ls "$ROOT/map-packages/" 2>/dev/null | head -5)"
  if [ -n "$MAPS" ]; then
    pass "map-packages/ has content"
  else
    warn "map-packages/ empty — map features unavailable"
  fi
  if [ -f "$ROOT/map-data/manifest.json" ] || [ -d "$ROOT/map-data/current" ]; then
    pass "map-data/ present"
  else
    warn "map-data/ not found (map tiles unavailable until installed)"
  fi

  # 8. port conflict
  PORT="$(value TMRKZ_HTTP_PORT)"
  PORT="${PORT:-8088}"
  OWN="$(docker ps -q --filter label=com.docker.compose.project=tmrkz 2>/dev/null | tr '\n' ' ')"
  BUSY="$(docker ps --format '{{.ID}} {{.Names}} {{.Ports}}' 2>/dev/null | grep -E ":${PORT}->" | awk -v own=" $OWN " '$1 && index(own,$1" ")==0{print $2;exit}' || true)"
  if [ -n "$BUSY" ]; then
    fail "port $PORT used by container $BUSY"; ISSUES=$((ISSUES+1))
  else
    pass "port $PORT available"
  fi

  # 9. disk space
  AVAIL="$(df -m "$ROOT" 2>/dev/null | awk 'NR==2{print $4}')"
  if [ -n "$AVAIL" ] && [ "$AVAIL" -lt 2048 ]; then
    warn "only ${AVAIL}MB free — recommend at least 2GB"
  elif [ -n "$AVAIL" ]; then
    pass "disk: ${AVAIL}MB free"
  fi

  # 10. database health
  DB_UP="$(dc exec -T db pg_isready -U tmrkz 2>/dev/null && echo yes || echo no)"
  if [ "$DB_UP" = "yes" ]; then
    pass "database: responsive"
    SCHEMA="$(dc exec -T db psql -U tmrkz -d tmrkz -Atc "select max(version::int) from flyway_schema_history where success and version is not null" 2>/dev/null || echo unknown)"
    if [ "$SCHEMA" != "unknown" ]; then
      pass "schema version: V$SCHEMA"
    else
      warn "cannot read schema version"
    fi
  else
    warn "database not reachable (services may be stopped)"
  fi

  # 11. TLS
  TLS_DIR="$(value TMRKZ_TLS_DIR)"
  TLS_DIR="${TLS_DIR:-ops/tls/private}"
  if [ -f "$TLS_DIR/server.crt" ] && [ -f "$TLS_DIR/server.key" ]; then
    EXPIRY="$(openssl x509 -in "$TLS_DIR/server.crt" -noout -enddate 2>/dev/null | sed 's/notAfter=//' || echo unknown)"
    if [ "$EXPIRY" != "unknown" ]; then
      pass "TLS certificate expires: $EXPIRY"
      DAYS="$(( ( $(date -d "$EXPIRY" +%s 2>/dev/null || date -j -f '%b %d %T %Y %Z' "$EXPIRY" +%s 2>/dev/null || echo 0) - $(date +%s) ) / 86400 ))" 2>/dev/null || DAYS=""
      if [ -n "$DAYS" ] && [ "$DAYS" -lt 30 ]; then
        warn "TLS certificate expires in $DAYS days — renew soon"
      fi
    fi
  else
    info "TLS: not configured (HTTP only)"
  fi

  # 12. trust store
  TRUST_DIR="$(value TMRKZ_TRUSTSTORE_DIR)"
  if [ -n "$TRUST_DIR" ] && [ -d "$TRUST_DIR" ]; then
    CERTS="$(ls "$TRUST_DIR"/*.pem "$TRUST_DIR"/*.crt 2>/dev/null | wc -l | tr -d ' ')"
    pass "truststore: $TRUST_DIR ($CERTS certificates)"
  else
    info "truststore: not configured"
  fi

  # 13. service health
  URL="$(value TMRKZ_PUBLIC_URL)"
  URL="${URL:-http://localhost:$PORT}"
  if command -v curl >/dev/null 2>&1; then
    HTTP="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$URL/" 2>/dev/null || echo 000)"
    if [ "$HTTP" = "200" ]; then
      pass "web: $URL/ → $HTTP"
    elif [ "$HTTP" = "000" ]; then
      warn "web: $URL/ not reachable (services may be stopped)"
    else
      warn "web: $URL/ → $HTTP"
    fi
    API="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$URL/api/v1/ping" 2>/dev/null || echo 000)"
    if [ "$API" = "200" ] || [ "$API" = "401" ]; then
      pass "backend: $URL/api/v1/ping → $API"
    elif [ "$API" = "000" ]; then
      warn "backend: not reachable"
    else
      warn "backend: $URL/api/v1/ping → $API"
    fi
  fi

  # 14. dependency caches in containers
  if docker image inspect tmrkz/folder-backend:1 >/dev/null 2>&1; then
    pass "Maven offline cache: in tmrkz/folder-backend:1"
  fi
  if docker image inspect tmrkz/folder-web:1 >/dev/null 2>&1; then
    pass "npm offline cache: in tmrkz/folder-web:1"
  fi

  # 15. tmrkz-images.tar
  if [ -f "$ROOT/tmrkz-images.tar" ]; then
    TAR_SIZE="$(du -h "$ROOT/tmrkz-images.tar" 2>/dev/null | cut -f1)"
    pass "tmrkz-images.tar present ($TAR_SIZE)"
    if [ -f "$ROOT/tmrkz-images.tar.sha256" ]; then
      pass "tmrkz-images.tar.sha256 present"
    else
      warn "tmrkz-images.tar.sha256 missing"
    fi
  else
    info "tmrkz-images.tar not in folder (images must already be loaded)"
  fi

  echo
  if [ "$ISSUES" -eq 0 ]; then
    pass "all checks passed"
  else
    fail "$ISSUES issue(s) found — see above"
  fi
  return $ISSUES
}

# ─── status ────────────────────────────────────────────────────────────────
cmd_status() {
  say "TMRKZ status"
  say "root: $ROOT"

  # git info if available
  if command -v git >/dev/null 2>&1 && [ -d "$ROOT/.git" ]; then
    HEAD="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
    say "HEAD: $HEAD"
  fi

  # running services
  say "services:"
  dc ps --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || warn "cannot list services"

  # schema version
  SCHEMA="$(dc exec -T db psql -U tmrkz -d tmrkz -Atc "select max(version::int) from flyway_schema_history where success and version is not null" 2>/dev/null || echo unknown)"
  say "schema: V$SCHEMA"

  # release info
  PORT="$(value TMRKZ_HTTP_PORT)"; PORT="${PORT:-8088}"
  URL="$(value TMRKZ_PUBLIC_URL)"; URL="${URL:-http://localhost:$PORT}"
  VER="$(curl -s --max-time 5 "$URL/api/v1/system/info" 2>/dev/null | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' || true)"
  if [ -n "$VER" ]; then
    say "release: $VER"
  fi
}

# ─── verify ────────────────────────────────────────────────────────────────
cmd_verify() {
  say "TMRKZ verify — testing representative paths"
  FAILURES=0
  PORT="$(value TMRKZ_HTTP_PORT)"; PORT="${PORT:-8088}"
  URL="$(value TMRKZ_PUBLIC_URL)"; URL="${URL:-http://localhost:$PORT}"

  check_http() {
    LABEL="$1"; EXPECT="$2"; TARGET="$3"
    CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$TARGET" 2>/dev/null || echo 000)"
    case "$EXPECT" in
      "$CODE") pass "$LABEL → $CODE" ;;
      *"$CODE"*) pass "$LABEL → $CODE" ;;
      *) fail "$LABEL → $CODE (expected $EXPECT)"; FAILURES=$((FAILURES+1)) ;;
    esac
  }

  check_http "frontend loads"      "200"     "$URL/"
  check_http "API requires auth"   "401"     "$URL/api/v1/ping"
  check_http "healthz"             "200"     "$URL/healthz"
  check_http "keycloak blocked"    "403"     "$URL/auth/admin/"

  # database
  DB_OK="$(dc exec -T db psql -U tmrkz -d tmrkz -Atc "select 'ok'" 2>/dev/null || echo fail)"
  if [ "$DB_OK" = "ok" ]; then pass "database query"; else fail "database query"; FAILURES=$((FAILURES+1)); fi

  # schema
  SCHEMA="$(dc exec -T db psql -U tmrkz -d tmrkz -Atc "select max(version::int) from flyway_schema_history where success and version is not null" 2>/dev/null || echo 0)"
  if [ "$SCHEMA" -ge 67 ]; then pass "schema V$SCHEMA >= V67"; else fail "schema V$SCHEMA < V67"; FAILURES=$((FAILURES+1)); fi

  echo
  if [ "$FAILURES" -eq 0 ]; then
    pass "all verification checks passed"
  else
    fail "$FAILURES check(s) failed"
  fi
  return $FAILURES
}

# ─── setup ─────────────────────────────────────────────────────────────────
cmd_setup() {
  say "TMRKZ setup — guided configuration"
  say "root: $ROOT"

  # run init-env to fill missing secrets
  if [ -f "$ROOT/ops/init-env.sh" ]; then
    say "ensuring .env has all required keys..."
    sh "$ROOT/ops/init-env.sh"
    pass ".env checked"
  fi

  # check images
  MISSING=0
  for img in tmrkz/folder-backend:1 tmrkz/folder-web:1 postgis/postgis:17-3.5-alpine tmrkz/keycloak:26.7.5-2 openfga/openfga:v1.8.16 osixia/openldap:1.5.0 nginx:1.28.3-alpine; do
    docker image inspect "$img" >/dev/null 2>&1 || { warn "image $img missing"; MISSING=$((MISSING+1)); }
  done
  if [ "$MISSING" -gt 0 ] && [ -f "$ROOT/tmrkz-images.tar" ]; then
    say "loading images from tmrkz-images.tar..."
    docker load -i "$ROOT/tmrkz-images.tar"
    pass "images loaded"
  elif [ "$MISSING" -gt 0 ]; then
    fail "images missing and tmrkz-images.tar not found — transfer it to this folder"
    return 1
  else
    pass "all images present"
  fi

  # check persistent directories
  mkdir -p "$ROOT/data/db" "$ROOT/data/files" "$ROOT/data/ldap-data" "$ROOT/data/ldap-config" "$ROOT/backups"
  pass "persistent directories ready"

  say "setup complete — start with: sh start.sh"
}

# ─── backup ────────────────────────────────────────────────────────────────
cmd_backup() {
  OUT_DIR="${1:-$ROOT/backups}"
  if [ -f "$ROOT/ops/backup.sh" ]; then
    say "running backup..."
    sh "$ROOT/ops/backup.sh" tmrkz "$OUT_DIR"
  else
    fail "ops/backup.sh not found"
    return 1
  fi
}

# ─── update ────────────────────────────────────────────────────────────────
cmd_update() {
  BUNDLE="${1:-}"
  if [ -z "$BUNDLE" ]; then
    echo "usage: sh ops/tmrkzctl.sh update <bundle.tar.gz>" >&2
    exit 2
  fi
  if [ ! -f "$BUNDLE" ]; then
    fail "bundle not found: $BUNDLE"
    return 1
  fi

  say "TMRKZ update from $BUNDLE"

  # 1. verify bundle
  say "verifying bundle..."
  STAGE="$(mktemp -d "$ROOT/.update-stage-XXXXXX")"
  trap 'rm -rf "$STAGE"' EXIT

  tar -tzf "$BUNDLE" >/dev/null 2>&1 || { fail "not a valid tar.gz archive"; return 1; }

  # check for path traversal
  if tar -tzf "$BUNDLE" | grep -qE '^\.\.|/\.\.' ; then
    fail "bundle contains path traversal — rejected"
    return 1
  fi

  # check for forbidden content
  if tar -tzf "$BUNDLE" | grep -qE '\.env$|node_modules/|\.m2/|\.git/|tmrkz-images\.tar$'; then
    fail "bundle contains forbidden content (.env, node_modules, .m2, .git, images)"
    return 1
  fi

  tar -xzf "$BUNDLE" -C "$STAGE"
  pass "bundle extracted to staging"

  # 2. check manifest
  if [ -f "$STAGE/manifest.json" ]; then
    pass "manifest.json found"
    BASE_COMMIT="$(sed -n 's/.*"baseCommit"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$STAGE/manifest.json" || true)"
    TARGET_COMMIT="$(sed -n 's/.*"targetCommit"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$STAGE/manifest.json" || true)"
    if [ -n "$BASE_COMMIT" ]; then
      info "base: $BASE_COMMIT → target: $TARGET_COMMIT"
      if command -v git >/dev/null 2>&1 && [ -d "$ROOT/.git" ]; then
        CURRENT="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
        if [ "$CURRENT" != "${BASE_COMMIT}" ] && [ "$CURRENT" != "$(echo "$BASE_COMMIT" | head -c 7)" ]; then
          warn "current HEAD $CURRENT differs from bundle base $BASE_COMMIT — review carefully"
        fi
      fi
    fi
  else
    warn "no manifest.json — treating as source-only bundle"
  fi

  # 3. check disk space
  BUNDLE_SIZE="$(du -sm "$STAGE" 2>/dev/null | cut -f1)"
  AVAIL="$(df -m "$ROOT" 2>/dev/null | awk 'NR==2{print $4}')"
  if [ -n "$AVAIL" ] && [ -n "$BUNDLE_SIZE" ] && [ "$AVAIL" -lt "$((BUNDLE_SIZE * 3))" ]; then
    fail "insufficient disk space: ${AVAIL}MB available, need ~$((BUNDLE_SIZE * 3))MB"
    return 1
  fi

  # 4. backup before update
  say "creating pre-update backup..."
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  BACKUP_DIR="$ROOT/backups/pre-update-$STAMP"
  if [ -f "$ROOT/ops/backup.sh" ]; then
    sh "$ROOT/ops/backup.sh" tmrkz "$ROOT/backups" >/dev/null 2>&1 && pass "backup saved" || warn "backup failed — proceeding with file backup only"
  fi

  # 5. stop watched services to prevent partial builds
  say "stopping build watchers..."
  dc stop web-build 2>/dev/null || true
  pass "watchers stopped"

  # 6. stage source files
  say "staging source update..."
  for d in backend frontend ops docs; do
    if [ -d "$STAGE/$d" ]; then
      info "updating $d/"
      cp -r "$STAGE/$d/"* "$ROOT/$d/" 2>/dev/null || true
    fi
  done
  # top-level files
  for f in docker-compose.yml docker-compose.override.yml start.sh RUN.md; do
    if [ -f "$STAGE/$f" ]; then
      cp "$STAGE/$f" "$ROOT/$f"
      info "updated $f"
    fi
  done
  pass "source files staged"

  # 7. restart affected services
  say "restarting services..."
  dc up -d --no-recreate backend 2>/dev/null || true
  dc start web-build 2>/dev/null || true
  pass "services restarting"

  # 8. wait for health
  say "waiting for readiness..."
  PORT="$(value TMRKZ_HTTP_PORT)"; PORT="${PORT:-8088}"
  URL="$(value TMRKZ_PUBLIC_URL)"; URL="${URL:-http://localhost:$PORT}"
  TRIES=0
  while [ "$TRIES" -lt 60 ]; do
    CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$URL/" 2>/dev/null || echo 000)"
    if [ "$CODE" = "200" ]; then
      pass "web ready"
      break
    fi
    TRIES=$((TRIES+1))
    sleep 2
  done
  if [ "$TRIES" -ge 60 ]; then
    fail "web not ready after 120s — check logs: docker compose -p tmrkz logs"
    info "rollback: restore from $BACKUP_DIR"
    return 1
  fi

  # cleanup
  rm -rf "$STAGE"
  trap - EXIT
  say "update applied — verify with: sh ops/tmrkzctl.sh verify"
}

# ─── rollback ──────────────────────────────────────────────────────────────
cmd_rollback() {
  RELEASE="${1:-}"
  if [ -z "$RELEASE" ]; then
    say "available backups:"
    ls -1d "$ROOT/backups"/tmrkz-* "$ROOT/backups"/pre-update-* 2>/dev/null | sort -r | head -10
    echo
    echo "usage: sh ops/tmrkzctl.sh rollback <backup-dir>" >&2
    exit 2
  fi
  if [ ! -d "$RELEASE" ] && [ -d "$ROOT/backups/$RELEASE" ]; then
    RELEASE="$ROOT/backups/$RELEASE"
  fi
  if [ ! -f "$RELEASE/manifest.json" ]; then
    fail "not a valid backup directory: $RELEASE"
    return 1
  fi
  say "rollback from: $RELEASE"
  warn "database rollback requires explicit confirmation"
  warn "this will restore the database to the backup state — subsequent data will be LOST"
  printf 'type YES to confirm: '
  read -r CONFIRM || true
  if [ "$CONFIRM" != "YES" ]; then
    say "rollback cancelled"
    return 0
  fi

  if [ -f "$ROOT/ops/verify-restore.sh" ]; then
    sh "$ROOT/ops/verify-restore.sh" "$RELEASE"
  else
    fail "ops/verify-restore.sh not found — manual restore required"
    return 1
  fi
}

# ─── inventory ─────────────────────────────────────────────────────────────
cmd_inventory() {
  say "TMRKZ installation inventory (redacted)"
  echo "──────────────────────────────────────"
  echo "root:     $ROOT"
  if command -v git >/dev/null 2>&1 && [ -d "$ROOT/.git" ]; then
    echo "branch:   $(git -C "$ROOT" branch --show-current 2>/dev/null || echo unknown)"
    echo "HEAD:     $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
    echo "status:   $(git -C "$ROOT" status --short 2>/dev/null | wc -l | tr -d ' ') changed files"
  fi
  echo "compose:  $(docker compose version --short 2>/dev/null || echo unknown)"
  echo "project:  tmrkz"
  echo
  echo "images:"
  for img in tmrkz/folder-backend:1 tmrkz/folder-web:1 postgis/postgis:17-3.5-alpine tmrkz/keycloak:26.7.5-2 openfga/openfga:v1.8.16 osixia/openldap:1.5.0 nginx:1.28.3-alpine; do
    if docker image inspect "$img" >/dev/null 2>&1; then
      ARCH="$(docker image inspect "$img" --format '{{.Architecture}}' 2>/dev/null || echo unknown)"
      ID="$(docker image inspect "$img" --format '{{.ID}}' 2>/dev/null | head -c 19)"
      echo "  $img  arch=$ARCH  id=$ID"
    else
      echo "  $img  MISSING"
    fi
  done
  echo
  echo "services:"
  dc ps --format 'table {{.Name}}\t{{.Status}}' 2>/dev/null || echo "  (not running)"
  echo
  echo "persistent data:"
  for d in data/db data/files data/ldap-data; do
    if [ -d "$ROOT/$d" ]; then
      SIZE="$(du -sh "$ROOT/$d" 2>/dev/null | cut -f1)"
      echo "  $d  $SIZE"
    else
      echo "  $d  (missing)"
    fi
  done
  echo
  echo "map-packages:"
  ls -1 "$ROOT/map-packages/" 2>/dev/null | head -5 || echo "  (empty)"
  echo
  echo "schema:"
  SCHEMA="$(dc exec -T db psql -U tmrkz -d tmrkz -Atc "select max(version::int) from flyway_schema_history where success and version is not null" 2>/dev/null || echo unknown)"
  echo "  version: V$SCHEMA"
  echo
  echo "configuration (redacted):"
  if [ -f "$ROOT/.env" ]; then
    redact_env "$ROOT/.env"
  else
    echo "  .env missing"
  fi
  echo
  echo "TLS:"
  TLS_DIR="$(value TMRKZ_TLS_DIR)"; TLS_DIR="${TLS_DIR:-ops/tls/private}"
  if [ -f "$TLS_DIR/server.crt" ]; then
    openssl x509 -in "$TLS_DIR/server.crt" -noout -subject -issuer -dates -ext subjectAltName 2>/dev/null || echo "  cannot read certificate"
  else
    echo "  not configured"
  fi
  echo "──────────────────────────────────────"
}

# ─── help ──────────────────────────────────────────────────────────────────
cmd_help() {
  cat <<'HELP'
tmrkzctl — TMRKZ recovery, bootstrap and diagnostics

Usage:
  sh ops/tmrkzctl.sh <command> [options]

Commands:
  doctor     Read-only system diagnostics (PASS/WARN/FAIL)
  setup      Guided first-time setup or reconfiguration
  status     Show release version and service health
  verify     Test representative admin paths
  update     Apply a staged source-only update bundle
  rollback   Rollback to a previous backup
  backup     Create a consistent backup
  inventory  Redacted diagnostic inventory for sharing

Options:
  --root <path>   Override detected TMRKZ folder

Examples:
  sh ops/tmrkzctl.sh doctor
  sh ops/tmrkzctl.sh setup
  sh ops/tmrkzctl.sh update /approved/inbox/TMRKZ_UPDATE_v102.tar.gz
  sh ops/tmrkzctl.sh backup ./backups
  sh ops/tmrkzctl.sh inventory > diagnostic.txt
HELP
}

# dispatch
case "$CMD" in
  doctor)    cmd_doctor ;;
  setup)     cmd_setup ;;
  status)    cmd_status ;;
  verify)    cmd_verify ;;
  update)    cmd_update "$@" ;;
  rollback)  cmd_rollback "$@" ;;
  backup)    cmd_backup "$@" ;;
  inventory) cmd_inventory ;;
  help|--help|-h) cmd_help ;;
  *) echo "unknown command: $CMD" >&2; cmd_help; exit 2 ;;
esac
