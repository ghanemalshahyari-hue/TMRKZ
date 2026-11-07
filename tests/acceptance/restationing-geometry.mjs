// Stationing V3 geometry editing (owner gates «GEOMETRY EDITING PHASE — GO» and «GEOMETRY IMPLEMENTATION → tmrkz-test
// ACCEPTANCE GO», 4 Nov 2026) on the REAL page with the real Keycloak/LDAP sign-in: G1 Polygon grouped move + reload, G2
// Polygon vertex edit + reload, G3 MultiPolygon copied whole, G4 grouped move of a two-part and a four-part MultiPolygon,
// G5 MultiPolygon vertex edit + reload, G6 invalid edit, G7 maximum area, G8 undo/redo/reset, G9 redraw by choice, PTR
// pointer release over the attribution, another map control and outside the canvas, the approver's view with return
// and resubmission, activation (with the occupancy re-check), and performance on a Polygon, two-part, four-part and
// 1,500-vertex site. Every geometry claim is checked against what the SERVER saved (GET /restationing-requests/{id}).
// Fictional data only. Drags are computed from the Web Mercator projection around the camera the editor opens on.
//
// Usage: MOVER_URL=http://localhost:8088 node tests/acceptance/restationing-geometry.mjs   (tmrkz-test, profile acceptance)
//        MOVER_URL=http://localhost:8097 node tests/acceptance/restationing-geometry.mjs   (tmrkz-v3dev, profile development)
//        ONLY=G1,G3,…  runs a subset (G2 needs G1, G6/G7 need G2, G4/G5 need G3, APPROVER needs G5, ACTIVATION needs
//        APPROVER). The acceptance profile reads the database for evidence only, in read-only transactions.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const BASE = process.env.MOVER_URL ?? 'http://localhost:8097';
const ACC = (process.env.PROFILE ?? (/:8088\b/.test(BASE) ? 'acceptance' : 'development')) === 'acceptance';
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const run = (k) => !ONLY || ONLY.has(k);
const OUT = new URL(`../../docs/evidence/acceptance-journeys/stationing-v3/geometry/${ACC ? 'tmrkz-test/' : ''}`, import.meta.url);
mkdirSync(OUT, { recursive: true });
const shot = (name) => fileURLToPath(new URL(name, OUT));
const PASSWORD = readFileSync(new URL('../../ops/test-env/.generated/user-password', import.meta.url), 'utf8').trim();
const require = createRequire(new URL('./package.json', import.meta.url));
const { chromium } = require('playwright-core');
const ZOOM = 15; // SiteEditor.ZOOM: the camera an editing session opens at, centred on the site's anchor
// the accepted engine's own rigid-move tolerances (siteGeometry.test.ts, footprint.test.ts)
const TOL = { lengthM: 0.5, areaRel: 1e-3 };
const DATA = ACC ? 'بيانات قبول وهمية' : 'بيانات تطوير وهمية';

// who edits which site: [user, requesting unit, moving unit, label]
const SITES = ACC
  ? {
      polygon: ['t.requester', 'الخدمات المشتركة', 'الخدمات المشتركة', 'Polygon'],
      multi: ['t.requester', 'الخدمات المشتركة', 'قسم الخدمات العامة', 'MultiPolygon, 2 parts (site 05)'],
      multi4: ['t.requester.pm', 'قسم مشاريع المباني', 'قسم قبول الأداء — موقع من أربعة أجزاء', 'MultiPolygon, 4 parts (ACC-GEO-MP4)'],
      dense: ['t.requester.pm', 'قسم مشاريع المباني', 'قسم قبول الأداء — موقع كثيف الرؤوس', 'Polygon, 1,500 vertices (ACC-GEO-DENSE)'],
    }
  : {
      polygon: ['t.requester', 'الخدمات المشتركة', 'الخدمات المشتركة', 'Polygon'],
      multi: ['t.requester2', 'إدارة التقنية', 'إدارة التقنية', 'MultiPolygon, 2 parts (DEV-MP2)'],
      multi4: ['t.manager.ga', 'قسم مشاريع المباني', 'وحدة الصيانة الإدارية', 'MultiPolygon, 4 parts (DEV-MP4)'],
      dense: ['t.manager.ga', 'قسم مشاريع المباني', 'فريق مرافق الشمال', 'Polygon, 1,500 vertices (DEV-DENSE)'],
    };
// the fictional approver seats: unit code → persona (provision-acceptance-v3*.sh)
const SEAT = {
  'HR-T-SS': 't.manager', 'HR-T-IT': 't.manager.it', 'HR-T-PM': 't.manager.ga', 'HR-T-ORG': 't.approver',
  'HR-T-PM-1': 't.seat.l8', 'HR-T-PM-1-1': 't.seat.l9', 'HR-T-PM-1-1-1': 't.seat.l10',
};
const deciderFor = (stage) => (stage.kind === 'EXCEPTION' ? 't.approver2' : SEAT[stage.unit?.code]);

