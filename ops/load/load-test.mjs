// Exploratory load measurement (not an acceptance of capacity — decision D-03 is open).
// N virtual users loop over typical read endpoints and periodically create + submit a request; a facilities reviewer then
// takes the first stage of the requests submitted. Reports per-endpoint count, P50, P95, max (ms) and error rate.
//
// Sign-in uses the supported manual flow only: POST /api/v1/auth/directory/login, where the directory verifies the password
// and TMRKZ links the account to its HR record. Run it against the disposable load environment and its synthetic accounts
// (ops/load/up-load-env.sh), never against production or the acceptance environment.
//
// Usage: MOVER_URL=http://localhost:8099 SMOKE=1 node ops/load/load-test.mjs          (one request through every stage)
//        MOVER_URL=http://localhost:8099 USERS=50 SECONDS=60 node ops/load/load-test.mjs
// LOAD_PASSWORD defaults to ops/test-env/.generated/load-password; accounts are load.0001… and load.r.fac/mgr/apr.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const BASE = process.env.MOVER_URL;
if (!BASE) throw new Error('Set MOVER_URL to the disposable load environment (e.g. http://localhost:8099).');
if (/:8088\b/.test(BASE)) throw new Error('Refusing to load the acceptance environment (:8088); use ops/load/up-load-env.sh.');
const PASSWORD = process.env.LOAD_PASSWORD
  ?? readFileSync(new URL('../test-env/.generated/load-password', import.meta.url), 'utf8').trim();
const SMOKE = process.env.SMOKE === '1';
const USERS = SMOKE ? 1 : Number(process.env.USERS ?? 50);
const SECONDS = SMOKE ? 0 : Number(process.env.SECONDS ?? 60);
const stats = new Map();
const record = (name, ms, ok) => {
  const s = stats.get(name) ?? { times: [], errors: 0 };
  s.times.push(ms);
  if (!ok) s.errors++;
  stats.set(name, s);
};

