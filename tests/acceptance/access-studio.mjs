// Permissions studio in Microsoft Edge against the acceptance environment (ADR-018, PA-10/PA-11 from the interface).
// Sign-in uses the real directory path; every step is a click or a keystroke. Screenshots: docs/evidence/access/.
// Usage: sh ops/test-env/up.sh && node tests/acceptance/access-studio.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { consoleErrors, external, launch, newContext, signInManual, watch } from './lib/browser.mjs';

const results = [];
const evidence = new URL('../../docs/evidence/access/', import.meta.url);
mkdirSync(evidence, { recursive: true });
const shot = (name) => fileURLToPath(new URL(name, evidence));

async function step(id, title, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ id, title, result: 'PASS', ms: Date.now() - started });
    console.log('PASS', id, title);
  } catch (e) {
    results.push({ id, title, result: 'FAIL', error: String(e.message ?? e).slice(0, 400) });
    console.log('FAIL', id, title, '—', e.message);
  }
}

const expect = (cond, message) => {
  if (!cond) throw new Error(message);
};

async function pickOrg(scope, page, name) {
  await scope.getByLabel('البحث في الجهات').first().fill(name);
  await scope.locator('.tree-hit', { hasText: name }).first().click();
  await page.waitForTimeout(300);
}

async function pickPerson(scope, name) {
  await scope.getByLabel('بحث الأشخاص').fill(name);
  const option = scope.locator('select[aria-label="الشخص"] option', { hasText: name }).first();
  await option.waitFor({ state: 'attached' });
  await scope.locator('select[aria-label="الشخص"]').selectOption(await option.getAttribute('value'));
}

