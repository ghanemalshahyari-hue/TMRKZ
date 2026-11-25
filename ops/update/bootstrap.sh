#!/usr/bin/env sh
# One-time bootstrap of the browser Update Center on an installation that does not have it yet (ADR-104/105). Run from the
# unpacked bootstrap folder made by  sh ops/update/make-release.sh --bootstrap <commit>  on the development machine.
#
#   sh bootstrap.sh check   [/data/TMRKZ]                  read-only: checksums, signature, what would be replaced, added,
#                                                          removed and left different; the Compose differences; changes nothing
#   sh bootstrap.sh apply   [/data/TMRKZ] [--with-config]  backs up every file it touches into backups/bootstrap/<time>/, installs
#                                                          the application files, the release verification key and the baseline;
#                                                          the Compose files only with --with-config (after you read the diff)
#   sh bootstrap.sh restore /data/TMRKZ/backups/bootstrap/<time>   puts every file back exactly as it was before that apply
#
# Never written: .env, certs/, data/, backups/ (except its own new backup), map-data/, map-runtime/, ops/local/.generated/
# (except the public verification key, once), release/, .git/, any other docker-compose.*.yml (e.g. docker-compose.dc-hosts.yml),
# tmrkz-images.tar. No image is loaded or built and nothing is downloaded. After apply: sh start.sh (the images are unchanged).
set -eu
export LC_ALL=C
PKG="$(cd "$(dirname "$0")" && pwd)"
CMD="${1:-}"
die() { echo "[bootstrap] $*" >&2; exit 2; }
say() { echo "[bootstrap] $*"; }
TAB="$(printf '\t')"

