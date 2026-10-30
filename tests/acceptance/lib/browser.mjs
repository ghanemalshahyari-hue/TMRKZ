// Shared helpers for browser acceptance tests against the acceptance environment (ops/test-env).
// Uses the locally installed Microsoft Edge through playwright-core: no browser download, no external service.
// Every page request outside localhost is aborted and recorded, so a journey that needed the internet fails.
import { readFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

export const BASE = process.env.MOVER_URL ?? 'http://localhost:8088';
export const PASSWORD =
  process.env.TMRKZ_TEST_PASSWORD ??
  (() => {
    try {
      return readFileSync(new URL('../../../ops/test-env/.generated/user-password', import.meta.url), 'utf8').trim();
    } catch {
      console.error('Start the test environment first (sh ops/test-env/up.sh) or set TMRKZ_TEST_PASSWORD.');
      process.exit(2);
    }
  })();

export const external = [];
export const consoleErrors = [];

export async function launch() {
  // HEADED=1 shows the windows; SLOWMO=<ms> slows each action so a person can follow it
  return chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'msedge', headless: process.env.HEADED ? false : true, slowMo: Number(process.env.SLOWMO ?? 0) });
}

/** A fresh browser profile (one person). External requests are blocked and recorded. */
export async function newContext(browser, opts = {}) {
  const ctx = await browser.newContext({ locale: 'ar-AE', timezoneId: 'Asia/Dubai', viewport: { width: 1440, height: 900 }, ...opts });
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (!['localhost', '127.0.0.1'].includes(u.hostname) && !u.protocol.startsWith('data') && !u.protocol.startsWith('blob')) {
      external.push(u.href);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  return ctx;
}

let serverErrorsExpected = false;
/** While a test injects server failures on purpose, the browser's resulting 500 messages are not application errors. */
export function expectServerErrors(on) {
  serverErrorsExpected = on;
}

export function watch(page, who) {
  page.on('console', (m) => {
    if (m.type() !== 'error' || /favicon|401|403|404|409|400|ERR_ABORTED/.test(m.text())) return;
    if (serverErrorsExpected && /500/.test(m.text())) return;
    consoleErrors.push(who + ': ' + m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(who + ' pageerror: ' + e.message));
}

/** Automatic path: TMRKZ → Keycloak sign-in page (TMRKZ theme) → directory → TMRKZ. Nothing is injected. */
export async function signInAutomatic(page, user) {
  await page.goto(BASE + '/');
  await page.getByText('الدخول الآلي بالحساب المؤسسي').click();
  await page.locator('#username').fill(user);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('#kc-login').click();
  await page.waitForSelector('.app-shell', { timeout: 30000 });
}

/** Manual path of the same sign-in page: username and password checked by the directory. */
export async function signInManual(page, user) {
  await page.goto(BASE + '/');
  await page.getByText('إدخال اسم المستخدم وكلمة المرور يدوياً').click();
  await page.locator('#tm-username').fill(user);
  await page.locator('#tm-password').fill(PASSWORD);
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
  await page.waitForSelector('.app-shell', { timeout: 30000 });
}

/** API session for test-data setup only (reported separately from browser steps). */
export async function apiSession(user) {
  const res = await fetch(BASE + '/api/v1/auth/directory/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mover' },
    body: JSON.stringify({ username: user, password: PASSWORD }),
  });
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('MOVER_SESSION='))?.split(';')[0];
  if (!cookie) throw new Error('setup sign-in failed for ' + user + ': ' + res.status);
  const call = async (method, path, body) => {
    const r = await fetch(BASE + '/api/v1' + path, {
      method,
      headers: { Cookie: cookie, Accept: 'application/json', ...(method !== 'GET' ? { 'X-Requested-With': 'mover', 'Content-Type': 'application/json' } : {}), ...(body?.__key ? { 'Idempotency-Key': body.__key } : {}) },
      body: body ? JSON.stringify(Object.fromEntries(Object.entries(body).filter(([k]) => k !== '__key'))) : undefined,
    });
    const text = await r.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: r.status, body: json };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), patch: (p, b) => call('PATCH', p, b), cookie };
}

export function evidenceDir() {
  const dir = new URL('../../../docs/evidence/map/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Minimal ZIP writer (stored entries + CRC-32), enough to build a map package in the test without dependencies. */
export function zip(files) {
  const table = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = Buffer.from(name, 'utf8');
    const d = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const crc = crc32(d);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(d.length, 18);
    local.writeUInt32LE(d.length, 22);
    local.writeUInt16LE(n.length, 26);
    parts.push(local, n, d);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(d.length, 20);
    c.writeUInt32LE(d.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length + d.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
