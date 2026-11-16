// ACCEPTANCE ONLY — OWNER DECISION PENDING. «LDAP FIRST LOGIN + ZERO ACCESS + UNIT-OWNED REQUESTS + UNIT-OWNED APPROVAL SEATS»
// (owner, 16 Nov 2026; ADR-069) on http://localhost:8088 only, headless Edge. Fictional people of ops/acceptance-main/acc69.mjs
// (demo Oracle + stand-in directory, nothing in TMRKZ before they sign in). Oracle is in force on :8088 (Mode B): a first
// sign-in finds the person live in HR and imports them with nothing. Screens (fictional data only) and results go to
// docs/evidence/ldap-first-login/. Prerequisite: `node ops/acceptance-main/acc69.mjs add`.
//   node tests/acceptance/acc69-ldap-first-login.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { accountPassword, adminPassword, BASE, signInAs } from './lib/acc69.mjs';

const ROOT = 'C:/Users/ADMIN/Desktop/TMRKZ';
const OUT = `${ROOT}/docs/evidence/ldap-first-login/`;
mkdirSync(OUT, { recursive: true });
const { chromium } = await import(pathToFileURL(`${ROOT}/tests/acceptance/node_modules/playwright-core/index.mjs`).href);

const results = [];
const ok = (pass, id, what, detail = '') => {
  results.push({ id, pass: !!pass, what, detail: String(detail).slice(0, 500) });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} — ${what}${detail ? ' · ' + String(detail).slice(0, 220) : ''}`);
  return !!pass;
};
const sql = (q) => execFileSync('docker', ['exec', 'tmrkz-mover-db-1', 'sh', '-c', `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -q -Atc "${q.replaceAll('"', '\\"')}"`], { encoding: 'utf8' }).trim();
const unit = (name) => sql(`select id from organization where name = '${name}' and status = 'ACTIVE'`);
const person = (login) => sql(`select id from person where lower(username) = '${login}' or id in (select p.id from person p join hr_person h on h.external_id = p.source_external_id and h.snapshot_id = (select id from hr_snapshot where status = 'PUBLISHED') where lower(h.domain_account) = '${login}') limit 1`);
const RUN = process.env.ACC69_RUN ?? '';
const L = Object.fromEntries(Object.entries({ new1: 'new1', uam: 'uam', fin: 'final', new2: 'new2', req: 'req1b', req2: 'req1b2', opsb: 'opsb' }).map(([k, v]) => [k, `acc69${RUN}.${v}`]));
const TAG = RUN ? ` (${RUN})` : '';
const U = { sec1a: 'قسم صحة 1-أ', center1: 'مركز صحة واحد', health: 'إدارة الصحة', sec1b: 'قسم صحة 1-ب', moveTo: 'قسم صحة 2-ب', opsUnit: 'عمليات إدارة الصحة' };
const LABEL = 'ACCEPTANCE ONLY — OWNER DECISION PENDING';

if (sql(`select count(*) from hr_person h join hr_snapshot s on s.id = h.snapshot_id and s.status = 'PUBLISHED' where lower(h.domain_account) like 'acc69${RUN}.%'`) !== '0'
    || sql(`select count(*) from person where lower(username) like 'acc69${RUN}.%'`) !== '0') {
  console.error(`acc69${RUN} people already exist in TMRKZ: this run starts from people TMRKZ has never seen (AUTH-01). Use the next batch: ACC69_RUN=…`);
  process.exit(2);
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const external = [];
async function context(cookies) {
  const ctx = await browser.newContext({ locale: 'ar-AE', timezoneId: 'Asia/Dubai', viewport: { width: 1440, height: 900 } });
  if (cookies) await ctx.addCookies(cookies);
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (!['localhost', '127.0.0.1'].includes(u.hostname) && !/^(data|blob):/.test(u.protocol)) {
      external.push(u.href);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  return page;
}
const go = async (page, hash) => {
  await page.goto(BASE + '/' + hash);
  await page.reload(); // a hash change alone keeps the page's data from before
  await page.waitForSelector('main#main', { timeout: 30000 });
  await page.waitForSelector('main#main', { timeout: 30000 });
  await page.waitForTimeout(1500);
};
const shot = (page, name, opts = {}) => page.screenshot({ path: OUT + name, ...opts });
const sessions = {};
const as = async (who) => (sessions[who] ??= await signInAs(L[who] ?? who, who === 'admin' ? adminPassword() : accountPassword()));
const admin = await signInAs('admin', adminPassword());

// ---- 1. the first LDAP login, in the browser: nobody created this account (AUTH-01) ---------------------------------------
const p1 = await context();
await p1.goto(BASE + '/');
const auto = p1.locator('a.tm-submit', { hasText: 'الدخول الآلي بالحساب المؤسسي' });
await auto.waitFor({ timeout: 30000 });
await p1.waitForTimeout(1500);
await auto.click();
await p1.locator('#username').waitFor({ timeout: 30000 });
await p1.locator('#username').fill(L.new1);
await p1.locator('#password').fill(accountPassword());
await shot(p1, '01-first-ldap-login.png');
await p1.locator('#kc-login').click();
await p1.waitForSelector('main#main', { timeout: 60000 });
await p1.getByTestId('access-identity').waitFor({ timeout: 30000 });
await p1.waitForTimeout(1500);
const new1 = person(L.new1);
ok(!!new1, 'AUTH-01', 'دخول أول من الدليل دون إضافة يدوية: أُنشئ الشخص وربط حسابه', sql(`select source || ' · ' || coalesce(username, '-') || ' · ' || (select string_agg(method, ',') from identity_link where person_id = p.id) from person p where id = '${new1}'`));
ok(sql(`select count(*) from membership where person_id = '${new1}'`) === '0', 'AUTH-04', 'العضوية في الوحدة لا تمنح شيئاً: صفر صلاحيات بعد الدخول الأول', 'membership 0');
await shot(p1, '02-zero-access-page.png', { fullPage: true });
await p1.getByTestId('access-identity').screenshot({ path: OUT + '03-identity-card.png' });
const card = (await p1.getByTestId('access-identity').innerText()).replace(/\s+/g, ' ');
ok(card.includes(U.sec1a) && card.includes('لم تقدم طلب صلاحية') && card.includes('موظف قبول أول'), 'AUTH-01b', 'بطاقة الهوية: الاسم والوحدة الحالية والوحدة الرئيسية والحالة', card.slice(0, 300));
const nav = (await p1.locator('.tz-top').innerText()).replace(/\s+/g, ' ');
const hidden = ['الرئيسية', 'المواقع', 'الخريطة', 'الطلبات', 'التقارير', 'الموقف', 'مسار', 'الإعدادات', 'الصلاحيات والوحدات'];
ok(nav.includes('طلب صلاحية') && hidden.every((h) => !nav.includes(h)), 'AUTH-03a', 'الشريط العلوي لمن لا صلاحية له: «طلب صلاحية» و«مركز الدعم» والخروج فقط', nav.slice(0, 200));
await go(p1, '#stationing');
ok((await p1.locator('.tz-app').getAttribute('data-view')) === 'requestAccess', 'AUTH-03b', 'فتح #stationing يدوياً يعيده إلى صفحة طلب الصلاحية');
const s1 = { api: async (m, u, b) => {
  const cookies = await p1.context().cookies(BASE);
  const r = await fetch(BASE + '/api/v1' + u, { method: m, headers: { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '), 'X-Requested-With': 'mover', 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
} };
const refused = [];
for (const path of ['/restationing-requests', '/sites', '/organizations/roots', '/request-hub', '/stationing/current', '/access/grants', '/requests']) {
  const r = await s1.api('GET', path);
  if (!(r.status === 403 && r.body?.code === 'NO_EFFECTIVE_ACCESS')) refused.push(`${path}=${r.status}`);
}
ok(!refused.length, 'AUTH-03c', 'الخادم يرفض واجهات التطبيق لمن لا صلاحية له (NO_EFFECTIVE_ACCESS)', refused.join(' ') || '7 of 7 refused');
ok((await s1.api('GET', '/access-requests/mine')).status === 200, 'AUTH-03d', 'صفحة طلب الصلاحية وحالتها تعمل');

// ---- 2. the administrator exposes roles to ask for (§9, §29, §36; ACCEPTANCE: broad, restored afterwards) ----------------
// what the catalogue was before any acceptance run: saved once, restored at the end of every run
const SAVED = `${ROOT}/ops/acceptance-main/.generated/acc69-offer-before.json`;
if (!existsSync(SAVED)) {
  const before = (await admin.api('GET', '/access-requests/offer')).body ?? [];
  writeFileSync(SAVED, JSON.stringify(Object.fromEntries(before.filter((r) => r.audience).map((r) => [r.code, { audience: r.audience, description: r.description, scopeModes: r.scopeModes?.length ? r.scopeModes : null, defaultScope: r.defaultScope }]))));
}
const saved = JSON.parse(readFileSync(SAVED, 'utf8'));
const offer = {
  ...saved,
  STATIONING_REQUESTER: { audience: 'EVERYONE', description: 'إنشاء طلبات التمركز الأولي ومناطق الانتشار وإعادة التمركز لوحدتك.' },
  POSTURE_VIEWER: { audience: 'EVERYONE', description: 'متابعة الموقف العملياتي لوحدتك وما يتبعها على الخريطة.' },
  CHAIN_APPROVER: { audience: 'EVERYONE' },
  UNIT_OPERATIONS_APPROVER: { audience: 'EVERYONE', description: 'اعتماد عمليات الوحدة للوحدات التي يحددها المعتمد النهائي.' },
  FYI_DISTRIBUTOR: { audience: 'EVERYONE', description: 'تحديد الوحدات التي تعلم بالطلب بعد الاعتماد النهائي.' },
  SITE_REGISTRATION_REQUESTER: { audience: 'SHOWN' },
};
const offered = await admin.api('PUT', '/access-requests/offer', offer);
ok(offered.status === 200, 'ADMIN-OFFER', 'مدير النظام يحدد «الصلاحيات المتاحة للطلب» دون تغيير الشيفرة (قبول: عرض واسع)', offered.status);
const pa = await context(admin.cookies);
await go(pa, '#permissions/policy');
await pa.getByTestId('access-offer').click();
await pa.getByTestId('access-offer-dialog').waitFor({ timeout: 15000 });
await pa.waitForTimeout(800);
await shot(pa, '04-permission-catalogue.png');
await pa.keyboard.press('Escape');

// the other fictional people sign in once (each imported with nothing), then the administrator gives the two access seats
for (const who of ['uam', 'fin', 'new2', 'req', 'req2', 'opsb']) await as(who);
const grant = async (who, role, home, scope) => {
  const r = await admin.api('POST', '/memberships', { personId: person(L[who]), organizationId: unit(home), roleCode: role, scope });
  ok(r.status === 200, 'SETUP-' + who + '-' + role, `${L[who]}: ${role} @ ${home}`, r.status === 200 ? r.body?.scopeText : JSON.stringify(r.body));
};
await grant('uam', 'UNIT_ACCESS_MANAGER', U.center1, { mode: 'CUSTOM', targets: [{ kind: 'ORGANIZATION', id: unit(U.center1), includeDescendants: true }] });
await grant('fin', 'ACCESS_FINAL_APPROVER', 'قيادة إدارة الصحة', null);
await grant('req', 'STATIONING_REQUESTER', U.sec1b, null);
await grant('req2', 'STATIONING_REQUESTER', U.sec1b, null);

// ---- 3. the person asks for five roles (ACCESS-01) --------------------------------------------------------------------------
await go(p1, '#requestAccess');
const ASKED = ['STATIONING_REQUESTER', 'POSTURE_VIEWER', 'CHAIN_APPROVER', 'UNIT_OPERATIONS_APPROVER', 'FYI_DISTRIBUTOR'];
for (const r of ASKED) await p1.locator(`input[data-role=${r}]`).check();
ok(await p1.getByTestId('access-info-only').isVisible(), 'OFFER-SHOWN', 'صلاحية «تظهر للاطلاع ولا تُطلب» تظهر بلا علامة اختيار');
await p1.getByLabel('سبب الطلب').fill('أحتاج هذه الصلاحيات لعملي في القسم — ' + LABEL);
await p1.locator('input[data-scope=UNIT]').check();
await p1.getByRole('button', { name: 'إرسال طلب الصلاحية' }).click();
await p1.getByTestId('access-open').waitFor({ timeout: 20000 });
await p1.waitForTimeout(1200);
await shot(p1, '05-submitted-access-request.png', { fullPage: true });
const reqId = sql(`select request_id from access_request where person_id = '${new1}' and open`);
const number = sql(`select number from request where id = '${reqId}'`);
ok(sql(`select array_to_string(requested, ',') from access_request where request_id = '${reqId}'`) === ASKED.join(','), 'ACCESS-01', `${number}: خمس صلاحيات من أنواع مختلفة في طلب واحد`, ASKED.join(','));
ok((await p1.getByTestId('access-overall').innerText()).includes('طلبك بانتظار مراجعة مسؤول الصلاحيات'), 'STATUS-1', 'سطر الحالة: «طلبك بانتظار مراجعة مسؤول الصلاحيات»');

// ---- 4. the unit's access manager recommends three (ACCESS-02) ------------------------------------------------------------
const pm = await context((await as('uam')).cookies);
await go(pm, '#accessInbox');
const itemM = pm.locator(`[data-testid=access-item][data-request="${number}"]`);
await itemM.waitFor({ timeout: 20000 });
for (const r of ['CHAIN_APPROVER', 'FYI_DISTRIBUTOR']) await itemM.locator(`input[data-role=${r}]`).uncheck();
ok(await itemM.getByRole('button', { name: 'إرسال التوصية' }).count() === 1 && await itemM.getByRole('button', { name: 'اعتماد وتفعيل' }).count() === 0, 'ACCESS-02a', 'مسؤول صلاحيات الوحدة يرى «إرسال التوصية» ولا يرى «اعتماد وتفعيل»');
await itemM.scrollIntoViewIfNeeded();
await shot(pm, '06-access-manager-recommendation.png', { fullPage: true });
await itemM.getByRole('button', { name: 'إرسال التوصية' }).click();
await pm.waitForTimeout(2000);
ok(sql(`select array_to_string(recommended, ',') from access_request where request_id = '${reqId}'`) === 'STATIONING_REQUESTER,POSTURE_VIEWER,UNIT_OPERATIONS_APPROVER', 'ACCESS-02', 'المطلوب 5 والموصى به 3، ولا شيء فعّال بعد', 'membership=' + sql(`select count(*) from membership where person_id = '${new1}'`));
ok(sql(`select count(*) from membership where person_id = '${new1}'`) === '0', 'ACCESS-02b', 'التوصية لا تفعّل أي صلاحية');
await go(p1, '#requestAccess');
ok((await p1.getByTestId('access-overall').innerText()).includes('بانتظار الاعتماد النهائي'), 'STATUS-2', 'سطر الحالة: «بانتظار الاعتماد النهائي»');

// ---- 5. the final access approver grants a different subset, each role with its exact scope (ACCESS-03/05/06) -------------
const pf = await context((await as('fin')).cookies);
await go(pf, '#accessInbox');
const itemF = pf.locator(`[data-testid=access-item][data-request="${number}"]`);
await itemF.waitFor({ timeout: 20000 });
await itemF.getByTestId('final-grants').waitFor({ timeout: 20000 });
await itemF.locator('[data-final-role=POSTURE_VIEWER] input[data-role=POSTURE_VIEWER]').uncheck();
// unit operations: «إدارة الصحة» with levels 9 and 10 (the owner's example), valid one year
await itemF.locator('[data-final-role=UNIT_OPERATIONS_APPROVER] select[data-scope-kind]').selectOption('CUSTOM');
await itemF.locator('[data-edit-units=UNIT_OPERATIONS_APPROVER]').click();
const dlg = pf.getByTestId('units-dialog');
await dlg.waitFor({ timeout: 15000 });
await dlg.getByRole('button', { name: 'إزالة ' + U.sec1a }).click();
const search = dlg.getByTestId('units-tree').getByRole('searchbox');
await search.fill(U.health);
const hit = dlg.getByRole('option').filter({ has: pf.locator('b', { hasText: new RegExp('^\\s*' + U.health + '\\s*$') }) }).first();
await hit.waitFor({ timeout: 15000 });
await hit.locator('input[type=checkbox]').check();
await search.fill('');
await pf.waitForTimeout(600);
await dlg.getByLabel('نطاق الاعتماد ' + U.health).selectOption('LEVELS');
const levels = dlg.getByRole('group', { name: 'مستويات ' + U.health });
for (const lv of ['9', '10']) await levels.getByLabel(lv, { exact: true }).check();
await pf.waitForTimeout(800);
await shot(pf, '08-unit-operations-levels.png');
await pf.getByTestId('units-save').click();
await dlg.waitFor({ state: 'detached', timeout: 15000 });
const inAYear = new Date(Date.now() + 365 * 864e5);
const day = `${inAYear.getFullYear()}-${String(inAYear.getMonth() + 1).padStart(2, '0')}-${String(inAYear.getDate()).padStart(2, '0')}`;
await itemF.locator('input[data-valid-to=UNIT_OPERATIONS_APPROVER]').fill(day);
await itemF.scrollIntoViewIfNeeded();
await pf.waitForTimeout(600);
await shot(pf, '07-final-approver-editing.png', { fullPage: true });
await itemF.getByTestId('access-preview-run').click();
const prev = itemF.getByTestId('access-preview');
await prev.waitFor({ timeout: 20000 });
await pf.waitForTimeout(800);
await prev.scrollIntoViewIfNeeded();
await prev.screenshot({ path: OUT + '09-effective-preview.png' });
const previewOps = (await prev.locator('tr[data-preview-role=UNIT_OPERATIONS_APPROVER]').innerText()).replace(/\s+/g, ' ');
const previewReq = (await prev.locator('tr[data-preview-role=STATIONING_REQUESTER]').innerText()).replace(/\s+/g, ' ');
ok(previewOps.includes('«إدارة الصحة»: المستوى 9 و10') && previewOps.includes('مسؤولية/مقعد الوحدة'), 'ACCESS-05', 'معتمد عمليات الوحدة: المرتكز «إدارة الصحة»، المستويان 9 و10، مقعد للوحدة', previewOps);
ok(previewReq.includes(U.sec1a) && previewReq.includes('صلاحية شخصية'), 'ACCESS-05b', 'إنشاء طلبات التمركز: الوحدة نفسها فقط، صلاحية شخصية', previewReq);
await itemF.getByTestId('access-activate').click();
await pf.waitForTimeout(2500);
await shot(pf, '10-activated-access.png', { fullPage: true });
const granted = sql(`select string_agg(m.role_code || '|' || coalesce((select string_agg(o.name || ':' || coalesce(array_to_string(t.levels, ','), case when t.include_descendants then '+' else '1' end), ';') from membership_scope_target t join organization o on o.id = t.target_id where t.membership_id = m.id), 'ROLE') || '|' || (m.valid_to is not null), ' ; ' order by m.role_code) from membership m where m.person_id = '${new1}' and (m.valid_to is null or m.valid_to > now())`);
ok(granted === `STATIONING_REQUESTER|${U.sec1a}:1|false ; UNIT_OPERATIONS_APPROVER|${U.health}:9,10|true`, 'ACCESS-03', 'المعتمد النهائي منح مجموعة مختلفة (2 من 3 موصى بها) بنطاق كل دور', granted);
ok(sql(`select array_to_string(requested, ',') || ' / ' || array_to_string(recommended, ',') || ' / ' || array_to_string(granted, ',') from access_request where request_id = '${reqId}'`)
  === `${ASKED.join(',')} / STATIONING_REQUESTER,POSTURE_VIEWER,UNIT_OPERATIONS_APPROVER / STATIONING_REQUESTER,UNIT_OPERATIONS_APPROVER`, 'ACCESS-SETS', 'المطلوب والموصى به والممنوح ثلاث مجموعات منفصلة');
// ACCESS-06: the grants list says exactly what the preview said; OpenFGA answers as the published decision
const listed = (await admin.api('GET', `/access/grants?personId=${new1}`)).body ?? [];
const opsText = listed.find((g) => g.role?.code === 'UNIT_OPERATIONS_APPROVER')?.scopeText;
ok(opsText && previewOps.includes(opsText), 'ACCESS-06', 'المعاينة تطابق النتيجة الفعلية حرفاً بحرف', opsText);
const fga = [];
for (const [org, expect] of [[U.sec1b, true], [U.moveTo, true], [U.center1, false], ['إدارة الإطفاء 1', false]]) {
  const id = unit(org);
  if (!id) continue;
  const ex = (await admin.api('GET', `/access/explain?personId=${new1}&organizationId=${id}`)).body;
  const a = (ex?.actions ?? []).find((x) => x.action === 'DECIDE_UNIT_OPERATIONS');
  fga.push(`${org}: published=${a?.published?.allowed} openfga=${a?.openfga} (expected ${expect})`);
  ok(a?.published?.allowed === expect && a?.openfga === expect, 'FGA-' + org, `اعتماد عمليات الوحدة في «${org}»: ${expect ? 'مسموح' : 'مرفوض'} في القرار المنشور وفي OpenFGA`, `published=${a?.published?.allowed} openfga=${a?.openfga} available=${ex?.openfgaAvailable}`);
}

// ---- 6. after the grant: only what the grants allow (§32) -----------------------------------------------------------------
const p1b = await context((await signInAs(L.new1, accountPassword())).cookies);
await go(p1b, '#home');
await p1b.waitForTimeout(1500);
const nav2 = (await p1b.locator('.tz-top').innerText()).replace(/\s+/g, ' ');
await shot(p1b, '11-permitted-navigation.png');
const notThere = ['الصلاحيات والوحدات', 'تهيئة المواقع', 'الإعدادات', 'مركز الصلاحيات', 'سجل التدقيق'].filter((x) => nav2.includes(x));
// the requester's own entries: «إعادة التمركز» in the bar and «طلب جديد» on the home page (not a bar link)
const ownEntries = nav2.includes('إعادة التمركز') && (await p1b.getByRole('button', { name: /طلب جديد/ }).count()) > 0;
ok(!notThere.length && ownEntries, 'NAV-AFTER', 'بعد التفعيل: يرى ما تسمح به منحتاه فقط، لا كامل التطبيق', nav2.slice(0, 260));
const s1b = await signInAs(L.new1, accountPassword());
const after = { hub: (await s1b.api('GET', '/request-hub')).status, grants: (await s1b.api('GET', '/access/grants')).status, setup: (await s1b.api('POST', '/site-setup/check', {})).status };
ok(after.hub === 200 && after.grants === 403 && after.setup === 403, 'API-AFTER', 'الواجهات تتبع المنح: مركز الطلبات مفتوح، إدارة الصلاحيات والتهيئة مرفوضتان', JSON.stringify(after));

// ---- 7. a unit no access manager covers: the review is passed, recorded, and the final approver receives it (§33) ---------
const s2 = await as('new2');
const asked2 = await s2.api('POST', '/access-requests', { roles: ['STATIONING_REQUESTER'], reason: 'أحتاجها لعملي في القسم — ' + LABEL, scope: { mode: 'UNIT', ids: [] } });
ok(asked2.status === 200, 'ACCESS-04a', 'موظف وحدة بلا مسؤول صلاحيات يقدم طلبه', asked2.status);
await go(pf, '#accessInbox');
const item2 = pf.locator(`[data-testid=access-item][data-request="${asked2.body?.number}"]`);
await item2.waitFor({ timeout: 20000 });
await item2.scrollIntoViewIfNeeded();
await item2.screenshot({ path: OUT + '12-no-access-manager-fallback.png' });
const advice2 = await item2.getByTestId('access-advice').innerText();
ok(advice2.includes('تم التجاوز — لا يوجد مسؤول صلاحيات يغطي الوحدة') && sql(`select count(*) from request_route_skip where request_id = '${asked2.body?.id}' and reason_code = 'NO_ACCESS_MANAGER'`) === '1', 'ACCESS-04', 'تم التجاوز — لا يوجد مسؤول صلاحيات يغطي الوحدة؛ الطلب عند المعتمد النهائي مباشرة', advice2);

// ---- 8. unit-owned request and unit-owned seat through a real HR transfer (§17–20, §34, §35) -------------------------------
const sr = await as('req');
const camp = sql(`select id from site where code = 'S-0002'`);
const made = await sr.api('POST', '/restationing-requests', { requestingUnitId: unit(U.sec1b), purpose: 'INITIAL_STATIONING', content: { kind: 'PERMANENT', scope: [unit(U.sec1b)], existingSite: camp, reason: 'تمركز أولي — ' + LABEL } });
ok(made.status === 200, 'OWN-setup', 'مقدم طلبات «قسم صحة 1-ب» ينشئ طلب تمركز أولي باسم وحدته', made.status === 200 ? made.body?.number : JSON.stringify(made.body).slice(0, 300));
const rid = made.body?.id;
const sent = await sr.api('POST', `/restationing-requests/${rid}/submit`, {});
ok(sent.status === 200, 'OWN-submit', 'أُرسل الطلب', sent.status === 200 ? sent.body?.state : JSON.stringify(sent.body).slice(0, 300));
const stageOps = sql(`select id from restationing_stage where request_id = '${rid}' and permission = 'DECIDE_UNIT_OPERATIONS' order by route_no desc limit 1`);
const n1Before = (await s1b.api('GET', `/restationing-requests/${rid}`)).body;
ok(n1Before?.can?.decide === true, 'SEAT-01', 'صاحب المقعد الحالي (الموظف الأول، عمليات «إدارة الصحة» م9–10) يرى المهمة المعلقة', n1Before?.currentStage ?? n1Before?.state);
const p13a = await context(s1b.cookies);
await go(p13a, `#restationing/${rid}`);
await p13a.waitForTimeout(2500);
await shot(p13a, '13a-seat-holder-before-transfer.png');

