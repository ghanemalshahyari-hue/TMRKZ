// ACCEPTANCE ONLY — OWNER DECISION PENDING. TMRKZ on http://localhost:8088 configured with MOVER's identity and HR settings
// (owner, 17 Nov 2026; ADR-079): MOVER's directory (mover-ldap, Samba AD, StartTLS, self-bind user@mover.local), MOVER's Oracle
// sandbox (mover-oracle-hr, FREEPDB1; the synthetic HR_AI views — TNQL's 100 % synthetic people) and the owner's specification
// «LDAP FIRST LOGIN + ZERO ACCESS + UNIT-OWNED REQUESTS + UNIT-OWNED APPROVAL SEATS» re-run on V49 with the access screens of
// ADR-074 (one scope for every activated role, no preview screen). Every person is a synthetic HR_AI record; their directory
// accounts were added to MOVER's dev directory for this run only (owner approval, 17 Nov 2026) and are removed afterwards.
// Headless Edge, no request outside localhost. Results and screens: docs/evidence/mover-settings/.
//   node tests/acceptance/acc79-mover-settings.mjs setup|modeB|modeA|stationing|modeB2
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/');
const BASE = process.env.MOVER_URL ?? 'http://localhost:8088';
const OUT = ROOT + 'docs/evidence/mover-settings/';
const GEN = ROOT + 'ops/acceptance-main/.generated/';
const STATE = GEN + 'acc79-state.json';
mkdirSync(OUT, { recursive: true });
const { chromium } = await import(pathToFileURL(ROOT + 'tests/acceptance/node_modules/playwright-core/index.mjs').href);

