#!/bin/sh
# Creates the identity provider's and the authorisation service's own databases and roles once. Business data (tmrkz),
# identity data (keycloak) and authorisation tuples (openfga) stay in separate databases with separate owners; re-running
# only re-applies the role passwords from the environment.
# TMRKZ's own database and its owner were called «mover» (the project's first working name) until 23 Nov 2026 (ADR-098):
# a database made before then is renamed to «tmrkz» here, once, before the backend connects (it waits for this one-shot).
# Each step checks what is already done, so an interrupted rename completes on the next start.
set -eu
export PGPASSWORD="$TMRKZ_DB_PASSWORD"
# The network may still be settling when this one-shot starts: wait for the server's name and port (up to a minute).
i=0
until pg_isready -h db >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -ge 30 ] && break; sleep 2
done

# 1. the owner: a role cannot rename itself, so a temporary administrator does it
if psql -h db -U mover -d postgres -Atc "select 1" >/dev/null 2>&1 \
   && [ "$(psql -h db -U mover -d postgres -Atc "select count(*) from pg_roles where rolname = 'tmrkz'")" = 0 ]; then
  echo "renaming the owner mover to tmrkz (ADR-098)"
  psql -h db -U mover -d postgres -v ON_ERROR_STOP=1 -q -v pw="$TMRKZ_DB_PASSWORD" <<'SQL'
select format('create role tmrkz_rename superuser login password %L', :'pw')
 where not exists (select from pg_roles where rolname = 'tmrkz_rename') \gexec
SQL
  psql -h db -U tmrkz_rename -d postgres -v ON_ERROR_STOP=1 -q -v pw="$TMRKZ_DB_PASSWORD" <<'SQL'
select pg_terminate_backend(pid) from pg_stat_activity where usename = 'mover';
alter role mover rename to tmrkz;
select format('alter role tmrkz password %L', :'pw') \gexec
SQL
fi
# 2. the database follows its owner's name; the temporary administrator goes
psql -h db -U tmrkz -d postgres -v ON_ERROR_STOP=1 -q <<'SQL'
select pg_terminate_backend(pid) from pg_stat_activity where datname = 'mover';
select 'alter database mover rename to tmrkz'
 where exists (select from pg_database where datname = 'mover') and not exists (select from pg_database where datname = 'tmrkz') \gexec
drop role if exists tmrkz_rename;
SQL

psql -h db -U tmrkz -d tmrkz -v ON_ERROR_STOP=1 -v kcpass="$TMRKZ_KEYCLOAK_DB_PASSWORD" -v fgapass="$TMRKZ_OPENFGA_DB_PASSWORD" <<'SQL'
select format('create role keycloak login password %L', :'kcpass')
 where not exists (select from pg_roles where rolname = 'keycloak') \gexec
select format('alter role keycloak password %L', :'kcpass') \gexec
select 'create database keycloak owner keycloak'
 where not exists (select from pg_database where datname = 'keycloak') \gexec
select format('create role openfga login password %L', :'fgapass')
 where not exists (select from pg_roles where rolname = 'openfga') \gexec
select format('alter role openfga password %L', :'fgapass') \gexec
select 'create database openfga owner openfga'
 where not exists (select from pg_database where datname = 'openfga') \gexec
SQL
echo "databases ready: tmrkz, keycloak, openfga"
