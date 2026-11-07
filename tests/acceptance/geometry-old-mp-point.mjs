// The restored Stationing editor (accepted for Polygon, owner 5 Nov 2026) on the two other site shapes, recorded on the
// REAL page, headless Edge, 1440×900 like the historical evidence:
//   B — a two-part MultiPolygon: copy over the current site → drag the symbol → drag the body of the second part →
//       «تعديل الرؤوس» on one part, its vertex moved (the other part unchanged) → undo / redo / reset → compare;
//   C — a current site that is only a Point: «ب · رسم حدود جديدة», «عدد الرؤوس» 5, five map clicks (the line grows,
//       numbered vertices, side lengths), closed by the fifth, a vertex dragged after closing → undo / redo / reset.
// Everything happens in NEW requests before any save: every non-GET request is counted and must be zero.
//
//   node tests/acceptance/geometry-old-mp-point.mjs      (UI_URL default http://localhost:5180, AUTH_URL :8088)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { partVectors, proposedParts, recordOf, ringCentre, toNewSiteStep, toScreen } from './geometry-helpers.mjs';

const UI = process.env.UI_URL ?? 'http://localhost:5180';
const AUTH = process.env.AUTH_URL ?? 'http://localhost:8088';
// EVIDENCE_DIR=<folder> keeps a regression run's evidence apart from the accepted run's
const OUT = process.env.EVIDENCE_DIR ? process.env.EVIDENCE_DIR.replace(/[\/]?$/, '/') : fileURLToPath(new URL('../../docs/evidence/ui-rebuild/geometry-old-editor-B-C/', import.meta.url));
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
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

const browser = await chromium.launch({ ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : { channel: 'msedge' }), headless: true });
const login = await browser.newContext({ viewport: SIZE });
const lp = await login.newPage();
await lp.goto(AUTH + '/api/v1/auth/oidc/start');
await lp.waitForSelector('#kc-form-login', { timeout: 30000 });
await lp.fill('#username', (process.env.ACC_USER ?? 't.requester'));
await lp.fill('#password', PASSWORD);
await lp.click('#kc-login');
await lp.waitForURL((u) => u.toString().startsWith(AUTH) && !u.toString().includes('/auth/realms/'), { timeout: 30000 });
await lp.goto(UI + '/');
const state = await login.storageState();
const countOf = (p) => p.evaluate(async () => (await (await fetch('/api/v1/restationing-requests')).json()).length);
const count0 = await countOf(lp);
const rec = { mp: await recordOf(lp, MP_UNIT), pt: await recordOf(lp, PT_UNIT) };
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

const helpers = (page) => {
  const read = async (label) => (await page.locator('.stw-proposal-panel dt', { hasText: label }).locator('xpath=following-sibling::dd[1]').first().innerText()).trim();
  const centre = async (loc) => {
    const b = await loc.boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const mapCentre = () => page.evaluate(() => document.querySelector('.tz-mapframe .tz-map-layer').tmrkzMap.getCenter().toArray());
  // a slow, visible drag: press, move in steps, release
  const drag = async (from, dx, dy) => {
    await page.mouse.move(from.x, from.y, { steps: 8 });
    await page.waitForTimeout(450);
    await page.mouse.down();
    await page.waitForTimeout(250);
    await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 24 });
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 24 });
    await page.waitForTimeout(400);
    await page.mouse.up();
    await page.waitForTimeout(1000);
  };
  const shot = (file) => page.screenshot({ path: OUT + file });
  return { read, centre, mapCentre, drag, shot };
};

