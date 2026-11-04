// Stationing V3 ACCEPTANCE through the real application and the real sign-in (owner gates of 4 Nov 2026), against the
// fictional acceptance environment (default http://localhost:8088) once the acceptance policy is published
// (publish-acceptance-policy.mjs). Fictional users and data only; requesting units are HR units with a level (owner §2).
// It adapts to the published policy (routes, ranges, allowances, exception) instead of assuming it.
//   A permanent (decisions and activation pressed on the real page) + map checks, X distance exception (normal, within
//   maxExtra, too far), C occupied deployment, D terrain on real GLO-30 cells, E cross-branch with F return and
//   selective re-approval, S security refusals by direct API calls, K boundary cases in the real editor, B temporary
//   with the real scheduler. G (hierarchy change) is NOT run here: the acceptance environment has no HR source attached
//   and the owner requires the HR synchronisation path, never direct SQL — see RestationingHrSyncIT.
// Usage: MOVER_URL=http://localhost:8088 node tests/acceptance/restationing-acceptance.mjs   (headless Edge)
//        ONLY=A,X,C,…  runs a subset
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const BASE = process.env.MOVER_URL ?? 'http://localhost:8088';
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const OUT = new URL('../../docs/evidence/acceptance-journeys/stationing-v3/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const shot = (name) => fileURLToPath(new URL(name, OUT));
const PASSWORD = readFileSync(new URL('../../ops/test-env/.generated/user-password', import.meta.url), 'utf8').trim();
const require = createRequire(new URL('./package.json', import.meta.url));
const { chromium } = require('playwright-core');

const results = [];
const requests = [];
const routes = [];
const ok = (cond, id, label, extra = '') => {
  results.push({ id, label, result: cond ? 'PASS' : 'FAIL', extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${id}  ${label}${extra ? '  — ' + extra : ''}`);
  return cond;
};
const note = (id, label, extra) => {
  results.push({ id, label, result: 'NOTE', extra });
  console.log(`NOTE  ${id}  ${label}  — ${extra}`);
};
const run = (k) => !ONLY || ONLY.has(k);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- real sign-in for API sessions: TMRKZ → Keycloak login form → LDAP → TMRKZ ------------------------------------
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
const sessions = new Map();
async function as(username) {
  if (sessions.has(username)) return sessions.get(username);
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
  const s = { cookie, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b) };
  sessions.set(username, s);
  return s;
}

// ---- fixtures from the server -----------------------------------------------------------------------------------
const admin = await as('t.admin');
// evidence reads (requests, authoritative stationing, links, audit) through the fictional auditor's read-only VIEW of every unit
const auditor = await as('t.auditor');
const must = async (path) => {
  const r = await admin.get(path);
  if (r.status !== 200) throw new Error(`${path}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body;
};
const flatten = (nodes, out = []) => { for (const n of nodes ?? []) { out.push(n); flatten(n.children, out); } return out; };
const orgs = flatten(await must('/organizations/tree'));
const org = (code) => orgs.find((o) => o.code === code)?.id;
const policy = (await must('/stationing/policy')).inForce;
if (!policy) {
  console.log('No Stationing policy in force: publish it first (tests/acceptance/publish-acceptance-policy.mjs).');
  process.exit(2);
}
const pv = policy.values;
console.log(`policy version ${policy.version} (${policy.reference}): primary ${pv.primary.minM}–${pv.primary.maxM} m, alternative ${pv.alternative.minM}–${pv.alternative.maxM} m, deployment ${pv.deploymentRequirement}, exception ${pv.exception.allowed ? '+' + pv.exception.maxExtraM + ' m' : 'off'}`);
// the fictional approver seats of the acceptance provisioning: unit code → persona
const SEAT = { 'HR-T-SS': 't.manager', 'HR-T-IT': 't.manager.it', 'HR-T-PM': 't.manager.ga', 'HR-T-ORG': 't.approver' };
const deciderFor = (stage) => (stage.kind === 'EXCEPTION' ? 't.approver2' : SEAT[stage.unit?.code]);
const SS = org('HR-T-SS'), IT = org('HR-T-IT'), PM = org('HR-T-PM');
const routeText = (route) => (route ?? []).map((s) => `${s.label}${s.mark ? ' [' + s.mark + ']' : ''}`).join(' ← ');

const M_LAT = 110_900;
const mLng = (lat) => 111_320 * Math.cos((lat * Math.PI) / 180);
const square = (lat, lng, halfM) => {
  const dy = halfM / M_LAT, dx = halfM / mLng(lat);
  return { type: 'Polygon', coordinates: [[[lng - dx, lat - dy], [lng + dx, lat - dy], [lng + dx, lat + dy], [lng - dx, lat + dy], [lng - dx, lat - dy]]] };
};
const east = (lat, lng, m) => [lat, lng + m / mLng(lat)];
const south = (lat, lng, m) => [lat - m / M_LAT, lng];
const north = (lat, lng, m) => [lat + m / M_LAT, lng];
/** A permanent request at `at`: primary `pm` metres east, alternative `am` metres south of the primary. */
const layout = (at, pm = 6000, am = 4000) => {
  const pr = east(at[0], at[1], pm);
  const al = south(pr[0], pr[1], am);
  return { site: square(at[0], at[1], 150), primary: square(pr[0], pr[1], 300), alternative: square(al[0], al[1], 300) };
};
const content = (scope, l, reason, extra = {}) => ({
  kind: 'PERMANENT', scope, site: { geometry: l.site, shape: 'DRAWN' }, primary: l.primary, alternative: l.alternative, reason, ...extra,
});
async function create(user, unit, c, journey) {
  const r = await (await as(user)).post('/restationing-requests', { requestingUnitId: unit, content: c });
  if (r.status !== 200) throw new Error(`create failed ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  requests.push({ journey, id: r.body.id, number: r.body.number, requester: user });
  return r.body;
}
const view = async (id, user = 't.auditor') => (await (await as(user)).get('/restationing-requests/' + id)).body;
const checks = async (id, user) => (await (await as(user)).get(`/restationing-requests/${id}/checks`)).body;
const legText = (c) => (c.legs ?? []).map((l) => `${l.label}: ${l.distanceM} m, ${l.status}, allowed ${l.effectiveMinM}–${l.effectiveMaxM}${l.exceptionMaxM ? ' (exception to ' + l.exceptionMaxM + ')' : ''}${l.terrain ? `, ${l.terrain.controllingClass} +${l.terrain.allowanceM}` : ''}`).join(' | ');
const recordRoute = (journey, r) => routes.push({
  journey, number: r.number, requestingUnit: r.requestingUnit?.code, stages: r.route?.length,
  route: (r.route ?? []).map((s) => ({ key: s.key, kind: s.kind, label: s.label, final: s.final, satisfies: s.satisfies, mark: s.mark, decidedBy: s.decidedBy?.name ?? null })),
});
/** Decides every remaining stage through the seat holders; returns the final state or the reason it stopped. */
async function approveAll(id) {
  for (let i = 0; i < 10; i++) {
    const r = await view(id);
    const cur = r.route.find((s) => s.current);
    if (!cur) return r.state;
    const who = deciderFor(cur);
    if (!who) return `no fictional seat holder for «${cur.label}»`;
    const d = await (await as(who)).post(`/restationing-requests/${id}/decision`, { decision: 'APPROVE' });
    if (d.status !== 200) return `«${cur.label}» by ${who}: ${d.status} ${d.body.message ?? ''}`;
  }
  return 'too many stages';
}

// ---- the real page (headless Edge): each persona signs in through Keycloak in the browser -------------------------
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const external = [];
const consoleErrors = [];
async function pageAs(user) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('request', (q) => { const u = q.url(); if (!u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u); });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`${user}: ${m.text()}`));
  page.on('pageerror', (e) => consoleErrors.push(`${user}: ${e.message}`));
  await page.goto(BASE + '/api/v1/auth/oidc/start');
  await page.waitForSelector('#kc-form-login', { timeout: 30000 });
  await page.fill('#username', user);
  await page.fill('#password', PASSWORD);
  await page.click('#kc-login');
  await page.waitForURL((u) => u.toString().startsWith(BASE) && !u.toString().includes('/auth/realms/'), { timeout: 30000 });
  return page;
}
async function openRequest(page, id) {
  await page.goto(`${BASE}/#restationing/${id}`);
  await page.waitForSelector('.rs-summary', { timeout: 30000 });
  await page.waitForTimeout(2500);
}
async function press(page, name) {
  await page.getByRole('button', { name }).click();
  await page.waitForTimeout(2500);
}

// fictional free ground near the acceptance sites (Dubai); the server checks occupancy anyway. SHIFT_M moves every
// layout north for a rerun, clear of the sites a previous run activated.
const P0 = north(25.1925, 55.3160, Number(process.env.SHIFT_M ?? 0));

/** Distinct colours in a PNG screenshot (8-bit RGB/RGBA, not interlaced): a blank map is one flat colour. */
function distinctColours(png) {
  let pos = 8, width = 0, height = 0, channels = 4;
  const idat = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); channels = data[9] === 6 ? 4 : 3; }
    if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  const colours = new Set();
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= channels ? cur[x - channels] : 0, b = prev[x], c = x >= channels ? prev[x - channels] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      cur[x] = (v + (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0)) & 255;
    }
    for (let x = 0; x < stride; x += channels) colours.add((cur[x] << 16) | (cur[x + 1] << 8) | cur[x + 2]);
    cur.copy(prev);
  }
  return colours.size;
}
/** Screenshot of the middle of the map (clear of the notices and the legend) and its colour count. */
async function mapCentreColours(page, name) {
  const box = await page.locator('.maplibregl-canvas').first().boundingBox();
  if (!box) return 0;
  const clip = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.3, width: box.width * 0.4, height: box.height * 0.4 };
  return distinctColours(await page.screenshot({ clip, path: shot(name) }));
}

