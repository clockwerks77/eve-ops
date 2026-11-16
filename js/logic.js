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
      const f = x.frozenAt && y.frozenAt ? (bx !== by ? (bx > by ? x : y) : x.frozenAt < y.frozenAt ? x : y.frozenAt < x.frozenAt ? y : stable(x) >= stable(y) ? x : y) : x.frozenAt ? x : y.frozenAt ? y : null;
      if (f) for (const k of ['gross', 'units', 'net', 'uncovered', 'borrowed', 'basis', 'frozenAt']) if (f[k] != null) out[k] = f[k];
      const exact = w => [w.fees, w.change, w.close];
      const j = x.close != null && y.close != null ? (stable(exact(x)) >= stable(exact(y)) ? x : y) : x.close != null ? x : y.close != null ? y : null;
      if (j) { out.fees = j.fees; out.change = j.change; out.close = j.close; }
      const look = w => ({ at: w.seenAt || 0, escrow: w.escrow, wallet: w.wallet });
      const sn = newer(look(x), look(y));
      if (sn && sn.at) { out.escrow = sn.escrow; out.wallet = sn.wallet; out.seenAt = sn.at; }
      const t = newer(x.tracker, y.tracker);
      if (t) out.tracker = t;
      const lk = newer(x.lock, y.lock);
      if (lk) out.lock = lk;
      return out;
    };
    const wa = a.weeks || {}, wb = b.weeks || {}, w = {};
    for (const k of new Set(Object.keys(wa.w || {}).concat(Object.keys(wb.w || {})))) w[k] = week((wa.w || {})[k], (wb.w || {})[k]);
    return {
      v: 1,
      pins: marks(a.pins, b.pins, keep.pins), copied: marks(a.copied, b.copied, keep.copied),
      seen: seen(a.seen, b.seen),
      costs: newer(a.costs, b.costs),
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
    tickBelow, tickAbove, isLegal, levels,
    sellPosition, buyPosition, planSells, planBid,
    ledger, unitCost, summarize, daily, velocity, startOfDay, startOfWeek,
    orderChecks, weekOf, moveRead, copyState, tripPlan, weekKey, weekStart, weekAfter, parseIsk, parseCosts, costLookup, journalSpan, tieOut, stable, syncMerge, parseEft, kitReady, shoppingList, stockNeed, multibuy, trainDays, clock, picketRoll, picketSnooze, campAlerts, nightMarkdown, programOutput, piRun, parseSigs, sellAt, tradedPerDay,
    isk, short, span, sec, shipName,
  };
});
