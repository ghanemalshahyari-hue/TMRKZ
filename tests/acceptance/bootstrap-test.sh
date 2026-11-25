#!/usr/bin/env sh
# The one-time bootstrap package (ADR-105/106) on a throw-away copy of an installation at an older commit (git archive of that
# commit — not a worktree), with fictional .env, certificates, data and a machine Compose file, and the kinds of drift a real
# machine has: a file edited by hand inside the package, one outside it, a file left at an EARLIER commit, a file copied from
# Windows with CRLF line ends. No container is started.
#
#   sh tests/acceptance/bootstrap-test.sh <empty-dir> [commit, default e30c1c1]
#
# BS-01 the package is built from the changed files only; BS-02 check changes nothing and places every differing file (as at
# the commit, an earlier committed version, changed on this machine); BS-03 apply stops before replacing a file changed on the
# machine; with --keep-local it installs, keeps protected and locally changed files byte for byte, installs only the PUBLIC key
# and a baseline that marks the kept files as changed locally; BS-04 restore puts back every file exactly; BS-05 a package
# altered after it was made, and one that smuggles .env in with recomputed checksums, are refused and change nothing; BS-06
# --overwrite-local replaces the changed file and keeps the machine's version in the backup.
set -eu
export MSYS_NO_PATHCONV=1
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
D="${1:?empty directory}"
SINCE="${2:-e30c1c1}"
mkdir -p "$D"; D="$(cd "$D" && pwd)"
[ -z "$(ls -A "$D")" ] || { echo "refused: $D is not empty"; exit 2; }
pass=0; fail=0
ok() { if [ "$1" = 0 ]; then pass=$((pass + 1)); echo "PASS  $2"; else fail=$((fail + 1)); echo "FAIL  $2"; fi; }
snap() { (cd "$D/TMRKZ" && find . -type f -not -path './backups/*' | sort | xargs sha256sum); }

mkdir -p "$D/TMRKZ"
(cd "$SRC" && git archive "$SINCE" -- start.sh RUN.md README.md FONT-LICENSE.txt docker-compose.yml docker-compose.override.yml backend frontend ops docs \
  map-packages assets handoff) | tar -x -C "$D/TMRKZ"
# the drift of a real machine
INSIDE=frontend/src/pages/DeploymentAreasRequest.tsx                     # in the package: changed since $SINCE
OUTSIDE="$(cd "$SRC" && git ls-tree -r --name-only "$SINCE" backend/src/main/java/ae/mover/common \
  | while read -r f; do git diff --quiet "$SINCE" -- "$f" && { echo "$f"; break; }; done)"   # edited by hand, not in the package
OLDER="$(cd "$SRC" && git diff --name-only "$SINCE~6" "$SINCE" -- docs | grep '\.md$' | head -n 1)"   # left at an earlier commit
WINDOWS=RUN.md                                                            # copied from Windows: CRLF line ends
cd "$D/TMRKZ"
printf 'COMPOSE_PROJECT_NAME=tmrkz\nTMRKZ_IP=10.0.0.5\nFICTIONAL_SECRET=keep-me\n' > .env
mkdir -p certs data/db map-runtime ops/local/.generated
echo fictional > certs/ca.pem; echo pg > data/db/PG_VERSION; printf 'services: {}\n' > docker-compose.dc-hosts.yml
echo '// local edit on the machine' >> "$OUTSIDE"
echo '// local edit inside the package' >> "$INSIDE"
(cd "$SRC" && git show "$SINCE~6:$OLDER") > "$OLDER"
sed 's/$/\r/' "$WINDOWS" > "$WINDOWS.crlf" && mv "$WINDOWS.crlf" "$WINDOWS"
sha256sum "$INSIDE" "$OUTSIDE" > "$D/local.sha"
snap > "$D/before.sha"
cd "$SRC"
OUTPUT="$(sh ops/update/make-release.sh --bootstrap "$SINCE" 2>&1)"
echo "$OUTPUT" | grep '^bootstrap package' || true
[ -f release/bootstrap/SHA256SUMS ] && [ -s release/bootstrap/BASE.tsv ] && [ -s release/bootstrap/KNOWN.tsv ] \
  && ! tar -tf release/bootstrap/TMRKZ-bootstrap-*.tar | grep -qE '(^|/)(\.env|release-signing\.key)$|^(data|certs|map-runtime|ops/local/\.generated)/'
ok $? "BS-01 minimal package built with the commit's file ids; no key, .env, data or certificates in it"
cp -r release/bootstrap "$D/pkg"
cd "$D/pkg"
sh bootstrap.sh check "$D/TMRKZ" > "$D/check.txt" 2>&1
snap | diff -q - "$D/before.sha" >/dev/null
ok $? "BS-02 check is read-only ($(grep -o 'plan: .*' "$D/check.txt"))"
grep -A 200 'CHANGED ON THIS MACHINE' "$D/check.txt" | grep -qF "$INSIDE" && grep -A 200 'CHANGED ON THIS MACHINE' "$D/check.txt" | grep -qF "$OUTSIDE" \
  && grep -qF "$OLDER   from" "$D/check.txt" && ! grep -A 200 'CHANGED ON THIS MACHINE' "$D/check.txt" | grep -qxF "    $WINDOWS" \
  && grep -qF "$INSIDE   ← changed on this machine" "$D/check.txt"
