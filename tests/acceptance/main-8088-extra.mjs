// What the journeys on the one application (ops/acceptance-main) do not already cover: the permission catalogue as an administrator sees
// it (nothing saved), a Point site drawn through the page, the posture in 3D and a temporary stationing's end date, the path of each
// request type on the approvals page (nothing saved), and that every page is on :8088.
//   . ops/acceptance-main/env.sh && node tests/acceptance/main-8088-extra.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { BASE, consoleErrors, external, launch, newContext, signInManual, watch } from './lib/browser.mjs';

const { ACC_NS: NS, ACC_PREFIX: PFX, DB_CONTAINER: DB, ACC_OUT } = process.env;
const OUT = `${ACC_OUT}/extra/`;
mkdirSync(OUT, { recursive: true });
const sql = (q) => execFileSync('docker', ['exec', DB, 'psql', '-X', '-q', '-U', 'mover', '-d', 'mover', '-At', '-c', q], { encoding: 'utf8' }).trim();
const results = [];
const ok = (pass, id, what, detail = '') => {
  results.push({ id, pass: !!pass, what, detail: String(detail).slice(0, 500) });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} — ${what}${detail ? ' · ' + String(detail).slice(0, 260) : ''}`);
};
const org = (x) => sql(`select md5('${NS}:org:${x}')::uuid`);
const browser = await launch();
const as = async (user) => {
  const c = await newContext(browser);
  const p = await c.newPage();
  watch(p, user);
  await signInManual(p, user);
  return p;
};
const go = async (p, hash) => {
  await p.goto(BASE + '/' + hash);
  await p.reload();
  await p.waitForSelector('main#main');
  await p.waitForTimeout(1500);
  ok(new URL(p.url()).origin === 'http://localhost:8088', 'URL', 'الصفحة على localhost:8088', p.url());
};
const button = (p, name) => p.getByRole('button', { name, exact: true });
/** WCAG contrast of an element's text on its own background. */
const contrast = (loc) => loc.evaluate((e) => {
  const parse = (c) => { const p = c.match(/[\d.]+/g).map(Number); return { r: p[0], g: p[1], b: p[2] }; };
  const lum = ({ r, g, b }) => { const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const st = getComputedStyle(e);
  const [a, b] = [lum(parse(st.color)), lum(parse(st.backgroundColor))].sort((x, y) => y - x);
  return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100;
});
const inThemes = async (page, id, what, loc) => {
  for (const theme of ['light', 'dark']) {
    const was = await page.evaluate((t) => { const w = document.documentElement.dataset.theme; document.documentElement.dataset.theme = t; return w; }, theme);
    await page.waitForTimeout(200);
    const c = await contrast(loc);
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, was);
    ok(c >= 4.5, `${id}-${theme}`, what, `${c}:1`);
  }
};
try {
  // ---- the catalogue ----------------------------------------------------------------------------------------------------
  const admin = await as('p14.admin');
  await go(admin, '#permissions');
  await button(admin, 'الصلاحيات المعروضة للطلب').click();
  await admin.getByTestId('access-offer-dialog').waitFor({ timeout: 15000 });
  await admin.waitForTimeout(800);
  const offers = await admin.locator('[data-offer]').evaluateAll((l) => l.map((e) => [e.getAttribute('data-offer'), e.value]));
  const map = Object.fromEntries(offers);
  const everyone = offers.filter(([, v]) => v === 'EVERYONE').map(([c]) => c).sort();
  ok(everyone.join() === ['CHAIN_APPROVER', 'FYI_RECEIVER', 'REQUESTER', 'UNIT_OPERATIONS_APPROVER'].sort().join(), 'CAT-01', 'الأربع المعروضة لكل شخص جديد كما هي', everyone.join());
  const requestable = ['POSTURE_VIEWER', 'STATIONING_REQUESTER', 'DEPLOYMENT_REQUESTER', 'SITE_REGISTRATION_REQUESTER', 'STATIONING_UNIT_APPROVER', 'STATIONING_OPS_APPROVER', 'STATIONING_FINAL_APPROVER', 'FYI_DISTRIBUTOR', 'SITE_LINK_MANAGER'];
  const shown = requestable.filter((c) => c in map);
  console.log('INFO shown:', offers.map(([c]) => c).join());
  ok(shown.length === requestable.length, 'CAT-02', 'الأدوار الجديدة القابلة للطلب ظاهرة', `${shown.length} من ${requestable.length}`);
  const hidden = ['SITE_SETUP_ADMIN', 'UNIT_ACCESS_MANAGER', 'ACCESS_FINAL_APPROVER', 'SYSTEM_ADMIN'].filter((c) => c in map);
  ok(hidden.length === 0, 'CAT-03', 'أدوار الإدارة والتهيئة لا تظهر', hidden.join());
  await admin.screenshot({ path: OUT + 'catalogue.png' });
  await button(admin, 'إلغاء').click();

  // ---- the path of each type (nothing saved) -----------------------------------------------------------------------------
  await go(admin, '#workflow');
  const types = await admin.getByLabel('نوع الطلب').locator('option').allTextContents();
  ok(['طلب صلاحيات', 'طلب اعتماد موقع', 'طلب تمركز أولي', 'طلب منطقة انتشار', 'طلب إعادة تمركز'].every((t) => types.includes(t)), 'PATH-01', 'كل أنواع الطلب في مسار الموافقات', types.join('، '));
  await admin.getByLabel('نوع الطلب').selectOption('route:DEPLOYMENT_AREAS');
  await admin.getByTestId('stationing-route').waitFor({ timeout: 15000 });
  await admin.waitForTimeout(800);
  await admin.locator('[data-last="7"]').check();
  await admin.locator('[data-stage=finalByPermission]').check();
  await admin.getByLabel('الوحدة مقدمة الطلب').fill('قسم الحركة أ');
  await admin.locator('.fs-org-picker li button').first().click({ timeout: 10000 });
  await admin.getByTestId('route-try').click();
  await admin.getByTestId('route-tried').waitFor({ timeout: 15000 });
  const tried = (await admin.getByTestId('route-tried').innerText()).replace(/\s+/g, ' ');
  ok(tried.includes('اعتماد المستوى L7') && tried.includes('الاعتماد النهائي'), 'PATH-02', 'التجربة تعرض المراحل ومن يحملها', tried.slice(0, 220));
  await inThemes(admin, 'CONTRAST-RESULT', 'وضوح نتيجة التجربة في مسار الموافقات', admin.locator('.fs-outcome'));
  ok((await admin.getByTestId('route-publish').isDisabled()), 'PATH-03', 'لا تفعيل قبل الحفظ والسبب');
  ok((await admin.locator('.react-flow__node').count()) >= 3 && !(await admin.locator('.fs-tile').count()), 'PATH-04', 'المخطط من الإعدادات، بلا سحب بطاقات');
  await admin.screenshot({ path: OUT + 'path-of-a-type.png' });
  ok(sql(`select count(*) from stationing_route_version`) === '0', 'PATH-05', 'لم يُحفظ ولم يُفعَّل مسار أثناء القبول');

  // ---- a Point site through the page ------------------------------------------------------------------------------------
  const sites = await as('p04.sites');
  await go(sites, '#siteSetup');
  await sites.getByTestId('setup-tree').waitFor({ timeout: 15000 });
  await sites.getByTestId('add-site').click();
  await button(sites, 'نقطة').click();
  await sites.getByTestId('place-point').click();
  await sites.waitForTimeout(500);
  const box = await sites.locator('.tz-mapframe .tz-map-layer canvas').first().boundingBox();
  await sites.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.25);
  await sites.waitForTimeout(800);
  const code = PFX + 'SITE-POINT-' + Date.now().toString(36);
  await sites.getByLabel('اسم الموقع').fill('موقع نقطة من الصفحة — اختبار قبول — وهمي');
  await sites.getByLabel('رمز الموقع').fill(code);
  await sites.getByLabel('سبب تسجيل الموقع').fill('تسجيل موقع نقطة في اختبار القبول');
  await sites.getByTestId('save-site').click();
  await sites.locator(`[data-site="${code}"]`).waitFor({ timeout: 15000 });
  ok(sql(`select count(*) from site_geometry_version g join site s on s.id = g.site_id where s.code = '${code}'`) === '0' && sql(`select lat is not null from site where code = '${code}'`) === 't', 'SITE-P1', 'موقع نقطة بلا حدود مخترعة');
  await sites.screenshot({ path: OUT + 'point-site.png' });

  // ---- a boundary that overlaps a registered site: refused, and no site left behind -----------------------------------------
  const refusedCode = PFX + 'SITE-OVERLAP-' + Date.now().toString(36);
  await sites.getByTestId('add-site').click();
  const [olat, olng] = sql(`select lat || ' ' || lng from site where id = md5('${NS}:site:SITE-07')::uuid`).split(' ').map(Number);
  await sites.evaluate(([x, y]) => document.querySelector('.tz-mapframe .tz-map-layer').tmrkzMap.jumpTo({ center: [x, y], zoom: 14 }), [olng, olat]);
  await sites.waitForTimeout(800);
  await sites.getByTestId('draw-site').click();
  await sites.waitForTimeout(500);
  const ob = await sites.locator('.tz-mapframe .tz-map-layer canvas').first().boundingBox();
  for (const [dx, dy] of [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]]) {
    await sites.mouse.click(ob.x + ob.width * dx, ob.y + ob.height * dy);
    await sites.waitForTimeout(250);
  }
  await sites.waitForTimeout(800);
  await sites.getByLabel('اسم الموقع').fill('موقع متداخل — اختبار قبول — وهمي');
  await sites.getByLabel('رمز الموقع').fill(refusedCode);
  await sites.getByLabel('سبب تسجيل الموقع').fill('موقع يتداخل مع موقع مسجل');
  await sites.getByTestId('save-site').click();
  await sites.waitForTimeout(1800);
  ok(sql(`select count(*) from site where code = '${refusedCode}'`) === '0', 'SITE-ATOMIC', 'الحدود المرفوضة لا تترك موقعاً بلا حدود');
  ok((await sites.getByTestId('add-site-form').count()) === 1, 'SITE-ATOMIC-2', 'يبقى النموذج مفتوحاً ليعدّل المستخدم الحدود');
  await sites.reload();

  // ---- posture: a temporary stationing's end date, and 3D -------------------------------------------------------------
  const view = await as('p12.view');
  await go(view, '#posture');
  await view.locator(`[data-unit="${org(process.env.ACC_TEMP_UNIT ?? 'N-A119')}"]`).click({ timeout: 15000 });
  await view.waitForTimeout(1500);
  const text = (await view.locator('main#main').innerText()).replace(/\s+/g, ' ');
  ok(/مؤقت/.test(text) && text.includes('2027'), 'POSTURE-T1', 'التمركز المؤقت يظهر بحالته وتاريخ نهايته', text.slice(0, 260));
  await view.locator(`[data-unit="${org('N-A11')}"]`).click();
  await view.waitForTimeout(1500);
  await button(view, '3D').click();
  await view.waitForTimeout(5000);
  const camera = await view.evaluate(() => { const m = document.querySelector('.tz-mapframe .tz-map-layer').tmrkzMap; return { terrain: !!m.getTerrain(), pitch: m.getPitch() }; });
  ok(camera.terrain && camera.pitch > 0, 'POSTURE-3D', 'الموقف في 3D على تضاريس حقيقية', JSON.stringify(camera));
  await inThemes(view, 'CONTRAST-3D', 'وضوح زر 3D المفعّل', view.locator('.tz-view-switch button.on'));
  await view.screenshot({ path: OUT + 'posture-3d.png' });
  await view.locator(`[data-unit="${org('N-A112')}"]`).click();
  await view.waitForTimeout(2500);
  const kept = await view.evaluate(() => { const m = document.querySelector('.tz-mapframe .tz-map-layer').tmrkzMap; return { terrain: !!m.getTerrain(), pitch: m.getPitch() }; });
  ok(kept.terrain && kept.pitch > 0, 'POSTURE-3D-2', 'يبقى 3D عند اختيار وحدة أخرى', JSON.stringify(kept));
  ok(!(await button(view, 'حفظ').count()) && !(await button(view, 'تعديل الحدود').count()), 'POSTURE-3D-RO', 'لا أدوات تعديل في 3D');
  await button(view, '2D').click();
  await view.waitForTimeout(1500);
  ok(consoleErrors.length === 0, 'EXTRA-CONSOLE', 'لا أخطاء في المتصفح', consoleErrors.slice(0, 3).join(' | '));
  ok(external.length === 0, 'EXTRA-EXTERNAL', 'صفر طلب خارجي', external.slice(0, 3).join(' | '));
} catch (e) {
  ok(false, 'ABORT', 'توقف التشغيل', e.message.slice(0, 400));
} finally {
  await browser.close();
}
writeFileSync(OUT + 'results.json', JSON.stringify({ at: new Date().toISOString(), results, consoleErrors, external }, null, 1) + '\n');
const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
