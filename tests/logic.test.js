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

test('slow line: a routine undercut on a line with no sales is offered, not urged', () => {
  const order = { order_id: 1, price: 1000000, volume_remain: 10, issued: '2026-11-01T00:00:00Z', location_id: 5, is_buy_order: false };
  const rival = { order_id: 2, price: 999000, volume_remain: 50, issued: '2026-11-10T00:00:00Z', location_id: 5, is_buy_order: false };
  const pos = L.sellPosition(order, [order, rival], new Set([1]), true);
  const ctx = { cost: 800000, jitaSell: 700000, isJita: false, netMult: 0.95125, modify: 0.0039, sniperUnits: 5, bigMove: 0.02 };
  assert.equal(L.planSells([{ order, pos }], ctx).get(1).action, 'tick');
  const slow = L.planSells([{ order, pos }], Object.assign({ slowDays: 7 }, ctx)).get(1);
  assert.equal(slow.action, 'optional'); assert.equal(slow.kind, 'slow'); assert.equal(slow.target, 998900);
  assert.equal(Math.round(slow.fee), Math.round(998900 * 10 * 0.0039));
  // a sniper or a big move keeps its own name, and a hold stays a hold
  const few = Object.assign({}, rival, { volume_remain: 3 });
  assert.equal(L.planSells([{ order, pos: L.sellPosition(order, [order, few], new Set([1]), true) }], Object.assign({ slowDays: 7 }, ctx)).get(1).kind, 'sniper');
  const deep = Object.assign({}, rival, { price: 900000 });
  assert.equal(L.planSells([{ order, pos: L.sellPosition(order, [order, deep], new Set([1]), true) }], Object.assign({ slowDays: 7 }, ctx)).get(1).kind, 'big');
  assert.equal(L.planSells([{ order, pos }], Object.assign({ slowDays: 7 }, ctx, { cost: 990000 })).get(1).action, 'hold');
});

test('trip plan: fewest jumps, pick-up before drop-off, and stops with no route', () => {
  const d = { 'start:A': 2, 'start:B': 9, 'start:C': 5, 'A:B': 8, 'A:C': 4, 'B:C': 3 };
  const dist = (a, b) => { const v = d[a + ':' + b]; return v != null ? v : d[b + ':' + a] != null ? d[b + ':' + a] : null; };
  assert.deepEqual(L.tripPlan(['A', 'B', 'C'], dist), { order: ['A', 'C', 'B'], legs: [2, 4, 3], total: 9 });
  // B holds the stock that C and A are waiting for: B first, whatever it costs
  assert.deepEqual(L.tripPlan(['A', 'B', 'C'], dist, [['B', 'A'], ['B', 'C']]), { order: ['B', 'C', 'A'], legs: [9, 3, 4], total: 16 });
  // a rule about a stop that is not on the trip is ignored
  assert.deepEqual(L.tripPlan(['A', 'C'], dist, [['B', 'A']]).order, ['A', 'C']);
  // one stop, already there
  assert.deepEqual(L.tripPlan(['A'], () => 0), { order: ['A'], legs: [0], total: 0 });
  // no route to a stop: no plan
  assert.equal(L.tripPlan(['A', 'Z'], dist), null);
  assert.equal(L.tripPlan([], dist).total, 0);
});

test('typed ISK figures', () => {
  assert.equal(L.parseIsk('356.4M'), 356400000);
  assert.equal(L.parseIsk('1.25b'), 1250000000);
  assert.equal(L.parseIsk('450k'), 450000);
  assert.equal(L.parseIsk('12,345,678'), 12345678);
  assert.equal(L.parseIsk(' -3.2 M '), -3200000);
  assert.equal(L.parseIsk('356.4M ISK'), 356400000);
  assert.equal(L.parseIsk('0'), 0);
  for (const bad of ['', 'abc', '12x', '1.2.3', 'M', null]) assert.equal(L.parseIsk(bad), null, String(bad));
});

test('weeks are named by their Monday and step by the calendar', () => {
  const wed = new Date(2026, 10, 11, 15, 30).getTime();                 // Wednesday 11 November 2026
  assert.equal(L.weekKey(wed), '2026-11-09');
  assert.equal(L.weekStart('2026-11-09'), new Date(2026, 10, 9).getTime());
  assert.equal(L.weekKey(L.weekAfter(L.weekStart('2026-11-09'))), '2026-11-16');
  // across the autumn clock change the next week still starts on a Monday at 00:00
  const oct = L.weekStart('2026-10-26');
  assert.equal(new Date(L.weekAfter(oct)).getHours(), 0);
  assert.equal(L.weekKey(L.weekAfter(oct)), '2026-11-02');
});

test('wallet journal for a week: kinds add up to the change, balances at both ends', () => {
  const d = (day, h) => new Date(Date.UTC(2026, 10, day, h)).toISOString();
  const j = [
    { id: 1, date: d(8, 20), ref_type: 'market_transaction', amount: 5e6, balance: 100e6 },
    { id: 2, date: d(9, 10), ref_type: 'market_transaction', amount: 20e6, balance: 120e6 },
    { id: 3, date: d(9, 10), ref_type: 'transaction_tax', amount: -675000, balance: 119325000 },
    { id: 4, date: d(10, 9), ref_type: 'market_escrow', amount: -30e6, balance: 89325000 },
    { id: 5, date: d(11, 9), ref_type: 'brokers_fee', amount: -450000, balance: 88875000 },
    { id: 6, date: d(12, 9), ref_type: 'planetary_export_tax', amount: -125000, balance: 88750000 },
    { id: 7, date: d(13, 9), ref_type: 'player_donation', amount: 10e6, balance: 98750000 },
    { id: 8, date: d(14, 9), ref_type: 'insurance', amount: 1e6, balance: 99750000 },
    { id: 9, date: d(16, 9), ref_type: 'market_transaction', amount: 7e6, balance: 106750000 },
  ];
  const from = Date.UTC(2026, 10, 9), to = Date.UTC(2026, 10, 16);
  const w = L.journalSpan(j.slice().reverse(), from, to);                 // ESI returns newest first
  assert.equal(w.covered, true); assert.equal(w.open, 100e6); assert.equal(w.close, 99750000);
  assert.equal(w.change, w.close - w.open);
  assert.equal(w.sales + w.purchases + w.broker + w.tax + w.planets + w.transfers + w.other, w.change);
  assert.deepEqual([w.sales, w.purchases, w.broker, w.tax, w.planets, w.transfers, w.other], [20e6, -30e6, -450000, -675000, -125000, 10e6, 1e6]);
  // a journal that starts inside the week cannot vouch for the whole of it
  const part = L.journalSpan(j.slice(3), from, to);
  assert.equal(part.covered, false); assert.equal(part.open, null); assert.equal(part.close, 99750000);
});

