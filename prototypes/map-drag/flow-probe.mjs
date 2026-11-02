import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'evidence'); mkdirSync(OUT, { recursive: true });
const BASE = 'http://127.0.0.1:5190';
const headed = !process.env.HEADLESS;
const b = await chromium.launch({ channel: 'msedge', headless: !headed });
const ctx = await b.newContext({ locale: 'ar-AE', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errs.push(m.text()); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto(BASE + '/flow.html', { waitUntil: 'load' });
await page.waitForSelector('.fx-fac', { timeout: 15000 });
await sleep(700);
const counts = await page.evaluate(() => ({ facs: document.querySelectorAll('.fx-fac').length, svgs: document.querySelectorAll('.fx-sym-svg svg').length }));
await page.screenshot({ path: join(OUT, 'flow-1-map.png') });

// 1) click a single-org facility → contextual toolbar
await page.locator('.fx-fac', { hasText: 'إدارة المشاريع' }).first().click();
await page.waitForSelector('.fx-toolbar:not([hidden])', { timeout: 8000 });
await sleep(400);
await page.screenshot({ path: join(OUT, 'flow-2-toolbar.png') });
const tbVisible = await page.locator('.fx-toolbar').isVisible();

// 2) propose → draggable symbol copy + range ring
await page.locator('.fx-tb-btn.primary', { hasText: 'اقتراح' }).click();
await page.waitForSelector('.fx-proposal', { state: 'attached', timeout: 8000 });
await page.waitForSelector('.fx-proposal .fx-sym-svg svg', { timeout: 8000 });
await sleep(500);
await page.screenshot({ path: join(OUT, 'flow-3-propose.png') });

// 3) drag the proposal symbol out across the boundary
const box = await page.locator('.fx-proposal .fx-sym-svg').first().boundingBox();
const sx = box.x + box.width / 2, sy = box.y + box.height / 2;
await page.mouse.move(sx, sy); await page.mouse.down();
let occSeen = false, outSeen = false;
const pts = [[sx - 120, sy - 40], [sx - 200, sy + 60], [sx + 60, sy + 180], [sx + 180, sy + 60], [sx - 20, sy - 6]];
for (const [x, y] of pts) { for (let i = 1; i <= 8; i++) { await page.mouse.move(sx + (x - sx) * (i / 8), sy + (y - sy) * (i / 8), { steps: 1 }); await sleep(10); } const cls = await page.locator('.fx-proposal').getAttribute('class'); if (cls && cls.includes('bad')) outSeen = true; }
await page.screenshot({ path: join(OUT, 'flow-4-drag.png') });
await page.mouse.up();
await sleep(400);

// 4) confirmation card (progressive disclosure)
const cardOpen = await page.locator('.fx-panel.open').count();
await page.screenshot({ path: join(OUT, 'flow-5-card.png') });

// 5) Escape cancels → restored
await page.keyboard.press('Escape');
await sleep(400);
const afterEsc = await page.evaluate(() => ({ proposal: document.querySelectorAll('.fx-proposal').length, cardOpen: document.querySelectorAll('.fx-panel.open').length, toolbar: !document.querySelector('.fx-toolbar').hidden }));
await page.screenshot({ path: join(OUT, 'flow-6-restored.png') });

// 6) shared-facility picker
await page.locator('.fx-fac', { hasText: 'جهات' }).first().click();
await page.waitForSelector('.fx-picker:not([hidden])', { timeout: 6000 }).catch(() => {});
await sleep(300);
await page.screenshot({ path: join(OUT, 'flow-7-picker.png') });
const pickerVisible = await page.locator('.fx-picker').isVisible();

console.log(JSON.stringify({ counts, tbVisible, outSeen, cardOpen, afterEsc, pickerVisible, errs: errs.slice(0, 5) }, null, 0));
await ctx.close(); await b.close();
