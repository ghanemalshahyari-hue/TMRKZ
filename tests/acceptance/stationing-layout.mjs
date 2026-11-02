// After removing the GIS merge (owner decision, 2 Nov 2026): «مساحة التمركز» is the only GIS entry, #map leads to it, the
// pre-merge layout is back and no merge-only control or panel remains. Writes after-*.png and results.json to
// docs/evidence/stationing-unmerge/. Nothing is written to the application.
// Usage: node tests/acceptance/stationing-layout.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as lib from './lib/browser.mjs';

const OUT = fileURLToPath(new URL('../../docs/evidence/stationing-unmerge/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const results = [];
const check = async (id, title, fn) => {
  try {
    const d = await fn();
    results.push({ id, title, result: 'PASS', detail: d });
    console.log('PASS', id, title, d ? '— ' + d : '');
  } catch (e) {
    results.push({ id, title, result: 'FAIL', error: String(e.message ?? e).split('\n')[0] });
    console.log('FAIL', id, title, '—', String(e.message ?? e).split('\n')[0]);
  }
};
const expect = (c, m) => {
  if (!c) throw new Error(m);
};
// selectors and labels that only the merge introduced
const MERGE_ONLY = [
  ['.context-bar', 'شريط السياق'],
  ['.period-tools', 'أدوات الفترة'],
  ['.map-toolbar', 'شريط أدوات الخريطة القديم'],
  ['.map-admin-links', 'أدوات المرافق'],
  ['.stw-dir', 'دليل بتبويبين'],
  ['.stw-side', 'العمود الجانبي المدمج'],
  ['.map-legend', 'الأسطورة'],
  ['.map-caption.coverage', 'تنبيه التغطية'],
];

const browser = await lib.launch();
try {
  const page = await (await lib.newContext(browser)).newPage();
  lib.watch(page, 't.requester');
  await lib.signInManual(page, 't.requester');

  await check('U1', '«مساحة التمركز» تفتح وهي الصفحة الافتراضية', async () => {
    await page.waitForSelector('.stw .stw-tree', { timeout: 20000 });
    await page.waitForSelector('.pin-wrap', { timeout: 20000 });
    await page.waitForTimeout(1500);
    expect((await page.locator('#navigation a.nav-item.active').innerText()).includes('مساحة التمركز'), 'active item');
    await page.screenshot({ path: OUT + 'after-01-open.png' });
    return 'الشجرة والخريطة ولوحة الخطوات · ' + (await page.locator('.pin-wrap').count()) + ' علامات';
  });

  await check('U2', 'الصفحة القديمة غائبة عن القائمة، و#map يفتح مساحة التمركز', async () => {
    const nav = (await page.locator('#navigation').innerText()).replace(/\s+/g, ' ');
    expect(!nav.includes('الخريطة والمرافق'), 'legacy entry in navigation');
    await page.goto(lib.BASE + '/#map');
    await page.waitForSelector('.stw .stw-tree');
    const h = await page.evaluate(() => location.hash);
    expect(h === '#stationing', 'hash ' + h);
    return 'القائمة دون «الخريطة والمرافق» · #map ← ' + h;
  });

  await check('U3', 'التخطيط البسيط قبل الدمج: شجرة الجهات، الخريطة بطبقات التمركز، لوحة الخطوات', async () => {
    for (const [sel, name] of MERGE_ONLY) expect((await page.locator(sel).count()) === 0, name + ' still present (' + sel + ')');
    expect((await page.getByRole('tab', { name: 'المواقع' }).count()) === 0, 'sites tab present');
    const chips = (await page.locator('.stw-chips').innerText()).replace(/\s+/g, ' ');
    for (const c of ['النطاق المسموح', 'المناطق المحجوزة', 'رموز الجهات', 'المواقع', 'الطبقات']) expect(chips.includes(c), 'chip ' + c);
    expect(await page.locator('aside.stw-panel.guide').isVisible(), 'steps panel');
    const d = await page.evaluate(() => {
      const r = (s) => document.querySelector(s)?.getBoundingClientRect();
      return { map: [Math.round(r('.map').width), Math.round(r('.map').height)], sw: document.documentElement.scrollWidth, iw: innerWidth };
    });
    return 'لا عناصر دمج (' + MERGE_ONLY.length + ' محددات + تبويب المواقع) · الخريطة ' + d.map.join('×') + ' بكسل';
  });

  await check('U4', 'قائمة الموقع هي قائمة التمركز البسيطة، لا الحلقة ولا لوحة التفاصيل', async () => {
    await page.getByLabel('البحث عن جهة أو موقع').fill('مركز الخدمات');
    await page.locator('.stw-search-pop button', { hasText: 'مركز الخدمات' }).first().click();
    await page.locator('.stw-popup').waitFor({ timeout: 10000 });
    await page.waitForTimeout(1500);
    const text = (await page.locator('.stw-popup').innerText()).replace(/\s+/g, ' ');
    expect(text.includes('طلب تمركز / إعادة تمركز') && text.includes('عرض المواقع المرتبطة'), 'popup items: ' + text);
    expect((await page.locator('.site-ring, .site-menu, .map-detail').count()) === 0, 'merged site menu or details panel present');
    await page.screenshot({ path: OUT + 'after-02-site-menu.png' });
    return 'القائمة: ' + text.slice(0, 120);
  });

  // a facilities administrator sees no facility tools in the workspace any more (they were part of the merge)
  await check('U5', 'لا أدوات إدارة مرافق مدمجة (مدير المرافق)', async () => {
    const p2 = await (await lib.newContext(browser)).newPage();
    lib.watch(p2, 't.admin');
    await lib.signInManual(p2, 't.admin');
    await p2.waitForSelector('.stw .stw-tree', { timeout: 20000 });
    await p2.waitForTimeout(1500);
    for (const name of ['إضافة موقع جديد بعلامة', 'استيراد حدود المواقع', 'مدير الخرائط']) expect((await p2.getByRole('button', { name, exact: true }).count()) === 0, name + ' present');
    for (const [sel, name] of MERGE_ONLY) expect((await p2.locator(sel).count()) === 0, name + ' present for t.admin');
    await p2.screenshot({ path: OUT + 'after-04-facility-manager.png' });
    await p2.context().close();
    return 'لا «إضافة موقع» ولا «استيراد الحدود» ولا «مدير الخرائط» ولا شريط سياق';
  });
} finally {
  await browser.close();
}
const failed = results.filter((r) => r.result !== 'PASS').length;
writeFileSync(OUT + 'results.json', JSON.stringify({ run: new Date().toISOString(), base: lib.BASE, results, externalRequests: lib.external, consoleErrors: lib.consoleErrors }, null, 2));
console.log(`\n${results.length - failed}/${results.length} passed · external ${lib.external.length} · console errors ${lib.consoleErrors.length}`);
process.exit(failed || lib.consoleErrors.length ? 1 : 0);
