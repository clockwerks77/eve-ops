// Works the safeguards on the sample data (#demo): a bid held at its max, a bid to pull, the left-behind check, new-line tags,
// the haul manifest's value, split and floor, the trip cap, the exposure panel and its limits, and the fee meter.
//   node tools/risk-test.js [folder for pictures]
const assert = require('assert'), path = require('path'), fs = require('fs');
const { serve, playwright, chrome, midweek } = require('./serve.js');
(async () => {
  const server = await serve(8147);
  const browser = await playwright().chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED/.test(m.text())) errors.push(m.text()); });
  await page.route('https://images.evetech.net/**', r => r.abort());
  await midweek(page);
  await page.goto('http://localhost:8147/#demo', { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  const ok = (name, cond, detail) => { assert.ok(cond, name + (detail ? ' (' + detail + ')' : '')); console.log('ok  ', name); };
  const shot = async name => { if (process.argv[2]) { fs.mkdirSync(process.argv[2], { recursive: true }); await page.screenshot({ path: path.join(process.argv[2], name + '.png'), fullPage: true }); } };

  // ---- the board still asks for the same ten routine changes as before: the safeguards only take a bump away where it would not pay
  const counts = (await page.locator('.tab-count').allInnerTexts()).map(t => Number((t.match(/(\d+) to change/) || [0, 0])[1]));
  ok('ten orders to change across the hubs', counts.reduce((a, b) => a + b, 0) === 10, counts.join('+'));

  await page.locator('.tab', { hasText: 'Jita' }).click(); await page.waitForTimeout(250);
  const row = name => page.locator('.stop .rows .row', { has: page.locator('.name', { hasText: name }) }).first();
  const txt = async name => (await row(name).innerText()).replace(/\s+/g, ' ');

  // ---- a bid whose bump would pass its max is left where it is
  const dc = await txt('Damage Control II');
  ok('outbid past the max bid: "Over max", with no price to type', /Over max/.test(dc) && await row('Damage Control II').locator('.price').count() === 0, dc);
  ok('and it says which two figures decided it', /top bid, 1,192,000, is over your max bid of 1,157,000/.test(await row('Damage Control II').locator('.call').getAttribute('title')), await row('Damage Control II').locator('.call').getAttribute('title'));
  // ---- a bid the hubs no longer pay for is pulled, even while it leads
  const tc = await txt('Tracking Computer II');
  ok('under the floor at every hub: "Pull"', /Pull/.test(tc) && await row('Tracking Computer II').locator('.chip-pull').count() === 1 && /Cancel it or lower it/.test(await row('Tracking Computer II').locator('.call').getAttribute('title')), tc);
  ok('its max is shown in red under the bid', await row('Tracking Computer II').locator('.maxbid.neg').count() === 1 && /max \d{3},\d00 /.test(tc) && /At your bid it nets [45]%/.test(await row('Tracking Computer II').locator('.maxbid').getAttribute('title')), tc);
  // ---- a new line with room: the ordinary bump, its max beside it, and the tag
  const wd = await txt('Warp Disruptor II');
  ok('a new line inside its max keeps its bump', /Change/.test(wd) && (await row('Warp Disruptor II').locator('.price').innerText()) === '839,900', wd);
  ok('with the max bid under the bid, and what it nets one hover away', /838,000 max 9\d\d,\d00 /.test(wd) && /At your bid it nets 2\d%/.test(await row('Warp Disruptor II').locator('.maxbid').getAttribute('title')), wd);
  ok('and it is marked as a new line', /New line/.test(await row('Warp Disruptor II').locator('.fresh').innerText()));
  ok('the hubs behind the max are one hover away', /Hek at 1,178,000.*Rens at 1,098,000.*Dodixie at 1,117,000/.test(await row('Warp Disruptor II').locator('.maxbid').getAttribute('title')), await row('Warp Disruptor II').locator('.maxbid').getAttribute('title'));
  // ---- a bid far under the top bid is a Check
  const ws = await row('Warp Scrambler II').locator('.call').getAttribute('title');
  ok('a bid the market has left behind is a Check', /Check/.test(await txt('Warp Scrambler II')) && /17% under the top bid, so it will not fill/.test(ws), ws);
  ok('a proven line is not tagged', await row('Small Shield Extender II').locator('.fresh').count() === 0);
  const sum = await page.locator('.stop-sum').first().innerText();
  ok('the hub says what its checks and changes come to', /4 to check/.test(sum) && /3 to change for [\d.]+[kM]/.test(sum), sum);
  await shot('risk-jita');

  // ---- haul manifest: value at cost, where a new line goes, the price not to list under
  const haul = page.locator('#haul'), line = haul.locator('tbody tr', { hasText: 'Warp Disruptor II' });
  const head = (await haul.locator('.block-head').innerText()).replace(/\s+/g, ' ');
  ok('the manifest is valued at cost', /149\.5M at cost/.test(head), head);
  const cells = (await line.locator('td').allInnerTexts()).map(t => t.replace(/\s+/g, ' '));
  ok('a new line is shared out between the hubs that pay, by what each trades', /^Hek 58, Rens 37, Dodixie 25 by what each hub trades$/.test(cells[cells.length - 2]), cells.join(' | '));
  ok('a thin listing is marked and not followed', await line.locator('.thin').count() === 1 && (await line.locator('.thin').innerText()) === '2,900,000' && /counted at 1,220,000/.test(await line.locator('.thin').getAttribute('title')));
  ok('with the price that still nets 10%', cells[cells.length - 1] === '966,800', cells[cells.length - 1]);
  ok('a line with sales this week still goes where it sold', /Hek/.test((await haul.locator('tbody tr', { hasText: 'Stasis Webifier II' }).locator('td.best').last().innerText())));
  const cap = haul.locator('[data-keep="lim-trip"]');
  await cap.fill('100M'); await cap.press('Enter'); await page.waitForTimeout(200);
  ok('over the trip cap the manifest says so', /Over your trip cap by 49\.5M: split the load/.test(await haul.locator('.block-head').innerText()));
  await cap.fill('1B'); await cap.press('Enter'); await page.waitForTimeout(200);
  ok('and under it, it does not', !/Over your trip cap/.test(await haul.locator('.block-head').innerText()) && (await cap.inputValue()) === '1.00B');

  // ---- the manifest's list prices and its load list
  ok('where a line is headed, the price to list it at is a button', (await line.locator('.price').count()) === 3 && /list at; front is/.test(cells.join(' ')), cells.join(' | '));
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const first = line.locator('.price').first(), typed = await first.innerText();
  await first.click(); await page.waitForTimeout(250);
  ok('pressing it copies the price and marks it', await line.locator('.price.is-done').count() === 1 && (await page.evaluate(() => navigator.clipboard.readText())) === typed.replace(/,/g, ''));
  await line.locator('.tag').first().click(); await page.waitForTimeout(150);
  const heads = async () => (await haul.locator('thead th').allInnerTexts()).join(' | ');
  await haul.locator('.haul-hub', { hasText: 'Hek' }).click(); await page.waitForTimeout(200);
  const loadSaid = async () => (await haul.locator('.hold-by').innerText()).replace(/\s+/g, ' ');
  ok('picking a hub turns the manifest into what to load for it', /Load from the Jita hangar \| Load \| m³ \| Hold after/.test(await heads()) && /^For Hek: load /.test(await loadSaid()) && /All of it fits/.test(await loadSaid()), await loadSaid());
  ok('with its volume', (await line.locator('td').nth(2).innerText()) === '58' && (await line.locator('td').nth(3).innerText()) !== '');
  ok('only the units headed there are loaded', /^58 of 120 in the hangar$/.test((await line.locator('td').nth(1).innerText()).replace(/\s+/g, ' ')) && /^Hek 58/.test(await line.locator('td.best').last().innerText()));
  const cargo = haul.locator('input[type=number]'), was = await cargo.inputValue();
  const aboard = Number(((await loadSaid()).match(/\(([\d,]+) m³ is already aboard\)/) || [0, '0'])[1].replace(/,/g, ''));
  await cargo.fill(String(aboard + 40)); await cargo.press('Enter'); await page.waitForTimeout(200);
  const after = (await haul.locator('tbody tr td:nth-child(4)').allInnerTexts()).filter(Boolean).map(t => Number(t.replace(/,/g, '')));
  ok('a small hold is filled to its room and no further', / m³ of the 40 m³ free/.test(await loadSaid()) && /will not fit whole/.test(await loadSaid()) && after.length > 0 && after.every((v, i) => v <= 40 && (!i || v >= after[i - 1])) && /hold is full/.test(await haul.locator('tbody').innerText()), await loadSaid());
  await cargo.fill(was); await cargo.press('Enter'); await page.waitForTimeout(200);
  await haul.locator('.haul-hub', { hasText: 'Rens' }).click(); await page.waitForTimeout(200);
  ok('two hubs load for both', /^For Hek, Rens: load /.test(await loadSaid()) && /^95 of 120/.test((await line.locator('td').nth(1).innerText()).replace(/\s+/g, ' ')));
  await shot('risk-load');
  await page.locator('.tab', { hasText: 'Amarr' }).click(); await page.waitForTimeout(200);
  ok('the manifest and its load list show at every hub', /^For Hek, Rens: load /.test(await loadSaid()) && await page.locator('#haul tbody tr').count() > 0);
  await haul.locator('text=Whole manifest').click(); await page.waitForTimeout(200);
  ok('and back to the whole manifest', /In the Jita hangar \| Units/.test(await heads()) && await haul.locator('.hold-by').count() === 0);
  await page.locator('.tab', { hasText: 'Jita' }).click(); await page.waitForTimeout(200);

  // ---- exposure: where the committed ISK is headed, the limits, the gate
  const risk = page.locator('#risk'), rt = async () => (await risk.innerText()).replace(/\s+/g, ' ');
  const before = await rt();
  ok('the panel adds up what is committed and lists the hubs it is headed for', /New lines: open/.test(before) && /Committed buy orders, and stock at cost [\d.]+[MB]/.test(before) && /Hek [\d.]+M/.test(before) && /Dodixie [\d.]+M/.test(before) && /Amarr [\d.]+M/.test(before), before);
  const lim = risk.locator('[data-keep="lim-unproven"]');
  await lim.fill('1M'); await lim.press('Enter'); await page.waitForTimeout(200);
  ok('past a limit, new lines close and the panel says why', /New lines: closed/.test(await rt()) && /Unproven lines hold [\d.]+[MB], over your limit of 1\.0M/.test(await rt()), await rt());
  await lim.fill('4B'); await lim.press('Enter'); await page.waitForTimeout(200);
  const res = risk.locator('[data-keep="lim-reserve"]');
  await res.fill('7B'); await res.press('Enter'); await page.waitForTimeout(200);
  ok('a wallet under the reserve closes them too', /New lines: closed/.test(await rt()) && /wallet, 6\.07B, is under your reserve of 7\.00B/.test(await rt()), await rt());
  await res.fill('nonsense'); await res.press('Enter'); await page.waitForTimeout(200);
  ok('a figure that cannot be read changes nothing', (await res.inputValue()) === '7.00B');
  await res.fill('2B'); await res.press('Enter'); await page.waitForTimeout(200);
  ok('back inside the limits they open again', /New lines: open/.test(await rt()));

  // ---- the fee meter
  const week = (await page.locator('.panel', { has: page.locator('#bumps') }).innerText()).replace(/\s+/g, ' ');
  ok('price changes made this week are counted with their fees', /Price changes 2 changes [\d.]+[kM] in fees, [\d.]+% of net/.test(week) && /Making every change on the board now would cost/.test(week), week);
  await shot('risk-side');

  // ---- phone width: nothing runs off the side
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300);
  ok('no sideways overflow at phone width', await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0);
  await shot('risk-phone');
  ok('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close(); server.close();
  console.log('all checks passed');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
