// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/logic.js');

test('tick rule: four significant figures', () => {
  // cases quoted in the trading notes
  assert.equal(L.tickAbove(1354000), 1355000);
  assert.equal(L.tickAbove(402200), 402300);
  assert.equal(L.tickAbove(955.0), 955.1);
  assert.equal(L.tickBelow(1323000), 1322000);
  assert.equal(L.tickBelow(985500), 985400);
  assert.equal(L.tickBelow(9690000), 9689000);
  // band edges
  assert.equal(L.tickBelow(1000000), 999900);
  assert.equal(L.tickAbove(999900), 1000000);
  assert.equal(L.tickBelow(100000), 99990);
  assert.equal(L.tickAbove(99990), 100000);
  assert.equal(L.tickAbove(9999000), 10000000);
  assert.equal(L.tickBelow(10000000), 9999000);
  assert.equal(L.tickAbove(12340000), 12350000);
  assert.equal(L.tickBelow(1000), 999.9);
  assert.equal(L.tickBelow(0.01), null);
  // a rival sitting off-grid still yields a legal price
  assert.equal(L.tickBelow(1322999.99), 1322000);
  assert.equal(L.tickAbove(579700.5), 579800);
  for (const p of [999900, 1322000, 955.1, 99990, 12350000, 0.02]) assert.ok(L.isLegal(p), String(p));
  for (const p of [1322500, 955.15, 12345000]) assert.ok(!L.isLegal(p), String(p));
});

const S = 60005686; // Hek
const sell = (id, price, vol, issued, loc) => ({ order_id: id, is_buy_order: false, price, volume_remain: vol, volume_total: vol, location_id: loc || S, issued: issued || '2026-11-10T00:00:00Z', range: 'region', system_id: 30002053 });
const buy = (id, price, vol, issued, range, loc, sys) => ({ order_id: id, is_buy_order: true, price, volume_remain: vol, volume_total: vol, location_id: loc || 60003760, issued: issued || '2026-11-10T00:00:00Z', range: range || 'station', system_id: sys || 30000142 });

test('sell position: undercut, leading, tie, other stations ignored', () => {
  const mine = sell(1, 1323000, 55);
  const book = [mine, sell(2, 1317000, 30), sell(3, 1318000, 12), sell(4, 1330000, 5), sell(5, 1000000, 99, null, 60004588), buy(9, 1200000, 10)];
  const p = L.sellPosition(mine, book, new Set([1]), true);
  assert.equal(p.status, 'undercut');
  assert.equal(p.front, 1317000);
  assert.equal(p.unitsUnder, 42);
  assert.deepEqual(p.under, [{ price: 1317000, units: 30 }, { price: 1318000, units: 12 }]);
  assert.equal(p.next, 1330000);

  const lead = L.sellPosition(sell(1, 1300000, 55), [sell(1, 1300000, 55), sell(2, 1317000, 30)], new Set([1]), true);
  assert.equal(lead.status, 'leading');
  assert.equal(lead.next, 1317000);

  // same price: the older order sells first
  const older = L.sellPosition(sell(1, 1317000, 55, '2026-11-12T00:00:00Z'), [sell(1, 1317000, 55, '2026-11-12T00:00:00Z'), sell(2, 1317000, 30, '2026-11-11T00:00:00Z')], new Set([1]), true);
  assert.equal(older.status, 'behind');
  assert.equal(older.tiedAhead, 30);
  const newer = L.sellPosition(sell(1, 1317000, 55, '2026-11-10T00:00:00Z'), [sell(1, 1317000, 55, '2026-11-10T00:00:00Z'), sell(2, 1317000, 30, '2026-11-11T00:00:00Z')], new Set([1]), true);
  assert.equal(newer.status, 'leading');
});

test('sell position: the newer source wins, and a missing order is flagged', () => {
  const listed = sell(1, 1323000, 55);
  const inBook = Object.assign(sell(1, 1317000, 40), { volume_total: 55 });
  assert.equal(L.sellPosition(listed, [inBook], new Set([1]), true).price, 1317000);
  assert.equal(L.sellPosition(listed, [inBook], new Set([1]), true).remain, 40);
  assert.equal(L.sellPosition(listed, [inBook], new Set([1]), false).price, 1323000);
  assert.equal(L.sellPosition(listed, [sell(2, 1, 1)], new Set([1]), true).status, 'gone');
  assert.notEqual(L.sellPosition(listed, [sell(2, 1400000, 1)], new Set([1]), false).status, 'gone');
});

