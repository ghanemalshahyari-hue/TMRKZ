// On the one application, with an acceptance batch's people only. It replaces access-requests.mjs and scope-approvals.mjs there: those two
// rewrite the levels of every unit in the published HR snapshot and publish access policy, which must not happen on :8088.
// Covered here: refusal at each stage, a scope of chosen units and of chosen sites as really granted and enforced, the final approver
// removing what the manager added, no deadline on this path, and a grant by units and levels in the permissions page. The policy itself
// is never touched: its version is compared before and after.
//   . ops/acceptance-main/env.sh && . ops/acceptance-main/env-batch.sh b2 && node tests/acceptance/access-scope-8088.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { BASE, apiSession, consoleErrors, external, launch, newContext, signInManual, watch } from './lib/browser.mjs';

const { ACC_NS: NS, ACC_USER_PREFIX: UP = '', ACC_SUFFIX: SFX, DB_CONTAINER: DB, ACC_OUT } = process.env;
const OUT = `${ACC_OUT}/access-scope/`;
mkdirSync(OUT, { recursive: true });
const sql = (q) => execFileSync('docker', ['exec', DB, 'psql', '-X', '-q', '-U', 'mover', '-d', 'mover', '-At', '-c', q], { encoding: 'utf8' }).trim();
const results = [];
const ok = (pass, id, what, detail = '') => {
  results.push({ id, pass: !!pass, what, detail: String(detail).slice(0, 400) });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} — ${what}${detail ? ' · ' + String(detail).slice(0, 240) : ''}`);
};
const org = (x) => sql(`select md5('${NS}:org:${x}')::uuid`);
const site = (x) => sql(`select md5('${NS}:site:${x}')::uuid`);
const person = (u) => sql(`select id from person where username = '${UP}${u}'`);
const live = (u) => sql(`select coalesce(string_agg(role_code, ',' order by role_code), '') from membership where person_id = '${person(u)}' and valid_to is null`);
const policyBefore = sql(`select coalesce(max(version), 0) from access_policy_version`);
const browser = await launch();
const pages = new Map();
const as = async (u) => {
  if (pages.has(u)) return pages.get(u);
  const p = await (await newContext(browser)).newPage();
  watch(p, u);
  await signInManual(p, u);
  pages.set(u, p);
  return p;
};
const go = async (p, hash) => {
  await p.goto(BASE + '/' + hash);
  await p.reload();
  await p.waitForSelector('main#main');
  await p.waitForTimeout(1200);
};
const button = (p, name) => p.getByRole('button', { name, exact: true });
const ask = async (p, role, mode, reason) => {
  await go(p, '#requestAccess');
  await p.locator(`[data-role=${role}]`).first().waitFor({ timeout: 10000 });
  await p.locator(`[data-role=${role}]`).check();
  await p.locator(`[data-scope=${mode}]`).check();
  await p.getByLabel('سبب الطلب').fill(reason);
};
const send = async (p) => {
  await button(p, 'إرسال طلب الصلاحية').click();
  await p.getByTestId('access-open').waitFor({ timeout: 10000 });
};
/** The item of one person in an inbox that may hold other batches' requests. */
const itemOf = (p, name) => p.getByTestId('access-item').filter({ hasText: name + SFX });
const N18 = 'مستخدم جديد ثالث';
const N19 = 'مستخدم جديد رابع';

try {
  // ACC_UNITS_ONLY=1: the grant by units alone, for a batch whose people already asked
  if (process.env.ACC_UNITS_ONLY !== '1') {
  // ---- refused by the reviewer, then by the final approver ---------------------------------------------------------------
  const p18 = await as('p18.new');
  await ask(p18, 'CHAIN_APPROVER', 'UNIT', 'طلب سيُرفض في المراجعة');
  await send(p18);
  const p02 = await as('p02.access');
  await go(p02, '#accessInbox');
  let it = itemOf(p02, N18);
  await it.waitFor({ timeout: 10000 });
  await it.getByLabel('ملاحظة').fill('لا حاجة لهذه الصلاحية');
  await it.getByRole('button', { name: 'رفض', exact: true }).click();
  await it.waitFor({ state: 'detached', timeout: 10000 });
  ok(live('p18.new') === '', 'REJECT-01', 'رفض المراجع لا يمنح شيئاً');
  ok(sql(`select count(*) from audit_event where action = 'REQUEST_REJECTED' and actor_person_id = '${person('p02.access')}'`) === '1', 'REJECT-02', 'الرفض مسجل باسم من رفض');

  const p19 = await as('p19.new');
  await ask(p19, 'CHAIN_APPROVER', 'UNIT', 'طلب سيُرفض في الاعتماد النهائي');
  await send(p19);
  await go(p02, '#accessInbox');
  it = itemOf(p02, N19);
  await it.waitFor({ timeout: 10000 });
  await it.getByRole('button', { name: 'إرسال التوصية', exact: true }).click();
  await it.waitFor({ state: 'detached', timeout: 10000 });
  const p03 = await as('p03.final');
  await go(p03, '#accessInbox');
  it = itemOf(p03, N19);
  await it.waitFor({ timeout: 10000 });
  await it.getByLabel('ملاحظة').fill('رُفض في الاعتماد النهائي');
  await it.getByRole('button', { name: 'رفض', exact: true }).click();
  await it.waitFor({ state: 'detached', timeout: 10000 });
  ok(live('p19.new') === '', 'REJECT-03', 'رفض المعتمد النهائي لا يمنح شيئاً');

  // ---- a scope of chosen units: granted and enforced -----------------------------------------------------------------------
  await ask(p18, 'CHAIN_APPROVER', 'UNITS', 'أحتاج وحدتين فقط');
  const chosen = ['شعبة أ3', 'شعبة أ5'];
  for (const name of chosen) await p18.getByTestId('access-scope').locator('label', { hasText: name + SFX }).locator('input').check();
  await send(p18);
  await go(p02, '#accessInbox');
  it = itemOf(p02, N18);
  await it.waitFor({ timeout: 10000 });
  ok((await it.getByTestId('access-scope-asked').innerText()).includes('وحدات محددة'), 'SCOPE-01', 'المراجع يرى النطاق المطلوب');
  await it.locator('[data-testid=access-extras] [data-role=POSTURE_VIEWER]').check();
  await it.getByRole('button', { name: 'إرسال التوصية', exact: true }).click();
  await it.waitFor({ state: 'detached', timeout: 10000 });
  await go(p03, '#accessInbox');
  it = itemOf(p03, N18);
  await it.waitFor({ timeout: 10000 });
  await p03.screenshot({ path: OUT + 'final-approval-units.png' });
  await it.getByRole('button', { name: 'اعتماد وتفعيل', exact: true }).click();
  await it.waitFor({ state: 'detached', timeout: 10000 });
  ok(live('p18.new') === 'CHAIN_APPROVER,POSTURE_VIEWER', 'SCOPE-02', 'مُنح المطلوب وإضافة المدير', live('p18.new'));
  const targets = sql(`select count(distinct t.target_id) from membership_scope_target t join membership m on m.id = t.membership_id where m.person_id = '${person('p18.new')}' and m.role_code = 'POSTURE_VIEWER'`);
  ok(targets === '2', 'SCOPE-03', 'النطاق المحفوظ وحدتان بالضبط', targets);
  const seen = (await (await apiSession('p18.new')).get('/operational-posture')).body.units.map((u) => u.id);
  ok(seen.includes(org('N-A113')) && seen.includes(org('N-A115')), 'SCOPE-04', 'الخادم يعرض الوحدتين المختارتين');
  ok(!seen.includes(org('N-A111')) && !seen.includes(org('N-A112')) && !seen.includes(org('N-A11')), 'SCOPE-05', 'ولا يعرض غيرهما، مع OpenFGA', `${seen.length} وحدة`);

  // ---- a scope of chosen sites, and the final approver removing the manager's extra -----------------------------------------
  await ask(p19, 'FYI_RECEIVER', 'SITES', 'أتلقى العلم عن موقع واحد');
  await p19.getByTestId('access-scope').locator('label', { hasText: 'موقع نقطة فقط' + SFX }).locator('input').check();
  await send(p19);
  await go(p02, '#accessInbox');
  it = itemOf(p02, N19);
  await it.waitFor({ timeout: 10000 });
  await it.locator('[data-testid=access-extras] [data-role=POSTURE_VIEWER]').check();
  await it.getByRole('button', { name: 'إرسال التوصية', exact: true }).click();
  await it.waitFor({ state: 'detached', timeout: 10000 });
  await go(p03, '#accessInbox');
  it = itemOf(p03, N19);
  await it.waitFor({ timeout: 10000 });
  await it.locator('[data-role=POSTURE_VIEWER]').uncheck();
  await it.getByRole('button', { name: 'اعتماد وتفعيل', exact: true }).click();
  await it.waitFor({ state: 'detached', timeout: 10000 });
  ok(live('p19.new') === 'FYI_RECEIVER', 'SCOPE-06', 'ما أزاله المعتمد النهائي لا يُمنح', live('p19.new'));
  const siteTarget = sql(`select count(*) from membership_scope_target t join membership m on m.id = t.membership_id where m.person_id = '${person('p19.new')}' and t.kind = 'SITE' and t.target_id = '${site('SITE-05')}'`);
  ok(siteTarget === '1', 'SCOPE-07', 'النطاق المحفوظ هو الموقع المختار', siteTarget);

  }

  // ---- this path has no deadline -----------------------------------------------------------------------------------------------
  const admin = await as('p14.admin');
  await go(admin, '#workflow');
  await admin.getByLabel('نوع الطلب').selectOption({ label: 'طلب صلاحيات' });
  await admin.waitForTimeout(1200);
  ok(!/مهلة/.test(await admin.locator('.fs-canvas').innerText()), 'PATH-NO-DEADLINE-1', 'بطاقات هذا المسار بلا مهلة');
  await admin.locator('.react-flow__node').filter({ hasText: 'مراجعة' }).first().click();
  await admin.waitForTimeout(500);
  ok(!/مهلة/.test(await admin.getByTestId('inspector').innerText()), 'PATH-NO-DEADLINE-2', 'ولا حقل مهلة للخطوة');

  // ---- a grant by units and levels in the permissions page, for an acceptance person ------------------------------------------
  const manager = person('p16.branch');
  await go(admin, '#permissions/policy');
  await admin.getByRole('tab', { name: 'المنح والنطاقات' }).click();
  const grid = admin.locator('.access-grid');
  await grid.getByPlaceholder(/ابحث/).first().fill('القيادة الرئيسية أ' + SFX);
  await grid.locator('button', { hasText: 'القيادة الرئيسية أ' + SFX }).first().click();
  await button(admin, 'منحة جديدة').click();
  const form = admin.getByRole('dialog').last();
  await form.getByPlaceholder('ابحث بالاسم أو الرقم الوظيفي…').fill(UP + 'p16.branch');
  await admin.waitForTimeout(800);
  await form.locator('select[aria-label="الشخص"]').selectOption(manager);
  const roleSelect = form.locator('label.field', { hasText: 'الدور' }).locator('select');
  await roleSelect.selectOption('LIMITED_VIEWER');
  await admin.waitForTimeout(200);
  ok((await admin.getByTestId('assign-units').count()) === 0, 'UNITS-01', 'دور لا يعتمد ولا يُبلَّغ بلا زر تعيين');
  await roleSelect.selectOption('UNIT_OPERATIONS_APPROVER');
  await admin.waitForTimeout(200);
  const assign = admin.getByTestId('assign-units');
  ok((await assign.innerText()).trim() === 'تعيين', 'UNITS-02', 'دور يعتمد يعرض «تعيين»');
  await assign.click();
  const dialog = admin.getByTestId('units-dialog');
  await dialog.waitFor();
  await admin.waitForTimeout(700);
  await dialog.getByLabel('ابحث عن وحدة').fill('القيادة الرئيسية أ' + SFX);
  await admin.waitForTimeout(700);
  const hit = dialog.locator('.ud-hit', { hasText: 'القيادة الرئيسية أ' + SFX });
  ok((await hit.count()) === 1, 'UNITS-03', 'البحث يجد الوحدة الرئيسية', await hit.count());
  await hit.locator('input').check();
  const row = dialog.getByTestId('unit-row').first();
  const scopeSelect = row.locator('select');
  ok((await scopeSelect.inputValue()) === 'ONE', 'UNITS-04', 'الوحدة المختارة تبدأ بـ«الوحدة فقط»');
  await scopeSelect.selectOption('BRANCH');
  await admin.waitForTimeout(700);
  ok(/وحد/.test(await row.getByTestId('unit-covered').innerText()), 'UNITS-05', 'ما تغطيه الوحدة مع مستوياتها معدود', await row.getByTestId('unit-covered').innerText());
  await scopeSelect.selectOption('LEVELS');
  await admin.waitForTimeout(300);
  const levelBoxes = row.getByRole('group').locator('label');
  await levelBoxes.filter({ hasText: /^\s*8\s*$/ }).locator('input').check();
  await levelBoxes.filter({ hasText: /^\s*9\s*$/ }).locator('input').check();
  await admin.waitForTimeout(700);
  ok((await row.getByTestId('unit-covered').innerText()).includes('المستوى 8 و9'), 'UNITS-06', 'المستويات المختارة تُعد أيضاً', await row.getByTestId('unit-covered').innerText());
  await button(admin, 'اعتماد الاختيار').click();
  ok((await form.locator('.scope-preview').innerText()).includes('المستوى 8 و9'), 'UNITS-07', 'النطاق يُقرأ بالكلمات قبل الحفظ');
  await button(admin, 'حفظ المنحة').click();
  await admin.waitForTimeout(1500);
  const levels = sql(`select array_to_string(t.levels, ',') from membership_scope_target t join membership m on m.id = t.membership_id where m.person_id = '${manager}' and m.role_code = 'UNIT_OPERATIONS_APPROVER' and m.valid_to is null`);
  ok(levels === '8,9', 'UNITS-08', 'المنحة تحفظ المستويات لا قائمة وحدات', levels);
  await admin.screenshot({ path: OUT + 'grant-by-levels.png' });

  ok(sql(`select coalesce(max(version), 0) from access_policy_version`) === policyBefore, 'POLICY-UNCHANGED', 'سياسة الصلاحيات لم تتغير', policyBefore);
  ok(consoleErrors.length === 0, 'CONSOLE', 'لا أخطاء في المتصفح', consoleErrors.slice(0, 3).join(' | '));
  ok(external.length === 0, 'EXTERNAL', 'صفر طلب خارجي', external.slice(0, 3).join(' | '));
} catch (e) {
  ok(false, 'ABORT', 'توقف التشغيل', e.message.slice(0, 500));
  for (const [u, p] of pages) await p.screenshot({ path: `${OUT}abort-${u}.png` }).catch(() => undefined);
} finally {
  await browser.close();
}
writeFileSync(OUT + 'results.json', JSON.stringify({ at: new Date().toISOString(), results, consoleErrors, external }, null, 1) + '\n');
const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
