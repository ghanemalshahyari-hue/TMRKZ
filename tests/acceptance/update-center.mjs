// «مركز التحديث» end to end (ADR-104), headless Edge against the throw-away installation of update-center/setup.sh (Compose
// project tmrkz-vmsim, laid out like the VM's /data/TMRKZ). Fictional data only.
//   node tests/acceptance/update-center.mjs <base-dir> [port]
// UC-01 choose the «Desktop» TMRKZ folder, see added/modified/deleted/config changes; UC-02 upload only what differs; UC-03 approve
// → the worker builds offline, backs up, applies, the backend restarts with the new build and the web is rebuilt, verified;
// UC-04 protected files untouched, the unselected Compose change not applied; UC-05 audited; UC-06 rollback restores;
// UC-07 a bad signature, protected paths and a file changed after signing are refused; UC-08 a release that does not build
// is refused before anything is applied; UC-09 restart reuses the build; UC-10 start.sh without tmrkz-images.tar and with an
// unnamed Compose file; UC-11 offline map served.
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BASE = process.argv[2];
const PORT = process.argv[3] ?? '8188';
if (!BASE) throw new Error('usage: node tests/acceptance/update-center.mjs <base-dir> [port]');
const VM = join(BASE, 'vm', 'TMRKZ');
const DESK = join(BASE, 'desk', 'TMRKZ');
const URL_ = `http://localhost:${PORT}`;
const OUT = join(BASE, 'evidence');
mkdirSync(OUT, { recursive: true });
const env = Object.fromEntries(readFileSync(join(VM, '.env'), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const PW = env.TMRKZ_PLATFORM_ADMIN_PASSWORD;
const results = [];
const ok = (cond, id, label, extra = '') => {
  results.push({ id, pass: !!cond, label, extra: String(extra).slice(0, 300) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${id}  ${label}${extra ? '  — ' + String(extra).slice(0, 200) : ''}`);
};
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const tree = (dir) => {
  const out = {};
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : (out[p.slice(dir.length)] = sha(p)); } };
  if (existsSync(dir)) walk(dir);
  return JSON.stringify(out);
};
const sh = (cwd, script, extraEnv = {}) => {
  try {
    return { code: 0, out: execFileSync('sh', [script], { cwd, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
  }
};
const release = () => sh(DESK, 'ops/update/make-release.sh');
const edit = (rel, from, to) => {
  const p = join(DESK, rel);
  const s = readFileSync(p, 'utf8');
  if (!s.includes(from)) throw new Error(`fixture text not found in ${rel}`);
  writeFileSync(p, s.replace(from, to));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the release: one change of each kind, made on the «Desktop» copy ----------------------------------------------------
const stamp = Date.now().toString(36);
const LIVE = 'return Map.of("startedAt", Instant.ofEpochMilli(ManagementFactory.getRuntimeMXBean().getStartTime()).toString());';
const docAdded = `docs/UPDATE_E2E_${stamp}.md`;
writeFileSync(join(DESK, docAdded), `# اختبار مركز التحديث ${stamp}\n`);
edit('frontend/src/components/UpdateCenter.tsx', '<h2>مركز التحديث</h2>', `<h2>مركز التحديث</h2><span data-testid="update-e2e-marker">e2e-${stamp}</span>`);
edit('backend/src/main/java/ae/mover/update/UpdateService.java', LIVE, LIVE.replace('.toString());', `.toString(), "probe", "e2e-${stamp}");`));
rmSync(join(DESK, 'docs/VM_QUICK_START_AR.md'));
appendFileSync(join(DESK, 'docker-compose.override.yml'), `\n# e2e: a change of the Compose configuration ${stamp}\n`);
const made = release();
ok(made.code === 0, 'UC-00', 'make-release.sh signs the Desktop folder', made.out.split('\n')[0]);

const before = {
  env: sha(join(VM, '.env')), dc: sha(join(VM, 'docker-compose.dc-hosts.yml')), certs: tree(join(VM, 'certs')),
  trust: sha(join(VM, 'ops/local/.generated/release-trust.pub')), override: sha(join(VM, 'docker-compose.override.yml')),
  quick: sha(join(VM, 'docs/VM_QUICK_START_AR.md')), service: sha(join(VM, 'backend/src/main/java/ae/mover/update/UpdateService.java')),
};

const { chromium } = await import(pathToFileURL(join(ROOT, 'tests/acceptance/node_modules/playwright-core/index.mjs')).href);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ locale: 'ar-AE', timezoneId: 'Asia/Dubai', viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
page.on('dialog', (d) => d.accept(`رجوع اختبار ${stamp}`));
const shot = (name) => page.screenshot({ path: join(OUT, name), fullPage: false }).catch(() => {});

async function signIn() {
  for (let attempt = 1; ; attempt++) {
    await page.goto(URL_ + '/');
    await page.getByText('إدخال رقم الـــــ U وكلمة المرور يدويا').click({ timeout: 60000 });
    await page.locator('#tm-username').fill('admin');
    await page.locator('#tm-password').fill(PW);
    await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
    try {
      await page.waitForSelector('main#main', { timeout: 20000 });
      return;
    } catch (e) {
      if (attempt >= 6) throw e; // a fresh installation: the platform accounts may still be being set up
      await sleep(15000);
    }
  }
}
async function openUpdateCenter() {
  await page.getByText('إدارة النظام', { exact: true }).first().click();
  await page.locator('[data-testid=update-center]').waitFor({ timeout: 60000 });
  await page.locator('[data-testid=update-center]').scrollIntoViewIfNeeded();
}
async function stateWait(states, minutes) {
  const until = Date.now() + minutes * 60000;
  while (Date.now() < until) {
    const s = await page.locator('[data-testid=update-state]').getAttribute('data-state').catch(() => null);
    if (s && states.includes(s)) return s;
    await sleep(2000);
  }
  return page.locator('[data-testid=update-state]').getAttribute('data-state').catch(() => null);
}
async function choose(dir) {
  await page.locator('[data-testid=update-folder]').setInputFiles(dir);
  return stateWait(['COMPARED', 'REJECTED'], 5);
}
const row = (path) => page.locator(`[data-testid=update-changes] tr[data-path="${path}"]`);
const api = async (path, init) => {
  const r = await page.request.fetch(URL_ + '/api/v1' + path, { headers: { 'X-Requested-With': 'mover', 'Content-Type': 'application/json' }, ...init });
  return { status: r.status(), body: await r.json().catch(() => null) };
};
const liveness = async () => (await (await fetch(URL_ + '/api/v1/system/liveness')).json().catch(() => ({})));

try {
  await signIn();
  await openUpdateCenter();
  const workerText = async () => {
    await page.waitForFunction(() => !document.querySelector('[data-testid=update-worker]')?.textContent?.includes('التحقق من عامل'), null, { timeout: 30000 });
    return page.locator('[data-testid=update-worker]').innerText();
  };
  ok((await workerText()).includes('عامل الصيانة يعمل'), 'UC-00', 'the maintenance worker is running');
  await shot('uc-00-worker.png');

  // UC-01
  const compared = await choose(DESK);
  await shot('uc-01-compared.png');
  ok(compared === 'COMPARED', 'UC-01', 'the signed release is verified and compared', compared);
  ok(await row(docAdded).getAttribute('data-change') === 'ADDED', 'UC-01', 'a new documentation file is «مضاف»');
  ok(await row('frontend/src/components/UpdateCenter.tsx').getAttribute('data-change') === 'MODIFIED', 'UC-01', 'a frontend file is «معدّل»');
  ok(await row('backend/src/main/java/ae/mover/update/UpdateService.java').getAttribute('data-change') === 'MODIFIED', 'UC-01', 'a backend file is «معدّل»');
  ok(await row('docs/VM_QUICK_START_AR.md').getAttribute('data-change') === 'DELETED', 'UC-01', 'a file gone from the release is «محذوف»');
  const cfg = row('docker-compose.override.yml');
  ok(await cfg.getAttribute('data-change') === 'MODIFIED' && !(await cfg.locator('input').isChecked()), 'UC-01',
    'the Compose change is shown, not selected (explicit choice only)');
  const paths = await page.locator('[data-testid=update-changes] tr[data-path]').evaluateAll((rs) => rs.map((r) => r.getAttribute('data-path')));
  ok(!paths.some((p) => /^(\.env|data\/|certs\/|map-|backups\/|ops\/local\/\.generated|release\/|docker-compose\.dc-hosts)/.test(p)), 'UC-04',
    'no protected or machine-specific path is even listed', paths.length + ' rows');

  // UC-02
  const uploadText = await page.locator('[data-testid=update-upload]').innerText();
  await page.locator('[data-testid=update-upload]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=update-upload]')?.textContent?.includes('(0)'), null, { timeout: 120000 });
  ok(/\((3)\)/.test(uploadText), 'UC-02', 'only the three differing files are uploaded (not the 800+ unchanged)', uploadText);

  // UC-03
  const startedBefore = (await liveness()).startedAt;
  await page.locator('[data-testid=update-reason]').fill(`اختبار التحديث ${stamp}`);
  await shot('uc-02-ready.png');
  await page.locator('[data-testid=update-approve]').click();
  const done = await stateWait(['DONE', 'DONE_RESTART_REQUIRED', 'FAILED_ROLLED_BACK', 'REJECTED', 'ERROR'], 30);
  await shot('uc-03-applied.png');
  const progress = await page.locator('[data-testid=update-progress]').innerText().catch(() => '');
  writeFileSync(join(OUT, 'uc-03-progress.txt'), progress);
  ok(done === 'DONE', 'UC-03', 'approved → built offline → backed up → applied → verified', done);
  const live = await liveness();
  ok(live.probe === `e2e-${stamp}` && live.startedAt !== startedBefore, 'UC-03', 'the backend runs the new build', JSON.stringify(live));
  await page.reload();
  await page.waitForSelector('main#main', { timeout: 60000 });
  await openUpdateCenter();
  ok(await page.locator('[data-testid=update-e2e-marker]').innerText().catch(() => '') === `e2e-${stamp}`, 'UC-03', 'the web runs the new build');
  ok((await workerText()).includes('عامل الصيانة يعمل'), 'UC-03', 'the worker still reports alive right after a long update');
  ok(existsSync(join(VM, docAdded)) && !existsSync(join(VM, 'docs/VM_QUICK_START_AR.md')), 'UC-03', 'added and deleted files applied');

  // UC-04
  ok(sha(join(VM, '.env')) === before.env && sha(join(VM, 'docker-compose.dc-hosts.yml')) === before.dc && tree(join(VM, 'certs')) === before.certs
    && sha(join(VM, 'ops/local/.generated/release-trust.pub')) === before.trust, 'UC-04', '.env, the VM Compose file, certificates and the trust key are untouched');
  ok(sha(join(VM, 'docker-compose.override.yml')) === before.override, 'UC-04', 'the unselected Compose change was not applied');
  const backups = readdirSync(join(VM, 'backups', 'updates')).filter((n) => /^\d{8}T/.test(n));
  const bdir = join(VM, 'backups', 'updates', backups.sort().at(-1) ?? '');
  ok(existsSync(join(bdir, 'before', 'backend/src/main/java/ae/mover/update/UpdateService.java'))
    && sha(join(bdir, 'before', 'backend/src/main/java/ae/mover/update/UpdateService.java')) === before.service
    && existsSync(join(bdir, 'before', 'docs/VM_QUICK_START_AR.md')), 'UC-04', 'every replaced or deleted file was backed up first', bdir);

  // UC-05
  await sleep(40000); // the outcome is audited by the backend's scan (every 15 s)
  const audit = await api('/audit-events?size=50');
  const actions = JSON.stringify(audit.body ?? {});
  ok(actions.includes('UPDATE_APPROVED') && actions.includes('UPDATE_DONE') && actions.includes('UPDATE_RECEIVED'), 'UC-05',
    'received, approved and done are in the audit log', audit.status);

  // UC-06
  const startedApplied = (await liveness()).startedAt;
  await page.locator('[data-testid=update-history-row]').first().getByRole('button', { name: 'عرض' }).click();
  await page.locator('[data-testid=update-rollback]').click();
  const back = await stateWait(['ROLLED_BACK', 'ERROR'], 30);
  await shot('uc-06-rolled-back.png');
  const live2 = await liveness();
  ok(back === 'ROLLED_BACK' && !live2.probe && live2.startedAt !== startedApplied, 'UC-06', 'rollback restores the previous backend', back + ' ' + JSON.stringify(live2));
  ok(!existsSync(join(VM, docAdded)) && sha(join(VM, 'docs/VM_QUICK_START_AR.md')) === before.quick
    && sha(join(VM, 'backend/src/main/java/ae/mover/update/UpdateService.java')) === before.service, 'UC-06', 'rollback restores the files exactly');

  // UC-07 refusals: a signature from another key; protected paths in a validly signed manifest; a file changed after signing
  const rel = readFileSync(join(DESK, 'release/RELEASE.json'), 'utf8');
  const man = readFileSync(join(DESK, 'release/MANIFEST.tsv'), 'utf8');
  const other = execFileSync('openssl', ['genpkey', '-algorithm', 'ed25519'], { encoding: 'utf8' });
  const badSig = sign(null, Buffer.from(rel), createPrivateKey(other)).toString('base64');
  const s1 = await api('/updates/sessions', { method: 'POST', data: { release: rel, signature: badSig, manifest: man } });
  let st = null;
  for (let i = 0; i < 30 && !['REJECTED', 'COMPARED'].includes(st); i++) { await sleep(1000); st = (await api('/updates/sessions/' + s1.body.id)).body?.state; }
  ok(st === 'REJECTED', 'UC-07', 'a release signed by another key is rejected', st);
  const z = '0'.repeat(64);
  const evil = ['.env', 'data/db/PG_VERSION', 'certs/vm-test.pem', 'ops/local/.generated/release-trust.pub', 'docker-compose.dc-hosts.yml', '../outside.txt', 'map-runtime/x']
    .map((p) => `app\t${z}\t1\t${p}`).join('\n') + '\n';
  const evilRel = JSON.stringify({ format: 1, release: `evil-${stamp}`, manifestSha256: createHash('sha256').update(evil).digest('hex') }) + '\n';
  const key = readFileSync(join(DESK, 'ops/local/.generated/release-signing.key'), 'utf8');
  const s2 = await api('/updates/sessions', { method: 'POST', data: { release: evilRel, signature: sign(null, Buffer.from(evilRel), createPrivateKey(key)).toString('base64'), manifest: evil } });
  let v2 = null;
  for (let i = 0; i < 30 && v2?.state !== 'COMPARED' && v2?.state !== 'REJECTED'; i++) { await sleep(1000); v2 = (await api('/updates/sessions/' + s2.body.id)).body; }
  const ch = v2?.compare?.changes ?? [];
  const listed = ch.filter((c) => c.change !== 'DELETED');
  ok(v2?.state === 'COMPARED' && listed.length === 7 && listed.every((c) => c.blocked), 'UC-07', 'protected paths in a signed release are all blocked',
    listed.map((c) => c.path).join(','));
  const dels = ch.filter((c) => c.change === 'DELETED');
  ok(dels.length > 50 && dels.every((c) => c.flags.includes('MASS_DELETION')), 'UC-07',
    'a release that would delete most of the installation is flagged and never deletes by default', dels.length + ' deletions');
  const s2a = await api(`/updates/sessions/${s2.body.id}/approve`, { method: 'POST', data: { paths: ['.env'], reason: 'محاولة' } });
  ok(s2a.status === 400, 'UC-07', 'approving a blocked path is refused', s2a.status);
  appendFileSync(join(DESK, docAdded), 'changed after signing\n');
  await choose(DESK);
  ok((await row(docAdded).innerText()).includes('تغير بعد التوقيع') && await row(docAdded).locator('input').isDisabled(), 'UC-07',
    'a file changed after signing cannot be selected or uploaded');
  await shot('uc-07-tampered.png');

  // UC-08 a release whose backend does not build: refused before anything is applied
  edit('backend/src/main/java/ae/mover/update/UpdateService.java', `"probe", "e2e-${stamp}");`, `"probe", "e2e-${stamp}") COMPILE_ERROR;`);
  release();
  await choose(DESK);
  await page.locator('[data-testid=update-upload]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=update-upload]')?.textContent?.includes('(0)'), null, { timeout: 120000 });
  const serviceBefore = sha(join(VM, 'backend/src/main/java/ae/mover/update/UpdateService.java'));
  const startedBroken = (await liveness()).startedAt;
  await page.locator('[data-testid=update-reason]').fill('إصدار لا يُبنى');
  await page.locator('[data-testid=update-approve]').click();
  const refused = await stateWait(['REJECTED', 'DONE', 'FAILED_ROLLED_BACK'], 30);
  await shot('uc-08-build-refused.png');
  ok(refused === 'REJECTED' && (await page.locator('[data-testid=update-message]').innerText()).includes('لا يُبنى'), 'UC-08',
    'a release that does not build with the existing libraries is refused', refused);
  ok(sha(join(VM, 'backend/src/main/java/ae/mover/update/UpdateService.java')) === serviceBefore && (await liveness()).startedAt === startedBroken,
    'UC-08', 'nothing was applied and the backend was not restarted');

  // UC-09 restart reuses the last build
  const r9 = execFileSync('docker', ['compose', 'restart', 'backend'], { cwd: VM, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { await sleep(2000); up = (await fetch(URL_ + '/api/v1/auth/status').catch(() => ({ status: 0 }))).status === 200; }
  const logs = execFileSync('docker', ['compose', 'logs', '--since', '5m', 'backend'], { cwd: VM, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  ok(up && logs.includes('has not changed since the last build'), 'UC-09', 'a restart starts the last build without rebuilding', r9.trim());

  // UC-10 start.sh: no tmrkz-images.tar needed; an extra Compose file not named in COMPOSE_FILE stops it
  const s10 = sh(VM, 'start.sh', { TMRKZ_IP: 'localhost', TMRKZ_PORT: PORT });
  ok(s10.code === 0 && s10.out.includes('tmrkz-images.tar not needed') && !existsSync(join(VM, 'tmrkz-images.tar')), 'UC-10',
    'start.sh starts with the loaded images and no archive', s10.out.split('\n').filter((l) => l.includes('images')).join(' '));
  const envText = readFileSync(join(VM, '.env'), 'utf8');
  writeFileSync(join(VM, '.env'), envText.split('\n').filter((l) => !l.startsWith('COMPOSE_FILE=')).join('\n'));
  const s10b = sh(VM, 'start.sh', { TMRKZ_IP: 'localhost', TMRKZ_PORT: PORT });
  writeFileSync(join(VM, '.env'), envText);
  ok(s10b.code === 2 && s10b.out.includes('docker-compose.dc-hosts.yml') && s10b.out.includes('COMPOSE_FILE'), 'UC-10',
    'an extra Compose file is never silently left out', s10b.out.split('\n').find((l) => l.includes('dc-hosts')));
  ok(sha(join(VM, 'docker-compose.dc-hosts.yml')) === before.dc, 'UC-10', 'the VM Compose file still untouched');

  // UC-11 offline map
  const m = await fetch(URL_ + '/map-data/manifest.json').catch(() => ({ status: 0 }));
  ok(m.status === 200, 'UC-11', 'the offline map package is served', m.status);
} catch (e) {
  ok(false, 'UC-XX', 'unexpected error', e.stack);
  await shot('uc-error.png');
} finally {
  await browser.close();
  writeFileSync(join(OUT, 'results.json'), JSON.stringify({ stamp, results }, null, 2));
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed — evidence in ${OUT}`);
  process.exit(failed ? 1 : 0);
}
