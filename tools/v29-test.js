// Works the version 29 additions on the sample data (#demo): a sale under cost at the top of the feed and in the phone's alerts,
// a bid to cancel, the week after every fee with a ship sale left out, the hubs' week, listings over the market, a hangar top-up,
// stock kept in Jita when no hub has room, and the New lines screen.
//   node tools/v29-test.js [folder for pictures]
const assert = require('assert'), path = require('path'), fs = require('fs');
const { serve, playwright, chrome, midweek } = require('./serve.js');
(async () => {
  const server = await serve(8149);
  const browser = await playwright().chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED/.test(m.text())) errors.push(m.text()); });
  await page.route('https://images.evetech.net/**', r => r.abort());
  await midweek(page);
  await page.goto('http://localhost:8149/#demo', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const ok = (name, cond, detail) => { assert.ok(cond, name + (detail ? ' (' + detail + ')' : '')); console.log('ok  ', name); };
  const shot = async name => { if (process.argv[2]) { fs.mkdirSync(process.argv[2], { recursive: true }); await page.screenshot({ path: path.join(process.argv[2], name + '.png'), fullPage: true }); } };
  const text = async sel => (await page.locator(sel).first().innerText()).replace(/\s+/g, ' ');

  const feed = await text('.feed li');
  ok('a sale under cost leads the feed, with what it lost', /^Sold under cost: 6 Damage Control II at Hek/.test(feed) && /lost [\d.]+M, at 599,600 each/.test(feed), feed);
  const week = await text('.side .panel:nth-child(2)');
  ok('the week is shown after every broker fee paid', /Net, all fees [\d.]+M sales [\d.]+M, less 19\.\dM of changes, bids and listings/.test(week), week.slice(0, 160));
  ok('the ship sold is not in Sold', /Sold 38\d\.\dM/.test(week) && !/1\.\dB/.test(week.slice(0, 200)), week.slice(0, 200));
  ok('fees are named by line', /Price changes by line/.test(week) && /10MN Afterburner II Jita, bid, 1 change/.test(week));
  const hubs = await text('#hubs');
  ok('each hub\'s week against what is listed there', /Hek \d+ lines [\d.]+M [\d,]+ units [\d.]+M at cost \d+%/.test(hubs), hubs.slice(0, 120));
  const over = await text('#over');
  ok('listings over the market are listed and read', /Priced over the market [\d.]+M listed in \d+ orders/.test(over) && /Light Missile Launcher II Dodixie, 152/.test(over) && /looks like a dump: wait/.test(over), over.slice(0, 200));

  await page.locator('.tab', { hasText: 'Jita' }).click(); await page.waitForTimeout(400);
  const dead = page.locator('.stop .rows .row', { hasText: "'Augmented' Hobgoblin" });
  ok('a bid over its max that bought nothing for days is offered for cancelling', /Cancel/.test(await dead.innerText()) && /nothing filled in 3 days: cancel it to free 95\.8M/.test((await dead.innerText()).replace(/\s+/g, ' ')));
  const web = page.locator('#haul tbody tr', { hasText: 'Stasis Webifier II' });
  ok('stock no hub has room for stays in Jita', /keep \d+ in Jita: no hub has room/.test(await web.innerText()) && /^Hek \d+/.test(await web.locator('td.best').last().innerText()));
  await page.waitForSelector('#fresh table', { timeout: 15000 });
  const fresh = await text('#fresh');
  ok('new lines are screened from the five hubs\' books', /New lines screened .* 4 of 5 items passed/.test(fresh) && /Simple Asteroid Mining Crystal Type A II/.test(fresh) && /Mining Foreman Burst II/.test(fresh), fresh.slice(0, 200));
  ok('a line already traded is not offered, and its kind weights its neighbour', !/Stasis Webifier II/.test(fresh) && /Rig Navigation: you made \d+% on this kind ×0\.\d\d/.test(fresh));
  ok('the lot is held to a day of Jita\'s trade, with its volume', /Jita trades 1,899 a day/.test(fresh));
  const bid = page.locator('#fresh tbody tr').first().locator('button.price');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await bid.click(); await page.waitForTimeout(200);
  ok('the bid copies and is marked', await page.locator('#fresh tbody tr').first().locator('.price.is-done').count() === 1);
  await shot('jita');

  await page.locator('.tab', { hasText: 'Dodixie' }).click(); await page.waitForTimeout(300);
  const top = await text('.stop .hangar');
  ok('stock in a hub\'s hangar is offered as a top-up of a few days of sales', /Top up from the hangar/.test(top) && /Warrior II 300 60 [\d.]+ \d+ 421,300/.test(top), top);
  await shot('dodixie');

  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300);
  ok('no sideways overflow at phone width', await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0);
  ok('no page errors', !errors.length, errors.join(' | '));
  await browser.close(); server.close();
  console.log('all checks passed');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
