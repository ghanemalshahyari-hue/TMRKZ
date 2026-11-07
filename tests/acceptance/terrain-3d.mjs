// TRUE OFFLINE 3D TERRAIN (owner brief of 6 Nov 2026), on the REAL page in headless Edge, every request outside the
// application's own origins blocked and counted. A NEW fictional request, never saved:
//   current site «موقع السهل الغربي (وهمي)» on the plain → re-stationing site placed on the mountain («تحديد الموقع على
//   الخريطة») → primary deployment area and alternative («تحديد المنطقة على الخريطة», the labelled development value)
//   → screenshots A (2D), B (3D), C (3D, proposed site selected), D (3D, deployment legs);
//   one recording cut into E (2D → 3D, slow rotation), F (the proposed site dragged from the mountain onto the plain in
//   3D: the polygon re-drapes and the terrain analysis changes), G (an area drawn and edited directly on the terrain);
//   then a two-part MultiPolygon in 3D and drag timings (four parts, 1,500 vertices) as t.manager.ga.
//
//   node tests/acceptance/terrain-3d.mjs     (UI_URL default http://localhost:5197 — the Vite dev server against the
//                                              development environment tmrkz-v3dev, AUTH_URL http://localhost:8097)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { toNewSiteStep, toScreen } from './geometry-helpers.mjs';