const ctx = { cost: 1100000, jitaSell: 1150000, isJita: false, netMult: 0.95125, modify: 0.0039, sniperUnits: 5, bigMove: 0.02 };
const grp = (orders, book) => { const ids = new Set(orders.map(o => o.order_id)); return orders.map(order => ({ order, pos: L.sellPosition(order, book, ids, true) })); };

test('sell call: tick one legal step under the front', () => {
  const mine = sell(1, 1323000, 55);
  const plan = L.planSells(grp([mine], [mine, sell(2, 1317000, 30)]), ctx).get(1);
  assert.equal(plan.action, 'tick');
  assert.equal(plan.target, 1316000);
  assert.ok(Math.abs(plan.fee - 1316000 * 55 * 0.0039) < 1e-6);
  assert.ok(Math.abs(plan.net - (1316000 * 0.95125 - 1100000)) < 1e-6);
});

test('sell call: both same-item orders get the same price (the wrong-order goof)', () => {
  const a = sell(1, 1317000, 2), b = sell(2, 1323000, 55);
  // market is behind us: the 2-unit order leads, the 55-unit order was missed
  const plan = L.planSells(grp([a, b], [a, b, sell(3, 1320000, 10)]), ctx);
  assert.equal(plan.get(1).action, 'hold');
  assert.equal(plan.get(2).action, 'tick');
  assert.equal(plan.get(2).target, 1317000);
  // market undercuts both: one shared target
  const plan2 = L.planSells(grp([a, b], [a, b, sell(3, 1310000, 40)]), ctx);
  assert.equal(plan2.get(1).target, 1309000);
  assert.equal(plan2.get(2).target, 1309000);
});

test('sell call: hold against dumps and Jita-level fronts, flag snipers', () => {
  const mine = sell(1, 1323000, 55);
  const dump = L.planSells(grp([mine], [mine, sell(2, 1150000, 104)]), ctx).get(1);
  assert.equal(dump.action, 'hold');
  assert.match(dump.reason, /below your cost/);
  const jita = L.planSells(grp([mine], [mine, sell(2, 1260000, 60)]), Object.assign({}, ctx, { jitaSell: 1270000 })).get(1);
  assert.equal(jita.action, 'hold');
  assert.match(jita.reason, /Jita/);
  const sniper = L.planSells(grp([mine], [mine, sell(2, 1322000, 3)]), ctx).get(1);
  assert.equal(sniper.action, 'optional');
  assert.equal(sniper.target, 1321000);
  const unknownCost = L.planSells(grp([mine], [mine, sell(2, 1317000, 30)]), Object.assign({}, ctx, { cost: null, jitaSell: null })).get(1);
  assert.equal(unknownCost.action, 'tick');
  assert.equal(unknownCost.net, null);
});

test('sell call: a front far below you is flagged as a big move, not a routine change', () => {
  // seen live: 328,800 against a front of 250,000 that is still above cost and above Jita
  const mine = sell(1, 328800, 200);
  const c = Object.assign({}, ctx, { cost: 208000, jitaSell: 232000 });
  const plan = L.planSells(grp([mine], [mine, sell(2, 250000, 86)]), c).get(1);
  assert.equal(plan.action, 'optional');
  assert.equal(plan.kind, 'big');
  assert.equal(plan.target, 249900);
  assert.match(plan.reason, /24% under you/);
  // 0.5% under is routine
  const near = L.planSells(grp([mine], [mine, sell(2, 327200, 86)]), c).get(1);
  assert.equal(near.action, 'tick');
  // a dump below cost still wins over "big move"
  const dump = L.planSells(grp([mine], [mine, sell(2, 215000, 86)]), c).get(1);
  assert.equal(dump.action, 'hold');
});

