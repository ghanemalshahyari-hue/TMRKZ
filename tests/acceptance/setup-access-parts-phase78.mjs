// «إعادة تنظيم التمركز والمواقع ومناطق الانتشار», phases 7 and 8 (owner brief §3, §6): «صلاحيات تهيئة المواقع» in the
// settings, and «الاعتماد الجزئي» on a re-stationing under review. On http://localhost:8088 as the platform administrator.
// For phase 8 the administrator is given «معتمد عمليات الوحدة» on the request's unit for this run only (through the product's
// own /memberships, audited) and the grant is ended at the end; nothing is decided, nothing in the rule is saved.
//   RS=RS-2026-0004 node tests/acceptance/setup-access-parts-phase78.mjs
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)).split(String.fromCharCode(92)).join('/');
const BASE = process.env.MOVER_URL ?? 'http://localhost:8088';
const OUT = ROOT + 'docs/evidence/stationing-redesign/phase7-8/';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const { chromium } = await import(pathToFileURL(ROOT + 'tests/acceptance/node_modules/playwright-core/index.mjs').href);
const ADMIN_PW = readFileSync(ROOT + '.env', 'utf8').match(/^TMRKZ_PLATFORM_ADMIN_PASSWORD=(.*)$/m)[1].trim();
const login = await fetch(BASE + '/api/v1/auth/directory/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mover' }, body: JSON.stringify({ username: 'admin', password: ADMIN_PW }) });
if (login.status !== 200) throw new Error('admin sign-in ' + login.status);
const raw = login.headers.getSetCookie().map((c) => c.split(';')[0]);
const cookies = raw.map((c) => ({ name: c.slice(0, c.indexOf('=')), value: c.slice(c.indexOf('=') + 1), url: BASE }));
const ck = raw.join('; ');
const xsrf = (ck.match(/XSRF-TOKEN=([^;]+)/) ?? [])[1];
const api = async (method, path, body) => {
  const r = await fetch(BASE + '/api/v1' + path, { method, headers: { Cookie: ck, 'X-Requested-With': 'mover', 'Content-Type': 'application/json', ...(xsrf ? { 'X-XSRF-TOKEN': decodeURIComponent(xsrf) } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t }; }
};
const results = [];
const external = [];
const ok = (pass, what, detail = '') => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'} ${what}${detail ? ' · ' + detail : ''}`); };
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const open = async (theme, hash, who = cookies) => {
  const ctx = await browser.newContext({ locale: 'ar-AE', timezoneId: 'Asia/Dubai', viewport: { width: 1440, height: 900 } });
  await ctx.addCookies(who);
  await ctx.addInitScript((t) => { try { localStorage.setItem('tmrkz-theme', t); } catch {} }, theme);
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (!['localhost', '127.0.0.1'].includes(u.hostname) && !/^(data|blob):/.test(u.protocol)) { external.push(u.href); return route.abort('blockedbyclient'); }
    return route.continue();
  });
  const page = await ctx.newPage();
  await page.goto(BASE + '/' + hash);
  return { ctx, page };
};

// ---- phase 7: «صلاحيات تهيئة المواقع» --------------------------------------------------------------------------------
const ruleBefore = (await api('GET', '/settings/site-setup-access')).body;
for (const theme of ['light', 'dark']) {
  const { ctx, page } = await open(theme, '#settings');
  const sec = page.getByTestId('site-setup-access');
  await sec.waitFor({ timeout: 20000 });
  await page.getByTestId('site-setup-access-sentence').waitFor({ timeout: 10000 });
  await page.waitForTimeout(800);
  await sec.scrollIntoViewIfNeeded();
  if (theme === 'light') {
    const sentence = (await page.getByTestId('site-setup-access-sentence').innerText()).replace(/\s+/g, ' ');
    ok(ruleBefore.saved || sentence.includes('عمليات الوحدة'), 'the initial rule: «معتمد عمليات الوحدة», changeable here', sentence);
    const boxes = await sec.locator('legend').allInnerTexts();
    ok(['الدور', 'الأشخاص', 'الوحدات ونطاقها', 'المستويات'].every((b) => boxes.includes(b)), 'the administrator chooses the role, the people, the units and their scope, and the levels', boxes.join('، '));
    // a change shows in the sentence before it is saved; without a reason it cannot be saved (nothing is saved here)
    await page.getByTestId('sa-levels').locator('label').nth(1).click();
    const after = (await page.getByTestId('site-setup-access-sentence').innerText()).replace(/\s+/g, ' ');
    ok(after.includes('المستويات 2') && await page.getByTestId('save-site-setup-access').isDisabled(), 'a change shows in the sentence; «حفظ» waits for a reason', after);
  }
  await sec.screenshot({ path: `${OUT}01-site-setup-access-${theme}.png` });
  await ctx.close();
}
ok(JSON.stringify((await api('GET', '/settings/site-setup-access')).body) === JSON.stringify(ruleBefore), 'the rule on the server is unchanged by this run');

