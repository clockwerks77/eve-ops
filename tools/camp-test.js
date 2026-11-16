// Runs a camp night on the Expedition tab's Camp board, inside a stand-in for the Android app and with the clock
// moved by hand: setup and the Night 0 gate, a mining window with a 45-minute picket rotation across three pilots,
// what the phone is told to ring for, a snooze pressed on the phone, gas and hole timers, the session log,
// the night's Markdown, and reopening on the "where we left off" card.
//   node tools/camp-test.js
const assert = require('assert');
const { serve, playwright, chrome } = require('./serve.js');
const fakeApp = `
  window.__sent = []; window.__acts = [];
  window.EveOpsNative = { onmessage: null, postMessage(text) {
    const m = JSON.parse(text); window.__sent.push(m);
    const reply = r => setTimeout(() => this.onmessage({ data: JSON.stringify(Object.assign({ rpc: m.rpc }, r)) }), 5);
    if (m.op === 'notify') reply({ allowed: true, settings: true, timers: true, exact: true });
    if (m.op === 'who') reply({ slots: {} });
    if (m.op === 'timers') reply({ ok: true, allowed: true, exact: true });
    if (m.op === 'timer-acts') reply({ acts: window.__acts.splice(0) });
  } };`;
(async () => {
  const server = await serve(8149), base = 'http://localhost:8149/';
  const browser = await playwright().chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(fakeApp);
  await page.route('https://esi.evetech.net/**', r => r.abort());
  await page.route('https://login.eveonline.com/**', r => r.abort());
  await page.clock.install({ time: new Date('2026-11-20T20:00:00') });
  const ok = (name, cond, detail) => { assert.ok(cond, name + (detail ? ' :: ' + detail : '')); console.log('ok  ', name); };
  const data = () => page.evaluate(() => JSON.parse(localStorage.getItem('eveops.expedition')));
  const pushed = () => page.evaluate(() => window.__sent.filter(m => m.op === 'timers').pop() || null);
  const text = sel => page.locator(sel).innerText();
  const settle = () => page.waitForTimeout(450);
  const ahead = async t => { await page.clock.fastForward(t); await settle(); };
  const MIN = 60000;

  await page.goto(base + '#expedition', { waitUntil: 'load' }); await page.waitForSelector('.ex');
  // three named pilots, so the rotation has names
  await page.evaluate(() => { const d = window.Ex.data(); ['Rook', 'Finch', 'Wick'].forEach((n, i) => { d.pilots[i + 1].display_name = n; }); localStorage.setItem('eveops.expedition', JSON.stringify(d)); });
  await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.ex');
  ok('with no camp the tab opens on Muster, and Camp offers the setup', await page.locator('.pcard[data-pilot]').count() === 4);
  await page.locator('.ex-head .view', { hasText: 'Camp' }).click();
  await page.click('text=Create the camp');
  ok('a camp needs a system name', /Name the system first/.test(await text('#camp-setup')));
  await page.fill('input[aria-label="System"]', 'J123405'); await page.fill('input[aria-label="Statics"]', 'highsec, C3');
  await page.click('text=Create the camp'); await settle();
  ok('the camp is created with a hole for each static', /J123405/.test(await text('#camp-status')) && await page.locator('.hole').count() === 2 && (await data()).camps[0].status === 'setup');
  ok('Night 1 waits for the Night 0 checklist', await page.locator('#camp-left .btn', { hasText: 'Start Night 1' }).isDisabled() && /0 of 6/.test(await text('#camp-left')));
  ok('a camp not yet started does not take over the page\u2019s opening view', await page.evaluate(() => window.Ex.campOpen()) === false);
  for (const box of await page.locator('#camp-left .check input').all()) await box.check();
  ok('with every box ticked it can start', await page.locator('#camp-left .btn', { hasText: 'Start Night 1' }).isEnabled());
  await page.click('text=Start Night 1'); await settle();
  ok('Night 1 is running', /^NIGHT\s*1/i.test((await page.locator('.cs').nth(1).innerText()).trim()) && (await data()).camps[0].status === 'active' && await page.evaluate(() => window.Ex.campOpen()));

  // acceptance test 4: a mining window, 45-minute picket rotation across three pilots
  ok('the rotation is offered in roster order', (await page.locator('#camp-start [data-rot].is-on').allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim()).join('|') === '1 Rook|2 Finch|3 Wick');
  const t0 = await page.evaluate(() => Date.now());
  await page.click('text=Start the Mining window'); await settle();
  let w = (await data()).windows[0];
  ok('the window starts with everyone present, flown by Khiana Kyn', w.type === 'mining' && w.pilot_ids.length === 4 && w.adam_mode === 'khiana' && Math.abs(w.start - t0) < 2000);
  ok('Rook is on picket, Finch is next', /Rook/.test(await text('.picket-on')) && /Finch/.test(await text('.picket-next')));
  let p = await pushed();
  const turns = p.alerts.filter(a => /^Picket: /.test(a.title));
  ok('the phone is told of the changes in order: Finch, Wick, Rook, Finch', turns.slice(0, 4).map(a => a.title).join('|') === 'Picket: Finch takes over|Picket: Wick takes over|Picket: Rook takes over|Picket: Finch takes over', JSON.stringify(turns.slice(0, 4).map(a => a.title)));
  ok('each 45 minutes after the last, with a second ring 5 minutes on', turns.slice(0, 3).every((a, i) => Math.abs(a.at - (w.start + (i + 1) * 45 * MIN)) < 5 && a.late.at === a.at + 5 * MIN && a.actions.join() === 'done,snooze'));
  ok('and of which timers exist', p.live.length === 2);

  await ahead('45:02');
  ok('at 45 minutes Finch is on and the change waits to be confirmed', /Finch/.test(await text('.picket-on')) && /Wick/.test(await text('.picket-next')) && /Finch took over/.test(await text('#camp-picket')) && await page.locator('#camp-picket.is-due').count() === 1);
  p = await pushed();
  ok('the unconfirmed change stays listed for its second ring', p.alerts[0].at === w.start + 45 * MIN && p.alerts[0].late.at === w.start + 50 * MIN);
  await page.locator('#camp-picket .btn', { hasText: 'Confirmed' }).click(); await settle();
  p = await pushed();
  ok('Confirmed drops the second ring', await page.locator('#camp-picket.is-due').count() === 0 && p.alerts[0].at === w.start + 90 * MIN);

  // nobody touches the phone for an hour and a half: the rotation carries on by itself
  await ahead('01:35:00');
  ok('at 2 h 20 min Rook is on again, after Finch and Wick', /Rook/.test(await text('.picket-on')) && /Finch/.test(await text('.picket-next')));
  w = (await data()).windows[0];
  ok('the window log has who picketed, in order', w.pickets.map(s => s.pilot_id).length === 3 && /So far: Rook .* Finch .* Wick /.test(await text('#camp-picket')));
  ok('each turn 45 minutes', w.pickets.every(s => s.to - s.from === 45 * MIN) && w.pickets[0].from === w.start);

  // Snooze pressed on the phone's notification for the change at 2 h 15 min: Wick stays on ten more minutes
  const boundary = w.start + 135 * MIN, picketId = (await data()).timers.find(t => t.kind === 'picket').id;
  const pressedAt = await page.evaluate(() => Date.now());
  await page.evaluate(a => { window.__acts.push(a); }, { id: picketId + ':' + boundary, act: 'snooze', at: pressedAt, until: pressedAt + 10 * MIN });
  await ahead('00:06'); await settle();
  ok('a snooze on the phone takes the change back', /Wick/.test(await text('.picket-on')) && /Rook/.test(await text('.picket-next')) && (await data()).windows[0].pickets.length === 2);
  p = await pushed();
  ok('and the phone is told the new times', p.alerts.find(a => /^Picket/.test(a.title)).at === pressedAt + 10 * MIN && p.alerts.find(a => /^Picket/.test(a.title)).title === 'Picket: Rook takes over');
  await ahead('10:00');
  ok('ten minutes later Rook is on', /Rook/.test(await text('.picket-on')));
  await page.locator('#camp-picket .btn', { hasText: 'Not yet' }).click(); await settle();
  ok('Not yet on the page does the same', /Wick/.test(await text('.picket-on')) && /10 more|in 9:5|in 10:0/.test(await text('#camp-picket')));
  await page.locator('#camp-picket .btn', { hasText: 'Change now' }).click(); await settle();
  ok('Change now hands over at once, confirmed', /Rook/.test(await text('.picket-on')) && await page.locator('#camp-picket.is-due').count() === 0);

  // acceptance test 1 on the camp board: one seat, and the switch changes the hull shown as flown
  ok('Adam is one cell: Khiana Kyn in the Odysseus, Todashi Kitsune logged off', await page.locator('.cs-adam').count() === 1 && /Khiana Kyn in the Odysseus/.test(await text('.cs-adam')) && /Todashi Kitsune and the Porpoise: logged off/.test(await text('.cs-adam')));
  await page.locator('.cs-adam .seg-b', { hasText: 'Todashi-mode' }).click(); await settle();
  ok('the switch shows Todashi Kitsune in the Porpoise and logs Khiana Kyn off', /Todashi Kitsune in the Porpoise/.test(await text('.cs-adam')) && /Khiana Kyn and the Odysseus: logged off/.test(await text('.cs-adam')) && !/Khiana Kyn in the Odysseus/.test(await text('.camp')));
  ok('the running window follows him', (await data()).windows[0].adam_mode === 'todashi' && /Adam flying Todashi Kitsune/.test(await text('#camp-window')));

  // gas: one tap, a 15-minute warning
  await page.fill('input[aria-label="Gas site name"]', 'Barren Perimeter Reservoir');
  const gasAt = await page.evaluate(() => Date.now());
  await page.locator('#camp-timers .btn', { hasText: 'Entered a gas site' }).click(); await settle();
  p = await pushed();
  const gas = p.alerts.find(a => /^Sleepers imminent/.test(a.title));
  ok('a gas timer rings at 15 minutes', !!gas && gas.title === 'Sleepers imminent: Barren Perimeter Reservoir' && Math.abs(gas.at - (gasAt + 15 * MIN)) < 2000 && /Sleepers in 1[45]:/.test(await text('.tcard[data-timer="gas"]')));
  await ahead('15:05');
  ok('after 15 minutes the card says sleepers are due', await page.locator('.tcard[data-timer="gas"].is-due').count() === 1 && /Sleepers due/.test(await text('.tcard[data-timer="gas"]')));
  const liveBefore = (await pushed()).live.length;
  await page.locator('.tcard[data-timer="gas"] .btn', { hasText: 'Left the site' }).click(); await settle();
  ok('leaving the site removes the timer, and the phone is told', await page.locator('.tcard[data-timer="gas"]').count() === 0 && (await pushed()).live.length === liveBefore - 1);

  // a hole at end of life: rings at 60 and 15 minutes left of its four hours
  const eolAt = await page.evaluate(() => Date.now());
  await page.locator('.hole', { has: page.locator('input[value="C3 static"]') }).locator('.check', { hasText: 'End of life' }).locator('input').check(); await settle();
  p = await pushed();
  const eol = p.alerts.filter(a => /^Hole to C3 static/.test(a.title));
  ok('end of life starts a four-hour timer with two rings', eol.length === 2 && Math.abs(eol[0].at - (eolAt + 180 * MIN)) < 2000 && Math.abs(eol[1].at - (eolAt + 225 * MIN)) < 2000 && /60 minutes left at most/.test(eol[0].title)
    && await page.locator('.tcard[data-timer="eol"]').count() === 1 && /gone by/.test(await text('.hole.is-eol')));
  await page.locator('.hole.is-eol .check', { hasText: 'Picketed' }).locator('input').check(); await settle();

  // the session log
  const note = page.locator('#camp-window input[aria-label="Window note"]');
  await note.fill('Rolled the C3 twice, hunter on the chain, stood down early'); await note.press('Enter'); await settle();
  await page.click('text=End the window'); await settle();
  const d1 = await data();
  w = d1.windows[0];
  const rec = d1.window_records[0];
  ok('ending the window closes the last picket turn and stops its timers', !!w.end && w.pickets[w.pickets.length - 1].to === w.end && !d1.timers.some(t => t.kind === 'picket' || t.kind === 'window') && d1.timers.some(t => t.kind === 'eol'));
  ok('a WindowRecord is written for the ISK-per-hour module', d1.window_records.length === 1 && rec.camp_id === d1.camps[0].id && rec.type === 'mining' && rec.start === w.start && rec.end === w.end && rec.pilot_ids_present.length === 4 && rec.adam_mode === 'todashi');
  ok('the phone has no picket change left to ring for', !(await pushed()).alerts.some(a => /^Picket/.test(a.title)));
  ok('the log shows the window, its picket turns and its note', /Mining/.test(await text('#camp-log')) && /Picket: Rook .*Finch .*Wick/.test(await text('#camp-log')) && await page.locator('#camp-log input[aria-label="Note for the Mining window"]').inputValue() === 'Rolled the C3 twice, hunter on the chain, stood down early');
  ok('with no window running the board shows where we left off', /Last window: Mining/.test(await text('#camp-left')) && /Rolled the C3 twice/.test(await text('#camp-left')) && await page.locator('#camp-start').count() === 1);

  // acceptance tests 6 and 7: end the night, shut the app, open it again
  await page.locator('#camp-left .btn', { hasText: 'End Night 1' }).click(); await settle();
  await page.locator('#camp-left .btn', { hasText: 'Copy Night 1 as Markdown' }).click(); await settle();
  const md = await page.evaluate(() => (window.__sent.filter(m => m.op === 'copy').pop() || {}).text);
  ok('the night exports as Markdown with windows, picket, notes, bank and holes', /^# Camp \u2014 Night 1\n/.test(md) && /\| Mining \| 20:0\d \| /.test(md) && /Todashi Kitsune \| Adam, Rook, Finch, Wick \| Rook 20:0/.test(md)
    && /- Mining, 20:0\d: Rolled the C3 twice/.test(md) && /## Bank/.test(md) && /- C3 static: fresh, end of life seen \d\d:\d\d, picketed/.test(md) && /1 window, /.test(md), md);
  await page.goto('about:blank');
  await page.goto(base, { waitUntil: 'load' }); await page.waitForSelector('.ex'); await settle();
  const left = await text('#camp-left');
  ok('reopened with no address, the page lands on the camp board\u2019s re-entry card', await page.locator('.ex-head .view.is-on').innerText() === 'Camp' && /Where we left off/.test(left));
  ok('which sums up the night: when it ended, the last window, the holes', /Night 1 ended .*: 1 window, /.test(left) && /Last window: Mining, .* Adam flying Todashi Kitsune, with Rook, Finch, Wick/.test(left) && /Picket: Rook, then Finch, then Wick/.test(left)
    && /C3 static fresh, end of life since/.test(left) && /Start Night 2/.test(left), left);
  ok('the hole\u2019s timer is still running after the restart', await page.locator('.tcard[data-timer="eol"]').count() === 1 && (await pushed()).alerts.some(a => /^Hole to C3 static/.test(a.title)));
  ok('a link to Trading still opens Trading', await (async () => { await page.goto(base + '#trading', { waitUntil: 'load' }); await settle(); return (await page.locator('.ex').count()) === 0; })());
  await page.goto(base + '#expedition', { waitUntil: 'load' }); await page.waitForSelector('.ex'); await settle();

  // ending the camp
  await page.locator('#camp-strike .btn', { hasText: 'End this camp' }).click();
  await page.locator('#camp-strike .btn', { hasText: /^End the camp$/ }).click(); await settle();
  const d2 = await data();
  ok('an ended camp leaves the board for a new one, keeps its log, and silences its timers', await page.locator('#camp-setup').count() === 1 && /J123405/.test(await text('#camp-earlier')) && d2.camps[0].status === 'ended' && d2.timers.length === 0
    && (await pushed()).alerts.length === 0 && d2.window_records.length === 1 && await page.evaluate(() => window.Ex.campOpen()) === false);
  ok('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close(); server.close();
  console.log('all checks passed');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
