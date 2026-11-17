// OWNER REVIEW — «PROFESSIONAL FLUID RESPONSIVE LAYOUT PASS» (owner, 18 Nov 2026). On http://localhost:8088 in Edge:
// the home page at 1280×720, 1366×768, 1440×900, 1920×1080, 2560×1440, 3440×1440 and 3840×2160, resized LIVE in one page
// (no reload): no horizontal scroll, the dashboard as wide as the window, its grid down to the bottom of the window, the
// map canvas the size of its card after every resize. Then the deployment-areas request narrow and maximised, and the
// re-stationing screen maximised (a synthetic requester). Screens: docs/evidence/responsive-layout/.
//   OTHER=juma.ghfly4 node tests/acceptance/responsive-layout.mjs
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)).split(String.fromCharCode(92)).join('/');
const BASE = process.env.MOVER_URL ?? 'http://localhost:8088';
const OUT = ROOT + 'docs/evidence/responsive-layout/';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const { chromium } = await import(pathToFileURL(ROOT + 'tests/acceptance/node_modules/playwright-core/index.mjs').href);
const signIn = async (username, password) => {
  const r = await fetch(BASE + '/api/v1/auth/directory/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mover' }, body: JSON.stringify({ username, password }) });
  if (r.status !== 200) throw new Error(`${username} sign-in ${r.status}`);
  return r.headers.getSetCookie().map((c) => c.split(';')[0]).map((c) => ({ name: c.slice(0, c.indexOf('=')), value: c.slice(c.indexOf('=') + 1), url: BASE }));
};
const admin = await signIn('admin', readFileSync(ROOT + '.env', 'utf8').match(/^TMRKZ_PLATFORM_ADMIN_PASSWORD=(.*)$/m)[1].trim());
const other = await signIn(process.env.OTHER ?? 'juma.ghfly4', readFileSync(ROOT + 'ops/acceptance-main/.generated/mover-ldap-test-password', 'utf8').trim());

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
const ok = (pass, what, detail = '') => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'} ${what}${detail ? ' · ' + detail : ''}`); };
const SIZES = [[1280, 720], [1366, 768], [1440, 900], [1920, 1080], [2560, 1440], [3440, 1440], [3840, 2160]];

/** What the layout does at this size: overflow, the dashboard's width, the space left under its grid, the map against its card. */
const measure = (page) => page.evaluate(() => {
  const r = (sel) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
  const home = r('.tz-home');
  const grid = r('.tz-home-grid');
  const box = r('.tz-home-mapbox');
  const canvas = document.querySelector('.tz-home-mapbox canvas');
  const scroller = document.querySelector('.tz-main');
  const tiles = [...document.querySelectorAll('.tz-tiles .tz-tile')].map((t) => t.getBoundingClientRect());
  const rows = new Set(tiles.map((t) => Math.round(t.top)));
  return {
    vw: innerWidth, vh: innerHeight,
    hscroll: document.documentElement.scrollWidth - innerWidth,
    homeW: home ? Math.round(home.width) : 0,
    gridBottomGap: grid ? Math.round(innerHeight - grid.bottom) : null,
    pageScrolls: scroller ? scroller.scrollHeight - scroller.clientHeight : 0,
    map: box && canvas ? { box: [Math.round(box.width), Math.round(box.height)], canvas: [Math.round(canvas.getBoundingClientRect().width), Math.round(canvas.getBoundingClientRect().height)] } : null,
    tileRows: rows.size, tiles: tiles.length, tileHeights: [...new Set(tiles.map((t) => Math.round(t.height)))],
    font: getComputedStyle(document.querySelector('.tz-home-title h1') ?? document.body).fontSize,
  };
});

