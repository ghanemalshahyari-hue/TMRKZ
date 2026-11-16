// FULL acceptance §22, §25 FINAL-L1, §26 FYI, §10–§11, §30–§31 (owner's specification, 16 Nov 2026) on http://localhost:8088.
// R1: U01 (requester, «وحدة إضافية 1 · م10-1», level 10) asks for the initial stationing of م10-1 at «معسكر القبول الكامل 01».
// Mixed hierarchy: L9 م9-3 has its own hierarchy approver (U02), L8 م8-5 and L7 «وحدة إضافية 1» have none → skipped; then
// unit operations (U03), the final approval by the nearest scope (A = U04, branch of م9-3; B = U05, level 9, must not see it),
// «تحديد وحدات العلم» (U06 chooses م8-6 manually → U07 reads it), activation (U09), the posture (U10, 2D and 3D).
// Every step is a person in a headless page; forged server calls prove the buttons are not the boundary. VIDEOS C, D, E.
//   node tests/acceptance/full26-request-mixed.mjs
import { writeFileSync } from 'node:fs';
import { DOCS, PRIVATE, button, buttons, closePage, consoleErrors, contextFor, external, go, launch, recorder, session, shot, sql, unitId } from './lib/full26-ui.mjs';

const ok = recorder('R1-mixed');
const B = 'وحدة إضافية 1';
const U = (n) => `${B} · ${n}`;
const CAMP = 'S-0002';
const L = (n) => 'full26.u' + String(n).padStart(2, '0');
const DECISIONS = ['اعتماد', 'اعتماد عمليات الوحدة', 'اعتماد نهائي', 'تحديد وحدات العلم', 'تفعيل', 'إرجاع للتعديل', 'رفض'];
const MUTATE = ['حفظ المسودة والفحص', 'إرسال للاعتماد', 'تعديل الطلب'];
const out = { personas: {} };
const browser = await launch();
const api = async (n) => (await session(L(n))).api;
const stateOf = (id) => sql(`select state from restationing_request where id = '${id}'`);
const route = (id) => sql(`select string_agg(s.kind || ':' || coalesce(o.name, '-') || ':' || coalesce(s.mark, 'OPEN') || ':' || coalesce(p.username, '-'), ' → ' order by s.position) from restationing_stage s left join organization o on o.id = s.unit_id left join person p on p.id = s.decided_by where s.request_id = '${id}' and s.route_no = (select route_no from restationing_request where id = '${id}')`);
const view = async (n, id) => (await (await api(n))('GET', `/restationing-requests/${id}`));
const forge = async (n, id, what, path, body, code) => {
  const r = await (await api(n))('POST', `/restationing-requests/${id}${path}`, body);
  ok(r.status >= 400, code, `${L(n)}: ${what} — مرفوض من الخادم`, `${r.status} ${r.body?.code ?? ''} ${(r.body?.message ?? '').slice(0, 120)}`);
  return r;
};
const openRequest = async (p, id) => {
  await go(p, '#restationing/' + id);
  await p.reload();
  await p.waitForSelector('main#main');
  await p.waitForTimeout(2500);
};
/** One holder at one stage: sees their own decision buttons and nobody else's, then decides. */
const stage = async (n, id, label, code, shotName, video) => {
  const p = await contextFor(browser, L(n), { video });
  await openRequest(p, id);
  await p.getByRole('button', { name: label, exact: true }).waitFor({ timeout: 15000 }).catch(() => undefined);
  const bad = await buttons(p, [label, 'إرجاع للتعديل', 'رفض'], DECISIONS.filter((d) => ![label, 'إرجاع للتعديل', 'رفض'].includes(d)));
  ok(bad.length === 0, code, `${L(n)} يرى «${label}» فقط`, bad.join(' | '));
  out.personas[L(n)] = { stage: label, missingOrExtra: bad };
  await p.locator('.tz-strip-head .tz-tool').click().catch(() => undefined);
  await p.waitForTimeout(800);
  if (shotName) await shot(p, shotName);
  await button(p, label).click();
  await p.waitForTimeout(2500);
  await closePage(p);
};

