// Visual rule editor in Microsoft Edge against the acceptance environment (PA-21, owner brief §9).
// Rules are authored by clicks only; the API is used for setup and to cross-check what the server stored and enforces
// (reported separately). The environment is restored at the end: the form loses the test rules in a new version and
// the workflow draft returns to the published stages.
// Usage: sh ops/test-env/up.sh && node tests/acceptance/rule-editor.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { apiSession, consoleErrors, external, launch, newContext, signInManual, watch } from './lib/browser.mjs';

const results = [];
const setup = [];
const evidence = new URL('../../docs/evidence/rules/', import.meta.url);
mkdirSync(evidence, { recursive: true });
const shot = (name) => fileURLToPath(new URL(name, evidence));
const TYPE = 'نقل إداري';

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
const expect = (cond, message) => {
  if (!cond) throw new Error(message);
};

/** Adds one condition "subject op value" to a rule editor section. */
async function addCondition(section, subject, op, value) {
  const add = section.getByRole('button', { name: 'إضافة شرط' });
  if (await add.count()) await add.click();
  else await section.getByRole('button', { name: 'شرط', exact: true }).click();
  const row = section.locator('.rule-cond').last();
  await row.getByLabel('موضوع الشرط').selectOption(subject);
  await row.getByLabel('المعامل').selectOption(op);
  if (value !== undefined) await row.getByLabel('قيمة الشرط').fill(String(value));
}

/** Same rule regardless of key order. */
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));

/** Publishes the form from the studio and waits until the server reports a newer published version. */
async function publishForm(page) {
  const before = (await publishedForm()).version;
  await page.getByRole('button', { name: 'نشر النموذج' }).click();
  for (let i = 0; i < 60; i++) {
    const now = await publishedForm();
    if (now.version > before) return now;
    await page.waitForTimeout(250);
  }
  throw new Error('form not published');
}

const admin = await apiSession('t.admin');
const requester = await apiSession('t.requester');
const publishedForm = async () => {
  const forms = (await admin.get('/forms')).body;
  const item = forms.find((f) => f.requestType.code === 'ADMIN_TRANSFER');
  return (await admin.get('/form-versions/' + item.published.id)).body;
};

