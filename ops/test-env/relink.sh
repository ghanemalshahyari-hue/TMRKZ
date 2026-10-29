#!/usr/bin/env sh
# Acceptance environment ONLY. After the fictional directory has been rebuilt (new entryUUIDs), TMRKZ refuses to link
# the new accounts to HR records that are already linked ("ALREADY_LINKED") — as it must. This resets the links of the
# fictional t.* users and the identity provider's imported copies so the next sign-in links them again. Never run this
# against a production deployment.
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
P="docker compose -p tmrkz-test"
$P exec -T db psql -U mover -d mover -v ON_ERROR_STOP=1 -q -c "
  delete from identity_link where person_id in (select id from person where username like 't.%');
  update identity_link_issue set resolved_at = now(), resolution = 'DISMISSED' where resolved_at is null and claimed_key like 't.%';"
$P exec -T keycloak sh -c '
  K=/opt/keycloak/bin/kcadm.sh
  $K config credentials --server http://localhost:8080/auth --realm master --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" >/dev/null
  for id in $($K get users -r tmrkz -q max=200 --fields id,username --format csv --noquotes | grep ",t\." | cut -d, -f1); do
    $K delete "users/$id" -r tmrkz
  done'
echo "[relink] fictional identity links reset; they are linked again at the next sign-in"
