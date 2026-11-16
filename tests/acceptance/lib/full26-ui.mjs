// FULL END-TO-END ACCEPTANCE (16 Nov 2026) — shared helpers for the headless browser on http://localhost:8088 only.
// Every person is a real session: full26.uNN signs in through TMRKZ → Keycloak → the stand-in directory (lib/full26.mjs), the
// administrator's cookies are borrowed read-only from the owner's Edge (lib/full26-admin.mjs). Requests leaving localhost are
// aborted and recorded (the acceptance must work offline). Screens go to docs/evidence/full-acceptance (fictional data only),
// anything private to the git-ignored ops/acceptance-main/.generated/evidence, videos to ops/acceptance-main/.generated/videos.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, renameSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const ROOT = process.env.TMRKZ_ROOT ?? 'C:/Users/ADMIN/Desktop/TMRKZ';
export const BASE = 'http://localhost:8088';
export const DOCS = `${ROOT}/docs/evidence/full-acceptance/`;
export const PRIVATE = `${ROOT}/ops/acceptance-main/.generated/evidence/`;
export const VIDEOS = `${ROOT}/ops/acceptance-main/.generated/videos/`;
for (const d of [DOCS, PRIVATE, VIDEOS]) mkdirSync(d, { recursive: true });

const { chromium } = await import(pathToFileURL(`${ROOT}/tests/acceptance/node_modules/playwright-core/index.mjs`).href);
const { signIn } = await import(pathToFileURL(`${ROOT}/tests/acceptance/lib/full26.mjs`).href);
const { adminSession } = await import(pathToFileURL(`${ROOT}/tests/acceptance/lib/full26-admin.mjs`).href);

export const LABEL = 'ACCEPTANCE ONLY — OWNER DECISION PENDING';
export const external = [];
export const consoleErrors = [];

export const sql = (q) =>
  execFileSync('docker', ['exec', 'tmrkz-mover-db-1', 'sh', '-c', `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -q -Atc "${q.replaceAll('"', '\\"')}"`], { encoding: 'utf8' }).trim();

/** Results of one phase, appended to a JSON-lines file so every phase adds to the same record. */
export function recorder(phase) {
  const file = `${PRIVATE}results.jsonl`;
  return (pass, id, what, detail = '') => {
    const line = { at: new Date().toISOString(), phase, id, pass: !!pass, what, detail: String(detail).slice(0, 600) };
    appendFileSync(file, JSON.stringify(line) + '\n');
    console.log(`${pass ? 'PASS' : 'FAIL'} ${id} — ${what}${detail ? ' · ' + String(detail).slice(0, 260) : ''}`);
    return !!pass;
  };
}

export async function launch() {
  return chromium.launch({ channel: 'msedge', headless: true });
}

const sessions = new Map();
/** A session for an account: 'admin' (borrowed) or a full26 login (real sign-in). Cached per run. */
export async function session(login) {
  if (!sessions.has(login)) sessions.set(login, login === 'admin' ? await adminSession(ROOT) : await signIn(login));
  return sessions.get(login);
}

/** A headless context signed in as `login`; with `video` the context records into VIDEOS (named when the page closes). */
export async function contextFor(browser, login, { video = null, viewport = { width: 1440, height: 900 } } = {}) {
  const s = await session(login);
  const ctx = await browser.newContext({
    locale: 'ar-AE', timezoneId: 'Asia/Dubai', viewport,
    ...(video ? { recordVideo: { dir: VIDEOS, size: { width: 1280, height: 800 } } } : {}),
  });
  await ctx.addCookies(s.cookies);
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (!['localhost', '127.0.0.1'].includes(u.hostname) && !u.protocol.startsWith('data') && !u.protocol.startsWith('blob')) {
      external.push(u.href);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|401|403|404|409|400|ERR_ABORTED/.test(m.text())) consoleErrors.push(login + ': ' + m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(login + ' pageerror: ' + e.message));
  page.on('dialog', (d) => d.accept(page.__dialogAnswer ?? 'ACCEPTANCE ONLY — OWNER DECISION PENDING'));
  page.__video = video;
  return page;
}

/** Closes the page's context; a recorded video is moved to VIDEOS/<name>.webm. */
export async function closePage(page) {
  const v = page.video();
  const name = page.__video;
  await page.context().close();
  if (v && name) {
    const p = await v.path();
    try { renameSync(p, `${VIDEOS}${name}.webm`); } catch { /* keep the generated name */ }
  }
}

export async function go(page, hash) {
  await page.goto(BASE + '/' + hash);
  await page.waitForSelector('main#main', { timeout: 30000 });
  await page.waitForTimeout(1200);
}

/** A screenshot: public (docs) only when it shows fictional data; `private: true` keeps it out of Git. */
export async function shot(page, name, { private: hidden = false, full = false } = {}) {
  const path = (hidden ? PRIVATE : DOCS) + name;
  await page.screenshot({ path, fullPage: full });
  return path;
}

export const button = (page, name) => page.getByRole('button', { name, exact: true });

/** MOVER-style visibility on the current page: the buttons that must be there and those that must not. */
export async function buttons(page, yes, no) {
  const has = {};
  for (const n of [...yes, ...no]) has[n] = (await button(page, n).count()) > 0;
  return [...yes.filter((n) => !has[n]).map((n) => 'ناقص: ' + n), ...no.filter((n) => has[n]).map((n) => 'زائد: ' + n)];
}

export const unitId = (name) => sql(`select id from organization where name = '${name}' and status = 'ACTIVE'`);
export const personId = (login) => sql(`select id from person where username = '${login}'`);
