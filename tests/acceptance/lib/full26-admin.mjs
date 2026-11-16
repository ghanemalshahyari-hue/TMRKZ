// FULL END-TO-END ACCEPTANCE (16 Nov 2026) — the administrator's session borrowed READ-ONLY from the owner's signed-in Edge on
// CDP port 9345: only its cookies are copied (nothing is clicked, typed or navigated there; the window is never closed).
// Returns {cookies, api(method,url,body)} like lib/full26.mjs signIn, so a headless context can be the administrator.
import { pathToFileURL } from 'node:url';

export const BASE = process.env.MOVER_URL ?? 'http://localhost:8088';

export async function adminSession(root) {
  const { chromium } = await import(pathToFileURL(`${root}/tests/acceptance/node_modules/playwright-core/index.mjs`).href);
  const b = await chromium.connectOverCDP('http://127.0.0.1:9345');
  const raw = await b.contexts()[0].cookies(BASE);
  // only the connection ends; the owner's browser stays open as it was
  await b.close().catch(() => undefined);
  const cookies = raw.map(({ name, value }) => ({ name, value, url: BASE }));
  const header = raw.map((c) => `${c.name}=${c.value}`).join('; ');
  const api = async (method, url, body, extra = {}) => {
    const r = await fetch(BASE + '/api/v1' + url, { method, headers: { Cookie: header, 'X-Requested-With': 'mover', 'Content-Type': 'application/json', Accept: 'application/json', ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    let b2 = null;
    try { b2 = t ? JSON.parse(t) : null; } catch { b2 = t; }
    return { status: r.status, body: b2 };
  };
  return { login: 'admin', cookies, api };
}
