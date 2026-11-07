// Both colour themes on the real pages (owner, 6 Nov 2026): the switch, that the sign-in page shares the application's colours,
// and the contrast of every visible text, measured. Reads only; nothing is saved.
//
//   node tests/acceptance/theme-contrast.mjs     BROWSER_PATH (Chrome or Edge), UI_URL, OUT
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const UI = process.env.UI_URL ?? 'http://localhost:8088';
const OUT = process.env.OUT ?? fileURLToPath(new URL('../../docs/evidence/theme/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const PASSWORD = (readFileSync(new URL('../../.env', import.meta.url), 'utf8').match(/^TMRKZ_PLATFORM_DEVELOPER_PASSWORD=(.*)$/m) ?? [])[1];
const { chromium } = createRequire(new URL('./package.json', import.meta.url))('playwright-core');
const results = [];
const ok = (pass, id, what, detail = '') => {
  results.push({ id, pass: !!pass, what, detail: String(detail).slice(0, 600) });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} — ${what}${detail ? ' · ' + String(detail).slice(0, 260) : ''}`);
};
const VIEWS = (process.env.VIEWS ?? 'home,map,org,requests,review,calendar,stationing,restationing,workflow,forms,permissions,permissions/matrix,settings,audit,reports,docs').split(',');

/** In the page: text whose contrast on what is behind it is under WCAG AA. */
function audit() {
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const behind = (el) => {
    const stack = [];
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      // a gradient is measured by its most opaque colour, so text over one is not left out
      const stops = s.backgroundImage === 'none' ? [] : (s.backgroundImage.match(/rgba?\([^)]+\)/g) ?? []).map(parse).sort((x, y) => y.a - x.a);
      const c = stops.length && stops[0].a > 0.5 ? stops[0] : parse(s.backgroundColor);
      if (c && c.a > 0) {
        stack.push(c);
        if (c.a >= 0.999) break;
      }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
    return { base };
  };
  const found = new Map();
  let measured = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent.trim();
    const el = n.parentElement;
    if (!text || !el || el.closest('.maplibregl-map, .leaflet-container, svg, option, script, style, [aria-hidden="true"], .fs-handle-label')) continue; // the label sits below its handle, on the card
    const box = el.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || el.closest('[hidden]') || el.closest(':disabled')) continue;
    const { base } = behind(el);
    const c = parse(s.color);
    if (!c) continue;
    const fg = over(c, base);
    const hi = Math.max(lum(fg), lum(base));
    const lo = Math.min(lum(fg), lum(base));
    const ratio = (hi + 0.05) / (lo + 0.05);
    const size = parseFloat(s.fontSize);
    const need = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700) ? 3 : 4.5;
    measured++;
    if (ratio < need) {
      const key = (el.className && typeof el.className === 'string' ? el.tagName.toLowerCase() + '.' + el.className.trim().split(/\s+/).join('.') : el.tagName.toLowerCase()) + ' ' + s.color + ' on ' + `rgb(${Math.round(base.r)},${Math.round(base.g)},${Math.round(base.b)})`;
      if (!found.has(key)) found.set(key, `${ratio.toFixed(2)} «${text.slice(0, 24)}» ${key}`);
    }
  }
  const brightPanels = document.documentElement.dataset.theme === 'dark'
    ? [...document.querySelectorAll('main *')].filter((e) => {
        const c = parse(getComputedStyle(e).backgroundColor);
        const b = e.getBoundingClientRect();
        return c && c.a > 0.9 && lum(c) > 0.6 && b.width > 120 && b.height > 40 && !e.closest('.maplibregl-map, .leaflet-container');
      }).slice(0, 6).map((e) => e.tagName.toLowerCase() + '.' + String(e.className).slice(0, 50))
    : [];
  return { measured, low: [...found.values()], brightPanels };
}

const browser = await chromium.launch({ ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : { channel: 'msedge' }), headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));

await page.goto(UI + '/');
await page.waitForSelector('.tm-card');
ok((await page.evaluate(() => document.documentElement.dataset.theme)) === 'light', 'T01', 'with no choice, the sand');
const sand = await page.evaluate(() => getComputedStyle(document.querySelector('.tm')).backgroundColor);
ok(sand === 'rgb(249, 247, 237)', 'T01a', 'the sign-in page is the original sand', sand);
await page.getByTestId('theme-toggle').click();
ok((await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark', 'T02', 'the sign-in page has the switch');
const groundDark = await page.evaluate(() => getComputedStyle(document.querySelector('.tm')).backgroundColor);
await page.screenshot({ path: OUT + 'A-signin-dark.png' });
const signDark = await page.evaluate(audit);
ok(signDark.low.length === 0, 'T03', 'sign-in, dark: contrast', signDark.low.join(' | '));
await page.getByTestId('theme-toggle').click();
const groundLight = await page.evaluate(() => getComputedStyle(document.querySelector('.tm')).backgroundColor);
await page.screenshot({ path: OUT + 'A-signin-light.png' });
const signLight = await page.evaluate(audit);
ok(signLight.low.length === 0, 'T04', 'sign-in, light: contrast', signLight.low.join(' | '));

await page.goto(UI + '/api/v1/auth/oidc/start');
await page.waitForSelector('#kc-form-login', { timeout: 30000 });
ok((await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'light', 'T05', 'the identity sign-in page keeps the choice');
await page.locator('#tm-theme').click();
ok((await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'dark', 'T06', 'and has the switch');
await page.screenshot({ path: OUT + 'B-identity-dark.png' });
await page.fill('#username', 'developer');
await page.fill('#password', PASSWORD);
await page.click('#kc-login');
await page.waitForSelector('main#main', { timeout: 30000 });
ok((await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark', 'T07', 'the application keeps the choice after signing in');
const insideDark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
ok(insideDark === groundDark, 'T08', 'dark: the sign-in ground and the application are one colour', `${groundDark} · ${insideDark}`);

for (const theme of ['dark', 'light']) {
  await page.evaluate((t) => localStorage.setItem('tmrkz-theme', t), theme);
  await page.goto(UI + '/#home');
  await page.reload();
  await page.waitForSelector('main#main');
  for (const view of VIEWS) {
    await page.goto(UI + '/#' + view);
    if (view.includes('/')) await page.reload(); // a tab is read when the page opens
    await page.waitForTimeout(1500);
    if (view === 'permissions/matrix') {
      const matrix = page.getByTestId('unit-matrix');
      await matrix.getByPlaceholder(/ابحث/).first().fill(process.env.MATRIX_UNIT ?? 'عمليات');
      await matrix.locator('.tree-note, button').filter({ hasText: process.env.MATRIX_UNIT ?? 'عمليات' }).first().click();
      await page.waitForTimeout(1500);
    }
    const name = view.replace('/', '-');
    await page.screenshot({ path: OUT + `${theme}-${name}.png` });
    const a = await page.evaluate(audit);
    ok(a.low.length === 0 && a.brightPanels.length === 0, `${theme}/${view}`, `${a.measured} texts`, [...a.low, ...a.brightPanels.map((b) => 'bright panel ' + b)].join(' | '));
  }
}
await page.goto(UI + '/#home');
await page.waitForSelector('main#main');
const insideLight = await page.evaluate(() => getComputedStyle(document.querySelector('.tz-main')).backgroundColor + '|' + getComputedStyle(document.body).backgroundColor);
ok(insideLight.includes(groundLight), 'T09', 'light: the sign-in ground and the application are one colour', `${groundLight} · ${insideLight}`);
ok(errors.length === 0, 'T10', 'no browser errors', errors.join(' | '));
writeFileSync(OUT + 'results.json', JSON.stringify({ at: new Date().toISOString(), results }, null, 1) + '\n');
await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
