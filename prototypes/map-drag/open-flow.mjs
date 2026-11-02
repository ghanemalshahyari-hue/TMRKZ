// Opens the symbol-first interaction prototype in a maximized Microsoft Edge window and leaves it open for the owner.
import { chromium } from 'playwright-core';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5190';
const b = await chromium.launch({ channel: 'msedge', headless: false, args: ['--start-maximized'] });
const ctx = await b.newContext({ locale: 'ar-AE', viewport: null });
const page = await ctx.newPage();
await page.goto(BASE + '/flow.html', { waitUntil: 'load' });
await page.waitForSelector('.fx-fac', { timeout: 20000 });
console.log('Flow prototype open at ' + BASE + '/flow.html — click a symbol, propose, drag. Leave running.');
await new Promise(() => {});
