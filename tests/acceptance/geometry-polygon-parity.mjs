// Polygon editing on the re-stationing step with the accepted Stationing editor's look (owner decision of 5 Nov 2026:
// «restore the previous approved map interaction»): one REAL recording on the page, headless Edge, 1920×1080 —
// the copy appears → grab the polygon → drag → drop → «تعديل الحدود» → move one vertex — with a frame at each moment.
// Everything happens in a NEW request before any save: every non-GET request is counted and must be zero.
//
//   node tests/acceptance/geometry-polygon-parity.mjs      (UI_URL default http://localhost:5180, AUTH_URL :8088)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { partVectors, proposedParts, recordOf, ringCentre, slowDrag, toNewSiteStep, toScreen } from './geometry-helpers.mjs';

const UI = process.env.UI_URL ?? 'http://localhost:5180';
const AUTH = process.env.AUTH_URL ?? 'http://localhost:8088';
// EVIDENCE_DIR=<folder> keeps a regression run's evidence apart from the accepted run's
const OUT = process.env.EVIDENCE_DIR ? process.env.EVIDENCE_DIR.replace(/[\/]?$/, '/') : fileURLToPath(new URL('../../docs/evidence/ui-rebuild/geometry-old-editor/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const PASSWORD = readFileSync(new URL('../../ops/test-env/.generated/user-password', import.meta.url), 'utf8').trim();
const { chromium } = createRequire(new URL('./package.json', import.meta.url))('playwright-core');
// POLY_UNIT / MP_UNIT / PT_UNIT name the units whose current site is a Polygon, a MultiPolygon and a marker (defaults: the
// tmrkz-test fixtures)
const POLY_UNIT = process.env.POLY_UNIT ?? 'الخدمات المشتركة';
const MP_UNIT = process.env.MP_UNIT ?? 'قسم الخدمات العامة';
const PT_UNIT = process.env.PT_UNIT ?? 'قسم النقل والحركة الإدارية';
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
const countOf = (p) => p.evaluate(async () => (await (await fetch('/api/v1/restationing-requests')).json()).length);
const count0 = await countOf(lp);
const rec = await recordOf(lp, POLY_UNIT);
await login.close();

const tmp = OUT + '.video';
rmSync(tmp, { recursive: true, force: true });
const ctx = await browser.newContext({ viewport: SIZE, storageState: state, recordVideo: { dir: tmp, size: SIZE } });
const page = await ctx.newPage();
page.on('request', (q) => {
  const u = q.url();
  if (!u.startsWith(UI) && !u.startsWith(AUTH) && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u);
  if (q.method() !== 'GET') writes.push(`${q.method()} ${u}`);
});
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(e.message));
const shot = (file) => page.screenshot({ path: OUT + file });
try {
  await toNewSiteStep(page, UI, rec.siteId, rec.orgName);
  await page.waitForTimeout(1800);
  // 1 — the copy appears on the current site, selected, with the organisation's mark and «مقترح»
  const before = await proposedParts(page);
  const tag = await page.locator('.stw-prop-sym .lbl').textContent();
  const origTag = await page.locator('.stw-orig-sym .lbl').textContent();
  await shot('P-1-copy-appears.png');
  ok(before.length === 1 && JSON.stringify(before[0]) === JSON.stringify(rec.siteGeometry.coordinates) && tag === 'مقترح' && origTag.includes('الموقع الحالي'),
    'P-COPY', 'the current Polygon is copied at once (no save), marked «مقترح» on the organisation symbol; the current site keeps its own tag', `«${rec.siteName}»`);
  // 2–3 — grab the polygon's body, drag it slowly, drop
  const c = await toScreen(page, ringCentre(before[0][0]));
  const grab = { x: c.x + 35, y: c.y + 45 };
  await slowDrag(page, grab, { x: grab.x + 380, y: grab.y - 230 }, { steps: 60, pause: 900, mid: () => shot('P-2-mid-drag.png') });
  await page.waitForTimeout(900);
  const after = await proposedParts(page);
  const dist = await page.locator('.stw-dist span').textContent();
  await shot('P-3-dropped.png');
  const v = partVectors(before, after);
  ok(v.metres > 400 && (await page.locator('.stw-vtx').count()) === 0, 'P-DRAG', 'the polygon itself follows the pointer and drops where released; no handles in the move', `moved ${Math.round(v.metres)} m; chip «${dist}»`);
  // 4 — «تعديل الحدود»: every vertex numbered, every side measured; move one vertex
  await page.getByRole('button', { name: 'تعديل الحدود' }).click();
  await page.waitForTimeout(1200);
  const handles = await page.locator('.stw-vtx').count();
  const sides = await page.locator('.stw-edge').count();
  const area0 = await page.locator('[data-testid=site-readout]').innerText();
  const vtx = await toScreen(page, after[0][0][1]);
  await slowDrag(page, vtx, { x: vtx.x + 70, y: vtx.y + 55 }, { steps: 40, pause: 700 });
  await page.waitForTimeout(1500);
  const edited = await proposedParts(page);
  const area1 = await page.locator('[data-testid=site-readout]').innerText();
  const active = await page.locator('.stw-vtx.on').textContent().catch(() => null);
  await shot('P-4-vertex-edited.png');
  // GeoJSON rings repeat their first vertex at the end
  const n = after[0][0].length - 1;
  ok(handles === n && sides === n && JSON.stringify(edited) !== JSON.stringify(after) && area0 !== area1 && active === '2',
    'P-VERTEX', 'vertex editing shows every vertex numbered and every side measured; one vertex moved changes the area, the moved vertex is marked', `${handles} vertices, ${sides} sides; active ${active}`);
  await page.waitForTimeout(1200);
} finally {
  const video = page.video();
  await ctx.close();
  renameSync(await video.path(), OUT + 'P-polygon-old-editor.webm');
  rmSync(tmp, { recursive: true, force: true });
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', OUT + 'P-polygon-old-editor.webm', '-vf', 'fps=8,scale=960:-1:flags=lanczos', '-loop', '0', OUT + 'P-polygon-old-editor.gif']);
  } catch {
    /* no ffmpeg: the webm stands alone */
  }
}
const check = await browser.newContext({ storageState: state });
const cp = await check.newPage();
await cp.goto(UI + '/');
const count1 = await countOf(cp);
await browser.close();
ok(writes.length === 0 && count1 === count0, 'P-NO-DRAFT', 'copy, drag and vertex editing created no draft: no write at all', `writes ${writes.length}; requests ${count0} → ${count1}`);
ok(external.length === 0, 'P-NET', 'no request leaves the application');
ok(consoleErrors.length === 0, 'P-CONSOLE', 'no console error', consoleErrors.slice(0, 3).join(' | '));
writeFileSync(OUT + 'results.json', JSON.stringify({ ui: UI, at: new Date().toISOString(), site: rec.siteName, results, writes, external, consoleErrors }, null, 2));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} PASS`);
process.exit(failed ? 1 : 0);