test('buy position and bid call', () => {
  const mine = buy(1, 578500, 40);
  const book = [mine, buy(2, 579700, 43), buy(3, 579600, 162), buy(4, 579400, 708), buy(5, 600000, 10, null, 'station', 60003469), buy(6, 500000, 5)];
  const reaches = o => o.location_id === 60003760 || o.range === 'region';
  const p = L.buyPosition(mine, book, new Set([1]), true, reaches);
  assert.equal(p.status, 'outbid');
  assert.equal(p.wall, 579700);
  assert.equal(p.unitsOver, 913);
  assert.deepEqual(p.over.map(l => l.price), [579700, 579600, 579400]);
  const plan = L.planBid(p, { broker: 0.015, modify: 0.0039, bigMove: 0.02 });
  assert.equal(plan.action, 'tick');
  assert.equal(plan.target, 579800);
  assert.equal(plan.escrowAdd, (579800 - 578500) * 40);
  const far = L.planBid(L.buyPosition(buy(1, 500000, 40), [buy(1, 500000, 40)].concat(book.slice(1)), new Set([1]), true, reaches), { broker: 0.015, modify: 0.0039, bigMove: 0.02 });
  assert.equal(far.action, 'optional');
  assert.equal(far.kind, 'big');
  assert.equal(far.target, 579800); // the 600,000 bid in another station does not reach Jita 4-4
  const top = buy(1, 580000, 40);
  assert.equal(L.planBid(L.buyPosition(top, [top].concat(book.slice(1)), new Set([1]), true, reaches), { broker: 0.015, modify: 0.0039, bigMove: 0.02 }).action, 'hold');
});

test('ledger: FIFO cost, uncovered units, zero-cost and excluded types', () => {
  const t = (id, date, type, qty, price, isBuy, loc) => ({ transaction_id: id, date, type_id: type, quantity: qty, unit_price: price, is_buy: isBuy, location_id: loc || S });
  const tx = [
    t(5, '2026-11-12T10:00:00Z', 519, 8, 1500000, false),   // 6 @1.0M + 2 @1.1M
    t(1, '2026-11-10T10:00:00Z', 519, 6, 1000000, true),
    t(2, '2026-11-11T10:00:00Z', 519, 10, 1100000, true),
    t(6, '2026-11-12T11:00:00Z', 2048, 4, 2000000, false),   // never bought in window
    t(7, '2026-11-12T12:00:00Z', 2329, 100, 9000, false),    // PI, zero cost
    t(8, '2026-11-12T13:00:00Z', 44992, 500, 5000000, true), // PLEX, excluded
  ];
  const led = L.ledger(tx, { netMult: 0.95125, exclude: new Set([44992]), zeroCost: new Set([2329]) });
  assert.equal(led.sales.length, 3);
  const g = led.sales[0];
  assert.equal(g.cost, 6 * 1000000 + 2 * 1100000);
  assert.ok(Math.abs(g.net - (8 * 1500000 * 0.95125 - 8200000)) < 1e-6);
  assert.equal(led.sales[1].covered, 0);
  assert.equal(led.sales[1].net, null);
  assert.ok(Math.abs(led.sales[2].net - 100 * 9000 * 0.95125) < 1e-6);
  assert.deepEqual(L.unitCost(led.lots, 519, 8), { cost: 1100000, units: 8 });
  assert.equal(L.unitCost(led.lots, 2048, 5), null);
  const s = L.summarize(led.sales, 0, Infinity);
  assert.equal(s.units, 112);
  assert.equal(s.uncovered, 4);
  const v = L.velocity(led.sales, Date.parse('2026-11-12T20:00:00Z'));
  assert.equal(v.get('519:' + S).d1, 8);
});

test('formatting', () => {
  assert.equal(L.isk(1317000), '1,317,000');
  assert.equal(L.isk(955.1), '955.10');
  assert.equal(L.short(6072800000), '6.07B');
  assert.equal(L.short(262468100), '262.5M');
  assert.equal(L.sec(0.949), 0.9);
  assert.equal(L.sec(0.03), 0.1);
  assert.equal(L.sec(-0.4), 0);
  assert.equal(L.sec(0.45), 0.5);
});

