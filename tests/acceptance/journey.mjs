// End-to-end acceptance journey against a running stack, through the web entry point (nginx → backend).
// Chosen demonstration journey (ACCEPTANCE_TESTS.md): book a service facility for an administrative body —
// map selection, data + period, submit, return, edit + resubmit, approvals, signed approval, reservation,
// info copy, execution/receipt tasks, closure with history kept. Also checks AT-29 (no external runtime requests).
//
// Usage: sh ops/test-env/up.sh && node tests/acceptance/journey.mjs
// Runs against the acceptance test environment (fictional directory, HR mirror and facilities). Every actor signs in
// through the real path: TMRKZ → Keycloak sign-in page → LDAP → TMRKZ callback. Transitions after sign-in use the API;
// the browser-driven journey (PA-25/26) is a separate test.

import { readFileSync } from 'node:fs';

const BASE = process.env.MOVER_URL ?? 'http://localhost:8088';
const PASSWORD = process.env.TMRKZ_TEST_PASSWORD ?? (() => {
  try {
    return readFileSync(new URL('../../ops/test-env/.generated/user-password', import.meta.url), 'utf8').trim();
  } catch {
    console.error('Start the test environment first (sh ops/test-env/up.sh) or set TMRKZ_TEST_PASSWORD.');
    process.exit(2);
  }
})();

let failures = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Cookies of one browser (all on the same origin: TMRKZ and Keycloak under /auth). */
class Jar {
  constructor() { this.cookies = new Map(); }
  take(res) {
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0];
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (!value || /max-age=0/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
}

/** The browser sign-in: TMRKZ start → Keycloak form → directory check → TMRKZ callback. Nothing is injected. */
async function browserSignIn(username, password) {
  const jar = new Jar();
  const go = async (url, init = {}) => {
    const res = await fetch(url.startsWith('http') ? url : BASE + url, { redirect: 'manual', ...init, headers: { ...(init.headers ?? {}), Cookie: jar.header() } });
    jar.take(res);
    return res;
  };
  let res = await go('/api/v1/auth/oidc/start');
  if (res.status !== 302) throw new Error('sign-in did not start: ' + res.status);
  res = await go(res.headers.get('location'));
  const html = await res.text();
  const action = html.match(/<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
  if (!action) throw new Error('provider sign-in form not found');
  res = await go(action, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password, credentialId: '' }) });
  if (res.status !== 302) return { signedIn: false, page: await res.text(), jar, loginPage: html };
  res = await go(res.headers.get('location'));
  return { signedIn: jar.cookies.has('MOVER_SESSION'), location: res.headers.get('location'), jar, loginPage: html };
}

/** The manual path of the sign-in page: username and password checked by the directory (LDAP over TLS). */
async function manualSignIn(username, password) {
  const res = await fetch(BASE + '/api/v1/auth/directory/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mover' }, body: JSON.stringify({ username, password }),
  });
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('MOVER_SESSION='))?.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null), cookie };
}

class Session {
  constructor(user, via = 'automatic') { this.user = user; this.via = via; this.cookie = ''; }
  async login() {
    if (this.via === 'manual') {
      const m = await manualSignIn(this.user, PASSWORD);
      if (!m.cookie) throw new Error(`manual sign-in ${this.user} failed: ${m.status}`);
      this.cookie = m.cookie;
      return this;
    }
    const r = await browserSignIn(this.user, PASSWORD);
    if (!r.signedIn) throw new Error(`sign-in ${this.user} failed: ${r.location ?? 'no redirect'}`);
    this.cookie = 'MOVER_SESSION=' + r.jar.cookies.get('MOVER_SESSION');
    return this;
  }
  async call(method, path, body, headers = {}) {
    const res = await fetch(BASE + '/api/v1' + path, {
      method,
      headers: {
        ...(method !== 'GET' ? { 'X-Requested-With': 'mover' } : {}),
        ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...headers,
      },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set && set.startsWith('MOVER_SESSION=')) this.cookie = set.split(';')[0];
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text(), headers: res.headers };
  }
  get = (p) => this.call('GET', p);
  post = (p, b, key) => this.call('POST', p, b ?? {}, key ? { 'Idempotency-Key': key } : {});
  patch = (p, b) => this.call('PATCH', p, b);
}