test('tie-out: tied within the tolerance, and counted in a row from the newest week', () => {
  const t = L.tieOut([{ net: 100, tracker: 99 }, { net: 100, tracker: 120 }, { net: 200, tracker: 201 }, { net: 300, tracker: 300 }], 0.02);
  assert.deepEqual(t.rows.map(r => r.tied), [true, false, true, true]);
  assert.equal(t.run, 2); assert.equal(t.rows[1].diff, -20);
  // the newest week has no tracker figure yet: nothing is running
  assert.equal(L.tieOut([{ net: 100, tracker: 100 }, { net: 100, tracker: null }], 0.02).run, 0);
  assert.equal(L.tieOut([], 0.02).run, 0);
});

test('sync: two devices joined either way round end the same, and joining again changes nothing', () => {
  const now = 1e12, H = 36e5, keep = { pins: 36 * H, copied: 6 * H };
  const pc = {
    v: 1,
    pins: { 11: { price: 100, at: now - H }, 12: { price: 200, at: now - 40 * H } },
    copied: { 21: { price: 5, at: now - 60000 }, 22: { price: 6, at: now - 120000 }, r380: { price: 9, at: now - 7 * H } },
    seen: { at: now - 3 * H, orders: { 1: { s: 'leading' } } },
    weeks: { carried: { v: 1e9, at: now - 100 }, w: { '2026-11-02': { gross: 10, units: 1, net: 5, uncovered: 0, frozenAt: now - 50, tracker: { v: 5, at: now - 10 } }, '2026-11-09': { escrow: 7, wallet: 8, seenAt: now - 500 } } },
  };
  const phone = {
    v: 1,
    pins: { 11: { gone: true, at: now - 60000 }, 13: { price: 300, at: now - 2 * H } },
    copied: { 22: { gone: true, at: now - 30000 }, 23: { price: 7, at: now - 1000 } },
    seen: { at: now - 60000, orders: {}, auto: true },
    weeks: { carried: null, w: { '2026-11-02': { gross: 11, units: 1, net: 6, uncovered: 0, frozenAt: now - 20, fees: -1, change: 2, close: 3 }, '2026-11-09': { escrow: 9, wallet: 10, seenAt: now - 100 } } },
  };
  const ab = L.syncMerge(pc, phone, now, keep), ba = L.syncMerge(phone, pc, now, keep);
  assert.equal(L.stable(ab), L.stable(ba));
  assert.equal(L.stable(L.syncMerge(ab, pc, now, keep)), L.stable(ab));
  assert.equal(L.stable(L.syncMerge(ab, ab, now, keep)), L.stable(ab));
  // a pin cleared on the phone is cleared everywhere; a stale pin is dropped; a new one travels
  assert.deepEqual(ab.pins, { 11: { gone: true, at: now - 60000 }, 13: { price: 300, at: now - 2 * H } });
  // copied marks: the undo on the phone wins over the older mark, the fresh ones are kept, the 7-hour-old one is dropped
  assert.deepEqual(Object.keys(ab.copied).sort(), ['21', '22', '23']);
  assert.equal(ab.copied[22].gone, true);
  // "Mark as seen" by hand beats a newer first-visit default
  assert.equal(ab.seen.at, now - 3 * H);
  // the week keeps the figures fixed first, gains the journal figures, and keeps the tracker entry
  assert.deepEqual(ab.weeks.w['2026-11-02'], { gross: 10, units: 1, net: 5, uncovered: 0, frozenAt: now - 50, fees: -1, change: 2, close: 3, tracker: { v: 5, at: now - 10 } });
  // costs travel (the newer import wins), and a week worked out again on newer costs replaces the figures fixed earlier
  const withCosts = Object.assign({}, phone, { costs: { at: now - 5, rows: [{ t: 519, l: null, d: null, c: 800000 }] },
    weeks: { carried: null, w: { '2026-11-02': { gross: 10, units: 1, net: 7, uncovered: 0, borrowed: 1, basis: now - 5, frozenAt: now - 1 } } } });
  const c1 = L.syncMerge(pc, withCosts, now, keep), c2 = L.syncMerge(withCosts, pc, now, keep);
  assert.equal(L.stable(c1), L.stable(c2));
  assert.equal(c1.costs.rows[0].c, 800000);
  assert.equal(c1.weeks.w['2026-11-02'].net, 7); assert.equal(c1.weeks.w['2026-11-02'].basis, now - 5);
  assert.deepEqual(c1.weeks.w['2026-11-02'].tracker, { v: 5, at: now - 10 });
  assert.deepEqual(ab.weeks.w['2026-11-09'], { escrow: 9, wallet: 10, seenAt: now - 100 });
  assert.deepEqual(ab.weeks.carried, { v: 1e9, at: now - 100 });
  // an empty sync file takes everything from the device
  assert.equal(L.stable(L.syncMerge(ab, { v: 1 }, now, keep)), L.stable(ab));
  assert.equal(L.stable({ b: 1, a: [2, { d: 1, c: undefined }] }), '{"a":[2,{"d":1}],"b":1}');
});

test('tracker costs: rows pasted from the Order Tracking sheet, with and without the header row', () => {
  const header = 'Date Listed\tItem\tVenue\tQty Listed\tUnit Cost\tList Price\tRelists\tQty Sold\tAvg Realized\tDate Sold Out\tDays on Market\tStatus\tRealized Net (approx)';
  const body = [
    '2026-09-01\tGyrostabilizer II\tRens\t25\t803,963\t968,000\t0\t25\t968,000\t2026-09-01\t0\tOK\t2,921,438',
    '2026-09-01\tGyrostabilizer II\tHek\t15\t803,963\t977,000\t0\t15\t977,000\t2026-09-01\t0\tOK\t1,881,263',
    '2026-10-20\tBiocells (PI)\tHek\t1,400\t0\t9,150\t0\t1,400\t9,150\t\t\tOK\t12,185,513',
    '',
    '\tNotes: relisted after the dump\t\t\t\t',
    'Running total\t\t\t\t\t\t\t\t\t\t\t\t16,988,214',
  ].join('\n');
  const p = L.parseCosts(header + '\n' + body);
  assert.equal(p.rows.length, 3); assert.equal(p.skipped, 2);
  assert.deepEqual(p.rows[0], { name: 'Gyrostabilizer II', venue: 'Rens', date: new Date(2026, 8, 1).getTime(), qty: 25, cost: 803963 });
  assert.equal(p.rows[2].cost, 0); assert.equal(p.rows[2].qty, 1400);
  assert.equal(p.net, 2921438 + 1881263 + 12185513);
  // no header: the sheet's usual column order
  assert.deepEqual(L.parseCosts(body).rows.map(r => r.name), ['Gyrostabilizer II', 'Gyrostabilizer II', 'Biocells']);
  // columns in another order are found by their headers; a sheet without Realized Net gives no total
  const moved = L.parseCosts('Item\tUnit Cost\tVenue\nDamage Control II\t1.2M\tAmarr');
  assert.deepEqual(moved.rows, [{ name: 'Damage Control II', venue: 'Amarr', date: null, qty: null, cost: 1200000 }]);
  assert.equal(moved.net, null);
  assert.deepEqual(L.parseCosts('').rows, []);
});

