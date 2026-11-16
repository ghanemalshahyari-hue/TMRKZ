// FULL acceptance §24 (inherited approver), §25 FINAL-L3 and FINAL-L4 (owner's specification, 16 Nov 2026) on :8088.
// R3: U01 asks for the initial stationing of «وحدة إضافية 1 · م10-3» (level 10) at the camp. Its L9 «م9-1» has no hierarchy
// approver of its own, but U02's grant at «م8-3» covers «هذا المستوى ومع جميع الوحدات التابعة» → م9-1 is NOT skipped: U02 signs it
// as the inherited approver, then signs م8-3 (his own level); L7 is skipped. After unit operations no final approver covers
// م10-3 (A = branch of م9-3, B = level 9) → FINAL-L3: the request waits, nothing approves it silently. FINAL-L4: overlapping
// assignments are added (ACCEPTANCE ONLY), first equal (both «وحدة إضافية 1» with every level → both may decide: ambiguity,
// reported, not decided), then B at the same unit with level 10 listed (levels before the whole branch → only B), B decides.
// The two final approvers are then restored to A = branch of م9-3 and B = level 9.
//   node tests/acceptance/full26-request-inherited.mjs
import { writeFileSync } from 'node:fs';
import { DOCS, LABEL, PRIVATE, button, closePage, contextFor, go, launch, recorder, session, shot, sql, unitId } from './lib/full26-ui.mjs';
import { chooseUnit, openWorkspace, row, tab } from './lib/full26-access-ui.mjs';

