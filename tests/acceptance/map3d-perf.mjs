// The 3D map's rendering cost (owner, 17 Nov 2026: "fix the rendering slowness for the 3D map"), measured on http://localhost:8088
// in Edge at 1440×900 on «تحديد مواقع التمركز المبدئية»: after «3D» is pressed, how many map tiles are fetched and how long until
// the map settles (no tile request for 1.5 s); then the frame times while the map is panned for three seconds. Three runs; the
// median is printed. Headless Edge draws with the machine's GPU when it can — compare runs on the same machine only.
//   node tests/acceptance/map3d-perf.mjs [label]
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)).split(String.fromCharCode(92)).join('/');
const BASE = process.env.MOVER_URL ?? 'http://localhost:8088';
const { chromium } = await import(pathToFileURL(ROOT + 'tests/acceptance/node_modules/playwright-core/index.mjs').href);
const ADMIN_PW = readFileSync(ROOT + '.env', 'utf8').match(/^TMRKZ_PLATFORM_ADMIN_PASSWORD=(.*)$/m)[1].trim();
const login = await fetch(BASE + '/api/v1/auth/directory/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mover' }, body: JSON.stringify({ username: 'admin', password: ADMIN_PW }) });
const cookies = login.headers.getSetCookie().map((c) => c.split(';')[0]).map((c) => ({ name: c.slice(0, c.indexOf('=')), value: c.slice(c.indexOf('=') + 1), url: BASE }));
const browser = await chromium.launch({ channel: 'msedge', headless: process.env.HEADED !== '1', args: ['--window-position=-3000,0', '--window-size=1440,900', ...(process.env.SOFTWARE === '1' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [])] });
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const runs = [];
for (let i = 0; i < 3; i++) {
  const ctx = await browser.newContext({ locale: 'ar-AE', viewport: { width: 1440, height: 900 }, deviceScaleFactor: Number(process.env.DPR ?? 1) });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  let tiles = 0;
  let last = Date.now();
  page.on('request', (r) => { if (r.url().includes('/map-data/')) { tiles++; last = Date.now(); } });
  await page.goto(BASE + '/#siteSetup');
  await page.waitForSelector('.maplibregl-canvas', { timeout: 30000 });
  await page.waitForTimeout(4000);
  tiles = 0;
  const t0 = Date.now();
  last = t0;
  await page.getByRole('button', { name: '3D', exact: true }).click();
  while (Date.now() - last < 1500 && Date.now() - t0 < 60000) await page.waitForTimeout(100);
  const settle = last - t0;
  const fetched = tiles;
  // the browser's own counters while panning: main-thread busy time (MapLibre's per-frame work runs there) and frames drawn
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const m0 = await metric();
  await page.evaluate(() => { window.__ft = []; let p = performance.now(); const f = (t) => { window.__ft.push(t - p); p = t; if (window.__ft.length < 2000) requestAnimationFrame(f); }; requestAnimationFrame(f); });
  const box = await page.locator('.maplibregl-canvas').first().boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let k = 0; k < 60; k++) { await page.mouse.move(cx + 200 * Math.sin(k / 9), cy + 120 * Math.cos(k / 9)); await page.waitForTimeout(50); }
  await page.mouse.up();
  const m1 = await metric();
  const ft = await page.evaluate(() => window.__ft.slice(2));
  const sorted = [...ft].sort((a, b) => a - b);
  runs.push({ settleMs: settle, tiles: fetched, busyMs: Math.round((m1.TaskDuration - m0.TaskDuration) * 1000), scriptMs: Math.round((m1.ScriptDuration - m0.ScriptDuration) * 1000), frames: ft.length, avgMs: ft.reduce((a, b) => a + b, 0) / ft.length, p95Ms: sorted[Math.floor(sorted.length * 0.95)] });
  await ctx.close();
}
await browser.close();
const out = { label: process.argv[2] ?? '', settleMs: median(runs.map((r) => r.settleMs)), tiles: median(runs.map((r) => r.tiles)), busyMs: median(runs.map((r) => r.busyMs)), scriptMs: median(runs.map((r) => r.scriptMs)), avgFrameMs: +median(runs.map((r) => r.avgMs)).toFixed(1), p95FrameMs: +median(runs.map((r) => r.p95Ms)).toFixed(1), runs };
console.log(JSON.stringify(out));
