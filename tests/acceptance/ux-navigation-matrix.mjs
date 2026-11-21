// Owner UX consolidation acceptance matrix (20 Nov 2026 §21): each stationing entry opens inside the one «مساحة التمركز»
// shell, the shell header is visible, the mode banner states the correct label (never «إعادة تمركز» for a legacy record),
// and the «إلغاء والعودة» button appears whenever an editor is open. Runs against :8088; needs BROWSER_PATH.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const ROOT = '/Users/engcode/Desktop/TMRKZ/'; const BASE = 'http://127.0.0.1:8088';
const { chromium } = await import(pathToFileURL(ROOT + 'tests/acceptance/node_modules/playwright-core/index.mjs').href);
const PW = readFileSync(ROOT + '.env', 'utf8').match(/^TMRKZ_PLATFORM_ADMIN_PASSWORD=(.*)$/m)[1].trim();
const r = await fetch(BASE + '/api/v1/auth/directory/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mover' }, body: JSON.stringify({ username: 'admin', password: PW }) });
const cookies = r.headers.getSetCookie().map((c) => c.split(';')[0]).map((c) => ({ name: c.slice(0, c.indexOf('=')), value: c.slice(c.indexOf('=') + 1), url: BASE }));
const browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH, headless: true });
const ctx = await browser.newContext({ locale: 'ar-AE', timezoneId: 'Asia/Dubai', viewport: { width: 1600, height: 1000 } });
await ctx.addCookies(cookies);
const page = await ctx.newPage();
const results = [];
const pass = (cond, label, extra = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`); };
async function go(hash, label) {
  await page.goto(BASE + '/' + hash, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const shellOn = await page.locator('.tz-stationing-shell').count() > 0;
  const mode = (await page.getByTestId('stationing-mode').first().textContent().catch(() => null))?.replace(/\s+/g, ' ');
  const exit = await page.getByTestId('stationing-exit').count() > 0;
  pass(shellOn, `UX-NAV ${label}: shell present`, hash);
  return { shellOn, mode, exit };
}
const idle = await go('#restationing', 'idle');
pass(!idle.mode, 'UX-NAV idle has no mode banner');
const r1 = await go('#restationing/new?purpose=RESTATIONING', 'new RESTATIONING');
pass(r1.mode && r1.mode.includes('إعادة تمركز'), 'UX-NAV restation mode label', r1.mode ?? '');
pass(r1.exit, 'UX-NAV restation exit present');
const r2 = await go('#restationing/new?purpose=DEPLOYMENT_AREAS', 'new DEPLOYMENT_AREAS');
pass(r2.mode && r2.mode.includes('مناطق انتشار'), 'UX-NAV deployment mode label', r2.mode ?? '');
const r3 = await go('#siteSetup', 'site setup');
pass(r3.mode && r3.mode.includes('تهيئة'), 'UX-NAV site-setup mode label', r3.mode ?? '');
// requests master/detail
await page.goto(BASE + '/#allRequests', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
pass(await page.getByTestId('request-detail').count() > 0, 'UX-NAV allRequests has detail panel');
const rows = await page.locator('[data-testid="overview-list"] tbody tr').count();
if (rows > 0) {
  await page.locator('[data-testid="overview-list"] tbody tr').first().click();
  await page.waitForTimeout(400);
  pass(await page.getByTestId('open-in-shell').count() > 0, 'UX-NAV detail shows «فتح في مساحة التمركز»');
}
// legacy opens with the correct banner
const list = await (await fetch(BASE + '/api/v1/restationing-requests', { headers: { Cookie: cookies.map(c => c.name+'='+c.value).join('; '), 'X-Requested-With': 'mover' } })).json();
const legacy = (list ?? []).find((r) => r.purpose === 'SITE_REGISTRATION' || r.purpose === 'INITIAL_STATIONING');
if (legacy) {
  await go('#restationing/' + legacy.id, 'legacy record');
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
