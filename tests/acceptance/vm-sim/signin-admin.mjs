// Platform admin sign-in through TMRKZ → Keycloak → TMRKZ over plain fetch, then /api/v1/me. BASE and PW from the environment.
const BASE = process.env.BASE;
const cookies = new Map();
const go = async (url, init = {}) => {
  const res = await fetch(url.startsWith('http') ? url : BASE + url, {
    redirect: 'manual', ...init,
    headers: { ...(init.headers ?? {}), Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
  });
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(';')[0]; const i = pair.indexOf('=');
    if (!pair.slice(i + 1) || /max-age=0/i.test(c)) cookies.delete(pair.slice(0, i)); else cookies.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return res;
};
let res = await go('/api/v1/auth/oidc/start');
res = await go(res.headers.get('location'));
const html = await res.text();
const action = html.match(/<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
if (!action) { console.log('FAIL no Keycloak sign-in form', res.status); process.exit(1); }
res = await go(action, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'admin', password: process.env.PW, credentialId: '' }) });
if (res.status !== 302) { console.log('FAIL Keycloak answered', res.status); process.exit(1); }
res = await go(res.headers.get('location'));
const me = await go('/api/v1/me', { headers: { 'X-Requested-With': 'mover' } });
const body = await me.json().catch(() => ({}));
const ok = me.status === 200 && body.username === 'admin';
console.log(`${ok ? 'PASS' : 'FAIL'} sign-in admin: /api/v1/me ${me.status} username=${body.username} role=${body.primaryRole?.code}`);
process.exit(ok ? 0 : 1);
