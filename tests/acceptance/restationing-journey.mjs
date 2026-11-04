// Stationing V3 re-stationing request journey against the DEVELOPMENT environment (sh ops/test-env/dev-v3.sh up && seed),
// through the real sign-in path (TMRKZ → Keycloak → LDAP) and the real API, with fictional users and data only:
//   1. permanent: draft → checks → submit (policy pinned, route from the requesting unit) → the requester cannot decide →
//      unit seat approves → the same human cannot decide the next stage → final seat approves → the requester and the
//      final approver cannot activate → an independent activator activates (new site, stationing, outbox, links untouched);
//   2. temporary: submitted and left at its first stage, for deciding on the page;
//   3. a draft that fails its checks (occupied ground), for the page.
// Usage: MOVER_URL=http://localhost:8097 node tests/acceptance/restationing-journey.mjs
import { readFileSync } from 'node:fs';

const BASE = process.env.MOVER_URL ?? 'http://localhost:8097';
const PASSWORD = readFileSync(new URL('../../ops/test-env/.generated/user-password', import.meta.url), 'utf8').trim();
let failures = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
  return cond;
};

class Jar {
  constructor() { this.cookies = new Map(); }
  take(res) {
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0];
      const i = pair.indexOf('=');
      const v = pair.slice(i + 1);
      if (!v || /max-age=0/i.test(c)) this.cookies.delete(pair.slice(0, i));
      else this.cookies.set(pair.slice(0, i), v);
    }
  }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
}

