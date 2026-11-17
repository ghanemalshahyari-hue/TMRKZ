// OWNER REVIEW — «إعادة تنظيم التمركز والمواقع ومناطق الانتشار», phase 1 (owner, 17 Nov 2026): the three ways of stationing as
// tabs of the top bar right after «الرئيسية» (no page in between), with their symbols; quieter colours; the dark theme in graphite
// and sand. On http://localhost:8088 as the platform administrator (who may take all three ways), in both themes. Headless Edge,
// nothing outside localhost. Screens: docs/evidence/stationing-redesign/phase1/.
//   node tests/acceptance/stationing-hub-phase1.mjs
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)).split(String.fromCharCode(92)).join('/');
const BASE = process.env.MOVER_URL ?? 'http://localhost:8088';
const OUT = ROOT + 'docs/evidence/stationing-redesign/phase1/';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const { chromium } = await import(pathToFileURL(ROOT + 'tests/acceptance/node_modules/playwright-core/index.mjs').href);
const ADMIN_PW = readFileSync(ROOT + '.env', 'utf8').match(/^TMRKZ_PLATFORM_ADMIN_PASSWORD=(.*)$/m)[1].trim();

const login = await fetch(BASE + '/api/v1/auth/directory/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mover' }, body: JSON.stringify({ username: 'admin', password: ADMIN_PW }) });
if (login.status !== 200) throw new Error('admin sign-in ' + login.status);
const cookies = login.headers.getSetCookie().map((c) => c.split(';')[0]).map((c) => ({ name: c.slice(0, c.indexOf('=')), value: c.slice(c.indexOf('=') + 1), url: BASE }));

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const external = [];
const results = [];
const ok = (pass, what, detail = '') => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'} ${what}${detail ? ' · ' + detail : ''}`); };
const TABS = [['SITE_SETUP', 'تحديد مواقع التمركز المبدئية', 'siteSetup'], ['DEPLOYMENT_AREAS', 'طلب مناطق انتشار', 'restationing'], ['RESTATIONING', 'طلب إعادة تمركز', 'restationing']];

async function context(theme, signedIn = true) {
  const ctx = await browser.newContext({ locale: 'ar-AE', timezoneId: 'Asia/Dubai', viewport: { width: 1440, height: 900 } });
  if (signedIn) await ctx.addCookies(cookies);
  await ctx.addInitScript((t) => { try { localStorage.setItem('tmrkz-theme', t); } catch {} }, theme);
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (!['localhost', '127.0.0.1'].includes(u.hostname) && !/^(data|blob):/.test(u.protocol)) { external.push(u.href); return route.abort('blockedbyclient'); }
    return route.continue();
  });
  return [ctx, await ctx.newPage()];
}

for (const theme of ['light', 'dark']) {
  const [ctx, page] = await context(theme);
  await page.goto(BASE + '/#home');
  await page.waitForSelector('main#main', { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}01-top-bar-tabs-${theme}.png` });
  await page.locator('.tz-top').screenshot({ path: `${OUT}02-top-bar-close-${theme}.png` });
  if (theme === 'light') {
    const bar = await page.locator('.tz-nav > a').evaluateAll((els) => els.map((e) => e.getAttribute('data-nav') + '=' + e.textContent.trim()));
    ok(bar.slice(1, 4).join(' | ') === TABS.map(([k, t]) => `${k}=${t}`).join(' | '), 'the three ways are tabs right after «الرئيسية», in the reference order', bar.slice(0, 5).join(' | '));
    ok((await page.locator('[data-nav=SITE_SETUP] svg, [data-nav=DEPLOYMENT_AREAS] svg, [data-nav=RESTATIONING] svg').count()) === 3, 'each tab carries its symbol');
  }
  // one click opens the work, and only that tab is highlighted
  for (const [key, , view] of TABS) {
    await page.locator(`[data-nav=${key}]`).click();
    await page.waitForTimeout(2500);
    const lit = await page.locator('.tz-nav > a.active').evaluateAll((els) => els.map((e) => e.getAttribute('data-nav')));
    if (theme === 'light') ok((await page.locator('.tz-app').getAttribute('data-view')) === view && lit.join() === key, `«${key}»: one click opens its screen, only this tab is highlighted`, `${page.url().replace(BASE, '')} · active=${lit.join()}`);
    await page.screenshot({ path: `${OUT}03-${key.toLowerCase()}-${theme}.png` });
  }
  await ctx.close();
}
// the sign-in page in the dark theme (graphite and sand, as the application)
const [sctx, spage] = await context('dark', false);
await spage.goto(BASE + '/');
await spage.waitForTimeout(2000);
await spage.screenshot({ path: `${OUT}04-sign-in-dark.png` });
await sctx.close();
ok(!external.length, 'nothing outside localhost', external.slice(0, 2).join(' '));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