// ---- B: a two-part MultiPolygon ---------------------------------------------------------------------------------------
await recording('B-multipolygon', async (page) => {
  const { read, centre, mapCentre, drag, shot } = helpers(page);
  await toNewSiteStep(page, UI, rec.mp.siteId, rec.mp.orgName);
  await page.waitForTimeout(1800);
  const copy = await proposedParts(page);
  ok(rec.mp.siteGeometry.type === 'MultiPolygon' && copy.length === 2 && same(copy, rec.mp.siteGeometry.coordinates) && (await page.locator('.stw-orig-sym').count()) === 1
    && (await page.locator('.stw-prop-sym').count()) === 1 && (await read('المساحة المقترحة')) === (await read('المساحة الحالية')) && (await read('الأجزاء')).startsWith('2'),
    'B1-COPY', 'the current MultiPolygon stays; the proposal copy appears over it, both parts in their places, one «مقترح» symbol, equal areas', `${copy.length} parts · ${await read('المساحة المقترحة')}`);
  await shot('B-1-copy-over-current.png');

  // drag the proposal SYMBOL: both parts follow; the map stays where it is
  const c0 = await mapCentre();
  await drag(await centre(page.locator('.stw-prop-sym').first()), 160, -100);
  const bySymbol = await proposedParts(page);
  const c1 = await mapCentre();
  const v1 = partVectors(copy, bySymbol);
  ok(v1.metres > 100 && v1.spread < 0.5 && same(c0, c1) && (await read('الفرق في المساحة')) === '0٪', 'B2-SYMBOL-DRAG', 'dragging the proposal symbol moves BOTH parts by the same vector; the map does not pan; area difference 0٪',
    `${Math.round(v1.metres)} m; parts differ by ${v1.spread.toFixed(3)} m`);
  await shot('B-2-dragged-by-symbol.png');

  // drag the BODY of the second part: both parts follow
  const p2 = await toScreen(page, ringCentre(bySymbol[1][0]));
  const c2 = await mapCentre();
  await drag(p2, -90, -60);
  const byBody = await proposedParts(page);
  const c3 = await mapCentre();
  const v2 = partVectors(bySymbol, byBody);
  ok(v2.metres > 50 && v2.spread < 0.5 && same(c2, c3) && (await read('الفرق في المساحة')) === '0٪', 'B3-BODY-DRAG', 'dragging the body of the SECOND part moves both parts together; the map does not pan; area difference 0٪',
    `${Math.round(v2.metres)} m; parts differ by ${v2.spread.toFixed(3)} m`);
  await shot('B-3-dragged-by-part-2.png');

  // «تعديل الرؤوس»: the selected part's vertices; choose part 2, move one of its vertices — part 1 unchanged
  await page.getByRole('button', { name: 'تعديل الرؤوس' }).click();
  await page.getByRole('button', { name: '◎ المقترح' }).click();
  await page.waitForTimeout(1200);
  const n1 = await page.locator('.stw-vtx').count();
  await page.getByRole('button', { name: /^الجزء 2/ }).click();
  await page.waitForTimeout(700);
  const n2 = await page.locator('.stw-vtx').count();
  const sides2 = await page.locator('.stw-edge').count();
  const aBefore = await read('المساحة المقترحة');
  await drag(await centre(page.locator('.stw-vtx').first()), 40, 35);
  const edited = await proposedParts(page);
  const aAfter = await read('المساحة المقترحة');
  ok(n1 === byBody[0][0].length - 1 && n2 === byBody[1][0].length - 1 && sides2 === n2 && same(edited[0], byBody[0]) && !same(edited[1], byBody[1]) && aAfter !== aBefore,
    'B4-PART-VERTEX', '«تعديل الرؤوس» shows the selected part’s numbered vertices and side lengths; one vertex of part 2 moved changes part 2 only — part 1 byte-identical', `part 1: ${n1} vertices, part 2: ${n2}; ${aBefore} → ${aAfter}`);
  await shot('B-4-part-2-vertex-moved.png');

  // undo / redo / reset (reset is undoable: undo brings the edit back)
  await page.getByRole('button', { name: '↶ تراجع', exact: true }).click();
  await page.waitForTimeout(500);
  const undone = await proposedParts(page);
  await page.getByRole('button', { name: '↷ إعادة', exact: true }).click();
  await page.waitForTimeout(500);
  const redone = await proposedParts(page);
  await page.getByRole('button', { name: 'إعادة الضبط', exact: true }).click();
  await page.waitForTimeout(700);
  const reset = await proposedParts(page);
  ok(same(undone, byBody) && same(redone, edited) && same(reset, copy), 'B5-UNDO-REDO-RESET', 'undo restores the part, redo reapplies it, reset returns both parts to the copy over the current site');
  await page.getByRole('button', { name: '↶ تراجع', exact: true }).click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: '⇆ مقارنة الموقعين' }).click();
  await page.waitForTimeout(1500);
  ok(same(await proposedParts(page), edited) && (await page.locator('.stw-orig-sym').count()) === 1, 'B6-COMPARE', '«⇆ مقارنة الموقعين» frames the current MultiPolygon and the proposal together');
  await shot('B-multipolygon-final.png');
  await page.waitForTimeout(1200);
});