const results = [];
const perf = [];
const requests = [];
const ok = (cond, id, label, extra = '') => {
  results.push({ id, label, result: cond ? 'PASS' : 'FAIL', extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${id}  ${label}${extra ? '  — ' + extra : ''}`);
  return cond;
};

// ---- read-only database evidence (acceptance profile) -------------------------------------------------------------
const DB = process.env.DB_CONTAINER ?? 'tmrkz-test-db-1';
const sql = (q) => execFileSync('docker', ['exec', '-i', DB, 'psql', '-X', '-q', '-U', 'mover', '-d', 'mover', '-At', '-v', 'ON_ERROR_STOP=1'], {
  input: 'set default_transaction_read_only = on;\n' + q, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' },
}).trim();
const sqlJson = (q) => JSON.parse(sql(`select coalesce(json_agg(x), '[]') from (${q}) x;`));

// ---- geometry, as the page computes it (lib/footprint, lib/siteGeometry) --------------------------------------------
const R = 6371008.8;
const M_LAT = 110_900;
const rad = (d) => (d * Math.PI) / 180;
const mLng = (lat) => 111_320 * Math.cos(rad(lat));
const dist = (a, b) => {
  const s = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};
const ringOf = (c) => c.map(([lng, lat]) => ({ lat, lng })).slice(0, -1);
const partsOf = (g) => (g.type === 'Polygon' ? [g.coordinates.map(ringOf)] : g.coordinates.map((p) => p.map(ringOf)));
const ringArea = (r) => {
  let t = 0;
  for (let i = 0; i < r.length; i++) {
    const p1 = r[i], p2 = r[(i + 1) % r.length], p3 = r[(i + 2) % r.length];
    t += (rad(p3.lng) - rad(p1.lng)) * Math.sin(rad(p2.lat));
  }
  return Math.abs((t * R * R) / 2);
};
// about the ring's first vertex: on absolute coordinates (55°, 25°) the shoelace sums lose ~1e-6° (0.1–1 m) to cancellation
const centroid = (r) => {
  const o = r[0];
  let a = 0, x = 0, y = 0;
  for (let i = 0; i < r.length; i++) {
    const p = { lng: r[i].lng - o.lng, lat: r[i].lat - o.lat }, q = { lng: r[(i + 1) % r.length].lng - o.lng, lat: r[(i + 1) % r.length].lat - o.lat };
    const f = p.lng * q.lat - q.lng * p.lat;
    a += f; x += (p.lng + q.lng) * f; y += (p.lat + q.lat) * f;
  }
  return { lat: o.lat + y / (3 * a), lng: o.lng + x / (3 * a) };
};
const anchorOf = (parts) => {
  let w = 0, lat = 0, lng = 0;
  for (const p of parts) {
    const a = ringArea(p[0]), c = centroid(p[0]);
    w += a; lat += c.lat * a; lng += c.lng * a;
  }
  return { lat: lat / w, lng: lng / w };
};
const edges = (r) => r.map((p, i) => dist(p, r[(i + 1) % r.length]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameGeometry = (a, b) => !!a && !!b && a.type === b.type && same(a.coordinates, b.coordinates);
const vertexCount = (parts) => parts.reduce((s, p) => s + p[0].length, 0);
/** A grouped move measured by PostGIS on the spheroid: per-vertex displacement, part-centroid distances, area. */
const postgisMove = (a, b) => sqlJson(`
  with o as (select ST_SetSRID(ST_GeomFromGeoJSON('${JSON.stringify(a)}'), 4326) g), m as (select ST_SetSRID(ST_GeomFromGeoJSON('${JSON.stringify(b)}'), 4326) g),
  po as (select (d).path[1] i, (d).geom g from (select ST_Dump(g) d from o) x), pm as (select (d).path[1] i, (d).geom g from (select ST_Dump(g) d from m) x),
  vo as (select (d).path k, (d).geom g from (select ST_DumpPoints(g) d from o) x), vm as (select (d).path k, (d).geom g from (select ST_DumpPoints(g) d from m) x),
  disp as (select ST_Distance(vo.g::geography, vm.g::geography) d from vo join vm using (k)),
  pairs as (select abs(ST_Distance(ST_Centroid(a.g)::geography, ST_Centroid(b.g)::geography) - ST_Distance(ST_Centroid(c.g)::geography, ST_Centroid(e.g)::geography)) d
              from po a join po b on a.i < b.i join pm c on c.i = a.i join pm e on e.i = b.i)
  select min(d) moved, max(d) - min(d) spread, (select coalesce(max(d), 0) from pairs) pair_change,
         abs(ST_Area((select g from m)::geography) / ST_Area((select g from o)::geography) - 1) area_change from disp`)[0];
/** A point beyond the edge opposite vertex i of ring r: dragging vertex i there makes the ring cross itself. */
const acrossOpposite = (r, i) => {
  const j = (i + Math.floor(r.length / 2)) % r.length, k = (j + 1) % r.length;
  const c = centroid(r);
  const mid = { lat: (r[j].lat + r[k].lat) / 2, lng: (r[j].lng + r[k].lng) / 2 };
  return { lat: 2 * mid.lat - c.lat, lng: 2 * mid.lng - c.lng };
};

// Web Mercator pixels (512-px tiles, as MapLibre) relative to the camera centre
const world = (z) => 512 * 2 ** z;
const merc = (p, z) => ({ x: ((p.lng + 180) / 360) * world(z), y: ((1 - Math.log(Math.tan(rad(p.lat)) + 1 / Math.cos(rad(p.lat))) / Math.PI) / 2) * world(z) });
const toScreen = (p, centre, box, z = ZOOM) => {
  const a = merc(p, z), c = merc(centre, z);
  return { x: box.x + box.width / 2 + (a.x - c.x), y: box.y + box.height / 2 + (a.y - c.y) };
};
const fromScreen = (pt, centre, box, z = ZOOM) => {
  const c = merc(centre, z);
  const x = c.x + (pt.x - box.x - box.width / 2), y = c.y + (pt.y - box.y - box.height / 2);
  return { lng: (x / world(z)) * 360 - 180, lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / world(z)))) * 180) / Math.PI };
};

// ---- real sign-in -------------------------------------------------------------------------------------------------
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
const sessions = new Map();
function as(username) {
  if (!sessions.has(username)) sessions.set(username, signIn(username).catch((e) => { sessions.delete(username); throw e; }));
  return sessions.get(username);
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
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const type = r.headers.get('content-type') ?? '';
    return { status: r.status, body: type.includes('json') ? await r.json() : await r.text() };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b) };
}

const browser = await chromium.launch({ ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : { channel: 'msedge' }), headless: true });
const external = [];
const consoleErrors = [];
async function pageAs(user) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('request', (q) => { const u = q.url(); if (!u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u); });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`${user}: ${m.text()}`));
  page.on('pageerror', (e) => consoleErrors.push(`${user}: ${e.message}`));
  page.on('dialog', (d) => (page.__dialog === 'dismiss' ? d.dismiss() : d.accept()));
  await page.goto(BASE + '/api/v1/auth/oidc/start');
  await page.waitForSelector('#kc-form-login', { timeout: 30000 });
  await page.fill('#username', user);
  await page.fill('#password', PASSWORD);
  await page.click('#kc-login');
  await page.waitForURL((u) => u.toString().startsWith(BASE) && !u.toString().includes('/auth/realms/'), { timeout: 30000 });
  return page;
}

// ---- instruments: long tasks (> 50 ms) and validation feedback after a release ---------------------------------------
/** Installs the long-task observer in the current document (hash navigations keep the document) and clears it. */
const longTasks = (page) => page.evaluate(() => {
  if (!window.__lt) {
    window.__lt = true;
    window.__long = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ type: 'longtask' });
  }
  window.__long = [];
});
/** Arms a probe: from the next pointer release to the last change of the editor's readout (validity verdict). */
const armFeedback = (page) => page.evaluate(() => {
  window.__fb = null;
  window.addEventListener('pointerup', () => {
    const t0 = performance.now();
    let last = t0;
    const host = document.querySelector('.rs-site-controls');
    const mo = new MutationObserver(() => { last = performance.now(); });
    if (host) mo.observe(host, { subtree: true, childList: true, characterData: true, attributes: true });
    setTimeout(() => { mo.disconnect(); window.__fb = Math.round(last - t0); }, 800);
  }, { capture: true, once: true });
});
const feedback = async (page) => {
  await page.waitForFunction(() => window.__fb !== null, null, { timeout: 5000 });
  return page.evaluate(() => window.__fb);
};
/** Presses an editor button and measures, in the page, until the readout has changed and the next frame is drawn. */
const timedButton = (page, name) => page.evaluate((name) => new Promise((resolve) => {
  const ro = document.querySelector('[data-testid=site-readout]');
  const before = ro.textContent;
  const btn = [...document.querySelectorAll('.rs-site-controls button')].find((b) => b.textContent.trim() === name);
  const t0 = performance.now();
  btn.click();
  const tick = () => {
    const el = document.querySelector('[data-testid=site-readout]');
    if (el && el.textContent !== before) requestAnimationFrame(() => resolve(Math.round(performance.now() - t0)));
    else if (performance.now() - t0 > 3000) resolve(null);
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}), name);

// ---- the editor on the page ----------------------------------------------------------------------------------------
const toast = async (page, text, timeout = 15000) =>
  page.waitForFunction((t) => { const e = document.getElementById('toast'); return e && !e.hidden && e.textContent.includes(t) ? e.textContent : null; }, text, { timeout }).then((h) => h.jsonValue());
async function newDraftWithCopy([user, unitName, movingName], label) {
  const page = await pageAs(user);
  await page.goto(`${BASE}/#restationing`);
  await page.waitForSelector('.rs-list');
  await page.getByRole('button', { name: '＋ طلب إعادة تمركز' }).click();
  await page.locator('.rs-form select').first().selectOption({ label: unitName });
  await page.locator('.rs-check', { hasText: movingName }).first().locator('input').check();
  await page.locator('.rs-form textarea').first().fill(`تحرير الهندسة — ${label} (${DATA})`);
  const created = page.waitForResponse((r) => r.url().endsWith('/api/v1/restationing-requests') && r.request().method() === 'POST');
  const t0 = Date.now();
  await page.getByRole('button', { name: 'نسخ حدود الموقع الحالي' }).click();
  const id = (await (await created).json()).id;
  const message = await toast(page, 'نُسخت حدود');
  const copyMs = Date.now() - t0;
  await page.waitForSelector('[data-testid=site-readout]');
  await page.waitForTimeout(800);
  await longTasks(page);
  requests.push({ scenario: label, id, user });
  return { page, id, user, message, copyMs };
}
async function save(page) {
  const done = page.waitForResponse((r) => /\/api\/v1\/restationing-requests\/[^/]+\/checks$/.test(r.url()));
  await page.getByRole('button', { name: 'حفظ المسودة والفحص' }).click();
  await done;
  await page.waitForTimeout(600);
}
/** Reloads the page, opens the request again and its editor: a new editing session centred on the saved geometry. */
async function reopen(page, id) {
  await page.goto(`${BASE}/#restationing/${id}`);
  await page.reload();
  await page.waitForSelector('.rs-summary', { timeout: 30000 });
  await page.getByRole('button', { name: 'تعديل الطلب' }).click();
  await page.waitForSelector('[data-testid=site-readout]', { timeout: 15000 });
  await page.waitForTimeout(800);
  await longTasks(page);
}
const viewOf = async (user, id) => (await (await as(user)).get('/restationing-requests/' + id)).body;
const checksOf = async (user, id) => (await (await as(user)).get(`/restationing-requests/${id}/checks`)).body;
const box = async (page) => page.locator('.rs-map-card canvas.maplibregl-canvas').first().boundingBox();
async function drag(page, from, to, steps = 24) {
  await longTasks(page);
  const t0 = await page.evaluate(() => performance.now());
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const { t1, long } = await page.evaluate(() => ({ t1: performance.now(), long: window.__long.slice() }));
  return { ms: Math.round(t1 - t0), steps, longest: Math.round(Math.max(0, ...long)), longTasks: long.length };
}
const readout = async (page) => (await page.locator('[data-testid=site-readout]').textContent()).replace(/\s+/g, ' ').trim();
/** The area the page shows (المساحة: 82,337 م²), as a number. */
const pageArea = (text) => Number((text.match(/المساحة: ([\d,٬.٠-٩]+)/)?.[1] ?? '').replace(/[,٬]/g, '').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))));
const validity = async (page) => (await page.locator('[data-testid=site-validity]').textContent()).trim();
const siteProblemIn = (sub, text) => (sub.body?.details?.problems ?? [sub.body?.message ?? '']).some((p) => p.includes(text));
async function approveAll(id, viewer) {
  for (let i = 0; i < 10; i++) {
    const r = await viewOf(viewer, id);
    const cur = r.route?.find((s) => s.current);
    if (!cur) return r.state;
    const who = deciderFor(cur);
    if (!who) return `no fictional seat holder for «${cur.label}»`;
    const d = await (await as(who)).post(`/restationing-requests/${id}/decision`, { decision: 'APPROVE' });
    if (d.status !== 200) return `«${cur.label}» by ${who}: ${d.status} ${d.body.message ?? ''}`;
  }
  return 'too many stages';
}
/** Deployment areas as in the accepted journeys: primary 6 km east of the site, alternative 4 km south of it. */
const square = (lat, lng, h) => ({ type: 'Polygon', coordinates: [[[lng - h / mLng(lat), lat - h / M_LAT], [lng + h / mLng(lat), lat - h / M_LAT], [lng + h / mLng(lat), lat + h / M_LAT], [lng - h / mLng(lat), lat + h / M_LAT], [lng - h / mLng(lat), lat - h / M_LAT]]] });
const deployments = (a) => {
  const pr = { lat: a.lat, lng: a.lng + 6000 / mLng(a.lat) };
  return { primary: square(pr.lat, pr.lng, 300), alternative: square(pr.lat - 4000 / M_LAT, pr.lng, 300) };
};