ok $? "BS-02 check names both hand edits, the file of an earlier commit (not as an edit), a CRLF copy as unchanged"
grep -E 'compared with|identical' "$D/check.txt" | sed 's/^/      /'
! sh bootstrap.sh apply "$D/TMRKZ" --with-config > "$D/stopped.txt" 2>&1 && grep -q 'stopped: 1 files changed on this machine' "$D/stopped.txt" \
  && snap | diff -q - "$D/before.sha" >/dev/null
ok $? "BS-03 apply stops before replacing a file changed on this machine, and changes nothing"
sh bootstrap.sh apply "$D/TMRKZ" --with-config --keep-local > "$D/apply.txt" 2>&1
grep -F -e './.env' -e './certs/' -e './data/' -e './docker-compose.dc-hosts.yml' "$D/before.sha" > "$D/protected.sha"
(cd "$D/TMRKZ" && sha256sum -c --quiet "$D/protected.sha" && sha256sum -c --quiet "$D/local.sha")
ok $? "BS-03 .env, certs/, data/, docker-compose.dc-hosts.yml and both hand-edited files byte for byte unchanged (--keep-local)"
BASEL="$D/TMRKZ/backups/updates/installed-MANIFEST.tsv"
[ -f "$D/TMRKZ/ops/local/.generated/release-trust.pub" ] && [ ! -f "$D/TMRKZ/ops/local/.generated/release-signing.key" ] \
  && [ -s "$BASEL" ] && grep -q 'maintenance:' "$D/TMRKZ/docker-compose.override.yml"
ok $? "BS-03 public verification key, baseline and the maintenance service installed; no signing key"
Z=0000000000000000000000000000000000000000000000000000000000000000
grep -qxF "$Z	$INSIDE" "$BASEL" && grep -qxF "$Z	$OUTSIDE" "$BASEL" \
  && grep -qxF "$(cd "$D/TMRKZ" && sha256sum "$OLDER" | cut -d' ' -f1)	$OLDER" "$BASEL" \
  && grep -qxF "$(cd "$D/TMRKZ" && sha256sum "$WINDOWS" | cut -d' ' -f1)	$WINDOWS" "$BASEL"
ok $? "BS-03 baseline: the kept hand edits marked as changed locally; the earlier-commit and CRLF files as installed (not edits)"
cmp -s "$D/TMRKZ/ops/update/UpdateWorker.java" "$SRC/ops/update/UpdateWorker.java"
ok $? "BS-03 the Update Center worker is the released one"
grep -E 'still differ|done:|were kept' "$D/apply.txt" | sed 's/^/      /'
B="$(ls -d "$D"/TMRKZ/backups/bootstrap/*/ | head -n 1)"
sh bootstrap.sh restore "$B" > "$D/restore.txt" 2>&1
snap | diff -q - "$D/before.sha" >/dev/null
ok $? "BS-04 restore returns every file exactly ($(wc -l < "$D/before.sha") files)"
cp -r "$D/pkg" "$D/pkg-altered"; printf 'x' >> "$D/pkg-altered/INSTALL.txt"
(cd "$D/pkg-altered" && ! sh bootstrap.sh apply "$D/TMRKZ" --keep-local > "$D/altered.txt" 2>&1) && grep -q 'checksum mismatch' "$D/altered.txt"
ok $? "BS-05 a package altered after it was made is refused"
cp -r "$D/pkg" "$D/pkg-forged"
(cd "$D/pkg-forged" && T="$(ls TMRKZ-bootstrap-*.tar)" && mkdir x && cd x && tar -xf "../$T" && printf 'EVIL=1\n' > .env && tar -cf "../$T" * .env \
  && cd .. && rm -rf x && sha256sum "$T" MANIFEST.tsv RELEASE.json RELEASE.sig release-trust.pub bootstrap.sh REMOVED.txt INSTALL.txt \
     BASE.tsv KNOWN.tsv BASE-COMMIT.txt config/* > SHA256SUMS)
(cd "$D/pkg-forged" && ! sh bootstrap.sh apply "$D/TMRKZ" --keep-local > "$D/forged.txt" 2>&1) && grep -q 'protected path' "$D/forged.txt"
ok $? "BS-05 a package smuggling .env with recomputed checksums is refused"
snap | diff -q - "$D/before.sha" >/dev/null
ok $? "BS-05 the installation is unchanged by both refused attempts"
sh bootstrap.sh apply "$D/TMRKZ" --with-config --overwrite-local > "$D/overwrite.txt" 2>&1
B2="$(ls -d "$D"/TMRKZ/backups/bootstrap/*/ | sort | tail -n 1)"
cmp -s "$D/TMRKZ/$INSIDE" "$SRC/$INSIDE" && (cd "$B2/before" && grep -F "$INSIDE" "$D/local.sha" | sha256sum -c --quiet) \
  && (cd "$D/TMRKZ" && grep -F "$OUTSIDE" "$D/local.sha" | sha256sum -c --quiet)
ok $? "BS-06 --overwrite-local replaces the changed file in the package (the machine's version kept in the backup); others stay"
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
