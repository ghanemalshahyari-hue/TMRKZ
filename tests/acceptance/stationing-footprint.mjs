// Stationing footprint acceptance (owner brief of 2 Nov 2026) in the real application, fictional tmrkz-test data.
// The eleven owner steps: open «مساحة التمركز», select a real organisation (tree and map symbol), see its symbol and
// registered polygon, start a relocation proposal, drag the whole polygon and symbol together (area kept), adjust a
// vertex with undo/redo, draw a new polygon by vertex count, enter vertex coordinates, compare old and proposed, cancel
// without changing authoritative data, save and reopen the draft. Evidence: docs/evidence/stationing/.
// Usage: node tests/acceptance/stationing-footprint.mjs   (HEADED=1 SLOWMO=300 to watch)
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BASE, apiSession, consoleErrors, external, launch, newContext, signInManual, watch } from './lib/browser.mjs';

// EVIDENCE_DIR=<folder> keeps a regression run's evidence apart from the accepted run's
const evidence = process.env.EVIDENCE_DIR ? pathToFileURL(process.env.EVIDENCE_DIR.replace(/[\/]?$/, '/')) : new URL('../../docs/evidence/stationing/', import.meta.url);
mkdirSync(evidence, { recursive: true });
const shot = (page, name) => page.screenshot({ path: fileURLToPath(new URL(name + '.png', evidence)) });
const results = [];
// SKIP=S11 leaves out a step (S11 saves a draft: skipped when the environment's data must stay unchanged)
const SKIP = (process.env.SKIP ?? '').split(',').filter(Boolean);
async function step(id, title, fn) {
  if (SKIP.includes(id)) {
    results.push({ id, title, result: 'SKIPPED' });
    console.log('SKIP', id, title);
    return;
  }
  try {
    const detail = await fn();
    results.push({ id, title, result: 'PASS', detail });
    console.log('PASS', id, title, detail ? '— ' + detail : '');
  } catch (e) {
    results.push({ id, title, result: 'FAIL', error: String(e.message ?? e).slice(0, 400) });
    console.log('FAIL', id, title, '—', e.message);
  }
}
const expect = (c, m) => {
  if (!c) throw new Error(m);
};
const num = (s) => Number(String(s).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[^0-9.]/g, ''));

const api = await apiSession('t.requester');
const site02 = (await api.get('/sites')).body.find((s) => s.code === '02');
const boundaryBefore = (await api.get('/sites/' + site02.id)).body.geometry?.version ?? null;
const requestsBefore = (await api.get('/requests?size=1')).body.total;