const browser = await launch();
try {
  const adminCtx = await newContext(browser);
  const admin = await adminCtx.newPage();
  watch(admin, 't.admin');
  admin.on('dialog', (d) => d.accept('اختبار القبول للاستوديو'));
  await signInManual(admin, 't.admin');

  await step('STUDIO-01', 'Global manager sees the published version, the matrix and a working decision service', async () => {
    await admin.goto(admin.url().split('#')[0] + '#permissions/policy');
    await admin.getByText(/الإصدار المنشور \d+/).waitFor();
    expect(await admin.locator('.matrix-table tbody tr').count() >= 7, 'matrix rows');
    await admin.getByRole('tab', { name: 'خدمة القرار' }).click();
    await admin.getByText('تعمل', { exact: true }).waitFor();
    await admin.screenshot({ path: shot('studio-01-service.png'), fullPage: true });
  });

  await step('STUDIO-02', 'Grants read as plain Arabic scopes, including an AND scope', async () => {
    await admin.getByRole('tab', { name: 'المنح والنطاقات' }).click();
    await pickOrg(admin.locator('.access-grid'), admin, 'إدارة التقنية');
    await admin.locator('td.scope-text', { hasText: 'بشرط أن يكون الموقع' }).first().waitFor();
    await pickOrg(admin.locator('.access-grid'), admin, 'الخدمات المشتركة');
    await admin.locator('td.scope-text', { hasText: '«الخدمات المشتركة» وفروعها' }).first().waitFor();
    await admin.screenshot({ path: shot('studio-02-grants.png'), fullPage: true });
  });

  await step('STUDIO-03', 'Explanation lists each action with its reasons; the decision service agrees on every row', async () => {
    await admin.getByRole('tab', { name: 'المعاينة والاختبار' }).click();
    await pickPerson(admin.locator('.access-grid'), 'مدير إدارة التقنية');
    await admin.getByRole('button', { name: 'اعرض الصلاحيات وأسبابها' }).click();
    await admin.locator('.explain-table tbody tr').first().waitFor();
    expect((await admin.locator('.explain-table tbody tr').count()) === 13, 'thirteen actions');
    expect((await admin.getByText('يختلف — يُرفض الإجراء').count()) === 0, 'decision service disagreed');
    await admin.locator('.explain-reason', { hasText: 'بشرط' }).first().waitFor();
    await admin.screenshot({ path: shot('studio-03-explain.png'), fullPage: true });
  });

  await step('STUDIO-04', 'Draft, impact and discard: nothing changes before publication', async () => {
    await admin.getByRole('tab', { name: 'الأدوار والإصدارات' }).click();
    await admin.getByText(/الإصدار المنشور \d+/).waitFor();
    await admin.waitForTimeout(500);
    if (await admin.getByRole('button', { name: 'تجاهل المسودة' }).count()) {
      // a draft left by an interrupted earlier run
      await admin.getByRole('button', { name: 'تجاهل المسودة' }).click();
    }
    await admin.getByRole('button', { name: 'إنشاء مسودة' }).click();
    await admin.getByText(/مسودة الإصدار \d+ مفتوحة/).waitFor();
    expect(!(await admin.getByLabel('اطلاع محدود تصدير').isChecked()), 'export already granted to the limited viewer');
    await admin.getByLabel('اطلاع محدود تصدير').click();
    await admin.waitForFunction(() => document.querySelector('input[aria-label="اطلاع محدود تصدير"]')?.checked === true);
    await admin.locator('tr.row-changed').first().waitFor();
    await admin.getByRole('button', { name: 'التحقق والأثر' }).click();
    await admin.getByText(/أثر المسودة \d+ مقارنة بالإصدار \d+/).waitFor();
    await admin.locator('td.good', { hasText: 'تصدير' }).first().waitFor();
    await admin.screenshot({ path: shot('studio-04-impact.png'), fullPage: true });
    await admin.getByRole('button', { name: 'تجاهل المسودة' }).click();
    await admin.getByRole('button', { name: 'إنشاء مسودة' }).waitFor();
  });

  const mgrCtx = await newContext(browser);
  const mgr = await mgrCtx.newPage();
  watch(mgr, 't.manager');
  mgr.on('dialog', (d) => d.accept('انتهاء اختبار القبول'));
  await signInManual(mgr, 't.manager');

  await step('STUDIO-05', 'An organisation access manager sees the policy read-only', async () => {
    await mgr.goto(mgr.url().split('#')[0] + '#permissions/policy');
    await mgr.getByText('عرض فقط: يعدل السياسة مدير صلاحيات عام').waitFor();
    expect((await mgr.getByRole('button', { name: 'إنشاء مسودة' }).count()) === 0, 'draft button shown');
  });

  await step('STUDIO-06', 'The manager cannot grant beyond their authority; inside it the grant is created and ended', async () => {
    await mgr.getByRole('tab', { name: 'المنح والنطاقات' }).click();
    const grid = mgr.locator('.access-grid');
    await pickOrg(grid, mgr, 'الخدمات المشتركة');
    await mgr.getByRole('button', { name: 'منحة جديدة' }).click();
    const dialog = mgr.locator('.grant-form');
    await pickPerson(dialog, 'مقدم طلب — التقنية');
    await dialog.locator('label.field', { hasText: 'الدور' }).locator('select').selectOption({ label: 'مقدم الطلب' });
    await dialog.getByText('نطاق مخصص: جهات أو مواقع أو موارد محددة').click();
    // an organisation outside the manager's authority is not even offered
    await dialog.locator('.grant-form-pickers').getByLabel('البحث في الجهات').fill('إدارة التقنية');
    await dialog.getByText('لا نتائج ضمن نطاقك.').waitFor();
    // a role the manager may not hand out is refused by the server
    await dialog.getByText('نطاق الدور الافتراضي').click();
    await dialog.locator('label.field', { hasText: 'الدور' }).locator('select').selectOption({ label: 'مدير الجهة' });
    await mgr.getByRole('button', { name: 'حفظ المنحة' }).click();
    await mgr.locator('.grant-error', { hasText: 'يتجاوز' }).waitFor();
    await mgr.screenshot({ path: shot('studio-06-refused.png'), fullPage: true });
    await dialog.locator('label.field', { hasText: 'الدور' }).locator('select').selectOption({ label: 'مقدم الطلب' });
    await mgr.getByRole('button', { name: 'حفظ المنحة' }).click();
    await mgr.getByText('أُضيفت المنحة').waitFor();
    const row = mgr.locator('tr', { hasText: 'مقدم طلب — التقنية' }).filter({ hasText: 'مقدم الطلب' }).first();
    await row.getByRole('button', { name: 'إنهاء' }).click();
    await mgr.getByText('انتهت المنحة').waitFor();
  });
} finally {
  await browser.close();
}

const summary = { run: new Date().toISOString(), results, externalRequests: external, consoleErrors };
writeFileSync(new URL('results.json', evidence), JSON.stringify(summary, null, 2));
const failed = results.filter((r) => r.result !== 'PASS').length;
console.log(`\n${results.length - failed}/${results.length} passed · external requests ${external.length} · console errors ${consoleErrors.length}`);
if (consoleErrors.length) console.log(consoleErrors.join('\n'));
process.exit(failed || consoleErrors.length ? 1 : 0);