// HR moves the holder and the requester out (the demo Oracle, then the application's own sync)
execFileSync('node', [`${ROOT}/ops/acceptance-main/acc69.mjs`, 'move', L.new1, U.moveTo], { stdio: 'inherit' });
execFileSync('node', [`${ROOT}/ops/acceptance-main/acc69.mjs`, 'move', L.req, U.moveTo], { stdio: 'inherit' });
const run = await admin.api('POST', '/hr/sync', {});
for (let i = 0; i < 180 && sql(`select count(*) from hr_sync_run where id = '${run.body?.runId}' and finished_at is not null`) === '0'; i++) await new Promise((r) => setTimeout(r, 1000));
ok(sql(`select status from hr_sync_run where id = '${run.body?.runId}'`) === 'SUCCEEDED', 'HR-SYNC', 'مزامنة الموارد البشرية نجحت ونقلت الشخصين', sql(`select coalesce(counts::text, '') from hr_sync_run where id = '${run.body?.runId}'`).slice(0, 200));
ok(sql(`select ended_reason from membership where person_id = '${new1}' and role_code = 'UNIT_OPERATIONS_APPROVER'`) === 'SEAT_UNIT_LEFT', 'SEAT-REL', 'المقعد أُخلي للوحدة عند النقل (SEAT_UNIT_LEFT) ولم يُنقل إلى الوحدة الجديدة',
  sql(`select string_agg(role_code || ':' || coalesce(ended_reason, 'active'), ' ') from membership where person_id = '${new1}'`));
