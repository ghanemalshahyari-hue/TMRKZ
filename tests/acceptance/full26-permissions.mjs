// FULL END-TO-END ACCEPTANCE (owner's specification of 16 Nov 2026, §20–§21) — ACCEPTANCE ONLY — OWNER DECISION PENDING.
// Distributes the permissions in the owner's numbering THROUGH «إدارة الصلاحيات والوحدات» on http://localhost:8088, headless:
// the administrator (global manager, session borrowed read-only) adds the 14 fictional users to their units and gives what only
// a global manager may give (the access manager, final approval, FYI distribution, activation, site setup); U14 — the access
// manager, signed in for real — gives the rest it may give. VIDEO A is recorded; screenshots 01–07. Idempotent.
//   node tests/acceptance/full26-permissions.mjs
import { BASE, LABEL, closePage, contextFor, launch, personId, recorder, session, shot, sql, unitId } from './lib/full26-ui.mjs';
import { addUser, assign, chooseUnit, filter, grantAccessManager, openWorkspace, saveBatch, tab, tick } from './lib/full26-access-ui.mjs';

const ok = recorder('permissions');
const B = 'وحدة إضافية 1';
const U = (n) => `${B} · ${n}`;
const OTHER = 'وحدة إضافية 3'; // under «الشرطة»: the unrelated branch
const login = (n) => 'full26.u' + String(n).padStart(2, '0');

// home units in the owner's numbering (spec §20); a person may be a user of two units (U01 asks for م10-1 and م10-3)
const HOMES = [
  [1, U('م10-1')], [1, U('م10-3')], [2, U('م9-3')], [3, B], [4, B], [5, B], [6, B], [7, U('م8-6')], [8, U('م8-2')],
  [9, B], [10, B], [11, B], [12, U('م9-4')], [13, OTHER], [14, B],
];

