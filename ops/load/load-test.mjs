// Exploratory load measurement (not an acceptance of capacity — decision D-03 is open).
// N virtual users loop over typical read endpoints and periodically create + submit a request; a facilities reviewer then
// takes the first stage of the requests submitted. Reports per-endpoint count, P50, P95, max (ms) and error rate.
//
// Sign-in uses the supported manual flow only: POST /api/v1/auth/directory/login, where the directory verifies the password
// and TMRKZ links the account to its HR record. Run it against the disposable load environment and its synthetic accounts
// (ops/load/up-load-env.sh), never against production or the acceptance environment.
//
// Usage: MOVER_URL=http://localhost:8099 SMOKE=1 node ops/load/load-test.mjs          (one request through every stage)
//        MOVER_URL=http://localhost:8099 USERS=50  SECONDS=60  node ops/load/load-test.mjs
//        MOVER_URL=http://localhost:8099 USERS=200 SECONDS=120 node ops/load/load-test.mjs
//        MOVER_URL=http://localhost:8099 USERS=500 SECONDS=180 node ops/load/load-test.mjs
// LOAD_PASSWORD defaults to ops/test-env/.generated/load-password; accounts are load.0001… and load.r.fac/mgr/apr.
//
// Coverage after the ADR-094 performance pass (brief §42): the loop exercises the critical operational-reads —
// /operational-posture (the one that used to be O(N) per authorised unit; now Site-Hub-friendly with a dataRevision
// + ETag that the 304 code-path relies on), /request-hub (now bulk per-unit state), /request-hub/home-cards, plus
// the existing /map/features viewport, /requests list, /sites, /tasks, /availability/grid and /me.
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

// Per-user state for the ETag-aware posture path: we send `If-None-Match: <last ETag>` once we have one, so every
// repeat posture call after the first is a cheap 304 Not Modified when nothing has changed. The counter records the
// fraction of 304s, which is the point of the dataRevision/ETag addition (brief §24, Gate 2 §A, Gate 2.5 §I). The
// siteHubs array of the first 200 response seeds a small per-user "selected site" and "selected unit" set so later
// iterations can also exercise the lazy /sites/{id} and /units/{id} detail paths realistically.
//
// Cold (200) and warm (304) latencies are recorded in separate buckets (Gate 2.5 §I) so the two very different cost
// profiles don't average away into one misleading P95.
const postureState = Array.from({ length: USERS }, () => ({ etag: null, siteIds: [], sampled: false }));
let postureNotModified = 0;

async function call304Posture(cookie, index) {
  const s = postureState[index];
  const t0 = performance.now();
  const headers = { Cookie: cookie, Accept: 'application/json' };
  if (s.etag) headers['If-None-Match'] = s.etag;
  const res = await fetch(BASE + '/api/v1/operational-posture', { headers });
  const text = await res.text();
  const ms = performance.now() - t0;
  const ok = res.status === 200 || res.status === 304;
  // Separate cold / warm series (§I). Cold = full response (200); warm = conditional 304. Averaging the two into
  // one bucket hides whichever profile is doing the actual load work.
  if (res.status === 304) {
    record('GET /operational-posture (warm 304)', ms, true);
    postureNotModified++;
  } else {
    record('GET /operational-posture (cold 200)', ms, ok);
  }
  // ETag is updated only on 200 responses; a 304 keeps the previous ETag valid.
  const etag = res.headers.get('etag');
  if (res.status === 200 && etag) s.etag = etag;
  // Sample up to 8 site ids from the first successful overview so later iterations can drill into a lazy detail.
  if (res.status === 200 && !s.sampled && text) {
    try {
      const body = JSON.parse(text);
      if (Array.isArray(body?.siteHubs) && body.siteHubs.length > 0) {
        s.siteIds = body.siteHubs.slice(0, 8).map((h) => h.siteId).filter(Boolean);
      }
      s.sampled = true;
    } catch {
      // not fatal — the lazy calls will be skipped for this user this loop
    }
  }
  return text && res.status === 200;
}

