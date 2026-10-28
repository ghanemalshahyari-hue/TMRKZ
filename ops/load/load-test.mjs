// Exploratory load measurement (not an acceptance of capacity — decision D-03 is open).
// N virtual users loop over typical read endpoints and periodically create + submit a request.
// Reports per-endpoint count, P50, P95, max (ms) and error rate.
//
// Usage: MOVER_URL=http://localhost:18089 LOAD_PASSWORD=... USERS=50 SECONDS=60 node ops/load/load-test.mjs

const BASE = process.env.MOVER_URL ?? 'http://localhost:18089';
const PASSWORD = process.env.LOAD_PASSWORD;
const USERS = Number(process.env.USERS ?? 50);
const SECONDS = Number(process.env.SECONDS ?? 60);
const stats = new Map();
const record = (name, ms, ok) => {
  const s = stats.get(name) ?? { times: [], errors: 0 };
  s.times.push(ms);
  if (!ok) s.errors++;
  stats.set(name, s);
};

async function call(cookie, method, path, body) {
  const t0 = performance.now();
  const res = await fetch(BASE + '/api/v1' + path, {
    method,
    headers: { Cookie: cookie, ...(method !== 'GET' ? { 'X-Requested-With': 'mover', 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const ms = performance.now() - t0;
  return { status: res.status, ms, body: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text };
}

async function login(user) {
  const res = await fetch(BASE + '/api/v1/auth/login', {
    method: 'POST', headers: { 'X-Requested-With': 'mover', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: PASSWORD }),
  });
  if (res.status !== 200) throw new Error('login failed for ' + user + ' ' + res.status);
  return res.headers.get('set-cookie').split(';')[0];
}

const cookies = [];
for (let i = 1; i <= USERS; i++) cookies.push(await login('load' + i));
const reviewer = await login('load51');
const sites = (await call(cookies[0], 'GET', '/sites')).body;
const resources = sites.flatMap((s) => s.resources).map((r) => r.id);
const typeCode = 'TEMP_OCCUPANCY';
const deadline = Date.now() + SECONDS * 1000;
const day = new Date().toISOString();

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
    if (n % 5 === 0) {
      const year = 2100 + index;
      const start = new Date(Date.UTC(year, 0, 1 + n)).toISOString();
      const end = new Date(Date.UTC(year, 0, 2 + n)).toISOString();
      const c = await call(cookie, 'POST', '/requests', {
        typeCode, origin: 'LIST', resourceIds: [resources[(index + n) % resources.length]], period: { start, end },
        values: { reason: 'طلب قياس أداء استكشافي' },
      });
      record('POST /requests', c.ms, c.status === 200);
      if (c.status === 200) {
        const s = await call(cookie, 'POST', `/requests/${c.body.id}/submit`, { expectedVersion: c.body.version });
        record('POST /requests/{id}/submit', s.ms, s.status === 200);
      }
    }
  }
}

const started = Date.now();
await Promise.all(cookies.map((_, i) => vu(i)));
const tasks = await call(reviewer, 'GET', '/tasks');
record('GET /tasks (reviewer, after load)', tasks.ms, tasks.status === 200);
const elapsed = (Date.now() - started) / 1000;

const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))];
let total = 0;
let errors = 0;
console.log(`\nExploratory load: ${USERS} concurrent users, ${elapsed.toFixed(0)} s, base ${BASE}\n`);
console.log('| Endpoint | Requests | P50 ms | P95 ms | Max ms | Errors |');
console.log('|---|---:|---:|---:|---:|---:|');
for (const [name, s] of stats) {
  const t = [...s.times].sort((a, b) => a - b);
  total += t.length;
  errors += s.errors;
  console.log(`| ${name} | ${t.length} | ${pct(t, 50).toFixed(0)} | ${pct(t, 95).toFixed(0)} | ${t[t.length - 1].toFixed(0)} | ${s.errors} |`);
}
console.log(`\nTotal ${total} requests, ${(total / elapsed).toFixed(1)} req/s, error rate ${((errors / total) * 100).toFixed(2)}%`);