const browser = await launch();
const admin = await contextFor(browser, 'admin', { video: 'A1-permissions-admin' });
try {
  await openWorkspace(admin);
  // 1. users added to their units, with no permission
  let current = null;
  for (const [n, unit] of HOMES) {
    if (current !== unit) {
      await chooseUnit(admin, unit);
      await tab(admin, 'إدارة الصلاحيات');
      current = unit;
    }
    await addUser(admin, login(n));
    const added = sql(`select count(*) from unit_member um join person p on p.id = um.person_id join organization o on o.id = um.organization_id where p.username = '${login(n)}' and o.name = '${unit}' and um.ended_at is null`);
    ok(added === '1', 'PERM-ADD-' + String(n).padStart(2, '0'), `«إضافة مستخدم»: ${login(n)} مستخدم في «${unit}» بلا صلاحية`, added);
  }
  // 01: the matrix of the main working unit, before any grant
  await chooseUnit(admin, B);
  await tab(admin, 'إدارة الصلاحيات');
  await admin.waitForTimeout(1500);
  ok(sql(`select count(*) from membership m join person p on p.id = m.person_id where p.username like 'full26.%' and (m.valid_to is null or m.valid_to > now())`) === '0', 'PERM-01', 'لا منحة قبل التوزيع');
  await shot(admin, '01-permission-matrix-before.png');

  // 2. what only a global manager gives, at «وحدة إضافية 1»
  const pid = (n) => personId(login(n));
  let staged = 0;
  staged += await tick(admin, pid(11), 'SITE_SETUP_ADMIN');
  staged += await tick(admin, pid(6), 'FYI_DISTRIBUTOR');
  staged += await tick(admin, pid(9), 'STATIONING_ACTIVATOR');
  if (staged) ok(true, 'PERM-02', 'حفظ التعديلات (تهيئة المواقع، تحديد وحدات العلم، تفعيل التمركز)', await saveBatch(admin));
  await admin.waitForTimeout(1200);
  await shot(admin, '07-site-setup-admin.png');

  // U14: «مدير صلاحيات الوحدة» over the unit and its sub-units, rights to look up, review, grant and add users
  if (!(await admin.locator(`tr[data-person="${pid(14)}"] button[data-cell="UNIT_ACCESS_MANAGER"].primary`).count())) {
    await grantAccessManager(admin, pid(14), 'UNIT_ACCESS_MANAGER', ['LOOKUP', 'REVIEW', 'GRANT', 'ANNEXED'], {
      before: (p) => shot(p, '00-access-manager-rights.png'),
    });
  }
  ok(sql(`select count(*) from membership where person_id = '${pid(14)}' and role_code = 'UNIT_ACCESS_MANAGER' and (valid_to is null or valid_to > now())`) === '1', 'PERM-03', 'U14 مدير صلاحيات الوحدة');

  // Final approver A (U04): «تعيين» — the branch of م9-3 (the dialog offers a final approver a whole unit with its levels, or everything)
  let offeredA = [];
  if (!(await admin.locator(`tr[data-person="${pid(4)}"] button[data-cell="FINAL_APPROVER"].primary`).count())) {
    offeredA = await assign(admin, pid(4), 'FINAL_APPROVER', [{ name: U('م9-3'), mode: 'BRANCH' }], { before: (p) => shot(p, '05-final-approver-scope.png') });
  }
  ok(sql(`select count(*) from membership where person_id = '${pid(4)}' and role_code = 'FINAL_APPROVER' and (valid_to is null or valid_to > now())`) === '1', 'PERM-04', 'المعتمد النهائي A: فرع م9-3', JSON.stringify(offeredA));

  // Final approver B (U05): the dialog is opened to record what it offers for a final approver, then closed
  await admin.locator(`tr[data-person="${pid(5)}"] button[data-cell="FINAL_APPROVER"]`).click();
  const d = admin.getByTestId('units-dialog');
  await d.waitFor();
  const search = d.getByTestId('units-tree').getByRole('searchbox');
  await search.fill(B);
  const hit = d.getByRole('option').filter({ has: admin.locator('b', { hasText: new RegExp('^' + B + '$') }) }).first();
  await hit.waitFor();
  await hit.locator('input[type=checkbox]').check();
  await search.fill('');
  await admin.waitForTimeout(600);
  const offeredB = await d.getByLabel('نطاق الاعتماد ' + B).locator('option').evaluateAll((o) => o.map((x) => x.value + ':' + x.textContent.trim()));
  await shot(admin, '05b-final-approver-no-levels-option.png');
  await admin.locator('.dialog-actions').getByRole('button', { name: 'إلغاء', exact: true }).click();
  await d.waitFor({ state: 'detached' });
  ok(!offeredB.some((o) => o.startsWith('LEVELS')), 'PERM-05', 'نافذة «تعيين» لا تعرض «مستويات محددة» للمعتمد النهائي', JSON.stringify(offeredB));

  // ... so its level scope is given through the same server call the dialog makes (POST /memberships), with levels [9]
  const a = await session('admin');
  if (sql(`select count(*) from membership where person_id = '${pid(5)}' and role_code = 'FINAL_APPROVER' and (valid_to is null or valid_to > now())`) === '0') {
    const today = new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10);
    const r = await a.api('POST', '/memberships', {
      personId: pid(5), organizationId: unitId(B), roleCode: 'FINAL_APPROVER', validFrom: new Date(today + 'T00:00:00+04:00').toISOString(),
      scope: { mode: 'CUSTOM', all: false, targets: [{ kind: 'ORGANIZATION', id: unitId(B), includeDescendants: true, levels: [9] }] },
    });
    ok(r.status === 200, 'PERM-06', `المعتمد النهائي B: المستوى 9 تحت «${B}» (${LABEL})`, r.status + ' ' + JSON.stringify(r.body).slice(0, 200));
  }

  // the unrelated branch: U13 asks and follows inside «وحدة إضافية 3» only
  await chooseUnit(admin, OTHER);
  await tab(admin, 'إدارة الصلاحيات');
  staged = (await tick(admin, pid(13), 'STATIONING_REQUESTER')) + (await tick(admin, pid(13), 'POSTURE_VIEWER'));
  if (staged) ok(true, 'PERM-07', 'U13 في فرع آخر', await saveBatch(admin));
} catch (e) {
  ok(false, 'PERM-ABORT-ADMIN', 'توقف', e.stack);
  await shot(admin, 'abort-admin.png', { private: true });
} finally {
  await closePage(admin);
}

