// FULL acceptance (16 Nov 2026) — ACCEPTANCE ONLY. A requester of a sub-unit is offered for an initial stationing only the sites
// linked to its unit or a parent, or sites it may read (RequestHubService.selectableSites); the camp's responsible unit does not
// count. So U11 links «وحدة إضافية 1» to «معسكر القبول الكامل 01» from the site's card («ربط الوحدات بالمواقع») — a link, not a
// stationing — on the real page, headless.
//   node tests/acceptance/full26-site-link.mjs
import { closePage, contextFor, go, launch, recorder, session, shot, sql, unitId } from './lib/full26-ui.mjs';

const ok = recorder('site-link');
const CAMP = 'S-0002';
const B = 'وحدة إضافية 1';
const before = (await (await session('full26.u01')).api('GET', `/request-hub/units/${unitId(B + ' · م10-1')}/sites`)).body;
ok(Array.isArray(before) && before.length === 0, 'LINK-00', 'قبل الربط: لا يُعرض المعسكر لطالب م10-1 (الوحدة المسؤولة لا تكفي)', JSON.stringify(before));
const browser = await launch();
const p = await contextFor(browser, 'full26.u11', { video: 'B2-site-link' });
try {
  await go(p, '#siteSetup');
  await p.getByTestId('setup-tree').waitFor({ timeout: 20000 });
  await p.waitForTimeout(2000);
  await p.locator(`[data-site="${CAMP}"]`).first().click();
  await p.getByTestId('stationed-here').waitFor({ timeout: 15000 });
  await p.waitForTimeout(1500);
  await p.getByLabel('بحث وحدة الربط').fill(B);
  await p.waitForTimeout(1200);
  await p.getByLabel('وحدة الربط', { exact: true }).selectOption({ label: B });
  await p.getByLabel('سبب الربط').fill('ACCEPTANCE ONLY — ربط الوحدة المسؤولة بالمعسكر ليختاره طالبو وحداتها');
  await p.getByTestId('add-link').click();
  await p.waitForTimeout(2500);
  await shot(p, '14c-site-card-link.png');
} catch (e) {
  ok(false, 'LINK-ABORT', 'توقف', e.stack);
  await shot(p, 'abort-link.png', { private: true });
} finally {
  await closePage(p);
  await browser.close();
}
const site = sql(`select id from site where code = '${CAMP}'`);
ok(sql(`select count(*) from site_link where site_id = '${site}' and organization_id = '${unitId(B)}' and valid_to is null`) === '1', 'LINK-01', 'رُبطت «وحدة إضافية 1» بالمعسكر');
ok(sql(`select count(*) from org_stationing where organization_id = '${unitId(B)}'`) === '0', 'LINK-02', 'الربط ليس تمركزاً');
const after = (await (await session('full26.u01')).api('GET', `/request-hub/units/${unitId(B + ' · م10-1')}/sites`)).body;
ok((after ?? []).some((s) => s.code === CAMP), 'LINK-03', 'بعد الربط: يُعرض المعسكر لطالب م10-1', JSON.stringify(after).slice(0, 200));
process.exit(0);
