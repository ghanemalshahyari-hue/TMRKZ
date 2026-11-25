// Final release acceptance (ADR-105), headless Edge against the throw-away installation of update-center/setup.sh (Compose
// project tmrkz-vmsim, laid out like the VM's /data/TMRKZ, https from its certs/ folder). Fictional data and accounts only.
// Run after tests/acceptance/update-center.mjs on the same installation:
//   node tests/acceptance/release-acceptance.mjs <base-dir> [port]
//
// UC-12 unauthorised users  UC-13 interrupted upload  UC-14 conflicting (locally modified) change  UC-15 insufficient disk
// UC-16 a build that does not start → automatic rollback  UC-17 maintenance continues while the application restarts
// UC-18 no Docker access, no command execution  UC-19 the signing key stays on the development machine
// CRT-E1…E5 certificates (inventory, https install/verify/restore, refusal, directory trust)  ENV-E1…E3 configuration import
// ADM-E1…E3 administrator found in the directory before a first sign-in
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BASE = process.argv[2];
const PORT = process.argv[3] ?? '8188';
if (!BASE) throw new Error('usage: node tests/acceptance/release-acceptance.mjs <base-dir> [port]');
const VM = join(BASE, 'vm', 'TMRKZ');
const DESK = join(BASE, 'desk', 'TMRKZ');
const URL_ = `http://localhost:${PORT}`;
const OUT = join(BASE, 'evidence-release');
const PKI = join(BASE, 'pki');
mkdirSync(OUT, { recursive: true });
mkdirSync(PKI, { recursive: true });
const readEnv = () => Object.fromEntries(readFileSync(join(VM, '.env'), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const ENV = readEnv();
const PW = ENV.TMRKZ_PLATFORM_ADMIN_PASSWORD;
const LDAP_PW = ENV.LOCAL_LDAP_ADMIN_PASSWORD;
const DPW = 'E2E#Directory-' + Date.now().toString(36);
const stamp = Date.now().toString(36);
const results = [];
const ok = (cond, id, label, extra = '') => {
  results.push({ id, pass: !!cond, label, extra: String(extra).slice(0, 300) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${id}  ${label}${extra ? '  — ' + String(extra).slice(0, 200) : ''}`);
};
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) => {
  try {
    return { code: 0, out: execFileSync(cmd, args, { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' }, stdio: ['pipe', 'pipe', 'pipe'], ...opts }) };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
  }
};
const compose = (...args) => run('docker', ['compose', ...args], { cwd: VM });
const release = () => run('sh', ['ops/update/make-release.sh'], { cwd: DESK });
const editDesk = (rel, from, to) => {
  const p = join(DESK, rel);
  const s = readFileSync(p, 'utf8');
  if (!s.includes(from)) throw new Error(`fixture text not found in ${rel}`);
  writeFileSync(p, s.replace(from, to));
};
const setEnvLine = (key, value) => {
  const lines = readFileSync(join(VM, '.env'), 'utf8').split('\n').filter((l) => !l.startsWith(key + '='));
  if (value !== null) lines.push(`${key}=${value}`);
  writeFileSync(join(VM, '.env'), lines.join('\n').replace(/\n+$/, '') + '\n');
};
const served = () => new Promise((resolve) => {
  const s = tls.connect({ host: 'localhost', port: 8543, servername: 'localhost', rejectUnauthorized: false }, () => {
    const raw = s.getPeerCertificate(true).raw;
    s.end();
    resolve(createHash('sha256').update(raw).digest('hex'));
  });
  s.on('error', (e) => resolve('error ' + e.message));
  s.setTimeout(5000, () => { s.destroy(); resolve('timeout'); });
});
const certSha = (pemPath) => createHash('sha256').update(new X509Certificate(readFileSync(pemPath)).raw).digest('hex');

// ---- the «Desktop» copy back to what the VM runs (update-center.mjs left test edits in it) ----------------------------------
for (const rel of ['backend/src/main/java/ae/mover/update/UpdateService.java', 'frontend/src/components/UpdateCenter.tsx', 'docker-compose.override.yml',
  'docs/VM_QUICK_START_AR.md']) {
  writeFileSync(join(DESK, rel), readFileSync(join(VM, rel)));
}
for (const n of readdirSync(join(DESK, 'docs')).filter((n) => n.startsWith('UPDATE_E2E_'))) rmSync(join(DESK, 'docs', n));

// ---- fictional directory accounts in the local stand-in directory ------------------------------------------------------
const people = { plain: `e2euser-${stamp}`, admin: `e2eadm-${stamp}` };
const ldif = Object.values(people).map((u) => `dn: uid=${u},ou=people,dc=tmrkz,dc=local\nobjectClass: inetOrgPerson\nuid: ${u}\ncn: E2E ${u}\nsn: E2E\n`
  + `displayName: مستخدم اختبار ${u}\nemployeeNumber: E2E-${u}\nuserPassword: ${DPW}\n`).join('\n');
const addRun = run('docker', ['compose', 'exec', '-T', 'openldap', 'ldapadd', '-x', '-H', 'ldap://localhost', '-D', 'cn=admin,dc=tmrkz,dc=local', '-w', LDAP_PW],
  { cwd: VM, input: ldif });
ok(addRun.code === 0 || addRun.out.includes('Already exists'), 'SETUP', 'two fictional accounts in the stand-in directory', addRun.out.split('\n')[0]);

// ---- a fictional PKI for the https certificate -------------------------------------------------------------------------
const ossl = (...args) => run('openssl', args, { cwd: PKI });
writeFileSync(join(PKI, 'inter.ext'), 'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n');
writeFileSync(join(PKI, 'server.ext'), 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
ossl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650', '-subj', '/CN=E2E Root CA/O=TMRKZ acceptance', '-keyout', 'root.key', '-out', 'root.crt',
  '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
ossl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=E2E Issuing CA/O=TMRKZ acceptance', '-keyout', 'inter.key', '-out', 'inter.csr');
ossl('x509', '-req', '-in', 'inter.csr', '-CA', 'root.crt', '-CAkey', 'root.key', '-CAcreateserial', '-days', '1825', '-out', 'inter.crt', '-extfile', 'inter.ext');
ossl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost/O=TMRKZ acceptance', '-keyout', 'server.key', '-out', 'server.csr');
ossl('x509', '-req', '-in', 'server.csr', '-CA', 'inter.crt', '-CAkey', 'inter.key', '-CAcreateserial', '-days', '365', '-out', 'server.crt', '-extfile', 'server.ext');
writeFileSync(join(PKI, 'chain.pem'), readFileSync(join(PKI, 'inter.crt'), 'utf8') + readFileSync(join(PKI, 'root.crt'), 'utf8'));
const pfx = ossl('pkcs12', '-export', '-inkey', 'server.key', '-in', 'server.crt', '-certfile', 'chain.pem', '-out', 'server.pfx', '-passout', 'pass:E2E-pfx-pass');
// a certificate for another key (its key never given): must be refused
ossl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', 'foreign.key', '-out', 'foreign.csr');
ossl('x509', '-req', '-in', 'foreign.csr', '-CA', 'inter.crt', '-CAkey', 'inter.key', '-CAcreateserial', '-days', '365', '-out', 'foreign.crt', '-extfile', 'server.ext');
ok(pfx.code === 0 && existsSync(join(PKI, 'server.pfx')), 'SETUP', 'a fictional root, issuing CA, server certificate and .pfx', pfx.out.slice(0, 120));

const { chromium } = await import(pathToFileURL(join(ROOT, 'tests/acceptance/node_modules/playwright-core/index.mjs')).href);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ locale: 'ar-AE', timezoneId: 'Asia/Dubai', viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
let promptAnswer = `استعادة اختبار ${stamp}`;
page.on('dialog', (d) => d.accept(promptAnswer));
const shot = (name, p = page) => p.screenshot({ path: join(OUT, name), fullPage: false }).catch(() => {});
const shotOf = (name, locator) => locator.screenshot({ path: join(OUT, name) }).catch(() => shot(name));

async function signIn(p, user, password) {
  for (let attempt = 1; ; attempt++) {
    await p.goto(URL_ + '/');
    await p.getByText('إدخال رقم الـــــ U وكلمة المرور يدويا').click({ timeout: 60000 });
    await p.locator('#tm-username').fill(user);
    await p.locator('#tm-password').fill(password);
    await p.getByRole('button', { name: 'تسجيل الدخول' }).click();
    try {
      await p.waitForSelector('main#main', { timeout: 20000 });
      return;
    } catch (e) {
      if (attempt >= 4) throw e;
      await sleep(10000);
    }
  }
}
async function settings(p = page) {
  await p.getByText('إدارة النظام', { exact: true }).first().click();
  await p.locator('[data-testid=update-center]').waitFor({ timeout: 60000 });
}
const api = async (p, path, init = {}) => {
  const r = await p.request.fetch(URL_ + '/api/v1' + path, { headers: { 'X-Requested-With': 'mover', 'Content-Type': 'application/json' }, ...init });
  return { status: r.status(), body: await r.json().catch(() => null) };
};
const liveness = async () => (await (await fetch(URL_ + '/api/v1/system/liveness')).json().catch(() => ({})));
async function updState(states, minutes) {
  const until = Date.now() + minutes * 60000;
  while (Date.now() < until) {
    const s = await page.locator('[data-testid=update-state]').getAttribute('data-state').catch(() => null);
    if (s && states.includes(s)) return s;
    await sleep(2000);
  }
  return page.locator('[data-testid=update-state]').getAttribute('data-state').catch(() => null);
}
async function chooseRelease() {
  await page.locator('[data-testid=update-folder]').setInputFiles(DESK);
  return updState(['COMPARED', 'REJECTED'], 5);
}
async function uploadAll() {
  await page.locator('[data-testid=update-upload]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=update-upload]')?.textContent?.includes('(0)'), null, { timeout: 180000 });
}
async function approve(reason) {
  await page.locator('[data-testid=update-reason]').fill(reason);
  await page.locator('[data-testid=update-approve]').click();
}
const updRow = (path) => page.locator(`[data-testid=update-changes] tr[data-path="${path}"]`);
/** Exactly one change selected — after the page has checked the local files and made its own default selection. */
async function only(path) {
  await updRow(path).locator('input:not([disabled])').waitFor({ timeout: 60000 });
  await sleep(2500);
  for (let i = 0; i < 3; i++) {
    await page.locator('[data-testid=update-changes] input[type=checkbox]').evaluateAll((els) => els.forEach((e) => { if (e.checked) e.click(); }));
    await updRow(path).locator('input').check();
    await sleep(700);
    const picked = await page.locator('[data-testid=update-changes] tr[data-path]').evaluateAll((rs) =>
      rs.filter((r) => r.querySelector('input')?.checked).map((r) => r.getAttribute('data-path')));
    if (picked.length === 1 && picked[0] === path) return;
  }
  throw new Error('could not select only ' + path);
}
async function certState(states, minutes) {
  const until = Date.now() + minutes * 60000;
  while (Date.now() < until) {
    const s = await page.locator('[data-testid=cert-state]').getAttribute('data-state').catch(() => null);
    if (s && states.includes(s)) return s;
    await sleep(1500);
  }
  return page.locator('[data-testid=cert-state]').getAttribute('data-state').catch(() => null);
}
const checkStatus = (code) => page.locator(`[data-testid=cert-checks] li[data-code="${code}"]`).first().getAttribute('data-status').catch(() => null);

try {
  // ---- UC-12 unauthorised users ---------------------------------------------------------------------------------------
  const anon = await Promise.all(['/updates', '/settings/certificates', '/administrators/lookup-options'].map((p) =>
    fetch(URL_ + '/api/v1' + p, { headers: { 'X-Requested-With': 'mover' } }).then((r) => r.status)));
  const anonPut = (await fetch(URL_ + '/api/v1/updates/sessions/20260101T000000-00000000/files?path=docs/x.md', { method: 'PUT',
    headers: { 'X-Requested-With': 'mover', 'Content-Type': 'application/octet-stream' }, body: 'x' })).status;
  ok(anon.every((s) => s === 401) && [401, 403].includes(anonPut), 'UC-12', 'without a session every update, certificate and lookup call is refused',
    anon.join(',') + ' put ' + anonPut);
  const plainCtx = await browser.newContext({ locale: 'ar-AE', viewport: { width: 1440, height: 1000 } });
  const plain = await plainCtx.newPage();
  await signIn(plain, people.plain, DPW);
  const plainCalls = await Promise.all([api(plain, '/updates'), api(plain, '/settings/certificates'),
    api(plain, '/settings/integration/import/preview', { method: 'POST', data: { fileName: 'x.env', text: 'LDAP_SERVER=x' } }),
    api(plain, '/updates/sessions', { method: 'POST', data: { release: '{}', signature: 'x', manifest: 'x' } })]);
  ok(plainCalls.every((c) => c.status === 403), 'UC-12', 'a signed-in person without global administration is refused everywhere',
    plainCalls.map((c) => c.status).join(','));
  ok(!(await plain.getByText('إدارة النظام', { exact: true }).count()), 'UC-12', 'and does not even see «إدارة النظام»');
  await shot('uc-12-no-access.png', plain);
  await plainCtx.close();

  await signIn(page, 'admin', PW);
  await settings();

  // ---- UC-19 the signing key stays on the development machine -------------------------------------------------------------
  const man = readFileSync(join(DESK, 'release/MANIFEST.tsv'), 'utf8');
  const pack = run('sh', ['ops/update/make-release.sh', '--package'], { cwd: DESK });
  const tarName = readdirSync(join(DESK, 'release')).filter((n) => n.startsWith('TMRKZ-app-') && n.endsWith('.tar')).sort().at(-1);
  const tarList = tarName ? run('tar', ['-tf', `release/${tarName}`], { cwd: DESK }).out : '';
  ok(!existsSync(join(VM, 'ops/local/.generated/release-signing.key')) && existsSync(join(VM, 'ops/local/.generated/release-trust.pub')), 'UC-19',
    'the VM holds only the public verification key');
  ok(!/release-signing|\.generated\/|^\S+\t\S+\t\S+\t\.env/m.test(man) && pack.code === 0 && tarList.length > 0
    && !/\.key$|release-signing|\.env$|^data\/|^certs\//m.test(tarList), 'UC-19', 'neither the manifest nor the transfer package carries a key, .env, data or certificates',
    `${tarName} ${tarList.split('\n').length} entries`);

  // ---- UC-18 no Docker access and no command execution -------------------------------------------------------------------
  const inspect = JSON.parse(run('docker', ['inspect', 'tmrkz-vmsim-maintenance-1', 'tmrkz-vmsim-backend-1']).out || '[]');
  const sockets = inspect.flatMap((c) => (c.Mounts ?? []).map((m) => m.Source + ' ' + m.Destination)).filter((m) => m.includes('docker.sock'));
  ok(inspect.length === 2 && sockets.length === 0 && inspect.every((c) => !c.HostConfig.Privileged), 'UC-18',
    'neither the maintenance worker nor the backend has the Docker socket or privileges', inspect.map((c) => c.Name).join(','));
  ok(compose('exec', '-T', 'maintenance', 'test', '-e', '/var/run/docker.sock').code !== 0, 'UC-18', 'no Docker socket inside the worker');
  const odd = `docs/e2e-$(touch pwned-${stamp}).md`;
  writeFileSync(join(DESK, odd), `# ${stamp}\n`);
  release();
  const c18 = await chooseRelease();
  ok(c18 === 'COMPARED' && await updRow(odd).count() === 1, 'UC-18', 'a file name with shell syntax is listed as an ordinary file', odd);
  await only(odd);
  await uploadAll();
  await approve(`اسم ملف غريب ${stamp}`);
  const d18 = await updState(['DONE', 'REJECTED', 'ERROR', 'FAILED_ROLLED_BACK'], 6);
  const pwned = run('sh', ['-c', `find . /tmp -name 'pwned-${stamp}*' 2>/dev/null | head -1`], { cwd: VM }).out.trim()
    + compose('exec', '-T', 'maintenance', 'sh', '-c', `find / -name 'pwned-${stamp}*' 2>/dev/null | head -1`).out.trim();
  ok(d18 === 'DONE' && existsSync(join(VM, odd)) && pwned === '', 'UC-18', 'it is written as a literal file and nothing is executed', d18 + ' ' + pwned);

  // ---- UC-14 a conflicting change: edited on the VM after the last update -----------------------------------------------
  writeFileSync(join(VM, odd), `# ${stamp}\nedited on the VM by hand\n`);
  writeFileSync(join(DESK, odd), `# ${stamp}\nchanged on the development machine\n`);
  release();
  await chooseRelease();
  const flags = await updRow(odd).innerText().catch(() => '');
  ok(flags.includes('معدّل على هذا الجهاز') && !(await updRow(odd).locator('input').isChecked()), 'UC-14',
    'a file changed on the VM since the last update is flagged and not selected by default', flags.trim());
  await shot('uc-14-conflict.png');

  // ---- UC-13 an interrupted upload -------------------------------------------------------------------------------------
  const sid = await page.evaluate(async () => (await (await fetch('/api/v1/updates', { headers: { 'X-Requested-With': 'mover' } })).json()).sessions[0].id);
  const full = readFileSync(join(DESK, odd));
  const partial = await page.evaluate(async ([id, path, text]) => {
    const r = await fetch(`/api/v1/updates/sessions/${id}/files?path=${encodeURIComponent(path)}`, { method: 'PUT',
      headers: { 'X-Requested-With': 'mover', 'Content-Type': 'application/octet-stream' }, body: text });
    return { status: r.status, body: await r.text() };
  }, [sid, odd, full.subarray(0, Math.floor(full.length / 2)).toString('utf8')]);
  const after13 = await api(page, '/updates/sessions/' + sid);
  const row13 = (after13.body?.compare?.changes ?? []).find((c) => c.path === odd);
  ok(partial.status === 400 && partial.body.includes('انقطع') && row13 && !row13.uploaded, 'UC-13',
    'a transfer cut short is refused, nothing staged; it can be sent again', partial.status + ' ' + partial.body.slice(0, 80));

  // ---- UC-15 insufficient disk space -----------------------------------------------------------------------------------
  setEnvLine('TMRKZ_UPDATE_MIN_FREE_MB', '99999999');
  compose('up', '-d', 'maintenance');
  await sleep(15000);
  await page.reload();
  await settings();
  await chooseRelease();
  await only(odd);
  await uploadAll();
  const vmBefore15 = sha(join(VM, odd));
  await approve(`مساحة القرص ${stamp}`);
  const d15 = await updState(['REJECTED', 'DONE', 'ERROR'], 5);
  const msg15 = await page.locator('[data-testid=update-message]').innerText().catch(() => '');
  await shot('uc-15-disk.png');
  ok(d15 === 'REJECTED' && msg15.includes('مساحة القرص') && sha(join(VM, odd)) === vmBefore15, 'UC-15',
    'with too little free space nothing is applied', msg15.slice(0, 120));
  setEnvLine('TMRKZ_UPDATE_MIN_FREE_MB', null);
  compose('up', '-d', 'maintenance');
  await sleep(15000);

  // ---- UC-17 maintenance continues while the application restarts ----------------------------------------------------------
  await page.reload();
  await settings();
  await chooseRelease();
  await only(odd);
  await uploadAll();
  await approve(`أثناء إعادة التشغيل ${stamp}`);
  compose('restart', 'backend');
  const d17 = await updState(['DONE', 'REJECTED', 'ERROR', 'FAILED_ROLLED_BACK'], 12);
  ok(d17 === 'DONE' && sha(join(VM, odd)) === sha(join(DESK, odd)), 'UC-17', 'an update applied while the backend restarts completes and verifies', d17);
  compose('restart', 'maintenance');
  await sleep(20000);
  const w17 = await api(page, '/updates');
  ok(w17.body?.worker?.alive && w17.body.sessions.length > 3, 'UC-17', 'the worker restarts on its own and its history is kept', JSON.stringify(w17.body?.worker));

  // ---- UC-16 a build that does not start: automatic rollback ------------------------------------------------------------------
  const CTOR = 'this.minFree = minFreeMb << 20;';
  editDesk('backend/src/main/java/ae/mover/update/UpdateService.java', CTOR, `${CTOR}\n        if (Boolean.parseBoolean("true")) throw new IllegalStateException("e2e ${stamp}: startup failure");`);
  release();
  await page.reload();
  await settings();
  await chooseRelease();
  await only('backend/src/main/java/ae/mover/update/UpdateService.java');
  await uploadAll();
  const serviceBefore = sha(join(VM, 'backend/src/main/java/ae/mover/update/UpdateService.java'));
  await approve(`بناء لا يعمل ${stamp}`);
  const d16 = await updState(['FAILED_ROLLED_BACK', 'DONE', 'REJECTED', 'ERROR'], 20);
  const prog16 = await page.locator('[data-testid=update-progress]').innerText().catch(() => '');
  writeFileSync(join(OUT, 'uc-16-progress.txt'), prog16);
  await shot('uc-16-rolled-back.png');
  let alive16 = false;
  for (let i = 0; i < 90 && !alive16; i++) { alive16 = (await fetch(URL_ + '/api/v1/auth/status').catch(() => ({ status: 0 }))).status === 200; if (!alive16) await sleep(4000); }
  ok(d16 === 'FAILED_ROLLED_BACK' && sha(join(VM, 'backend/src/main/java/ae/mover/update/UpdateService.java')) === serviceBefore && alive16, 'UC-16',
    'a build that never answers is rolled back by itself and the previous one serves again', d16);
  editDesk('backend/src/main/java/ae/mover/update/UpdateService.java', `\n        if (Boolean.parseBoolean("true")) throw new IllegalStateException("e2e ${stamp}: startup failure");`, '');
  release();

  // ---- ENV-E1…E3 importing a compatible application's configuration file ----------------------------------------------------
  // back to the directory .env describes (a previous run may have saved one), so the comparison starts from the same state
  await api(page, '/settings/integration/directory', { method: 'DELETE' });
  await page.reload();
  await settings();
  const envFile = join(BASE, 'other-app.env');
  writeFileSync(envFile, [
    '# another application on this network (fictional values)', 'LDAP_ENABLED=true', 'LDAP_SERVER=openldap', 'LDAP_PORT=389',
    'LDAP_SECURITY_MODE=starttls', 'LDAP_BASE_DN=dc=tmrkz,dc=local', 'LDAP_BIND_DN=cn=admin,dc=tmrkz,dc=local', `LDAP_BIND_PASSWORD="${LDAP_PW}"`,
    'LDAP_CA_CERT_PATH=/opt/other-app/ca-certs/tmrkz-local-directory-ca.pem', 'KEYCLOAK_ENABLED=true', 'KEYCLOAK_SERVER_URL=https://keycloak.example.test',
    'KEYCLOAK_REALM=corp', 'KEYCLOAK_CLIENT_ID=other-application', `KEYCLOAK_CLIENT_SECRET=fictional-client-secret-${stamp}`,
    'KEYCLOAK_REDIRECT_URI=https://other.example.test/callback', `DATABASE_URL=postgresql://app:fictional-db-${stamp}@db/app`,
    `SECRET_KEY=fictional-secret-${stamp}`, 'ORACLE_SETTINGS_KEY=fictional', `SMS_PASSWORD=fictional-sms-${stamp}`, 'OPENFGA_STORE_ID=01HE2E', ''].join('\n'));
  await page.locator('[data-testid=env-import]').scrollIntoViewIfNeeded();
  await page.locator('[data-testid=env-file]').setInputFiles(envFile);
  await page.locator('[data-testid=env-preview]').waitFor({ timeout: 30000 });
  const field = (p) => page.locator(`[data-testid=env-field][data-path="${p}"]`);
  const envText = await page.locator('[data-testid=env-import]').innerText();
  ok(await page.locator('[data-testid=env-format]').getAttribute('data-format') === 'COMPATIBLE'
    && await field('DIRECTORY.baseDn').getAttribute('data-status') === 'CONFLICT' && !(await field('DIRECTORY.baseDn').locator('input').isChecked())
    && await field('DIRECTORY.caCertificatesPem').getAttribute('data-status') === 'NEW' && await field('DIRECTORY.caCertificatesPem').locator('input').isChecked()
    && await field('DIRECTORY.bindPassword').getAttribute('data-status') === 'SAME', 'ENV-E1',
  'recognised and compared: a conflict kept, the CA found in this machine\'s folders, the same password recognised');
  ok(['DATABASE_URL', 'SECRET_KEY', 'ORACLE_SETTINGS_KEY', 'OPENFGA_STORE_ID'].every((k) => envText.includes(k))
    && ![LDAP_PW, `fictional-client-secret-${stamp}`, `fictional-db-${stamp}`, `fictional-secret-${stamp}`, `fictional-sms-${stamp}`].some((s) => envText.includes(s))
    && (await page.locator('[data-testid=env-section-incomplete]').count()) >= 1, 'ENV-E1',
  'never-imported values named only, no secret shown, the other application\'s Keycloak not chosen (incomplete)');
  await shotOf('env-e1-preview.png', page.locator('[data-testid=env-import]'));
  await field('DIRECTORY.baseDn').locator('input').check();
  ok(await page.locator('[data-testid=env-apply]').isDisabled(), 'ENV-E2', 'applying is not possible before the test');
  await page.locator('[data-testid=env-test]').click();
  await page.locator('[data-testid=env-test-result]').first().waitFor({ timeout: 60000 });
  ok(await page.locator('[data-testid=env-test-result]').first().getAttribute('data-ok') === 'true', 'ENV-E2', 'the chosen directory values pass a live protected connection',
    await page.locator('[data-testid=env-test-result]').first().innerText());
  await page.locator('[data-testid=env-reason]').fill(`نقل إعدادات الدليل ${stamp}`);
  await shotOf('env-e2-tested.png', page.locator('[data-testid=env-import]'));
  const envBefore = sha(join(VM, '.env'));
  await page.locator('[data-testid=env-apply]').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid=env-preview]'), null, { timeout: 30000 });
  const dir = await api(page, '/settings/integration/directory');
  ok(dir.body?.source === 'SAVED' && dir.body.saved.baseDn === 'dc=tmrkz,dc=local' && dir.body.saved.caCertificatesPem.includes('BEGIN CERTIFICATE')
    && sha(join(VM, '.env')) === envBefore, 'ENV-E3', 'saved to «إعدادات التكامل» (audited); .env not touched', dir.body?.source);
  const status = await api(page, '/settings/integration/status');
  ok(status.body?.directory?.state === 'UP', 'ENV-E3', 'the directory answers with the imported settings', status.body?.directory?.message);

  // ---- ADM-E1…E3 an administrator found in the directory before a first sign-in --------------------------------------------
  await page.locator('[data-testid=admin-lifecycle]').scrollIntoViewIfNeeded();
  await page.locator('[data-testid=admin-lifecycle]').getByRole('button', { name: '＋ مدير جديد' }).click();
  await page.getByLabel('حساب الدليل المؤسسي').check();
  await page.locator('[data-testid=admin-lookup-options]').waitFor({ timeout: 10000 });
  ok(await page.locator('[data-testid=admin-lookup-options]').getAttribute('data-mode') === 'SERVICE_ACCOUNT', 'ADM-E1',
    'the screen says which directory lookup this installation can make', await page.locator('[data-testid=admin-lookup-options]').innerText());
  await page.locator('[data-testid=admin-lookup-value]').fill(people.admin);
  await page.getByRole('button', { name: 'عرض الهوية' }).click();
  await page.locator('[data-testid=admin-candidate]').waitFor({ timeout: 20000 });
  const cand = await page.locator('[data-testid=admin-candidate]').innerText();
  ok(cand.includes('وُجد في الدليل المؤسسي الآن') && cand.includes('لم يدخل تمركز بعد') && cand.includes(`E2E-${people.admin}`), 'ADM-E2',
    'an account that never signed in is found in the directory and shown for confirmation', cand.replace(/\s+/g, ' ').slice(0, 160));
  await page.locator('[data-testid=admin-reason]').fill(`مدير نظام للاختبار ${stamp}`);
  await shotOf('adm-e2-candidate.png', page.locator('[data-testid=admin-lifecycle]'));
  await page.getByRole('button', { name: 'تأكيد منح صلاحية مدير النظام لهذا الشخص' }).click();
  await page.locator('[data-testid=admin-row]', { hasText: `مستخدم اختبار ${people.admin}` }).waitFor({ timeout: 20000 });
  const admins = await api(page, '/administrators');
  const made = (admins.body ?? []).find((a) => a.username === people.admin);
  const newCtx = await browser.newContext({ locale: 'ar-AE', viewport: { width: 1440, height: 1000 } });
  const np = await newCtx.newPage();
  await signIn(np, people.admin, DPW);
  const me = await api(np, '/me');
  await np.getByText('إدارة النظام', { exact: true }).first().click();
  const sees = await np.locator('[data-testid=update-center]').waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
  ok(made && me.body?.id === made.personId && sees, 'ADM-E3', 'their first sign-in lands on the record made at confirmation, with the role', `${me.body?.id} ${made?.personId}`);
  await newCtx.close();

  // ---- CRT-E1…E5 certificates ----------------------------------------------------------------------------------------------
  await page.reload();
  await settings();
  const cc = page.locator('[data-testid=cert-center]');
  await cc.scrollIntoViewIfNeeded();
  await page.locator('[data-testid=cert-store][data-store=HTTPS]').waitFor({ timeout: 30000 });
  const httpsStore = await page.locator('[data-testid=cert-store][data-store=HTTPS]').innerText();
  ok(httpsStore.includes('certs') && httpsStore.includes('server.crt') && httpsStore.includes('يطابق'), 'CRT-E1',
    'the https folder the configuration uses (certs/) is listed with its certificate and its key\'s match, never the key', httpsStore.replace(/\s+/g, ' ').slice(0, 160));
  await shotOf('crt-e1-inventory.png', cc);
  const originalServed = await served();
  ok(originalServed === certSha(join(VM, 'certs/server.crt')), 'CRT-E1', 'the https entry point serves the installed certificate', originalServed.slice(0, 16));

  // a certificate for another key: refused
  await page.locator('[data-testid=cert-target]').selectOption('HTTPS');
  await page.locator('[data-testid=cert-files]').setInputFiles([join(PKI, 'foreign.crt'), join(PKI, 'chain.pem')]);
  await page.locator('[data-testid=cert-check]').click();
  ok(await certState(['BLOCKED', 'CHECKED'], 1) === 'BLOCKED' && await checkStatus('KEY_MATCH') === 'FAIL', 'CRT-E4',
    'a certificate that does not hold this server\'s key is refused before anything is written');
  await shotOf('crt-e4-refused.png', page.locator('[data-testid=cert-session]'));
  await page.locator('[data-testid=cert-discard]').click();

  // the .pfx with its new key
  await page.locator('[data-testid=cert-files]').setInputFiles([join(PKI, 'server.pfx')]);
  await page.locator('[data-testid=cert-password]').fill('E2E-pfx-pass');
  await page.locator('[data-testid=cert-hostname]').fill('localhost');
  await page.locator('[data-testid=cert-check]').click();
  const c2 = await certState(['CHECKED', 'BLOCKED'], 1);
  const passes = await Promise.all(['KEY_MATCH', 'VALIDITY', 'SERVER_AUTH', 'HOSTNAME', 'CHAIN', 'KEY_STRENGTH'].map(checkStatus));
  ok(c2 === 'CHECKED' && passes.every((s) => s === 'PASS'), 'CRT-E2', 'key, validity, server use, host name, chain and key strength pass', passes.join(','));
  const sessionText = await page.locator('[data-testid=cert-session]').innerText();
  ok(!sessionText.includes('PRIVATE KEY') && !sessionText.includes(readFileSync(join(PKI, 'server.key'), 'utf8').split('\n')[2]), 'CRT-E2', 'the private key is never shown');
  await shotOf('crt-e2-checked.png', page.locator('[data-testid=cert-session]'));
  await page.locator('[data-testid=cert-reason]').fill(`تجديد شهادة https ${stamp}`);
  await page.locator('[data-testid=cert-apply]').click();
  await sleep(3000);
  if (await page.locator('[data-testid=stepup-notice]').isVisible().catch(() => false)) {
    // the session is older than five minutes: the decision asks for a fresh sign-in instead of failing silently
    ok(await certState(['CHECKED'], 0.1) === 'CHECKED', 'STEP-UP', 'an application with a sign-in older than five minutes asks to confirm the identity; nothing changed');
    await shotOf('stepup-notice.png', page.locator('[data-testid=cert-session]'));
    // a fresh sign-in: out first, then in again
    await api(page, '/auth/logout', { method: 'POST' });
    await ctx.clearCookies();
    await signIn(page, 'admin', PW);
    await settings();
    await page.locator('[data-testid=cert-center]').scrollIntoViewIfNeeded();
    await page.locator('[data-testid=cert-history-row]', { hasText: 'بانتظار التطبيق' }).first().getByRole('button', { name: 'عرض' }).click();
    await page.locator('[data-testid=cert-reason]').fill(`تجديد شهادة https ${stamp}`);
    await page.locator('[data-testid=cert-apply]').click();
  } else {
    const toast = await page.locator('#toast').innerText().catch(() => '');
    if (toast) ok(false, 'CRT-E2', 'apply was refused', toast);
  }
  const a2 = await certState(['APPLIED', 'APPLIED_INACTIVE', 'FAILED_ROLLED_BACK', 'REJECTED', 'ERROR'], 4);
  const newServed = await served();
  await shotOf('crt-e2-applied.png', page.locator('[data-testid=cert-session]'));
  ok(a2 === 'APPLIED' && newServed === certSha(join(PKI, 'server.crt')), 'CRT-E2', 'installed by the worker, reloaded by the https entry point, verified served', a2);
  const cb = existsSync(join(VM, 'backups', 'certificates')) ? readdirSync(join(VM, 'backups', 'certificates')).sort().at(-1) : null;
  ok(cb && existsSync(join(VM, 'backups', 'certificates', cb, 'server.key')) && existsSync(join(VM, 'backups', 'certificates', cb, 'server.crt')), 'CRT-E2',
    'the previous certificate and key were backed up first', cb);
  ok(!readdirSync(join(VM, 'certs')).some((n) => n.includes('tmrkz-cert')), 'CRT-E2', 'no temporary file left in the folder');

  promptAnswer = `استعادة الشهادة ${stamp}`;
  await page.locator('[data-testid=cert-restore]').click();
  const r3 = await certState(['RESTORED', 'ERROR'], 4);
  const back = await served();
  ok(r3 === 'RESTORED' && back === originalServed, 'CRT-E3', 'restore puts the previous certificate back and it is served again', r3);
  await shotOf('crt-e3-restored.png', page.locator('[data-testid=cert-session]'));

  // the directory's own trust, from a certificate already on this machine
  await page.locator('[data-testid=cert-target]').selectOption('DIRECTORY');
  // here certs/ is the https folder itself (TMRKZ_TLS_DIR=./certs): its ca-chain.pem is offered for import
  await page.locator('[data-testid=cert-store][data-store=HTTPS] [data-testid=cert-use]').first().click();
  await page.locator('[data-testid=cert-check]').click();
  const d5 = await certState(['CHECKED', 'BLOCKED'], 1);
  ok(d5 === 'CHECKED' && await checkStatus('LIVE_TLS') === 'PASS', 'CRT-E5', 'adding a CA from certs/ to the directory\'s trust is tested live first', d5);
  await page.locator('[data-testid=cert-reason]').fill(`ثقة الدليل ${stamp}`);
  await page.locator('[data-testid=cert-apply]').click();
  const d5a = await certState(['APPLIED', 'FAILED_ROLLED_BACK', 'ERROR'], 1);
  const dirAfter = await api(page, '/settings/integration/directory');
  ok(d5a === 'APPLIED' && (dirAfter.body?.saved?.caCertificatesPem.match(/BEGIN CERTIFICATE/g) ?? []).length === 2, 'CRT-E5', 'applied at once to that service alone', d5a);
  await shotOf('crt-e5-directory.png', page.locator('[data-testid=cert-session]'));
  promptAnswer = `رجوع ثقة الدليل ${stamp}`;
  await page.locator('[data-testid=cert-restore]').click();
  ok(await certState(['RESTORED', 'ERROR'], 1) === 'RESTORED', 'CRT-E5', 'and restored');
  await sleep(40000);
  const audit = JSON.stringify((await api(page, '/audit-events?size=100')).body ?? {});
  ok(['CERT_CHECKED', 'CERT_APPROVED', 'CERT_APPLIED', 'CERT_RESTORED', 'INTEGRATION_ENV_IMPORTED', 'ADMIN_GRANTED', 'UPDATE_REJECTED'].every((a) => audit.includes(a))
    && !audit.includes(LDAP_PW) && !audit.includes('E2E-pfx-pass'), 'AUD', 'every step is audited and no secret is in the audit log');
} catch (e) {
  ok(false, 'XX', 'unexpected error', e.stack);
  await shot('error.png');
  if (readFileSync(join(VM, '.env'), 'utf8').includes('TMRKZ_UPDATE_MIN_FREE_MB=')) {
    setEnvLine('TMRKZ_UPDATE_MIN_FREE_MB', null);
    compose('up', '-d', 'maintenance');
  }
} finally {
  await browser.close();
  writeFileSync(join(OUT, 'results.json'), JSON.stringify({ stamp, results }, null, 2));
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed — evidence in ${OUT}`);
  process.exit(failed ? 1 : 0);
}
