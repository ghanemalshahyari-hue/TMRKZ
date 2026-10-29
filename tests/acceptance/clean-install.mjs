// Clean installation (owner review 2026-10-29, point 2): an empty database, no fictional HR mirror or facilities.
// Shows that the first administrator can be created through the documented, limited path and can then configure the
// HR source, while everyone else stays refused until the HR mirror contains them.
// Usage: called by ops/test-env/clean-install.sh <compose-project>
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BASE = process.env.MOVER_URL ?? 'http://localhost:8098';
const PROJECT = process.argv[2] ?? 'tmrkz-clean';
const PASSWORD = readFileSync(new URL('../../ops/test-env/.generated/user-password', import.meta.url), 'utf8').trim();

let failures = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

async function manual(username, password) {
  const res = await fetch(BASE + '/api/v1/auth/directory/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mover' }, body: JSON.stringify({ username, password }),
  });
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('MOVER_SESSION='))?.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null), cookie };
}
const call = async (cookie, method, path, body) => {
  const res = await fetch(BASE + '/api/v1' + path, {
    method, headers: { Cookie: cookie, 'X-Requested-With': 'mover', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const bootstrap = (login) => {
  try {
    return execFileSync('sh', ['ops/bootstrap-admin.sh', login, PROJECT], { encoding: 'utf8' }).trim();
  } catch (e) {
    return (e.stdout ?? '').toString().trim();
  }
};

const status = await (await fetch(BASE + '/api/v1/auth/status')).json();
ok(status.manual && status.configured, 'both sign-in paths configured on the empty installation');
const before = await manual('t.admin', PASSWORD);
// With no HR data synchronised yet the answer is STALE_SOURCE: nobody is linked before the first successful sync.
const refusedEmpty = (r) => r.status === 403 && ['STALE_SOURCE', 'NO_MATCH'].includes(r.body?.details?.reason);
ok(refusedEmpty(before), 'without HR data nobody is linked', before.body?.details?.reason);

ok(bootstrap('t.admin').startsWith('registered'), 'host operator registers the first administrator login');
const admin = await manual('t.admin', PASSWORD);
ok(admin.status === 200 && !!admin.cookie, 'that login signs in (password verified by the directory)');
const me = admin.body ?? {};
ok(me.permissions?.includes('CONFIGURE') && me.permissions?.includes('MANAGE_ACCESS') && !me.permissions?.includes('VIEW'),
  'temporary administrator: configuration and access, no request content', (me.permissions ?? []).join(','));

const saved = await call(admin.cookie, 'PUT', '/hr/source', {
  name: 'مصدر الموارد البشرية', enabled: false, hostOrUrl: 'hr-db.example.internal', port: 1521, serverName: 'HRSVC',
  nameType: 'service_name', username: 'tmrkz_reader', password: 'not-a-real-password', unitView: 'HR.UNITS_V', personView: 'HR.PEOPLE_V',
});
ok(saved.status === 200 && saved.body?.passwordSet === true && !('password' in (saved.body ?? {})), 'administrator configures the HR source (password write-only)');
const test = await call(admin.cookie, 'POST', '/hr/source/test');
ok(test.status === 200 && test.body?.ok === false && !!test.body?.failure, 'connection test reports a clear failure without an Oracle server', test.body?.failure);
const hr = await call(admin.cookie, 'GET', '/hr/status');
ok(hr.status === 200 && hr.body?.stale === true, 'HR status shows no published data yet');

ok(bootstrap('t.requester').startsWith('refused'), 'a second bootstrap is refused while an administrator exists');
const other = await manual('t.requester', PASSWORD);
ok(refusedEmpty(other), 'other directory users stay refused until the HR mirror has them', other.body?.details?.reason);
const issues = await call(admin.cookie, 'GET', '/identity-issues');
ok(issues.status === 200 && issues.body.some((i) => ['STALE_SOURCE', 'NO_MATCH'].includes(i.reason)), 'refused sign-ins wait on the access manager list');
const start = await fetch(BASE + '/api/v1/auth/oidc/start', { redirect: 'manual' });
ok(start.status === 302 && start.headers.get('location').startsWith(BASE + '/auth/realms/tmrkz/'), 'automatic sign-in path starts at the identity provider');

console.log(failures ? `\nClean installation FAILED (${failures})` : '\nClean installation PASSED');
process.exit(failures ? 1 : 0);
