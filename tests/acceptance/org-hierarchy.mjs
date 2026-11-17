// Read-only #org hierarchy acceptance: the real shared tree, not a source-code-only assertion.
// Local platform example: export TMRKZ_TEST_PASSWORD from the protected installation environment first.
// Optional: ORG_TREE_DEEP_NAME picks a known descendant in another approved acceptance fixture.
import { mkdirSync } from 'node:fs';
import { BASE, launch, newContext, watch, signInAutomatic, consoleErrors } from './lib/browser.mjs';

const checks = [];
const check = (ok, message) => {
  if (!ok) throw new Error(message);
  checks.push(message);
  console.log('PASS', message);
};
const browser = await launch();
const ctx = await newContext(browser, { viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
watch(page, 'developer');

try {
  await signInAutomatic(page, process.env.ORG_TREE_USER ?? 'developer');
  await page.goto(BASE + '/#org');
  await page.locator('aside.org-tree').waitFor({ timeout: 15000 });
  const tree = page.getByTestId('org-page-tree');
  await tree.waitFor({ timeout: 15000 });
  check(await page.locator('.org-nodes .org-node:visible').count() === 0, 'retired flat organization list is not visible');

  const tabs = page.locator('.ut-nodes li[role="treeitem"]:visible');
  const firstCount = await tabs.count();
  const levels = await tabs.evaluateAll((rows) => rows.map((r) => Number(r.getAttribute('aria-level') ?? 0)));
  const totalText = await page.getByText(/\d[\d,]* جهة ضمن نطاقك/).textContent();
  check(firstCount > 0, 'initial shared tree has visible authorized roots/children');
  check(Math.max(...levels) <= 2, 'initially only roots, or one root plus its immediate children, are visible');
  check(firstCount < Number(totalText.match(/\d[\d,]*/)[0].replaceAll(',', '')), 'all descendants are not flattened into the page');
  const height = await page.locator('aside.org-tree').evaluate((el) => el.getBoundingClientRect().height);
  check(height > 0 && height <= 820, `hierarchy remains within a bounded viewport (${Math.round(height)}px)`);
  check(!/\b00\b/.test(await tree.innerText()), 'padded zero site-count badges are absent');
  const total = totalText;
  const initialDetail = await page.locator('.org-summary h2').textContent();

  // A branch twist is independent of organization selection. No organization-detail request is expected.
  const detailCalls = [];
  const listener = (req) => { if (/\/organizations\/[0-9a-f-]{36}/i.test(req.url())) detailCalls.push(req.url()); };
  page.on('request', listener);
  const twist = tree.locator('.ut-nodes > li[role="treeitem"] button.ut-twist').first();
  const beforeToggle = await twist.getAttribute('aria-label');
  await twist.click();
  const after = await tree.locator('.ut-nodes > li[role="treeitem"]').first().getAttribute('aria-expanded');
  check(after === 'false', 'parent branch collapses without selecting it');
  await twist.click();
  check((await tree.locator('.ut-nodes > li[role="treeitem"]').first().getAttribute('aria-expanded')) === 'true', 'parent branch reopens');
  check((await page.locator('.org-summary h2').textContent()) === initialDetail, 'collapse/reopen preserves the selected organization');
  check(detailCalls.length === 0, 'a branch toggle does not write or trigger an organization-detail request');
  page.off('request', listener);

  // Select an immediate child and assert the existing organization detail remains wired.
  const child = tree.locator('.ut-nodes li[role="treeitem"][aria-level="2"] .ut-focus').first();
  check(await child.count() === 1, 'an immediate child is available for selection');
  const childName = (await child.textContent()).replace(/\s+/g, ' ').trim();
  await child.click();
  await page.waitForTimeout(250);
  check((await page.locator('.org-summary h2').textContent()).includes(childName), `child selection opens its existing details (${childName})`);
  check((await child.getAttribute('aria-current')) === 'true', 'selected organization is marked in the tree');

  // Search opens the result's ancestors and reuses the same organization selection, not a new page or data source.
  const deepName = process.env.ORG_TREE_DEEP_NAME ?? 'Level 3-1-1';
  const search = tree.getByRole('searchbox', { name: 'البحث في شجرة الجهات' });
  check(await search.count() === 1, 'shared tree offers its own scoped search');
  await search.fill(deepName);
  const result = tree.locator('.ut-hit', { hasText: deepName }).first();
  await result.waitFor({ timeout: 10000 });
  await result.click();
  await page.waitForTimeout(250);
  check((await page.locator('.org-summary h2').textContent()).includes(deepName), 'search result opens the existing organization detail');
  const deep = tree.locator('.ut-focus[aria-current="true"]', { hasText: deepName });
  check(await deep.count() === 1, 'search reveals the selected descendant through its ancestors');
  await deep.focus();
  await deep.press('ArrowLeft');
  check((await deep.evaluate((el) => el.closest('li').getAttribute('aria-expanded'))) === 'true', 'RTL ArrowLeft expands a parent when applicable');
  await deep.press('ArrowRight');
  check((await deep.evaluate((el) => el.closest('li').getAttribute('aria-expanded'))) === 'false', 'RTL ArrowRight collapses the parent');
  await deep.press('ArrowUp');
  await deep.press('ArrowDown');
  check(await deep.evaluate((el) => el === document.activeElement), 'Up/Down navigation keeps keyboard traversal within visible rows');
  check((await page.getByText(/\d[\d,]* جهة ضمن نطاقك/).textContent()) === total, 'scoped unit total is unchanged by all read-only interactions');
  check(errors.length === 0 && consoleErrors.length === 0, 'hierarchy renders without browser application errors');

  const out = new URL('../../docs/evidence/org-hierarchy/', import.meta.url);
  mkdirSync(out, { recursive: true });
  await page.screenshot({ path: new URL('deep-result.png', out).pathname, fullPage: false });
  console.log(JSON.stringify({ result: 'PASS', checks: checks.length, details: checks }));
} finally {
  await ctx.close();
  await browser.close();
}