test('order checks: the recurring mistakes', () => {
  const ok = { isBuy: false, price: 1317000, duration: 90, known: true, front: 1320000, cost: 1090000, netMult: 0.95125 };
  assert.deepEqual(L.orderChecks(ok), []);
  assert.match(L.orderChecks(Object.assign({}, ok, { known: false }))[0], /Not at one of your hubs/);
  assert.match(L.orderChecks(Object.assign({}, ok, { duration: 1 }))[0], /1 day, not 90/);
  assert.match(L.orderChecks(Object.assign({}, ok, { price: 29050, front: 290500, cost: null }))[0], /90% under the next seller/); // decimal slip
  assert.match(L.orderChecks(Object.assign({}, ok, { price: 13170000 }))[0], /above the front/);
  assert.match(L.orderChecks(Object.assign({}, ok, { price: 1100000, front: 1105000 }))[0], /below your cost/);
  assert.match(L.orderChecks({ isBuy: true, price: 5800000, duration: 90, known: true, wall: 579700 })[0], /above the next bid/);
  assert.deepEqual(L.orderChecks({ isBuy: true, price: 579800, duration: 90, known: true, wall: 579700 }), []);
});

test('week of price history and how a big move reads against it', () => {
  const h = [{ average: 300000, volume: 10 }, { average: 320000, volume: 60 }, { average: 318000, volume: 70 }];
  const w = L.weekOf(h, 2);
  assert.equal(Math.round(w.price), 318923);
  assert.equal(w.perDay, 65);
  assert.equal(L.weekOf([], 7), null);
  assert.equal(L.moveRead(250000, 318000), 'dump');
  assert.equal(L.moveRead(250000, 252000), 'repricing');
  assert.equal(L.moveRead(300000, 318000), 'unclear');
});

// One of Adam's real colonies (barren, Biocells) as ESI reported it on 2026-11-13T20:31Z.
const colony = () => ({
  at: Date.parse('2026-11-13T20:31:09Z'),
  pins: [
    { id: 'b1', kind: 'basic', contents: [] }, { id: 'b2', kind: 'basic', contents: [[2288, 398]] },
    { id: 'b3', kind: 'basic', contents: [[2270, 1652]] }, { id: 'b4', kind: 'basic', contents: [] },
    { id: 'a1', kind: 'advanced', contents: [[2396, 20]] }, { id: 'a2', kind: 'advanced', contents: [[2396, 20]] },
    { id: 'cc', kind: 'store', cap: 500, contents: [[2288, 55677], [2270, 44322]] },
    { id: 'lp', kind: 'store', cap: 10000, contents: [[2329, 1065]] },
    { id: 'e1', kind: 'ecu', ex: { prod: 2288, base: 3090, cycle: 3600000, start: Date.parse('2026-11-13T20:31:09Z'), end: Date.parse('2026-11-17T20:31:09Z') } },
    { id: 'e2', kind: 'ecu', ex: { prod: 2270, base: 1636, cycle: 3600000, start: Date.parse('2026-11-13T20:31:09Z'), end: Date.parse('2026-11-17T20:31:09Z') } },
  ],
  routes: [['b1', 'a1', 2396, 20], ['b2', 'a2', 2396, 20], ['a2', 'lp', 2329, 5], ['b4', 'a1', 2399, 20], ['b3', 'a2', 2399, 20],
    ['e2', 'b4', 2270, 3000], ['e2', 'b3', 2270, 3000], ['e2', 'cc', 2270, 5776], ['e1', 'b2', 2288, 3000], ['e1', 'b1', 2288, 3000], ['e1', 'cc', 2288, 16248], ['a1', 'lp', 2329, 5]],
});
const vol = t => ({ 2288: 0.005, 2270: 0.005, 2396: 0.19, 2399: 0.19, 2329: 0.75 }[t] || 1);

test('extractor curve: bounded by 7.2x the base, and decays', () => {
  // EVE sizes the extractor's routes to the curve's ceiling: 3090 x 7.2 = 22,248, the sum of this extractor's routes
  assert.equal(3090 * 7.2, 3000 + 3000 + 16248);
  let total = 0;
  for (let k = 0; k < 96; k++) { const y = L.programOutput(3090, 3600000, k); assert.ok(y > 0 && y <= 22248); total += y; }
  assert.ok(L.programOutput(3090, 3600000, 0) > 3 * L.programOutput(3090, 3600000, 95) / 2);
  assert.ok(total > 300000 && total < 900000, String(total));
});

