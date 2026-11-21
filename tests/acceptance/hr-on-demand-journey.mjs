// The acceptance journeys of ADR-094 on a TEMPORARY EMPTY installation (owner brief, 20 Nov 2026): fresh system, unit
// preview and import from the demo Oracle, first login by the manual form and by Keycloak resolving to the SAME person,
// the unknown unit, Oracle down after users exist, the 24-hour refresh, the daily sync, scale timings. Writes screenshots
// and JOURNEY.md into docs/evidence/hr-on-demand/.
//   sh ops/hr-demo/empty-install.sh up && BROWSER_PATH=… node tests/acceptance/hr-on-demand-journey.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BASE = process.env.MOVER_URL ?? 'http://localhost:8098';
const PROJECT = process.env.PROJECT ?? 'tmrkz-empty';
const OUT = ROOT + 'docs/evidence/hr-on-demand/';
mkdirSync(OUT, { recursive: true });
const { chromium } = await import(pathToFileURL(ROOT + 'tests/acceptance/node_modules/playwright-core/index.mjs').href);
const envOf = (file) => Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const G = ROOT + 'ops/hr-demo/.generated/';
const ADMIN_PW = envOf(ROOT + '.env').TMRKZ_PLATFORM_ADMIN_PASSWORD;
const PEOPLE_PW = readFileSync(G + 'ad-people-password', 'utf8').trim();
const ORA = envOf(G + 'oracle_hr.env');
const AD = envOf(G + 'synthetic-ad.env');
const CA_PEM = readFileSync(G + 'synthetic-ad/tls/ca.crt', 'utf8');