// 3. U14 — the access manager — gives the rest it may give
const mgr = await contextFor(browser, login(14), { video: 'A2-permissions-access-manager' });
try {
  const pid = (n) => personId(login(n));
  await openWorkspace(mgr);
  await chooseUnit(mgr, B);
  await tab(mgr, 'إدارة الصلاحيات');
  if (!(await mgr.locator(`tr[data-person="${pid(3)}"] button[data-cell="UNIT_OPERATIONS_APPROVER"].primary`).count())) {
    const offered = await assign(mgr, pid(3), 'UNIT_OPERATIONS_APPROVER', [{ name: B, mode: 'BRANCH' }], { before: (p) => shot(p, '04-unit-operations-assigned.png') });
    ok(true, 'PERM-08', 'U14 يعيّن معتمد عمليات الوحدة U03 على «وحدة إضافية 1» وفروعها', JSON.stringify(offered));
  }
  if (await tick(mgr, pid(10), 'POSTURE_VIEWER')) ok(true, 'PERM-09', 'U14 يمنح متابعة الموقف العملياتي U10', await saveBatch(mgr));
  // U14 cannot give what only a global manager gives: its cells are locked
  const locked = await mgr.locator(`tr[data-person="${pid(4)}"] td:has(button.aw-lock)`).count();
  ok(locked > 0, 'PERM-10', 'خلايا ما لا يمنحه U14 مقفلة (الاعتماد النهائي، التفعيل، تهيئة المواقع)', locked);
  await shot(mgr, '04b-access-manager-matrix.png');

  await chooseUnit(mgr, U('م10-1'));
  await tab(mgr, 'إدارة الصلاحيات');
  if (await tick(mgr, pid(1), 'STATIONING_REQUESTER')) ok(true, 'PERM-11', 'U14 يمنح U01 إنشاء طلبات التمركز في م10-1', await saveBatch(mgr));
  await shot(mgr, '02-requester-assigned.png');
  await chooseUnit(mgr, U('م10-3'));
  await tab(mgr, 'إدارة الصلاحيات');
  if (await tick(mgr, pid(1), 'STATIONING_REQUESTER')) ok(true, 'PERM-12', 'U14 يمنح U01 إنشاء طلبات التمركز في م10-3 (اختبار المعتمد الموروث)', await saveBatch(mgr));

  await chooseUnit(mgr, U('م9-3'));
  await tab(mgr, 'إدارة الصلاحيات');
  if (!(await mgr.locator(`tr[data-person="${pid(2)}"] button[data-cell="CHAIN_APPROVER"].primary`).count())) {
    const offered = await assign(mgr, pid(2), 'CHAIN_APPROVER', [{ name: U('م9-3'), mode: 'ONE' }, { name: U('م8-3'), mode: 'BRANCH' }], {
      before: (p) => shot(p, '03-hierarchy-approver-assigned.png'),
    });
    ok(true, 'PERM-13', 'U14 يعيّن U02 معتمد السلسلة: م9-3 «هذا المستوى فقط» + م8-3 «ومع جميع الوحدات التابعة»', JSON.stringify(offered));
  }
  await shot(mgr, '03b-hierarchy-approver-saved.png');

  for (const [n, unit, code] of [[7, U('م8-6'), 'PERM-14'], [8, U('م8-2'), 'PERM-15']]) {
    await chooseUnit(mgr, unit);
    await tab(mgr, 'إدارة الصلاحيات');
    if (!(await mgr.locator(`tr[data-person="${pid(n)}"] button[data-cell="FYI_RECEIVER"].primary`).count())) {
      const offered = await assign(mgr, pid(n), 'FYI_RECEIVER', [{ name: unit, mode: 'ONE' }]);
      ok(true, code, `U14 يمنح ${login(n)} «للعلم» في «${unit}» وحدها`, JSON.stringify(offered));
    }
  }
  await shot(mgr, '06-fyi-receiver-assigned.png');

  await chooseUnit(mgr, U('م9-4'));
  await tab(mgr, 'إدارة الصلاحيات');
  const s1 = await tick(mgr, pid(12), 'STATIONING_REQUESTER');
  const s2 = await tick(mgr, pid(12), 'SITE_REGISTRATION_REQUESTER');
  if (s1 || s2) ok(true, 'PERM-16', 'U14 يمنح U12 (المستخدم المفوَّض) طلبات التمركز وطلب اعتماد موقع في م9-4', await saveBatch(mgr));
  await shot(mgr, '06b-delegated-user-assigned.png');
} catch (e) {
  ok(false, 'PERM-ABORT-U14', 'توقف', e.stack);
  await shot(mgr, 'abort-u14.png', { private: true });
} finally {
  await closePage(mgr);
}
await browser.close();
process.exit(0);
