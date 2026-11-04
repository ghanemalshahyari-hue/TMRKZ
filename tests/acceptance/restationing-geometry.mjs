// Stationing V3 geometry editing (owner gate «GEOMETRY EDITING PHASE — GO», 4 Nov 2026) on the REAL page with the real
// Keycloak/LDAP sign-in: G1 Polygon grouped move, G2 Polygon vertex edit + reload, G3 MultiPolygon copied whole, G4
// MultiPolygon grouped move, G5 MultiPolygon vertex edit + reload, G6 invalid edit, G7 maximum area, G8 undo/redo/reset,
// G9 redraw by choice, the approver's view of a submitted MultiPolygon, and performance on a Polygon, two-part, four-part
// and dense site. Every geometry claim is checked against what the SERVER saved (GET /restationing-requests/{id}).
// Fictional data only. Drags are computed from the Web Mercator projection around the camera the editor opens on.
// Usage: MOVER_URL=http://localhost:8097 node tests/acceptance/restationing-geometry.mjs   (headless Edge)
//        ONLY=G1,G3,…  runs a subset (G2 needs G1, G5/G8 need G3)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const BASE = process.env.MOVER_URL ?? 'http://localhost:8097';
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const run = (k) => !ONLY || ONLY.has(k);
const OUT = new URL('../../docs/evidence/acceptance-journeys/stationing-v3/geometry/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const shot = (name) => fileURLToPath(new URL(name, OUT));
const PASSWORD = readFileSync(new URL('../../ops/test-env/.generated/user-password', import.meta.url), 'utf8').trim();
const require = createRequire(new URL('./package.json', import.meta.url));
const { chromium } = require('playwright-core');
const ZOOM = 15; // SiteEditor.ZOOM: the camera an editing session opens at, centred on the site's anchor

const results = [];
const perf = [];
const requests = [];
const ok = (cond, id, label, extra = '') => {
  results.push({ id, label, result: cond ? 'PASS' : 'FAIL', extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${id}  ${label}${extra ? '  — ' + extra : ''}`);
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- geometry, as the page computes it (lib/footprint, lib/siteGeometry) --------------------------------------------
const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const dist = (a, b) => {
  const s = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};
const ringOf = (c) => {
  const r = c.map(([lng, lat]) => ({ lat, lng }));
  return r.slice(0, -1);
};
const partsOf = (g) => (g.type === 'Polygon' ? [g.coordinates.map(ringOf)] : g.coordinates.map((p) => p.map(ringOf)));
const ringArea = (r) => {
  let t = 0;
  for (let i = 0; i < r.length; i++) {
    const p1 = r[i], p2 = r[(i + 1) % r.length], p3 = r[(i + 2) % r.length];
    t += (rad(p3.lng) - rad(p1.lng)) * Math.sin(rad(p2.lat));
  }
  return Math.abs((t * R * R) / 2);
};
const centroid = (r) => {
  let a = 0, x = 0, y = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length];
    const f = p.lng * q.lat - q.lng * p.lat;
    a += f; x += (p.lng + q.lng) * f; y += (p.lat + q.lat) * f;
  }
  return { lat: y / (3 * a), lng: x / (3 * a) };
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

// Web Mercator pixels (512-px tiles, as MapLibre) relative to the camera centre
const world = (z) => 512 * 2 ** z;
const merc = (p, z) => ({ x: ((p.lng + 180) / 360) * world(z), y: ((1 - Math.log(Math.tan(rad(p.lat)) + 1 / Math.cos(rad(p.lat))) / Math.PI) / 2) * world(z) });
const toScreen = (p, centre, box) => {
  const a = merc(p, ZOOM), c = merc(centre, ZOOM);
  return { x: box.x + box.width / 2 + (a.x - c.x), y: box.y + box.height / 2 + (a.y - c.y) };
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

const browser = await chromium.launch({ channel: 'msedge', headless: true });
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
  // long tasks while editing: the map must stay responsive
  await page.addInitScript(() => {
    window.__long = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ type: 'longtask', buffered: true });
  });
  return page;
}

// ---- the editor on the page ----------------------------------------------------------------------------------------
const toast = async (page, text, timeout = 15000) =>
  page.waitForFunction((t) => { const e = document.getElementById('toast'); return e && !e.hidden && e.textContent.includes(t) ? e.textContent : null; }, text, { timeout }).then((h) => h.jsonValue());
async function newDraftWithCopy(user, unitName, movingName, label) {
  const page = await pageAs(user);
  await page.goto(`${BASE}/#restationing`);
  await page.waitForSelector('.rs-list');
  await page.getByRole('button', { name: '＋ طلب إعادة تمركز' }).click();
  await page.locator('.rs-form select').first().selectOption({ label: unitName });
  await page.locator('.rs-check', { hasText: movingName }).first().locator('input').check();
  await page.locator('.rs-form textarea').first().fill(`تحرير الهندسة — ${label} (بيانات تطوير وهمية)`);
  const created = page.waitForResponse((r) => r.url().endsWith('/api/v1/restationing-requests') && r.request().method() === 'POST');
  const t0 = Date.now();
  await page.getByRole('button', { name: 'نسخ حدود الموقع الحالي' }).click();
  const id = (await (await created).json()).id;
  const message = await toast(page, 'نُسخت حدود');
  const copyMs = Date.now() - t0;
  await page.waitForSelector('[data-testid=site-readout]');
  await page.waitForTimeout(800);
  requests.push({ scenario: label, id, user });
  return { page, id, message, copyMs };
}
async function save(page) {
  const done = page.waitForResponse((r) => /\/api\/v1\/restationing-requests\/[^/]+\/checks$/.test(r.url()));
  await page.getByRole('button', { name: 'حفظ المسودة والفحص' }).click();
  await done;
  await page.waitForTimeout(600);
}
const viewOf = async (user, id) => (await (await as(user)).get('/restationing-requests/' + id)).body;
const checksOf = async (user, id) => (await (await as(user)).get(`/restationing-requests/${id}/checks`)).body;
const box = async (page) => page.locator('.rs-map-card canvas.maplibregl-canvas').first().boundingBox();
async function drag(page, from, to, steps = 24) {
  const t0 = await page.evaluate(() => { window.__long = []; return performance.now(); });
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

const state = {};

try {
  // ---- G1: Polygon — copy and grouped move ---------------------------------------------------------------------------
  if (run('G1')) {
    const d = await newDraftWithCopy('t.requester', 'الخدمات المشتركة', 'الخدمات المشتركة', 'G1 مضلع');
    await save(d.page);
    const v0 = await viewOf('t.requester', d.id);
    const current = v0.currentSites.find((s) => s.geometry?.type === 'Polygon');
    const copy = v0.content.site.geometry;
    ok(copy.type === 'Polygon' && same(copy, current.geometry) && v0.content.site.shape === 'COPY' && v0.content.site.copiedFrom === current.site.id, 'G1a', 'Polygon copied exactly (saved by the server)', `${d.message}; ${partsOf(copy)[0][0].length} vertices; shape ${v0.content.site.shape}, copied from the current site: ${v0.content.site.copiedFrom === current.site.id}`);
    const parts0 = partsOf(copy);
    const centre = anchorOf(parts0);
    const b = await box(d.page);
    const from = toScreen(centre, centre, b);
    const p = await drag(d.page, from, { x: from.x + 140, y: from.y - 90 });
    perf.push({ site: 'Polygon (4 vertices)', step: 'grouped drag', ...p });
    await save(d.page);
    const v1 = await viewOf('t.requester', d.id);
    const parts1 = partsOf(v1.content.site.geometry);
    const areaDiff = Math.abs(ringArea(parts1[0][0]) - ringArea(parts0[0][0])) / ringArea(parts0[0][0]);
    const edgeDiff = Math.max(...edges(parts1[0][0]).map((e, i) => Math.abs(e - edges(parts0[0][0])[i])));
    const movedM = dist(anchorOf(parts1), centre);
    const c1 = await checksOf('t.requester', d.id);
    ok(v1.content.site.geometry.type === 'Polygon' && parts1[0][0].length === parts0[0][0].length && areaDiff < 1e-3 && edgeDiff < 0.5 && movedM > 300 && !c1.problems.some((x) => x.startsWith('حدود الموقع المقترح')), 'G1b',
      'grouped drag: shape and area kept; the server accepts the saved geometry', `moved ${Math.round(movedM)} m; area Δ ${(areaDiff * 100).toFixed(4)} %; max edge Δ ${edgeDiff.toFixed(3)} m; server site area ${c1.siteAreaM2} m²`);
    await d.page.screenshot({ path: shot('G1-moved.png') });
    state.g1 = { ...d, centre, parts1, geometry: v1.content.site.geometry };
  }

  // ---- G2: Polygon — vertex edit, save, reload --------------------------------------------------------------------
  if (run('G2') && state.g1) {
    const { page, id, centre, parts1 } = state.g1;
    await page.getByRole('button', { name: 'تعديل الحدود' }).click();
    await page.waitForTimeout(500);
    const b = await box(page);
    const v = parts1[0][0][1];
    const from = toScreen(v, centre, b);
    const before = await readout(page);
    const t = await drag(page, from, { x: from.x + 40, y: from.y + 25 }, 16);
    perf.push({ site: 'Polygon (4 vertices)', step: 'vertex drag', ...t });
    const during = await readout(page);
    await save(page);
    const v2 = await viewOf('t.requester', id);
    const parts2 = partsOf(v2.content.site.geometry);
    const others = parts2[0][0].every((p, i) => i === 1 || same(p, parts1[0][0][i]));
    const c2 = await checksOf('t.requester', id);
    ok(!same(parts2[0][0][1], parts1[0][0][1]) && others && v2.content.site.shape === 'EDITED' && during !== before && (await validity(page)) === 'الحدود صالحة' && Math.abs(c2.siteAreaM2 - pageArea(during)) / c2.siteAreaM2 < 1e-3, 'G2a',
      'one vertex moved; area and validity update live; the page and the server agree on the area; stored as EDITED', `readout: ${during}; server area ${c2.siteAreaM2} m²`);
    await page.screenshot({ path: shot('G2-vertex.png') });
    // reload: the page, the request and the editor again — the saved geometry, exactly
    await page.goto(`${BASE}/#restationing/${id}`);
    await page.reload();
    await page.waitForSelector('.rs-summary', { timeout: 30000 });
    await page.getByRole('button', { name: 'تعديل الطلب' }).click();
    await page.waitForSelector('[data-testid=site-readout]', { timeout: 15000 });
    await page.waitForTimeout(800);
    await save(page);
    const v3 = await viewOf('t.requester', id);
    ok(same(v3.content.site.geometry, v2.content.site.geometry), 'G2b', 'after reload and reopening, the editor holds exactly the saved geometry (saved again unchanged)', await readout(page));
    // reopening started a new editing session: the camera is now centred on the saved geometry's anchor
    state.g2 = { page, id, centre: anchorOf(parts2), parts: parts2 };
  }

  // ---- G6: invalid edit — immediate warning, server refusal, no submission ------------------------------------------
  if (run('G6') && state.g2) {
    const { page, id, centre, parts } = state.g2;
    await page.getByRole('button', { name: 'تعديل الحدود' }).click();
    await page.waitForTimeout(400);
    const r = parts[0][0];
    const c = centroid(r);
    // vertex 3 (index 2) pulled to the far side of the edge between vertices 4 and 1: its edges cross that edge
    const mid = { lat: (r[3].lat + r[0].lat) / 2, lng: (r[3].lng + r[0].lng) / 2 };
    const target = { lat: 2 * mid.lat - c.lat, lng: 2 * mid.lng - c.lng };
    const b = await box(page);
    await drag(page, toScreen(r[2], centre, b), toScreen(target, centre, b), 16);
    const warn = await validity(page);
    const submitDisabled = await page.getByRole('button', { name: 'إرسال للاعتماد' }).isDisabled();
    await save(page);
    const ch = await checksOf('t.requester', id);
    const sub = await (await as('t.requester')).post(`/restationing-requests/${id}/submit`, {});
    ok(warn.startsWith('الحدود غير صالحة') && submitDisabled && ch.problems.some((x) => x.startsWith('حدود الموقع المقترح')) && sub.status === 400, 'G6',
      'a self-crossing edit: immediate warning, the page blocks submission, the server refuses it', `${warn}; server: ${ch.problems.find((x) => x.startsWith('حدود الموقع المقترح'))}; submit ${sub.status}`);
    await page.screenshot({ path: shot('G6-invalid.png') });
    await page.getByRole('button', { name: 'تراجع', exact: true }).click();
    await page.waitForTimeout(400);
    await save(page);
  }

  // ---- G7: maximum footprint — hard block ---------------------------------------------------------------------------
  if (run('G7') && state.g2) {
    const { page, id, centre, parts } = state.g2;
    const r = parts[0][0];
    const c = centroid(r);
    const target = { lat: c.lat + 5 * (r[2].lat - c.lat), lng: c.lng + 5 * (r[2].lng - c.lng) };
    const b = await box(page);
    await drag(page, toScreen(r[2], centre, b), toScreen(target, centre, b), 16);
    const warn = await validity(page);
    await save(page);
    const ch = await checksOf('t.requester', id);
    const sub = await (await as('t.requester')).post(`/restationing-requests/${id}/submit`, {});
    ok(warn.includes('المساحة تتجاوز الحد الأقصى المعتمد') && ch.problems.some((x) => x.includes('تتجاوز الحد الأقصى المعتمد')) && sub.status === 400, 'G7',
      'beyond the configured maximum footprint: shown immediately and refused by the server (hard block)', `${await readout(page)}; server: ${ch.problems.find((x) => x.includes('تتجاوز'))}; submit ${sub.status}`);
    await page.screenshot({ path: shot('G7-max-area.png') });
  }

  // ---- G9: redraw only by the requester's choice ---------------------------------------------------------------------
  if (run('G9')) {
    const d = await newDraftWithCopy('t.requester', 'الخدمات المشتركة', 'الخدمات المشتركة', 'G9 رسم جديد');
    await save(d.page);
    const copy = (await viewOf('t.requester', d.id)).content.site;
    d.page.__dialog = 'dismiss';
    await d.page.getByRole('button', { name: 'رسم حدود جديدة' }).click();
    await d.page.waitForTimeout(400);
    await save(d.page);
    const kept = (await viewOf('t.requester', d.id)).content.site;
    d.page.__dialog = 'accept';
    await d.page.getByRole('button', { name: 'رسم حدود جديدة' }).click();
    const told = await toast(d.page, 'أُلغيت الحدود السابقة بطلبك');
    const b = await box(d.page);
    await d.page.mouse.click(b.x + b.width / 2 + 200, b.y + b.height / 2);
    await toast(d.page, 'رُسمت حدود جديدة');
    await save(d.page);
    const drawn = (await viewOf('t.requester', d.id)).content.site;
    ok(same(kept.geometry, copy.geometry) && kept.shape === 'COPY' && drawn.shape === 'DRAWN' && drawn.copiedFrom == null && !same(drawn.geometry, copy.geometry), 'G9',
      '«رسم حدود جديدة»: declined, the copy stays; chosen, the copy is discarded with a message and a new shape is drawn', `${told.trim()}; copy ${copy.shape} → kept ${kept.shape} → ${drawn.shape}`);
    await d.page.context().close();
  }

  // ---- G3: MultiPolygon copied whole ---------------------------------------------------------------------------------
  if (run('G3')) {
    const d = await newDraftWithCopy('t.requester2', 'إدارة التقنية', 'إدارة التقنية', 'G3 متعدد الأجزاء');
    const banner = await d.page.locator('.rs-site-controls .rs-banner').first().textContent();
    await save(d.page);
    const v0 = await viewOf('t.requester2', d.id);
    const current = v0.currentSites.find((s) => s.geometry?.type === 'MultiPolygon');
    const copy = v0.content.site.geometry;
    ok(copy.type === 'MultiPolygon' && copy.coordinates.length === current.geometry.coordinates.length && same(copy, current.geometry) && banner.includes('كل أجزاء الموقع ستنتقل معاً'), 'G3',
      'MultiPolygon copied whole: every part, in order, same coordinates; «كل أجزاء الموقع ستنتقل معاً»', `${d.message}; ${copy.coordinates.length} parts; copy ${d.copyMs} ms`);
    perf.push({ site: 'MultiPolygon (2 parts)', step: 'copy', ms: d.copyMs });
    await d.page.screenshot({ path: shot('G3-copied.png') });
    state.g3 = { ...d, parts0: partsOf(copy), centre: anchorOf(partsOf(copy)), copy };
  }

  // ---- G4: MultiPolygon grouped move -----------------------------------------------------------------------------------
  if (run('G4') && state.g3) {
    const { page, id, parts0, centre } = state.g3;
    const b = await box(page);
    const from = toScreen(centroid(parts0[0][0]), centre, b);
    const p = await drag(page, from, { x: from.x + 160, y: from.y + 70 });
    perf.push({ site: 'MultiPolygon (2 parts)', step: 'grouped drag', ...p });
    await save(page);
    const v = await viewOf('t.requester2', id);
    const parts1 = partsOf(v.content.site.geometry);
    const areas = parts1.map((pt, i) => Math.abs(ringArea(pt[0]) - ringArea(parts0[i][0])) / ringArea(parts0[i][0]));
    const d0 = dist(centroid(parts0[0][0]), centroid(parts0[1][0]));
    const d1 = dist(centroid(parts1[0][0]), centroid(parts1[1][0]));
    const each = parts1.map((pt, i) => Math.round(dist(centroid(pt[0]), centroid(parts0[i][0]))));
    ok(v.content.site.geometry.type === 'MultiPolygon' && parts1.length === parts0.length && Math.max(...areas) < 1e-3 && Math.abs(d1 - d0) < 0.5 && Math.min(...each) > 300 && Math.abs(each[0] - each[1]) < 1, 'G4',
      'one drag moved every part together: areas, shapes and the distance between parts kept', `each part moved ${each.join(' / ')} m; part distance ${d0.toFixed(2)} → ${d1.toFixed(2)} m; max area Δ ${(Math.max(...areas) * 100).toFixed(4)} %`);
    await page.screenshot({ path: shot('G4-moved.png') });
    state.g4 = { page, id, centre, parts: parts1, geometry: v.content.site.geometry };
  }

  // ---- G5: MultiPolygon vertex edit on part 2, save, reload ----------------------------------------------------------
  if (run('G5') && state.g4) {
    const { page, id, centre, parts } = state.g4;
    await page.getByRole('button', { name: 'تعديل الحدود' }).click();
    await page.locator('.rs-parts .chip', { hasText: 'الجزء 2' }).click();
    await page.waitForTimeout(400);
    const b = await box(page);
    const from = toScreen(parts[1][0][0], centre, b);
    const t = await drag(page, from, { x: from.x - 30, y: from.y + 30 }, 16);
    perf.push({ site: 'MultiPolygon (2 parts)', step: 'vertex drag', ...t });
    const live = await readout(page);
    await save(page);
    const v = await viewOf('t.requester2', id);
    const edited = partsOf(v.content.site.geometry);
    ok(same(edited[0], parts[0]) && !same(edited[1][0][0], parts[1][0][0]) && edited[1][0].slice(1).every((p, i) => same(p, parts[1][0][i + 1])) && live.includes('الجزء النشط: 2'), 'G5a',
      'a vertex of part 2 moved; part 1 exactly unchanged', live);
    await page.screenshot({ path: shot('G5-vertex.png') });
    await page.reload();
    await page.waitForSelector('.rs-summary', { timeout: 30000 });
    await page.getByRole('button', { name: 'تعديل الطلب' }).click();
    await page.waitForSelector('[data-testid=site-readout]', { timeout: 15000 });
    await page.waitForTimeout(800);
    await save(page);
    const again = await viewOf('t.requester2', id);
    ok(same(again.content.site.geometry, v.content.site.geometry), 'G5b', 'after reload and reopening, the MultiPolygon is exactly the saved one');
    state.g5 = { page, id, geometry: v.content.site.geometry, centre: anchorOf(edited) };
  }

  // ---- G8: undo / redo / reset over a grouped move and a vertex edit -------------------------------------------------
  if (run('G8')) {
    const d = await newDraftWithCopy('t.requester2', 'إدارة التقنية', 'إدارة التقنية', 'G8 تراجع وإعادة');
    const page = d.page;
    await save(page);
    const C = (await viewOf('t.requester2', d.id)).content.site.geometry;
    const centre = anchorOf(partsOf(C));
    const b = await box(page);
    const from = toScreen(centroid(partsOf(C)[0][0]), centre, b);
    await drag(page, from, { x: from.x + 120, y: from.y - 60 });
    await save(page);
    const M = (await viewOf('t.requester2', d.id)).content.site.geometry;
    await page.getByRole('button', { name: 'تعديل الحدود' }).click();
    await page.locator('.rs-parts .chip', { hasText: 'الجزء 2' }).click();
    await page.waitForTimeout(300);
    await drag(page, toScreen(partsOf(M)[1][0][2], centre, b), { x: toScreen(partsOf(M)[1][0][2], centre, b).x + 30, y: toScreen(partsOf(M)[1][0][2], centre, b).y + 20 }, 12);
    await save(page);
    const E = (await viewOf('t.requester2', d.id)).content.site.geometry;
    const step = async (name) => {
      const t0 = Date.now();
      await page.getByRole('button', { name, exact: true }).click();
      await page.waitForTimeout(250);
      perf.push({ site: 'MultiPolygon (2 parts)', step: name, ms: Date.now() - t0 - 250 });
      await save(page);
      return (await viewOf('t.requester2', d.id)).content.site.geometry;
    };
    const u1 = await step('تراجع');
    const u2 = await step('تراجع');
    const r1 = await step('إعادة');
    const r2 = await step('إعادة');
    const rs = await step('استعادة البداية');
    const u3 = await step('تراجع');
    ok(same(u1, M) && same(u2, C) && same(r1, M) && same(r2, E) && same(rs, C) && same(u3, E), 'G8',
      'copy → move → edit part 2 → undo → undo → redo → redo → reset → undo: every state exactly as recorded', 'undo→M, undo→copy, redo→M, redo→edited, reset→copy, undo→edited');
    await page.context().close();
  }

  // ---- the approver sees the submitted MultiPolygon -----------------------------------------------------------------
  if (run('APPROVER') && state.g5) {
    const { id, geometry } = state.g5;
    const a = anchorOf(partsOf(geometry));
    const mLng = 111_320 * Math.cos(rad(a.lat));
    const sq = (lat, lng, h) => ({ type: 'Polygon', coordinates: [[[lng - h / mLng, lat - h / 110_900], [lng + h / mLng, lat - h / 110_900], [lng + h / mLng, lat + h / 110_900], [lng - h / mLng, lat + h / 110_900], [lng - h / mLng, lat - h / 110_900]]] });
    const pr = { lat: a.lat, lng: a.lng + 6200 / mLng };
    const al = { lat: pr.lat - 4000 / 110_900, lng: pr.lng };
    const cur = (await viewOf('t.requester2', id)).content;
    await (await as('t.requester2')).put(`/restationing-requests/${id}/content`, { ...cur, primary: sq(pr.lat, pr.lng, 250), alternative: sq(al.lat, al.lng, 250) });
    const sub = await (await as('t.requester2')).post(`/restationing-requests/${id}/submit`, {});
    const approver = await pageAs('t.manager.it');
    await approver.goto(`${BASE}/#restationing/${id}`);
    await approver.waitForSelector('.rs-summary', { timeout: 30000 });
    await approver.waitForTimeout(3000);
    await approver.screenshot({ path: shot('APPROVER-multipolygon.png') });
    const seen = (await viewOf('t.manager.it', id)).content.site.geometry;
    const legend = await approver.locator('.rs-legend').textContent();
    ok(sub.status === 200 && same(seen, geometry) && sub.body.revisions?.at(-1) && legend.includes('الموقع المقترح'), 'APPROVER',
      'the approver sees the submitted MultiPolygon (the revision holds it)', `submit ${sub.status} ${sub.body.message ?? ''}; ${seen.coordinates?.length} parts`);
    await approver.context().close();
  }

  // ---- performance on several-part and dense sites -----------------------------------------------------------------
  if (run('PERF')) {
    for (const [unit, label] of [['وحدة الصيانة الإدارية', 'MultiPolygon (4 parts)'], ['فريق مرافق الشمال', 'dense Polygon (1,500 vertices)']]) {
      const d = await newDraftWithCopy('t.manager.ga', 'قسم مشاريع المباني', unit, 'أداء ' + label);
      perf.push({ site: label, step: 'copy', ms: d.copyMs });
      await save(d.page);
      const g = (await viewOf('t.manager.ga', d.id)).content.site.geometry;
      const parts = partsOf(g);
      const centre = anchorOf(parts);
      const b = await box(d.page);
      const from = toScreen(centroid(parts[0][0]), centre, b);
      perf.push({ site: label, step: 'grouped drag', ...(await drag(d.page, from, { x: from.x + 150, y: from.y + 50 }, 30)) });
      await save(d.page);
      const g1 = (await viewOf('t.manager.ga', d.id)).content.site.geometry;
      const p1 = partsOf(g1);
      const kept = p1.every((pt, i) => Math.abs(ringArea(pt[0]) - ringArea(parts[i][0])) / ringArea(parts[i][0]) < 1e-3) && p1.length === parts.length;
      await d.page.getByRole('button', { name: 'تعديل الحدود' }).click();
      await d.page.waitForTimeout(400);
      const vtx = toScreen(p1[0][0][0], centre, b);
      const t0 = Date.now();
      perf.push({ site: label, step: 'vertex drag', ...(await drag(d.page, vtx, { x: vtx.x + 12, y: vtx.y + 12 }, 12)) });
      await d.page.waitForFunction(() => document.querySelector('[data-testid=site-validity]')?.textContent.length > 0);
      perf.push({ site: label, step: 'validation refresh (vertex drop → verdict)', ms: Date.now() - t0 });
      const t1 = Date.now();
      await d.page.getByRole('button', { name: 'تراجع', exact: true }).click();
      await d.page.waitForTimeout(100);
      perf.push({ site: label, step: 'undo', ms: Date.now() - t1 - 100 });
      ok(kept && g1.type === g.type, 'PERF-' + label, `${label}: copied, moved as one, areas kept`, `${parts.length} part(s), ${parts.reduce((s, p) => s + p[0].length, 0)} vertices`);
      await d.page.context().close();
    }
  }
} finally {
  ok(external.length === 0, 'NET', 'zero external requests from the page', external.slice(0, 3).join(' '));
  ok(consoleErrors.length === 0, 'CONSOLE', 'no console or page errors', consoleErrors.slice(0, 6).join(' | '));
  for (const p of perf) console.log(`PERF  ${p.site} · ${p.step}: ${p.ms} ms${p.steps ? ` (${p.steps} pointer moves, longest task ${p.longest} ms, ${p.longTasks} long tasks)` : ''}`);
  writeFileSync(new URL(ONLY ? `results-${[...ONLY].join('')}.json` : 'results.json', OUT), JSON.stringify({ ranAt: new Date().toISOString(), base: BASE, results, perf, requests }, null, 2));
  await browser.close();
  const failed = results.filter((r) => r.result === 'FAIL').length;
  console.log(`\n${failed === 0 ? 'Geometry editing acceptance PASSED' : failed + ' check(s) FAILED'} (${results.filter((r) => r.result === 'PASS').length} pass)`);
  process.exitCode = failed ? 1 : 0;
}
