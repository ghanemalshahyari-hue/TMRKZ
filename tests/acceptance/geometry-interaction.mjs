// Evidence of the re-stationing geometry interaction (owner correction of 5 Nov 2026: «THE GEOMETRY ITSELF IS THE
// CONTROL») on the REAL page, headless Edge, recorded: four separate 1920×1080 videos, a final PNG and a few frames
// each, and an animated GIF when ffmpeg is installed. Everything happens in a NEW request before any save, so nothing is
// written: every non-GET request is counted and must be zero.
//
//   node tests/acceptance/geometry-interaction.mjs      (UI_URL default http://localhost:5180, AUTH_URL :8088)
//
// A: a single-Polygon current site («الخدمات المشتركة» at «موقع RS-2026-0022»): the copy appears → grab → drag → drop.
// B: a two-part MultiPolygon («قسم الخدمات العامة» at «موقع RS-2026-0048»): drag one part → both move together.
// C: a marker-only current site («قسم النقل والحركة الإدارية» at «مبنى الخدمات الغربية»): vertex 1 → 4 → finish.
// D: vertex editing on the Polygon copy: «تعديل الحدود» → move a vertex → undo → redo → reset.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { partVectors, proposedParts, recordOf, rendersRole, ringCentre, slowDrag, toNewSiteStep, toScreen } from './geometry-helpers.mjs';

