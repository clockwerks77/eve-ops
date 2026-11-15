/* Eve Ops — loads the character's live data, works out what to do at each hub, draws the board. */
(function () {
  'use strict';
  const C = window.EVEOPS_CONFIG, L = window.Logic, E = window.Esi;
  const root = document.getElementById('app');
  const demo = !!(window.Demo && window.Demo.on);
  const NET = 1 - C.fees.broker - C.fees.salesTax;
  const M = 6e4, H = 36e5, D = 864e5;
  const VERSION = (document.querySelector('meta[name="eveops-version"]') || {}).content || '';
  const SKILL = { trade: 3443, retail: 3444, wholesale: 16596, tycoon: 18580, infomorph: 33399 };
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  const num = n => Number(n).toLocaleString('en-US');
  const plural = (n, one, many) => num(n) + ' ' + (n === 1 ? one : many || one + 's');

  // ------------------------------------------------------------------ dom
  function h(tag, props) {
    const el = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style') for (const p of Object.keys(v)) el.style.setProperty(p, v[p]);
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (let i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, kid) {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) kid.forEach(k => add(el, k));
    else el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }

  // ----------------------------------------- lookups kept between visits
  const STATIC = 'eveops.static.v1';
  const K = Object.assign({ names: {}, systems: {}, stations: {}, planets: {}, routes: {} }, demo ? null : E.store.get(STATIC));
  let saveTimer = 0;
  function saveStatic() {
    if (demo) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => E.store.set(STATIC, K), 800);
  }
  const nameOf = id => K.names[id] || 'Item ' + id;

  async function resolveNames(ids) {
    const need = Array.from(new Set(ids)).filter(id => id && id < 1e12 && !(id in K.names));
    for (let i = 0; i < need.length; i += 500) {
      const chunk = need.slice(i, i + 500);
      try {
        (await E.post('/universe/names/', chunk)).forEach(x => { K.names[x.id] = x.name; });
      } catch (err) { // one unknown id rejects the whole batch, so retry singly
        await Promise.all(chunk.map(id => E.post('/universe/names/', [id]).then(r => r.forEach(x => { K.names[x.id] = x.name; }), () => {})));
      }
    }
    if (need.length) saveStatic();
  }
  async function station(id) {
    if (K.stations[id]) return K.stations[id];
    let s;
    if (id >= 1e12) {
      const r = await E.get('/universe/structures/' + id + '/', { auth: true });
      s = { name: r.data.name, system: r.data.solar_system_id };
    } else {
      const r = await E.get('/universe/stations/' + id + '/');
      s = { name: r.data.name, system: r.data.system_id };
    }
    K.stations[id] = s; K.names[id] = s.name; saveStatic();
    return s;
  }
  async function system(id) {
    if (K.systems[id]) return K.systems[id];
    const r = await E.get('/universe/systems/' + id + '/');
    K.systems[id] = { name: r.data.name, sec: r.data.security_status }; saveStatic();
    return K.systems[id];
  }
  async function planetName(id) {
    if (K.planets[id]) return K.planets[id];
    const r = await E.get('/universe/planets/' + id + '/');
    K.planets[id] = r.data.name; saveStatic();
    return K.planets[id];
  }
  async function route(from, to, flag) {
    if (from === to) return [from];
    const key = from + ':' + to + ':' + flag, hit = K.routes[key];
    if (hit && Date.now() - hit.at < 7 * D) return hit.ids;
    const r = await E.get('/route/' + from + '/' + to + '/', { query: { flag } });
    K.routes[key] = { ids: r.data, at: Date.now() }; saveStatic();
    return r.data;
  }

  // ---------------------------------------------------------------- state
  const S = {
    who: null, loc: null, ship: null, wallet: null,
    orders: [], ordersAt: 0, tx: [], assets: [], books: new Map(), jumps: new Map(),
    queue: [], skills: null, clones: null, planets: [], kills: new Map(), routes: {},
    feeds: {}, ready: false, running: false, notice: null,
    pins: (!demo && E.store.get('eveops.pins')) || {}, wantWake: false, wake: null,
    prices: new Map(), tab: null, follow: true,
  };
  const me = () => '/characters/' + S.who.id;
  function feed(name, entry) { S.feeds[name] = { at: entry.modified, next: entry.expires, err: null }; }
  async function load(name, fn) {
    try { await fn(); }
    catch (err) { S.feeds[name] = Object.assign({ at: 0, next: 0 }, S.feeds[name], { err: err.message || String(err) }); }
  }

  async function loadLocation() {
    const pair = await Promise.all([E.get(me() + '/location/', { auth: true }), E.get(me() + '/ship/', { auth: true })]);
    const a = S.loc || {}, b = pair[0].data;
    const moved = !S.loc || a.station_id !== b.station_id || a.structure_id !== b.structure_id || a.solar_system_id !== b.solar_system_id;
    S.loc = b; S.ship = pair[1].data;
    S.feeds.Location = { at: pair[0].fetched, next: 0, err: null }; // when it was last checked, not when it last changed
    if (moved) {
      S.follow = true; // show the hub they have just arrived at
      await Promise.all([
        system(b.solar_system_id).catch(() => {}),
        b.station_id || b.structure_id ? station(b.station_id || b.structure_id).catch(() => {}) : null,
      ]);
    }
    return moved;
  }
  async function loadWallet() { const r = await E.get(me() + '/wallet/', { auth: true }); S.wallet = r.data; feed('Wallet', r); }
  async function loadOrders() { const r = await E.get(me() + '/orders/', { auth: true }); S.orders = r.data; S.ordersAt = r.modified; feed('Your orders', r); }
  async function loadTx() {
    const first = await E.get(me() + '/wallet/transactions/', { auth: true });
    let all = first.data.slice(), page = first.data;
    for (let i = 0; i < 4 && page.length >= 1000; i++) { // reach back about six weeks
      const oldest = page.reduce((a, b) => (b.transaction_id < a.transaction_id ? b : a));
      if (Date.now() - Date.parse(oldest.date) > 45 * D) break;
      const more = await E.get(me() + '/wallet/transactions/', { auth: true, query: { from_id: oldest.transaction_id } });
      page = more.data.filter(t => t.transaction_id < oldest.transaction_id);
      if (!page.length) break;
      all = all.concat(page);
    }
    S.tx = all; feed('Sales and purchases', first);
  }
  async function loadAssets() { const r = await E.get(me() + '/assets/', { auth: true }); S.assets = r.data; feed('Hangars', r); }
  async function loadSkills() {
    const r = await Promise.all([E.get(me() + '/skillqueue/', { auth: true }), E.get(me() + '/skills/', { auth: true }), E.get(me() + '/clones/', { auth: true })]);
    S.queue = r[0].data; S.skills = r[1].data; S.clones = r[2].data; feed('Skills and clones', r[0]);
    await Promise.all((S.clones.jump_clones || []).map(j => station(j.location_id).then(st => system(st.system)).catch(() => {})));
  }
  async function loadPlanets() {
    const r = await E.get(me() + '/planets/', { auth: true });
    S.planets = await Promise.all(r.data.map(async p => {
      const pair = await Promise.all([E.get(me() + '/planets/' + p.planet_id + '/', { auth: true }), planetName(p.planet_id).catch(() => 'Planet ' + p.planet_id)]);
      const ex = pair[0].data.pins.filter(x => x.extractor_details).map(x => (x.expiry_time ? Date.parse(x.expiry_time) : 0));
      return { id: p.planet_id, name: pair[1], type: p.planet_type, extractors: ex.length, expiry: ex.length ? Math.min.apply(null, ex) : null };
    }));
    feed('Planets', r);
  }
  async function loadKills() {
    const r = await E.get('/universe/system_kills/');
    S.kills = new Map(r.data.map(k => [k.system_id, k])); feed('Kill feed', r);
  }
  async function loadPrices() {
    const r = await E.get('/markets/prices/');
    S.prices = new Map(r.data.map(x => [x.type_id, x.average_price || x.adjusted_price || 0])); feed('Item prices', r);
  }
  async function loadBooks() {
    const want = new Map();
    for (const o of S.orders) {
      want.set(o.region_id + ':' + o.type_id, [o.region_id, o.type_id]);
      if (!o.is_buy_order) want.set(C.jita.region + ':' + o.type_id, [C.jita.region, o.type_id]);
    }
    let oldest = Infinity, soonest = Infinity, failed = 0;
    await Promise.all(Array.from(want, async ([key, rt]) => {
      try {
        const r = await E.get('/markets/' + rt[0] + '/orders/', { query: { order_type: 'all', type_id: rt[1] } });
        S.books.set(key, { orders: r.data, modified: r.modified });
        oldest = Math.min(oldest, r.modified); soonest = Math.min(soonest, r.expires);
      } catch (err) { failed++; }
    }));
    for (const k of Array.from(S.books.keys())) if (!want.has(k)) S.books.delete(k);
    S.feeds['Market books'] = {
      at: isFinite(oldest) ? oldest : (S.feeds['Market books'] || {}).at || 0,
      next: isFinite(soonest) ? soonest : Date.now() + M,
      err: failed ? failed + ' of ' + want.size + ' books did not load.' : null,
    };
  }
  /** Rival bids placed elsewhere only count if their range reaches my station: measure the ones that matter. */
  async function loadReach() {
    const jobs = new Map();
    for (const o of S.orders) {
      if (!o.is_buy_order) continue;
      const b = S.books.get(o.region_id + ':' + o.type_id);
      if (!b) continue;
      const st = await station(o.location_id);
      for (const r of b.orders) {
        if (!r.is_buy_order || r.location_id === o.location_id || r.price < o.price) continue;
        if (!/^\d+$/.test(String(r.range)) || r.system_id === st.system) continue;
        const key = r.system_id + '>' + st.system;
        if (S.jumps.has(key) || jobs.has(key)) continue;
        jobs.set(key, route(r.system_id, st.system, 'shortest').then(ids => S.jumps.set(key, ids.length - 1), () => S.jumps.set(key, Infinity)));
      }
    }
    await Promise.all(jobs.values());
  }
  function reaches(rival, order, stationSystem) {
    if (rival.location_id === order.location_id || rival.range === 'region') return true;
    if (rival.range === 'station') return false;
    if (rival.system_id === stationSystem) return true;
    if (rival.range === 'solarsystem') return false;
    const j = S.jumps.get(rival.system_id + '>' + stationSystem);
    return j != null && j <= Number(rival.range);
  }
  function hubIds() {
    const ids = new Set(S.orders.map(o => o.location_id));
    ids.add(C.jita.station);
    return Array.from(ids);
  }
  async function loadRoutes() {
    if (!S.loc) return;
    const from = S.loc.solar_system_id, out = {};
    await system(from).catch(() => {});
    await Promise.all(hubIds().map(async id => {
      try {
        const st = await station(id);
        const pair = await Promise.all([route(from, st.system, 'shortest'), route(from, st.system, 'secure').catch(() => null)]);
        await Promise.all(Array.from(new Set(pair[0].concat(pair[1] || []))).map(system));
        out[id] = { short: pair[0], safe: pair[1] };
      } catch (err) { out[id] = { err: err.message || String(err) }; }
    }));
    S.routes = out;
  }

  async function run() {
    if (S.running) return;
    S.running = true; paint();
    try {
      await Promise.all([
        load('Location', loadLocation), load('Wallet', loadWallet), load('Your orders', loadOrders),
        load('Sales and purchases', loadTx), load('Hangars', loadAssets), load('Skills and clones', loadSkills), load('Kill feed', loadKills),
      ]);
      if (!demo && !E.who()) return;
      const ids = [];
      S.orders.forEach(o => ids.push(o.type_id));
      S.tx.forEach(t => ids.push(t.type_id));
      S.queue.forEach(q => ids.push(q.skill_id));
      if (S.ship) ids.push(S.ship.ship_type_id);
      await resolveNames(ids).catch(() => {});
      S.ready = true; paint();
      await Promise.all([load('Market books', loadBooks), load('Planets', loadPlanets), load('Routes', loadRoutes), load('Item prices', loadPrices)]);
      await loadReach().catch(() => {});
    } finally {
      S.running = false;
      paint();
    }
  }

  // ---------------------------------------------------------------- model
  function build() {
    const now = Date.now();
    const zero = new Set(C.zeroCostTypes);
    const led = L.ledger(S.tx, { netMult: NET, exclude: new Set(C.excludeTypes), zeroCost: zero });
    const vel = L.velocity(led.sales, now);
    const myIds = new Set(S.orders.map(o => o.order_id));
    const windowDays = led.from ? (now - led.from) / D : 0;

    const listedByType = new Map();
    for (const o of S.orders) if (!o.is_buy_order) listedByType.set(o.type_id, (listedByType.get(o.type_id) || 0) + o.volume_remain);
    const costOf = type => (zero.has(type) ? { cost: 0, units: Infinity } : L.unitCost(led.lots, type, listedByType.get(type) || 0));
    const jitaSell = type => {
      const b = S.books.get(C.jita.region + ':' + type);
      if (!b) return null;
      const p = b.orders.filter(o => !o.is_buy_order && o.location_id === C.jita.station && !myIds.has(o.order_id)).map(o => o.price);
      return p.length ? Math.min.apply(null, p) : null;
    };

    // pins that have served their purpose
    let pinsChanged = false;
    for (const id of Object.keys(S.pins)) {
      if (!myIds.has(Number(id)) || now - S.pins[id].at > 36 * H) { delete S.pins[id]; pinsChanged = true; }
    }
    const pinOf = (id, livePrice) => {
      const p = S.pins[id];
      if (!p) return null;
      if (livePrice === p.price && now - p.at > 6 * H) { delete S.pins[id]; pinsChanged = true; return null; }
      return { price: p.price, at: p.at, done: livePrice === p.price };
    };

    const stops = new Map();
    const stop = id => { if (!stops.has(id)) stops.set(id, { id, sells: [], bids: [], hangar: [] }); return stops.get(id); };

    const groups = new Map();
    for (const o of S.orders) {
      if (o.is_buy_order) continue;
      const b = S.books.get(o.region_id + ':' + o.type_id);
      const k = o.location_id + ':' + o.type_id;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push({ order: o, pos: b ? L.sellPosition(o, b.orders, myIds, b.modified >= S.ordersAt) : null });
    }
    const slow = [];
    let listed = 0, listedCost = 0, uncosted = 0;
    for (const g of groups.values()) {
      const o0 = g[0].order;
      const c = costOf(o0.type_id);
      const cost = c ? c.cost : null;
      const plan = g.every(x => x.pos)
        ? L.planSells(g, { cost, jitaSell: jitaSell(o0.type_id), isJita: o0.location_id === C.jita.station, netMult: NET, modify: C.fees.modify, sniperUnits: C.sniperUnits, bigMove: C.bigMove })
        : new Map();
      const v = vel.get(o0.type_id + ':' + o0.location_id) || { d1: 0, d7: 0, last: 0 };
      let left = 0;
      for (const x of g) {
        const price = x.pos ? x.pos.price : x.order.price, remain = x.pos ? x.pos.remain : x.order.volume_remain;
        const gone = x.pos && x.pos.status === 'gone';
        if (!gone) {
          left += remain; listed += price * remain;
          if (cost != null) listedCost += cost * remain; else uncosted += remain;
        }
        stop(x.order.location_id).sells.push({
          id: x.order.order_id, type: x.order.type_id, name: nameOf(x.order.type_id), twin: g.length > 1,
          price, remain, total: x.order.volume_total, pos: x.pos, cost, vel: v,
          expires: Date.parse(x.order.issued) + x.order.duration * D,
          plan: plan.get(x.order.order_id) || { action: 'wait', reason: 'Waiting for the market book.', target: null },
          pin: pinOf(x.order.order_id, price),
        });
      }
      const lastBuy = led.lastBuy.get(o0.type_id) || 0;
      const quiet = windowDays >= C.staleDays && now - v.last > C.staleDays * D && now - lastBuy > C.staleDays * D;
      const clear = v.d7 > 0 ? left / (v.d7 / 7) : null;
      const settled = now - lastBuy > 7 * D;
      if (left > 0 && (quiet || (settled && clear != null && clear > 30))) slow.push({ type: o0.type_id, name: nameOf(o0.type_id), stop: o0.location_id, left, last: v.last, clear, quiet });
    }
    slow.sort((a, b) => (b.quiet - a.quiet) || ((b.clear || 1e9) - (a.clear || 1e9)));

    let escrow = 0, bidCount = 0;
    for (const o of S.orders) {
      if (!o.is_buy_order) continue;
      bidCount++; escrow += o.escrow || 0;
      const b = S.books.get(o.region_id + ':' + o.type_id), st = K.stations[o.location_id];
      const pos = b && st ? L.buyPosition(o, b.orders, myIds, b.modified >= S.ordersAt, r => reaches(r, o, st.system)) : null;
      const price = pos ? pos.price : o.price;
      stop(o.location_id).bids.push({
        id: o.order_id, type: o.type_id, name: nameOf(o.type_id), price, remain: pos ? pos.remain : o.volume_remain,
        total: o.volume_total, pos, escrow: o.escrow || 0, days: o.duration,
        expires: Date.parse(o.issued) + o.duration * D,
        plan: pos ? L.planBid(pos, { broker: C.fees.broker, modify: C.fees.modify, bigMove: C.bigMove }) : { action: 'wait', reason: 'Waiting for the market book.', target: null },
        pin: pinOf(o.order_id, price),
      });
    }
    if (pinsChanged && !demo) E.store.set('eveops.pins', S.pins);

    const traded = new Set(S.orders.map(o => o.type_id));
    S.tx.forEach(t => traded.add(t.type_id));
    const hang = new Map();
    for (const a of S.assets) {
      if (a.location_type !== 'station' || a.location_flag !== 'Hangar' || a.is_singleton) continue;
      if (!traded.has(a.type_id) || C.excludeTypes.indexOf(a.type_id) >= 0) continue;
      if (!stops.has(a.location_id) && a.location_id !== C.jita.station) continue;
      const k = a.location_id + ':' + a.type_id;
      hang.set(k, (hang.get(k) || 0) + a.quantity);
    }
    for (const [k, qty] of hang) {
      const p = k.split(':').map(Number);
      stop(p[0]).hangar.push({ type: p[1], name: nameOf(p[1]), qty });
    }

    const rank = { tick: 0, optional: 1, wait: 2, none: 3, hold: 4 };
    const order = r => (r.pin && !r.pin.done ? -1 : rank[r.plan.action] + (r.plan.action === 'hold' && r.pos && r.pos.status === 'leading' ? 1 : 0));
    const here = S.loc ? S.loc.station_id || S.loc.structure_id || null : null;
    const hop = id => {
      const s = K.systems[id] || { name: 'System ' + id, sec: 1 }, k = S.kills.get(id) || {};
      return { id, name: s.name, sec: L.sec(s.sec), ship: k.ship_kills || 0, pod: k.pod_kills || 0 };
    };
    const list = Array.from(stops.values()).map(s => {
      const st = K.stations[s.id] || { name: nameOf(s.id), system: null };
      const sys = st.system && K.systems[st.system];
      const r = Object.assign({}, S.routes[s.id]);
      const rows = s.sells.concat(s.bids);
      s.sells.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name) || b.remain - a.remain);
      s.bids.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
      s.hangar.sort((a, b) => a.name.localeCompare(b.name));
      const same = r.short && r.safe && r.safe.length <= r.short.length;
      if (same) r.short = r.safe;
      return Object.assign(s, {
        station: st.name, system: st.system, short: sys ? sys.name : String(st.name).split(' ')[0],
        docked: here != null && here === s.id, inSystem: !!(S.loc && st.system && S.loc.solar_system_id === st.system),
        jumps: r.short ? r.short.length - 1 : null,
        shortRoute: r.short ? r.short.map(hop) : null, safeRoute: r.safe && !same ? r.safe.map(hop) : null, routeErr: r.err || null,
        change: rows.filter(x => x.plan.action === 'tick' || (x.pin && !x.pin.done)).length,
        optional: rows.filter(x => x.plan.action === 'optional').length,
        waiting: rows.filter(x => x.pin && !x.pin.done).length,
        pinned: rows.filter(x => x.pin).length,
      });
    });
    list.sort((a, b) => (b.docked - a.docked) || (b.inSystem - a.inSystem) || ((a.jumps == null ? 999 : a.jumps) - (b.jumps == null ? 999 : b.jumps)) || a.short.localeCompare(b.short));

    const lv = id => { const s = S.skills && S.skills.skills.find(x => x.skill_id === id); return s ? s.trained_skill_level : 0; };
    const queue = S.queue.filter(q => q.finish_date && Date.parse(q.finish_date) > now).sort((a, b) => a.queue_position - b.queue_position);
    const lastJump = S.clones && S.clones.last_clone_jump_date ? Date.parse(S.clones.last_clone_jump_date) : null;

    // everything in hangars and ships, at EVE's universe-wide average price
    let held = 0;
    for (const a of S.assets) {
      if (a.is_blueprint_copy) continue;
      held += (S.prices.get(a.type_id) || 0) * a.quantity;
    }
    const wealth = S.wallet == null ? null : S.wallet + escrow + listed + held;

    // which hub tab is showing: follow the character on arrival, otherwise leave the choice alone
    const at = list.find(s => s.docked) || list.find(s => s.inSystem);
    if (S.follow && at) { S.tab = at.id; S.follow = false; }
    if (!list.some(s => s.id === S.tab)) S.tab = list.length ? (at || list[0]).id : null;

    return {
      now, stops: list, slow: slow.slice(0, 8), tab: S.tab,
      wallet: S.wallet, escrow, bidCount, listed, listedCost, uncosted, held, wealth, priced: S.prices.size > 0,
      slots: S.skills ? { used: S.orders.length, max: 5 + 4 * lv(SKILL.trade) + 8 * lv(SKILL.retail) + 16 * lv(SKILL.wholesale) + 32 * lv(SKILL.tycoon) } : null,
      week: L.summarize(led.sales, L.startOfWeek(now), Infinity),
      today: L.summarize(led.sales, L.startOfDay(now), Infinity),
      days: L.daily(led.sales, 14, now), windowDays,
      planets: S.planets.slice().sort((a, b) => (a.expiry == null ? Infinity : a.expiry) - (b.expiry == null ? Infinity : b.expiry)),
      queue: queue.map(q => ({ name: nameOf(q.skill_id), level: q.finished_level, done: Date.parse(q.finish_date) })),
      paused: S.queue.filter(q => !q.finish_date).sort((a, b) => a.queue_position - b.queue_position).map(q => ({ name: nameOf(q.skill_id), level: q.finished_level })),
      clone: S.clones ? { ready: lastJump ? lastJump + (24 - lv(SKILL.infomorph)) * H : 0, at: (S.clones.jump_clones || []).map(j => { const st = K.stations[j.location_id]; const sy = st && K.systems[st.system]; return sy ? sy.name : st ? st.name.split(' ')[0] : null; }).filter(Boolean) } : null,
    };
  }

  // ----------------------------------------------------------------- view
  const roman = ['', 'I', 'II', 'III', 'IV', 'V'];
  const clock = ms => new Date(ms).toLocaleString('en-CA', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const live = (kind, at, text) => h('span', { 'data-live': kind, 'data-at': at }, text || liveText(kind, at));
  function liveText(kind, at) {
    const d = at - Date.now();
    if (kind === 'age') return at ? L.span(d) + ' old' : 'not loaded';
    if (kind === 'ago') return at ? L.span(d) + ' ago' : 'never';
    if (kind === 'next') return d > 0 ? 'next in ' + L.span(d) : 'due now';
    return d > 0 ? 'in ' + L.span(d) : L.span(d) + ' ago'; // 'until'
  }
  function stamp() {
    root.querySelectorAll('[data-live]').forEach(el => { el.textContent = liveText(el.getAttribute('data-live'), Number(el.getAttribute('data-at'))); });
  }
  function icon(type) {
    const img = h('img', { class: 'icon', alt: '', width: 32, height: 32, loading: 'lazy', src: 'https://images.evetech.net/types/' + type + '/icon?size=64' });
    img.addEventListener('error', () => { img.classList.add('is-missing'); });
    return img;
  }
  function copy(btn, price) {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(String(price)).then(() => {
      btn.classList.add('is-copied');
      setTimeout(() => btn.classList.remove('is-copied'), 1400);
    }, () => {});
  }
  function C_(cls, label) { const el = h('div', { class: 'c ' + cls, 'data-label': label }); for (let i = 2; i < arguments.length; i++) add(el, arguments[i]); return el; }

  function callCell(r, kind) {
    if (r.pin && !r.pin.done) {
      const moved = r.plan.action === 'tick' && r.plan.target != null && (kind === 'sell' ? r.plan.target < r.pin.price : r.plan.target > r.pin.price);
      return C_('call', 'Call', h('span', { class: 'chip chip-pin' }, 'Pinned'),
        h('span', { class: 'why' }, moved ? 'The book has moved since: now ' + L.isk(r.plan.target) + '.' : 'Waiting to see it in the book, up to 5 min.'));
    }
    const done = r.pin && r.pin.done;
    const lead = r.pos && r.pos.status === 'leading';
    const big = r.plan.kind === 'big';
    const label = { tick: 'Change', optional: big ? 'Big move' : 'Sniper', wait: 'Loading', none: 'Gone', hold: lead ? (kind === 'sell' ? 'Leading' : 'Top bid') : 'Hold' }[r.plan.action];
    const cls = { tick: 'chip-go', optional: big ? 'chip-big' : 'chip-opt', wait: 'chip-wait', none: 'chip-gone', hold: lead ? 'chip-lead' : 'chip-hold' }[r.plan.action];
    const depthShown = r.pos && r.plan.action === 'tick' && r.plan.kind !== 'mismatch' && (r.pos.status === 'undercut' || r.pos.status === 'behind' || r.pos.status === 'outbid');
    const why = r.plan.action === 'hold' && lead ? null
      : r.plan.action === 'tick' ? (depthShown ? '' : r.plan.reason + ' ') + (r.plan.fee ? 'Changing costs ' + L.short(r.plan.fee) + '.' : '')
      : r.plan.reason;
    const soon = r.expires - Date.now() < 3 * D;
    return C_('call', 'Call', h('span', { class: 'chip ' + cls }, label), done && h('span', { class: 'chip chip-done' }, 'Changed'),
      soon && r.plan.action !== 'none' && h('span', { class: 'chip chip-opt' }, 'Expires ', live('until', r.expires)),
      why && h('span', { class: 'why' }, why));
  }
  function typeCell(r) {
    const price = r.pin && !r.pin.done ? r.pin.price : (r.plan.action === 'tick' || r.plan.action === 'optional') ? r.plan.target : null;
    if (price == null) return C_('type', 'Type this', h('span', { class: 'none' }, r.pin && r.pin.done ? 'Done' : ''));
    return C_('type', 'Type this', h('button', { class: 'price' + (r.plan.action === 'optional' && !r.pin ? ' is-soft' : ''), type: 'button', title: 'Copy ' + price, onclick: e => copy(e.currentTarget, price) }, L.isk(price)));
  }
  function itemCell(r) {
    return C_('item', 'Item', icon(r.type), h('span', { class: 'name' }, r.name, r.twin && h('span', { class: 'twin' }, num(r.total) + '-unit order')));
  }

  function sellRow(r) {
    const p = r.pos;
    const front = !p ? '' : p.front == null ? 'No one else' : L.isk(p.front);
    const depth = !p || p.front == null ? null
      : p.status === 'undercut' ? plural(p.unitsUnder, 'unit') + ' under you'
      : p.status === 'behind' ? plural(p.tiedAhead, 'older unit') + ' at your price'
      : p.status === 'leading' ? (p.front === p.price ? 'Tied, yours is older' : 'You lead by ' + L.isk(p.front - p.price)) : null;
    const at = r.plan.target != null ? r.plan.target : r.price;
    const net = r.cost != null ? at * NET - r.cost : null;
    return h('div', { class: 'row is-' + r.plan.action + (r.pin && !r.pin.done ? ' is-pinned' : '') },
      itemCell(r),
      C_('left', 'Left', h('b', null, num(r.remain)), h('span', { class: 'of' }, ' of ' + num(r.total))),
      C_('yours', 'Your price', L.isk(r.price)),
      C_('front', 'Front of book', h('span', null, front), depth && h('span', { class: 'sub' }, depth)),
      callCell(r, 'sell'),
      typeCell(r),
      C_('net', 'Net each', net == null ? h('span', { class: 'sub' }, 'Cost unknown') : [h('span', { class: net < 0 ? 'neg' : '' }, L.short(net)), r.cost > 0 && h('span', { class: 'sub' }, Math.round(net / r.cost * 100) + '%')]),
      C_('pace', 'Sold', h('span', null, num(r.vel.d1) + ' in 24 h'), h('span', { class: 'sub' }, num(r.vel.d7) + ' in 7 days')));
  }
  function bidRow(r) {
    const p = r.pos;
    const wall = !p ? '' : p.wall == null ? 'No other bids' : L.isk(p.wall);
    const depth = !p || p.wall == null ? null
      : p.over.length ? p.over.map(l => h('span', { class: 'level' }, L.isk(l.price), h('span', { class: 'of' }, ' ×' + num(l.units))))
      : p.status === 'behind' ? plural(p.tiedAhead, 'older unit') + ' at your price'
      : 'You lead by ' + L.isk(p.price - p.wall);
    return h('div', { class: 'row is-' + r.plan.action + (r.pin && !r.pin.done ? ' is-pinned' : '') },
      itemCell(r),
      C_('left', 'Filled', h('b', null, num(r.total - r.remain)), h('span', { class: 'of' }, ' of ' + num(r.total))),
      C_('yours', 'Your bid', L.isk(r.price)),
      C_('front', p && p.over.length ? 'Bids above you' : 'Next bid', p && p.over.length ? depth : [h('span', null, wall), depth && h('span', { class: 'sub' }, depth)]),
      callCell(r, 'bid'),
      typeCell(r),
      C_('net', 'In escrow', L.short(r.escrow)),
      C_('pace', 'Expires', live('until', r.expires)));
  }
  const head = labels => h('div', { class: 'row row-head', 'aria-hidden': 'true' }, labels.map((t, i) => h('div', { class: 'c ' + ['item', 'left', 'yours', 'front', 'call', 'type', 'net', 'pace'][i] }, t)));

  function strip(label, hops) {
    const hot = hops.filter(x => x.ship + x.pod > 0); // in travel order
    return h('div', { class: 'route' },
      h('span', { class: 'route-label' }, label + ', ' + plural(hops.length - 1, 'jump')),
      h('span', { class: 'strip', role: 'img', 'aria-label': hops.map(x => x.name + ' ' + x.sec.toFixed(1)).join(', ') },
        hops.map(x => h('i', { class: 'sys s' + Math.round(x.sec * 10) + (x.ship + x.pod > 0 ? ' is-hot' : ''), title: x.name + ' ' + x.sec.toFixed(1) + (x.ship + x.pod ? ', ' + x.ship + ' ships and ' + x.pod + ' pods lost in the last hour' : '') }))),
      h('span', { class: 'hot' }, hot.length ? hot.slice(0, 8).map(x => x.name + ' ' + x.ship + '/' + x.pod).join(', ') + (hot.length > 8 ? ', and ' + (hot.length - 8) + ' more' : '') : 'No ships or pods lost on this route in the last hour'));
  }

  function stopView(s) {
    const state = s.docked ? 'Docked here' : s.inSystem ? 'In this system' : s.jumps != null ? plural(s.jumps, 'jump') + ' away' : '';
    const pinnable = s.sells.concat(s.bids).filter(r => r.plan.action === 'tick' && r.plan.target != null && !(r.pin && !r.pin.done));
    const summary = [];
    if (s.change) summary.push(s.change + ' to change');
    if (s.optional) summary.push(s.optional + ' your call');
    if (!s.change && !s.optional) summary.push('Nothing to change');
    return h('section', { class: 'stop' + (s.docked ? ' is-here' : ''), id: 'stop-' + s.id, role: 'tabpanel', 'aria-label': s.short },
      h('header', { class: 'stop-head' },
        h('div', { class: 'stop-title' },
          h('h2', null, s.station),
          h('span', { class: 'stop-state' }, state),
          h('span', { class: 'stop-sum' }, summary.join(', '))),
        !s.docked && s.shortRoute && s.shortRoute.length > 1 && h('div', { class: 'routes' },
          strip(s.safeRoute ? 'Shortest' : 'Route', s.shortRoute),
          s.safeRoute && strip('Secure', s.safeRoute)),
        s.routeErr && h('p', { class: 'stop-sub' }, 'No route found: ' + s.routeErr),
        h('div', { class: 'stop-tools' },
          pinnable.length ? h('button', { type: 'button', class: 'btn', onclick: () => pin(pinnable) }, 'Pin ' + plural(pinnable.length, 'price')) : null,
          s.pinned ? h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => unpin(s) }, 'Clear pins') : null)),
      s.sells.length ? h('div', { class: 'rows' }, head(['Sell orders', 'Left', 'Your price', 'Front of book', 'Call', 'Type this', 'Net each', 'Sold']), s.sells.map(sellRow)) : null,
      s.bids.length ? h('div', { class: 'rows' }, head(['Buy orders', 'Filled', 'Your bid', 'Bids above you', 'Call', 'Type this', 'In escrow', 'Expires']), s.bids.map(bidRow)) : null,
      s.hangar.length ? h('p', { class: 'hangar' }, h('span', { class: 'hangar-label' }, s.id === C.jita.station ? 'In the hangar to collect' : 'In the hangar, not listed'),
        s.hangar.map(x => h('span', { class: 'hangar-item' }, x.name + ' ×' + num(x.qty)))) : null);
  }

  function tabsView(m) {
    const pick = id => { S.tab = id; S.follow = false; paint(); };
    return h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Hubs, nearest first' }, m.stops.map(s => {
      const on = s.id === m.tab;
      const where = s.docked ? 'Docked here' : s.inSystem ? 'In this system' : s.jumps != null ? plural(s.jumps, 'jump') : '';
      return h('button', { type: 'button', role: 'tab', class: 'tab' + (on ? ' is-on' : '') + (s.docked ? ' is-here' : ''), 'aria-selected': on ? 'true' : 'false', onclick: () => pick(s.id) },
        h('span', { class: 'tab-name' }, s.short),
        h('span', { class: 'tab-sub' }, where),
        h('span', { class: 'tab-count' + (s.change ? '' : ' is-zero') }, s.change ? s.change + ' to change' : 'Nothing to change'));
    }));
  }

  function pin(rows) {
    const at = Date.now();
    rows.forEach(r => { S.pins[r.id] = { price: r.plan.target, at }; });
    if (!demo) E.store.set('eveops.pins', S.pins);
    paint();
  }
  function unpin(s) {
    s.sells.concat(s.bids).forEach(r => { delete S.pins[r.id]; });
    if (!demo) E.store.set('eveops.pins', S.pins);
    paint();
  }

  const fact = (label, value, note) => h('div', { class: 'fact' }, h('dt', null, label), h('dd', null, value, note && h('span', { class: 'sub' }, note)));

  function weekPanel(m) {
    const top = Math.max.apply(null, m.days.map(d => Math.max(d.net, 0)).concat(1));
    const best = m.days.reduce((a, b) => (b.net > a.net ? b : a));
    return h('section', { class: 'panel' },
      h('h3', null, 'Since Monday'),
      h('dl', { class: 'facts' },
        fact('Net after fees', L.short(m.week.net), 'estimate'),
        fact('Sold', L.short(m.week.gross), plural(m.week.units, 'unit')),
        fact('Today', L.short(m.today.net), L.short(m.today.gross) + ' sold')),
      h('div', { class: 'bars', role: 'list', 'aria-label': 'Net after fees per day, last 14 days' },
        m.days.map((d, i) => {
          const day = new Date(d.day).toLocaleDateString('en-CA', { weekday: 'long', month: 'short', day: 'numeric' });
          return h('span', { class: 'bar' + (i === m.days.length - 1 ? ' is-today' : ''), role: 'listitem', tabindex: 0, 'aria-label': day + ': net ' + L.short(d.net) + ', sold ' + L.short(d.gross) },
            h('span', { class: 'tip' }, h('b', null, day), h('span', null, 'Net ' + L.short(d.net)), h('span', null, 'Sold ' + L.short(d.gross) + ', ' + plural(d.units, 'unit'))),
            h('span', { class: 'col' }, h('i', { style: { height: Math.max(2, Math.round(Math.max(d.net, 0) / top * 100)) + '%' } })),
            h('b', { class: 'day' }, new Date(d.day).toLocaleDateString('en-CA', { weekday: 'narrow' })));
        })),
      h('p', { class: 'note' }, 'Best of the last 14 days: ' + L.short(best.net) + ' on ' + new Date(best.day).toLocaleDateString('en-CA', { weekday: 'long' }) + '.'
        + (m.week.uncovered ? ' ' + plural(m.week.uncovered, 'unit') + ' sold this week had no purchase on record, so they add to "Sold" but not to net.' : '')));
  }
  function booksPanel(m) {
    return h('section', { class: 'panel' },
      h('h3', null, 'Capital'),
      h('dl', { class: 'facts' },
        fact('Wallet', m.wallet == null ? '' : L.isk(Math.round(m.wallet))),
        fact('In buy orders', L.isk(Math.round(m.escrow)), plural(m.bidCount, 'bid')),
        fact('Listed, at your prices', L.isk(Math.round(m.listed))),
        fact('Hangars and ships', m.priced ? L.isk(Math.round(m.held)) : '', m.priced ? 'at EVE average prices' : 'loading prices'),
        h('div', { class: 'fact fact-total' }, h('dt', null, 'Overall wealth'), h('dd', null, m.wealth == null ? '' : L.isk(Math.round(m.wealth))))),
      h('dl', { class: 'facts facts-more' },
        fact('Listed, at cost', L.isk(Math.round(m.listedCost)), m.uncosted ? plural(m.uncosted, 'unit') + ' without a cost' : 'estimate'),
        m.slots && fact('Order slots', m.slots.used + ' of ' + m.slots.max)));
  }
  function piPanel(m) {
    return h('section', { class: 'panel' }, h('h3', null, 'Planetary Interaction Timers'),
      m.planets.length ? h('ul', { class: 'timers' }, m.planets.map(p => h('li', { class: p.expiry != null && p.expiry < m.now + 6 * H ? 'is-soon' : '' },
        h('span', { class: 't-what' }, p.name, h('span', { class: 'sub' }, p.type + (p.extractors ? '' : ', no extractors'))),
        p.expiry == null ? h('span', { class: 't-when' }, '') : p.expiry === 0 ? h('span', { class: 't-when' }, 'Not running')
          : h('span', { class: 't-when' }, p.expiry < m.now ? 'Stopped ' : 'Stops ', live('until', p.expiry), h('span', { class: 'sub' }, clock(p.expiry))))))
        : h('p', { class: 'note' }, S.feeds.Planets ? 'No colonies.' : 'Loading.'));
  }
  function skillPanel(m) {
    const q = m.queue;
    return h('section', { class: 'panel' }, h('h3', null, 'Skill Queue'),
      q.length ? [h('ul', { class: 'timers' }, q.slice(0, 6).map((x, i) => h('li', null,
        h('span', { class: 't-what' }, x.name + ' ' + roman[x.level], h('span', { class: 'sub' }, i === 0 ? 'training now' : 'queued')),
        h('span', { class: 't-when' }, 'Done ', live('until', x.done), h('span', { class: 'sub' }, clock(x.done)))))),
        h('p', { class: 'note' }, (q.length > 6 ? plural(q.length - 6, 'more skill') + ' after these. ' : '') + 'Queue ends ' + new Date(q[q.length - 1].done).toLocaleString('en-CA', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '.')]
        : m.paused.length ? [h('ul', { class: 'timers' }, m.paused.slice(0, 6).map(x => h('li', null,
            h('span', { class: 't-what' }, x.name + ' ' + roman[x.level], h('span', { class: 'sub' }, 'queued')),
            h('span', { class: 't-when' }, 'Paused')))),
          h('p', { class: 'note' }, 'This character is not training. ' + plural(m.paused.length, 'skill') + ' in the queue, paused.')]
        : h('ul', { class: 'timers' }, h('li', { class: S.skills ? 'is-soon' : '' }, h('span', { class: 't-what' }, 'Nothing training'), h('span', { class: 't-when' }, S.skills ? 'Queue is empty' : 'Loading'))));
  }
  function clonePanel(m) {
    const c = m.clone;
    return h('section', { class: 'panel' }, h('h3', null, 'Jump Clone'),
      c ? h('ul', { class: 'timers' }, h('li', null,
        h('span', { class: 't-what' }, 'Next jump', h('span', { class: 'sub' }, c.at.length ? 'clones in ' + c.at.join(', ') : 'no jump clones installed')),
        h('span', { class: 't-when' }, c.ready > m.now ? ['Ready ', live('until', c.ready), h('span', { class: 'sub' }, clock(c.ready))] : 'Ready now')))
        : h('p', { class: 'note' }, 'Loading.'));
  }
  function slowPanel(m) {
    const hub = id => { const s = m.stops.find(x => x.id === id); return s ? s.short : ''; };
    return h('section', { class: 'panel' }, h('h3', null, 'Slow lines'),
      m.slow.length ? h('ul', { class: 'timers' }, m.slow.map(x => h('li', null,
        h('span', { class: 't-what' }, x.name, h('span', { class: 'sub' }, hub(x.stop) + ', ' + num(x.left) + ' left')),
        h('span', { class: 't-when' }, x.last ? ['Last sale ', live('ago', x.last)] : 'No sale on record',
          h('span', { class: 'sub' }, x.clear != null ? Math.round(x.clear) + ' days to clear at this pace' : 'no sales this week')))))
        : h('p', { class: 'note' }, m.windowDays < C.staleDays ? 'Needs ' + C.staleDays + ' days of sales history; EVE has returned ' + Math.floor(m.windowDays) + '.' : 'Every line has sold in the last ' + C.staleDays + ' days and clears within a month.'));
  }
  function dataPanel() {
    const names = ['Market books', 'Your orders', 'Wallet', 'Sales and purchases', 'Hangars', 'Planets', 'Kill feed', 'Item prices', 'Location', 'Skills and clones', 'Routes'];
    return h('section', { class: 'panel panel-data' }, h('h3', null, 'How fresh this is'),
      h('ul', { class: 'feeds' }, names.filter(n => S.feeds[n]).map(n => {
        const f = S.feeds[n];
        return h('li', { class: f.err ? 'is-err' : '' }, h('span', null, n),
          f.err ? h('span', { class: 'sub' }, f.err) : h('span', { class: 'sub' }, live('age', f.at), n === 'Location' || n === 'Routes' ? null : [', ', live('next', f.next)]));
      })),
      h('p', { class: 'note' }, 'EVE publishes market books every 5 minutes, your order list every 20, sales every hour. A change you make shows here when the next book lands. Route figures are ships/pods lost in the last hour.'),
      h('div', { class: 'tools' },
        'wakeLock' in navigator ? h('button', { type: 'button', class: 'btn btn-quiet', 'aria-pressed': S.wantWake ? 'true' : 'false', onclick: toggleWake }, S.wantWake ? 'Screen stays on' : 'Keep screen on') : null,
        demo ? h('a', { class: 'btn btn-quiet', href: './' }, 'Leave sample data')
          : h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { E.signOut(); location.reload(); } }, 'Sign out')));
  }

  function topView(m) {
    const st = S.loc && (S.loc.station_id || S.loc.structure_id);
    const sys = S.loc && K.systems[S.loc.solar_system_id];
    const where = !S.loc ? '' : st ? 'Docked at ' + ((K.stations[st] || {}).name || nameOf(st)) : 'In space' + (sys ? ' in ' + sys.name : '');
    const ship = S.ship ? ', flying ' + nameOf(S.ship.ship_type_id) + (S.ship.ship_name ? ' "' + S.ship.ship_name + '"' : '') : '';
    const f = S.feeds['Market books'];
    return h('header', { class: 'top' },
      h('div', { class: 'who' }, h('h1', null, S.who.name), h('p', null, where + ship)),
      m && h('dl', { class: 'purse' },
        h('div', null, h('dt', null, 'Overall wealth'), h('dd', { title: m.wealth == null ? '' : L.isk(Math.round(m.wealth)) }, m.wealth == null ? '' : L.short(m.wealth))),
        h('div', null, h('dt', null, 'Wallet'), h('dd', { title: m.wallet == null ? '' : L.isk(m.wallet) }, m.wallet == null ? '' : L.short(m.wallet))),
        h('div', null, h('dt', null, 'In buy orders'), h('dd', null, L.short(m.escrow))),
        h('div', null, h('dt', null, 'Net since Monday'), h('dd', null, L.short(m.week.net)))),
      h('div', { class: 'sync' },
        S.update && h('button', { type: 'button', class: 'btn btn-update', onclick: () => location.reload() }, 'Update ready, reload'),
        h('p', null, f && f.at ? ['Market books ', live('age', f.at), h('span', { class: 'sub' }, live('next', f.next))] : S.running ? 'Loading' : ''),
        h('button', { type: 'button', class: 'btn', disabled: S.running, onclick: run }, S.running ? 'Loading' : 'Refresh')));
  }

  function paint() {
    if (!demo && !E.who()) return loginView(S.notice || 'Your sign-in ended. Log in again to carry on.');
    const m = S.ready ? build() : null;
    const y = window.scrollY;
    root.replaceChildren(
      demo ? h('p', { class: 'banner' }, 'Sample data. Routes are real, the orders and ISK are invented. ', h('a', { href: './' }, 'Leave sample data')) : '',
      topView(m),
      m ? h('main', { class: 'board' },
        h('div', { class: 'stops' }, m.stops.length ? [tabsView(m), stopView(m.stops.find(s => s.id === m.tab) || m.stops[0])] : h('p', { class: 'empty' }, 'No open orders. Place one in game and it appears here within 20 minutes.')),
        h('aside', { class: 'side' }, weekPanel(m), booksPanel(m), piPanel(m), skillPanel(m), clonePanel(m), slowPanel(m), dataPanel()))
        : h('main', { class: 'board' }, h('p', { class: 'empty' }, 'Loading your orders.')));
    window.scrollTo(0, y);
  }

  function loginView(notice) {
    const ready = !!C.clientId;
    root.replaceChildren(h('main', { class: 'door' },
      h('h1', null, 'Eve Ops'),
      h('p', { class: 'lede' }, 'Your open orders against the live book, the exact price to type at each hub, and the route between them.'),
      notice && h('p', { class: 'door-note' }, notice),
      ready
        ? h('button', { type: 'button', class: 'btn btn-big', onclick: e => { e.currentTarget.disabled = true; E.login().catch(err => loginView(err.message)); } }, 'Log in with EVE')
        : h('p', { class: 'door-note' }, 'Sign-in is not switched on yet: the EVE application’s Client ID still has to be added to this page.'),
      h('p', { class: 'small' }, 'Log in with the character that holds your market orders. Access is read-only, and the sign-in is kept in this browser only.'),
      h('p', { class: 'small' }, h('a', { href: '#demo' }, 'Look around with sample data'))));
  }

  /** A board left open for days should notice when a newer version has been published. */
  async function checkVersion() {
    try {
      const html = await (await fetch('./', { cache: 'no-store' })).text();
      const m = html.match(/name="eveops-version" content="([^"]+)"/);
      if (m && VERSION && m[1] !== VERSION && !S.update) { S.update = true; paint(); }
    } catch (err) { /* offline: try again later */ }
  }

  async function toggleWake() {
    S.wantWake = !S.wantWake;
    await wake();
    paint();
  }
  async function wake() {
    try {
      if (!S.wantWake) { if (S.wake) await S.wake.release(); S.wake = null; return; }
      if (!S.wake && document.visibilityState === 'visible') {
        S.wake = await navigator.wakeLock.request('screen');
        S.wake.addEventListener('release', () => { S.wake = null; });
      }
    } catch (err) { S.wantWake = false; }
  }

  // ----------------------------------------------------------------- boot
  async function boot() {
    window.addEventListener('hashchange', () => location.reload());
    if (demo) S.who = window.Demo.who;
    else {
      try { await E.finishLogin(); } catch (err) { S.notice = err.message; }
      S.who = E.who();
      if (!S.who) return loginView(S.notice);
    }
    await run();
    let n = 0;
    setInterval(async () => {
      stamp();
      if (document.hidden || S.running) return;
      if (!demo && !E.who()) return paint();
      n++;
      if (n % 20 === 0) checkVersion();          // every five minutes
      if (n % 4 === 0) return run();           // once a minute: fetch whatever EVE has republished
      try { if (await loadLocation()) { await loadRoutes(); paint(); } } catch (err) { /* next tick */ }
    }, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { wake(); run(); } });
  }
  boot();
})();
