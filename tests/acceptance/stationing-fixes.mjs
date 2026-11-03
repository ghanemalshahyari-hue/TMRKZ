// Regression checks for the objectively broken behaviour found by the visual audit of «مساحة التمركز»
// (docs/audit/stationing-ux/VISUAL_AUDIT_AR.md): V-02 touch drag, V-03 proposal colours, V-04 RTL offsets, V-06 stacked
// markers, V-09 organisation-page link, V-15 organisations without a symbol, V-16 site menu focus and Escape.
// Real application, fictional tmrkz-test data, Microsoft Edge. Nothing is written (no proposal is saved).
// Usage: node tests/acceptance/stationing-fixes.mjs   Evidence: docs/evidence/stationing-fixes/
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BASE, apiSession, consoleErrors, external, launch, newContext, signInManual, watch } from './lib/browser.mjs';

// EVIDENCE_DIR=<folder> keeps a regression run's evidence apart from the accepted run's
const evidence = process.env.EVIDENCE_DIR ? pathToFileURL(process.env.EVIDENCE_DIR.replace(/[\/]?$/, '/')) : new URL('../../docs/evidence/stationing-fixes/', import.meta.url);
mkdirSync(evidence, { recursive: true });
const shot = (page, name) => page.screenshot({ path: fileURLToPath(new URL(name + '.png', evidence)) });
const results = [];
async function step(id, title, fn) {
  try {
    const detail = await fn();
    results.push({ id, title, result: 'PASS', detail });
    console.log('PASS', id, title, detail ? '— ' + detail : '');
  } catch (e) {
    results.push({ id, title, result: 'FAIL', error: String(e.message ?? e).split('\n')[0].slice(0, 400) });
    console.log('FAIL', id, title, '—', String(e.message ?? e).split('\n')[0]);
  }
}
const expect = (c, m) => {
  if (!c) throw new Error(m);
};

const requesterApi = await apiSession('t.requester');
const approverApi = await apiSession('t.approver');
const SITE02 = (await requesterApi.get('/sites')).body.find((s) => s.code === '02');

const browser = await launch();
const open = async (login, viewport = { width: 1920, height: 1080 }, extra = {}) => {
  const ctx = await newContext(browser, { viewport, ...extra });
  const page = await ctx.newPage();
  watch(page, login);
  await signInManual(page, login);
  await page.goto(BASE + '/#stationing');
  await page.waitForSelector('.pin-wrap', { timeout: 20000 });
  await page.waitForTimeout(1500);
  return { ctx, page };
};
/** Search «مركز الخدمات», open its menu and start a proposal; the panel shows the readouts. */
async function startProposal(page) {
  await page.getByLabel('البحث عن جهة أو موقع').fill('مركز الخدمات');
  await page.locator('.stw-search-pop button', { hasText: 'مركز الخدمات' }).first().click();
  await page.locator('.stw-popup').waitFor({ timeout: 10000 });
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: /طلب تمركز/ }).first().click();
  await page.locator('aside.stw-panel').getByText('اقتراح الموقع على الخريطة').waitFor();
  await page.waitForTimeout(1800);
}
const distance = (page) => page.locator('aside.stw-panel .stw-live b').innerText();

