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

const ctx = { cost: 1100000, jitaSell: 1150000, isJita: false, netMult: 0.95125, modify: 0.0039, sniperUnits: 5 };
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

test('buy position and bid call', () => {
  const mine = buy(1, 578500, 40);
  const book = [mine, buy(2, 579700, 43), buy(3, 579600, 162), buy(4, 579400, 708), buy(5, 600000, 10, null, 'station', 60003469), buy(6, 500000, 5)];
  const reaches = o => o.location_id === 60003760 || o.range === 'region';
  const p = L.buyPosition(mine, book, new Set([1]), true, reaches);
  assert.equal(p.status, 'outbid');
  assert.equal(p.wall, 579700);
  assert.equal(p.unitsOver, 913);
  assert.deepEqual(p.over.map(l => l.price), [579700, 579600, 579400]);
  const plan = L.planBid(p, { broker: 0.015, modify: 0.0039 });
  assert.equal(plan.action, 'tick');
  assert.equal(plan.target, 579800);
  assert.equal(plan.escrowAdd, (579800 - 578500) * 40);
  const top = buy(1, 580000, 40);
  assert.equal(L.planBid(L.buyPosition(top, [top].concat(book.slice(1)), new Set([1]), true, reaches), { broker: 0.015, modify: 0.0039 }).action, 'hold');
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
