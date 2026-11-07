// The accepted Stationing editor's acceptance sequence (tests/acceptance/stationing-footprint.mjs, S4–S7 and S9) replayed
// on the V3 re-stationing step (owner decision of 5 Nov 2026: «restore the previous approved map interaction» into
// #restationing). Same window as the historical evidence (1440×900), same gestures, a frame per step named after the old
// one, one recording of the whole sequence. Everything happens in a NEW request before any save: every non-GET request
// is counted and must be zero. The old distance rule is NOT part of it (re-stationing has no distance restriction).
//
//   node tests/acceptance/geometry-old-sequence.mjs      (UI_URL default http://localhost:5180, AUTH_URL :8088)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { partVectors, proposedParts, recordOf, ringCentre, toNewSiteStep, toScreen } from './geometry-helpers.mjs';

const UI = process.env.UI_URL ?? 'http://localhost:5180';
const AUTH = process.env.AUTH_URL ?? 'http://localhost:8088';
// EVIDENCE_DIR=<folder> keeps a regression run's evidence apart from the accepted run's
const OUT = process.env.EVIDENCE_DIR ? process.env.EVIDENCE_DIR.replace(/[\/]?$/, '/') : fileURLToPath(new URL('../../docs/evidence/ui-rebuild/geometry-old-sequence/', import.meta.url));
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
const step = (pass, id, what, detail = '') => {
  results.push({ id, pass: !!pass, what, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} — ${what}${detail ? ' · ' + detail : ''}`);
};
const external = [];
const consoleErrors = [];
const writes = [];

const browser = await chromium.launch({ ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : { channel: 'msedge' }), headless: true });
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
  // the terrain analysis (6 Nov 2026) is a read-only POST — it carries a geometry and saves nothing — not a write
  if (q.method() !== 'GET' && !u.endsWith('/api/v1/stationing/terrain/assess')) writes.push(`${q.method()} ${u}`);
});
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(e.message));
const shot = (name) => page.screenshot({ path: OUT + name + '.png' });
const panel = page.locator('.stw-proposal-panel');
const read = async (label) => (await panel.locator('dt', { hasText: label }).locator('xpath=following-sibling::dd[1]').first().innerText()).trim();
const centre = async (loc) => {
  const b = await loc.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
// the historical test's drag: press, move in steps, release
const drag = async (from, dx, dy) => {
  await page.mouse.move(from.x, from.y, { steps: 6 });
  await page.waitForTimeout(250);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 14 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 14 });
  await page.waitForTimeout(250);
  await page.mouse.up();
  await page.waitForTimeout(900);
};

try {
  // S4 — start the proposal: a copy of the boundary with its own symbol; the original stays
  await toNewSiteStep(page, UI, rec.siteId, rec.orgName);
  await page.waitForTimeout(1800);
  const copy = await proposedParts(page);
  const a4 = await read('المساحة المقترحة');
  const cur4 = await read('المساحة الحالية');
  step(copy.length === 1 && (await page.locator('.stw-orig-sym').count()) === 1 && (await page.locator('.stw-prop-sym').count()) === 1 && a4 === cur4,
    'S4', 'بدء الاقتراح: نسخة من الحدود ورمز «مقترح»، والموقع الحالي ورمزه باقيان', `النسخة ${a4} = الحالية ${cur4}`);
  await shot('s04-proposal-copy');

  // S5 — drag from the SYMBOL, then again from the polygon BODY: one rigid object, area unchanged
  const before = await proposedParts(page);
  await drag(await centre(page.locator('.stw-prop-sym').first()), 150, -90);
  const mid = await proposedParts(page);
  const delta1 = await read('الفرق في المساحة');
  const dist = await panel.locator('.stw-live b').innerText();
  await shot('s05-dragged');
  const c = await toScreen(page, ringCentre(mid[0][0]));
  await drag({ x: c.x + 38, y: c.y + 38 }, -40, -20);
  const after = await proposedParts(page);
  const delta2 = await read('الفرق في المساحة');
  const v1 = partVectors(before, mid);
  const v2 = partVectors(mid, after);
  step(v1.metres > 100 && v2.metres > 20 && delta1 === '0٪' && delta2 === '0٪', 'S5', 'سحب الرمز ثم سحب المساحة نفسها: الحدود تنتقل جسماً واحداً والمساحة ثابتة',
    `من الرمز ${Math.round(v1.metres)} م ثم من المساحة ${Math.round(v2.metres)} م · فرق المساحة ${delta1} / ${delta2} · المسافة ${dist}`);

  // S6 — vertex editing: numbered handles on the map, drag one, undo, redo
  await page.getByRole('button', { name: 'تعديل الرؤوس' }).click();
  await page.getByRole('button', { name: '◎ المقترح' }).click();
  await page.waitForTimeout(900);
  const handles = await page.locator('.stw-vtx').count();
  const aBefore = await read('المساحة المقترحة');
  await drag(await centre(page.locator('.stw-vtx').first()), 30, 30);
  const aAfter = await read('المساحة المقترحة');
  const sides = await page.locator('.stw-edge').count();
  await shot('s06-vertex-edited');
  await page.getByRole('button', { name: '↶ تراجع' }).click();
  await page.waitForTimeout(500);
  const aUndo = await read('المساحة المقترحة');
  await page.getByRole('button', { name: '↷ إعادة' }).click();
  await page.waitForTimeout(500);
  const aRedo = await read('المساحة المقترحة');
  step(handles === 4 && sides === 4 && aAfter !== aBefore && aUndo === aBefore && aRedo === aAfter, 'S6', 'تعديل رأس مرقّم على الخريطة، ثم تراجع وإعادة',
    `${handles} رؤوس و${sides} أضلاع · قبل ${aBefore} ← بعد ${aAfter} · التراجع ${aUndo} · الإعادة ${aRedo}`);

  // S7 — «ب · رسم حدود جديدة» with «عدد الرؤوس» = 5: five clicks on the map close the shape
  await page.getByRole('tab', { name: 'ب · رسم حدود جديدة' }).click();
  await page.getByLabel('عدد الرؤوس').fill('5');
  await page.waitForTimeout(1200);
  const m = await page.locator('.tz-mapframe canvas.maplibregl-canvas').boundingBox();
  const cx = m.x + m.width * 0.3;
  const cy = m.y + m.height * 0.45;
  for (const [dx, dy] of [[0, -50], [48, -15], [30, 42], [-30, 42], [-48, -15]]) {
    await page.mouse.click(cx + dx, cy + dy);
    await page.waitForTimeout(450);
  }
  await page.waitForTimeout(1200);
  const v7 = await page.locator('.stw-vtx').count();
  const e7 = await page.locator('.stw-edge').count();
  const shape7 = await read('صحة الشكل');
  const area7 = await read('المساحة المقترحة');
  const drawn = await proposedParts(page);
  await shot('s07-drawn-5-vertices');
  step(v7 === 5 && e7 === 5 && shape7.includes('صالح') && drawn.length === 1 && drawn[0][0].length === 6 && (await page.locator('[data-testid=site-readout]').getAttribute('data-shape')) === 'DRAWN',
    'S7', 'رسم حدود جديدة باختيار عدد الرؤوس 5 بالنقر على الخريطة', `5 رؤوس مرقمة · ${e7} أطوال أضلاع · المساحة ${area7} · ${shape7}`);

  // S9 — compare the current site with the proposal
  await page.getByRole('button', { name: '⇆ مقارنة الموقعين' }).click();
  await page.waitForTimeout(1500);
  const dist9 = await panel.locator('.stw-live b').innerText();
  await shot('s09-compare');
  step((await page.locator('.stw-orig-sym').count()) === 1 && (await page.locator('.stw-prop-sym').count()) === 1, 'S9', 'مقارنة الموقع الحالي بالمقترح في عرض واحد',
    `الحالي بالأزرق والمقترح بالأخضر وخط المسافة · ${dist9}`);
  await page.waitForTimeout(1200);
} finally {
  const video = page.video();
  await ctx.close();
  renameSync(await video.path(), OUT + 'old-sequence-S4-S9.webm');
  rmSync(tmp, { recursive: true, force: true });
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', OUT + 'old-sequence-S4-S9.webm', '-vf', 'fps=8,scale=960:-1:flags=lanczos', '-loop', '0', OUT + 'old-sequence-S4-S9.gif']);
  } catch {
    /* no ffmpeg: the webm stands alone */
  }
}
const check = await browser.newContext({ storageState: state });
const cp = await check.newPage();
await cp.goto(UI + '/');
const count1 = await countOf(cp);
await browser.close();
step(writes.length === 0 && count1 === count0, 'NO-DRAFT', 'النسخ والسحب وتعديل الرؤوس والرسم والمقارنة لم تُنشئ مسودة: لا كتابة إطلاقاً', `writes ${writes.length}; requests ${count0} → ${count1}`);
step(external.length === 0, 'NET', 'لا طلب يخرج من التطبيق');
step(consoleErrors.length === 0, 'CONSOLE', 'لا خطأ في وحدة التحكم', consoleErrors.slice(0, 3).join(' | '));
writeFileSync(OUT + 'results.json', JSON.stringify({ ui: UI, at: new Date().toISOString(), site: rec.siteName, results, writes, external, consoleErrors }, null, 2));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} PASS`);
process.exit(failed ? 1 : 0);
