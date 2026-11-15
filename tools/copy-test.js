// Presses price buttons on the sample data (#demo) and checks the "copied" marks: clipboard, progress, undo, clear.
//   node tools/copy-test.js
const assert = require('assert');
const { serve, playwright, chrome } = require('./serve.js');
(async () => {
  const server = await serve(8143);
  const browser = await playwright().chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('https://images.evetech.net/**', r => r.abort());
  await page.goto('http://localhost:8143/#demo', { waitUntil: 'networkidle' });
  const sum = () => page.locator('.stop-sum').first().innerText();
  const prices = page.locator('.stop .rows .price');
  const ok = (name, cond) => { assert.ok(cond, name); console.log('ok  ', name); };
  ok('the sample hub has prices to press', await prices.count() >= 2 && !/copied/.test(await sum()));
  const rowTall = await page.locator('.stop .rows .row').nth(1).evaluate(el => el.getBoundingClientRect().height);
  const first = (await prices.nth(0).innerText()).replace(/,/g, '');
  await prices.nth(0).click(); await page.waitForTimeout(300);
  ok('the price is on the clipboard', await page.evaluate(() => navigator.clipboard.readText()) === first);
  ok('the row is marked and counted', /1 of \d+ copied/.test(await sum()) && await page.locator('.row.is-copied .price.is-done').count() === 1);
  ok('the mark sits on the button and reads "Last" with the time', /^Last \d\d:\d\d/.test(await page.locator('.pm .tag').first().innerText()));
  const tall = () => page.locator('.stop .rows .row').nth(1).evaluate(el => el.getBoundingClientRect().height);
  ok('the mark adds no height to the row', Math.abs(await tall() - rowTall) < 0.5);
  await page.waitForTimeout(1100);
  await prices.nth(1).click(); await page.waitForTimeout(300);
  ok('a second press moves "Last" on', /2 of \d+ copied/.test(await sum()) && await page.locator('.tag.is-last').count() === 1 && /^\d\d:\d\d/.test(await page.locator('.tag').first().innerText()));
  await page.locator('.tag').first().click(); await page.waitForTimeout(200);
  ok('pressing the time removes that mark', /1 of \d+ copied/.test(await sum()));
  await page.click('text=Clear copied marks'); await page.waitForTimeout(200);
  ok('Clear copied marks removes the rest and the button', !/copied/.test(await sum()) && await page.locator('.tag').count() === 0 && await page.locator('text=Clear copied marks').count() === 0);
  ok('no page errors', errors.length === 0);
  await browser.close(); server.close();
  console.log('all checks passed');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
