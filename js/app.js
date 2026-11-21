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
  /** Which view an address asks for: Trading unless it names another. */
  function viewOf(hash) { return hash === '#wormholes' ? 'wh' : hash === '#expedition' ? 'ex' : 'trade'; }
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
  const K = Object.assign({ names: {}, systems: {}, stations: {}, planets: {}, routes: {}, types: {} }, demo ? null : E.store.get(STATIC));
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
  async function typeInfo(id) {
    if (K.types[id] && K.types[id].g) return K.types[id];
    const r = await E.get('/universe/types/' + id + '/');
    K.types[id] = { v: r.data.packaged_volume || r.data.volume || 0, cap: r.data.capacity || 0, g: r.data.group_id }; saveStatic();
    return K.types[id];
  }
  /** An item group's name and its category's name, kept between visits. */
  async function groupInfo(id) {
    K.groups = K.groups || {};
    if (K.groups[id]) return K.groups[id];
    const r = await E.get('/universe/groups/' + id + '/');
    const cat = await E.get('/universe/categories/' + r.data.category_id + '/').then(x => x.data.name, () => '');
    K.groups[id] = { name: r.data.name, cat }; saveStatic();
    return K.groups[id];
  }
  // What counts as exploration loot and as gas, by item group name.
  const GAS = /Harvestable Cloud|Compressed Gas/i;
  const LOOT = /Salvaged Materials|Ancient Salvage|Sleeper Components|Datacores|Decryptors|Materials and Compounds|Artifacts and Prototypes|Rogue Drone Components|Overseer|Triglavian Data|Research Data/i;
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
  // `view`: mid-camp, a plain open lands on the Expedition tab's camp board.
  const S = {
    who: null, loc: null, ship: null, wallet: null,
    orders: [], ordersAt: 0, tx: [], assets: [], books: new Map(), jumps: new Map(),
    queue: [], skills: null, clones: null, planets: [], kills: new Map(), routes: {},
    feeds: {}, ready: false, running: false, notice: null,
    pins: (!demo && E.store.get('eveops.pins')) || {}, copied: (!demo && E.store.get('eveops.copied')) || {}, legs: {}, openCalls: new Set(), journal: null, costs: (!demo && E.store.get('eveops.costs')) || null, costDraft: null, costNote: null, notify: Object.assign({ change: false, extractors: false, launchpad: false }, E.store.get('eveops.notify')), notifyAllowed: null, weeks: Object.assign({ carried: null, w: {} }, !demo && E.store.get('eveops.weeks')), fold: (!demo && E.store.get('eveops.fold')) || {}, tripSkip: new Set(), tripSafe: !demo && !!(E.store.get('eveops.trip') || {}).safe, tripOpen: (() => { const t = !demo && E.store.get('eveops.trip'); return t && t.open != null ? !!t.open : window.matchMedia('(min-width: 49rem)').matches; })(), wantWake: false, wake: null,
    prices: new Map(), tab: null, follow: true, view: !location.hash && window.Ex && window.Ex.campOpen() ? 'ex' : viewOf(location.hash), hist: new Map(), piNear: null, piFrom: null, history: [], scout: null, lootBooks: new Map(), lootVol: new Map(), lootSig: '', lootAt: 0, lootJumps: {},
    seen: (!demo && E.store.get('eveops.seen')) || null, load: (!demo && E.store.get('eveops.load')) || null, cargo: (!demo && E.store.get('eveops.cargo')) || C.haul.cargo, haulTo: (!demo && E.store.get('eveops.haulTo')) || [],
    reads: new Map(), riskSet: (!demo && E.store.get('eveops.risk')) || null,
  };
  /** The four limits of the safeguards: the page's defaults, with whatever has been set here (or on another device) over them. */
  function limits() { return Object.assign({}, C.risk.limits, S.riskSet && S.riskSet.v); }
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
  async function loadOrders() {
    const r = await E.get(me() + '/orders/', { auth: true }); S.orders = r.data; S.ordersAt = r.modified; feed('Your orders', r);
    noteChanges();
    S.history = await E.get(me() + '/orders/history/', { auth: true }).then(x => x.data, () => S.history);
  }
  /** Counts the price changes made since the orders were last read, week by week, for the fee meter under "Since Monday". */
  function noteChanges() {
    const ch = L.orderChanges(demo ? window.Demo.orderLog : E.store.get('eveops.orderlog'), S.orders, C.fees);
    if (demo) window.Demo.orderLog = ch.log; else E.store.set('eveops.orderlog', ch.log);
    for (const c of ch.changes) {
      const key = L.weekKey(c.at), w = S.weeks.w[key] || (S.weeks.w[key] = {});
      w.bumps = { n: ((w.bumps || {}).n || 0) + 1, fee: ((w.bumps || {}).fee || 0) + c.fee };
    }
    if (ch.changes.length) saveWeeks(true);
  }
  const hubOf = new Map(C.hubs.map(hb => [hb.station, hb]));
  /** Stock of items you trade, sitting loose in a station hangar. Map type -> units. */
  function hangarAt(station) {
    const traded = new Set(S.orders.map(o => o.type_id));
    S.tx.forEach(t => traded.add(t.type_id));
    const m = new Map();
    for (const a of S.assets) {
      if (a.location_id !== station || a.location_type !== 'station' || a.location_flag !== 'Hangar' || a.is_singleton) continue;
      if (!traded.has(a.type_id) || C.excludeTypes.indexOf(a.type_id) >= 0) continue;
      m.set(a.type_id, (m.get(a.type_id) || 0) + a.quantity);
    }
    return m;
  }
  /** Items you trade that are in the cargo hold of the ship you are flying. Map type -> units. (EVE reports hangars and cargo once an hour.) */
  function cargoHold() {
    const m = new Map(), ship = S.ship ? S.ship.ship_item_id : null;
    if (!ship) return m;
    const traded = new Set(S.orders.map(o => o.type_id));
    S.tx.forEach(t => traded.add(t.type_id));
    for (const a of S.assets) {
      if (a.location_id !== ship || a.location_flag !== 'Cargo' || a.is_singleton) continue;
      if (!traded.has(a.type_id) || C.excludeTypes.indexOf(a.type_id) >= 0) continue;
      m.set(a.type_id, (m.get(a.type_id) || 0) + a.quantity);
    }
    return m;
  }
  /** Lines that sold in the last 7 days at a hub and have nothing listed there now. Map "station:type" -> units sold. */
  function soldOut(now) {
    const open = new Set(S.orders.filter(o => !o.is_buy_order).map(o => o.location_id + ':' + o.type_id));
    const m = new Map();
    for (const t of S.tx) {
      if (t.is_buy || now - Date.parse(t.date) > 7 * D || !hubOf.has(t.location_id)) continue;
      if (C.excludeTypes.indexOf(t.type_id) >= 0 || C.zeroCostTypes.indexOf(t.type_id) >= 0 || C.planetTypes.indexOf(t.type_id) >= 0) continue;
      const k = t.location_id + ':' + t.type_id;
      if (!open.has(k)) m.set(k, (m.get(k) || 0) + t.quantity);
    }
    return m;
  }
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
  /** The wallet journal (EVE keeps 30 days): the exact fees, tax and balances behind the weekly close. */
  async function loadJournal() { const r = await E.get(me() + '/wallet/journal/', { auth: true }); S.journal = r.data; feed('Wallet journal', r); }
  async function loadAssets() { const r = await E.get(me() + '/assets/', { auth: true }); S.assets = r.data; feed('Hangars', r); }
  async function loadSkills() {
    const r = await Promise.all([E.get(me() + '/skillqueue/', { auth: true }), E.get(me() + '/skills/', { auth: true }), E.get(me() + '/clones/', { auth: true })]);
    S.queue = r[0].data; S.skills = r[1].data; S.clones = r[2].data; feed('Skills and clones', r[0]);
    await Promise.all((S.clones.jump_clones || []).map(j => station(j.location_id).then(st => system(st.system)).catch(() => {})));
  }
  async function loadPlanets() {
    const r = await E.get(me() + '/planets/', { auth: true });
    const now = Date.now();
    const times = [0, 1, 2, 3, 4, 5, 6, 7].map(d => now + d * D);
    S.planets = await Promise.all(r.data.map(async p => {
      const pair = await Promise.all([E.get(me() + '/planets/' + p.planet_id + '/', { auth: true }), planetName(p.planet_id).catch(() => 'Planet ' + p.planet_id)]);
      const ex = pair[0].data.pins.filter(x => x.extractor_details).map(x => (x.expiry_time ? Date.parse(x.expiry_time) : 0));
      const base = { id: p.planet_id, name: pair[1], type: p.planet_type, system: p.solar_system_id, extractors: ex.length, expiry: ex.length ? Math.min.apply(null, ex) : null, product: null, units: null, fill: 0 };
      try { Object.assign(base, await forecast(p, pair[0].data, times)); } catch (err) { base.forecastErr = err.message || String(err); }
      return base;
    }));
    feed('Planets', r);
  }
  /** ESI shows a colony as it was when last opened in game; work out what is on it now and over the next week. */
  async function forecast(p, d, times) {
    const ids = new Set();
    d.pins.forEach(x => { ids.add(x.type_id); (x.contents || []).forEach(c => ids.add(c.type_id)); });
    d.routes.forEach(x => ids.add(x.content_type_id));
    await Promise.all([resolveNames(Array.from(ids)), Promise.all(Array.from(ids).map(typeInfo))]);
    const kind = id => {
      const n = K.names[id] || '';
      return /Extractor Control Unit/.test(n) ? 'ecu' : /Basic Industry/.test(n) ? 'basic' : /Advanced Industry/.test(n) ? 'advanced'
        : /Command Center|Launchpad|Storage Facility/.test(n) ? 'store' : 'other';
    };
    const col = {
      at: Date.parse(p.last_update),
      pins: d.pins.map(x => ({
        id: x.pin_id, kind: kind(x.type_id), cap: (K.types[x.type_id] || {}).cap || 0,
        contents: (x.contents || []).map(c => [c.type_id, c.amount]),
        lastStart: x.last_cycle_start ? Date.parse(x.last_cycle_start) : 0,
        ex: x.extractor_details && x.expiry_time && x.install_time ? {
          prod: x.extractor_details.product_type_id, base: x.extractor_details.qty_per_cycle, cycle: x.extractor_details.cycle_time * 1000,
          start: Date.parse(x.install_time), end: Date.parse(x.expiry_time) } : null,
      })),
      routes: d.routes.map(x => [x.source_pin_id, x.destination_pin_id, x.content_type_id, x.quantity]),
    };
    const byId = new Map(col.pins.map(x => [x.id, x]));
    let product = null; // what the colony makes: the output of its advanced factories, or of its basic ones if it has none
    for (const tier of ['advanced', 'basic']) for (const rt of col.routes) if (product == null && (byId.get(rt[0]) || {}).kind === tier) product = rt[2];
    if (product == null) return {};
    const vol = t => (K.types[t] || {}).v || 1;
    const snaps = L.piRun(col, times.map(t => Math.max(t, col.at)), vol);
    const units = snaps.map(m => { let n = 0; for (const b of m.values()) n += b.get(product) || 0; return n; });
    let fill = 0; // how full the storage that receives the product is
    for (const rt of col.routes) {
      const dst = byId.get(rt[1]);
      if (rt[2] !== product || !dst || dst.kind !== 'store' || !dst.cap) continue;
      let used = 0;
      for (const e of snaps[0].get(dst.id)) used += e[1] * vol(e[0]);
      fill = Math.max(fill, used / dst.cap);
    }
    return { product, units, fill, volume: vol(product) };
  }
  async function loadKills() {
    const r = await E.get('/universe/system_kills/');
    S.kills = new Map(r.data.map(k => [k.system_id, k])); feed('Kill feed', r);
  }
  /** The wormhole pilot, if signed in: their wallet, assets, orders and skill queue for the combined figures. */
  async function loadScout() {
    const sc = demo ? window.Demo.scout : E.who('scout');
    if (!sc) { S.scout = null; return; }
    const base = '/characters/' + sc.id, a = { auth: 'scout' };
    const r = await Promise.all([E.get(base + '/wallet/', a), E.get(base + '/assets/', a), E.get(base + '/skillqueue/', a), E.get(base + '/orders/', a)]);
    await resolveNames(r[2].data.map(q => q.skill_id)).catch(() => {});
    // exploration loot and gas among her stacked items, and where each stack sits
    const all = r[1].data, byItem = new Map(all.map(x => [x.item_id, x])), kinds = new Map(), where = new Map(), tops = new Set(), holders = new Set();
    await Promise.all(Array.from(new Set(all.filter(x => !x.is_singleton).map(x => x.type_id))).map(async t => {
      try {
        const g = await groupInfo((await typeInfo(t)).g);
        const kind = GAS.test(g.name) ? 'Gas' : LOOT.test(g.name) || /Ancient Relics/i.test(g.cat) ? 'Exploration' : null;
        if (kind) kinds.set(t, { kind, group: g.name });
      } catch (err) { /* unknown type: leave it out */ }
    }));
    for (const x of all) {
      if (x.is_singleton || !kinds.has(x.type_id)) continue;
      let cur = x, holder = null;
      for (let i = 0; i < 6 && byItem.has(cur.location_id); i++) { cur = byItem.get(cur.location_id); holder = holder || cur; }
      where.set(x.item_id, { top: cur.location_id, holder: holder ? holder.type_id : null, flag: x.location_flag });
      tops.add(cur.location_id);
      if (holder) holders.add(holder.type_id);
    }
    const placeNames = {}, placeSys = {};
    await Promise.all(Array.from(tops).map(async id => {
      try {
        if (id >= 1e12) { const st = (await E.get('/universe/structures/' + id + '/', a)).data; placeNames[id] = st.name; placeSys[id] = st.solar_system_id; }
        else if (id >= 6e7 && id < 7e7) { const st = await station(id); placeNames[id] = st.name; placeSys[id] = st.system; }
        else if (id >= 3e7 && id < 4e7) { placeNames[id] = 'In space in ' + (await system(id)).name; placeSys[id] = id; }
      } catch (err) { placeNames[id] = id >= 1e12 ? 'A structure (name not available)' : 'Unknown place'; }
    }));
    await resolveNames(Array.from(kinds.keys()).concat(Array.from(holders))).catch(() => {});
    S.scout = { name: sc.name, wallet: r[0].data, assets: all, queue: r[2].data, orders: r[3].data, kinds, where, placeNames, placeSys };
  }
  /** Every hub's book for each kind of loot the wormhole pilot holds, and the jumps from where it sits to each hub. */
  async function loadLoot() {
    const sc = S.scout;
    if (!sc || !sc.kinds.size) { S.lootBooks.clear(); S.lootVol.clear(); S.lootSig = ''; delete S.feeds['Loot prices']; return; }
    const types = Array.from(new Set(sc.assets.filter(x => sc.where.has(x.item_id) && !x.is_blueprint_copy).map(x => x.type_id))).sort((x, y) => x - y);
    const hubs = (await Promise.all(C.hubs.map(hb => station(hb.station).then(st => ({ hb, sys: st.system }), () => null)))).filter(Boolean);
    const sig = types.join(',');
    if (sig !== S.lootSig || Date.now() - S.lootAt > 10 * M) {
      let failed = 0, oldest = Infinity;
      const next = new Map(), vol = new Map();
      await Promise.all(types.map(t => Promise.all(C.hubs.map(async hb => {
        try {
          const r = await E.get('/markets/' + hb.region + '/orders/', { query: { order_type: 'all', type_id: t } });
          next.set(hb.region + ':' + t, r.data); oldest = Math.min(oldest, r.modified);
        } catch (err) { failed++; }
        try { vol.set(hb.region + ':' + t, L.tradedPerDay((await E.get('/markets/' + hb.region + '/history/', { query: { type_id: t } })).data, Date.now(), 7)); }
        catch (err) { /* pace not known for this hub */ }
      }))));
      S.lootBooks = next; S.lootVol = vol; S.lootSig = sig; S.lootAt = Date.now();
      S.feeds['Loot prices'] = { at: isFinite(oldest) ? oldest : 0, next: S.lootAt + 10 * M, err: failed ? failed + ' of ' + types.length * C.hubs.length + ' books did not load.' : null };
    }
    const jumps = {};
    await Promise.all(Object.keys(sc.placeSys).map(async top => {
      const from = sc.placeSys[top];
      if (!from || from >= 31000000) return;      // no stargate route out of wormhole space
      jumps[top] = {};
      await Promise.all(hubs.map(async x => {
        try { jumps[top][x.hb.station] = (await route(from, x.sys, 'shortest')).length - 1; } catch (err) { /* no route */ }
      }));
    }));
    S.lootJumps = jumps;
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
      else for (const hb of C.hubs) want.set(hb.region + ':' + o.type_id, [hb.region, o.type_id]);       // a bid is judged by what the hubs pay
    }
    for (const p of S.planets) if (p.product) for (const hb of C.hubs) want.set(hb.region + ':' + p.product, [hb.region, p.product]);
    const waiting = Array.from(new Set(Array.from(hangarAt(C.jita.station).keys()).concat(Array.from(cargoHold().keys()))));
    for (const type of waiting) for (const hb of C.hubs) want.set(hb.region + ':' + type, [hb.region, type]);
    for (const k of soldOut(Date.now()).keys()) {
      const p = k.split(':').map(Number);
      want.set(hubOf.get(p[0]).region + ':' + p[1], [hubOf.get(p[0]).region, p[1]]);
      want.set(C.jita.region + ':' + p[1], [C.jita.region, p[1]]);
    }
    await Promise.all(waiting.map(t => typeInfo(t).catch(() => {})));
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
  /**
   * A month of each hub's price history for the lines you have never sold or listed at a hub (on bid, in the Jita hangar or in the hold).
   * Until your own sales say more, this and the book are what a hub is read from. EVE republishes it once a day.
   */
  async function loadReads() {
    const known = new Set(), knownAt = new Set();
    for (const t of S.tx) if (!t.is_buy && t.location_id !== C.jita.station && hubOf.has(t.location_id)) { known.add(t.type_id); knownAt.add(t.location_id + ':' + t.type_id); }
    for (const o of S.orders) if (!o.is_buy_order && o.location_id !== C.jita.station && hubOf.has(o.location_id)) { known.add(o.type_id); knownAt.add(o.location_id + ':' + o.type_id); }
    const types = new Set(S.orders.filter(o => o.is_buy_order).map(o => o.type_id));
    for (const t of hangarAt(C.jita.station).keys()) types.add(t);
    for (const t of cargoHold().keys()) types.add(t);
    const want = new Map();
    for (const t of types) {
      if (C.zeroCostTypes.indexOf(t) >= 0 || C.planetTypes.indexOf(t) >= 0) continue;
      // a line you sell is read only in the hubs you sell it in (to tell a thin spike at the front of the book); a new one in every hub
      for (const hb of C.hubs) if (hb.station !== C.jita.station && (!known.has(t) || knownAt.has(hb.station + ':' + t))) want.set(hb.region + ':' + t, [hb.region, t]);
    }
    let failed = 0, oldest = Infinity, soonest = Infinity;
    await Promise.all(Array.from(want, async ([key, rt]) => {
      try {
        const r = await E.get('/markets/' + rt[0] + '/history/', { query: { type_id: rt[1] } });
        S.reads.set(key, r.data); oldest = Math.min(oldest, r.modified); soonest = Math.min(soonest, r.expires);
      } catch (err) { failed++; }
    }));
    for (const k of Array.from(S.reads.keys())) if (!want.has(k)) S.reads.delete(k);
    if (want.size) S.feeds['Price history'] = { at: isFinite(oldest) ? oldest : 0, next: isFinite(soonest) ? soonest : Date.now() + H, err: failed ? failed + ' of ' + want.size + ' histories did not load.' : null };
    else delete S.feeds['Price history'];
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
    // hub to hub, for the trip plan (kept for a week like every route)
    const hs = hubIds(), legs = {};
    await Promise.all(hs.reduce((jobs, a, i) => jobs.concat(hs.slice(i + 1).map(async b => {
      try {
        const sa = await station(a), sb = await station(b);
        const pair = await Promise.all([route(sa.system, sb.system, 'shortest'), route(sa.system, sb.system, 'secure').catch(() => null)]);
        await Promise.all(Array.from(new Set(pair[0].concat(pair[1] || []))).map(system));
        legs[a + ':' + b] = { short: pair[0], safe: pair[1] };
      } catch (err) { /* that pair is left out of the plan */ }
    })), []));
    S.legs = legs;
    const sysId = (S.planets[0] || {}).system;
    if (sysId) {
      await system(sysId).catch(() => {});
      const near = await Promise.all(C.hubs.map(async hb => {
        try { const st = await station(hb.station); return { station: hb.station, name: hb.name, jumps: (await route(st.system, sysId, 'shortest')).length - 1 }; }
        catch (err) { return { station: hb.station, name: hb.name, jumps: Infinity }; }
      }));
      S.piNear = near.sort((a, b) => a.jumps - b.jumps)[0];
      S.piFrom = await route(from, sysId, 'shortest').then(x => x.length - 1, () => null);
    }
  }
  /** A week of price history for each line flagged as a big move, so the call can be read against it. */
  async function loadHistory() {
    const m = build();
    const jobs = [];
    for (const st of m.stops) for (const r of st.sells) {
      if (r.plan.kind !== 'big') continue;
      const key = r.region + ':' + r.type;
      if (S.hist.has(key)) continue;
      S.hist.set(key, null);
      jobs.push(E.get('/markets/' + r.region + '/history/', { query: { type_id: r.type } }).then(h => S.hist.set(key, L.weekOf(h.data, 7)), () => S.hist.delete(key)));
    }
    await Promise.all(jobs);
  }

  async function run() {
    if (S.running) return;
    S.running = true; paint();
    try {
      await Promise.all([
        load('Location', loadLocation), load('Wallet', loadWallet), load('Your orders', loadOrders),
        load('Sales and purchases', loadTx), load('Wallet journal', loadJournal), load('Hangars', loadAssets), load('Skills and clones', loadSkills), load('Kill feed', loadKills),
      ]);
      if (!demo && !E.who()) return;
      const ids = [];
      S.orders.forEach(o => ids.push(o.type_id));
      S.tx.forEach(t => ids.push(t.type_id));
      S.queue.forEach(q => ids.push(q.skill_id));
      if (S.ship) ids.push(S.ship.ship_type_id);
      await resolveNames(ids).catch(() => {});
      S.ready = true; paint();
      await load('Planets', loadPlanets);
      await Promise.all([load('Market books', loadBooks), load('Routes', loadRoutes), load('Item prices', loadPrices), load('Second character', loadScout), load('Price history', loadReads)]);
      S.settled = true;                                   // books, history and orders are in: a load's plan may be fixed from here on
      await loadReach().catch(() => {});
      paint();
      await Promise.all([loadHistory().catch(() => {}), load('Loot prices', loadLoot)]);
    } finally {
      S.running = false;
      paint();
    }
  }

  // ---------------------------------------------------------------- model
  function build() {
    const now = Date.now();
    const zero = new Set(C.zeroCostTypes);
    // The wallet's own purchases come first; the tracker's costs fill in for units the wallet cannot account for (config: costs.prefer).
    const track = S.costs && S.costs.rows && S.costs.rows.length ? L.costLookup(S.costs.rows) : null;
    const led = L.ledger(S.tx, { netMult: NET, exclude: new Set(C.excludeTypes), zeroCost: zero, made: new Set(C.planetTypes), fallback: track, prefer: C.costs.prefer });
    const vel = L.velocity(led.sales, now);
    const myIds = new Set(S.orders.map(o => o.order_id));
    const windowDays = led.from ? (now - led.from) / D : 0;
    const hubSet = new Set(C.hubs.map(x => x.station));
    const R = C.risk, lim = limits();
    const away = C.hubs.filter(hb => hb.station !== C.jita.station);

    const listedByType = new Map();
    for (const o of S.orders) if (!o.is_buy_order) listedByType.set(o.type_id, (listedByType.get(o.type_id) || 0) + o.volume_remain);
    const costFor = (type, units, loc) => {
      if (zero.has(type)) return { cost: 0, units: Infinity };
      const c = L.unitCost(led.lots, type, units), t = !c && track ? track(type, loc || null, now) : null;
      return c || (t != null ? { cost: t, units: 0, tracker: true } : null);
    };
    const costOf = (type, loc) => costFor(type, listedByType.get(type) || 0, loc);
    const jitaSell = type => {
      const b = S.books.get(C.jita.region + ':' + type);
      if (!b) return null;
      const p = b.orders.filter(o => !o.is_buy_order && o.location_id === C.jita.station && !myIds.has(o.order_id)).map(o => o.price);
      return p.length ? Math.min.apply(null, p) : null;
    };

    const ask = (type, hb) => {
      const b = S.books.get(hb.region + ':' + type);
      if (!b) return null;
      const px = b.orders.filter(o => !o.is_buy_order && o.location_id === hb.station && !myIds.has(o.order_id)).map(o => o.price);
      return px.length ? Math.min.apply(null, px) : null;
    };
    const hubName = id => (hubOf.get(id) || {}).name || ((K.systems[(K.stations[id] || {}).system] || {}).name) || 'another station';

    // ---- safeguards: where each line goes, the most a bid on it may be, and whether it has earned a re-bid
    const myLow = new Map();
    for (const o of S.orders) if (!o.is_buy_order) { const k = o.location_id + ':' + o.type_id; myLow.set(k, Math.min(myLow.has(k) ? myLow.get(k) : Infinity, o.price)); }
    const planCache = new Map(), sold7 = new Map();
    for (const x of led.sales) if (now - x.date <= 7 * D) { const k = x.type_id + ':' + x.location_id, e = sold7.get(k) || { qty: 0, gross: 0 }; e.qty += x.qty; e.gross += x.gross; sold7.set(k, e); }
    /** The plan for one item at one cost: `buyFee` is the broker's share when the cost is a bid still to fill. */
    const planFor = (type, cost, buyFee) => {
      const key = type + ':' + cost + ':' + buyFee;
      if (planCache.has(key)) return planCache.get(key);
      const hubs = [];
      for (const hb of away) {                     // hubs you have sold it in or list it in: counted at the front of the book there
        const v = vel.get(type + ':' + hb.station), mine = myLow.get(hb.station + ':' + type), a = ask(type, hb);
        if (!(v && v.last) && mine == null) continue;
        const front = a == null ? mine : mine == null ? a : Math.min(a, mine), wk = sold7.get(type + ':' + hb.station);
        if (front == null) continue;
        // a front far over what the item trades at there is a thin spike: it counts for no more than 115% of the month's average
        const cap = L.spikeCap(S.reads.get(hb.region + ':' + type), now, R.spike), seen = cap != null && front > cap ? cap : front;
        // a front well under what you sold at there this week is a dump, which drains: the hub is counted at no less than 93% of your week's average
        hubs.push({ name: hb.name, station: hb.station, price: wk && wk.qty ? Math.max(seen, 0.93 * wk.gross / wk.qty) : seen, ask: a, perDay: v ? v.d7 / 7 : 0, thin: seen < front });
      }
      const sold = hubs.length > 0;
      if (!sold) for (const hb of away) {          // never sold at a hub: each hub is read from its book and its region's history
        const hist = S.reads.get(hb.region + ':' + type);
        if (!hist) continue;
        const rd = L.hubRead(ask(type, hb), hist, now, R.spike);
        if (rd.price != null && rd.perDay >= R.minPerDay) hubs.push({ name: hb.name, station: hb.station, price: rd.price, ask: rd.ask, perDay: rd.perDay, thin: rd.thin });
      }
      const g = Object.assign(L.destPlan(hubs, { cost, buyFee, netMult: NET, floor: R.floor, margin: R.margin, top: R.top }), { read: hubs, sold });
      planCache.set(key, g);
      return g;
    };
    const buysBy = new Map(), soldBy = new Map(), stockBy = new Map(listedByType);
    for (const t of S.tx) if (t.is_buy) { if (!buysBy.has(t.type_id)) buysBy.set(t.type_id, []); buysBy.get(t.type_id).push({ at: Date.parse(t.date), qty: t.quantity }); }
    for (const b of buysBy.values()) b.sort((x, y) => x.at - y.at);
    for (const x of led.sales) {
      const e = soldBy.get(x.type_id) || { units: 0, net: 0, cost: 0 };
      e.units += x.qty;
      if (x.net != null && x.cost > 0) { e.net += x.net; e.cost += x.cost; }
      soldBy.set(x.type_id, e);
    }
    for (const a of S.assets) if (!a.is_singleton && (a.location_flag === 'Hangar' || a.location_flag === 'Cargo')) stockBy.set(a.type_id, (stockBy.get(a.type_id) || 0) + a.quantity);
    const statusCache = new Map(), madeHere = new Set(C.planetTypes);
    /** Whether a line has proven itself: 'proven', 'new', 'probation' or 'drop' (see lineStatus). What comes off your own colonies is proven. */
    const statusOf = type => {
      if (statusCache.has(type)) return statusCache.get(type);
      const e = soldBy.get(type) || { units: 0, net: 0, cost: 0 };
      const st = zero.has(type) || madeHere.has(type) ? { state: 'proven', sold: e.units, lot: 0, first: null, thin: false }
        : L.lineStatus({ buys: buysBy.get(type) || [], sold: e.units, margin: e.cost > 0 ? e.net / e.cost : null, stock: stockBy.get(type) || 0 }, Object.assign({ floor: R.floor }, R.probation), now);
      if (st.state === 'drop' && !st.lot && windowDays < R.probation.days) st.state = 'new';      // too little history to call it
      statusCache.set(type, st);
      return st;
    };
    // restock: what is already on the way, and the bid that would lead in Jita
    const onBid = new Map();
    for (const o of S.orders) if (o.is_buy_order) onBid.set(o.type_id, (onBid.get(o.type_id) || 0) + o.volume_remain);
    const jitaHang = hangarAt(C.jita.station);
    const jitaBid = type => {
      const b = S.books.get(C.jita.region + ':' + type);
      if (!b) return null;
      const px = b.orders.filter(o => o.is_buy_order && !myIds.has(o.order_id) && (o.location_id === C.jita.station || o.range === 'region')).map(o => o.price);
      return px.length ? L.tickAbove(Math.max.apply(null, px)) : null;
    };
    const restock = [];
    const consider = (type, loc, left, d7, hubPrice) => {
      if (zero.has(type) || d7 < C.restock.minWeek || loc === C.jita.station) return;
      const days = left / (d7 / 7);
      if (days > C.restock.days) return;
      const bid = jitaBid(type), coming = (onBid.get(type) || 0) + (jitaHang.get(type) || 0);
      const net = bid != null && hubPrice != null ? hubPrice * NET - bid : null;
      const margin = net != null && bid ? net / bid : null;
      const mk = S.copied['r' + type] && !S.copied['r' + type].gone ? S.copied['r' + type] : null;
      const stt = statusOf(type);
      restock.push({ type, name: nameOf(type), hub: hubName(loc), left, perDay: d7 / 7, days, bid, coming, want: Math.max(0, Math.round(d7) - left - coming), net, margin, thin: margin != null && margin < C.restock.minMargin,
        probation: stt.state === 'proven' ? null : stt,
        copied: mk ? { state: 'waiting', price: mk.price, at: mk.at, moved: bid != null && mk.price !== bid } : null });
    };

    // pins that have served their purpose
    let pinsChanged = false;
    // Entries leave these lists by age alone (a removal by hand stays as { gone, at } until then), so that devices sharing them agree.
    for (const id of Object.keys(S.pins)) {
      if (now - S.pins[id].at > PIN_KEEP) { delete S.pins[id]; pinsChanged = true; }
    }
    const pinOf = (id, livePrice) => {
      const p = S.pins[id];
      if (!p || p.gone) return null;
      if (livePrice === p.price && now - p.at > 6 * H) return null;      // shown in the book for six hours: the pin has done its job
      return { price: p.price, at: p.at, done: livePrice === p.price };
    };

    // "copied" marks: which prices have gone to the clipboard, so a pass through a hub keeps its place.
    // Keys are order IDs; 'r' + type ID for a bid on the restock shortlist.
    let marksChanged = false;
    for (const id of Object.keys(S.copied)) {
      if (now - S.copied[id].at > C.copied.keepHours * H) { delete S.copied[id]; marksChanged = true; }
    }
    const typed = (plan, pin) => (pin && !pin.done ? pin.price : (plan.action === 'tick' || plan.action === 'optional') ? plan.target : null);
    const markOf = (id, live, plan, pin, book) => L.copyState(S.copied[id] && !S.copied[id].gone ? S.copied[id] : null, { live, target: typed(plan, pin), dataAt: Math.max(book ? book.modified : 0, S.ordersAt), grace: C.copied.grace * 1000 });

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
      const c = costOf(o0.type_id, o0.location_id);
      const cost = c ? c.cost : null;
      const v = vel.get(o0.type_id + ':' + o0.location_id) || { d1: 0, d7: 0, last: 0 };
      const plan = g.every(x => x.pos)
        ? L.planSells(g, { cost, jitaSell: jitaSell(o0.type_id), isJita: o0.location_id === C.jita.station, netMult: NET, modify: C.fees.modify, sniperUnits: C.sniperUnits, bigMove: C.bigMove,
          slowDays: windowDays >= C.slowFee.days && v.d7 === 0 && now - (led.lastBuy.get(o0.type_id) || 0) > C.slowFee.days * D ? C.slowFee.days : 0 })
        : new Map();
      const book = S.books.get(o0.region_id + ':' + o0.type_id);
      let left = 0;
      for (const x of g) {
        const price = x.pos ? x.pos.price : x.order.price, remain = x.pos ? x.pos.remain : x.order.volume_remain;
        const pl = plan.get(x.order.order_id) || { action: 'wait', reason: 'Waiting for the market book.', target: null }, pn = pinOf(x.order.order_id, price);
        const gone = x.pos && x.pos.status === 'gone', cp = markOf(x.order.order_id, price, pl, pn, book);
        if (!gone) {
          left += remain; listed += price * remain;
          if (cost != null) listedCost += cost * remain; else uncosted += remain;
        }
        stop(x.order.location_id).sells.push({
          id: x.order.order_id, type: x.order.type_id, name: nameOf(x.order.type_id), twin: g.length > 1,
          price, remain, total: x.order.volume_total, pos: x.pos, cost, vel: v,
          expires: Date.parse(x.order.issued) + x.order.duration * D, region: x.order.region_id,
          week: S.hist.get(x.order.region_id + ':' + x.order.type_id) || null,
          checks: L.orderChecks({ isBuy: false, price, duration: x.order.duration, known: hubSet.has(x.order.location_id), front: x.pos ? x.pos.front : null, cost, netMult: NET, copied: cp && cp.state === 'missed' ? cp.price : null }),
          plan: pl, pin: pn, typed: typed(pl, pn), copied: cp, status: statusOf(x.order.type_id).state, thinLine: statusOf(x.order.type_id).thin,
        });
      }
      consider(o0.type_id, o0.location_id, left, v.d7, g.reduce((m, x) => Math.min(m, x.pos ? x.pos.price : x.order.price), Infinity));
      const lastBuy = led.lastBuy.get(o0.type_id) || 0;
      const quiet = windowDays >= C.staleDays && now - v.last > C.staleDays * D && now - lastBuy > C.staleDays * D;
      const clear = v.d7 > 0 ? left / (v.d7 / 7) : null;
      const settled = now - lastBuy > 7 * D;
      const stt = statusOf(o0.type_id), drop = stt.state === 'drop' ? stt : null;
      if (left > 0 && (quiet || (settled && clear != null && clear > 30) || drop)) slow.push({ type: o0.type_id, name: nameOf(o0.type_id), stop: o0.location_id, left, last: v.last, clear, quiet, drop });
    }
    slow.sort((a, b) => (!!b.drop - !!a.drop) || (b.quiet - a.quiet) || ((b.clear || 1e9) - (a.clear || 1e9)));

    let escrow = 0, bidCount = 0;
    for (const o of S.orders) {
      if (!o.is_buy_order) continue;
      bidCount++; escrow += o.escrow || 0;
      const b = S.books.get(o.region_id + ':' + o.type_id), st = K.stations[o.location_id];
      const pos = b && st ? L.buyPosition(o, b.orders, myIds, b.modified >= S.ordersAt, r => reaches(r, o, st.system)) : null;
      const price = pos ? pos.price : o.price;
      // the bid as the book alone would call it, then held to what the hubs pay: over its max it is left, under the floor it is pulled
      const g = planFor(o.type_id, price, C.fees.broker), known = g.state !== 'unknown';
      const pl = pos ? L.guardBid(L.planBid(pos, { broker: C.fees.broker, modify: C.fees.modify, bigMove: C.bigMove }), pos, g) : { action: 'wait', reason: 'Waiting for the market book.', target: null }, pn = pinOf(o.order_id, price);
      const cp = markOf(o.order_id, price, pl, pn, b);
      stop(o.location_id).bids.push({
        id: o.order_id, type: o.type_id, name: nameOf(o.type_id), price, remain: pos ? pos.remain : o.volume_remain,
        total: o.volume_total, pos, escrow: o.escrow || 0, days: o.duration,
        expires: Date.parse(o.issued) + o.duration * D, region: o.region_id, week: null,
        checks: L.orderChecks({ isBuy: true, price, duration: o.duration, known: hubSet.has(o.location_id), wall: pos ? pos.wall : null, behind: R.behind, max: known ? g.max : null, copied: cp && cp.state === 'missed' ? cp.price : null }),
        plan: pl, pin: pn, typed: typed(pl, pn), copied: cp, status: statusOf(o.type_id).state, thinLine: statusOf(o.type_id).thin,
        guard: known ? { state: g.state, max: g.max, margin: g.margin, hubs: g.hubs, sold: g.sold } : null,
      });
    }
    if (pinsChanged && !demo) E.store.set('eveops.pins', S.pins);
    if (marksChanged && !demo) E.store.set('eveops.copied', S.copied);

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
    const pulled = r => r.plan.kind === 'pull';
    const order = r => (r.checks.length || pulled(r) ? -2 : r.pin && !r.pin.done ? -1 : rank[r.plan.action] + (r.plan.action === 'hold' && r.pos && r.pos.status === 'leading' ? 1 : 0));
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
      const toChange = x => x.plan.action === 'tick' || (x.pin && !x.pin.done);
      const held = x => x.copied && x.copied.state === 'waiting' && !x.copied.moved;       // copied, and still the price to type
      const last = rows.filter(held).reduce((a, x) => (!a || x.copied.at > a.copied.at ? x : a), null);
      if (last) last.copied.last = true;
      return Object.assign(s, {
        station: st.name, system: st.system, short: sys ? sys.name : String(st.name).split(' ')[0],
        docked: here != null && here === s.id, inSystem: !!(S.loc && st.system && S.loc.solar_system_id === st.system),
        jumps: r.short ? r.short.length - 1 : null,
        shortRoute: r.short ? r.short.map(hop) : null, safeRoute: r.safe && !same ? r.safe.map(hop) : null, routeErr: r.err || null,
        change: rows.filter(toChange).length, changeFee: sum(rows.filter(toChange), x => x.plan.fee || 0),
        copied: rows.filter(x => toChange(x) && held(x)).length,
        optional: rows.filter(x => x.plan.action === 'optional').length,
        check: rows.filter(x => x.checks.length || pulled(x)).length,
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
    let scout = null;
    if (S.scout) {
      let sheld = 0;
      for (const a of S.scout.assets) if (!a.is_blueprint_copy) sheld += (S.prices.get(a.type_id) || 0) * a.quantity;
      const sorders = sum(S.scout.orders, o => (o.is_buy_order ? o.escrow || 0 : o.price * o.volume_remain));
      const sq = S.scout.queue.filter(x => x.finish_date && Date.parse(x.finish_date) > now).sort((a, b) => a.queue_position - b.queue_position);
      scout = { name: S.scout.name, wallet: S.scout.wallet, held: sheld, wealth: S.scout.wallet + sheld + sorders,
        queue: sq.map(x => ({ name: nameOf(x.skill_id), level: x.finished_level, done: Date.parse(x.finish_date) })), paused: S.scout.queue.filter(x => !x.finish_date).length };
      // where each kind of loot sells: every hub's lowest ask and standing bids, for all the units held
      const sellQty = new Map();
      for (const a of S.scout.assets) if (S.scout.where.has(a.item_id) && !a.is_blueprint_copy) sellQty.set(a.type_id, (sellQty.get(a.type_id) || 0) + a.quantity);
      const lootHubs = C.hubs.map(hb => ({ name: hb.name, station: hb.station, region: hb.region, system: (K.stations[hb.station] || {}).system }));
      const market = new Map();
      for (const e of sellQty) {
        const jb = S.lootBooks.get(C.jita.region + ':' + e[0]);
        let ref = null;
        if (jb) for (const o of jb) if (!o.is_buy_order && o.location_id === C.jita.station && (ref == null || o.price < ref)) ref = o.price;
        market.set(e[0], L.sellAt(lootHubs, hb => S.lootBooks.get(hb.region + ':' + e[0]), e[1], { ref: ref || S.prices.get(e[0]) || null, refStation: ref ? C.jita.station : null, share: C.loot.share, days: C.loot.days,
          perDay: hb => { const v = S.lootVol.get(hb.region + ':' + e[0]); return v == null ? null : v; } }));
      }
      const places = new Map();
      for (const a of S.scout.assets) {
        const w = S.scout.where.get(a.item_id), kd = S.scout.kinds.get(a.type_id);
        if (!w || !kd) continue;
        const hold = /Gas/.test(w.flag) ? ' gas hold' : /Ore/.test(w.flag) ? ' ore hold' : /Fleet/.test(w.flag) ? ' fleet hangar' : /Cargo/.test(w.flag) ? ' cargo' : '';
        const label = (S.scout.placeNames[w.top] || 'Unknown place') + (w.holder ? ', in ' + nameOf(w.holder) + hold : '');
        const p = places.get(label) || { name: label, top: w.top, rows: new Map(), value: 0, m3: 0 };
        const row = p.rows.get(a.type_id) || { type: a.type_id, name: nameOf(a.type_id), kind: kd.kind, group: kd.group, qty: 0, sell: 0, m3: 0, value: 0 };
        const val = a.is_blueprint_copy ? 0 : (S.prices.get(a.type_id) || 0) * a.quantity, vol = ((K.types[a.type_id] || {}).v || 0) * a.quantity;
        row.qty += a.quantity; row.m3 += vol; row.value += val; p.value += val; p.m3 += vol;
        if (!a.is_blueprint_copy) row.sell += a.quantity;
        p.rows.set(a.type_id, row); places.set(label, p);
      }
      const NOW = 1 - C.fees.salesTax, worth = r => (r.list ? r.list.value : r.now ? r.now.value : r.value);
      scout.loot = Array.from(places.values()).map(p => {
        const rows = Array.from(p.rows.values());
        for (const r of rows) {
          const mk = market.get(r.type), all = sellQty.get(r.type) || 0;
          const lh = mk && mk.list ? mk.hubs.find(x => x.name === mk.list) : null, nh = mk && mk.now ? mk.hubs.find(x => x.name === mk.now) : null;
          r.hubs = mk ? mk.hubs : [];
          r.list = lh && r.sell ? { hub: lh.name, value: r.sell * lh.fair * NET, days: lh.days, slow: lh.slow } : null;
          r.now = nh && r.sell && all ? { hub: nh.name, value: nh.now * (r.sell / all) * NOW, filled: nh.filled, of: all } : null;
        }
        return Object.assign(p, { rows: rows.sort((x, y) => worth(y) - worth(x)), list: sum(rows, r => (r.list ? r.list.value : 0)), now: sum(rows, r => (r.now ? r.now.value : 0)), jumps: S.lootJumps[p.top] || null });
      }).sort((x, y) => (y.list || y.value) - (x.list || x.value));
      // the whole pile taken to one hub, and each item taken to its best hub
      const units = sum(Array.from(sellQty.values()), q => q);
      scout.sell = {
        ready: S.lootBooks.size > 0, types: sellQty.size, units,
        hubs: lootHubs.map(hb => {
          let list = 0, now = 0, noAsk = 0, slow = 0, filled = 0;
          for (const e of sellQty) {
            const x = market.get(e[0]).hubs.find(y => y.station === hb.station);
            if (x.ask != null) { list += e[1] * x.fair * NET; if (x.slow) slow++; } else noAsk++;
            now += x.now * NOW; filled += x.filled;
          }
          return { name: hb.name, station: hb.station, list, now, noAsk, slow, filled };
        }),
        split: { list: sum(scout.loot, p => p.list), now: sum(scout.loot, p => p.now) },
      };
    }

    const sellHub = C.hubs.find(x => x.station === C.pi.sellStation) || C.hubs[0];
    const colonies = S.planets.filter(p => p.product && p.units).map(p => {
      const asks = C.hubs.map(hb => ask(p.product, hb));
      const price = ask(p.product, sellHub);
      return Object.assign({}, p, { productName: nameOf(p.product), asks, price, best: Math.max.apply(null, asks.map(x => x || 0)),
        listedUnits: listedByType.get(p.product) || 0, value: price != null ? p.units[0] * price : null });
    });
    const series = [0, 1, 2, 3, 4, 5, 6, 7].map(d => sum(colonies, c => (c.price || 0) * c.units[d]));
    const reach = series.findIndex(v => v >= C.pi.worth);
    const pi = !colonies.length ? null : {
      colonies, series, value: series[0], perDay: series[1] - series[0], reach,
      units: sum(colonies, c => c.units[0]), m3: sum(colonies, c => c.units[0] * c.volume),
      full: Math.max.apply(null, colonies.map(c => c.fill)), near: S.piNear, from: S.piFrom,
      system: (K.systems[colonies[0].system] || {}).name || 'the colonies', sellName: sellHub.name,
      stopped: colonies.filter(c => c.expiry != null && c.expiry < now).length,
    };
    if (pi) pi.go = pi.full >= 0.85 ? 'full' : pi.value >= C.pi.worth ? 'worth' : 'wait';

    // ---- restock: lines that sold out this week with nothing listed there now
    for (const e of soldOut(now)) {
      const p = e[0].split(':').map(Number);
      consider(p[1], p[0], 0, e[1], ask(p[1], hubOf.get(p[0])));
    }
    restock.sort((a, b) => (a.thin - b.thin) || a.days - b.days || (b.net || 0) * b.perDay - (a.net || 0) * a.perDay);

    // ---- haul manifest: what is waiting in the Jita hangar and where each item sells
    /** Where units of an item go: a hub where you sold it this week, else its plan (shared out by pace, a thin listing not counted), else the highest ask. */
    const destOf = (type, qty, unit) => {
      const asks = away.map(hb => ({ name: hb.name, ask: ask(type, hb), sold: (vel.get(type + ':' + hb.station) || {}).d7 || 0 }));
      const proven = asks.filter(a => a.ask != null && a.sold > 0);
      const pool = proven.length ? proven : asks.filter(a => a.ask != null);
      const top = pool.length ? pool.reduce((a, b) => (b.ask > a.ask ? b : a)) : null;
      const g = planFor(type, unit || 0, 0);
      // A line you have not sold this week goes where its plan says, shared out by pace, and not simply to the highest ask (which may be one thin listing).
      const planned = !proven.length && g.hubs.length ? g : null;
      for (const a of asks) { const rd = g.read.find(x => x.name === a.name); a.thin = !!(rd && rd.thin); a.counts = rd && rd.thin ? rd.price : null; }
      return { asks, best: planned ? planned.hubs[0].name : top ? top.name : null,
        split: planned && planned.state === 'ok' && planned.hubs.length > 1 ? L.splitUnits(qty, planned.hubs) : null, under: !!planned && planned.state === 'under', fresh: !!planned && !planned.sold };
    };
    /** What to list units of an item at in a hub, by the same judgement as the Call column: follow your order for it there if you have one, else the book. */
    const listAt = (type, qty, hb) => {
      const st = list.find(x => x.id === hb.station), front = ask(type, hb), c = costFor(type, qty, hb.station), js = jitaSell(type);
      const mine = st ? st.sells.filter(r => r.type === type && r.plan.action !== 'none').sort((a, b) => a.price - b.price)[0] : null;
      let price = null, why = 'no one is selling it here', soft = false;
      if (mine && mine.plan.action === 'tick') { price = mine.plan.target; why = 'the price your order here should move to'; }
      else if (mine && mine.plan.action === 'optional') { price = mine.plan.target; soft = true; why = { big: 'big move on your order here: your call', sniper: 'sniper under your order here: your call', slow: 'slow line here: your call' }[mine.plan.kind] || 'your call'; }
      else if (mine && mine.pos && mine.pos.status === 'leading') { price = mine.price; why = 'matches your order here'; }
      else if (mine) why = String(mine.plan.reason || 'Hold.').replace(/\.$/, '').replace(/^./, x => x.toLowerCase());
      else if (front != null && c && front * NET <= c.cost) why = 'front is below your cost';
      else if (front != null && hb.station !== C.jita.station && js != null && front <= js) why = 'front is at or below the Jita sell price';
      else if (front != null && c && c.cost > 0 && L.tickBelow(front) * NET - c.cost < R.floor * c.cost) why = 'one step under the front nets under ' + Math.round(R.floor * 100) + '%; your floor is ' + L.isk(L.tickCeil(c.cost * (1 + R.floor) / NET));
      else if (front != null) { price = L.tickBelow(front); why = 'front is ' + L.isk(front); }
      const net = price != null && c ? price * NET - c.cost : null;
      const mk = S.copied['g' + type + ':' + hb.station];
      return { price, net, soft, why, margin: net != null && c.cost > 0 ? net / c.cost : null,
        copied: mk && !mk.gone ? { state: 'waiting', price: mk.price, at: mk.at, moved: price != null && mk.price !== price } : null };
    };
    const haulRows = Array.from(jitaHang, e => {
      const c = costFor(e[0], e[1]), unit = c ? c.cost : null, d = destOf(e[0], e[1], unit);
      // where its units go, and what to list them at there (the same price the cargo hold will offer once they are aboard)
      const parts = d.split || (d.best ? [{ name: d.best, units: e[1] }] : []), listing = {};
      for (const p of parts) { const hb = away.find(x => x.name === p.name); if (hb) listing[p.name] = listAt(e[0], e[1], hb); }
      return { type: e[0], name: nameOf(e[0]), qty: e[1], each: (K.types[e[0]] || {}).v || 0, m3: e[1] * ((K.types[e[0]] || {}).v || 0), asks: d.asks, best: d.best, split: d.split, under: d.under, fresh: d.fresh, parts, list: listing,
        unit, value: unit != null ? unit * e[1] : null, floor: unit > 0 ? L.tickCeil(unit * (1 + R.floor) / NET) : null, status: statusOf(e[0]).state, thinLine: statusOf(e[0]).thin };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const haul = { rows: haulRows, units: sum(haulRows, r => r.qty), m3: sum(haulRows, r => r.m3), cargo: S.cargo, value: sum(haulRows, r => r.value || 0), unpriced: haulRows.filter(r => r.value == null).length, cap: lim.trip };

    // ---- cargo hold: what is in the ship now, where each item is to be listed, and what to list it at in each hub.
    // The load keeps the plan it came aboard with (the manifest's), counted down as it is listed, so the hold empties over the stops.
    const inHold = cargoHold(), shipId = S.ship ? S.ship.ship_item_id : null, hubAt = new Map(C.hubs.map(hb => [hb.station, hb.name]));
    const dockedHub = S.loc ? hubAt.get(S.loc.station_id || S.loc.structure_id) || null : null;
    const loadWas = S.load && S.load.ship === shipId ? S.load.t : {}, loadNow = {};
    const holdRows = Array.from(inHold, e => {
      const cu = costFor(e[0], e[1]), d = destOf(e[0], e[1], cu ? cu.cost : null), asks = d.asks;
      const step = L.loadStep(loadWas[e[0]] || null, { qty: e[1], here: dockedHub,
        orders: S.orders.filter(o => !o.is_buy_order && o.type_id === e[0] && hubAt.has(o.location_id)).map(o => ({ id: o.order_id, hub: hubAt.get(o.location_id), units: o.volume_total })),
        split: n => { const dn = n === e[1] ? d : destOf(e[0], n, cu ? cu.cost : null); return dn.split || (dn.best ? [{ name: dn.best, units: n }] : []); } });
      loadNow[e[0]] = step.entry;
      const left = step.left.filter(x => x.name), best = left.length ? { name: (left.find(x => x.name === dockedHub) || left[0]).name } : null;
      const listing = {};
      for (const hb of C.hubs) listing[hb.station] = listAt(e[0], e[1], hb);
      const c0 = costFor(e[0], e[1]);
      return { type: e[0], name: nameOf(e[0]), qty: e[1], m3: e[1] * ((K.types[e[0]] || {}).v || 0), asks, best: best ? best.name : null, left, waiting: step.waiting, list: listing, value: c0 ? c0.cost * e[1] : null };
    }).sort((a, b) => a.name.localeCompare(b.name));
    // kept on this device; left alone while the hangars have not loaded or another ship is being flown with nothing aboard
    // and not fixed until the books, the price history and your orders are in, or a plan would be made from half the picture
    const settled = !!S.settled && ['Hangars', 'Your orders', 'Market books'].every(f => (S.feeds[f] || {}).at);
    if (settled && shipId != null && (inHold.size || (S.load && S.load.ship === shipId))) {
      const next = { ship: shipId, t: loadNow };
      if (L.stable(next) !== L.stable(S.load)) { S.load = next; if (!demo) E.store.set('eveops.load', next); }
    }
    const unitM3 = t => (K.types[t] || {}).v || 0, holdBy = new Map();
    for (const r of holdRows) for (const x of r.left) { const b = holdBy.get(x.name) || { name: x.name, units: 0, m3: 0, items: 0 }; b.units += x.units; b.m3 += x.units * unitM3(r.type); b.items++; holdBy.set(x.name, b); }
    const hold = { by: away.map(hb => holdBy.get(hb.name)).filter(Boolean), nowhere: holdRows.filter(r => !r.left.length && !r.waiting).length, rows: holdRows, units: sum(holdRows, r => r.qty), m3: sum(holdRows, r => r.m3), at: (S.feeds.Hangars || {}).at || 0, ship: S.ship ? nameOf(S.ship.ship_type_id) : '', value: sum(holdRows, r => r.value || 0), unpriced: holdRows.filter(r => r.value == null).length, cap: lim.trip };

    // ---- load list: the hubs picked on the manifest, and what to take out of the Jita hangar for them, fitted to the room left in the hold
    const haulTo = away.map(hb => hb.name).filter(n => S.haulTo.indexOf(n) >= 0);
    haul.hubs = away.map(hb => { const rows = haulRows.filter(r => r.parts.some(p => p.name === hb.name)); return { name: hb.name, on: haulTo.indexOf(hb.name) >= 0, lines: rows.length, m3: sum(rows, r => r.each * sum(r.parts.filter(p => p.name === hb.name), p => p.units)) }; });
    haul.nowhere = haulRows.filter(r => !r.parts.length).length;
    if (haulTo.length) {
      const lines = haulRows.map(r => {
        const mine = r.parts.filter(p => haulTo.indexOf(p.name) >= 0), units = sum(mine, p => p.units);
        // what a unit should bring at its hub: the list price there, or what the item trades at where the front is a thin listing
        const gainAt = p => { const a = r.asks.find(x => x.name === p.name), at = r.list[p.name]; return a && a.thin && r.unit != null ? a.counts * NET - r.unit : at ? at.net : null; };
        const priced = mine.filter(p => gainAt(p) != null), n = sum(priced, p => p.units);
        return { row: r, parts: mine, units, m3: r.each, cost: r.unit, gain: n ? sum(priced, p => p.units * gainAt(p)) / n : null };
      }).filter(x => x.units > 0);
      const room = Math.max(0, S.cargo - hold.m3), fit = L.loadFit(lines, room, Math.max(0, lim.trip - hold.value));
      haul.load = { to: haulTo, room, aboard: hold.m3, m3: fit.m3, value: fit.value, units: fit.units, left: fit.left, want: sum(lines, x => x.units * x.m3), other: haulRows.length - lines.length,
        rows: fit.rows.map(f => Object.assign({}, lines[f.i], f)) };
    } else haul.load = null;

    // ---- exposure: every committed ISK by the hub it is headed for, against the limits
    const exLines = [];
    for (const st of list) {
      for (const r of st.bids) exLines.push({ isk: r.escrow, proven: r.status === 'proven', hubs: r.guard && r.guard.hubs.length ? r.guard.hubs : null });
      for (const r of st.sells) if (!(r.pos && r.pos.status === 'gone')) exLines.push({ isk: r.cost != null ? r.cost * r.remain : 0, proven: r.status === 'proven', hubs: [{ name: st.short, share: 1 }] });
      if (st.id !== C.jita.station) for (const x of st.hangar) { const c = costFor(x.type, x.qty, st.id); exLines.push({ isk: c ? c.cost * x.qty : 0, proven: statusOf(x.type).state === 'proven', hubs: [{ name: st.short, share: 1 }] }); }
    }
    for (const r of haulRows) exLines.push({ isk: r.value || 0, proven: r.status === 'proven', hubs: r.split ? r.split.map(sp => ({ name: sp.name, share: sp.units / r.qty })) : r.best ? [{ name: r.best, share: 1 }] : null });
    for (const r of holdRows) { const n = sum(r.left, x => x.units); exLines.push({ isk: r.value || 0, proven: statusOf(r.type).state === 'proven', hubs: n ? r.left.map(x => ({ name: x.name, share: x.units / n })) : null }); }
    const risk = { ex: L.exposure(exLines, S.wallet, lim), lim, bumps: (S.weeks.w[L.weekKey(now)] || {}).bumps || { n: 0, fee: 0 }, changeNow: { n: sum(list, st => st.change), fee: sum(list, st => st.changeFee) } };

    // ---- trip plan: the hubs with something to do, in the order that takes the fewest jumps
    const trip = (() => {
      if (!S.loc || !list.length) return null;
      const jita = C.jita.station, byName = new Map(C.hubs.map(hb => [hb.name, hb.station]));
      const drops = new Map();
      for (const r of haulRows) for (const part of r.split || [{ name: r.best, units: r.qty }]) { const to = byName.get(part.name); if (to && to !== jita) drops.set(to, (drops.get(to) || 0) + part.units); }
      const lists = new Map();                              // already in the hold: units to list at each hub, by the plan the load came aboard with
      for (const r of holdRows) for (const x of r.left) { const to = byName.get(x.name); if (to) lists.set(to, (lists.get(to) || 0) + x.units); }
      const bids = restock.slice(0, 12).filter(r => r.bid != null && r.want && !r.thin && !r.probation).length;
      const viaJita = haulRows.length > 0 && list.some(s => s.id === jita) && !S.tripSkip.has(String(jita));
      // what there is to do at a hub, each with a tone so the plan can be read by colour
      const jobsAt = s => {
        const jobs = [];
        if (s.check) jobs.push({ kind: 'check', tone: 'bad', n: s.check, text: 'to check' });
        if (s.change) jobs.push({ kind: 'change', tone: 'warn', n: s.change, text: 'to change' });
        if (s.optional) jobs.push({ kind: 'call', tone: 'dim', n: s.optional, text: 'your call' });
        if (s.id === jita && haulRows.length) jobs.push({ kind: 'pickup', tone: 'calm', pre: 'pick up', n: haul.units });
        if (s.id === jita && bids) jobs.push({ kind: 'bids', tone: 'ink', n: bids, text: bids === 1 ? 'bid to place' : 'bids to place' });
        if (lists.has(s.id)) jobs.push({ kind: 'list', tone: 'calm', pre: 'list', n: lists.get(s.id), text: 'from cargo' });
        if (viaJita && drops.has(s.id)) jobs.push({ kind: 'drop', tone: 'calm', pre: 'drop off', n: drops.get(s.id) });
        if (pi && pi.near && isFinite(pi.near.jumps) && pi.near.station === s.id && pi.go !== 'wait') jobs.push({ kind: 'pi', tone: 'lead', text: 'planetary pickup' });
        return jobs;
      };
      // One visit per hub, except the hub you are docked in when stock for it is still in Jita: its orders are done now, the drop on the way back.
      const withWork = [];
      for (const st of list) {
        const jobs = jobsAt(st), drop = jobs.find(x => x.kind === 'drop') || null;
        if (drop && st.docked && jobs.length > 1) {
          withWork.push({ key: String(st.id), s: st, jobs: jobs.filter(x => x !== drop) });
          withWork.push({ key: st.id + ':drop', s: st, jobs: [drop], again: true });
        } else if (jobs.length) withWork.push({ key: drop ? st.id + ':drop' : String(st.id), s: st, jobs });
      }
      const wanted = withWork.filter(x => !S.tripSkip.has(x.key));          // a visit is left out by its own key, so a return visit can go while the first stays
      if (wanted.length > 1 && !Object.keys(S.legs).length) return null;          // hub-to-hub routes are still loading
      const idOf = key => (key === 'start' ? key : Number(String(key).split(':')[0]));
      const path = (a, b) => {                       // system by system, in travel order
        a = idOf(a); b = idOf(b);
        if (a === b) return [hop(list.find(x => x.id === b).system)];
        if (a === 'start') { const st = list.find(x => x.id === b); return st.docked ? [hop(st.system)] : (S.tripSafe && st.safeRoute) || st.shortRoute; }
        const fwd = S.legs[a + ':' + b], back = S.legs[b + ':' + a], leg = fwd || back;
        const ids = leg ? (S.tripSafe && leg.safe) || leg.short : null;
        return ids ? (fwd ? ids : ids.slice().reverse()).map(hop) : null;
      };
      const dist = (a, b) => { const hops = path(a, b); return hops ? hops.length - 1 : null; };
      const going = wanted.filter(x => dist('start', x.key) != null), lost = wanted.filter(x => going.indexOf(x) < 0);     // no route from here: left out and named
      const plan = going.length ? L.tripPlan(going.map(x => x.key), dist, going.filter(x => /:drop$/.test(x.key)).map(x => [String(jita), x.key])) : null;
      const stopsOut = plan ? plan.order.map((key, i) => {
        const x = going.find(g => g.key === key), hops = path(i ? plan.order[i - 1] : 'start', key) || [];
        return { id: x.s.id, key: x.key, short: x.s.short, jobs: x.jobs, here: x.s.docked && i === 0, again: !!x.again, jumps: plan.legs[i], hops: hops.slice(1), hot: hops.slice(1).filter(y => y.ship + y.pod > 0).length };
      }) : [];
      return {
        stops: stopsOut, total: plan ? plan.total : 0, safe: S.tripSafe, stuck: going.length > 0 && !plan,
        skipped: withWork.filter(x => S.tripSkip.has(x.key)).map(x => ({ key: x.key, short: x.s.short + (x.again ? ' again' : '') })),
        lost: Array.from(new Set(lost.map(x => x.s.short))),
        idle: list.filter(st => !withWork.some(x => x.s === st)).map(st => st.short),
      };
    })();

    // ---- weekly closes: each finished week's figures are fixed the first time they are seen complete, so they outlast EVE's history
    const closes = (() => {
      const W = S.weeks, cur = L.startOfWeek(now), curKey = L.weekKey(cur);
      const txAt = (S.feeds['Sales and purchases'] || {}).at || 0, jAt = (S.feeds['Wallet journal'] || {}).at || 0;
      const basis = S.costs ? S.costs.at || 0 : 0;
      let changed = false;
      const first = led.from == null ? cur : L.startOfWeek(led.from) < led.from ? L.weekAfter(L.startOfWeek(led.from)) : L.startOfWeek(led.from);
      const starts = new Set(Object.keys(W.w).map(L.weekStart));
      for (let ws = first; ws <= cur; ws = L.weekAfter(ws)) starts.add(ws);
      starts.add(cur);
      // this week: note the wallet and the ISK in buy orders as last seen, which is what the close will show for them
      const c = W.w[curKey] || (W.w[curKey] = {});
      if (S.wallet != null && S.books.size && (c.escrow !== escrow || c.wallet !== S.wallet) && now - (c.seenAt || 0) > 15 * 60000) { c.escrow = escrow; c.wallet = S.wallet; c.seenAt = now; changed = true; }
      const rows = [];
      for (const ws of Array.from(starts).sort((a, b) => a - b)) {
        const we = L.weekAfter(ws), key = L.weekKey(ws), closed = we <= now;
        let rec = W.w[key] || {};
        // fixed once closed; worked out again only when newer tracker costs arrive and EVE's history still holds the whole week
        if (!rec.frozenAt || (((rec.basis || 0) < basis || (rec.rules || 1) < C.ledgerRules) && led.from != null && led.from <= ws)) {
          const sm = L.summarize(led.sales, ws, we), fig = { gross: sm.gross, units: sm.units, net: sm.net, uncovered: sm.uncovered, borrowed: sm.borrowed, basis, rules: C.ledgerRules, gaps: L.uncosted(led.sales, ws, we).slice(0, 6).map(g => [g.type, g.units]) };
          if (closed && txAt >= we) { rec = W.w[key] = Object.assign({}, rec, fig, { frozenAt: now }); changed = true; }
          else rec = Object.assign({}, rec, fig);
        }
        const j = S.journal ? L.journalSpan(S.journal, ws, we) : null;
        const exact = j && j.covered && (!closed || jAt >= we) ? { fees: j.broker + j.tax, change: j.change, close: closed ? j.close : null } : null;
        if (exact && closed && rec.frozenAt && rec.close == null && exact.close != null) { Object.assign(W.w[key], exact); rec = W.w[key]; changed = true; }
        const src = rec.close != null ? rec : exact || {};
        rows.push({
          key, start: ws, end: we, closed, gross: rec.gross, units: rec.units, net: rec.net, uncovered: rec.uncovered || 0, gaps: rec.gaps || [], borrowed: rec.borrowed || 0, stale: !!rec.frozenAt && (rec.basis || 0) < basis,
          fees: src.fees != null ? src.fees : null, change: src.change != null ? src.change : null,
          close: closed ? (src.close != null ? src.close : rec.wallet != null ? rec.wallet : null) : S.wallet, closeSeen: closed && src.close == null && rec.wallet != null ? rec.seenAt : null,
          escrow: closed ? (rec.escrow != null ? rec.escrow : null) : escrow, escrowSeen: closed ? rec.seenAt || null : null,
          tracker: rec.tracker && rec.tracker.v != null ? rec.tracker.v : null,
          // set to the tracker's figure: a finished week whose sales the page cannot cost counts at what the ledger recorded
          locked: closed && !!(rec.lock && rec.lock.on) && !!rec.tracker && rec.tracker.v != null,
        });
      }
      if (changed) saveWeeks(true);
      const done = rows.filter(r => r.closed), tie = L.tieOut(done, C.tieOut.within);
      done.forEach((r, i) => { r.diff = tie.rows[i].diff; r.tied = tie.rows[i].tied; });
      const carried = W.carried && W.carried.v != null ? W.carried.v : null;
      return { rows: rows.slice().reverse(), since: rows.length ? rows[0].start : cur, carried, toDate: (carried || 0) + sum(rows, r => (r.locked ? r.tracker : r.net) || 0), run: tie.run, need: C.tieOut.weeks, journal: !!S.journal,
        costs: S.costs && S.costs.rows && S.costs.rows.length ? { at: S.costs.at, lines: S.costs.rows.length, items: new Set(S.costs.rows.map(r => r.t)).size, net: S.costs.net, unknown: S.costs.unknown || [] } : null };
    })();

    // ---- alerts: what the Android app may notify about. One entry per thing, with an id that stays the same while it lasts.
    const alerts = [];
    for (const st of list) for (const r of st.sells.concat(st.bids)) {
      const inHand = (r.pin && !r.pin.done) || (r.copied && r.copied.state === 'waiting' && !r.copied.moved);     // pinned or just copied: already being dealt with
      if (r.plan.action === 'tick' && !inHand) alerts.push({ id: 'c' + r.id, kind: 'change', text: st.short + ': ' + r.name });
    }
    for (const p of S.planets) {
      if (p.extractors && p.expiry > 0 && p.expiry < now) alerts.push({ id: 'x' + p.id + ':' + p.expiry, kind: 'extractors', text: p.name });
      if (p.fill >= 0.85) alerts.push({ id: 'f' + p.id, kind: 'launchpad', text: p.name + ' at ' + Math.round(p.fill * 100) + '%' });
    }

    // ---- what changed since the baseline ("Mark as seen")
    const snapshot = {};
    for (const st of list) for (const r of st.sells.concat(st.bids)) snapshot[r.id] = { t: r.type, l: st.id, b: st.bids.indexOf(r) >= 0, s: r.pos ? r.pos.status : '' };
    if (!S.seen && Object.keys(snapshot).length && S.books.size) { S.seen = { at: now - D, orders: snapshot, auto: true }; if (!demo) E.store.set('eveops.seen', S.seen); }
    const changes = [];
    if (S.seen) {
      const groupsTx = new Map();
      for (const t of S.tx) {
        const when = Date.parse(t.date);
        if (when <= S.seen.at || C.excludeTypes.indexOf(t.type_id) >= 0) continue;
        const k = (t.is_buy ? 'b' : 's') + ':' + t.location_id + ':' + t.type_id;
        const g = groupsTx.get(k) || { buy: t.is_buy, loc: t.location_id, type: t.type_id, qty: 0, isk: 0, at: 0, net: null };
        g.qty += t.quantity; g.isk += t.quantity * t.unit_price; g.at = Math.max(g.at, when);
        groupsTx.set(k, g);
      }
      for (const x of led.sales) {
        const g = x.date > S.seen.at && x.net != null ? groupsTx.get('s:' + x.location_id + ':' + x.type_id) : null;
        if (g) g.net = (g.net || 0) + x.net;
      }
      for (const g of groupsTx.values()) changes.push({ rank: 2, at: g.at, type: g.type, tone: g.buy ? 'calm' : 'lead',
        text: (g.buy ? 'Bought ' : 'Sold ') + num(g.qty) + ' ' + nameOf(g.type) + ' at ' + hubName(g.loc) + ' for ' + L.short(g.isk),
        sub: g.buy ? null : g.net != null ? 'net ' + L.short(g.net) : 'no cost on record' });
      const closed = new Map(S.history.map(o => [o.order_id, o]));
      for (const id of Object.keys(S.seen.orders)) {
        const was = S.seen.orders[id], cur = snapshot[id];
        if (!cur) {
          const gone = closed.get(Number(id));
          const what = !gone ? 'Closed' : gone.volume_remain === 0 ? (was.b ? 'Bid filled' : 'Sold out') : gone.state === 'cancelled' ? 'Cancelled' : 'Expired with ' + num(gone.volume_remain) + ' left';
          changes.push({ rank: /Expired/.test(what) ? 0 : 1, at: 0, type: was.t, tone: /Expired/.test(what) ? 'bad' : 'lead', text: what + ': ' + nameOf(was.t) + ' at ' + hubName(was.l), sub: gone ? num(gone.volume_total) + '-unit order' : null });
        } else if (was.s === 'leading' && (cur.s === 'undercut' || cur.s === 'behind' || cur.s === 'outbid')) {
          changes.push({ rank: 0, at: 0, type: was.t, tone: 'warn', text: (cur.b ? 'Outbid: ' : 'Undercut: ') + nameOf(was.t) + ' at ' + hubName(was.l), sub: 'was leading when you last looked' });
        }
      }
      changes.sort((a, b) => a.rank - b.rank || b.at - a.at);
    }

    // which hub tab is showing: follow the character on arrival, otherwise leave the choice alone
    const at = list.find(s => s.docked) || list.find(s => s.inSystem);
    if (S.follow && at) { S.tab = at.id; S.follow = false; }
    if (!list.some(s => s.id === S.tab)) S.tab = list.length ? (at || list[0]).id : null;

    return {
      now, stops: list, slow: slow.slice(0, 8), tab: S.tab, pi,
      restock: restock.slice(0, 12), haul, hold, trip, closes, alerts, changes, snapshot, seenAt: S.seen ? S.seen.at : null, risk,
      wallet: S.wallet, escrow, bidCount, listed, listedCost, uncosted, held, wealth, priced: S.prices.size > 0, scout, both: wealth != null && scout ? wealth + scout.wealth : null,
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
  /** Puts a price on the clipboard. With a key (an order, or a restock line) the press is also marked, so the row shows it has been done. */
  function copy(btn, price, key) {
    const done = () => {
      if (key == null) { btn.classList.add('is-copied'); return setTimeout(() => btn.classList.remove('is-copied'), 1400); }
      S.copied[key] = { price, at: Date.now() };
      saveMarks();
      const again = root.querySelector('[data-copy="' + key + '"]');
      if (again) again.focus({ preventScroll: true });
    };
    if (E.native) { E.tell('copy', { text: String(price) }); return done(); }     // in the Android app, the app fills the clipboard
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(String(price)).then(done, () => {});
  }
  function saveMarks() { if (!demo) E.store.set('eveops.copied', S.copied); syncSoon(); paint(); }
  function unmark(keys) { const at = Date.now(); keys.forEach(k => { S.copied[k] = { gone: true, at }; }); saveMarks(); }
  const hhmm = ms => new Date(ms).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false });
  /**
   * The price button and, once pressed, its mark. The mark adds no line: the time sits on the button's top border
   * (press it to remove the mark), the button goes quiet with a tick while that is still the price to type,
   * and anything that needs words (not in the book, book moved) is said in the Call column by markWhy.
   */
  function priceMark(key, price, mark, soft) {
    const held = mark && mark.state === 'waiting' && !mark.moved;
    const btn = h('button', { class: 'price' + (soft ? ' is-soft' : '') + (held ? ' is-done' : ''), type: 'button', 'data-copy': key, title: (held ? 'Copy again: ' : 'Copy ') + price, onclick: e => copy(e.currentTarget, price, key) }, L.isk(price));
    if (!mark || mark.state === 'landed') return btn;
    const said = markSaid(mark);
    const tag = h('button', { class: 'tag' + (held ? (mark.last ? ' is-last' : '') : ' is-warn'), type: 'button', title: (said || 'Copied ' + hhmm(mark.at) + '.') + ' Press to remove the mark.', 'aria-label': 'Remove the copied mark', onclick: () => unmark([key]) },
      (held && mark.last ? 'Last ' : '') + hhmm(mark.at), h('span', { class: 'x', 'aria-hidden': 'true' }, '\u00d7'));
    return h('span', { class: 'pm' }, btn, tag);
  }
  function markSaid(mark) {
    if (!mark || mark.state === 'landed') return null;
    if (mark.state === 'missed') return 'Copied ' + hhmm(mark.at) + ' but not in the book.';
    return mark.moved ? 'Copied ' + L.isk(mark.price) + ' at ' + hhmm(mark.at) + '; the book has moved.' : null;
  }
  const markWhy = r => { const t = markSaid(r.copied); return t && h('span', { class: 'why' + (r.copied.state === 'missed' ? ' why-warn' : '') }, t); };
  function C_(cls, label) { const el = h('div', { class: 'c ' + cls, 'data-label': label }); for (let i = 2; i < arguments.length; i++) add(el, arguments[i]); return el; }

  /** The Call column keeps to two lines where the rows are a table, so every row is the same height. The whole of it shows on hover, and stays open after a press. */
  function callCell(r, kind) {
    const el = callParts(r, kind);
    el.title = Array.from(el.childNodes, n => n.textContent.trim()).filter(Boolean).join(' \u00b7 ');
    if (S.openCalls.has(r.id)) el.classList.add('is-open');
    el.addEventListener('click', () => { if (!S.openCalls.delete(r.id)) S.openCalls.add(r.id); paint(); });
    return el;
  }
  function callParts(r, kind) {
    if (r.pin && !r.pin.done) {
      const moved = r.plan.action === 'tick' && r.plan.target != null && (kind === 'sell' ? r.plan.target < r.pin.price : r.plan.target > r.pin.price);
      return C_('call', 'Call', h('span', { class: 'chip chip-pin' }, 'Pinned'),
        h('span', { class: 'why' }, moved ? 'The book has moved since: now ' + L.isk(r.plan.target) + '.' : 'Waiting to see it in the book, up to 5 min.'), markWhy(r));
    }
    const done = (r.pin && r.pin.done) || (r.copied && r.copied.state === 'landed');
    const lead = r.pos && r.pos.status === 'leading';
    const big = r.plan.kind === 'big', slow = r.plan.kind === 'slow';
    const guard = r.plan.kind === 'over' || r.plan.kind === 'pull' ? r.plan.kind : null;      // a bid held to its max, or one that no longer pays
    const label = { tick: 'Change', optional: big ? 'Big move' : slow ? 'Slow line' : 'Sniper', wait: 'Loading', none: 'Gone', hold: guard === 'over' ? 'Over max' : guard === 'pull' ? 'Pull' : lead ? (kind === 'sell' ? 'Leading' : 'Top bid') : 'Hold' }[r.plan.action];
    const cls = { tick: 'chip-go', optional: big ? 'chip-big' : 'chip-opt', wait: 'chip-wait', none: 'chip-gone', hold: guard === 'pull' ? 'chip-pull' : guard ? 'chip-hold' : lead ? 'chip-lead' : 'chip-hold' }[r.plan.action];
    const depthShown = r.pos && r.plan.action === 'tick' && r.plan.kind !== 'mismatch' && (r.pos.status === 'undercut' || r.pos.status === 'behind' || r.pos.status === 'outbid');
    const why = r.plan.action === 'hold' && lead && !guard ? null
      : r.plan.action === 'tick' ? (depthShown ? '' : r.plan.reason + ' ') + (r.plan.fee ? 'Changing costs ' + L.short(r.plan.fee) + '.' : '')
      : String(r.plan.reason || '').replace(/^Sniper: (.)/, (x, c) => c.toUpperCase()) + (slow && r.plan.fee ? ' Changing costs ' + L.short(r.plan.fee) + '.' : '');
    const soon = r.expires - Date.now() < 3 * D;
    let read = null;
    if (big && r.week && r.pos && r.pos.front != null) {
      read = 'Week average ' + L.isk(Math.round(r.week.price)) + ' on ' + num(Math.round(r.week.perDay)) + ' a day: '
        + { dump: 'looks like a dump.', repricing: 'the market has moved.', unclear: 'could be either.' }[L.moveRead(r.pos.front, r.week.price)];
    }
    return C_('call', 'Call',
      r.checks.length ? h('span', { class: 'chip chip-check' }, 'Check') : null,
      h('span', { class: 'chip ' + cls }, label), done && h('span', { class: 'chip chip-done' }, 'Changed'),
      soon && r.plan.action !== 'none' && h('span', { class: 'chip chip-opt' }, 'Expires ', live('until', r.expires)),
      r.checks.length ? h('span', { class: 'why why-check' }, r.checks.join(' ')) : null,
      why && h('span', { class: 'why' }, read ? why.replace(' Dump or repricing: your call.', '') + ' ' + read : why), markWhy(r));
  }
  function typeCell(r) {
    if (r.typed == null) return C_('type', 'Type this', h('span', { class: 'none' }, (r.pin && r.pin.done) || (r.copied && r.copied.state === 'landed') ? 'Done' : ''));
    return C_('type', 'Type this', priceMark(r.id, r.typed, r.copied, r.plan.action === 'optional' && !r.pin));
  }
  const rowClass = r => 'row is-' + r.plan.action + (r.pin && !r.pin.done ? ' is-pinned' : '') + (r.typed != null && r.copied && r.copied.state === 'waiting' && !r.copied.moved ? ' is-copied' + (r.copied.last ? ' is-last' : '') : '');
  function itemCell(r) {
    const fresh = r.status === 'drop' ? ['Drop', r.thinLine ? 'Two weeks on, and what it has sold netted under ' + Math.round(C.risk.floor * 100) + '% on what you paid: clear any stock and drop the line, or bid again only at a cost that mends the margin.'
        : 'Two weeks on, or never sold, and under half of its first lot gone: clear the stock and drop the line.']
      : r.status === 'probation' ? ['On probation', 'Selling, but under half of its first lot has gone yet: no re-bid until it has.']
      : r.status === 'new' ? ['New line', 'Nothing sold yet: no re-bid until half of its first lot has gone.'] : null;
    return C_('item', 'Item', icon(r.type), h('span', { class: 'name' }, r.name, r.twin && h('span', { class: 'twin' }, num(r.total) + '-unit order'),
      fresh && h('span', { class: 'fresh' + (r.status === 'drop' ? ' is-drop' : ''), title: fresh[1] }, fresh[0])));
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
    return h('div', { class: rowClass(r) },
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
    return h('div', { class: rowClass(r) },
      itemCell(r),
      C_('left', 'Filled', h('b', null, num(r.total - r.remain)), h('span', { class: 'of' }, ' of ' + num(r.total))),
      C_('yours', 'Your bid', L.isk(r.price), r.guard && r.guard.max != null ? h('span', { class: 'sub maxbid' + (r.guard.state === 'under' ? ' neg' : ''),
        title: 'The highest bid that still leaves ' + Math.round(C.risk.margin * 100) + '% after every fee across ' + r.guard.hubs.map(x => x.name + ' at ' + L.isk(Math.round(x.price))).join(', ') + (r.guard.sold ? ' (the front of the book where you sell it, or 115% of the month\u2019s average there where the front is a thin listing over that).' : ' (read from each hub\u2019s book and price history).')
          + (r.guard.margin != null ? ' At your bid it ' + (r.guard.margin < 0 ? 'loses ' : 'nets ') + Math.round(Math.abs(r.guard.margin) * 100) + '%.' : '') },
        'max ' + L.isk(r.guard.max)) : null),
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

  function stopView(s, m) {
    const state = s.docked ? 'Docked here' : s.inSystem ? 'In this system' : s.jumps != null ? plural(s.jumps, 'jump') + ' away' : '';
    const pinnable = s.sells.concat(s.bids).filter(r => r.plan.action === 'tick' && r.plan.target != null && !(r.pin && !r.pin.done));
    const summary = [];
    if (s.check) summary.push(s.check + ' to check');
    if (s.change) summary.push(s.change + ' to change' + (s.changeFee >= 1000 ? ' for ' + L.short(s.changeFee) : ''));
    if (s.copied) summary.push(s.copied + ' of ' + s.change + ' copied');
    const restockMarks = s.id === C.jita.station ? m.restock.filter(r => r.copied).map(r => 'r' + r.type) : [];
    const marks = s.sells.concat(s.bids).filter(r => r.copied).map(r => r.id).concat(restockMarks);
    if (s.optional) summary.push(s.optional + ' your call');
    if (!s.change && !s.optional && !s.check) summary.push('Nothing to change');
    const pickup = m.pi && m.pi.near && isFinite(m.pi.near.jumps) && m.pi.near.station === s.id && m.pi.go !== 'wait';
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
        pickup && h('p', { class: 'pickup' }, h('span', { class: 'chip chip-lead' }, 'Planetary pickup'),
          m.pi.system + ' is ' + plural(m.pi.near.jumps, 'jump') + ' from here, with about ' + L.short(m.pi.value) + ' of product waiting. ', h('a', { href: '#pi', onclick: e => { e.preventDefault(); document.getElementById('pi').scrollIntoView({ behavior: 'smooth' }); } }, 'See the planets')),
        h('div', { class: 'stop-tools' },
          pinnable.length ? h('button', { type: 'button', class: 'btn', onclick: () => pin(pinnable) }, 'Pin ' + plural(pinnable.length, 'price')) : null,
          s.pinned ? h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => unpin(s) }, 'Clear pins') : null,
          marks.length ? h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => unmark(marks) }, 'Clear copied marks') : null)),
      s.sells.length ? h('div', { class: 'rows' }, head(['Sell orders', 'Left', 'Your price', 'Front of book', 'Call', 'Type this', 'Net each', 'Sold']), s.sells.map(sellRow)) : null,
      s.bids.length ? h('div', { class: 'rows' }, head(['Buy orders', 'Filled', 'Your bid', 'Bids above you', 'Call', 'Type this', 'In escrow', 'Expires']), s.bids.map(bidRow)) : null,
      s.id === C.jita.station && m.haul.rows.length ? haulView(m) : null,
      m.hold.rows.length ? holdView(m, s) : null,
      s.id !== C.jita.station && m.haul.rows.length ? haulView(m) : null,
      s.id === C.jita.station && m.restock.length ? restockView(m) : null,
      s.hangar.length && s.id !== C.jita.station ? h('p', { class: 'hangar' }, h('span', { class: 'hangar-label' }, 'In the hangar, not listed'),
        s.hangar.map(x => h('span', { class: 'hangar-item' }, x.name + ' ×' + num(x.qty)))) : null);
  }

  /**
   * The hubs with something to do, in the order that takes the fewest jumps from where the character is, drawn as a route line:
   * a dot for each stop, and between them one square per system on the way, coloured by security as on the route strips
   * (a red cap where ships or pods were lost in the last hour). A longer leg is a longer run of squares.
   */
  function tripView(m) {
    const t = m.trip;
    if (!t || (!t.stops.length && !t.skipped.length && !t.lost.length)) return null;
    const pick = id => { S.tab = id; S.follow = false; paint(); };
    const skip = (key, on) => { if (on) S.tripSkip.add(key); else S.tripSkip.delete(key); paint(); };
    const keep = () => { if (!demo) E.store.set('eveops.trip', { safe: S.tripSafe, open: S.tripOpen }); paint(); };
    const mode = safe => { S.tripSafe = safe; keep(); };
    const next = t.stops.find(x => !x.here);
    const job = jb => h('li', { class: 'trip-job is-' + jb.tone }, jb.pre ? jb.pre + ' ' : null, jb.n != null ? h('b', null, num(jb.n)) : null, jb.text ? (jb.n != null ? ' ' : '') + jb.text : null);
    const track = x => h('span', { class: 'trip-track' },
      h('span', { class: 'strip', role: 'img', 'aria-label': plural(x.jumps, 'jump') + (x.hot ? ', ' + plural(x.hot, 'system') + ' with losses in the last hour' : '') },
        x.hops.map(y => h('i', { class: 'sys s' + Math.round(y.sec * 10) + (y.ship + y.pod > 0 ? ' is-hot' : ''), title: y.name + ' ' + y.sec.toFixed(1) + (y.ship + y.pod ? ', ' + y.ship + ' ships and ' + y.pod + ' pods lost in the last hour' : '') }))),
      h('span', { class: 'trip-leg' }, h('b', null, num(x.jumps)), x.jumps === 1 ? ' jump' : ' jumps', x.hot ? h('span', { class: 'neg' }, ', ' + x.hot + ' hot') : null));
    return h('section', { class: 'trip', 'aria-label': 'Trip plan' },
      h('div', { class: 'trip-head' },
        h('h3', null, 'Trip plan'),
        t.stops.length ? h('span', { class: 'trip-total' }, plural(t.total, 'jump') + ', ' + plural(t.stops.length, 'stop')) : null,
        t.stuck ? h('span', { class: 'neg' }, 'No route joins these stops.') : null,
        !S.tripOpen && next ? h('span', { class: 'trip-total' }, 'Next: ', h('button', { type: 'button', class: 'linkish', onclick: () => pick(next.id) }, next.short), ', ' + plural(next.jumps, 'jump')) : null,
        h('span', { class: 'trip-mode', role: 'group', 'aria-label': 'Trip plan options' },
          S.tripOpen ? h('button', { type: 'button', class: 'btn btn-quiet', 'aria-pressed': t.safe ? 'false' : 'true', onclick: () => mode(false) }, 'Shortest') : null,
          S.tripOpen ? h('button', { type: 'button', class: 'btn btn-quiet', 'aria-pressed': t.safe ? 'true' : 'false', onclick: () => mode(true) }, 'Secure') : null,
          h('button', { type: 'button', class: 'btn btn-quiet', 'aria-expanded': S.tripOpen ? 'true' : 'false', onclick: () => { S.tripOpen = !S.tripOpen; keep(); } }, S.tripOpen ? 'Hide' : 'Show'))),
      !S.tripOpen ? null : [t.stops.length ? h('ol', { class: 'trip-line' }, t.stops.map(x => h('li', { class: 'trip-stop' + (x.here ? ' is-here' : '') + (x.id === m.tab ? ' is-on' : '') },
        x.here ? null : track(x),
        h('div', { class: 'trip-node' },
          h('span', { class: 'trip-at' }, h('i', { class: 'trip-dot' }),
            h('button', { type: 'button', class: 'trip-name', onclick: () => pick(x.id) }, x.short, x.again ? ' again' : ''),
            x.here ? h('span', { class: 'trip-here' }, 'here') : null,
            h('button', { type: 'button', class: 'trip-skip', title: 'Leave ' + x.short + (x.again ? ' again' : '') + ' out of this trip', 'aria-label': 'Leave ' + x.short + (x.again ? ' again' : '') + ' out of this trip', onclick: () => skip(x.key, true) }, '\u00d7')),
          h('ul', { class: 'trip-jobs' }, x.jobs.map(job)))))) : null,
      t.lost.length ? h('p', { class: 'note neg' }, 'No route from here to ' + t.lost.join(', ') + '.') : null,
      t.skipped.length || t.idle.length ? h('p', { class: 'note' },
        t.skipped.length ? ['Left out by you: ', t.skipped.map((x, i) => [i ? ', ' : '', h('button', { type: 'button', class: 'linkish', onclick: () => skip(x.key, false) }, x.short + ' (put back)')]), '. '] : null,
        t.idle.length ? 'Nothing to do in ' + t.idle.join(', ') + '.' : null) : null,
      t.stops.length > 1 ? h('p', { class: 'note' }, 'One square per system on the way, coloured by security. A red cap, counted as "hot", marks ships or pods lost there in the last hour.') : null]);
  }

  function tabsView(m) {
    const pick = id => { S.tab = id; S.follow = false; paint(); };
    return h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Hubs, nearest first' }, m.stops.map(s => {
      const on = s.id === m.tab;
      const where = s.docked ? 'Docked here' : s.inSystem ? 'In this system' : s.jumps != null ? plural(s.jumps, 'jump') : '';
      return h('button', { type: 'button', role: 'tab', class: 'tab' + (on ? ' is-on' : '') + (s.docked ? ' is-here' : ''), 'aria-selected': on ? 'true' : 'false', onclick: () => pick(s.id) },
        h('span', { class: 'tab-name' }, s.short),
        h('span', { class: 'tab-sub' }, where),
        h('span', { class: 'tab-count' + (s.change || s.check ? '' : ' is-zero') }, (s.check ? s.check + ' to check' + (s.change ? ', ' : '') : '') + (s.change ? s.change + ' to change' : s.check ? '' : 'Nothing to change')),
        m.pi && m.pi.near && isFinite(m.pi.near.jumps) && m.pi.near.station === s.id && m.pi.go !== 'wait' ? h('span', { class: 'tab-pi' }, 'Planetary pickup') : null,
        s.id === C.jita.station && (m.restock.length || m.haul.rows.length) ? h('span', { class: 'tab-pi' }, [m.haul.rows.length ? plural(m.haul.units, 'unit') + ' to haul' : null, m.restock.length ? m.restock.length + ' to restock' : null].filter(Boolean).join(', ')) : null);
    }));
  }

  /**
   * A section's heading as a button that folds the section down to its heading line and opens it again.
   * The choice is kept on this device. `tag` is the heading level the section already uses.
   */
  const folded = key => !!S.fold[key];
  function foldHead(tag, key, title) {
    const shut = folded(key);
    return h(tag, null, h('button', { type: 'button', class: 'fold', 'aria-expanded': shut ? 'false' : 'true', title: (shut ? 'Show ' : 'Hide ') + title,
      onclick: () => { if (shut) delete S.fold[key]; else S.fold[key] = true; if (!demo) E.store.set('eveops.fold', S.fold); paint(); } }, h('i', { class: 'fold-mark', 'aria-hidden': 'true' }), title));
  }

  /** The most stock, at cost, to carry in one trip: a figure typed here, kept with the other limits. */
  function capBox(cap) {
    return h('label', { class: 'cargo' }, 'trip cap ', h('input', { class: 'isk-in lim-in', type: 'text', inputmode: 'decimal', 'data-keep': 'lim-trip', 'aria-label': 'The most stock, at cost, to carry in one trip', value: L.short(cap),
      onchange: e => setLimit('trip', e.target.value), onkeydown: e => { if (e.key === 'Enter') e.target.blur(); } }));
  }
  const worth = x => L.short(x.value) + ' at cost' + (x.unpriced ? ', ' + plural(x.unpriced, 'item') + ' with no cost on record' : '');
  function haulView(m) {
    const hl = m.haul, ld = hl.load, over = hl.m3 > hl.cargo, rich = hl.value > hl.cap, pct = Math.round(C.risk.floor * 100);
    const byName = new Map(C.hubs.map(hb => [hb.name, hb.station]));
    const setTo = names => { S.haulTo = names; if (!demo) E.store.set('eveops.haulTo', names); paint(); };
    const toggle = name => setTo(hl.hubs.filter(x => (x.name === name ? !x.on : x.on)).map(x => x.name));
    // a hub's cell: where units of the row are headed, the price to list them at is a button to copy, as in the Type this column
    const hubCell = (r, a, mine) => {
      const at = mine ? r.list[a.name] : null, shown = a.ask == null ? '' : a.thin ? h('span', { class: 'thin', title: 'A thin listing far above what this trades at there: counted at ' + L.isk(Math.round(a.counts)) }, L.isk(a.ask)) : L.isk(a.ask);
      const sold = a.sold ? h('span', { class: 'sub' }, 'you sold ' + num(a.sold) + ' this week') : null;
      if (!at) return h('td', null, shown, sold);
      // under a thin front the price is your call: the line was planned at what the item trades at there, not at that listing
      return h('td', { class: 'best' }, at.price != null ? priceMark('g' + r.type + ':' + byName.get(a.name), at.price, at.copied, at.soft || a.thin) : shown,
        h('span', { class: 'sub' }, at.price == null ? at.why : a.thin ? ['your call: front ', shown, ' is thin'] : 'list at; ' + at.why), sold);
    };
    const takeTo = (r, parts) => h('td', { class: 'best' }, parts.length ? parts.map(x => x.name + ' ' + num(x.units)).join(', ') : '',
      r.under ? h('span', { class: 'sub neg' }, 'no hub nets ' + pct + '%') : r.fresh ? h('span', { class: 'sub' }, 'by what each hub trades') : null);
    const cost = (v, r) => h('td', null, r.unit == null ? h('span', { class: 'sub' }, 'no cost') : L.short(v));
    const item = r => h('td', { class: 'l' }, h('span', { class: 'pi-item' }, icon(r.type), r.name));
    const floor = r => h('td', null, r.floor == null ? '' : L.isk(r.floor));
    const hubHeads = hl.rows[0].asks.map(a => h('th', null, a.name));
    return h('div', { class: 'block' + (folded('haul') ? ' is-folded' : ''), id: 'haul' },
      h('div', { class: 'block-head' }, foldHead('h3', 'haul', 'Haul manifest'),
        h('span', { class: over ? 'neg' : '' }, plural(hl.units, 'unit') + ', ' + num(Math.round(hl.m3)) + ' m³ of '),
        h('label', { class: 'cargo' }, h('input', { type: 'number', min: 0, step: 1, value: hl.cargo, 'aria-label': 'Cargo hold in cubic metres',
          onchange: e => { S.cargo = Math.max(0, Number(e.target.value) || 0); if (!demo) E.store.set('eveops.cargo', S.cargo); paint(); } }), ' m³ cargo'),
        over && h('span', { class: 'chip chip-check' }, 'Over by ' + num(Math.round(hl.m3 - hl.cargo)) + ' m³'),
        h('span', { class: 'worth' + (rich ? ' neg' : '') }, worth(hl)), capBox(hl.cap),
        rich && h('span', { class: 'chip chip-check' }, 'Over your trip cap by ' + L.short(hl.value - hl.cap) + ': split the load')),
      folded('haul') ? null : h('div', { class: 'haul-to', role: 'group', 'aria-label': 'Hubs to load for' }, h('span', { class: 'haul-to-label' }, 'Load for'),
        hl.hubs.map(x => h('button', { type: 'button', class: 'btn haul-hub', 'aria-pressed': x.on ? 'true' : 'false', disabled: !x.lines && !x.on, title: x.lines ? plural(x.lines, 'line') + ' in the Jita hangar for ' + x.name : 'Nothing in the Jita hangar is for ' + x.name, onclick: () => toggle(x.name) },
          x.name, h('span', { class: 'sub' }, x.lines ? num(Math.round(x.m3)) + ' m³' : 'nothing'))),
        ld ? h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => setTo([]) }, 'Whole manifest') : h('span', { class: 'why' }, 'pick the hubs this trip goes to')),
      folded('haul') || !ld ? null : h('p', { class: 'hold-by' }, 'For ', h('b', null, ld.to.join(', ')), ': load ', h('b', null, num(ld.units)), ' ' + (ld.units === 1 ? 'unit' : 'units') + ', ' + num(Math.round(ld.m3)) + ' m³ of the ' + num(Math.round(ld.room)) + ' m³ free'
        + (ld.aboard > 0 ? ' (' + num(Math.round(ld.aboard)) + ' m³ is already aboard)' : '') + ', ' + L.short(ld.value) + ' at cost.',
        ld.left ? h('span', { class: 'neg' }, ' ' + plural(ld.left, 'line') + ' will not fit whole: ' + num(Math.round(ld.want - ld.m3)) + ' m³ stays in the hangar.') : ' All of it fits.',
        ld.other ? ' ' + plural(ld.other, 'other line') + ' in the hangar ' + (ld.other === 1 ? 'is' : 'are') + ' for other hubs.' : null),
      folded('haul') ? null : h('div', { class: 'pi-scroll' }, ld
        ? h('table', { class: 'pi-table' },
          h('thead', null, h('tr', null, h('th', { class: 'l' }, 'Load from the Jita hangar'), h('th', null, 'Load'), h('th', null, 'm³'), h('th', null, 'Hold after'), h('th', null, 'At cost'), hubHeads, h('th', null, 'Take to'), h('th', null, 'Do not list below'))),
          h('tbody', null, ld.rows.map(x => { const r = x.row; return h('tr', { class: x.take ? '' : 'is-left' },
            item(r),
            h('td', { class: x.take ? 'best' : '' }, num(x.take), x.take < r.qty ? h('span', { class: 'sub' + (x.short ? ' neg' : '') }, 'of ' + num(r.qty) + (x.short === 'room' ? ': hold is full' : x.short === 'cap' ? ': trip cap' : ' in the hangar')) : null),
            h('td', null, num(Math.round(x.m3))), h('td', null, x.take ? num(Math.round(x.sum)) : ''),
            cost(x.value, r),
            r.asks.map(a => hubCell(r, a, x.parts.some(p => p.name === a.name))),
            takeTo(r, x.parts), floor(r)); })))
        : h('table', { class: 'pi-table' },
          h('thead', null, h('tr', null, h('th', { class: 'l' }, 'In the Jita hangar'), h('th', null, 'Units'), h('th', null, 'm³'), h('th', null, 'At cost'), hubHeads, h('th', null, 'Take to'), h('th', null, 'Do not list below'))),
          h('tbody', null, hl.rows.map(r => h('tr', null,
            item(r),
            h('td', null, num(r.qty)), h('td', null, num(Math.round(r.m3))),
            cost(r.value, r),
            r.asks.map(a => hubCell(r, a, r.parts.some(p => p.name === a.name))),
            takeTo(r, r.parts), floor(r)))))),
      folded('haul') ? null : h('p', { class: 'note' }, 'Hub columns are the lowest ask there now; a dotted one is a thin listing far above what the item trades at, and is not counted. In the hub a line is headed for, the price is the one to list it at there, by the same rules as the Call column; press it to copy it, and the mark is the same one the cargo hold shows once the stock is aboard. "Take to" prefers a hub where you sold this item in the last 7 days. A line you have not sold yet goes to the hubs that net '
        + pct + '% or better, shared out by what each trades. "Do not list below" is the price that still nets ' + pct + '% on what you paid. Pick hubs under "Load for" and the list becomes what to take out of the hangar for them, the most ISK per m³ first, until the hold (less what is already aboard) or the trip cap is full.'));
  }
  /** What is in the ship's cargo hold, where each item sells, and the price to list it at in the hub this panel is for. */
  function holdView(m, s) {
    const hd = m.hold, away = C.hubs.filter(hb => hb.station !== C.jita.station);
    const at = r => (r.left.find(x => x.name === s.short) || { units: 0 }).units, here = hd.rows.filter(r => at(r) > 0).length;
    const out = new Set(((m.trip && m.trip.skipped) || []).map(x => x.short.replace(/ again$/, '')));
    const stopIds = new Set(((m.trip && m.trip.stops) || []).map(x => x.short));
    const off = hd.by.filter(b => out.has(b.name) && !stopIds.has(b.name));
    return h('div', { class: 'block' + (folded('hold') ? ' is-folded' : ''), id: 'hold' },
      h('div', { class: 'block-head' }, foldHead('h3', 'hold', 'In your cargo hold'),
        h('span', null, plural(hd.units, 'unit') + ', ' + num(Math.round(hd.m3)) + ' m\u00b3' + (hd.ship ? ' in the ' + hd.ship : '')),
        h('span', { class: 'worth' + (hd.value > hd.cap ? ' neg' : '') }, worth(hd)),
        hd.value > hd.cap ? h('span', { class: 'chip chip-check' }, 'Over your trip cap of ' + L.short(hd.cap)) : null,
        here ? h('span', { class: 'chip chip-lead' }, plural(here, 'item') + ' to list here') : null,
        h('span', { class: 'why' }, 'as EVE last reported it, ', live('ago', hd.at))),
      folded('hold') || !hd.by.length ? null : h('p', { class: 'hold-by' }, 'Aboard for: ',
        hd.by.map((b, i) => [i ? ', ' : null, h('b', null, b.name === s.short ? 'here' : b.name), ' ' + num(Math.round(b.m3)) + ' m\u00b3', out.has(b.name) && !stopIds.has(b.name) ? h('span', { class: 'neg' }, ' (left out of this trip)') : null]),
        off.length ? h('span', { class: 'neg' }, '. ' + num(Math.round(sum(off, b => b.m3))) + ' m\u00b3 stays aboard after this trip') : null,
        hd.nowhere ? ', ' + plural(hd.nowhere, 'item') + ' with nowhere to go yet' : null),
      folded('hold') ? null : h('div', { class: 'pi-scroll' }, h('table', { class: 'pi-table' },
        h('thead', null, h('tr', null, h('th', { class: 'l' }, 'In the hold'), h('th', null, 'Units'), h('th', null, 'm\u00b3'),
          away.map(hb => h('th', null, hb.name)), h('th', null, 'Take to'), h('th', null, 'Net each'), h('th', null, 'List at ' + s.short))),
        h('tbody', null, hd.rows.map(r => {
          const at = r.list[s.id] || { price: null, why: '', copied: null }, hereUnits = (r.left.find(x => x.name === s.short) || { units: 0 }).units, best = hereUnits > 0;
          return h('tr', { class: at.copied && !at.copied.moved ? 'is-copied' : '' },
            h('td', { class: 'l' }, h('span', { class: 'pi-item' }, icon(r.type), h('span', null, r.name))),
            h('td', null, num(r.qty)), h('td', null, num(Math.round(r.m3))),
            r.asks.map(a => h('td', { class: r.left.some(x => x.name === a.name) ? 'best' : '' }, a.ask == null ? '' : L.isk(a.ask), a.sold ? h('span', { class: 'sub' }, 'you sold ' + num(a.sold) + ' this week') : null)),
            h('td', { class: 'best' }, r.left.slice().sort((x, y) => (y.name === s.short) - (x.name === s.short)).map(x => (x.name === s.short ? 'Here' : x.name) + ' ' + num(x.units)).join(', '),
              r.waiting ? h('span', { class: 'sub' }, num(r.waiting) + ' already listed') : null),
            h('td', null, at.net == null ? '' : [h('span', { class: at.net < 0 ? 'neg' : '' }, L.short(at.net)), at.margin != null ? h('span', { class: 'sub' }, Math.round(at.margin * 100) + '%') : null]),
            h('td', null, at.price == null ? h('span', { class: 'sub' }, at.why) : [priceMark('g' + r.type + ':' + s.id, at.price, at.copied, !best || at.soft), h('span', { class: 'sub' }, at.why)]));
        })))),
      folded('hold') ? null : h('p', { class: 'note' }, 'Items you have bought or sold on the market that are in the ship you are flying. The price follows the same rules as the Call column: your order for that item in ' + s.short + ' if you have one, else one legal step under the lowest ask, and none where that would sell under cost or under Jita. A dashed price is your call, or an item with no units planned for ' + s.short + '. "Take to" is the plan the load came aboard with, the same as the haul manifest gave it in Jita: it is fixed when the units come aboard and counts down as you list them, so the hold empties over the stops, and a hub you do not visit keeps its share aboard. EVE reports hangars and cargo once an hour, so a load you have just taken on can take that long to appear.'));
  }
  function restockView(m) {
    const offered = m.restock.filter(r => r.bid != null && r.want && !r.thin && !r.probation);
    const held = r => (r.probation.state === 'drop' ? 'clear and drop: ' : 'on probation: ') + (r.probation.lot ? num(r.probation.sold) + ' of ' + num(r.probation.lot) + ' sold' : 'no sale on record')
      + (r.probation.thin ? ', netting under ' + Math.round(C.risk.floor * 100) + '%' : '');
    const newest = offered.filter(r => r.copied && !r.copied.moved).reduce((a, r) => (!a || r.copied.at > a.copied.at ? r : a), null);
    if (newest) newest.copied.last = true;
    const want = offered.filter(r => !(r.copied && !r.copied.moved)).length;
    return h('div', { class: 'block' + (folded('restock') ? ' is-folded' : '') },
      h('div', { class: 'block-head' }, foldHead('h3', 'restock', 'Restock shortlist'),
        folded('restock') ? h('span', null, plural(m.restock.length, 'line') + (want ? ', ' + plural(want, 'bid') + ' to place' : '')) : null, h('span', { class: 'why' }, C.restock.days + ' days of stock or less, selling at least ' + C.restock.minWeek + ' a week'),
        offered.some(r => r.copied) ? h('span', null, offered.filter(r => r.copied && !r.copied.moved).length + ' of ' + offered.length + ' bids copied') : null),
      folded('restock') ? null : h('div', { class: 'pi-scroll' }, h('table', { class: 'pi-table' },
        h('thead', null, h('tr', null, h('th', { class: 'l' }, 'Line'), h('th', null, 'Left'), h('th', null, 'Sells a day'), h('th', null, 'Days left'), h('th', null, 'On the way'), h('th', null, 'Units to bid'), h('th', null, 'Net each'), h('th', null, 'Bid to type'))),
        h('tbody', null, m.restock.map(r => h('tr', { class: r.copied && !r.copied.moved && offered.indexOf(r) >= 0 ? 'is-copied' + (r.copied.last ? ' is-last' : '') : '' },
          h('td', { class: 'l' }, h('span', { class: 'pi-item' }, icon(r.type), h('span', null, r.name, h('span', { class: 'sub' }, r.hub)))),
          h('td', { class: r.left ? '' : 'neg' }, r.left ? num(r.left) : 'Sold out'),
          h('td', null, r.perDay.toFixed(1)), h('td', null, r.left ? r.days.toFixed(1) : ''),
          h('td', null, r.coming ? num(r.coming) : ''),
          h('td', null, r.thin ? h('span', { class: 'sub' }, 'margin too thin') : r.probation ? h('span', { class: 'sub' + (r.probation.state === 'drop' ? ' neg' : '') }, held(r)) : r.want ? num(r.want) : h('span', { class: 'sub' }, 'covered')),
          h('td', null, r.net == null ? '' : [h('span', { class: r.thin ? 'neg' : '' }, L.short(r.net)), h('span', { class: 'sub' }, Math.round(r.margin * 100) + '%')]),
          h('td', null, offered.indexOf(r) >= 0 ? priceMark('r' + r.type, r.bid, r.copied, false) : '')))))),
      folded('restock') ? null : h('p', { class: 'note' }, 'Units to bid is a week of your sales less what is left, already on bid, or waiting in the Jita hangar. The bid is one legal tick over the top Jita bid; net each is at the hub price after fees. A line on probation is offered no bid until half of its first lot has sold.'));
  }
  function feedPanel(m) {
    const mark = () => { S.seen = { at: Date.now(), orders: m.snapshot }; if (!demo) E.store.set('eveops.seen', S.seen); syncSoon(); paint(); };
    return h('section', { class: 'panel' },
      h('div', { class: 'block-head' }, h('h3', null, 'Since you last looked'), m.changes.length ? h('button', { type: 'button', class: 'btn btn-quiet btn-small', onclick: mark }, 'Mark as seen') : null),
      m.changes.length ? h('ul', { class: 'feed' }, m.changes.slice(0, 10).map(c => h('li', { class: 'tone-' + c.tone }, h('span', null, c.text), c.sub && h('span', { class: 'sub' }, c.sub))),
        m.changes.length > 10 ? h('li', { class: 'sub' }, 'and ' + (m.changes.length - 10) + ' more') : null)
        : h('p', { class: 'note' }, 'Nothing new.'),
      m.seenAt && h('p', { class: 'note' }, 'Counting from ', live('ago', m.seenAt), '.'));
  }

  /** The wormhole pilot's exploration loot and gas, by where it sits, with what each hub pays, for planning hand-overs to the trader. */
  function lootView(m) {
    const sc = m.scout;
    if (!sc || !sc.loot) return null;
    const sell = sc.sell, ready = sell.ready, vol = sum(sc.loot, p => p.m3), avg = sum(sc.loot, p => p.value);
    const kind = k => sum(sc.loot, p => sum(p.rows.filter(r => r.kind === k), r => (ready ? (r.list ? r.list.value : r.now ? r.now.value : 0) : r.value)));
    const pct = x => +(x * 100).toFixed(3) + '%';
    const fig = (v, u) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + u;     // three figures, so near prices stay apart
    const px = n => (n >= 1e9 ? fig(n / 1e9, 'B') : n >= 1e6 ? fig(n / 1e6, 'M') : n >= 1e3 ? fig(n / 1e3, 'k') : L.isk(n));
    const cube = v => (v > 0 && v < 0.5 ? 'under 1' : num(Math.round(v)));
    const pace = d => (d == null ? '' : !isFinite(d) ? ', no trade there this week' : d <= 1 ? ' within a day' : ' in about ' + Math.ceil(d) + ' days');
    const jumpsText = j => (j == null ? null : j === 0 ? 'here' : j + (j === 1 ? ' jump' : ' jumps'));
    const top = f => Math.max.apply(null, sell.hubs.map(f));
    const hubCell = (r, hb) => {
      const x = r.hubs.find(y => y.station === hb.station);
      if (!x || (x.ask == null && x.bid == null)) return h('td', null, '');
      return h('td', { class: r.list && r.list.hub === x.name ? 'best' : '', title: x.perDay == null ? null : 'About ' + num(Math.round(x.perDay)) + ' a day traded in that region this week' },
        x.ask == null ? h('span', { class: 'sub' }, 'no asks') : x.thin ? h('span', { class: 'thin', title: 'A lone listing far above the Jita price: counted at the Jita price' }, px(x.ask)) : px(x.ask),
        h('span', { class: 'sub' + (r.now && r.now.hub === x.name ? ' best-bid' : '') }, x.bid == null ? 'no bids' : 'bid ' + px(x.bid)));
    };
    return h('section', { class: 'pi', id: 'loot' },
      h('header', { class: 'pi-head' }, h('h2', null, 'Loot and gas to hand over'),
        h('span', { class: 'stop-sum' }, !sc.loot.length ? 'Nothing found'
          : ready ? 'List for about ' + L.short(sell.split.list) + ', or sell now for about ' + L.short(sell.split.now) + ', ' + cube(vol) + ' m³'
          : 'About ' + L.short(avg) + ', ' + cube(vol) + ' m³')),
      h('p', { class: 'pi-note' }, sc.loot.length
        ? 'Exploration ' + L.short(kind('Exploration')) + ', gas ' + L.short(kind('Gas')) + '. Grouped by where ' + sc.name + ' has it.' + (ready ? '' : ' Valued at EVE average prices while the hub prices load.')
        : 'No exploration loot or gas in ' + sc.name + '’s hangars or holds. The asset list updates hourly.'),
      ready && sc.loot.length ? h('div', { class: 'block' },
        h('div', { class: 'block-head' }, h('h3', null, 'Which hub pays best'), h('span', { class: 'why' }, 'all ' + plural(sell.units, 'unit') + ' of ' + plural(sell.types, 'item') + ' taken to one hub, after fees')),
        h('div', { class: 'pi-scroll' }, h('table', { class: 'pi-table loot-sum' },
          h('thead', null, h('tr', null, h('th', { class: 'l' }, 'Hub'), h('th', null, 'Listed at the lowest ask'), h('th', null, 'Sold now to bids'))),
          h('tbody', null, sell.hubs.map(x => h('tr', null,
            h('td', { class: 'l' }, x.name),
            h('td', { class: x.list > 0 && x.list === top(y => y.list) ? 'best' : '' }, x.list ? L.short(x.list) : '',
              x.noAsk || x.slow ? h('span', { class: 'sub' }, [x.noAsk ? x.noAsk + ' of ' + plural(sell.types, 'item') + ' not on sale there' : null, x.slow ? x.slow + (x.slow === 1 ? ' item' : ' items') + ' would take over ' + C.loot.days + ' days' : null].filter(Boolean).join(', ')) : null),
            h('td', { class: x.now > 0 && x.now === top(y => y.now) ? 'best' : '' }, x.now ? L.short(x.now) : '', x.filled < sell.units ? h('span', { class: 'sub' }, x.filled ? 'bids take ' + num(x.filled) + ' of ' + plural(sell.units, 'unit') : 'no bids') : null))),
            h('tr', { class: 'loot-split' }, h('td', { class: 'l' }, 'Each item at its best hub'), h('td', null, L.short(sell.split.list)), h('td', null, L.short(sell.split.now))))))) : null,
      sc.loot.map(p => h('div', { class: 'block' },
        h('div', { class: 'block-head' }, h('h3', null, p.name),
          h('span', { class: 'why' }, (ready ? 'list about ' + L.short(p.list) + ', sell now about ' + L.short(p.now) : 'about ' + L.short(p.value)) + ', ' + cube(p.m3) + ' m³')),
        h('div', { class: 'pi-scroll' }, h('table', { class: 'pi-table' },
          h('thead', null, h('tr', null, h('th', { class: 'l' }, 'Item'), h('th', null, 'Units'), h('th', null, 'm³'),
            ready ? [h('th', null, 'List in'), h('th', null, 'Sell now in'), C.hubs.map(hb => h('th', null, hb.name, p.jumps && p.jumps[hb.station] != null ? h('span', { class: 'sub' }, jumpsText(p.jumps[hb.station])) : null))]
              : [h('th', null, 'Each'), h('th', null, 'Value')])),
          h('tbody', null, p.rows.map(r => h('tr', null,
            h('td', { class: 'l' }, h('span', { class: 'pi-item' }, icon(r.type), h('span', null, r.name, h('span', { class: 'sub' }, r.group)))),
            h('td', null, num(r.qty)), h('td', null, cube(r.m3)),
            ready ? [h('td', { class: r.list ? 'best' : '' }, r.list ? [r.list.hub, h('span', { class: 'sub' + (r.list.slow ? ' neg' : '') }, L.short(r.list.value) + pace(r.list.days))] : h('span', { class: 'sub' }, r.sell ? 'not on sale at a hub' : 'blueprint copy, contract only')),
              h('td', null, r.now ? [r.now.hub, h('span', { class: 'sub' }, L.short(r.now.value) + (r.now.filled < r.now.of ? ', bids take ' + num(r.now.filled) + ' of ' + num(r.now.of) : ''))] : h('span', { class: 'sub' }, r.sell ? 'no bids' : '')),
              C.hubs.map(hb => hubCell(r, hb))]
              : [h('td', null, r.value ? L.short(r.value / r.qty) : ''), h('td', null, r.value ? L.short(r.value) : 'not priced')]))))))),
      ready && sc.loot.length ? h('p', { class: 'note' }, 'Each hub column is the lowest ask there with the top bid beneath, and the jumps from where the loot sits. “List in” is the hub with the highest ask where the pile would sell within ' + C.loot.days + ' days at ' + Math.round(C.loot.share * 100) + '% of that region’s trade, passing over a lone listing more than 1.5 times the Jita ask (dotted underline); when every hub is slower than that, it is the quickest one. “Sell now in” fills the bids standing at the hub station, in its system or region-wide with every unit held. Totals are after fees: '
        + pct(C.fees.broker + C.fees.salesTax) + ' on a listing, ' + pct(C.fees.salesTax) + ' on a sale to a bid. Hub prices refresh every 10 minutes, the asset list hourly.') : null);
  }

  function piView(m) {
    const p = m.pi;
    if (!p) return null;
    const verdict = { full: 'launchpad nearly full', worth: 'worth a stop', wait: 'not yet' }[p.go];
    const when = p.go !== 'wait' ? '' : p.reach > 0 ? 'Reaches ' + L.short(C.pi.worth) + (p.reach === 1 ? ' tomorrow. ' : ' in ' + p.reach + ' days. ') : 'Will not reach ' + L.short(C.pi.worth) + ' within a week at this pace. ';
    const where = p.near && isFinite(p.near.jumps) ? p.system + ' is ' + plural(p.near.jumps, 'jump') + ' from ' + p.near.name + (p.from != null ? ' and ' + plural(p.from, 'jump') + ' from you. ' : '. ') : '';
    const shut = folded('pi');
    return h('section', { class: 'pi' + (shut ? ' is-folded' : ''), id: 'pi' },
      h('header', { class: 'pi-head' },
        foldHead('h2', 'pi', 'Planetary Interaction'),
        h('span', { class: 'chip ' + (p.go === 'wait' ? 'chip-hold' : 'chip-lead') }, 'Pickup: ' + verdict),
        h('span', { class: 'stop-sum' }, 'About ' + L.short(p.value) + ' waiting')),
      shut ? null : h('p', { class: 'pi-note' }, plural(Math.round(p.units), 'unit') + ', ' + num(Math.round(p.m3)) + ' m\u00b3, growing about ' + L.short(p.perDay) + ' a day. ' + when + where
        + (p.stopped ? plural(p.stopped, 'colony has', 'colonies have') + ' stopped extractors.' : '')),
      shut ? null : h('div', { class: 'pi-scroll' }, h('table', { class: 'pi-table' },
        h('thead', null, h('tr', null, h('th', { class: 'l' }, 'Product'), h('th', null, 'On planet'), h('th', null, 'A day'), h('th', null, 'Listed'),
          C.hubs.map(hb => h('th', null, hb.name)), h('th', null, 'Value'))),
        h('tbody', null, p.colonies.map(c => h('tr', null,
          h('td', { class: 'l' }, h('span', { class: 'pi-item' }, icon(c.product), h('span', null, c.productName,
            h('span', { class: 'sub' }, c.name + ', ' + c.type + (c.expiry != null && c.expiry < m.now ? ', extractors stopped' : ''))))),
          h('td', null, num(Math.round(c.units[0]))),
          h('td', null, '+' + num(Math.round(c.units[1] - c.units[0]))),
          h('td', null, c.listedUnits ? num(c.listedUnits) : ''),
          c.asks.map(a => h('td', { class: a != null && a === c.best ? 'best' : '' }, a == null ? '' : L.isk(a))),
          h('td', null, c.value == null ? '' : L.short(c.value))))))),
      shut ? null : h('p', { class: 'note' }, 'Hub columns are the lowest ask in each station, highest marked. Value uses the ' + p.sellName + ' ask. EVE only reports a colony as it was when last opened in game, so the units are worked out from there: an estimate.'));
  }

  function saveCosts(costs) { S.costs = costs; if (!demo) E.store.set('eveops.costs', S.costs); syncSoon(); paint(); }
  /** Reads rows pasted from the tracker's Order Tracking sheet, asks EVE for each item name's type, and keeps the unit costs. */
  async function importCosts() {
    const parsed = L.parseCosts(S.costDraft || '');
    if (!parsed.rows.length) { S.costNote = 'No rows with an item and a unit cost were found. Copy the rows from the Order Tracking sheet, header row included.'; return paint(); }
    S.costNote = 'Asking EVE for the item names.'; paint();
    try {
      const names = Array.from(new Set(parsed.rows.map(r => r.name))), ids = new Map();
      for (let i = 0; i < names.length; i += 400) {
        const r = await E.post('/universe/ids/', names.slice(i, i + 400));
        (r.inventory_types || []).forEach(x => { ids.set(x.name.toLowerCase(), x.id); K.names[x.id] = x.name; });
      }
      saveStatic();
      const hubAt = v => { const hb = C.hubs.find(x => v && v.toLowerCase().indexOf(x.name.toLowerCase()) === 0); return hb ? hb.station : null; };
      const rows = [], unknown = new Set();
      for (const r of parsed.rows) {
        const t = ids.get(r.name.toLowerCase());
        if (t) rows.push({ t, l: hubAt(r.venue), d: r.date, c: r.cost }); else unknown.add(r.name);
      }
      if (!rows.length) { S.costNote = 'EVE recognised none of the ' + names.length + ' item names in those rows, so nothing was changed.'; return paint(); }
      S.costDraft = null;
      S.costNote = 'Read ' + plural(rows.length, 'row') + (parsed.skipped ? ', passed over ' + plural(parsed.skipped, 'line') + ' with no item or cost' : '') + '. The weekly figures below now use them.';
      saveCosts({ at: Date.now(), rows, net: parsed.net, unknown: Array.from(unknown) });
    } catch (err) { S.costNote = 'The item names could not be looked up: ' + (err.message || err) + ' Nothing was changed.'; paint(); }
  }
  function saveWeeks(quiet) { if (!demo) E.store.set('eveops.weeks', S.weeks); syncSoon(); if (!quiet) paint(); }
  /** Finished weeks, newest first: the page's own figures, the exact ones from the wallet journal, and a box for the tracker's net to tie out against. */
  function closesView(m) {
    const c = m.closes;
    if (!c) return null;
    const typed = (text, apply) => { const t = String(text).trim(), v = t === '' ? null : L.parseIsk(t); if (t !== '' && v == null) return paint(); apply(v); saveWeeks(); };
    const setTracker = (key, text) => typed(text, v => { const w = S.weeks.w[key] || (S.weeks.w[key] = {}); w.tracker = { v, at: Date.now() }; });
    const setCarried = text => typed(text, v => { S.weeks.carried = { v, at: Date.now() }; });
    const setLock = (key, on) => { const w = S.weeks.w[key] || (S.weeks.w[key] = {}); w.lock = { on, at: Date.now() }; saveWeeks(); };
    const day = ms => new Date(ms).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
    const box = (keep, value, label, onset) => h('input', { class: 'isk-in', type: 'text', inputmode: 'decimal', 'data-keep': keep, 'aria-label': label, placeholder: keep === 'carried' ? 'e.g. 1.25B' : '', value: value == null ? '' : L.isk(Math.round(value)),
      onchange: e => onset(e.target.value), onkeydown: e => { if (e.key === 'Enter') e.target.blur(); } });
    const signed = v => (v > 0 ? '+' : '') + L.short(v);
    const k = c.costs;
    // which items the units without a cost are, so the tracker rows that would cover them can be found
    const gapText = r => { const g = r.gaps || [], named = sum(g.slice(0, 3), x => x[1]); return g.length ? g.slice(0, 3).map(x => nameOf(x[0]) + ' ' + num(x[1])).join(', ') + (named < r.uncovered ? ', and ' + num(r.uncovered - named) + ' more' : '') : null; };
    const gapTitle = r => ((r.gaps || []).length ? r.gaps.map(x => nameOf(x[0]) + ' ' + num(x[1])).join(', ') : null);
    const costBox = S.costDraft == null ? null : h('div', { class: 'costs-in' },
      h('textarea', { class: 'costs-text', rows: 5, spellcheck: 'false', 'data-keep': 'costs-paste', 'aria-label': 'Rows copied from the tracker',
        placeholder: 'In the tracker workbook, open the Order Tracking sheet, select its rows with the header row, copy, and paste here.', oninput: e => { S.costDraft = e.target.value; } }, S.costDraft),
      h('div', { class: 'tools' },
        h('button', { type: 'button', class: 'btn', onclick: importCosts }, 'Read these rows'),
        h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { S.costDraft = null; paint(); } }, 'Cancel')));
    const status = c.run >= c.need ? 'Tied ' + plural(c.run, 'week') + ' running: the page can take over as the ledger.'
      : c.run ? 'Tied ' + plural(c.run, 'week') + ' running; ' + c.need + ' in a row and the page can take over as the ledger.'
      : 'Type the tracker\u2019s net for a finished week to tie it out. A week ties within ' + Math.round(C.tieOut.within * 100) + '%.';
    return h('section', { class: 'pi closes', id: 'closes' },
      h('header', { class: 'pi-head' },
        h('h2', null, 'Weekly close'),
        h('span', { class: 'chip ' + (c.run >= c.need ? 'chip-lead' : 'chip-hold') }, c.run >= c.need ? 'Tied out' : c.run ? 'Tied ' + c.run + ' of ' + c.need : 'Not tied yet'),
        h('span', { class: 'stop-sum' }, 'Realized net to date ' + L.short(c.toDate))),
      h('p', { class: 'pi-note' }, status),
      h('p', { class: 'closes-carry' }, h('label', null, 'Realized net before ' + day(c.since) + ', from the tracker ', box('carried', c.carried, 'Realized net carried in from the tracker', setCarried)),
        h('span', { class: 'sub' }, c.carried == null ? 'Left empty, "to date" counts from ' + day(c.since) + '.' : 'Included in "to date".')),
      h('div', { class: 'closes-costs' },
        h('span', null, 'Cost basis from the tracker: ', k ? h('b', null, plural(k.lines, 'row') + ', ' + plural(k.items, 'item')) : h('b', null, 'none yet'),
          k ? h('span', { class: 'sub' }, 'read ' + clock(k.at) + (k.net != null ? '. Its Realized Net column adds to ' + L.short(k.net) : '') + '.') : h('span', { class: 'sub' }, 'Units sold with no purchase in EVE\u2019s history have no cost until the tracker\u2019s rows are pasted in.')),
        S.costDraft == null ? h('span', { class: 'tools' },
          h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { S.costDraft = ''; S.costNote = null; paint(); } }, k ? 'Paste newer rows' : 'Paste rows from the tracker'),
          k ? h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { saveCosts({ at: Date.now(), rows: [], net: null, unknown: [] }); S.costNote = 'Tracker costs removed.'; } }, 'Remove') : null) : null),
      costBox,
      S.costNote ? h('p', { class: 'note' }, S.costNote) : null,
      k && k.unknown.length ? h('p', { class: 'note' }, 'Not recognised as EVE item names, so left out: ' + k.unknown.slice(0, 8).join(', ') + (k.unknown.length > 8 ? ', and ' + (k.unknown.length - 8) + ' more' : '') + '.') : null,
      h('div', { class: 'pi-scroll' }, h('table', { class: 'pi-table closes-table' },
        h('thead', null, h('tr', null, h('th', { class: 'l' }, 'Week'), h('th', null, 'Sold'), h('th', null, 'Net after fees'), h('th', null, 'Tracker\u2019s net'), h('th', null, 'Difference'),
          h('th', null, 'Broker fees and tax'), h('th', null, 'Wallet change'), h('th', null, 'Wallet at close'), h('th', null, 'In buy orders'))),
        h('tbody', null, c.rows.slice(0, 8).map(r => h('tr', { class: r.closed ? '' : 'is-open' },
          h('td', { class: 'l' }, day(r.start) + ' to ' + day(r.end - D), h('span', { class: 'sub' }, r.closed ? 'closed' : 'this week so far')),
          h('td', null, L.short(r.gross), h('span', { class: 'sub' }, plural(r.units, 'unit'))),
          r.locked ? h('td', null, L.short(r.tracker), h('span', { class: 'sub' }, 'the tracker\u2019s figure'),
            h('span', { class: 'sub' }, 'page worked out ' + L.short(r.net) + (r.uncovered ? ', ' + plural(r.uncovered, 'unit') + ' without a cost' : '')))
          : h('td', null, L.short(r.net),
            r.uncovered ? h('span', { class: 'sub neg' }, plural(r.uncovered, 'unit') + ' without a cost') : null,
            r.uncovered && gapText(r) ? h('span', { class: 'sub gaps', title: gapTitle(r) }, gapText(r)) : null,
            r.borrowed ? h('span', { class: 'sub' }, plural(r.borrowed, 'unit') + ' at tracker cost') : null,
            r.stale ? h('span', { class: 'sub' }, 'before the newest costs') : !r.uncovered && !r.borrowed ? h('span', { class: 'sub' }, 'wallet costs') : null),
          h('td', null, r.closed ? box('t' + r.key, r.tracker, 'Tracker net for the week of ' + day(r.start), v => setTracker(r.key, v)) : ''),
          r.locked ? h('td', null, 'Set to tracker', h('button', { type: 'button', class: 'linkish', onclick: () => setLock(r.key, false) }, 'Undo'))
          : h('td', { class: r.tied == null ? '' : r.tied ? 'best' : 'neg' }, r.tied == null ? '' : [r.tied ? 'Tied' : 'Off', h('span', { class: 'sub' }, signed(r.diff)),
            r.tied ? null : h('button', { type: 'button', class: 'linkish', onclick: () => setLock(r.key, true) }, 'Use the tracker\u2019s figure')]),
          h('td', null, r.fees == null ? '' : L.short(r.fees)),
          h('td', null, r.change == null ? '' : signed(r.change)),
          h('td', null, r.close == null ? '' : L.isk(Math.round(r.close)), r.closeSeen ? h('span', { class: 'sub' }, 'as seen ' + clock(r.closeSeen)) : r.closed ? null : h('span', { class: 'sub' }, 'now')),
          h('td', null, r.escrow == null ? '' : L.short(r.escrow), r.escrowSeen ? h('span', { class: 'sub' }, 'as seen ' + clock(r.escrowSeen)) : r.closed ? null : h('span', { class: 'sub' }, 'now'))))))),
      h('p', { class: 'note' }, 'Weeks run Monday to Sunday on this device\u2019s clock. Sold and net come from your sales. Cost is what the wallet shows you paid, first in, first out; units the wallet has no purchase for take the tracker\u2019s unit cost for that item (its row at the same hub, listed most recently before the sale). A closed week is fixed, and worked out again only when newer tracker rows are pasted while EVE still has that week\u2019s sales. '
        + 'Fees, wallet change and wallet at close are exact, from the wallet journal, which EVE keeps for 30 days. In buy orders is as this page last saw it that week. '
        + 'A finished week that is off can be set to the tracker\u2019s figure: it then counts at that figure in "to date" and is left out of the tie-out, because it was adopted and not checked.'));
  }

  function pin(rows) {
    const at = Date.now();
    rows.forEach(r => { S.pins[r.id] = { price: r.plan.target, at }; });
    if (!demo) E.store.set('eveops.pins', S.pins);
    syncSoon(); paint();
  }
  function unpin(s) {
    const at = Date.now();
    s.sells.concat(s.bids).forEach(r => { if (S.pins[r.id]) S.pins[r.id] = { gone: true, at }; });
    if (!demo) E.store.set('eveops.pins', S.pins);
    syncSoon(); paint();
  }

  // ------------------------------------------------- sync between devices
  const PIN_KEEP = 36 * H;
  const syncDoc = () => ({ v: 1, pins: S.pins, copied: S.copied, seen: S.seen, costs: S.costs, risk: S.riskSet, weeks: S.weeks });
  function syncApply(d) {
    S.pins = d.pins || {}; S.copied = d.copied || {}; S.seen = d.seen || S.seen; S.weeks = Object.assign({ carried: null, w: {} }, d.weeks); S.costs = d.costs || S.costs; S.riskSet = d.risk || S.riskSet;
    if (!demo) { E.store.set('eveops.costs', S.costs); E.store.set('eveops.risk', S.riskSet); E.store.set('eveops.pins', S.pins); E.store.set('eveops.copied', S.copied); E.store.set('eveops.seen', S.seen); E.store.set('eveops.weeks', S.weeks); }
  }
  let syncTimer = 0;
  function syncNow() {
    clearTimeout(syncTimer);
    if (!window.Sync || !window.Sync.on) return Promise.resolve(false);
    return window.Sync.cycle(syncDoc, syncApply, { pins: PIN_KEEP, copied: C.copied.keepHours * H }).then(ok => { paint(); return ok; });
  }
  /** A change made here goes up a few seconds later, so a run of presses makes one write. */
  function syncSoon() { if (window.Sync && window.Sync.on) { clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 3000); } }
  /**
   * Asks the app whether Android lets it post notifications, and with `ask` has Android put its own question to the owner
   * (Android shows that question at most twice; after two refusals only the phone's settings can turn them on).
   * A build of the app from before notifications does not answer at all.
   */
  function notifyState(ask) {
    if (!E.native) return;
    E.ask('notify', ask ? { ask: true } : {}).then(r => { S.notifyAllowed = typeof r.allowed === 'boolean' ? r.allowed : 'old'; S.notifySettings = !!r.settings; paint(); },
      () => { S.notifyAllowed = 'old'; paint(); });
  }
  /** In the Android app only: which things the phone should notify about. The app does the notifying, from the summary the page hands it. */
  function notifyPanel(m) {
    if (!E.native) return null;
    const askAndroid = () => { notifyState(true); setTimeout(() => notifyState(false), 4000); setTimeout(() => notifyState(false), 12000); };   // look again once Android's question has been answered
    const set = (kind, on) => {
      S.notify = Object.assign({}, S.notify, { [kind]: on });
      E.store.set('eveops.notify', S.notify);
      if (on) askAndroid(); else notifyState(false);
      paint();
    };
    const any = S.notify.change || S.notify.extractors || S.notify.launchpad;
    const count = kind => m.alerts.filter(a => a.kind === kind).length;
    const row = (kind, label, now) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: S.notify[kind], onchange: e => set(kind, e.target.checked) }), h('span', null, label, h('span', { class: 'sub' }, now)));
    return h('section', { class: 'panel panel-notify' }, h('h3', null, 'Phone notifications'),
      row('change', 'An order loses the lead', count('change') ? plural(count('change'), 'order') + ' to change now' : 'none now'),
      row('extractors', 'Extractors stop', count('extractors') ? plural(count('extractors'), 'colony', 'colonies') + ' stopped now' : 'all running'),
      row('launchpad', 'A launchpad is nearly full', count('launchpad') ? plural(count('launchpad'), 'colony', 'colonies') + ' at 85% or more' : 'none now'),
      any && S.notifyAllowed === true ? h('p', { class: 'note' }, h('span', { class: 'best' }, 'Android allows notifications from Eve Ops.')) : null,
      any && S.notifyAllowed === false ? [
        h('p', { class: 'note neg' }, 'Android has not allowed notifications from Eve Ops yet.'),
        h('div', { class: 'tools' },
          h('button', { type: 'button', class: 'btn', onclick: askAndroid }, 'Ask Android to allow them'),
          S.notifySettings ? h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => E.tell('notify-settings', {}) }, 'Open Android\u2019s settings for Eve Ops') : null),
        h('p', { class: 'note' }, 'Android should show its own question, "Allow Eve Ops to send you notifications?". If nothing appears, turn them on by hand: press and hold the Eve Ops icon on the home screen, choose App info, then Notifications. The phone\u2019s general list of notifying apps may not show Eve Ops until then.')] : null,
      any && S.notifyAllowed === 'old' ? h('p', { class: 'note neg' }, 'This build of the app cannot notify. Install the newest Eve Ops APK.') : null,
      h('p', { class: 'note' }, 'The app checks about every half hour while it is closed and tells you once about each new thing. Routine changes only: big moves, snipers and slow lines stay quiet.'));
  }
  function syncPanel() {
    const Y = window.Sync;
    if (!Y) return null;
    const st = Y.state;
    const on = () => {
      const el = root.querySelector('[data-keep="sync-token"]');
      S.syncNote = 'Asking GitHub.'; paint();
      Y.enable(el ? el.value : '').then(r => { S.syncNote = r.made ? 'Sync is on. This device made the shared file.' : 'Sync is on. This device joined the shared file.'; return syncNow(); },
        err => { S.syncNote = err.message || String(err); paint(); });
    };
    return h('section', { class: 'panel panel-sync' }, h('h3', null, 'Sync between devices'),
      st.on ? [
        h('p', { class: 'note' }, st.err ? h('span', { class: 'neg' }, st.err) : st.last ? ['On. Last checked ', live('ago', st.last), '.'] : 'On. Checking.'),
        h('p', { class: 'note' }, 'Shared: pins, copied marks, "Mark as seen", the weekly closes and the exposure limits.'),
        h('div', { class: 'tools' },
          h('button', { type: 'button', class: 'btn btn-quiet', disabled: st.busy, onclick: () => { syncNow(); } }, 'Sync now'),
          h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { Y.disable(); S.syncNote = 'Sync is off on this device. The shared file was left on GitHub.'; paint(); } }, 'Turn off here'))]
        : [
          h('p', { class: 'note' }, 'Keeps pins, copied marks, "Mark as seen" and the weekly closes the same on your PC, tablet and phone, through one small file in a secret gist on your GitHub account.'),
          h('p', { class: 'note' }, 'Make a token at ', h('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener noreferrer' }, 'GitHub, fine-grained tokens'),
            ': no repository access, and under Account permissions set Gists to read and write. Paste the same token on each device.'),
          h('div', { class: 'tools' },
            h('input', { class: 'isk-in sync-in', type: 'password', autocomplete: 'off', spellcheck: 'false', 'data-keep': 'sync-token', 'aria-label': 'GitHub token for sync', placeholder: 'GitHub token', onkeydown: e => { if (e.key === 'Enter') on(); } }),
            h('button', { type: 'button', class: 'btn btn-quiet', onclick: on }, 'Turn on'))],
      S.syncNote ? h('p', { class: 'note' }, S.syncNote) : null);
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
        fact('Today', L.short(m.today.net), L.short(m.today.gross) + ' sold'),
        fact('Price changes', h('span', { class: m.week.net > 0 && m.risk.bumps.fee > C.risk.feeShare * m.week.net ? 'neg' : '', id: 'bumps' }, plural(m.risk.bumps.n, 'change')),
          m.risk.bumps.n ? L.short(m.risk.bumps.fee) + ' in fees' + (m.week.net > 0 ? ', ' + (m.risk.bumps.fee / m.week.net * 100).toFixed(1) + '% of net' : '') : 'none seen this week'),
        m.closes && fact('Realized net to date', h('a', { href: '#closes', onclick: e => { e.preventDefault(); const el = document.getElementById('closes'); if (el) el.scrollIntoView({ behavior: 'smooth' }); } }, L.short(m.closes.toDate)), m.closes.carried == null ? 'since ' + new Date(m.closes.since).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : 'with the tracker\u2019s earlier weeks')),
      h('div', { class: 'bars', role: 'list', 'aria-label': 'Net after fees per day, last 14 days' },
        m.days.map((d, i) => {
          const day = new Date(d.day).toLocaleDateString('en-CA', { weekday: 'long', month: 'short', day: 'numeric' });
          return h('span', { class: 'bar' + (i === m.days.length - 1 ? ' is-today' : ''), role: 'listitem', tabindex: 0, 'aria-label': day + ': net ' + L.short(d.net) + ', sold ' + L.short(d.gross) },
            h('span', { class: 'tip' }, h('b', null, day), h('span', null, 'Net ' + L.short(d.net)), h('span', null, 'Sold ' + L.short(d.gross) + ', ' + plural(d.units, 'unit'))),
            h('span', { class: 'col' }, h('i', { style: { height: Math.max(2, Math.round(Math.max(d.net, 0) / top * 100)) + '%' } })),
            h('b', { class: 'day' }, new Date(d.day).toLocaleDateString('en-CA', { weekday: 'narrow' })));
        })),
      h('p', { class: 'note' }, 'Best of the last 14 days: ' + L.short(best.net) + ' on ' + new Date(best.day).toLocaleDateString('en-CA', { weekday: 'long' }) + '.'
        + (m.week.uncovered ? ' ' + plural(m.week.uncovered, 'unit') + ' sold this week had no purchase on record, so they add to "Sold" but not to net.' : '')
        + (m.risk.changeNow.n ? ' Making every change on the board now would cost ' + L.short(m.risk.changeNow.fee) + '.' : '')));
  }
  function booksPanel(m) {
    return h('section', { class: 'panel' },
      h('h3', null, 'Capital'),
      h('dl', { class: 'facts' },
        fact('Wallet', m.wallet == null ? '' : L.isk(Math.round(m.wallet))),
        fact('In buy orders', L.isk(Math.round(m.escrow)), plural(m.bidCount, 'bid')),
        fact('Listed, at your prices', L.isk(Math.round(m.listed))),
        fact('Hangars and ships', m.priced ? L.isk(Math.round(m.held)) : '', m.priced ? 'at EVE average prices' : 'loading prices'),
        h('div', { class: 'fact fact-total' }, h('dt', null, m.scout ? 'Overall wealth, ' + S.who.name : 'Overall wealth'), h('dd', null, m.wealth == null ? '' : L.isk(Math.round(m.wealth)))),
        m.scout && fact(m.scout.name, L.isk(Math.round(m.scout.wealth)), 'wallet ' + L.short(m.scout.wallet) + ', hangars and ships ' + L.short(m.scout.held)),
        m.both != null && h('div', { class: 'fact fact-total' }, h('dt', null, 'Both characters'), h('dd', null, L.isk(Math.round(m.both))))),
      h('dl', { class: 'facts facts-more' },
        fact('Listed, at cost', L.isk(Math.round(m.listedCost)), m.uncosted ? plural(m.uncosted, 'unit') + ' without a cost' : 'estimate'),
        m.slots && fact('Order slots', m.slots.used + ' of ' + m.slots.max)));
  }
  function setLimit(key, text) {
    const v = L.parseIsk(String(text).trim());
    if (v == null || v < 0) return paint();
    S.riskSet = { v: Object.assign(limits(), { [key]: v }), at: Date.now() };
    if (!demo) E.store.set('eveops.risk', S.riskSet);
    syncSoon(); paint();
  }
  /** Every committed ISK (buy orders, and stock at what it cost) by the hub it is headed for, against three limits that can be typed over. */
  function riskPanel(m) {
    const ex = m.risk.ex, lim = m.risk.lim;
    const box = (key, label) => h('input', { class: 'isk-in lim-in', type: 'text', inputmode: 'decimal', 'data-keep': 'lim-' + key, 'aria-label': label, value: L.short(lim[key]),
      onchange: e => setLimit(key, e.target.value), onkeydown: e => { if (e.key === 'Enter') e.target.blur(); } });
    const row = (label, value, bad, limit) => h('div', { class: 'fact' }, h('dt', null, label, limit ? h('span', { class: 'sub lim' }, limit) : null), h('dd', { class: bad ? 'neg' : '' }, value));
    return h('section', { class: 'panel panel-risk', id: 'risk' },
      h('h3', null, 'Exposure'),
      h('p', { class: 'gate' }, h('span', { class: 'chip ' + (ex.gate.open ? 'chip-lead' : 'chip-pull') }, ex.gate.open ? 'New lines: open' : 'New lines: closed'),
        ex.gate.open ? h('span', { class: 'sub' }, 'Every limit below has room.') : ex.gate.why.map(t => h('span', { class: 'sub neg' }, t))),
      h('dl', { class: 'facts' },
        row('Committed', L.short(ex.total), false, 'buy orders, and stock at cost'),
        row('In unproven lines', L.short(ex.unproven), ex.unproven > lim.unproven, ['at most ', box('unproven', 'The most to have committed to unproven lines')]),
        row('Wallet', m.wallet == null ? '' : L.short(m.wallet), m.wallet != null && m.wallet < lim.reserve, ['keep back ', box('reserve', 'The wallet to keep back')])),
      h('dl', { class: 'facts facts-more' },
        h('div', { class: 'fact' }, h('dt', null, 'Headed for', h('span', { class: 'sub lim' }, 'any one hub at most ', box('hub', 'The most headed for any one hub'))), h('dd', null, '')),
        ex.hubs.map(x => row(x.name, L.short(x.isk), x.over)),
        ex.loose > 0 ? row('No hub read yet', L.short(ex.loose), false) : null),
      h('p', { class: 'note' }, 'A buy order counts where its line sells: split by your own sales there, or for a line you have not sold yet by what each hub trades. A line is unproven until half of its first lot has sold at ' + Math.round(C.risk.floor * 100) + '% or better. '
        + 'While a limit is passed, new lines stay closed; re-bids on proven lines are not held back.'));
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
    return h('section', { class: 'panel' }, h('h3', null, 'Skill Queue' + (m.scout ? ', ' + S.who.name : '')),
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
  function scoutSkills(m) {
    const sc = m.scout;
    if (!sc) return null;
    return h('section', { class: 'panel' }, h('h3', null, 'Skill Queue, ' + sc.name),
      sc.queue.length ? [h('ul', { class: 'timers' }, sc.queue.slice(0, 6).map((x, i) => h('li', null,
        h('span', { class: 't-what' }, x.name + ' ' + roman[x.level], h('span', { class: 'sub' }, i === 0 ? 'training now' : 'queued')),
        h('span', { class: 't-when' }, 'Done ', live('until', x.done), h('span', { class: 'sub' }, clock(x.done)))))),
        h('p', { class: 'note' }, (sc.queue.length > 6 ? plural(sc.queue.length - 6, 'more skill') + ' after these. ' : '') + 'Queue ends ' + new Date(sc.queue[sc.queue.length - 1].done).toLocaleString('en-CA', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '.')]
        : h('ul', { class: 'timers' }, h('li', { class: sc.paused ? '' : 'is-soon' }, h('span', { class: 't-what' }, 'Nothing training'), h('span', { class: 't-when' }, sc.paused ? 'Queue is paused' : 'Queue is empty'))));
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
          x.drop ? h('span', { class: 'sub neg' }, 'Clear and drop: ' + (x.drop.lot ? num(x.drop.sold) + ' of ' + num(x.drop.lot) + ' sold' : 'never bought or sold on record')) : null,
          h('span', { class: 'sub' }, x.clear != null ? Math.round(x.clear) + ' days to clear at this pace' : 'no sales this week')))))
        : h('p', { class: 'note' }, m.windowDays < C.staleDays ? 'Needs ' + C.staleDays + ' days of sales history; EVE has returned ' + Math.floor(m.windowDays) + '.' : 'Every line has sold in the last ' + C.staleDays + ' days and clears within a month.'));
  }
  function dataPanel() {
    const names = ['Market books', 'Your orders', 'Wallet', 'Sales and purchases', 'Wallet journal', 'Hangars', 'Planets', 'Kill feed', 'Item prices', 'Price history', 'Loot prices', 'Location', 'Skills and clones', 'Routes'];
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
    const ship = S.ship ? ', flying ' + nameOf(S.ship.ship_type_id) + (S.ship.ship_name ? ' "' + L.shipName(S.ship.ship_name) + '"' : '') : '';
    const f = S.feeds['Market books'];
    return h('header', { class: 'top' },
      h('div', { class: 'who' }, h('h1', null, S.who.name), h('p', null, where + ship)),
      h('nav', { class: 'views', 'aria-label': 'Views' }, [['trade', 'Trading'], ['wh', 'Wormholes'], ['ex', 'Expedition']].map(v =>
        h('button', { type: 'button', class: 'view' + (S.view === v[0] ? ' is-on' : ''), 'aria-pressed': S.view === v[0] ? 'true' : 'false', onclick: () => setView(v[0]) }, v[1]))),
      m && h('dl', { class: 'purse' },
        h('div', null, h('dt', null, m.both != null ? 'Overall wealth, both' : 'Overall wealth'), h('dd', { title: m.wealth == null ? '' : L.isk(Math.round(m.both != null ? m.both : m.wealth)) }, m.wealth == null ? '' : L.short(m.both != null ? m.both : m.wealth))),
        h('div', null, h('dt', null, 'Wallet'), h('dd', { title: m.wallet == null ? '' : L.isk(m.wallet) }, m.wallet == null ? '' : L.short(m.wallet))),
        h('div', null, h('dt', null, 'In buy orders'), h('dd', null, L.short(m.escrow))),
        h('div', null, h('dt', null, 'Net since Monday'), h('dd', null, L.short(m.week.net)))),
      h('div', { class: 'sync' },
        S.update && h('button', { type: 'button', class: 'btn btn-update', onclick: () => location.reload() }, 'Update ready, reload'),
        h('p', null, f && f.at ? ['Market books ', live('age', f.at), h('span', { class: 'sub' }, live('next', f.next))] : S.running ? 'Loading' : ''),
        h('button', { type: 'button', class: 'btn', disabled: S.running, onclick: run }, S.running ? 'Loading' : 'Refresh')));
  }

  function setView(v) {
    S.view = v;
    if (!demo) history.replaceState(null, '', v === 'wh' ? '#wormholes' : v === 'ex' ? '#expedition' : location.pathname);
    paint();
  }
  /**
   * Expedition ops needs no EVE sign-in and no network, so it can stand alone: this is the page when nobody is signed in
   * and the address asks for it. Signed in, it is a third view under the usual top bar.
   */
  function expeditionAlone() {
    const y = window.scrollY;
    root.replaceChildren(
      demo ? h('p', { class: 'banner' }, 'Sample data: an invented crew. ', h('a', { href: './' }, 'Leave sample data')) : '',
      h('header', { class: 'top top-bare' }, h('div', { class: 'who' }, h('h1', null, 'Eve Ops'), h('p', null, 'Not signed in to EVE. Expedition ops works without it.')),
        h('nav', { class: 'views', 'aria-label': 'Views' }, h('button', { type: 'button', class: 'view', onclick: () => { history.replaceState(null, '', location.pathname); S.view = 'trade'; loginView(S.notice); } }, 'Sign in for Trading and Wormholes'))),
      window.Ex.view(paint));
    window.scrollTo(0, y);
  }
  function paint() {
    if (!demo && !E.who()) return S.view === 'ex' && window.Ex ? expeditionAlone() : loginView(S.notice || 'Your sign-in ended. Log in again to carry on.');
    const m = S.ready ? build() : null;
    share(m);
    const y = window.scrollY;
    const act = document.activeElement, typing = act && act.getAttribute && act.getAttribute('data-keep') ? { key: act.getAttribute('data-keep'), value: act.value, a: act.selectionStart, b: act.selectionEnd } : null;
    if (typing) setTimeout(() => {          // a repaint must not take a half-typed figure away
      const el = root.querySelector('[data-keep="' + typing.key + '"]');
      if (el && document.activeElement !== el) { el.value = typing.value; el.focus({ preventScroll: true }); try { el.setSelectionRange(typing.a, typing.b); } catch (e) { /* not a text box */ } }
    }, 0);
    if (S.view === 'ex' && window.Ex) {
      root.replaceChildren(demo ? h('p', { class: 'banner' }, 'Sample data: an invented crew. ', h('a', { href: './' }, 'Leave sample data')) : '', topView(m), window.Ex.view(paint));
      return window.scrollTo(0, y);
    }
    if (S.view === 'wh' && window.Wh) {
      root.replaceChildren(demo ? h('p', { class: 'banner' }, 'Sample data. ', h('a', { href: './' }, 'Leave sample data')) : '', topView(m), window.Wh.view(paint, m ? lootView(m) : null));
      return window.scrollTo(0, y);
    }
    root.replaceChildren(
      demo ? h('p', { class: 'banner' }, 'Sample data. Routes are real, the orders and ISK are invented. ', h('a', { href: './' }, 'Leave sample data')) : '',
      topView(m),
      m ? h('main', { class: 'board' },
        h('div', { class: 'stops' }, m.stops.length ? [tripView(m), tabsView(m), stopView(m.stops.find(s => s.id === m.tab) || m.stops[0], m), piView(m), closesView(m)] : [h('p', { class: 'empty' }, 'No open orders. Place one in game and it appears here within 20 minutes.'), piView(m), closesView(m)]),
        h('aside', { class: 'side' }, feedPanel(m), weekPanel(m), booksPanel(m), riskPanel(m), piPanel(m), skillPanel(m), scoutSkills(m), clonePanel(m), slowPanel(m), notifyPanel(m), syncPanel(), dataPanel()))
        : h('main', { class: 'board' }, h('p', { class: 'empty' }, 'Loading your orders.')));
    root.querySelectorAll('.row > .call').forEach(el => { if (el.classList.contains('is-open') || el.scrollHeight > el.clientHeight + 2) el.classList.add('has-more'); });
    window.scrollTo(0, y);
  }

  /**
   * What the Android app's home-screen widgets show: a short summary of the board, handed to the app
   * a moment after each repaint. Times are absolute so the widgets stay right between refreshes.
   */
  function widgetData(m) {
    const rows = s => s.sells.concat(s.bids);
    const hubs = m.stops.map(s => ({ name: s.short, change: s.change, optional: s.optional, check: s.check, orders: rows(s).length, here: !!s.docked, jumps: s.jumps,
      hold: rows(s).filter(r => r.plan.action === 'hold' && !(r.pos && r.pos.status === 'leading')).length }));
    const sys = S.loc && K.systems[S.loc.solar_system_id], docked = S.loc && (S.loc.station_id || S.loc.structure_id);
    const sc = m.scout, sell = sc && sc.sell && sc.sell.ready && sc.loot.length ? sc.sell : null;
    return {
      v: 1, at: m.now, pilot: S.who.name, sample: demo,
      where: !S.loc ? '' : (docked ? 'Docked in ' : 'In space in ') + (sys ? sys.name : 'an unknown system'), ship: S.ship ? nameOf(S.ship.ship_type_id) : '',
      wealth: m.both != null ? m.both : m.wealth, both: m.both != null, wallet: m.wallet, escrow: m.escrow, listed: m.listed, week: m.week.net, today: m.today.net,
      orders: { sells: sum(m.stops, s => s.sells.length), bids: m.bidCount, change: sum(hubs, x => x.change), optional: sum(hubs, x => x.optional), check: sum(hubs, x => x.check), hold: sum(hubs, x => x.hold),
        used: m.slots ? m.slots.used : null, max: m.slots ? m.slots.max : null },
      hubs, booksAt: (S.feeds['Market books'] || {}).at || 0,
      pi: m.pi ? { go: m.pi.go, value: m.pi.value, perDay: m.pi.perDay, units: Math.round(m.pi.units), m3: Math.round(m.pi.m3), full: m.pi.full, reach: m.pi.reach, worth: C.pi.worth, system: m.pi.system, stopped: m.pi.stopped,
        near: m.pi.near && isFinite(m.pi.near.jumps) ? m.pi.near.name : '', nearJumps: m.pi.near && isFinite(m.pi.near.jumps) ? m.pi.near.jumps : null, from: m.pi.from } : null,
      planets: m.planets.map(p => ({ name: p.name, expiry: p.expiry, product: p.product ? nameOf(p.product) : '', units: p.units ? Math.round(p.units[0]) : null, fill: p.fill || 0 })),
      skill: m.queue[0] || null, skillEnd: m.queue.length ? m.queue[m.queue.length - 1].done : null, paused: m.paused.length > 0,
      scout: sc ? { name: sc.name, wealth: sc.wealth, wallet: sc.wallet, skill: sc.queue[0] || null,
        loot: sc.loot ? { places: sc.loot.length, value: sum(sc.loot, p => p.value), m3: Math.round(sum(sc.loot, p => p.m3)),
          list: sell ? sell.split.list : null, now: sell ? sell.split.now : null, hub: sell ? sell.hubs.reduce((a, b) => (b.list > a.list ? b : a)).name : '' } : null } : null,
      wh: window.Wh && window.Wh.summary ? window.Wh.summary() : null,
      problems: Object.keys(S.feeds).filter(n => S.feeds[n].err).length,
      alerts: m.alerts, notify: S.notify,
    };
  }
  let shareTimer = 0;
  function share(m) {
    if (!E.native || !m) return;
    clearTimeout(shareTimer);
    shareTimer = setTimeout(() => { try { E.tell('snapshot', { settled: !S.running, data: widgetData(m) }); } catch (err) { /* the next repaint tries again */ } }, 1200);
  }

  /** The phone's browser after an EVE sign-in that the Android app started: send the one-time code on to the app. */
  function handoffView(url) {
    root.replaceChildren(h('main', { class: 'door' },
      h('h1', null, 'Eve Ops'),
      h('p', { class: 'lede' }, 'EVE has approved the sign-in. Go back to the app to finish.'),
      h('a', { class: 'btn btn-big', href: url }, 'Return to the Eve Ops app'),
      h('p', { class: 'small' }, 'If nothing happens, the Eve Ops app is not installed on this device. You can close this tab.')));
    setTimeout(() => { location.href = url; }, 250);      // most browsers hand over without the tap
  }

  function loginView(notice) {
    const ready = !!C.clientId;
    root.replaceChildren(h('main', { class: 'door' },
      h('h1', null, 'Eve Ops'),
      h('p', { class: 'lede' }, 'Your open orders against the live book, the exact price to type at each hub, and the route between them.'),
      notice && h('p', { class: 'door-note' }, notice),
      ready
        ? h('button', { type: 'button', class: 'btn btn-big', onclick: e => { if (!E.native) e.currentTarget.disabled = true; Promise.resolve(E.login()).catch(err => loginView(err.message)); } }, 'Log in with EVE')
        : h('p', { class: 'door-note' }, 'Sign-in is not switched on yet: the EVE application’s Client ID still has to be added to this page.'),
      h('p', { class: 'small' }, 'Log in with the character that holds your market orders. Access is read-only, and the sign-in is kept ' + (E.native ? 'in this app only.' : 'in this browser only.')),
      h('p', { class: 'small' }, h('a', { href: '#demo' }, 'Look around with sample data')),
      window.Ex ? h('p', { class: 'small' }, h('a', { href: '#expedition' }, 'Expedition ops'), ': the camp\u2019s muster and kit. No sign-in or network needed.') : null));
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
  /** Keeps a copy of the page on the device, so it opens with no network (Expedition ops is fully usable that way). */
  function keepOffline() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js?v=' + (VERSION || '0')).catch(() => { /* the page works as before without it */ });
  }
  async function boot() {
    keepOffline();
    if (S.view === 'ex' && window.Ex && S.who) paint();          // nothing to wait for
    window.addEventListener('hashchange', () => {
      if ((location.hash === '#demo') !== demo) return location.reload();
      S.view = viewOf(location.hash);
      paint();
    });
    if (demo) S.who = window.Demo.who;
    else {
      let done = false;
      try { done = await E.finishLogin(); } catch (err) { S.notice = err.message; }
      if (done && done.handoff) return handoffView(done.handoff);
      if (done === 'scout') { S.view = 'wh'; history.replaceState(null, '', '#wormholes'); }
      try { await E.init(); } catch (err) { S.notice = err.message; }
      S.who = E.who();
      if (!S.who) return paint();                 // the sign-in screen, or Expedition ops when the address asks for it
    }
    const scout = () => (window.Wh && window.Wh.signedIn() ? window.Wh.tick().then(moved => { if (moved && S.view === 'wh') paint(); }, () => {}) : null);
    if (S.view === 'wh') paint();
    scout();
    syncNow();
    notifyState(S.notify.change || S.notify.extractors || S.notify.launchpad);     // a notification is wanted: let Android ask if it has not been allowed yet
    await run();
    let n = 0;
    setInterval(async () => {
      stamp();
      if (document.hidden) return;
      scout();
      if (S.running) return;
      if (!demo && !E.who()) return paint();
      n++;
      if (n % 20 === 0) checkVersion();          // every five minutes
      if (n % 4 === 0) { syncNow(); return run(); }           // once a minute: fetch whatever EVE has republished, and what the other devices changed
      try { if (await loadLocation()) { await loadRoutes(); paint(); } } catch (err) { /* next tick */ }
    }, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { wake(); syncNow(); notifyState(false); run(); } });
    window.addEventListener('eveops-resume', () => notifyState(false));     // the app came back to the front, perhaps from Android's question or its settings
  }
  boot();
})();
