// «الانحدار» INSIDE the shapes being placed (owner, 6 Nov 2026), on the REAL page in a real browser, every request outside the
// application's own origins blocked and counted. A NEW fictional request, never saved:
//   the site is placed on the mountain, then dragged onto the plain with the pointer. The green, orange and red zones must
//   lie only inside the shape, change during the drag (before the drop), and turn green on the plain; no whole-map slope
//   layer exists; the deployment area being placed is coloured too, and the current site never; nothing is written.
//
//   node tests/acceptance/slope-inside.mjs
//     UI_URL (default http://localhost:5197, the dev server against tmrkz-v3dev), AUTH_URL (http://localhost:8097),
//     BROWSER_PATH (a Chrome or Edge executable; default: the installed Edge channel), OUT (evidence folder).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { toNewSiteStep, toScreen } from './geometry-helpers.mjs';

const UI = process.env.UI_URL ?? 'http://localhost:5197';
const AUTH = process.env.AUTH_URL ?? 'http://localhost:8097';
const DB = process.env.DB_CONTAINER ?? 'tmrkz-v3dev-db-1';
const OUT = process.env.OUT ?? fileURLToPath(new URL('../../docs/evidence/terrain-3d/slope-inside/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const PASSWORD = readFileSync(new URL('../../ops/test-env/.generated/user-password', import.meta.url), 'utf8').trim();
const { chromium } = createRequire(new URL('./package.json', import.meta.url))('playwright-core');
const SIZE = { width: 1680, height: 1000 };
const MAP = '.tz-mapframe .tz-map-layer';
// the same fictional points as terrain-3d.mjs: real GLO-30 relief, ops/test-env/dev-3d-terrain-seed.sql
const P = { mountain: { lat: 24.77, lng: 56.075 }, plain: { lat: 24.84, lng: 56.045 } };

const results = [];
const ok = (pass, id, what, detail = '') => {
  results.push({ id, pass: !!pass, what, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} — ${what}${detail ? ' · ' + detail : ''}`);
};
const external = [];
const consoleErrors = [];
const writes = [];
const sql = (q) => execFileSync('docker', ['exec', DB, 'psql', '-X', '-q', '-U', 'mover', '-d', 'mover', '-At', '-c', 'set default_transaction_read_only = on', '-c', q], { encoding: 'utf8' }).trim();
const rowCounts = () => sql("select (select count(*) from restationing_request) || '/' || (select count(*) from restationing_revision) || '/' || (select count(*) from org_stationing)");

const launch = process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : { channel: 'msedge' };
const browser = await chromium.launch({ ...launch, headless: true, args: ['--use-angle=metal', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: SIZE });
const page = await ctx.newPage();
await ctx.route('**/*', (route) => {
  const u = route.request().url();
  if (u.startsWith(UI) || u.startsWith(AUTH) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
  external.push(u);
  return route.abort();
});
page.on('request', (q) => {
  if (q.method() !== 'GET' && !q.url().endsWith('/api/v1/stationing/terrain/assess') && !q.url().includes('/auth/')) writes.push(`${q.method()} ${q.url()}`);
});
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(e.message));

const settle = async (ms = 700) => {
  await page.waitForTimeout(ms);
  await page.waitForFunction((s) => { const m = document.querySelector(s)?.tmrkzMap; return !!m && m.loaded() && m.areTilesLoaded() && !m.isMoving(); }, MAP, { timeout: 45000 }).catch(() => undefined);
  await page.waitForTimeout(300);
};
const control = () => page.locator('[data-testid=slope-control]').evaluate((e) => ({
  tone: e.dataset.tone,
  live: e.dataset.live,
  verdict: e.querySelector('[data-testid=slope-verdict]')?.innerText ?? '',
  ok: e.querySelector('[data-testid=slope-share-ok]')?.innerText ?? '',
  care: e.querySelector('[data-testid=slope-share-care]')?.innerText ?? '',
  risk: e.querySelector('[data-testid=slope-share-risk]')?.innerText ?? '',
}));
const panelClass = () => page.locator('[data-testid=terrain-panel]').evaluate((e) => ({ pending: e.dataset.pending, cls: e.dataset.class }));
/** The shape and the zones as the map holds them: every zone rectangle's centre must be inside the shape. */
const zones = () => page.evaluate((s) => {
  const m = document.querySelector(s).tmrkzMap;
  const zs = m.getSource('rs-slope-zones').serialize().data;
  const shape = m.getSource('rs-edit').serialize().data.features.flatMap((f) => f.geometry.coordinates);
  const inRing = (x, y, r) => {
    let c = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) if (r[i][1] > y !== r[j][1] > y && x < ((r[j][0] - r[i][0]) * (y - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
    return c;
  };
  let rects = 0;
  let outside = 0;
  const tones = {};
  for (const f of zs.features) {
    tones[f.properties.tone] = f.geometry.coordinates.length;
    for (const [ring] of f.geometry.coordinates) {
      rects++;
      const [xs, ys] = [ring.map((c) => c[0]), ring.map((c) => c[1])];
      const [x, y] = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
      if (!shape.some((ring2) => inRing(x, y, ring2))) outside++;
    }
  }
  return { rects, outside, tones, painted: m.queryRenderedFeatures({ layers: ['rs-slope-zones'] }).length };
}, MAP);
const fp = (z) => JSON.stringify(z.tones);

// ---- sign in, the fictional data, nothing saved ------------------------------------------------------------------
await page.goto(`${AUTH}/api/v1/auth/oidc/start`);
await page.waitForSelector('#kc-form-login', { timeout: 30000 });
await page.fill('#username', 't.requester');
await page.fill('#password', PASSWORD);
await page.click('#kc-login');
await page.waitForURL((u) => u.toString().startsWith(AUTH) && !u.toString().includes('/auth/realms/'), { timeout: 30000 });
await page.goto(UI + '/');
const current = await page.evaluate(async () => (await fetch('/api/v1/stationing/current')).json());
const rec = current.find((c) => c.siteName === 'موقع السهل الغربي (وهمي)');
if (!rec) throw new Error('fictional current site not found: run ops/test-env/dev-3d-terrain-seed.sql');
const counts0 = rowCounts();

await toNewSiteStep(page, UI, rec.siteId, rec.orgName);
await settle(1500);
const legend = await page.locator('[data-testid=slope-control]').evaluate((e) => ({ on: e.dataset.on, rows: e.querySelectorAll('li').length, text: e.innerText }));
ok(legend.on === 'true' && legend.rows === 3 && /مناسب/.test(legend.text) && /بحذر/.test(legend.text) && /مرتفع أو منخفض شديد/.test(legend.text),
  'S01', 'on by default on the new-site step: three colours and what each means', legend.text.replace(/\s+/g, ' '));
const whole = await page.evaluate((s) => { const m = document.querySelector(s).tmrkzMap; return { old: !!m.getLayer('terrain3d-slope'), rasters: m.getStyle().layers.filter((l) => /slope/.test(l.id) && l.type === 'raster').length, order: m.getStyle().layers.map((l) => l.id) }; }, MAP);
ok(!whole.old && whole.rasters === 0, 'S02', 'no slope colouring over the whole map any more');
const iz = whole.order.indexOf('rs-slope-zones');
ok(iz >= 0 && iz < whole.order.indexOf('rs-line') && iz < whole.order.indexOf('rs-edit-line'), 'S03', 'the zones lie under the outlines');

await page.locator('[data-testid=view-switch] button', { hasText: '3D' }).click();
await settle(2500);
const zoomOut = async (n) => { for (let i = 0; i < n; i++) { await page.getByRole('button', { name: 'تصغير' }).click(); await settle(400); } };
for (let i = 0; i < 4; i++) { await page.getByRole('button', { name: 'تصغير' }).click(); await settle(400); }
await page.getByRole('button', { name: 'تحديد الموقع على الخريطة' }).click();
const m0 = await toScreen(page, [P.mountain.lng, P.mountain.lat]);
await page.mouse.move(m0.x, m0.y, { steps: 10 });
await page.waitForTimeout(200);
await page.mouse.click(m0.x, m0.y);
await settle(2500);
await page.waitForFunction(() => document.querySelector('[data-testid=terrain-panel]')?.dataset.pending === 'false', null, { timeout: 30000 }).catch(() => undefined);
await settle(800);
const onMountain = { zones: await zones(), control: await control(), server: await panelClass() };
await page.screenshot({ path: OUT + 'A-3d-on-mountain.png' });
// close up: the card frames the site over its ground, and the colours can be read inside the boundary
await page.locator('.tz3-card.r-SITE').click();
await settle(2500);
await page.screenshot({ path: OUT + 'A2-3d-on-mountain-close.png' });
ok(onMountain.zones.rects > 20 && onMountain.zones.outside === 0 && onMountain.zones.painted > 0, 'S04', 'on the mountain: the colours are drawn in 3D, and only inside the shape', `${onMountain.zones.rects} runs, ${onMountain.zones.outside} outside, ${onMountain.zones.painted} painted`);
ok(onMountain.server.cls === 'MOUNTAINOUS' && onMountain.control.tone === 'risk' && onMountain.control.live === 'false' && /مسموح مع الحذر من الانحدار/.test(onMountain.control.verdict) && onMountain.zones.tones.risk > 0,
  'S05', 'on the mountain: red, «allowed, with care for the slope»; the server also classes it mountainous', `${onMountain.server.cls}; ${JSON.stringify(onMountain.control)}`);

await zoomOut(2);
// ---- the drag: from the mountain onto the plain, read mid-way with the button still down ---------------------------
const from = await toScreen(page, [P.mountain.lng, P.mountain.lat]);
const to = await toScreen(page, [P.plain.lng, P.plain.lat]);
await page.mouse.move(from.x, from.y, { steps: 8 });
await page.waitForTimeout(200);
await page.mouse.down();
const tones = new Set();
const seen = [];
const STEPS = 24;
const frames = [];
for (let i = 1; i <= STEPS; i++) {
  await page.mouse.move(from.x + ((to.x - from.x) * i) / STEPS, from.y + ((to.y - from.y) * i) / STEPS);
  await page.waitForTimeout(90);
  const c = await control();
  tones.add(c.tone);
  seen.push(c.tone);
  frames.push(fp(await zones()));
  if (i === Math.round(STEPS * 0.5)) await page.screenshot({ path: OUT + 'B-3d-during-drag.png' });
}
const midLive = await control();
const changedDuring = new Set(frames).size;
ok(midLive.live === 'true' && changedDuring >= 3, 'S06', 'during the drag, before the drop, the colours change on the way', `${changedDuring} different mixes; verdicts ${seen.join(' ')}`);
await page.mouse.up();
await settle(2500);
await page.waitForFunction(() => document.querySelector('[data-testid=terrain-panel]')?.dataset.pending === 'false', null, { timeout: 30000 }).catch(() => undefined);
await settle(800);
const onPlain = { zones: await zones(), control: await control(), server: await panelClass() };
await page.screenshot({ path: OUT + 'C-3d-on-plain.png' });
ok(onPlain.control.tone === 'ok' && onPlain.control.live === 'false' && /مناسب للتمركز/.test(onPlain.control.verdict) && ['FLAT', 'UNDULATING'].includes(onPlain.server.cls) && onPlain.zones.outside === 0,
  'S07', 'dropped on the plain: green, «suitable»; the server also classes it flat or undulating', `${onPlain.server.cls}; ${JSON.stringify(onPlain.control)}; ${JSON.stringify(onPlain.zones.tones)}`);
const moved = onPlain.server.cls !== onMountain.server.cls;
ok(moved, 'S08', 'the colour follows the ground, not a fixed value', `${onMountain.control.tone} → ${onPlain.control.tone}`);

// ---- the same in 2D, the switch, and drawing a new boundary --------------------------------------------------------
await page.locator('[data-testid=view-switch] button', { hasText: '2D' }).click();
await settle(1800);
await page.getByRole('button', { name: 'الموقع المقترح' }).click();
await settle(1500);
const flat = await zones();
await page.screenshot({ path: OUT + 'D-2d-on-plain.png' });
ok(flat.rects > 0 && flat.outside === 0 && flat.painted > 0, 'S09', 'the same colours in 2D', `${flat.rects} runs`);

await page.locator('[data-testid=slope-control] button').click();
await settle(500);
const off = await page.evaluate((s) => { const m = document.querySelector(s).tmrkzMap; return { layer: !!m.getLayer('rs-slope-zones'), opacity: m.getPaintProperty('rs-edit-fill', 'fill-opacity') }; }, MAP);
ok(!off.layer && off.opacity === 0.32, 'S10', 'switched off: the colours are gone and the site has its own tint back');
await page.locator('[data-testid=slope-control] button').click();
await settle(700);
const on = await zones();
ok(on.rects > 0 && on.outside === 0, 'S11', 'switched on again: the colours return for the shape where it is');

// a new boundary around the mountain flank: the colours appear as it encloses ground, before it is closed
await page.locator('[data-testid=view-switch] button', { hasText: '3D' }).click();
await settle(2200);
await page.getByRole('tab', { name: /رسم حدود جديدة/ }).click();
await settle(500);
const box = await page.locator(MAP).boundingBox();
const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
const corners = [[-90, -60], [90, -60], [90, 60]];
for (const [dx, dy] of corners) {
  await page.mouse.move(c.x + dx, c.y + dy, { steps: 6 });
  await page.waitForTimeout(150);
  await page.mouse.click(c.x + dx, c.y + dy);
  await page.waitForTimeout(250);
}
await page.mouse.move(c.x - 90, c.y + 60, { steps: 6 });
await settle(900);
const drawing = await page.evaluate((s) => document.querySelector(s).tmrkzMap.getSource('rs-slope-zones').serialize().data.features.length, MAP);
const drawControl = await control();
await page.screenshot({ path: OUT + 'E-3d-while-drawing.png' });
ok(drawing > 0 && drawControl.tone !== '', 'S12', 'while a new boundary is being drawn, the colours show inside it before it closes', JSON.stringify(drawControl));

// ---- a deployment area being placed is coloured as well; the current site stays plain ----------------------------------
await page.keyboard.press('Escape');
await settle(500);
await page.getByRole('tab', { name: /نقل الحدود الحالية/ }).click();
await settle(900);
const beforeArea = await page.locator('[data-testid=slope-control]').evaluate((e) => e.dataset.shape);
await page.getByRole('button', { name: 'الخطوة 5: الانتشار' }).click();
await page.waitForSelector('[data-testid=area-controls]', { timeout: 20000 });
await settle(1500);
await page.getByRole('button', { name: 'تحديد المنطقة على الخريطة' }).click();
await settle(600);
const free = await page.evaluate((s) => {
  const m = document.querySelector(s).tmrkzMap;
  const r = m.getCanvas().getBoundingClientRect();
  for (const [fx, fy] of [[0.55, 0.75], [0.7, 0.7], [0.4, 0.8], [0.6, 0.6]]) {
    const [x, y] = [r.left + r.width * fx, r.top + r.height * fy];
    if (document.elementFromPoint(x, y)?.classList.contains('maplibregl-canvas')) return { x, y };
  }
  return null;
}, MAP);
await page.mouse.move(free.x, free.y, { steps: 8 });
await page.waitForTimeout(200);
await page.mouse.click(free.x, free.y);
await settle(2200);
const area = await page.locator('[data-testid=slope-control]').evaluate((e) => ({ shape: e.dataset.shape, tone: e.dataset.tone, title: e.querySelector('[data-testid=slope-shape]')?.innerText }));
const plain = await page.evaluate((s) => {
  const m = document.querySelector(s).tmrkzMap;
  const zs = m.getSource('rs-slope-zones').serialize().data.features;
  const cur = m.getSource('rs').serialize().data.features.find((f) => f.properties.role === 'CURRENT');
  const ring = cur?.geometry.type === 'Polygon' ? cur.geometry.coordinates[0] : cur?.geometry.coordinates?.[0]?.[0];
  const lngs = ring.map((c) => c[0]);
  const lats = ring.map((c) => c[1]);
  const [w, e, so, n] = [Math.min(...lngs), Math.max(...lngs), Math.min(...lats), Math.max(...lats)];
  const inCurrent = zs.flatMap((f) => f.geometry.coordinates).filter(([r]) => r[0][0] > w && r[1][0] < e && r[0][1] < n && r[2][1] > so).length;
  return { features: zs.length, inCurrent };
}, MAP);
await page.screenshot({ path: OUT + 'F-3d-deployment-area.png' });
ok(area.shape === 'primary' && area.tone !== '' && /الانتشار الرئيسية/.test(area.title ?? ''), 'S16', 'the deployment area being placed gets its colours, and the legend is about it', JSON.stringify(area) + ` (was ${beforeArea})`);
ok(plain.features > 0, 'S17', 'the site being placed keeps its colours beside the area', JSON.stringify(plain));

const counts1 = rowCounts();
ok(writes.length === 0 && counts0 === counts1, 'S13', 'nothing written: no request writes, database rows unchanged', `${counts0} → ${counts1}; writes ${writes.length}`);
ok(external.length === 0, 'S14', 'no request left the application', external.slice(0, 3).join(' '));
ok(consoleErrors.length === 0, 'S15', 'no console errors', consoleErrors.slice(0, 3).join(' | '));

writeFileSync(OUT + 'results.json', JSON.stringify({ at: new Date().toISOString(), results, mountain: onMountain, plain: onPlain, seen }, null, 1) + '\n');
await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
