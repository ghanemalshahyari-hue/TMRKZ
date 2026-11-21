#!/usr/bin/env sh
# The demo Oracle HR's people into the synthetic enterprise directory (ops/hr-demo/ad_accounts.py; owner, 20 Nov 2026;
# ADR-094): generate the LDIF from the demo Oracle (in the builder's python container, on the isolated network), then
# add it to tmrkz-synthetic-ad in bulk. Demo only.
#   sh ops/hr-demo/synthetic-ad/load.sh                 the first 20,000 people
#   sh ops/hr-demo/synthetic-ad/load.sh --limit 500     a quick subset
#   sh ops/hr-demo/synthetic-ad/load.sh --all           every person (200,000 in the large profile)
#   sh ops/hr-demo/synthetic-ad/load.sh --count         users in the directory, nothing else
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."
G=.generated
docker inspect -f '{{.State.Running}}' tmrkz-synthetic-ad 2>/dev/null | grep -q true || { echo "[synthetic-ad] not running — sh ops/hr-demo/synthetic-ad/up.sh" >&2; exit 2; }
if [ "${1:-}" = "--count" ]; then
  # listing OU=People materializes every entry: at hundreds of thousands of users it blocks the server (samba-tool
  # «user list» hits the same ceiling). samba-tool «computer list» is an empty catalog scan: the users we loaded carry
  # no servicePrincipalName, so they are skipped and only their count-at-the-end summary does the work.
  echo "users in the directory: $(docker exec tmrkz-synthetic-ad sh -c "samba-tool user list 2>/dev/null | wc -l | tr -d ' '")"
  [ -f .generated/ad-people.ldif ] && echo "users in the LDIF         : $(grep -c '^dn:' .generated/ad-people.ldif)"
  exit 0
fi
[ -f "$G/oracle_hr.env" ] || { echo "[hr-demo] no $G/oracle_hr.env — run sh ops/hr-demo/up.sh first" >&2; exit 2; }
ls "$G"/wheels/oracledb-* >/dev/null 2>&1 || { echo "[hr-demo] no driver wheels in $G/wheels — run sh ops/hr-demo/up.sh first" >&2; exit 2; }
HERE="$(pwd -W 2>/dev/null || pwd)"
docker run --rm --network tmrkz-mover_internal -v "$HERE:/w" -w /w python:3.12-slim \
  sh -c "pip install -q --disable-pip-version-check --no-index --find-links .generated/wheels oracledb==4.0.2 >/dev/null && python ad_accounts.py generate $*"
python3 ad_accounts.py load
echo "[synthetic-ad] every synthetic account signs in as <login>@tmrkz.test with the password in $G/ad-people-password"
