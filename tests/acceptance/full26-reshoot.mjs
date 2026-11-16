// FULL acceptance (16 Nov 2026) — clearer frames of screens already reached, read-only: the matrix cells of the saved grants
// (02, 04b, 06, 07) on a wider screen with the column scrolled into view, and the posture (23, 24) framed on the camp, its primary
// and alternative areas together (the map's view is moved, nothing is saved). Headless.
//   node tests/acceptance/full26-reshoot.mjs
import { closePage, contextFor, go, launch, shot, unitId } from './lib/full26-ui.mjs';
import { chooseUnit, openWorkspace, row, tab } from './lib/full26-access-ui.mjs';
import { execFileSync } from 'node:child_process';

const sql = (q) => execFileSync('docker', ['exec', 'tmrkz-mover-db-1', 'sh', '-c', `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "${q}"`], { encoding: 'utf8' }).trim();
const B = 'وحدة إضافية 1';
const U = (n) => `${B} · ${n}`;
const pid = (n) => sql(`select id from person where username = 'full26.u${String(n).padStart(2, '0')}'`);
const browser = await launch();
const wide = { viewport: { width: 1920, height: 1080 } };

const cell = async (p, n, code, name) => {
  const c = row(p, pid(n)).locator(`[data-cell="${code}"]`).first();
  await c.scrollIntoViewIfNeeded();
  await p.waitForTimeout(400);
  await c.evaluate((e) => (e.closest('td').style.outline = '3px solid #d9822b'));
  await p.locator('.aw-main').screenshot({ path: `C:/Users/ADMIN/Desktop/TMRKZ/docs/evidence/full-acceptance/${name}` });
};
const admin = await contextFor(browser, 'admin', wide);
await openWorkspace(admin);
await chooseUnit(admin, B);
await tab(admin, 'إدارة الصلاحيات');
await cell(admin, 11, 'SITE_SETUP_ADMIN', '07-site-setup-admin.png');
await cell(admin, 6, 'FYI_DISTRIBUTOR', '06c-fyi-distributor-assigned.png');
await cell(admin, 9, 'STATIONING_ACTIVATOR', '07b-activator-assigned.png');
await cell(admin, 4, 'FINAL_APPROVER', '05d-final-approvers-saved.png');
await closePage(admin);
const mgr = await contextFor(browser, 'full26.u14', wide);
await openWorkspace(mgr);
await chooseUnit(mgr, U('م10-1'));
await tab(mgr, 'إدارة الصلاحيات');
await cell(mgr, 1, 'STATIONING_REQUESTER', '02-requester-assigned.png');
await chooseUnit(mgr, B);
await tab(mgr, 'إدارة الصلاحيات');
await cell(mgr, 3, 'UNIT_OPERATIONS_APPROVER', '04b-unit-operations-saved.png');
await chooseUnit(mgr, U('م8-6'));
await tab(mgr, 'إدارة الصلاحيات');
await cell(mgr, 7, 'FYI_RECEIVER', '06-fyi-receiver-assigned.png');
await closePage(mgr);

// the posture, framed on the camp and both areas
const p = await contextFor(browser, 'full26.u10');
await go(p, '#posture');
await p.getByTestId('posture-tree').waitFor({ timeout: 20000 });
await p.waitForTimeout(1500);
await p.getByTestId('posture-tree').locator(`[data-node="${unitId(U('م8-2'))}"] .ut-name`).click();
await p.waitForTimeout(3500);
const frame = (z) => p.evaluate(([c, z]) => document.querySelector('.tz-mapframe .tz-map-layer').tmrkzMap.jumpTo({ center: c, zoom: z }), [[55.997, 24.952], z]);
await frame(12.2);
await p.waitForTimeout(3000);
await shot(p, '23-operational-posture-2d.png');
await p.getByRole('button', { name: '3D', exact: true }).click();
await p.waitForTimeout(4000);
await frame(12.0);
await p.waitForTimeout(6000);
await shot(p, '24-operational-posture-3d.png');
await closePage(p);
await browser.close();
process.exit(0);