// ---- phase 8: «الاعتماد الجزئي» ---------------------------------------------------------------------------------------
const number = process.env.RS ?? 'RS-2026-0004';
const item = (await api('GET', '/restationing-requests')).body.find((x) => x.number === number);
const view0 = (await api('GET', '/restationing-requests/' + item.id)).body;
// the decider: a synthetic HR_AI person of MOVER's local directory (acceptance only), not the requester; the administrator
// may not grant itself a role, so it grants this person «معتمد عمليات الوحدة» on the unit for the run
const DECIDER = process.env.DECIDER ?? 'fahad.ktby4';
const dl = await fetch(BASE + '/api/v1/auth/directory/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mover' }, body: JSON.stringify({ username: DECIDER, password: readFileSync(ROOT + 'ops/acceptance-main/.generated/mover-ldap-test-password', 'utf8').trim() }) });
if (dl.status !== 200) throw new Error(DECIDER + ' sign-in ' + dl.status);
const dRaw = dl.headers.getSetCookie().map((c) => c.split(';')[0]);
const deciderId = (await (await fetch(BASE + '/api/v1/me', { headers: { Cookie: dRaw.join('; '), 'X-Requested-With': 'mover' } })).json()).id;
const grant = await api('POST', '/memberships', { personId: deciderId, organizationId: view0.requestingUnit.id, roleCode: 'UNIT_OPERATIONS_APPROVER', scope: { mode: 'CUSTOM', targets: [{ kind: 'ORGANIZATION', id: view0.requestingUnit.id, includeDescendants: false, levels: null }] } });
const grantId = grant.body?.id ?? grant.body?.membershipId;
ok(grant.status === 200, 'a synthetic decider holds «معتمد عمليات الوحدة» on the unit for this run (audited)', String(grant.status) + ' ' + JSON.stringify(grant.body).slice(0, 120));
// signed in again, with the grant
const dl2 = await fetch(BASE + '/api/v1/auth/directory/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mover' }, body: JSON.stringify({ username: DECIDER, password: readFileSync(ROOT + 'ops/acceptance-main/.generated/mover-ldap-test-password', 'utf8').trim() }) });
const deciderCookies = dl2.headers.getSetCookie().map((c) => c.split(';')[0]).map((c) => ({ name: c.slice(0, c.indexOf('=')), value: c.slice(c.indexOf('=') + 1), url: BASE }));
try {
  for (const theme of ['light', 'dark']) {
    const { ctx, page } = await open(theme, '#restationing/' + item.id, deciderCookies);
    const panel = page.getByTestId('part-review');
    const shown = await panel.waitFor({ timeout: 25000 }).then(() => true, () => false);
    if (theme === 'light') {
      ok(shown, 'the stage that decides now sees the request\'s parts');
      if (shown) {
        const rows = await panel.locator('.pr-head b').allInnerTexts();
        ok(rows.join(' | ') === 'موقع التمركز الجديد | منطقة الانتشار الرئيسية | منطقة الانتشار الفرعية', 'the parts: the new site, the main area, the sub-area', rows.join(' | '));
        await page.getByTestId('part-approve-SITE').click();
        await page.getByTestId('part-approve-PRIMARY').click();
        await page.getByTestId('part-changes-ALTERNATIVE').click();
        await page.getByLabel('ما المطلوب في منطقة الانتشار الفرعية').fill('أبعدها عن الطريق');
        const btn = (await page.getByTestId('part-decide').innerText()).trim();
        ok(btn.includes('إعادة للتعديل') && btn.includes('جزء واحد'), 'two parts approved and one returned: the stage returns that part only', btn);
      }
    }
    if (shown) await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${OUT}02-part-review-${theme}.png` });
    if (shown) await panel.screenshot({ path: `${OUT}03-part-review-panel-${theme}.png` });
    await ctx.close();
  }
} finally {
  if (grantId) {
    const end = await api('POST', '/memberships/' + grantId + '/end', { endAt: null, reason: 'انتهت لقطات المراجعة — حساب اختبار قبول' });
    ok(end.status === 200, 'the run\'s grant is ended', String(end.status));
  }
}
const view1 = (await api('GET', '/restationing-requests/' + item.id)).body;
ok(view1.state === view0.state && JSON.stringify(view1.parts) === JSON.stringify(view0.parts), 'nothing was decided: the request and its parts as before', `${view1.state}`);
ok(!external.length, 'nothing outside localhost', external.slice(0, 2).join(' '));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
