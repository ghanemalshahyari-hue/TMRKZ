// OWNER REVIEW — «إعادة تنظيم التمركز والمواقع ومناطق الانتشار», phase 2 (owner, 17 Nov 2026): «تحديد مواقع التمركز المبدئية»
// in three steps — «بيانات الموقع» (the unit first, name, type, main or inside, symbol, notes), «تحديد الموقع والحدود» (the map,
// 2D/3D), «مراجعة وحفظ» («حفظ الموقع والتمركز المبدئي»). On http://localhost:8088 as the platform administrator, both themes;
// synthetic HR_AI units only. The dark run reviews and saves nothing; the light run SAVES one fictional site with the initial
// stationing of a unit stationed nowhere (chosen from the server: «مركز صحة اثنين» while it is free), without deployment areas
// (accepted by the owner 17 Nov 2026; ADR-081). Screens: docs/evidence/stationing-redesign/phase2/.
//   node tests/acceptance/initial-site-phase2.mjs
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)).split(String.fromCharCode(92)).join('/');
const BASE = process.env.MOVER_URL ?? 'http://localhost:8088';
const OUT = ROOT + 'docs/evidence/stationing-redesign/phase2/';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const { chromium } = await import(pathToFileURL(ROOT + 'tests/acceptance/node_modules/playwright-core/index.mjs').href);
const ADMIN_PW = readFileSync(ROOT + '.env', 'utf8').match(/^TMRKZ_PLATFORM_ADMIN_PASSWORD=(.*)$/m)[1].trim();
const login = await fetch(BASE + '/api/v1/auth/directory/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mover' }, body: JSON.stringify({ username: 'admin', password: ADMIN_PW }) });
if (login.status !== 200) throw new Error('admin sign-in ' + login.status);
const cookies = login.headers.getSetCookie().map((c) => c.split(';')[0]).map((c) => ({ name: c.slice(0, c.indexOf('=')), value: c.slice(c.indexOf('=') + 1), url: BASE }));
const apiGet = async (path) => (await fetch(BASE + '/api/v1' + path, { headers: { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '), 'X-Requested-With': 'mover' } })).json();
const sitesBefore = (await apiGet('/sites')).length;
// a unit stationed nowhere: «مركز صحة اثنين» while it is free, else the first free unit of the synthetic tree
const taken = new Set((await apiGet('/stationing/current')).map((r) => r.orgId));
const units = [];
const walk = (n) => { units.push(n); (n.children ?? []).forEach(walk); };
(await apiGet('/organizations/tree')).forEach(walk);
const free = units.filter((u) => u.status !== 'INACTIVE' && !taken.has(u.id));
const FREE_UNIT = (free.find((u) => u.name === 'مركز صحة اثنين') ?? free.find((u) => units.filter((x) => x.name.includes(u.name)).length === 1))?.name;
if (!FREE_UNIT) throw new Error('no unit stationed nowhere is left in the synthetic tree');
const SITE_NAME = 'موقع تمركز مبدئي — وهمي ' + Date.now().toString(36).slice(-4);
console.log(`unit: ${FREE_UNIT} · site: ${SITE_NAME}`);

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const external = [];
const results = [];
const ok = (pass, what, detail = '') => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'} ${what}${detail ? ' · ' + detail : ''}`); };
const STATIONED_UNIT = 'مركز صحة واحد'; // stationed at the acceptance site

async function pickUnit(page, name) {
  const search = page.getByLabel('البحث في الجهات');
  await search.fill(name);
  // the search answers as a hierarchy: the unit found under its ancestors (owner, 17 Nov 2026)
  const hit = page.getByTestId('tree-search-results').locator('[data-found=match]').filter({ hasText: name }).first();
  await hit.waitFor({ timeout: 15000 });
  await hit.click();
  await page.getByTestId('unit-picked').waitFor({ timeout: 10000 });
}

// the dark run first: it reviews only; the light run saves (the unit is then stationed, so it comes last)
for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({ locale: 'ar-AE', timezoneId: 'Asia/Dubai', viewport: { width: 1440, height: 900 } });
  await ctx.addCookies(cookies);
  await ctx.addInitScript((t) => { try { localStorage.setItem('tmrkz-theme', t); } catch {} }, theme);
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (!['localhost', '127.0.0.1'].includes(u.hostname) && !/^(data|blob):/.test(u.protocol)) { external.push(u.href); return route.abort('blockedbyclient'); }
    return route.continue();
  });
  const page = await ctx.newPage();
  await page.goto(BASE + '/#home');
  await page.waitForSelector('main#main', { timeout: 30000 });
  // one click on the tab: the steps open at once
  await page.locator('[data-nav=SITE_SETUP]').click();
  await page.getByTestId('initial-step-1').waitFor({ timeout: 30000 });
  await page.waitForTimeout(2500);
  const steps = await page.locator('.sw-steps li span').allInnerTexts();
  if (theme === 'light') {
    ok(steps.join(' | ') === 'بيانات الموقع | تحديد الموقع والحدود | مراجعة وحفظ', 'the tab opens the three steps at once', steps.join(' | '));
    await page.screenshot({ path: `${OUT}01-step1-start-${theme}.png` });
    // the unit search as a hierarchy: the ancestors from the top, the units found marked, each row chosen as in the tree
    await page.getByLabel('البحث في الجهات').fill('صحة');
    await page.getByTestId('tree-search-results').locator('[data-found=match]').first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(600);
    const anc = await page.getByTestId('tree-search-results').locator('[data-found=ancestor]').allInnerTexts();
    const found = await page.getByTestId('tree-search-results').locator('[data-found=match]').allInnerTexts();
    ok(anc.length >= 2 && found.some((t) => t.includes('مركز صحة واحد')) && found.some((t) => t.includes('مركز صحة اثنين')), 'the unit search shows each result under its whole chain of ancestors', `ancestors ${anc.length} · found ${found.length}`);
    await page.locator('.tz-site-work').screenshot({ path: `${OUT}01b-unit-search-hierarchy-${theme}.png` });
    await page.getByLabel('البحث في الجهات').fill('');
    // a unit already stationed is not stationed again by the setup
    await pickUnit(page, STATIONED_UNIT);
    await page.getByLabel('اسم الموقع').fill('موقع قبول — وهمي ٢');
    await page.getByTestId('wizard-next').click();
    await page.waitForTimeout(600);
    const err = await page.locator('.sw-err').first().innerText().catch(() => '');
    ok(err.includes('طلب إعادة تمركز') && (await page.getByTestId('initial-step-1').count()) === 1, 'a unit with an approved stationing is stopped: it changes by a re-stationing request', err);
    await page.screenshot({ path: `${OUT}05-unit-already-stationed-${theme}.png` });
    await page.getByTestId('unit-picked').getByRole('button', { name: 'تغيير' }).click();
  }
  // «بيانات الموقع»: the unit first, then the site
  await pickUnit(page, FREE_UNIT);
  await page.getByLabel('اسم الموقع').fill(SITE_NAME);
  await page.getByLabel('نوع الموقع').selectOption('معسكر');
  // «رمز الموقع على الخريطة»: a field that says what it is, then the picker window searched by name
  if (theme === 'light') await page.getByTestId('symbol-field').screenshot({ path: `${OUT}02a-symbol-field-empty-${theme}.png` });
  await page.getByTestId('symbol-choose').click();
  await page.getByTestId('symbol-dialog').waitFor({ timeout: 10000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}02c-symbol-picker-${theme}.png` });
  const q = page.getByLabel('ابحث عن رمز بالاسم');
  const shown = async () => page.getByTestId('symbol-grid').locator('.sym-pick b').allInnerTexts();
  await q.fill('طبي');
  await page.waitForTimeout(900);
  const med = await shown();
  if (theme === 'light') ok(['طبابة', 'مستشفى ميداني', 'إسعاف', 'مركز صحي'].every((n) => med.includes(n)), '«طبي» finds طبابة، مستشفى، إسعاف، مركز صحي by name', med.join('، '));
  await page.screenshot({ path: `${OUT}02d-symbol-search-medical-${theme}.png` });
  await q.fill('دروع');
  await page.waitForTimeout(900);
  const arm = await shown();
  if (theme === 'light') ok(['مدرعات', 'دبابات'].every((n) => arm.includes(n)), '«دروع» finds مدرعات and دبابات', arm.join('، '));
  if (theme === 'light') await page.screenshot({ path: `${OUT}02e-symbol-search-armour-${theme}.png` });
  await q.fill('مستشقى'); // one letter wrong
  await page.waitForTimeout(900);
  if (theme === 'light') ok((await shown()).includes('مستشفى ميداني'), 'a misspelt «مستشقى» still finds the field hospital');
  await q.fill('معسكر');
  await page.waitForTimeout(900);
  if (theme === 'light') ok((await shown())[0] === 'معسكر / قاعدة', '«معسكر» puts the camp first');
  await page.locator('[data-symbol-pick=base]').click();
  await page.getByTestId('symbol-dialog').waitFor({ state: 'detached', timeout: 10000 });
  await page.getByLabel('ملاحظات الموقع').fill('موقع اختبار قبول وهمي');
  await page.waitForTimeout(800);
  await page.getByTestId('initial-step-1').evaluate((el) => el.closest('.sw-fill, .sw-wizard')?.scrollTo?.(0, 0));
  await page.getByText('الجهة / الوحدة').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}02-step1-data-${theme}.png` });
  if (theme === 'light') await page.locator('.tz-site-work').screenshot({ path: `${OUT}02b-step1-panel-${theme}.png` });
  // «تحديد الموقع والحدود»: draw on the map
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('draw-site').waitFor({ timeout: 10000 });
  await page.getByTestId('draw-site').click();
  const box = await page.locator('.maplibregl-canvas').first().boundingBox();
  const cx = box.x + box.width * 0.45, cy = box.y + box.height * 0.5;
  for (const [dx, dy] of [[-70, -50], [60, -60], [80, 40], [-20, 70]]) { await page.mouse.click(cx + dx, cy + dy); await page.waitForTimeout(250); }
  // a double click places the last corner and finishes the drawing (owner, 17 Nov 2026): the light run double-clicks on an
  // empty spot, the dark run on the last corner already placed
  if (theme === 'light') await page.mouse.dblclick(cx - 80, cy + 20);
  else await page.mouse.dblclick(cx - 20, cy + 70);
  await page.waitForTimeout(1200);
  const done = await page.getByTestId('shape-done').innerText().catch(() => '');
  ok(done.includes('تم رسم الحدود') && (await page.getByTestId('finish-draw').count()) === 0, `a double click finishes the drawing (${theme === 'light' ? 'on an empty spot: the last corner' : 'on the last corner'})`, done);
  if (theme === 'light') ok((await page.locator('.sw-maplabel').innerText()).includes(SITE_NAME), 'the site\'s name and symbol stand on its boundary on the map');
  await page.screenshot({ path: `${OUT}03-step2-boundary-${theme}.png` });
  // «مراجعة وحفظ»: the summary and «حفظ الموقع والتمركز المبدئي»
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('initial-step-3').waitFor({ timeout: 10000 });
  const sum = (await page.getByTestId('site-summary').innerText()).replace(/\s+/g, ' ');
  if (theme === 'light') {
    ok(sum.includes(FREE_UNIT + ' — التمركز المبدئي') && sum.includes('معسكر') && sum.includes('موقع رئيسي'), 'the review names the unit\'s initial stationing and the site', sum.slice(0, 200));
    ok((await page.getByText('أي الوحدات تتمركز').count()) === 0 && (await page.getByText('منطقة الانتشار الرئيسية').count()) === 0, 'no «which units are stationed here» and no deployment areas in the setup');
    // without a reason the server is not asked: the step says what is missing
    await page.getByTestId('save-initial').click();
    ok((await page.getByTestId('save-error').innerText().catch(() => '')).includes('سبب التسجيل'), 'the save asks for the reason first, on the step itself');
  }
  await page.getByLabel('سبب تسجيل الموقع').fill('تحديد الموقع المبدئي للوحدة — اختبار قبول وهمي');
  await page.screenshot({ path: `${OUT}04-step3-review-${theme}.png` });
  if (theme === 'light') {
    // the save: the site, its boundary and the unit's initial stationing, in one audited act
    await page.getByTestId('save-initial').click();
    await page.getByTestId('site-made').waitFor({ timeout: 20000 });
    const made = (await page.getByTestId('site-made').innerText()).replace(/\s+/g, ' ');
    ok(made.includes(SITE_NAME) && made.includes(FREE_UNIT) && made.includes('تمركزها المبدئي المعتمد'), 'the save answers: the site with its code, and the unit\'s initial stationing', made.slice(0, 220));
    // the list follows a moment later (the registered sites are read again after the save)
    ok(await page.getByTestId('setup-tree').getByText(SITE_NAME).first().waitFor({ timeout: 15000 }).then(() => true, () => false), 'the new site appears in the site list');
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}06-saved-${theme}.png` });
    const rec = (await apiGet('/stationing/current')).find((r) => r.orgName === FREE_UNIT);
    ok(rec?.siteName === SITE_NAME && rec?.origin === 'SETUP' && !rec?.requestId, 'the server holds the unit\'s initial stationing at the new site (origin SETUP, no request)', rec ? `${rec.siteCode} · ${rec.origin}` : 'none');
    // the unit is now stationed: a second setup for it is stopped on the first step
    await page.getByRole('button', { name: 'إضافة موقع آخر' }).click();
    await page.getByTestId('initial-step-1').waitFor({ timeout: 10000 });
    await page.waitForTimeout(1500);
    await pickUnit(page, FREE_UNIT);
    await page.getByLabel('اسم الموقع').fill(SITE_NAME + ' ب');
    await page.getByTestId('wizard-next').click();
    await page.waitForTimeout(600);
    ok((await page.locator('.sw-err').first().innerText().catch(() => '')).includes(SITE_NAME), 'the unit now stationed is stopped in a new setup, naming its site');
  }
  await ctx.close();
}
ok((await apiGet('/sites')).length === sitesBefore + 1, 'exactly one site was added (the light run\'s)');
ok(!external.length, 'nothing outside localhost', external.slice(0, 2).join(' '));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
