#!/usr/bin/env sh
# A signed release of this TMRKZ folder for the Update Center (ADR-104). The same folder is the development copy and the
# installation; the release only lists which of its files an update carries (ops/update/managed-paths.conf) with their
# SHA-256, and signs that list. The Update Center of a machine accepts the release only when the signature verifies with the
# public key installed there once (ops/local/.generated/release-trust.pub), and then uploads only the files that differ.
#
#   sh ops/update/make-release.sh --init-key   once, on the machine where releases are made: creates the signing key
#   sh ops/update/make-release.sh              writes release/RELEASE.json, release/MANIFEST.tsv, release/RELEASE.sig
#   sh ops/update/make-release.sh --package    also the one-time transfer package for a machine without the Update Center:
#                                              release/TMRKZ-app-<id>.tar (app + docs files only, never a protected one),
#                                              release/config/ (the Compose files, to compare with the machine's, never extracted)
#   sh ops/update/make-release.sh --bootstrap <commit>   the MINIMAL one-time package for a machine running <commit> (ADR-105):
#                                              release/bootstrap/ (changed files only, signed list, Compose files for review,
#                                              public key, bootstrap.sh, INSTALL.txt, SHA256SUMS)
#   Windows CMD:  "C:\Program Files\Git\bin\sh.exe" ops/update/make-release.sh
#
# Needs sh, awk, sha256sum and openssl (Git for Windows and Ubuntu have them). Nothing is downloaded; nothing outside
# release/ (and, with --init-key, ops/local/.generated/) is written. With git, the release is git's tracked files as they are
# in the folder now; without git, every file the rules name.
set -eu
export LC_ALL=C
cd "$(dirname "$0")/../.."
G=ops/local/.generated
KEY="${TMRKZ_RELEASE_KEY:-$G/release-signing.key}"
PUB="$G/release-signing.pub"
RULES=ops/update/managed-paths.conf
OUT=release
MAX=$((24 * 1024 * 1024))

if [ "${1:-}" = "--init-key" ]; then
  if [ -f "$KEY" ]; then echo "the signing key exists already: $KEY"; exit 0; fi
  mkdir -p "$G"
  openssl genpkey -algorithm ed25519 -out "$KEY" 2>/dev/null
  chmod 600 "$KEY" 2>/dev/null || true
  openssl pkey -in "$KEY" -pubout -out "$PUB" 2>/dev/null
  [ -f "$G/release-trust.pub" ] || cp "$PUB" "$G/release-trust.pub"
  echo "signing key (stays on this machine, never copied): $KEY"
  echo "public key: $PUB"
  echo "install it ONCE on each machine that accepts updates, as  ops/local/.generated/release-trust.pub"
  exit 0
fi
PACKAGE=false
[ "${1:-}" = "--package" ] && PACKAGE=true
# --bootstrap <commit>: the minimal one-time package for a machine at that commit (ADR-105), see the end of this script
SINCE=""
if [ "${1:-}" = "--bootstrap" ]; then
  SINCE="${2:?usage: sh ops/update/make-release.sh --bootstrap <commit the machine runs, e.g. e30c1c1>}"
  git rev-parse --verify --quiet "$SINCE^{commit}" >/dev/null || { echo "unknown commit: $SINCE" >&2; exit 2; }
fi
[ -f "$KEY" ] || { echo "no signing key: run  sh ops/update/make-release.sh --init-key  first" >&2; exit 2; }
[ -f "$RULES" ] || { echo "missing $RULES" >&2; exit 2; }

# a relative working directory: native tools (openssl.exe on Windows) then need no path translation
TMP="$OUT/.work.$$"; rm -rf "$TMP"; mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT INT TERM

# 1. the candidate files
COMMIT=""; DIRTY=false
if [ -d .git ] && command -v git >/dev/null 2>&1; then
  # tracked files and new files git does not ignore (a new source file not yet committed is part of the folder)
  git -c core.quotepath=off ls-files -co --exclude-standard > "$TMP/all"
  COMMIT="$(git rev-parse HEAD 2>/dev/null || true)"
  [ -z "$(git status --porcelain --untracked-files=no 2>/dev/null)" ] || DIRTY=true