const UI = process.env.UI_URL ?? 'http://localhost:5180';
const AUTH = process.env.AUTH_URL ?? 'http://localhost:8088';
const OUT = fileURLToPath(new URL('../../docs/evidence/ui-rebuild/geometry-interaction/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const PASSWORD = readFileSync(new URL('../../ops/test-env/.generated/user-password', import.meta.url), 'utf8').trim();
const { chromium } = createRequire(new URL('./package.json', import.meta.url))('playwright-core');
const SIZE = { width: 1920, height: 1080 };
const results = [];
const ok = (pass, id, what, detail = '') => {
  results.push({ id, pass: !!pass, what, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} — ${what}${detail ? ' · ' + detail : ''}`);
};
const external = [];
const consoleErrors = [];
const writes = [];

const browser = await chromium.launch({ channel: 'msedge', headless: true });
// sign in once, outside the recordings
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
const count0 = (await lp.evaluate(async () => (await (await fetch('/api/v1/restationing-requests')).json()).length));
const rec = { a: await recordOf(lp, 'الخدمات المشتركة'), b: await recordOf(lp, 'قسم الخدمات العامة'), c: await recordOf(lp, 'قسم النقل والحركة الإدارية') };
await login.close();

async function recording(name, run) {
  const tmp = OUT + '.video-' + name;
  rmSync(tmp, { recursive: true, force: true });
  const ctx = await browser.newContext({ viewport: SIZE, storageState: state, recordVideo: { dir: tmp, size: SIZE } });
  const page = await ctx.newPage();
  page.on('request', (q) => {
    const u = q.url();
    if (!u.startsWith(UI) && !u.startsWith(AUTH) && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u);
    if (q.method() !== 'GET') writes.push(`${name}: ${q.method()} ${u}`);
  });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`${name}: ${m.text()}`));
  page.on('pageerror', (e) => consoleErrors.push(`${name}: ${e.message}`));
  page.on('dialog', (d) => d.accept());
  try {
    await run(page);
  } finally {
    const video = page.video();
    await ctx.close();
    const src = await video.path();
    renameSync(src, OUT + name + '.webm');
    rmSync(tmp, { recursive: true, force: true });
    try {
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', OUT + name + '.webm', '-vf', 'fps=6,scale=960:-1:flags=lanczos', '-loop', '0', OUT + name + '.gif']);
    } catch {
      /* no ffmpeg: the webm stands alone */
    }
  }
}
const shot = (page, file) => page.screenshot({ path: OUT + file });

// ---- A: single Polygon ------------------------------------------------------------------------------------------------
await recording('A-polygon', async (page) => {
  await toNewSiteStep(page, UI, rec.a.siteId, rec.a.orgName);
  const instruction = await page.locator('[data-testid=drag-instruction]').textContent();
  const before = await proposedParts(page);
  const current = await rendersRole(page, 'rs-fill', 'CURRENT');
  const bands = await page.locator('.tz-mapframe .tz-map-layer').first().getAttribute('data-bands');
  await shot(page, 'A-1-copy-appears.png');
  const from = await toScreen(page, ringCentre(before[0][0]));
  await slowDrag(page, from, { x: from.x + 420, y: from.y - 170 }, { steps: 40, pause: 400, mid: () => shot(page, 'A-2-mid-drag.png') });
  const after = await proposedParts(page);
  const stillCurrent = await rendersRole(page, 'rs-fill', 'CURRENT');
  await page.waitForTimeout(600);
  await shot(page, 'A-polygon-final.png');
  const v = partVectors(before, after);
  ok(before.length === 1 && rec.a.siteGeometry.type === 'Polygon' && JSON.stringify(before[0]) === JSON.stringify(rec.a.siteGeometry.coordinates) && instruction.includes('اسحب الموقع إلى موقع إعادة التمركز الجديد') && current && bands === '0',
    'A-COPY', 'the single-Polygon current footprint appears at once as the proposed site, identical, ready to drag; the current site stays drawn; no ring', `«${rec.a.siteName}»`);
  ok(v.metres > 500 && stillCurrent, 'A-DRAG', 'the footprint itself moves under the pointer; the current site stays as reference', `moved ${Math.round(v.metres)} m`);
});

// ---- B: two-part MultiPolygon ------------------------------------------------------------------------------------------
await recording('B-multipolygon', async (page) => {
  await toNewSiteStep(page, UI, rec.b.siteId, rec.b.orgName);
  const before = await proposedParts(page);
  await shot(page, 'B-1-copy-appears.png');
  // grab the FIRST part only: every part follows
  const from = await toScreen(page, ringCentre(before[0][0]));
  await slowDrag(page, from, { x: from.x + 380, y: from.y + 140 }, { steps: 40, pause: 400, mid: () => shot(page, 'B-2-mid-drag.png') });
  const after = await proposedParts(page);
  await page.waitForTimeout(600);
  await shot(page, 'B-multipolygon-final.png');
  const v = partVectors(before, after);
  ok(rec.b.siteGeometry.type === 'MultiPolygon' && before.length === rec.b.siteGeometry.coordinates.length && JSON.stringify(before) === JSON.stringify(rec.b.siteGeometry.coordinates),
    'B-COPY', 'every part of the MultiPolygon is copied, in order, the type kept', `${before.length} parts`);
  ok(after.length === before.length && v.metres > 400 && v.spread < 0.5, 'B-GROUP-DRAG', 'dragging one part moves all parts by the same vector', `${Math.round(v.metres)} m; parts differ by ${v.spread.toFixed(3)} m`);
});

// ---- C: marker-only current site: draw vertex by vertex ---------------------------------------------------------------
await recording('C-point', async (page) => {
  await toNewSiteStep(page, UI, rec.c.siteId, rec.c.orgName);
  const msg = await page.locator('[data-testid=draw-readout]').textContent();
  await shot(page, 'C-1-draw-from-point.png');
  const c = await page.locator('.tz-mapframe canvas.maplibregl-canvas').first().boundingBox();
  const cx = c.x + c.width / 2;
  const cy = c.y + c.height / 2;
  const pts = [[cx - 90, cy - 80], [cx + 110, cy - 90], [cx + 120, cy + 90], [cx - 80, cy + 100]];
  for (let i = 0; i < pts.length; i++) {
    await page.mouse.move(pts[i][0], pts[i][1], { steps: 30 });
    await page.waitForTimeout(350);
    await page.mouse.click(pts[i][0], pts[i][1]);
    await page.waitForTimeout(450);
    if (i === 1) await shot(page, 'C-2-two-vertices.png');
  }
  await page.mouse.move(pts[0][0] + 40, pts[0][1] + 30, { steps: 25 });
  const four = await page.locator('[data-testid=draw-readout]').getAttribute('data-count');
  const validity = await page.locator('[data-testid=draw-validity]').textContent();
  await shot(page, 'C-3-four-vertices.png');
  // finish by clicking the first vertex
  await page.mouse.move(pts[0][0], pts[0][1], { steps: 25 });
  await page.waitForTimeout(300);
  await page.mouse.click(pts[0][0], pts[0][1]);
  await page.waitForTimeout(900);
  const parts = await proposedParts(page);
  const shape = await page.locator('[data-testid=site-readout]').getAttribute('data-shape');
  await shot(page, 'C-point-final.png');
  ok(msg.includes('الموقع الحالي علامة فقط — ارسم حدود الموقع الجديد على الخريطة') && four === '4' && validity.trim() === 'صالح' && parts.length === 1 && parts[0][0].length === 5 && shape === 'DRAWN',
    'C-DRAW', 'a marker-only current site opens drawing; four clicks give four numbered vertices with sides and area; a click on the first vertex finishes a DRAWN polygon', `vertices ${four}; ${validity.trim()}; shape ${shape}`);
});

// ---- D: vertex editing with undo, redo and reset ------------------------------------------------------------------------
await recording('D-vertex-edit', async (page) => {
  await toNewSiteStep(page, UI, rec.a.siteId, rec.a.orgName);
  const start = await proposedParts(page);
  const from = await toScreen(page, ringCentre(start[0][0]));
  await slowDrag(page, from, { x: from.x + 260, y: from.y - 60 }, { steps: 30, pause: 250 });
  const dropped = await proposedParts(page);
  await page.getByRole('button', { name: 'تعديل الحدود' }).click();
  await page.waitForTimeout(800);
  await shot(page, 'D-1-vertices.png');
  const areaBefore = await page.locator('[data-testid=site-readout]').textContent();
  const v0 = await toScreen(page, dropped[0][0][0]);
  await slowDrag(page, v0, { x: v0.x - 90, y: v0.y - 70 }, { steps: 30, pause: 300 });
  const edited = await proposedParts(page);
  const areaAfter = await page.locator('[data-testid=site-readout]').textContent();
  await shot(page, 'D-2-vertex-moved.png');
  await page.getByRole('button', { name: 'تراجع', exact: true }).click();
  await page.waitForTimeout(700);
  const undone = await proposedParts(page);
  await page.getByRole('button', { name: 'إعادة', exact: true }).click();
  await page.waitForTimeout(700);
  const redone = await proposedParts(page);
  await shot(page, 'D-3-redo.png');
  await page.getByRole('button', { name: 'استعادة البداية', exact: true }).click();
  await page.waitForTimeout(900);
  const reset = await proposedParts(page);
  await shot(page, 'D-vertex-edit-final.png');
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  ok(!same(edited, dropped) && areaBefore !== areaAfter && same(undone, dropped) && same(redone, edited) && same(reset, start), 'D-EDIT',
    'one vertex moved on the map changes the area; undo restores, redo reapplies, reset returns to the starting copy', `${areaBefore.split('الحدود')[0].trim()} → ${areaAfter.split('الحدود')[0].trim()}`);
});

// nothing of this was saved: no write, the same number of requests
const check = await browser.newContext({ viewport: SIZE, storageState: state });
const cp = await check.newPage();
await cp.goto(UI + '/');
const count1 = await cp.evaluate(async () => (await (await fetch('/api/v1/restationing-requests')).json()).length);
await check.close();
ok(writes.length === 0 && count1 === count0, 'NO-DRAFT', 'copy, drag, draw and vertex editing created no draft: no write at all', `writes ${writes.length}; requests ${count0} → ${count1}`);
ok(external.length === 0, 'NET', 'no request leaves the application', external.slice(0, 3).join(' '));
ok(consoleErrors.length === 0, 'CONSOLE', 'no console error', consoleErrors.slice(0, 3).join(' | '));
writeFileSync(OUT + 'results.json', JSON.stringify({ ui: UI, at: new Date().toISOString(), sites: { A: rec.a.siteName, B: rec.b.siteName, C: rec.c.siteName }, results, writes, external, consoleErrors }, null, 2));
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} PASS`);
await browser.close();
process.exit(results.every((r) => r.pass) ? 0 : 1);
