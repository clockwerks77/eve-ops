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
  const S = {
    who: null, loc: null, ship: null, wallet: null,
    orders: [], ordersAt: 0, tx: [], assets: [], books: new Map(), jumps: new Map(),
    queue: [], skills: null, clones: null, planets: [], kills: new Map(), routes: {},
    feeds: {}, ready: false, running: false, notice: null,
    pins: (!demo && E.store.get('eveops.pins')) || {}, wantWake: false, wake: null,
    prices: new Map(), tab: null, follow: true, view: location.hash === '#wormholes' ? 'wh' : 'trade', hist: new Map(), piNear: null, piFrom: null, history: [], scout: null, lootBooks: new Map(), lootVol: new Map(), lootSig: '', lootAt: 0, lootJumps: {},
    seen: (!demo && E.store.get('eveops.seen')) || null, cargo: (!demo && E.store.get('eveops.cargo')) || C.haul.cargo,
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
  async function loadOrders() {
    const r = await E.get(me() + '/orders/', { auth: true }); S.orders = r.data; S.ordersAt = r.modified; feed('Your orders', r);
    S.history = await E.get(me() + '/orders/history/', { auth: true }).then(x => x.data, () => S.history);
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
  /** Lines that sold in the last 7 days at a hub and have nothing listed there now. Map "station:type" -> units sold. */
  function soldOut(now) {
    const open = new Set(S.orders.filter(o => !o.is_buy_order).map(o => o.location_id + ':' + o.type_id));
    const m = new Map();
    for (const t of S.tx) {
      if (t.is_buy || now - Date.parse(t.date) > 7 * D || !hubOf.has(t.location_id)) continue;
      if (C.excludeTypes.indexOf(t.type_id) >= 0 || C.zeroCostTypes.indexOf(t.type_id) >= 0) continue;
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
    }
    for (const p of S.planets) if (p.product) for (const hb of C.hubs) want.set(hb.region + ':' + p.product, [hb.region, p.product]);
    const waiting = Array.from(hangarAt(C.jita.station).keys());
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
      await load('Planets', loadPlanets);
      await Promise.all([load('Market books', loadBooks), load('Routes', loadRoutes), load('Item prices', loadPrices), load('Second character', loadScout)]);
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
    const led = L.ledger(S.tx, { netMult: NET, exclude: new Set(C.excludeTypes), zeroCost: zero });
    const vel = L.velocity(led.sales, now);
    const myIds = new Set(S.orders.map(o => o.order_id));
    const windowDays = led.from ? (now - led.from) / D : 0;
    const hubSet = new Set(C.hubs.map(x => x.station));

    const listedByType = new Map();
    for (const o of S.orders) if (!o.is_buy_order) listedByType.set(o.type_id, (listedByType.get(o.type_id) || 0) + o.volume_remain);
    const costOf = type => (zero.has(type) ? { cost: 0, units: Infinity } : L.unitCost(led.lots, type, listedByType.get(type) || 0));
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
      restock.push({ type, name: nameOf(type), hub: hubName(loc), left, perDay: d7 / 7, days, bid, coming, want: Math.max(0, Math.round(d7) - left - coming), net, margin, thin: margin != null && margin < C.restock.minMargin });
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
          expires: Date.parse(x.order.issued) + x.order.duration * D, region: x.order.region_id,
          week: S.hist.get(x.order.region_id + ':' + x.order.type_id) || null,
          checks: L.orderChecks({ isBuy: false, price, duration: x.order.duration, known: hubSet.has(x.order.location_id), front: x.pos ? x.pos.front : null, cost, netMult: NET }),
          plan: plan.get(x.order.order_id) || { action: 'wait', reason: 'Waiting for the market book.', target: null },
          pin: pinOf(x.order.order_id, price),
        });
      }
      consider(o0.type_id, o0.location_id, left, v.d7, g.reduce((m, x) => Math.min(m, x.pos ? x.pos.price : x.order.price), Infinity));
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
        expires: Date.parse(o.issued) + o.duration * D, region: o.region_id, week: null,
        checks: L.orderChecks({ isBuy: true, price, duration: o.duration, known: hubSet.has(o.location_id), wall: pos ? pos.wall : null }),
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
    const order = r => (r.checks.length ? -2 : r.pin && !r.pin.done ? -1 : rank[r.plan.action] + (r.plan.action === 'hold' && r.pos && r.pos.status === 'leading' ? 1 : 0));
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
        check: rows.filter(x => x.checks.length).length,
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
    const away = C.hubs.filter(hb => hb.station !== C.jita.station);
    const haulRows = Array.from(jitaHang, e => {
      const asks = away.map(hb => ({ name: hb.name, ask: ask(e[0], hb), sold: (vel.get(e[0] + ':' + hb.station) || {}).d7 || 0 }));
      const proven = asks.filter(a => a.ask != null && a.sold > 0);
      const pool = proven.length ? proven : asks.filter(a => a.ask != null);
      const best = pool.length ? pool.reduce((a, b) => (b.ask > a.ask ? b : a)) : null;
      return { type: e[0], name: nameOf(e[0]), qty: e[1], m3: e[1] * ((K.types[e[0]] || {}).v || 0), asks, best: best ? best.name : null };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const haul = { rows: haulRows, units: sum(haulRows, r => r.qty), m3: sum(haulRows, r => r.m3), cargo: S.cargo };

    // ---- what changed since the baseline ("Mark as seen")
    const snapshot = {};
    for (const st of list) for (const r of st.sells.concat(st.bids)) snapshot[r.id] = { t: r.type, l: st.id, b: st.bids.indexOf(r) >= 0, s: r.pos ? r.pos.status : '' };
    if (!S.seen && Object.keys(snapshot).length && S.books.size) { S.seen = { at: now - D, orders: snapshot }; if (!demo) E.store.set('eveops.seen', S.seen); }
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
      restock: restock.slice(0, 12), haul, changes, snapshot, seenAt: S.seen ? S.seen.at : null,
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
      : String(r.plan.reason || '').replace(/^Sniper: (.)/, (x, c) => c.toUpperCase());
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
      why && h('span', { class: 'why' }, read ? why.replace(' Dump or repricing: your call.', '') + ' ' + read : why));
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

  function stopView(s, m) {
    const state = s.docked ? 'Docked here' : s.inSystem ? 'In this system' : s.jumps != null ? plural(s.jumps, 'jump') + ' away' : '';
    const pinnable = s.sells.concat(s.bids).filter(r => r.plan.action === 'tick' && r.plan.target != null && !(r.pin && !r.pin.done));
    const summary = [];
    if (s.check) summary.push(s.check + ' to check');
    if (s.change) summary.push(s.change + ' to change');
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
          s.pinned ? h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => unpin(s) }, 'Clear pins') : null)),
      s.sells.length ? h('div', { class: 'rows' }, head(['Sell orders', 'Left', 'Your price', 'Front of book', 'Call', 'Type this', 'Net each', 'Sold']), s.sells.map(sellRow)) : null,
      s.bids.length ? h('div', { class: 'rows' }, head(['Buy orders', 'Filled', 'Your bid', 'Bids above you', 'Call', 'Type this', 'In escrow', 'Expires']), s.bids.map(bidRow)) : null,
      s.id === C.jita.station && m.haul.rows.length ? haulView(m) : null,
      s.id === C.jita.station && m.restock.length ? restockView(m) : null,
      s.hangar.length && s.id !== C.jita.station ? h('p', { class: 'hangar' }, h('span', { class: 'hangar-label' }, 'In the hangar, not listed'),
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
        h('span', { class: 'tab-count' + (s.change || s.check ? '' : ' is-zero') }, (s.check ? s.check + ' to check' + (s.change ? ', ' : '') : '') + (s.change ? s.change + ' to change' : s.check ? '' : 'Nothing to change')),
        m.pi && m.pi.near && isFinite(m.pi.near.jumps) && m.pi.near.station === s.id && m.pi.go !== 'wait' ? h('span', { class: 'tab-pi' }, 'Planetary pickup') : null,
        s.id === C.jita.station && (m.restock.length || m.haul.rows.length) ? h('span', { class: 'tab-pi' }, [m.haul.rows.length ? plural(m.haul.units, 'unit') + ' to haul' : null, m.restock.length ? m.restock.length + ' to restock' : null].filter(Boolean).join(', ')) : null);
    }));
  }

  const priceBtn = price => h('button', { class: 'price', type: 'button', title: 'Copy ' + price, onclick: e => copy(e.currentTarget, price) }, L.isk(price));
  function haulView(m) {
    const hl = m.haul, over = hl.m3 > hl.cargo;
    return h('div', { class: 'block' },
      h('div', { class: 'block-head' }, h('h3', null, 'Haul manifest'),
        h('span', { class: over ? 'neg' : '' }, plural(hl.units, 'unit') + ', ' + num(Math.round(hl.m3)) + ' m³ of '),
        h('label', { class: 'cargo' }, h('input', { type: 'number', min: 0, step: 1, value: hl.cargo, 'aria-label': 'Cargo hold in cubic metres',
          onchange: e => { S.cargo = Math.max(0, Number(e.target.value) || 0); if (!demo) E.store.set('eveops.cargo', S.cargo); paint(); } }), ' m³ cargo'),
        over && h('span', { class: 'chip chip-check' }, 'Over by ' + num(Math.round(hl.m3 - hl.cargo)) + ' m³')),
      h('div', { class: 'pi-scroll' }, h('table', { class: 'pi-table' },
        h('thead', null, h('tr', null, h('th', { class: 'l' }, 'In the Jita hangar'), h('th', null, 'Units'), h('th', null, 'm³'), hl.rows[0].asks.map(a => h('th', null, a.name)), h('th', null, 'Take to'))),
        h('tbody', null, hl.rows.map(r => h('tr', null,
          h('td', { class: 'l' }, h('span', { class: 'pi-item' }, icon(r.type), r.name)),
          h('td', null, num(r.qty)), h('td', null, num(Math.round(r.m3))),
          r.asks.map(a => h('td', { class: a.name === r.best ? 'best' : '' }, a.ask == null ? '' : L.isk(a.ask), a.sold ? h('span', { class: 'sub' }, 'you sold ' + num(a.sold) + ' this week') : null)),
          h('td', { class: 'best' }, r.best || '')))))),
      h('p', { class: 'note' }, 'Hub columns are the lowest ask there now. "Take to" prefers a hub where you sold this item in the last 7 days, then the highest ask.'));
  }
  function restockView(m) {
    return h('div', { class: 'block' },
      h('div', { class: 'block-head' }, h('h3', null, 'Restock shortlist'), h('span', { class: 'why' }, C.restock.days + ' days of stock or less, selling at least ' + C.restock.minWeek + ' a week')),
      h('div', { class: 'pi-scroll' }, h('table', { class: 'pi-table' },
        h('thead', null, h('tr', null, h('th', { class: 'l' }, 'Line'), h('th', null, 'Left'), h('th', null, 'Sells a day'), h('th', null, 'Days left'), h('th', null, 'On the way'), h('th', null, 'Units to bid'), h('th', null, 'Net each'), h('th', null, 'Bid to type'))),
        h('tbody', null, m.restock.map(r => h('tr', null,
          h('td', { class: 'l' }, h('span', { class: 'pi-item' }, icon(r.type), h('span', null, r.name, h('span', { class: 'sub' }, r.hub)))),
          h('td', { class: r.left ? '' : 'neg' }, r.left ? num(r.left) : 'Sold out'),
          h('td', null, r.perDay.toFixed(1)), h('td', null, r.left ? r.days.toFixed(1) : ''),
          h('td', null, r.coming ? num(r.coming) : ''),
          h('td', null, r.thin ? h('span', { class: 'sub' }, 'margin too thin') : r.want ? num(r.want) : h('span', { class: 'sub' }, 'covered')),
          h('td', null, r.net == null ? '' : [h('span', { class: r.thin ? 'neg' : '' }, L.short(r.net)), h('span', { class: 'sub' }, Math.round(r.margin * 100) + '%')]),
          h('td', null, r.bid != null && r.want && !r.thin ? priceBtn(r.bid) : '')))))),
      h('p', { class: 'note' }, 'Units to bid is a week of your sales less what is left, already on bid, or waiting in the Jita hangar. The bid is one legal tick over the top Jita bid; net each is at the hub price after fees.'));
  }
  function feedPanel(m) {
    const mark = () => { S.seen = { at: Date.now(), orders: m.snapshot }; if (!demo) E.store.set('eveops.seen', S.seen); paint(); };
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
    return h('section', { class: 'pi', id: 'pi' },
      h('header', { class: 'pi-head' },
        h('h2', null, 'Planetary Interaction'),
        h('span', { class: 'chip ' + (p.go === 'wait' ? 'chip-hold' : 'chip-lead') }, 'Pickup: ' + verdict),
        h('span', { class: 'stop-sum' }, 'About ' + L.short(p.value) + ' waiting')),
      h('p', { class: 'pi-note' }, plural(Math.round(p.units), 'unit') + ', ' + num(Math.round(p.m3)) + ' m\u00b3, growing about ' + L.short(p.perDay) + ' a day. ' + when + where
        + (p.stopped ? plural(p.stopped, 'colony has', 'colonies have') + ' stopped extractors.' : '')),
      h('div', { class: 'pi-scroll' }, h('table', { class: 'pi-table' },
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
      h('p', { class: 'note' }, 'Hub columns are the lowest ask in each station, highest marked. Value uses the ' + p.sellName + ' ask. EVE only reports a colony as it was when last opened in game, so the units are worked out from there: an estimate.'));
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
        h('div', { class: 'fact fact-total' }, h('dt', null, m.scout ? 'Overall wealth, ' + S.who.name : 'Overall wealth'), h('dd', null, m.wealth == null ? '' : L.isk(Math.round(m.wealth)))),
        m.scout && fact(m.scout.name, L.isk(Math.round(m.scout.wealth)), 'wallet ' + L.short(m.scout.wallet) + ', hangars and ships ' + L.short(m.scout.held)),
        m.both != null && h('div', { class: 'fact fact-total' }, h('dt', null, 'Both characters'), h('dd', null, L.isk(Math.round(m.both))))),
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
          h('span', { class: 'sub' }, x.clear != null ? Math.round(x.clear) + ' days to clear at this pace' : 'no sales this week')))))
        : h('p', { class: 'note' }, m.windowDays < C.staleDays ? 'Needs ' + C.staleDays + ' days of sales history; EVE has returned ' + Math.floor(m.windowDays) + '.' : 'Every line has sold in the last ' + C.staleDays + ' days and clears within a month.'));
  }
  function dataPanel() {
    const names = ['Market books', 'Your orders', 'Wallet', 'Sales and purchases', 'Hangars', 'Planets', 'Kill feed', 'Item prices', 'Loot prices', 'Location', 'Skills and clones', 'Routes'];
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
      h('nav', { class: 'views', 'aria-label': 'Views' }, [['trade', 'Trading'], ['wh', 'Wormholes']].map(v =>
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
    if (!demo) history.replaceState(null, '', v === 'wh' ? '#wormholes' : location.pathname);
    paint();
  }
  function paint() {
    if (!demo && !E.who()) return loginView(S.notice || 'Your sign-in ended. Log in again to carry on.');
    const m = S.ready ? build() : null;
    const y = window.scrollY;
    if (S.view === 'wh' && window.Wh) {
      root.replaceChildren(demo ? h('p', { class: 'banner' }, 'Sample data. ', h('a', { href: './' }, 'Leave sample data')) : '', topView(m), window.Wh.view(paint, m ? lootView(m) : null));
      return window.scrollTo(0, y);
    }
    root.replaceChildren(
      demo ? h('p', { class: 'banner' }, 'Sample data. Routes are real, the orders and ISK are invented. ', h('a', { href: './' }, 'Leave sample data')) : '',
      topView(m),
      m ? h('main', { class: 'board' },
        h('div', { class: 'stops' }, m.stops.length ? [tabsView(m), stopView(m.stops.find(s => s.id === m.tab) || m.stops[0], m), piView(m)] : [h('p', { class: 'empty' }, 'No open orders. Place one in game and it appears here within 20 minutes.'), piView(m)]),
        h('aside', { class: 'side' }, feedPanel(m), weekPanel(m), booksPanel(m), piPanel(m), skillPanel(m), scoutSkills(m), clonePanel(m), slowPanel(m), dataPanel()))
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
    window.addEventListener('hashchange', () => {
      if ((location.hash === '#demo') !== demo) return location.reload();
      S.view = location.hash === '#wormholes' ? 'wh' : 'trade';
      paint();
    });
    if (demo) S.who = window.Demo.who;
    else {
      try { if ((await E.finishLogin()) === 'scout') { S.view = 'wh'; history.replaceState(null, '', '#wormholes'); } } catch (err) { S.notice = err.message; }
      S.who = E.who();
      if (!S.who) return loginView(S.notice);
    }
    const scout = () => (window.Wh && window.Wh.signedIn() ? window.Wh.tick().then(moved => { if (moved && S.view === 'wh') paint(); }, () => {}) : null);
    if (S.view === 'wh') paint();
    scout();
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
      if (n % 4 === 0) return run();           // once a minute: fetch whatever EVE has republished
      try { if (await loadLocation()) { await loadRoutes(); paint(); } } catch (err) { /* next tick */ }
    }, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { wake(); run(); } });
  }
  boot();
})();