const ok = recorder('R3-inherited-final');
const B = 'وحدة إضافية 1';
const U = (n) => `${B} · ${n}`;
const L = (n) => 'full26.u' + String(n).padStart(2, '0');
const CAMP = 'S-0002';
const out = { simulate: {} };
const browser = await launch();
const admin = await session('admin');
const api = async (n) => (await session(L(n))).api;
const pid = (n) => sql(`select id from person where username = '${L(n)}'`);
const stateOf = (id) => sql(`select state from restationing_request where id = '${id}'`);
const route = (id) => sql(`select string_agg(s.kind || ':' || coalesce(o.name, '-') || ':' || coalesce(s.mark, 'OPEN') || ':' || coalesce(p.username, '-'), ' → ' order by s.position) from restationing_stage s left join organization o on o.id = s.unit_id left join person p on p.id = s.decided_by where s.request_id = '${id}' and s.route_no = (select route_no from restationing_request where id = '${id}')`);
const policy = (await admin.api('GET', '/stationing/policy')).body.inForce.values;
const simulate = async (unit, tag) => {
  const r = await admin.api('POST', '/stationing/routes/INITIAL_STATIONING/simulate', { orgId: unitId(unit), routing: policy.routing, stages: policy.approvalStages });
  out.simulate[tag] = r.body;
  return r.body;
};
const finalGrant = (n) => sql(`select id from membership where person_id = '${pid(n)}' and role_code = 'FINAL_APPROVER' and valid_from <= now() and (valid_to is null or valid_to > now())`);
const today = new Date(new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10) + 'T00:00:00+04:00').toISOString();
const replaceB = async (targets, why) => {
  const r = await admin.api('POST', `/access/grants/${finalGrant(5)}/replace`, {
    grant: { personId: pid(5), organizationId: unitId(B), roleCode: 'FINAL_APPROVER', validFrom: today, scope: { mode: 'CUSTOM', all: false, targets } },
    reason: `${LABEL}: ${why}`,
  });
  if (r.status !== 200) throw new Error('replace B: ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 300));
  return r.body;
};
/** A's «تعيين» through the screen as the administrator: rows = units to have (BRANCH each). */
const setA = async (names, shotName) => {
  const p = await contextFor(browser, 'admin');
  await openWorkspace(p);
  await chooseUnit(p, B);
  await tab(p, 'إدارة الصلاحيات');
  await row(p, pid(4)).locator('button[data-cell="FINAL_APPROVER"]').click();
  const d = p.getByTestId('units-dialog');
  await d.waitFor();
  const have = await d.getByTestId('unit-row').locator('td:first-child').allInnerTexts();
  for (const h of have.map((x) => x.trim()).filter((x) => !names.includes(x))) await d.getByRole('button', { name: 'إزالة ' + h, exact: true }).click();
  for (const n of names.filter((x) => !have.map((y) => y.trim()).includes(x))) {
    const s = d.getByTestId('units-tree').getByRole('searchbox');
    await s.fill(n);
    await d.getByRole('option').filter({ has: p.locator('b', { hasText: new RegExp('^\\s*' + n + '\\s*$') }) }).first().locator('input[type=checkbox]').check();
    await s.fill('');
    await p.waitForTimeout(500);
  }
  await p.waitForTimeout(800);
  if (shotName) await shot(p, shotName);
  await p.getByTestId('units-save').click();
  await d.waitFor({ state: 'detached', timeout: 15000 });
  await p.waitForTimeout(1500);
  await closePage(p);
};
const canDecide = async (n, id) => {
  const v = await (await api(n))('GET', `/restationing-requests/${id}`);
  return v.status === 200 ? !!v.body?.can?.decide : `HTTP ${v.status}`;
};

let id = null;
try {
  // ---- the route the server would derive, as the policy page's simulator shows it ------------------------------------------
  const sim = await simulate(U('م10-3'), 'm10-3-before');
  const s91 = (sim.stages ?? []).find((s) => s.unit === U('م9-1'));
  ok(s91 && s91.inheritedFrom === U('م8-3') && !s91.skipped, 'INHERIT-01', 'المحاكي: م9-1 بلا معتمد خاص، يعتمدها معتمد م8-3 (موروث) — لا تُتجاوز', JSON.stringify(s91));

  // ---- U01 asks for م10-3 on the page --------------------------------------------------------------------------------------
  const p1 = await contextFor(browser, L(1), { video: 'C6-requester-inherited' });
  await go(p1, '#newRequest');
  await p1.getByTestId('hub-units').waitFor({ timeout: 20000 });
  await p1.locator(`[data-unit="${unitId(U('م10-3'))}"] [data-go=INITIAL_STATIONING]`).click();
  await p1.getByTestId('initial-sites').waitFor({ timeout: 20000 });
  await p1.waitForTimeout(1500);
  await p1.locator(`[data-testid=initial-sites] [data-site="${CAMP}"]`).click();
  await p1.waitForTimeout(1200);
  await p1.getByTestId('initial-next').click();
  await p1.waitForTimeout(2000);
  await p1.locator('.tz-flow-review textarea').fill('ACCEPTANCE ONLY — تمركز أولي لـ م10-3 في معسكر القبول الكامل 01 (اختبار المعتمد الموروث)');
  await button(p1, 'حفظ المسودة والفحص').click();
  await p1.waitForTimeout(2500);
  await button(p1, 'إرسال للاعتماد').click();
  await p1.waitForFunction(() => /^#restationing\/[0-9a-f-]{36}$/.test(location.hash), null, { timeout: 20000 });
  id = await p1.evaluate(() => location.hash.split('/')[1]);
  out.request = { id, number: sql(`select number from restationing_request where id = '${id}'`) };
  await closePage(p1);
  out.routeAtSubmit = route(id);
  ok(out.routeAtSubmit === `HIERARCHY:${U('م9-1')}:OPEN:- → HIERARCHY:${U('م8-3')}:OPEN:- → HIERARCHY:${B}:SKIPPED:- → UNIT_OPERATIONS:-:OPEN:- → FINAL:-:OPEN:-`,
    'INHERIT-02', 'م9-1 ليست متجاوزة (معتمد موروث)، م8-3 بمعتمدها، «وحدة إضافية 1» متجاوزة', out.routeAtSubmit);

  // ---- U02 signs م9-1 as the inherited approver, then his own م8-3 ------------------------------------------------------
  const p2 = await contextFor(browser, L(2), { video: 'C7-inherited-approver' });
  await go(p2, '#restationing/' + id);
  await p2.reload();
  await p2.getByRole('button', { name: 'اعتماد', exact: true }).waitFor({ timeout: 15000 });
  await p2.locator('.tz-strip-head .tz-tool').click().catch(() => undefined);
  await p2.waitForTimeout(1000);
  await shot(p2, '17b-inherited-approver-decision.png');
  out.inheritedPage = (await p2.locator('.tz-strip').innerText()).replace(/\s+/g, ' ').slice(0, 500);
  ok(/موروث|معتمد أعلى|يعتمدها معتمد/.test(out.inheritedPage), 'INHERIT-03', 'صفحة الطلب تقول إن المستوى يعتمده معتمد أعلى (موروث)', out.inheritedPage.slice(0, 300));
  await button(p2, 'اعتماد').click();
  await p2.waitForTimeout(2500);
  await go(p2, '#restationing/' + id);
  await p2.reload();
  await p2.getByRole('button', { name: 'اعتماد', exact: true }).waitFor({ timeout: 15000 });
  await button(p2, 'اعتماد').click();
  await p2.waitForTimeout(2500);
  await closePage(p2);
  out.afterHierarchy = route(id);
  ok(out.afterHierarchy.startsWith(`HIERARCHY:${U('م9-1')}:APPROVED:${L(2)} → HIERARCHY:${U('م8-3')}:APPROVED:${L(2)} → HIERARCHY:${B}:SKIPPED:-`),
    'INHERIT-04', 'U02 وقّع م9-1 (موروثاً) ثم م8-3 (مستواه) — الاستثناء الوحيد من «شخص واحد لمرحلة واحدة»', out.afterHierarchy);
  const uo = await (await api(3))('POST', `/restationing-requests/${id}/decision`, { decision: 'APPROVE' });
  ok(uo.status === 200, 'R3-01', 'U03 اعتمد عمليات الوحدة', uo.status);

  // ---- FINAL-L3: no final approver covers م10-3 -----------------------------------------------------------------------------
  const simL3 = await simulate(U('م10-3'), 'm10-3-final-L3');
  const finalHolders = (simL3.stages ?? []).find((s) => s.kind === 'FINAL')?.holders;
  ok(finalHolders === 0, 'FINAL-L3a', 'المحاكي: صفر معتمد نهائي يغطي م10-3', finalHolders);
  const a3 = await canDecide(4, id);
  const b3 = await canDecide(5, id);
  ok(a3 !== true && b3 !== true, 'FINAL-L3b', 'لا A ولا B يقرر الطلب', `A=${a3} B=${b3}`);
  const fA = await (await api(4))('POST', `/restationing-requests/${id}/decision`, { decision: 'APPROVE' });
  const fB = await (await api(5))('POST', `/restationing-requests/${id}/decision`, { decision: 'APPROVE' });
  ok(fA.status >= 403 && fB.status >= 403 && stateOf(id) === 'UNDER_REVIEW', 'FINAL-L3c', 'لا اعتماد صامت: يبقى الطلب قيد المراجعة عند «الاعتماد النهائي»', `${fA.status} ${fB.status} ${stateOf(id)}`);
  const pr = await contextFor(browser, L(1));
  await go(pr, '#restationing/' + id);
  await pr.reload();
  await pr.waitForTimeout(3000);
  await pr.locator('.tz-strip-head .tz-tool').click().catch(() => undefined);
  await pr.waitForTimeout(800);
  await shot(pr, '19c-final-L3-no-final-approver.png');
  out.l3Page = (await pr.locator('main#main').innerText()).replace(/\s+/g, ' ');
  ok(/لا يوجد معتمد نهائي|لا معتمد نهائي|لا أحد يملك/.test(out.l3Page), 'FINAL-L3d', 'الصفحة تقول صراحة: لا يوجد معتمد نهائي صالح', (out.l3Page.match(/الاعتماد النهائي[^.]{0,120}/) ?? [''])[0]);
  await closePage(pr);

  // ---- FINAL-L4a: equal scopes (ACCEPTANCE ONLY) -----------------------------------------------------------------------------
  await setA([U('م9-3'), B], '05c-final-A-overlap-dialog.png');
  await replaceB([{ kind: 'ORGANIZATION', id: unitId(B), includeDescendants: true }], 'FINAL-L4 تداخل متساوٍ مؤقت');
  const simEq = await simulate(U('م10-3'), 'm10-3-final-L4-equal');
  const a4 = await canDecide(4, id);
  const b4 = await canDecide(5, id);
  out.l4equal = { holders: (simEq.stages ?? []).find((s) => s.kind === 'FINAL')?.holders, A: a4, B: b4 };
  ok(a4 === true && b4 === true, 'FINAL-L4a', 'نطاقان متساويان («وحدة إضافية 1» بكل مستوياتها) → كلاهما يستطيع القرار: غموض يُرفع للمالك، ولم يُقرَّر', JSON.stringify(out.l4equal));
  // ---- FINAL-L4b: at the same unit a list of levels comes before the whole branch → only B ----------------------------------
  await replaceB([{ kind: 'ORGANIZATION', id: unitId(B), includeDescendants: true, levels: [10] }], 'FINAL-L4 تداخل حتمي مؤقت: المستوى 10');
  const simDet = await simulate(U('م10-3'), 'm10-3-final-L4-levels');
  const simNear = await simulate(U('م10-1'), 'm10-1-final-L4-nearest-unit');
  const a5 = await canDecide(4, id);
  const b5 = await canDecide(5, id);
  out.l4levels = { holders: (simDet.stages ?? []).find((s) => s.kind === 'FINAL')?.holders, A: a5, B: b5, m10_1_holders: (simNear.stages ?? []).find((s) => s.kind === 'FINAL')?.holders };
  ok(a5 === false && b5 === true, 'FINAL-L4b', 'عند الوحدة نفسها: قائمة المستويات (B) تسبق الفرع كله (A) — قاعدة حتمية', JSON.stringify(out.l4levels));
  const fA2 = await (await api(4))('POST', `/restationing-requests/${id}/decision`, { decision: 'APPROVE' });
  ok(fA2.status === 403, 'FINAL-L4c', 'A بطلب مصنوع — مرفوض', fA2.status + ' ' + (fA2.body?.code ?? ''));
  const pB = await contextFor(browser, L(5));
  await go(pB, '#restationing/' + id);
  await pB.reload();
  await pB.getByRole('button', { name: 'اعتماد نهائي', exact: true }).waitFor({ timeout: 15000 });
  await shot(pB, '19d-final-L4-B-decides.png');
  await button(pB, 'اعتماد نهائي').click();
  await pB.waitForTimeout(2500);
  await closePage(pB);
  ok(stateOf(id) === 'APPROVED_NOT_ACTIVATED', 'FINAL-L4d', 'B اعتمد نهائياً؛ الطلب بانتظار تحديد وحدات العلم والتفعيل (للمالك)', stateOf(id));
} catch (e) {
  ok(false, 'R3-ABORT', 'توقف', e.stack);
} finally {
  // ---- restore the two final approvers as distributed --------------------------------------------------------------------
  try {
    await setA([U('م9-3')], null);
    await replaceB([{ kind: 'ORGANIZATION', id: unitId(B), includeDescendants: true, levels: [9] }], 'إعادة B إلى المستوى 9 بعد FINAL-L4');
    const a = sql(`select string_agg(coalesce(o.name, '') || case when t.levels is not null and cardinality(t.levels) > 0 then ' L' || array_to_string(t.levels, ',') when t.include_descendants then ' +فروع' else '' end, '، ') from membership m join membership_scope_target t on t.membership_id = m.id left join organization o on o.id = t.target_id where m.person_id = '${pid(4)}' and m.role_code = 'FINAL_APPROVER' and (m.valid_to is null or m.valid_to > now())`);
    const b = sql(`select string_agg(coalesce(o.name, '') || case when t.levels is not null and cardinality(t.levels) > 0 then ' L' || array_to_string(t.levels, ',') when t.include_descendants then ' +فروع' else '' end, '، ') from membership m join membership_scope_target t on t.membership_id = m.id left join organization o on o.id = t.target_id where m.person_id = '${pid(5)}' and m.role_code = 'FINAL_APPROVER' and (m.valid_to is null or m.valid_to > now())`);
    ok(a === `${U('م9-3')} +فروع` && b === `${B} L9`, 'FINAL-RESTORE', 'أُعيد A إلى فرع م9-3 وB إلى المستوى 9', `A=${a} · B=${b}`);
  } catch (e) {
    ok(false, 'FINAL-RESTORE', 'إعادة المعتمدين النهائيين', e.stack);
  }
}
out.final = id ? { state: stateOf(id), route: route(id) } : null;
writeFileSync(PRIVATE + 'R3.json', JSON.stringify(out, null, 1));
writeFileSync(DOCS + 'R3-route-and-final-levels.json', JSON.stringify(out, null, 1));
await browser.close();
process.exit(0);