# paths a bootstrap never writes (the same core list the maintenance worker hard-codes)
protected() {
  case "$1" in
    .env|.env.*|certs|certs/*|data|data/*|backups|backups/*|map-data|map-data/*|map-runtime|map-runtime/*|ops/local/.generated|ops/local/.generated/*) return 0 ;;
    release|release/*|.git|.git/*|tmrkz-images.tar|tmrkz-images.tar.sha256) return 0 ;;
    docker-compose.yml|docker-compose.override.yml) return 1 ;;
    docker-compose.*.yml) return 0 ;;
    /*|*..*|*'\'*) return 0 ;;
  esac
  return 1
}

if [ "$CMD" = restore ]; then
  B="${2:?usage: sh bootstrap.sh restore <installation>/backups/bootstrap/<time>}"
  B="$(cd "$B" && pwd)"
  T="$(cd "$B/../../.." && pwd)"
  [ -f "$B/written.txt" ] && [ -f "$T/start.sh" ] || die "not a bootstrap backup of an installation: $B"
  say "restoring $T from $B"
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    protected "$p" && [ "$p" != "ops/local/.generated/release-trust.pub" ] && die "refused path in the backup list: $p"
    if [ -f "$B/before/$p" ]; then mkdir -p "$T/$(dirname "$p")"; cat "$B/before/$p" > "$T/$p"; else rm -f "$T/$p"; fi
  done < "$B/written.txt"
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    mkdir -p "$T/$(dirname "$p")"; cp "$B/before/$p" "$T/$p"
  done < "$B/removed.txt"
  if [ -f "$B/baseline-before.tsv" ]; then cp "$B/baseline-before.tsv" "$T/backups/updates/installed-MANIFEST.tsv"; else rm -f "$T/backups/updates/installed-MANIFEST.tsv"; fi
  say "restored $(grep -c . "$B/written.txt" || true) written and $(grep -c . "$B/removed.txt" || true) removed files. Next: cd $T && sh start.sh"
  exit 0
fi

[ "$CMD" = check ] || [ "$CMD" = apply ] || die "usage: sh bootstrap.sh check|apply [/data/TMRKZ] [--with-config]  |  restore <backup>"
T="${2:-/data/TMRKZ}"
WITH_CONFIG=false
[ "${3:-}" = "--with-config" ] && WITH_CONFIG=true
[ -d "$T" ] || die "no installation folder $T"
T="$(cd "$T" && pwd)"
[ -f "$T/start.sh" ] && [ -f "$T/docker-compose.yml" ] && [ -d "$T/backend" ] && [ -d "$T/frontend" ] || die "$T does not look like a TMRKZ folder"
cd "$PKG"

# 1. the package is complete and unchanged
[ -f SHA256SUMS ] || die "SHA256SUMS missing in $PKG"
sha256sum -c --quiet SHA256SUMS || die "checksum mismatch: the package was altered or copied incompletely; nothing changed"
say "package checksums: OK"
TAR="$(ls TMRKZ-bootstrap-*.tar 2>/dev/null | head -n 1)"
[ -n "$TAR" ] || die "no TMRKZ-bootstrap-*.tar in $PKG"

# 2. the release is signed by the development machine's key, and its file list is the one signed
openssl pkeyutl -verify -pubin -inkey release-trust.pub -rawin -in RELEASE.json -sigfile RELEASE.bin >/dev/null 2>&1 \
  || { base64 -d RELEASE.sig > RELEASE.bin.tmp 2>/dev/null && openssl pkeyutl -verify -pubin -inkey release-trust.pub -rawin -in RELEASE.json \
       -sigfile RELEASE.bin.tmp >/dev/null 2>&1; } || { rm -f RELEASE.bin.tmp; die "the release signature does not verify; nothing changed"; }
rm -f RELEASE.bin.tmp
[ "$(sha256sum MANIFEST.tsv | cut -d' ' -f1)" = "$(sed -n 's/.*"manifestSha256":"\([0-9a-f]*\)".*/\1/p' RELEASE.json)" ] \
  || die "MANIFEST.tsv is not the signed one; nothing changed"
TRUST="$T/ops/local/.generated/release-trust.pub"
if [ -f "$TRUST" ] && ! cmp -s "$TRUST" release-trust.pub; then
  die "this installation already trusts another release key ($TRUST); nothing changed. Replace it only deliberately, by hand."
fi
say "release signature: OK ($(sed -n 's/.*"release":"\([^"]*\)".*/\1/p' RELEASE.json))"

# 3. unpack apart and check every file against the signed list; refuse any protected or unknown path
W="$T/.bootstrap-staging.$$"
rm -rf "$W"; mkdir -p "$W"
trap 'rm -rf "$W"' EXIT INT TERM
tar -tf "$TAR" > "$W/.list"
while IFS= read -r p; do
  case "$p" in */) continue ;; esac
  protected "$p" && die "refused: the package names a protected path ($p); nothing changed"
  grep -q "$TAB$p\$" MANIFEST.tsv || die "refused: $p is not in the signed list; nothing changed"
done < "$W/.list"
tar -xf "$TAR" -C "$W"
awk -F "$TAB" '$1 == "app" || $1 == "docs" {print $2 "\t" $4}' MANIFEST.tsv > "$W/.want"
: > "$W/.plan"
while IFS="$TAB" read -r sha p; do
  [ -f "$W/$p" ] || continue
  [ "$(sha256sum "$W/$p" | cut -d' ' -f1)" = "$sha" ] || die "refused: $p in the package is not the signed file; nothing changed"
  if [ ! -f "$T/$p" ]; then echo "ADD$TAB$p" >> "$W/.plan"
  elif [ "$(sha256sum "$T/$p" | cut -d' ' -f1)" != "$sha" ]; then echo "REPLACE$TAB$p" >> "$W/.plan"; fi
done < "$W/.want"
: > "$W/.remove"
if [ -f REMOVED.txt ]; then
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    protected "$p" && continue
    case "$p" in backend/*|frontend/*|ops/*|docs/*|map-packages/*|assets/*|handoff/*) ;; *) continue ;; esac
    [ -f "$T/$p" ] && echo "$p" >> "$W/.remove"
  done < REMOVED.txt
fi
ADDS="$(grep -c '^ADD' "$W/.plan" || true)"; REPL="$(grep -c '^REPLACE' "$W/.plan" || true)"; RMS="$(grep -c . "$W/.remove" || true)"
say "plan: replace $REPL, add $ADDS, remove $RMS files (application and documentation only)"
sed 's/^/    /' "$W/.plan" | head -n 60
[ "$RMS" -gt 0 ] && sed 's/^/    REMOVE\t/' "$W/.remove" | head -n 30
CFG_DIFF=false
for c in docker-compose.yml docker-compose.override.yml; do
  if [ -f "config/$c" ] && ! cmp -s "config/$c" "$T/$c"; then
    CFG_DIFF=true
    say "Compose file differs: $c (applied only with --with-config):"
    diff -u "$T/$c" "config/$c" | sed 's/^/    /' | head -n 80 || true
  fi
done
[ "$CMD" = check ] && { say "check only: nothing changed"; exit 0; }

# 4. back up everything that will be touched, then install
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
B="$T/backups/bootstrap/$STAMP"
mkdir -p "$B/before"
: > "$B/written.txt"; : > "$B/removed.txt"
keep() { if [ -f "$T/$1" ]; then mkdir -p "$B/before/$(dirname "$1")"; cp -p "$T/$1" "$B/before/$1"; fi; echo "$1" >> "$B/written.txt"; }
put() { mkdir -p "$T/$(dirname "$2")"; if [ -f "$T/$2" ]; then cat "$1" > "$T/$2"; else cp "$1" "$T/$2"; fi; }
[ -f "$T/backups/updates/installed-MANIFEST.tsv" ] && cp "$T/backups/updates/installed-MANIFEST.tsv" "$B/baseline-before.tsv"
while IFS="$TAB" read -r kind p; do keep "$p"; put "$W/$p" "$p"; done < "$W/.plan"
while IFS= read -r p; do mkdir -p "$B/before/$(dirname "$p")"; cp -p "$T/$p" "$B/before/$p"; echo "$p" >> "$B/removed.txt"; rm -f "$T/$p"; done < "$W/.remove"
if [ "$WITH_CONFIG" = true ]; then
  for c in docker-compose.yml docker-compose.override.yml; do
    [ -f "config/$c" ] && ! cmp -s "config/$c" "$T/$c" && { keep "$c"; put "config/$c" "$c"; say "Compose file replaced: $c (previous in $B/before/$c)"; }
  done
elif [ "$CFG_DIFF" = true ]; then
  say "Compose files NOT changed. The Update Center needs the «maintenance» service of the new docker-compose.override.yml:"
  say "  read the diff above, then run again with --with-config (your other Compose files stay as they are)"
fi
if [ ! -f "$TRUST" ]; then
  mkdir -p "$(dirname "$TRUST")"; cp release-trust.pub "$TRUST"; echo "ops/local/.generated/release-trust.pub" >> "$B/written.txt"
  say "installed the release verification key (public only): ops/local/.generated/release-trust.pub"
fi
# the baseline: the signed files this folder now holds unchanged — later updates flag a file changed here by hand
mkdir -p "$T/backups/updates"
awk -F "$TAB" '{print $2 "\t" $4}' MANIFEST.tsv | while IFS="$TAB" read -r sha p; do
  [ -f "$T/$p" ] && [ "$(sha256sum "$T/$p" | cut -d' ' -f1)" = "$sha" ] && printf '%s\t%s\n' "$sha" "$p"
done > "$T/backups/updates/installed-MANIFEST.tsv"
LEFT="$(awk -F "$TAB" '{print $2 "\t" $4}' MANIFEST.tsv | while IFS="$TAB" read -r sha p; do
  [ -f "$T/$p" ] && [ "$(sha256sum "$T/$p" | cut -d' ' -f1)" = "$sha" ] || echo "$p"; done | grep -c . || true)"
say "done: backup $B ($(grep -c . "$B/written.txt" || true) written, $(grep -c . "$B/removed.txt" || true) removed)"
say "$LEFT files of the release still differ here (not in this minimal package); the first browser update brings them"
say "next: cd $T && sh start.sh    then «إدارة النظام ← مركز التحديث»: «عامل الصيانة يعمل»"
say "undo: sh $PKG/bootstrap.sh restore $B   then sh start.sh"