async function signIn(username) {
  const jar = new Jar();
  const go = async (url, init = {}) => {
    const res = await fetch(url.startsWith('http') ? url : BASE + url, { redirect: 'manual', ...init, headers: { ...(init.headers ?? {}), Cookie: jar.header() } });
    jar.take(res);
    return res;
  };
  let res = await go('/api/v1/auth/oidc/start');
  res = await go(res.headers.get('location'));
  const html = await res.text();
  const action = html.match(/<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
  res = await go(action, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password: PASSWORD, credentialId: '' }) });
  res = await go(res.headers.get('location'));
  if (!jar.cookies.has('MOVER_SESSION')) throw new Error('sign-in failed for ' + username);
  const cookie = 'MOVER_SESSION=' + jar.cookies.get('MOVER_SESSION');
  const call = async (method, path, body) => {
    const r = await fetch(BASE + '/api/v1' + path, {
      method,
      headers: { ...(method !== 'GET' ? { 'X-Requested-With': 'mover', 'Content-Type': 'application/json' } : {}), Cookie: cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const type = r.headers.get('content-type') ?? '';
    return { status: r.status, body: type.includes('json') ? await r.json() : await r.text() };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b) };
}

const square = (lat, lng, h = 0.0012) => ({
  type: 'Polygon',
  coordinates: [[[lng - h, lat - h], [lng + h, lat - h], [lng + h, lat + h], [lng - h, lat + h], [lng - h, lat - h]]],
});
const flatten = (nodes, out = []) => {
  for (const n of nodes ?? []) {
    out.push(n);
    flatten(n.children, out);
  }
  return out;
};

const requester = await signIn('t.requester');
const managerSS = await signIn('t.manager');
const approver = await signIn('t.approver');
const facilities = await signIn('t.facilities');
const requester2 = await signIn('t.requester2');

const orgs = flatten((await approver.get('/organizations/tree')).body);
const org = (code) => orgs.find((o) => o.code === code)?.id;
const SS = org('HR-T-SS');
const IT = org('HR-T-IT');
ok(!!SS && !!IT, 'fictional units found', `SS ${SS}, IT ${IT}`);

// 1. permanent: the shared-services department moves to one proposed site south of its current one
const draft = await requester.post('/restationing-requests', {
  requestingUnitId: SS,
  content: {
    kind: 'PERMANENT',
    scope: [SS],
    site: { geometry: square(25.1925, 55.3160), copiedFrom: null, shape: 'COPY' },
    primary: square(25.1625, 55.3610, 0.0025),
    alternative: square(25.1265, 55.3610, 0.0025),
    reason: 'نقل الخدمات المشتركة إلى موقع أوسع (بيانات تطوير وهمية)',
  },
});
ok(draft.status === 200 && draft.body.state === 'DRAFT', 'draft created', `${draft.status} ${draft.body.number ?? JSON.stringify(draft.body).slice(0, 200)}`);
const id = draft.body.id;
const checks = (await requester.get(`/restationing-requests/${id}/checks`)).body;
ok(checks.ok, 'checks pass against policy version ' + checks.policyVersion, checks.problems?.join(' | '));
for (const l of checks.legs ?? []) {
  console.log(`      ${l.label}: ${l.status} ${l.distanceM} م (المسموح ${l.effectiveMinM}–${l.effectiveMaxM}) الأرض ${l.terrain?.controllingClass ?? '—'} +${l.terrain?.allowanceM ?? 0}`);
}
let r = await requester.post(`/restationing-requests/${id}/submit`, {});
ok(r.status === 200 && r.body.state === 'UNDER_REVIEW', 'submitted: policy pinned, route from the requesting unit', `${r.status} ${r.body.route?.map((s) => s.label).join(' ← ') ?? JSON.stringify(r.body).slice(0, 300)}`);
r = await requester.post(`/restationing-requests/${id}/decision`, { decision: 'APPROVE' });
ok(r.status === 403, 'the requester cannot decide a stage of their own request', `${r.status} ${r.body.message ?? ''}`);
r = await managerSS.post(`/restationing-requests/${id}/decision`, { decision: 'APPROVE' });
ok(r.status === 200 && r.body.route?.[0]?.mark === 'APPROVED', 'the unit seat approves the first stage', `${r.status} ${r.body.message ?? ''}`);
r = await managerSS.post(`/restationing-requests/${id}/decision`, { decision: 'APPROVE' });
ok(r.status === 403, 'the same human cannot decide the next stage', `${r.status} ${r.body.message ?? ''}`);
r = await approver.post(`/restationing-requests/${id}/decision`, { decision: 'APPROVE' });
ok(r.status === 200 && r.body.state === 'APPROVED_NOT_ACTIVATED', 'the final seat approves: approved, not activated', `${r.status} ${r.body.state ?? r.body.message}`);
r = await approver.post(`/restationing-requests/${id}/activate`, {});
ok(r.status >= 400, 'the final approver cannot activate (D1)', `${r.status} ${r.body.message ?? ''}`);
r = await requester.post(`/restationing-requests/${id}/activate`, {});
ok(r.status >= 400, 'the requester cannot activate', `${r.status} ${r.body.message ?? ''}`);
r = await facilities.post(`/restationing-requests/${id}/activate`, { reason: 'تفعيل بعد التحقق من الجاهزية' });
ok(r.status === 200 && r.body.state === 'ACTIVATED_PERMANENT', 'an independent activator activates: new site, stationing and events', `${r.status} ${r.body.activation?.site?.name ?? r.body.message}`);
const current = (await requester.get(`/stationing/current?orgId=${SS}`)).body;
ok(Array.isArray(current) && current.some((c) => c.siteId === r.body.activation?.site?.id), 'the read contract shows the new stationing', JSON.stringify(current).slice(0, 160));

// 2. temporary: the IT department, 30 days, left at its first stage for the page
const start = new Date(Date.now() + 2 * 86400000).toISOString();
const end = new Date(Date.now() + 32 * 86400000).toISOString();
const temp = await requester2.post('/restationing-requests', {
  requestingUnitId: IT,
  content: {
    kind: 'TEMPORARY', start, end, scope: [IT],
    site: { geometry: square(25.2560, 55.3400), copiedFrom: null, shape: 'DRAWN' },
    primary: square(25.2560, 55.4000, 0.0025),
    alternative: square(25.2920, 55.4000, 0.0025),
    reason: 'تمركز مؤقت لإدارة التقنية أثناء صيانة مكتبها (بيانات تطوير وهمية)',
  },
});
ok(temp.status === 200, 'temporary draft created', `${temp.status} ${temp.body.number ?? temp.body.message}`);
r = await requester2.post(`/restationing-requests/${temp.body.id}/submit`, {});
ok(r.status === 200 && r.body.state === 'UNDER_REVIEW', 'temporary submitted, waiting at its first stage', `${r.status} ${r.body.message ?? r.body.route?.map((s) => s.label).join(' ← ')}`);

// 3. a draft whose proposed site lies on occupied ground (the coordination centre's boundary)
const bad = await requester.post('/restationing-requests', {
  requestingUnitId: SS,
  content: { kind: 'PERMANENT', scope: [SS], site: { geometry: square(25.2390, 55.3250), shape: 'COPY' }, reason: 'مسودة للعرض' },
});
const badChecks = (await requester.get(`/restationing-requests/${bad.body.id}/checks`)).body;
ok(!badChecks.ok && badChecks.problems.some((p) => p.includes('يتداخل')), 'a site on occupied ground is refused by the checks', badChecks.problems?.slice(0, 2).join(' | '));

console.log(`\n${failures === 0 ? 'Re-stationing journey PASSED' : failures + ' check(s) FAILED'}`);
process.exit(failures ? 1 : 0);