const n1After = (await s1b.api('GET', `/restationing-requests/${rid}`));
ok(n1After.status >= 403 || n1After.body?.can?.decide === false, 'SEAT-02', 'صاحب المقعد السابق فقد المهمة المعلقة', n1After.status);
await grant('opsb', 'UNIT_OPERATIONS_APPROVER', U.opsUnit, { mode: 'CUSTOM', targets: [{ kind: 'ORGANIZATION', id: unit(U.health), includeDescendants: true, levels: [9, 10] }] });
const sb = await as('opsb');
const bView = (await sb.api('GET', `/restationing-requests/${rid}`)).body;
ok(bView?.can?.decide === true && sql(`select count(*) from restationing_stage where request_id = '${rid}' and permission = 'DECIDE_UNIT_OPERATIONS'`) === '1', 'SEAT-03', 'صاحب المقعد الجديد يرى الطلب نفسه والمرحلة نفسها', `stage ${stageOps}`);
const pb = await context(sb.cookies);
await go(pb, `#restationing/${rid}`);
await pb.waitForTimeout(2500);
await shot(pb, '13-unit-seat-transfer.png');
const decided = await sb.api('POST', `/restationing-requests/${rid}/decision`, { decision: 'APPROVE' });
ok(decided.status === 200, 'SEAT-03b', 'صاحب المقعد الجديد يقرر المرحلة', decided.status === 200 ? decided.body?.state : JSON.stringify(decided.body).slice(0, 200));
ok(sql(`select p.display_name from restationing_stage s join person p on p.id = s.decided_by where s.id = '${stageOps}'`) === 'معتمد عمليات قبول ب' + TAG + ' — وهمي', 'SEAT-04', 'سجل القرار يحفظ الشخص الذي قرر فعلاً');

