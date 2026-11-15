/* Eve Ops — pure logic: price ticks, book position, hold/tick calls, FIFO ledger.
   No network, no DOM. Runs in the browser (window.Logic) and in Node (tests). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Logic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- prices
  // EVE prices carry 4 significant figures. Work in whole cents to avoid float drift.
  function cents(p) { return Math.round(p * 100); }
  function stepFor(c) { return Math.pow(10, Math.max(0, String(Math.abs(c)).length - 4)); }
  function isLegal(p) { const c = cents(p); return c > 0 && c % stepFor(c) === 0; }
  /** Largest legal price strictly below p. */
  function tickBelow(p) {
    const c = cents(p) - 1;
    if (c <= 0) return null;
    const s = stepFor(c);
    return Math.floor(c / s) * s / 100;
  }
  /** Smallest legal price strictly above p. */
  function tickAbove(p) {
    const c = cents(p) + 1;
    const s = stepFor(c);
    return Math.ceil(c / s) * s / 100;
  }

  // ------------------------------------------------------------- book math
  function levels(orders, dir) {
    const m = new Map();
    for (const o of orders) m.set(o.price, (m.get(o.price) || 0) + o.volume_remain);
    const arr = Array.from(m, ([price, units]) => ({ price, units }));
    arr.sort((a, b) => (dir === 'asc' ? a.price - b.price : b.price - a.price));
    return arr;
  }
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);

  /**
   * Where one of my sell orders stands among sell orders in the same station.
   * bookNewer: the market book was published after my order list, so trust the
   * book's copy of my order (price, units left) over the list's.
   */
  function sellPosition(order, book, myIds, bookNewer) {
    const live = book.find(o => o.order_id === order.order_id) || null;
    const src = live && bookNewer ? live : order;
    const price = src.price;
    const remain = src.volume_remain;
    const issued = Date.parse(src.issued);
    const rivals = book.filter(o => !o.is_buy_order && o.location_id === order.location_id && !myIds.has(o.order_id));
    const lv = levels(rivals, 'asc');
    const under = lv.filter(l => l.price < price);
    const tiedAhead = sum(rivals.filter(o => o.price === price && Date.parse(o.issued) < issued), o => o.volume_remain);
    const front = lv.length ? lv[0].price : null;
    const above = lv.find(l => l.price > price) || null;
    let status;
    if (!live && bookNewer) status = 'gone';
    else if (front === null || front > price) status = 'leading';
    else if (front === price) status = tiedAhead > 0 ? 'behind' : 'leading';
    else status = 'undercut';
    return {
      price, remain, total: order.volume_total, issued,
      front, next: above ? above.price : null,
      unitsUnder: sum(under, l => l.units), tiedAhead,
      ahead: sum(under, l => l.units) + tiedAhead,
      under: under.slice(0, 3), status, inBook: !!live,
    };
  }

  /**
   * Where one of my buy orders stands. `reaches(o)` says whether a rival buy
   * order can be filled at my order's station (same station, or range covers it).
   */
  function buyPosition(order, book, myIds, bookNewer, reaches) {
    const live = book.find(o => o.order_id === order.order_id) || null;
    const src = live && bookNewer ? live : order;
    const price = src.price;
    const remain = src.volume_remain;
    const issued = Date.parse(src.issued);
    const rivals = book.filter(o => o.is_buy_order && !myIds.has(o.order_id) && reaches(o));
    const lv = levels(rivals, 'desc');
    const over = lv.filter(l => l.price > price);
    const tiedAhead = sum(rivals.filter(o => o.price === price && Date.parse(o.issued) < issued), o => o.volume_remain);
    const wall = lv.length ? lv[0].price : null;
    let status;
    if (!live && bookNewer) status = 'gone';
    else if (wall === null || wall < price) status = 'leading';
    else if (wall === price) status = tiedAhead > 0 ? 'behind' : 'leading';
    else status = 'outbid';
    return {
      price, remain, total: order.volume_total, filled: order.volume_total - remain, issued,
      wall, unitsOver: sum(over, l => l.units), tiedAhead,
      ahead: sum(over, l => l.units) + tiedAhead,
      over: over.slice(0, 3), status, inBook: !!live,
    };
  }

  // ----------------------------------------------------------------- calls
  /**
   * Decide what to do with every sell order I have for one item in one station.
   * group: [{ order, pos }]   ctx: { cost, jitaSell, isJita, netMult, modify, sniperUnits }
   * Returns a Map order_id -> { action, reason, target, fee, net, margin }
   *   action: 'hold' | 'tick' | 'optional' | 'none'
   */
  function planSells(group, ctx) {
    const out = new Map();
    const live = group.filter(g => g.pos.status !== 'gone');
    for (const g of group) {
      if (g.pos.status === 'gone') out.set(g.order.order_id, { action: 'none', reason: 'Not in the market book. Sold out, cancelled or expired.', target: null });
    }
    if (!live.length) return out;
    const lead = live.reduce((a, b) => (b.pos.price < a.pos.price ? b : a));
    const ownLow = lead.pos.price;
    const money = (target, g) => {
      const net = ctx.cost != null ? target * ctx.netMult - ctx.cost : null;
      return {
        target,
        fee: target * g.pos.remain * ctx.modify,
        net,
        margin: net != null && ctx.cost > 0 ? net / ctx.cost : null,
      };
    };
    const holdAt = (g, reason) => Object.assign({ action: 'hold', reason }, money(g.pos.price, g), { target: null, fee: 0 });

    if (lead.pos.status === 'undercut' || lead.pos.status === 'behind') {
      const front = lead.pos.front;
      const target = tickBelow(front);
      const units = lead.pos.ahead;
      let action = 'tick';
      let reason = lead.pos.status === 'behind'
        ? units.toLocaleString('en-US') + ' older units at your price'
        : units.toLocaleString('en-US') + (units === 1 ? ' unit' : ' units') + ' under you';
      if (ctx.cost != null && front * ctx.netMult <= ctx.cost) { action = 'hold'; reason = 'Front is below your cost. Dump, let it drain.'; }
      else if (ctx.cost != null && target * ctx.netMult <= ctx.cost) { action = 'hold'; reason = 'One tick under would sell below cost.'; }
      else if (!ctx.isJita && ctx.jitaSell != null && front <= ctx.jitaSell) { action = 'hold'; reason = 'Front is at or below the Jita sell price.'; }
      else if (units <= ctx.sniperUnits) { action = 'optional'; reason = 'Sniper: ' + reason + '.'; }
      for (const g of live) {
        if (action === 'hold') out.set(g.order.order_id, holdAt(g, reason));
        else if (g.pos.price <= target) out.set(g.order.order_id, holdAt(g, 'Already under the front.'));
        else out.set(g.order.order_id, Object.assign({ action, reason }, money(target, g)));
      }
      return out;
    }
    // My lowest order leads. Any other order of mine priced above it is a mismatch.
    for (const g of live) {
      if (g.pos.price > ownLow) {
        out.set(g.order.order_id, Object.assign({ action: 'tick', kind: 'mismatch', reason: 'Priced above your other order here.' }, money(ownLow, g)));
      } else {
        out.set(g.order.order_id, holdAt(g, live.length > 1 && g !== lead ? 'Leading, matches your other order.' : 'Leading.'));
      }
    }
    return out;
  }

  /** ctx: { broker, modify } */
  function planBid(pos, ctx) {
    if (pos.status === 'gone') return { action: 'none', reason: 'Not in the market book. Filled, cancelled or expired.', target: null };
    if (pos.status === 'leading') return { action: 'hold', reason: 'Top bid.', target: null, fee: 0 };
    const target = tickAbove(pos.wall);
    const added = (target - pos.price) * pos.remain;
    const units = pos.ahead;
    return {
      action: 'tick',
      reason: pos.status === 'behind'
        ? units.toLocaleString('en-US') + ' older units at your price'
        : units.toLocaleString('en-US') + (units === 1 ? ' unit' : ' units') + ' bid above you',
      target,
      escrowAdd: added,
      fee: target * pos.remain * ctx.modify + Math.max(0, added) * ctx.broker,
    };
  }

  // ---------------------------------------------------------------- ledger
  /**
   * First-in first-out cost matching over the wallet transactions the API still holds.
   * Returns { sales: [...], lots: Map(type_id -> [{qty, price, date}]), from, to }
   * A sale's `net` covers only the units a purchase was found for (`covered`).
   */
  function ledger(transactions, opts) {
    const exclude = opts.exclude || new Set();
    const zero = opts.zeroCost || new Set();
    const tx = transactions.filter(t => !exclude.has(t.type_id)).slice()
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.transaction_id - b.transaction_id);
    const lots = new Map();
    const sales = [];
    const lastBuy = new Map();
    for (const t of tx) {
      const when = Date.parse(t.date);
      if (t.is_buy) {
        if (!lots.has(t.type_id)) lots.set(t.type_id, []);
        lots.get(t.type_id).push({ qty: t.quantity, price: t.unit_price, date: when });
        lastBuy.set(t.type_id, when);
        continue;
      }
      let need = t.quantity, cost = 0, covered = 0;
      if (zero.has(t.type_id)) { covered = need; need = 0; }
      const q = lots.get(t.type_id) || [];
      while (need > 0 && q.length) {
        const lot = q[0];
        const take = Math.min(need, lot.qty);
        cost += take * lot.price; covered += take; need -= take; lot.qty -= take;
        if (lot.qty === 0) q.shift();
      }
      sales.push({
        date: when, type_id: t.type_id, location_id: t.location_id,
        qty: t.quantity, price: t.unit_price, gross: t.quantity * t.unit_price,
        covered, cost, net: covered > 0 ? covered * t.unit_price * opts.netMult - cost : null,
      });
    }
    return {
      sales, lots, lastBuy,
      from: tx.length ? Date.parse(tx[0].date) : null,
      to: tx.length ? Date.parse(tx[tx.length - 1].date) : null,
    };
  }

  /** Average cost of the newest `qty` units still on hand for a type, or null. */
  function unitCost(lots, typeId, qty) {
    const q = lots.get(typeId);
    if (!q || !q.length) return null;
    let need = qty > 0 ? qty : Infinity, units = 0, cost = 0;
    for (let i = q.length - 1; i >= 0 && need > 0; i--) {
      const take = Math.min(need, q[i].qty);
      units += take; cost += take * q[i].price; need -= take;
    }
    return units > 0 ? { cost: cost / units, units } : null;
  }

  function summarize(sales, from, to) {
    const s = { gross: 0, units: 0, net: 0, uncovered: 0, count: 0 };
    for (const x of sales) {
      if (x.date < from || x.date >= to) continue;
      s.gross += x.gross; s.units += x.qty; s.count++;
      if (x.net != null) s.net += x.net;
      s.uncovered += x.qty - x.covered;
    }
    return s;
  }

  function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function startOfWeek(ms) { // Monday 00:00, device time
    const d = new Date(startOfDay(ms));
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.getTime();
  }
  function daily(sales, days, now) {
    const out = [];
    const d = new Date(startOfDay(now));
    d.setDate(d.getDate() - (days - 1));
    for (let i = 0; i < days; i++) {
      const from = d.getTime();
      d.setDate(d.getDate() + 1);
      out.push(Object.assign({ day: from }, summarize(sales, from, d.getTime())));
    }
    return out;
  }

  /** Map "type:location" -> { d1, d7, last } units sold in the last day / week, last sale time. */
  function velocity(sales, now) {
    const m = new Map();
    for (const x of sales) {
      const k = x.type_id + ':' + x.location_id;
      const v = m.get(k) || { d1: 0, d7: 0, last: 0 };
      if (now - x.date <= 864e5) v.d1 += x.qty;
      if (now - x.date <= 7 * 864e5) v.d7 += x.qty;
      if (x.date > v.last) v.last = x.date;
      m.set(k, v);
    }
    return m;
  }

  // ------------------------------------------------------------ formatting
  function isk(n) {
    if (n == null || !isFinite(n)) return '';
    const r = Math.round(n * 100) / 100;
    return r.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(r) ? 0 : 2, maximumFractionDigits: 2 });
  }
  function short(n) {
    if (n == null || !isFinite(n)) return '';
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(Math.round(n));
  }
  function span(ms) {
    const m = Math.round(Math.abs(ms) / 60000);
    if (m < 1) return 'under a minute';
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60);
    if (h < 48) return h + ' h' + (m % 60 && h < 10 ? ' ' + (m % 60) + ' min' : '');
    return Math.round(h / 24) + ' days';
  }
  /** Security status as the game shows it: one decimal, and anything above 0 never shows as 0.0. */
  function sec(s) {
    let r = Math.round(s * 10) / 10;
    if (s > 0 && r <= 0) r = 0.1;
    return Math.max(0, Math.min(1, r));
  }

  return {
    tickBelow, tickAbove, isLegal, levels,
    sellPosition, buyPosition, planSells, planBid,
    ledger, unitCost, summarize, daily, velocity, startOfDay, startOfWeek,
    isk, short, span, sec,
  };
});