test('tracker costs fill in only where the wallet has no purchase', () => {
  const day = d => new Date(Date.UTC(2026, 10, d)).toISOString();
  const tx = [
    { transaction_id: 1, date: day(2), type_id: 519, location_id: 9, quantity: 10, unit_price: 800000, is_buy: true },
    { transaction_id: 2, date: day(5), type_id: 519, location_id: 7, quantity: 14, unit_price: 1000000, is_buy: false },     // 10 from the wallet, 4 from the tracker
    { transaction_id: 3, date: day(6), type_id: 2048, location_id: 7, quantity: 5, unit_price: 1500000, is_buy: false },      // tracker only
    { transaction_id: 4, date: day(6), type_id: 380, location_id: 7, quantity: 3, unit_price: 500000, is_buy: false },        // nobody knows
  ];
  const rows = [
    { t: 519, l: 8, d: Date.UTC(2026, 9, 1), c: 700000 }, { t: 519, l: 7, d: Date.UTC(2026, 9, 1), c: 750000 }, { t: 519, l: 7, d: Date.UTC(2026, 10, 20), c: 990000 },
    { t: 2048, l: null, d: null, c: 1200000 },
  ];
  const look = L.costLookup(rows);
  assert.equal(look(519, 7, Date.UTC(2026, 10, 5)), 750000);     // same station, latest listed before the sale
  assert.equal(look(519, 7, Date.UTC(2026, 10, 25)), 990000);
  assert.equal(look(519, 3, Date.UTC(2026, 10, 5)), 750000);     // no row for that station: any station's
  assert.equal(look(519, 7, Date.UTC(2026, 8, 1)), 750000);      // sold before any row was listed: the earliest
  assert.equal(look(380, 7, 0), null);
  const opts = { netMult: 0.95, exclude: new Set(), zeroCost: new Set() };
  const plain = L.summarize(L.ledger(tx, opts).sales, 0, Infinity);
  assert.equal(plain.uncovered, 4 + 5 + 3); assert.equal(plain.borrowed, 0);
  const led = L.ledger(tx, Object.assign({ fallback: look }, opts)), sum = L.summarize(led.sales, 0, Infinity);
  assert.equal(sum.uncovered, 3); assert.equal(sum.borrowed, 4 + 5);
  assert.equal(led.sales[0].cost, 10 * 800000 + 4 * 750000);
  assert.equal(Math.round(sum.net), Math.round(14 * 1000000 * 0.95 - (10 * 800000 + 4 * 750000) + 5 * 1500000 * 0.95 - 5 * 1200000));
  // the other setting: the tracker's cost for every unit of an item it lists
  const t2 = L.ledger(tx, Object.assign({ fallback: look, prefer: 'tracker' }, opts));
  assert.equal(t2.sales[0].cost, 14 * 750000); assert.equal(t2.sales[0].borrowed, 14);
  assert.equal(t2.lots.get(519).length, 0);                      // the wallet's lot is still used up
  assert.equal(L.summarize(t2.sales, 0, Infinity).uncovered, 3);
});

test('expedition: a fit pasted in EFT format', () => {
  const fit = L.parseEft([
    '[Procurer, Camp standard]', '',
    'Mining Laser Upgrade II', 'Mining Laser Upgrade II', '',
    'Multispectrum Shield Hardener II', 'Medium Shield Extender II', 'Medium Shield Extender II', '[Empty Med slot]', '',
    'Strip Miner I', 'Strip Miner I', 'Small Core Defense Field Extender I /offline', '',
    'Heavy Missile Launcher II, Scourge Fury Heavy Missile', '',
    'Hobgoblin II x5', 'Mining Drone I x5', '', 'Nanite Repair Paste x50', 'Hobgoblin II x5',
    '', '[Venture, something else]', 'Miner I',
  ].join('\n'));
  assert.equal(fit.ship, 'Procurer'); assert.equal(fit.name, 'Camp standard');
  const qty = n => (fit.items.find(i => i.name === n) || {}).qty;
  assert.equal(qty('Mining Laser Upgrade II'), 2); assert.equal(qty('Medium Shield Extender II'), 2); assert.equal(qty('Strip Miner I'), 2);
  assert.equal(qty('Small Core Defense Field Extender I'), 1);            // "/offline" is not part of the name
  assert.equal(qty('Heavy Missile Launcher II'), 1); assert.deepEqual(fit.loaded, ['Scourge Fury Heavy Missile']);
  assert.equal(qty('Hobgoblin II'), 10); assert.equal(qty('Nanite Repair Paste'), 50);
  assert.equal(qty('Miner I'), undefined); assert.equal(qty('Procurer'), undefined);   // the second fit and the hull itself are not items
  assert.equal(L.parseEft('just some words'), null); assert.equal(L.parseEft(''), null);
  assert.deepEqual(L.parseEft('[Praxis, bare hull]').items, []);
});

test('expedition: kit readiness and the shopping list (acceptance test 2)', () => {
  const hulls = [
    { key: 'prospect', label: 'Prospect', ship: 'Prospect', buy_at: 'Jita', items: [{ name: 'Gas Cloud Scoop II', qty: 2 }, { name: 'Covert Ops Cloaking Device II', qty: 1 }] },
    { key: 'procurer', label: 'Procurer', ship: 'Procurer', buy_at: 'Jita', items: [] },
    { key: 'praxis', label: 'Praxis', ship: 'Praxis', buy_at: 'Rens', items: [{ name: 'Large Remote Armor Repairer II', qty: 1 }] },
    { key: 'pvp', label: 'PvP reship', ship: null, buy_at: 'Jita', items: [] },
  ];
  const keys = hulls.map(x => x.key);
  // one pilot, two of the four hulls owned: half ready
  const kit = [{ pilot_id: 'a', hull_key: 'procurer', status: 'owned' }, { pilot_id: 'a', hull_key: 'praxis', status: 'owned' }, { pilot_id: 'a', hull_key: 'prospect', status: 'missing' }];
  assert.deepEqual(L.kitReady('a', kit, keys), { have: 2, total: 4, pct: 50 });
  const one = L.shoppingList({ pilots: ['a'], kit, hulls, stock: [] });
  assert.deepEqual(one.places, { Jita: [{ name: 'Covert Ops Cloaking Device II', qty: 1 }, { name: 'Gas Cloud Scoop II', qty: 2 }, { name: 'Prospect', qty: 1 }] });
  assert.deepEqual(one.unnamed, [{ label: 'PvP reship', qty: 1 }]);
  assert.equal(L.multibuy(one.places.Jita), 'Covert Ops Cloaking Device II x1\nGas Cloud Scoop II x2\nProspect x1');
  // "staged at camp" counts as having it; a second pilot with nothing needs everything
  const two = kit.concat([{ pilot_id: 'b', hull_key: 'prospect', status: 'staged' }]);
  assert.equal(L.kitReady('b', two, keys).pct, 25);
  const both = L.shoppingList({ pilots: ['a', 'b'], kit: two, hulls,
    stock: [{ item: 'Core Scanner Probe I', base: 8, per: 'pilot', doubled: true, have: 10, buy_at: 'Jita' }, { item: 'Mobile Tractor Unit', base: 2, per: 'camp', doubled: false, have: 2, buy_at: 'Jita' },
      { item: '', label: 'Ammunition', base: 1000, per: 'pilot', doubled: true, have: 0, buy_at: 'Jita' }, { item: 'Mobile Depot', base: 1, per: 'pilot', doubled: true, have: 0, buy_at: 'Rens' }] });
  const at = (place, n) => (both.places[place].find(i => i.name === n) || {}).qty;
  assert.equal(at('Jita', 'Prospect'), 1); assert.equal(at('Jita', 'Procurer'), 1); assert.equal(at('Rens', 'Praxis'), 1); assert.equal(at('Rens', 'Large Remote Armor Repairer II'), 1);
  assert.equal(at('Jita', 'Core Scanner Probe I'), 8 * 2 * 2 - 10);                 // per pilot, doubled, less what is held
  assert.equal(at('Jita', 'Mobile Tractor Unit'), undefined);                       // already have both
  assert.equal(at('Rens', 'Mobile Depot'), 4);
  assert.deepEqual(both.unnamed, [{ label: 'PvP reship', qty: 2 }, { label: 'Ammunition', qty: 4000 }]);
  // everything owned: nothing to buy
  const full = keys.map(k => ({ pilot_id: 'a', hull_key: k, status: 'owned' }));
  assert.deepEqual(L.shoppingList({ pilots: ['a'], kit: full, hulls, stock: [] }), { places: {}, unnamed: [] });
  assert.equal(L.kitReady('a', full, keys).pct, 100);
  assert.equal(Math.round(L.trainDays(387760, 1800)), 9); assert.equal(L.stockNeed({ base: 3, per: 'camp', doubled: true }, 4), 6);
});

