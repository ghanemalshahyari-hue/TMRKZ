#!/usr/bin/env sh
# One-time bootstrap of the browser Update Center on an installation that does not have it yet (ADR-104/105/106). Run from
# the unpacked bootstrap folder made by  sh ops/update/make-release.sh --bootstrap <commit>  on the development machine.
#
#   sh bootstrap.sh check   [/data/TMRKZ]                  read-only: checksums, signature, what this machine holds compared
#                                                          with the release (each differing file as at the package's commit,
#                                                          an earlier committed version, or changed on this machine), what
#                                                          would be replaced, added and removed; the Compose differences
#   sh bootstrap.sh apply   [/data/TMRKZ] [--with-config] [--keep-local | --overwrite-local]
#                                                          backs up every file it touches into backups/bootstrap/<time>/,
#                                                          installs the application files, the release verification key and
#                                                          the baseline; the Compose files only with --with-config. A file
#                                                          changed on this machine is never replaced silently: apply stops
#                                                          and names it, unless --keep-local (left as it is; the Update
#                                                          Center then lists it as changed locally) or --overwrite-local
#                                                          (replaced; the machine's file stays in the backup)
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
ZERO=0000000000000000000000000000000000000000000000000000000000000000

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

[ "$CMD" = check ] || [ "$CMD" = apply ] || die "usage: sh bootstrap.sh check|apply [/data/TMRKZ] [--with-config] [--keep-local|--overwrite-local]  |  restore <backup>"
shift
T=/data/TMRKZ
case "${1:-}" in --*|"") ;; *) T="$1"; shift ;; esac
WITH_CONFIG=false
LOCAL_RULE=stop
for a in "$@"; do
  case "$a" in
    --with-config) WITH_CONFIG=true ;;
    --keep-local) LOCAL_RULE=keep ;;
    --overwrite-local) LOCAL_RULE=overwrite ;;
    *) die "unknown option: $a" ;;
  esac