// the home page, one page resized live through every size
{
  const ctx = await browser.newContext({ locale: 'ar-AE', timezoneId: 'Asia/Dubai', viewport: { width: 1280, height: 720 } });
  await ctx.addCookies(admin);
  await ctx.addInitScript(() => { try { localStorage.setItem('tmrkz-theme', 'dark'); } catch {} });
  const page = await ctx.newPage();
  await page.goto(BASE + '/#home');
  await page.waitForSelector('.tz-home-mapbox canvas', { timeout: 30000 });
  await page.waitForTimeout(3000);
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(1200);
    const m = await measure(page);
    const mapFits = m.map && Math.abs(m.map.box[0] - m.map.canvas[0]) <= 2 && Math.abs(m.map.box[1] - m.map.canvas[1]) <= 2;
    const usesWidth = m.homeW >= w - 2;
    // the grid reaches the bottom (within the page's gutter) unless the page is taller than the window by design (tablet)
    const usesHeight = m.gridBottomGap != null && m.gridBottomGap >= -2 && m.gridBottomGap <= 40;
    ok(m.hscroll <= 0 && usesWidth && usesHeight && mapFits, `${w}×${h}: full width, grid down to the bottom, map canvas = its card, no horizontal scroll`,
      `home ${m.homeW}px · gap under grid ${m.gridBottomGap}px · map ${m.map?.box.join('×')} / canvas ${m.map?.canvas.join('×')} · indicators ${m.tiles} in ${m.tileRows} row(s), heights ${m.tileHeights.join('/')} · title ${m.font}`);
    await page.screenshot({ path: `${OUT}home-${w}x${h}.png` });
  }
  // back and forth again: nothing stays at a previous size
  for (const [w, h] of [[1920, 1080], [1366, 768], [3440, 1440]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(900);
    const m = await measure(page);
    ok(m.map && Math.abs(m.map.box[0] - m.map.canvas[0]) <= 2 && m.homeW >= w - 2, `live resize to ${w}×${h} again: the dashboard and the map follow without a reload`, `${m.homeW}px · map ${m.map?.box.join('×')} / ${m.map?.canvas.join('×')}`);
  }
  await ctx.close();
}

// the work screens: the deployment-areas request narrow and maximised, the re-stationing screen maximised
for (const [name, nav, w, h] of [['deployment-request', 'DEPLOYMENT_AREAS', 1280, 720], ['deployment-request', 'DEPLOYMENT_AREAS', 2560, 1440], ['restationing', 'RESTATIONING', 1366, 768], ['restationing', 'RESTATIONING', 2560, 1440], ['site-setup', 'SITE_SETUP', 1280, 720], ['site-setup', 'SITE_SETUP', 2560, 1440]]) {
  const asAdmin = nav === 'SITE_SETUP';
  const ctx = await browser.newContext({ locale: 'ar-AE', timezoneId: 'Asia/Dubai', viewport: { width: w, height: h } });
  await ctx.addCookies(asAdmin ? admin : other);
  await ctx.addInitScript(() => { try { localStorage.setItem('tmrkz-theme', 'dark'); } catch {} });
  const page = await ctx.newPage();
  await page.goto(BASE + '/#home');
  await page.waitForSelector('main#main', { timeout: 30000 });
  await page.locator(`[data-nav=${nav}]`).click();
  await page.waitForSelector('.maplibregl-canvas', { timeout: 30000 });
  await page.waitForTimeout(3500);
  const m = await page.evaluate(() => {
    const c = document.querySelector('.tz-console')?.getBoundingClientRect();
    const canvas = document.querySelector('.maplibregl-canvas')?.getBoundingClientRect();
    const host = document.querySelector('.maplibregl-map')?.getBoundingClientRect();
    const spill = [...document.querySelectorAll('.tz-console > .tz-col')].filter((k) => k.scrollWidth > k.clientWidth + 1).map((k) => k.className);
    return { spill, hscroll: document.documentElement.scrollWidth - innerWidth, console: c ? [Math.round(c.width), Math.round(c.height)] : null, canvas: canvas ? [Math.round(canvas.width), Math.round(canvas.height)] : null, host: host ? [Math.round(host.width), Math.round(host.height)] : null, bottomGap: c ? Math.round(innerHeight - c.bottom) : null };
  });
  const fits = m.canvas && m.host && Math.abs(m.canvas[0] - m.host[0]) <= 2 && Math.abs(m.canvas[1] - m.host[1]) <= 2;
  ok(m.hscroll <= 0 && m.console && m.console[0] >= w - 2 && m.bottomGap <= 2 && fits && !m.spill.length, `${name} at ${w}×${h}: the workspace fills the window, the map canvas fills its frame, no panel spills over the map`, `workspace ${m.console?.join('×')} · map ${m.host?.join('×')} / canvas ${m.canvas?.join('×')}${m.spill.length ? ' · spills: ' + m.spill.join(', ') : ''}`);
  await page.screenshot({ path: `${OUT}${name}-${w}x${h}.png` });
  await ctx.close();
}
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
