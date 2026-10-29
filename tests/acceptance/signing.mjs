// Certificate signature and organisation seal in Microsoft Edge against the acceptance environment (PA-22/PA-23,
// ADR-020) with the fictional signing PKI of ops/test-env/signing-pki.sh. Setup through the API (reported separately):
// signature mode PKI, two requests carried to their final stage. Browser: the approver signs, the seal is added, both
// are validated, the decision publishes them, the document re-validates; the approver with a revoked certificate is
// refused and nothing is approved. The signature mode is restored at the end.
// Usage: sh ops/test-env/up.sh && node tests/acceptance/signing.mjs
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { apiSession, consoleErrors, external, launch, newContext, signInManual, watch } from './lib/browser.mjs';

const results = [];
const setup = [];
const evidence = new URL('../../docs/evidence/signing/', import.meta.url);
mkdirSync(evidence, { recursive: true });
const shot = (name) => fileURLToPath(new URL(name, evidence));
const key = () => createHash('sha1').update(String(Math.random())).digest('hex');

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
const call = async (label, p) => {
  const r = await p;
  setup.push(label + ': ' + r.status);
  if (r.status >= 300) throw new Error(label + ' ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 300));
  return r.body;
};

const admin = await apiSession('t.admin');
const requester = await apiSession('t.requester');
const facilities = await apiSession('t.facilities');
const manager = await apiSession('t.manager');

async function setMode(mode) {
  const settings = (await admin.get('/policies/current')).body.settings;
  const d = await call('policy draft ' + mode, admin.post('/policies/drafts', { settings: { ...settings, signatureMode: mode } }));
  await call('policy publish ' + mode, admin.post('/policy-versions/' + d.id + '/publish', {}));
}

/** A request on R-05 for a free day, carried through the earlier stages to the final approval (setup only). */
async function atFinalStage(day, subject) {
  const sites = (await requester.get('/sites')).body;
  const res = sites.flatMap((s) => s.resources).find((r) => r.code === 'R-05');
  const type = (await requester.get('/request-types')).body.find((t) => t.kind === 'NEW_RESERVATION').code;
  const org = (await requester.get('/me')).body.primaryOrg.id;
  const d = await call('create ' + subject, requester.post('/requests', { typeCode: type, origin: 'LIST', ownerOrgId: org, resourceIds: [res.id], subject,
    unit: 'DAYS', period: { start: day + 'T00:00:00+04:00', end: day + 'T23:00:00+04:00' }, values: { reason: 'اختبار التوقيع بالشهادة وختم الجهة' } }));
  await call('submit ' + subject, requester.post('/requests/' + d.id + '/submit', { expectedVersion: d.version, __key: key() }));
  for (const u of [facilities, manager]) {
    const t = ((await u.get('/tasks')).body ?? []).find((x) => x.requestId === d.id && !x.final);
    if (t) await call('decide ' + t.stageKey, u.post('/tasks/' + t.id + '/decision', { decision: 'APPROVE', expectedRevision: 1, __key: key() }));
  }
  return (await requester.get('/requests/' + d.id)).body.number;
}

const stamp = Date.now() % 100000;
const dayA = '2031-' + String(1 + (stamp % 12)).padStart(2, '0') + '-' + String(1 + (stamp % 27)).padStart(2, '0');
const dayB = '2032-' + String(1 + (stamp % 12)).padStart(2, '0') + '-' + String(1 + (stamp % 27)).padStart(2, '0');

await setMode('PKI');
const browser = await launch();
try {
  const numberA = await atFinalStage(dayA, 'توقيع بالشهادة ' + stamp);
  const numberB = await atFinalStage(dayB, 'شهادة ملغاة ' + stamp);

  await step('SIGN-01', 'The approver signs with the certificate, the organisation seal is added, both validate, the decision publishes them', async () => {
    const ctx = await newContext(browser);
    const page = await ctx.newPage();
    watch(page, 't.approver');
    await signInManual(page, 't.approver');
    await page.goto(page.url().split('#')[0] + '#review');
    await page.locator('.inbox-item', { hasText: numberA }).click();
    await page.getByRole('button', { name: /اعتماد وتوقيع/ }).first().click();
    const dialog = page.locator('dialog[open]');
    await dialog.getByRole('button', { name: 'التوقيع بشهادتي وختم الجهة' }).click();
    await dialog.locator('.signature-checks li', { hasText: 'توقيع المعتمد' }).waitFor();
    await dialog.locator('.signature-checks li', { hasText: 'ختم الجهة' }).waitFor();
    expect((await dialog.locator('.signature-checks li.bad').count()) === 0, 'a signature did not validate');
    await dialog.screenshot({ path: shot('sign-01-signed.png') });
    await dialog.getByRole('button', { name: 'نشر التوقيع والاعتماد' }).click();
    await page.getByText('اكتمل الاعتماد وثُبت الحجز').waitFor();
    await page.locator('.document-signature', { hasText: 'ختم الجهة' }).first().waitFor();
    await page.getByRole('button', { name: 'تحقق من التوقيع والختم الآن' }).click();
    await page.locator('.document-verification.good').waitFor();
    await page.locator('.document-signoff').screenshot({ path: shot('sign-01-verified.png') });
    await ctx.close();
    return numberA + ': موقع ومختوم ومنشور ومتحقق منه';
  });

  await step('SIGN-02', 'An approver whose certificate is revoked is refused; nothing is approved', async () => {
    const ctx = await newContext(browser);
    const page = await ctx.newPage();
    watch(page, 't.approver2');
    await signInManual(page, 't.approver2');
    await page.goto(page.url().split('#')[0] + '#review');
    await page.locator('.inbox-item', { hasText: numberB }).click();
    await page.getByRole('button', { name: /اعتماد وتوقيع/ }).first().click();
    const dialog = page.locator('dialog[open]');
    await dialog.getByRole('button', { name: 'التوقيع بشهادتي وختم الجهة' }).click();
    await dialog.locator('.error-text', { hasText: 'ملغاة' }).waitFor();
    expect(await dialog.getByRole('button', { name: 'نشر التوقيع والاعتماد' }).isDisabled(), 'publish enabled without a valid signature');
    await dialog.screenshot({ path: shot('sign-02-revoked.png') });
    await ctx.close();
    const list = (await requester.get('/requests?size=50')).body.items.find((x) => x.number === numberB);
    expect(list && list.status === 'SUBMITTED', 'request left review: ' + JSON.stringify(list));
    return numberB + ': شهادة ملغاة ← رفض، الطلب قيد المراجعة';
  });
} finally {
  await browser.close();
  await setMode('INTERNAL_ATTESTATION');
}

writeFileSync(new URL('results.json', evidence), JSON.stringify({ run: new Date().toISOString(), results, setupApiCalls: setup, externalRequests: external, consoleErrors }, null, 2));
const failed = results.filter((r) => r.result !== 'PASS').length;
console.log(`\n${results.length - failed}/${results.length} passed · setup API calls ${setup.length} · external requests ${external.length} · console errors ${consoleErrors.length}`);
if (consoleErrors.length) console.log(consoleErrors.join('\n'));
process.exit(failed || consoleErrors.length ? 1 : 0);
