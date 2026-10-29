// Resource settings in Microsoft Edge against the acceptance environment (PA-17): relation to sub-resources and the
// optional shared-use limit, set by a facility manager from the site panel. Every change is reverted at the end.
// Usage: sh ops/test-env/up.sh && node tests/acceptance/resources.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { consoleErrors, external, launch, newContext, signInManual, watch } from './lib/browser.mjs';

const results = [];
const evidence = new URL('../../docs/evidence/resources/', import.meta.url);
mkdirSync(evidence, { recursive: true });
const shot = (name) => fileURLToPath(new URL(name, evidence));

async function step(id, title, fn) {
  try {
    const detail = await fn();
    results.push({ id, title, result: 'PASS', detail });
    console.log('PASS', id, title, detail ? '— ' + detail : '');
  } catch (e) {
    results.push({ id, title, result: 'FAIL', error: String(e.message ?? e).slice(0, 400) });
    console.log('FAIL', id, title, '—', String(e.message ?? e).split('\n')[0]);
  }
}

const browser = await launch();
try {
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  watch(page, 't.admin');
  await signInManual(page, 't.admin');
  await page.goto(page.url().split('#')[0] + '#map');
  await page.getByLabel('البحث في المواقع').fill('المبنى المشترك');
  await page.locator('.tree-hit', { hasText: 'المبنى المشترك' }).first().click();
  await page.getByRole('button', { name: 'إعداد الموارد وعلاقاتها' }).click();
  const dialog = page.locator('.resource-settings');
  const row = (name) => dialog.locator('tbody tr', { hasText: name });
  const form = dialog.locator('.resource-form');

  await step('RES-01', 'A shared resource has no limit until one is set; a limit is saved and removed again', async () => {
    await row('استخدام المبنى المشترك').locator('td', { hasText: 'بلا حد' }).waitFor();
    await row('استخدام المبنى المشترك').getByRole('button', { name: 'تعديل' }).click();
    await form.getByLabel(/حد الاستخدام المتزامن/).fill('5');
    await form.getByRole('button', { name: 'حفظ المورد' }).click();
    await row('استخدام المبنى المشترك').locator('td', { hasText: '5 استخدامات' }).waitFor();
    await page.screenshot({ path: shot('res-01-shared-limit.png'), fullPage: true });
    await row('استخدام المبنى المشترك').getByRole('button', { name: 'تعديل' }).click();
    await form.getByLabel(/حد الاستخدام المتزامن/).fill('');
    await form.getByRole('button', { name: 'حفظ المورد' }).click();
    await row('استخدام المبنى المشترك').locator('td', { hasText: 'بلا حد' }).waitFor();
    return 'بلا حد ← 5 ← بلا حد';
  });

  await step('RES-02', 'The relation with sub-resources is switched to independent and back', async () => {
    await row('استخدام المبنى المشترك').getByRole('button', { name: 'تعديل' }).click();
    await form.getByText('مستقل: يُحجز هو وموارده الفرعية كل على حدة').click();
    await form.getByRole('button', { name: 'حفظ المورد' }).click();
    await row('استخدام المبنى المشترك').locator('td', { hasText: 'مستقل عن موارده الفرعية' }).waitFor();
    await row('استخدام المبنى المشترك').getByRole('button', { name: 'تعديل' }).click();
    await form.getByText('حجزه يمنع موارده الفرعية، وحجز أي منها يمنعه (افتراضي)').click();
    await form.getByRole('button', { name: 'حفظ المورد' }).click();
    await row('استخدام المبنى المشترك').locator('td', { hasText: 'حجزه يمنع موارده الفرعية' }).waitFor();
  });

  await step('RES-03', 'An invalid setting is refused by the server and shown in the dialog', async () => {
    await row('القاعة متعددة الاستخدام').getByRole('button', { name: 'تعديل' }).click();
    if (await form.getByLabel(/حد الاستخدام المتزامن/).count()) throw new Error('limit offered for an exclusive resource');
    await form.getByLabel('فترة التسليم (دقيقة)').fill('99999');
    await form.getByRole('button', { name: 'حفظ المورد' }).click();
    await dialog.locator('.error-text', { hasText: 'فترة التسليم بين 0 و10080' }).waitFor();
    await form.getByRole('button', { name: 'إلغاء' }).click();
  });
} finally {
  await browser.close();
}

writeFileSync(new URL('results.json', evidence), JSON.stringify({ run: new Date().toISOString(), results, externalRequests: external, consoleErrors }, null, 2));
const failed = results.filter((r) => r.result !== 'PASS').length;
console.log(`\n${results.length - failed}/${results.length} passed · external requests ${external.length} · console errors ${consoleErrors.length}`);
if (consoleErrors.length) console.log(consoleErrors.join('\n'));
process.exit(failed || consoleErrors.length ? 1 : 0);
