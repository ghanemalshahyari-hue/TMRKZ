// The fictional acceptance accounts full26.u01…u14 (ACCEPTANCE ONLY): a real sign-in through TMRKZ → Keycloak → the stand-in
// directory → TMRKZ over HTTP, and the session it opens, for API calls or a headless browser. The password is read from the
// git-ignored ops/acceptance-main/.generated/full26-password and never printed.
import { readFileSync } from 'node:fs';

export const BASE = process.env.MOVER_URL ?? 'http://localhost:8088';
const password = () => readFileSync(new URL('../../../ops/acceptance-main/.generated/full26-password', import.meta.url), 'utf8').trim();

export async function signIn(login) {
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
  if (!action) throw new Error(`${login}: no sign-in form`);
  res = await go(action, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: login, password: password(), credentialId: '' }) });
  if (res.status !== 302) throw new Error(`${login}: provider answered ${res.status}`);
  res = await go(res.headers.get('location'));
  const session = cookies.get('MOVER_SESSION');
  if (!session) throw new Error(`${login}: no TMRKZ session (${res.headers.get('location') ?? res.status})`);
  const api = async (method, url, body) => {
    const r = await go('/api/v1' + url, { method, headers: { 'X-Requested-With': 'mover', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    let b = null;
    try { b = t ? JSON.parse(t) : null; } catch { b = t; }
    return { status: r.status, body: b };
  };
  return { login, session, cookies: [...cookies].map(([name, value]) => ({ name, value, url: BASE })), api };
}
