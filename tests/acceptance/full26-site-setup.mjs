// FULL acceptance §27–§28 (owner's specification, 16 Nov 2026) — ACCEPTANCE ONLY — OWNER DECISION PENDING.
// U11 («تهيئة المواقع والتمركز» over everything) creates «معسكر القبول الكامل 01» from zero in the REAL «موقع جديد» wizard on
// http://localhost:8088, headless: 1 data, 2 boundary drawn by clicks on the map canvas (a double click finishes), 3 the initial
// stationing of «وحدة إضافية 1 · م8-2» (ticked in the units tree), 4 its primary and 5 alternative deployment areas placed with one
// click each («تحديد المنطقة على الخريطة»), 6 the review with the server's check, 2D and 3D, then one save. VIDEO B.
// Positions (open land in the Hajar foothills, inside the installed GLO-30 coverage, ~52 km from S-0001) were confirmed first
// with POST /api/v1/site-setup/check. Then the records are verified read-only.
//   node tests/acceptance/full26-site-setup.mjs
import { writeFileSync } from 'node:fs';
import { DOCS, PRIVATE, button, closePage, contextFor, go, launch, recorder, session, shot, sql, unitId } from './lib/full26-ui.mjs';

const ok = recorder('site-setup');
const NAME = 'معسكر القبول الكامل 01';
const UNIT = 'وحدة إضافية 1 · م8-2';
const C = [55.965, 24.935]; // the camp
const P = [56.0295, 24.935]; // primary area centre (≈6.5 km east, hilly)
const A = [56.0295, 24.971]; // alternative area centre (≈4.0 km north of the primary, mountainous)
const MAP = '.tz-mapframe .tz-map-layer';
const toScreen = (page, ll) => page.evaluate(([sel, ll]) => {
  const m = document.querySelector(sel).tmrkzMap;
  const p = m.project(ll);
  const r = m.getCanvas().getBoundingClientRect();
  return { x: r.left + p.x, y: r.top + p.y, inside: p.x > 20 && p.y > 20 && p.x < r.width - 20 && p.y < r.height - 20 };
}, [MAP, ll]);
const jump = (page, centre, zoom) => page.evaluate(([sel, c, z]) => document.querySelector(sel).tmrkzMap.jumpTo({ center: c, zoom: z }), [MAP, centre, zoom]);
const exact = (s) => new RegExp('^\\s*' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$');

if (sql(`select count(*) from site where name = '${NAME}'`) !== '0') {
  console.log('the camp already exists — nothing to do');
  process.exit(0);
}
const browser = await launch();
const p = await contextFor(browser, 'full26.u11', { video: 'B-site-from-zero' });
const result = {};
try {
  await go(p, '#siteSetup');
  await p.getByTestId('setup-tree').waitFor({ timeout: 20000 });
  await p.waitForTimeout(2500);
  await p.getByTestId('add-site').click();
  // step 1 — data
  const strip = await p.locator('.sw-steps').getAttribute('aria-label');
  ok(strip === 'الخطوة 1 من 6', 'SETUP-UI-01', 'صاحب التهيئة يرى ست خطوات', strip);
  await p.getByLabel('اسم الموقع').fill(NAME);
  await p.locator('[data-kind="معسكر"]').click();
  await p.getByTestId('where-main').click();
  const owner = p.getByTestId('owner-tree');
  await owner.getByRole('searchbox').fill('وحدة إضافية 1');
  const hit = owner.getByRole('option').filter({ has: p.locator('b', { hasText: exact('وحدة إضافية 1') }) }).first();
  await hit.waitFor({ timeout: 15000 });
  await hit.locator('button').click();
  await p.getByTestId('owner-picked').waitFor();
  await p.waitForTimeout(600);
  await shot(p, '08-new-site-data.png');
  await p.getByTestId('wizard-next').click();
  await p.waitForTimeout(1200);

  // step 2 — boundary, drawn by clicking on the map canvas; the last corner is a double click, which finishes the drawing
  await jump(p, C, 15);
  await p.waitForTimeout(1500);
  await p.getByTestId('draw-site').click();
  await p.waitForTimeout(600);
  const dlat = (m) => m / 110900;
  const dlng = (m) => m / (111320 * Math.cos((C[1] * Math.PI) / 180));
  const corners = [[-300, -260], [280, -300], [330, 120], [40, 330], [-310, 180]].map(([e, n]) => [C[0] + dlng(e), C[1] + dlat(n)]);
  for (let i = 0; i < corners.length; i++) {
    const at = await toScreen(p, corners[i]);
    if (i === corners.length - 1) await p.mouse.dblclick(at.x, at.y);
    else await p.mouse.click(at.x, at.y);
    await p.waitForTimeout(450);
  }
  await p.waitForTimeout(1200);
  const finishedByDouble = (await p.getByTestId('shape-done').count()) > 0;
  ok(finishedByDouble, 'SETUP-UI-02a', 'النقر المزدوج يُنهي الرسم (ADR-063)',
    finishedByDouble ? '' : 'DEFECT: بعد النقرة الأولى تظهر علامة الرأس stw-vtx تحت المؤشر فتلتقط النقرة الثانية وحدث dblclick ولا يصلان إلى الخريطة: ' + (await p.locator('.sw-drawing .sw-hint').innerText().catch(() => '')));
  if (!finishedByDouble) {
    // the page's other documented way to close: a click on the first corner
    const first = await toScreen(p, corners[0]);
    await p.mouse.click(first.x, first.y);
  }
  await p.getByTestId('shape-done').waitFor({ timeout: 10000 });
  ok(true, 'SETUP-UI-02', 'حدود الموقع مرسومة بالنقر على الخريطة', await p.getByTestId('shape-done').innerText());
  await shot(p, '09-new-site-boundary.png');
  await p.getByTestId('wizard-next').click();
  await p.waitForTimeout(1200);

  // step 3 — the initial stationing: one unit ticked, explicitly (nothing below it moves with it)
  await p.getByTestId('setup-step-3').waitFor();
  await p.getByLabel('بحث عن وحدة للتمركز').fill('م8-2');
  const u = p.getByTestId('setup-units').getByRole('option').filter({ has: p.locator('b', { hasText: exact(UNIT) }) }).first();
  await u.waitFor({ timeout: 15000 });
  await u.locator('input[type=checkbox]').check();
  await p.getByLabel('بحث عن وحدة للتمركز').fill('');
  await p.getByTestId('setup-chosen').waitFor();
  result.requirement = await p.getByTestId('setup-requirement').innerText().catch(() => '');
  await shot(p, '10-initial-stationing-selection.png');
  await p.getByTestId('wizard-next').click();
  await p.waitForTimeout(1500);

  // steps 4 and 5 — each area placed by one click with the policy's initial square, then dragged a little on the map
  const place = async (centre, step, name, legName) => {
    await p.getByTestId(step).waitFor();
    await button(p, 'تحديد المنطقة على الخريطة').click();
    await p.waitForTimeout(1500);
    let at = await toScreen(p, centre);
    if (!at.inside) {
      await jump(p, [(C[0] + centre[0]) / 2, (C[1] + centre[1]) / 2], 12);
      await p.waitForTimeout(1500);
      at = await toScreen(p, centre);
    }
    await p.mouse.click(at.x, at.y);
    await p.waitForTimeout(2500);
    // dragged by its body: the editor keeps it on the map, nothing is saved while it moves
    await p.mouse.move(at.x, at.y, { steps: 5 });
    await p.mouse.down();
    await p.mouse.move(at.x + 6, at.y - 4, { steps: 8 });
    await p.mouse.up();
    await p.waitForTimeout(2500);
    const dist = await p.getByTestId('area-distance').innerText().catch(() => '');
    result[legName] = { distance: dist, readout: (await p.getByTestId('area-readout').innerText().catch(() => '')).replace(/\s+/g, ' ') };
    ok(dist && !/—/.test(dist.trim()), 'SETUP-UI-' + legName, name + ' موضوعة بنقرة ومسحوبة، ومسافتها ظاهرة', dist);
  };
  await place(P, 'setup-step-4', 'منطقة الانتشار الرئيسية', 'PRIMARY');
  await shot(p, '11-primary-deployment.png');
  await p.getByTestId('wizard-next').click();
  await p.waitForTimeout(1500);
  await place(A, 'setup-step-5', 'منطقة الانتشار البديلة', 'ALTERNATIVE');
  await shot(p, '12-alternative-deployment.png');
  await p.getByTestId('wizard-next').click();

  // step 6 — the review: the site, the unit with its two areas, the server's check per unit
  await p.getByTestId('setup-step-6').waitFor();
  await p.locator('[data-testid=setup-review] .sw-done, [data-testid=setup-review] .sw-err').first().waitFor({ timeout: 30000 });
  const verdict = await p.getByTestId('setup-review').innerText();
  result.review = verdict.replace(/\s+/g, ' ').slice(0, 900);
  ok(verdict.includes('الفحوص مستوفاة'), 'SETUP-UI-06', 'فحص الخادم قبل الحفظ: مستوفاة', result.review.slice(0, 300));
  await p.getByLabel('سبب تسجيل الموقع').fill('ACCEPTANCE ONLY — OWNER DECISION PENDING: تهيئة أولى لمعسكر القبول الكامل مع تمركزه الابتدائي ومنطقتي انتشاره');
  await jump(p, [(C[0] + P[0]) / 2, (C[1] + A[1]) / 2], 11.6);
  await p.waitForTimeout(2500);
  await shot(p, '14-final-setup-review.png');
  await button(p, '3D').click();
  await p.waitForTimeout(6000);
  await shot(p, '13-3d-terrain-review.png');
  await button(p, '2D').click();
  await p.waitForTimeout(1500);
  await p.getByTestId('setup-save').click();
  const code = (await p.getByTestId('made-code').innerText({ timeout: 30000 })).trim();
  result.code = code;
  result.units = await p.getByTestId('made-units').innerText().catch(() => '');
  ok(/^S-\d{4,}$/.test(code), 'SETUP-UI-07', 'حُفظ في حفظة واحدة، برمز تلقائي', code + ' · ' + result.units);
  await p.waitForTimeout(1500);
  await shot(p, '14b-site-saved.png');
} catch (e) {
  ok(false, 'SETUP-UI-ABORT', 'توقف', e.stack);
  await shot(p, 'abort-site-setup.png', { private: true });
} finally {
  await closePage(p);
  await browser.close();
}

// the records, read-only
const site = sql(`select id from site where name = '${NAME}'`) || '00000000-0000-0000-0000-000000000000';
const org = unitId(UNIT);
ok(sql(`select count(*) from site where name = '${NAME}'`) === '1', 'SITE-BOOT-01', 'موقع مادي واحد، لا نسخة مكررة');
const resp = sql(`select string_agg(o.name, '، ') from site_responsibility r join organization o on o.id = r.organization_id where r.site_id = '${site}' and r.valid_to is null`);
ok(resp === 'وحدة إضافية 1', 'SITE-BOOT-02', 'الوحدة المسؤولة «وحدة إضافية 1»', resp);
const st = sql(`select id || '|' || origin || '|' || kind || '|' || coalesce(request_id::text, '-') from org_stationing where organization_id = '${org}' and site_id = '${site}' and valid_to is null`);
ok(/\|SETUP\|PERMANENT\|-$/.test(st), 'SITE-BOOT-03', 'تمركز ابتدائي معتمد (origin SETUP، دائم، بلا طلب)', st);
const areas = sql(`select role || ':' || origin || ':' || state from deployment_area where organization_id = '${org}' order by role`);
ok(areas === 'ALTERNATIVE:SETUP:ACTIVE\nPRIMARY:SETUP:ACTIVE', 'SITE-BOOT-04', 'منطقتا الانتشار الرئيسية والبديلة نافذتان', areas.replace('\n', ' | '));
ok(sql(`select count(*) from audit_event where action = 'SITE_SETUP_BOOTSTRAPPED' and entity_id = '${site}'`) === '1', 'SITE-BOOT-05', 'حدث تدقيق واحد SITE_SETUP_BOOTSTRAPPED');
ok(sql(`select count(*) from restationing_request`) === '0', 'SITE-BOOT-06', 'التهيئة لا تنشئ طلب اعتماد');
const viewer = await session('full26.u10');
const posture = await viewer.api('GET', '/operational-posture');
const mine = (posture.body?.units ?? []).find((x) => x.id === org);
ok(posture.status === 200 && mine && JSON.stringify(mine).includes(NAME), 'SITE-BOOT-07', 'الموقف العملياتي يعكسها فوراً (U10)', JSON.stringify(mine ?? posture.body).slice(0, 400));
result.records = { site, stationing: st, areas, audit: sql(`select detail::text from audit_event where action = 'SITE_SETUP_BOOTSTRAPPED' and entity_id = '${site}'`).slice(0, 1500) };
writeFileSync(PRIVATE + 'site-setup.json', JSON.stringify(result, null, 1));
writeFileSync(DOCS + 'site-setup-result.json', JSON.stringify(result, null, 1));
process.exit(0);