const user = (name, via) => new Session(name, via).login();
const key = () => crypto.randomUUID();
const dubaiMidnight = (y, m, d) => new Date(Date.UTC(y, m - 1, d) - 4 * 3600 * 1000).toISOString();

// ---- AT-29: offline / no external runtime dependencies -------------------------------------------------
{
  const page = await fetch(BASE + '/');
  const html = await page.text();
  const csp = page.headers.get('content-security-policy') ?? '';
  ok(page.status === 200, 'web entry point serves the application');
  ok(csp.includes("default-src 'self'") && !/https?:\/\//.test(csp.replace(/https?:\/\/(www\.)?w3\.org\S*/g, '')),
    'CSP allows only same-origin resources', csp.slice(0, 90));
  const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !u.startsWith('#'));
  ok(assets.every((u) => u.startsWith('/') || u.startsWith('./')), 'index.html references only local assets');
  let external = [];
  for (const a of assets.filter((u) => /\.(js|css)$/.test(u))) {
    const text = await (await fetch(new URL(a, BASE))).text();
    const fetchable = [...text.matchAll(/(?:fetch\(|import\(|url\()\s*["'`](https?:\/\/[^"'`)]+)/g)].map((m) => m[1]);
    external = external.concat(fetchable);
  }
  ok(external.length === 0, 'bundled code contains no fetchable external URLs', external.join(', '));
  const font = await fetch(BASE + '/fonts/NotoSansArabic.ttf');
  ok(font.status === 200, 'Arabic font served locally');
}

// ---- Enterprise sign-in (PA-07 through the real provider and directory) -------------------------------
{
  const local = await fetch(BASE + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mover' }, body: '{"username":"x","password":"y"}' });
  const demo = await fetch(BASE + '/api/v1/auth/demo-users');
  ok(local.status === 401 && demo.status === 401, 'no local password or demo sign-in exists');
  const status = await (await fetch(BASE + '/api/v1/auth/status')).json();
  ok(status.configured && status.reachable, 'identity provider configured and reachable');
  const good = await browserSignIn('t.requester', PASSWORD);
  ok(good.loginPage.includes('TMRKZ') && good.loginPage.includes('dir="rtl"') && !/https?:\/\/(?!localhost)/.test(good.loginPage.match(/<link[^>]+>/g)?.join('') ?? ''),
    'provider sign-in page carries the TMRKZ theme with local assets');
  ok(good.signedIn && good.location === '/', 'directory password accepted; TMRKZ session opened');
  const wrong = await browserSignIn('t.requester', PASSWORD + 'x');
  ok(!wrong.signedIn && !wrong.jar.cookies.has('MOVER_SESSION') && wrong.page.includes('tm-alert'), 'wrong password refused by the directory; no session');
  const unlinked = await browserSignIn('t.unlinked', PASSWORD);
  ok(!unlinked.signedIn && unlinked.location === '/#auth-error=IDENTITY_NOT_LINKED&reason=NO_MATCH',
    'directory account without an HR record is refused and queued', unlinked.location);
  // The manual path of the same page: username and password checked by the directory directly.
  ok(status.manual === true, 'manual sign-in offered on the sign-in page');
  const manualOk = await manualSignIn('t.requester', PASSWORD);
  ok(manualOk.status === 200 && !!manualOk.cookie && manualOk.body?.signInMethod === 'DIRECTORY', 'manual sign-in: directory password accepted');
  const manualWrong = await manualSignIn('t.requester', PASSWORD + 'x');
  ok(manualWrong.status === 401 && !manualWrong.cookie, 'manual sign-in: wrong password refused, no session');
  const manualUnlinked = await manualSignIn('t.unlinked', PASSWORD);
  ok(manualUnlinked.status === 403 && manualUnlinked.body?.details?.reason === 'NO_MATCH', 'manual sign-in: directory-only account refused and queued');
  const out = await fetch(BASE + '/api/v1/auth/logout', { method: 'POST', headers: { Cookie: manualOk.cookie, 'X-Requested-With': 'mover' } });
  ok((await out.json()).redirect === '/?signed-out=1', 'logout returns to the sign-in page with the signed-out message');
}

// ---- Journey -----------------------------------------------------------------------------------------
const requester = await user('t.requester');
const facilities = await user('t.facilities', 'manual');
const manager = await user('t.manager');
const approver = await user('t.approver');

const sites = (await requester.get('/sites')).body;
const service = sites.find((s) => s.code === '02');
ok(!!service, 'requester sees «مركز الخدمات» on the map directory');
const resource = service.resources.find((r) => r.parentResourceId === null);
// coverage is computed for an actual viewport (ADR-017): here the regional extent of the fictional facilities
const features = (await requester.get('/map/features?bbox=55.25,25.15,55.40,25.25&zoom=12&time=' + encodeURIComponent(new Date().toISOString()))).body;
ok(features.coverage.status === 'FULL' && features.features.some((f) => f.siteId === service.id), 'map layer lists the facility with local coverage');

const types = (await requester.get('/request-types')).body;
const temp = types.find((t) => t.code === 'TEMP_OCCUPANCY');
const orgGA = (await requester.get('/organizations/tree')).body; // requester scope: own organisation subtree
const year = 2030 + Math.floor(Math.random() * 40);
const day = 1 + Math.floor(Math.random() * 20);
const start = dubaiMidnight(year, 3, day);
const end = dubaiMidnight(year, 3, day + 3);

const created = await requester.post('/requests', {
  typeCode: temp.code, origin: 'MAP', resourceIds: [resource.id], subject: 'إشغال مؤقت — رحلة قبول',
  period: { start, end }, values: { reason: 'استقبال الموظفين الجدد خلال البرنامج الإداري', headcount: 30 },
});
ok(created.status === 200 && created.body.status === 'DRAFT', 'draft created from the map', created.body.number);
const id = created.body.id;

const form = new FormData();
form.append('fieldId', 'attachments');
form.append('file', new Blob(['خطة الاستقبال — نسخة تجريبية'], { type: 'text/plain' }), 'plan.txt');
const up = await requester.call('POST', `/requests/${id}/attachments`, form);
ok(up.status === 200 && up.body.scanStatus === 'CLEAN', 'attachment stored with checksum and scan result', up.body.sha256?.slice(0, 12));

const approverMe = (await approver.get('/me')).body;
let detail = (await requester.get(`/requests/${id}`)).body;
await requester.patch(`/requests/${id}/draft`, { expectedVersion: detail.version, infoOrgIds: [approverMe.primaryOrg.id] });
detail = (await requester.get(`/requests/${id}`)).body;
const submitted = await requester.post(`/requests/${id}/submit`, { expectedVersion: detail.version }, key());
ok(submitted.status === 200 && submitted.body.status === 'SUBMITTED', 'submitted for review');
ok(submitted.body.reservations.length === 0, 'no reservation exists while the request is under review (orange)');

const taskOf = async (s) => (await s.get('/tasks')).body.find((t) => t.requestId === id);
let t = await taskOf(facilities);
ok(!!t && t.stageKey === 'facilities_review', 'facilities reviewer has the first task');
ok(!(await taskOf(manager)), 'manager has nothing before the first stage completes (sequential)');
await facilities.post(`/tasks/${t.id}/decision`, { decision: 'APPROVE', expectedRevision: 1 }, key());

t = await taskOf(manager);
const noReason = await manager.post(`/tasks/${t.id}/decision`, { decision: 'RETURN', expectedRevision: 1 }, key());
ok(noReason.status === 400, 'return without a reason is refused');
const returned = await manager.post(`/tasks/${t.id}/decision`,
  { decision: 'RETURN', note: 'يرجى ذكر المرجع الإداري', reasonCode: 'INCOMPLETE_DATA', expectedRevision: 1 }, key());
ok(returned.body.status === 'RETURNED', 'returned to the requester with a reason');

detail = (await requester.get(`/requests/${id}`)).body;
await requester.patch(`/requests/${id}/draft`, { expectedVersion: detail.version, values: { reference: 'م-ج/2026/118' } });
detail = (await requester.get(`/requests/${id}`)).body;
const resubmitted = await requester.post(`/requests/${id}/submit`,
  { expectedVersion: detail.version, resubmissionReason: 'إضافة المرجع الإداري' }, key());
ok(resubmitted.body.revision === 2, 'resubmitted as revision 2');
ok(resubmitted.body.stages.find((s) => s.key === 'facilities_review').state === 'CARRIED',
  'descriptive change keeps the earlier facilities approval (change policy)');

t = await taskOf(manager);
await manager.post(`/tasks/${t.id}/decision`, { decision: 'APPROVE', expectedRevision: 2 }, key());
t = await taskOf(approver);
const doc = (await approver.get(`/tasks/${t.id}/approval-document`)).body;
ok(doc.sha256?.length === 64 && doc.signatureLabel.includes('ليس توقيعاً رقمياً'), 'approval document hashed; attestation not labelled as PKI');
const signKey = key();
const decision = { decision: 'APPROVE', expectedRevision: 2, signature: { confirm: true } };
const approved = await approver.post(`/tasks/${t.id}/decision`, decision, signKey);
ok(approved.body.status === 'APPROVED', 'final approval recorded');
ok(approved.body.reservations.length === 1 && approved.body.reservations[0].status === 'ACTIVE', 'reservation created atomically with the approval');
const replay = await approver.post(`/tasks/${t.id}/decision`, decision, signKey);
ok(replay.status === 200 && replay.body.reservations.length === 1, 'replayed approval returns the same result (idempotent)');

const second = await requester.post('/requests', {
  typeCode: temp.code, origin: 'LIST', resourceIds: [resource.id], period: { start: dubaiMidnight(year, 3, day + 1), end },
  values: { reason: 'طلب متعارض لاختبار منع التداخل' },
});
await requester.post(`/requests/${second.body.id}/submit`, { expectedVersion: second.body.version }, key());
const check = await requester.post('/availability/check', { resourceIds: [resource.id], start: dubaiMidnight(year, 3, day + 1), end });
ok(check.body.available === false, 'availability preview reports the conflict (preview only)');

let infoNotice = false;
for (let i = 0; i < 15 && !infoNotice; i++) {
  infoNotice = (await approver.get('/notifications')).body.some((n) => n.requestId === id && n.kind === 'INFO_COPY');
  if (!infoNotice) await sleep(1000);
}
ok(infoNotice, 'info recipient organisation notified through the outbox');

detail = (await requester.get(`/requests/${id}`)).body;
const handover = detail.executionTasks.find((e) => e.key === 'handover');
const receipt = detail.executionTasks.find((e) => e.key === 'receipt');
ok((await requester.post(`/requests/${id}/close`, {}, key())).status === 400, 'cannot close before execution tasks are done');
ok((await facilities.post(`/execution-tasks/${handover.id}/complete`, { note: 'تم التسليم بمحضر رقم 44' }, key())).status === 200, 'handover completed with evidence');
ok((await requester.post(`/execution-tasks/${receipt.id}/complete`, { note: 'تم الاستلام' }, key())).status === 200, 'receipt confirmed by the requesting body');
const closed = await requester.post(`/requests/${id}/close`, { note: 'اكتمل التنفيذ' }, key());
ok(closed.body.status === 'CLOSED', 'administrative file closed');
ok(closed.body.reservations[0].status === 'ACTIVE', 'closing the file does not release the reservation');
ok(closed.body.history.length >= 10, 'history kept', `${closed.body.history.length} events`);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nJourney PASSED');
process.exit(failures ? 1 : 0);