test('expedition: the picket rotation rolls in order, and a snooze takes one back', () => {
  const MIN = 60000, t0 = Date.UTC(2026, 10, 20, 1, 0);
  const timer = { id: 'tp', kind: 'picket', rotation_order: ['a', 'b', 'c'], turn: 0, started_at: t0, since: t0, ends_at: t0 + 45 * MIN, interval_min: 45, acked: null };
  assert.deepEqual(L.picketRoll(timer, t0 + 44 * MIN).stints, []);
  // 2 h 20 min in: three changes have been made, a then b then c, and a is on again
  const r = L.picketRoll(timer, t0 + 140 * MIN);
  assert.deepEqual(r.stints.map(x => [x.pilot_id, (x.from - t0) / MIN, (x.to - t0) / MIN]), [['a', 0, 45], ['b', 45, 90], ['c', 90, 135]]);
  assert.equal(r.timer.turn, 0); assert.equal(r.timer.since, t0 + 135 * MIN); assert.equal(r.timer.ends_at, t0 + 180 * MIN);
  assert.equal(timer.turn, 0);                                                         // the original is left alone
  // snooze before the change is due: the same pilot stays ten minutes longer
  const early = L.picketSnooze(timer, [], t0 + 45 * MIN, t0 + 55 * MIN);
  assert.ok(early.ok); assert.equal(early.timer.ends_at, t0 + 55 * MIN); assert.equal(early.timer.turn, 0);
  // snooze pressed 2 minutes after the change at 45: b's turn is taken back, a stays on until 57
  const one = L.picketRoll(timer, t0 + 47 * MIN);
  const back = L.picketSnooze(one.timer, one.stints, t0 + 45 * MIN, t0 + 57 * MIN);
  assert.ok(back.ok); assert.deepEqual(back.stints, []); assert.equal(back.timer.turn, 0); assert.equal(back.timer.since, t0); assert.equal(back.timer.ends_at, t0 + 57 * MIN);
  const after = L.picketRoll(back.timer, t0 + 58 * MIN);
  assert.deepEqual(after.stints.map(x => [x.pilot_id, (x.to - x.from) / MIN]), [['a', 57]]); assert.equal(after.timer.ends_at, t0 + 102 * MIN);
  // a snooze for a change long past is refused
  assert.equal(L.picketSnooze(r.timer, r.stints, t0 + 45 * MIN, t0 + 150 * MIN).ok, false);
  assert.equal(L.clock(245000), '4:05'); assert.equal(L.clock(3729000), '1:02:09'); assert.equal(L.clock(-500), '0:00');
});

test('expedition: what the phone is told to ring for', () => {
  const MIN = 60000, t0 = Date.UTC(2026, 10, 20, 1, 0), rules = { picket_min: 45, snooze_min: 10, late_min: 5, gas_min: 15, eol_hours: 4, eol_warn_min: [60, 15], ahead: 12, horizon_hours: 10 }, name = id => ({ a: 'Rook', b: 'Finch', c: 'Wren' })[id];
  const picket = { id: 'tp', kind: 'picket', rotation_order: ['a', 'b', 'c'], turn: 0, started_at: t0, since: t0, ends_at: t0 + 45 * MIN, interval_min: 45, acked: null };
  const gas = { id: 'tg', kind: 'gas', label: 'Barren Perimeter Reservoir', started_at: t0, ends_at: t0 + 15 * MIN };
  const eol = { id: 'te', kind: 'eol', label: 'the C3 static', ends_at: t0 + 240 * MIN };
  const list = L.campAlerts({ timers: [picket, gas, eol, { id: 'tw', kind: 'window', label: 'Mining', ends_at: null }], name, rules }, t0 + MIN);
  assert.deepEqual(list.slice(0, 3).map(a => [a.id, (a.at - t0) / MIN, a.title]),
    [['tg', 15, 'Sleepers imminent: Barren Perimeter Reservoir'], ['tp:' + (t0 + 45 * MIN), 45, 'Picket: Finch takes over'], ['tp:' + (t0 + 90 * MIN), 90, 'Picket: Wren takes over']]);
  const first = list[1];
  assert.equal(first.text, 'Rook comes off picket, Finch goes on.'); assert.equal(first.group, 'tp'); assert.deepEqual(first.actions, ['done', 'snooze']);
  assert.equal(first.late.at, t0 + 50 * MIN); assert.equal(first.late.text, 'Finch should have relieved Rook 5 minutes ago.');
  // the hole rings at 60 and at 15 minutes left
  assert.deepEqual(list.filter(a => a.group === 'te').map(a => [(a.at - t0) / MIN, a.title]), [[180, 'Hole to the C3 static: 60 minutes left at most'], [225, 'Hole to the C3 static: 15 minutes left at most']]);
  // the rotation goes round: a, b, c, a ... and stops at the horizon
  const turns = list.filter(a => a.group === 'tp');
  assert.equal(turns[2].title, 'Picket: Rook takes over'); assert.ok(turns.length >= 8 && turns.length <= rules.ahead);
  assert.ok(turns.every(a => a.at - (t0 + MIN) <= rules.horizon_hours * 3600000));
  // just after a change nobody confirmed: that change is still listed for its second ring, until it is confirmed or the ring has gone
  const rolled = L.picketRoll(picket, t0 + 46 * MIN).timer;
  const now = L.campAlerts({ timers: [rolled], name, rules }, t0 + 46 * MIN);
  assert.equal(now[0].id, 'tp:' + (t0 + 45 * MIN)); assert.equal(now[0].late.at, t0 + 50 * MIN); assert.equal(now[1].at, t0 + 90 * MIN);
  assert.equal(L.campAlerts({ timers: [Object.assign({}, rolled, { acked: rolled.since })], name, rules }, t0 + 46 * MIN)[0].at, t0 + 90 * MIN);
  assert.equal(L.campAlerts({ timers: [rolled], name, rules }, t0 + 51 * MIN)[0].at, t0 + 90 * MIN);
  // one pilot is no rotation; a gas timer that has rung or been confirmed is not rung again
  assert.deepEqual(L.campAlerts({ timers: [Object.assign({}, picket, { rotation_order: ['a'] })], name, rules }, t0), []);
  assert.deepEqual(L.campAlerts({ timers: [gas], name, rules }, t0 + 16 * MIN), []);
  assert.deepEqual(L.campAlerts({ timers: [Object.assign({}, gas, { acked: true })], name, rules }, t0), []);
});

