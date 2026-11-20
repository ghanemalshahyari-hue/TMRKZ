// Release closure (20 Nov 2026), owner brief §16–§17: «الاعتماد الجزئي» as a REAL round trip on :8088, and the policy's excess.
//  A. a re-stationing is sent; the deciding stage approves the new site and the main area and returns the sub-area; the
//     requester opens the returned request, changes only the sub-area, resubmits; the same stage sees the site and the main
//     area kept as approved and only the sub-area to review; every stage approves; the request is approved and waits for an
//     independent activator — the requester and the final approver cannot activate (proved by the server's refusal);
//  B. a second request returned the same way: the requester changes the main area too; its approval is invalidated and the
//     stage must decide it again;
//  C. an oversized new site may be sent and is flagged «يتجاوز المسموح» for the deciders; a self-intersecting site cannot be sent.
// Synthetic people only (HR_AI, in the stand-in directory): REQUESTER on one acceptance unit, and the deciders the route needs —
// the acceptance batch's personas (b2.p06.h1 …) or the two seats granted for this run. Nothing is activated.
//   REQUESTER=juma.ghfly4 DECIDERS=majed.mhyry2,rashed.kndy2 node tests/acceptance/partial-approval-roundtrip.mjs
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)).split(String.fromCharCode(92)).join('/');
const BASE = process.env.MOVER_URL ?? 'http://localhost:8088';
const OUT = ROOT + 'docs/evidence/partial-approval/';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const { chromium } = await import(pathToFileURL(ROOT + 'tests/acceptance/node_modules/playwright-core/index.mjs').href);
const results = [];
const ok = (pass, what, detail = '') => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'} ${what}${detail ? ' · ' + detail : ''}`); };