// ---- C: a current site that is only a Point ----------------------------------------------------------------------------
await recording('C-point', async (page) => {
  const { read, centre, drag, shot } = helpers(page);
  await toNewSiteStep(page, UI, rec.pt.siteId, rec.pt.orgName);
  await page.waitForTimeout(1500);
  const tabA = page.getByRole('tab', { name: 'أ · نقل الحدود الحالية' });
  const markerOnly = (await tabA.isDisabled()) && ((await page.locator('[data-testid=draw-readout]').textContent()) ?? '').includes('الموقع الحالي علامة فقط');
  await page.getByRole('tab', { name: 'ب · رسم حدود جديدة' }).click();
  await page.getByLabel('عدد الرؤوس').fill('5');
  await page.waitForTimeout(1500);
  await shot('C-1-draw-ready.png');
  const m = await page.locator('.tz-mapframe canvas.maplibregl-canvas').boundingBox();
  const cx = m.x + m.width * 0.36;
  const cy = m.y + m.height * 0.42;
  const pts = [[0, -46], [44, -14], [27, 39], [-27, 39], [-44, -14]];
  const counts = [];
  for (let i = 0; i < pts.length; i++) {
    const [dx, dy] = pts[i];
    // the pointer travels to each vertex, so the line can be seen following it
    await page.mouse.move(cx + dx, cy + dy, { steps: 20 });
    await page.waitForTimeout(350);
    await page.mouse.click(cx + dx, cy + dy);
    await page.waitForTimeout(600);
    if (i < 4) counts.push(await page.locator('.stw-vtx').count());
    if (i === 1) await shot('C-2-two-vertices.png');
    if (i === 3) {
      ok((await page.locator('.stw-edge').count()) === 4 && counts.join() === '1,2,3,4', 'C2-GROWING', 'each click adds the next numbered vertex; the open line and its side lengths grow (4 of 5 here)', `vertices ${counts.join(' → ')}`);
      await shot('C-3-four-vertices.png');
    }
  }
  await page.waitForTimeout(1500);
  const drawn = await proposedParts(page);
  const area = await read('المساحة المقترحة');
  const valid = await read('صحة الشكل');
  ok(markerOnly && drawn.length === 1 && drawn[0][0].length === 6 && (await page.locator('.stw-vtx').count()) === 5 && (await page.locator('.stw-edge').count()) === 5 && valid.includes('صالح')
    && (await page.locator('[data-testid=site-readout]').getAttribute('data-shape')) === 'DRAWN', 'C3-CLOSED', 'a Point-only current site: «ب · رسم حدود جديدة», «عدد الرؤوس» 5 — the fifth click closes the shape: five numbered vertices, five side lengths, area, validity (no fixed square)',
    `${area} · ${valid}`);
  await shot('C-4-closed-5-vertices.png');

  // a vertex dragged after closing; undo / redo / reset
  await drag(await centre(page.locator('.stw-vtx').nth(1)), 30, 25);
  const moved = await proposedParts(page);
  const area2 = await read('المساحة المقترحة');
  await shot('C-5-vertex-dragged.png');
  await page.getByRole('button', { name: '↶ تراجع', exact: true }).click();
  await page.waitForTimeout(500);
  const undone = await proposedParts(page);
  await page.getByRole('button', { name: '↷ إعادة', exact: true }).click();
  await page.waitForTimeout(500);
  const redone = await proposedParts(page);
  await page.getByRole('button', { name: 'إعادة الضبط', exact: true }).click();
  await page.waitForTimeout(600);
  const reset = await proposedParts(page);
  ok(!same(moved, drawn) && area2 !== area && same(undone, drawn) && same(redone, moved) && same(reset, drawn), 'C4-EDIT-UNDO-REDO-RESET', 'after closing, a numbered vertex drags on the map; undo, redo and reset work', `${area} → ${area2}`);
  await page.getByRole('button', { name: '↶ تراجع', exact: true }).click();
  await page.waitForTimeout(800);
  await shot('C-point-final.png');
  await page.waitForTimeout(1200);
});

const check = await browser.newContext({ storageState: state });
const cp = await check.newPage();
await cp.goto(UI + '/');
const count1 = await countOf(cp);
await browser.close();
ok(writes.length === 0 && count1 === count0, 'NO-DRAFT', 'copy, drags, vertex edits, drawing, undo, redo, reset and compare created no draft: no write at all', `writes ${writes.length}; requests ${count0} → ${count1}`);
ok(external.length === 0, 'NET', 'no request leaves the application');
ok(consoleErrors.length === 0, 'CONSOLE', 'no console error', consoleErrors.slice(0, 3).join(' | '));
writeFileSync(OUT + 'results.json', JSON.stringify({ ui: UI, at: new Date().toISOString(), sites: { B: rec.mp.siteName, C: rec.pt.siteName }, results, writes, external, consoleErrors }, null, 2));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} PASS`);
process.exit(failed ? 1 : 0);
