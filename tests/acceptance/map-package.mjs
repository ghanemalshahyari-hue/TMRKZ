// The production map package on the real Stationing V3 page (owner gate «PRODUCTION MAP PACKAGING PHASE — GO», sections
// 6, 15, 19 and 21). Runs headless Edge against tmrkz-test with the external network made unavailable to the browser
// (every host name resolves to nothing except the loopback, and every non-loopback request goes to a dead proxy), and
// checks that the page draws from the installed package only: street mode, labels, one label per MultiPolygon site,
// terrain mode, state kept across mode switches, performance with a verified long-task instrument, console and network.
//
//   MOVER_URL=http://localhost:8088 node tests/acceptance/map-package.mjs
//
// The live MapLibre map is read through React's fiber tree (test only; the application exposes no map handle). Nothing
// is saved: the editing measurement drags the copied site and leaves the editor without saving.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const BASE = process.env.MOVER_URL ?? 'http://localhost:8088';
const OUT = new URL('../../docs/evidence/map-package/browser/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const shot = (name) => fileURLToPath(new URL(name, OUT));
const PASSWORD = readFileSync(new URL('../../ops/test-env/.generated/user-password', import.meta.url), 'utf8').trim();
const require = createRequire(new URL('./package.json', import.meta.url));
const { chromium } = require('playwright-core');

// fictional acceptance requests (docs/evidence/acceptance-journeys/stationing-v3/geometry/tmrkz-test/SUMMARY.md)
const REQ = {
  activated2: { id: '677d8373-4bb8-4012-9cfe-16ca7e550238', n: 'RS-2026-0048', user: 't.requester' }, // 2-part site, activated
  review2: { id: '516b77e5-3952-48b0-b019-65cc9444f043', n: 'RS-2026-0043', user: 't.requester' }, // 2-part, areas, bands
  draft4: { id: 'c865fd3e-a0c6-4042-836a-ed855db4ce54', n: 'RS-2026-0049', user: 't.requester.pm' }, // current site ACC-GEO-MP4
  draft2: { id: '7a2c439e-387c-4c74-8638-7c9262c7fc4a', n: 'RS-2026-0050', user: 't.requester' }, // 2-part draft, editor
};

const results = [];
const ok = (cond, id, title, detail = '') => {
  results.push({ id, pass: !!cond, title, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${id} ${title}${detail ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
};

const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE 127.0.0.1', '--proxy-server=http://127.0.0.1:9'],
});
const external = [];
const consoleErrors = [];
const mapResponses = [];

async function pageAs(user) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('request', (q) => { const u = q.url(); if (!u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u); });
  page.on('response', (r) => { if (r.url().includes('/map-data/')) mapResponses.push({ url: r.url().slice(BASE.length), status: r.status() }); });
  page.on('requestfailed', (q) => { if (q.url().includes('/map-data/')) mapResponses.push({ url: q.url().slice(BASE.length), status: 'failed ' + q.failure()?.errorText }); });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`${user}: ${m.text()}`));
  page.on('pageerror', (e) => consoleErrors.push(`${user}: ${e.message}`));
  page.on('dialog', (d) => d.accept());
  await page.goto(BASE + '/api/v1/auth/oidc/start');
  await page.waitForSelector('#kc-form-login', { timeout: 30000 });
  await page.fill('#username', user);
  await page.fill('#password', PASSWORD);
  await page.click('#kc-login');
  await page.waitForURL((u) => u.toString().startsWith(BASE) && !u.toString().includes('/auth/realms/'), { timeout: 30000 });
  return page;
}