const browser = await launch();
let draftId = null;
try {
  const page = await (await newContext(browser)).newPage();
  watch(page, 't.requester');
  await signInManual(page, 't.requester');
  const panel = page.locator('aside.stw-panel');
  const read = async (label) => (await panel.locator('dt', { hasText: label }).locator('xpath=following-sibling::dd[1]').first().innerText()).trim();
  const centre = async (loc) => {
    const b = await loc.boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const drag = async (from, dx, dy) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 24 });
    await page.mouse.up();
    await page.waitForTimeout(900);
  };

  await step('S1', 'فتح «مساحة التمركز»', async () => {
    await page.goto(BASE + '/#stationing');
    await page.locator('.stw .stw-tree').waitFor();
    await page.waitForTimeout(2000);
    await shot(page, 's01-open');
    return 'الصفحة داخل إطار التطبيق، شجرة الجهات والخريطة';
  });

  await step('S2', 'اختيار جهة حقيقية من الشجرة ومن رمزها على الخريطة', async () => {
    await page.locator('.stw-tree').getByText('الخدمات المشتركة').first().click();
    await page.locator('.stw-tree').getByText('مركز الخدمات').first().waitFor();
    const symbols = await page.locator('.map-org-symbol-btn').count();
    expect(symbols > 0, 'no organisation symbol on the map');
    await page.locator('.map-org-symbol-btn').first().click();
    await page.waitForTimeout(1200);
    await shot(page, 's02-organisation');
    return 'الشجرة: الخدمات المشتركة ومواقعها · ' + symbols + ' رمز جهة قابل للنقر على الخريطة';
  });

  await step('S3', 'رؤية رمز الجهة وحدود موقعها المسجلة', async () => {
    await page.getByLabel('البحث عن جهة أو موقع').fill('مركز الخدمات');
    await page.locator('.stw-search-pop button', { hasText: 'مركز الخدمات' }).first().click();
    await page.waitForTimeout(2200);
    const paths = await page.locator(`path[data-site="${site02.id}"]`).count();
    await shot(page, 's03-registered-footprint');
    expect(paths > 0, 'registered boundary of site 02 not drawn');
    return 'حدود «مركز الخدمات» المسجلة مرسومة مع رمز الجهة';
  });

  await step('S4', 'بدء اقتراح تمركز: نسخة من الحدود والرمز، والأصل باقٍ', async () => {
    await page.getByRole('button', { name: /طلب تمركز/ }).first().click();
    await panel.getByText('اقتراح الموقع على الخريطة').waitFor();
    await page.waitForTimeout(1500);
    expect((await page.locator('path.stw-prop-path').count()) === 1, 'no proposal copy');
    expect((await page.locator('.stw-orig-sym').count()) === 1, 'registered symbol not kept');
    const a = await read('المساحة المقترحة');
    expect(a === (await read('المساحة المعتمدة')), 'copy area differs: ' + a);
    await shot(page, 's04-proposal-copy');
    return 'النسخة: ' + a + ' مطابقة للمساحة المعتمدة';
  });

  await step('S5', 'سحب الحدود والرمز معاً كجسم واحد مع ثبات الشكل والمساحة', async () => {
    const sym = page.locator('.stw-prop-sym').first();
    await drag(await centre(sym), 150, -90);
    await page.waitForTimeout(1500);
    const dist = await panel.locator('.stw-live b').innerText();
    const delta = await read('الفرق في المساحة');
    await shot(page, 's05-dragged');
    expect(delta === '0٪', 'area changed by the move: ' + delta);
    // drag again after dropping, from the polygon body this time
    const body = page.locator('path.stw-prop-path');
    await drag(await centre(body), -40, -20);
    const delta2 = await read('الفرق في المساحة');
    expect(delta2 === '0٪', 'area changed by the second move: ' + delta2);
    return 'المسافة ' + dist + ' · فرق المساحة ' + delta + ' بعد سحبتين (من الرمز ثم من المساحة)';
  });

  await step('S6', 'تعديل رأس، ثم تراجع وإعادة', async () => {
    await page.getByRole('button', { name: 'تعديل الرؤوس' }).click();
    await page.locator('.stw-prop-sym').first().waitFor();
    await page.getByRole('button', { name: '◎ المقترح' }).click();
    await page.waitForTimeout(900);
    const v = page.locator('.stw-vtx').first();
    await v.waitFor();
    const before = await read('المساحة المقترحة');
    await drag(await centre(v), 30, 30);
    const after = await read('المساحة المقترحة');
    expect(after !== before, 'vertex move did not change the area');
    await shot(page, 's06-vertex-edited');
    await page.getByRole('button', { name: '↶ تراجع' }).click();
    await page.waitForTimeout(500);
    expect((await read('المساحة المقترحة')) === before, 'undo did not restore');
    await page.getByRole('button', { name: '↷ إعادة' }).click();
    await page.waitForTimeout(500);
    expect((await read('المساحة المقترحة')) === after, 'redo did not reapply');
    return 'قبل ' + before + ' ← بعد ' + after + ' · التراجع والإعادة يعملان';
  });

  await step('S7', 'رسم حدود جديدة باختيار عدد الرؤوس', async () => {
    await page.getByRole('tab', { name: 'ب · رسم حدود جديدة' }).click();
    await page.getByLabel('عدد الرؤوس').fill('5');
    await page.waitForTimeout(1200);
    const m = await page.locator('.stw-mapwrap .leaflet-container').boundingBox();
    const cx = m.x + m.width * 0.3;
    const cy = m.y + m.height * 0.45;
    for (const [dx, dy] of [[0, -50], [48, -15], [30, 42], [-30, 42], [-48, -15]]) {
      await page.mouse.click(cx + dx, cy + dy);
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(1200);
    expect((await page.locator('.stw-vtx').count()) === 5, 'five numbered vertices expected');
    const shape = await read('صحة الشكل');
    const area = await read('المساحة المقترحة');
    const edges = await page.locator('.stw-edge').count();
    await shot(page, 's07-drawn-5-vertices');
    expect(shape.includes('صالح'), 'shape: ' + shape);
    return '5 رؤوس مرقمة · ' + edges + ' أطوال أضلاع · المساحة ' + area + ' · ' + shape;
  });

  await step('S8', 'إدخال إحداثيات الرؤوس بدقة', async () => {
    await page.getByLabel('عدد الرؤوس').fill('3');
    await page.getByRole('button', { name: 'إعادة الضبط' }).click();
    await page.waitForTimeout(600);
    // three vertices about 1.6 km west-north-west of site 02, typed
    for (const [lat, lng] of [['25.2125', '55.3005'], ['25.2125', '55.3025'], ['25.2140', '55.3015']]) {
      await page.getByLabel('خط عرض الرأس', { exact: true }).fill(lat);
      await page.getByLabel('خط طول الرأس', { exact: true }).fill(lng);
      await page.getByRole('button', { name: 'إضافة رأس' }).click();
      await page.waitForTimeout(300);
    }
    await page.waitForTimeout(1500);
    expect((await page.locator('.stw-vt tbody tr').count()) === 3, 'vertex table');
    // precise edit of vertex 3 in the table
    const lat3 = page.getByLabel('خط عرض الرأس 3');
    await lat3.fill('25.2145');
    await lat3.press('Enter');
    await page.waitForTimeout(1200);
    const area = await read('المساحة المقترحة');
    await shot(page, 's08-typed-coordinates');
    return '3 رؤوس بالإحداثيات + تعديل الرأس 3 من الجدول · المساحة ' + area;
  });

  await step('S9', 'مقارنة الموقع المعتمد بالمقترح', async () => {
    await page.getByRole('button', { name: '⇆ مقارنة الموقعين' }).click();
    await page.waitForTimeout(1500);
    const dist = await panel.locator('.stw-live b').innerText();
    await shot(page, 's09-compare');
    expect((await page.locator('.stw-orig-sym').count()) === 1 && (await page.locator('.stw-prop-sym').count()) === 1, 'both locations');
    return 'الأصل بالأزرق والمقترح بالأخضر وخط المسافة · ' + dist;
  });

  await step('S10', 'الإلغاء دون تغيير أي بيانات معتمدة', async () => {
    await panel.getByRole('button', { name: 'إلغاء', exact: true }).click();
    await page.waitForTimeout(1200);
    expect((await page.locator('path.stw-prop-path').count()) === 0, 'preview left on the map');
    const after = (await api.get('/sites/' + site02.id)).body.geometry?.version ?? null;
    const requestsAfter = (await api.get('/requests?size=1')).body.total;
    await shot(page, 's10-cancelled');
    expect(after === boundaryBefore, 'registered boundary changed');
    expect(requestsAfter === requestsBefore, 'a request was created');
    return 'إصدار الحدود ' + after + ' كما هو · لا طلب جديد (' + requestsAfter + ')';
  });

  await step('S11', 'حفظ المعاينة كمسودة ثم فتحها من جديد', async () => {
    await page.getByLabel('البحث عن جهة أو موقع').fill('مركز الخدمات');
    await page.locator('.stw-search-pop button', { hasText: 'مركز الخدمات' }).first().click();
    await page.waitForTimeout(1800);
    await page.getByRole('button', { name: /طلب تمركز/ }).first().click();
    await panel.getByText('اقتراح الموقع على الخريطة').waitFor();
    await page.waitForTimeout(1500);
    await drag(await centre(page.locator('.stw-prop-sym').first()), -170, 60);
    await page.waitForTimeout(1500);
    const go = page.getByRole('button', { name: 'متابعة إلى تفاصيل الطلب' });
    expect(await go.isEnabled(), 'cannot continue: ' + (await panel.innerText()).slice(0, 300));
    await go.click();
    await panel.getByText('تفاصيل الطلب').first().waitFor();
    await panel.getByPlaceholder('مثال: المبنى الإداري الجديد').fill('مقر الخدمات المقترح (تحقق)');
    await panel.getByPlaceholder('لماذا يلزم هذا التمركز؟').fill('تحقق من حفظ معاينة الحدود وإعادة فتحها');
    await shot(page, 's11a-details');
    await panel.getByRole('button', { name: 'حفظ كمسودة' }).click();
    await page.waitForFunction(() => /#stationing\/[0-9a-f-]{36}/.test(location.hash), null, { timeout: 15000 });
    draftId = (await page.evaluate(() => location.hash)).split('/')[1];
    const saved = (await api.get('/requests/' + draftId + '/relocation')).body;
    expect(saved?.geometry?.type === 'Polygon', 'saved geometry is ' + saved?.geometry?.type);
    await page.goto(BASE + '/#stationing/' + draftId);
    await page.reload();
    await panel.getByText('اقتراح الموقع على الخريطة').waitFor({ timeout: 20000 });
    await page.waitForTimeout(2500);
    const reopened = await read('المساحة المقترحة');
    await shot(page, 's11b-reopened');
    expect((await page.locator('path.stw-prop-path').count()) === 1, 'reopened draft has no polygon');
    const after = (await api.get('/sites/' + site02.id)).body.geometry?.version ?? null;
    expect(after === boundaryBefore, 'registered boundary changed by saving');
    return 'المسودة ' + draftId.slice(0, 8) + ' محفوظة بمضلع (' + Math.round(saved.areaM2 ?? 0) + ' م²) وأُعيد فتحها: ' + reopened + ' · الحدود المعتمدة دون تغيير';
  });
} finally {
  await browser.close();
}
const failed = results.filter((r) => r.result !== 'PASS').length;
writeFileSync(new URL('results.json', evidence), JSON.stringify({ run: new Date().toISOString(), draftId, results, externalRequests: external, consoleErrors }, null, 2));
console.log(`\n${results.length - failed}/${results.length} passed · external requests ${external.length} · console errors ${consoleErrors.length}`);
if (consoleErrors.length) console.log(consoleErrors.join('\n'));
process.exit(failed || consoleErrors.length ? 1 : 0);