test('expedition: a camp night as Markdown (acceptance test 7)', () => {
  const MIN = 60000, t0 = Date.UTC(2026, 10, 20, 1, 0), hm = ts => new Date(ts).toISOString().slice(11, 16);
  const md = L.nightMarkdown({
    camp: { system_name: 'J123405', system_class: 'C2', statics: 'highsec, C3', stage_type: 'nomad' }, night: { n: 2, started_at: t0, ended_at: t0 + 200 * MIN },
    windows: [
      { type: 'ratting', start: t0 + 100 * MIN, end: t0 + 190 * MIN, pilot_ids: ['adam', 'a'], adam_mode: 'khiana', note: 'rolled the C3 twice | stood down early', pickets: [] },
      { type: 'mining', start: t0 + 5 * MIN, end: t0 + 95 * MIN, pilot_ids: ['adam', 'a', 'b'], adam_mode: 'todashi', note: '', pickets: [{ pilot_id: 'a', from: t0 + 5 * MIN, to: t0 + 50 * MIN }, { pilot_id: 'b', from: t0 + 50 * MIN, to: t0 + 95 * MIN }] }],
    holes: [{ destination: 'C3 static', state: 'critical', eol_at: t0 + 150 * MIN, picketed: true, bookmarked: false }],
    name: id => ({ adam: 'Adam', a: 'Rook', b: 'Finch' })[id], mode: k => ({ khiana: 'Khiana Kyn', todashi: 'Todashi Kitsune' })[k], type: k => k.charAt(0).toUpperCase() + k.slice(1), time: hm, day: () => 'Fri 20 Nov' });
  const lines = md.split('\n');
  assert.equal(lines[0], '# Camp — Night 2');
  assert.ok(md.includes('J123405 (C2, statics: highsec, C3). Nomad camp.')); assert.ok(md.includes('Night 2: Fri 20 Nov 01:00 to 04:20.'));
  // windows in time order, as a table with the same number of cells in every row
  const rows = lines.filter(l => l.startsWith('|'));
  assert.equal(rows.length, 4); assert.ok(rows.every(r => r.split('|').length === 9));
  assert.equal(rows[2], '| Mining | 01:05 | 02:35 | 1 h 30 min | Todashi Kitsune | Adam, Rook, Finch | Rook 01:05 to 01:50; Finch 01:50 to 02:35 |');
  assert.equal(rows[3], '| Ratting | 02:40 | 04:10 | 1 h 30 min | Khiana Kyn | Adam, Rook | none |');
  assert.ok(md.includes('2 windows, 3 h in all.'));
  assert.ok(md.includes('- Ratting, 02:40: rolled the C3 twice | stood down early'));
  assert.ok(md.includes('## Bank')); assert.ok(md.includes('- C3 static: critical, end of life seen 03:30, picketed, not bookmarked both sides'));
  assert.ok(L.nightMarkdown({ camp: {}, night: { n: 1, started_at: t0, ended_at: null }, windows: [], holes: [], name: String, mode: String, type: String, time: hm, day: () => 'Fri' }).includes('No windows were run.'));
});

test('weekly close: a week set to the tracker\'s figure is left out of the tie-out', () => {
  const w = (net, tracker, locked) => ({ net, tracker, locked });
  // oldest first: off but adopted, then two that tie on their own
  const t = L.tieOut([w(69.2e6, 121.5e6, true), w(300e6, 303e6), w(281e6, 280e6)], 0.02);
  assert.deepEqual(t.rows.map(r => r.tied), [null, true, true]); assert.equal(t.rows[0].locked, true); assert.equal(Math.round(t.rows[0].diff / 1e5) / 10, -52.3);
  assert.equal(t.run, 2);
  // an adopted week between two tied ones does not break the run, and does not add to it
  assert.equal(L.tieOut([w(300e6, 303e6), w(69.2e6, 121.5e6, true), w(281e6, 280e6)], 0.02).run, 2);
  // an off week that is not adopted still stops it
  assert.equal(L.tieOut([w(300e6, 303e6), w(69.2e6, 121.5e6), w(281e6, 280e6)], 0.02).run, 1);
  // adopted weeks alone are not a tie-out
  assert.equal(L.tieOut([w(69.2e6, 121.5e6, true), w(260e6, 310e6, true)], 0.02).run, 0);
  // the choice travels between devices with the newer press winning
  const a = { weeks: { w: { '2026-10-19': { tracker: { v: 121.5e6, at: 5 }, lock: { on: true, at: 9 } } } } }, b = { weeks: { w: { '2026-10-19': { lock: { on: false, at: 7 } } } } };
  assert.deepEqual(L.syncMerge(a, b, 100, { pins: 1e9, copied: 1e9 }).weeks.w['2026-10-19'].lock, { on: true, at: 9 });
});

test('ledger: a planetary product with no purchase costs nothing, one that was bought keeps its price', () => {
  const t = (id, date, type, qty, price, isBuy) => ({ transaction_id: id, date, type_id: type, quantity: qty, unit_price: price, is_buy: isBuy, location_id: 60003760 });
  const tx = [
    t(1, '2026-11-15T10:00:00Z', 2310, 34096, 1.88, false),   // Noble Gas straight off the colonies
    t(2, '2026-11-14T10:00:00Z', 2393, 100, 400, true),       // a tier 1 commodity bought on the market
    t(3, '2026-11-15T11:00:00Z', 2393, 150, 600, false),      // 100 of them bought, 50 made
    t(4, '2026-11-15T12:00:00Z', 2404, 80, 900000, false),    // a module with no purchase on record
    t(5, '2026-11-15T13:00:00Z', 33474, 19, 1500000, false),
  ];
  const opts = { netMult: 0.95, exclude: new Set(), zeroCost: new Set(), made: new Set([2310, 2393]) };
  const led = L.ledger(tx, opts), s = L.summarize(led.sales, 0, Infinity);
  assert.equal(s.uncovered, 99);
  assert.ok(Math.abs(led.sales[0].net - 34096 * 1.88 * 0.95) < 1e-6);
  assert.equal(led.sales[1].cost, 100 * 400); assert.equal(led.sales[1].covered, 150);
  assert.deepEqual(L.uncosted(led.sales, 0, Infinity).map(g => [g.type, g.units]), [[2404, 80], [33474, 19]]);
  assert.equal(L.summarize(L.ledger(tx, Object.assign({}, opts, { made: null })).sales, 0, Infinity).uncovered, 99 + 34096 + 50);
});

