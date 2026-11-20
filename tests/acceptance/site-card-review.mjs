// OWNER REVIEW (owner, 17 Nov 2026) — three screens shown before their server side:
//  1. «تحديد مواقع التمركز المبدئية»: the site list as a tree — a camp's inside sites behind its arrow;
//  2. the site's card: its facts, one «تعديل», and «حذف الموقع» for the administrator / «طلب حذف» for everyone else;
//  3. «إعدادات النظام ← إرشادات صفحة الدخول»: the sign-in page's notes edited, added, ordered, hidden and removed, with a preview.
// On http://localhost:8088 as the platform administrator, and as a synthetic requester of MOVER's directory (HR_AI) who
// manages one unit's site. Connected (ADR-086): the deletion panel reads the server's impact; on these sites the server
// names what stops a deletion (requests that refer to them), so nothing is deleted; the requester's «طلب حذف» is REAL and
// the administrator then refuses it (the run leaves no open request behind).
//   OTHER=juma.ghfly4 node tests/acceptance/site-card-review.mjs
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)).split(String.fromCharCode(92)).join('/');
const BASE = process.env.MOVER_URL ?? 'http://localhost:8088';
const OUT = ROOT + 'docs/evidence/site-card-review/';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const { chromium } = await import(pathToFileURL(ROOT + 'tests/acceptance/node_modules/playwright-core/index.mjs').href);
const OTHER = process.env.OTHER ?? 'juma.ghfly4';
const signIn = async (username, password) => {
  const r = await fetch(BASE + '/api/v1/auth/directory/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mover' }, body: JSON.stringify({ username, password }) });
  if (r.status !== 200) throw new Error(`${username} sign-in ${r.status}`);
  return r.headers.getSetCookie().map((c) => c.split(';')[0]).map((c) => ({ name: c.slice(0, c.indexOf('=')), value: c.slice(c.indexOf('=') + 1), url: BASE }));
};
const admin = await signIn('admin', readFileSync(ROOT + '.env', 'utf8').match(/^TMRKZ_PLATFORM_ADMIN_PASSWORD=(.*)$/m)[1].trim());
const other = await signIn(OTHER, readFileSync(ROOT + 'ops/acceptance-main/.generated/mover-ldap-test-password', 'utf8').trim());
const apiGet = async (cookies, path) => (await fetch(BASE + '/api/v1' + path, { headers: { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '), 'X-Requested-With': 'mover' } })).json();
const sitesBefore = JSON.stringify((await apiGet(admin, '/sites')).map((s) => s.id + s.status));
// a camp with an inside site, and a camp where a unit is stationed (from the server)
const sites = await apiGet(admin, '/sites');
const parent = sites.find((s) => sites.some((k) => k.parentId === s.id));
const kid = sites.find((k) => k.parentId === parent?.id);
const stationed = (await apiGet(admin, '/stationing/current')).find((r) => !sites.some((k) => k.parentId === r.siteId));
// the other person's unit whose site they set up (OTHER_UNIT names it when the person holds several units)
const otherUnits = (await apiGet(other, '/request-hub')).units.filter((u) => u.site);
const otherSite = (otherUnits.find((u) => u.name.includes(process.env.OTHER_UNIT ?? '\u0000')) ?? otherUnits[0])?.site;
if (!parent || !kid || !stationed || !otherSite) throw new Error('needs a camp with an inside site, a stationed unit and a site of the other person\'s unit');

const browser = await chromium.launch(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH, headless: true } : { channel: 'msedge', headless: true });
const external = [];
const results = [];
const ok = (pass, what, detail = '') => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'} ${what}${detail ? ' · ' + detail : ''}`); };
const open = async (cookies, theme, hash) => {
  const ctx = await browser.newContext({ locale: 'ar-AE', timezoneId: 'Asia/Dubai', viewport: { width: 1440, height: hash === '#settings' ? 1500 : 900 } });
  await ctx.addCookies(cookies);
  await ctx.addInitScript((t) => { try { localStorage.setItem('tmrkz-theme', t); } catch {} }, theme);
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (!['localhost', '127.0.0.1'].includes(u.hostname) && !/^(data|blob):/.test(u.protocol)) { external.push(u.href); return route.abort('blockedbyclient'); }
    return route.continue();
  });
  const page = await ctx.newPage();
  lastPage = page;
  await page.goto(BASE + '/' + hash);
  await page.waitForSelector('main#main', { timeout: 30000 });
  return { ctx, page };
};
// a failure keeps the screen it happened on (release closure, 20 Nov 2026)
let lastPage = null;
process.on('uncaughtException', async (e) => {
  console.error(String(e).split('\n').slice(0, 4).join('\n'));
  try { await lastPage?.screenshot({ path: OUT + 'failure.png' }); console.error('screen: ' + OUT + 'failure.png · ' + lastPage?.url()); } catch {}
  process.exit(1);
});
const text = async (loc) => (await loc.innerText()).replace(/\s+/g, ' ');

for (const theme of ['light', 'dark']) {
  const { ctx, page } = await open(admin, theme, '#siteSetup');
  await page.getByTestId('setup-tree').locator(`[data-site="${parent.code}"]`).waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  // 1. the tree: the inside site behind its camp's arrow
  if (theme === 'light') {
    ok(await page.getByTestId('setup-tree').locator(`[data-site="${kid.code}"]`).count() === 0, 'an inside site is not a row of its own: it waits behind its camp\'s arrow', `${kid.code} in ${parent.code}`);
    await page.locator('.tz-site-list').screenshot({ path: `${OUT}01-list-closed-${theme}.png` });
  }
  await page.locator(`[data-twisty="${parent.code}"]`).click();
  await page.getByTestId('inside-of-' + parent.code).locator(`[data-site="${kid.code}"]`).waitFor({ timeout: 5000 });
  if (theme === 'light') ok(true, 'the arrow opens the camp: its inside site under it, indented');
  await page.locator('.tz-site-list').screenshot({ path: `${OUT}02-list-open-${theme}.png` });
  // 2. the card: the facts and three actions
  await page.getByTestId('setup-tree').locator(`[data-site="${parent.code}"]`).first().click();
  await page.getByTestId('site-facts').waitFor({ timeout: 10000 });
  await page.waitForTimeout(1500);
  const facts = await text(page.getByTestId('site-facts'));
  if (theme === 'light') {
    ok(['النوع', 'المكان', 'الوحدة المتمركزة', 'الحدود', 'المواقع الداخلية', 'الوحدات المرتبطة'].every((w) => facts.includes(w)) && facts.includes(kid.name), 'the card shows the site\'s facts at a glance, its inside site among them', facts.slice(0, 200));
    const acts = await page.getByTestId('site-actions').locator('button').allInnerTexts();
    ok(acts.join(' | ') === 'تعديل | ＋ موقع داخل | حذف الموقع', 'three actions under it: «تعديل», «＋ موقع داخل», «حذف الموقع» (the administrator)', acts.join(' | '));
    ok(await page.locator('.sw-fcard').count() === 0, 'no folded sections any more');
  }
  await page.locator('.tz-site-work').screenshot({ path: `${OUT}03-card-${theme}.png` });
  if (theme === 'light') {
    await page.getByTestId('edit-site').click();
    await page.getByTestId('site-edit').waitFor({ timeout: 5000 });
    ok(await page.getByTestId('save-edit').isDisabled(), 'one form for every change, saved with one reason (nothing to save until something changes)');
    await page.locator('.tz-site-work').screenshot({ path: `${OUT}04-edit-${theme}.png` });
    await page.getByTestId('site-edit').getByRole('button', { name: 'إلغاء' }).click();
    // the administrator deletes a camp: its inside sites go with it, each named in a warning first (owner, 17 Nov 2026)
    await page.getByTestId('delete-site').click();
    await page.getByTestId('delete-ack').waitFor({ timeout: 10000 });
    await page.waitForTimeout(800);
    const imp = await text(page.getByTestId('delete-panel'));
    const warn = await text(page.getByTestId('delete-related'));
    await page.getByLabel('سبب الحذف').fill('موقع أُنشئ للاختبار — اختبار قبول وهمي');
    await page.getByTestId('delete-ack').check();
    ok(imp.includes('نهائياً') && warn.includes(kid.name), 'deleting a camp warns that its inside sites are deleted with it, naming each; erased completely', warn.slice(0, 160));
    const block1 = await page.getByTestId('delete-blockers').innerText().catch(() => '');
    ok(block1.includes('الطلب') && await page.getByTestId('confirm-delete').isDisabled(), 'the server says what stops it (a request refers to the site): «حذف الموقع» stays off', block1.replace(/\s+/g, ' ').slice(0, 160));
    await page.locator('.tz-site-work').screenshot({ path: `${OUT}05-delete-with-inside-${theme}.png` });
    // a camp where a unit is stationed: the impact is said before the reason
    await page.getByTestId('setup-tree').locator(`[data-site="${stationed.siteCode}"]`).first().click();
    await page.getByTestId('delete-site').waitFor({ timeout: 10000 });
    await page.waitForTimeout(1200);
    await page.getByTestId('delete-site').click();
    const imp2 = await text(page.getByTestId('delete-panel'));
    ok(imp2.includes(stationed.orgName) && imp2.includes('بلا تمركز') && imp2.includes('سجل التدقيق'), 'deleting says what goes with it: the unit\'s initial stationing and areas (the unit back to no stationing); one audit line stays', imp2.slice(0, 200));
    await page.getByLabel('سبب الحذف').fill('موقع أُنشئ للاختبار — اختبار قبول وهمي');
    await page.getByTestId('delete-ack').check();
    const block2 = await page.getByTestId('delete-blockers').innerText().catch(() => '');
    ok(await page.getByTestId('confirm-delete').isDisabled() === (block2.length > 0), 'the delete is off exactly when the server names a reason', block2.replace(/\s+/g, ' ').slice(0, 160) || 'nothing stops it');
    await page.locator('.tz-site-work').screenshot({ path: `${OUT}06-delete-${theme}.png` });
  }
  await ctx.close();
}

// everyone else asks the administrator
{
  const { ctx, page } = await open(other, 'light', '#siteSetup');
  await page.getByTestId('setup-tree').locator(`[data-site]`).first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  const code = sites.find((s) => s.id === otherSite.id)?.code;
  await page.getByTestId('setup-tree').locator(`[data-site="${code}"]`).first().click();
  await page.getByTestId('site-actions').waitFor({ timeout: 10000 });
  await page.waitForTimeout(1200);
  ok(await page.getByTestId('delete-site').count() === 0 && await page.getByTestId('request-delete').count() === 1, 'someone who manages the site but is not the administrator gets «طلب حذف», never «حذف الموقع»');
  await page.getByTestId('request-delete').click();
  const imp = await text(page.getByTestId('delete-panel'));
  ok(imp.includes('مدير النظام'), 'the request goes to the system administrator, who approves or refuses it', imp.slice(0, 200));
  await page.getByLabel('سبب طلب الحذف').fill('الموقع لم يعد مستخدماً — اختبار قبول وهمي');
  await page.getByTestId('delete-ack').check();
  await page.getByTestId('send-delete-request').click();
  await page.getByTestId('delete-request-open').waitFor({ timeout: 15000 });
  ok(true, '«إرسال طلب الحذف» sends the request; the panel now says it waits for the system administrator', await page.getByTestId('delete-request-open').innerText());
  await page.locator('.tz-site-work').screenshot({ path: `${OUT}07-request-delete-light.png` });
  await ctx.close();
}
// the administrator sees the request on the site and refuses it (the run leaves nothing open)
{
  const { ctx, page } = await open(admin, 'light', '#siteSetup');
  const code = sites.find((s) => s.id === otherSite.id)?.code;
  await page.getByTestId('setup-tree').locator(`[data-site="${code}"]`).first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  ok(await page.getByTestId('setup-tree').locator(`[data-site="${code}"]`).getByTestId('delete-requested').count() === 1, 'the administrator sees «طلب حذف» on the site in the list');
  await page.getByTestId('setup-tree').locator(`[data-site="${code}"]`).first().click();
  await page.getByTestId('delete-site').click();
  await page.getByTestId('delete-request-open').waitFor({ timeout: 10000 });
  await page.getByLabel('سبب الحذف').fill('الموقع ما زال مستخدماً — اختبار قبول وهمي');
  await page.locator('.tz-site-work').screenshot({ path: `${OUT}08-admin-decides-light.png` });
  await page.getByTestId('refuse-delete').click();
  await page.waitForTimeout(1500);
  const open2 = (await apiGet(admin, '/site-deletion-requests')).filter((q) => q.siteId === otherSite.id);
  ok(open2.length === 0, 'the administrator refuses: the request is closed, the site stays', `open now: ${open2.length}`);
  await ctx.close();
}

// 3. the sign-in page's notes in the settings
for (const theme of ['light', 'dark']) {
  const { ctx, page } = await open(admin, theme, '#settings');
  const sec = page.getByTestId('signin-notes-settings');
  await sec.waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);
  if (theme === 'light') {
    const prev = await text(page.getByTestId('signin-preview'));
    ok(['الدخول الآلي', 'الإدخال اليدوي', 'الصلاحيات والحماية'].every((w) => prev.includes(w)), 'the settings start from the three notes the sign-in page shows today', prev.slice(0, 120));
    await page.screenshot({ path: `${OUT}09-signin-notes-${theme}.png` });
    await page.getByTestId('add-notice').click();
    await page.getByLabel('التصنيف').fill('صيانة مجدولة');
    await page.getByLabel('عنوان الإرشاد').fill('توقف الخدمة للتحديث');
    await page.getByLabel('نص الإرشاد').fill('يتوقف النظام ساعة واحدة مساء الخميس للتحديث. احفظ عملك قبلها.');
    const prev2 = await page.getByTestId('signin-preview').locator('article').allInnerTexts();
    ok(prev2[0]?.includes('توقف الخدمة للتحديث'), 'a new important notice shows first in the preview', prev2[0]?.replace(/\s+/g, ' '));
    await page.locator('[data-note]').first().getByRole('button', { name: 'إخفاء' }).click();
    const prev3 = await text(page.getByTestId('signin-preview'));
    ok(!prev3.includes('بالحساب المؤسسي'), 'a hidden note leaves the preview');
    await page.getByTestId('delete-note-1').click();
    ok(await page.locator('[data-note]').count() === 3, 'a note is removed with ✕');
    await page.screenshot({ path: `${OUT}10-signin-notes-edited-${theme}.png` });
    // saved for real (ADR-083): the run saves the page's own notes back, so the sign-in page is as it was
    await page.getByRole('button', { name: 'استعادة الإرشادات الأصلية' }).click();
    await page.getByTestId('save-notes').click();
    await page.getByTestId('notes-saved').waitFor({ timeout: 15000 });
    const pub = await (await fetch(BASE + '/api/v1/auth/notices')).json();
    ok(pub.saved === true && pub.notes.map((n) => n.title).join('|') === 'بالحساب المؤسسي|حساب محلي أو حساب مؤسسي|الصلاحيات من جهتك', '«حفظ» saves the board; the sign-in page reads it before anyone signs in', pub.notes.map((n) => n.title).join('، '));
  } else await page.screenshot({ path: `${OUT}09-signin-notes-${theme}.png` });
  await ctx.close();
}
ok(JSON.stringify((await apiGet(admin, '/sites')).map((s) => s.id + s.status)) === sitesBefore, 'nothing was deleted');
ok(!external.length, 'nothing outside localhost', external.slice(0, 2).join(' '));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