const LABEL = 'ACCEPTANCE ONLY — OWNER DECISION PENDING';
const PW = readFileSync(GEN + 'mover-ldap-test-password', 'utf8').trim();
const ADMIN_PW = readFileSync(ROOT + '.env', 'utf8').match(/^TMRKZ_PLATFORM_ADMIN_PASSWORD=(.*)$/m)[1].trim();
// login in MOVER's directory = PERSON_USER_ID of a synthetic HR_AI person; HR unit ids of HR_AI
const P = {
  new1: 'darwish.atyby85', uam: 'saqer.ghfly92', mover: 'ibrahim.nqby74', req1: 'obaid.kaby98', req2: 'rashed.zaaby83',
  new2: 'saif.hmady72', srcB: 'hazza.kndy101', mismatch: 'matar.zahry80', final: 'zayed.rmythy71', fin: 'mansoor.tnyjy80',
  opsb: 'jasem.zahry89', unknown: 'tariq.hmady90',
};
const UID = { main: '100005', health: '100006', c1: '100007', c2: '100008' };
// added by number (MOVER's «إضافة مستخدم»): a synthetic person with a new and an old military number, typed by the OLD one
const BY_NUMBER = { old: '3711964', fresh: 'N10587761', account: 'ahmed.mzrway68' };

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { results: [] };
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 1));
const done = (id) => state.results.some((r) => r.id === id && r.pass);
const ok = (pass, id, what, detail = '') => {
  state.results = state.results.filter((r) => r.id !== id);
  state.results.push({ id, pass: !!pass, what, detail: String(detail).slice(0, 600), at: new Date().toISOString() });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} — ${what}${detail ? ' · ' + String(detail).slice(0, 260) : ''}`);
  save();
  return !!pass;
};
const sql = (q) => execFileSync('docker', ['exec', 'tmrkz-mover-db-1', 'psql', '-U', 'mover', '-d', 'mover', '-X', '-q', '-At', '-c', q], { encoding: 'utf8' }).trim();
const q = (s) => "'" + String(s).replaceAll("'", "''") + "'";
const org = (hrId) => sql(`select id from organization where source_external_id = ${q(hrId)} and status = 'ACTIVE'`);
const orgName = (hrId) => sql(`select name from organization where source_external_id = ${q(hrId)} and status = 'ACTIVE'`);
const person = (login) => sql(`select p.id from person p left join person_directory_profile d on d.person_id = p.id where lower(p.username) = ${q(login)} or lower(d.username) = ${q(login)} order by p.created_at limit 1`) || sql(`select p.id from person p join hr_person h on h.external_id = p.source_external_id and h.snapshot_id = (select id from hr_snapshot where status = 'PUBLISHED') where lower(h.domain_account) = ${q(login)} limit 1`);
const ldapUnit = (login, unit) => execFileSync('docker', ['exec', '-i', 'mover-ldap', 'ldbmodify', '-H', '/var/lib/samba/private/sam.ldb'], { input: `dn: CN=${login},CN=Users,DC=mover,DC=local\nchangetype: modify\nreplace: departmentNumber\ndepartmentNumber: ${unit}\n`, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });

/** The manual sign-in over HTTP (TMRKZ's own form endpoint): the platform administrator through the protected client, everyone else
 *  by a direct bind to MOVER's directory as user@mover.local — MOVER's self-bind. */
async function signIn(login, password = login === 'admin' ? ADMIN_PW : PW) {
  const r = await fetch(BASE + '/api/v1/auth/directory/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mover' }, body: JSON.stringify({ username: login, password }) });
  const cookies = r.headers.getSetCookie().map((c) => c.split(';')[0]);
  const body = await r.text();
  const cookie = cookies.join('; ');
  const api = async (method, path, b) => {
    const x = await fetch(BASE + '/api/v1' + path, { method, headers: { Cookie: cookie, 'X-Requested-With': 'mover', 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
    const t = await x.text();
    let j = null;
    try { j = t ? JSON.parse(t) : null; } catch { j = t; }
    return { status: x.status, body: j };
  };
  return { status: r.status, body, api, cookies: cookies.map((c) => ({ name: c.slice(0, c.indexOf('=')), value: c.slice(c.indexOf('=') + 1), url: BASE })) };
}

const inboxTask = async (who, requestId) => ((await (await signIn(P[who])).api('GET', '/access-requests/inbox')).body ?? []).find((i) => i.requestId === requestId)?.taskId;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const external = [];
async function context(cookies) {
  const ctx = await browser.newContext({ locale: 'ar-AE', timezoneId: 'Asia/Dubai', viewport: { width: 1440, height: 900 } });
  if (cookies) await ctx.addCookies(cookies);
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (!['localhost', '127.0.0.1'].includes(u.hostname) && !/^(data|blob):/.test(u.protocol)) { external.push(u.href); return route.abort('blockedbyclient'); }
    return route.continue();
  });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  return page;
}
const go = async (page, hash) => {
  await page.goto(BASE + '/' + hash);
  await page.reload();
  await page.waitForSelector('main#main', { timeout: 30000 });
  await page.waitForTimeout(1500);
};
const shot = (page, name, opts = {}) => page.screenshot({ path: OUT + name, ...opts });
/** The sign-in page in the browser: «إدخال رقم الـــــ U وكلمة المرور يدويا» (manual) or «الدخول الآلي برقم الــــ U» (Keycloak). */
async function browserSignIn(login, how, shotName) {
  const page = await context();
  await page.goto(BASE + '/');
  if (how === 'manual') {
    await page.getByText('إدخال رقم الـــــ U وكلمة المرور يدويا').click();
    await page.locator('#tm-username').fill(login);
    await page.locator('#tm-password').fill(PW);
    if (shotName) await shot(page, shotName);
    await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
  } else {
    await page.getByText('الدخول الآلي برقم الــــ U').click();
    await page.locator('#username').waitFor({ timeout: 30000 });
    await page.locator('#username').fill(login);
    await page.locator('#password').fill(PW);
    if (shotName) await shot(page, shotName);
    await page.locator('#kc-login').click();
  }
  await page.waitForSelector('main#main', { timeout: 60000 });
  await page.waitForTimeout(2000);
  return page;
}

const phase = process.argv[2];
const admin = await signIn('admin');
if (admin.status !== 200) throw new Error('admin sign-in ' + admin.status);
const aapi = admin.api;

// ================================================================================================================================
if (phase === 'setup') {
  // the catalogue as it is before the run, restored at the end (ACCEPTANCE: broad for the run, the owner chooses production's)
  if (!existsSync(GEN + 'acc79-offer-before.json')) {
    const before = (await aapi('GET', '/access-requests/offer')).body ?? [];
    writeFileSync(GEN + 'acc79-offer-before.json', JSON.stringify(Object.fromEntries(before.filter((r) => r.audience).map((r) => [r.code, { audience: r.audience, description: r.description, scopeModes: r.scopeModes?.length ? r.scopeModes : null, defaultScope: r.defaultScope }]))));
  }
  const offer = {
    STATIONING_REQUESTER: { audience: 'EVERYONE', description: 'تقديم طلبات إعادة التمركز ومناطق الانتشار لوحدتك.' },
    POSTURE_VIEWER: { audience: 'EVERYONE', description: 'متابعة الموقف العملياتي لوحدتك وما يتبعها على الخريطة.' },
    CHAIN_APPROVER: { audience: 'EVERYONE' },
    UNIT_OPERATIONS_APPROVER: { audience: 'EVERYONE', description: 'اعتماد عمليات الوحدة للوحدات التي يحددها المعتمد النهائي.' },
    FYI_DISTRIBUTOR: { audience: 'EVERYONE', description: 'تحديد الوحدات التي تعلم بالطلب بعد الاعتماد النهائي.' },
    FYI_RECEIVER: { audience: 'EVERYONE' },
  };
  const put = await aapi('PUT', '/access-requests/offer', offer);
  ok(put.status === 200, 'SETUP-OFFER', 'مدير النظام يحدد «الصلاحيات المعروضة للطلب» من الشاشة/الواجهة بلا تغيير شيفرة (قبول: عرض واسع)', put.status === 200 ? Object.keys(offer).join(',') : JSON.stringify(put.body));

  // the access request type and its path, as on every installation (owner-review-setup)
  const list = async () => (await aapi('GET', '/workflows')).body;
  let access = (await list()).find((w) => w.requestType.kind === 'ACCESS');
  if (!access) {
    const made = await aapi('POST', '/request-types', { name: 'طلب صلاحيات', kind: 'ACCESS' });
    if (made.status !== 200) throw new Error('type: ' + JSON.stringify(made.body).slice(0, 400));
    access = (await list()).find((w) => w.requestType.kind === 'ACCESS');
  }
  if (!access.published) {
    const step = (id, name, role, y) => ({ id, type: 'approval', name, x: 300, y, mode: 'ANY', slaDays: 3, assignees: [{ role, orgFrom: 'BY_SCOPE' }], final: id === 'fin', requiresSignature: false });
    const graph = {
      nodes: [{ id: 'st', type: 'start', name: 'بداية الطلب', x: 300, y: 0 }, step('rev', 'مراجعة مدير صلاحيات الوحدة', 'UNIT_ACCESS_MANAGER', 150), step('fin', 'اعتماد طلبات الصلاحية', 'ACCESS_FINAL_APPROVER', 320), { id: 'ok', type: 'end_approved', name: 'معتمد', x: 300, y: 480 }],
      edges: [{ from: 'st', to: 'rev' }, { from: 'rev', to: 'fin', when: 'approved' }, { from: 'fin', to: 'ok', when: 'approved' }],
    };
    const draft = await aapi('POST', `/workflows/${access.id}/drafts`, { definition: { name: 'طلب صلاحيات', stages: [], execution: [], graph } });
    if (draft.status !== 200) throw new Error('draft: ' + JSON.stringify(draft.body).slice(0, 400));
    const live = await aapi('POST', `/workflow-versions/${draft.body.id}/publish`, {});
    ok(live.status === 200, 'SETUP-ACCESS-PATH', 'مسار «طلب صلاحيات»: مدير صلاحيات الوحدة ثم معتمد طلبات الصلاحية', live.status);
  }

  // a fictional stationing policy (ACCEPTANCE / FICTIONAL), routing on HR_AI's levels: centre L8, department L7, main body L6
  const inForce = (await aapi('GET', '/stationing/policy')).body?.inForce;
  if (!inForce?.values?.approvalStages) {
    const values = {
      maxFootprintAreaM2: 200000, deploymentRequirement: 'REQUIRED',
      primary: { minM: 5000, maxM: 8000, terrainApplies: false }, alternative: { minM: 3000, maxM: 5000, terrainApplies: false },
      terrainSlopeClassification: { datasetCode: 'copernicus-glo30', datasetVersion: '2026.11', classes: [
        { code: 'FLAT', label: 'مستوٍ / شبه مستوٍ', fromPct: 0, toPct: 2 }, { code: 'UNDULATING', label: 'متموّج', fromPct: 2, toPct: 10 },
        { code: 'ROLLING', label: 'تضاريس متدرجة', fromPct: 10, toPct: 15 }, { code: 'HILLY', label: 'تلال', fromPct: 15, toPct: 30 },
        { code: 'MOUNTAINOUS', label: 'جبلي / شديد التضرس', fromPct: 30, toPct: null }] },
      terrainAllowancesM: { FLAT: 0, UNDULATING: 500, ROLLING: 1000, HILLY: 1500, MOUNTAINOUS: 2000 },
      terrainClassPriority: ['MOUNTAINOUS', 'HILLY', 'ROLLING', 'UNDULATING', 'FLAT'], terrainAppliesTo: 'MAX_ONLY',
      exception: { allowed: false, maxExtraM: 0 }, crossBranch: { allowed: true, authorities: ['OTHER_UNIT', 'SITE_RESPONSIBLE'], independent: false },
      routing: { startAt: 'SELF', levels: [
        { level: 8, approves: true, label: 'اعتماد المركز', finalStage: false, dependsOn: ['SCOPE', 'SITE', 'DEPLOYMENT'] },
        { level: 7, approves: true, label: 'اعتماد الإدارة', finalStage: true, dependsOn: [] }] },
      deploymentAreaDefault: { shape: 'SQUARE', areaM2: 90000 },
      approvalStages: { unitOperations: true, finalByPermission: true, fyiBeforeActivation: true },
    };
    const r = await aapi('POST', '/stationing/policy/versions', { values, reason: 'سياسة قبول وهمية — اختبار قبول — ليست قيم الإنتاج', reference: 'ACCEPTANCE / FICTIONAL · ADR-079' });
    ok(r.status === 200, 'SETUP-POLICY', 'سياسة تمركز قبول وهمية (ACCEPTANCE / FICTIONAL) على مستويات HR_AI', r.status === 200 ? 'version ' + (r.body?.version?.version ?? '') : JSON.stringify(r.body).slice(0, 400));
  }

  // a fictional site where «مركز صحة واحد» is stationed (ACCEPTANCE / FICTIONAL), the way ops/acceptance-main/seed.sql records it
  const c1 = org(UID.c1);
  if (sql(`select count(*) from org_stationing where organization_id = '${c1}' and valid_to is null`) === '0') {
    sql(`insert into site(id, code, name, kind, lat, lng, created_at, notes)
         values (md5('acc79:site')::uuid, 'ACC79-SITE-01', 'موقع قبول — وهمي', 'موقع', 24.8603, 56.0603, now(), 'ACCEPTANCE / FICTIONAL · ADR-079') on conflict do nothing`);
    sql(`insert into site_geometry_version(id, site_id, version, geojson, crs, source, valid_from, geom, geometry_type, reason)
         select md5('acc79:geo')::uuid, md5('acc79:site')::uuid, 1, ST_AsGeoJSON(g)::jsonb, 'EPSG:4326', 'ACCEPTANCE / FICTIONAL', now(), g, 'Polygon', 'اختبار قبول — وهمي'
           from (select ST_MakeEnvelope(56.0590, 24.8590, 56.0616, 24.8616, 4326) g) x on conflict do nothing`);
    sql(`update site set geometry_version = 1 where id = md5('acc79:site')::uuid`);
    sql(`insert into site_responsibility(id, site_id, organization_id, valid_from) values (md5('acc79:resp')::uuid, md5('acc79:site')::uuid, '${c1}', now() - interval '30 days')`);
    sql(`insert into org_stationing(id, organization_id, site_id, kind, valid_from, origin, reason, recorded_by)
         values (md5('acc79:st')::uuid, '${c1}', md5('acc79:site')::uuid, 'PERMANENT', now() - interval '30 days', 'CORRECTION', 'اختبار قبول — وهمي', (select id from person where username = 'admin'))`);
  }
  ok(sql(`select count(*) from org_stationing where organization_id = '${c1}' and valid_to is null`) === '1', 'SETUP-SITE', '«مركز صحة واحد» متمركز في موقع قبول وهمي');
}

// ================================================================================================================================
if (phase === 'modeB') {
  // MOVER's configured state: Oracle in force. First the administrator adds a person by number, as MOVER's «إضافة مستخدم».
  const c2 = org(UID.c2);
  if (!done('MOVER-ADD-2')) {
  const look = await aapi('GET', `/access/unit-members/lookup?organizationId=${c2}&key=${encodeURIComponent(BY_NUMBER.old)}`);
  ok(look.status === 200 && look.body?.importOnSave === true && !look.body?.personId, 'MOVER-ADD-1', 'البحث بالرقم العسكري القديم يجلب الموظف من Oracle مباشرة ولا يحفظ شيئاً (كما MOVER)', `${look.status} · ${look.body?.displayName ?? JSON.stringify(look.body).slice(0, 200)} · ${look.body?.unitName ?? ''}`);
  const pa = await context(admin.cookies);
  await go(pa, '#permissions');
  await shot(pa, 'B0-access-workspace.png');
  const add = await aapi('POST', '/access/unit-members', { organizationId: c2, employeeNo: BY_NUMBER.old });
  const added = sql(`select p.id from person p join hr_person h on h.external_id = p.source_external_id and h.snapshot_id = (select id from hr_snapshot where status = 'PUBLISHED') where lower(h.domain_account) = ${q(BY_NUMBER.account)}`);
  ok(add.status === 200 && !!added && sql(`select count(*) from membership where person_id = '${added}'`) === '0', 'MOVER-ADD-2', '«حفظ»: يُستورد سجله وحده من الموارد البشرية، بلا أي صلاحية، في الوحدة المختارة', `${add.status} · employee_no=${sql(`select employee_no from person where id = '${added}'`)} · grants=0 · unit entry=${sql(`select count(*) from unit_member where person_id = '${added}' and ended_at is null`)}`);
  }

  // SOURCE-02: a directory person TMRKZ has never seen signs in with Oracle in force → their one HR record, zero access
  if (!person(P.srcB)) {
    const pB = await browserSignIn(P.srcB, 'manual', 'B1-manual-sign-in-form.png');
    await pB.getByTestId('access-identity').waitFor({ timeout: 30000 });
    await shot(pB, 'B2-first-sign-in-oracle-identity.png', { fullPage: true });
  }
  const srcB = person(P.srcB);
  const idB = (await (await signIn(P.srcB)).api('GET', '/access-requests/mine')).body?.identity ?? {};
  const card = `${idB.name} · ${idB.employeeNo} · ${idB.rank} · ${idB.position} · ${idB.unit} · ${idB.source}`;
  const viaSignIn = sql(`select count(*) from audit_event where action = 'HR_PERSON_IMPORTED' and entity_id = '${srcB}' and detail->>'via' = 'SIGN_IN'`);
  ok(!!srcB && sql(`select source from person where id = '${srcB}'`) === 'HR' && sql(`select count(*) from membership where person_id = '${srcB}'`) === '0'
    && idB.sourceCode === 'ORACLE' && idB.unit === orgName(UID.c2) && viaSignIn !== '0', 'SOURCE-02', 'Oracle في الخدمة: أول دخول من الدليل يستورد سجل الموارد البشرية الواحد بلا صلاحية، والوحدة والرتبة من Oracle', card.slice(0, 260) + ' · imported at sign-in=' + viaSignIn);
  // the automatic button: the same person through Keycloak, which federates MOVER's directory
  const pK = await browserSignIn(P.srcB, 'automatic', 'B3-automatic-keycloak-form.png');
  ok((await pK.locator('[data-testid=access-identity]').count()) === 1 && person(P.srcB) === srcB, 'LOGIN-AUTO', '«الدخول الآلي برقم الــــ U»: Keycloak يتحقق من كلمة المرور في دليل MOVER، والشخص نفسه', srcB);

  // SOURCE-04: the directory says «مركز صحة واحد», Oracle says «مركز صحة اثنين» → Oracle places the person, the difference is logged
  ldapUnit(P.mismatch, UID.c1);
  const sm = await signIn(P.mismatch);
  const mm = person(P.mismatch);
  const mine = (await sm.api('GET', '/access-requests/mine')).body;
  ok(sm.status === 200 && mine?.identity?.unit === orgName(UID.c2) && sql(`select count(*) from audit_event where action = 'IDENTITY_ORG_SOURCE_MISMATCH' and entity_id = '${mm}'`) !== '0', 'SOURCE-04', 'الدليل وOracle مختلفان: Oracle يحدد الوحدة، ويُسجل IDENTITY_ORG_SOURCE_MISMATCH، والدخول لا يُمنع', `${sm.status} · ${mine?.identity?.unit} · audits=${sql(`select count(*) from audit_event where action = 'IDENTITY_ORG_SOURCE_MISMATCH' and entity_id = '${mm}'`)}`);
}

// ================================================================================================================================
if (phase === 'modeA') {
  // Oracle switched off in «مصدر الموارد البشرية»: the units stay (published snapshot), the directory places people (Mode A)
  const src = (await aapi('GET', '/hr/source')).body;
  if (src?.enabled) {
    const o = Object.fromEntries(readFileSync(ROOT + 'ops/local/.generated/mover-oracle-hr.env', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const off = await aapi('PUT', '/hr/source', { ...src, enabled: false, hostOrUrl: src.hostOrUrl ?? o.HOST, password: o.PASSWORD });
    ok(off.status === 200, 'MODE-A', 'إيقاف مصدر Oracle: TMRKZ يعمل من الدليل (الوضع أ) والوحدات باقية', off.status === 200 ? '' : JSON.stringify(off.body).slice(0, 300));
  }

  // ---- AUTH-01 … AUTH-04, SOURCE-01: the first directory sign-in, in the browser -------------------------------------------
  const firstTime = !person(P.new1);
  const p1 = firstTime ? await browserSignIn(P.new1, 'manual', '01-first-ldap-login.png') : await context((await signIn(P.new1)).cookies);
  if (!firstTime) await go(p1, '#requestAccess');
  await p1.getByTestId('access-identity').waitFor({ timeout: 30000 });
  const new1 = person(P.new1);
  ok(!!new1 && sql(`select count(*) from identity_link where person_id = '${new1}'`) !== '0', 'AUTH-01', 'دخول أول من الدليل دون إضافة يدوية: أُنشئ الشخص وربط حسابه', sql(`select source || ' · ' || coalesce(username, '-') || ' · ' || (select string_agg(method, ',') from identity_link where person_id = p.id) from person p where id = '${new1}'`));
  if (firstTime) {
  ok(sql(`select count(*) from membership where person_id = '${new1}'`) === '0', 'AUTH-04', 'العضوية في الوحدة لا تمنح شيئاً: صفر صلاحيات', 'membership 0');
  await shot(p1, '02-zero-access-page.png', { fullPage: true });
  await p1.getByTestId('access-identity').screenshot({ path: OUT + '03-identity-card.png' });
  const card1 = (await p1.getByTestId('access-identity').innerText()).replace(/\s+/g, ' ');
  ok((await p1.getByTestId('access-identity').getAttribute('data-source')) === 'LDAP' && card1.includes(orgName(UID.c1)), 'SOURCE-01', 'قبل Oracle: الوحدة من الدليل بمعرّف الوحدة (departmentNumber = معرف Oracle)، لا بالاسم', card1.slice(0, 260));
  const nav = (await p1.locator('.tz-top').innerText()).replace(/\s+/g, ' ');
  const hidden = ['الرئيسية', 'المواقع', 'الخريطة', 'التقارير', 'الموقف', 'مسار', 'الإعدادات', 'الصلاحيات والوحدات'];
  ok(nav.includes('طلب صلاحية') && hidden.every((h) => !nav.includes(h)), 'AUTH-03a', 'الشريط العلوي: «طلب صلاحية» والدعم والخروج فقط', nav.slice(0, 200));
  await go(p1, '#sites');
  ok((await p1.locator('.tz-app').getAttribute('data-view')) === 'requestAccess', 'AUTH-03b', 'فتح #sites يدوياً يعيده إلى صفحة طلب الصلاحية');
  const s1 = await signIn(P.new1);
  const refused = [];
  for (const path of ['/restationing-requests', '/sites', '/organizations/roots', '/request-hub', '/stationing/current', '/access/grants', '/requests']) {
    const r = await s1.api('GET', path);
    if (!(r.status === 403 && r.body?.code === 'NO_EFFECTIVE_ACCESS')) refused.push(`${path}=${r.status}`);
  }
  ok(!refused.length, 'AUTH-03c', 'الخادم يرفض واجهات التطبيق لمن لا صلاحية له (NO_EFFECTIVE_ACCESS)', refused.join(' ') || '7 of 7 refused');
  }

  // AUTH-02: a directory Unit ID TMRKZ does not hold
  const before = sql('select count(*) from organization');
  const pu = await browserSignIn(P.unknown, 'manual');
  await pu.getByTestId('access-identity').waitFor({ timeout: 30000 });
  const nc = await pu.getByTestId('access-unit-not-configured').count() ? await pu.getByTestId('access-unit-not-configured').innerText() : '';
  await shot(pu, '03b-unit-not-configured.png', { fullPage: true });
  ok(nc.includes('تم التحقق من هويتك') && sql('select count(*) from organization') === before && sql(`select count(*) from organization where source_external_id = '999999'`) === '0', 'AUTH-02', 'معرّف وحدة غير موجود في TMRKZ: لا تُنشأ وحدة، والرسالة «تم التحقق من هويتك، لكن وحدتك التنظيمية غير مهيأة في النظام»', nc);

  // the other synthetic people sign in once (each with nothing), then the administrator gives the seats of the run
  for (const who of ['uam', 'final', 'new2', 'req1', 'req2', 'opsb', 'fin', 'mover']) {
    const s = await signIn(P[who]);
    ok(s.status === 200, 'SIGNIN-' + who, `${P[who]}: دخول يدوي من الدليل (الوضع أ)`, s.status);
  }
  const grant = async (who, role, unitHr, scope) => {
    if (sql(`select count(*) from membership where person_id = '${person(P[who])}' and role_code = '${role}' and (valid_to is null or valid_to > now())`) !== '0') return;
    const r = await aapi('POST', '/memberships', { personId: person(P[who]), organizationId: org(unitHr), roleCode: role, scope });
    ok(r.status === 200, 'GRANT-' + who + '-' + role, `${P[who]}: ${role}`, r.status === 200 ? r.body?.scopeText : JSON.stringify(r.body).slice(0, 300));
  };
  await grant('uam', 'UNIT_ACCESS_MANAGER', UID.c1, { mode: 'CUSTOM', targets: [{ kind: 'ORGANIZATION', id: org(UID.c1), includeDescendants: true }] });
  await grant('final', 'ACCESS_FINAL_APPROVER', UID.main, null);
  await grant('req1', 'STATIONING_REQUESTER', UID.c1, { mode: 'CUSTOM', targets: [{ kind: 'ORGANIZATION', id: org(UID.c1), includeDescendants: false }] });
  await grant('req2', 'STATIONING_REQUESTER', UID.c1, { mode: 'CUSTOM', targets: [{ kind: 'ORGANIZATION', id: org(UID.c1), includeDescendants: false }] });
  await grant('fin', 'FINAL_APPROVER', UID.main, { mode: 'CUSTOM', targets: [{ kind: 'ORGANIZATION', id: org(UID.main), includeDescendants: true }] });

  // the catalogue the administrator set (setup phase), in the browser
  const pa = await context(admin.cookies);
  await go(pa, '#permissions/policy');
  const offerBtn = pa.getByTestId('access-offer');
  if (await offerBtn.count()) {
    await offerBtn.click();
    await pa.waitForTimeout(1200);
  }
  await shot(pa, '04-permission-catalogue.png');
  await pa.keyboard.press('Escape');

  // ---- ACCESS-01: five roles of different kinds in one request -----------------------------------------------------------------
  const ASKED = ['STATIONING_REQUESTER', 'POSTURE_VIEWER', 'CHAIN_APPROVER', 'UNIT_OPERATIONS_APPROVER', 'FYI_DISTRIBUTOR'];
  if (!state.accessRequest) {
  await go(p1, '#requestAccess');
  for (const r of ASKED) await p1.locator(`input[data-role=${r}]`).check();
  await p1.getByLabel('سبب الطلب').fill('أحتاج هذه الصلاحيات لعملي في المركز — ' + LABEL);
  await p1.getByRole('button', { name: 'إرسال طلب الصلاحية' }).click();
  await p1.getByTestId('access-open').waitFor({ timeout: 20000 });
  await p1.waitForTimeout(1200);
  await shot(p1, '05-submitted-access-request.png', { fullPage: true });
  const reqId0 = sql(`select request_id from access_request where person_id = '${new1}' and open`);
  state.accessRequest = { reqId: reqId0, number: sql(`select number from request where id = '${reqId0}'`) };
  save();
  }
  const { reqId, number } = state.accessRequest;
  ok(sql(`select array_to_string(requested, ',') from access_request where request_id = '${reqId}'`) === ASKED.join(','), 'ACCESS-01', `${number}: خمس صلاحيات من أنواع مختلفة في طلب واحد`, ASKED.join(','));
  if (!done('STATUS-1')) ok((await p1.getByTestId('access-overall').innerText()).includes('مسؤول الصلاحيات'), 'STATUS-1', 'سطر الحالة: «طلبك بانتظار مراجعة مسؤول الصلاحيات»', await p1.getByTestId('access-overall').innerText());

  // ---- ACCESS-02: the unit's access manager recommends three, nothing becomes active --------------------------------------------
  const pm = await context((await signIn(P.uam)).cookies);
  if (!done('ACCESS-02')) {
  await go(pm, '#accessInbox');
  const itemM = pm.locator('[data-testid=access-item]').filter({ hasText: number });
  await itemM.waitFor({ timeout: 20000 });
  for (const r of ['CHAIN_APPROVER', 'FYI_DISTRIBUTOR']) await itemM.locator(`input[data-role=${r}]`).uncheck();
  ok(await itemM.getByRole('button', { name: 'إرسال التوصية' }).count() === 1 && await itemM.getByRole('button', { name: 'اعتماد وتفعيل' }).count() === 0, 'ACCESS-02a', 'مسؤول صلاحيات الوحدة يرى «إرسال التوصية» ولا يرى «اعتماد وتفعيل»');
  await itemM.scrollIntoViewIfNeeded();
  await shot(pm, '06-access-manager-recommendation.png', { fullPage: true });
  await itemM.getByRole('button', { name: 'إرسال التوصية' }).click();
  await pm.waitForTimeout(2000);
  ok(sql(`select array_to_string(recommended, ',') from access_request where request_id = '${reqId}'`) === 'STATIONING_REQUESTER,POSTURE_VIEWER,UNIT_OPERATIONS_APPROVER'
    && sql(`select count(*) from membership where person_id = '${new1}'`) === '0', 'ACCESS-02', 'المطلوب 5 والموصى به 3، ولا شيء فعّال بعد');
  await go(p1, '#requestAccess');
  ok((await p1.getByTestId('access-overall').innerText()).includes('بانتظار الاعتماد النهائي'), 'STATUS-2', 'سطر الحالة: «بانتظار الاعتماد النهائي»');
  }

  // ---- ACCESS-03: the final access approver grants a different subset, one scope for all (the screen of ADR-074) ----------------
  const pf = await context((await signIn(P.final)).cookies);
  if (!done('ACCESS-03')) {
  await go(pf, '#accessInbox');
  const itemF = pf.locator('[data-testid=access-item]').filter({ hasText: number });
  await itemF.waitFor({ timeout: 20000 });
  await itemF.locator('input[data-role=POSTURE_VIEWER]').uncheck();
  await itemF.locator('input[data-scope=UNIT_TREE]').check();
  await itemF.scrollIntoViewIfNeeded();
  await pf.waitForTimeout(600);
  await shot(pf, '07-final-approver-editing.png', { fullPage: true });
  // ACCESS-06 on the server (the screen has no preview since ADR-074): what /preview says equals what the approval writes
  const task = await inboxTask('final', reqId);
  // «وحدتي والوحدات التابعة» for both roles, written in the grant model: the person's unit with its descendants
  const grants = ['STATIONING_REQUESTER', 'UNIT_OPERATIONS_APPROVER'].map((role) => ({ role, scope: { mode: 'CUSTOM', targets: [{ kind: 'ORGANIZATION', id: org(UID.c1), includeDescendants: true }] } }));
  const prev = await (await signIn(P.final)).api('POST', `/access-requests/${reqId}/preview`, { taskId: task, grants });
  state.preview = prev.body;
  await itemF.getByRole('button', { name: 'اعتماد وتفعيل' }).click();
  await pf.waitForTimeout(2500);
  await shot(pf, '10-activated-access.png', { fullPage: true });
  const granted = sql(`select string_agg(m.role_code, ',' order by m.role_code) from membership m where m.person_id = '${new1}' and (m.valid_to is null or m.valid_to > now())`);
  ok(granted === 'STATIONING_REQUESTER,UNIT_OPERATIONS_APPROVER', 'ACCESS-03', 'المعتمد النهائي منح مجموعة مختلفة (2 من 3 موصى بها)', granted);
  ok(sql(`select array_to_string(requested, ',') || ' / ' || array_to_string(recommended, ',') || ' / ' || array_to_string(granted, ',') from access_request where request_id = '${reqId}'`)
    === `${ASKED.join(',')} / STATIONING_REQUESTER,POSTURE_VIEWER,UNIT_OPERATIONS_APPROVER / STATIONING_REQUESTER,UNIT_OPERATIONS_APPROVER`, 'ACCESS-SETS', 'المطلوب والموصى به والممنوح ثلاث مجموعات منفصلة');
  const listed = (await aapi('GET', `/access/grants?personId=${new1}`)).body ?? [];
  const texts = listed.filter((g) => !g.validTo || new Date(g.validTo) > new Date()).map((g) => `${g.role?.code}: ${g.scopeText}`).sort().join(' | ');
  const pv = (prev.body?.lines ?? []).map((r) => `${r.role}: ${r.scopeText}`).sort().join(' | ');
  ok(prev.status === 200 && pv === texts, 'ACCESS-06', 'معاينة الخادم (/preview) تطابق المنح المكتوبة حرفاً بحرف — الشاشة بلا معاينة منذ ADR-074', `${prev.status} preview=[${pv}] written=[${texts}]`);
  }

  // ---- ACCESS-05: unit operations by levels — the same «تعيين» dialog of the access workspace (the screen of ADR-074 has no levels)
  const opsGrant = sql(`select id from membership where person_id = '${new1}' and role_code = 'UNIT_OPERATIONS_APPROVER' and (valid_to is null or valid_to > now())`);
  // the dialog «تعيين» replaces the grant (POST /access/grants/{id}/replace): its home stays the person's unit, its anchor and levels change
  const lv = done('ACCESS-05') ? { status: 200 } : await aapi('POST', `/access/grants/${opsGrant}/replace`, { grant: { personId: new1, organizationId: org(UID.c1), roleCode: 'UNIT_OPERATIONS_APPROVER', scope: { mode: 'CUSTOM', targets: [{ kind: 'ORGANIZATION', id: org(UID.health), includeDescendants: true, levels: [8] }] } }, reason: 'المستوى 8 تحت «إدارة الصحة» — مثال المالك (المستويان 9 و10) على أعماق HR_AI' });
  const lvText = (await aapi('GET', `/access/grants?personId=${new1}`)).body?.find((g) => g.role?.code === 'UNIT_OPERATIONS_APPROVER')?.scopeText;
  ok(lv.status === 200, 'ACCESS-05', 'معتمد عمليات الوحدة: المرتكز «إدارة الصحة» والمستوى 8 (أعمق مستوى تحتها في HR_AI)', lv.status === 200 ? lvText : JSON.stringify(lv.body).slice(0, 300));
  const fga = [];
  for (const [hr, expect] of [[UID.c1, true], [UID.c2, true], [UID.health, false], ['100013', false]]) {
    const ex = (await aapi('GET', `/access/explain?personId=${new1}&organizationId=${org(hr)}`)).body;
    const a = (ex?.actions ?? []).find((x) => x.action === 'DECIDE_UNIT_OPERATIONS');
    fga.push(`${orgName(hr)}: published=${a?.published?.allowed} openfga=${a?.openfga}`);
    ok(a?.published?.allowed === expect && a?.openfga === expect, 'FGA-' + hr, `اعتماد عمليات الوحدة في «${orgName(hr)}»: ${expect ? 'مسموح' : 'مرفوض'} في القرار المنشور وفي OpenFGA`, `published=${a?.published?.allowed} openfga=${a?.openfga}`);
  }
  state.fga = fga;

  // ---- §32: after the grant, only what the grants allow ------------------------------------------------------------------------
  const p1b = await context((await signIn(P.new1)).cookies);
  await go(p1b, '#home');
  const nav2 = (await p1b.locator('.tz-top').innerText()).replace(/\s+/g, ' ');
  await shot(p1b, '11-permitted-navigation.png');
  // «تهيئة المواقع» is expected since ADR-078: «معتمد عمليات الوحدة» also manages facilities and site links within its grant
  const notThere = ['الصلاحيات والوحدات', 'الإعدادات', 'مركز الصلاحيات', 'سجل التدقيق', 'طلبات الصلاحية'].filter((x) => nav2.includes(x));
  const s1b = await signIn(P.new1);
  const after = { hub: (await s1b.api('GET', '/request-hub')).status, grants: (await s1b.api('GET', '/access/grants')).status, setup: (await s1b.api('POST', '/site-setup/check', {})).status };
  ok(!notThere.length && after.hub === 200 && after.grants === 403, 'NAV-AFTER', 'بعد التفعيل: يرى ما تسمح به منحتاه فقط، والواجهات تتبع المنح', nav2.slice(0, 220) + ' · ' + JSON.stringify(after));

  // ---- ACCESS-04: a unit no access manager covers --------------------------------------------------------------------------------
  if (!done('ACCESS-04')) {
  const s2 = await signIn(P.new2);
  const asked2 = await s2.api('POST', '/access-requests', { roles: ['STATIONING_REQUESTER'], reason: 'أحتاجها لعملي في المركز — ' + LABEL, scope: { mode: 'UNIT', ids: [] } });
  ok(asked2.status === 200, 'ACCESS-04a', 'موظف «مركز صحة اثنين» (لا مسؤول صلاحيات يغطيه) يقدم طلبه', asked2.status);
  await go(pf, '#accessInbox');
  const item2 = pf.locator('[data-testid=access-item]').filter({ hasText: asked2.body?.number ?? '-' });
  await item2.waitFor({ timeout: 20000 });
  await item2.scrollIntoViewIfNeeded();
  await item2.screenshot({ path: OUT + '12-no-access-manager-fallback.png' });
  const advice2 = await item2.getByTestId('access-advice').innerText();
  ok(advice2.includes('تم التجاوز') && sql(`select count(*) from request_route_skip where request_id = '${asked2.body?.id}' and reason_code = 'NO_ACCESS_MANAGER'`) === '1', 'ACCESS-04', 'تم التجاوز — لا يوجد مسؤول صلاحيات يغطي الوحدة؛ الطلب عند المعتمد النهائي مباشرة', advice2);
  }

  // ---- ACCESS-07: the person moves (directory Unit ID) after the recommendation and before the final approval -----------------
  if (!done('ACCESS-07')) {
  const sMv = await signIn(P.mover);
  const askedMv = await sMv.api('POST', '/access-requests', { roles: ['STATIONING_REQUESTER'], reason: 'طلب قبل النقل — ' + LABEL, scope: { mode: 'UNIT', ids: [] } });
  const mvId = askedMv.body?.id;
  const tM = await inboxTask('uam', mvId);
  const rec = await (await signIn(P.uam)).api('POST', `/access-requests/${mvId}/decision`, { taskId: tM, decision: 'APPROVE', roles: ['STATIONING_REQUESTER'], scope: { mode: 'UNIT', ids: [] } });
  ldapUnit(P.mover, UID.c2);
  await signIn(P.mover); // the directory's new Unit ID is read at this sign-in (Mode A)
  const tF = await inboxTask('final', mvId);
  const fin1 = await (await signIn(P.final)).api('POST', `/access-requests/${mvId}/decision`, { taskId: tF, decision: 'APPROVE', roles: ['STATIONING_REQUESTER'], scope: { mode: 'UNIT', ids: [] } });
  const mvP = person(P.mover);
  const grantedOld = sql(`select count(*) from membership where person_id = '${mvP}' and organization_id = '${org(UID.c1)}'`);
  ok(rec.status === 200 && grantedOld === '0' && sql(`select count(*) from audit_event where action = 'ACCESS_REQUEST_UNIT_CHANGED' and entity_id = '${mvId}'`) !== '0', 'ACCESS-07', 'نُقل قبل الاعتماد النهائي: لا يُمنح نطاق الوحدة السابقة، والطلب نفسه يُعاد إلى الوحدة الحالية، «الوحدة تغيرت أثناء طلب الصلاحية»',
    `recommend=${rec.status} final=${fin1.status} ${JSON.stringify(fin1.body).slice(0, 160)} · old-unit grants=${grantedOld} · audit=${sql(`select count(*) from audit_event where action = 'ACCESS_REQUEST_UNIT_CHANGED' and entity_id = '${mvId}'`)} · state=${sql(`select status from request where id = '${mvId}'`)}`);
  }
  save();
}

// ================================================================================================================================
if (phase === 'zero') {
  // zero access measured on a person who still holds nothing (an open access request, no grant): the bar, a typed URL, the APIs
  const who = process.argv[3] ?? 'new2';
  const id = person(P[who]);
  const s = await signIn(P[who]);
  const page = await context(s.cookies);
  await go(page, '#requestAccess');
  const held = sql(`select count(*) from membership where person_id = '${id}' and (valid_to is null or valid_to > now())`);
  ok(held === '0', 'AUTH-04', 'العضوية في الوحدة لا تمنح شيئاً: صفر صلاحيات', `${P[who]} · membership ${held} · unit ${sql(`select o.name from unit_member m join organization o on o.id = m.organization_id where m.person_id = '${id}' and m.ended_at is null limit 1`) || '-'}`);
  const nav = (await page.locator('.tz-top').innerText()).replace(/\s+/g, ' ');
  const hidden = ['الرئيسية', 'المواقع', 'الخريطة', 'التقارير', 'الموقف', 'مسار', 'الإعدادات', 'الصلاحيات والوحدات'];
  ok(nav.includes('طلب صلاحية') && hidden.every((h) => !nav.includes(h)), 'AUTH-03a', 'الشريط العلوي: «طلب صلاحية» والدعم والخروج فقط', `${P[who]} · ${nav.slice(0, 160)}`);
  await go(page, '#sites');
  ok((await page.locator('.tz-app').getAttribute('data-view')) === 'requestAccess', 'AUTH-03b', 'فتح #sites يدوياً يعيده إلى صفحة طلب الصلاحية', P[who]);
  const refused = [];
  for (const path of ['/restationing-requests', '/sites', '/organizations/roots', '/request-hub', '/stationing/current', '/access/grants', '/requests']) {
    const r = await s.api('GET', path);
    if (!(r.status === 403 && r.body?.code === 'NO_EFFECTIVE_ACCESS')) refused.push(`${path}=${r.status}`);
  }
  ok(!refused.length, 'AUTH-03c', 'الخادم يرفض واجهات التطبيق لمن لا صلاحية له (NO_EFFECTIVE_ACCESS)', `${P[who]} · ` + (refused.join(' ') || '7 of 7 refused'));
}

// ================================================================================================================================
if (phase === 'shots0') {
  // the zero-access page and identity card of someone who holds nothing and never asked (signed in first in Oracle mode)
  const who = process.argv[3] ?? 'srcB';
  const s = await signIn(P[who]);
  const page = await context(s.cookies);
  await go(page, '#requestAccess');
  await page.getByTestId('access-identity').waitFor({ timeout: 30000 });
  await shot(page, '02-zero-access-page.png', { fullPage: true });
  await page.getByTestId('access-identity').screenshot({ path: OUT + '03-identity-card.png' });
  const txt = (await page.getByTestId('access-identity').innerText()).replace(/\s+/g, ' ');
  ok(sql(`select count(*) from membership where person_id = '${person(P[who])}'`) === '0' && txt.includes('لم تقدم طلب صلاحية'), 'SHOT-ZERO', 'صفحة من لا صلاحية له وبطاقة هويته (لم يقدم طلباً بعد)', `${P[who]} · ${txt.slice(0, 200)}`);
}

// ================================================================================================================================
if (phase === 'stationing') {
  const new1 = person(P.new1);
  const c1 = org(UID.c1);
  const sr = await signIn(P.req1);
  const lat0 = 24.8603, lng0 = 56.0603;
  const offLng = (m) => m / (111320 * Math.cos((lat0 * Math.PI) / 180));
  const sq = (lat, lng, h) => ({ type: 'Polygon', coordinates: [[[lng - h, lat - h], [lng + h, lat - h], [lng + h, lat + h], [lng - h, lat + h], [lng - h, lat - h]]] });
  const content = { kind: 'PERMANENT', scope: [c1], primary: sq(lat0, lng0 + offLng(6000), 0.0012), alternative: sq(lat0 + 4000 / 110900, lng0 + offLng(6000), 0.0012), reason: 'مناطق انتشار — ' + LABEL };
  let rid = state.restationing?.id;
  if (!rid) {
    const made = await sr.api('POST', '/restationing-requests', { requestingUnitId: c1, purpose: 'DEPLOYMENT_AREAS', content });
    ok(made.status === 200, 'OWN-setup', 'مقدم طلبات «مركز صحة واحد» ينشئ طلب مناطق انتشار باسم وحدته', made.status === 200 ? made.body?.number : JSON.stringify(made.body).slice(0, 400));
    rid = made.body?.id;
    const sent = await sr.api('POST', `/restationing-requests/${rid}/submit`, {});
    ok(sent.status === 200, 'OWN-submit', 'أُرسل الطلب ومسار الاعتماد محسوب', sent.status === 200 ? JSON.stringify((sent.body?.route ?? []).map((r) => r.key ?? r.label)).slice(0, 300) : JSON.stringify(sent.body).slice(0, 400));
    state.restationing = { id: rid, number: made.body?.number };
    save();
  }
  const skips = sql(`select string_agg(coalesce(reason_code, '') , ',') from request_route_skip where request_id = '${rid}'`);
  const s1 = await signIn(P.new1);
  const before = (await s1.api('GET', `/restationing-requests/${rid}`)).body;
  ok(before?.can?.decide === true, 'SEAT-01', 'صاحب المقعد الحالي (عمليات «إدارة الصحة» م8) يرى المهمة المعلقة في مرحلة «اعتماد عمليات الوحدة»', `${before?.currentStage ?? before?.state} · skipped=${skips}`);
  const p13a = await context(s1.cookies);
  await go(p13a, `#restationing/${rid}`);
  await p13a.waitForTimeout(2500);
  await shot(p13a, '13a-seat-holder-before-transfer.png');
  const stageOps = sql(`select id from restationing_stage where request_id = '${rid}' and permission = 'DECIDE_UNIT_OPERATIONS' order by route_no desc limit 1`);

  // the holder and the requester move in the directory (Mode A): the next sign-in reads the new Unit ID
  ldapUnit(P.new1, UID.c2);
  ldapUnit(P.req1, UID.c2);
  const s1m = await signIn(P.new1);
  await signIn(P.req1);
  ok(sql(`select ended_reason from membership where person_id = '${new1}' and role_code = 'UNIT_OPERATIONS_APPROVER'`) === 'SEAT_UNIT_LEFT', 'SEAT-REL', 'المقعد أُخلي للوحدة عند النقل (SEAT_UNIT_LEFT) ولم يُنقل إلى الوحدة الجديدة',
    sql(`select string_agg(role_code || ':' || coalesce(ended_reason, 'active'), ' ') from membership where person_id = '${new1}'`));
  const aAfter = await s1m.api('GET', `/restationing-requests/${rid}`);
  ok(aAfter.status >= 403 || aAfter.body?.can?.decide === false, 'SEAT-02', 'صاحب المقعد السابق فقد المهمة المعلقة', aAfter.status);
  const g = await aapi('POST', '/memberships', { personId: person(P.opsb), organizationId: org(UID.health), roleCode: 'UNIT_OPERATIONS_APPROVER', scope: { mode: 'CUSTOM', targets: [{ kind: 'ORGANIZATION', id: org(UID.health), includeDescendants: true, levels: [8] }] } });
  const sb = await signIn(P.opsb);
  const bView = (await sb.api('GET', `/restationing-requests/${rid}`)).body;
  ok(g.status === 200 && bView?.can?.decide === true && sql(`select count(*) from restationing_stage where request_id = '${rid}' and permission = 'DECIDE_UNIT_OPERATIONS'`) === '1', 'SEAT-03', 'صاحب المقعد الجديد يرى الطلب نفسه والمرحلة نفسها', `grant=${g.status} stage=${stageOps}`);
  const pb = await context(sb.cookies);
  await go(pb, `#restationing/${rid}`);
  await pb.waitForTimeout(2500);
  await shot(pb, '13-unit-seat-transfer.png');
  const decided = await sb.api('POST', `/restationing-requests/${rid}/decision`, { decision: 'APPROVE' });
  ok(decided.status === 200 && sql(`select p.id from restationing_stage s join person p on p.id = s.decided_by where s.id = '${stageOps}'`) === person(P.opsb), 'SEAT-04', 'صاحب المقعد الجديد قرر المرحلة، والسجل يحفظ الشخص الذي قرر فعلاً', `${decided.status} · ${decided.body?.state ?? JSON.stringify(decided.body).slice(0, 160)}`);

  const r2 = await signIn(P.req2);
  const view2 = await r2.api('GET', `/restationing-requests/${rid}`);
  ok(view2.status === 200 && view2.body?.requestingUnit?.name === orgName(UID.c1), 'OWN-01', 'بعد نقل مقدم الطلب: الطلب ما زال لـ«مركز صحة واحد»، ويراه مقدم طلبات الوحدة الآخر، والمسار يستمر', `${view2.status} · ${view2.body?.requestingUnit?.name} · ${view2.body?.requester?.name ? 'مقدمه في السجل' : ''} · ${view2.body?.state}`);
  const moved = await (await signIn(P.req1)).api('GET', `/restationing-requests/${rid}`);
  ok(moved.status >= 403, 'OWN-02', 'مقدم الطلب المنقول لا يأخذ الطلب معه إلى وحدته الجديدة', moved.status + ' · ' + sql(`select string_agg(role_code || ':' || coalesce(ended_reason, 'active'), ' ') from membership where person_id = '${person(P.req1)}'`));
  ok(sql(`select requesting_unit_id from restationing_request where id = '${rid}'`) === c1, 'OWN-03', 'ملكية الطلب لم تتغير في قاعدة البيانات');
  const p14 = await context(r2.cookies);
  await go(p14, `#restationing/${rid}`);
  await p14.waitForTimeout(2500);
  await shot(p14, '14-request-survives-requester-transfer.png');
}