test('sync: a week worked out under newer rules wins over an older working of it', () => {
  const old = { weeks: { w: { '2026-11-09': { gross: 10, units: 5, net: 3, uncovered: 4, basis: 50, frozenAt: 100 } } } };
  const fresh = { weeks: { w: { '2026-11-09': { gross: 10, units: 5, net: 4, uncovered: 1, basis: 0, rules: 2, gaps: [[2404, 1]], frozenAt: 200 } } } };
  const keep = { pins: 1e9, copied: 1e9 };
  const ab = L.syncMerge(old, fresh, 300, keep), ba = L.syncMerge(fresh, old, 300, keep);
  assert.deepEqual(ab, ba);
  assert.equal(ab.weeks.w['2026-11-09'].net, 4); assert.equal(ab.weeks.w['2026-11-09'].rules, 2);
  assert.deepEqual(ab.weeks.w['2026-11-09'].gaps, [[2404, 1]]);
});

// ------------------------------------------------------------------ safeguards (version 25)
const NETM = 1 - 0.015 - 0.03375;
const histRows = (now, days, avg, vol) => Array.from({ length: days }, (_, i) => ({ date: new Date(now - (days - i) * 864e5).toISOString().slice(0, 10), average: typeof avg === 'function' ? avg(days - i) : avg, volume: typeof vol === 'function' ? vol(days - i) : vol }));

test('legal prices at or beside a figure', () => {
  assert.equal(L.tickFloor(857312.7), 857300);
  assert.equal(L.tickFloor(857300), 857300);
  assert.equal(L.tickCeil(1305420.2), 1306000);
  assert.equal(L.tickCeil(1306000), 1306000);
  assert.equal(L.tickFloor(7882.4), 7882);
  assert.equal(L.tickCeil(8099.1), 8100);
});

test('the front of a book counts for no more than 115% of the month\'s average, given a month to go on', () => {
  const now = Date.parse('2026-11-17T17:00:00Z');
  // Dodixie, Small Hyperspatial Velocity Optimizer II: asking 3,979,000 against a month at 3,283,000
  const cap = L.spikeCap(histRows(now, 30, 3283000, 39), now, 1.15);
  assert.ok(Math.abs(cap - 3775450) < 1);
  assert.ok(cap < 3979000);
  // eight traded days are not a month: nothing is called a spike
  assert.equal(L.spikeCap(histRows(now, 8, 1540000, 20), now, 1.15), null);
  assert.equal(L.spikeCap([], now, 1.15), null);
  assert.equal(L.spikeCap(null, now, 1.15), null);
  // days with nothing traded do not count towards the month
  assert.equal(L.spikeCap(histRows(now, 30, 1000, d => (d <= 9 ? 5 : 0)), now, 1.15), null);
});

test('a hub is counted at the lowest of its ask and its history, so a thin spike does not count', () => {
  const now = Date.parse('2026-11-17T17:00:00Z');
  // a steady hub: the ask is the lowest mark
  const steady = L.hubRead(1117000, histRows(now, 30, 1150000, 140), now, 1.15);
  assert.equal(steady.price, 1117000);
  assert.equal(steady.thin, false);
  assert.equal(Math.round(steady.perDay), 140);
  // a lone listing far above what the item trades at: counted at the trade, and marked
  const spike = L.hubRead(2900000, histRows(now, 30, 1220000, 27), now, 1.15);
  assert.equal(spike.price, 1220000);
  assert.equal(spike.thin, true);
  // the week jumped but the month did not: held to 115% of the month
  const jump = L.hubRead(2744000, histRows(now, 30, d => (d <= 7 ? 2700000 : 1600000), 100), now, 1.15);
  assert.ok(jump.price < 2744000 && jump.price > 1600000 * 1.15 && jump.price < 2300000, String(jump.price));
  // a week busier than the month is paced by the month
  const burst = L.hubRead(1000, histRows(now, 30, 1000, d => (d <= 7 ? 170 : 40)), now, 1.15);
  assert.ok(burst.perDay < 80 && burst.perDay > 60, String(burst.perDay));
  // nothing listed and nothing traded: no opinion
  assert.equal(L.hubRead(null, [], now, 1.15).price, null);
  // nobody selling now, but it trades: the history stands in
  assert.equal(L.hubRead(null, histRows(now, 30, 500000, 10), now, 1.15).price, 500000);
});

test('where a line goes, and the most a bid on it may be', () => {
  const hubs = [
    { name: 'Amarr', station: 1, price: 1117000, perDay: 142 },
    { name: 'Rens', station: 2, price: 1098000, perDay: 96 },
    { name: 'Dodixie', station: 3, price: 1171729, perDay: 63 },
    { name: 'Hek', station: 4, price: 905000, perDay: 400 },      // busy, but under the floor at this bid
  ];
  const o = { cost: 838000, buyFee: 0.015, netMult: NETM, floor: 0.10, margin: 0.15, top: 3 };
  const g = L.destPlan(hubs, o);
  assert.equal(g.state, 'ok');
  assert.deepEqual(g.hubs.map(x => x.name), ['Amarr', 'Rens', 'Dodixie']);          // best pace of profit first; Hek is left out
  assert.ok(Math.abs(g.hubs.reduce((a, x) => a + x.share, 0) - 1) < 1e-9);
  assert.ok(L.isLegal(g.max) && Math.abs(g.max - 914700) <= 200, String(g.max));     // the roster's figure for Warp Disruptor II on 2026-11-17 was 914,700
  assert.ok(g.margin > 0.25 && g.margin < 0.27);
  // the same bid placed higher: still fine up to the max, not past it
  assert.equal(L.destPlan(hubs, Object.assign({}, o, { cost: 914700 })).state, 'ok');
  // hub prices fall away: no hub nets the floor
  const fell = L.destPlan(hubs.map(x => Object.assign({}, x, { price: 900000 })), o);
  assert.equal(fell.state, 'under');
  assert.ok(fell.max < 838000 && fell.margin < 0.10);
  // nothing to read
  assert.equal(L.destPlan([], o).state, 'unknown');
  assert.equal(L.destPlan([{ name: 'Hek', price: null, perDay: 9 }], o).state, 'unknown');
  // stock already paid for carries no broker fee on the way in; with no pace known the shares are equal
  const paid = L.destPlan([{ name: 'Hek', price: 1000000, perDay: 0 }, { name: 'Rens', price: 1100000, perDay: 0 }], { cost: 800000, buyFee: 0, netMult: NETM, floor: 0.10, margin: 0.15, top: 3 });
  assert.deepEqual(paid.hubs.map(x => x.share), [0.5, 0.5]);
});

