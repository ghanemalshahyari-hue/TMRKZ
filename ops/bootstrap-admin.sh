#!/usr/bin/env sh
# First administrator of an EMPTY installation. Registers one directory login for 24 hours. Its first sign-in (password
# verified by the directory or Keycloak) becomes a temporary system administrator for 72 hours, so that the HR source
# can be configured. Once the HR mirror contains the same person, the next sign-in moves to the HR record and the
# temporary grant ends. Refused while any active system administrator exists. Recorded in the audit trail.
# Usage: ops/bootstrap-admin.sh <directory-login> [compose-project]
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."
LOGIN="$(printf '%s' "${1:?usage: ops/bootstrap-admin.sh <directory-login> [compose-project]}" | tr 'A-Z' 'a-z')"
PROJECT="${2:-tmrkz-mover}"
case "$LOGIN" in *[!a-z0-9._@-]*) echo "invalid login"; exit 2;; esac
RESULT="$(docker compose -p "$PROJECT" exec -T db psql -U mover -d mover -v ON_ERROR_STOP=1 -v login="$LOGIN" -At <<'SQL'
with admins as (
  select count(*) as n from membership m join person p on p.id = m.person_id and p.status = 'ACTIVE'
  where m.role_code = 'SYSTEM_ADMIN' and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())),
registered as (
  insert into bootstrap_admin(login, requested_at, expires_at)
  select :'login', now(), now() + interval '24 hours' from admins where n = 0
  on conflict (login) do update set requested_at = now(), expires_at = now() + interval '24 hours', used_at = null, person_id = null
  returning login),
logged as (
  insert into audit_event(actor_name, action, entity_type, entity_label)
  select 'host operator', 'BOOTSTRAP_ADMIN_REGISTERED', 'IDENTITY', login from registered returning id)
select case when exists (select 1 from registered) then 'registered' else 'refused' end;
SQL
)"
if [ "$RESULT" = "registered" ]; then
  echo "registered: sign in as '$LOGIN' within 24 hours (manual or automatic sign-in); the administrator grant lasts 72 hours"
else
  echo "refused: an active system administrator already exists; grant rights from the application instead"
  exit 1
fi