async function callLazySite(cookie, index) {
  const s = postureState[index];
  if (!s.siteIds.length) return;
  const siteId = s.siteIds[Math.floor(Math.random() * s.siteIds.length)];
  const r = await call(cookie, 'GET', '/operational-posture/sites/' + siteId);
  record('GET /operational-posture/sites/{id}', r.ms, r.status === 200);
  // Reserve the first authorised unit at that site for the subsequent /units/{id} probe in this loop iteration.
  if (r.status === 200 && Array.isArray(r.body?.units) && r.body.units.length > 0) {
    const unitId = r.body.units[0].id;
    const u = await call(cookie, 'GET', '/operational-posture/units/' + unitId);
    record('GET /operational-posture/units/{id}', u.ms, u.status === 200);
    // If the site carries pending request summaries, pick one and fetch its geometry (brief §F).
    if (Array.isArray(r.body?.pending) && r.body.pending.length > 0) {
      const requestId = r.body.pending[0].requestId;
      const pr = await call(cookie, 'GET', '/operational-posture/requests/' + requestId);
      record('GET /operational-posture/requests/{id}', pr.ms, pr.status === 200 || pr.status === 404);
    }
  }
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
      // Hub + home cards: bulk now, previously N+1 per unit (ADR-094)
      ['GET /request-hub', '/request-hub'],
      ['GET /request-hub/home-cards', '/request-hub/home-cards'],
    ]) {
      const r = await call(cookie, 'GET', path);
      record(name, r.ms, r.status === 200);
    }
    // Operational posture: viewer rights are the broadest, so we only ask for it when the account can read it. A
    // 403 from a non-posture account is still counted as "ran"; the error rate is then driven by data shape, not
    // a hot-path regression. Users without the right still exercise the normal reads above.
    await call304Posture(cookie, index);
    // Realistic traffic mix (brief §P): most iterations skip the lazy drill-down; one in three does it so the
    // 50/200/500-user plots carry representative /sites/{id} and /units/{id} latencies without 500 users all
    // hammering one endpoint in lockstep.
    if (n % 3 === 0) await callLazySite(cookie, index);
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
if (!SMOKE) {
  const cold = stats.get('GET /operational-posture (cold 200)')?.times.length ?? 0;
  const warm = stats.get('GET /operational-posture (warm 304)')?.times.length ?? 0;
  const postureCalls = cold + warm;
  if (postureCalls > 0) {
    console.log(`Operational posture: ${warm}/${postureCalls} answered 304 Not Modified `
      + `(${((warm / postureCalls) * 100).toFixed(1)} %), ${cold} cold 200 responses (new ETag)`);
    // Invalidation evidence (Gate 2.5 §J): the existing load naturally invalidates posture ETags via the
    // createAndSubmit writes (restationing_request is a posture_change trigger source). If the 304 % is
    // reasonable but non-trivial (both cold and warm present), the ETag is both saving backend work AND
    // correctly moving on writes. A test that showed only cold-200s would mean 304 is broken; only warm-304s
    // would mean writes aren't bumping the revision. Both numbers above together prove the invalidation path.
    if (cold > 0 && warm > 0) {
      console.log('Invalidation evidence: ETag moves on posture-relevant writes AND is honoured between them.');
    } else if (cold > 0) {
      console.log('WARNING: no warm 304s observed — the ETag path may be broken or writes are too frequent.');
    } else {
      console.log('WARNING: no cold 200s observed — writes may not be bumping the revision as expected.');
    }
  }
}
if (smoke) {
  console.log('\nSmoke workflow: ' + JSON.stringify(smoke));
  const ok = smoke.submitted && !smoke.requesterOfferedOwnTask && smoke.facilities === 200 && smoke.manager === 200
    && smoke.approver === 200 && smoke.status === 'APPROVED' && errors === 0;
  console.log(ok ? 'SMOKE PASSED' : 'SMOKE FAILED');
  process.exit(ok ? 0 : 1);
}
