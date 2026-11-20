//   node tests/acceptance/integration-settings.mjs   (BROWSER_PATH=… for a machine without Edge; SETTINGS_ROUTE defaults to /#settings)
// Smoke check of «إعدادات التكامل» on :8088 (ADR-092): the platform administrator opens the settings, both sections render,
// «اختبار الاتصال» of the directory section reaches the local stand-in directory (StartTLS, CA pasted, service bind), and the
// Keycloak section's test reaches the local realm's discovery document. Nothing is saved: :8088 keeps its configuration.
import { mkdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BASE = process.env.MOVER_URL ?? 'http://127.0.0.1:8088';
const OUT = ROOT + 'docs/evidence/integration-settings/';
mkdirSync(OUT, { recursive: true });
const { chromium } = await import(pathToFileURL(ROOT + 'tests/acceptance/node_modules/playwright-core/index.mjs').href);
const env = readFileSync(ROOT + '.env', 'utf8');
const val = (k) => (env.match(new RegExp('^' + k + '=(.*)$', 'm')) ?? [])[1]?.trim().replace(/^['"]|['"]$/g, '') ?? '';
const route = process.env.SETTINGS_ROUTE ?? '/#settings';

const signIn = async (username, password) => {
  const r = await fetch(BASE + '/api/v1/auth/directory/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mover' }, body: JSON.stringify({ username, password }) });
  if (r.status !== 200) throw new Error(`${username} sign-in ${r.status}`);
  return r.headers.getSetCookie().map((c) => c.split(';')[0]).map((c) => ({ name: c.slice(0, c.indexOf('=')), value: c.slice(c.indexOf('=') + 1), url: BASE }));
};
const admin = await signIn('admin', val('TMRKZ_PLATFORM_ADMIN_PASSWORD'));
const results = [];
const ok = (pass, what, detail = '') => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'} ${what}${detail ? ' · ' + detail : ''}`); };

const browser = await chromium.launch(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH, headless: true } : { channel: 'msedge', headless: true });
const ctx = await browser.newContext({ locale: 'ar-AE', timezoneId: 'Asia/Dubai', viewport: { width: 1440, height: 1000 } });
await ctx.addCookies(admin);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|401|403|404/.test(m.text())) errors.push(m.text()); });
await page.goto(BASE + route, { waitUntil: 'networkidle' });
const dir = page.getByTestId('integration-directory');
const kc = page.getByTestId('integration-oidc');
await dir.waitFor({ timeout: 20000 });
ok(await dir.isVisible(), 'INT-UI-01 the directory section is on «إعدادات النظام»');
ok(await kc.isVisible(), 'INT-UI-02 the Keycloak section is on «إعدادات النظام»');
ok((await dir.locator('.pill').first().innerText()).includes('ملف البيئة') || (await dir.locator('.pill').first().innerText()).includes('غير'), 'INT-UI-03 the directory section states its source (nothing saved yet)', await dir.locator('.pill').first().innerText());
await dir.scrollIntoViewIfNeeded();
await page.screenshot({ path: OUT + '01-settings-before.png', fullPage: false });

// the stand-in directory, exactly as .env names it, entered on the screen; tested, not saved
const fill = async (section, label, value) => {
  const input = section.locator('label.field', { hasText: label }).locator('input, textarea').first();
  await input.fill(value);
};
await fill(dir, 'خادم الدليل', 'openldap');
await dir.locator('select').first().selectOption('starttls');
await fill(dir, 'المنفذ', '389');
await fill(dir, 'قاعدة البحث', 'dc=tmrkz,dc=local');
await fill(dir, 'حساب الخدمة', 'cn=admin,dc=tmrkz,dc=local');
await fill(dir, 'كلمة مرور حساب الخدمة', val('LOCAL_LDAP_ADMIN_PASSWORD'));
await dir.locator('summary').click();
await dir.getByRole('button', { name: /دليل قياسي/ }).click();
await fill(dir, 'شهادة الجهة المصدرة', readFileSync(ROOT + 'ops/local/.generated/certs/ca.crt', 'utf8'));
const derived = await dir.getByTestId('directory-derived').innerText();
ok(derived.includes('ldap://openldap:389') && derived.includes('حساب الخدمة'), 'INT-UI-04 the derived address and bind description follow the form', derived.replace(/\s+/g, ' ').slice(0, 120));
await dir.getByRole('button', { name: 'اختبار الاتصال' }).click();
const dirResult = dir.getByTestId('directory-test-result');
await dirResult.waitFor({ timeout: 30000 });
const dirText = await dirResult.innerText();
ok(!(await dirResult.evaluate((e) => e.classList.contains('red'))) && /نجح/.test(dirText), 'INT-UI-05 «اختبار الاتصال» reaches the stand-in directory over StartTLS with the pasted CA and binds the service account', dirText.replace(/\s+/g, ' ').slice(0, 140));
await page.screenshot({ path: OUT + '02-directory-test.png', fullPage: false });

// a wrong password is named as such (the secured channel itself fine)
await fill(dir, 'كلمة مرور حساب الخدمة', 'not-the-password');
await dir.getByRole('button', { name: 'اختبار الاتصال' }).click();
await dirResult.waitFor({ timeout: 30000 });
const wrongText = await dirResult.innerText();
ok((await dirResult.evaluate((e) => e.classList.contains('red'))) && /رفض الدليل/.test(wrongText), 'INT-UI-06 a wrong service password is reported as refused credentials, not as an unreachable directory', wrongText.replace(/\s+/g, ' ').slice(0, 120));

// the local Keycloak entered as MOVER would enter an enterprise one; tested, not saved
await kc.scrollIntoViewIfNeeded();
await fill(kc, 'عنوان خادم Keycloak', BASE + '/auth');
await fill(kc, 'المجال', 'tmrkz');
await fill(kc, 'معرّف العميل', 'tmrkz-web');
await fill(kc, 'سر العميل', val('TMRKZ_OIDC_CLIENT_SECRET'));
await fill(kc, 'العنوان الداخلي', 'http://keycloak:8080/auth');
const issuer = await kc.getByTestId('oidc-derived').innerText();
ok(issuer.includes(BASE + '/auth/realms/tmrkz'), 'INT-UI-07 the expected issuer is <server>/realms/<realm>', issuer.replace(/\s+/g, ' '));
await kc.getByRole('button', { name: 'اختبار الاتصال' }).click();
const kcResult = kc.getByTestId('oidc-test-result');
await kcResult.waitFor({ timeout: 30000 });
const kcText = await kcResult.innerText();
ok(!(await kcResult.evaluate((e) => e.classList.contains('red'))) && /نجح/.test(kcText), 'INT-UI-08 the Keycloak test reads the realm\'s discovery document over the internal address, the issuer matches, keys read', kcText.replace(/\s+/g, ' ').slice(0, 140));
await page.screenshot({ path: OUT + '03-keycloak-test.png', fullPage: false });

// nothing was saved
const view = await (await fetch(BASE + '/api/v1/settings/integration/directory', { headers: { Cookie: admin.map((c) => `${c.name}=${c.value}`).join('; '), 'X-Requested-With': 'mover' } })).json();
ok(view.saved === null, 'INT-UI-09 a test saves nothing', 'source=' + view.source);
ok(errors.length === 0, 'INT-UI-10 no page error', errors.join(' | ').slice(0, 200));
await browser.close();
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
