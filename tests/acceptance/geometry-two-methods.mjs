// Two placement methods (owner decision of 5 Nov 2026), recorded on the REAL page, headless Edge, 1440×900:
//   site    A — drag the current footprint copy to its destination (the accepted old editor);
//           B — «تحديد الموقع على الخريطة»: one click far away and the same footprint (both parts of a MultiPolygon)
//               moves there, its centre on the point; the distance is information only;
//   primary A — «تحديد المنطقة على الخريطة»: one click places the initial area of the policy in force (on tmrkz-test the
//               labelled acceptance value, version 2), then dragged; B — «رسم حدود المنطقة» with «عدد الرؤوس» 5;
//   alternative — the same two, measured from the primary area.
// Every recording shows the distance connector updating; nothing is saved: every non-GET request is counted.
//
//   node tests/acceptance/geometry-two-methods.mjs   (UI_URL default http://localhost:5180, AUTH_URL :8088;
//                                                     REUSE_DRAFT=RS-2026-0057 — a draft with a site, reopened)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { partVectors, proposedParts, recordOf, ringCentre, toNewSiteStep, toScreen } from './geometry-helpers.mjs';

const UI = process.env.UI_URL ?? 'http://localhost:5180';
const AUTH = process.env.AUTH_URL ?? 'http://localhost:8088';
const DRAFT = process.env.REUSE_DRAFT ?? 'RS-2026-0057';
// EVIDENCE_DIR=<folder> keeps a regression run's evidence apart from the accepted run's
const OUT = process.env.EVIDENCE_DIR ? process.env.EVIDENCE_DIR.replace(/[\/]?$/, '/') : fileURLToPath(new URL('../../docs/evidence/ui-rebuild/geometry-two-methods/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const PASSWORD = readFileSync(new URL('../../ops/test-env/.generated/user-password', import.meta.url), 'utf8').trim();
const { chromium } = createRequire(new URL('./package.json', import.meta.url))('playwright-core');
// POLY_UNIT / MP_UNIT / PT_UNIT name the units whose current site is a Polygon, a MultiPolygon and a marker (defaults: the
// tmrkz-test fixtures)
const POLY_UNIT = process.env.POLY_UNIT ?? 'الخدمات المشتركة';
const MP_UNIT = process.env.MP_UNIT ?? 'قسم الخدمات العامة';
const PT_UNIT = process.env.PT_UNIT ?? 'قسم النقل والحركة الإدارية';
const SIZE = { width: 1440, height: 900 };
const results = [];
const ok = (pass, id, what, detail = '') => {
  results.push({ id, pass: !!pass, what, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} — ${what}${detail ? ' · ' + detail : ''}`);
};
const external = [];
const consoleErrors = [];
const writes = [];

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const login = await browser.newContext({ viewport: SIZE });
const lp = await login.newPage();
await lp.goto(AUTH + '/api/v1/auth/oidc/start');
await lp.waitForSelector('#kc-form-login', { timeout: 30000 });
await lp.fill('#username', 't.requester');
await lp.fill('#password', PASSWORD);
await lp.click('#kc-login');
await lp.waitForURL((u) => u.toString().startsWith(AUTH) && !u.toString().includes('/auth/realms/'), { timeout: 30000 });
await lp.goto(UI + '/');
const state = await login.storageState();
const getJson = (p, path) => p.evaluate(async (u) => (await fetch('/api/v1' + u)).json(), path);
const list = await getJson(lp, '/restationing-requests');
const count0 = list.length;
const draft = list.find((r) => r.number === DRAFT);
const rec = { poly: await recordOf(lp, POLY_UNIT), mp: await recordOf(lp, MP_UNIT) };
if (!draft) throw new Error('draft ' + DRAFT + ' not found');
const draftBefore = await getJson(lp, '/restationing-requests/' + draft.id);
await login.close();

async function recording(name, run) {
  const tmp = OUT + '.video-' + name;
  rmSync(tmp, { recursive: true, force: true });
  const ctx = await browser.newContext({ viewport: SIZE, storageState: state, recordVideo: { dir: tmp, size: SIZE } });
  const page = await ctx.newPage();
  page.on('request', (q) => {
    const u = q.url();
    if (!u.startsWith(UI) && !u.startsWith(AUTH) && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u);
    // the terrain analysis (6 Nov 2026) is a read-only POST — it carries a geometry and saves nothing — not a write
    if (q.method() !== 'GET' && !u.endsWith('/api/v1/stationing/terrain/assess')) writes.push(`${name}: ${q.method()} ${u}`);
  });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`${name}: ${m.text()}`));
  page.on('pageerror', (e) => consoleErrors.push(`${name}: ${e.message}`));
  try {
    await run(page);
  } finally {
    const video = page.video();
    await ctx.close();
    renameSync(await video.path(), OUT + name + '.webm');
    rmSync(tmp, { recursive: true, force: true });
    try {
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', OUT + name + '.webm', '-vf', 'fps=8,scale=960:-1:flags=lanczos', '-loop', '0', OUT + name + '.gif']);
    } catch {
      /* no ffmpeg: the webm stands alone */
    }
  }
}

const MAP = '.tz-mapframe .tz-map-layer';
const shot = (page, file) => page.screenshot({ path: OUT + file });
const chip = (page) => page.locator('.stw-dist span').textContent().catch(() => null);
const bands = (page) => page.locator(MAP).first().getAttribute('data-bands');
const meanOf = (coords) => {
  const pts = coords.flatMap((part) => part[0].slice(0, -1));
  return { lng: pts.reduce((a, p) => a + p[0], 0) / pts.length, lat: pts.reduce((a, p) => a + p[1], 0) / pts.length };
};
const placedArea = (parts) => {
  const r = parts[0][0];
  const lat0 = (r[0][1] * Math.PI) / 180;
  let s = 0;
  for (let i = 0; i < r.length - 1; i++) s += (r[i][0] * 111320 * Math.cos(lat0)) * (r[i + 1][1] * 110900) - (r[i + 1][0] * 111320 * Math.cos(lat0)) * (r[i][1] * 110900);
  return Math.abs(s / 2);
};
const metres = (a, b) => Math.hypot((b.lng - a.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180), (b.lat - a.lat) * 110900);
/** A point {m} metres from {c} towards {deg} (degrees from north). */
const towards = (c, deg, m) => ({ lat: c.lat + (m * Math.cos((deg * Math.PI) / 180)) / 110900, lng: c.lng + (m * Math.sin((deg * Math.PI) / 180)) / (111320 * Math.cos((c.lat * Math.PI) / 180)) });
const glide = async (page, to) => {
  await page.mouse.move(to.x, to.y, { steps: 25 });
  await page.waitForTimeout(500);
};
const slowDrag = async (page, from, dx, dy) => {
  await glide(page, from);
  await page.mouse.down();
  await page.waitForTimeout(250);
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 25 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 25 });
  await page.waitForTimeout(400);
  await page.mouse.up();
  await page.waitForTimeout(1000);
};
const coordsOf = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);
const kmText = (m) => (m / 1000).toLocaleString('ar-AE', { maximumFractionDigits: 1 });
/** The connector's allowed range is the server's leg: minimum–policy maximum, and the terrain allowance when it extends it. */
/**
 * The connector's allowed range is the server's: its terrain analysis of the area WHERE IT NOW IS (owner brief «TRUE
 * OFFLINE 3D TERRAIN», §25, 6 Nov 2026 — a moved area's allowance and range follow its new ground at once). Before that
 * brief the connector kept the last saved check's range until the next save; this expectation followed it.
 */
const rangeMatches = async (page, k, text) => {
  const g = await page.evaluate((sel) => document.querySelector(sel).tmrkzMap.getSource('rs-edit').serialize().data.features[0].geometry, MAP);
  const a = await page.evaluate(async (geometry) => (await fetch('/api/v1/stationing/terrain/assess', { method: 'POST', headers: { 'content-type': 'application/json', Accept: 'application/json', 'X-Requested-With': 'mover' }, body: JSON.stringify({ geometry }) })).json(), g);
  const l = a[k];
  const want = `المسموح ${kmText(l.effectiveMinM)}–${kmText(l.baseMaxM)} كم` + (l.effectiveMaxM !== l.baseMaxM ? ` (حتى ${kmText(l.effectiveMaxM)} كم مع طبيعة الأرض)` : '');
  return { ok: (text ?? '').includes(want), want };
};

// the draft reopened at the deployment step (nothing is saved on the way)
async function toDeployment(page) {
  await page.goto(`${UI}/#restationing/${draft.id}`);
  await page.getByRole('button', { name: 'تعديل الطلب' }).click();
  await page.waitForSelector('.tz-flow', { state: 'attached', timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'الخطوة 5: الانتشار' }).click();
  await page.waitForSelector('[data-testid=area-controls]', { timeout: 20000 });
  await page.waitForTimeout(1800);
  return getJson(page, '/restationing-requests/' + draft.id);
}

// ---- site A: drag ------------------------------------------------------------------------------------------------------
await recording('site-A-drag', async (page) => {
  await toNewSiteStep(page, UI, rec.poly.siteId, rec.poly.orgName);
  await page.waitForTimeout(1500);
  const before = await proposedParts(page);
  const c = await toScreen(page, ringCentre(before[0][0]));
  await slowDrag(page, { x: c.x + 35, y: c.y + 40 }, 330, -190);
  const after = await proposedParts(page);
  const text = await chip(page);
  await shot(page, 'site-A-drag-final.png');
  const v = partVectors(before, after);
  ok(v.metres > 300 && /^المسافة: .+ — للعلم فقط$/.test(text ?? '') && (await bands(page)) === '0', 'SITE-A', 'the footprint itself is dragged to its destination; the connector says «المسافة … — للعلم فقط»; no ring',
    `${Math.round(v.metres)} m · «${text}»`);
});

// ---- site B: pick the destination far away; the same footprint (both parts) moves there --------------------------------
await recording('site-B-pick-destination', async (page) => {
  await toNewSiteStep(page, UI, rec.mp.siteId, rec.mp.orgName);
  await page.waitForTimeout(1500);
  const before = await proposedParts(page);
  await page.getByRole('button', { name: 'تحديد الموقع على الخريطة' }).click();
  await page.waitForTimeout(500);
  // zoom out with the map's own «−» to see far away, then pick a point near the edge of the view
  for (let i = 0; i < 4; i++) {
    await page.getByRole('button', { name: 'تصغير' }).click();
    await page.waitForTimeout(700);
  }
  const box = await page.locator('.tz-mapframe canvas.maplibregl-canvas').boundingBox();
  const px = { x: box.x + box.width * 0.8, y: box.y + box.height * 0.22 };
  const target = await page.evaluate(([sel, x, y]) => {
    const m = document.querySelector(sel).tmrkzMap;
    const r = m.getCanvas().getBoundingClientRect();
    const ll = m.unproject([x - r.left, y - r.top]);
    return { lng: ll.lng, lat: ll.lat };
  }, [MAP, px.x, px.y]);
  await shot(page, 'site-B-1-picking.png');
  await glide(page, px);
  await page.mouse.click(px.x, px.y);
  await page.waitForTimeout(1500);
  const after = await proposedParts(page);
  const text = await chip(page);
  await shot(page, 'site-B-2-moved-far.png');
  const v = partVectors(before, after);
  const landed = metres(meanOf(after), target);
  await page.getByRole('button', { name: '◎ المقترح' }).click();
  await page.waitForTimeout(1500);
  await shot(page, 'site-B-pick-destination-final.png');
  ok(after.length === 2 && v.spread < 0.5 && v.metres > 5000 && landed < 60 && /^المسافة: .+ كم — للعلم فقط$/.test(text ?? '') && (await bands(page)) === '0',
    'SITE-B', '«تحديد الموقع على الخريطة»: one click far away moves the same MultiPolygon there, both parts together, its centre on the point; the distance is information only',
    `${Math.round(v.metres)} m; parts differ by ${v.spread.toFixed(3)} m; centre ${Math.round(landed)} m from the click · «${text}»`);
  // still editable afterwards with the old editor
  ok(await page.getByRole('button', { name: 'تعديل الرؤوس' }).isEnabled(), 'SITE-B-EDITABLE', 'after the click-move the proposal is still edited on the map (تعديل الرؤوس, undo …)');
});

// ---- deployment: click to place, or draw, for each area ----------------------------------------------------------------
async function placeByClick(page, name, k, fromOf, deg, dist) {
  const r = await toDeployment(page);
  if (k === 'alternative') {
    await page.getByRole('tab', { name: 'منطقة الانتشار البديلة' }).click();
    await page.waitForTimeout(1500);
  }
  const from = meanOf(coordsOf(fromOf(r.content)));
  const defaultText = await page.locator('[data-testid=area-default]').textContent();
  await page.getByRole('button', { name: 'تحديد المنطقة على الخريطة' }).click();
  await page.waitForTimeout(500);
  const target = towards(from, deg, dist);
  const px = await toScreen(page, [target.lng, target.lat]);
  await glide(page, px);
  await page.mouse.click(px.x, px.y);
  await page.waitForTimeout(1500);
  const placed = await proposedParts(page);
  const t1 = await chip(page);
  await shot(page, `${name}-1-placed.png`);
  // then moved like the site, by its tag (the old editor's handle; the area is small at this scale): the connector follows
  const tb = await page.locator('.stw-prop-sym').first().boundingBox();
  await slowDrag(page, { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 }, 70, 45);
  const moved = await proposedParts(page);
  const t2 = await chip(page);
  const panel = await page.locator('[data-testid=area-distance]').textContent();
  await shot(page, `${name}-final.png`);
  const area = (await page.locator('[data-testid=area-readout] dd').first().textContent()) ?? '';
  const d = metres(from, meanOf(moved));
  const range = await rangeMatches(page, k, t2);
  const shown = parseFloat((t2 ?? '').replace(/[^\d.]/g, ' ').trim().split(/\s+/)[0]);
  ok(placed.length === 1 && placed[0][0].length === 5 && metres(meanOf(placed), target) < 60 && t1 !== t2 && /المسموح/.test(t2 ?? '') && /(ضمن النطاق|خارج النطاق|يحتاج استثناء)/.test(t2 ?? '') && panel === t2
    && Math.abs(shown * 1000 - d) < 120 && (await bands(page)) === '0' && range.ok && placedArea(placed) > 89_000 && placedArea(placed) < 91_000,
    name.toUpperCase(), `«تحديد المنطقة على الخريطة» (${k === 'primary' ? 'الرئيسية' : 'البديلة'}): one click places the initial area there, it is dragged like the site, and the connector from ${k === 'primary' ? 'the re-stationing site' : 'the primary area'} updates — distance, allowed range, verdict; no ring`,
    `«${t1}» → «${t2}» · ${area.trim()} · range from the server: «${range.want}» · ${defaultText?.trim()}`);
}

async function placeByDrawing(page, name, k, fromOf, deg, dist) {
  const r = await toDeployment(page);
  if (k === 'alternative') {
    await page.getByRole('tab', { name: 'منطقة الانتشار البديلة' }).click();
    await page.waitForTimeout(1500);
  }
  const from = meanOf(coordsOf(fromOf(r.content)));
  await page.getByRole('button', { name: 'رسم حدود المنطقة' }).click();
  await page.getByLabel('عدد الرؤوس').fill('5');
  await page.waitForTimeout(800);
  const target = towards(from, deg, dist);
  const c = await toScreen(page, [target.lng, target.lat]);
  for (const [dx, dy] of [[0, -40], [38, -12], [24, 34], [-24, 34], [-38, -12]]) {
    await glide(page, { x: c.x + dx, y: c.y + dy });
    await page.mouse.click(c.x + dx, c.y + dy);
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(1500);
  const drawn = await proposedParts(page);
  const t = await chip(page);
  const range = await rangeMatches(page, k, t);
  await shot(page, `${name}-final.png`);
  ok(drawn.length === 1 && drawn[0][0].length === 6 && (await page.locator('.stw-vtx').count()) === 5 && (await page.locator('.stw-edge').count()) === 5 && range.ok && (await bands(page)) === '0',
    name.toUpperCase(), `«رسم حدود المنطقة» (${k === 'primary' ? 'الرئيسية' : 'البديلة'}): five clicks with «عدد الرؤوس» 5 close the area — numbered vertices, side lengths — and the connector shows distance, range (terrain allowance as the server's leg), verdict`, `«${t}» · server range «${range.want}»`);
}

await recording('primary-A-click', (page) => placeByClick(page, 'primary-A-click', 'primary', (c) => c.site.geometry, 100, 6300));
await recording('primary-B-draw', (page) => placeByDrawing(page, 'primary-B-draw', 'primary', (c) => c.site.geometry, 140, 6500));
// away from the map legend (bottom left), so every click lands on the map
await recording('alternative-A-click', (page) => placeByClick(page, 'alternative-A-click', 'alternative', (c) => c.primary, 20, 4000));
await recording('alternative-B-draw', (page) => placeByDrawing(page, 'alternative-B-draw', 'alternative', (c) => c.primary, 330, 4200));

const check = await browser.newContext({ storageState: state });
const cp = await check.newPage();
await cp.goto(UI + '/');
const count1 = (await getJson(cp, '/restationing-requests')).length;
const after = await getJson(cp, '/restationing-requests/' + draft.id);
await browser.close();
ok(writes.length === 0 && count1 === count0 && JSON.stringify(after.content) === JSON.stringify(draftBefore.content), 'NO-WRITE', 'clicks, drags and drawings of the site and both areas saved nothing: no write, no new request', `writes ${writes.length}; requests ${count0} → ${count1}`);
ok(external.length === 0, 'NET', 'no request leaves the application');
ok(consoleErrors.length === 0, 'CONSOLE', 'no console error', consoleErrors.slice(0, 3).join(' | '));
writeFileSync(OUT + 'results.json', JSON.stringify({ ui: UI, at: new Date().toISOString(), draft: DRAFT, results, writes, external, consoleErrors }, null, 2));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} PASS`);
process.exit(failed ? 1 : 0);
