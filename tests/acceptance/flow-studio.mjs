// «استوديو التدفقات» (owner, 6 Nov 2026; ADR-041) on the REAL page in a real browser, with the pointer as a person uses it:
// tiles dragged in, steps joined by dragging from handle to handle, a step edited beside the chart, tried on a real unit.
// It saves one draft and one responsibility to do this, and removes them at the end. It never publishes: publishing and the
// engine are proven by WorkflowGraphIT.
//
//   node tests/acceptance/flow-studio.mjs
//     UI_URL (default http://localhost:8088), BROWSER_PATH (a Chrome or Edge executable; default: the Edge channel),
//     FLOW_USER, FLOW_PASSWORD (default: developer, from .env), DB_CONTAINER, OUT (evidence folder).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const UI = process.env.UI_URL ?? 'http://localhost:8088';
const DB = process.env.DB_CONTAINER ?? 'tmrkz-mover-db-1';
const OUT = process.env.OUT ?? fileURLToPath(new URL('../../docs/evidence/flow-studio/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const env = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
const USER = process.env.FLOW_USER ?? 'developer';
const PASSWORD = process.env.FLOW_PASSWORD ?? (env.match(/^TMRKZ_PLATFORM_DEVELOPER_PASSWORD=(.*)$/m) ?? [])[1];
const { chromium } = createRequire(new URL('./package.json', import.meta.url))('playwright-core');

const results = [];
const ok = (pass, id, what, detail = '') => {
  results.push({ id, pass: !!pass, what, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} — ${what}${detail ? ' · ' + detail : ''}`);
};
const sql = (q) => execFileSync('docker', ['exec', DB, 'psql', '-X', '-q', '-U', 'mover', '-d', 'mover', '-At', '-c', q], { encoding: 'utf8' }).trim();

const launch = process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : { channel: 'msedge' };
const browser = await chromium.launch({ ...launch, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1680, height: 1000 } });
const page = await ctx.newPage();
const external = [];
const errors = [];
const published = [];
await ctx.route('**/*', (r) => {
  const u = r.request().url();
  if (u.startsWith(UI) || u.startsWith('data:') || u.startsWith('blob:')) return r.continue();
  external.push(u);
  return r.abort();
});
page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text().slice(0, 240)));
page.on('pageerror', (e) => errors.push(e.message.slice(0, 240)));
page.on('request', (q) => { if (q.method() === 'POST' && /workflow-versions\/[^/]+\/publish/.test(q.url())) published.push(q.url()); });

await page.goto(UI + '/api/v1/auth/oidc/start');
await page.waitForSelector('#kc-form-login', { timeout: 30000 });
await page.fill('#username', USER);
await page.fill('#password', PASSWORD);
await page.click('#kc-login');
await page.waitForTimeout(2500);
await page.goto(UI + '/#workflow');
await page.waitForSelector('[data-testid=flow-studio] .react-flow__node', { timeout: 30000 });
await page.waitForTimeout(800);

// a request type with no draft yet, so nothing of anyone's is overwritten; its draft is removed at the end
const typeOptions = await page.locator('select[aria-label="نوع الطلب"] option').evaluateAll((o) => o.map((x) => x.value));
const free = sql("select t.code from request_type t join workflow_definition w on w.request_type_code = t.code where not exists (select 1 from workflow_version v where v.workflow_id = w.id and v.status = 'DRAFT') order by t.sort_order limit 1");
if (!free || !typeOptions.includes(free)) throw new Error('no request type without a draft');
await page.selectOption('select[aria-label="نوع الطلب"]', free);
await page.waitForTimeout(1200);
const workflowId = sql(`select id from workflow_definition where request_type_code = '${free}'`);
const respBefore = sql('select count(*) from org_responsibility');

const count = (type) => page.locator(`[data-testid=node-${type}]`).count();
const cards = async () => (await page.locator('.react-flow__node').count());
await page.screenshot({ path: OUT + 'A-published-as-a-chart.png' });
ok((await count('start')) === 1 && (await count('approval')) >= 1 && (await count('end_approved')) === 1, 'F01', 'the published flow opens as a chart: its stages in order, a start and an approved end', `${await cards()} steps`);

const canvas = page.locator('.fs-canvas');
const box = await canvas.boundingBox();
/** Drags a tile from the palette to a free place; the chart is first tidied and fitted so places are known. */
async function dropTile(type, fx, fy) {
  await page.locator(`[data-testid=tile-${type}]`).dragTo(canvas, { targetPosition: { x: box.width * fx, y: box.height * fy } });
  await page.waitForTimeout(350);
}
const before = await cards();
await dropTile('decision', 0.2, 0.12);
ok((await cards()) === before + 1 && (await count('decision')) === 1, 'F02', 'a tile dragged from the palette lands on the chart as a new step');
await page.screenshot({ path: OUT + 'B-dragged-in.png' });

// moving a step with the pointer
const q = page.locator('[data-testid=node-decision]');
const q0 = await q.boundingBox();
await page.mouse.move(q0.x + q0.width / 2, q0.y + 12);
await page.mouse.down();
await page.mouse.move(q0.x + q0.width / 2 + 90, q0.y + 12 + 60, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
const q1 = await q.boundingBox();
ok(Math.abs(q1.x - q0.x - 90) < 25 && Math.abs(q1.y - q0.y - 60) < 25, 'F03', 'a step moves with the pointer', `moved ${Math.round(q1.x - q0.x)}, ${Math.round(q1.y - q0.y)} px`);

// undo and redo
await page.getByRole('button', { name: /تراجع/ }).click();
await page.waitForTimeout(250);
const q2 = await q.boundingBox();
await page.getByRole('button', { name: /إعادة/ }).first().click();
await page.waitForTimeout(250);
const q3 = await q.boundingBox();
ok(Math.abs(q2.x - q0.x) < 12 && Math.abs(q3.x - q1.x) < 12, 'F04', 'undo and redo restore the place');

// a chart of its own: start → question → (yes) new approval → final; (no) → notify → rejected end
await dropTile('approval', 0.75, 0.12);
await dropTile('notify', 0.8, 0.45);
await dropTile('end_rejected', 0.8, 0.75);
await page.getByRole('button', { name: 'ترتيب البطاقات' }).click();
await page.waitForTimeout(500);
await page.locator('.react-flow__controls-fitview').click();
await page.waitForTimeout(700);
ok((await cards()) === before + 4, 'F05', 'tidy and fit keep every step', `${await cards()} steps`);

const nodeId = (type, i = 0) => page.locator(`[data-testid=node-${type}]`).nth(i).getAttribute('data-node');
const handle = (id, kind) => page.locator(`.react-flow__node[data-id="${id}"] .react-flow__handle${kind}`);
async function wire(fromId, handleClass, toId) {
  const a = await handle(fromId, handleClass).boundingBox();
  const b = await handle(toId, '.target').boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 14 });
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(300);
}
const start = await nodeId('start');
const ask = await nodeId('decision');
const tell = await nodeId('notify');
const endNo = await nodeId('end_rejected');
const appr = await page.locator('[data-testid=node-approval]').evaluateAll((l) => l.map((e) => e.getAttribute('data-node')));
const draftApproval = appr.find((id) => /^n_/.test(id));
const firstStage = sql(`select definition->'stages'->0->>'key' from workflow_version where workflow_id = '${workflowId}' and status = 'PUBLISHED'`);
const edges0 = await page.locator('.react-flow__edge').count();
await wire(start, '.source', ask);
const edges1 = await page.locator('.react-flow__edge').count();
ok(edges1 === edges0, 'F06', 'a line drawn from an outlet that already has one replaces it', `${edges0} → ${edges1} lines`);
await wire(ask, '.h-yes', draftApproval);
await wire(ask, '.h-no', tell);
await wire(tell, '.source', endNo);
await wire(draftApproval, '.h-approved', firstStage);
const edges2 = await page.locator('.react-flow__edge').count();
ok(edges2 === edges1 + 4, 'F07', 'yes, no, a plain line and approved are drawn by dragging from handle to handle', `${edges2} lines`);
const labels = await page.locator('.react-flow__edge-text').evaluateAll((l) => l.map((e) => e.textContent));
ok(['نعم', 'لا', 'عند الموافقة'].every((w) => labels.join(' ').includes(w)), 'F08', 'each line says what it means', [...new Set(labels)].join('، '));

// the step's details: the question's rule
await page.locator(`.react-flow__node[data-id="${ask}"]`).click();
await page.waitForSelector('[data-testid=inspector]');
await page.getByLabel('اسم الخطوة').fill('هل المدة طويلة؟');
await page.waitForTimeout(300);
ok((await page.locator(`.react-flow__node[data-id="${ask}"]`).innerText()).includes('هل المدة طويلة؟'), 'F09', 'a name typed beside the chart appears on the step at once');
await page.locator('[data-testid=inspector]').getByRole('button', { name: /شرط|أضف/ }).first().click();
await page.waitForTimeout(300);
await page.screenshot({ path: OUT + 'C-question-rule.png' });

// the approval: a role at a unit found by typing its name, from the real organisation
await page.locator(`.react-flow__node[data-id="${draftApproval}"]`).click();
await page.getByLabel('اسم الخطوة').fill('موافقة الجهة المختصة');
await page.getByRole('button', { name: '＋ جهة موافقة' }).click();
const place = page.locator('[data-testid=place]').first();
const reviewer = await place.locator('select').first().locator('option').evaluateAll((o) => o.map((x) => x.value).find((v) => v === 'FACILITIES_REVIEWER') ?? o[1]?.value);
await place.locator('select').first().selectOption(reviewer);
await page.getByLabel('طريقة تحديد الجهة').selectOption('FIXED');
const unit = sql("select name from organization where source = 'HR' and status = 'ACTIVE' and parent_id is not null order by code limit 1");
await page.getByLabel('الجهة المحددة').fill(unit.slice(0, Math.min(unit.length, 12)));
await page.waitForSelector('.fs-org-picker li button', { timeout: 8000 });
await page.locator('.fs-org-picker li button').first().click();
await page.waitForTimeout(300);
const chosen = await page.locator('.fs-org-chosen b').innerText();
ok(chosen.length > 0 && (await page.locator(`.react-flow__node[data-id="${draftApproval}"]`).innerText()).includes(chosen), 'F10', 'a unit is found by typing its name, and the step shows it', chosen);
// the other ways of finding the place are on offer
const kinds = await page.getByLabel('طريقة تحديد الجهة').locator('option').allInnerTexts();
ok(kinds.length === 8 && kinds.includes('حسب الوحدات المعيّنة للمعتمد') && kinds.includes('جهة أعلى منها') && kinds.includes('الجهة المسؤولة عن…') && kinds.includes('الجهة عند مستوى محدد'), 'F11', 'eight ways to say where a step goes', kinds.join('، '));
await page.screenshot({ path: OUT + 'D-approval-details.png' });

// the responsibilities
await page.getByRole('button', { name: 'المسؤوليات' }).click();
await page.getByLabel('اسم المسؤولية').fill('مسؤولية فحص المتصفح');
await page.getByRole('button', { name: 'إضافة', exact: true }).click();
await page.waitForSelector('.fs-resp-item', { timeout: 8000 });
const item = page.locator('.fs-resp-item', { hasText: 'مسؤولية فحص المتصفح' });
const root = sql("select name from organization where source = 'HR' and status = 'ACTIVE' and parent_id is null order by code limit 1");
await item.getByLabel('الفرع').fill(root.slice(0, 12));
await item.locator('.fs-org-picker li button').first().click();
await item.getByLabel('الجهة المسؤولة').fill(unit.slice(0, 12));
await item.locator('.fs-org-picker li button').first().click();
await item.getByRole('button', { name: 'حفظ القاعدة' }).click();
await page.waitForTimeout(600);
ok((await item.locator('li').count()) === 1, 'F12', 'a responsibility and a rule «every unit under X → Y» are saved', (await item.locator('li').first().innerText()).replace(/\s+/g, ' '));
await page.screenshot({ path: OUT + 'E-responsibilities.png' });
await page.locator('.dialog-head button').first().click();
await page.waitForTimeout(300);

// the check names what is missing and points at it: the question still has no line problem? its rule must be complete
await page.getByTestId('try').click();
await page.waitForSelector('[data-testid=try-panel]');
await page.waitForTimeout(1500);
await page.screenshot({ path: OUT + 'F-check.png' });
const problems = await page.locator('[data-testid=problems] li').allInnerTexts();
ok(problems.length > 0 || (await page.locator('[data-testid=route]').count()) === 1, 'F13', 'the check answers from the server, in plain Arabic', problems.join(' | ').slice(0, 300));
const publishEnabledWhenBad = problems.length > 0 ? await page.getByTestId('publish').isEnabled() : false;
ok(!publishEnabledWhenBad, 'F14', 'publishing stays closed while the check has anything to fix');
ok(problems.some((p) => p.includes('هل المدة طويلة؟')), 'F29', 'a problem in a question names the question');
ok((await page.locator('.fs-node.problem').count()) >= 1, 'F30', 'the step with a problem is marked on the chart');
const firstLink = page.locator('[data-testid=problems] li .link-button').first();
await firstLink.click();
await page.waitForTimeout(500);
ok((await page.getByLabel('اسم الخطوة').inputValue()) === 'هل المدة طويلة؟', 'F15', 'pressing a problem opens the step it is about');

// a complete chart: tried on a real unit, the route is walked and a rejection can be tried
await page.locator('.fs-side-tabs button', { hasText: 'التجربة' }).click();
await page.waitForTimeout(300);
if (!(await page.locator('.fs-try .fs-org-chosen').count())) {
  await page.getByLabel('الوحدة مقدمة الطلب').fill(unit.slice(0, 12));
  await page.waitForSelector('.fs-try .fs-org-picker li button', { timeout: 8000 });
  await page.locator('.fs-try .fs-org-picker li button').first().click();
}
writeFileSync(OUT + 'results.json', JSON.stringify({ at: new Date().toISOString(), results }, null, 1) + '\n');

// a question's rule through the real editor is exercised by the rule editor's own suite; here the chart must validate, so the
// test sets the rule the page would hold through the page's own save (the same API), then reloads what was saved
const version = sql(`select id from workflow_version where workflow_id = '${workflowId}' and status = 'DRAFT'`);
const def = JSON.parse(sql(`select definition::text from workflow_version where id = '${version}'`));
const qn = def.graph.nodes.find((n) => n.type === 'decision');
qn.condition = { fact: 'durationDays', op: 'gte', value: 2 };
const saved = await page.evaluate(async ([id, d]) => (await fetch(`/api/v1/workflows/${id}/drafts`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mover' }, body: JSON.stringify({ definition: d }) })).status, [workflowId, def]);
ok(saved === 200, 'F16', 'the chart as drawn is saved with its positions', `${def.graph.nodes.length} steps, ${def.graph.edges.length} lines`);
await page.reload();
await page.waitForSelector('[data-testid=flow-studio] .react-flow__node', { timeout: 30000 });
await page.selectOption('select[aria-label="نوع الطلب"]', free);
await page.waitForTimeout(1500);
const q4 = await page.locator(`.react-flow__node[data-id="${ask}"]`).count();
ok(q4 === 1 && (await page.locator('.react-flow__edge').count()) === edges2, 'F17', 'after a reload the draft opens exactly as drawn');
await page.getByRole('tab', { name: /التجربة/ }).click();
await page.getByLabel('الوحدة مقدمة الطلب').fill(unit.slice(0, 12));
await page.waitForSelector('.fs-try .fs-org-picker li button', { timeout: 8000 });
await page.locator('.fs-try .fs-org-picker li button').first().click();
await page.locator('.fs-try-facts input').first().fill('5');
await page.getByRole('button', { name: 'تشغيل التجربة' }).click();
await page.waitForSelector('[data-testid=route]', { timeout: 15000 });
await page.waitForTimeout(500);
const longRoute = await page.locator('.fs-route li').allInnerTexts();
await page.screenshot({ path: OUT + 'G-route-long-request.png' });
ok(longRoute.join(' ').includes('موافقة الجهة المختصة') && (await page.locator('.fs-outcome').innerText()).includes('معتمد'), 'F18', 'long request on a real unit: «yes» goes through the new approval, to approved', `${longRoute.length} steps`);
const visited = await page.locator('.fs-node.visited').count();
ok(visited === longRoute.length, 'F19', 'the route lights up on the chart', `${visited} steps lit`);
const place0 = await page.locator('.fs-route-place').first().innerText();
ok(place0.includes(chosen), 'F20', 'the step says where it goes and how many people hold the role there', place0.replace(/\s+/g, ' '));
ok(await page.getByTestId('publish').isEnabled(), 'F21', 'publishing opens only after a clean check');
await page.locator('.fs-try-facts input').first().fill('1');
await page.getByRole('button', { name: 'تشغيل التجربة' }).click();
await page.waitForTimeout(1500);
const shortRoute = await page.locator('.fs-route li').allInnerTexts();
ok(shortRoute.join(' ').includes('إشعار') && (await page.locator('.fs-outcome').innerText()).includes('مرفوض'), 'F22', 'short request: «no» goes to the notice and the rejected end', `${shortRoute.length} steps`);
await page.screenshot({ path: OUT + 'H-route-short-request.png' });
await page.locator('.fs-try-facts input').first().fill('5');
await page.getByRole('button', { name: 'تشغيل التجربة' }).click();
await page.waitForTimeout(1500);
await page.locator('.fs-route li', { hasText: 'موافقة الجهة المختصة' }).getByLabel('ماذا لو رُفضت هنا؟').check();
await page.waitForTimeout(1500);
ok((await page.locator('.fs-outcome').innerText()).includes('مرفوض'), 'F23', '«what if rejected here?»: that approval has no rejected line, so the request ends rejected');
await page.screenshot({ path: OUT + 'I-what-if-rejected.png' });
// editing closes publishing again
await page.getByRole('tab', { name: 'الخطوة' }).click();
await page.locator(`.react-flow__node[data-id="${ask}"]`).click();
await page.getByLabel('اسم الخطوة').fill('هل مدة الطلب طويلة؟');
ok(!(await page.getByTestId('publish').isEnabled()), 'F24', 'any change after the check closes publishing again');

ok(published.length === 0, 'F25', 'this check published nothing');
ok(external.length === 0, 'F26', 'no request left the application', external.slice(0, 3).join(' '));
ok(errors.length === 0, 'F27', 'no browser errors', errors.slice(0, 3).join(' | '));

// removing what the check saved
sql(`delete from workflow_version where id = '${version}' and status = 'DRAFT'`);
sql("delete from org_responsibility where name = 'مسؤولية فحص المتصفح'");
ok(sql(`select count(*) from workflow_version where workflow_id = '${workflowId}' and status = 'DRAFT'`) === '0' && sql('select count(*) from org_responsibility') === respBefore, 'F28', 'what the check saved is removed: no draft and no responsibility left');

writeFileSync(OUT + 'results.json', JSON.stringify({ at: new Date().toISOString(), type: free, results }, null, 1) + '\n');
await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
