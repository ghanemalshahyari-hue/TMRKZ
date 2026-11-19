// Focused sign-in route checks against the existing application at :8088.
// No injected identity, demo role switch, real employee password or intermediate test realm is used.
// External enterprise SSO is reported separately from the retained local-Keycloak development profile.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { BASE, launch, newContext, watch, external, consoleErrors } from './lib/browser.mjs';

const fail = (condition, message) => {
  if (!condition) throw new Error(message);
};
const checks = [];
const pass = (name, detail) => {
  checks.push({ name, detail, status: 'PASS' });
  console.log('PASS', name, '—', detail);
};

const readLocalAdminPassword = () => {
  const values = Object.fromEntries(
    readFileSync(new URL('../../.env', import.meta.url), 'utf8')
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')];
      }),
  );
  fail(values.TMRKZ_PLATFORM_ADMIN_PASSWORD, 'Local test admin password is not configured');
  return values.TMRKZ_PLATFORM_ADMIN_PASSWORD;
};

const environment = Object.fromEntries(
  readFileSync(new URL('../../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')];
    }),
);
const profileKeys = [
  'TMRKZ_ENTERPRISE_OIDC_ISSUER',
  'TMRKZ_ENTERPRISE_OIDC_INTERNAL_URL',
  'TMRKZ_ENTERPRISE_OIDC_CLIENT_ID',
  'TMRKZ_ENTERPRISE_OIDC_CLIENT_SECRET',
];
const missingProfileKeys = profileKeys.filter((key) => !environment[key]);

const outputDir = new URL('../../docs/evidence/sign-in-routing/', import.meta.url);
mkdirSync(outputDir, { recursive: true });
const browser = await launch();
try {
  {
    const context = await newContext(browser);
    try {
      const page = await context.newPage();
      watch(page, 'manual-direct-LDAP');
      const requests = [];
      page.on('request', (request) => requests.push({ url: request.url(), method: request.method() }));
      await page.goto(BASE + '/');

      const ghost = page.getByRole('button', { name: 'إدخال رقم الـــــ U وكلمة المرور يدويا', exact: true });
      fail(await ghost.count() === 1, 'Expected the direct-manual ghost control');
      await ghost.click();
      await page.locator('#tm-username').waitFor({ state: 'visible' });
      await page.locator('#tm-password').waitFor({ state: 'visible' });
      fail(!requests.some((request) => request.method === 'POST'), 'Opening manual form must not authenticate');
      pass('manual-choice-is-form-only', 'tm-ghost opens username/password fields without a login request');

      const automatic = page.locator('a.tm-submit[href^="/api/v1/auth/oidc/start"]');
      fail(await automatic.count() === 1, 'Expected exactly one automatic OIDC link');
      await automatic.click({ trial: true });
      fail(requests.filter((request) => request.url.includes('/api/v1/auth/oidc/start')).length === 0,
        'A trial link check must not start OIDC or require an enterprise redirect');
      pass('automatic-link-is-oidc', 'The automatic tm-submit link targets the existing /auth/oidc/start handler');

      const attemptsBeforeSubmit = requests.length;
      await page.locator('#tm-username').fill('tlsprobe-' + randomUUID());
      await page.locator('#tm-password').fill(randomUUID() + randomUUID());
      const [response] = await Promise.all([
        page.waitForResponse((response) => response.url().endsWith('/api/v1/auth/directory/login')
          && response.request().method() === 'POST', { timeout: 30000 }),
        page.getByRole('button', { name: 'تسجيل الدخول', exact: true }).click(),
      ]);
      const answer = await response.json();
      fail(response.status() === 401 && answer.code === 'IDENTITY_SIGN_IN_FAILED',
        `Synthetic enterprise user must be refused by LDAP, got ${response.status()} ${answer.code}`);
      fail(!requests.slice(attemptsBeforeSubmit).some((request) => request.url.includes('/api/v1/auth/oidc/')
        || request.url.includes('/auth/realms/')), 'Manual enterprise submission must not fall through to Keycloak');
      pass('manual-submit-direct-LDAP-only', 'Synthetic invalid user reaches trusted direct LDAP and receives 401, not DIRECTORY_UNAVAILABLE');
    } finally {
      await context.close();
    }
  }

  {
    const context = await newContext(browser);
    try {
      const page = await context.newPage();
      watch(page, 'local-platform-automatic');
      await page.goto(BASE + '/');
      await page.locator('a.tm-submit[href^="/api/v1/auth/oidc/start"]').click();
      await page.locator('#username').fill('admin');
      await page.locator('#password').fill(readLocalAdminPassword());
      await page.locator('#kc-login').click();
      await page.waitForSelector('main#main', { timeout: 30000 });
      pass('retained-local-Keycloak-flow', 'The existing admin follows the normal automatic Keycloak journey to the app shell');
    } finally {
      await context.close();
    }
  }

  fail(external.length === 0, 'Unexpected external browser requests: ' + external.join(', '));
  fail(consoleErrors.length === 0, 'Browser console errors: ' + consoleErrors.join(' | '));
  pass('no-external-browser-requests-or-console-errors', 'Sign-in routes used only local application assets and local Keycloak');
} finally {
  await browser.close();
}

writeFileSync(new URL('results.json', outputDir), JSON.stringify({
  application: BASE,
  checks,
  externalRequests: external,
  consoleErrors,
  enterpriseAutomaticSso: missingProfileKeys.length === 0
    ? { state: 'profile-present-separate-activation-still-required', missingFields: [] }
    : { state: 'AWAITING_APPROVED_EXTERNAL_CLIENT_PROFILE', missingFields: missingProfileKeys },
  retainedLocalKeycloakFlow: 'Verified independently; does not prove MOVER-compatible external enterprise connectivity',
  realEnterpriseUserPasswordUsed: false,
  syntheticInvalidAccountUsed: true,
}, null, 2) + '\n');
console.log(`\n${checks.length} sign-in route checks passed. Evidence: ${new URL('results.json', outputDir).pathname}`);
if (missingProfileKeys.length) {
  console.log('LIMIT: the retained local Keycloak flow passed; external enterprise SSO awaits an approved client profile:', missingProfileKeys.join(', '));
}
