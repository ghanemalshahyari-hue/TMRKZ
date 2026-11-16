// ACCEPTANCE ONLY (ADR-069, 16 Nov 2026): real sign-ins on http://localhost:8088 through TMRKZ → Keycloak → the stand-in
// directory, for the fictional acc69.* people (ops/acceptance-main/acc69.mjs) and the platform administrator. Passwords are read
// from git-ignored files (the fictional accounts' from ops/acceptance-main/.generated/full26-password, the administrator's from
// .env) and never printed.
import { readFileSync } from 'node:fs';

export const BASE = process.env.MOVER_URL ?? 'http://localhost:8088';
const ROOT = new URL('../../../', import.meta.url);

export const accountPassword = () => readFileSync(new URL('ops/acceptance-main/.generated/full26-password', ROOT), 'utf8').trim();
export const adminPassword = () => readFileSync(new URL('.env', ROOT), 'utf8').match(/^TMRKZ_PLATFORM_ADMIN_PASSWORD=(.*)$/m)?.[1]?.trim();

/** One sign-in over HTTP (no browser): returns cookies for a headless context and api(method, url, body). */
export async function signInAs(login, password) {
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
  res = await go(action, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: login, password, credentialId: '' }) });
  if (res.status !== 302) throw new Error(`${login}: provider answered ${res.status}`);
  res = await go(res.headers.get('location'));
  if (!cookies.get('MOVER_SESSION')) {
    const where = res.headers.get('location') ?? String(res.status);
    throw Object.assign(new Error(`${login}: no TMRKZ session (${where})`), { where });
  }
  const api = async (method, url, body) => {
    const r = await go('/api/v1' + url, { method, headers: { 'X-Requested-With': 'mover', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    let b = null;
    try { b = t ? JSON.parse(t) : null; } catch { b = t; }
    return { status: r.status, body: b };
  };
  return { login, cookies: [...cookies].map(([name, value]) => ({ name, value, url: BASE })), api };
}