let id = null;
try {
  // ---- U01 creates the request on the page --------------------------------------------------------------------------
  const p1 = await contextFor(browser, L(1), { video: 'C1-requester-creates' });
  await go(p1, '#newRequest');
  await p1.getByTestId('hub-units').waitFor({ timeout: 20000 });
  const row = p1.locator(`[data-unit="${unitId(U('م10-1'))}"]`);
  ok((await row.getAttribute('data-state')) === 'NO_STATIONING', 'R1-01', 'الوحدة بلا تمركز: يُعرض لها «طلب تمركز أولي»');
  const navTop = (await p1.locator('.tz-top').innerText()).replace(/\s+/g, ' ');
  await row.locator('[data-go=INITIAL_STATIONING]').click();
  await p1.getByTestId('initial-sites').waitFor({ timeout: 20000 });
  await p1.waitForTimeout(1500);
  await p1.locator(`[data-testid=initial-sites] [data-site="${CAMP}"]`).click();
  await p1.waitForTimeout(1500);
  await p1.getByTestId('initial-next').click();
  await p1.waitForTimeout(2000);
  await p1.locator('.tz-flow-review textarea').fill('ACCEPTANCE ONLY — تمركز أولي لـ م10-1 في معسكر القبول الكامل 01');
  await button(p1, 'حفظ المسودة والفحص').click();
  await p1.waitForTimeout(2500);
  await shot(p1, '15-requester-creates-request.png');
  await button(p1, 'إرسال للاعتماد').click();
  await p1.waitForFunction(() => /^#restationing\/[0-9a-f-]{36}$/.test(location.hash), null, { timeout: 20000 });
  id = await p1.evaluate(() => location.hash.split('/')[1]);
  out.request = { id, number: sql(`select number from restationing_request where id = '${id}'`) };
  ok(stateOf(id) === 'UNDER_REVIEW', 'R1-02', 'أُرسل الطلب: قيد المراجعة', out.request.number);
  // the requester's own view: no decision button of any stage
  await openRequest(p1, id);
  const bad1 = await buttons(p1, [], DECISIONS.filter((d) => d !== 'إرجاع للتعديل' && d !== 'رفض'));
  ok(bad1.length === 0, 'BTN-U01', 'مقدم الطلب لا يرى اعتماد السلسلة ولا العمليات ولا النهائي ولا التفعيل', bad1.join(' | '));
  ok(navTop.includes('طلب جديد') || (await p1.getByText('طلب جديد').count()) > 0, 'BTN-U01b', 'مقدم الطلب يرى «طلب جديد»');
  await p1.locator('.tz-strip-head .tz-tool').click();
  await p1.waitForTimeout(1000);
  await shot(p1, '16-route-skipped-levels.png');
  out.routeAtSubmit = route(id);
  await closePage(p1);

  // ---- the route the server derived and recorded ---------------------------------------------------------------------
  const expected = `HIERARCHY:${U('م9-3')}:OPEN:- → HIERARCHY:${U('م8-5')}:SKIPPED:- → HIERARCHY:${B}:SKIPPED:- → UNIT_OPERATIONS:-:OPEN:- → FINAL:-:OPEN:-`;
  ok(out.routeAtSubmit === expected, 'HIER-01', 'المسار المختلط: م9-3 بمعتمد، م8-5 و«وحدة إضافية 1» متجاوزتان، ثم العمليات ثم النهائي؛ الوحدة الرئيسية ليست مرحلة', out.routeAtSubmit);
  const skips = sql(`select string_agg(organization_name || ' (L' || organization_level || ') ' || reason_code || ' — ' || reason_text, ' | ' order by hierarchy_order) from restationing_route_skip where request_id = '${id}'`);
  out.skips = skips;
  ok(skips.includes(U('م8-5')) && skips.includes('NO_HIERARCHY_APPROVER') && skips.split(' | ').length === 2, 'HIER-02', 'التجاوز مسجل لكل وحدة باسمها ومستواها وسببه', skips);
  ok(sql(`select count(*) from audit_event where entity_id = '${id}' and action = 'HIERARCHY_LEVEL_SKIPPED'`) === '1', 'HIER-03', 'حدث تدقيق واحد HIERARCHY_LEVEL_SKIPPED');
  const v1 = await view(1, id);
  const skippedView = (v1.body?.route ?? []).filter((s) => s.mark === 'SKIPPED');
  ok(skippedView.length === 2 && skippedView.every((s) => s.skipReason === 'لا يوجد معتمد للسلسلة الهرمية' && !s.decidedBy), 'HIER-04', 'الصفحة تعرض «تم التجاوز — لا يوجد معتمد للسلسلة الهرمية» بلا علامة اعتماد ولا معتمد', JSON.stringify(skippedView.map((s) => [s.unit?.name, s.mark, s.skipReason])));
  ok(!JSON.stringify(v1.body).includes('CHAIN_APPROVER|*') && sql(`select count(*) from restationing_stage where request_id = '${id}' and mark is null and kind = 'HIERARCHY'`) === '1', 'HIER-05', 'لا مهمة مفتوحة لأي حامل للدور (لا CHAIN_APPROVER|*)');

  // ---- forged calls before their turn ---------------------------------------------------------------------------------
  await forge(1, id, 'مقدم الطلب يعتمد طلبه', '/decision', { decision: 'APPROVE' }, 'SEC-01');
  await forge(3, id, 'عمليات الوحدة تعتمد قبل دورها', '/decision', { decision: 'APPROVE' }, 'SEC-02');
  await forge(4, id, 'المعتمد النهائي يعتمد قبل دوره', '/decision', { decision: 'APPROVE' }, 'SEC-03');
  await forge(13, id, 'مستخدم فرع آخر يقرر', '/decision', { decision: 'APPROVE' }, 'SEC-04');
  await forge(9, id, 'التفعيل قبل الاعتماد', '/activate', {}, 'SEC-05');
  ok((await view(13, id)).status >= 403, 'SEC-06', 'مستخدم فرع آخر لا يفتح الطلب', (await view(13, id)).status);
  ok((await view(7, id)).status >= 403, 'FYI-05a', 'مستقبل العلم لا يفتح الطلب قبل اختيار وحدته', (await view(7, id)).status);

  // ---- hierarchy: U02 at م9-3 --------------------------------------------------------------------------------------
  await stage(2, id, 'اعتماد', 'BTN-U02', '17-hierarchy-approver-decision.png', 'C2-hierarchy-approver');
  out.afterHierarchy = route(id);
  ok(/HIERARCHY:وحدة إضافية 1 · م9-3:APPROVED:full26\.u02/.test(out.afterHierarchy), 'HIER-06', 'U02 اعتمد م9-3؛ المتجاوزتان بقيتا متجاوزتين بلا معتمد', out.afterHierarchy);
  // a fabricated approval of a skipped level: the server only ever decides the current stage, and U02 has no turn there
  const fab = await (await api(2))('POST', `/restationing-requests/${id}/decision`, { decision: 'APPROVE', stage: 'H:' + unitId(U('م8-5')) });
  ok(fab.status >= 400 && sql(`select count(*) from restationing_stage where request_id = '${id}' and mark = 'SKIPPED' and decided_by is null`) === '2', 'SEC-07', 'اعتماد مصنوع لمستوى متجاوز مرفوض، والمستويان بلا معتمد', `${fab.status} ${fab.body?.code ?? ''}`);
  await forge(2, id, 'معتمد السلسلة يأخذ عمليات الوحدة', '/decision', { decision: 'APPROVE' }, 'SEC-08');

  // ---- unit operations: U03 ----------------------------------------------------------------------------------------
  await stage(3, id, 'اعتماد عمليات الوحدة', 'BTN-U03', '18-unit-operations.png', 'C3-unit-operations');
  await forge(3, id, 'عمليات الوحدة تأخذ الاعتماد النهائي', '/decision', { decision: 'APPROVE' }, 'SEC-09');

  // ---- final: A (U04) receives it, B (U05, level 9) does not --------------------------------------------------------
  const vB = await view(5, id);
  ok(vB.status >= 403 || !vB.body?.can?.decide, 'FINAL-L1b', 'المعتمد النهائي B (المستوى 9) لا دور له في طلب من المستوى 10', vB.status + ' ' + JSON.stringify(vB.body?.can ?? {}));
  await forge(5, id, 'المعتمد النهائي B يعتمد طلباً خارج نطاقه', '/decision', { decision: 'APPROVE' }, 'FINAL-L1c');
  const vA = await view(4, id);
  ok(vA.body?.can?.decide === true, 'FINAL-L1a', 'المعتمد النهائي A (فرع م9-3) يستقبله', JSON.stringify(vA.body?.can ?? {}));
  await stage(4, id, 'اعتماد نهائي', 'BTN-U04', '19-final-approval.png', 'C4-final-approval');
  ok(stateOf(id) === 'APPROVED_NOT_ACTIVATED', 'R1-03', 'معتمد نهائياً، لم يُفعَّل');
  ok(sql(`select count(*) from org_stationing where organization_id = '${unitId(U('م10-1'))}'`) === '0', 'ACT-01', 'الاعتماد ليس تفعيلاً: لا سجل تمركز بعد');

  // ---- activation waits for the FYI distribution; the final approver never activates ---------------------------------
  const p9 = await contextFor(browser, L(9));
  await openRequest(p9, id);
  ok((await button(p9, 'تفعيل').count()) === 0, 'ACT-02', 'لا زر «تفعيل» قبل تحديد وحدات العلم');
  await closePage(p9);
  await forge(9, id, 'التفعيل قبل تحديد وحدات العلم', '/activate', {}, 'SEC-10');
  await forge(4, id, 'المعتمد النهائي يفعّل ما اعتمده', '/activate', {}, 'SEC-11');
  await forge(7, id, 'مستقبل العلم يوزع العلم', '/fyi', { units: [] }, 'SEC-12');

  // ---- FYI: U06 chooses م8-6 from the tree (manual), U07 reads it ----------------------------------------------------
  const p6 = await contextFor(browser, L(6), { video: 'D1-fyi-distributor' });
  await openRequest(p6, id);
  const bad6 = await buttons(p6, ['تحديد وحدات العلم'], DECISIONS.filter((d) => d !== 'تحديد وحدات العلم'));
  ok(bad6.length === 0, 'BTN-U06', 'U06 يرى «تحديد وحدات العلم» فقط', bad6.join(' | '));
  await button(p6, 'تحديد وحدات العلم').click();
  await p6.getByTestId('fyi-send').waitFor({ timeout: 15000 });
  await p6.waitForTimeout(1200);
  const box = p6.locator(`[data-fyi-unit="${unitId(U('م8-6'))}"]`);
  await box.scrollIntoViewIfNeeded();
  await box.check();
  await p6.getByTestId('fyi-distribution').getByLabel('ملاحظة العلم').fill('ACCEPTANCE ONLY — اختيار يدوي: قد تحتاج م8-6 طلباتها الخاصة لاحقاً');
  await p6.waitForTimeout(600);
  await p6.getByTestId('fyi-distribution').scrollIntoViewIfNeeded();
  await shot(p6, '20-fyi-unit-selection-tree.png');
  out.fyiTree = (await p6.getByTestId('fyi-distribution').innerText()).replace(/\s+/g, ' ').slice(0, 600);
  await p6.getByTestId('fyi-send').click();
  await p6.getByTestId('fyi-done').waitFor({ timeout: 15000 });
  ok(true, 'FYI-02', 'اختيار يدوي لوحدة إضافية من الشجرة: م8-6', await p6.getByTestId('fyi-done').innerText());
  await closePage(p6);
  ok(sql(`select count(*) from membership m join person p on p.id = m.person_id where p.username = '${L(7)}' and (m.valid_to is null or m.valid_to > now())`) === '1', 'FYI-08', 'العلم لا يمنح صلاحية دائمة (منحة U07 الوحيدة كما هي)');

  const p7 = await contextFor(browser, L(7), { video: 'D2-fyi-receiver' });
  await go(p7, '#home');
  await p7.waitForTimeout(1500);
  ok(sql(`select count(*) from notification n join person p on p.id = n.person_id where p.username = '${L(7)}' and n.title like 'للعلم:%' and n.body like '%${id}%'`) === '1', 'FYI-03a', 'وصل U07 إشعار «للعلم» بهذا الطلب');
  await openRequest(p7, id);
  await p7.getByTestId('fyi-read-only').waitFor({ timeout: 15000 });
  const bad7 = await buttons(p7, [], [...DECISIONS, ...MUTATE]);
  ok(bad7.length === 0, 'FYI-04', 'U07 يقرأ الطلب بلا أي زر تعديل أو قرار', bad7.join(' | '));
  await shot(p7, '21-fyi-receiver-view.png');
  await closePage(p7);
  ok((await view(7, id)).status === 200, 'FYI-03', 'U07 يفتح هذا الطلب');
  await forge(7, id, 'مستقبل العلم يعتمد', '/decision', { decision: 'APPROVE' }, 'FYI-04b');
  await forge(7, id, 'مستقبل العلم يفعّل', '/activate', {}, 'FYI-04c');
  const geom = await (await api(7))('PUT', `/restationing-requests/${id}/content`, { kind: 'PERMANENT', scope: [unitId(U('م10-1'))], reason: 'محاولة مصنوعة', existingSite: sql(`select id from site where code = '${CAMP}'`) });
  ok(geom.status >= 400, 'FYI-04d', 'مستقبل العلم لا يعدّل المحتوى أو الشكل', geom.status + ' ' + (geom.body?.code ?? ''));
  const grantTry = await (await api(7))('POST', '/memberships', { personId: sql(`select id from person where username = '${L(7)}'`), organizationId: unitId(U('م8-6')), roleCode: 'STATIONING_REQUESTER', scope: { mode: 'ROLE', targets: [] } });
  ok(grantTry.status >= 400, 'FYI-04e', 'مستقبل العلم لا ينشئ صلاحيات', grantTry.status + ' ' + (grantTry.body?.code ?? ''));
  ok((await view(8, id)).status >= 403, 'FYI-06', 'U08 (للعلم في م8-2، لم تُختر) لا يرث الاطلاع', (await view(8, id)).status);

  // ---- activation: U09 ------------------------------------------------------------------------------------------------
  const p9b = await contextFor(browser, L(9), { video: 'E1-activation' });
  await openRequest(p9b, id);
  const bad9 = await buttons(p9b, ['تفعيل'], ['اعتماد', 'اعتماد عمليات الوحدة', 'اعتماد نهائي', 'تحديد وحدات العلم']);
  ok(bad9.length === 0, 'BTN-U09', 'U09 يرى «تفعيل» فقط، بعد تحديد وحدات العلم', bad9.join(' | '));
  await shot(p9b, '22-activation.png');
  await button(p9b, 'تفعيل').click();
  await p9b.waitForTimeout(3000);
  await closePage(p9b);
  ok(stateOf(id) === 'ACTIVATED_PERMANENT', 'ACT-03', 'فُعّل');
  const st = sql(`select s.code || '|' || o.origin || '|' || o.kind from org_stationing o join site s on s.id = o.site_id where o.organization_id = '${unitId(U('م10-1'))}' and o.valid_to is null`);
  ok(st === `${CAMP}|REQUEST|PERMANENT`, 'ACT-04', 'سجل التمركز المعتمد: م10-1 في المعسكر، من الطلب، دائم', st);
  ok(sql(`select count(*) from org_stationing where organization_id in ('${unitId(U('م11-1'))}', '${unitId(U('م11-2'))}')`) === '0', 'ACT-05', 'لا تنتقل الوحدات التابعة تلقائياً');
  ok(sql(`select count(*) from notification n join person p on p.id = n.person_id where p.username = '${L(8)}' and n.title like 'للعلم: تمركز في%' and n.title like '%${out.request.number}'`) === '1', 'FYI-01', 'تلقائي: U08 (للعلم في م8-2 المتمركزة في المعسكر) أُبلغ عند التفعيل', sql(`select n.title || ' — ' || n.body from notification n join person p on p.id = n.person_id where p.username = '${L(8)}' order by n.created_at desc limit 1`));
  ok(sql(`select count(*) from notification n join person p on p.id = n.person_id where p.username = '${L(7)}' and n.title like 'للعلم: تمركز في%'`) === '0', 'FYI-01b', 'U07 (م8-6 ليست طرفاً تلقائياً) لا يُبلَّغ تلقائياً');
  out.fyiRead = sql(`select string_agg(p.username || ':' || coalesce(n.read_at::text, 'unread'), ', ') from notification n join person p on p.id = n.person_id where n.body like '%${id}%'`);
} catch (e) {
  ok(false, 'R1-ABORT', 'توقف', e.stack);
}
out.final = id ? { state: stateOf(id), route: route(id) } : null;
out.external = external;
out.consoleErrors = consoleErrors;
writeFileSync(PRIVATE + 'R1.json', JSON.stringify(out, null, 1));
writeFileSync(DOCS + 'R1-route.json', JSON.stringify({ request: out.request, routeAtSubmit: out.routeAtSubmit, skips: out.skips, final: out.final, fyiTree: out.fyiTree }, null, 1));
await browser.close();
process.exit(0);