try {
  // ---- A: permanent, decided and activated on the real page, with the map checks before activation -----------------
  let reqA;
  if (run('A')) {
    const linksBefore = (await auditor.get('/site-links?includeEnded=true')).body;
    const r = await create('t.requester', SS, content([SS], layout(P0), 'قبول A: نقل الخدمات المشتركة (بيانات قبول وهمية)'), 'A');
    reqA = r.id;
    const c = await checks(reqA, 't.requester');
    ok(c.ok && !c.needsDistanceException, 'A1', 'permanent draft passes the server checks, no exception needed', c.problems?.join(' | ') || legText(c));
    const page = await pageAs('t.requester');
    await openRequest(page, reqA);
    await press(page, 'إرسال للاعتماد');
    let v = await view(reqA);
    recordRoute('A', v);
    ok(v.state === 'UNDER_REVIEW' && v.policyVersion === policy.version, 'A2', 'submitted on the page; policy version locked', `${v.state}, policy ${v.policyVersion}, ${v.route.length} stages: ${routeText(v.route)}`);
    ok(v.route.length === 2 && v.route[0].unit?.code === 'HR-T-SS' && v.route.at(-1).final && v.route.at(-1).unit?.code === 'HR-T-ORG', 'A3', 'ancestry route from the L7 requesting unit: its own approver, then L6 final (no unrelated unit)');
    await page.screenshot({ path: shot('A-submitted.png') });
    // the map on the real page while the request is under review
    const legend = await page.locator('.rs-legend').textContent();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: shot('MAP-street.png') });
    const streetColours = await mapCentreColours(page, 'MAP-street-centre.png');
    ok(['الموقع الحالي', 'الموقع المقترح', 'الانتشار الرئيسية', 'الانتشار البديلة', 'النطاق المسموح'].every((t) => legend.includes(t)) && streetColours >= 20, 'MAP1',
      'the map draws (basemap, current site, proposed site, both deployment areas, guidance rings) and the legend names them', `${streetColours} colours in the middle of the map; legend: ${legend.replace(/\s+/g, ' ').trim()}`);
    await page.getByRole('button', { name: 'طبيعة الأرض' }).click();
    await page.waitForTimeout(3500);
    await page.screenshot({ path: shot('MAP-terrain.png') });
    const terrainColours = await mapCentreColours(page, 'MAP-terrain-centre.png');
    const terrainNotice = await page.locator('[data-testid=map-source-notice]').textContent();
    await page.getByRole('button', { name: 'الشوارع' }).click();
    await page.waitForTimeout(1500);
    const still = await page.locator('.rs-summary').textContent();
    ok(/DSM|Copernicus/.test(terrainNotice) && terrainColours >= 20 && still.includes(v.number), 'MAP2', 'terrain mode draws (GLO-30 notice) and back to street mode keeps the request selected', `${terrainColours} colours; ${terrainNotice.replace(/\s+/g, ' ').trim().slice(0, 140)}`);
    for (let i = 0; i < 6; i++) {
      v = await view(reqA);
      const cur = v.route.find((s) => s.current);
      if (!cur) break;
      const who = deciderFor(cur);
      if (!who) { ok(false, 'A4', 'every stage has a fictional seat holder', `no seat for «${cur.label}»`); break; }
      const p = await pageAs(who);
      await openRequest(p, reqA);
      await press(p, 'اعتماد المرحلة');
      await p.context().close();
    }
    v = await view(reqA);
    ok(v.state === 'APPROVED_NOT_ACTIVATED', 'A4', 'each stage approved on the page by its own seat holder', `${v.state}; ${routeText(v.route)}; final approver ${v.finalApprover?.name}`);
    const act = await pageAs('t.facilities');
    await openRequest(act, reqA);
    await press(act, 'تفعيل (إجراء مستقل)');
    await act.screenshot({ path: shot('A-activated.png') });
    await act.context().close();
    v = await view(reqA);
    ok(v.state === 'ACTIVATED_PERMANENT', 'A5', 'activated on the page by an independent activator', `${v.state}, by ${v.activation?.by?.name}, site ${v.activation?.site?.name}`);
    const cur = (await auditor.get(`/stationing/current?orgId=${SS}`)).body;
    ok(Array.isArray(cur) && cur.some((s) => s.siteId === v.activation?.site?.id && s.origin === 'REQUEST'), 'A6', 'new authoritative stationing in the read contract', Array.isArray(cur) ? cur.map((s) => `${s.siteName} ${s.kind} ${s.origin}`).join(', ') : JSON.stringify(cur).slice(0, 160));
    const linksAfter = (await auditor.get('/site-links?includeEnded=true')).body;
    ok(JSON.stringify(linksBefore) === JSON.stringify(linksAfter), 'A7', 'site links unchanged by the activation (O-14)', `${linksAfter.length} links before and after`);
    await page.context().close();
  }

  // ---- X: distance exception (O-17) — normal, within maxExtra, beyond it ------------------------------------------
  if (run('X')) {
    const reason = 'قبول X: استثناء مسافة الانتشار (بيانات قبول وهمية)';
    const at = south(P0[0], P0[1], 12000);
    const r = await create('t.requester', SS, content([SS], layout(at), reason), 'X');
    let c = await checks(r.id, 't.requester');
    const base = c.legs.find((l) => l.leg === 'primary');
    ok(c.ok && !c.needsDistanceException && base.status === 'OK' && !c.route.some((s) => s.kind === 'EXCEPTION'), 'X1', 'normal: inside the effective range, no exception stage', legText(c));
    // within: 1 km beyond the effective maximum (terrain allowance included), inside effective maximum + maxExtra
    const lw = layout(at, base.effectiveMaxM + 1000);
    await (await as('t.requester')).put(`/restationing-requests/${r.id}/content`, content([SS], lw, reason));
    c = await checks(r.id, 't.requester');
    let leg = c.legs.find((l) => l.leg === 'primary');
    ok(!c.ok && leg.status === 'NEEDS_EXCEPTION' && leg.exceptionMaxM === leg.effectiveMaxM + pv.exception.maxExtraM && c.problems.some((p) => p.includes('استثناء مسافة بسبب مكتوب')), 'X2', 'within maxExtra: an exception is required, with a written reason', legText(c));
    const why = 'طريق الوصول الوحيد إلى منطقة الانتشار يمر من هناك (سبب قبول وهمي)';
    await (await as('t.requester')).put(`/restationing-requests/${r.id}/content`, content([SS], lw, reason, { exceptions: { primary: why } }));
    c = await checks(r.id, 't.requester');
    const xi = c.route.findIndex((s) => s.kind === 'EXCEPTION');
    ok(c.ok && c.needsDistanceException && xi >= 0 && xi === c.route.length - 2 && c.route.at(-1).final, 'X3', 'with the reason: a separate exception stage just before the final stage', c.route.map((s) => s.label).join(' ← '));
    const sub = await (await as('t.requester')).post(`/restationing-requests/${r.id}/submit`, {});
    recordRoute('X', sub.body);
    ok(sub.status === 200 && sub.body.content?.exceptions?.primary === why, 'X4', 'submitted; the reason is part of the submitted content', `${sub.body.state}, ${sub.body.route?.length} stages: ${routeText(sub.body.route)}`);
    const audit = (await auditor.get('/audit-events?page=0&size=50&action=RESTATIONING_SUBMITTED')).body;
    const submitted = (audit.items ?? []).find((e) => e.entityLabel === r.number);
    ok(JSON.stringify(submitted ?? {}).includes('طريق الوصول الوحيد'), 'X5', 'the written reason is in the audit history of the submission', submitted ? `audit «${submitted.action}» ${submitted.entityLabel}` : `audit event not visible (${audit.items?.length ?? 0} events read)`);
    await (await as('t.manager')).post(`/restationing-requests/${r.id}/decision`, { decision: 'APPROVE' });
    const seat = await (await as('t.approver')).post(`/restationing-requests/${r.id}/decision`, { decision: 'APPROVE' });
    ok(seat.status === 403, 'X6', 'a seat holder without «اعتماد استثناء مسافة الانتشار» cannot decide the exception stage', `${seat.status} ${seat.body.message}`);
    const exc = await (await as('t.approver2')).post(`/restationing-requests/${r.id}/decision`, { decision: 'APPROVE' });
    ok(exc.status === 200, 'X7', 'the holder of «اعتماد استثناء مسافة الانتشار» decides it', `${exc.status} ${exc.body.message ?? ''}`);
    const fin = await (await as('t.approver')).post(`/restationing-requests/${r.id}/decision`, { decision: 'APPROVE' });
    ok(fin.status === 200 && fin.body.state === 'APPROVED_NOT_ACTIVATED', 'X8', 'then the final stage: approved, not activated', `${fin.body.state}; ${routeText(fin.body.route)}`);
    // too far: beyond effective maximum + maxExtra — a hard refusal, even with a reason
    const at2 = south(P0[0], P0[1], 18000);
    const r2 = await create('t.requester', SS, content([SS], layout(at2), 'قبول X: أبعد من حد الاستثناء (بيانات قبول وهمية)'), 'X-too-far');
    const b2 = (await checks(r2.id, 't.requester')).legs.find((l) => l.leg === 'primary');
    await (await as('t.requester')).put(`/restationing-requests/${r2.id}/content`, content([SS], layout(at2, b2.effectiveMaxM + pv.exception.maxExtraM + 600), 'قبول X: أبعد من حد الاستثناء (بيانات قبول وهمية)', { exceptions: { primary: why } }));
    const c2 = await checks(r2.id, 't.requester');
    leg = c2.legs.find((l) => l.leg === 'primary');
    const s2 = await (await as('t.requester')).post(`/restationing-requests/${r2.id}/submit`, {});
    ok(leg.status === 'OUT_OF_RANGE' && !c2.ok && s2.status === 400 && !(c2.route ?? []).some((s) => s.kind === 'EXCEPTION'), 'X9', 'too far: beyond effective maximum + maxExtra is a hard refusal, no exception stage', `${legText(c2)}; submit ${s2.status} ${s2.body.message ?? ''}`);
  }

  // ---- C: occupied deployment is a hard block --------------------------------------------------------------------
  if (run('C')) {
    const sites = (await admin.get('/sites')).body;
    const occupied = (sites.items ?? sites).find((s) => s.code === '01');
    const l = layout(south(P0[0], P0[1], 2200));
    l.primary = square(occupied.location.lat, occupied.location.lng, 400);
    const r = await create('t.requester', SS, content([SS], l, 'قبول C: انتشار فوق أرض مشغولة (بيانات قبول وهمية)'), 'C');
    const c = await checks(r.id, 't.requester');
    ok(!c.ok && c.problems.some((p) => p.includes('أرض مشغولة')), 'C1', 'a deployment area over occupied ground is refused by the checks', c.problems?.find((p) => p.includes('مشغولة')));
    const s = await (await as('t.requester')).post(`/restationing-requests/${r.id}/submit`, {});
    ok(s.status === 400, 'C2', 'and the submission is refused (hard block, O-08)', `${s.status} ${s.body.message ?? ''}`);
  }

  // ---- D: terrain on real GLO-30 slopes — flat, and a non-zero allowance -----------------------------------------
  if (run('D')) {
    // flat: the first candidate deployment area south of the acceptance sites that the real slopes classify FLAT
    let flat = null;
    for (let km = 8; km <= 24 && !flat; km += 2) {
      const a = await admin.post('/stationing/terrain/assess', { geometry: layout(south(P0[0], P0[1], km * 1000)).primary });
      if (a.status === 200 && a.body.controllingClass === 'FLAT') flat = { km, a: a.body };
    }
    ok(!!flat && flat.a.allowanceM === 0 && flat.a.primary.effectiveMaxM === pv.primary.maxM && flat.a.primary.effectiveMinM === pv.primary.minM, 'D1', 'flat ground: FLAT adds nothing to the range',
      flat ? `${flat.km} km south: ${flat.a.controllingClass} +${flat.a.allowanceM} m, range ${flat.a.primary.effectiveMinM}–${flat.a.primary.effectiveMaxM}, shares ${flat.a.shares.filter((s) => s.percent > 0).map((s) => s.code + ' ' + s.percent.toFixed(1) + '%').join(', ')}; ${flat.a.datasetCode} ${flat.a.datasetVersion} ${flat.a.surfaceModel}` : 'no FLAT candidate found');
    let steep = null;
    for (const lat of [24.79, 24.82, 24.85, 24.76]) {
      for (const lng of [56.13, 56.16, 56.19, 56.22]) {
        const a = await admin.post('/stationing/terrain/assess', { geometry: square(lat, lng, 400) });
        if (a.status === 200 && ['MOUNTAINOUS', 'HILLY', 'ROLLING'].includes(a.body.controllingClass) && a.body.allowanceM > 0) { steep = { lat, lng, a: a.body }; break; }
      }
      if (steep) break;
    }
    if (!steep) {
      note('D2', 'non-zero allowance case', 'no steep cell found in the candidate grid');
    } else {
      const add = steep.a.allowanceM;
      const dist = pv.primary.maxM + add * 0.6; // beyond the base maximum, inside the allowance
      const siteAt = [steep.lat, steep.lng - dist / mLng(steep.lat)];
      const altAt = north(steep.lat, steep.lng, pv.alternative.minM + 500);
      const l = { site: square(siteAt[0], siteAt[1], 150), primary: square(steep.lat, steep.lng, 400), alternative: square(altAt[0], altAt[1], 300) };
      const r = await create('t.requester', SS, content([SS], l, 'قبول D: انتشار على أرض ذات ميل (بيانات قبول وهمية)'), 'D');
      const c = await checks(r.id, 't.requester');
      const leg = c.legs?.find((x) => x.leg === 'primary');
      ok(leg && leg.terrain?.allowanceM === add && leg.effectiveMaxM === pv.primary.maxM + add && leg.effectiveMinM === pv.primary.minM && leg.distanceM > pv.primary.maxM && leg.status === 'OK', 'D2',
        'non-zero allowance: beyond the base maximum, inside base + allowance, accepted (maximum only, O-06)',
        leg ? `${leg.terrain?.controllingClass} «${leg.terrain?.controllingLabel}» +${leg.terrain?.allowanceM} m: ${leg.distanceM} m within ${leg.effectiveMinM}–${leg.effectiveMaxM} (base ${leg.baseMinM}–${leg.baseMaxM}); shares ${leg.terrain?.shares.filter((s) => s.percent > 0).map((s) => s.code + ' ' + s.percent.toFixed(1) + '%').join(', ')}` : JSON.stringify(c.problems));
      const s = await (await as('t.requester')).post(`/restationing-requests/${r.id}/submit`, {});
      recordRoute('D', s.body);
      ok(s.status === 200 && s.body.revisions?.[0]?.policyVersion === policy.version, 'D3', 'submitted with the terrain decision and the policy version recorded', `policy ${s.body.revisions?.[0]?.policyVersion}; ${legText(c)}`);
      const stop = await approveAll(r.id);
      ok(stop === 'APPROVED_NOT_ACTIVATED', 'D4', 'approved through its route (not activated)', stop);
    }
    note('D5', 'terrain tie on real data', 'an exact area tie on real GLO-30 cells is not practical to construct; the tie, the priority and the block are proven on a synthetic raster (StationingFoundationIT, StationingRulesTest)');
  }

  // ---- E + F: cross-branch inclusion, then return and selective re-approval on the same request -------------------
  if (run('E')) {
    const reason = 'قبول E: ضم وحدة من فرع آخر (بيانات قبول وهمية)';
    const at = south(P0[0], P0[1], 6000);
    const l = layout(at);
    const r = await create('t.requester', SS, content([SS, PM], l, reason), 'E/F');
    let c = await checks(r.id, 't.requester');
    ok(!c.ok && c.problems.some((p) => p.includes('خارج فرع')), 'E1', 'a unit of another branch is never moved implicitly', c.problems.find((p) => p.includes('خارج فرع')));
    const occupants = { [PM]: 'INCLUDED' };
    for (const o of c.otherBranch ?? []) if (o.decisionRequired && o.unit !== PM) occupants[o.unit] = 'EXCLUDED';
    await (await as('t.requester')).put(`/restationing-requests/${r.id}/content`, content([SS, PM], l, reason, { occupants }));
    c = await checks(r.id, 't.requester');
    const cross = c.route?.find((s) => s.kind === 'CROSS_BRANCH');
    ok(c.ok && !!cross && cross.unit?.code === 'HR-T-PM' && cross.satisfies.length === 2, 'E2', 'explicit inclusion: one stage of the other unit satisfies OTHER_UNIT and SITE_RESPONSIBLE (not independent)', cross ? `${cross.label} — يستوفي: ${cross.satisfies.join('، ')}` : c.problems?.join(' | '));
    let v = (await (await as('t.requester')).post(`/restationing-requests/${r.id}/submit`, {})).body;
    recordRoute('E', v);
    ok(v.state === 'UNDER_REVIEW', 'E3', 'submitted', `${v.route?.length} stages: ${routeText(v.route)}`);
    // every stage but the final approves; the final returns it for a change of the alternative area
    for (const s of v.route.filter((x) => !x.final)) await (await as(deciderFor(s))).post(`/restationing-requests/${r.id}/decision`, { decision: 'APPROVE' });
    const ret = await (await as('t.approver')).post(`/restationing-requests/${r.id}/decision`, { decision: 'RETURN', reason: 'انقل منطقة الانتشار البديلة قليلاً' });
    ok(ret.body.state === 'RETURNED_FOR_CHANGES', 'F1', 'returned for changes at the final stage', routeText(ret.body.route));
    await (await as('t.requester')).put(`/restationing-requests/${r.id}/content`, content([SS, PM], { ...l, alternative: layout(at, 6000, 4300).alternative }, reason, { occupants }));
    const re = await (await as('t.requester')).post(`/restationing-requests/${r.id}/submit`, { reason: 'نقلت منطقة الانتشار البديلة كما طُلب' });
    const rev = re.body.revisions?.at(-1);
    ok(re.status === 200 && rev?.changed?.length === 1 && rev.changed[0] === 'DEPLOYMENT', 'F2', 'resubmitted: only the deployment changed', `changed ${rev?.changed}`);
    const levels = pv.routing.levels;
    const restsOnDeployment = (s) => s.kind === 'HIERARCHY' && (levels.find((x) => s.label.startsWith(x.label + ' — '))?.dependsOn ?? []).includes('DEPLOYMENT');
    const expected = v.route.filter((s) => !s.final && restsOnDeployment(s)).map((s) => s.key).sort();
    const carriedExpected = v.route.filter((s) => !s.final && !restsOnDeployment(s)).map((s) => s.key).sort();
    ok(JSON.stringify(rev.invalidated.map((x) => x.stage).sort()) === JSON.stringify(expected) && JSON.stringify([...rev.carried].sort()) === JSON.stringify(carriedExpected), 'F3',
      'only the decisions resting on the deployment are taken again; the cross-branch decision is carried (D18)',
      `invalidated ${rev.invalidated.map((x) => x.label).join(', ') || 'none'}; carried ${re.body.route.filter((s) => s.mark === 'CARRIED').map((s) => s.label).join(', ') || 'none'}; ${routeText(re.body.route)}`);
    const stop = await approveAll(r.id);
    v = await view(r.id);
    recordRoute('F (after resubmission)', v);
    ok(stop === 'APPROVED_NOT_ACTIVATED', 'F4', 'the re-taken stages are decided again; the request completes', `${stop}; ${routeText(v.route)}`);
  }

  // ---- S: security — the server refuses what the page would not offer ----------------------------------------------
  if (run('S')) {
    const r = await create('t.requester', SS, content([SS], layout(south(P0[0], P0[1], 9000)), 'قبول الأمان (بيانات قبول وهمية)'), 'S');
    await (await as('t.requester')).post(`/restationing-requests/${r.id}/submit`, {});
    const self = await (await as('t.requester')).post(`/restationing-requests/${r.id}/decision`, { decision: 'APPROVE' });
    ok(self.status === 403 && self.body.code === 'SEPARATION_OF_DUTIES', 'S1', 'the requester cannot approve their own request', `${self.status} ${self.body.code} ${self.body.message}`);
    // the seat holder delegates the seat to the requester: still refused on the requester's own request
    const mgr = await as('t.manager');
    const mgrId = (await mgr.get('/me')).body.id;
    const members = (await mgr.get(`/organizations/${SS}`)).body.members ?? (await admin.get(`/organizations/${SS}`)).body.members ?? [];
    const membership = members.find((m) => m.person.id === mgrId && m.role.code === 'ACC_V3_UNIT_APPROVER' && m.active);
    const reqId = (await (await as('t.requester')).get('/me')).body.id;
    const del = membership
      ? await mgr.post('/delegations', { delegateId: reqId, membershipId: membership.membershipId, validFrom: new Date().toISOString(), validTo: new Date(Date.now() + 3600e3).toISOString(), reason: 'تفويض اختبار قبول (وهمي)' })
      : { status: 0, body: { message: 'seat membership not visible' } };
    if (del.status === 200) {
      sessions.delete('t.requester');
      const viaDelegation = await (await as('t.requester')).post(`/restationing-requests/${r.id}/decision`, { decision: 'APPROVE' });
      ok(viaDelegation.status === 403, 'S2', 'a seat delegated to the requester does not let them approve their own request', `${viaDelegation.status} ${viaDelegation.body.code} ${viaDelegation.body.message}`);
      const rv = await mgr.post(`/delegations/${del.body.id}/revoke`, { reason: 'انتهى اختبار القبول' });
      note('S2r', 'delegation revoked after the check', `${rv.status}`);
    } else {
      note('S2', 'delegation circumvention', `delegation not created through the API (${del.status} ${del.body?.message ?? ''})`);
    }
    const outsider = await as('t.requester2');
    ok((await outsider.get(`/restationing-requests/${r.id}`)).status === 404, 'S3', 'a user of another branch cannot see the request');
    ok((await outsider.post(`/restationing-requests/${r.id}/decision`, { decision: 'APPROVE' })).status === 404, 'S4', 'nor act on it');
    const wrongSeat = await (await as('t.manager.it')).post(`/restationing-requests/${r.id}/decision`, { decision: 'APPROVE' });
    ok([403, 404].includes(wrongSeat.status), 'S5', 'another unit\'s approver cannot decide this stage', `${wrongSeat.status} ${wrongSeat.body.message ?? ''}`);
    const finalEarly = await (await as('t.approver')).post(`/restationing-requests/${r.id}/decision`, { decision: 'APPROVE' });
    ok(finalEarly.status === 403, 'S6', 'the final approver cannot decide before the current stage', `${finalEarly.status} ${finalEarly.body.message ?? ''}`);
    const earlyActivate = await (await as('t.facilities')).post(`/restationing-requests/${r.id}/activate`, {});
    ok(earlyActivate.status >= 400, 'S7', 'activation before final approval is refused', `${earlyActivate.status} ${earlyActivate.body.message ?? ''}`);
    const rej = await (await as('t.manager')).post(`/restationing-requests/${r.id}/decision`, { decision: 'REJECT', reason: 'انتهى اختبار الأمان' });
    ok(rej.status === 200 && rej.body.state === 'REJECTED', 'S8', 'the security request is closed by rejection', `${rej.status} ${rej.body.state ?? rej.body.message}`);
    note('S9', 'second account of the same human', 'accepted by the owner as backend/OpenFGA evidence (RestationingWorkflowIT.permanentJourney); the acceptance directory holds no linked second account');
  }

  // ---- K: boundary cases in the real editor (drafts kept, identified as acceptance-test drafts) -------------------
  if (run('K')) {
    const cases = [
      ['t.requester', 'الخدمات المشتركة', 'الخدمات المشتركة', 'Polygon', 'نُسخت حدود'],
      ['t.requester', 'الخدمات المشتركة', 'قسم الخدمات العامة', 'MultiPolygon', 'متعددة الأجزاء'],
      ['t.requester2', 'إدارة التقنية', 'إدارة التقنية', 'Point', 'نقطةً بلا حدود'],
    ];
    for (const [user, unitName, movingName, type, expect] of cases) {
      const before = new Set(((await (await as(user)).get('/restationing-requests?state=DRAFT')).body ?? []).map((d) => d.id));
      const page = await pageAs(user);
      await page.goto(`${BASE}/#restationing`);
      await page.waitForSelector('.rs-list');
      await page.getByRole('button', { name: '＋ طلب إعادة تمركز' }).click();
      await page.locator('.rs-form select').first().selectOption({ label: unitName });
      await page.locator('.rs-check', { hasText: movingName }).first().locator('input').check();
      await page.locator('.rs-form textarea').first().fill(`مسودة اختبار قبول — سلوك نسخ الحدود (${type}) — بيانات وهمية، ليست طلب عمل`);
      await page.getByRole('button', { name: 'نسخ حدود الموقع الحالي' }).click();
      const toast = await page.waitForFunction((t) => { const e = document.getElementById('toast'); return e && !e.hidden && e.textContent.includes(t) ? e.textContent : null; }, expect, { timeout: 15000 })
        .then((h) => h.jsonValue()).catch(async () => (await page.locator('#toast').textContent()) ?? '');
      const drawButton = (await page.locator('.rs-tools button').nth(1).textContent()).trim();
      await page.screenshot({ path: shot(`K-${type}.png`) });
      await page.context().close();
      const draft = ((await (await as(user)).get('/restationing-requests?state=DRAFT')).body ?? []).find((d) => !before.has(d.id));
      if (draft) requests.push({ journey: `K-${type}: ACCEPTANCE-TEST DRAFT (boundary copy), not a business request`, id: draft.id, number: draft.number, requester: user });
      ok(toast.includes(expect) && (type === 'Polygon' || drawButton === 'رسم حدود جديدة'), 'K-' + type, `«نسخ حدود الموقع الحالي» on a ${type} current site (moving unit ${movingName})`, `${toast.trim().slice(0, 150)}; draw button «${drawButton}»; draft ${draft?.number ?? 'none'}`);
    }
  }

  // ---- G: hierarchy change — not on this environment ----------------------------------------------------------------
  if (run('G')) {
    const src = (await admin.get('/hr/source')).body;
    note('G', 'hierarchy change through HR synchronisation', `NOT RUN on this environment: HR source «${src.name ?? '?'}» enabled=${src.enabled}, no connection settings; its HR mirror was loaded by ops/test-env/seed.sql. The synchronisation reads Oracle only (JDBC thin) and the owner forbids direct SQL as equivalent evidence. Proven through HrSyncService with the Oracle-compatible test source: RestationingHrSyncIT.`);
  }

  // ---- B: temporary with the real scheduler (last: it waits a few minutes) ------------------------------------------
  if (run('B')) {
    const at = south(P0[0] - 0.03, P0[1] + 0.05, 2000);
    const start = new Date(Date.now() + 120_000).toISOString();
    const end = new Date(Date.now() + 300_000).toISOString();
    const original = (await auditor.get(`/stationing/current?orgId=${IT}`)).body;
    const r = await create('t.requester2', IT, { ...content([IT], layout(at), 'قبول B: تمركز مؤقت (بيانات قبول وهمية)'), kind: 'TEMPORARY', start, end }, 'B');
    const sub = await (await as('t.requester2')).post(`/restationing-requests/${r.id}/submit`, {});
    recordRoute('B', sub.body);
    const stop = await approveAll(r.id);
    const act = await (await as('t.facilities')).post(`/restationing-requests/${r.id}/activate`, {});
    ok(stop === 'APPROVED_NOT_ACTIVATED' && act.body.state === 'TEMPORARY_SCHEDULED', 'B1', 'temporary approved and activated: scheduled for its start', `${act.body.state ?? act.body.message}; ${sub.body.route?.length} stages; start ${start}, end ${end}; original ${original.map((s) => s.siteName + ' ' + s.kind).join(', ')}`);
    let state = act.body.state;
    for (let i = 0; i < 40 && state !== 'TEMPORARY_RETURNED'; i++) {
      await sleep(15_000);
      state = (await view(r.id)).state;
      if (state === 'ACTIVE_TEMPORARY' && !results.find((x) => x.id === 'B2')) {
        const during = (await auditor.get(`/stationing/current?orgId=${IT}`)).body;
        const temp = during.find((s) => s.kind === 'TEMPORARY' && s.requestId === r.id);
        ok(!!temp && new Date() >= new Date(start), 'B2', 'the real scheduler started it at its start; the authoritative stationing is the temporary site', `${new Date().toISOString()}: ${during.map((s) => `${s.siteName} ${s.kind}${s.plannedEnd ? ' until ' + s.plannedEnd : ''}`).join(', ')}`);
      }
    }
    const after = (await auditor.get(`/stationing/current?orgId=${IT}`)).body;
    const history = (await auditor.get(`/stationing/organizations/${IT}/history`)).body;
    const ended = history.find((s) => s.kind === 'TEMPORARY' && s.requestId === r.id);
    ok(state === 'TEMPORARY_RETURNED' && after.length === original.length && after.every((s) => original.some((o) => o.siteId === s.siteId && o.kind === s.kind)) && !!ended?.validTo, 'B3',
      'returned automatically at its end; the preserved original stationing is the authoritative one again',
      `${state}; temporary ${ended?.validFrom} → ${ended?.validTo} (${ended?.endReason}); now ${after.map((s) => s.siteName + ' ' + s.kind).join(', ')}`);
    note('B4', 'extension, early return, cancellation before start', 'not built yet — remaining implementation work, not accepted here');
  }
} finally {
  ok(external.length === 0, 'NET', 'zero external requests from the real page', external.slice(0, 3).join(' '));
  ok(consoleErrors.length === 0, 'CONSOLE', 'no console or page errors on the real page', consoleErrors.slice(0, 8).join(' | '));
  writeFileSync(new URL(ONLY ? `results-${[...ONLY].join('')}.json` : 'results.json', OUT), JSON.stringify({ ranAt: new Date().toISOString(), base: BASE, only: ONLY ? [...ONLY] : null, policy: { version: policy.version, reference: policy.reference }, results, requests, routes }, null, 2));
  await browser.close();
  const failed = results.filter((r) => r.result === 'FAIL').length;
  console.log(`\n${failed === 0 ? 'Stationing V3 acceptance PASSED' : failed + ' check(s) FAILED'} (${results.filter((r) => r.result === 'PASS').length} pass, ${results.filter((r) => r.result === 'NOTE').length} notes)`);
  process.exitCode = failed ? 1 : 0;
}
