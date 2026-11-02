// Drives the REAL TMRKZ stationing workspace at http://localhost:8088 in headed Microsoft Edge and measures the drag.
// Signs in as a fictional requester (test env), reaches the «طلب تمركز» proposal marker, injects a frame sampler +
// MutationObservers, performs a scripted drag, and reports measured numbers. Run once per build to compare before/after:
//   LABEL=before node real-drive.mjs    (against the currently deployed build)
//   ...rebuild web... LABEL=after node real-drive.mjs
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'evidence');
mkdirSync(OUT, { recursive: true });
const BASE = process.env.MOVER_URL ?? 'http://localhost:8088';
const LABEL = process.env.LABEL ?? 'run';
const USER = process.env.USER_LOGIN ?? 't.requester';
const PASSWORD = process.env.TMRKZ_TEST_PASSWORD ?? readFileSync(join(HERE, '../../ops/test-env/.generated/user-password'), 'utf8').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SAMPLER = () => {
  const rt = { frames: [], lastT: 0, on: false, panelMut: 0, markerChild: 0, long: 0, longMs: 0 };
  window.__rt = rt;
  const loop = (t) => { if (rt.on) { if (rt.lastT) rt.frames.push(t - rt.lastT); rt.lastT = t; } else rt.lastT = 0; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  const panel = document.querySelector('.stw-panel');
  if (panel) { rt.pObs = new MutationObserver((ms) => { if (rt.on) rt.panelMut += ms.length; }); rt.pObs.observe(panel, { subtree: true, childList: true, attributes: true, characterData: true }); }
  const pane = document.querySelector('.leaflet-marker-pane');
  if (pane) { rt.mObs = new MutationObserver((ms) => { if (rt.on) for (const m of ms) if (m.type === 'childList') rt.markerChild += m.addedNodes.length + m.removedNodes.length; }); rt.mObs.observe(pane, { subtree: true, childList: true }); }
  try { rt.po = new PerformanceObserver((l) => { for (const e of l.getEntries()) if (rt.on) { rt.long++; rt.longMs += e.duration; } }); rt.po.observe({ entryTypes: ['longtask'] }); } catch (e) { /* unsupported */ }
};
const STATS = () => {
  const rt = window.__rt; const xs = rt.frames.slice().sort((a, b) => a - b);
  const q = (p) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : 0);
  const mean = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  return { frames: xs.length, meanMs: +mean.toFixed(2), p95Ms: +q(0.95).toFixed(2), worstMs: +(xs[xs.length - 1] ?? 0).toFixed(2), fpsMean: +(mean ? 1000 / mean : 0).toFixed(1), janky: xs.filter((d) => d > 25).length, longTasks: rt.long, longTaskMs: +rt.longMs.toFixed(1), panelMutations: rt.panelMut, markerChildMutations: rt.markerChild };
};

async function run() {
  const browser = await chromium.launch({ channel: 'msedge', headless: !!process.env.HEADLESS, slowMo: Number(process.env.SLOWMO ?? 0) });
  const ctx = await browser.newContext({ locale: 'ar-AE', timezoneId: 'Asia/Dubai', viewport: { width: 1440, height: 900 } });
  const external = [];
  await ctx.route('**/*', (route) => { const u = new URL(route.request().url()); if (!['localhost', '127.0.0.1'].includes(u.hostname) && !u.protocol.startsWith('data') && !u.protocol.startsWith('blob')) { external.push(u.href); return route.abort('blockedbyclient'); } return route.continue(); });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|401|403|404|409|400|ERR_ABORTED/.test(m.text())) errs.push(m.text()); });

  // sign in (real Keycloak + fictional directory)
  await page.goto(BASE + '/');
  await page.getByText('الدخول الآلي بالحساب المؤسسي').click();
  await page.locator('#username').fill(USER);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('#kc-login').click();
  await page.waitForSelector('.app-shell', { timeout: 30000 });

  // open the stationing workspace
  await page.evaluate(() => { location.hash = 'stationing'; });
  await page.waitForSelector('.stw-top-search input', { timeout: 20000 });

  // pick a site via the top search (sets the site and its responsible organisation), then «طلب تمركز»
  await page.locator('.stw-top-search input').fill('مركز الخدمات');
  await page.waitForSelector('.stw-search-pop', { timeout: 15000 });
  await page.locator('.stw-search-pop button', { hasText: 'مركز الخدمات' }).first().click();
  await page.waitForSelector('.stw-popup', { timeout: 15000 });
  await page.getByRole('button', { name: /طلب تمركز/ }).click();

  // the proposal marker appears once the server returns the rule and the point is placed
  await page.waitForSelector('.stw-proposal .stw-pin', { timeout: 25000 });
  await sleep(1200);
  await page.screenshot({ path: join(OUT, 'real-' + LABEL + '-1-ready.png') });

  await page.evaluate(SAMPLER);
  const box = await page.locator('.stw-proposal .stw-pin').boundingBox();
  const sx = box.x + box.width / 2, sy = box.y + box.height / 2;
  const lerp = (a, b, t) => a + (b - a) * t;
  const path = [];
  for (let i = 0; i <= 28; i++) path.push([lerp(sx, sx - 150, i / 28), lerp(sy, sy - 30, i / 28)]);
  for (let i = 1; i <= 30; i++) path.push([lerp(sx - 150, sx + 190, i / 30), lerp(sy - 30, sy + 110, i / 30)]);
  for (let i = 1; i <= 26; i++) path.push([lerp(sx + 190, sx - 10, i / 26), lerp(sy + 110, sy - 10, i / 26)]);

  await page.evaluate(() => { window.__rt.on = true; });
  await page.mouse.move(sx, sy); await page.mouse.down();
  for (const [x, y] of path) { await page.mouse.move(x, y, { steps: 1 }); await sleep(9); }
  await page.screenshot({ path: join(OUT, 'real-' + LABEL + '-2-drag.png') });
  await page.mouse.up();
  await sleep(120);
  await page.evaluate(() => { window.__rt.on = false; });
  const stats = await page.evaluate(STATS);
  await sleep(400);
  await page.screenshot({ path: join(OUT, 'real-' + LABEL + '-3-drop.png') });

  // pan + zoom to confirm the camera stays responsive and does not fight the drag
  await page.mouse.move(760, 460); await page.mouse.down(); await page.mouse.move(620, 380, { steps: 12 }); await page.mouse.up();
  await page.mouse.wheel(0, -220); await sleep(400);
  await page.screenshot({ path: join(OUT, 'real-' + LABEL + '-4-panzoom.png') });

  const result = { label: LABEL, base: BASE, user: USER, when: new Date().toISOString(), external, errors: errs.slice(0, 6), stats };
  writeFileSync(join(OUT, 'real-' + LABEL + '.json'), JSON.stringify(result, null, 2));
  console.log(LABEL, JSON.stringify(stats), 'external=' + external.length, 'errs=' + errs.length);
  await ctx.close();
  await browser.close();
}
run().catch((e) => { console.error(e); process.exit(1); });
