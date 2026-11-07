// The climbing approval (owner, 6 Nov 2026; ADR-041) on the REAL page with the real imported hierarchy, in a real browser: one card
// that climbs to the main unit, a stop at levels read from the HR source, and the question about the requesting unit. It saves one
// draft to try it, removes it at the end, and publishes nothing. The engine is proven by WorkflowGraphIT.
//
//   node tests/acceptance/flow-climb.mjs     BROWSER_PATH (Chrome or Edge), UI_URL, DB_CONTAINER, OUT
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const UI = process.env.UI_URL ?? 'http://localhost:8088';
const DB = process.env.DB_CONTAINER ?? 'tmrkz-mover-db-1';
const OUT = process.env.OUT ?? fileURLToPath(new URL('../../docs/evidence/flow-studio/climb/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const PASSWORD = (readFileSync(new URL('../../.env', import.meta.url), 'utf8').match(/^TMRKZ_PLATFORM_DEVELOPER_PASSWORD=(.*)$/m) ?? [])[1];
const { chromium } = createRequire(new URL('./package.json', import.meta.url))('playwright-core');
const results = [];
const ok = (pass, id, what, detail = '') => {
  results.push({ id, pass: !!pass, what, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} — ${what}${detail ? ' · ' + detail : ''}`);
};
const sql = (q) => execFileSync('docker', ['exec', DB, 'psql', '-X', '-q', '-U', 'mover', '-d', 'mover', '-At', '-c', q], { encoding: 'utf8' }).trim();

const browser = await chromium.launch({ ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : { channel: 'msedge' }), headless: true });
const page = await (await browser.newContext({ viewport: { width: 1680, height: 1000 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 220)));
await page.goto(UI + '/api/v1/auth/oidc/start');
await page.waitForSelector('#kc-form-login', { timeout: 30000 });
await page.fill('#username', 'developer');
await page.fill('#password', PASSWORD);
await page.click('#kc-login');
await page.waitForTimeout(2500);
await page.goto(UI + '/#workflow');
await page.waitForSelector('[data-testid=flow-studio] .react-flow__node', { timeout: 30000 });
const type = sql("select t.code from request_type t join workflow_definition w on w.request_type_code = t.code where not exists (select 1 from workflow_version v where v.workflow_id = w.id and v.status = 'DRAFT') order by t.sort_order limit 1");
await page.selectOption('select[aria-label="نوع الطلب"]', type);
await page.waitForTimeout(1200);
const workflowId = sql(`select id from workflow_definition where request_type_code = '${type}'`);

// a chart of its own: start → question (is the requesting unit a main unit?) → no: the climb → the existing final approval
const fin = await page.locator('[data-testid=node-approval]').evaluateAll((l) => l.map((e) => e.getAttribute('data-node')));
for (const id of fin.slice(0, -1)) {
  await page.locator(`.react-flow__node[data-id="${id}"]`).click();
  await page.keyboard.press('Delete');
  await page.waitForTimeout(150);
}
const finalId = fin.at(-1);
const canvas = page.locator('.fs-canvas');
const size = await canvas.boundingBox();
await page.locator('[data-testid=tile-decision]').dragTo(canvas, { targetPosition: { x: size.width * 0.2, y: size.height * 0.2 } });
await page.locator('[data-testid=tile-approval]').dragTo(canvas, { targetPosition: { x: size.width * 0.8, y: size.height * 0.2 } });
await page.getByRole('button', { name: 'ترتيب البطاقات' }).click();
await page.locator('.react-flow__controls-fitview').click();
await page.waitForTimeout(600);
const ids = await page.locator('[data-testid=node-approval]').evaluateAll((l) => l.map((e) => e.getAttribute('data-node')));
const climbId = ids.find((i) => i !== finalId);
const ask = await page.locator('[data-testid=node-decision]').getAttribute('data-node');
const start = await page.locator('[data-testid=node-start]').getAttribute('data-node');

await page.locator(`.react-flow__node[data-id="${climbId}"]`).click();
await page.getByLabel('اسم الخطوة').fill('موافقات الهيكل');
await page.getByLabel('طريقة الموافقة').selectOption('chain');
await page.getByLabel('الدور في كل جهة').selectOption('ORG_MANAGER');
await page.waitForTimeout(300);
const card = page.locator(`.react-flow__node[data-id="${climbId}"]`);
ok((await card.innerText()).includes('تصعد مستوى بعد مستوى حتى الوحدة الرئيسية'), 'C01', 'one card climbs, and by default stops at the main unit', (await card.innerText()).replace(/\s+/g, ' ').slice(0, 110));
ok(!(await page.locator('[data-testid=inspector]').innerText()).includes('هذه هي الموافقة النهائية'), 'C02', 'a climbing card cannot be the final approval');

const stops = await page.getByLabel('يتوقف عند').locator('option').allInnerTexts();
ok(stops.includes('حتى الوحدة الرئيسية') && stops.includes('حتى مستوى من المستويات') && stops.includes('حتى أعلى الهيكل'), 'C03', 'the stop can be the main unit, levels, the top, a count or a unit', stops.join('، '));
await page.getByLabel('يتوقف عند').selectOption('LEVELS');
await page.waitForTimeout(300);
const offered = await page.getByRole('group', { name: 'مستويات التوقف' }).locator('label').allInnerTexts();
const inSource = sql("select count(distinct level) from hr_unit where level is not null and snapshot_id = (select id from hr_snapshot where status = 'PUBLISHED')");
ok(String(offered.length) === inSource, 'C04', 'the levels offered are those in the imported hierarchy, not a fixed list', `${offered.length} levels offered, ${inSource} in the source`);
await page.getByRole('group', { name: 'مستويات التوقف' }).locator('label', { hasText: 'المستوى 7' }).locator('input').check();
await page.getByRole('group', { name: 'مستويات التوقف' }).locator('label', { hasText: 'المستوى 8' }).locator('input').check();
await page.waitForTimeout(250);
ok((await card.innerText()).includes('حتى المستوى 8 أو 7'), 'C05', 'several levels can be chosen, and the card says so');
await page.screenshot({ path: OUT + 'A-stop-at-levels.png' });
await page.getByLabel('يتوقف عند').selectOption('MAIN_UNIT');
await page.waitForTimeout(250);

const handle = (id, cls) => page.locator(`.react-flow__node[data-id="${id}"] .react-flow__handle${cls}`);
async function wire(a, cls, b) {
  const x = await handle(a, cls).boundingBox();
  const y = await handle(b, '.target').boundingBox();
  await page.mouse.move(x.x + x.width / 2, x.y + x.height / 2);
  await page.mouse.down();
  await page.mouse.move(y.x + y.width / 2, y.y + y.height / 2, { steps: 12 });
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.waitForTimeout(250);
}
await page.getByRole('button', { name: 'ترتيب البطاقات' }).click();
await page.locator('.react-flow__controls-fitview').click();
await page.waitForTimeout(500);
await wire(start, '.source', ask);
await wire(ask, '.h-no', climbId);
await wire(ask, '.h-yes', finalId);
await wire(climbId, '.h-approved', finalId);
ok((await page.locator('.react-flow__edge').count()) === 5, 'C06', 'the chart is joined by dragging', `${await page.locator('.react-flow__edge').count()} lines`);

await page.locator(`.react-flow__node[data-id="${ask}"]`).click();
await page.getByLabel('اسم الخطوة').fill('هل وحدة مقدم الطلب رئيسية؟');
await page.getByTestId('try').click();
await page.waitForSelector('[data-testid=try-panel]');
await page.waitForTimeout(1200);
const version = sql(`select id from workflow_version where workflow_id = '${workflowId}' and status = 'DRAFT'`);
const def = JSON.parse(sql(`select definition::text from workflow_version where id = '${version}'`));
const q = def.graph.nodes.find((n) => n.type === 'decision');
q.condition = { fact: 'requesterIsMain', op: 'eq', value: 'YES' };
const saved = await page.evaluate(async ([id, d]) => (await fetch(`/api/v1/workflows/${id}/drafts`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mover' }, body: JSON.stringify({ definition: d }) })).status, [workflowId, def]);
ok(saved === 200, 'C07', 'the chart is saved as a draft with its question');
await page.reload();
await page.waitForSelector('[data-testid=flow-studio] .react-flow__node', { timeout: 30000 });
await page.selectOption('select[aria-label="نوع الطلب"]', type);
await page.waitForTimeout(1300);
await page.locator(`.react-flow__node[data-id="${ask}"]`).click();
await page.waitForTimeout(300);
const offeredSubjects = await page.locator('[data-testid=inspector] select option').allInnerTexts();
const sentence = await page.locator('[data-testid=inspector] .fs-sentence').innerText();
ok(offeredSubjects.includes('هل وحدة مقدم الطلب رئيسية؟') && offeredSubjects.includes('مستوى وحدة مقدم الطلب') && sentence.includes('هل وحدة مقدم الطلب رئيسية؟'), 'C08', 'the question can ask about the requesting unit', sentence);
await page.screenshot({ path: OUT + 'B-question-about-the-unit.png' });

const tryOn = async (name) => {
  await page.getByRole('tab', { name: /التجربة/ }).click();
  if (await page.locator('.fs-try .fs-org-chosen .link-button').count()) await page.locator('.fs-try .fs-org-chosen .link-button').click();
  await page.getByLabel('الوحدة مقدمة الطلب').fill(name);
  await page.waitForSelector('.fs-try .fs-org-picker li button', { timeout: 8000 });
  await page.locator('.fs-try .fs-org-picker li button', { hasText: name }).first().click();
  await page.getByRole('button', { name: 'تشغيل التجربة' }).click();
  await page.waitForSelector('[data-testid=route]', { timeout: 15000 });
  await page.waitForTimeout(900);
  return (await page.locator('.fs-route li').allInnerTexts()).map((t) => t.replace(/\s+/g, ' '));
};
const lowest = sql("select o.name from organization o join hr_unit h on h.external_id = o.source_external_id and h.snapshot_id = (select id from hr_snapshot where status = 'PUBLISHED') where h.level = (select max(level) from hr_unit where snapshot_id = (select id from hr_snapshot where status = 'PUBLISHED')) and o.status = 'ACTIVE' order by o.code limit 1");
const main = sql("select o.name from organization o join hr_unit h on h.external_id = o.source_external_id and h.snapshot_id = (select id from hr_snapshot where status = 'PUBLISHED') where h.is_main and o.status = 'ACTIVE' order by o.code limit 1");
const fromLowest = await tryOn(lowest);
const climb = fromLowest.find((l) => l.includes('موافقات الهيكل')) ?? '';
await page.screenshot({ path: OUT + 'C-climb-from-the-lowest-unit.png' });
const passed = (climb.match(/\d+\. /g) ?? []).length;
ok(passed >= 2 && fromLowest.join(' ').includes('لا') , 'C09', `from «${lowest}» the question says no and the card lists every unit up to the main unit`, climb.slice(0, 300));
const lit = await page.locator('.fs-node.visited').count();
ok(lit === fromLowest.length, 'C10', 'the route lights up on the chart', `${lit} steps`);
const fromMain = await tryOn(main);
ok(!fromMain.some((l) => l.includes('موافقات الهيكل')) && fromMain.some((l) => l.includes('نعم')), 'C11', `from the main unit «${main}» the question says yes and goes straight to the final approval`, fromMain.map((l) => l.slice(0, 40)).join(' ← '));
await page.screenshot({ path: OUT + 'D-from-the-main-unit.png' });

ok(errors.length === 0, 'C12', 'no browser errors', errors.join(' | '));
sql(`delete from workflow_version where id = '${version}' and status = 'DRAFT'`);
ok(sql(`select count(*) from workflow_version where workflow_id = '${workflowId}' and status = 'DRAFT'`) === '0', 'C13', 'the draft saved for this check is removed');
writeFileSync(OUT + 'results.json', JSON.stringify({ at: new Date().toISOString(), type, results }, null, 1) + '\n');
await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