test('colony forecast: product accumulates at a believable pace and nothing goes negative', () => {
  const c = colony(), H = 3600000;
  const snaps = L.piRun(c, [c.at, c.at + 24 * H, c.at + 48 * H, c.at + 96 * H, c.at + 240 * H], vol);
  const bio = snaps.map(s => s.get('lp').get(2329));
  assert.equal(bio[0], 1065);
  // two advanced factories at 5 units an hour each is the ceiling: 240 a day
  for (let i = 1; i < bio.length; i++) assert.ok(bio[i] >= bio[i - 1], bio.join());
  assert.ok(bio[1] - bio[0] >= 60 && bio[1] - bio[0] <= 240, bio.join());
  assert.ok(bio[3] - bio[0] <= 960, bio.join());
  assert.equal(bio[4], bio[4]); // program over: output stops growing once inputs run dry
  assert.ok(bio[4] - bio[3] < 60, bio.join());
  for (const s of snaps) for (const m of s.values()) for (const n of m.values()) assert.ok(n >= 0);
  // the full command center cannot take more raw material
  assert.ok(snaps[1].get('cc').get(2288) <= 100000);
});

test('probe scanner paste', () => {
  const text = 'ABC-123\tCosmic Signature\tWormhole\tUnstable Wormhole\t100.0%\t5.12 AU\nXYZ-042\tCosmic Signature\t\t\t0.0%\t11.4 AU\r\nQRS-777\tCosmic Anomaly\tOre Site\tOrdinary Perimeter Deposit\t100.0%\t3.02 AU\nnot a row\n';
  const s = L.parseSigs(text);
  assert.equal(s.length, 3);
  assert.deepEqual(s[0], { id: 'ABC-123', scan: 'Cosmic Signature', group: 'Wormhole', name: 'Unstable Wormhole', signal: '100.0%', dist: '5.12 AU' });
  assert.equal(s[1].group, '');
  assert.equal(s[2].scan, 'Cosmic Anomaly');
  assert.deepEqual(L.parseSigs(''), []);
});

test('ship names with symbols come through as typed', () => {
  assert.equal(L.shipName("u'\\u263cQuiet Knife'"), '☼Quiet Knife');
  assert.equal(L.shipName('Dawn Treader IV'), 'Dawn Treader IV');
  assert.equal(L.shipName("u'It\\'s fine'"), "It's fine");
  assert.equal(L.shipName(undefined), '');
});

test('where a pile of loot sells: lowest ask, bids that reach the hub, and the best hub for each', () => {
  const hubs = [{ name: 'Hek', station: 1, system: 10 }, { name: 'Jita', station: 2, system: 20 }, { name: 'Amarr', station: 3, system: 30 }];
  const sell = (loc, price) => ({ is_buy_order: false, location_id: loc, price, volume_remain: 50, range: 'region' });
  const buy = (loc, sys, price, units, range, min) => ({ is_buy_order: true, location_id: loc, system_id: sys, price, volume_remain: units, range: range || 'station', min_volume: min || 1 });
  const books = {
    Hek: [sell(1, 1300), sell(1, 1250), sell(99, 900), buy(1, 10, 1000, 4), buy(98, 10, 1100, 3, 'solarsystem'), buy(97, 11, 1200, 50, 'station'), buy(96, 12, 950, 100, 'region')],
    Jita: [sell(2, 1200), buy(2, 20, 1150, 5), buy(2, 20, 1140, 500, 'station', 50)],
    Amarr: [sell(3, 2600)],
  };
  const r = L.sellAt(hubs, hb => books[hb.name], 10, { ref: 1200, refStation: 2 });
  const [hek, jita, amarr] = r.hubs;
  assert.equal(hek.ask, 1250);                 // the 900 ask is in another station
  assert.equal(hek.bid, 1100);                 // the 1200 bid is station-only, somewhere else
  assert.equal(hek.now, 3 * 1100 + 4 * 1000 + 3 * 950);
  assert.equal(hek.filled, 10);
  assert.equal(jita.now, 5 * 1150);            // the big bid wants 50 at a time and only 5 are left
  assert.equal(jita.filled, 5);
  assert.equal(amarr.thin, true);              // a lone listing at more than 1.5 times the Jita ask
  assert.equal(jita.thin, false);
  assert.equal(amarr.fair, 1200);              // and it is counted at the Jita ask, not its own
  assert.equal(hek.fair, 1250);
  assert.equal(r.list, 'Hek');
  assert.equal(r.now, 'Hek');
});