const UI = process.env.UI_URL ?? 'http://localhost:5197';
const AUTH = process.env.AUTH_URL ?? 'http://localhost:8097';
const DB = process.env.DB_CONTAINER ?? 'tmrkz-v3dev-db-1';
const OUT = process.env.EVIDENCE_DIR ? process.env.EVIDENCE_DIR.replace(/[\/]?$/, '/') : fileURLToPath(new URL('../../docs/evidence/terrain-3d/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const PASSWORD = readFileSync(new URL('../../ops/test-env/.generated/user-password', import.meta.url), 'utf8').trim();
const { chromium } = createRequire(new URL('./package.json', import.meta.url))('playwright-core');
const SIZE = { width: 1680, height: 1000 };
const MAP = '.tz-mapframe .tz-map-layer';
// fictional points on real GLO-30 relief (ops/test-env/dev-3d-terrain-seed.sql): mountain, undulating ground, mountain
// flank, and a flat stretch of the plain
const P = { mountain: { lat: 24.77, lng: 56.075 }, primary: { lat: 24.825, lng: 56.125 }, alternative: { lat: 24.855, lng: 56.155 }, plain: { lat: 24.84, lng: 56.045 } };

const results = [];
const ok = (pass, id, what, detail = '') => {
  results.push({ id, pass: !!pass, what, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} — ${what}${detail ? ' · ' + detail : ''}`);
};
const external = [];
const consoleErrors = [];
const writes = [];
const assessCalls = [];
const demRequests = [];
const sql = (q) =>
  execFileSync('docker', ['exec', DB, 'psql', '-X', '-q', '-U', 'mover', '-d', 'mover', '-At', '-c', 'set default_transaction_read_only = on', '-c', q], { encoding: 'utf8' }).trim();
const rowCounts = () => sql("select (select count(*) from restationing_request) || '/' || (select count(*) from restationing_revision) || '/' || (select count(*) from org_stationing)");

// headless Edge draws with the machine's GPU (ANGLE Direct3D 11); a software renderer would measure nothing useful
const browser = await chromium.launch({ ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : { channel: 'msedge' }), headless: true });

async function signIn(user) {
  const ctx = await browser.newContext({ viewport: SIZE });
  const p = await ctx.newPage();
  await p.goto(AUTH + '/api/v1/auth/oidc/start');
  await p.waitForSelector('#kc-form-login', { timeout: 30000 });
  await p.fill('#username', user);
  await p.fill('#password', PASSWORD);
  await p.click('#kc-login');
  await p.waitForURL((u) => u.toString().startsWith(AUTH) && !u.toString().includes('/auth/realms/'), { timeout: 30000 });
  await p.goto(UI + '/');
  const state = await ctx.storageState();
  const current = await p.evaluate(async () => (await fetch('/api/v1/stationing/current')).json());
  await ctx.close();
  return { state, current };
}

/** A context whose every request outside the application is refused and counted; writes are recorded. */
async function context(state, name, video) {
  const ctx = await browser.newContext({ viewport: SIZE, storageState: state, ...(video ? { recordVideo: { dir: video, size: SIZE } } : {}) });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(UI) || u.startsWith(AUTH) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    external.push(`${name}: ${u}`);
    return route.abort();
  });
  const page = await ctx.newPage();
  page.on('request', (q) => {
    const u = q.url();
    if (u.includes('/terrain/glo30/visualization-3d/terrain-rgb.pmtiles')) demRequests.push(u);
    if (q.method() === 'GET') return;
    if (u.endsWith('/api/v1/stationing/terrain/assess')) assessCalls.push(u);
    else writes.push(`${name}: ${q.method()} ${u}`);
  });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`${name}: ${m.text()}`));
  page.on('pageerror', (e) => consoleErrors.push(`${name}: ${e.message}`));
  return { ctx, page };
}

const mapEval = (page, fn, arg) => page.evaluate(([sel, src, a]) => new Function('m', 'a', src)(document.querySelector(sel).tmrkzMap, a), [MAP, fn, arg]);
const settle = async (page, ms = 600) => {
  await page.waitForTimeout(ms);
  await page.waitForFunction((sel) => {
    const m = document.querySelector(sel)?.tmrkzMap;
    return !!m && m.loaded() && m.areTilesLoaded() && !m.isMoving();
  }, MAP, { timeout: 45000 }).catch(() => undefined);
  await page.waitForTimeout(400);
};
const editParts = (page) => mapEval(page, `const s = m.getSource('rs-edit'); return (s.serialize().data.features || []).map((f) => f.geometry.coordinates);`);
const panel = (page) => page.locator('[data-testid=terrain-panel]').evaluate((e) => ({ ...e.dataset, text: e.innerText }));
const waitPanel = (page) => page.waitForFunction(() => document.querySelector('[data-testid=terrain-panel]')?.dataset.pending === 'false', null, { timeout: 30000 }).catch(() => undefined);
const camera = (page) => mapEval(page, `return { pitch: m.getPitch(), bearing: m.getBearing(), zoom: m.getZoom(), terrain: m.getTerrain() }`);
const clickAt = async (page, ll) => {
  const s = await toScreen(page, [ll.lng, ll.lat]);
  await page.mouse.move(s.x, s.y, { steps: 12 });
  await page.waitForTimeout(250);
  await page.mouse.click(s.x, s.y);
  return s;
};
/** Right-button drag: MapLibre rotates (and tilts) the camera, as a person does. */
const rotate = async (page, dx, steps = 60) => {
  const box = await page.locator(MAP).boundingBox();
  const c = { x: box.x + box.width / 2, y: box.y + box.height * 0.45 };
  await page.mouse.move(c.x, c.y);
  await page.mouse.down({ button: 'right' });
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(c.x + (dx * i) / steps, c.y, { steps: 1 });
    await page.waitForTimeout(45);
  }
  await page.mouse.up({ button: 'right' });
};
const shot = (page, file) => page.screenshot({ path: OUT + file });

// ---- sign in, the fictional data, nothing saved ------------------------------------------------------------------
const req = await signIn((process.env.ACC_USER ?? 't.requester'));
const rec = req.current.find((c) => c.siteName === ('موقع السهل الغربي' + (process.env.ACC_SUFFIX ?? ' (وهمي)')));
if (!rec) throw new Error('fictional current site not found: run ops/test-env/dev-3d-terrain-seed.sql');
const counts0 = rowCounts();
const videoDir = OUT + '.video-master';
rmSync(videoDir, { recursive: true, force: true });
const { ctx, page } = await context(req.state, 'requester', videoDir);
const t0 = Date.now();
const marks = {};
const mark = (k, edge) => ((marks[k] ??= {})[edge] = (Date.now() - t0) / 1000);

// 1–3, then the new site: the copy of the current boundary appears on the plain
await toNewSiteStep(page, UI, rec.siteId, rec.orgName);
await settle(page, 1500);
const has3d = await page.locator('[data-testid=view-switch] button', { hasText: '3D' }).isEnabled();
const manifest = await page.evaluate(async () => (await fetch('/map-data/manifest.json')).json());
ok(has3d && manifest.components.some((c) => c.id === 'terrain-3d'), 'T01', '3D available from the installed package', `${manifest.packageId}, component terrain-3d, switch enabled`);
const copy = await editParts(page);

// the re-stationing site onto the mountain: zoom out with the map's own buttons, «تحديد الموقع على الخريطة», one click
for (let i = 0; i < 4; i++) {
  await page.getByRole('button', { name: 'تصغير' }).click();
  await settle(page, 500);
}
await page.getByRole('button', { name: 'تحديد الموقع على الخريطة' }).click();
await clickAt(page, P.mountain);
await settle(page, 900);
const onMountain = await editParts(page);
const placedCentre = onMountain[0]?.[0].slice(0, -1).reduce((a, c, _, r) => [a[0] + c[0] / r.length, a[1] + c[1] / r.length], [0, 0]) ?? [0, 0];
ok(onMountain.length === 1 && JSON.stringify(onMountain) !== JSON.stringify(copy) && Math.hypot((placedCentre[0] - P.mountain.lng) * 101000, (placedCentre[1] - P.mountain.lat) * 110900) < 150,
  'T02', 'proposed site placed on the mountain (one click, same shape)', `centre ${placedCentre.map((v) => v.toFixed(5)).join(', ')}`);

// the deployment step without saving (step tracker), then both areas by «تحديد المنطقة على الخريطة»
await page.getByRole('button', { name: 'الخطوة 5: الانتشار' }).click();
await page.waitForSelector('[data-testid=area-controls]', { timeout: 20000 });
await settle(page, 1200);
await page.getByRole('button', { name: 'تحديد المنطقة على الخريطة' }).click();
await settle(page, 800);
await clickAt(page, P.primary);
await settle(page, 900);
await page.locator('[data-testid=area-controls]').getByRole('tab', { name: 'منطقة الانتشار البديلة' }).click();
await settle(page, 1200);
await page.getByRole('button', { name: 'تحديد المنطقة على الخريطة' }).click();
await settle(page, 800);
await clickAt(page, P.alternative);
await settle(page, 900);
await page.getByRole('button', { name: 'الحدود والمناطق' }).click();
await settle(page, 1500);
await waitPanel(page);
const geometry2d = await page.evaluate((sel) => {
  const m = document.querySelector(sel).tmrkzMap;
  return JSON.stringify([m.getSource('rs').serialize().data, m.getSource('rs-edit').serialize().data]);
}, MAP);
const undo2d = await page.getByRole('button', { name: '↶ تراجع' }).isEnabled();
await shot(page, 'A-2d-request.png');

// ---- E: 2D → 3D, then a slow rotation ------------------------------------------------------------------------------
mark('E', 'start');
await page.locator('[data-testid=view-switch] button', { hasText: '3D' }).click();
await settle(page, 2500);
await page.getByRole('button', { name: 'الحدود والمناطق' }).click();
await settle(page, 2500);
const cam3d = await camera(page);
ok(cam3d.terrain?.source === 'terrain3d' && cam3d.terrain.exaggeration === 1 && cam3d.pitch > 45, 'T03', 'MapLibre terrain on, exaggeration 1, tilted camera', JSON.stringify(cam3d));
await shot(page, 'B-3d-request.png');
await rotate(page, 260);
await settle(page, 800);
await rotate(page, -420, 90);
await settle(page, 1500);
mark('E', 'end');
const camRot = await camera(page);
ok(Math.abs(camRot.bearing - cam3d.bearing) > 5, 'T04', 'the camera rotates over the terrain (right-button drag)', `bearing ${cam3d.bearing.toFixed(1)}° → ${camRot.bearing.toFixed(1)}°`);

// drape evidence: every request geometry is drawn by a fill and a line layer (MapLibre drapes them on the terrain) and
// its vertices lie at very different heights of the terrain the map is drawing
const drape = await mapEval(page, `
  const q = (layer) => m.getLayer(layer) ? m.queryRenderedFeatures({ layers: [layer] }) : [];
  const roles = new Set([...q('rs-fill'), ...q('rs-area-fill')].map((f) => f.properties.role));
  const edited = q('rs-edit-fill').length;
  const occ = q('occ-fill').length;
  const spread = (coords) => { const h = coords.map((c) => m.queryTerrainElevation(c)).filter((v) => v != null); return h.length ? [Math.min(...h), Math.max(...h)] : null; };
  const rs = m.getSource('rs').serialize().data.features.filter((f) => f.geometry.type !== 'Point' && f.geometry.type !== 'LineString');
  const by = {};
  for (const f of rs) by[f.properties.role] = spread((f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates).flatMap((p) => p[0]));
  const e = m.getSource('rs-edit').serialize().data.features;
  by.EDITED = spread(e.flatMap((f) => f.geometry.coordinates[0]));
  return { roles: [...roles], edited, occ, by, types: ['rs-fill', 'rs-area-fill', 'rs-line', 'rs-edit-fill', 'rs-edit-line', 'occ-fill'].map((l) => m.getLayer(l)?.type) };`);
ok(['CURRENT', 'SITE', 'PRIMARY'].every((r) => drape.roles.includes(r)) && drape.edited > 0, 'T05', 'current, proposed, primary and alternative rendered as draped fills in 3D', JSON.stringify({ roles: drape.roles, edited: drape.edited, types: drape.types }));
ok(drape.occ > 0, 'T06', 'occupied ground (another unit\'s site) rendered as a draped fill in 3D', `${drape.occ} features`);
const span = (r) => (drape.by[r] ? Math.round(drape.by[r][1] - drape.by[r][0]) : -1);
ok(span('SITE') > 100, 'T07', 'the proposed site spans the mountain: its vertices lie at different terrain heights', Object.entries(drape.by).map(([k, v]) => `${k} ${v ? v.map(Math.round).join('–') + ' m' : '—'}`).join(', '));

// markers: each card stands on the terrain point under its geometry (screen position = terrain-aware projection)
const cards = await page.evaluate((sel) => {
  const m = document.querySelector(sel).tmrkzMap;
  const r = m.getCanvas().getBoundingClientRect();
  return [...document.querySelectorAll('.tz3-card-wrap')].map((el) => {
    const card = el.querySelector('.tz3-card');
    const b = el.getBoundingClientRect();
    return { role: card?.dataset.role, x: b.left + b.width / 2 - r.left, y: b.bottom - r.top, opacity: getComputedStyle(el).opacity };
  });
}, MAP);
const anchors = await mapEval(page, `
  return [...document.querySelectorAll('.tz3-card-wrap')].map((el) => { const ll = [Number(el.dataset.lng), Number(el.dataset.lat)]; const p = m.project(ll); return { x: p.x, y: p.y - 58, elev: m.queryTerrainElevation(ll) }; });`).catch(() => null);
const off = anchors ? cards.map((c, i) => Math.hypot(c.x - anchors[i].x, c.y - anchors[i].y)) : [];
ok(cards.length === 4 && off.length === 4 && off.every((d) => d < 4), 'T08', 'four cards, each on a 58 px stem from its ground point at the terrain height', cards.map((c, i) => `${c.role} ${off[i]?.toFixed(1)} px, ${anchors?.[i]?.elev?.toFixed(0)} m`).join(' · '));

// connectors: three, in one order and direction; the move is information only
const chips = await page.$$eval('.tz3-chip', (els) => els.map((e) => ({ leg: e.dataset.leg, text: e.innerText, verdict: !!e.querySelector('i') })));
const heads = await mapEval(page, `
  const f = m.getSource('rs').serialize().data.features.filter((x) => x.properties.role === 'LEG_HEAD').map((x) => ({ leg: x.properties.leg, rotate: x.properties.rotate }));
  const e = m.getSource('rs-edit-head').serialize().data;
  return { legs: f, edited: e.type === 'Feature' ? e.properties.rotate : (e.features || []).map((x) => x.properties.rotate) };`);
const kinds = chips.map((c) => c.leg).sort().join(',');
const move = chips.find((c) => c.leg === 'move');
ok(kinds === 'alternative,move,primary' && move && move.text.includes('للعلم فقط') && !move.verdict, 'T09', 'three connectors: move (information only, no verdict), site → primary, primary → alternative', chips.map((c) => `${c.leg}: ${c.text.replace(/\s+/g, ' ')}`).join(' | '));
const bearing = (a, b) => {
  const r = (d) => (d * Math.PI) / 180;
  const y = Math.sin(r(b.lng - a.lng)) * Math.cos(r(b.lat));
  const x = Math.cos(r(a.lat)) * Math.sin(r(b.lat)) - Math.sin(r(a.lat)) * Math.cos(r(b.lat)) * Math.cos(r(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
};
ok(heads.legs.some((h) => h.leg === 'primary') && typeof heads.edited === 'number' && Math.abs(heads.edited - bearing(P.primary, P.alternative)) < 3, 'T10', 'arrowheads point the leg\'s way: primary → alternative from the primary area (not from the site)', `edited-leg head ${heads.edited?.toFixed?.(1)}°, expected ≈${bearing(P.primary, P.alternative).toFixed(1)}°; RequestMap heads ${JSON.stringify(heads.legs)}`);

// ---- C: the proposed site selected, its terrain analysis -----------------------------------------------------------
await page.locator('.tz3-card.r-SITE').click();
await waitPanel(page);
await settle(page, 700);
const siteP = await panel(page);
await shot(page, 'C-3d-proposed-site-analysis.png');
ok(siteP.role === 'SITE' && siteP.class && Number(siteP.max) - Number(siteP.min) > 100 && !(await page.locator('[data-testid=terrain-rule]').count()) && (await page.locator('[data-testid=terrain-move]').innerText()).includes('للعلم فقط'),
  'T11', 'proposed site: server class, real heights, NO range verdict (distance for information only)', `class ${siteP.class}, ${siteP.min}–${siteP.max} m, centre ${siteP.centre} m`);

// ---- D: the deployment legs and their rules --------------------------------------------------------------------------
const serverA = await page.evaluate(async () => {
  const g = (await (await fetch('/api/v1/stationing/policy')).json()).inForce.values;
  return { allowances: g.terrainAllowancesM, primary: g.primary, alternative: g.alternative };
});
const ruleOk = (pp, leg) => pp.verdict && pp.source === 'preview' && Number(pp.allowance) === serverA.allowances[pp.class] && Number(pp.effectiveMax) === serverA[leg].maxM + serverA.allowances[pp.class];
await page.locator('.tz3-card.r-PRIMARY').click();
await waitPanel(page);
await settle(page, 700);
const primP = await panel(page);
await page.locator('.tz3-chip[data-leg=alternative]').click();
await waitPanel(page);
await settle(page, 900);
const altP = await panel(page);
const altChip = await page.locator('.tz3-chip[data-leg=alternative]').innerText();
await shot(page, 'D-3d-deployment-legs.png');
ok(primP.role === 'PRIMARY' && ruleOk(primP, 'primary') && altP.role === 'ALTERNATIVE' && ruleOk(altP, 'alternative') && altChip.includes('الفعّال'),
  'T12', 'deployment legs: allowance and effective maximum are exactly the policy in force for the server class of each area',
  `primary ${primP.class} +${primP.allowance} m → max ${primP.effectiveMax} m ${primP.verdict}; alternative ${altP.class} +${altP.allowance} m → max ${altP.effectiveMax} m ${altP.verdict}; chip «${altChip.replace(/\s+/g, ' ')}»`);
const profileOk = await page.locator('[data-testid=terrain-profile] svg path.line').count();
ok(profileOk === 1, 'T13', 'elevation profile of the selected leg drawn from the elevation tiles', (await page.locator('[data-testid=terrain-profile] figcaption').innerText()).replace(/\s+/g, ' '));

// ---- 3D → 2D: nothing of the request changed ------------------------------------------------------------------------
await page.locator('[data-testid=view-switch] button', { hasText: '2D' }).click();
await settle(page, 1500);
const geometryBack = await page.evaluate((sel) => {
  const m = document.querySelector(sel).tmrkzMap;
  return JSON.stringify([m.getSource('rs').serialize().data, m.getSource('rs-edit').serialize().data]);
}, MAP);
const cam2d = await camera(page);
ok(geometryBack === geometry2d && (await page.getByRole('button', { name: '↶ تراجع' }).isEnabled()) === undo2d && !cam2d.terrain && cam2d.pitch === 0, 'T14', '2D → 3D → 2D leaves every coordinate, part order and the undo history exactly as they were', `pitch ${cam2d.pitch}, terrain ${cam2d.terrain}`);

// ---- F: drag the proposed site from the mountain onto the plain, in 3D ---------------------------------------------
await page.getByRole('button', { name: 'الخطوة 4: الموقع الجديد' }).click();
await settle(page, 1200);
await page.locator('[data-testid=view-switch] button', { hasText: '3D' }).click();
await settle(page, 2500);
await waitPanel(page);
const before = await panel(page);
const partsBefore = await editParts(page);
mark('F', 'start');
await page.waitForTimeout(800);
const from = await toScreen(page, [P.mountain.lng, P.mountain.lat]);
const grab = await page.evaluate(() => {
  const el = document.querySelector('.stw-prop-sym');
  const b = el.getBoundingClientRect();
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
});
const to = await toScreen(page, [P.plain.lng, P.plain.lat]);
await page.mouse.move(grab.x, grab.y, { steps: 15 });
await page.waitForTimeout(400);
await page.mouse.down();
for (let i = 1; i <= 70; i++) {
  await page.mouse.move(grab.x + ((to.x - from.x) * i) / 70, grab.y + ((to.y - from.y) * i) / 70, { steps: 1 });
  await page.waitForTimeout(40);
}
await page.waitForTimeout(400);
await page.mouse.up();
await settle(page, 800);
await waitPanel(page);
await page.waitForTimeout(1500);
mark('F', 'end');
const after = await panel(page);
const partsAfter = await editParts(page);
const elevAfter = await mapEval(page, `const e = m.getSource('rs-edit').serialize().data.features; const h = e.flatMap((f) => f.geometry.coordinates[0]).map((c) => m.queryTerrainElevation(c)); return [Math.min(...h), Math.max(...h)];`);
await shot(page, 'F-after-drag-on-plain.png');
ok(JSON.stringify(partsAfter) !== JSON.stringify(partsBefore) && after.class !== before.class && Number(after.max) < Number(before.max) - 150,
  'T15', 'drag in 3D: the site settles on the plain, and its terrain class and heights are read again', `class ${before.class} → ${after.class}; heights ${before.min}–${before.max} m → ${after.min}–${after.max} m; terrain under the dropped vertices ${elevAfter.map(Math.round).join('–')} m`);

// ---- G: an area drawn and edited directly on the terrain -------------------------------------------------------------
await page.getByRole('button', { name: 'الخطوة 5: الانتشار' }).click();
await page.waitForSelector('[data-testid=area-controls]', { timeout: 20000 });
await settle(page, 1500);
await page.locator('[data-testid=area-controls]').getByRole('tab', { name: 'منطقة الانتشار البديلة' }).click();
await settle(page, 1500);
mark('G', 'start');
await page.getByRole('button', { name: 'رسم حدود المنطقة' }).click();
await settle(page, 1200);
// closer, with the wheel over the place to draw
const zc = await toScreen(page, [P.alternative.lng, P.alternative.lat]);
await page.mouse.move(zc.x, zc.y);
for (let i = 0; i < 6; i++) {
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(250);
}
await settle(page, 1200);
const ring = [[-260, -200], [260, -230], [300, 220], [-240, 250]].map(([e, n]) => ({ lat: P.alternative.lat + n / 110900, lng: P.alternative.lng + e / (111320 * Math.cos((P.alternative.lat * Math.PI) / 180)) }));
// the map's own click events: where on the terrain each click landed (MapLibre picks the terrain under the pointer)
await mapEval(page, `window.__clicks = []; m.on('click', (e) => window.__clicks.push({ ll: [e.lngLat.lng, e.lngLat.lat], px: [e.point.x, e.point.y], elev: m.queryTerrainElevation(e.lngLat), back: (() => { const p = m.project(e.lngLat); return [p.x, p.y]; })() }));`);
for (const v of ring) {
  const s = await toScreen(page, [v.lng, v.lat]);
  await page.mouse.move(s.x, s.y, { steps: 10 });
  await page.waitForTimeout(300);
  await page.mouse.click(s.x, s.y);
  await page.waitForTimeout(500);
}
await settle(page, 1000);
const clicks = await page.evaluate(() => window.__clicks);
const drawn = await editParts(page);
const vtx = drawn[0]?.[0] ?? [];
// each vertex IS the terrain point of its click, and that point projects back over the terrain onto the clicked pixel
const same = clicks.length === 4 && clicks.every((c, i) => vtx[i] && vtx[i][0] === c.ll[0] && vtx[i][1] === c.ll[1]);
const px = clicks.map((c) => Math.hypot(c.back[0] - c.px[0], c.back[1] - c.px[1]));
ok(drawn.length === 1 && vtx.length === 5 && same && px.every((e) => e < 2) && clicks.every((c) => c.elev > 150), 'T16', 'drawing in 3D: four vertices placed on the terrain exactly where it was clicked',
  `vertices = click points: ${same}; back-projection ${px.map((e) => e.toFixed(2)).join(', ')} px; terrain heights at the clicks ${clicks.map((c) => Math.round(c.elev)).join(', ')} m`);
const drawnElev = clicks.map((c) => c.elev);
// edit one vertex on the terrain, then undo, redo and reset
const v2 = await toScreen(page, vtx[1]);
await page.mouse.move(v2.x, v2.y, { steps: 10 });
await page.waitForTimeout(300);
await page.mouse.down();
await page.mouse.move(v2.x + 70, v2.y + 45, { steps: 30 });
await page.waitForTimeout(300);
await page.mouse.up();
await settle(page, 900);
const edited = await editParts(page);
await page.getByRole('button', { name: '↶ تراجع' }).click();
await page.waitForTimeout(700);
const undone = await editParts(page);
await page.getByRole('button', { name: '↷ إعادة' }).click();
await page.waitForTimeout(700);
const redone = await editParts(page);
await page.getByRole('button', { name: 'إعادة الضبط' }).click();
await page.waitForTimeout(900);
const reset = await editParts(page);
await settle(page, 1200);
mark('G', 'end');
await shot(page, 'G-drawn-on-terrain.png');
ok(JSON.stringify(edited) !== JSON.stringify(drawn) && JSON.stringify(undone) === JSON.stringify(drawn) && JSON.stringify(redone) === JSON.stringify(edited) && JSON.stringify(reset) === JSON.stringify(drawn),
  'T17', 'editing in 3D: a vertex dragged on the terrain; undo, redo and reset restore exact coordinates', `terrain under the drawn vertices ${drawnElev.map((h) => Math.round(h)).join(', ')} m`);
const video = page.video();
const videoPath = await video.path();
await ctx.close();
renameSync(videoPath, OUT + 'master.webm');
rmSync(videoDir, { recursive: true, force: true });

// ---- MultiPolygon and drag timings (t.manager.ga) ----------------------------------------------------------------------
const mgr = await signIn((process.env.ACC_MGR ?? 't.manager.ga'));
const timings = [];
for (const [code, parts] of [[('موقع من جزأين على السهل' + (process.env.ACC_SUFFIX ?? ' (وهمي)')), 2], [('موقع من أربعة أجزاء' + (process.env.ACC_SUFFIX ?? ' (وهمي)')), 4], [('موقع كثيف الرؤوس' + (process.env.ACC_SUFFIX ?? ' (وهمي)')), 1]]) {
  const r = mgr.current.find((c) => c.siteName === code);
  if (!r) {
    ok(false, 'T18', 'fictional site present: ' + code);
    continue;
  }
  const { ctx: c2, page: p2 } = await context(mgr.state, 'manager-' + parts);
  await toNewSiteStep(p2, UI, r.siteId, r.orgName);
  await settle(p2, 1500);
  await p2.locator('[data-testid=view-switch] button', { hasText: '3D' }).click();
  await settle(p2, 3000);
  const rendered = await p2.evaluate((sel) => {
    const m = document.querySelector(sel).tmrkzMap;
    return { parts: new Set(m.queryRenderedFeatures({ layers: ['rs-edit-fill'] }).map((f) => f.properties.part)).size, terrain: !!m.getTerrain(), vertices: m.getSource('rs-edit').serialize().data.features.reduce((s, f) => s + f.geometry.coordinates[0].length, 0) };
  }, MAP);
  await p2.evaluate(() => {
    window.__long = [];
    new PerformanceObserver((l) => window.__long.push(...l.getEntries().map((e) => e.duration))).observe({ type: 'longtask', buffered: false });
    window.__frames = [];
    let last = performance.now();
    const tick = (t) => {
      window.__frames.push(t - last);
      last = t;
      if (window.__frames.length < 2000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const g = await p2.evaluate(() => {
    const b = document.querySelector('.stw-prop-sym').getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await p2.evaluate(() => (window.__frames = []));
  await p2.mouse.move(g.x, g.y, { steps: 5 });
  await p2.mouse.down();
  for (let i = 1; i <= 60; i++) {
    await p2.mouse.move(g.x + i * 4, g.y + i * 2, { steps: 1 });
    await p2.waitForTimeout(16);
  }
  await p2.mouse.up();
  await p2.waitForTimeout(800);
  const perf = await p2.evaluate(() => {
    const f = window.__frames.slice(1).sort((a, b) => a - b);
    return { long: window.__long.length, longMax: Math.max(0, ...window.__long), p50: f[Math.floor(f.length / 2)], p95: f[Math.floor(f.length * 0.95)], max: f[f.length - 1] };
  });
  timings.push({ site: code, parts, vertices: rendered.vertices, ...perf });
  if (parts === 2) ok(rendered.terrain && rendered.parts === 2, 'T18', 'a two-part MultiPolygon proposed site is drawn with both parts on the 3D terrain', JSON.stringify(rendered));
  await c2.close();
}
ok(timings.length === 3 && timings.every((t) => t.p95 < 120), 'T19', '3D drag timings (headless Edge on the GPU, ANGLE Direct3D 11; long tasks recorded, not hidden)', timings.map((t) => `${t.parts} part(s)/${t.vertices} vertices: p50 ${t.p50?.toFixed(0)} ms, p95 ${t.p95?.toFixed(0)} ms, max ${t.max?.toFixed(0)} ms, long tasks ${t.long} (max ${t.longMax.toFixed(0)} ms)`).join(' · '));

// ---- the invariants -------------------------------------------------------------------------------------------------
const counts1 = rowCounts();
// the page's own requests decide (other work may write fictional drafts in the shared development database meanwhile);
// the database row counts are reported beside them
ok(writes.length === 0, 'T20', 'zero request writes: the only POSTs are the read-only terrain analysis', `other writes ${writes.length}; terrain analyses ${assessCalls.length}; rows (requests/revisions/stationings) ${counts0} → ${counts1}`);
ok(external.length === 0, 'T21', 'zero external requests (all outside traffic refused and counted)', external.slice(0, 3).join(' '));
ok(demRequests.length > 0 && demRequests.every((u) => u.startsWith(UI + '/map-data/')), 'T22', 'the elevation tiles come from the installed offline package only', `${demRequests.length} range requests to /map-data/terrain/glo30/visualization-3d/terrain-rgb.pmtiles`);
ok(consoleErrors.length === 0, 'T23', 'zero console errors', consoleErrors.slice(0, 3).join(' | '));
await browser.close();

// recordings E, F, G cut from the one master recording
const cut = (name, from, to) => {
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(Math.max(0, from - 0.5)), '-to', String(to + 0.5), '-i', OUT + 'master.webm', '-c:v', 'libvpx-vp9', '-b:v', '2500k', '-an', OUT + name + '.webm']);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', OUT + name + '.webm', '-vf', 'fps=6,scale=840:-1:flags=lanczos', '-loop', '0', OUT + name + '.gif']);
  } catch (e) {
    console.log('ffmpeg: ' + e.message);
  }
};
cut('E-2d-to-3d-rotate', marks.E.start, marks.E.end);
cut('F-drag-mountain-to-plain', marks.F.start, marks.F.end);
cut('G-draw-edit-on-terrain', marks.G.start, marks.G.end);
rmSync(OUT + 'master.webm', { force: true });
const failed = results.filter((r) => !r.pass);
writeFileSync(OUT + 'results.json', JSON.stringify({ when: new Date().toISOString(), ui: UI, auth: AUTH, package: manifest.packageId, marks, timings, results, external, consoleErrors, writes, assessCalls: assessCalls.length, demRequests: demRequests.length }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
