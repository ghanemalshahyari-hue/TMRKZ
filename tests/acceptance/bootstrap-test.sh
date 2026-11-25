#!/usr/bin/env sh
# The one-time bootstrap package (ADR-105) on a throw-away copy of an installation at an older commit (git archive of that
# commit — not a worktree), with fictional .env, certificates, data and a machine Compose file. No container is started.
#
#   sh tests/acceptance/bootstrap-test.sh <empty-dir> [commit, default e30c1c1]
#
# BS-01 the package is built from the changed files only; BS-02 check changes nothing; BS-03 apply installs, keeps protected
# files byte for byte, installs only the PUBLIC key and the baseline; BS-04 restore puts back every file exactly; BS-05 a package
# altered after it was made, and one that smuggles .env in with recomputed checksums, are refused and change nothing.
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
cd "$D/TMRKZ"
printf 'COMPOSE_PROJECT_NAME=tmrkz\nTMRKZ_IP=10.0.0.5\nFICTIONAL_SECRET=keep-me\n' > .env
mkdir -p certs data/db map-runtime ops/local/.generated
echo fictional > certs/ca.pem; echo pg > data/db/PG_VERSION; printf 'services: {}\n' > docker-compose.dc-hosts.yml
echo '// local edit on the machine' >> backend/src/main/java/ae/mover/authz/UnitMemberService.java
snap > "$D/before.sha"
cd "$SRC"
OUTPUT="$(sh ops/update/make-release.sh --bootstrap "$SINCE" 2>&1)"
echo "$OUTPUT" | grep '^bootstrap package' || true
[ -f release/bootstrap/SHA256SUMS ] && ! tar -tf release/bootstrap/TMRKZ-bootstrap-*.tar | grep -qE '(^|/)(\.env|release-signing\.key)$|^(data|certs|map-runtime|ops/local/\.generated)/'
ok $? "BS-01 minimal package built; no key, .env, data or certificates in it"
cp -r release/bootstrap "$D/pkg"
cd "$D/pkg"
sh bootstrap.sh check "$D/TMRKZ" > "$D/check.txt" 2>&1
snap | diff -q - "$D/before.sha" >/dev/null
ok $? "BS-02 check is read-only ($(grep -o 'plan: .*' "$D/check.txt"))"
sh bootstrap.sh apply "$D/TMRKZ" --with-config > "$D/apply.txt" 2>&1
grep -F -e './.env' -e './certs/' -e './data/' -e './docker-compose.dc-hosts.yml' "$D/before.sha" > "$D/protected.sha"
(cd "$D/TMRKZ" && sha256sum -c --quiet "$D/protected.sha")
ok $? "BS-03 .env, certs/, data/ and docker-compose.dc-hosts.yml byte for byte unchanged"
[ -f "$D/TMRKZ/ops/local/.generated/release-trust.pub" ] && [ ! -f "$D/TMRKZ/ops/local/.generated/release-signing.key" ] \
  && [ -s "$D/TMRKZ/backups/updates/installed-MANIFEST.tsv" ] && grep -q 'maintenance:' "$D/TMRKZ/docker-compose.override.yml"
ok $? "BS-03 public verification key, baseline and the maintenance service installed; no signing key"
cmp -s "$D/TMRKZ/ops/update/UpdateWorker.java" "$SRC/ops/update/UpdateWorker.java"
ok $? "BS-03 the Update Center worker is the released one"
grep -E 'still differ|done:' "$D/apply.txt" | sed 's/^/      /'
B="$(ls -d "$D"/TMRKZ/backups/bootstrap/*/ | head -n 1)"
sh bootstrap.sh restore "$B" > "$D/restore.txt" 2>&1
snap | diff -q - "$D/before.sha" >/dev/null
ok $? "BS-04 restore returns every file exactly ($(wc -l < "$D/before.sha") files)"
cp -r "$D/pkg" "$D/pkg-altered"; printf 'x' >> "$D/pkg-altered/INSTALL.txt"
(cd "$D/pkg-altered" && ! sh bootstrap.sh apply "$D/TMRKZ" > "$D/altered.txt" 2>&1) && grep -q 'checksum mismatch' "$D/altered.txt"
ok $? "BS-05 a package altered after it was made is refused"
cp -r "$D/pkg" "$D/pkg-forged"
(cd "$D/pkg-forged" && T="$(ls TMRKZ-bootstrap-*.tar)" && mkdir x && cd x && tar -xf "../$T" && printf 'EVIL=1\n' > .env && tar -cf "../$T" * .env \
  && cd .. && rm -rf x && sha256sum "$T" MANIFEST.tsv RELEASE.json RELEASE.sig release-trust.pub bootstrap.sh REMOVED.txt INSTALL.txt config/* > SHA256SUMS)
(cd "$D/pkg-forged" && ! sh bootstrap.sh apply "$D/TMRKZ" > "$D/forged.txt" 2>&1) && grep -q 'protected path' "$D/forged.txt"
ok $? "BS-05 a package smuggling .env with recomputed checksums is refused"
snap | diff -q - "$D/before.sha" >/dev/null
ok $? "BS-05 the installation is unchanged by both refused attempts"
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