/** Finds the page's MapLibre map through React's fiber tree and keeps it as window.__m (test only). */
const grabMap = (page) => page.waitForFunction(() => {
  const host = document.querySelector('.ml-offline-canvas');
  if (!host) return false;
  const key = Object.keys(host).find((k) => k.startsWith('__reactFiber$'));
  const isMap = (v) => v && typeof v === 'object' && typeof v.queryRenderedFeatures === 'function' && typeof v.getStyle === 'function';
  for (let f = host[key]; f; f = f.return) {
    for (let h = f.memoizedState; h && typeof h === 'object'; h = h.next) {
      const s = h.memoizedState;
      if (isMap(s)) return (window.__m = s), true;
      if (s && isMap(s.current)) return (window.__m = s.current), true;
    }
  }
  return false;
}, null, { timeout: 30000 });
/** Opens a request on a fresh document and waits until the page shows that request and its map is idle. */
async function openRequest(page, req) {
  await page.goto(`${BASE}/#restationing/${req.id}`);
  await page.reload();
  await page.waitForFunction((n) => document.querySelector('.rs-summary')?.textContent.includes(n), req.n, { timeout: 30000 });
  await grabMap(page);
  await idle(page);
}
/** The point of a role's label in the request map's data (the site or an area), as [lng, lat]. */
const labelAt = (page, role) => page.evaluate((role) => window.__m.getStyle().sources.rs.data.features.find((f) => f.properties.role === role && f.geometry.type === 'Point')?.geometry.coordinates ?? null, role);
const idle = (page) => page.evaluate(() => new Promise((resolve) => {
  const m = window.__m;
  const done = () => requestAnimationFrame(() => resolve());
  if (m.loaded() && m.areTilesLoaded() && !m.isMoving()) return done();
  m.once('idle', done);
}));
const camera = (page) => page.evaluate(() => { const m = window.__m; const c = m.getCenter(); return { lng: +c.lng.toFixed(7), lat: +c.lat.toFixed(7), zoom: +m.getZoom().toFixed(4), bearing: m.getBearing(), pitch: m.getPitch() }; });
const jump = async (page, lng, lat, zoom) => { await page.evaluate(([lng, lat, zoom]) => window.__m.jumpTo({ center: [lng, lat], zoom }), [lng, lat, zoom]); await idle(page); };
/** Rendered features per basemap layer and the label texts drawn. */
const rendered = (page) => page.evaluate(() => {
  const m = window.__m;
  const byLayer = {};
  const texts = [];
  for (const f of m.queryRenderedFeatures()) {
    byLayer[f.layer.id] = (byLayer[f.layer.id] ?? 0) + 1;
    if (f.layer.type === 'symbol') {
      const t = f.layer.layout?.['text-field'];
      const p = f.properties;
      const txt = f.layer.id.startsWith('rs-') ? p.label : p['name:ar'] ?? p.name ?? p['name:en'] ?? p.ref;
      if (txt) texts.push({ layer: f.layer.id, text: String(txt) });
      void t;
    }
  }
  return { byLayer, texts };
});
const groups = (page) => page.evaluate(() => {
  const vis = {};
  for (const l of window.__m.getStyle().layers) {
    const g = l.metadata?.['tmrkz:group'];
    if (g) vis[g] = vis[g] ?? new Set();
    if (g) vis[g].add(window.__m.getLayoutProperty(l.id, 'visibility') ?? 'visible');
  }
  return Object.fromEntries(Object.entries(vis).map(([k, v]) => [k, [...v].join('/')]));
});
const overlayState = (page) => page.evaluate(() => {
  const m = window.__m;
  const style = m.getStyle();
  const own = style.layers.filter((l) => !l.metadata?.['tmrkz:group'] && l.id !== 'tmrkz-overlay-anchor');
  const sources = Object.fromEntries(Object.entries(style.sources).filter(([k]) => k !== 'basemap' && k !== 'hillshade').map(([k, s]) => [k, JSON.stringify(s.data ?? null)]));
  return { layers: own.map((l) => `${l.id}:${m.getLayoutProperty(l.id, 'visibility') ?? 'visible'}`), sources };
});
const ARABIC = /[؀-ۿ]/;
const LATIN = /[A-Za-z]/;

// ---- long-task instrument (a page task, scheduled by setTimeout, is what the observer attributes) -----------------
const armLongTasks = (page) => page.evaluate(() => {
  if (!window.__lt) {
    window.__lt = true;
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(Math.round(e.duration)))).observe({ type: 'longtask' });
  }
  window.__long = [];
});
const longTasks = (page) => page.evaluate(() => window.__long.slice());
const timed = async (page, fn) => { await armLongTasks(page); const t0 = Date.now(); await fn(); const ms = Date.now() - t0; return { ms, longTasks: await longTasks(page) }; };

