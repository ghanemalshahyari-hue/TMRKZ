// The final owner test: for every persona p01 → p14, on the real page, the buttons that must appear and those that must not,
// each at the stage where it matters, and the same action forged at the server. Fresh owner-review environment only; it creates
// one permission request and one deployment request. Writes BUTTON_MATRIX_AR.md and button-matrix.json next to the evidence.
//
//   BROWSER_PATH=… MOVER_URL=http://localhost:8096 node tests/acceptance/persona-buttons.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { apiSession, BASE, consoleErrors, external, launch, newContext, signInManual, watch } from './lib/browser.mjs';

// On the one application (ops/acceptance-main): ACC_NS and ACC_PREFIX name the loaded run; ACC_EVIDENCE keeps evidence out of Git,
// because pages on :8088 can show real units. Defaults keep the separate fictional environments working.
const NS = process.env.ACC_NS ?? 't';
const PFX = process.env.ACC_PREFIX ?? '';
// the button matrix's own new person and unit, so it can run after the journeys on the same load
const NEW = process.env.PB_NEW ?? 'p01.new';
const UNIT = process.env.PB_UNIT ?? 'N-A11';
const ASK = process.env.ACC_ASK_ROLE ?? 'POSTURE_VIEWER';
const DB = process.env.DB_CONTAINER ?? 'tmrkz-next-db-1';
const evidence = process.env.ACC_EVIDENCE ?? fileURLToPath(new URL('../../docs/evidence/stationing-next/', import.meta.url));
mkdirSync(evidence, { recursive: true });
const sql = (q) => execFileSync('docker', ['exec', DB, 'psql', '-X', '-q', '-U', 'mover', '-d', 'mover', '-At', '-c', q], { encoding: 'utf8' }).trim();
const org = (x) => sql(`select md5('${NS}:org:${x}')::uuid`);
const rows = [];
const browser = await launch();
const pageOf = new Map();
const pageAs = async (u) => {
  if (pageOf.has(u)) return pageOf.get(u);
  const c = await newContext(browser);
  const p = await c.newPage();
  watch(p, u);
  await signInManual(p, u);
  pageOf.set(u, p);
  return p;
};
const open = async (p, hash) => {
  await p.goto(BASE + '/' + hash);
  await p.reload();
  await p.waitForSelector('main#main');
  await p.waitForTimeout(1500);
};
/** One row of the matrix: what the page shows now, and the forged calls that must be refused. */
const check = async (persona, role, page, hash, yes, no, forged = []) => {
  const p = await pageAs(persona);
  await open(p, hash);
  const hasBtn = async (n) => (await p.getByRole('button', { name: n, exact: true }).count()) > 0 || (await p.getByRole('link', { name: n, exact: true }).count()) > 0;
  const missing = [];
  for (const n of yes) if (!(await hasBtn(n))) missing.push(n);
  const extra = [];
  for (const n of no) if (await hasBtn(n)) extra.push(n);
  const api = await apiSession(persona);
  const refused = [];
  for (const [label, method, path, body] of forged) {
    const r = await api[method](path, body);
    refused.push({ label, status: r.status, pass: r.status === 400 || r.status === 403 || r.status === 404 });
  }
  const pass = !missing.length && !extra.length && refused.every((r) => r.pass);
  rows.push({ persona, role, page, yes, no, missing, extra, refused, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${persona} ${page}${missing.length ? ' ناقص: ' + missing.join('، ') : ''}${extra.length ? ' زائد: ' + extra.join('، ') : ''}${refused.filter((r) => !r.pass).map((r) => ' قُبل: ' + r.label + ' ' + r.status).join('')}`);
};
const ALL = ['اعتماد', 'اعتماد عمليات الوحدة', 'اعتماد نهائي', 'تحديد وحدات العلم', 'تفعيل'];
const without = (...keep) => ALL.filter((b) => !keep.includes(b));
const square = (lng, lat, d = 0.0015) => ({ type: 'Polygon', coordinates: [[[lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d], [lng - d, lat + d], [lng - d, lat - d]]] });

try {
  const p01Api = await apiSession(NEW);
  await check(NEW, 'مستخدم جديد', 'طلب صلاحية', '#requestAccess', ['إرسال طلب الصلاحية'], ['إرسال التوصية', 'اعتماد وتفعيل', ...ALL, '＋ طلب جديد']);
  const asked = await p01Api.post('/access-requests', { roles: [ASK], reason: 'أتابع موقف وحدتي', scope: { mode: 'UNIT', ids: [] } });
  if (asked.status !== 200) throw new Error('access: ' + JSON.stringify(asked.body));
  const task = () => sql(`select id from task_assignment where request_id = '${asked.body.id}' and status = 'OPEN'`);
  await check('p02.access', 'مدير صلاحيات الوحدة', 'طلبات الصلاحية', '#accessInbox', ['إرسال التوصية', 'إرجاع للتعديل', 'رفض'], ['اعتماد وتفعيل', ...ALL], [
    ['قرار نهائي قبل وقته بنطاق النظام كله', 'post', `/access-requests/${asked.body.id}/decision`, { taskId: task(), decision: 'APPROVE', roles: [ASK], scope: { mode: 'ALL', ids: [] } }],
  ]);
  const a02 = await apiSession('p02.access');
  const rec = await a02.post(`/access-requests/${asked.body.id}/decision`, { taskId: task(), decision: 'APPROVE', roles: [ASK] });
  if (rec.status !== 200) throw new Error('recommend: ' + JSON.stringify(rec.body));
  await check('p03.final', 'معتمد الصلاحيات النهائي', 'طلبات الصلاحية', '#accessInbox', ['اعتماد وتفعيل', 'إرجاع للتعديل', 'رفض'], ['إرسال التوصية', ...ALL]);

  const a05 = await apiSession('p05.req');
  await check('p04.sites', 'مدير المواقع', 'تهيئة المواقع والتمركز', '#siteSetup', ['＋ إضافة موقع'], [...ALL, 'اعتماد وتفعيل', 'إرسال التوصية']);
  await check('p05.req', 'مقدم الطلبات', 'طلب جديد', '#newRequest', ['طلب منطقة انتشار', 'طلب تمركز أولي', 'طلب إعادة تمركز'], [...ALL, 'اعتماد وتفعيل', 'إرسال التوصية', '＋ إضافة موقع']);
  const made = await a05.post('/restationing-requests', { requestingUnitId: org(UNIT), purpose: 'DEPLOYMENT_AREAS', content: { kind: 'PERMANENT', scope: [org(UNIT)], primary: square(56.1195, 24.86), alternative: square(56.1195, 24.8965), reason: 'منطقتا الانتشار لفحص الأزرار' } });
  if (made.status !== 200) throw new Error('draft: ' + JSON.stringify(made.body));
  const id = made.body.id;
  const sub = await a05.post(`/restationing-requests/${id}/submit`, {});
  if (sub.status !== 200) throw new Error('submit: ' + JSON.stringify(sub.body));
  const decide = ['اعتماد مصنوع', 'post', `/restationing-requests/${id}/decision`, { decision: 'APPROVE' }];
  const activate = ['تفعيل مصنوع', 'post', `/restationing-requests/${id}/activate`, {}];
  const fyi = ['علم مصنوع', 'post', `/restationing-requests/${id}/fyi`, { units: [] }];
  const req = '#restationing/' + id;
  const nextStage = async (who) => {
    const r = await (await apiSession(who)).post(`/restationing-requests/${id}/decision`, { decision: 'APPROVE' });
    if (r.status !== 200) throw new Error(who + ': ' + JSON.stringify(r.body).slice(0, 300));
  };
  await check('p05.req', 'مقدم الطلبات', 'طلبه قيد الاعتماد', req, [], ALL, [decide, activate, fyi]);
  await check('p07.h2', 'اعتماد المستوى L7', 'قبل دوره', req, [], ALL, [decide, activate, fyi]);
  await check('p06.h1', 'اعتماد المستوى L8', 'مرحلته', req, ['اعتماد', 'إرجاع للتعديل', 'رفض'], without('اعتماد'), [activate, fyi]);
  await nextStage('p06.h1');
  await check('p07.h2', 'اعتماد المستوى L7', 'مرحلته', req, ['اعتماد', 'إرجاع للتعديل', 'رفض'], without('اعتماد'), [activate, fyi]);
  await nextStage('p07.h2');
  await check('p09.fin', 'الاعتماد النهائي', 'قبل دوره', req, [], ALL, [decide, activate, fyi]);
  await check('p08.ops', 'عمليات الوحدة', 'مرحلته', req, ['اعتماد عمليات الوحدة', 'إرجاع للتعديل', 'رفض'], without('اعتماد عمليات الوحدة'), [activate, fyi]);
  await nextStage('p08.ops');
  await check('p09.fin', 'الاعتماد النهائي', 'مرحلته', req, ['اعتماد نهائي', 'إرجاع للتعديل', 'رفض'], without('اعتماد نهائي'), [activate, fyi]);
  await nextStage('p09.fin');
  await check('p11.act', 'التفعيل', 'قبل تحديد العلم', req, [], ALL, [activate, decide, fyi]);
  await check('p10.fyi', 'توزيع العلم', 'بعد الاعتماد النهائي', req, ['تحديد وحدات العلم'], without('تحديد وحدات العلم'), [decide, activate]);
  const sent = await (await apiSession('p10.fyi')).post(`/restationing-requests/${id}/fyi`, { units: [org('N-B1')] });
  if (sent.status !== 200) throw new Error('fyi: ' + JSON.stringify(sent.body));
  await check('p11.act', 'التفعيل', 'بعد المراحل كلها', req, ['تفعيل'], without('تفعيل'), [decide, fyi]);
  await check('p12.view', 'متابعة الموقف', 'الموقف العملياتي', '#posture', [], [...ALL, 'إرجاع للتعديل', 'رفض', 'حفظ المسودة والفحص', 'إرسال للاعتماد', '＋ طلب جديد', 'إضافة ربط', 'تعديل الطلب'], [
    ['إنشاء طلب مصنوع', 'post', '/restationing-requests', { requestingUnitId: org('N-A11'), purpose: 'DEPLOYMENT_AREAS', content: { kind: 'PERMANENT', scope: [org('N-A11')], reason: 'محاولة مصنوعة' } }],
    decide, activate, fyi,
    ['ربط مصنوع', 'post', '/site-links', { siteId: sql(`select md5('${NS}:site:SITE-01')::uuid`), organizationId: org('N-A11'), reason: 'محاولة مصنوعة' }],
    ['تصحيح مصنوع', 'post', '/stationing/corrections', { organizationId: org('N-A11'), siteId: sql(`select md5('${NS}:site:SITE-01')::uuid`), reason: 'محاولة مصنوعة' }],
  ]);
  await check('p13.other', 'متابعة من فرع آخر', 'الطلب الذي وصله للعلم', req, [], [...ALL, 'إرجاع للتعديل', 'رفض', 'تعديل الطلب'], [decide, activate, fyi]);
  await check('p14.admin', 'مدير المنصة', 'مركز الصلاحيات', '#permissions', ['الصلاحيات المعروضة للطلب'], [...ALL, 'اعتماد وتفعيل', 'إرسال التوصية'], [decide, activate, fyi]);
} catch (e) {
  rows.push({ persona: 'ABORT', role: '', page: e.message.slice(0, 300), yes: [], no: [], missing: [], extra: [], refused: [], pass: false });
  console.log('FAIL ABORT ' + e.message.slice(0, 400));
} finally {
  await browser.close();
}
const failed = rows.filter((r) => !r.pass);
const clean = consoleErrors.length === 0 && external.length === 0;
writeFileSync(evidence + 'button-matrix.json', JSON.stringify({ at: new Date().toISOString(), rows, consoleErrors, external }, null, 1) + '\n');
const cell = (l) => (l.length ? l.join('، ') : '—');
const md = ['# مصفوفة ظهور الأزرار لكل مستخدم', '', 'نتيجة فعلية من المتصفح الحقيقي في بيئة `tmrkz-next` الوهمية (`tests/acceptance/persona-buttons.mjs`). كل سطر فُحص في تلك الحالة من الطلب، والطلبات المصنوعة أُرسلت إلى الخادم.', '',
  '| المستخدم | الدور | الصفحة أو الحالة | يجب أن يظهر | يجب ألا يظهر | طلبات مصنوعة مرفوضة | النتيجة |', '|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| \`${r.persona}\` | ${r.role} | ${r.page} | ${cell(r.yes)} | ${cell(r.no)} | ${r.refused.length ? r.refused.filter((x) => x.pass).length + ' من ' + r.refused.length : '—'} | ${r.pass ? 'PASS' : 'FAIL'} |`), '',
  `أخطاء المتصفح: ${consoleErrors.length}. الطلبات الخارجية: ${external.length}.`, ''];
writeFileSync(evidence + 'BUTTON_MATRIX_AR.md', md.join('\n'));
console.log(`${rows.length - failed.length}/${rows.length} passed; console errors ${consoleErrors.length}; external ${external.length}`);
process.exit(failed.length || !clean ? 1 : 0);