// the request stays the requesting unit's
const reqView = (await (await as('req2')).api('GET', `/restationing-requests/${rid}`));
ok(reqView.status === 200 && reqView.body?.requestingUnit?.name === U.sec1b && reqView.body?.requester?.name === 'مقدم طلبات قبول' + TAG + ' — وهمي', 'OWN-01', 'بعد نقل مقدم الطلب: الطلب ما زال لـ«قسم صحة 1-ب»، ويراه مقدم طلبات الوحدة الآخر، ويبقى مقدمه في السجل',
  `${reqView.status} · ${reqView.body?.requestingUnit?.name} · ${reqView.body?.requester?.name} · ${reqView.body?.state}`);
const movedReq = await (await signInAs(L.req, accountPassword())).api('GET', `/restationing-requests/${rid}`);
ok(movedReq.status >= 403, 'OWN-02', 'مقدم الطلب المنقول لا يأخذ الطلب معه إلى وحدته الجديدة', movedReq.status + ' · ' + sql(`select string_agg(role_code || ':' || coalesce(ended_reason, 'active'), ' ') from membership where person_id = '${person(L.req)}'`));
ok(sql(`select requesting_unit_id from restationing_request where id = '${rid}'`) === unit(U.sec1b), 'OWN-03', 'ملكية الطلب لم تتغير في قاعدة البيانات');
const p14 = await context((await as('req2')).cookies);
await go(p14, `#restationing/${rid}`);
await p14.waitForTimeout(2500);
await shot(p14, '14-request-survives-requester-transfer.png');

// ---- restore the catalogue (ACCEPTANCE ONLY: the production catalogue is the owner's) --------------------------------------
const restored = await admin.api('PUT', '/access-requests/offer', saved);
ok(restored.status === 200, 'ADMIN-OFFER-RESTORED', '«الصلاحيات المتاحة للطلب» أُعيدت إلى ما كانت عليه قبل القبول', Object.keys(saved).join(','));
ok(!external.length, 'OFFLINE', 'لا طلب خارج localhost', external.slice(0, 3).join(' '));

await browser.close();
const passed = results.filter((r) => r.pass).length;
writeFileSync(OUT + 'results.json', JSON.stringify({ at: new Date().toISOString(), base: BASE, label: LABEL, request: number, restationing: made.body?.number, fga, passed, total: results.length, results }, null, 1));
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
