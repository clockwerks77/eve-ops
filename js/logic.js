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
        else out.set(g.order.order_id, Object.assign({ action, kind, reason }, money(target, g)));
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
    } else {
      if (o.front != null && o.price <= o.front * 0.7) out.push(pct(1 - o.price / o.front) + ' under the next seller. Check for a typo.');
      else if (o.front != null && o.price >= o.front * 1.5) out.push(pct(o.price / o.front - 1) + ' above the front. Check for a typo.');
      if (o.cost != null && o.cost > 0 && o.price * o.netMult < o.cost) out.push('Sells below your cost.');
    }
    return out;
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
    tickBelow, tickAbove, isLegal, levels,
    sellPosition, buyPosition, planSells, planBid,
    ledger, unitCost, summarize, daily, velocity, startOfDay, startOfWeek,
    orderChecks, weekOf, moveRead, copyState, programOutput, piRun, parseSigs, sellAt, tradedPerDay,
    isk, short, span, sec, shipName,
  };
});