test('units shared out between hubs add up exactly', () => {
  const s = L.splitUnits(210, [{ name: 'Amarr', share: 142 / 301 }, { name: 'Rens', share: 96 / 301 }, { name: 'Dodixie', share: 63 / 301 }]);
  assert.deepEqual(s, [{ name: 'Amarr', units: 99 }, { name: 'Rens', units: 67 }, { name: 'Dodixie', units: 44 }]);
  assert.equal(L.splitUnits(5, [{ name: 'A', share: 0.98 }, { name: 'B', share: 0.02 }]).reduce((a, x) => a + x.units, 0), 5);
  assert.deepEqual(L.splitUnits(1, [{ name: 'A', share: 0.5 }, { name: 'B', share: 0.5 }]).length, 1);
  assert.deepEqual(L.splitUnits(10, []), []);
});

test('a bid is held at its max, and pulled when it no longer pays', () => {
  const ctx = { broker: 0.015, modify: 0.0039, bigMove: 0.02 };
  const pos = { status: 'outbid', price: 3304000, remain: 29, wall: 3601000, ahead: 82, over: [] };
  const bump = L.planBid(pos, ctx);
  assert.equal(bump.target, 3602000);
  // the top bid has gone past what the line supports: leave it
  const over = L.guardBid(bump, pos, { state: 'ok', max: 3485000, margin: 0.21 });
  assert.equal(over.action, 'hold'); assert.equal(over.kind, 'over'); assert.equal(over.target, null);
  assert.match(over.reason, /3,601,000.*over your max bid of 3,485,000/);
  // within the max: the bump stands as it was
  assert.equal(L.guardBid(bump, pos, { state: 'ok', max: 3700000, margin: 0.21 }), bump);
  // hub prices fell under the floor: pull, even while leading
  const lead = { status: 'leading', price: 945900, remain: 159, wall: 945800, ahead: 0, over: [] };
  const pull = L.guardBid(L.planBid(lead, ctx), lead, { state: 'under', max: 859700, margin: 0.04 });
  assert.equal(pull.kind, 'pull'); assert.match(pull.reason, /Nets 4%.*859,700.*Cancel it or lower it/);
  assert.match(L.guardBid(L.planBid(lead, ctx), lead, { state: 'under', max: 700000, margin: -0.03 }).reason, /^Loses 3%/);
  // no read of the hubs: no opinion
  assert.equal(L.guardBid(bump, pos, { state: 'unknown' }), bump);
  assert.equal(L.guardBid(bump, pos, null), bump);
});

test('checks: a bid left far behind, and a price that is not the one copied', () => {
  const bid = { isBuy: true, price: 959700, duration: 90, known: true, wall: 1306000, behind: 0.15 };
  assert.match(L.orderChecks(bid)[0], /27% under the top bid, so it will not fill/);
  // the same gap is the plan when the top bid is past the line's max
  assert.deepEqual(L.orderChecks(Object.assign({}, bid, { max: 1250000 })), []);
  assert.match(L.orderChecks(Object.assign({}, bid, { max: 1343000 }))[0], /under the top bid/);
  // an ordinary outbid is not a check
  assert.deepEqual(L.orderChecks(Object.assign({}, bid, { price: 1295000 })), []);
  // without the rule switched on, nothing changes for older callers
  assert.deepEqual(L.orderChecks({ isBuy: true, price: 959700, duration: 90, known: true, wall: 1306000 }), []);
  // copied 1,307,000, typed 959,700
  assert.match(L.orderChecks(Object.assign({}, bid, { max: 1250000, copied: 1307000 }))[0], /You copied 1,307,000 but the order shows 959,700/);
  assert.deepEqual(L.orderChecks({ isBuy: false, price: 1322000, duration: 90, known: true, front: 1323000, cost: 1000000, netMult: NETM, copied: 1322000 }), []);
});

test('probation: a line earns a re-bid by selling half of its first lot', () => {
  const now = Date.parse('2026-12-01T12:00:00Z'), day = 864e5, r = { lotDays: 3, half: 0.5, days: 14, floor: 0.10 };
  const lot = [{ at: now - 5 * day, qty: 100 }, { at: now - 4 * day, qty: 50 }];           // both within three days: one lot of 150
  assert.equal(L.lineStatus({ buys: lot, sold: 0, margin: null, stock: 150 }, r, now).state, 'new');
  assert.deepEqual(L.lineStatus({ buys: lot, sold: 40, margin: 0.2, stock: 110 }, r, now), { state: 'probation', sold: 40, lot: 150, first: now - 5 * day, thin: false });
  assert.equal(L.lineStatus({ buys: lot, sold: 75, margin: 0.2, stock: 75 }, r, now).state, 'proven');
  assert.equal(L.lineStatus({ buys: lot, sold: 120, margin: 0.04, stock: 30 }, r, now).state, 'probation');      // selling, but under the floor
  // a re-buy a week later is not part of the first lot
  assert.equal(L.lineStatus({ buys: lot.concat([{ at: now - 1 * day, qty: 300 }]), sold: 80, margin: 0.2, stock: 370 }, r, now).state, 'proven');
  // two weeks on and still short: clear it and drop the line
  const old = [{ at: now - 15 * day, qty: 150 }];
  assert.equal(L.lineStatus({ buys: old, sold: 20, margin: 0.2, stock: 130 }, r, now).state, 'drop');
  assert.equal(L.lineStatus({ buys: old, sold: 90, margin: 0.2, stock: 60 }, r, now).state, 'proven');
  // bought before the wallet's window and still selling: proven; on bid only: new; old stock nobody buys: drop
  assert.equal(L.lineStatus({ buys: [], sold: 12, margin: null, stock: 5 }, r, now).state, 'proven');
  assert.equal(L.lineStatus({ buys: [], sold: 0, margin: null, stock: 0 }, r, now).state, 'new');
  assert.equal(L.lineStatus({ buys: [], sold: 0, margin: null, stock: 2 }, r, now).state, 'drop');
});

test('price changes are counted from the issue times EVE restamps', () => {
  const fees = { broker: 0.015, modify: 0.0039 };
  const t0 = '2026-11-17T15:00:00Z', t1 = '2026-11-17T20:48:00Z';
  const first = L.orderChanges(null, [{ order_id: 1, issued: t0, price: 838000, volume_remain: 210, is_buy_order: true }, { order_id: 2, issued: t0, price: 1007000, volume_remain: 36, is_buy_order: false }], fees);
  assert.deepEqual(first.changes, []);                                                    // the first look only takes note
  const second = L.orderChanges(first.log, [
    { order_id: 1, issued: t1, price: 839900, volume_remain: 210, is_buy_order: true },      // bumped: the fee on the order, and the broker's share of the escrow added
    { order_id: 2, issued: t0, price: 1007000, volume_remain: 30, is_buy_order: false },     // sold some, not changed
    { order_id: 3, issued: t1, price: 500, volume_remain: 10, is_buy_order: false }], fees); // new: noted, not counted
  assert.equal(second.changes.length, 1);
  assert.equal(second.changes[0].id, 1);
  assert.ok(Math.abs(second.changes[0].fee - (839900 * 210 * 0.0039 + 1900 * 210 * 0.015)) < 0.01);
  assert.deepEqual(Object.keys(second.log), ['1', '2', '3']);
  assert.deepEqual(L.orderChanges(second.log, [{ order_id: 1, issued: t1, price: 839900, volume_remain: 200, is_buy_order: true }], fees).changes, []);
});