async function call(cookie, method, path, body, idempotent = false) {
  const t0 = performance.now();
  const res = await fetch(BASE + '/api/v1' + path, {
    method,
    headers: {
      Cookie: cookie,
      Accept: 'application/json',
      ...(method !== 'GET' ? { 'X-Requested-With': 'mover', 'Content-Type': 'application/json' } : {}),
      ...(idempotent ? { 'Idempotency-Key': randomUUID() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const ms = performance.now() - t0;
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  return { status: res.status, ms, body: parsed };
}

async function login(user) {
  const t0 = performance.now();
  const res = await fetch(BASE + '/api/v1/auth/directory/login', {
    method: 'POST', headers: { 'X-Requested-With': 'mover', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: PASSWORD }),
  });
  record('POST /auth/directory/login', performance.now() - t0, res.status === 200);
  if (res.status !== 200) throw new Error('sign-in failed for ' + user + ': ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('MOVER_SESSION='));
  if (!cookie) throw new Error('no session cookie for ' + user);
  return cookie.split(';')[0];
}

const account = (i) => 'load.' + String(i).padStart(4, '0');
const cookies = [];
for (let i = 1; i <= USERS; i++) cookies.push(await login(account(i)));
const reviewer = await login('load.r.fac');
const me = (await call(cookies[0], 'GET', '/me')).body;
const owner = me.primaryOrg.id;
const sites = (await call(cookies[0], 'GET', '/sites')).body;
const resources = sites.flatMap((s) => s.resources).filter((r) => !r.parentResourceId).map((r) => r.id);
const type = (await call(cookies[0], 'GET', '/request-types')).body.find((t) => t.kind === 'NEW_RESERVATION');
if (!type || !resources.length) throw new Error('no reservation type or resource visible to ' + account(1));
const deadline = Date.now() + SECONDS * 1000;
const day = new Date().toISOString();
const submitted = [];

async function createAndSubmit(cookie, index, n) {
  // a year of its own per user and loop, so requests never contend for the same period
  const start = new Date(Date.UTC(2100 + index, 0, 1 + n)).toISOString();
  const end = new Date(Date.UTC(2100 + index, 0, 2 + n)).toISOString();
  const c = await call(cookie, 'POST', '/requests', {
    typeCode: type.code, origin: 'LIST', ownerOrgId: owner, resourceIds: [resources[(index + n) % resources.length]],
    period: { start, end }, values: { reason: 'طلب قياس أداء استكشافي ببيانات اصطناعية' },
  });
  record('POST /requests', c.ms, c.status === 200);
  if (c.status !== 200) return null;
  const s = await call(cookie, 'POST', `/requests/${c.body.id}/submit`, { expectedVersion: c.body.version }, true);
  record('POST /requests/{id}/submit', s.ms, s.status === 200);
  if (s.status === 200) submitted.push(c.body.id);
  return s.status === 200 ? c.body.id : null;
}

async function vu(index) {
  const cookie = cookies[index];
  let n = 0;
  while (Date.now() < deadline) {
    n++;
    for (const [name, path] of [
      ['GET /requests', '/requests?size=50'],
      ['GET /map/features', '/map/features?time=' + encodeURIComponent(day)],
      ['GET /sites', '/sites'],
      ['GET /tasks', '/tasks'],
      ['GET /availability/grid', '/availability/grid?days=7'],
      ['GET /me', '/me'],
    ]) {
      const r = await call(cookie, 'GET', path);
      record(name, r.ms, r.status === 200);
    }
    if (n % 5 === 0) await createAndSubmit(cookie, index, n);
  }
}

/** Decides the open task of one request for the given person; returns the HTTP status (or null when not offered). */
async function decide(cookie, requestId, name, signature) {
  const task = (await call(cookie, 'GET', '/tasks')).body.find((t) => t.requestId === requestId);
  if (!task) return null;
  const detail = (await call(cookie, 'GET', '/requests/' + requestId)).body;
  const body = { decision: 'APPROVE', expectedRevision: detail.revision ?? detail.currentRevision ?? 1 };
  if (signature) body.signature = { confirm: true };
  const d = await call(cookie, 'POST', `/tasks/${task.id}/decision`, body, true);
  record(name, d.ms, d.status === 200);
  return d.status;
}

const started = Date.now();
let smoke = null;
if (SMOKE) {
  // one request through every stage, each decided by a different synthetic person (separation of duties, ADR-027)
  const id = await createAndSubmit(cookies[0], 0, 1);
  const own = (await call(cookies[0], 'GET', '/tasks')).body.some((t) => t.requestId === id);
  const facilities = id && await decide(reviewer, id, 'POST /tasks/{id}/decision (facilities)');
  const manager = facilities === 200 && await decide(await login('load.r.mgr'), id, 'POST /tasks/{id}/decision (organisation)');
  const approver = manager === 200 && await decide(await login('load.r.apr'), id, 'POST /tasks/{id}/decision (final)', true);
  const final = id && (await call(cookies[0], 'GET', '/requests/' + id)).body;
  smoke = { request: final?.number, submitted: Boolean(id), requesterOfferedOwnTask: own, facilities, manager, approver, status: final?.status };
} else {
  await Promise.all(cookies.map((_, i) => vu(i)));
  // the facilities reviewer takes the first stage of what was submitted (at most 20, measured as decisions)
  for (const id of submitted.slice(0, 20)) await decide(reviewer, id, 'POST /tasks/{id}/decision (facilities)');
  const tasks = await call(reviewer, 'GET', '/tasks');
  record('GET /tasks (reviewer, after load)', tasks.ms, tasks.status === 200);
}
const elapsed = (Date.now() - started) / 1000;

const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))];
let total = 0;
let errors = 0;
console.log(`\n${SMOKE ? 'Smoke workflow' : 'Exploratory load'}: ${USERS} signed-in users, ${elapsed.toFixed(0)} s, base ${BASE}\n`);
console.log('| Endpoint | Requests | P50 ms | P95 ms | Max ms | Errors |');
console.log('|---|---:|---:|---:|---:|---:|');
for (const [name, s] of stats) {
  const t = [...s.times].sort((a, b) => a - b);
  total += t.length;
  errors += s.errors;
  console.log(`| ${name} | ${t.length} | ${pct(t, 50).toFixed(0)} | ${pct(t, 95).toFixed(0)} | ${t[t.length - 1].toFixed(0)} | ${s.errors} |`);
}
console.log(`\nTotal ${total} requests, ${(total / Math.max(elapsed, 1)).toFixed(1)} req/s, error rate ${((errors / total) * 100).toFixed(2)}%`);
if (smoke) {
  console.log('\nSmoke workflow: ' + JSON.stringify(smoke));
  const ok = smoke.submitted && !smoke.requesterOfferedOwnTask && smoke.facilities === 200 && smoke.manager === 200
    && smoke.approver === 200 && smoke.status === 'APPROVED' && errors === 0;
  console.log(ok ? 'SMOKE PASSED' : 'SMOKE FAILED');
  process.exit(ok ? 0 : 1);
}