const results = [];
const timings = [];
const ok = (cond, label, extra = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + String(extra).slice(0, 200) : ''}`); return !!cond; };
const timed = async (label, fn) => { const t = Date.now(); const r = await fn(); const ms = Date.now() - t; timings.push([label, ms]); console.log(`      ${label}: ${ms} ms`); return r; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'mover' };
const manual = async (username, password) => {
  const res = await fetch(BASE + '/api/v1/auth/directory/login', { method: 'POST', headers: H, body: JSON.stringify({ username, password }) });
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return { status: res.status, body: await res.json().catch(() => null), cookie };
};
const call = async (cookie, method, path, body) => {
  const res = await fetch(BASE + '/api/v1' + path, { method, headers: { Cookie: cookie, ...H }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, body: json, text };
};
const sql = (q) => execFileSync('docker', ['compose', '-p', PROJECT, 'exec', '-T', 'db', 'psql', '-U', 'mover', '-d', 'mover', '-At', '-c', q], { encoding: 'utf8' }).trim();
const ldb = (login, attr) => {
  const out = execFileSync('docker', ['exec', 'tmrkz-synthetic-ad', 'ldbsearch', '-H', '/var/lib/samba/private/sam.ldb', '-b', 'OU=People,DC=tmrkz,DC=test', `(sAMAccountName=${login})`, attr], { encoding: 'utf8' });
  return (out.match(new RegExp('^' + attr + ': (.*)$', 'm')) ?? [])[1]?.trim() ?? null;
};
const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8' });

// ---- browser helpers ----------------------------------------------------------------------------------------------
const browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH, headless: true });
const pageErrors = [];
const contextWith = async (cookie) => {
  const ctx = await browser.newContext({ locale: 'ar-AE', timezoneId: 'Asia/Dubai', viewport: { width: 1440, height: 1000 } });
  if (cookie) await ctx.addCookies(cookie.split('; ').map((c) => ({ name: c.slice(0, c.indexOf('=')), value: c.slice(c.indexOf('=') + 1), url: BASE })));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  return page;
};
const shot = async (page, name) => { await page.waitForTimeout(700); await page.screenshot({ path: OUT + name }); };

// ---- 0. the fresh system ------------------------------------------------------------------------------------------
const admin = await manual('admin', ADMIN_PW);
ok(admin.status === 200, 'J0 the platform administrator signs in on the empty installation', admin.status);
const state0 = await call(admin.cookie, 'GET', '/system/state');
ok(state0.body?.empty === true && state0.body.units === 0, 'J0 /system/state says empty (no unit, site, stationing or request)', JSON.stringify(state0.body));
{
  const page = await contextWith(admin.cookie);
  await page.goto(BASE + '/#home', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  ok((await page.getByTestId('home-empty').count()) === 1, 'J0 the home shows nothing in the middle (home-empty)');
  await shot(page, 'J01-home-empty.png');
  for (const [view, name] of [['stationing', 'J02-sites-empty.png'], ['posture', null], ['restationing', null], ['siteSetup', 'J03-site-setup-empty.png']]) {
    await page.goto(BASE + '/#' + view, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    const empty = await page.getByTestId('empty-centre').count();
    const maps = await page.locator('.maplibregl-map, canvas.maplibregl-canvas').count();
    ok(empty === 1 && maps === 0, `J0 «${view}» shows the empty centre and creates no map instance`, `empty=${empty} maps=${maps}`);
    if (name) await shot(page, name);
  }
  await page.goto(BASE + '/#settings', { waitUntil: 'networkidle' });
  await page.getByTestId('settings-group-hr').waitFor({ timeout: 30000 });
  ok((await page.getByTestId('hr-units-not-imported').count()) === 1, 'J0 the HR panel says «لم يتم استيراد الوحدات»');
  await page.getByTestId('hr-units-not-imported').scrollIntoViewIfNeeded();
  await shot(page, 'J04-settings-units-not-imported.png');
  await page.context().close();
}

// ---- 1. the directory through «إعدادات التكامل» (ADR-092) ----------------------------------------------------------
const directory = {
  enabled: true, server: 'tmrkz-synthetic-ad', port: 636, securityMode: 'ldaps', domain: 'tmrkz.test', baseDn: 'DC=tmrkz,DC=test',
  bindDn: 'CN=Administrator,CN=Users,DC=tmrkz,DC=test', bindPassword: AD.SYNTHETIC_AD_ADMIN_PASSWORD,
  usernameAttribute: 'sAMAccountName', uuidAttribute: 'objectGUID', employeeNumberAttribute: 'MilNumber', userObjectClass: 'user',
  rankAttribute: 'MilRankName', positionAttribute: 'MilOccupation', unitIdAttribute: 'MilUnitId', unitNameAttribute: 'MilCurrentUnitName',
  mainUnitIdAttribute: 'MilMainUnitId', caCertificatesPem: CA_PEM, timeoutSeconds: 10,
};
const dirTest = await timed('directory test with a synthetic login', () => call(admin.cookie, 'POST', '/settings/integration/directory/test', { settings: directory, testLogin: 'khalid.aamry22', testPassword: PEOPLE_PW }));
ok(dirTest.body?.ok === true, 'J1 the synthetic directory answers the test (LDAPS, generated CA, user@tmrkz.test bind)', dirTest.body?.message ?? dirTest.text.slice(0, 120));
const dirSaved = await call(admin.cookie, 'PUT', '/settings/integration/directory', directory);
ok(dirSaved.status === 200, 'J1 the directory settings are saved from the screen\'s API', dirSaved.status);
const live = await call(admin.cookie, 'GET', '/settings/integration/status');
ok(live.body?.directory?.state === 'UP' || /يعمل/.test(JSON.stringify(live.body)), 'J1 the live badge of the directory says يعمل', JSON.stringify(live.body).slice(0, 160));

// ---- 2. the HR source: test, preview, nothing imported yet ----------------------------------------------------------
const source = {
  name: 'Oracle HR (synthetic)', enabled: true, hostOrUrl: ORA.ORACLE_HR_HOST, port: Number(ORA.ORACLE_HR_PORT), serverName: ORA.ORACLE_HR_SERVICE, nameType: 'service_name',
  username: ORA.ORACLE_MOVER_USER, password: ORA.ORACLE_MOVER_PASSWORD, unitView: 'HR_AI.HR_ENV_UNITS_AI', personView: 'HR_AI.HR_PRS_EMPLOYEES_ALL',
  connectTimeoutS: 10, callTimeoutMs: 120000, dropPercent: 10, dropMinimum: 3, maxAgeHours: 720,
  autoSync: false, syncIntervalHours: 24, peopleSync: false, directorySignInSuffices: true, personRefreshHours: 24,
};
const srcSaved = await call(admin.cookie, 'PUT', '/hr/source', source);
ok(srcSaved.status === 200 && srcSaved.body?.personRefreshHours === 24, 'J2 the HR source is saved (people on demand, no automatic sync, refresh after 24 h)', srcSaved.status);
const hrTest = await timed('HR connection test', () => call(admin.cookie, 'POST', '/hr/source/test'));
ok(hrTest.body?.ok === true, 'J2 اختبار الاتصال reaches the demo Oracle', hrTest.body?.message ?? hrTest.body?.failure);
const F = (entity, field, column, transform = 'none', alternates = []) => ({ entity, field, column, transform, alternates, enabled: true });
const fields = [
  F('UNIT', 'external_unit_id', 'ID'), F('UNIT', 'name', 'NAME'), F('UNIT', 'parent_external_unit_id', 'UNIT_PATH', 'path_parent'),
  F('UNIT', 'status', 'STATUS'), F('UNIT', 'code', 'CODE'), F('UNIT', 'name_en', 'NAME_E'), F('UNIT', 'level', 'UNT_LEVEL'), F('UNIT', 'main_external_unit_id', 'MAIN_UNIT_ID'),
  F('PERSON', 'external_person_id', 'PRS_ID'), F('PERSON', 'employee_number', 'NEW_MIL_NO', 'first_non_empty', ['MIL_NUMBER']),
  F('PERSON', 'legacy_employee_number', 'MIL_NUMBER'), F('PERSON', 'domain_account', 'PERSON_USER_ID'), F('PERSON', 'full_name', 'FULL_NAME'),
  F('PERSON', 'unit_external_id', 'ORG_UNIT_ID'), F('PERSON', 'status_text', 'EMP_STATUS_DESC'), F('PERSON', 'rank', 'GRADE_NAME'),
  F('PERSON', 'position_id', 'POSITION_ID'), F('PERSON', 'position', 'EMP_POSITION_DESC'), F('PERSON', 'job', 'JOB_NAME'), F('PERSON', 'leave_status', 'EMP_WORK_STATUS_DESC'),
];
const rules = { UNIT: { column: 'STATUS', operator: 'EQUALS', values: ['1'] }, PERSON: { column: 'EMP_STATUS_DESC', operator: 'EQUALS', values: ['في الخدمة'] } };
const draft = await call(admin.cookie, 'POST', '/hr/mappings/draft', { fields, activeRules: rules });
ok(draft.status === 200, 'J2 mapping drafted (MOVER\'s columns; parent from UNIT_PATH, main unit from MAIN_UNIT_ID)', draft.text.slice(0, 160));
const disc = await timed('discover columns', () => call(admin.cookie, 'POST', `/hr/mappings/${draft.body?.id}/discover`, {}));
const pub = await call(admin.cookie, 'POST', `/hr/mappings/${draft.body?.id}/publish`, {});
ok(disc.status === 200 && pub.status === 200, 'J2 mapping discovered and published', `${disc.status}/${pub.status} ${pub.text.slice(0, 160)}`);
const preview = await timed('units preview (read-only, 30k units + people count)', () => call(admin.cookie, 'POST', '/hr/units/preview', {}));
ok(preview.body?.ok === true && preview.body.units > 20000 && preview.body.mainUnits > 100, 'J2 معاينة الوحدات states the source: units, main units, levels, problems', `units=${preview.body?.units} main=${preview.body?.mainUnits} levels=${preview.body?.levels?.length} people=${preview.body?.people} problems=${preview.body?.problemCount} ${preview.body?.message ?? ''}`);
const stAfterPreview = await call(admin.cookie, 'GET', '/hr/status');
ok(stAfterPreview.body?.unitsImported === 0 && stAfterPreview.body?.lastPreview?.units === preview.body?.units && stAfterPreview.body?.lastAttemptAt == null, 'J2 the preview wrote nothing: 0 units locally, no run; the source count is kept', `imported=${stAfterPreview.body?.unitsImported}`);
ok(Number(sql("select count(*) from organization")) === 0 && Number(sql('select count(*) from hr_sync_run')) === 0, 'J2 the database holds no organisation and no run after the preview');

// ---- 3. first login BEFORE the units exist: identity verified, unit not configured, zero access ------------------------
const k1 = await timed('first manual sign-in (HR has no snapshot yet)', () => manual('khalid.aamry22', PEOPLE_PW));
ok(k1.status === 200 && k1.body?.permissions?.length === 0, 'J3 a brand-new person enters by the directory with zero access while HR has no published data', `${k1.status} ${JSON.stringify(k1.body?.details ?? k1.body?.permissions)}`);
ok(k1.body?.hrMatch === 'PENDING', 'J3 their HR match is pending («بانتظار تحديث HR»)', k1.body?.hrMatch);
const mine1 = await call(k1.cookie, 'GET', '/access-requests/mine');
ok(mine1.body?.identity?.unitConfigured === false && mine1.body.identity.statedUnitId === ldb('khalid.aamry22', 'MilUnitId'), 'J3 the identity card says the unit is not configured and names the directory\'s unit ID; no unit was created', `${mine1.body?.identity?.statedUnitId} / ${mine1.body?.identity?.statedUnitName}`);
ok(Number(sql("select count(*) from organization")) === 0, 'J3 an unknown unit creates no organisation');
const refusedView = await call(k1.cookie, 'GET', '/sites');
ok(refusedView.status === 403, 'J3 zero access is enforced by the server (sites refused)', refusedView.status);
{
  const page = await contextWith(k1.cookie);
  await page.goto(BASE + '/#requestAccess', { waitUntil: 'networkidle' });
  await page.getByTestId('access-identity').waitFor({ timeout: 30000 });
  ok((await page.getByTestId('access-unit-not-configured').count()) === 1, 'J3 the screen shows «تم التحقق من هويتك، لكن وحدتك التنظيمية غير مهيأة في النظام»');
  ok((await page.getByTestId('hr-match-pending').count()) === 1, 'J3 and the HR-pending note');
  await shot(page, 'J05-first-login-unit-not-configured.png');
  await page.context().close();
}
const khalidId1 = sql("select id from person where lower(username) = 'khalid.aamry22'");

// ---- 4. import the units now --------------------------------------------------------------------------------------
const run = await call(admin.cookie, 'POST', '/hr/sync', {});
ok(run.status === 202 || run.status === 200, 'J4 «استيراد الوحدات الآن» accepted', run.status);
const t0 = Date.now();
let st;
for (let i = 0; i < 240; i++) { await sleep(5000); st = await call(admin.cookie, 'GET', '/hr/status'); if (!st.body?.running && st.body?.lastRun && st.body.lastRun.status !== 'RUNNING') break; }
timings.push(['units import (run + projection)', Date.now() - t0]);
ok(st.body?.lastRun?.status === 'SUCCEEDED', 'J4 the import succeeded', `${st.body?.lastRun?.status} ${st.body?.lastRun?.errorMessage ?? ''} ${Date.now() - t0} ms`);
ok(st.body?.unitsImported > 20000 && st.body?.localMainUnits > 100, 'J4 units and main units are local now; people still 0 fetched in bulk', `units=${st.body?.unitsImported} main=${st.body?.localMainUnits} people=${st.body?.peopleFetched} changes=${JSON.stringify(st.body?.lastChanges)}`);
ok(Number(sql("select count(*) from person where source = 'HR'")) <= 1, 'J4 no person was synced in bulk');
const stateImported = await call(admin.cookie, 'GET', '/system/state');
ok(stateImported.body?.empty === false && stateImported.body?.unitsImported === true, 'J4 /system/state is no longer empty');
{
  const page = await contextWith(admin.cookie);
  await page.goto(BASE + '/#settings', { waitUntil: 'networkidle' });
  const status = page.locator('section', { hasText: 'مزامنة الموارد البشرية' }).first();
  await status.waitFor({ timeout: 30000 }); await status.scrollIntoViewIfNeeded();
  await page.waitForTimeout(700);
  await status.screenshot({ path: OUT + 'J06-hr-status-after-import.png' });
  await page.goto(BASE + '/#stationing', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  ok((await page.getByTestId('empty-centre').count()) === 0, 'J4 the operational screen shows its map frame again once data exists');
  await page.context().close();
}

// ---- 5. the same person by the manual form and by Keycloak -----------------------------------------------------------
const k2 = await timed('manual sign-in after the import (HR matched live)', () => manual('khalid.aamry22', PEOPLE_PW));
ok(k2.status === 200 && k2.body?.hrMatch === 'MATCHED' && k2.body?.id === khalidId1, 'J5 the next manual sign-in matches the HR record onto the SAME person (no duplicate)', `${k2.body?.hrMatch} same=${k2.body?.id === khalidId1}`);
const mine2 = await call(k2.cookie, 'GET', '/access-requests/mine');
const unitId = ldb('khalid.aamry22', 'MilUnitId'); const mainId = ldb('khalid.aamry22', 'MilMainUnitId');
ok(mine2.body?.identity?.unitConfigured === true && mine2.body.identity.unitId, 'J5 the unit is configured now; the identity card names unit and main unit', `${mine2.body?.identity?.unit} / ${mine2.body?.identity?.mainUnit} (${mine2.body?.identity?.rank}, ${mine2.body?.identity?.position})`);
const scopeRoot = mine2.body?.scopeUnits?.[0];
const mainOrg = sql(`select id from organization where source = 'HR' and source_external_id = '${mainId}'`);
ok(scopeRoot?.id === mainOrg && mine2.body.scopeUnits.length > 1, 'J5 the scope tree begins at the person\'s main unit', `root=${scopeRoot?.name} units=${mine2.body?.scopeUnits?.length}`);
ok((mine2.body?.requestable ?? []).length > 0, 'J5 the requestable roles come from the role policy', (mine2.body?.requestable ?? []).map((r) => r.code ?? r.role ?? r).slice(0, 5).join(','));
{
  const page = await contextWith(k2.cookie);
  await page.goto(BASE + '/#requestAccess', { waitUntil: 'networkidle' });
  await page.getByTestId('access-identity').waitFor({ timeout: 30000 });
  await page.waitForTimeout(1000);
  const scopeRadio = page.locator('input[data-scope=UNITS]');
  if (await scopeRadio.count()) { await scopeRadio.check(); await page.waitForTimeout(800); }
  const current = await page.locator('.ut-current').count();
  ok(current === 1, 'J5 the scope tree highlights the person\'s own unit', `ut-current=${current}`);
  await shot(page, 'J07-access-request-after-import.png');
  await page.context().close();
}
{
  // Keycloak: the automatic button, the realm's login form, back to TMRKZ — the same person id
  const page = await contextWith(null);
  await page.goto(BASE + '/');
  const auto = page.locator('a.tm-submit', { hasText: 'الدخول الآلي' });
  await auto.waitFor({ timeout: 30000 }); await page.waitForTimeout(800);
  const tk = Date.now();
  await auto.click();
  await page.locator('#username').waitFor({ timeout: 60000 });
  await page.locator('#username').fill('khalid.aamry22');
  await page.locator('#password').fill(PEOPLE_PW);
  await shot(page, 'J08-keycloak-login.png');
  await page.locator('#kc-login').click();
  await page.waitForSelector('main#main', { timeout: 90000 });
  timings.push(['Keycloak sign-in (browser, same person)', Date.now() - tk]);
  const me = await page.evaluate(async () => (await fetch('/api/v1/me', { headers: { 'X-Requested-With': 'mover' } })).json());
  ok(me.id === khalidId1 && me.signInMethod === 'PROVIDER', 'J5 the Keycloak sign-in resolves to the SAME person as the manual form', `${me.signInMethod} same=${me.id === khalidId1}`);
  ok(Number(sql("select count(*) from person where lower(username) = 'khalid.aamry22'")) === 1, 'J5 one person row for both paths');
  await page.waitForTimeout(1500);
  await shot(page, 'J09-after-keycloak-login.png');
  await page.context().close();
}

// ---- 6. Oracle down after users exist --------------------------------------------------------------------------------
docker('pause', 'tmrkz-hr-demo-oracle');
let abdulla, kDown, abdullaId;
try {
  abdulla = await timed('first manual sign-in while Oracle is paused', () => manual('abdulla.blwshy30', PEOPLE_PW));
  ok(abdulla.status === 200 && abdulla.body?.permissions?.length === 0 && abdulla.body?.hrMatch === 'PENDING', 'J6 Oracle down: a new person still enters with zero access, marked «بانتظار تحديث HR»', `${abdulla.status} ${abdulla.body?.hrMatch} ${JSON.stringify(abdulla.body?.details ?? '')}`);
  const mineA = await call(abdulla.cookie, 'GET', '/access-requests/mine');
  ok(mineA.body?.identity?.unitConfigured === true && mineA.body?.identity?.sourceCode === 'LDAP', 'J6 placed in their (now known) unit from the directory\'s attributes', `${mineA.body?.identity?.unit} / ${mineA.body?.identity?.mainUnit}`);
  abdullaId = sql("select id from person where lower(username) = 'abdulla.blwshy30'");
  kDown = await timed('existing person\'s sign-in while Oracle is paused', () => manual('khalid.aamry22', PEOPLE_PW));
  ok(kDown.status === 200 && kDown.body?.id === khalidId1, 'J6 an existing person signs in while Oracle is down (nothing refused, nothing undone)', kDown.status);
  const browse = await Promise.all([call(admin.cookie, 'GET', '/org-tree'), call(admin.cookie, 'GET', '/sites'), call(admin.cookie, 'GET', '/system/state')]);
  ok(browse.every((r) => r.status === 200), 'J6 browsing (org tree, sites, state) works while Oracle is down', browse.map((r) => r.status).join('/'));
  const page = await contextWith(abdulla.cookie);
  await page.goto(BASE + '/#requestAccess', { waitUntil: 'networkidle' });
  await page.getByTestId('hr-match-pending').waitFor({ timeout: 30000 });
  await shot(page, 'J10-oracle-down-zero-access.png');
  await page.context().close();
} finally {
  docker('unpause', 'tmrkz-hr-demo-oracle');
}
await sleep(2000);
const abdulla2 = await timed('sign-in after Oracle is back (match)', () => manual('abdulla.blwshy30', PEOPLE_PW));
ok(abdulla2.status === 200 && abdulla2.body?.hrMatch === 'MATCHED' && abdulla2.body?.id === abdullaId, 'J6 Oracle back: the next sign-in matches the HR record onto the same person, no duplicate', `${abdulla2.body?.hrMatch} same=${abdulla2.body?.id === abdullaId} rows=${sql("select count(*) from person where lower(username) = 'abdulla.blwshy30'")}`);

// ---- 7. the 24-hour refresh and the manual refresh -------------------------------------------------------------------
sql(`update person set hr_fetched_at = now() - interval '25 hours' where id = '${khalidId1}'`);
const k3 = await timed('sign-in with a stale record (refreshed from HR)', () => manual('khalid.aamry22', PEOPLE_PW));
const fetchedAge = Number(sql(`select extract(epoch from (now() - hr_fetched_at)) from person where id = '${khalidId1}'`));
ok(k3.status === 200 && fetchedAge < 120, 'J7 a record older than the period is refreshed on the next sign-in', `age=${Math.round(fetchedAge)} s`);
const k4 = await manual('khalid.aamry22', PEOPLE_PW);
const meK = await call(k4.cookie, 'GET', '/me');
ok(meK.body?.hrStale === false && meK.body?.hrFetchedAt, 'J7 /me says the record is fresh and when HR last answered', meK.body?.hrFetchedAt);
const manualRefresh = await timed('manual refresh of oneself', () => call(k4.cookie, 'POST', '/me/hr-refresh', {}));
ok(manualRefresh.status === 200 && manualRefresh.body?.refreshed === true, 'J7 «تحديث بياناتي من الموارد البشرية» asks HR now', JSON.stringify(manualRefresh.body));
const offSaved = await call(admin.cookie, 'PUT', '/hr/source', { ...source, personRefreshHours: 0 });
sql(`update person set hr_fetched_at = now() - interval '25 hours' where id = '${khalidId1}'`);
await manual('khalid.aamry22', PEOPLE_PW);
const notRefreshed = Number(sql(`select extract(epoch from (now() - hr_fetched_at)) from person where id = '${khalidId1}'`));
ok(offSaved.body?.personRefreshHours === 0 && notRefreshed > 3600, 'J7 with the period disabled (0) nothing refreshes automatically', `age=${Math.round(notRefreshed)} s`);
await call(admin.cookie, 'PUT', '/hr/source', { ...source, personRefreshHours: 24 });

// ---- 8. the daily sync -----------------------------------------------------------------------------------------------
const auto = await call(admin.cookie, 'PUT', '/hr/source', { ...source, autoSync: true, syncIntervalHours: 24 });
const stAuto = await call(admin.cookie, 'GET', '/hr/status');
ok(auto.body?.autoSync === true && stAuto.body?.nextRunAt && !stAuto.body?.syncDue, 'J8 automatic sync every 24 h: the next run is scheduled from the last success', stAuto.body?.nextRunAt);
sql("update hr_source set last_success_at = now() - interval '25 hours'");
const runsBefore = Number(sql("select count(*) from hr_sync_run where trigger = 'SCHEDULED'"));
let scheduled = false; const t8 = Date.now();
for (let i = 0; i < 60; i++) { await sleep(5000); if (Number(sql("select count(*) from hr_sync_run where trigger = 'SCHEDULED'")) > runsBefore) { scheduled = true; break; } }
ok(scheduled, 'J8 when the source\'s own interval is due, the scheduler starts a SCHEDULED run within its minute tick', `${Date.now() - t8} ms`);
for (let i = 0; i < 240; i++) { await sleep(5000); st = await call(admin.cookie, 'GET', '/hr/status'); if (!st.body?.running) break; }
ok(st.body?.lastRun?.status === 'SUCCEEDED' && st.body?.lastRun?.trigger === 'SCHEDULED', 'J8 the scheduled run succeeded and carried the people forward (none read in bulk)', `${st.body?.lastRun?.status} peopleCarried=${st.body?.lastRun?.counts?.peopleCarried}`);
await call(admin.cookie, 'PUT', '/hr/source', { ...source, autoSync: false });

// ---- 9. a person fetched on demand by number ---------------------------------------------------------------------------
const mariamNo = ldb('mariam.aamry10', 'MilNumber'); const mariamUnit = ldb('mariam.aamry10', 'MilUnitId');
const mariamOrg = sql(`select id from organization where source = 'HR' and source_external_id = '${mariamUnit}'`);
const added = await timed('add a person by number (one HR lookup)', () => call(admin.cookie, 'POST', '/access/unit-members', { organizationId: mariamOrg, employeeNo: mariamNo }));
ok(added.status === 200 && Number(sql(`select count(*) from person where employee_no = '${mariamNo}'`)) === 1, 'J9 «إضافة بالرقم» fetches exactly that person from HR', added.text.slice(0, 120));
const total = Number(sql("select count(*) from person where source = 'HR'"));
ok(total <= 3, 'J9 people in TMRKZ are only those who signed in or were added', `hr people=${total}`);

// ---- report ------------------------------------------------------------------------------------------------------------
await browser.close();
ok(pageErrors.length === 0, 'no page error in the browser', pageErrors.slice(0, 2).join(' | '));
const passed = results.filter(Boolean).length;
const md = [`# ADR-094 acceptance journeys on a temporary empty installation — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, '',
  `Installation: ${BASE} (compose project ${PROJECT}, empty database), synthetic directory tmrkz-synthetic-ad (Samba AD, LDAPS), demo Oracle tmrkz-hr-demo-oracle (large profile). Result: ${passed}/${results.length} checks passed.`, '',
  '## Timings', '', '| Step | ms |', '|---|---|', ...timings.map(([l, ms]) => `| ${l} | ${ms} |`), '',
  '## Source counts', '', `units ${preview.body?.units} (active ${preview.body?.activeUnits}, main ${preview.body?.mainUnits}, roots ${preview.body?.roots}), people ${preview.body?.people}, levels ${JSON.stringify(preview.body?.levels)}, problems ${JSON.stringify(preview.body?.problems)}`, '',
  '## Screenshots', '', 'J01 home empty · J02 sites empty · J03 site setup empty · J04 settings «لم يتم استيراد الوحدات» · J05 first login, unit not configured · J06 HR status after import · J07 access request after import (scope tree, own unit) · J08 Keycloak login · J09 after Keycloak login · J10 Oracle down, zero access', ''].join('\n');
writeFileSync(OUT + 'JOURNEY.md', md);
console.log(`\n${passed}/${results.length} passed — ${OUT}JOURNEY.md`);
process.exit(passed === results.length ? 0 : 1);