test('exposure: committed ISK by hub against the limits, and the gate on new lines', () => {
  const lines = [
    { isk: 176e6, proven: false, hubs: [{ name: 'Amarr', share: 0.47 }, { name: 'Rens', share: 0.32 }, { name: 'Dodixie', share: 0.21 }] },
    { isk: 150e6, proven: false, hubs: [{ name: 'Amarr', share: 1 }] },
    { isk: 300e6, proven: true, hubs: [{ name: 'Dodixie', share: 1 }] },
    { isk: 40e6, proven: true, hubs: null },
    { isk: 0, proven: false, hubs: [{ name: 'Hek', share: 1 }] },
  ];
  const lim = { reserve: 2e9, unproven: 4e9, hub: 2e9 };
  const ex = L.exposure(lines, 2.39e9, lim);
  assert.equal(ex.total, 666e6); assert.equal(ex.unproven, 326e6); assert.equal(ex.loose, 40e6);
  assert.deepEqual(ex.hubs.map(x => x.name), ['Dodixie', 'Amarr', 'Rens']);
  assert.ok(Math.abs(ex.hubs[1].isk - (176e6 * 0.47 + 150e6)) < 1);
  assert.deepEqual(ex.gate, { open: true, why: [] });
  // each limit closes the gate and says why
  assert.match(L.exposure(lines, 1.9e9, lim).gate.why[0], /wallet, 1\.90B, is under your reserve of 2\.00B/);
  assert.match(L.exposure(lines, 2.39e9, Object.assign({}, lim, { unproven: 300e6 })).gate.why[0], /Unproven lines hold 326\.0M, over your limit of 300\.0M/);
  const tight = L.exposure(lines, 2.39e9, Object.assign({}, lim, { hub: 200e6 }));
  assert.equal(tight.gate.open, false);
  assert.deepEqual(tight.hubs.filter(x => x.over).map(x => x.name), ['Dodixie', 'Amarr']);
  assert.equal(tight.gate.why.length, 2);
  assert.deepEqual(L.exposure([], null, lim).gate.open, true);
});

test('sync carries the limits and the week\'s change count', () => {
  const keep = { pins: 1e9, copied: 1e9 };
  const a = { risk: { v: { reserve: 2e9, unproven: 4e9, hub: 2e9, trip: 1e9 }, at: 5 }, weeks: { w: { '2026-11-16': { bumps: { n: 14, fee: 5.1e6 } } } } };
  const b = { risk: { v: { reserve: 1.5e9, unproven: 4e9, hub: 2e9, trip: 1e9 }, at: 9 }, weeks: { w: { '2026-11-16': { bumps: { n: 9, fee: 3.3e6 } } } } };
  const ab = L.syncMerge(a, b, 100, keep), ba = L.syncMerge(b, a, 100, keep);
  assert.equal(L.stable(ab), L.stable(ba));
  assert.equal(ab.risk.v.reserve, 1.5e9);                                    // the newer setting
  assert.deepEqual(ab.weeks.w['2026-11-16'].bumps, { n: 14, fee: 5.1e6 });   // the fuller count
  assert.equal(L.syncMerge(a, {}, 100, keep).risk.at, 5);
});

test('a load keeps the plan it came aboard with, and counts down as it is listed', () => {
  const split = n => L.splitUnits(n, [{ name: 'Amarr', share: 0.6 }, { name: 'Dodixie', share: 0.3 }, { name: 'Rens', share: 0.1 }]);
  const old = { id: 7, hub: 'Amarr', units: 50 };              // an order from an earlier load: not counted
  let r = L.loadStep(null, { qty: 100, orders: [old], here: null, split });
  assert.deepEqual(r.left, [{ name: 'Amarr', units: 60 }, { name: 'Dodixie', units: 30 }, { name: 'Rens', units: 10 }]);
  // prices move on the way: the split would now send everything to Rens, but the load keeps its plan
  const moved = n => [{ name: 'Rens', units: n }];
  assert.deepEqual(L.loadStep(r.entry, { qty: 100, orders: [old], here: null, split: moved }).left, r.left);
  // listed 60 in Amarr: the order list shows it before the cargo does
  const mine = { id: 8, hub: 'Amarr', units: 60 };
  r = L.loadStep(r.entry, { qty: 100, orders: [old, mine], here: 'Amarr', split: moved });
  assert.deepEqual(r.left, [{ name: 'Dodixie', units: 30 }, { name: 'Rens', units: 10 }]);
  assert.equal(r.waiting, 60);
  // then the cargo catches up, and nothing is taken off twice
  r = L.loadStep(r.entry, { qty: 40, orders: [old, mine], here: null, split: moved });
  assert.deepEqual(r.left, [{ name: 'Dodixie', units: 30 }, { name: 'Rens', units: 10 }]);
  assert.equal(r.waiting, 0);
  // the Amarr order sells out and leaves the order list: the 60 stay counted
  r = L.loadStep(r.entry, { qty: 40, orders: [old], here: null, split: moved });
  assert.deepEqual(r.left, [{ name: 'Dodixie', units: 30 }, { name: 'Rens', units: 10 }]);
  // the same input twice gives the same answer
  assert.deepEqual(L.loadStep(r.entry, { qty: 40, orders: [old], here: null, split: moved }), r);
});

test('units that leave the hold unexplained come off the hub you are in, then the largest share', () => {
  const split = n => L.splitUnits(n, [{ name: 'Hek', share: 0.5 }, { name: 'Rens', share: 0.5 }]);
  let r = L.loadStep(null, { qty: 40, orders: [], here: null, split });
  // the cargo drops by 25 while docked in Hek, before any order shows: 20 off Hek, 5 off Rens
  r = L.loadStep(r.entry, { qty: 15, orders: [], here: 'Hek', split });
  assert.deepEqual(r.left, [{ name: 'Rens', units: 15 }]);
  // the Hek order of 25 then shows: it explains what was taken off, and nothing more comes off
  const hek = { id: 1, hub: 'Hek', units: 25 };
  r = L.loadStep(r.entry, { qty: 15, orders: [hek], here: 'Hek', split });
  assert.deepEqual(r.left, [{ name: 'Rens', units: 15 }]);
  assert.deepEqual(r.entry.t, {});
  // more of the same item comes aboard: only the new units are shared out
  r = L.loadStep(r.entry, { qty: 35, orders: [hek], here: null, split });
  assert.deepEqual(r.left, [{ name: 'Rens', units: 25 }, { name: 'Hek', units: 10 }]);
  // listing more at a hub than its share takes the rest off the largest other share
  r = L.loadStep(r.entry, { qty: 35, orders: [hek, { id: 2, hub: 'Hek', units: 14 }], here: 'Hek', split });
  assert.deepEqual(r.left, [{ name: 'Rens', units: 21 }]);
  // an item with nowhere to go is kept as "nowhere yet"
  assert.deepEqual(L.loadStep(null, { qty: 5, orders: [], here: null, split: () => [] }).left, [{ name: '', units: 5 }]);
});