// ================================================================================================================================
if (phase === 'seatrel') {
  // the seat released on the person's CURRENT unit-operations grant (an earlier row was replaced by the levels of ACCESS-05)
  const new1 = person(P.new1);
  const rel = sql(`select ended_reason from membership where person_id = '${new1}' and role_code = 'UNIT_OPERATIONS_APPROVER' order by valid_from desc, created_at desc limit 1`);
  ok(rel === 'SEAT_UNIT_LEFT' && sql(`select count(*) from audit_event where action = 'UNIT_SEAT_RELEASED' and entity_id = '${new1}'`) !== '0'
    && sql(`select count(*) from membership where person_id = '${new1}' and organization_id = '${org(UID.c2)}' and (valid_to is null or valid_to > now())`) === '0', 'SEAT-REL',
    'المقعد أُخلي للوحدة عند النقل (SEAT_UNIT_LEFT، UNIT_SEAT_RELEASED) ولم يُنقل إلى الوحدة الجديدة', sql(`select string_agg(role_code || ':' || coalesce(ended_reason, 'active'), ' ' order by valid_from) from membership where person_id = '${new1}'`).slice(0, 300));
  const rid = state.restationing.id;
  const skipped = sql(`select count(*) from restationing_stage where request_id = '${rid}' and kind = 'HIERARCHY' and mark = 'SKIPPED'`);
  ok(skipped === '2' && sql(`select count(*) from audit_event where action = 'HIERARCHY_LEVEL_SKIPPED' and entity_id = '${rid}'`) !== '0', 'ROUTE-SKIP', 'مستويات السلسلة بلا معتمد تُتجاوز ويُسجَّل السبب (NO_HIERARCHY_APPROVER)، ثم «اعتماد عمليات الوحدة» مرحلة مستقلة', `skipped=${skipped}`);
  const fin = done('OWN-04') ? { status: 200, body: { state: 'APPROVED_NOT_ACTIVATED' } } : await (await signIn(P.fin)).api('POST', `/restationing-requests/${rid}/decision`, { decision: 'APPROVE' });
  ok(fin.status === 200 && fin.body?.state === 'APPROVED_NOT_ACTIVATED', 'OWN-04', 'المسار يستمر حتى الاعتماد النهائي للطلب نفسه بعد نقل مقدمه وتبديل صاحب المقعد', `${fin.status} · ${fin.body?.state ?? JSON.stringify(fin.body).slice(0, 200)}`);
}