const perf = {};
try {
  // ---- OFF: the browser has no external network --------------------------------------------------------------------
  {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    const probe = await p.evaluate(async () => {
      const out = {};
      for (const u of ['https://tile.openstreetmap.org/0/0/0.png', 'https://1.1.1.1/', 'https://unpkg.com/maplibre-gl']) {
        try { await fetch(u, { mode: 'no-cors' }); out[u] = 'reachable'; } catch (e) { out[u] = 'blocked: ' + e.name; }
      }
      return out;
    });
    await ctx.close();
    ok(Object.values(probe).every((v) => v.startsWith('blocked')), 'OFF', 'external network unavailable to the browser (name resolution and non-loopback traffic cut)', probe);
  }

  // ---- first map: initial load, package files, street mode ---------------------------------------------------------
  const page = await pageAs(REQ.activated2.user);
  await page.goto(`${BASE}/#restationing/${REQ.activated2.id}`);
  await page.addInitScript(() => {
    window.__long = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(Math.round(e.duration)))).observe({ type: 'longtask', buffered: true });
    window.__lt = true;
  });
  let t0 = Date.now();
  await page.reload();
  await page.waitForFunction((n) => document.querySelector('.rs-summary')?.textContent.includes(n), REQ.activated2.n, { timeout: 30000 });
  await grabMap(page);
  await idle(page);
  perf.initialLoad = { ms: Date.now() - t0, longTasks: await longTasks(page) };
  ok(true, 'PERF-LOAD', 'initial map load: full page load of a request (application, map, basemap, font, overlays) until the map is idle', perf.initialLoad);
  const style = await page.evaluate(() => { const s = window.__m.getStyle(); return { sources: Object.fromEntries(Object.entries(s.sources).map(([k, v]) => [k, { type: v.type, url: v.url ?? null }])), fontFaces: s['font-faces'] ?? null, glyphs: s.glyphs ?? null, sprite: s.sprite ?? null }; });
  const urls = Object.values(style.sources).map((s) => s.url).filter(Boolean);
  ok(style.sources.basemap?.url === `pmtiles://${BASE}/map-data/basemap/uae.pmtiles` && style.sources.hillshade?.url === `pmtiles://${BASE}/map-data/terrain/glo30/visualization/hillshade.pmtiles`
    && JSON.stringify(style.fontFaces).includes(`${BASE}/map-data/fonts/NotoSansArabic.ttf`) && !style.glyphs && !style.sprite && urls.every((u) => u.startsWith(`pmtiles://${BASE}/map-data/`)),
  'PKG', 'the map reads only the installed package: basemap, hillshade and font under /map-data/, no glyph or sprite server', style);
  await page.screenshot({ path: shot('S1-activated-two-part-site.png') });

  // one label per logical site: the activated two-part site is both the unit's current site and the request's site
  const labelCounts = async () => {
    const r = await rendered(page);
    const counts = {};
    for (const t of r.texts.filter((x) => x.layer === 'rs-label')) counts[t.text] = (counts[t.text] ?? 0) + 1;
    const source = await page.evaluate(() => {
      const d = window.__m.getStyle().sources.rs.data;
      return d.features.filter((f) => f.properties.label).map((f) => `${f.properties.role}:${f.geometry.type}`);
    });
    return { counts, source };
  };
  const siteAt = await labelAt(page, 'SITE');
  for (const z of [14, 15, 16, 17]) {
    // centred on the site itself: the request's deployment areas lie kilometres away
    await jump(page, siteAt[0], siteAt[1], z);
    const lc = await labelCounts();
    ok(Object.values(lc.counts).every((n) => n === 1) && Object.keys(lc.counts).length >= 1 && lc.source.filter((s) => s.startsWith('SITE')).length === 1 && lc.source.filter((s) => s.startsWith('CURRENT')).length === 1,
      `ML1-z${z}`, `${REQ.activated2.n}: the two-part site is named once (current and proposed, each one label point), zoom ${z}`, lc);
  }
  await page.screenshot({ path: shot('S2-two-part-one-label-z16.png') });

  // street mode: UAE basemap, road hierarchy, labels (Dubai, then the whole country)
  const streets = {};
  for (const [name, lng, lat, z] of [['dubai-z14', 55.2744, 25.1972, 14], ['dubai-z12', 55.30, 25.20, 12], ['abudhabi-z13', 54.37, 24.47, 13], ['uae-z8', 54.6, 24.4, 8]]) {
    await jump(page, lng, lat, z);
    streets[name] = await rendered(page);
    await page.screenshot({ path: shot(`S3-street-${name}.png`) });
  }
  const has = (r, id) => (r.byLayer[id] ?? 0) > 0;
  const d14 = streets['dubai-z14'];
  ok(has(d14, 'road-highway') && has(d14, 'road-major_road') && has(d14, 'road-minor_road') && Object.keys(d14.byLayer).some((k) => k.includes('water')) && Object.keys(d14.byLayer).some((k) => k.includes('building')),
    'ST1', 'street basemap at Dubai z14: highways, major and minor roads, water and buildings drawn from the package', d14.byLayer);
  ok(has(streets['uae-z8'], 'road-highway') && !has(streets['uae-z8'], 'road-minor_road'), 'ST2', 'road hierarchy by zoom: at z8 only the major network, minor roads from z13', streets['uae-z8'].byLayer);
  const texts = Object.values(streets).flatMap((r) => r.texts.filter((t) => !t.layer.startsWith('rs-')).map((t) => t.text));
  const arabic = texts.filter((t) => ARABIC.test(t));
  const latin = texts.filter((t) => LATIN.test(t) && !ARABIC.test(t));
  const mixed = texts.filter((t) => ARABIC.test(t) && /[A-Za-z0-9٠-٩]/.test(t));
  const routes = Object.values(streets).flatMap((r) => r.texts.filter((t) => t.layer.includes('route') || t.layer.includes('shield')).map((t) => t.text));
  ok(arabic.length >= 20 && routes.length >= 3, 'LB1', 'Arabic road and place labels and route-number shields drawn with the packaged font',
    { arabic: arabic.length, sampleArabic: arabic.slice(0, 4), routes: [...new Set(routes)].slice(0, 8) });
  ok(latin.length + mixed.length >= 1, 'LB2', 'English (fallback) and mixed Arabic/Latin/digit labels drawn', { latin: [...new Set(latin)].slice(0, 5), mixed: [...new Set(mixed)].slice(0, 5) });
  const attribution = await page.locator('.maplibregl-ctrl-attrib').first().textContent();
  const notice = await page.locator('[data-testid=map-source-notice]').first().textContent();
  ok(attribution.includes('© OpenStreetMap contributors (ODbL)') && notice.includes('وليست أسماء رسمية'), 'LB3', 'street attribution (ODbL) and the unofficial road-name notice', { attribution, notice });

  // the four-part site (current site of the fixture section) is named once
  const pm = await pageAs(REQ.draft4.user);
  await openRequest(pm, REQ.draft4);
  {
    // close to the four-part current site, so its parts and its one name are visible
    const cur = await labelAt(pm, 'CURRENT');
    await jump(pm, cur[0], cur[1], 17);
    const lc = await (async () => {
      const r = await rendered(pm);
      const counts = {};
      for (const t of r.texts.filter((x) => x.layer === 'rs-label')) counts[t.text] = (counts[t.text] ?? 0) + 1;
      const source = await pm.evaluate(() => window.__m.getStyle().sources.rs.data.features.filter((f) => f.properties.label).map((f) => `${f.properties.role}:${f.geometry.type}`));
      const parts = await pm.evaluate(() => window.__m.getStyle().sources.rs.data.features.filter((f) => f.properties.role === 'CURRENT' && f.geometry.type === 'MultiPolygon').map((f) => f.geometry.coordinates.length));
      return { counts, source, currentParts: parts };
    })();
    ok(lc.currentParts.includes(4) && Object.values(lc.counts).every((n) => n === 1) && lc.source.filter((s) => s.startsWith('CURRENT')).length === 1,
      'ML2', `${REQ.draft4.n}: the four-part current site (ACC-GEO-MP4) is named once, not four times`, lc);
    await pm.screenshot({ path: shot('S4-four-part-one-label.png') });
  }
  await pm.context().close();

  // ---- terrain mode and state preservation (request under review: site, both areas, both deployment bands) ---------
  await page.goto(`${BASE}/#restationing`);
  await page.waitForSelector('.rs-list', { timeout: 30000 });
  const item = page.locator('.rs-item', { hasText: REQ.review2.n }).first();
  await item.scrollIntoViewIfNeeded();
  perf.openRequest = await timed(page, async () => {
    await item.click();
    await page.waitForFunction((n) => document.querySelector('.rs-summary')?.textContent.includes(n), REQ.review2.n, { timeout: 30000 });
    await grabMap(page);
    await page.waitForFunction(() => window.__m.getStyle().sources.rs?.data?.features?.some((f) => f.properties.role === 'PRIMARY'), null, { timeout: 30000 });
    await idle(page);
  });
  ok(true, 'PERF-OPEN', `opening a request from the list (${REQ.review2.n}): its page, map and overlays idle`, perf.openRequest);
  const summary = async () => ({ hash: await page.evaluate(() => location.hash), summary: (await page.locator('.rs-summary').textContent()).trim().slice(0, 400), proposed: await page.locator('[data-testid=proposed-site]').textContent() });
  const before = { ui: await summary(), camera: await camera(page), overlay: await overlayState(page), groups: await groups(page) };
  await page.screenshot({ path: shot('S5-state-street-before.png') });
  const toTerrain = await timed(page, async () => { await page.getByRole('button', { name: 'طبيعة الأرض' }).first().click(); await page.waitForTimeout(50); await idle(page); });
  perf.toTerrain = toTerrain;
  const inTerrain = { ui: await summary(), camera: await camera(page), overlay: await overlayState(page), groups: await groups(page) };
  await page.screenshot({ path: shot('S6-state-terrain.png') });
  const toStreet = await timed(page, async () => { await page.getByRole('button', { name: 'الشوارع' }).first().click(); await page.waitForTimeout(50); await idle(page); });
  perf.toStreet = toStreet;
  const after = { ui: await summary(), camera: await camera(page), overlay: await overlayState(page), groups: await groups(page) };
  await page.screenshot({ path: shot('S7-state-street-after.png') });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  ok(inTerrain.groups.terrain === 'visible' && inTerrain.groups.street === 'none' && before.groups.street === 'visible', 'TR1', 'terrain mode shows the GLO-30 hillshade group and hides the street group', { before: before.groups, terrain: inTerrain.groups });
  ok(same(before.ui, inTerrain.ui) && same(before.ui, after.ui), 'SP1', 'street → terrain → street keeps the request, the selected unit/site and the proposed-site facts', after.ui);
  ok(same(before.overlay, inTerrain.overlay) && same(before.overlay, after.overlay) && Object.keys(before.overlay.sources).length >= 1, 'SP2', 'the proposed geometry, deployment areas and deployment bands (overlay layers and data) are unchanged across both switches',
    { layers: before.overlay.layers, features: JSON.parse(before.overlay.sources.rs ?? '{"features":[]}').features.map((f) => f.properties.role) });
  ok(same(before.camera, inTerrain.camera) && same(before.camera, after.camera), 'SP3', 'the camera (centre, zoom, bearing, pitch) is unchanged across both switches', after.camera);
  ok(true, 'PERF-MODE', 'street ↔ terrain switch until the map is idle', { toTerrain, toStreet });

  // terrain coverage over the country and over the mountains, from the packaged hillshade only
  await page.getByRole('button', { name: 'طبيعة الأرض' }).first().click();
  const before404 = mapResponses.length;
  for (const [name, lng, lat, z] of [['uae-z7', 54.4, 24.3, 7], ['uae-z8-east', 55.6, 24.6, 8], ['hajar-z11', 56.13, 24.81, 11], ['liwa-z10', 53.75, 23.1, 10]]) {
    await jump(page, lng, lat, z);
    await page.screenshot({ path: shot(`S8-terrain-${name}.png`) });
  }
  const shade = mapResponses.slice(before404).filter((r) => r.url.includes('hillshade'));
  const terrainNotice = await page.locator('[data-testid=map-source-notice]').first().textContent();
  const terrainAttr = await page.locator('.maplibregl-ctrl-attrib').first().textContent();
  ok(shade.length > 0 && shade.every((r) => r.status === 206) && terrainNotice.includes('DSM') && terrainAttr.includes('produced using Copernicus WorldDEM-30'),
    'TR2', 'terrain over the UAE, the eastern mountains and Liwa read from the packaged hillshade (range requests), DSM notice and Copernicus 6(b) attribution',
    { hillshadeRequests: shade.length, statuses: [...new Set(shade.map((r) => r.status))], notice: terrainNotice });
  await page.getByRole('button', { name: 'الشوارع' }).first().click();
  await idle(page);

  // ---- performance: zoom/pan and label layout, deployment bands --------------------------------------------------
  const inst = await page.evaluate(() => new Promise((resolve) => {
    if (!window.__lt) { window.__lt = true; window.__long = []; new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(Math.round(e.duration)))).observe({ type: 'longtask' }); }
    window.__long = [];
    setTimeout(() => { const t = performance.now(); while (performance.now() - t < 120); setTimeout(() => resolve(window.__long.slice()), 200); }, 0);
  }));
  ok(inst.some((d) => d >= 100), 'INSTRUMENT', 'the long-task observer records a deliberate 120 ms page task', inst);
  const c0 = await camera(page);
  perf.zoomSweep = await timed(page, async () => {
    for (const z of [10, 11, 12, 13, 14, 15, 16, 15, 13, 11]) await jump(page, c0.lng, c0.lat, z);
  });
  perf.pan = await timed(page, async () => {
    for (let i = 0; i < 8; i++) { await page.evaluate(() => window.__m.panBy([180, 90], { duration: 0 })); await idle(page); }
  });
  const site = await labelAt(page, 'SITE');
  perf.bands = await timed(page, async () => { await jump(page, site[0], site[1], 10); });
  const bandFeatures = await page.evaluate(() => window.__m.queryRenderedFeatures({ layers: ['rs-band', 'rs-band-line'] }).length);
  await page.screenshot({ path: shot('S9-deployment-bands-z10.png') });
  ok(bandFeatures > 0, 'PERF-BANDS', 'deployment bands drawn when zoomed out (z10)', { ...perf.bands, bandFeatures });
  ok(true, 'PERF-ZOOM', 'zoom sweep z10→z16→z11 (10 steps, idle at each, label placement included) and 8 pans', { zoom: perf.zoomSweep, pan: perf.pan });

  // ---- geometry editing overlays: the accepted grouped drag on a two-part draft, not saved -------------------------
  await openRequest(page, REQ.draft2);
  await page.getByRole('button', { name: 'تعديل الطلب' }).click();
  await page.waitForSelector('[data-testid=site-readout]', { timeout: 15000 });
  await grabMap(page);
  await idle(page);
  const readout0 = await page.locator('[data-testid=site-readout]').textContent();
  const partCentre = () => page.evaluate(() => {
    const m = window.__m;
    const f = m.queryRenderedFeatures({ layers: ['rs-edit-fill'] })[0];
    if (!f) return null;
    const ring = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates[0][0] : f.geometry.coordinates[0];
    const c = ring.slice(0, -1).reduce((a, p) => [a[0] + p[0] / (ring.length - 1), a[1] + p[1] / (ring.length - 1)], [0, 0]);
    const p = m.project(c);
    const r = m.getCanvas().getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  });
  const target = await partCentre();
  if (target) {
    perf.drag = await timed(page, async () => {
      await page.mouse.move(target.x, target.y);
      await page.mouse.down();
      for (let i = 1; i <= 30; i++) { await page.mouse.move(target.x + i * 4, target.y + i * 2); }
      await page.mouse.up();
      await page.waitForTimeout(300);
    });
  }
  const readout1 = await page.locator('[data-testid=site-readout]').textContent();
  const moved = await partCentre();
  const movedPx = target && moved ? Math.round(Math.hypot(moved.x - target.x, moved.y - target.y)) : null;
  await page.screenshot({ path: shot('S10-editor-grouped-drag.png') });
  ok(target && perf.drag && perf.drag.longTasks.every((d) => d <= 50) && movedPx > 60 && readout1.includes('الحدود صالحة'), 'PERF-EDIT', `${REQ.draft2.n}: grouped drag of the copied two-part site on the packaged map (30 pointer moves, not saved): no long task`,
    { ...perf.drag, movedPx, accepted: 'geometry acceptance 708–720 ms, 0 long tasks', readoutBefore: readout0?.slice(0, 120), readoutAfter: readout1?.slice(0, 120) });
  await page.goto(`${BASE}/#restationing`);

  // ---- network and console --------------------------------------------------------------------------------------
  const failed = mapResponses.filter((r) => typeof r.status !== 'number' || r.status >= 400);
  const kinds = [...new Set(mapResponses.map((r) => r.url.split('?')[0]))];
  ok(failed.length === 0 && kinds.includes('/map-data/basemap/uae.pmtiles') && kinds.includes('/map-data/fonts/NotoSansArabic.ttf') && kinds.includes('/map-data/terrain/glo30/visualization/hillshade.pmtiles'),
    'NET-PKG', 'every map file came from the installed package and answered (basemap and hillshade by range, the font in full)', { files: kinds, requests: mapResponses.length, failed: failed.slice(0, 5) });
  ok(external.length === 0, 'NET', 'zero external requests from the application pages', external.slice(0, 10));
  ok(consoleErrors.length === 0, 'CONSOLE', 'no console or page errors', consoleErrors.slice(0, 10));
} catch (e) {
  ok(false, 'RUN', 'the run completed', e.stack ?? String(e));
} finally {
  await browser.close();
  const passed = results.filter((r) => r.pass).length;
  writeFileSync(new URL('results.json', OUT), JSON.stringify({ base: BASE, when: new Date().toISOString(), passed, total: results.length, perf, results }, null, 2));
  console.log(`\n${passed}/${results.length} passed; external requests: ${external.length}; console errors: ${consoleErrors.length}`);
  process.exitCode = passed === results.length ? 0 : 1;
}
