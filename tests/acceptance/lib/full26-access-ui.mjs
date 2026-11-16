// «إدارة الصلاحيات والوحدات» driven as a person drives it (FULL acceptance, 16 Nov 2026): choose a unit by search, «إضافة مستخدم»,
// tick cells and «حفظ التعديلات», or «تعيين» through the units dialog. Every helper only clicks and types; the server decides.
import { go } from './full26-ui.mjs';

const exact = (s) => new RegExp('^\\s*' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$');

export async function openWorkspace(page) {
  await go(page, '#permissions');
  await page.getByTestId('access-workspace').waitFor({ timeout: 20000 });
}

export async function chooseUnit(page, name) {
  const box = page.getByLabel('ابحث عن وحدة بالاسم');
  await box.fill(name);
  const hit = page.getByRole('listbox', { name: 'نتائج البحث' }).getByRole('option').filter({ has: page.locator('b', { hasText: exact(name) }) }).first();
  await hit.waitFor({ timeout: 15000 });
  await hit.click();
  await page.locator('.aw-main .aw-title h2', { hasText: exact(name) }).waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);
}

export async function tab(page, name) {
  await page.locator('.aw-main').getByRole('tab', { name, exact: true }).click();
  await page.waitForTimeout(700);
}

export async function filter(page, text) {
  await page.getByLabel('بحث داخل الوحدة المحددة').fill(text);
  await page.waitForTimeout(900);
}

/** «إضافة مستخدم» ← «إضافة رقم المستخدم بدون ربط الموارد»: the account exists in the directory, with no HR record. */
export async function addUser(page, login) {
  await page.getByTestId('add-user').click();
  const d = page.getByTestId('add-user-dialog');
  await d.waitFor();
  await d.getByText('إضافة رقم المستخدم بدون ربط الموارد').click();
  await d.getByLabel('رقم المستخدم', { exact: true }).fill(login);
  await page.getByTestId('add-user-save').click();
  await d.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(1200);
}

export const row = (page, pid) => page.locator(`table[data-testid=aw-matrix] tr[data-person="${pid}"]`);

/** Ticks a CHECK cell (if not already ticked) — staged until «حفظ التعديلات». Returns whether it changed anything. */
export async function tick(page, pid, code) {
  const cell = row(page, pid).locator(`input[data-cell="${code}"]`);
  await cell.waitFor({ timeout: 15000 });
  if (await cell.isChecked()) return false;
  await cell.check();
  return true;
}

/** «حفظ التعديلات»: saved in one step; a whole-unit change asks for the explicit acknowledgement. Returns the status text. */
export async function saveBatch(page) {
  await page.getByTestId('aw-save').click();
  const done = page.locator('.aw-bar.ok[role=status]');
  const confirm = page.getByTestId('aw-whole');
  await Promise.race([done.waitFor({ timeout: 20000 }), confirm.waitFor({ timeout: 20000 }), page.locator('.aw-bar.bad').waitFor({ timeout: 20000 })]);
  if (await confirm.count()) {
    await confirm.check();
    await page.getByTestId('aw-confirm').click();
    await done.waitFor({ timeout: 20000 });
  }
  if (await page.locator('.aw-bar.bad').count()) return 'REFUSED: ' + (await page.locator('.aw-bar.bad').innerText());
  return (await done.innerText()).replace(/\s+/g, ' ').trim();
}

/**
 * «تعيين» through the units dialog: rows [{name, mode}] where mode is the option value (ONE, BRANCH). Returns the dialog's
 * option labels of the first row (to record what the screen offers) after optional `before(page)` (a screenshot).
 */
export async function assign(page, pid, code, rows, { before = null, everything = false } = {}) {
  await row(page, pid).locator(`button[data-cell="${code}"]`).click();
  const d = page.getByTestId('units-dialog');
  await d.waitFor({ timeout: 15000 });
  if (everything) {
    await d.getByLabel('كل الوحدات الحالية والمستقبلية').check();
  }
  const offered = [];
  for (const r of rows) {
    const search = d.getByTestId('units-tree').getByRole('searchbox');
    await search.fill(r.name);
    const hit = d.getByRole('option').filter({ has: page.locator('b', { hasText: exact(r.name) }) }).first();
    await hit.waitFor({ timeout: 15000 });
    await hit.locator('input[type=checkbox]').check();
    await search.fill('');
    await page.waitForTimeout(500);
    const sel = d.getByLabel('نطاق الاعتماد ' + r.name);
    await sel.waitFor({ timeout: 10000 });
    offered.push(await sel.locator('option').evaluateAll((o) => o.map((x) => x.value + ':' + x.textContent.trim())));
    if (r.mode) await sel.selectOption(r.mode);
  }
  await page.waitForTimeout(800);
  if (before) await before(page);
  await page.getByTestId('units-save').click();
  await d.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(1500);
  return offered;
}

/** «مسؤول إدارة الوصول والصلاحيات»: the ADMIN cell's dialog, the unit with its sub-units, and the rights ticked. */
export async function grantAccessManager(page, pid, code, rights, { before = null } = {}) {
  await row(page, pid).locator(`button[data-cell="${code}"]`).click();
  const d = page.getByTestId('access-admin-dialog');
  await d.waitFor({ timeout: 15000 });
  await d.getByText('هذه الوحدة والوحدات التابعة').click();
  for (const box of await d.locator('input[data-right]').all()) {
    const key = await box.getAttribute('data-right');
    if (rights.includes(key) !== (await box.isChecked())) await box.click();
  }
  if (before) await before(page);
  await page.getByTestId('aa-save').click();
  await d.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(1500);
}
