// End-to-end acceptance journey against a running stack, through the web entry point (nginx → backend).
// Chosen demonstration journey (ACCEPTANCE_TESTS.md): book a service facility for an administrative body —
// map selection, data + period, submit, return, edit + resubmit, approvals, signed approval, reservation,
// info copy, execution/receipt tasks, closure with history kept. Also checks AT-29 (no external runtime requests).
//
// Usage: MOVER_URL=http://localhost:8088 MOVER_DEMO_PASSWORD=... node tests/acceptance/journey.mjs
// Requires the fictional demo dataset (MOVER_DEMO_SEED=true).

const BASE = process.env.MOVER_URL ?? 'http://localhost:8088';
const PASSWORD = process.env.MOVER_DEMO_PASSWORD;
if (!PASSWORD) {
  console.error('Set MOVER_DEMO_PASSWORD (see .env)');
  process.exit(2);
}

let failures = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Session {
  constructor(user) { this.user = user; this.cookie = ''; }
  async login() {
    const r = await this.call('POST', '/auth/login', { username: this.user, password: PASSWORD });
    if (r.status !== 200) throw new Error(`login ${this.user}: ${r.status} ${JSON.stringify(r.body)}`);
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

const user = (name) => new Session(name).login();
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

// ---- Journey -----------------------------------------------------------------------------------------
const requester = await user('requester');
const facilities = await user('facilities');
const manager = await user('manager');
const approver = await user('approver');

const sites = (await requester.get('/sites')).body;
const service = sites.find((s) => s.code === '02');
ok(!!service, 'requester sees «مركز الخدمات» on the map directory');
const resource = service.resources.find((r) => r.parentResourceId === null);
const features = (await requester.get('/map/features?time=' + encodeURIComponent(new Date().toISOString()))).body;
ok(features.coverage.covered === true && features.features.some((f) => f.siteId === service.id), 'map layer lists the facility with local coverage');

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
const decision = { decision: 'APPROVE', expectedRevision: 2, signature: { password: PASSWORD, confirm: true } };
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
