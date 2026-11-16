// Works the order rows, the trip plan, the cargo hold, the weekly close and the tracker cost import on the sample data (#demo).
//   node tools/board-test.js
const assert = require('assert');
const { serve, playwright, chrome, midweek } = require('./serve.js');
(async () => {
  const server = await serve(8144);
  const browser = await playwright().chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('https://images.evetech.net/**', r => r.abort());
  await midweek(page);
  await page.goto('http://localhost:8144/#demo', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const ok = (name, cond, detail) => { assert.ok(cond, name + (detail ? ' (' + detail + ')' : '')); console.log('ok  ', name); };
  const text = sel => page.locator(sel).first().innerText();

  // ---- rows keep one height: a Check with its detail is no taller than its neighbours
  await page.locator('.tab', { hasText: 'Jita' }).click(); await page.waitForTimeout(200);
  const tall = () => page.locator('.stop .rows .row:not(.row-head)').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().height)));
  const check = page.locator('.stop .rows .row', { has: page.locator('.chip-check') }).first();
  const rowsBefore = await tall();
  ok('the row with a Check is the same height as the rows beside it', rowsBefore[0] === rowsBefore[1] && rowsBefore[1] === rowsBefore[2] && /Check/.test(await check.innerText()));
  ok('all of its detail is one hover away', /Listed for 1 day, not 90/.test(await check.locator('.call').getAttribute('title')) && /Changing costs/.test(await check.locator('.call').getAttribute('title')));
  await check.locator('.call').click(); await page.waitForTimeout(150);
  ok('a press opens it, and a second press closes it', (await tall())[0] >= rowsBefore[0] && await check.locator('.call.is-open').count() === 1);
  await check.locator('.call').click(); await page.waitForTimeout(150);
  ok('closed again, the rows match', (await tall())[0] === rowsBefore[1]);
  await page.locator('.tab', { hasText: 'Hek' }).click(); await page.waitForTimeout(200);

  // ---- trip plan: a route line
  const names = async () => (await page.locator('.trip-name').allInnerTexts()).join(' > ');
  ok('the plan starts where the character is docked', /^Hek > /.test(await names()) && await page.locator('.trip-stop.is-here .trip-here').count() === 1 && await page.locator('.trip-stop.is-here .trip-track').count() === 0);
  ok('stock is picked up in Jita before it is dropped', /Jita > Hek again/.test(await names()));
  const total = Number((await text('.trip-total')).match(/^(\d+) jump/)[1]);
  const legs = (await page.locator('.trip-leg').allInnerTexts()).map(t => Number((t.match(/(\d+) jump/) || [0, 0])[1]));
  ok('the legs add up to the total (' + total + ' jumps)', legs.reduce((a, b) => a + b, 0) === total);
  ok('each leg is drawn as one square per system', await page.locator('.trip-track .sys').count() === total && await page.locator('.trip-track .sys.is-hot').count() > 0);
  const jobs = (await page.locator('.trip-stop').first().locator('.trip-job').allInnerTexts()).join(' | ');
  ok('what to do at a stop is listed under it', /2 to change/.test(jobs) && /2 your call/.test(jobs) && /list 30 from cargo/.test(jobs) && /planetary pickup/.test(jobs));
  await page.locator('.trip-stop', { hasText: 'Hek again' }).locator('.trip-skip').click(); await page.waitForTimeout(150);
  ok('a return visit can be left out on its own', /^Hek > /.test(await names()) && !/again/.test(await names()) && /Jita/.test(await names()) && /Hek again \(put back\)/.test(await page.locator('.trip').innerText()));
  await page.click('text=Hek again (put back)'); await page.waitForTimeout(150);
  await page.locator('.trip-stop', { hasText: 'Jita' }).locator('.trip-skip').click(); await page.waitForTimeout(150);
  ok('leaving Jita out drops the pick-up and the return visit', !/Jita|again/.test(await names()) && /Left out by you: Jita/.test(await page.locator('.trip .note').first().innerText()));
  const shorter = Number((await text('.trip-total')).match(/^(\d+) jump/)[1]);
  ok('and the trip gets shorter (' + shorter + ' jumps)', shorter < total);
  await page.click('text=Jita (put back)'); await page.waitForTimeout(150);
  await page.locator('.trip-mode >> text=Secure').click(); await page.waitForTimeout(150);
  ok('the secure routes are never shorter', Number((await text('.trip-total')).match(/^(\d+) jump/)[1]) >= total);
  await page.locator('.trip-mode >> text=Shortest').click();
  await page.locator('.trip-name', { hasText: 'Dodixie' }).click(); await page.waitForTimeout(150);
  ok('a stop in the plan opens that hub', /Dodixie/.test(await text('.stop h2')));
  await page.locator('.trip-mode >> text=Hide').click(); await page.waitForTimeout(150);
  ok('hidden, the plan keeps one line with the next stop', await page.locator('.trip-line').count() === 0 && /Next: Rens/.test(await text('.trip-head')));

  // ---- cargo hold
  const hold = page.locator('#hold');
  ok('the hold lists traded items only, and where each sells best', await hold.locator('tbody tr').count() === 2 && /Warrior II/.test(await hold.innerText()) && !/Item 21898/.test(await hold.innerText()));
  ok('in Dodixie the item that sells best there is marked "Here"', /Here/.test(await hold.locator('tbody tr', { hasText: 'Warrior II' }).innerText()) && /1 item to list here/.test(await hold.innerText()));
  await page.locator('.tab', { hasText: 'Hek' }).click(); await page.waitForTimeout(200);
  const dc = hold.locator('tbody tr', { hasText: 'Damage Control II' });
  ok('in Hek the listing price follows the call on the order already there', (await dc.locator('.price').innerText()) === '1,419,000' && /big move on your order here/.test(await dc.innerText()) && await dc.locator('.price.is-soft').count() === 1);
  await dc.locator('.price').click(); await page.waitForTimeout(250);
  ok('pressing it marks it copied', await dc.locator('.price.is-done').count() === 1);
  await dc.locator('.tag').click(); await page.waitForTimeout(150);

  // ---- weekly close
  const rows = page.locator('.closes-table tbody tr');
  ok('this week and the finished weeks are listed', await rows.count() >= 4 && /this week so far/.test(await rows.nth(0).innerText()) && /closed/.test(await rows.nth(1).innerText()));
  const net = await rows.nth(1).locator('td').nth(2).innerText();
  const box = rows.nth(1).locator('.isk-in');
  await box.fill(net.split('\n')[0]); await box.press('Enter'); await page.waitForTimeout(200);
  ok('the tracker figure for last week ties', /Tied/.test(await rows.nth(1).locator('td').nth(4).innerText()) && /Tied 1 week running/.test(await text('#closes .pi-note')));
  await rows.nth(2).locator('.isk-in').fill('5M'); await rows.nth(2).locator('.isk-in').press('Enter'); await page.waitForTimeout(200);
  ok('a figure that is far off is called out with the gap', /Off/.test(await rows.nth(2).locator('td').nth(4).innerText()) && /Tied 1 week running/.test(await text('#closes .pi-note')));
  // a week that is off can be set to the tracker's figure: it counts at that figure and is left out of the tie-out
  const offSum = await text('#closes .stop-sum'), pageNet = (await rows.nth(2).locator('td').nth(2).innerText()).split('\n')[0];
  await rows.nth(2).locator('.linkish', { hasText: 'Use the tracker' }).click(); await page.waitForTimeout(200);
  const lockedCell = await rows.nth(2).locator('td').nth(2).innerText();
  ok('a week that is off can be set to the tracker\'s figure', /^5\.0M/.test(lockedCell) && /the tracker.s figure/.test(lockedCell) && lockedCell.includes('page worked out ' + pageNet) && /Set to tracker/.test(await rows.nth(2).locator('td').nth(4).innerText())
    && await rows.nth(2).locator('.neg').count() === 0, lockedCell);
  ok('"to date" then counts the tracker\'s figure, and the tie-out neither gains nor loses by it', offSum !== await text('#closes .stop-sum') && /Tied 1 week running/.test(await text('#closes .pi-note')));
  await rows.nth(2).locator('.linkish', { hasText: 'Undo' }).click(); await page.waitForTimeout(200);
  ok('Undo puts the page\'s own figure back', (await rows.nth(2).locator('td').nth(2).innerText()).split('\n')[0] === pageNet && /Off/.test(await rows.nth(2).locator('td').nth(4).innerText()) && offSum === await text('#closes .stop-sum'));
  await rows.nth(2).locator('.isk-in').fill((await rows.nth(2).locator('td').nth(2).innerText()).split('\n')[0]); await rows.nth(2).locator('.isk-in').press('Enter'); await page.waitForTimeout(200);
  ok('two tied weeks in a row: the page can take over', /Tied out/.test(await text('#closes .pi-head')) && /take over as the ledger/.test(await text('#closes .pi-note')));
  const before = await text('#closes .stop-sum');
  await page.locator('[data-keep="carried"]').fill('1.25B'); await page.locator('[data-keep="carried"]').press('Enter'); await page.waitForTimeout(200);
  ok('the tracker\'s earlier weeks are added to "to date"', before !== await text('#closes .stop-sum') && /1\.\d+B/.test(await text('#closes .stop-sum')));
  await page.locator('[data-keep="carried"]').fill('nonsense'); await page.locator('[data-keep="carried"]').press('Enter'); await page.waitForTimeout(200);
  ok('a figure that cannot be read changes nothing', (await page.locator('[data-keep="carried"]').inputValue()) === '1,250,000,000');
  // ---- the tracker's cost basis
  const weekNet = async () => (await rows.nth(0).locator('td').nth(2).innerText()).replace(/\n/g, ' | ');
  const was = await weekNet();
  ok('before any costs are pasted, units the wallet cannot account for are called out', /without a cost/.test(was) && /none yet/.test(await text('.closes-costs')));
  await page.click('text=Paste rows from the tracker');
  await page.locator('.costs-text').fill(['Date Listed\tItem\tVenue\tQty Listed\tUnit Cost\tList Price\tRelists\tQty Sold\tAvg Realized\tDate Sold Out\tDays on Market\tStatus\tRealized Net (approx)',
    '2026-10-01\tSmall Shield Extender II\tRens\t60\t401,500\t512,000\t0\t48\t512,000\t\t\tOK\t4,105,440',
    '2026-10-01\tNot A Real Item\tHek\t5\t100\t200\t0\t0\t\t\t\tOK\t0', '', 'Totals\t\t\t\t\t\t\t\t\t\t\t\t4,105,440'].join('\n'));
  await page.click('text=Read these rows'); await page.waitForTimeout(600);
  const now = await weekNet();
  ok('pasted rows give those units a cost, and the week says how many', !/without a cost/.test(now) && /units at tracker cost/.test(now) && now !== was, was + '  ->  ' + now);
  ok('the import says what it read and what it could not place', /1 row, 1 item/.test(await text('.closes-costs')) && /adds to 4\.1M/.test(await text('.closes-costs')) && /Not A Real Item/.test(await page.locator('#closes').innerText()));
  await page.locator('.closes-costs >> text=Remove').click(); await page.waitForTimeout(300);
  ok('removing the costs puts the figures back', (await weekNet()) === was);

  const j = (await rows.nth(1).locator('td').allInnerTexts()).map(t => t.split('\n')[0]);
  ok('fees, wallet change and wallet at close come from the journal', /^[-−]/.test(j[5]) && /^[+-−]/.test(j[6]) && /^\d{1,3}(,\d{3})+$/.test(j[7]));
  // ---- sections under the orders fold down to their heading line
  await page.locator('.tab', { hasText: 'Jita' }).click(); await page.waitForTimeout(200);
  const fold = name => page.locator('.fold', { hasText: name });
  const part = name => page.locator('.block, .pi', { has: fold(name) }).last();
  for (const name of ['Haul manifest', 'In your cargo hold', 'Restock shortlist', 'Planetary Interaction']) {
    const open = await part(name).locator('table').count();
    await fold(name).click(); await page.waitForTimeout(120);
    ok(name + ' folds to its heading', open === 1 && await part(name).locator('table').count() === 0 && await fold(name).getAttribute('aria-expanded') === 'false');
  }
  ok('a folded shortlist still says what is waiting', /\d+ lines?/.test(await part('Restock shortlist').locator('.block-head').innerText()));
  await page.locator('.tab', { hasText: 'Hek' }).click(); await page.waitForTimeout(200);
  ok('the cargo hold stays folded on another hub', await part('In your cargo hold').locator('table').count() === 0);
  await fold('In your cargo hold').click(); await page.waitForTimeout(120);
  ok('a second press opens it again', await part('In your cargo hold').locator('table').count() === 1 && await fold('In your cargo hold').getAttribute('aria-expanded') === 'true');
  ok('no page errors', errors.length === 0);
  await browser.close(); server.close();
  console.log('all checks passed');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
