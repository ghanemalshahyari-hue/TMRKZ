// FULL acceptance §11 (posture), §26 FYI-05/FYI-07, §30 (every important button per persona), §31 (forged actions) —
// owner's specification, 16 Nov 2026, on http://localhost:8088, headless. Each of the 14 accounts signs in for real; the top
// navigation each one sees is recorded with what it must and must not see; the posture viewer (U10) is shown in 2D and 3D
// (VIDEO E2); the read receipt of an FYI notice; forged calls by the posture viewer, the unrelated user, the access manager.
//   node tests/acceptance/full26-personas.mjs
import { writeFileSync } from 'node:fs';
import { DOCS, PRIVATE, button, buttons, closePage, contextFor, go, launch, recorder, session, shot, sql, unitId } from './lib/full26-ui.mjs';

const ok = recorder('personas');
const B = 'وحدة إضافية 1';
const U = (n) => `${B} · ${n}`;
const L = (n) => 'full26.u' + String(n).padStart(2, '0');
const req = (num) => sql(`select id from restationing_request where number = '${num}'`);
const [R1, R2, R3] = ['RS-2026-0001', 'RS-2026-0002', 'RS-2026-0003'].map(req);
const CAMP = sql(`select id from site where code = 'S-0002'`);
const api = async (n) => (await session(L(n))).api;
const out = { nav: {}, pages: {} };
const browser = await launch();

