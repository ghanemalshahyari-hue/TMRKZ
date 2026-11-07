// Approvals by a grant's scope, independence and for-information by place (ADR-042), in the acceptance environment with its
// fictional people: the units dialog and the studio on the real page, then a whole request from the lowest unit to the
// for-information notices, decided by real sign-ins with OpenFGA in the loop.
//
//   sh ops/test-env/up.sh && BROWSER_PATH=… MOVER_URL=… node tests/acceptance/scope-approvals.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { apiSession, launch, newContext, signInManual, watch, consoleErrors } from './lib/browser.mjs';

const DB = process.env.DB_CONTAINER ?? 'tmrkz-test-db-1';
const evidence = fileURLToPath(new URL('../../docs/evidence/scope-approvals/', import.meta.url));
mkdirSync(evidence, { recursive: true });
const sql = (q) => execFileSync('docker', ['exec', DB, 'psql', '-X', '-q', '-U', 'mover', '-d', 'mover', '-At', '-c', q], { encoding: 'utf8' }).trim();
const results = [];
const ok = (pass, id, what, detail = '') => {
  results.push({ id, pass: !!pass, what, detail: String(detail).slice(0, 300) });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} — ${what}${detail ? ' · ' + String(detail).slice(0, 200) : ''}`);
};
let keys = 0;
const key = () => 'scope-' + Date.now() + '-' + ++keys;
const org = (code) => sql(`select id from organization where code = 'HR-T-${code}'`);

// the fictional hierarchy: levels and a main unit, a deep requesting unit, and another unit standing at the same place
sql(`update hr_unit set level = case external_id when 'T-ORG' then 5 when 'T-PM' then 6 when 'T-PM-1' then 7 when 'T-PM-1-1' then 8 when 'T-PM-1-1-1' then 9 else 6 end,
     is_main = external_id = 'T-PM' where snapshot_id = (select id from hr_snapshot where status = 'PUBLISHED')`);
const deep = org('PM-1-1-1');
const main = org('PM');
const it = org('IT');
const siteId = sql(`insert into site(id, code, name, kind, lat, lng) values (gen_random_uuid(), 'SCOPE-${Date.now()}', 'موقع مشترك للتجربة', 'مرفق', 25.2, 55.3) returning id`);
sql(`insert into site_responsibility(id, site_id, organization_id, valid_from) values (gen_random_uuid(), '${siteId}', '${deep}', '2026-01-01T00:00:00Z')`);
const resource = sql(`insert into resource(id, site_id, code, name, kind, policy) values (gen_random_uuid(), '${siteId}', 'R-SCOPE-${Date.now()}', 'قاعة التجربة', 'قاعة', 'EXCLUSIVE') returning id`);

const admin = await apiSession('t.admin');
const person = (u) => sql(`select id from person where username = '${u}'`);
const grant = async (who, code, home, scope) => {
  const r = await admin.post('/memberships', { personId: person(who), organizationId: home, roleCode: code, validFrom: new Date(Date.now() - 86400000).toISOString(), ...(scope ? { scope } : {}) });
  if (r.status !== 200) throw new Error('grant ' + who + ' ' + code + ': ' + JSON.stringify(r.body).slice(0, 200));
  return r.body;
};

// ---- the four roles, published as any other role ----------------------------------------------------------------------
const template = JSON.parse(readFileSync(new URL('../../ops/policy/approval-roles.json', import.meta.url), 'utf8'));
let r = await admin.post('/access/policy/draft', { note: template.note });
ok(r.status === 200, 'S01', 'a policy draft for the approval roles', r.status);
const put = (b) => fetch(process.env.MOVER_URL + '/api/v1/access/policy/draft/roles', { method: 'PUT', headers: { Cookie: admin.cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'mover' }, body: JSON.stringify(b) });
for (const role of template.roles) {
  const s = await put(role);
  if (s.status !== 200) ok(false, 'S01b', 'role refused: ' + role.code, await s.text());
}
r = await admin.post('/access/policy/draft/publish', { note: template.note });
ok(r.status === 200, 'S02', 'the four roles are published through the policy', r.status === 200 ? '' : JSON.stringify(r.body));

// the people other than the one the dialog grants
await grant('t.requester', 'REQUESTER', deep);
await grant('t.manager.it', 'CHAIN_APPROVER', org('PM-1-1'));
await grant('t.manager.ga', 'CHAIN_APPROVER', org('PM-1'));
await grant('t.auditor', 'FYI_RECEIVER', main);
await grant('t.limited', 'FYI_RECEIVER', it); // holds nothing else that reads these requests

// ---- the units dialog on the real page ----------------------------------------------------------------------------------
const browser = await launch();
try {
  const page = await (await newContext(browser)).newPage();
  watch(page, 't.admin');
  await signInManual(page, 't.admin');
  const base = page.url().split('#')[0];
  await page.goto(base + '#permissions/policy');
  await page.getByRole('tab', { name: 'المنح والنطاقات' }).click();
  const grid = page.locator('.access-grid');
  await grid.getByPlaceholder(/ابحث/).first().fill('إدارة المشاريع');
  await grid.locator('button', { hasText: 'إدارة المشاريع' }).first().click();
  await page.getByRole('button', { name: 'منحة جديدة' }).click();
  const form = page.getByRole('dialog').last();
  await form.getByPlaceholder('ابحث بالاسم أو الرقم الوظيفي…').fill('t.manager');
  await page.waitForTimeout(600);
  const managerId = person('t.manager');
  await form.locator('select[aria-label="الشخص"]').selectOption(managerId);
  const roleSelect = form.locator('label.field', { hasText: 'الدور' }).locator('select');
  await roleSelect.selectOption('LIMITED_VIEWER');
  await page.waitForTimeout(200);
  ok((await page.getByTestId('assign-units').count()) === 0, 'U01', 'a role that neither approves nor is told has no button');
  await roleSelect.selectOption('UNIT_OPERATIONS_APPROVER');
  await page.waitForTimeout(200);
  const button = page.getByTestId('assign-units');
  ok((await button.innerText()).trim() === 'تعيين', 'U02', 'an approving role shows «تعيين»');
  await button.click();
  const dialog = page.getByTestId('units-dialog');
  await dialog.waitFor();
  await page.waitForTimeout(700);
  const tree = dialog.getByTestId('units-tree');
  ok((await tree.innerText()).includes('إدارة المشاريع'), 'U03', 'the tree starts at the main units', (await tree.innerText()).replace(/\s+/g, ' ').slice(0, 80));
  ok(!(await tree.innerText()).includes('الخدمات المشتركة'), 'U04', 'and shows nothing outside a main unit');
  await dialog.getByLabel('ابحث عن وحدة').fill('الخدمات');
  await page.waitForTimeout(600);
  ok((await dialog.getByText('لا توجد وحدة بهذا الاسم').count()) === 1, 'U05', 'the search stays inside them as well');
  await dialog.getByLabel('ابحث عن وحدة').fill('');
  await page.waitForTimeout(400);
  await tree.locator('input[type=checkbox]').first().check();
  const row = dialog.getByTestId('unit-row').first();
  const scopeSelect = row.locator('select');
  ok((await scopeSelect.inputValue()) === 'ONE', 'U06', 'a newly ticked unit starts as «الوحدة فقط»', await row.getByTestId('unit-covered').innerText());
  await scopeSelect.selectOption('BRANCH');
  await page.waitForTimeout(700);
  const branchText = await row.getByTestId('unit-covered').innerText();
  ok(branchText.includes('+ 3 وحدات تابعة'), 'U07', 'with all its levels: what it covers is counted', branchText);
  await scopeSelect.selectOption('LEVELS');
  await page.waitForTimeout(300);
  const levelBoxes = row.getByRole('group').locator('label');
  ok((await levelBoxes.count()) > 0, 'U08', 'the levels offered come from the hierarchy', (await levelBoxes.allInnerTexts()).join(' '));
  await levelBoxes.filter({ hasText: /^\s*8\s*$/ }).locator('input').check();
  await levelBoxes.filter({ hasText: /^\s*9\s*$/ }).locator('input').check();
  await page.waitForTimeout(700);
  const levelsText = await row.getByTestId('unit-covered').innerText();
  ok(levelsText.includes('المستوى 8 و9') && levelsText.includes('وحدتان'), 'U09', 'chosen levels are counted too', levelsText);
  await page.screenshot({ path: evidence + 'A-units-dialog.png' });
  await page.getByRole('button', { name: 'اعتماد الاختيار' }).click();
  ok((await button.innerText()).trim() === 'وحدة واحدة', 'U10', 'the button now reads the number of units', await button.innerText());
  ok((await form.locator('.scope-preview').innerText()).includes('المستوى 8 و9'), 'U11', 'the scope reads in words before saving', await form.locator('.scope-preview').innerText());
  await page.getByRole('button', { name: 'حفظ المنحة' }).click();
  await page.locator('td.scope-text', { hasText: 'المستوى 8 و9' }).first().waitFor({ timeout: 10000 });
  ok(sql(`select array_to_string(levels, ',') from membership_scope_target t join membership m on m.id = t.membership_id where m.person_id = '${managerId}' and m.role_code = 'UNIT_OPERATIONS_APPROVER'`) === '8,9', 'U12', 'the grant keeps the levels, not a list of units');
  await page.screenshot({ path: evidence + 'B-grant-saved.png' });

  // the final approver: every unit, chosen in the same dialog
  await page.getByRole('button', { name: 'منحة جديدة' }).click();
  const form2 = page.getByRole('dialog').last();
  await form2.getByPlaceholder('ابحث بالاسم أو الرقم الوظيفي…').fill('t.approver2');
  await page.waitForTimeout(600);
  await form2.locator('select[aria-label="الشخص"]').selectOption(person('t.approver2'));
  await form2.locator('label.field', { hasText: 'الدور' }).locator('select').selectOption('FINAL_APPROVER');
  await page.getByTestId('assign-units').click();
  const finalOptions = await (async () => {
    const d = page.getByTestId('units-dialog');
    await d.getByTestId('units-tree').locator('input[type=checkbox]').first().waitFor();
    await d.getByTestId('units-tree').locator('input[type=checkbox]').first().check();
    const options = await d.getByTestId('unit-row').first().locator('select option').allInnerTexts();
    await d.getByTestId('units-tree').locator('input[type=checkbox]').first().uncheck();
    return options;
  })();
  ok(finalOptions.join() === 'الوحدة مع جميع مستوياتها', 'U13a', 'a final approver takes a whole unit with its levels, or every unit', finalOptions.join());
  await page.getByTestId('units-dialog').getByText('كل الوحدات الحالية والمستقبلية').click();
  await page.getByRole('button', { name: 'اعتماد الاختيار' }).click();
  ok((await page.getByTestId('assign-units').innerText()).trim() === 'كل الوحدات', 'U13', 'a final approver can be given every unit');
  await page.getByRole('button', { name: 'حفظ المنحة' }).click();
  await page.locator('td.scope-text', { hasText: 'نطاق شامل' }).first().waitFor({ timeout: 10000 });

  // ---- the matrix of a unit --------------------------------------------------------------------------------------------
  await page.getByRole('tab', { name: 'مصفوفة الوحدات' }).click();
  const matrix = page.getByTestId('unit-matrix');
  await matrix.getByPlaceholder(/ابحث/).first().fill('إدارة المشاريع');
  await matrix.locator('button', { hasText: 'إدارة المشاريع' }).first().click();
  await page.waitForTimeout(800);
  const managerRow = matrix.locator(`tr[data-person="${managerId}"]`);
  ok((await managerRow.locator('[data-cell=UNIT_OPERATIONS_APPROVER]').innerText()) === 'وحدة واحدة', 'M01', 'the matrix shows the unit’s people and how many units a grant covers');
  ok((await managerRow.locator('input[data-cell=REQUESTER]').count()) === 1, 'M02', 'a role not given over units is a tick');
  await page.screenshot({ path: evidence + 'C-unit-matrix.png' });
  await managerRow.locator('[data-cell=FYI_RECEIVER]').click();
  const fyiDialog = page.getByTestId('units-dialog');
  await fyiDialog.waitFor();
  await page.waitForTimeout(600);
  await fyiDialog.getByRole('button', { name: /فتح إدارة المشاريع/ }).click();
  await page.waitForTimeout(500);
  await fyiDialog.getByTestId('units-tree').locator('label', { hasText: 'قسم مشاريع المباني' }).locator('input').check();
  await page.getByRole('button', { name: 'اعتماد الاختيار' }).click();
  await page.waitForTimeout(1200);
  ok((await managerRow.locator('[data-cell=FYI_RECEIVER]').innerText()) === 'وحدة واحدة', 'M03', 'a cell’s button saves at once');
  await managerRow.locator('[data-cell=FYI_RECEIVER]').click();
  const again = page.getByTestId('units-dialog');
  await again.waitFor();
  await again.getByTestId('unit-row').first().locator('select').selectOption('BRANCH');
  await page.getByRole('button', { name: 'اعتماد الاختيار' }).click();
  await page.waitForTimeout(1200);
  const fyiRows = sql(`select count(*), count(*) filter (where valid_to is null) from membership where person_id = '${managerId}' and role_code = 'FYI_RECEIVER'`);
  ok(fyiRows === '2|1', 'M04', 'a changed scope is a new grant, and the old one stays in history', fyiRows);
  ok((await matrix.getByTestId('fyi-mains').count()) === 1, 'M05', 'the main for-information units are chosen here');
  const periods = matrix.getByTestId('unit-ops-routes');
  await periods.getByRole('button', { name: 'إضافة فترة' }).click();
  await periods.getByLabel('اسم الفترة').fill('الدوام الرسمي');
  await periods.getByPlaceholder(/ابحث/).first().fill('قسم مشاريع');
  await periods.locator('button', { hasText: 'قسم مشاريع المباني' }).first().click();
  await periods.getByRole('button', { name: /أضف/ }).click();
  await periods.getByRole('button', { name: 'حفظ الفترة' }).click();
  await periods.getByText('الدوام الرسمي').waitFor({ timeout: 8000 });
  ok(sql(`select to_char(time_from, 'HH24:MI') || '-' || to_char(time_to, 'HH24:MI') from unit_ops_route`) === '07:00-15:00', 'M06', 'a period is added by its unit');
  await page.screenshot({ path: evidence + 'D-periods.png', fullPage: true });
  await periods.getByRole('button', { name: 'حذف الدوام الرسمي' }).click();
  await page.waitForTimeout(800);
  ok(sql(`select count(*) from unit_ops_route`) === '0', 'M07', 'and removed; without periods the nearest grant decides');

  // ---- the studio -------------------------------------------------------------------------------------------------------
  await page.goto(base + '#workflow');
  await page.waitForSelector('[data-testid=flow-studio] .react-flow__node', { timeout: 30000 });
  await page.selectOption('select[aria-label="نوع الطلب"]', 'ADMIN_TRANSFER');
  await page.waitForTimeout(1200);
  await page.locator('[data-testid=node-approval]').first().click();
  await page.waitForTimeout(300);
  const inspector = page.getByTestId('inspector');
  const offered = await inspector.locator('option').allInnerTexts();
  ok(offered.includes('حسب الوحدات المعيّنة للمعتمد'), 'U14', 'a step can go «حسب الوحدات المعيّنة للمعتمد»');
  ok(offered.includes('معتمد عمليات الوحدة'), 'U15', 'and the new roles are offered');

  // ---- a whole request ----------------------------------------------------------------------------------------------------
  const step = (id, name, place, extra = {}) => ({ id, type: 'approval', name, x: 0, y: 0, mode: 'ANY', slaDays: 3, assignees: [place], final: false, requiresSignature: false, ...extra });
  const graph = {
    nodes: [
      { id: 'st', type: 'start', name: 'بداية الطلب', x: 0, y: 0 },
      step('levels', 'اعتماد مستويات الوحدة', { role: 'CHAIN_APPROVER', orgFrom: 'REQUEST_ORG' }, { mode: 'ALL', chain: { from: 'PARENT', stop: 'MAIN_UNIT', skipEmpty: true } }),
      step('ops', 'اعتماد عمليات الوحدة', { role: 'UNIT_OPERATIONS_APPROVER', orgFrom: 'BY_SCOPE' }),
      step('fin', 'الاعتماد النهائي', { role: 'FINAL_APPROVER', orgFrom: 'BY_SCOPE' }, { final: true }),
      { id: 'ok', type: 'end_approved', name: 'معتمد', x: 0, y: 0 },
    ],
    edges: [{ from: 'st', to: 'levels' }, { from: 'levels', to: 'ops', when: 'approved' }, { from: 'ops', to: 'fin', when: 'approved' }, { from: 'fin', to: 'ok', when: 'approved' }],
  };
  const item = (await admin.get('/workflows')).body.find((w) => w.requestType.code === 'ADMIN_TRANSFER');
  const draft = await admin.post(`/workflows/${item.id}/drafts`, { definition: { name: 'اعتماد كما في التنقل', stages: [], execution: [], graph } });
  ok(draft.status === 200, 'J01', 'the chart is saved', draft.status === 200 ? '' : JSON.stringify(draft.body).slice(0, 240));
  const pub = await admin.post(`/workflow-versions/${draft.body.id}/publish`, {});
  ok(pub.status === 200, 'J02', 'and published', pub.status === 200 ? '' : JSON.stringify(pub.body).slice(0, 240));

  const requester = await apiSession('t.requester');
  const created = await requester.post('/requests', { typeCode: 'ADMIN_TRANSFER', origin: 'LIST', ownerOrgId: deep, resourceIds: [resource], period: { start: '2031-03-01T08:00:00+04:00', end: '2031-03-03T08:00:00+04:00' }, values: { reason: 'نقل إداري لتجربة مسار الاعتماد', headcount: 5 } });
  ok(created.status === 200, 'J03', 'a request from the lowest unit', created.status === 200 ? '' : JSON.stringify(created.body).slice(0, 240));
  const id = created.body.id;
  const taskOf = async (s) => (await s.get('/tasks')).body.find((t) => t.requestId === id);
  const approve = async (s) => {
    const t = await taskOf(s);
    return t ? s.post(`/tasks/${t.id}/decision`, { decision: 'APPROVE', expectedRevision: 1, __key: key() }) : { status: 0 };
  };

  const detail0 = (await requester.get('/requests/' + id)).body;
  const sent = await requester.post(`/requests/${id}/submit`, { expectedVersion: detail0.version, __key: key() });
  ok(sent.status === 200, 'J04', 'it is sent, because someone’s scope reaches its unit', sent.status === 200 ? '' : JSON.stringify(sent.body).slice(0, 240));

  const chain = sql(`select string_agg(o.name, ' ← ' order by t.created_at) from task_assignment t join organization o on o.id = t.target_org_id where t.request_id = '${id}' and t.stage_key = 'levels'`);
  const m1 = await apiSession('t.manager.it');
  const m2 = await apiSession('t.manager.ga');
  ok((await approve(m1)).status === 200, 'J05', 'first level of the climb', chain);
  ok((await approve(m2)).status === 200, 'J06', 'second level of the climb, the last below the main unit, which is never a station', sql(`select string_agg(o.name, ' ← ' order by t.created_at) from task_assignment t join organization o on o.id = t.target_org_id where t.request_id = '${id}' and t.stage_key = 'levels'`));
  const uo = await apiSession('t.manager');
  ok((await taskOf(m2)) === undefined, 'J07', 'whoever signed the climb has nothing more');
  const uoTask = await taskOf(uo);
  ok(uoTask?.stageKey === 'ops', 'J08', 'the unit operations step reaches the holder of the chosen levels, whose home is in another branch', uoTask?.stageName);
  ok((await approve(uo)).status === 200, 'J09', 'and they decide it, with OpenFGA in the loop');
  ok((await taskOf(uo)) === undefined, 'J10', 'they are not offered the final approval');
  const placeHolder = await apiSession('t.limited');
  const beforeFinalAtPlace = await placeHolder.get('/requests/' + id);
  ok([403, 404].includes(beforeFinalAtPlace.status), 'J11', 'for information sees nothing before the final approval', beforeFinalAtPlace.status);
  const fin = await apiSession('t.approver2');
  ok((await approve(fin)).status === 200, 'J12', 'a different person approves finally');
  ok((await requester.get('/requests/' + id)).body.status === 'APPROVED', 'J13', 'the request is approved');

  const told = (req) => sql(`select string_agg(p.username, ',' order by p.username) from request_fyi f join person p on p.id = f.person_id where f.request_id = '${req}'`);
  const informed = told(id);
  ok(informed === 't.auditor,t.manager', 'J14', 'for information: the holder at the main unit, and the holder of a scope covering the requesting unit', informed);
  ok([403, 404].includes((await placeHolder.get('/requests/' + id)).status), 'J15', 'a holder of «للعلم» in a unit this request does not concern reads nothing, even after it');

  // a unit of another branch standing at the same place: told too, on the next request there
  sql(`insert into site_link(id, site_id, organization_id, valid_from, reason, created_by) values (gen_random_uuid(), '${siteId}', '${it}', '2026-01-01T00:00:00Z', 'وحدة موجودة في الموقع', '${person('t.admin')}')`);
  const second = await requester.post('/requests', { typeCode: 'ADMIN_TRANSFER', origin: 'LIST', ownerOrgId: deep, resourceIds: [resource], period: { start: '2031-05-01T08:00:00+04:00', end: '2031-05-03T08:00:00+04:00' }, values: { reason: 'طلب ثان لتجربة للعلم حسب المكان', headcount: 5 } });
  const secondId = second.body.id;
  await requester.post(`/requests/${secondId}/submit`, { expectedVersion: (await requester.get('/requests/' + secondId)).body.version, __key: key() });
  const decide = async (s) => {
    const t = (await s.get('/tasks')).body.find((x) => x.requestId === secondId);
    return s.post(`/tasks/${t.id}/decision`, { decision: 'APPROVE', expectedRevision: 1, __key: key() });
  };
  for (const s of [m1, m2, uo, fin]) await decide(s);
  const informed2 = told(secondId);
  ok(informed2 === 't.auditor,t.limited,t.manager', 'J16', 'a holder in a unit of another branch at the same place is told as well', informed2);
  const manyViewers = await (await apiSession('t.requester2')).get('/requests/' + secondId);
  ok([403, 404].includes(manyViewers.status), 'J16a', 'someone else at that unit, without the role, reads nothing', manyViewers.status);
  const view = await placeHolder.get('/requests/' + secondId);
  ok(view.status === 200 && view.body.view !== 'FULL', 'J17', 'and reads its summary', view.status + ' ' + view.body?.view);
  let notice = null;
  for (let i = 0; i < 40 && !notice; i++) {
    const list = (await placeHolder.get('/notifications')).body;
    notice = (list.items ?? list).find((n) => n.requestId === secondId && n.kind === 'INFO_COPY') ?? null;
    if (!notice) await new Promise((res) => setTimeout(res, 1000));
  }
  ok(notice?.body?.includes('الوحدة: فريق مرافق الشمال') && notice.body.includes('وحدتها الرئيسية: إدارة المشاريع'), 'J18', 'the notice says which unit it is and its main unit', notice?.body);
  const list = (await requester.get('/requests/' + secondId)).body.fyi ?? [];
  ok(list.length === 3 && list.some((f) => f.firstReadAt), 'J18a', 'the request records who was told and who has read it', list.map((f) => f.person + (f.firstReadAt ? ' ✓' : '')).join('، '));
  ok(consoleErrors.length === 0, 'J19', 'no browser errors', consoleErrors.join(' | '));
} finally {
  await browser.close();
}
writeFileSync(evidence + 'results.json', JSON.stringify({ at: new Date().toISOString(), results }, null, 1) + '\n');
const failed = results.filter((x) => !x.pass);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
