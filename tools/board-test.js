// Works the trip plan and the weekly close on the sample data (#demo) and checks what they show.
//   node tools/board-test.js
const assert = require('assert');
const { serve, playwright, chrome } = require('./serve.js');
(async () => {
  const server = await serve(8144);
  const browser = await playwright().chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('https://images.evetech.net/**', r => r.abort());
  await page.goto('http://localhost:8144/#demo', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const ok = (name, cond) => { assert.ok(cond, name); console.log('ok  ', name); };
  const text = sel => page.locator(sel).first().innerText();

  // ---- trip plan
  const names = async () => (await page.locator('.trip-name').allInnerTexts()).join(' > ');
  ok('the plan starts where the character is docked', /^Hek > /.test(await names()) && /^Here/.test(await text('.trip-stop .trip-leg')));
  ok('stock is picked up in Jita before it is dropped', /Jita > Hek again/.test(await names()));
  const total = Number((await text('.trip-total')).match(/^(\d+) jump/)[1]);
  const legs = (await page.locator('.trip-leg').allInnerTexts()).map(t => Number((t.match(/(\d+) jump/) || [0, 0])[1]));
  ok('the legs add up to the total (' + total + ' jumps)', legs.reduce((a, b) => a + b, 0) === total);
  await page.locator('.trip-stop', { hasText: 'Jita' }).locator('.trip-skip').click(); await page.waitForTimeout(150);
  ok('leaving Jita out drops the pick-up and the return visit', !/Jita|again/.test(await names()) && /Left out by you: Jita/.test(await text('.trip .note')));
  const shorter = Number((await text('.trip-total')).match(/^(\d+) jump/)[1]);
  ok('and the trip gets shorter (' + shorter + ' jumps)', shorter < total);
  await page.click('text=Jita (put back)'); await page.waitForTimeout(150);
  await page.locator('.trip-mode >> text=Secure').click(); await page.waitForTimeout(150);
  ok('the secure routes are never shorter', Number((await text('.trip-total')).match(/^(\d+) jump/)[1]) >= total);
  await page.locator('.trip-mode >> text=Shortest').click();
  await page.locator('.trip-name', { hasText: 'Dodixie' }).click(); await page.waitForTimeout(150);
  ok('a stop in the plan opens that hub', /Dodixie/.test(await text('.stop h2')));
  await page.locator('.trip-mode >> text=Hide').click(); await page.waitForTimeout(150);
  ok('hidden, the plan keeps one line with the next stop', await page.locator('.trip-legs').count() === 0 && /Next: Rens/.test(await text('.trip-head')));

  // ---- weekly close
  const rows = page.locator('.closes-table tbody tr');
  ok('this week and the finished weeks are listed', await rows.count() >= 4 && /this week so far/.test(await rows.nth(0).innerText()) && /closed/.test(await rows.nth(1).innerText()));
  const net = await rows.nth(1).locator('td').nth(2).innerText();
  const box = rows.nth(1).locator('.isk-in');
  await box.fill(net.split('\n')[0]); await box.press('Enter'); await page.waitForTimeout(200);
  ok('the tracker figure for last week ties', /Tied/.test(await rows.nth(1).locator('td').nth(4).innerText()) && /Tied 1 week running/.test(await text('#closes .pi-note')));
  await rows.nth(2).locator('.isk-in').fill('5M'); await rows.nth(2).locator('.isk-in').press('Enter'); await page.waitForTimeout(200);
  ok('a figure that is far off is called out with the gap', /Off/.test(await rows.nth(2).locator('td').nth(4).innerText()) && /Tied 1 week running/.test(await text('#closes .pi-note')));
  await rows.nth(2).locator('.isk-in').fill((await rows.nth(2).locator('td').nth(2).innerText()).split('\n')[0]); await rows.nth(2).locator('.isk-in').press('Enter'); await page.waitForTimeout(200);
  ok('two tied weeks in a row: the page can take over', /Tied out/.test(await text('#closes .pi-head')) && /take over as the ledger/.test(await text('#closes .pi-note')));
  const before = await text('#closes .stop-sum');
  await page.locator('[data-keep="carried"]').fill('1.25B'); await page.locator('[data-keep="carried"]').press('Enter'); await page.waitForTimeout(200);
  ok('the tracker\'s earlier weeks are added to "to date"', before !== await text('#closes .stop-sum') && /1\.\d+B/.test(await text('#closes .stop-sum')));
  await page.locator('[data-keep="carried"]').fill('nonsense'); await page.locator('[data-keep="carried"]').press('Enter'); await page.waitForTimeout(200);
  ok('a figure that cannot be read changes nothing', (await page.locator('[data-keep="carried"]').inputValue()) === '1,250,000,000');
  const j = (await rows.nth(1).locator('td').allInnerTexts()).map(t => t.split('\n')[0]);
  ok('fees, wallet change and wallet at close come from the journal', /^[-−]/.test(j[5]) && /^[+-−]/.test(j[6]) && /^\d{1,3}(,\d{3})+$/.test(j[7]));
  ok('no page errors', errors.length === 0);
  await browser.close(); server.close();
  console.log('all checks passed');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
