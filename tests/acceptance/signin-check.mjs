// One browser sign-in through TMRKZ → Keycloak → directory → TMRKZ, reporting whether a TMRKZ session was opened.
// Usage: node tests/acceptance/signin-check.mjs <login> <expect-success|expect-failure>
// Used by ops/test-env/check-untrusted-tls.sh; the password comes from the test environment.
import { readFileSync } from 'node:fs';

const BASE = process.env.MOVER_URL ?? 'http://localhost:8088';
const [login, expectation] = process.argv.slice(2);
const password = process.env.TMRKZ_TEST_PASSWORD
  ?? readFileSync(new URL('../../ops/test-env/.generated/user-password', import.meta.url), 'utf8').trim();

const cookies = new Map();
const go = async (url, init = {}) => {
  const res = await fetch(url.startsWith('http') ? url : BASE + url, {
    redirect: 'manual', ...init,
    headers: { ...(init.headers ?? {}), Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
  });
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    if (!pair.slice(i + 1) || /max-age=0/i.test(c)) cookies.delete(pair.slice(0, i));
    else cookies.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return res;
};

let res = await go('/api/v1/auth/oidc/start');
res = await go(res.headers.get('location'));
const html = await res.text();
const action = html.match(/<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
let session = false;
let detail = 'no sign-in form';
if (action) {
  res = await go(action, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: login, password, credentialId: '' }) });
  if (res.status === 302) {
    res = await go(res.headers.get('location'));
    session = cookies.has('MOVER_SESSION');
    detail = res.headers.get('location') ?? '';
  } else {
    detail = 'provider answered ' + res.status + (/(tm-alert[^"]*")[^>]*>([^<]+)/.exec(await res.text())?.[2]?.trim() ?? '');
  }
}
const wanted = expectation === 'expect-success';
console.log(`${session === wanted ? 'PASS' : 'FAIL'}  sign-in ${login}: ${session ? 'session opened' : 'refused'} — ${detail}`);
process.exit(session === wanted ? 0 : 1);
