// Asking for permissions on the real pages and real sign-ins (ADR-044), in the acceptance environment with its fictional people:
// a person with no permission sees only the page to ask; a reviewer advises; only the final approval grants.
//
//   sh ops/test-env/up.sh && BROWSER_PATH=… MOVER_URL=… node tests/acceptance/access-requests.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BASE, apiSession, consoleErrors, launch, newContext, signInManual, watch } from './lib/browser.mjs';

const DB = process.env.DB_CONTAINER ?? 'tmrkz-test-db-1';
const evidence = fileURLToPath(new URL('../../docs/evidence/access-requests/', import.meta.url));
mkdirSync(evidence, { recursive: true });
const sql = (q) => execFileSync('docker', ['exec', DB, 'psql', '-X', '-q', '-U', 'mover', '-d', 'mover', '-At', '-c', q], { encoding: 'utf8' }).trim();
const results = [];
const ok = (pass, id, what, detail = '') => {
  results.push({ id, pass: !!pass, what, detail: String(detail).slice(0, 300) });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} — ${what}${detail ? ' · ' + String(detail).slice(0, 200) : ''}`);
};
const org = (code) => sql(`select id from organization where code = 'HR-T-${code}'`);
const person = (u) => sql(`select id from person where username = '${u}'`);

// the fictional hierarchy, and a person with an HR unit and no permission
sql(`update hr_unit set level = 6, is_main = external_id = 'T-IT' where snapshot_id = (select id from hr_snapshot where status = 'PUBLISHED')`);
sql(`update membership set valid_to = now() where person_id = '${person('t.requester2')}'`);
const admin = await apiSession('t.admin');
const template = JSON.parse(readFileSync(new URL('../../ops/policy/approval-roles.json', import.meta.url), 'utf8'));
await admin.post('/access/policy/draft', { note: template.note });
for (const role of template.roles) {
  const s = await fetch(BASE + '/api/v1/access/policy/draft/roles', { method: 'PUT', headers: { Cookie: admin.cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'mover' }, body: JSON.stringify(role) });
  if (s.status !== 200) ok(false, 'S01', 'role refused: ' + role.code, await s.text());
}
const pub = await admin.post('/access/policy/draft/publish', { note: template.note });
ok(pub.status === 200, 'S01', 'the roles are published through the policy', pub.status === 200 ? '' : JSON.stringify(pub.body));
const grant = async (who, role, home, scope) => {
  const r = await admin.post('/memberships', { personId: person(who), organizationId: home, roleCode: role, validFrom: new Date(Date.now() - 86400000).toISOString(), ...(scope ? { scope } : {}) });
  if (r.status !== 200) throw new Error('grant ' + who + ': ' + JSON.stringify(r.body).slice(0, 200));
};
await grant('t.manager.it', 'UNIT_ACCESS_MANAGER', org('IT'));
await grant('t.approver2', 'ACCESS_FINAL_APPROVER', org('GA'));

const browser = await launch();
try {
  const adminPage = await (await newContext(browser)).newPage();
  watch(adminPage, 't.admin');
  await signInManual(adminPage, 't.admin');
  await adminPage.goto(BASE + '/#workflow');
  await adminPage.getByTestId('type-add').click();
  await adminPage.getByLabel('اسم نوع الطلب').fill('طلب صلاحيات');
  ok((await adminPage.getByRole('radiogroup').count()) === 0, 'A00', 'choosing the subject first shows nothing about bookings');
  await adminPage.getByTestId('topic-access').click();
  ok((await adminPage.getByRole('radiogroup').count()) === 0, 'A00a', 'and permissions asks nothing more');
  await adminPage.getByRole('button', { name: 'إضافة', exact: true }).click();
  await adminPage.waitForTimeout(1500);
  const shown = await adminPage.locator('select[aria-label="نوع الطلب"] option:checked').innerText();
  ok(shown === 'طلب صلاحيات', 'A01', 'the type is added from the screen, and selected', shown);
  ok((await adminPage.locator('[data-testid=node-start]').count()) === 1, 'A02', 'its path starts empty');
  await adminPage.screenshot({ path: evidence + 'A-new-type.png' });

  const item = (await admin.get('/workflows')).body.find((w) => w.requestType.name === 'طلب صلاحيات');
  const step = (id, name, role, extra = {}) => ({ id, type: 'approval', name, x: 300, y: 100, mode: 'ANY', slaDays: 3, assignees: [{ role, orgFrom: 'BY_SCOPE' }], final: false, requiresSignature: false, ...extra });
  const graph = {
    nodes: [{ id: 'st', type: 'start', name: 'بداية الطلب', x: 300, y: 0 }, step('rev', 'مراجعة مدير صلاحيات الوحدة', 'UNIT_ACCESS_MANAGER'), step('fin', 'اعتماد طلبات الصلاحية', 'ACCESS_FINAL_APPROVER', { final: true }), { id: 'ok', type: 'end_approved', name: 'معتمد', x: 300, y: 500 }],
    edges: [{ from: 'st', to: 'rev' }, { from: 'rev', to: 'fin', when: 'approved' }, { from: 'fin', to: 'ok', when: 'approved' }],
  };

  // ---- before the path is active ------------------------------------------------------------------------------------
  const asker = await (await newContext(browser)).newPage();
  watch(asker, 't.requester2');
  await signInManual(asker, 't.requester2');
  await asker.waitForTimeout(1200);
  ok((await asker.getByTestId('access-request').count()) === 1, 'Z01', 'a person with no permission lands on the page to ask');
  ok((await asker.getByTestId('access-unavailable').count()) === 1, 'Z02', 'and it says when the path is not active yet');

  const draft = await admin.post(`/workflows/${item.id}/drafts`, { definition: { name: 'طلب صلاحيات', stages: [], execution: [], graph } });
  const live = await admin.post(`/workflow-versions/${draft.body.id}/publish`, {});
  ok(live.status === 200, 'A03', 'the path is activated', live.status === 200 ? '' : JSON.stringify(live.body).slice(0, 240));

  // ---- the administrator decides what is shown; no deadline on this type -------------------------------------------------
  await adminPage.reload();
  await adminPage.locator('select[aria-label="نوع الطلب"]').selectOption({ label: 'طلب صلاحيات' });
  await adminPage.locator('[data-testid=node-approval]').first().waitFor({ timeout: 15000 });
  await adminPage.waitForTimeout(600);
  ok(!(await adminPage.locator('.fs-canvas').innerText()).includes('المهلة'), 'D01', 'the cards of this type show no deadline');
  await adminPage.getByRole('button', { name: 'ترتيب البطاقات' }).click();
  await adminPage.waitForTimeout(600);
  await adminPage.locator('[data-testid=node-approval]').first().click();
  await adminPage.getByTestId('inspector').waitFor();
  ok(!(await adminPage.getByTestId('inspector').innerText()).includes('المهلة'), 'D02', 'and the step has no deadline to set');
  await adminPage.getByTestId('access-offer').click();
  await adminPage.locator('[data-offer]').first().waitFor({ timeout: 8000 });
  const offerable = await adminPage.locator('[data-offer]').evaluateAll((l) => l.map((e) => e.getAttribute('data-offer')));
  ok(offerable.includes('REQUESTER') && !offerable.includes('SYSTEM_ADMIN') && !offerable.includes('UNIT_ACCESS_MANAGER') && !offerable.includes('ACCESS_FINAL_APPROVER'), 'O01', 'the administrator chooses among what can be offered', offerable.join());
  await adminPage.locator('[data-offer=FYI_RECEIVER]').selectOption('MANAGER');
  await adminPage.screenshot({ path: evidence + 'A-what-is-shown.png' });
  await adminPage.getByRole('button', { name: 'حفظ', exact: true }).last().click();
  await adminPage.getByTestId('access-offer-dialog').waitFor({ state: 'detached', timeout: 8000 });
  ok(true, 'O02', 'and saves it');

  // ---- the person ------------------------------------------------------------------------------------------------------
  await asker.goto(BASE + '/#audit');
  await asker.reload();
  await asker.waitForTimeout(1500);
  ok((await asker.getByTestId('access-request').count()) === 1, 'Z03', 'any address still shows only this page');
  const nav = await asker.locator('.tz-top .tz-nav').innerText();
  ok(nav.replace(/\s+/g, ' ').trim() === 'طلب صلاحية', 'Z04', 'the menu has nothing else', nav.replace(/\s+/g, ' '));
  const offered = await asker.locator('[data-role]').evaluateAll((l) => l.map((e) => e.getAttribute('data-role')));
  ok(offered.join() === 'REQUESTER,CHAIN_APPROVER,UNIT_OPERATIONS_APPROVER', 'Z05', 'it offers only what the administrator shows to everyone', offered.join());
  await asker.screenshot({ path: evidence + 'B-the-page-to-ask.png' });
  await asker.locator('[data-role=REQUESTER]').check();
  await asker.locator('[data-role=CHAIN_APPROVER]').check();
  await asker.getByLabel('سبب الطلب').fill('أحتاجها لعملي في إدارة التقنية');
  await asker.getByRole('button', { name: 'إرسال طلب الصلاحية' }).click();
  await asker.getByTestId('access-open').waitFor({ timeout: 10000 });
  ok(true, 'Z06', 'it is sent, and no second one can be while it is open');
  ok((await asker.getByTestId('access-mine').innerText()).includes('مراجعة مدير صلاحيات الوحدة'), 'Z07', 'the person sees where it waits');

  // ---- the reviewer ---------------------------------------------------------------------------------------------------
  const reviewer = await (await newContext(browser)).newPage();
  watch(reviewer, 't.manager.it');
  await signInManual(reviewer, 't.manager.it');
  await reviewer.goto(BASE + '/#accessInbox');
  await reviewer.reload();
  const card = reviewer.getByTestId('access-item');
  await card.waitFor({ timeout: 10000 });
  ok((await card.innerText()).includes('أحتاجها لعملي'), 'R01', 'the reviewer has it, with the reason');
  await card.locator('[data-role=CHAIN_APPROVER]').uncheck();
  ok((await card.getByTestId('access-extras').innerText()).includes('للعلم'), 'R01a', 'the manager has the extra permissions the person did not see');
  await card.getByTestId('access-extras').locator('[data-role=FYI_RECEIVER]').check();
  await reviewer.screenshot({ path: evidence + 'C-the-reviewer.png' });
  await card.getByRole('button', { name: 'إرسال التوصية' }).click();
  await reviewer.getByText('لا توجد طلبات تنتظرك').waitFor({ timeout: 10000 });
  ok(sql(`select count(*) from membership where person_id = '${person('t.requester2')}' and valid_to is null`) === '0', 'R02', 'advice grants nothing');

  // ---- the final approver --------------------------------------------------------------------------------------------
  const finalApprover = await (await newContext(browser)).newPage();
  watch(finalApprover, 't.approver2');
  await signInManual(finalApprover, 't.approver2');
  await finalApprover.goto(BASE + '/#accessInbox');
  await finalApprover.reload();
  const last = finalApprover.getByTestId('access-item');
  await last.waitFor({ timeout: 10000 });
  ok((await last.getByTestId('access-advice').innerText()).includes('مقدم الطلب') && (await last.getByTestId('access-advice').innerText()).includes('للعلم') && !(await last.getByTestId('access-advice').innerText()).includes('السلسلة'), 'F01', 'the final approver sees the advice', await last.getByTestId('access-advice').innerText());
  await finalApprover.screenshot({ path: evidence + 'D-the-final-approver.png' });
  await last.getByRole('button', { name: 'اعتماد وتفعيل' }).click();
  await finalApprover.getByText('لا توجد طلبات تنتظرك').waitFor({ timeout: 10000 });
  const held = sql(`select string_agg(role_code, ',' order by role_code) from membership where person_id = '${person('t.requester2')}' and valid_to is null`);
  ok(held === 'FYI_RECEIVER,REQUESTER', 'F02', 'what the final approver chose is granted, the extra included, and what the manager removed is not', held);

  await asker.reload();
  await asker.waitForTimeout(2000);
  const after = (await asker.locator('.tz-top .tz-nav').innerText()).replace(/\s+/g, ' ');
  ok(after.includes('الرئيسية') && after.includes('الطلبات'), 'Z08', 'the person’s application opens', after);
  await asker.goto(BASE + '/#requestAccess');
  await asker.waitForTimeout(1200);
  ok((await asker.getByTestId('access-mine').innerText()).includes('فُعّل: مقدم الطلب'), 'Z09', 'and their list says what was activated');
  await asker.screenshot({ path: evidence + 'E-activated.png' });
  ok(consoleErrors.length === 0, 'Z10', 'no browser errors', consoleErrors.join(' | '));
} finally {
  await browser.close();
}
writeFileSync(evidence + 'results.json', JSON.stringify({ at: new Date().toISOString(), results }, null, 1) + '\n');
const failed = results.filter((x) => !x.pass);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