const state = {};

try {
  // ---- the long-task instrument works (a deliberate 120 ms task is seen) ---------------------------------------------
  {
    const page = await pageAs(SITES.polygon[0]);
    await page.goto(`${BASE}/#restationing`);
    await page.waitForSelector('.rs-list');
    await longTasks(page);
    // scheduled as a page task (a script injected by the driver is not attributed as one)
    await page.evaluate(() => setTimeout(() => { const t = performance.now(); while (performance.now() - t < 120); }, 0));
    await page.waitForTimeout(400);
    const seen = await page.evaluate(() => window.__long.slice());
    ok(seen.some((d) => d >= 100), 'INSTRUMENT', 'the long-task observer records a deliberate 120 ms task (so "0 long tasks" is a measurement)', `recorded ${seen.map(Math.round).join(', ')} ms`);
    await page.context().close();
  }

  // ---- G1: Polygon — copy, grouped move, save, reload -------------------------------------------------------------
  if (run('G1')) {
    const d = await newDraftWithCopy(SITES.polygon, 'G1 مضلع');
    await save(d.page);
    const v0 = await viewOf(d.user, d.id);
    const copy = v0.content.site.geometry;
    const current = v0.currentSites.find((s) => s.site.id === v0.content.site.copiedFrom);
    ok(copy.type === 'Polygon' && sameGeometry(copy, current?.geometry) && v0.content.site.shape === 'COPY', 'G1a', 'Polygon copied exactly (saved by the server)', `${d.message}; ${vertexCount(partsOf(copy))} vertices; shape ${v0.content.site.shape}, copied from «${current?.site.name}»`);
    const parts0 = partsOf(copy);
    const centre = anchorOf(parts0);
    const b = await box(d.page);
    const from = toScreen(centre, centre, b);
    const p = await drag(d.page, from, { x: from.x + 140, y: from.y - 90 });
    await save(d.page);
    const v1 = await viewOf(d.user, d.id);
    const parts1 = partsOf(v1.content.site.geometry);
    const areaDiff = Math.abs(ringArea(parts1[0][0]) - ringArea(parts0[0][0])) / ringArea(parts0[0][0]);
    const edgeDiff = Math.max(...edges(parts1[0][0]).map((e, i) => Math.abs(e - edges(parts0[0][0])[i])));
    const movedM = dist(anchorOf(parts1), centre);
    const c1 = await checksOf(d.user, d.id);
    ok(v1.content.site.geometry.type === 'Polygon' && parts1[0][0].length === parts0[0][0].length && areaDiff < TOL.areaRel && edgeDiff < TOL.lengthM && movedM > 300 && !c1.problems.some((x) => x.startsWith('حدود الموقع المقترح')), 'G1b',
      'grouped drag: shape and area kept; the server accepts the saved geometry', `moved ${Math.round(movedM)} m; area Δ ${(areaDiff * 100).toFixed(4)} %; max edge Δ ${edgeDiff.toFixed(3)} m; server site area ${c1.siteAreaM2} m²; ${p.longTasks} long tasks`);
    await d.page.screenshot({ path: shot('G1-moved.png') });
    await reopen(d.page, d.id);
    await save(d.page);
    const v2 = await viewOf(d.user, d.id);
    ok(sameGeometry(v2.content.site.geometry, v1.content.site.geometry), 'G1c', 'after reload and reopening, the moved Polygon is exactly the saved one (saved again unchanged)', await readout(d.page));
    state.g1 = { ...d, centre: anchorOf(parts1), parts1, geometry: v1.content.site.geometry };
  }

  // ---- G2: Polygon — vertex edit, save, reload --------------------------------------------------------------------
  if (run('G2') && state.g1) {
    const { page, id, user, centre, parts1 } = state.g1;
    await page.getByRole('button', { name: 'تعديل الحدود' }).click();
    await page.waitForTimeout(500);
    const b = await box(page);
    const from = toScreen(parts1[0][0][1], centre, b);
    const before = await readout(page);
    await drag(page, from, { x: from.x + 40, y: from.y + 25 }, 16);
    const during = await readout(page);
    await save(page);
    const v2 = await viewOf(user, id);
    const parts2 = partsOf(v2.content.site.geometry);
    const others = parts2[0][0].every((p, i) => i === 1 || same(p, parts1[0][0][i]));
    const c2 = await checksOf(user, id);
    ok(!same(parts2[0][0][1], parts1[0][0][1]) && others && v2.content.site.shape === 'EDITED' && during !== before && (await validity(page)) === 'الحدود صالحة' && Math.abs(c2.siteAreaM2 - pageArea(during)) / c2.siteAreaM2 < 1e-3, 'G2a',
      'one vertex moved; area and validity update live; the page and the server agree on the area; stored as EDITED', `readout: ${during}; server area ${c2.siteAreaM2} m²`);
    await page.screenshot({ path: shot('G2-vertex.png') });
    await reopen(page, id);
    await save(page);
    const v3 = await viewOf(user, id);
    ok(sameGeometry(v3.content.site.geometry, v2.content.site.geometry), 'G2b', 'after reload and reopening, the editor holds exactly the saved geometry (saved again unchanged)', await readout(page));
    state.g2 = { page, id, user, centre: anchorOf(parts2), parts: parts2 };
  }

  // ---- G6: invalid edit — immediate warning, server refusal, not submitted ------------------------------------------
  if (run('G6') && state.g2) {
    const { page, id, user, centre, parts } = state.g2;
    await page.getByRole('button', { name: 'تعديل الحدود' }).click();
    await page.waitForTimeout(400);
    const r = parts[0][0];
    const b = await box(page);
    await drag(page, toScreen(r[2], centre, b), toScreen(acrossOpposite(r, 2), centre, b), 16);
    const warn = await validity(page);
    const submitDisabled = await page.getByRole('button', { name: 'إرسال للاعتماد' }).isDisabled();
    await save(page);
    const ch = await checksOf(user, id);
    const sub = await (await as(user)).post(`/restationing-requests/${id}/submit`, {});
    const st = (await viewOf(user, id)).state;
    ok(warn.startsWith('الحدود غير صالحة') && submitDisabled && ch.problems.some((x) => x.startsWith('حدود الموقع المقترح')) && sub.status === 400 && siteProblemIn(sub, 'حدود الموقع المقترح') && st === 'DRAFT', 'G6',
      'a self-crossing edit: immediate warning, the page blocks submission, the server refuses it, the request stays a draft', `${warn}; server: ${ch.problems.find((x) => x.startsWith('حدود الموقع المقترح'))}; submit ${sub.status}; state ${st}`);
    await page.screenshot({ path: shot('G6-invalid.png') });
    await page.getByRole('button', { name: 'تراجع', exact: true }).click();
    await page.waitForTimeout(400);
    await save(page);
  }

  // ---- G7: maximum footprint — hard block ---------------------------------------------------------------------------
  if (run('G7') && state.g2) {
    const { page, id, user, centre, parts } = state.g2;
    const limit = (await checksOf(user, id)).maxFootprintAreaM2;
    // out to three zoom levels lower (MapLibre's keyboard step keeps the centre and lands on a whole zoom level)
    await page.locator('.rs-map-card canvas.maplibregl-canvas').first().focus();
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Minus'); await page.waitForTimeout(600); }
    const z = ZOOM - 3;
    const r = parts[0][0];
    // vertex 3 pulled straight out from the diagonal between its neighbours, far enough for 1.5 × the limit
    const mid = { lat: (r[1].lat + r[3].lat) / 2, lng: (r[1].lng + r[3].lng) / 2 };
    const h = (2 * 1.5 * limit) / dist(r[1], r[3]);
    const dx = (r[2].lng - mid.lng) * mLng(mid.lat), dy = (r[2].lat - mid.lat) * M_LAT, n = Math.hypot(dx, dy);
    const target = { lat: mid.lat + ((dy / n) * h) / M_LAT, lng: mid.lng + ((dx / n) * h) / mLng(mid.lat) };
    const b = await box(page);
    await drag(page, toScreen(r[2], centre, b, z), toScreen(target, centre, b, z), 20);
    const warn = await validity(page);
    await save(page);
    const ch = await checksOf(user, id);
    const sub = await (await as(user)).post(`/restationing-requests/${id}/submit`, {});
    const v = await viewOf(user, id);
    const landed = dist(partsOf(v.content.site.geometry)[0][0][2], target);
    ok(warn.includes('المساحة تتجاوز الحد الأقصى المعتمد') && ch.problems.some((x) => x.includes('تتجاوز الحد الأقصى المعتمد')) && sub.status === 400 && siteProblemIn(sub, 'تتجاوز الحد الأقصى المعتمد') && v.state === 'DRAFT', 'G7',
      'beyond the configured maximum footprint: shown immediately and refused by the server (hard block)', `${await readout(page)}; server: ${ch.problems.find((x) => x.includes('تتجاوز'))}; submit ${sub.status}; state ${v.state}; vertex landed ${Math.round(landed)} m from the aimed point`);
    await page.screenshot({ path: shot('G7-max-area.png') });
    await page.context().close();
  }

  // ---- G9: redraw only by the requester's choice ---------------------------------------------------------------------
  if (run('G9')) {
    const d = await newDraftWithCopy(SITES.polygon, 'G9 رسم جديد');
    await save(d.page);
    const copy = (await viewOf(d.user, d.id)).content.site;
    d.page.__dialog = 'dismiss';
    await d.page.getByRole('button', { name: 'رسم حدود جديدة' }).click();
    await d.page.waitForTimeout(400);
    await save(d.page);
    const kept = (await viewOf(d.user, d.id)).content.site;
    d.page.__dialog = 'accept';
    await d.page.getByRole('button', { name: 'رسم حدود جديدة' }).click();
    const told = await toast(d.page, 'أُلغيت الحدود السابقة بطلبك');
    const b = await box(d.page);
    await d.page.mouse.click(b.x + b.width / 2 + 200, b.y + b.height / 2);
    await toast(d.page, 'رُسمت حدود جديدة');
    await save(d.page);
    const drawn = (await viewOf(d.user, d.id)).content.site;
    ok(sameGeometry(kept.geometry, copy.geometry) && kept.shape === 'COPY' && drawn.shape === 'DRAWN' && drawn.copiedFrom == null && !sameGeometry(drawn.geometry, copy.geometry), 'G9',
      '«رسم حدود جديدة»: declined, the copy stays; chosen, the copy is discarded with a message and a new shape is drawn', `${told.trim()}; copy ${copy.shape} → kept ${kept.shape} → ${drawn.shape}`);
    await d.page.context().close();
  }

  // ---- PTR: a drag released over the attribution, over another map control, outside the canvas ---------------------
  if (run('PTR')) {
    const d = await newDraftWithCopy(SITES.polygon, 'PTR إفلات المؤشر');
    const page = d.page;
    await save(page);
    const g0 = (await viewOf(d.user, d.id)).content.site.geometry;
    const centre0 = anchorOf(partsOf(g0));
    const b = await box(page);
    const centreOf = async (sel) => { const e = await page.locator(sel).first().boundingBox(); return { x: e.x + e.width / 2, y: e.y + e.height / 2 }; };
    const targets = [
      ['PTR1', 'released over the map attribution', await centreOf('.rs-map-card .maplibregl-ctrl-attrib')],
      ['PTR2', 'released over another map control (the map-source notice)', await centreOf('.rs-map-card [data-testid=map-source-notice]')],
      ['PTR3', 'released outside the map canvas', { x: b.x + b.width + 120 < 1590 ? b.x + b.width + 120 : b.x - 120, y: b.y + b.height / 2 }],
    ];
    for (const [key, label, release] of targets) {
      // each case from the copied position (the previous case left the site under its release point)
      await page.getByRole('button', { name: 'استعادة البداية', exact: true }).click();
      await page.waitForTimeout(300);
      const a0 = centre0;
      const start = toScreen(a0, centre0, b);
      await drag(page, start, release, 24);
      // after the release the pointer moves on without a button: the site must not follow it
      await page.mouse.move(b.x + 40, b.y + 40, { steps: 8 });
      await page.waitForTimeout(300);
      const undoOn = await page.getByRole('button', { name: 'تراجع', exact: true }).isEnabled();
      await save(page);
      const g1 = (await viewOf(d.user, d.id)).content.site.geometry;
      const s0 = fromScreen(start, centre0, b), s1 = fromScreen(release, centre0, b);
      const expected = { lat: a0.lat + (s1.lat - s0.lat), lng: a0.lng + (s1.lng - s0.lng) };
      const off = dist(anchorOf(partsOf(g1)), expected);
      ok(off < 3 && undoOn && (await validity(page)) === 'الحدود صالحة', key, `${label}: the drag ends there, the move is committed and saved where the pointer was released`, `moved ${Math.round(dist(a0, anchorOf(partsOf(g1))))} m; ${off.toFixed(2)} m from the release point`);
    }
    await page.screenshot({ path: shot('PTR-released.png') });
    await page.context().close();
  }

  // ---- G3: MultiPolygon copied whole ---------------------------------------------------------------------------------
  if (run('G3')) {
    const d = await newDraftWithCopy(SITES.multi, 'G3 متعدد الأجزاء');
    const banner = await d.page.locator('.rs-site-controls .rs-banner').first().textContent();
    await save(d.page);
    const v0 = await viewOf(d.user, d.id);
    const copy = v0.content.site.geometry;
    const current = v0.currentSites.find((s) => s.site.id === v0.content.site.copiedFrom);
    ok(copy.type === 'MultiPolygon' && current?.geometry?.type === 'MultiPolygon' && copy.coordinates.length === current.geometry.coordinates.length && sameGeometry(copy, current.geometry) && banner.includes('كل أجزاء الموقع ستنتقل معاً'), 'G3',
      'MultiPolygon copied whole: every part, in order, same coordinates; «كل أجزاء الموقع ستنتقل معاً»', `${d.message}; ${copy.coordinates.length} parts from «${current?.site.name}»; copy ${d.copyMs} ms`);
    await d.page.screenshot({ path: shot('G3-copied.png') });
    state.g3 = { ...d, parts0: partsOf(copy), centre: anchorOf(partsOf(copy)), copy };
  }

  /** One drag from part 1 moves every part: areas, shapes and the distances between parts kept within TOL. */
  async function groupedMove(page, user, id, geom0, vector) {
    const parts0 = partsOf(geom0);
    const centre = anchorOf(parts0);
    const b = await box(page);
    const from = toScreen(centroid(parts0[0][0]), centre, b);
    const p = await drag(page, from, { x: from.x + vector.x, y: from.y + vector.y });
    await save(page);
    const v = await viewOf(user, id);
    const parts1 = partsOf(v.content.site.geometry);
    const areas = parts1.map((pt, i) => Math.abs(ringArea(pt[0]) - ringArea(parts0[i][0])) / ringArea(parts0[i][0]));
    const each = parts1.map((pt, i) => dist(centroid(pt[0]), centroid(parts0[i][0])));
    const pairs = [];
    for (let i = 0; i < parts0.length; i++) for (let j = i + 1; j < parts0.length; j++) {
      pairs.push(Math.abs(dist(centroid(parts1[i][0]), centroid(parts1[j][0])) - dist(centroid(parts0[i][0]), centroid(parts0[j][0]))));
    }
    const edgeDiff = Math.max(...parts1.map((pt, i) => Math.max(...edges(pt[0]).map((e, k) => Math.abs(e - edges(parts0[i][0])[k])))));
    // the same, measured by PostGIS on the WGS84 spheroid (authoritative on the acceptance environment)
    const pg = ACC ? postgisMove(geom0, v.content.site.geometry) : null;
    const pass = v.content.site.geometry.type === 'MultiPolygon' && parts1.length === parts0.length && Math.max(...areas) < TOL.areaRel
      && Math.max(...pairs) < TOL.lengthM && edgeDiff < TOL.lengthM && Math.max(...each) - Math.min(...each) < TOL.lengthM && Math.min(...each) > 300
      && (!pg || (pg.spread < TOL.lengthM && pg.pair_change < TOL.lengthM && pg.area_change < TOL.areaRel));
    return { pass, v, parts1, drag: p, text: `each part moved ${each.map((m) => m.toFixed(2)).join(' / ')} m; largest change of a distance between parts ${Math.max(...pairs).toFixed(3)} m (${pairs.length} pairs); largest edge change ${edgeDiff.toFixed(3)} m; largest area change ${(Math.max(...areas) * 100).toFixed(4)} % (tolerance ${TOL.lengthM} m, ${TOL.areaRel * 100} %)${pg ? `; PostGIS: every vertex moved ${pg.moved.toFixed(3)} m (spread ${(pg.spread * 1000).toFixed(1)} mm), distances between part centroids changed by at most ${(pg.pair_change * 1000).toFixed(2)} mm, area change ${(pg.area_change * 100).toFixed(5)} %` : ''}; ${p.longTasks} long tasks` };
  }

  // ---- G4: grouped move of the two-part site and of the four-part fixture ---------------------------------------------
  if (run('G4') && state.g3) {
    const { page, id, user, copy, centre } = state.g3;
    const m = await groupedMove(page, user, id, copy, { x: 160, y: 70 });
    ok(m.pass, 'G4a', 'two-part MultiPolygon: one drag moved every part together, shapes, areas and spacing kept', m.text);
    await page.screenshot({ path: shot('G4-moved-2-parts.png') });
    state.g4 = { page, id, user, centre, parts: m.parts1, geometry: m.v.content.site.geometry };
    const d = await newDraftWithCopy(SITES.multi4, 'G4 أربعة أجزاء');
    await save(d.page);
    const g = (await viewOf(d.user, d.id)).content.site.geometry;
    const m4 = await groupedMove(d.page, d.user, d.id, g, { x: 160, y: 70 });
    ok(g.type === 'MultiPolygon' && partsOf(g).length === 4 && m4.pass, 'G4b', 'four-part MultiPolygon (ACC fixture): one drag moved all four parts together, shapes, areas and spacing kept', m4.text);
    await d.page.screenshot({ path: shot('G4-moved-4-parts.png') });
    await d.page.context().close();
  }

  // ---- G5: MultiPolygon vertex edit on part 2, save, reload ----------------------------------------------------------
  if (run('G5') && state.g4) {
    const { page, id, user, centre, parts } = state.g4;
    await page.getByRole('button', { name: 'تعديل الحدود' }).click();
    await page.locator('.rs-parts .chip', { hasText: 'الجزء 2' }).click();
    await page.waitForTimeout(400);
    const b = await box(page);
    const from = toScreen(parts[1][0][0], centre, b);
    // outwards, away from part 1 (the parts of site 05 are about 30 m apart)
    const away = toScreen(centroid(parts[0][0]), centre, b);
    const n = Math.hypot(from.x - away.x, from.y - away.y);
    await drag(page, from, { x: from.x + (35 * (from.x - away.x)) / n, y: from.y + (35 * (from.y - away.y)) / n }, 16);
    const live = await readout(page);
    await save(page);
    const v = await viewOf(user, id);
    const edited = partsOf(v.content.site.geometry);
    ok(same(edited[0], parts[0]) && !same(edited[1][0][0], parts[1][0][0]) && edited[1][0].slice(1).every((p, i) => same(p, parts[1][0][i + 1])) && live.includes('الجزء النشط: 2') && (await validity(page)) === 'الحدود صالحة' && v.content.site.shape === 'EDITED', 'G5a',
      'a vertex of part 2 moved; part 1 exactly unchanged; still valid; stored as EDITED', live);
    await page.screenshot({ path: shot('G5-vertex.png') });
    await reopen(page, id);
    await save(page);
    const again = await viewOf(user, id);
    ok(sameGeometry(again.content.site.geometry, v.content.site.geometry), 'G5b', 'after reload and reopening, the MultiPolygon is exactly the saved one');
    state.g5 = { page, id, user, geometry: v.content.site.geometry };
  }

  // ---- G8: undo / redo / reset over a grouped move and a vertex edit -------------------------------------------------
  if (run('G8')) {
    const d = await newDraftWithCopy(SITES.multi, 'G8 تراجع وإعادة');
    const page = d.page;
    await save(page);
    const C = (await viewOf(d.user, d.id)).content.site.geometry;
    const centre = anchorOf(partsOf(C));
    const b = await box(page);
    const from = toScreen(centroid(partsOf(C)[0][0]), centre, b);
    await drag(page, from, { x: from.x + 120, y: from.y - 60 });
    await save(page);
    const M = (await viewOf(d.user, d.id)).content.site.geometry;
    await page.getByRole('button', { name: 'تعديل الحدود' }).click();
    await page.locator('.rs-parts .chip', { hasText: 'الجزء 2' }).click();
    await page.waitForTimeout(300);
    const v2 = toScreen(partsOf(M)[1][0][2], centre, b);
    await drag(page, v2, { x: v2.x + 30, y: v2.y + 20 }, 12);
    await save(page);
    const E = (await viewOf(d.user, d.id)).content.site.geometry;
    const step = async (name) => {
      await page.getByRole('button', { name, exact: true }).click();
      await page.waitForTimeout(250);
      await save(page);
      return (await viewOf(d.user, d.id)).content.site.geometry;
    };
    const u1 = await step('تراجع');
    const u2 = await step('تراجع');
    const r1 = await step('إعادة');
    const r2 = await step('إعادة');
    const rs = await step('استعادة البداية');
    const u3 = await step('تراجع');
    ok(sameGeometry(u1, M) && sameGeometry(u2, C) && sameGeometry(r1, M) && sameGeometry(r2, E) && sameGeometry(rs, C) && sameGeometry(u3, E), 'G8',
      'initial → move → vertex → undo vertex → undo move → redo move → redo vertex → reset → undo: every state exactly as recorded', 'undo→moved, undo→initial, redo→moved, redo→edited, reset→initial, undo→edited');
    await page.context().close();
  }

  // ---- the approver's view, return and resubmission (revision history) ------------------------------------------------
  if (run('APPROVER') && state.g5) {
    const { page: rq, id, user, geometry } = state.g5;
    const areas = deployments(anchorOf(partsOf(geometry)));
    const cur = (await viewOf(user, id)).content;
    await (await as(user)).put(`/restationing-requests/${id}/content`, { ...cur, ...areas });
    const sub = await (await as(user)).post(`/restationing-requests/${id}/submit`, {});
    const first = sub.body.route?.find((s) => s.current);
    const approver = first ? deciderFor(first) : null;
    ok(sub.status === 200 && sub.body.state === 'UNDER_REVIEW' && !!approver, 'APPROVER-1', 'the edited two-part MultiPolygon with its deployment areas is submitted', `submit ${sub.status} ${sub.body.message ?? sub.body.state}; route ${(sub.body.route ?? []).map((s) => s.label).join(' ← ')}`);
    if (sub.status === 200 && approver) {
      const ap = await pageAs(approver);
      await ap.goto(`${BASE}/#restationing/${id}`);
      await ap.waitForSelector('.rs-summary', { timeout: 30000 });
      await ap.waitForTimeout(3000);
      await ap.screenshot({ path: shot('APPROVER-submitted.png') });
      const seen = await viewOf(approver, id);
      const sg = seen.content.site.geometry;
      const legend = await ap.locator('.rs-legend').textContent();
      const revisionsText = await ap.locator('summary', { hasText: 'الإرسالات' }).textContent();
      const rev1 = sqlJson(`select content->'site'->'geometry' as g from restationing_revision where request_id = '${id}' and n = 1`)[0]?.g;
      ok(sameGeometry(sg, geometry) && sg.type === 'MultiPolygon' && sg.coordinates.length === 2 && seen.revisions.length === 1 && revisionsText.includes('(1)') && legend.includes('الموقع المقترح') && sameGeometry(rev1, geometry), 'APPROVER-2',
        `the approver (${approver}) receives exactly the submitted geometry, held by revision 1`, `${sg.type}, ${sg.coordinates.length} parts; ${revisionsText.trim()}; revision 1 in the database holds the same geometry: ${sameGeometry(rev1, geometry)}`);
      const facts = (await ap.locator('.rs-facts').textContent()).replace(/\s+/g, ' ');
      ok(facts.includes('مضلع متعدد') && facts.includes('2 أجزاء') && facts.includes('#1'), 'APPROVER-3', 'the request page states the proposed site\'s type, part count and revision to the approver', facts.slice(0, 400));
      // returned for a change of the site; the requester moves it on the page and resubmits
      const ret = await (await as(approver)).post(`/restationing-requests/${id}/decision`, { decision: 'RETURN', reason: `حرّك حدود الموقع المقترح قليلاً (${DATA})` });
      ok(ret.status === 200 && ret.body.state === 'RETURNED_FOR_CHANGES', 'RETURN', 'returned for changes by the approver', `${ret.status} ${ret.body.state ?? ret.body.message}`);
      await reopen(rq, id);
      const parts = partsOf(geometry);
      const b = await box(rq);
      const centre = anchorOf(parts);
      const from = toScreen(centroid(parts[0][0]), centre, b);
      await drag(rq, from, { x: from.x + 50, y: from.y + 10 });
      await save(rq);
      const g2 = (await viewOf(user, id)).content.site.geometry;
      const re = await (await as(user)).post(`/restationing-requests/${id}/submit`, { reason: 'نقلت حدود الموقع كما طُلب' });
      const revs = sqlJson(`select n, content->'site'->'geometry' as g from restationing_revision where request_id = '${id}' order by n`);
      ok(re.status === 200 && re.body.state === 'UNDER_REVIEW' && re.body.revisions?.length === 2 && re.body.revisions[1].changed.includes('SITE')
        && revs.length === 2 && sameGeometry(revs[0].g, geometry) && sameGeometry(revs[1].g, g2) && !sameGeometry(revs[0].g, revs[1].g) && revs.every((x) => x.g.type === 'MultiPolygon' && x.g.coordinates.length === 2), 'RESUBMIT',
        'resubmitted: revision 2 holds the moved MultiPolygon and revision 1 still holds the first submitted one', `revisions ${revs.map((x) => `#${x.n} ${x.g.type} ${x.g.coordinates.length} parts`).join(', ')}; changed ${re.body.revisions?.[1]?.changed}; moved ${Math.round(dist(anchorOf(partsOf(revs[0].g)), anchorOf(partsOf(revs[1].g))))} m`);
      await ap.reload();
      await ap.waitForSelector('.rs-summary', { timeout: 30000 });
      await ap.waitForTimeout(2500);
      await ap.screenshot({ path: shot('APPROVER-resubmitted.png') });
      state.approved = { id, user, geometry: g2, areas, requestingUnit: re.body.requestingUnit };
      await ap.context().close();
    }
    await rq.context().close();
  }

  // ---- activation: the submitted geometry, the occupancy re-check, links untouched ---------------------------------
  if (run('ACTIVATION') && ACC && state.approved) {
    const { id, user, geometry, areas, requestingUnit } = state.approved;
    const tss2 = sql(`select id from organization where code = 'T-SS-2'`);
    const tss1 = sql(`select id from organization where code = 'T-SS-1'`);
    // B: another section, the same ground; approved while A is approved (nothing occupies the ground yet)
    const b = await (await as(user)).post('/restationing-requests', { requestingUnitId: requestingUnit.id, content: {
      kind: 'PERMANENT', scope: [tss2], site: { geometry, shape: 'DRAWN' }, ...areas, reason: `فحص الإشغال عند التفعيل — الأرض نفسها (${DATA})` } });
    requests.push({ scenario: 'ACTIVATION occupancy re-check (B)', id: b.body.id, user });
    const bSub = await (await as(user)).post(`/restationing-requests/${b.body.id}/submit`, {});
    const aStop = await approveAll(id, user);
    const bStop = bSub.status === 200 ? await approveAll(b.body.id, user) : `not submitted: ${bSub.status} ${bSub.body.message}`;
    ok(aStop === 'APPROVED_NOT_ACTIVATED' && bStop === 'APPROVED_NOT_ACTIVATED', 'ACTIVATION-1', 'A (the resubmitted request) and B (another section on the same ground) are fully approved', `A ${aStop}; B ${bStop}`);
    const fingerprint = () => sqlJson(`select
        (select count(*) from site_link) as links, (select md5(coalesce(string_agg(to_jsonb(l)::text, '|' order by l.id), '')) from site_link l) as links_md5,
        (select md5(string_agg(to_jsonb(x)::text, '|' order by x.id)) from org_stationing x where x.organization_id <> '${tss1}') as other_stationing_md5,
        (select md5(string_agg(to_jsonb(r)::text, '|' order by r.id)) from site_responsibility r) as responsibility_md5,
        (select v.version || ':' || md5(v.geojson::text) from site s join site_geometry_version v on v.site_id = s.id and v.version = s.geometry_version where s.code = '05') as site05`)[0];
    const before = fingerprint();
    const act = await (await as('t.facilities')).post(`/restationing-requests/${id}/activate`, {});
    const after = await viewOf(user, id);
    const reg = sqlJson(`select v.geometry_type, ST_NumGeometries(v.geom) as parts,
        ST_Equals(v.geom, ST_SetSRID(ST_GeomFromGeoJSON((rv.content->'site'->'geometry')::text), 4326)) as equals_revision,
        v.geojson as geojson, (select count(*) from org_stationing x where x.organization_id = '${tss1}' and x.site_id = r.site_id and x.valid_to is null) as stationed
        from restationing_request r join site s on s.id = r.site_id join site_geometry_version v on v.site_id = s.id and v.version = s.geometry_version
        join restationing_revision rv on rv.request_id = r.id and rv.n = (select max(n) from restationing_revision where request_id = r.id) where r.id = '${id}'`)[0];
    ok(act.status === 200 && after.state === 'ACTIVATED_PERMANENT' && reg?.geometry_type === 'MultiPolygon' && reg.parts === 2 && reg.equals_revision && sameGeometry(reg.geojson, geometry) && reg.stationed === 1, 'ACTIVATION-2',
      'activation registers the submitted MultiPolygon exactly (its own type, both parts) and stations the section there', `activate ${act.status}; state ${after.state}; site «${after.activation?.site?.name}»: ${reg?.geometry_type}, ${reg?.parts} parts, equal to the last revision: ${reg?.equals_revision}`);
    const bAct = await (await as('t.facilities')).post(`/restationing-requests/${b.body.id}/activate`, {});
    const bState = (await viewOf(user, b.body.id)).state;
    ok(bAct.status === 400 && (bAct.body.message ?? '').includes('تغيّر إشغال الأرض منذ الاعتماد') && bState === 'APPROVED_NOT_ACTIVATED', 'ACTIVATION-3',
      'occupancy is checked again at activation: B, approved on ground that is now occupied, is refused and not activated', `${bAct.status} ${bAct.body.message}; B stays ${bState}`);
    const end = fingerprint();
    ok(same(before, end), 'ACTIVATION-4', 'site links, responsibilities, the copied site 05 and every other unit\'s stationing are unchanged by the activation', `site links ${before.links} → ${end.links}; site 05 version ${before.site05.split(':')[0]} unchanged: ${before.site05 === end.site05}`);
  }

  // ---- performance: Polygon, two parts, four parts, 1,500 vertices ----------------------------------------------------
  if (run('PERF')) {
    for (const key of ['polygon', 'multi', 'multi4', 'dense']) {
      const label = SITES[key][3];
      const d = await newDraftWithCopy(SITES[key], 'أداء ' + label);
      const page = d.page;
      perf.push({ site: label, step: 'copy (click → copied site shown)', ms: d.copyMs });
      await save(page);
      const g = (await viewOf(d.user, d.id)).content.site.geometry;
      const parts = partsOf(g);
      const centre = anchorOf(parts);
      const b = await box(page);
      const from = toScreen(centroid(parts[0][0]), centre, b);
      perf.push({ site: label, step: 'grouped drag', ...(await drag(page, from, { x: from.x + 150, y: from.y + 50 }, 30)) });
      await save(page);
      const p1 = partsOf((await viewOf(d.user, d.id)).content.site.geometry);
      const kept = p1.length === parts.length && p1.every((pt, i) => Math.abs(ringArea(pt[0]) - ringArea(parts[i][0])) / ringArea(parts[i][0]) < TOL.areaRel);
      await page.getByRole('button', { name: 'تعديل الحدود' }).click();
      if (parts.length > 1) await page.locator('.rs-parts .chip', { hasText: 'الجزء 1' }).click();
      await page.waitForTimeout(400);
      const vtx = toScreen(p1[0][0][0], centre, b);
      const before = await readout(page);
      await armFeedback(page);
      perf.push({ site: label, step: 'vertex drag', ...(await drag(page, vtx, { x: vtx.x + 12, y: vtx.y + 12 }, 12)) });
      perf.push({ site: label, step: 'validation feedback after release (valid)', ms: await feedback(page) });
      const edited = (await readout(page)) !== before;
      await longTasks(page);
      perf.push({ site: label, step: 'undo', ms: await timedButton(page, 'تراجع') });
      perf.push({ site: label, step: 'redo', ms: await timedButton(page, 'إعادة') });
      // an invalid drop (the vertex across the opposite edge): the full rules run on release
      const moved = { x: vtx.x + 12, y: vtx.y + 12 };
      await armFeedback(page);
      perf.push({ site: label, step: 'invalid vertex drop', ...(await drag(page, moved, toScreen(acrossOpposite(p1[0][0], 0), centre, b), 12)) });
      perf.push({ site: label, step: 'validation feedback after release (invalid verdict)', ms: await feedback(page) });
      const invalid = (await validity(page)).startsWith('الحدود غير صالحة');
      perf.push({ site: label, step: 'undo of the invalid drop', ms: await timedButton(page, 'تراجع') });
      const validAgain = (await validity(page)) === 'الحدود صالحة';
      ok(kept && edited && invalid && validAgain && g.type === (key === 'multi' || key === 'multi4' ? 'MultiPolygon' : 'Polygon'), 'PERF-' + key,
        `${label}: copied, moved as one with areas kept, vertex edited, an invalid drop caught and undone`, `${parts.length} part(s), ${vertexCount(parts)} vertices`);
      await page.context().close();
    }
  }
} finally {
  ok(external.length === 0, 'NET', 'zero external requests from the page', external.slice(0, 3).join(' '));
  ok(consoleErrors.length === 0, 'CONSOLE', 'no console or page errors', consoleErrors.slice(0, 6).join(' | '));
  for (const p of perf) console.log(`PERF  ${p.site} · ${p.step}: ${p.ms} ms${p.steps ? ` (${p.steps} pointer moves, longest task ${p.longest} ms, ${p.longTasks} long tasks)` : ''}`);
  writeFileSync(new URL(ONLY ? `results-${[...ONLY].join('')}.json` : 'results.json', OUT), JSON.stringify({ ranAt: new Date().toISOString(), base: BASE, profile: ACC ? 'acceptance' : 'development', results, perf, requests }, null, 2));
  await browser.close();
  const failed = results.filter((r) => r.result === 'FAIL').length;
  console.log(`\n${failed === 0 ? 'Geometry editing acceptance PASSED' : failed + ' check(s) FAILED'} (${results.filter((r) => r.result === 'PASS').length} pass)`);
  process.exitCode = failed ? 1 : 0;
}
