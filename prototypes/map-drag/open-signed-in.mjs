// Opens a real, signed-in TMRKZ window in Microsoft Edge and leaves it open on the stationing workspace so the owner
// can drag the marker by hand. Headed, stays open until stopped. Not a test — a convenience launcher.
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.MOVER_URL ?? 'http://localhost:8088';
const USER = process.env.USER_LOGIN ?? 't.requester';
const PASSWORD = process.env.TMRKZ_TEST_PASSWORD ?? readFileSync(join(HERE, '../../ops/test-env/.generated/user-password'), 'utf8').trim();

const browser = await chromium.launch({ channel: 'msedge', headless: false, args: ['--start-maximized'] });
const ctx = await browser.newContext({ locale: 'ar-AE', timezoneId: 'Asia/Dubai', viewport: null });
const page = await ctx.newPage();

await page.goto(BASE + '/');
await page.getByText('الدخول الآلي بالحساب المؤسسي').click();
await page.locator('#username').fill(USER);
await page.locator('#password').fill(PASSWORD);
await page.locator('#kc-login').click();
await page.waitForSelector('.app-shell', { timeout: 30000 });

// go to the stationing workspace and set up the «طلب تمركز» proposal, ready to drag
await page.evaluate(() => { location.hash = 'stationing'; });
await page.waitForSelector('.stw-top-search input', { timeout: 20000 });
await page.locator('.stw-top-search input').fill('مركز الخدمات');
await page.waitForSelector('.stw-search-pop', { timeout: 15000 });
await page.locator('.stw-search-pop button', { hasText: 'مركز الخدمات' }).first().click();
await page.waitForSelector('.stw-popup', { timeout: 15000 });
await page.getByRole('button', { name: /طلب تمركز/ }).click();
await page.waitForSelector('.stw-proposal .stw-pin', { timeout: 25000 });

console.log('Signed in as ' + USER + '. The stationing workspace is open — drag the green marker. Leave this running.');
await new Promise(() => {}); // keep the window open until the process is stopped