// ---- what each persona sees at the top, and which pages answer -------------------------------------------------------------
// MUST SEE / MUST NOT SEE (spec §30), in the navigation's own words
const RULES = {
  1: [['طلب جديد'], ['تهيئة المواقع', 'الصلاحيات']],
  2: [[], ['طلب جديد', 'تهيئة المواقع']],
  3: [[], ['طلب جديد', 'تهيئة المواقع']],
  4: [[], ['طلب جديد', 'تهيئة المواقع']],
  5: [[], ['طلب جديد', 'تهيئة المواقع']],
  6: [[], ['طلب جديد', 'تهيئة المواقع']],
  7: [[], ['طلب جديد', 'تهيئة المواقع']],
  8: [[], ['طلب جديد', 'تهيئة المواقع']],
  9: [[], ['طلب جديد', 'تهيئة المواقع']],
  10: [[], ['طلب جديد', 'تهيئة المواقع']],
  11: [['تهيئة المواقع'], ['طلب جديد']],
  12: [['طلب جديد'], ['تهيئة المواقع']],
  13: [['طلب جديد'], ['تهيئة المواقع']],
  14: [[], ['طلب جديد', 'تهيئة المواقع']],
};
for (let n = 1; n <= 14; n++) {
  const p = await contextFor(browser, L(n));
  await go(p, '#home');
  await p.waitForTimeout(1500);
  const top = (await p.locator('.tz-top').innerText()).replace(/\s+/g, ' ');
  // the «المزيد» menu holds the rest of the pages
  const more = p.locator('.tz-top').getByRole('button', { name: /المزيد/ });
  let extra = '';
  if (await more.count()) {
    await more.first().click();
    await p.waitForTimeout(500);
    extra = (await p.locator('.tz-pop, [role=menu]').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
    await p.keyboard.press('Escape');
  }
  const all = top + ' ' + extra;
  const [yes, no] = RULES[n];
  const missing = yes.filter((x) => !all.includes(x));
  const extraBad = no.filter((x) => all.includes(x));
  out.nav[L(n)] = { top, more: extra };
  ok(!missing.length && !extraBad.length, `NAV-${String(n).padStart(2, '0')}`, `${L(n)}: يرى ${yes.join('، ') || '—'} ولا يرى ${no.join('، ')}`, [...missing.map((m) => 'ناقص: ' + m), ...extraBad.map((m) => 'زائد: ' + m)].join(' | ') || (top + ' ‖ ' + extra).slice(0, 300));
  // a request page each one may or may not open
  const v1 = await (await api(n))('GET', `/restationing-requests/${R1}`);
  out.pages[L(n)] = { R1: v1.status, R1can: v1.body?.can ? Object.entries(v1.body.can).filter(([, v]) => v).map(([k]) => k) : null };
  await closePage(p);
}
const expectR1 = { 1: 200, 2: 200, 3: 200, 4: 200, 5: 404, 6: 200, 7: 200, 8: 404, 9: 200, 10: 404, 11: 200, 12: 404, 13: 404, 14: 404 };
for (const [n, s] of Object.entries(expectR1)) {
  const got = out.pages[L(n)].R1;
  ok(got === s || (s === 404 && got >= 403), `OPEN-R1-${String(n).padStart(2, '0')}`, `${L(n)} يفتح الطلب RS-2026-0001: ${s === 200 ? 'نعم' : 'لا'}`, `${got} · can: ${(out.pages[L(n)].R1can ?? []).join(',') || '—'}`);
}

// ---- FYI-05 / FYI-07 --------------------------------------------------------------------------------------------------------
const u7 = await api(7);
ok((await u7('GET', `/restationing-requests/${R2}`)).status >= 403 && (await u7('GET', `/restationing-requests/${R3}`)).status >= 403, 'FYI-05', 'U07 لا يفتح طلباً لم تُختر له وحدته (RS-2026-0002، RS-2026-0003)');
const p7 = await contextFor(browser, L(7));
await go(p7, '#home');
await p7.waitForTimeout(1500);
await p7.getByRole('button', { name: /^الإشعارات/ }).click();
await p7.waitForTimeout(800);
await shot(p7, '21b-fyi-notification.png');
await p7.locator('.notif-item', { hasText: 'للعلم: الطلب RS-2026-0001' }).first().click();
await p7.waitForTimeout(1500);
await closePage(p7);
const readAt = sql(`select coalesce(read_at::text, '') from notification n join person p on p.id = n.person_id where p.username = '${L(7)}' and n.title = 'للعلم: الطلب RS-2026-0001'`);
ok(readAt !== '', 'FYI-07', 'إيصال القراءة: يُسجَّل وقت قراءة إشعار «للعلم» (notification.read_at)', readAt);

// ---- posture viewer: 2D, 3D, read-only, own branch only (VIDEO E2) -----------------------------------------------------------
const p10 = await contextFor(browser, L(10), { video: 'E2-posture-2D-3D' });
try {
  await go(p10, '#posture');
  await p10.getByTestId('posture-tree').waitFor({ timeout: 20000 });
  await p10.waitForTimeout(2000);
  const tree = await p10.getByTestId('posture-tree').innerText();
  ok(tree.includes(B) && !tree.includes('وحدة إضافية 3'), 'POSTURE-01', 'U10 يرى فرعه فقط', tree.replace(/\s+/g, ' ').slice(0, 200));
  const node = p10.getByTestId('posture-tree').locator(`[data-node="${unitId(U('م8-2'))}"] .ut-name`);
  if (!(await node.count())) {
    await p10.getByTestId('posture-tree').locator(`[data-node="${unitId(B)}"] .ut-twist`).first().click().catch(() => undefined);
    await p10.waitForTimeout(1200);
  }
  await p10.getByTestId('posture-tree').locator(`[data-node="${unitId(U('م8-2'))}"] .ut-name`).click();
  await p10.waitForTimeout(3500);
  const prim = await p10.getByTestId('posture-primary').innerText().catch(() => '');
  const alt = await p10.getByTestId('posture-alternative').innerText().catch(() => '');
  const panel = (await p10.locator('main#main').innerText()).replace(/\s+/g, ' ');
  out.posture = { prim, alt, panel: panel.slice(0, 1200) };
  ok(prim.includes('معتمدة') && alt.includes('معتمدة') && panel.includes('معسكر القبول الكامل 01'), 'POSTURE-02', 'التمركز الحالي والموقع ومنطقتا الانتشار المعتمدتان (م8-2)', `${prim.replace(/\s+/g, ' ')} | ${alt.replace(/\s+/g, ' ')}`);
  ok(/دائم/.test(panel), 'POSTURE-03', 'حالة التمركز دائم/مؤقت ظاهرة', (panel.match(/[^ ]* ?دائم[^ ]* ?[^ ]*/) ?? [''])[0]);
  const bad = await buttons(p10, [], ['اعتماد', 'اعتماد عمليات الوحدة', 'اعتماد نهائي', 'تحديد وحدات العلم', 'تفعيل', 'حفظ المسودة والفحص', 'إرسال للاعتماد', 'إضافة ربط', 'تعديل الطلب', '＋ طلب جديد']);
  ok(bad.length === 0, 'POSTURE-04', 'لا أزرار تعديل أو قرار', bad.join(' | '));
  await shot(p10, '23-operational-posture-2d.png');
  await button(p10, '3D').click();
  await p10.waitForTimeout(7000);
  await shot(p10, '24-operational-posture-3d.png');
  await button(p10, '2D').click().catch(() => undefined);
  await p10.waitForTimeout(800);
  // م10-1, activated through the request
  await p10.getByTestId('posture-tree').locator(`[data-node="${unitId(U('م10-1'))}"] .ut-name`).click().catch(() => undefined);
  await p10.waitForTimeout(2500);
  await shot(p10, '23b-operational-posture-m10-1.png');
} catch (e) {
  ok(false, 'POSTURE-ABORT', 'توقف', e.stack);
  await shot(p10, 'abort-posture.png', { private: true });
}
await closePage(p10);
const u10 = await api(10);
const posture = (await u10('GET', '/operational-posture')).body;
ok(!JSON.stringify(posture).includes('وحدة إضافية 3') && !JSON.stringify(posture).includes('الشرطة'), 'POSTURE-05', 'لا بيانات من فرع آخر');
const forged10 = await Promise.all([
  u10('POST', '/restationing-requests', { requestingUnitId: unitId(U('م8-1')), purpose: 'DEPLOYMENT_AREAS', content: { kind: 'PERMANENT', scope: [unitId(U('م8-1'))], reason: 'محاولة مصنوعة' } }),
  u10('POST', '/site-links', { siteId: CAMP, organizationId: unitId(U('م8-1')), reason: 'محاولة مصنوعة' }),
  u10('POST', '/stationing/corrections', { organizationId: unitId(U('م8-1')), siteId: CAMP, reason: 'محاولة مصنوعة' }),
  u10('POST', `/restationing-requests/${R3}/activate`, {}),
  u10('POST', '/site-setup', { site: { name: 'x', kind: 'معسكر', location: { lat: 24.9, lng: 55.9 } }, boundary: null, units: [], reason: 'محاولة مصنوعة' }),
]);
ok(forged10.every((m) => m.status >= 403), 'SEC-14', 'متابع الموقف لا يغيّر شيئاً حتى بطلبات مصنوعة', forged10.map((m) => m.status).join(','));

// ---- the unrelated branch user ------------------------------------------------------------------------------------------------
const u13 = await api(13);
const p13 = (await u13('GET', '/operational-posture')).body;
const list13 = (await u13('GET', '/restationing-requests')).body ?? [];
ok(!JSON.stringify(p13).includes(B) && !JSON.stringify(p13).includes('معسكر القبول الكامل'), 'ISO-01', 'U13 (فرع «الشرطة») لا يرى شيئاً من «وحدة إضافية 1» ولا المعسكر في الموقف', JSON.stringify(p13).slice(0, 200));
ok(list13.length === 0, 'ISO-02', 'ولا طلباتها', list13.length);
const r13 = await Promise.all([R1, R2, R3].map((r) => u13('GET', `/restationing-requests/${r}`)));
ok(r13.every((x) => x.status >= 403), 'ISO-03', 'ولا يفتح أي طلب منها بالعنوان', r13.map((x) => x.status).join(','));
const s13 = await u13('GET', `/sites/${CAMP}/occupants`);
ok(s13.status >= 403 || !JSON.stringify(s13.body).includes(B), 'ISO-04', 'ولا يسمّي من في المعسكر', s13.status + ' ' + JSON.stringify(s13.body).slice(0, 160));
const p13page = await contextFor(browser, L(13));
await go(p13page, '#posture');
await p13page.waitForTimeout(3000);
await shot(p13page, '25-unrelated-branch-posture.png');
await closePage(p13page);

// ---- the access manager cannot give what only a global manager gives, nor decide requests ---------------------------------------
const u14 = await api(14);
const today = new Date(new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10) + 'T00:00:00+04:00').toISOString();
const give = (role, scope) => u14('POST', '/memberships', { personId: sql(`select id from person where username = '${L(2)}'`), organizationId: unitId(U('م9-3')), roleCode: role, validFrom: today, scope });
const g1 = await give('FINAL_APPROVER', { mode: 'CUSTOM', all: false, targets: [{ kind: 'ORGANIZATION', id: unitId(U('م9-3')), includeDescendants: true }] });
const g2 = await give('SITE_SETUP_ADMIN', { mode: 'ROLE', targets: [] });
const g3 = await give('STATIONING_ACTIVATOR', { mode: 'ROLE', targets: [] });
ok([g1, g2, g3].every((g) => g.status >= 403), 'SEC-15', 'U14 لا يمنح الاعتماد النهائي ولا التهيئة ولا التفعيل (حتى بطلب مصنوع)', [g1, g2, g3].map((g) => g.status + ' ' + (g.body?.message ?? '').slice(0, 60)).join(' | '));
const self = await u14('POST', '/memberships', { personId: sql(`select id from person where username = '${L(14)}'`), organizationId: unitId(B), roleCode: 'POSTURE_VIEWER', validFrom: today, scope: { mode: 'ROLE', targets: [] } });
ok(self.status >= 400, 'SEC-16', 'U14 لا يمنح نفسه', self.status + ' ' + (self.body?.message ?? '').slice(0, 80));
const outside = await u14('POST', '/memberships', { personId: sql(`select id from person where username = '${L(13)}'`), organizationId: unitId('وحدة إضافية 3'), roleCode: 'POSTURE_VIEWER', validFrom: today, scope: { mode: 'ROLE', targets: [] } });
ok(outside.status >= 403, 'SEC-17', 'U14 لا يمنح خارج نطاقه', outside.status);
ok(sql(`select count(*) from membership m join person p on p.id = m.person_id where p.username like 'full26.%' and m.created_at > now() - interval '10 minutes' and m.granted_by = (select id from person where username = '${L(14)}')`) === '0', 'SEC-18', 'لم يُكتب شيء من المحاولات');

writeFileSync(PRIVATE + 'personas.json', JSON.stringify(out, null, 1));
writeFileSync(DOCS + 'personas-navigation.json', JSON.stringify({ nav: Object.fromEntries(Object.entries(out.nav).map(([k, v]) => [k, v.top])), openR1: out.pages }, null, 1));
await browser.close();
process.exit(0);