else
  find . -type f | sed 's#^\./##' > "$TMP/all"
fi

# 2. the class of each path (first matching rule; unnamed = dev); only app, config and docs are released
awk -v rules="$RULES" '
  function glob2re(g,   r, i, c, n) {
    r = ""; n = length(g)
    for (i = 1; i <= n; i++) {
      c = substr(g, i, 1)
      if (c == "*" && substr(g, i + 1, 1) == "*") {
        if (substr(g, i + 2, 1) == "/") { r = r "(.*/)?"; i += 2 } else { r = r ".*"; i++ }
        if (substr(r, length(r) - 3) == "/.*" && 0) {}
      } else if (c == "*") { r = r "[^/]*" }
      else if (c == "?") { r = r "[^/]" }
      else if (index(".+()^$|{}[]\\", c)) { r = r "\\" c }
      else { r = r c }
    }
    sub(/\/\.\*$/, "(/.*)?", r)
    return "^" r "$"
  }
  BEGIN {
    while ((getline line < rules) > 0) {
      sub(/\r$/, "", line)
      if (line ~ /^[ \t]*(#|$)/) continue
      split(line, f, /[ \t]+/)
      n++; cls[n] = f[1]; re[n] = glob2re(f[2])
    }
  }
  {
    sub(/\r$/, ""); p = $0; c = "dev"
    for (i = 1; i <= n; i++) if (p ~ re[i]) { c = cls[i]; break }
    if (c == "app" || c == "config" || c == "docs") print c "\t" p
  }' "$TMP/all" > "$TMP/classified"

# 3. SHA-256 and size of each released file that exists now (a tracked file deleted in the folder is not released)
: > "$TMP/manifest"
TAB="$(printf '\t')"
: > "$TMP/present"
while IFS="$TAB" read -r cls path; do
  [ -L "$path" ] && { echo "refused: $path is a symbolic link" >&2; exit 3; }
  [ -f "$path" ] && printf '%s\t%s\n' "$cls" "$path" >> "$TMP/present"
done < "$TMP/classified"
# in batches: one sha256sum and one stat for all files, not two processes per file
cut -f2 "$TMP/present" | tr '\n' '\0' | xargs -0 -r sha256sum > "$TMP/sums"
cut -f2 "$TMP/present" | tr '\n' '\0' | xargs -0 -r stat -c '%s %n' > "$TMP/sizes"
awk -v sums="$TMP/sums" -v sizes="$TMP/sizes" '
  BEGIN {
    while ((getline l < sums) > 0) { h = substr(l, 1, 64); p = substr(l, 67); sum[p] = h }
    while ((getline l < sizes) > 0) { i = index(l, " "); size[substr(l, i + 1)] = substr(l, 1, i - 1) }
    FS = "\t"
  }
  { if (!($2 in sum) || !($2 in size)) { print "cannot read " $2 > "/dev/stderr"; exit 5 }
    printf "%s\t%s\t%s\t%s\n", $1, sum[$2], size[$2], $2 }' "$TMP/present" > "$TMP/manifest"
sort -t "$TAB" -k4,4 "$TMP/manifest" > "$TMP/MANIFEST.tsv"

FILES="$(wc -l < "$TMP/MANIFEST.tsv" | tr -d ' ')"
BYTES="$(awk -F '\t' '{s += $3} END {print s + 0}' "$TMP/MANIFEST.tsv")"
LARGE="$(awk -F '\t' -v m="$MAX" '$3 > m {print $4}' "$TMP/MANIFEST.tsv" | tr '\n' ' ')"
MSHA="$(sha256sum "$TMP/MANIFEST.tsv" | cut -d' ' -f1)"
RSHA="$(sha256sum "$RULES" | cut -d' ' -f1)"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SHORT="$(printf '%s' "${COMMIT:-nogit}" | cut -c1-7)"
ID="$(date -u +%Y%m%d-%H%M%S)-$SHORT"; [ "$DIRTY" = true ] && ID="$ID-local"
printf '{"format":1,"release":"%s","createdAt":"%s","commit":"%s","localChanges":%s,"files":%s,"bytes":%s,"manifestSha256":"%s","rulesSha256":"%s"}\n' \
  "$ID" "$NOW" "$COMMIT" "$DIRTY" "$FILES" "$BYTES" "$MSHA" "$RSHA" > "$TMP/RELEASE.json"
openssl pkeyutl -sign -rawin -inkey "$KEY" -in "$TMP/RELEASE.json" -out "$TMP/RELEASE.bin" 2>/dev/null \
  || { echo "signing failed (openssl 3 with Ed25519 is needed)" >&2; exit 4; }
base64 < "$TMP/RELEASE.bin" | tr -d '\n' > "$TMP/RELEASE.sig"

mkdir -p "$OUT"
cp "$TMP/MANIFEST.tsv" "$OUT/MANIFEST.tsv"; cp "$TMP/RELEASE.json" "$OUT/RELEASE.json"; cp "$TMP/RELEASE.sig" "$OUT/RELEASE.sig"
rm -rf "$OUT/config" "$OUT"/TMRKZ-app-*.tar
SUMS="MANIFEST.tsv RELEASE.json RELEASE.sig"
if [ "$PACKAGE" = true ]; then
  # the one-time transfer (ADR-104): the application and documentation files exactly as listed; the Compose files apart
  awk -F '	' '$1 == "app" || $1 == "docs" {print $4}' "$OUT/MANIFEST.tsv" > "$TMP/package.list"
  tar -cf "$OUT/TMRKZ-app-$ID.tar" -T "$TMP/package.list"
  mkdir -p "$OUT/config"
  awk -F '	' '$1 == "config" {print $4}' "$OUT/MANIFEST.tsv" | while read -r f; do cp "$f" "$OUT/config/"; done
  SUMS="$SUMS TMRKZ-app-$ID.tar $(cd "$OUT" && ls config/* 2>/dev/null | tr '
' ' ')"
fi
( cd "$OUT" && sha256sum $SUMS > SHA256SUMS )
if [ -n "$SINCE" ]; then
  # the minimal bootstrap (ADR-105): only the application and documentation files changed since the machine's commit (plus
  # the Update Center itself), the signed full list to check them against, the Compose files for review, the PUBLIC key, and
  # ops/update/bootstrap.sh. Never the signing key, .env, data, certificates or maps.
  BS="$OUT/bootstrap"
  rm -rf "$BS"; mkdir -p "$BS/config"
  { git -c core.quotepath=off diff --name-only --no-renames "$SINCE" -- . ; git -c core.quotepath=off ls-files -o --exclude-standard; } | sort -u > "$TMP/changed"
  awk -F '	' 'NR == FNR {c[$0] = 1; next} ($1 == "app" || $1 == "docs") && ($4 in c || $4 ~ /^ops\/update\//) {print $4}' \
    "$TMP/changed" "$OUT/MANIFEST.tsv" > "$TMP/bootstrap.list"
  # application and documentation files that existed at that commit and are gone now
  git -c core.quotepath=off diff --name-only --no-renames --diff-filter=D "$SINCE" -- backend frontend ops docs map-packages assets handoff \
    | grep -v -e '^ops/local/\.generated/' -e '^backend/src/test/' > "$BS/REMOVED.txt" || true
  tar -cf "$BS/TMRKZ-bootstrap-$ID.tar" -T "$TMP/bootstrap.list"
  awk -F '	' '$1 == "config" {print $4}' "$OUT/MANIFEST.tsv" | while read -r f; do cp "$f" "$BS/config/"; done
  cp "$OUT/MANIFEST.tsv" "$OUT/RELEASE.json" "$OUT/RELEASE.sig" "$BS/"
  cp "$PUB" "$BS/release-trust.pub"
  cp ops/update/bootstrap.sh "$BS/bootstrap.sh"
  # what the machine may hold (ADR-106), as git ids of file bytes (the machine computes them without git): each released or
  # removed file as at <commit> (BASE.tsv), and every version of it ever committed (KNOWN.tsv: id, path, commit, date) — so
  # the bootstrap tells a file changed on the machine from one left at an earlier release
  { awk -F '	' '{print $4}' "$OUT/MANIFEST.tsv"; cat "$BS/REMOVED.txt"; } | sort -u > "$TMP/known.paths"
  git -c core.quotepath=off ls-tree -r "$SINCE" \
    | awk -F '	' 'NR == FNR {w[$0] = 1; next} {split($1, a, " "); if (a[2] == "blob" && ($2 in w)) print a[3] "\t" $2}' "$TMP/known.paths" - > "$BS/BASE.tsv"
  git -c core.quotepath=off log --format='@%h %cs' --raw --no-abbrev --no-renames HEAD \
    | awk -F '	' 'NR == FNR {w[$0] = 1; next} /^@/ {split(substr($0, 2), c, " "); next}
        /^:/ {split($1, a, " "); if (a[4] !~ /^0+$/ && ($2 in w)) print a[4] "\t" $2 "\t" substr(c[1], 1, 7) "\t" c[2]}' "$TMP/known.paths" - \
    | sort -u > "$BS/KNOWN.tsv"
  printf '%s\n%s\n' "$(git rev-parse --short "$SINCE")" "$(git log -1 --format='%H %cs %s' "$SINCE")" > "$BS/BASE-COMMIT.txt"
  cat > "$BS/INSTALL.txt" <<EOF
TMRKZ one-time bootstrap $ID (for a machine at commit $SINCE)

Copy this whole folder to the machine, e.g. /data/tmrkz-bootstrap-$ID, then as the maintenance account (PAM, once):
  cd /data/tmrkz-bootstrap-$ID
  sh bootstrap.sh check /data/TMRKZ                    # read-only: checksums, signature, what this machine holds compared
                                                       # with the release (files changed here are named), the Compose diff
  sh bootstrap.sh apply /data/TMRKZ --with-config      # after reading the check; it stops if a file changed here would be
                                                       # replaced: add --keep-local (leave them) or --overwrite-local
  cd /data/TMRKZ && sh start.sh                        # the images are unchanged; no tmrkz-images.tar is needed
Then in the browser: «إدارة النظام ← مركز التحديث» must show «عامل الصيانة يعمل». Later updates go through the browser only.
Undo: sh bootstrap.sh restore /data/TMRKZ/backups/bootstrap/<time printed by apply>   then  sh start.sh
Never copied here and never needed on the machine: the release signing key, .env, data/, certs/, map-data/, map-runtime/.
EOF
  ( cd "$BS" && sha256sum TMRKZ-bootstrap-"$ID".tar MANIFEST.tsv RELEASE.json RELEASE.sig release-trust.pub bootstrap.sh REMOVED.txt INSTALL.txt \
      BASE.tsv KNOWN.tsv BASE-COMMIT.txt config/* > SHA256SUMS )
  echo "bootstrap package: $BS ($(grep -c . "$TMP/bootstrap.list") files, $(du -k "$BS/TMRKZ-bootstrap-$ID.tar" | cut -f1) KB tar, $(grep -c . "$BS/REMOVED.txt" || true) removals listed)"
fi
echo "release $ID: $FILES files, $BYTES bytes$( [ "$DIRTY" = true ] && echo ', includes changes not yet committed')"
[ -z "$LARGE" ] || echo "note: larger than the browser upload limit (24 MB), transferred by the operator instead: $LARGE"
echo "written: $OUT/RELEASE.json  $OUT/MANIFEST.tsv  $OUT/RELEASE.sig  $OUT/SHA256SUMS"
echo "next: open the Update Center of the target machine and choose this folder ($(pwd))"
