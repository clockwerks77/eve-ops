// Works the Expedition view with nobody signed in: Adam's one seat, a pilot's muster questions, kit readiness,
// the shopping list, export and import, and a reload with the network off.
//   node tools/expedition-test.js
const assert = require('assert');
const { serve, playwright, chrome } = require('./serve.js');
const FIT = '[Procurer, Camp standard]\nDamage Control II\nMining Laser Upgrade II\n\nMedium Shield Extender II\nMedium Shield Extender II\n\nStrip Miner I\nStrip Miner I\n\nHobgoblin II x5\n';
(async () => {
  const server = await serve(8147);
  const browser = await playwright().chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('https://esi.evetech.net/**', r => r.abort());
  await page.route('https://login.eveonline.com/**', r => r.abort());
  const ok = (name, cond) => { assert.ok(cond, name); console.log('ok  ', name); };
  const data = () => page.evaluate(() => JSON.parse(localStorage.getItem('eveops.expedition')));
  const tab = name => page.locator('.ex-head .view', { hasText: name }).click();

  await page.goto('http://localhost:8147/', { waitUntil: 'networkidle' });
  ok('the sign-in screen offers Expedition ops', await page.locator('.door a[href="#expedition"]').count() === 1);
  await page.click('.door a[href="#expedition"]'); await page.waitForSelector('.ex');
  ok('it opens with nobody signed in', await page.locator('.ex h2').innerText() === 'Expedition ops');

  // acceptance test 1: Adam is one seat with a mode switch, never two pilots
  ok('Adam has exactly one seat and one card', await page.locator('.seat-adam').count() === 1 && await page.locator('.pcard[data-pilot="adam"]').count() === 1);
  ok('the seat names Khiana Kyn, with Todashi Kitsune logged off', /flying Khiana Kyn in the Odysseus/.test(await page.locator('.seat-adam .seat-who').innerText()) && /Todashi Kitsune and the Porpoise stay logged off/.test(await page.locator('.seat-adam').innerText()));
  ok('Adam cannot be put in a second seat', await page.locator('.seat select option', { hasText: 'Adam' }).count() === 0);
  await page.locator('.seat-adam .seg-b', { hasText: 'Todashi-mode' }).click();
  ok('the switch changes the same seat to Todashi Kitsune', /flying Todashi Kitsune in the Porpoise/.test(await page.locator('.seat-adam .seat-who').innerText()) && /Khiana Kyn and the Odysseus stay logged off/.test(await page.locator('.seat-adam').innerText()) && await page.locator('.seat-adam').count() === 1);
  ok('one Adam record is stored, in one mode', (await data()).pilots.filter(p => p.is_adam).length === 1 && (await data()).adam_mode === 'todashi');
  ok('the can-fly table has one row for Adam', await page.locator('.ex-matrix tbody tr', { hasText: 'Adam' }).count() === 1);
  await page.locator('.seat-adam .seg-b', { hasText: 'Khiana-mode' }).click();

  // acceptance test 2: a pilot, the questionnaire, two of four hulls, and the shopping list
  const before = await page.locator('.pcard[data-pilot]').count();
  await page.click('text=Add a pilot');
  ok('a new pilot is added with the questions open', await page.locator('.pcard[data-pilot]').count() === before + 1 && await page.locator('.pcard.is-open .pedit').count() === 1);
  const card = page.locator('.pcard.is-open');
  ok('nothing is answered yet', /0 of 6 questions answered/.test(await card.innerText()) && /ships not asked yet/.test(await card.innerText()));
  const fill = async (label, value) => { const box = card.locator('input[aria-label="' + label + '"]'); await box.fill(value); await box.press('Enter'); await page.waitForTimeout(60); };
  await fill('Real name', 'Wren'); await fill('Character name', 'Wren Test'); await fill('Skill points', '8M');
  await card.locator('.seg-b', { hasText: 'Alpha' }).click();
  await card.locator('.check', { hasText: 'Praxis, Drake or Gila' }).locator('input').check();
  await card.locator('.seg-b', { hasText: 'Maybe' }).click();
  await card.locator('.seg-b', { hasText: 'Nomad only' }).click();
  await fill('Nights and time zone', 'Saturdays, Eastern');
  await card.locator('.seg-b', { hasText: 'Shared SRP pot' }).click();
  await fill('Pot cap in ISK', '500M');
  const text = await card.innerText();
  ok('all six questions are answered', /6 of 6 questions answered/.test(text));
  ok('the gaps are in plain words, with training at the Alpha rate', /Wren: no gas ship\. Assign a Venture and Gas Cloud Harvesting I, about 2 days of training from nothing as an Alpha\./.test(text) && /Wren: no mining barge\./.test(text) && !/no ratting hull/.test(text));
  const wren = (await data()).pilots.find(p => p.display_name === 'Wren');
  ok('the answers are stored on the pilot', wren.sp_approx === 8e6 && wren.omega === false && wren.will_train === 'maybe' && wren.stage_pref === 'nomad' && wren.loss_tolerance.mode === 'pot' && wren.loss_tolerance.pot_cap === 5e8);

  // leave only Adam and Wren, so the list below is exact
  for (let i = 0; i < 3; i++) {
    const blank = page.locator('.pcard[data-pilot]', { hasText: 'not named yet' }).first();
    await blank.locator('text=Muster questions').click();
    await page.click('text=Remove this pilot'); await page.locator('.pcard.is-open .btn', { hasText: /^Remove$/ }).click();
  }
  ok('unnamed pilots can be removed', (await data()).pilots.length === 2);

  await tab('Kit');
  const kit = page.locator('.pcard[data-kit="' + wren.id + '"]'), mine = page.locator('.pcard[data-kit="adam"]');
  for (const k of ['Prospect', 'Praxis']) await kit.locator('.kit-row', { hasText: k }).locator('.seg-b', { hasText: 'Owned' }).click();
  ok('two of four hulls owned reads 50%', /50%/.test(await kit.locator('.pcard-pct').innerText()));
  for (const k of ['Prospect', 'Procurer', 'Praxis', 'PvP reship']) await mine.locator('.kit-row', { hasText: k }).locator('.seg-b', { hasText: 'At camp' }).click();
  ok('hulls staged at camp count too', /100%/.test(await mine.locator('.pcard-pct').innerText()));
  // the Procurer's fit, bought in Rens
  const fit = page.locator('.fitcard[data-hull="procurer"]');
  await fit.locator('text=Paste a fit').click();
  await fit.locator('textarea').fill('not a fit'); await fit.locator('.btn', { hasText: 'Save fit' }).click();
  ok('something that is not a fit is refused', /does not start with a fit header/.test(await fit.innerText()));
  await fit.locator('textarea').fill(FIT); await fit.locator('.btn', { hasText: 'Save fit' }).click();
  ok('the fit is read', /11 modules and items besides the hull/.test(await fit.innerText()));
  await fit.locator('.seg-b', { hasText: 'Rens' }).click();
  // clear the camp stock so only hulls are left
  while (await page.locator('.ex-stock .trip-skip').count()) await page.locator('.ex-stock .trip-skip').first().click();
  const rens = page.locator('.shop-place[data-place="Rens"]');
  const want = 'Damage Control II x1\nHobgoblin II x5\nMedium Shield Extender II x2\nMining Laser Upgrade II x1\nProcurer x1\nStrip Miner I x2';
  ok('the shopping list is exactly the missing hull and its modules, in multibuy format', (await rens.locator('.multibuy').innerText()).trim() === want);
  ok('nothing is bought in Jita, and the doctrine hull with no fit is named as not listed', /nothing to buy/.test(await page.locator('.shop-place[data-place="Jita"]').innerText()) && /PvP reship × 1/.test(await page.locator('#ex-shopping').innerText()));
  await rens.locator('.copy-btn').click(); await page.waitForTimeout(200);
  ok('Copy for Multibuy puts it on the clipboard', await page.evaluate(() => navigator.clipboard.readText()) === want);

  // camp stock: doubled, per pilot
  await page.click('text=Add a line');
  const row = page.locator('.ex-stock tbody tr').last();
  const set = async (label, value) => { const box = row.locator('input[aria-label="' + label + '"]'); await box.fill(value); await box.press('Enter'); await page.waitForTimeout(60); };
  await set('Item name', 'Core Scanner Probe I'); await set('Each', '8'); await set('Have', '10');
  ok('stock is each × pilots × 2, less what is held', /Core Scanner Probe I x22/.test(await page.locator('.shop-place[data-place="Jita"] .multibuy').innerText()));
  await page.locator('#ex-night0 .check', { hasText: 'Comms confirmed' }).locator('input').check();
  ok('the Night 0 checklist counts', /1 of 6/.test(await page.locator('#ex-night0 .block-head').innerText()));

  // export, wipe, import
  await page.locator('.ex-tools .btn', { hasText: 'Export' }).click();
  await page.locator('.ex-io .btn', { hasText: 'Copy as JSON' }).click(); await page.waitForTimeout(200);
  const json = await page.evaluate(() => navigator.clipboard.readText());
  ok('the export is the whole module as JSON', JSON.parse(json).pilots.length === 2 && Array.isArray(JSON.parse(json).loot_events) && Array.isArray(JSON.parse(json).window_records));
  await page.locator('.ex-io .btn', { hasText: 'Copy the muster as Markdown' }).click(); await page.waitForTimeout(200);
  const md = await page.evaluate(() => navigator.clipboard.readText());
  ok('the muster exports as Markdown', /^# Expedition muster/.test(md) && /## Wren/.test(md) && /- Kit: 50%/.test(md) && /## Adam \(one seat: Khiana Kyn or Todashi Kitsune\)/.test(md));
  await page.evaluate(() => localStorage.removeItem('eveops.expedition'));
  await page.reload({ waitUntil: 'networkidle' }); await page.waitForSelector('.ex');
  ok('with the data gone it starts fresh', (await page.locator('.pcard[data-pilot]').count()) === 4);
  await page.locator('.ex-tools .btn', { hasText: 'Import' }).click();
  await page.locator('.ex-io textarea').fill('{"nope":1}'); await page.locator('.ex-io .btn', { hasText: 'Replace with this' }).click();
  ok('an import that is not an export changes nothing', /nothing was changed/.test(await page.locator('.ex-io').innerText()) && (await page.locator('.pcard[data-pilot]').count()) === 4);
  await page.locator('.ex-io textarea').fill(json); await page.locator('.ex-io .btn', { hasText: 'Replace with this' }).click();
  ok('the import brings everything back', (await page.locator('.pcard[data-pilot]').count()) === 2 && await page.locator('.pcard', { hasText: 'Wren' }).count() === 1);

  // no network at all
  await page.waitForFunction(async () => { const r = await navigator.serviceWorker.getRegistration(); return !!(r && r.active) && (await caches.keys()).length > 0; }, null, { timeout: 15000 });
  await ctx.setOffline(true);
  await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.ex', { timeout: 10000 });
  ok('with the network off the page still opens, with the data', await page.locator('.pcard', { hasText: 'Wren' }).count() === 1 && await page.locator('link[rel="stylesheet"]').evaluate(l => !!l.sheet && l.sheet.cssRules.length > 50));
  await tab('Kit');
  await page.locator('.pcard[data-kit="' + wren.id + '"] .kit-row', { hasText: 'Procurer' }).locator('.seg-b', { hasText: 'Owned' }).click();
  await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.ex');
  ok('changes made with the network off are kept', (await data()).kit.some(r => r.pilot_id === wren.id && r.hull_key === 'procurer' && r.status === 'owned'));
  await ctx.setOffline(false);

  // signed in (sample data), it is a third view beside Trading and Wormholes, and those are as they were
  await page.goto('http://localhost:8147/#demo', { waitUntil: 'networkidle' }); await page.reload({ waitUntil: 'networkidle' });
  ok('the top bar has the three views', (await page.locator('.top .view').allInnerTexts()).join(',') === 'Trading,Wormholes,Expedition');
  await page.locator('.top .view', { hasText: 'Expedition' }).click();
  ok('the sample camp is running, so the tab opens on the Camp board', await page.locator('.ex-head .view.is-on').innerText() === 'Camp' && await page.locator('#camp-picket').count() === 1);
  await tab('Muster');
  ok('the sample crew is separate from the real one', await page.locator('.pcard', { hasText: 'Rook' }).count() === 1 && await page.locator('.pcard', { hasText: 'Wren' }).count() === 0);
  await page.locator('.top .view', { hasText: 'Trading' }).click();
  ok('Trading is still there', await page.locator('.stop').count() > 0);
  ok('no page errors', errors.length === 0);
  await browser.close(); server.close();
  console.log('all checks passed');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