try {
  await step('F-02', 'السحب باللمس ينقل المضلع والرمز، لا الخريطة (390×844، أحداث لمس)', async () => {
    const { ctx, page } = await open('t.requester', { width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await startProposal(page);
    const sym = page.locator('.stw-prop-sym').first();
    await sym.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    const before = await distance(page);
    const view = await page.getAttribute('.map', 'data-view');
    const b = await sym.boundingBox();
    const c = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y }] });
    for (let i = 1; i <= 24; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c.x + i * 4, y: c.y - i * 3 }] });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(1500);
    const after = await distance(page);
    const view2 = await page.getAttribute('.map', 'data-view');
    await shot(page, 'f02-touch-drag');
    await ctx.close();
    expect(after !== before, `distance unchanged (${before} → ${after})`);
    expect(view2 === view, 'the map panned instead of the proposal moving');
    return `المسافة ${before} ← ${after} · عرض الخريطة ثابت`;
  });

  let desk = null;
  await step('F-03', 'ألوان المقترح والتحقق ظاهرة: «مقترح» وشارة المسافة ونقطة الإتاحة', async () => {
    desk = await open('t.requester');
    const { page } = desk;
    await page.locator('.stw-tree').getByText('الخدمات المشتركة').first().click();
    await page.locator('.stw-site-row').first().waitFor();
    await startProposal(page);
    const c = await page.evaluate(() => {
      const bg = (sel) => {
        const e = document.querySelector(sel);
        return e ? getComputedStyle(e).backgroundColor : 'absent';
      };
      return { label: bg('.stw-prop-sym .lbl'), chip: bg('.stw-dist span'), dot: bg('.stw-dot') };
    });
    await shot(page, 'f03-colours');
    for (const [k, v] of Object.entries(c)) expect(v !== 'absent' && v !== 'rgba(0, 0, 0, 0)' && v !== 'transparent', k + ' has no colour: ' + v);
    return '«مقترح» ' + c.label + ' · المسافة ' + c.chip + ' · الإتاحة ' + c.dot;
  });

  await step('F-04', 'مقابض الرؤوس وأطوال الأضلاع ورمز المقترح على نقاطها في الاتجاه العربي', async () => {
    const { page } = desk;
    await page.getByRole('button', { name: 'تعديل الرؤوس' }).click();
    await page.waitForTimeout(1000);
    const r = await page.evaluate(() => {
      const off = (sel) =>
        [...document.querySelectorAll(sel)].map((el) => {
          const a = el.closest('.leaflet-marker-icon').getBoundingClientRect();
          const b = el.getBoundingClientRect();
          return { dx: Math.round(b.left + b.width / 2 - a.left), dy: Math.round(b.top + b.height / 2 - a.top) };
        });
      return { v: off('.stw-vtx'), e: off('.stw-edge'), s: off('.stw-prop-sym') };
    });
    await shot(page, 'f04-vertices-on-corners');
    expect(r.v.length >= 3 && r.v.every((x) => Math.abs(x.dx) <= 1 && Math.abs(x.dy) <= 1), 'vertex handle off its vertex: ' + JSON.stringify(r.v));
    expect(r.e.every((x) => Math.abs(x.dx) <= 1 && Math.abs(x.dy) <= 1), 'edge label off its edge: ' + JSON.stringify(r.e));
    // the symbol is raised on purpose (its label sits below it); horizontally it is centred on the proposal
    expect(r.s.every((x) => Math.abs(x.dx) <= 1), 'proposal symbol off centre: ' + JSON.stringify(r.s));
    await desk.page.locator('aside.stw-panel').getByRole('button', { name: 'إلغاء', exact: true }).click();
    await desk.ctx.close();
    return r.v.length + ' رؤوس و' + r.e.length + ' أضلاع: إزاحة 0 بكسل · الرمز في المنتصف أفقياً';
  });

  await step('F-06', 'موقعان في نقطة واحدة: النقر يسأل عن الموقع المقصود، والموقع الأم صار قابلاً للاختيار', async () => {
    const { ctx, page } = await open('t.admin');
    await page.locator(`.pin-wrap[data-site="${SITE02.id}"]`).click();
    const chooser = page.locator('.stw-popup[aria-label="عدة مواقع في هذا الموضع"]');
    await chooser.waitFor({ timeout: 8000 });
    const names = (await chooser.locator('.stw-stack b').allInnerTexts()).map((x) => x.trim());
    await shot(page, 'f06-stack-chooser');
    expect(names.includes('مركز الخدمات') && names.includes('مجمع المؤسسة'), 'chooser lists ' + names.join('، '));
    await chooser.getByRole('button', { name: /مجمع المؤسسة/ }).click();
    await page.locator('.stw-popup[aria-label="إجراءات مجمع المؤسسة"]').waitFor({ timeout: 8000 });
    await ctx.close();
    return 'القائمة: ' + names.join('، ') + ' ← «مجمع المؤسسة» مختار';
  });

  await step('F-09', '«على الخريطة» في الهيكل التنظيمي يحدد الجهة والموقع ويفتح قائمته', async () => {
    const ctx = await newContext(browser, { viewport: { width: 1920, height: 1080 } });
    const page = await ctx.newPage();
    watch(page, 't.requester');
    await signInManual(page, 't.requester');
    await page.goto(BASE + '/#org');
    await page.locator('.org-node').filter({ hasText: 'الخدمات المشتركة' }).first().click();
    const row = page.locator('tr').filter({ hasText: 'مركز الخدمات' }).filter({ has: page.getByRole('button', { name: 'على الخريطة' }) }).first();
    await row.waitFor({ timeout: 10000 });
    await row.getByRole('button', { name: 'على الخريطة' }).click();
    await page.locator('.stw-popup[aria-label="إجراءات مركز الخدمات"]').waitFor({ timeout: 15000 });
    await page.waitForTimeout(1500);
    const r = await page.evaluate((id) => ({
      hash: location.hash,
      selected: document.querySelectorAll(`.pin-wrap.selected[data-site="${id}"]`).length,
      head: document.querySelector('.stw-popup-head b')?.textContent ?? null,
      tree: document.querySelector('.stw-tree-row.active')?.textContent?.replace(/\s+/g, ' ') ?? null,
    }), SITE02.id);
    await shot(page, 'f09-org-link-selects');
    await ctx.close();
    expect(r.selected === 1, 'site not selected on the map');
    expect(r.head === 'الخدمات المشتركة', 'menu organisation: ' + r.head);
    expect(r.tree?.includes('الخدمات المشتركة'), 'organisation not selected in the tree: ' + r.tree);
    expect(r.hash === '#stationing', 'address not settled: ' + r.hash);
    return 'الموقع محدد على الخريطة · القائمة مفتوحة · «الخدمات المشتركة» محددة في الشجرة';
  });

  await step('F-15', 'جهة بلا رمز معتمد تظهر بعلامة محايدة وتبقى قابلة للاختيار', async () => {
    const now = new Date();
    const from = now.toISOString().slice(0, 13) + ':00:00.000Z';
    const to = new Date(now.getTime() + 86400000).toISOString().slice(0, 13) + ':00:00.000Z';
    const f = (await approverApi.get(`/map/features?siteIds=${SITE02.id}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).body.features[0];
    const orgs = [...new Map([f.responsibleOrg, ...(f.occupants ?? [])].filter(Boolean).map((o) => [o.id, o])).values()];
    const { ctx, page } = await open('t.approver');
    const buttons = page.locator(`.map-org-symbol-btn[aria-label$="والموقع ${SITE02.name}"]`);
    await buttons.first().waitFor({ timeout: 10000 });
    const n = await buttons.count();
    const generic = page.locator(`.map-org-symbol-btn[aria-label$="والموقع ${SITE02.name}"]:has(.map-org-symbol.generic)`);
    const g = await generic.count();
    expect(n === orgs.length, `${n} symbols for ${orgs.length} organisations`);
    let picked = null;
    if (g) {
      const label = await generic.first().getAttribute('aria-label');
      await generic.first().click();
      await page.locator('.stw-popup').waitFor({ timeout: 8000 });
      picked = await page.locator('.stw-popup-head b').innerText();
      expect(label.includes(picked), 'menu shows another organisation: ' + picked);
    }
    await shot(page, 'f15-generic-symbol');
    await ctx.close();
    return orgs.length + ' جهات للموقع ← ' + n + ' رموز على الخريطة (' + g + ' علامة محايدة)' + (picked ? ' · اختيار «' + picked + '»' : '');
  });

  await step('F-16', 'لوحة المفاتيح: Enter على العلامة ينقل التركيز إلى القائمة، وEscape يغلقها ويعيد التركيز للعلامة', async () => {
    const { ctx, page } = await open('t.requester', { width: 1366, height: 768 });
    const icon = page.locator(`.leaflet-marker-icon.pin-icon:has(.pin-wrap[data-site="${SITE02.id}"])`);
    await icon.focus();
    await page.keyboard.press('Enter');
    await page.locator('.stw-popup').waitFor({ timeout: 8000 });
    await page.waitForTimeout(500);
    const inside = await page.evaluate(() => !!document.activeElement?.closest('.stw-popup'));
    const focused = await page.evaluate(() => document.activeElement?.textContent?.replace(/\s+/g, ' ').trim());
    await shot(page, 'f16-keyboard-menu');
    await page.keyboard.press('Escape');
    await page.locator('.stw-popup').waitFor({ state: 'detached', timeout: 5000 });
    await page.waitForTimeout(200);
    const back = await page.evaluate(() => document.activeElement?.querySelector('.pin-wrap')?.getAttribute('data-site'));
    await ctx.close();
    expect(inside, 'focus stayed outside the menu');
    expect(back === SITE02.id, 'focus not returned to the marker');
    return 'التركيز داخل القائمة على «' + focused + '» · Escape يغلق ويعيد التركيز للعلامة';
  });
} finally {
  await browser.close();
}
const failed = results.filter((r) => r.result !== 'PASS').length;
writeFileSync(new URL('results.json', evidence), JSON.stringify({ run: new Date().toISOString(), base: BASE, results, externalRequests: external, consoleErrors }, null, 2));
console.log(`\n${results.length - failed}/${results.length} passed · external requests ${external.length} · console errors ${consoleErrors.length}`);
if (consoleErrors.length) console.log(consoleErrors.join('\n'));
process.exit(failed || consoleErrors.length ? 1 : 0);