test('where loot sells: nothing on the market, and a lone high listing when it is the only one', () => {
  const hubs = [{ name: 'Hek', station: 1, system: 10 }, { name: 'Jita', station: 2, system: 20 }];
  const none = L.sellAt(hubs, () => [], 5, {});
  assert.equal(none.list, null);
  assert.equal(none.now, null);
  assert.equal(none.hubs[0].filled, 0);
  const lone = L.sellAt(hubs, hb => (hb.name === 'Hek' ? [{ is_buy_order: false, location_id: 1, price: 5000, volume_remain: 1 }] : []), 5, { ref: 1000 });
  assert.equal(lone.hubs[0].thin, true);
  assert.equal(lone.list, 'Hek');              // still the only place it is on sale
});

test('where loot sells: a hub too slow for the pile is passed over, and the quickest is used when all are slow', () => {
  const hubs = [{ name: 'Hek', station: 1, system: 10 }, { name: 'Rens', station: 2, system: 20 }, { name: 'Jita', station: 3, system: 30 }];
  const ask = (loc, price) => [{ is_buy_order: false, location_id: loc, price, volume_remain: 9 }];
  const books = { Hek: ask(1, 110), Rens: ask(2, 125), Jita: ask(3, 100) };
  const perDay = { Hek: 400, Rens: 10, Jita: 9000 };
  const r = L.sellAt(hubs, hb => books[hb.name], 420, { ref: 100, refStation: 3, perDay: hb => perDay[hb.name], share: 0.15, days: 14 });
  assert.equal(Math.round(r.hubs[0].days), 7);          // 420 units at 15% of 400 a day
  assert.equal(r.hubs[1].slow, true);                   // 280 days in Rens
  assert.equal(r.list, 'Hek');                          // Rens asks more but would not sell
  const slow = L.sellAt(hubs, hb => books[hb.name], 420, { perDay: hb => ({ Hek: 3, Rens: 0, Jita: 20 })[hb.name] });
  assert.equal(slow.hubs[1].days, Infinity);
  assert.equal(slow.list, 'Jita');                      // every hub is slow: take the quickest
  const unknown = L.sellAt(hubs, hb => books[hb.name], 420, {});
  assert.equal(unknown.hubs[0].slow, false);            // no history loaded: do not guess
  assert.equal(unknown.list, 'Rens');
});

test('units traded a day counts calendar days, not days that had trades', () => {
  const now = Date.parse('2026-11-15T12:00:00Z');
  const hist = [{ date: '2026-11-01', volume: 999 }, { date: '2026-11-09', volume: 70 }, { date: '2026-11-13', volume: 35 }, { date: '2026-11-14', volume: 35 }];
  assert.equal(L.tradedPerDay(hist, now, 7), 20);
  assert.equal(L.tradedPerDay([], now, 7), 0);
  assert.equal(L.tradedPerDay(null, now, 7), 0);
});

test('copied marks: waiting, landed, not in the book, and a book that moved', () => {
  const at = Date.parse('2026-11-15T17:14:00Z'), grace = 180000, mark = { price: 1322000, at };
  assert.equal(L.copyState(undefined, { live: 1323000, target: 1322000, dataAt: at, grace }), null);
  // just copied: the page's data is older than the copy
  assert.deepEqual(L.copyState(mark, { live: 1323000, target: 1322000, dataAt: at - 60000, grace }), { state: 'waiting', price: 1322000, at, moved: false });
  // data from inside the time it takes to type the price does not count against it
  assert.equal(L.copyState(mark, { live: 1323000, target: 1322000, dataAt: at + grace - 1, grace }).state, 'waiting');
  // newer data, old price still showing: it was never typed
  assert.equal(L.copyState(mark, { live: 1323000, target: 1322000, dataAt: at + grace, grace }).state, 'missed');
  // the order shows the copied price: done, whatever the book asks for next
  assert.deepEqual(L.copyState(mark, { live: 1322000, target: 1321000, dataAt: at + 400000, grace }), { state: 'landed', price: 1322000, at, moved: false });
  assert.equal(L.copyState(mark, { live: 1322000, target: null, dataAt: at + 400000, grace }).state, 'landed');
  // a rival moved before the change showed: the price to type is a different one now
  assert.equal(L.copyState(mark, { live: 1323000, target: 1321000, dataAt: at + 30000, grace }).moved, true);
  // nothing to type any more (rival gone) is not a moved book
  assert.equal(L.copyState(mark, { live: 1323000, target: null, dataAt: at + 30000, grace }).moved, false);
});