const browser = await launch();
try {
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  watch(page, 't.admin');
  await signInManual(page, 't.admin');
  const base = page.url().split('#')[0];

  await step('RULES-01', 'Visibility and requirement built by clicks, tried on the server, published as the typed rule', async () => {
    await page.goto(base + '#forms');
    await page.getByLabel('نوع الطلب').selectOption({ label: TYPE });
    const row = page.locator('tr', { has: page.locator('span.latin', { hasText: /^reference$/ }) });
    await row.getByRole('button', { name: /قواعد الحقل/ }).click();
    const dialog = page.locator('.rules-layout');
    const visible = dialog.getByRole('region', { name: 'يظهر الحقل عندما' });
    await addCondition(visible, 'fact:durationDays', 'gt', 7);
    await visible.locator('.rule-sentence', { hasText: '«مدة الطلب بالأيام» أكبر من «7»' }).waitFor();
    const required = dialog.getByRole('region', { name: 'يصبح الحقل مطلوباً عندما' });
    await addCondition(required, 'fact:durationDays', 'gt', 30);
    const tryDays = dialog.locator('.rules-try').getByLabel('مدة الطلب بالأيام');
    const states = [];
    for (const [days, want] of [
      [3, 'لا يظهر'],
      [10, 'اختياري'],
      [40, 'مطلوب'],
    ]) {
      await tryDays.fill(String(days));
      await dialog.locator('.rules-result', { hasText: want }).waitFor();
      states.push(days + ' يوم ← ' + want);
    }
    await page.screenshot({ path: shot('rules-01-field-rules.png'), fullPage: true });
    await page.getByRole('button', { name: 'تطبيق على المسودة' }).click();
    await row.locator('.rule-cell', { hasText: 'يظهر عندما: «مدة الطلب بالأيام» أكبر من «7»' }).waitFor();
    const field = (await publishForm(page)).schema.fields.find((f) => f.id === 'reference');
    setup.push('GET /forms, /form-versions/{id}: published rule read back');
    expect(canon(field.visibleWhen) === canon({ fact: 'durationDays', op: 'gt', value: 7 }), 'visibleWhen ' + JSON.stringify(field.visibleWhen));
    expect(canon(field.requiredWhen) === canon({ fact: 'durationDays', op: 'gt', value: 30 }), 'requiredWhen ' + JSON.stringify(field.requiredWhen));
    return states.join(' · ') + ' · المخزن مطابق';
  });

  await step('RULES-02', 'The server enforces the published rule on submission (no client trust)', async () => {
    const me = (await requester.get('/me')).body;
    const org = me.grants.find((g) => g.permissions.includes('CREATE'))?.organization?.id;
    const sites = (await requester.get('/sites')).body;
    const resource = sites.flatMap((s) => (s.view === 'FULL' ? s.resources : [])).find((r) => r.policy === 'EXCLUSIVE');
    const create = await requester.post('/requests', {
      typeCode: 'ADMIN_TRANSFER',
      origin: 'LIST',
      ownerOrgId: org,
      resourceIds: [resource.id],
      period: { start: '2031-03-01T08:00:00+04:00', end: '2031-04-15T08:00:00+04:00' },
      values: { reason: 'نقل إداري طويل المدة لاختبار القواعد', headcount: 5 },
    });
    setup.push('POST /requests (draft, 45 days): ' + create.status);
    expect(create.status === 200, 'draft ' + create.status + ' ' + JSON.stringify(create.body));
    const id = create.body.id;
    const version = (await requester.get('/requests/' + id)).body.version;
    const submit = await requester.post('/requests/' + id + '/submit', { expectedVersion: version, __key: 'rules-' + Date.now() });
    setup.push('POST /requests/{id}/submit: ' + submit.status);
    expect(submit.status === 400, 'submit ' + submit.status);
    const label = (await publishedForm()).schema.fields.find((f) => f.id === 'reference').label;
    expect(JSON.stringify(submit.body).includes(label), 'message names the field: ' + JSON.stringify(submit.body).slice(0, 200));
    return 'طلب 45 يوماً دون «' + label + '» ← رفض 400 من الخادم';
  });

  await step('RULES-03', 'A stage made conditional by clicks; the simulation skips or runs it by sample values', async () => {
    await page.goto(base + '#workflow');
    await page.getByLabel('نوع الطلب المرتبط').selectOption({ label: TYPE });
    const stage = page.locator('.flow-node').first();
    await stage.getByRole('button', { name: /المرحلة شرطية|شرط المرحلة/ }).click();
    const editor = page.getByRole('region', { name: 'تُنفذ المرحلة عندما' });
    if (await editor.getByRole('button', { name: 'إزالة الشرط' }).count()) await editor.getByRole('button', { name: 'إزالة الشرط' }).click();
    await addCondition(editor, 'fact:resourceCount', 'gt', 1);
    await page.getByRole('button', { name: 'تطبيق على المسودة' }).click();
    await stage.locator('.stage-condition', { hasText: '«عدد الموارد المطلوبة» أكبر من «1»' }).waitFor();
    const count = page.locator('.sim-inputs').getByLabel('عدد الموارد المطلوبة');
    await count.fill('1');
    await page.getByRole('button', { name: 'محاكاة الأثر' }).click();
    await page.locator('.test-list li', { hasText: 'تُتخطى' }).first().waitFor();
    await count.fill('2');
    await page.getByRole('button', { name: 'محاكاة الأثر' }).click();
    await page.waitForFunction(() => ![...document.querySelectorAll('.test-list li')].some((li) => li.textContent.includes('تُتخطى')));
    await page.screenshot({ path: shot('rules-03-stage-condition.png'), fullPage: true });
    // leave the server draft equal to the published stages
    await stage.getByRole('button', { name: 'تعديل شرط المرحلة' }).click();
    await page.getByRole('region', { name: 'تُنفذ المرحلة عندما' }).getByRole('button', { name: 'إزالة الشرط' }).click();
    await page.getByRole('button', { name: 'تطبيق على المسودة' }).click();
    await page.getByRole('button', { name: 'محاكاة الأثر' }).click();
    await page.locator('.test-list li').first().waitFor();
    return 'موارد 1 ← المرحلة الأولى تُتخطى · موارد 2 ← تُنفذ';
  });

  await step('RULES-04', 'Clean-up through the interface: rules removed and published as a new version', async () => {
    await page.goto(base + '#forms');
    await page.getByLabel('نوع الطلب').selectOption({ label: TYPE });
    const row = page.locator('tr', { has: page.locator('span.latin', { hasText: /^reference$/ }) });
    await row.getByRole('button', { name: /قواعد الحقل/ }).click();
    for (const name of ['يظهر الحقل عندما', 'يصبح الحقل مطلوباً عندما']) {
      const region = page.getByRole('region', { name });
      if (await region.getByRole('button', { name: 'إزالة الشرط' }).count()) await region.getByRole('button', { name: 'إزالة الشرط' }).click();
    }
    await page.getByRole('button', { name: 'تطبيق على المسودة' }).click();
    await row.locator('.rule-cell', { hasText: 'إضافة قاعدة' }).waitFor();
    const field = (await publishForm(page)).schema.fields.find((f) => f.id === 'reference');
    expect(!field.visibleWhen && !field.requiredWhen, 'rules still present');
  });
} finally {
  await browser.close();
}

writeFileSync(new URL('results.json', evidence), JSON.stringify({ run: new Date().toISOString(), results, setupApiCalls: setup, externalRequests: external, consoleErrors }, null, 2));
const failed = results.filter((r) => r.result !== 'PASS').length;
console.log(`\n${results.length - failed}/${results.length} passed · setup API calls ${setup.length} · external requests ${external.length} · console errors ${consoleErrors.length}`);
if (consoleErrors.length) console.log(consoleErrors.join('\n'));
process.exit(failed || consoleErrors.length ? 1 : 0);
