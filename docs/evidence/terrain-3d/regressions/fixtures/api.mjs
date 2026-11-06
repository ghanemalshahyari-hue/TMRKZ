// Scratch helper: real OIDC sign-in (TMRKZ -> Keycloak -> LDAP) against the development backend, fictional users only.
import { readFileSync } from 'node:fs';

export const BASE = process.env.MOVER_URL ?? 'http://localhost:8097';
const PASSWORD = readFileSync('C:/Users/ADMIN/Desktop/TMRKZ/ops/test-env/.generated/user-password', 'utf8').trim();

class Jar {
  constructor() { this.cookies = new Map(); }
  take(res) {
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0];
      const i = pair.indexOf('=');
      const v = pair.slice(i + 1);
      if (!v || /max-age=0/i.test(c)) this.cookies.delete(pair.slice(0, i));
      else this.cookies.set(pair.slice(0, i), v);
    }
  }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
}

export async function signIn(username) {
  const jar = new Jar();
  const go = async (url, init = {}) => {
    const res = await fetch(url.startsWith('http') ? url : BASE + url, { redirect: 'manual', ...init, headers: { ...(init.headers ?? {}), Cookie: jar.header() } });
    jar.take(res);
    return res;
  };
  let res = await go('/api/v1/auth/oidc/start');
  res = await go(res.headers.get('location'));
  const html = await res.text();
  const action = html.match(/<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
  res = await go(action, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password: PASSWORD, credentialId: '' }) });
  res = await go(res.headers.get('location'));
  if (!jar.cookies.has('MOVER_SESSION')) throw new Error('sign-in failed for ' + username);
  const cookie = 'MOVER_SESSION=' + jar.cookies.get('MOVER_SESSION');
  const call = async (method, path, body) => {
    const r = await fetch(BASE + '/api/v1' + path, {
      method,
      headers: { ...(method !== 'GET' ? { 'X-Requested-With': 'mover', 'Content-Type': 'application/json' } : {}), Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const type = r.headers.get('content-type') ?? '';
    return { status: r.status, body: type.includes('json') ? await r.json() : await r.text() };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b) };
}

export const M_LAT = 110_900;
export const mLng = (lat) => 111_320 * Math.cos((lat * Math.PI) / 180);
export const square = (lat, lng, halfM) => {
  const dy = halfM / M_LAT, dx = halfM / mLng(lat);
  return { type: 'Polygon', coordinates: [[[lng - dx, lat - dy], [lng + dx, lat - dy], [lng + dx, lat + dy], [lng - dx, lat + dy], [lng - dx, lat - dy]]] };
};
export const towards = (c, deg, m) => ({ lat: c.lat + (m * Math.cos((deg * Math.PI) / 180)) / M_LAT, lng: c.lng + (m * Math.sin((deg * Math.PI) / 180)) / mLng(c.lat) });