// ================================================================================================================================
if (phase === 'modeB2') {
  // Oracle switched on again: the directory person of Mode A becomes their one HR record — the same person, the same unit node
  const src = (await aapi('GET', '/hr/source')).body;
  const o = Object.fromEntries(readFileSync(ROOT + 'ops/local/.generated/mover-oracle-hr.env', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  if (!src?.enabled) {
    const on = await aapi('PUT', '/hr/source', { ...src, enabled: true, hostOrUrl: src.hostOrUrl ?? o.HOST, password: o.PASSWORD });
    ok(on.status === 200, 'MODE-B', 'تشغيل مصدر Oracle مرة أخرى (الوضع ب)', on.status);
  }
  const before = { person: person(P.uam), orgs: sql('select count(*) from organization'), unit: org(UID.c1) };
  const su = await signIn(P.uam);
  const mine = (await su.api('GET', '/access-requests/mine')).body;
  const afterP = person(P.uam);
  ok(su.status === 200 && afterP === before.person && sql('select count(*) from organization') === before.orgs && org(UID.c1) === before.unit && mine?.identity?.sourceCode === 'ORACLE', 'SOURCE-03',
    'بعد تفعيل Oracle: الشخص نفسه (لا تكرار) والوحدة نفسها بمعرّف الوحدة نفسه (لا عقدة ثانية)، والمصدر الآن Oracle', `${su.status} · same person=${afterP === before.person} · orgs ${before.orgs}→${sql('select count(*) from organization')} · source=${mine?.identity?.sourceCode} · ${sql(`select source || ':' || coalesce(source_external_id, '-') from person where id = '${afterP}'`)}`);
  // restore the catalogue as it was before the run (the production catalogue is the owner's)
  const saved = JSON.parse(readFileSync(GEN + 'acc79-offer-before.json', 'utf8'));
  const restored = await aapi('PUT', '/access-requests/offer', saved);
  ok(restored.status === 200, 'OFFER-RESTORED', '«الصلاحيات المعروضة للطلب» أُعيدت إلى ما كانت عليه قبل القبول', Object.keys(saved).join(',') || '(فارغة)');
}

ok(!external.length, 'OFFLINE-' + phase, 'لا طلب خارج localhost', external.slice(0, 3).join(' '));
await browser.close();
const passed = state.results.filter((r) => r.pass).length;
writeFileSync(OUT + 'results.json', JSON.stringify({ at: new Date().toISOString(), base: BASE, label: LABEL, accessRequest: state.accessRequest?.number, restationing: state.restationing?.number, fga: state.fga, passed, total: state.results.length, results: state.results }, null, 1));
console.log(`\n${passed}/${state.results.length} passed (all phases so far)`);