done
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
RELEASE="$(sed -n 's/.*"release":"\([^"]*\)".*/\1/p' RELEASE.json)"
say "release signature: OK ($RELEASE)"

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

# 4. what this machine holds (ADR-106): it may not be exactly the commit the package was made for (files copied by hand,
#    earlier transfers, local edits). Every released file that differs from the release, and every file the release removes,
#    is placed by git's id of its bytes: BASE = as at that commit, OLDER = an earlier committed version, LOCAL = changed on
#    this machine (no committed version has these bytes). A file copied from Windows with CRLF line ends is matched too.
BASE_COMMIT="$(sed -n 1p BASE-COMMIT.txt 2>/dev/null || true)"
[ -f BASE.tsv ] && [ -f KNOWN.tsv ] || die "BASE.tsv or KNOWN.tsv missing: make the package again with make-release.sh --bootstrap; nothing changed"
blob() { { printf 'blob %d\000' "$(wc -c < "$1" | tr -d ' ')"; cat "$1"; } | sha1sum | cut -d' ' -f1; }
awk -F "$TAB" '{print $4}' MANIFEST.tsv > "$W/.released"
# the machine's SHA-256 of every released file present, in one pass
(cd "$T" && while IFS= read -r p; do [ -f "$p" ] && printf '%s\000' "$p"; done < "$W/.released" | xargs -0 -r sha256sum) \
  | awk '{h = $1; sub(/^[0-9a-f]+ [ *]/, ""); print h "\t" $0}' > "$W/.vmsha"
awk -F "$TAB" 'NR == FNR {m[$2] = $1; next} ($4 in m) && m[$4] != $2 {print $4}' "$W/.vmsha" MANIFEST.tsv > "$W/.differ"
cat "$W/.remove" >> "$W/.differ"
: > "$W/.vm"
while IFS= read -r p; do
  [ -f "$T/$p" ] || continue
  b="$(blob "$T/$p")"; l="$b"
  # (byte counts, not grep: grep on Windows drops the CR before matching)
  tr -d '\r' < "$T/$p" > "$W/.lf"
  [ "$(wc -c < "$W/.lf" | tr -d ' ')" = "$(wc -c < "$T/$p" | tr -d ' ')" ] || l="$(blob "$W/.lf")"
  printf '%s\t%s\t%s\n' "$b" "$l" "$p" >> "$W/.vm"
done < "$W/.differ"
awk -F "$TAB" -v base=BASE.tsv -v known=KNOWN.tsv '
  BEGIN {
    while ((getline l < base) > 0) { split(l, f, "\t"); B[f[2]] = f[1] }
    while ((getline l < known) > 0) { split(l, f, "\t"); K[f[1] "\t" f[2]] = f[3] " " f[4] }
  }
  { b = $1; lf = $2; p = $3
    if (B[p] != "" && B[p] == b) print "BASE\t" p "\t"
    else if ((b "\t" p) in K) print "OLDER\t" p "\t" K[b "\t" p]
    else if (B[p] != "" && B[p] == lf) print "BASE\t" p "\tCRLF"
    else if ((lf "\t" p) in K) print "OLDER\t" p "\t" K[lf "\t" p] " CRLF"
    else print "LOCAL\t" p "\t" }' "$W/.vm" > "$W/.origin"
originof() { awk -F "$TAB" -v p="$1" '$2 == p {print $1; exit}' "$W/.origin"; }
SAME="$(awk -F "$TAB" 'NR == FNR {m[$2] = $1; next} ($4 in m) && m[$4] == $2' "$W/.vmsha" MANIFEST.tsv | grep -c . || true)"
ABSENT="$(awk -F "$TAB" 'NR == FNR {m[$2] = 1; next} !($4 in m)' "$W/.vmsha" MANIFEST.tsv | grep -c . || true)"
NB="$(grep -c '^BASE' "$W/.origin" || true)"; NO="$(grep -c '^OLDER' "$W/.origin" || true)"; NL="$(grep -c '^LOCAL' "$W/.origin" || true)"
say "this machine compared with release $RELEASE (package made for commit ${BASE_COMMIT:-?}):"
say "  $SAME released files identical, $ABSENT not present here; differing: $NB as at that commit, $NO an earlier committed version, $NL changed on this machine"
[ "$NO" -gt 0 ] && { say "  earlier committed versions (not edited here; the first browser update brings them up to date):"; grep '^OLDER' "$W/.origin" | head -n 25 | sed 's/^OLDER\t/    /; s/\t/   from /'; }
[ "$NL" -gt 0 ] && { say "  CHANGED ON THIS MACHINE (no committed version has these bytes):"; grep '^LOCAL' "$W/.origin" | cut -f2 | sed 's/^/    /' | head -n 200; }

# 5. the plan: a file changed on this machine is a conflict wherever the package would replace or remove it
: > "$W/.conflicts"
while IFS="$TAB" read -r kind p; do [ "$kind" = REPLACE ] && [ "$(originof "$p")" = LOCAL ] && echo "$p" >> "$W/.conflicts"; done < "$W/.plan"
while IFS= read -r p; do [ "$(originof "$p")" = LOCAL ] && echo "$p" >> "$W/.conflicts"; done < "$W/.remove"
CFG_DIFF=false
for c in docker-compose.yml docker-compose.override.yml; do
  if [ -f "config/$c" ] && ! cmp -s "config/$c" "$T/$c"; then
    CFG_DIFF=true
    o="$(originof "$c")"
    say "Compose file differs: $c ($([ "$o" = LOCAL ] && echo 'CHANGED ON THIS MACHINE — merge by hand, ' || true)applied only with --with-config):"
    diff -u "$T/$c" "config/$c" | sed 's/^/    /' | head -n 80 || true
    [ "$o" = LOCAL ] && [ "$WITH_CONFIG" = true ] && echo "$c" >> "$W/.conflicts"
  fi
done
ADDS="$(grep -c '^ADD' "$W/.plan" || true)"; REPL="$(grep -c '^REPLACE' "$W/.plan" || true)"; RMS="$(grep -c . "$W/.remove" || true)"
NC="$(grep -c . "$W/.conflicts" || true)"
say "plan: replace $REPL, add $ADDS, remove $RMS files (application and documentation only); $NC of them changed on this machine"
while IFS="$TAB" read -r kind p; do
  printf '    %s\t%s%s\n' "$kind" "$p" "$(grep -qxF "$p" "$W/.conflicts" && echo '   ← changed on this machine' || true)"
done < "$W/.plan" | head -n 80
[ "$RMS" -gt 0 ] && sed 's/^/    REMOVE\t/' "$W/.remove" | head -n 30
if [ "$NC" -gt 0 ]; then
  say "files changed on this machine that this package would replace or remove ($NC):"
  sed 's/^/    /' "$W/.conflicts"
  say "  compare each with the release first (e.g. tar -xOf $TAR <path> | diff -u $T/<path> -), then apply with ONE of:"
  say "    --keep-local       leave them as they are (the Update Center lists them as «معدّل على هذا الجهاز» until you decide)"
  say "    --overwrite-local  replace them (the machine's version is kept in backups/bootstrap/<time>/before/)"
fi
if [ "$CMD" = check ]; then say "check only: nothing changed"; exit 0; fi
[ "$NC" -gt 0 ] && [ "$LOCAL_RULE" = stop ] && die "stopped: $NC files changed on this machine would be replaced (listed above); nothing changed"

# 6. back up everything that will be touched, then install (with --keep-local, without the files changed on this machine)
if [ "$LOCAL_RULE" = keep ] && [ "$NC" -gt 0 ]; then
  awk -F "$TAB" 'NR == FNR {c[$0] = 1; next} !($2 in c)' "$W/.conflicts" "$W/.plan" > "$W/.plan2"; mv "$W/.plan2" "$W/.plan"
  grep -vxF -f "$W/.conflicts" "$W/.remove" > "$W/.remove2" || true; mv "$W/.remove2" "$W/.remove"
fi
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
B="$T/backups/bootstrap/$STAMP"
mkdir -p "$B/before"
: > "$B/written.txt"; : > "$B/removed.txt"
cp "$W/.origin" "$B/machine-origin.tsv"
keep() { if [ -f "$T/$1" ]; then mkdir -p "$B/before/$(dirname "$1")"; cp -p "$T/$1" "$B/before/$1"; fi; echo "$1" >> "$B/written.txt"; }
put() { mkdir -p "$T/$(dirname "$2")"; if [ -f "$T/$2" ]; then cat "$1" > "$T/$2"; else cp "$1" "$T/$2"; fi; }
[ -f "$T/backups/updates/installed-MANIFEST.tsv" ] && cp "$T/backups/updates/installed-MANIFEST.tsv" "$B/baseline-before.tsv"
while IFS="$TAB" read -r kind p; do keep "$p"; put "$W/$p" "$p"; done < "$W/.plan"
while IFS= read -r p; do mkdir -p "$B/before/$(dirname "$p")"; cp -p "$T/$p" "$B/before/$p"; echo "$p" >> "$B/removed.txt"; rm -f "$T/$p"; done < "$W/.remove"
if [ "$WITH_CONFIG" = true ]; then
  for c in docker-compose.yml docker-compose.override.yml; do
    if [ -f "config/$c" ] && ! cmp -s "config/$c" "$T/$c"; then
      if [ "$LOCAL_RULE" = keep ] && grep -qxF "$c" "$W/.conflicts"; then say "Compose file kept as it is (changed on this machine): $c — merge the maintenance service by hand"; continue; fi
      keep "$c"; put "config/$c" "$c"; say "Compose file replaced: $c (previous in $B/before/$c)"
    fi
  done
elif [ "$CFG_DIFF" = true ]; then
  say "Compose files NOT changed. The Update Center needs the «maintenance» service of the new docker-compose.override.yml:"
  say "  read the diff above, then run again with --with-config (your other Compose files stay as they are)"
fi
if [ ! -f "$TRUST" ]; then
  mkdir -p "$(dirname "$TRUST")"; cp release-trust.pub "$TRUST"; echo "ops/local/.generated/release-trust.pub" >> "$B/written.txt"
  say "installed the release verification key (public only): ops/local/.generated/release-trust.pub"
fi
# the baseline the Update Center compares with (ADR-106): a released file as signed → its hash; a committed version of an
# earlier release, not edited here → its own hash (the first browser update replaces it as an ordinary update); a file changed
# on this machine and kept → a mark no file has, so the Update Center shows it as «معدّل على هذا الجهاز» and asks before replacing it
mkdir -p "$T/backups/updates"
(cd "$T" && while IFS= read -r p; do [ -f "$p" ] && printf '%s\000' "$p"; done < "$W/.released" | xargs -0 -r sha256sum) \
  | awk '{h = $1; sub(/^[0-9a-f]+ [ *]/, ""); print h "\t" $0}' > "$W/.now"
awk -F "$TAB" -v zero="$ZERO" '
  FILENAME == ARGV[1] {o[$2] = $1; next}
  FILENAME == ARGV[2] {want[$4] = $2; next}
  { p = $2; h = $1
    if (want[p] == h || o[p] == "BASE" || o[p] == "OLDER") print h "\t" p
    else print zero "\t" p }' "$W/.origin" MANIFEST.tsv "$W/.now" > "$T/backups/updates/installed-MANIFEST.tsv"
LEFT="$(awk -F "$TAB" 'NR == FNR {m[$2] = $1; next} m[$4] != $2' "$W/.now" MANIFEST.tsv | grep -c . || true)"
KEPT="$(grep -c "^$ZERO" "$T/backups/updates/installed-MANIFEST.tsv" || true)"
say "done: backup $B ($(grep -c . "$B/written.txt" || true) written, $(grep -c . "$B/removed.txt" || true) removed)"
say "$LEFT files of the release still differ here (not in this minimal package); the first browser update brings them"
[ "$KEPT" -gt 0 ] && say "$KEPT files changed on this machine were kept; the Update Center lists them as «معدّل على هذا الجهاز» and asks before replacing them"
say "next: cd $T && sh start.sh    then «إدارة النظام ← مركز التحديث»: «عامل الصيانة يعمل»"
say "undo: sh $PKG/bootstrap.sh restore $B   then sh start.sh"