const accPassword = () => { try { return readFileSync(ROOT + 'ops/acceptance-main/.generated/mover-ldap-test-password', 'utf8').trim(); } catch { return null; } };
const batchPassword = () => { try { return readFileSync(ROOT + 'ops/test-env/.generated/user-password', 'utf8').trim(); } catch { return null; } };
async function session(username, password) {
  const r = await fetch(BASE + '/api/v1/auth/directory/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mover' }, body: JSON.stringify({ username, password }) });
  if (r.status !== 200) return null;
  const raw = r.headers.getSetCookie().map((c) => c.split(';')[0]);
  const ck = raw.join('; ');
  const xsrf = (ck.match(/XSRF-TOKEN=([^;]+)/) ?? [])[1];
  const api = async (method, path, body) => {
    const x = await fetch(BASE + '/api/v1' + path, { method, headers: { Cookie: ck, 'X-Requested-With': 'mover', 'Content-Type': 'application/json', ...(xsrf ? { 'X-XSRF-TOKEN': decodeURIComponent(xsrf) } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const t = await x.text();
    try { return { status: x.status, body: JSON.parse(t) }; } catch { return { status: x.status, body: t }; }
  };
  const me = (await api('GET', '/me')).body;
  return { username, api, me, cookies: raw.map((c) => ({ name: c.slice(0, c.indexOf('=')), value: c.slice(c.indexOf('=') + 1), url: BASE })) };
}
const WHO = process.env.REQUESTER ?? 'juma.ghfly4';
const requester = await session(WHO, accPassword());
if (!requester) throw new Error(WHO + ' cannot sign in');
// every decider the route may need: this run's seats, then the acceptance batch's personas (hierarchy levels, operations, final)
const candidates = [];
for (const u of (process.env.DECIDERS ?? 'majed.mhyry2,rashed.kndy2').split(',')) { const s = await session(u, accPassword()); if (s) candidates.push(s); }
const bp = batchPassword();
if (bp) for (const b of ['b2', 'b3', 'b4']) for (const p of ['p06.h1', 'p07.h2', 'p08.ops', 'p09.fin', 'p03.final', 'p16.branch']) { const s = await session(`${b}.${p}`, bp); if (s) candidates.push(s); }
console.log('deciders signed in: ' + candidates.map((c) => c.username).join(', '));

const hub = (await requester.api('GET', '/request-hub')).body;
const movable = hub.units.filter((u) => u.site && u.actions.some((a) => a.action === 'RESTATIONING' && a.allowed));
// the unit the deciders' seats are on (UNIT_MATCH names it), else the first the person may move
const mine = movable.find((u) => u.name.includes(process.env.UNIT_MATCH ?? 'السهل')) ?? movable[0];
if (!mine) throw new Error(WHO + ' has no stationed unit to move');
const g0 = mine.site.geometry;
const ring = (g0.type === 'Polygon' ? g0.coordinates[0] : g0.coordinates[0][0]);
const shift = (dx, dy, scale = 1) => {
  const cx = ring.reduce((a, p) => a + p[0], 0) / ring.length;
  const cy = ring.reduce((a, p) => a + p[1], 0) / ring.length;
  return { type: 'Polygon', coordinates: [ring.map(([x, y]) => [cx + (x - cx) * scale + dx, cy + (y - cy) * scale + dy])] };
};
// the policy in force (version 1 on :8088): the main area 5–9.5 km from the new site, the sub-area 3–7 km from the main area;
// 0.01° of longitude ≈ 1.0 km here, so: new site 2 km east, main area ≈ 6.5 km further, sub-area ≈ 4.5 km beyond it
const PRIMARY = shift(0.085, 0.004);
const content = (sub) => ({ kind: 'PERMANENT', start: null, end: null, scope: [mine.id], site: { geometry: shift(0.02, 0), copiedFrom: mine.site.id, shape: 'COPY' }, primary: PRIMARY, alternative: sub, reason: 'الاعتماد الجزئي — جولة كاملة، قبول وهمي', exceptions: {}, occupants: {} });
const view = (s, id) => s.api('GET', '/restationing-requests/' + id).then((r) => r.body);
const stageNow = (r) => r.route.find((s) => s.current);
/** The signed-in person who may decide the request's current stage, other than the one who decided the last one. */
const deciderFor = async (id, notUser) => {
  for (const c of candidates) {
    if (c.username === notUser) continue;
    const r = await view(c, id);
    if (r.can?.decide) return { c, r };
  }
  return null;
};
// a part's state: what the current stage holds while the request is under review; what the last stage decided once it is returned
const partState = (r, part) => { const p = r.parts?.find((x) => x.part === part); return r.state === 'UNDER_REVIEW' ? p?.current : (p?.last?.state ?? p?.current); };

// ---- A. the round trip ------------------------------------------------------------------------------------------------
const madeA = await requester.api('POST', '/restationing-requests', { requestingUnitId: mine.id, content: content(shift(0.13, 0.006)), purpose: 'RESTATIONING' });
if (madeA.status !== 200 && madeA.status !== 201) throw new Error('A not made: ' + madeA.status + ' ' + JSON.stringify(madeA.body).slice(0, 200));
const A = madeA.body.id;
const sentA = await requester.api('POST', `/restationing-requests/${A}/submit`, { reason: 'جولة الاعتماد الجزئي' });
if (sentA.status !== 200) throw new Error('A not sent: ' + sentA.status + ' ' + JSON.stringify(sentA.body).slice(0, 300));
ok(sentA.body.state === 'UNDER_REVIEW', 'PA-01 the request is sent and under review', `${sentA.body.number} · stages: ${sentA.body.route.map((s) => s.label + (s.mark ? ' [' + s.mark + ']' : '')).join(' → ')}`);
const numberA = sentA.body.number;
let first = await deciderFor(A, null);
if (!first) throw new Error('no signed-in person may decide the first stage of ' + numberA + ' (' + stageNow(sentA.body)?.label + ')');
const stage1 = stageNow(first.r);
const partsDecision = await first.c.api('POST', `/restationing-requests/${A}/decision`, { decision: 'PARTS', parts: { SITE: 'APPROVE', PRIMARY: 'APPROVE', ALTERNATIVE: 'CHANGES' }, partNotes: { ALTERNATIVE: 'الفرعية أبعد من المطلوب: قرّبها' } });
ok(partsDecision.status === 200 && partsDecision.body.state === 'RETURNED_FOR_CHANGES', `PA-02 ${first.c.username} at «${stage1?.label}» approves the new site and the main area and returns the sub-area: the request is returned with that part named`, partsDecision.status + ' ' + (partsDecision.body.returned?.parts ?? partsDecision.body.returned?.reason ?? JSON.stringify(partsDecision.body).slice(0, 120)));
let rA = await view(requester, A);
ok(partState(rA, 'SITE') === 'APPROVED' && partState(rA, 'PRIMARY') === 'APPROVED' && partState(rA, 'ALTERNATIVE') === 'CHANGES_REQUESTED', 'PA-03 the requester sees each part: site approved, main area approved, sub-area to change', rA.parts?.map((p) => p.part + ':' + p.current).join(' '));

// the requester opens the returned request in the map-first editor (the browser), changes only the sub-area through the API and resubmits
const browser = await chromium.launch(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH, headless: true } : { channel: process.env.BROWSER_CHANNEL ?? 'msedge', headless: true });
const ctx = await browser.newContext({ locale: 'ar-AE', timezoneId: 'Asia/Dubai', viewport: { width: 1440, height: 900 } });
await ctx.addCookies(requester.cookies);
await ctx.route('**/*', (route) => { const u = new URL(route.request().url()); return ['localhost', '127.0.0.1'].includes(u.hostname) || /^(data|blob):/.test(u.protocol) ? route.continue() : route.abort('blockedbyclient'); });
const page = await ctx.newPage();
await page.goto(BASE + '/#restationing/' + A);
await page.waitForTimeout(1500);
await page.getByRole('button', { name: /تعديل/ }).first().click();
await page.getByTestId('restation-request').waitFor({ timeout: 30000 });
await page.waitForTimeout(1500);
const note = await page.getByTestId('returned-note').innerText().catch(() => '');
ok(note.includes('أُعيد') && /الفرعية|sub|ALTERNATIVE/.test(note), 'PA-04 the returned request opens in the map-first editor and names the returned part', note.replace(/\s+/g, ' ').slice(0, 140));
await page.screenshot({ path: OUT + '01-returned-in-editor.png' });
await ctx.close();
const edited = { ...rA.content, alternative: shift(0.125, 0.012) };
const put = await requester.api('PUT', `/restationing-requests/${A}/content`, edited);
const resent = await requester.api('POST', `/restationing-requests/${A}/submit`, { reason: 'قُرّبت الفرعية فقط' });
ok(put.status === 200 && resent.status === 200 && resent.body.state === 'UNDER_REVIEW', 'PA-05 only the sub-area changed; the request is resubmitted', resent.body.revisions?.at(-1)?.changed?.join(',') ?? '');
rA = await view(requester, A);
ok(partState(rA, 'SITE') === 'APPROVED' && partState(rA, 'PRIMARY') === 'APPROVED' && ['PENDING', 'EDITED', 'REOPENED'].includes(partState(rA, 'ALTERNATIVE')), 'PA-06 the site and the main area stay approved; only the sub-area is open for review', rA.parts?.map((p) => p.part + ':' + p.current).join(' '));
let again = await deciderFor(A, null);
ok(!!again && stageNow(again.r)?.key === stage1?.key, 'PA-07 the request is back at the stage that returned it', again ? again.c.username + ' @ ' + stageNow(again.r)?.label : 'nobody may decide');
if (again) {
  const kept = await again.c.api('POST', `/restationing-requests/${A}/decision`, { decision: 'PARTS', parts: { SITE: 'CHANGES' } });
  ok(kept.status === 400, 'PA-08 a part approved at this stage and unchanged cannot be decided again there (server refusal)', kept.status + ' ' + (kept.body?.message ?? ''));
  const approveRest = await again.c.api('POST', `/restationing-requests/${A}/decision`, { decision: 'PARTS', parts: { ALTERNATIVE: 'APPROVE' } });
  ok(approveRest.status === 200, 'PA-09 the stage approves the re-reviewed sub-area alone; the kept parts need no new decision', approveRest.status + ' → ' + approveRest.body?.state);
}
// the remaining stages, each by a different person, until the final approval
let last = again?.c.username ?? null;
let r = await view(requester, A);
let guard = 0;
while (r.state === 'UNDER_REVIEW' && guard++ < 8) {
  const d = await deciderFor(A, last);
  if (!d) break;
  const dec = await d.c.api('POST', `/restationing-requests/${A}/decision`, { decision: 'APPROVE', reason: 'موافق' });
  console.log(`  ${d.c.username} approves «${stageNow(d.r)?.label}» → ${dec.status} ${dec.body?.state ?? ''}`);
  last = d.c.username;
  r = await view(requester, A);
}
ok(r.state === 'APPROVED_NOT_ACTIVATED', 'PA-10 every stage approved: the request waits for activation', r.state + ' · ' + r.route.map((s) => s.label + ':' + (s.mark ?? '-')).join(' | '));
const tryActivate = await requester.api('POST', `/restationing-requests/${A}/activate`, { reason: 'x' });
const finalSess = candidates.find((c) => c.username === last);
const finalTry = finalSess ? await finalSess.api('POST', `/restationing-requests/${A}/activate`, { reason: 'x' }) : { status: 0 };
ok(!r.can.activate && tryActivate.status === 403 && (finalSess ? finalTry.status === 403 : true), 'PA-11 activation is a separate act: refused to the requester and to the final approver (an independent activator only; nothing activated here)', `requester ${tryActivate.status}, final ${finalTry.status}`);

// ---- B. the main area changed too: its approval is invalidated -----------------------------------------------------------
const madeB = await requester.api('POST', '/restationing-requests', { requestingUnitId: mine.id, content: content(shift(0.13, 0.006)), purpose: 'RESTATIONING' });
const B = madeB.body.id;
const sentB = await requester.api('POST', `/restationing-requests/${B}/submit`, { reason: 'جولة ثانية' });
const dB = await deciderFor(B, null);
if (!dB) throw new Error('no decider for B');
await dB.c.api('POST', `/restationing-requests/${B}/decision`, { decision: 'PARTS', parts: { SITE: 'APPROVE', PRIMARY: 'APPROVE', ALTERNATIVE: 'CHANGES' }, partNotes: { ALTERNATIVE: 'قرّبها' } });
let rB = await view(requester, B);
const editedB = { ...rB.content, primary: shift(0.09, 0.002), alternative: shift(0.135, 0.008) };
await requester.api('PUT', `/restationing-requests/${B}/content`, editedB);
const resentB = await requester.api('POST', `/restationing-requests/${B}/submit`, { reason: 'غُيّرت الرئيسية والفرعية' });
rB = await view(requester, B);
ok(resentB.status === 200 && partState(rB, 'SITE') === 'APPROVED' && ['REOPENED', 'EDITED', 'PENDING'].includes(partState(rB, 'PRIMARY')) && ['PENDING', 'EDITED', 'REOPENED'].includes(partState(rB, 'ALTERNATIVE')),
  'PA-12 the main area was changed too: its approval is invalidated and it must be decided again; the untouched site stays approved', rB.parts?.map((p) => p.part + ':' + p.current).join(' '));
const dB2 = await deciderFor(B, null);
if (dB2) {
  const mustDecide = await dB2.c.api('POST', `/restationing-requests/${B}/decision`, { decision: 'PARTS', parts: { ALTERNATIVE: 'APPROVE' } });
  ok(mustDecide.status !== 200 || mustDecide.body.state === 'UNDER_REVIEW', 'PA-13 the stage cannot pass the reopened main area by silence: it has to decide it', mustDecide.status + ' ' + (mustDecide.body?.message ?? mustDecide.body?.state ?? ''));
  console.log('  B is left under review at «' + stageNow(dB2.r)?.label + '» with its reopened main area (for the parts screen check)');
}

// ---- C. the policy's excess ------------------------------------------------------------------------------------------------
const policy = (await requester.api('GET', '/stationing/policy')).body.inForce?.values;
const maxSite = policy?.maxFootprintAreaM2 ?? null;
if (maxSite) {
  const big = content(shift(0.13, 0.006));
  big.site = { geometry: shift(0.02, 0, 3.5), copiedFrom: null, shape: 'DRAWN' };
  const madeC = await requester.api('POST', '/restationing-requests', { requestingUnitId: mine.id, content: big, purpose: 'RESTATIONING' });
  const Cid = madeC.body.id;
  const checks = (await requester.api('GET', `/restationing-requests/${Cid}/checks`)).body;
  const sentC = await requester.api('POST', `/restationing-requests/${Cid}/submit`, { reason: 'موقع أكبر من الحد الأقصى — قبول وهمي' });
  ok(checks?.areaOverMax === true && sentC.status === 200 && sentC.body.state === 'UNDER_REVIEW', 'PA-14 an oversized but valid new site may be sent; it is flagged for the deciders (the final approver decides or returns it)', `areaOverMax=${checks?.areaOverMax} · sent ${sentC.status} ${sentC.body?.state ?? ''}`);
  const dC = await deciderFor(Cid, null);
  if (dC) {
    const ctx2 = await browser.newContext({ locale: 'ar-AE', timezoneId: 'Asia/Dubai', viewport: { width: 1440, height: 900 } });
    await ctx2.addCookies(dC.c.cookies);
    const p2 = await ctx2.newPage();
    await p2.goto(BASE + '/#restationing/' + Cid);
    await p2.waitForTimeout(2500);
    const text = (await p2.locator('.tz-context').innerText().catch(() => '')).replace(/\s+/g, ' ');
    ok(/تتجاوز|يتجاوز المسموح/.test(text), 'PA-15 the decider sees the excess on the request («تتجاوز الحد الأقصى» / «يتجاوز المسموح»)', text.match(/.{0,40}(تتجاوز|يتجاوز).{0,40}/)?.[0] ?? text.slice(0, 80));
    await p2.screenshot({ path: OUT + '02-oversized-for-decider.png' });
    await ctx2.close();
    const ret = await dC.c.api('POST', `/restationing-requests/${Cid}/decision`, { decision: 'RETURN', reason: 'صغّر الموقع إلى المسموح — قبول وهمي' });
    ok(ret.status === 200 && ret.body.state === 'RETURNED_FOR_CHANGES', 'PA-16 the deciding stage may return an oversized request', ret.status);
  }
} else ok(true, 'PA-14 (no maximum footprint in the policy in force; the oversized path cannot be shown)');
// invalid geometry: a self-intersecting ring cannot be sent (and a crossing edit is refused before that)
const bow = { type: 'Polygon', coordinates: [[ring[0], ring[2], ring[1], ring[3] ?? ring[0], ring[0]]] };
const madeD = await requester.api('POST', '/restationing-requests', { requestingUnitId: mine.id, content: { ...content(shift(0.13, 0.006)), site: { geometry: bow, copiedFrom: null, shape: 'DRAWN' } }, purpose: 'RESTATIONING' });
let refused = madeD.status >= 400;
let detail = madeD.status + ' ' + (madeD.body?.message ?? '');
if (!refused) {
  const sentD = await requester.api('POST', `/restationing-requests/${madeD.body.id}/submit`, { reason: 'هندسة غير صالحة' });
  refused = sentD.status >= 400;
  detail = 'draft ' + madeD.status + ', submit ' + sentD.status + ' ' + (sentD.body?.message ?? '');
}
ok(refused, 'PA-17 a self-intersecting site is refused: it cannot become a sent request', detail);
await browser.close();
console.log(`requests of this run on «${mine.name}»: ${numberA} (approved, not activated), ${sentB.body?.number ?? '?'} (under review), and the oversized / invalid ones`);
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
