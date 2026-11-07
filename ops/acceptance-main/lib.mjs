// Shared by provision and cleanup. Secrets are read from local ignored files and never printed.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const GEN = fileURLToPath(new URL('./.generated/', import.meta.url));
mkdirSync(GEN, { recursive: true });
export const DB = 'tmrkz-mover-db-1';
export const LDAP = 'tmrkz-mover-openldap-1';
export const KEYCLOAK = 'tmrkz-mover-keycloak-1';
export const USERS = ['p01.new', 'p02.access', 'p03.final', 'p04.sites', 'p05.req', 'p06.h1', 'p07.h2', 'p08.ops', 'p09.fin', 'p10.fyi', 'p11.act', 'p12.view', 'p13.other', 'p14.admin', 'p15.fyi', 'p16.branch', 'p17.new', 'p18.new', 'p19.new'];
export const CURRENT = GEN + 'current-run.json';

export const MARK = ' — اختبار قبول — وهمي';
/** The acceptance seed for one batch. dy moves a further batch north, so that its sites stand on free ground. */
export const seedText = ({ ns, prefix, up = '', sfx = MARK, dy = 0, file = './seed.sql' }) =>
  readFileSync(new URL(file, import.meta.url), 'utf8').replaceAll('__NS__', ns).replaceAll('__PFX__', prefix).replaceAll('__UP__', up).replaceAll('__SFX__', sfx).replaceAll('__DY__', String(dy));
export const directoryEntries = (prefix, up = '') => USERS.map((u) => `dn: uid=${up}${u},ou=people,dc=tmrkz,dc=local
objectClass: inetOrgPerson
uid: ${up}${u}
cn: ${up}${u} اختبار قبول وهمي
sn: ACCEPTANCE
employeeNumber: ${prefix}P${u.slice(1, 3)}
userPassword: ${password()}
`).join('\n');

const run = (args, input) => execFileSync('docker', args, { encoding: 'utf8', input, maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'pipe'] });
/** One SQL script on the application's database, stopping at the first error; returns its output. */
export const psql = (script, db = 'mover') => run(['exec', '-i', DB, 'psql', '-X', '-q', '-U', 'mover', '-d', db, '-At', '-v', 'ON_ERROR_STOP=1', '-f', '-'], script).trim();
export const dockerRun = run;
export const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
export const writeJson = (f, v) => writeFileSync(f, JSON.stringify(v, null, 1) + '\n', { mode: 0o600 });
export const loaded = () => (existsSync(CURRENT) ? readJson(CURRENT) : null);
export const manifestFile = (id) => `${GEN}run-${id}.json`;
export const password = () => readFileSync(ROOT + 'ops/test-env/.generated/user-password', 'utf8').trim();
export const ldapAdmin = () => readFileSync(ROOT + 'ops/local/.generated/ldap-admin-password', 'utf8').trim();

/**
 * Keycloak users of this run, by exact username. kcadm runs inside the container, its password on stdin.
 * action: 'list' prints id,username for each; 'delete' removes them.
 */
export function keycloak(action, names = USERS) {
  const env = readFileSync(ROOT + '.env', 'utf8');
  const kc = env.match(/^TMRKZ_KEYCLOAK_ADMIN_PASSWORD=(.*)$/m)?.[1];
  if (!kc) throw new Error('no Keycloak admin password in .env');
  const script = `set -eu
K=/opt/keycloak/bin/kcadm.sh
C="--config /tmp/kcadm-acc.config"
trap 'rm -f /tmp/kcadm-acc.config' EXIT
$K config credentials $C --server http://localhost:8080/auth --realm master --user tmrkz-bootstrap --password '${kc}' >/dev/null 2>&1
for u in ${names.join(' ')}; do
  id="$($K get users -r tmrkz -q username="$u" -q exact=true --fields id --format csv --noquotes $C 2>/dev/null | head -1)"
  [ -n "$id" ] || continue
  ${action === 'delete' ? '$K delete users/$id -r tmrkz $C 2>/dev/null; echo "deleted $id,$u"' : 'echo "$id,$u"'}
done
`;
  return run(['exec', '-i', KEYCLOAK, 'bash', '-s'], script).trim().split('\n').filter(Boolean);
}

/**
 * Count and content hash of every application table: the proof that real rows are as they were. Tables that legitimately move on
 * by themselves are compared by nothing here and named in the report: the append-only audit log, the authorisation sync's own
 * bookkeeping (its outcome is checked through the tuples), and sign-in sessions. The terrain rasters are compared by count.
 */
export const NOT_COMPARED = ['audit_event', 'authz_change', 'authz_sync_state', 'user_session', 'idempotency_record', 'flyway_schema_history'];
export function fingerprintAll() {
  const tables = psql(`select tablename from pg_tables where schemaname = 'public' order by 1`).split('\n').filter((t) => !NOT_COMPARED.includes(t));
  const out = {};
  for (const t of tables) {
    const q = /^(terrain_slope|map_)/.test(t) ? `select count(*) || '|-' from "${t}"` : `select count(*) || '|' || coalesce(md5(string_agg(md5(x::text), '' order by md5(x::text))), '-') from "${t}" x`;
    out[t] = psql(q);
  }
  return out;
}
export const tupleCounts = () => ({ authzTuple: Number(psql('select count(*) from authz_tuple')), openfgaTuple: Number(psql('select count(*) from tuple', 'openfga')) });
export function waitAuthzDrained(ms = 120000) {
  const end = Date.now() + ms;
  for (;;) {
    const lag = Number(psql(`select coalesce((select max(seq) from authz_change), 0) - coalesce((select max(applied_seq) from authz_sync_state), 0)`));
    if (lag <= 0) return true;
    if (Date.now() > end) throw new Error('the authorisation sync is behind by ' + lag);
    execFileSync('sleep', ['2']);
  }
}
