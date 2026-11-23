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

  /** Largest legal price at or below p, and smallest at or above it. */
  function tickFloor(p) { return p > 0 && isLegal(p) ? cents(p) / 100 : tickBelow(p); }
  function tickCeil(p) { return p > 0 && isLegal(p) ? cents(p) / 100 : tickAbove(p); }

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
   * group: [{ order, pos }]   ctx: { cost, jitaSell, isJita, netMult, modify, sniperUnits, bigMove }
   * Returns a Map order_id -> { action, kind, reason, target, fee, net, margin }
   *   action: 'hold' | 'tick' | 'optional' | 'none'
   *   kind (for 'optional'): 'big' = the front sits far below you, 'sniper' = a few units just under
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
      const drop = (lead.pos.price - target) / lead.pos.price;
      let action = 'tick', kind = null;
      let reason = lead.pos.status === 'behind'
        ? units.toLocaleString('en-US') + ' older units at your price'
        : units.toLocaleString('en-US') + (units === 1 ? ' unit' : ' units') + ' under you';
      if (ctx.cost != null && front * ctx.netMult <= ctx.cost) { action = 'hold'; reason = 'Front is below your cost. Dump, let it drain.'; }
      else if (ctx.cost != null && target * ctx.netMult <= ctx.cost) { action = 'hold'; reason = 'One tick under would sell below cost.'; }
      else if (!ctx.isJita && ctx.jitaSell != null && front <= ctx.jitaSell) { action = 'hold'; reason = 'Front is at or below the Jita sell price.'; }
      else if (drop > ctx.bigMove) { action = 'optional'; kind = 'big'; reason = 'Front is ' + Math.round(drop * 1000) / 10 + '% under you. Dump or repricing: your call.'; }
      else if (units <= ctx.sniperUnits) { action = 'optional'; kind = 'sniper'; reason = 'Sniper: ' + reason + '.'; }
      else if (ctx.slowDays) { action = 'optional'; kind = 'slow'; reason = 'No sale here in ' + ctx.slowDays + ' days: is staying in front worth the fee? Your call.'; }
      for (const g of live) {
        if (action === 'hold') out.set(g.order.order_id, holdAt(g, reason));
        else if (g.pos.price <= target) out.set(g.order.order_id, holdAt(g, 'Already under the front.'));
        else {
          const m = money(target, g), back = action === 'tick' ? payback(m.fee, m.net, ctx.pace) : null;
          // a change that costs more than the profit on the sales it can bring in a day is not urged: the price is still offered
          if (back && !back.worth) out.set(g.order.order_id, Object.assign({ action: 'optional', kind: 'fee', reason: reason + '. Changing costs the profit on ' + back.sales + ' sales; you sell about ' + paceText(ctx.pace) + ' a day here. Your call.', payback: back }, m));
          else out.set(g.order.order_id, Object.assign({ action, kind, reason, payback: back }, m));
        }
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

  /** ctx: { broker, modify, bigMove } */
  function planBid(pos, ctx) {
    if (pos.status === 'gone') return { action: 'none', reason: 'Not in the market book. Filled, cancelled or expired.', target: null };
    if (pos.status === 'leading') return { action: 'hold', reason: 'Top bid.', target: null, fee: 0 };
    const target = tickAbove(pos.wall);
    const added = (target - pos.price) * pos.remain;
    const units = pos.ahead;
    const rise = (target - pos.price) / pos.price;
    const big = rise > ctx.bigMove;
    return {
      action: big ? 'optional' : 'tick',
      kind: big ? 'big' : null,
      reason: big ? 'Top bid is ' + Math.round(rise * 1000) / 10 + '% above yours. Check the margin before you bump.'
        : pos.status === 'behind'
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
    const made = opts.made || new Set();
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
      let need = t.quantity, cost = 0, covered = 0, borrowed = 0;
      if (zero.has(t.type_id)) { covered = need; need = 0; }
      // opts.prefer 'tracker': the tracker's cost for every unit of an item it lists; the wallet's lots are still used up, to stay in step
      const first = need > 0 && opts.prefer === 'tracker' && opts.fallback ? opts.fallback(t.type_id, t.location_id, when) : null;
      if (first != null) { cost = need * first; covered = borrowed = need; }
      const q = lots.get(t.type_id) || [];
      while (need > 0 && q.length) {
        const lot = q[0];
        const take = Math.min(need, lot.qty);
        if (first == null) { cost += take * lot.price; covered += take; }
        need -= take; lot.qty -= take;
        if (lot.qty === 0) q.shift();
      }
      if (first != null) need = 0;
      // made, not bought (a planetary product with no purchase left in the wallet): no cost
      if (need > 0 && made.has(t.type_id)) { covered += need; need = 0; }
      // units the wallet has no purchase for (bought before EVE's history, or never bought): the tracker's cost, if it has one
      if (need > 0 && opts.fallback) {
        const c = opts.fallback(t.type_id, t.location_id, when);
        if (c != null) { cost += need * c; covered += need; borrowed = need; need = 0; }
      }
      sales.push({
        date: when, type_id: t.type_id, location_id: t.location_id,
        qty: t.quantity, price: t.unit_price, gross: t.quantity * t.unit_price,
        covered, borrowed, cost, net: covered > 0 ? covered * t.unit_price * opts.netMult - cost : null,
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
    const s = { gross: 0, units: 0, net: 0, uncovered: 0, borrowed: 0, count: 0 };
    for (const x of sales) {
      if (x.date < from || x.date >= to) continue;
      s.gross += x.gross; s.units += x.qty; s.count++;
      if (x.net != null) s.net += x.net;
      s.uncovered += x.qty - x.covered; s.borrowed += x.borrowed || 0;
    }
    return s;
  }

  /** The sales between two times that have units without a cost, most units first: [{ type, units, gross }]. */
  function uncosted(sales, from, to) {
    const m = new Map();
    for (const x of sales) {
      if (x.date < from || x.date >= to || x.qty <= x.covered) continue;
      const e = m.get(x.type_id) || { type: x.type_id, units: 0, gross: 0 };
      e.units += x.qty - x.covered; e.gross += (x.qty - x.covered) * x.price;
      m.set(x.type_id, e);
    }
    return Array.from(m.values()).sort((a, b) => b.units - a.units || b.gross - a.gross || a.type - b.type);
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

  // ---------------------------------------------------------------- checks
  /**
   * Mistakes worth catching fast on one order. Returns a list of short sentences (empty = fine).
   * o: { isBuy, price, duration, known (station is one of your hubs), front, wall, cost, netMult }
   */
  function orderChecks(o) {
    const out = [];
    const pct = x => Math.round(Math.abs(x) * 100) + '%';
    if (!o.known) out.push('Not at one of your hubs.');
    if (o.duration < 90) out.push('Listed for ' + o.duration + (o.duration === 1 ? ' day' : ' days') + ', not 90.');
    if (o.isBuy) {
      if (o.wall != null && o.price >= o.wall * 1.25) out.push(pct(o.price / o.wall - 1) + ' above the next bid. Check for a typo.');
      // far under the top bid it will not fill, unless the top bid is past what the line supports (o.max), where staying behind is the plan
      else if (o.behind && o.wall != null && o.price <= o.wall * (1 - o.behind) && !(o.max != null && tickAbove(o.wall) > o.max)) out.push(pct(1 - o.price / o.wall) + ' under the top bid, so it will not fill. A typo, or a bid the market has left behind.');
    } else {
      // a dropped digit (897,200 for 1,897,200) sells at half price within minutes: caught against the next seller, and against what you
      // sold it for here this week (`typical`) where there is no other seller to go by
      const low = o.under || 0.25;
      if (o.front != null && o.price <= o.front * (1 - low)) out.push(pct(1 - o.price / o.front) + ' under the next seller. Check for a typo.');
      else if (o.typical != null && o.typical > 0 && o.price <= o.typical * (1 - low)) out.push(pct(1 - o.price / o.typical) + ' under what you sold it for here this week. Check for a typo.');
      else if (o.front != null && o.price >= o.front * 1.5) out.push(pct(o.price / o.front - 1) + ' above the front. Check for a typo.');
      if (o.cost != null && o.cost > 0 && o.price * o.netMult < o.cost) out.push('Sells below your cost.');
    }
    // the price copied from the page and the price the order ended up at are far apart: most likely a slip of the keys
    if (o.copied != null && o.copied > 0 && Math.abs(o.price - o.copied) / o.copied > 0.02) out.push('You copied ' + isk(o.copied) + ' but the order shows ' + isk(o.price) + '.');
    return out;
  }

  /**
   * Whether a price change earns its fee: the number of sales whose profit the fee eats, against the sales a day expected at the hub.
   * pace: units a day you can expect to sell there (null when not known: the change is not judged).
   * -> null, or { sales, perDay, worth } (worth: the fee is no more than the profit on a day's sales, or on one sale)
   */
  function payback(fee, netEach, pace) {
    if (pace == null || !(fee > 0) || !(netEach > 0)) return null;
    const sales = Math.ceil(fee / netEach - 1e-9);
    return { sales, perDay: pace, worth: sales <= Math.max(1, pace) };
  }
  const paceText = p => (p >= 10 ? String(Math.round(p)) : p >= 1 ? (Math.round(p * 10) / 10).toString() : (Math.round(p * 100) / 100).toString());

  /**
   * How many units to list at once at a hub: `days` of the pace you can expect there, at least one, and never more than you have.
   * Listing in batches keeps an order small, and a price change costs a share of the order's whole value.
   * -> { list, keep } (list = all when the pace is not known)
   */
  function batch(qty, pace, days) {
    if (!(qty > 0)) return { list: 0, keep: 0 };
    if (pace == null || !(pace > 0)) return { list: qty, keep: 0 };
    const list = Math.min(qty, Math.max(1, Math.ceil(pace * (days || 3) - 1e-9)));
    return { list, keep: qty - list };
  }

  /**
   * Units shared out between hubs, held to what each hub can take: `room` is { hub: units it can still take } (missing = no limit).
   * Units over a hub's room go to the next hub in `order` that has room; what no hub can take stays behind as { name: '', units }.
   * parts: [{ name, units }] -> [{ name, units }] in the same order, the kept units last.
   */
  function capSplit(parts, room, order) {
    const out = new Map(), left = Object.assign({}, room || {});
    let spare = 0;
    for (const p of parts || []) {
      const r = left[p.name] == null ? Infinity : Math.max(0, left[p.name]);
      const take = Math.min(p.units, r);
      if (take > 0) out.set(p.name, (out.get(p.name) || 0) + take);
      if (left[p.name] != null) left[p.name] = r - take;
      spare += p.units - take;
    }
    for (const name of order || []) {
      if (spare <= 0) break;
      const r = left[name] == null ? Infinity : Math.max(0, left[name]);
      const take = Math.min(spare, r);
      if (take > 0) { out.set(name, (out.get(name) || 0) + take); spare -= take; if (left[name] != null) left[name] = r - take; }
    }
    const rows = Array.from(out, e => ({ name: e[0], units: e[1] }));
    if (spare > 0) rows.push({ name: '', units: spare });
    return rows;
  }

  /**
   * A bid over its max that has bought nothing for `days`: it ties up ISK and will not fill at a price that pays. Cancel it.
   * o: { kind (the bid's call kind), issued (ms, restamped when the price changes), lastFill (ms of the last purchase of the line, or 0), escrow, now }
   * -> null, or { reason }
   */
  function deadBid(o, days) {
    if (o.kind !== 'over') return null;
    const span = (days || 3) * 864e5;
    if (o.now - o.issued < span || (o.lastFill && o.now - o.lastFill < span)) return null;
    return { reason: 'Over max, and nothing filled in ' + (days || 3) + ' days: cancel it to free ' + short(o.escrow || 0) + '.' };
  }

  /**
   * The week's net after every fee actually paid: the ledger's net counts the broker's share of each sale only, so the broker fees
   * the journal shows beyond that (price changes, bids placed, listings not yet sold) come off too.
   * -> { net, extra } (extra: the fees taken off, never negative)
   */
  function trueNet(net, gross, broker, rate) {
    if (net == null || broker == null) return null;
    const extra = Math.max(0, Math.abs(broker) - (rate || 0) * (gross || 0));
    return { net: net - extra, extra };
  }

  // ------------------------------------------------------------- new lines
  /**
   * The New lines screen, step 1: one page of a region's order book folded into what the screen keeps per item and hub station.
   * acc: Map type -> { [hub name]: { ask, levels: [[price, units]] (the cheapest 12 asks), bid } }
   * hub: { name, station, system }. A bid counts at the station when it is there, region-wide, or elsewhere in its system with a range
   * wider than its station (bids from other systems with a jump range are not measured here, so the top bid may read a little low).
   */
  function screenEat(acc, orders, hub) {
    for (const o of orders || []) {
      if (o.location_id !== hub.station && !(o.is_buy_order && (o.range === 'region' || (o.system_id === hub.system && o.range !== 'station')))) continue;
      let e = acc.get(o.type_id);
      if (!e) { e = {}; acc.set(o.type_id, e); }
      const x = e[hub.name] || (e[hub.name] = { ask: null, levels: [], bid: null });
      if (o.is_buy_order) { if (x.bid == null || o.price > x.bid) x.bid = o.price; continue; }
      if (x.ask == null || o.price < x.ask) x.ask = o.price;
      x.levels.push([o.price, o.volume_remain]);
      if (x.levels.length > 24) { x.levels.sort((a, b) => a[0] - b[0]); x.levels.length = 12; }
    }
    return acc;
  }

  /**
   * Step 2, the price pass: what each allowed item would cost in Jita and which hubs would pay for it, from the books alone.
   * books: Map type -> screenEat entry (Jita under o.jita). o: { allowed: Map type -> group (or Set), skip: Set of types, jita: 'Jita',
   *   hubs: [names], maxCost, gap (a Jita spread wider than this is bought at the ask), netMult, buyFee, floor }
   * Cost is one legal tick over the top Jita bid, plus the broker's share for placing it; or the Jita ask where the spread is wide
   * or the tick would meet the ask ("buy at the ask", your call). A hub passes when its lowest ask nets `floor` on that cost.
   * -> [{ type, bid, atAsk, cost, jitaAsk, hubs: [{ name, ask, levels }] }]
   */
  function screenCandidates(books, o) {
    const out = [];
    for (const [type, e] of books) {
      if (o.allowed && !o.allowed.has(type)) continue;
      if (o.skip && o.skip.has(type)) continue;
      const j = e[o.jita];
      if (!j || (j.bid == null && j.ask == null)) continue;
      let bid = j.bid != null ? tickAbove(j.bid) : null, atAsk = false;
      if (bid == null || (j.ask != null && ((j.ask - j.bid) / j.ask > o.gap || bid >= j.ask))) { bid = j.ask; atAsk = true; }
      if (bid == null || bid > o.maxCost) continue;
      const cost = bid * (1 + (atAsk ? 0 : o.buyFee || 0));
      const hubs = [];
      for (const name of o.hubs) {
        const x = e[name];
        if (!x || x.ask == null) continue;
        if (x.ask * o.netMult - cost >= o.floor * cost) hubs.push({ name, ask: x.ask, levels: x.levels.slice().sort((a, b) => a[0] - b[0]) });
      }
      if (hubs.length) out.push({ type, bid, atAsk, cost, jitaAsk: j.ask, hubs, jitaLevels: atAsk ? j.levels.slice().sort((a, b) => a[0] - b[0]) : null });
    }
    return out;
  }

  /**
   * Step 3, the volume pass and the score, for one candidate. hist: { [hub name]: ESI daily rows, oldest first }.
   * A hub counts when it traded `minPerDay` a day over its last 7 published days, still nets `floor` at the lowest of its ask, its newest
   * day's average and its week's average, and has no more than `maxDays` of trade already listed within 5% of that price.
   * Score = the sum over those hubs of net each x units a day x `share`, times the line's `weight` (how its kind of item has done for you).
   * First lot = `lotDays` x `lotShare` of those hubs' trade, held to `lotIsk` and to a day of Jita's own trade when that is known.
   * o: { netMult, floor, minPerDay, maxDays, share, lotDays, lotShare, lotIsk, weight, jitaPerDay, now }
   * -> null, or { type, bid, atAsk, cost, score, raw, hubs: [{ name, price, ask, perDay, net, margin }] best first, lot: { units, isk } }
   */
  function screenScore(c, hist, o) {
    const now = o.now || Date.now(), hubs = [];
    for (const x of c.hubs) {
      const rows = (hist[x.name] || []).filter(r => Date.parse(r.date) >= now - 8 * 864e5).slice(-7);
      const vol = sum(rows, r => r.volume), perDay = vol / 7;
      if (!rows.length || perDay < o.minPerDay) continue;
      const price = Math.min(x.ask, rows[rows.length - 1].average, sum(rows, r => r.average * r.volume) / vol);
      const net = price * o.netMult - c.cost;
      if (net < o.floor * c.cost) continue;
      const listed = sum((x.levels || []).filter(l => l[0] <= price * 1.05), l => l[1]);
      if (listed > o.maxDays * perDay) continue;
      hubs.push({ name: x.name, price, ask: x.ask, perDay, net, margin: net / c.cost });
    }
    if (!hubs.length) return null;
    let units = Math.round(sum(hubs, x => x.perDay) * o.lotDays * o.lotShare);
    if (o.jitaPerDay != null && o.jitaPerDay > 0) units = Math.min(units, Math.floor(o.jitaPerDay));
    units = Math.max(1, Math.min(units, Math.floor(o.lotIsk / c.bid)));
    // bought at the Jita ask: the lot is priced up the asks actually there (a few units listed far under the market are not a price),
    // and held to what is listed within the 12 cheapest asks
    let bid = c.bid, cost = c.cost, short = 1;
    if (c.atAsk && c.jitaLevels && c.jitaLevels.length) {
      let need = units, isk = 0, got = 0;
      for (const l of c.jitaLevels) { if (need <= 0) break; const t = Math.min(need, l[1]); isk += t * l[0]; got += t; need -= t; }
      if (!got) return null;
      short = got / units; units = got; bid = isk / got; cost = bid;
      for (const x of hubs) { x.net = x.price * o.netMult - cost; x.margin = x.net / cost; }
      for (let i = hubs.length - 1; i >= 0; i--) if (hubs[i].net < o.floor * cost) hubs.splice(i, 1);
      if (!hubs.length) return null;
    }
    hubs.sort((a, b) => b.net * b.perDay - a.net * a.perDay);
    // a lot Jita cannot fill whole is worth that much less
    const raw = sum(hubs, x => x.net * x.perDay * o.share) * short, weight = o.weight == null ? 1 : o.weight;
    return { type: c.type, bid, atAsk: c.atAsk, cost, score: raw * weight, raw, weight, hubs, lot: { units, isk: units * bid } };
  }

  // ------------------------------------------------------------------ risk
  /**
   * What a hub is counted as paying for an item you have no sale of on record: the lowest of the ask there now, the last
   * day's average, the week's average and `spike` times the month's average, so a thin spike in the book does not count.
   * history: ESI's daily rows for the hub's region, oldest first. The pace is the lower of the week's and the month's units a day.
   * -> { price, ask, perDay, thin } (price null when there is neither an ask nor a traded day to go on)
   */
  function hubRead(ask, history, now, spike) {
    const rows = history || [], day = r => Date.parse(r.date);
    const w = rows.filter(r => day(r) >= now - 8 * 864e5), m = rows.filter(r => day(r) >= now - 31 * 864e5);   // the newest day is published a day late
    const vw = sum(w, r => r.volume), vm = sum(m, r => r.volume);
    const marks = [];
    if (ask != null) marks.push(ask);
    if (vw) { marks.push(w[w.length - 1].average); marks.push(sum(w, r => r.average * r.volume) / vw); }
    if (vm) marks.push((spike || 1.15) * sum(m, r => r.average * r.volume) / vm);
    const price = marks.length ? Math.min.apply(null, marks) : null;
    return { price, ask: ask == null ? null : ask, perDay: Math.min(vw / 7, vm / 30), thin: ask != null && price != null && price < ask * 0.95 };
  }

  /**
   * The most an ask can be counted at: `spike` times the month's traded average in the hub's region. A listing over it is a thin
   * spike, not a price. Null with fewer than `minDays` traded days in the month, which is too little to call anything a spike.
   */
  function spikeCap(history, now, spike, minDays) {
    const m = (history || []).filter(r => Date.parse(r.date) >= now - 31 * 864e5 && r.volume > 0), vm = sum(m, r => r.volume);
    return m.length >= (minDays || 10) && vm ? (spike || 1.15) * sum(m, r => r.average * r.volume) / vm : null;
  }

  /**
   * Where a line goes, and the most a bid on it may be.
   * hubs: [{ name, station, price (what the hub is counted as paying), perDay (the pace it is weighted by) }]
   * o: { cost (unit cost, or the bid), buyFee (the broker's share on a bid still to fill, else 0), netMult, floor, margin, top }
   * The line goes to the hubs that net `floor` or better at this cost: the best pace of profit first, `top` of them at most, shared out by pace.
   * `max` is the highest bid that still leaves `margin` across those hubs. With no hub at the floor the state is 'under', and the figures
   * are for the best hubs there are; with no hub read at all it is 'unknown'.
   * -> { state, hubs: [{ name, station, price, perDay, net, margin, share }], blend, net, margin, max }
   */
  function destPlan(hubs, o) {
    const fee = o.buyFee || 0, cost = o.cost * (1 + fee), top = o.top || 3;
    const all = (hubs || []).filter(x => x.price != null && x.price > 0).map(x => {
      const net = x.price * o.netMult - cost;
      return Object.assign({}, x, { net, margin: cost > 0 ? net / cost : null, pace: Math.max(x.perDay || 0, 0) });
    });
    if (!all.length) return { state: 'unknown', hubs: [], blend: null, net: null, margin: null, max: null };
    const ok = all.filter(x => x.net >= o.floor * cost);
    const pick = (ok.length ? ok : all).sort((a, b) => b.pace * Math.max(b.net, 0) - a.pace * Math.max(a.net, 0) || b.price - a.price).slice(0, top);
    let total = sum(pick, x => x.pace);
    if (!(total > 0)) { pick.forEach(x => { x.pace = 1; }); total = pick.length; }       // no pace known: equal shares
    pick.forEach(x => { x.share = x.pace / total; });
    const blend = sum(pick, x => x.share * x.price * o.netMult), net = blend - cost;
    return { state: ok.length ? 'ok' : 'under', hubs: pick, blend, net, margin: cost > 0 ? net / cost : null, max: tickFloor(blend / ((1 + o.margin) * (1 + fee))) };
  }

  /** `qty` whole units shared out by the hubs' shares, adding up exactly: the odd units go to the largest remainders. -> [{ name, units }] */
  function splitUnits(qty, hubs) {
    const rows = (hubs || []).map(x => { const exact = qty * (x.share || 0); return { name: x.name, units: Math.floor(exact), rest: exact - Math.floor(exact) }; });
    let left = qty - sum(rows, r => r.units);
    for (const r of rows.slice().sort((a, b) => b.rest - a.rest)) { if (left <= 0) break; r.units++; left--; }
    return rows.filter(r => r.units > 0).map(r => ({ name: r.name, units: r.units }));
  }

  /**
   * The plan a load travels with: where the units of one item in the hold are to be listed, fixed when they come aboard
   * and counted down as they are listed, so the hold empties over the stops and a price moving mid-trip does not re-route it.
   * entry: what was kept last time, or null: { q (units aboard when last seen), left: { hub: units still to list there },
   *        t: { hub: units that left the hold there with no order yet to explain them }, ids: [your sell orders for the item, as last seen] }
   * o: { qty (units aboard now), orders: [{ id, hub, units }] (your sell orders for the item now, at their full size), here (the hub you are
   *      docked in, or null), split(units) -> [{ name, units }] (where units coming aboard now would go; '' is "nowhere yet") }
   * A new order comes off its hub's share (then off the largest), unless it explains units already taken off. Units that come aboard are
   * shared out by `split`. Units that leave the hold with no new order come off the hub you are docked in first, then off the largest share.
   * EVE reports orders before cargo, and either can arrive first: nothing is taken off twice, and the same input twice changes nothing.
   * -> { entry, left: [{ name, units }] (largest first), waiting (units aboard that the order list already shows as listed) }
   */
  function loadStep(entry, o) {
    const fresh = !entry, e = { q: fresh ? 0 : entry.q || 0, left: Object.assign({}, fresh ? null : entry.left), t: Object.assign({}, fresh ? null : entry.t), ids: fresh ? null : (entry.ids || []).slice() };
    const orders = o.orders || [], known = new Set(e.ids || orders.map(x => x.id));      // orders already up when the item comes aboard are not this load
    const biggest = (m, first) => (first != null && m[first] > 0 ? first : Object.keys(m).filter(k => m[k] > 0).sort((x, y) => m[y] - m[x] || (x < y ? -1 : 1))[0]);
    const take = (m, first, n) => { while (n > 0) { const k = biggest(m, first); if (k == null) break; const d = Math.min(n, m[k]); m[k] -= d; n -= d; } return n; };
    for (const x of orders) if (!known.has(x.id)) take(e.left, x.hub, take(e.t, x.hub, x.units));
    e.ids = orders.map(x => x.id);
    const added = Math.max(0, o.qty - e.q);
    if (added) {
      let placed = 0;
      for (const p of (o.split ? o.split(added) : []) || []) if (p.units > 0) { e.left[p.name || ''] = (e.left[p.name || ''] || 0) + p.units; placed += p.units; }
      if (placed < added) e.left[''] = (e.left[''] || 0) + added - placed;
    }
    e.q = o.qty;
    let over = sum(Object.keys(e.left), k => e.left[k]) - o.qty;
    while (over > 0) { const k = biggest(e.left, o.here); const d = Math.min(over, e.left[k]); e.left[k] -= d; e.t[k] = (e.t[k] || 0) + d; over -= d; }
    for (const m of [e.left, e.t]) for (const k of Object.keys(m)) if (!(m[k] > 0)) delete m[k];
    const left = Object.keys(e.left).map(k => ({ name: k, units: e.left[k] })).sort((x, y) => y.units - x.units || (x.name < y.name ? -1 : 1));
    return { entry: e, left, waiting: Math.max(0, o.qty - sum(left, x => x.units)) };
  }

  /**
   * What to load for the hubs chosen, fitted to the room in the hold and to the trip cap.
   * lines: [{ units, m3 (each), cost (each, or null), gain (ISK each expected at the hub after fees and cost, or null) }]
   * room: m3 free in the hold. cap: ISK at cost still free under the trip cap (Infinity for none).
   * The most ISK per m3 goes aboard first; lines with no price to go by come after those, smallest first. A line that does not
   * fit whole is loaded in part, and the lines after it are still tried, so a small item can take the room a large one could not.
   * -> { rows: [{ i (index into lines), take, m3, value, sum (m3 aboard after this line), short: null | 'room' | 'cap' }] in loading order,
   *      m3, value, units, left (lines not loaded whole) }
   */
  function loadFit(lines, room, cap) {
    const per = x => (x.gain == null ? null : x.m3 > 0 ? x.gain / x.m3 : Infinity);
    const order = lines.map((x, i) => i).sort((a, b) => {
      const pa = per(lines[a]), pb = per(lines[b]);
      if ((pa == null) !== (pb == null)) return pa == null ? 1 : -1;
      if (pa != null && pa !== pb) return pb - pa;
      return lines[a].units * lines[a].m3 - lines[b].units * lines[b].m3 || a - b;
    });
    let space = Math.max(0, room || 0), isk = cap == null ? Infinity : Math.max(0, cap), m3 = 0, value = 0, units = 0, left = 0;
    const rows = order.map(i => {
      const x = lines[i];
      const byRoom = x.m3 > 0 ? Math.floor(space / x.m3 + 1e-9) : x.units, byCap = x.cost > 0 && isFinite(isk) ? Math.floor(isk / x.cost + 1e-9) : x.units;
      const take = Math.max(0, Math.min(x.units, byRoom, byCap));
      const short = take >= x.units ? null : byRoom <= byCap ? 'room' : 'cap';
      space -= take * x.m3; isk -= take * (x.cost || 0); m3 += take * x.m3; value += take * (x.cost || 0); units += take; if (short) left++;
      return { i, take, m3: take * x.m3, value: take * (x.cost || 0), sum: m3, short };
    });
    return { rows, m3, value, units, left };
  }

  /**
   * A bid's call once the line's plan is known (a destPlan worked out at the bid's own price).
   *   'pull': no hub nets the floor at this bid any more, so cancel it or lower it.
   *   'over': the price that would retake the lead is past the max bid, so leave it where it is.
   */
  function guardBid(plan, pos, g) {
    if (!g || g.state === 'unknown' || !pos || pos.status === 'gone') return plan;
    const pct = x => Math.round(Math.abs(x) * 100) + '%';
    if (g.state === 'under') return { action: 'hold', kind: 'pull', target: null, fee: 0,
      reason: (g.margin < 0 ? 'Loses ' : 'Nets ') + pct(g.margin) + ' at today\u2019s hub prices; the most this line supports is ' + isk(g.max) + '. Cancel it or lower it.' };
    if (plan.target != null && g.max != null && plan.target > g.max) return { action: 'hold', kind: 'over', target: null, fee: 0,
      reason: 'The top bid, ' + isk(pos.wall) + ', is over your max bid of ' + isk(g.max) + '. Leave it.' };
    return plan;
  }

  /**
   * Whether a line has earned a re-bid.
   * x: { buys: [{ at, qty }] in the wallet's window, oldest first; sold: units sold in it; margin: net over cost on those sales (null when not known); stock: units still held }
   * r: { lotDays, half, days, floor }. The first lot is everything bought within `lotDays` of the first purchase.
   *   'proven': `half` of the first lot has sold, at the floor or better where the cost is known. A line that sells with no purchase in the window was bought before it, and is proven.
   *   'new': nothing sold yet.  'probation': selling, not there yet.
   *   'drop': `days` after the first purchase and still not proven, or stock on hand with no purchase and no sale on record at all.
   * -> { state, sold, lot, first, thin }
   */
  function lineStatus(x, r, now) {
    const buys = x.buys || [], first = buys.length ? buys[0].at : null, sold = x.sold || 0;
    const lot = first == null ? 0 : sum(buys.filter(b => b.at <= first + r.lotDays * 864e5), b => b.qty);
    const thin = lot > 0 && x.margin != null && x.margin < r.floor;
    let state;
    if (!lot) state = sold > 0 ? 'proven' : x.stock > 0 ? 'drop' : 'new';
    else if (sold >= lot * r.half && !thin) state = 'proven';
    else if (now - first > r.days * 864e5) state = 'drop';
    else state = sold > 0 ? 'probation' : 'new';
    return { state, sold, lot, first, thin };
  }

  /**
   * Price changes made since the orders were last looked at. log: { order_id: { i: issue time, p: price } } from that look.
   * EVE restamps an order's issue time when its price is changed, so a later issue time at another price is one change
   * (several between two looks count as one). Each costs `modify` of the order's value, plus the broker's share of any escrow added to a bid.
   * -> { log (for the next look), changes: [{ id, at, fee }] }
   */
  function orderChanges(log, orders, fees) {
    const next = {}, changes = [];
    for (const o of orders) {
      const i = Date.parse(o.issued), was = log && log[o.order_id];
      if (was && i > was.i && o.price !== was.p) changes.push({ id: o.order_id, at: i, type: o.type_id, loc: o.location_id, buy: !!o.is_buy_order,
        fee: o.price * o.volume_remain * fees.modify + (o.is_buy_order ? Math.max(0, o.price - was.p) * o.volume_remain * fees.broker : 0) });
      next[o.order_id] = { i, p: o.price };
    }
    return { log: next, changes };
  }

  /**
   * Committed ISK by where it is headed, against the limits.
   * lines: [{ isk (a bid's escrow, or stock at cost), proven, hubs: [{ name, share }] or null when no destination is known }]
   * limits: { reserve (wallet to keep back), unproven (most committed to lines that have not proven themselves), hub (most headed for any one hub) }
   * -> { total, unproven, hubs: [{ name, isk, over }] largest first, loose, gate: { open, why: [sentences] } }
   * The gate says whether new lines may be opened; re-bids on proven lines are not its business.
   */
  function exposure(lines, wallet, limits) {
    const by = new Map();
    let total = 0, unproven = 0, loose = 0;
    for (const l of lines || []) {
      if (!(l.isk > 0)) continue;
      total += l.isk;
      if (!l.proven) unproven += l.isk;
      if (!l.hubs || !l.hubs.length) { loose += l.isk; continue; }
      for (const x of l.hubs) by.set(x.name, (by.get(x.name) || 0) + l.isk * (x.share == null ? 1 / l.hubs.length : x.share));
    }
    const hubs = Array.from(by, e => ({ name: e[0], isk: e[1], over: limits.hub != null && e[1] > limits.hub })).sort((a, b) => b.isk - a.isk);
    const why = [];
    if (wallet != null && limits.reserve != null && wallet < limits.reserve) why.push('The wallet, ' + short(wallet) + ', is under your reserve of ' + short(limits.reserve) + '.');
    if (limits.unproven != null && unproven > limits.unproven) why.push('Unproven lines hold ' + short(unproven) + ', over your limit of ' + short(limits.unproven) + '.');
    for (const x of hubs) if (x.over) why.push(x.name + ' has ' + short(x.isk) + ' headed for it, over your limit of ' + short(limits.hub) + '.');
    return { total, unproven, hubs, loose, gate: { open: !why.length, why } };
  }

  /** Last `days` complete days of a region's price history: volume-weighted price and units a day. */
  function weekOf(history, days) {
    const rows = history.slice(-days);
    const vol = sum(rows, r => r.volume);
    if (!rows.length || !vol) return null;
    return { price: sum(rows, r => r.average * r.volume) / vol, perDay: vol / rows.length, days: rows.length };
  }
  /** How a far-off front compares with the week: 'dump' (well below it), 'repricing' (the week is already there) or 'unclear'. */
  function moveRead(front, weekPrice) {
    if (front <= weekPrice * 0.93) return 'dump';
    if (front >= weekPrice * 0.97) return 'repricing';
    return 'unclear';
  }

  // ------------------------------------------------------------ weekly closes
  const pad2 = n => (n < 10 ? '0' : '') + n;
  /** The name a week is kept under: its Monday, device time, as YYYY-MM-DD. */
  function weekKey(ms) { const d = new Date(startOfWeek(ms)); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function weekStart(key) { const p = String(key).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]).getTime(); }
  /** Monday 00:00 of the week after the one starting at `ms` (a calendar step, so clock changes do not shift it). */
  function weekAfter(ms) { const d = new Date(ms); d.setDate(d.getDate() + 7); return d.getTime(); }

  /** A typed ISK figure: "356.4M", "1.25b", "450k", "12,345,678", "-3.2 M". A number, or null for anything else. */
  function parseIsk(text) {
    const m = String(text == null ? '' : text).replace(/[,\s]|isk/gi, '').match(/^([+-]?)(\d+(?:\.\d+)?|\.\d+)([kmb]?)$/i);
    if (!m) return null;
    const v = Number(m[2]) * { '': 1, k: 1e3, m: 1e6, b: 1e9 }[m[3].toLowerCase()];
    return m[1] === '-' ? -v : v;
  }

  /**
   * Rows copied from the tracker workbook's Order Tracking sheet (select the rows in Excel, copy, paste): tab-separated,
   * columns Date Listed, Item, Venue, Qty Listed, Unit Cost, ... Realized Net. A header row, if it was copied too, says
   * where each column is; without one the sheet's usual order is assumed. Lines without an item and a unit cost are skipped.
   * Returns { rows: [{ name, venue, date, qty, cost }], skipped, net } where net is the Realized Net column added up (null if absent).
   */
  function parseCosts(text) {
    const lines = String(text == null ? '' : text).split(/\r?\n/).map(l => l.split('\t').map(c => c.trim()));
    let col = { date: 0, item: 1, venue: 2, qty: 3, cost: 4, net: 12 };
    const head = lines.findIndex(c => c.some(x => /^item$/i.test(x)) && c.some(x => /unit cost/i.test(x)));
    if (head >= 0) {
      const at = re => lines[head].findIndex(x => re.test(x));
      col = { date: at(/date listed/i), item: at(/^item$/i), venue: at(/^venue$/i), qty: at(/qty listed/i), cost: at(/unit cost/i), net: at(/realized net/i) };
    }
    const cell = (c, i) => (i >= 0 && i < c.length ? c[i] : '');
    const day = t => { const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t); const ms = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : Date.parse(t); return isFinite(ms) ? ms : null; };
    const rows = [];
    let skipped = 0, net = null;
    lines.forEach((c, i) => {
      if (i === head || !c.some(Boolean)) return;
      const name = cell(c, col.item).replace(/\s*\([^)]*\)\s*$/, ''), cost = parseIsk(cell(c, col.cost));     // "Coolant (PI)" is the item Coolant
      if (!name || cost == null || cost < 0 || /^\d[\d,.]*$/.test(name)) { skipped++; return; }
      const n = parseIsk(cell(c, col.net));
      if (n != null) net = (net || 0) + n;
      rows.push({ name, venue: cell(c, col.venue), date: day(cell(c, col.date)), qty: parseIsk(cell(c, col.qty)), cost });
    });
    return { rows, skipped, net };
  }
  /**
   * A cost for units the wallet cannot account for, from the tracker's rows ({ t: type, l: station or null, d: date listed or null, c: unit cost }).
   * Of the rows for that item, one at the same station is preferred; among those, the latest listed on or before the sale, else the earliest.
   * Returns a function (type, station, when) -> unit cost or null.
   */
  function costLookup(rows) {
    const by = new Map();
    for (const r of rows || []) { if (!by.has(r.t)) by.set(r.t, []); by.get(r.t).push(r); }
    for (const list of by.values()) list.sort((a, b) => (a.d || 0) - (b.d || 0));
    return (type, station, when) => {
      const all = by.get(type);
      if (!all) return null;
      const here = all.filter(r => r.l != null && r.l === station), pool = here.length ? here : all;
      let pick = pool[0];
      for (const r of pool) if ((r.d || 0) <= when) pick = r;
      return pick.c;
    };
  }

  /**
   * What the wallet journal says about the time from `from` up to `to`: where the wallet moved, by kind, and the balance at each end.
   * The kinds add up to `change` exactly. `covered` is false when the journal does not reach back past `from`,
   * in which case the sums cover only part of the span and `open` is unknown.
   */
  function journalSpan(journal, from, to) {
    const rows = journal.map(e => ({ at: Date.parse(e.date), id: e.id, kind: e.ref_type, amount: e.amount || 0, balance: e.balance }))
      .sort((a, b) => a.at - b.at || a.id - b.id);
    const out = { sales: 0, purchases: 0, broker: 0, tax: 0, planets: 0, transfers: 0, other: 0, change: 0, open: null, close: null, covered: false, entries: 0 };
    for (const e of rows) {
      if (e.at < from) { out.open = e.balance; out.covered = true; }
      if (e.at >= to) break;
      out.close = e.balance;
      if (e.at < from) continue;
      out.entries++; out.change += e.amount;
      const k = e.kind === 'market_transaction' ? (e.amount >= 0 ? 'sales' : 'purchases') : e.kind === 'market_escrow' ? 'purchases'
        : e.kind === 'brokers_fee' ? 'broker' : e.kind === 'transaction_tax' ? 'tax' : /^planetary_/.test(e.kind) ? 'planets'
        : /^(player_donation|player_trading|corporation_account_withdrawal)$/.test(e.kind) ? 'transfers' : 'other';
      out[k] += e.amount;
    }
    return out;
  }

  /**
   * The tie-out. `weeks` are closed weeks, oldest first, each { net, tracker } (tracker null when not entered).
   * A week ties when the two figures differ by no more than `within` of the tracker's. `run` counts tied weeks in a row, ending at the newest.
   */
  function tieOut(weeks, within) {
    const rows = weeks.map(w => {
      if (w.tracker == null || w.net == null) return { diff: null, tied: null };
      const diff = w.net - w.tracker;
      // a week set to the tracker's figure was adopted, not checked: it neither ties nor counts against the run
      if (w.locked) return { diff, tied: null, locked: true };
      return { diff, tied: Math.abs(diff) <= Math.abs(w.tracker) * within };
    });
    let run = 0;
    for (let i = rows.length - 1; i >= 0 && (rows[i].tied || rows[i].locked); i--) if (rows[i].tied) run++;
    return { rows, run };
  }

  // ------------------------------------------------------------ expedition
  /**
   * A fit pasted in EFT format (the game's "Copy to clipboard" and every fitting tool write it):
   *   [Ship, Fit name] then one module per line, "Module, Loaded charge", and "Item x12" for drones and cargo.
   * Returns { ship, name, items: [{ name, qty }], loaded: [charge names] } without the hull itself, or null when there is no fit header.
   * Loaded charges are named but not counted: the format does not say how many.
   */
  function parseEft(text) {
    const lines = String(text == null ? '' : text).split(/\r?\n/).map(l => l.trim());
    const header = /^\[([^,\]]+),\s*(.*)\]$/;
    const head = lines.findIndex(l => header.test(l));
    if (head < 0) return null;
    const m = header.exec(lines[head]), items = new Map(), loaded = new Set();
    const add = (name, qty) => { if (name) items.set(name, (items.get(name) || 0) + qty); };
    for (const raw of lines.slice(head + 1)) {
      if (header.test(raw)) break;                              // a second fit pasted under the first
      if (!raw || raw[0] === '[') continue;                     // blank lines and [Empty High slot]
      const line = raw.replace(/\s*\/offline$/i, '');
      const many = /^(.*?)\s+x(\d+)$/.exec(line);
      if (many) { add(many[1].trim(), Number(many[2])); continue; }
      const at = line.indexOf(',');
      add((at < 0 ? line : line.slice(0, at)).trim(), 1);
      if (at >= 0 && line.slice(at + 1).trim()) loaded.add(line.slice(at + 1).trim());
    }
    return { ship: m[1].trim(), name: m[2].trim(), items: Array.from(items, e => ({ name: e[0], qty: e[1] })), loaded: Array.from(loaded) };
  }

  /** How much of the standard kit a pilot has: owned or staged at camp both count. kit rows are { pilot_id, hull_key, status }. */
  function kitReady(pilotId, kit, hullKeys) {
    const have = hullKeys.filter(k => { const r = kit.find(x => x.pilot_id === pilotId && x.hull_key === k); return !!r && (r.status === 'owned' || r.status === 'staged'); }).length;
    return { have, total: hullKeys.length, pct: hullKeys.length ? Math.round(have / hullKeys.length * 100) : 0 };
  }

  /**
   * Everything still to buy, by where it is bought.
   *   pilots: [pilot ids]; kit: [{ pilot_id, hull_key, status }] (no row counts as missing);
   *   hulls: [{ key, label, ship (item name, or null when not chosen yet), buy_at, items: [{ name, qty }] }] (the standard fit, shared by every pilot);
   *   stock: [{ item (item name or ''), label, base, per: 'pilot' | 'camp', doubled, have, buy_at }].
   * A missing hull puts the hull and its whole fit on the list once per pilot missing it. Stock is base x pilots (when per pilot),
   * twice over when doubled, less what is already held. Anything without an item name cannot go into a multibuy and is returned in `unnamed`.
   */
  function shoppingList(x) {
    const places = {}, unnamed = [];
    const put = (place, name, qty) => { if (qty > 0) { const p = places[place] || (places[place] = new Map()); p.set(name, (p.get(name) || 0) + qty); } };
    for (const hl of x.hulls) {
      const missing = x.pilots.filter(id => { const r = x.kit.find(k => k.pilot_id === id && k.hull_key === hl.key); return !r || r.status === 'missing'; }).length;
      if (!missing) continue;
      if (!hl.ship) { unnamed.push({ label: hl.label, qty: missing }); continue; }
      put(hl.buy_at, hl.ship, missing);
      for (const it of hl.items || []) put(hl.buy_at, it.name, it.qty * missing);
    }
    for (const st of x.stock || []) {
      const short = stockNeed(st, x.pilots.length) - (st.have || 0);
      if (short <= 0) continue;
      if (!st.item) unnamed.push({ label: st.label || 'Camp stock', qty: short }); else put(st.buy_at, st.item, short);
    }
    const out = {};
    for (const p of Object.keys(places)) out[p] = Array.from(places[p], e => ({ name: e[0], qty: e[1] })).sort((a, b) => a.name.localeCompare(b.name));
    return { places: out, unnamed };
  }
  /** Camp stock wanted: the base figure, for each pilot when it is per pilot, and twice over when the camp rule (spares x2) applies. */
  function stockNeed(st, pilots) { return (Number(st.base) || 0) * (st.per === 'pilot' ? pilots : 1) * (st.doubled ? 2 : 1); }
  /** The text EVE's Multibuy window takes: one "Item name x quantity" per line. */
  function multibuy(lines) { return lines.map(l => l.name + ' x' + l.qty).join('\n'); }
  /** Days to train `sp` skill points from nothing at `perHour` (EVE trains round the clock). */
  function trainDays(sp, perHour) { return sp / perHour / 24; }

  // ------------------------------------------------ expedition: camp and timers
  /** A countdown or a stopwatch reading: 4:05, 1:02:09. */
  function clock(ms) {
    const t = Math.max(0, Math.floor(Math.abs(ms) / 1000)), hh = Math.floor(t / 3600), mm = Math.floor(t % 3600 / 60), ss = t % 60;
    return (hh ? hh + ':' + String(mm).padStart(2, '0') : mm) + ':' + String(ss).padStart(2, '0');
  }
  /**
   * The picket rotation brought up to `now`. A picket timer holds { rotation_order, turn, since, ends_at, interval_min }:
   * `turn` is who is on (an index into the order) since `since`, until `ends_at`. The rotation is taken as made when its
   * time comes, whether or not anyone touched the phone, so the alerts keep coming in order.
   * -> { timer, stints: [{ pilot_id, from, to }] } with one stint for every turn that ended.
   */
  function picketRoll(t, now) {
    const out = Object.assign({}, t), stints = [], n = (t.rotation_order || []).length, step = (t.interval_min || 0) * 60000;
    if (!n || !(step > 0)) return { timer: out, stints };
    for (let guard = 0; now >= out.ends_at && guard < 1000; guard++) {
      stints.push({ pilot_id: out.rotation_order[out.turn % n], from: out.since, to: out.ends_at });
      out.turn = (out.turn + 1) % n; out.since = out.ends_at; out.ends_at += step;
    }
    return { timer: out, stints };
  }
  /**
   * "Not yet": the rotation that was due at `boundary` is put off to `until`. If that rotation has already been taken as
   * made, it is taken back: the last stint comes out of the log and the earlier pilot is still on.
   * -> { timer, stints, ok } (ok false when the boundary is not this timer's last or next rotation).
   */
  function picketSnooze(t, stints, boundary, until) {
    const out = Object.assign({}, t), log = (stints || []).slice(), n = (t.rotation_order || []).length;
    if (n && boundary === t.ends_at) { out.ends_at = until; return { timer: out, stints: log, ok: true }; }
    const last = log[log.length - 1];
    if (n && boundary === t.since && last && last.to === boundary) {
      log.pop(); out.turn = (t.turn - 1 + n) % n; out.since = last.from; out.ends_at = until; out.acked = null;
      return { timer: out, stints: log, ok: true };
    }
    return { timer: out, stints: log, ok: false };
  }
  /**
   * What the phone should ring for, soonest first. The Android app keeps this list and rings each alert at its time even
   * when the app is shut, so the texts carry no clock times (a snooze on the phone moves the times, not the words).
   * x: { timers, name(pilot_id), rules: C.expedition.timers } -> [{ id, group, at, title, text, late, actions }]
   * `late` is a second ring if nobody confirms; `group` ties the alerts that a snooze moves together.
   * An alert whose time has passed is listed only while its second ring is still to come.
   */
  function campAlerts(x, now) {
    const r = x.rules, out = [], name = x.name, MIN = 60000;
    for (const t of x.timers || []) {
      if (t.kind === 'picket') {
        const order = t.rotation_order || [], n = order.length, step = (t.interval_min || 0) * MIN;
        if (n < 2 || !(step > 0)) continue;
        const one = (b, off, on) => ({
          id: t.id + ':' + b, group: t.id, at: b, title: 'Picket: ' + name(on) + ' takes over',
          text: name(off) + ' comes off picket, ' + name(on) + ' goes on.',
          late: { at: b + r.late_min * MIN, title: 'Picket change not confirmed', text: name(on) + ' should have relieved ' + name(off) + ' ' + r.late_min + ' minutes ago.' },
          actions: ['done', 'snooze'] });
        // the rotation just made, while its second ring is still to come
        if (t.since > t.started_at && t.acked !== t.since && t.since + r.late_min * MIN > now) out.push(one(t.since, order[(t.turn - 1 + n) % n], order[t.turn % n]));
        for (let k = 0; k < r.ahead; k++) {
          const b = t.ends_at + k * step;
          if (b - now > r.horizon_hours * 3600000) break;
          if (b > now) out.push(one(b, order[(t.turn + k) % n], order[(t.turn + k + 1) % n]));
        }
      } else if (t.kind === 'gas') {
        if (t.ends_at > now && !t.acked) out.push({ id: t.id, group: t.id, at: t.ends_at, title: 'Sleepers imminent: ' + t.label,
          text: r.gas_min + ' minutes since first entry. Sleepers arrive at about 15 to 20 minutes.', late: null, actions: ['done'] });
      } else if (t.kind === 'eol') {
        for (const m of r.eol_warn_min) {
          const at = t.ends_at - m * MIN;
          if (at > now) out.push({ id: t.id + ':' + m, group: t.id, at, title: 'Hole to ' + t.label + ': ' + m + ' minutes left at most',
            text: 'It was seen at end of life nearly ' + (r.eol_hours * 60 - m >= 120 ? Math.floor((r.eol_hours * 60 - m) / 60) + ' hours' : (r.eol_hours * 60 - m) + ' minutes') + ' ago and can close at any time.', late: null, actions: ['done'] });
        }
      }
    }
    return out.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  }
  /**
   * One camp night as Markdown for the notes vault.
   * x: { camp, night: { n, started_at, ended_at }, windows, holes, name(pilot_id), mode(key), type(key), time(ts), day(ts) }
   */
  function nightMarkdown(x) {
    const c = x.camp, n = x.night, wins = (x.windows || []).slice().sort((a, b) => a.start - b.start), cell = v => String(v).replace(/\|/g, '/');
    const out = ['# Camp — Night ' + n.n, ''];
    out.push((c.system_name || 'System not named') + (c.system_class ? ' (' + c.system_class + (c.statics ? ', statics: ' + c.statics : '') + ')' : '') + '. ' + (c.stage_type === 'home' ? 'Staged from J142117.' : 'Nomad camp.'));
    out.push('Night ' + n.n + ': ' + x.day(n.started_at) + ' ' + x.time(n.started_at) + (n.ended_at ? ' to ' + x.time(n.ended_at) : ', still running') + '.', '');
    out.push('## Windows', '');
    if (!wins.length) out.push('No windows were run.');
    else {
      const total = wins.reduce((a, w) => a + ((w.end || w.start) - w.start), 0);
      out.push('| Window | Start | End | Length | Adam flew | Pilots | Picket |', '|---|---|---|---|---|---|---|');
      for (const w of wins) {
        out.push('| ' + [x.type(w.type), x.time(w.start), w.end ? x.time(w.end) : 'running', w.end ? span(w.end - w.start) : '', x.mode(w.adam_mode), w.pilot_ids.map(x.name).join(', '),
          (w.pickets || []).map(p => x.name(p.pilot_id) + ' ' + x.time(p.from) + ' to ' + x.time(p.to)).join('; ') || 'none'].map(cell).join(' | ') + ' |');
      }
      out.push('', wins.length + (wins.length === 1 ? ' window, ' : ' windows, ') + span(total) + ' in all.');
    }
    out.push('', '## Notes', '');
    const noted = wins.filter(w => w.note);
    if (noted.length) noted.forEach(w => out.push('- ' + x.type(w.type) + ', ' + x.time(w.start) + ': ' + w.note)); else out.push('No notes.');
    out.push('', '## Bank', '', 'Not recorded yet: the bank manifest is the next phase of this module.');
    out.push('', '## Holes as last recorded', '');
    if ((x.holes || []).length) for (const hl of x.holes) {
      out.push('- ' + (hl.destination || 'Unnamed hole') + ': ' + hl.state + (hl.eol_at ? ', end of life seen ' + x.time(hl.eol_at) : '') + ', ' + (hl.picketed ? 'picketed' : 'not picketed') + ', ' + (hl.bookmarked ? 'bookmarked both sides' : 'not bookmarked both sides'));
    } else out.push('No holes on the board.');
    return out.join('\n') + '\n';
  }

  // ---------------------------------------------------- sync between devices
  /** JSON with every object's keys in order, so two equal documents give equal text. */
  function stable(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  /**
   * Joins two copies of the shared state (this device's and the one in the sync file). The order of the two does not matter
   * and joining twice changes nothing, so every device ends with the same result.
   *   pins, copied: entry by entry the newer wins; one removed by hand stays as { gone: true, at } so the removal travels;
   *                 entries older than keep.pins / keep.copied (ms) are dropped.
   *   seen ("Mark as seen"): the newer wins, and one set by hand beats the first-visit default.
   *   costs (the tracker's cost rows): the newer import wins.
   *   weeks: a finished week's figures from whichever device fixed them first, unless one worked them out on a newer import of costs; exact journal figures from either;
   *          "as last seen" from the later look; the tracker's figure and the carried-in figure by the newer entry.
   */
  function syncMerge(a, b, now, keep) {
    a = a || {}; b = b || {};
    const newer = (x, y) => (!x ? y || null : !y ? x : (x.at || 0) > (y.at || 0) ? x : (y.at || 0) > (x.at || 0) ? y : stable(x) >= stable(y) ? x : y);
    const marks = (x, y, ttl) => {
      const out = {};
      for (const k of new Set(Object.keys(x || {}).concat(Object.keys(y || {})))) {
        const e = newer((x || {})[k], (y || {})[k]);
        if (e && now - (e.at || 0) <= ttl) out[k] = e;
      }
      return out;
    };
    const seen = (x, y) => (!x || !y ? x || y || null : !!x.auto !== !!y.auto ? (x.auto ? y : x) : newer(x, y));
    const week = (x, y) => {
      x = x || {}; y = y || {};
      const out = {};
      const bx = x.basis || 0, by = y.basis || 0;                 // which import of the tracker's costs the figures were worked out with
      const rx = x.rules || 1, ry = y.rules || 1;                 // and which version of the rules
      const f = x.frozenAt && y.frozenAt ? (rx !== ry ? (rx > ry ? x : y) : bx !== by ? (bx > by ? x : y) : x.frozenAt < y.frozenAt ? x : y.frozenAt < x.frozenAt ? y : stable(x) >= stable(y) ? x : y) : x.frozenAt ? x : y.frozenAt ? y : null;
      if (f) for (const k of ['gross', 'units', 'net', 'uncovered', 'borrowed', 'basis', 'rules', 'gaps', 'frozenAt']) if (f[k] != null) out[k] = f[k];
      const exact = w => [w.fees, w.change, w.close];
      const j = x.close != null && y.close != null ? (stable(exact(x)) >= stable(exact(y)) ? x : y) : x.close != null ? x : y.close != null ? y : null;
      if (j) { out.fees = j.fees; out.change = j.change; out.close = j.close; if (j.broker != null) out.broker = j.broker; }
      const look = w => ({ at: w.seenAt || 0, escrow: w.escrow, wallet: w.wallet });
      const sn = newer(look(x), look(y));
      if (sn && sn.at) { out.escrow = sn.escrow; out.wallet = sn.wallet; out.seenAt = sn.at; }
      const t = newer(x.tracker, y.tracker);
      if (t) out.tracker = t;
      const lk = newer(x.lock, y.lock);
      if (lk) out.lock = lk;
      // price changes counted this week: each device counts what it saw, so the fuller count stands
      const ux = x.bumps || null, uy = y.bumps || null, bp = !ux ? uy : !uy ? ux : ux.n !== uy.n ? (ux.n > uy.n ? ux : uy) : stable(ux) >= stable(uy) ? ux : uy;
      if (bp) out.bumps = bp;
      // the same count by line goes with it (version 29 on)
      const lines = bp === ux ? x.lines : bp === uy ? y.lines : null;
      if (lines) out.lines = lines;
      return out;
    };
    const wa = a.weeks || {}, wb = b.weeks || {}, w = {};
    for (const k of new Set(Object.keys(wa.w || {}).concat(Object.keys(wb.w || {})))) w[k] = week((wa.w || {})[k], (wb.w || {})[k]);
    return {
      v: 1,
      pins: marks(a.pins, b.pins, keep.pins), copied: marks(a.copied, b.copied, keep.copied),
      seen: seen(a.seen, b.seen),
      costs: newer(a.costs, b.costs),
      risk: newer(a.risk, b.risk),
      weeks: { carried: newer(wa.carried, wb.carried), w },
    };
  }

  /**
   * The order to visit a few stops in for the fewest jumps, ending wherever that leaves you.
   * dist(a, b) gives the jumps between two stops, with 'start' for where you are now; null means no route, which rules that order out.
   * `before` lists pairs [x, y]: x has to be visited before y (pick up in one place, drop in another).
   * Every order is tried, so this is for a handful of stops. Ties keep the order the stops were given in.
   * Returns { order, legs, total } or null when no order works.
   */
  function tripPlan(stops, dist, before) {
    let best = null;
    const rules = (before || []).filter(p => stops.indexOf(p[0]) >= 0 && stops.indexOf(p[1]) >= 0);
    const walk = (order, rest, legs, total) => {
      if (best && total >= best.total) return;
      if (!rest.length) { best = { order, legs, total }; return; }
      for (const st of rest) {
        if (rules.some(p => p[1] === st && order.indexOf(p[0]) < 0)) continue;
        const d = dist(order.length ? order[order.length - 1] : 'start', st);
        if (d == null) continue;
        walk(order.concat([st]), rest.filter(x => x !== st), legs.concat([d]), total + d);
      }
    };
    walk([], stops.slice(0, 8), [], 0);
    return best;
  }

  /**
   * What a "copied" mark on an order means now. The mark { price, at } is made when its price button is pressed.
   *   landed:  the order shows at the copied price, so the change went in
   *   waiting: the page's data on the order is not yet newer than the copy, allowing `grace` ms to type it in game
   *   missed:  the data is newer than that and the order still shows another price
   * `moved` is true when the price to type now is no longer the one that was copied.
   */
  function copyState(mark, o) {
    if (!mark) return null;
    const state = o.live === mark.price ? 'landed' : o.dataAt >= mark.at + o.grace ? 'missed' : 'waiting';
    return { state, price: mark.price, at: mark.at, moved: state !== 'landed' && o.target != null && o.target !== mark.price };
  }

  /** Rows copied from the in-game probe scanner (Ctrl+A, Ctrl+C): one signature or anomaly per line, tab separated. */
  function parseSigs(text) {
    const out = [];
    for (const line of String(text).split(/\r?\n/)) {
      const c = line.split('\t').map(x => x.trim());
      if (c.length < 3 || !/^[A-Z]{3}-\d{3}$/.test(c[0])) continue;
      out.push({ id: c[0], scan: c[1] || '', group: c[2] || '', name: c[3] || '', signal: c[4] || '', dist: c[5] || '' });
    }
    return out;
  }

  // --------------------------------------------------------------- planets
  /** Units an extractor yields in cycle k (0-based) of its program. EVE's own decay-and-wobble curve. */
  function programOutput(base, cycleMs, k) {
    const barWidth = cycleMs / 900000;
    const t = (k + 0.5) * barWidth;
    const decay = base / (1 + t * 0.012);
    const phase = Math.pow(base, 0.7);
    const wobble = Math.max(0, (Math.cos(phase + t / 12) + Math.cos(phase / 2 + t / 5) + Math.cos(t / 2)) / 3);
    return Math.floor(barWidth * decay * (1 + 0.8 * wobble));
  }

  /**
   * Roll a colony forward from the moment EVE last recorded it. ESI only reports a colony as it was
   * when last opened in game, so what is on the planet now has to be worked out.
   * col: { at, pins: [{ id, kind: 'ecu'|'basic'|'advanced'|'store', cap, contents: [[type, units]], lastStart,
   *        ex: { prod, base, cycle, start, end } }], routes: [[fromPin, toPin, type, units]] }
   * times: ascending ms (>= col.at).  vol(type): m3 per unit.
   * Returns, for each time, Map(storePinId -> Map(type -> units)).
   * Handles extractor -> factory -> factory -> storage chains (P0 to P1 to P2); anything else passes through untouched.
   */
  function piRun(col, times, vol) {
    const STEP = 900000;
    const pins = new Map();
    for (const p of col.pins) pins.set(p.id, { id: p.id, kind: p.kind, cap: p.cap || 0, buf: new Map(p.contents || []), ex: p.ex || null, lastStart: p.lastStart || 0, busy: 0, need: new Map(), out: null, k: 0 });
    const from = new Map();
    for (const r of col.routes) {
      const src = pins.get(r[0]), dst = pins.get(r[1]);
      if (!src || !dst) continue;
      if (!from.has(src.id)) from.set(src.id, []);
      from.get(src.id).push({ to: dst.id, type: r[2], qty: r[3] });
      if (dst.kind === 'basic') dst.need.set(r[2], 3000);
      if (dst.kind === 'advanced') dst.need.set(r[2], 40);
      if (src.kind === 'basic') src.out = { type: r[2], qty: 20, cycle: 1800000 };
      if (src.kind === 'advanced') src.out = { type: r[2], qty: 5, cycle: 3600000 };
    }
    for (const list of from.values()) list.sort((a, b) => (pins.get(a.to).kind === 'store') - (pins.get(b.to).kind === 'store')); // factories are served before storage
    for (const p of pins.values()) {
      if (p.ex) p.k = Math.max(0, Math.floor((col.at - p.ex.start) / p.ex.cycle));
      if (p.out && p.lastStart + p.out.cycle > col.at) p.busy = p.lastStart + p.out.cycle;
    }
    const used = p => { let v = 0; for (const e of p.buf) v += e[1] * vol(e[0]); return v; };
    const room = (p, type) => (p.kind === 'store' ? Math.max(0, Math.floor((p.cap - used(p)) / vol(type) + 1e-6))
      : p.need.has(type) ? Math.max(0, p.need.get(type) - (p.buf.get(type) || 0)) : 0);
    const move = (src, r, have, fromBuf) => {
      const dst = pins.get(r.to);
      const n = Math.min(r.qty, have, room(dst, r.type));
      if (n <= 0) return 0;
      dst.buf.set(r.type, (dst.buf.get(r.type) || 0) + n);
      if (fromBuf) src.buf.set(r.type, src.buf.get(r.type) - n);
      return n;
    };
    const emit = (src, type, units) => { for (const r of from.get(src.id) || []) if (r.type === type && units > 0) units -= move(src, r, units, false); };
    const topUp = () => {
      for (const p of pins.values()) {
        if (p.kind !== 'store') continue;
        for (const r of from.get(p.id) || []) if (pins.get(r.to).kind !== 'store') move(p, r, p.buf.get(r.type) || 0, true);
      }
    };
    const snap = () => { const m = new Map(); for (const p of pins.values()) if (p.kind === 'store') m.set(p.id, new Map(p.buf)); return m; };
    const out = [];
    const last = times[times.length - 1];
    for (let t = col.at, i = 0; ; t += STEP) {
      while (i < times.length && times[i] <= t) { out.push(snap()); i++; }
      if (i >= times.length || t > last) break;
      const next = t + STEP;
      for (const p of pins.values()) {
        if (!p.ex) continue;
        for (let fire = p.ex.start + (p.k + 1) * p.ex.cycle; fire <= next && fire <= p.ex.end; fire += p.ex.cycle) { emit(p, p.ex.prod, programOutput(p.ex.base, p.ex.cycle, p.k)); p.k++; }
      }
      for (const p of pins.values()) if (p.out && p.busy && p.busy <= next) { p.busy = 0; emit(p, p.out.type, p.out.qty); }
      topUp();
      for (const p of pins.values()) {
        if (!p.out || p.busy || !p.need.size) continue;
        let ready = true;
        for (const e of p.need) if ((p.buf.get(e[0]) || 0) < e[1]) ready = false;
        if (!ready) continue;
        for (const e of p.need) p.buf.set(e[0], p.buf.get(e[0]) - e[1]);
        p.busy = next + p.out.cycle;
      }
      topUp();
    }
    while (out.length < times.length) out.push(snap());
    return out;
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
  /** ESI hands back ship names that contain symbols as u'\\u263cName'; turn that into the name as typed in game. */
  function shipName(raw) {
    const m = /^u'(.*)'$/.exec(String(raw || ''));
    if (!m) return String(raw || '');
    return m[1].replace(/\\u([0-9a-fA-F]{4})/g, (x, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\x([0-9a-fA-F]{2})/g, (x, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/\\(['\\])/g, '$1');
  }
  /** Units a day traded in a region over the last `days` calendar days, from ESI's daily history (days with no trade are simply absent). */
  function tradedPerDay(history, now, days) {
    const from = now - (days + 1) * 864e5;      // the newest day is published a day late
    return sum((history || []).filter(r => Date.parse(r.date) >= from), r => r.volume) / days;
  }

  /**
   * Where a pile of one item sells. At each hub: the lowest ask to list against, the top bid, what the
   * standing bids that can be filled from that station would pay for `qty` units (best price first),
   * and how long the pile would take to sell there at opts.share of the hub's daily trade.
   * hubs: [{ name, station, system }]; bookOf(hub) -> that region's orders for the item (buys and sells);
   * opts.perDay(hub) -> units a day traded there, or null when not known.
   * opts.ref is a sane price for the item (the Jita ask, else EVE's average): an ask more than opts.far
   * times it is a lone high listing. The place to list is the highest ask that is neither a lone listing
   * nor slower than opts.days; failing that, the quickest hub.
   */
  function sellAt(hubs, bookOf, qty, opts) {
    opts = opts || {};
    const far = opts.far || 1.5, share = opts.share || 0.15, limit = opts.days || 14;
    const rows = hubs.map(hb => {
      const orders = bookOf(hb) || [];
      let ask = null;
      for (const o of orders) if (!o.is_buy_order && o.location_id === hb.station && (ask == null || o.price < ask)) ask = o.price;
      const bids = orders.filter(o => o.is_buy_order && o.volume_remain > 0 &&
        (o.location_id === hb.station || o.range === 'region' || (hb.system != null && o.system_id === hb.system && o.range !== 'station')))
        .sort((a, b) => b.price - a.price);
      let left = qty, now = 0;
      for (const b of bids) {
        if (left <= 0) break;
        if ((b.min_volume || 1) > left) continue;
        const take = Math.min(left, b.volume_remain);
        now += take * b.price; left -= take;
      }
      const perDay = opts.perDay ? opts.perDay(hb) : null;
      const days = perDay == null ? null : perDay > 0 ? qty / (perDay * share) : Infinity;
      return { name: hb.name, station: hb.station, ask, bid: bids.length ? bids[0].price : null, now, filled: qty - left, thin: false, perDay, days, slow: days != null && days > limit };
    });
    const ref = opts.ref || null;
    for (const r of rows) r.thin = !!(ref && r.ask != null && r.station !== opts.refStation && r.ask > ref * far);
    for (const r of rows) r.fair = r.thin ? ref : r.ask;      // what a listing there is counted at
    const pick = (pool, f) => (pool.length ? pool.reduce((a, b) => (f(b) > f(a) ? b : a)) : null);
    const asked = rows.filter(r => r.ask != null), sane = asked.filter(r => !r.thin), quick = sane.filter(r => !r.slow);
    const list = quick.length ? pick(quick, r => r.ask) : sane.length ? pick(sane, r => -r.days) : pick(asked, r => r.ask);
    const now = pick(rows.filter(r => r.filled > 0), r => r.now);
    return { hubs: rows, list: list ? list.name : null, now: now ? now.name : null };
  }

  /** Security status as the game shows it: one decimal, and anything above 0 never shows as 0.0. */
  function sec(s) {
    let r = Math.round(s * 10) / 10;
    if (s > 0 && r <= 0) r = 0.1;
    return Math.max(0, Math.min(1, r));
  }

  return {
    tickBelow, tickAbove, tickFloor, tickCeil, isLegal, levels,
    sellPosition, buyPosition, planSells, planBid,
    hubRead, spikeCap, destPlan, splitUnits, loadStep, loadFit, guardBid, lineStatus, orderChanges, exposure,
    payback, batch, capSplit, deadBid, trueNet, screenEat, screenCandidates, screenScore,
    ledger, unitCost, summarize, uncosted, daily, velocity, startOfDay, startOfWeek,
    orderChecks, weekOf, moveRead, copyState, tripPlan, weekKey, weekStart, weekAfter, parseIsk, parseCosts, costLookup, journalSpan, tieOut, stable, syncMerge, parseEft, kitReady, shoppingList, stockNeed, multibuy, trainDays, clock, picketRoll, picketSnooze, campAlerts, nightMarkdown, programOutput, piRun, parseSigs, sellAt, tradedPerDay,
    isk, short, span, sec, shipName,
  };
});
