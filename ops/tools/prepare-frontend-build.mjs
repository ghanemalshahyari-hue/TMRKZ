// Prepare a clean Docker build context for the organizational-hierarchy restoration.
// Run on the current source host or an authorized connected build host. It performs no build/deploy and reads no secrets.
// The only text substitutions are the three previously approved login labels; the map-serving file is preserved as-is.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, openSync, closeSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
if (!process.env.TMRKZ_ALLOW_FRONTEND_PREP) {
  console.error('Read the source/change review, then set TMRKZ_ALLOW_FRONTEND_PREP=yes for an authorized source export.');
  process.exit(2);
}
const command = (name, args, input) => {
  const result = spawnSync(name, args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, input });
  if (result.status !== 0) throw new Error(`${name} failed: ${result.stderr}`);
  return result.stdout;
};
const git = (args) => command('git', ['-c', `safe.directory=${ROOT}`, '-C', ROOT, ...args]);
const revision = git(['rev-parse', 'HEAD']).trim();
const sourceDate = git(['show', '-s', '--format=%cI', revision]).trim();
if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('Source revision is not an immutable commit');

const out = mkdtempSync(join(process.env.TMRKZ_FRONTEND_EXPORT_ROOT || tmpdir(), 'tmrkz-web-source-'));
const context = join(out, 'context');
mkdirSync(context, { recursive: true });
const archiveResult = spawnSync('git', ['-c', `safe.directory=${ROOT}`, '-C', ROOT, 'archive', '--format=tar', revision, 'frontend', 'docs', 'handoff'], {
  encoding: 'buffer', maxBuffer: 512 * 1024 * 1024,
});
if (archiveResult.status !== 0) throw new Error(`git archive failed: ${archiveResult.stderr.toString('utf8')}`);
command('tar', ['-xf', '-', '-C', context], archiveResult.stdout);
// `git archive` intentionally excludes untracked active-session evidence, credentials and runtime state.
for (const forbidden of ['.env', '.git', 'docs/audit/enterprise-launch', 'frontend/node_modules', 'frontend/dist']) {
  if (existsSync(join(context, forbidden))) throw new Error(`Forbidden build-context input present: ${forbidden}`);
}

const loginPath = join(context, 'frontend/src/pages/LoginPage.tsx');
let login = readFileSync(loginPath, 'utf8');
const substitutions = [
  ['الدخول الآلي بالحساب المؤسسي', 'الدخول الآلي برقم الــــ U'],
  ['إدخال اسم المستخدم وكلمة المرور يدوياً', 'إدخال رقم الـــــ U وكلمة المرور يدويا'],
  ['العودة إلى خيارات الدخول', 'العودة لخيارات الدخول'],
];
for (const [from, to] of substitutions) {
  if (login.split(from).length !== 2) throw new Error(`Approved login label source must occur exactly once: ${from}`);
  login = login.replace(from, to);
}
writeFileSync(loginPath, login);
const treeSource = readFileSync(join(context, 'frontend/src/pages/OrgPage.tsx'), 'utf8');
if (!treeSource.includes('<UnitTree') || !treeSource.includes('openSingleRoot') || !treeSource.includes('org-page-tree')) {
  throw new Error('The exported baseline does not contain the shared collapsible OrgPage tree');
}
if (!existsSync(join(context, 'frontend/src/components/tree/UnitTree.tsx'))) throw new Error('Shared UnitTree is missing');

// Map access is an independent accepted correction; it is not a text edit inside a built static asset.
const mapConfig = join(ROOT, 'frontend/nginx.conf');
const mapOverride = join(ROOT, 'docker-compose.yml');
copyFileSync(mapConfig, join(context, 'frontend/nginx.conf'));
if (!existsSync(mapOverride)) throw new Error('The canonical Compose configuration is missing');

const envText = existsSync(join(ROOT, '.env')) ? readFileSync(join(ROOT, '.env'), 'utf8') : '';
const flag = (key, fallback = false) => {
  const match = envText.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? match[1].trim() === 'true' : fallback;
};
const buildArgs = { STATIONING_V3: flag('TMRKZ_STATIONING_V3'), FLOW_STUDIO_UI: flag('TMRKZ_FLOW_STUDIO_UI') };
const hash = (body) => createHash('sha256').update(body).digest('hex');
const fileHash = (path) => hash(readFileSync(path));
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const info = statSync(path);
    if (info.isDirectory()) walk(path);
    else files.push({ path: relative(context, path), sha256: fileHash(path), bytes: info.size });
  }
};
walk(context);
const mapHash = fileHash(mapConfig);
const exportedMap = files.find((f) => f.path === 'frontend/nginx.conf');
if (!exportedMap || exportedMap.sha256 !== mapHash) throw new Error('Map Nginx preservation differs from the reviewed working file');
const args = Object.entries(buildArgs).flatMap(([key, value]) => ['--build-arg', `${key}=${value}`]);
const buildPackage = join(out, 'frontend-build-context.tar.gz');
command('tar', ['-czf', buildPackage, '-C', context, '.']);
const manifest = {
  kind: 'tmrkz-reviewed-frontend-build-context', version: 1,
  sourceRevision: revision, sourceDate,
  purpose: 'Restore the existing shared collapsible UnitTree on #org through a proper source build, not a static-artifact patch.',
  selectedChanges: [
    'Use the baseline OrgPage UnitTree and tree styles already present in this revision.',
    'Apply only the three previously approved exact login-label substitutions to frontend/src/pages/LoginPage.tsx.',
    'Preserve the reviewed frontend/nginx.conf map-delivery configuration byte-identically.',
    'Include only the revision-controlled frontend/docs/handoff tree; untracked active-session materials are excluded.',
  ],
  loginLabels: substitutions.map(([from, to]) => ({ from, to })),
  buildArgs,
  mapServing: { nginxSha256: mapHash, composeMapAccessSha256: fileHash(mapOverride), mountPolicy: 'read-only' },
  package: { file: buildPackage, sha256: fileHash(buildPackage), fileCount: files.length, files },
  build: { command: ['docker', 'build', '-f', 'frontend/Dockerfile', ...args, '.'], cwd: 'extracted-context-root' },
  notExecutedHere: 'This preparation does not build, deploy, contact an external provider or read .env secret values.',
};
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ result: 'PREPARED', revision, package: buildPackage, sha256: manifest.package.sha256,
  manifest: join(out, 'manifest.json'), fileCount: files.length, buildArgs, databaseChanges: false, builtOrDeployed: false }, null, 2));
