/* Eve Ops — sample data for the #demo view. Shaped exactly like ESI answers so the
   real code path runs. Routes and system security are real; orders and ISK are invented. */
(function () {
  'use strict';
  const on = location.hash === '#demo';
  const now = Date.now(), M = 6e4, H = 36e5, D = 864e5;
  const iso = ago => new Date(now - ago).toISOString();
  const ST = { jita: 60003760, amarr: 60008494, dodixie: 60011866, rens: 60004588, hek: 60005686 };
  const REGION = { 60003760: 10000002, 60008494: 10000043, 60011866: 10000032, 60004588: 10000030, 60005686: 10000042 };
  const SYS = { 60003760: 30000142, 60008494: 30002187, 60011866: 30002659, 60004588: 30002510, 60005686: 30002053 };
  const CHAR = 90000001;

  const names = {
    60003760: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant',
    60008494: 'Amarr VIII (Oris) - Emperor Family Academy',
    60011866: 'Dodixie IX - Moon 20 - Federation Navy Assembly Plant',
    60004588: 'Rens VI - Moon 8 - Brutor Tribe Treasury',
    60005686: 'Hek VIII - Moon 12 - Boundless Creation Factory',
    519: 'Gyrostabilizer II', 22291: 'Ballistic Control System II', 2889: '200mm AutoCannon II',
    10631: 'Rocket Launcher II', 438: '1MN Afterburner II', 12058: '10MN Afterburner II',
    380: 'Small Shield Extender II', 3831: 'Medium Shield Extender II', 527: 'Stasis Webifier II',
    2281: 'Multispectrum Shield Hardener II', 2048: 'Damage Control II', 2404: 'Light Missile Launcher II',
    2488: 'Warrior II', 33474: 'Mobile Depot', 1183: 'Small Armor Repairer II', 3041: 'Small Focused Pulse Laser II',
    2329: 'Biocells', 9832: 'Coolant', 12733: 'Prorator',
    3443: 'Trade', 3444: 'Retail', 16596: 'Wholesale', 18580: 'Tycoon', 33399: 'Infomorph Synchronizing', 16622: 'Accounting',
  };

  // Real routes out of Hek and real security values, read from ESI on 2026-11-15.
  const routes = {"30000142:shortest":[30002053,30002723,30002719,30002718,30002691,30002644,30002643,30002642,30000144,30000142],"30000142:secure":[30002053,30002049,30002048,30002682,30002681,30002641,30002634,30002633,30004970,30004972,30002761,30002764,30002765,30002768,30002803,30002805,30002791,30000139,30000144,30000142],"30002187:shortest":[30002053,30002054,30002056,30002057,30002058,30002090,30002095,30002539,30002542,30003068,30003067,30003065,30003520,30003521,30003522,30002187],"30002187:secure":[30002053,30002543,30002545,30002568,30002529,30002530,30002507,30002509,30000004,30000005,30000002,30002973,30002969,30002974,30002972,30002971,30002970,30002963,30002964,30002991,30002994,30003545,30003548,30003525,30003523,30003522,30002187],"30002659:shortest":[30002053,30002049,30002048,30002682,30002681,30002641,30002634,30002655,30002659],"30002659:secure":[30002053,30002049,30002048,30002682,30002681,30002641,30002634,30002655,30002659],"30002510:shortest":[30002053,30002543,30002544,30002568,30002529,30002526,30002510],"30002510:secure":[30002053,30002543,30002545,30002568,30002529,30002526,30002510]};
  const systems = {"30000002":["Lashesih",0.752],"30000004":["Jark",0.817],"30000005":["Sasta",0.814],"30000139":["Urlen",0.949],"30000142":["Jita",0.946],"30000144":["Perimeter",0.949],"30002048":["Bei",0.565],"30002049":["Uttindar",0.504],"30002053":["Hek",0.8],"30002054":["Hror",0.512],"30002056":["Resbroko",0.438],"30002057":["Hadozeko",0.396],"30002058":["Ardar",0.366],"30002090":["Frerstorn",0.306],"30002095":["Eszur",0.213],"30002187":["Amarr",0.949],"30002507":["Abudban",0.732],"30002509":["Odatrik",0.816],"30002510":["Rens",0.895],"30002526":["Frarn",0.839],"30002529":["Gyng",0.798],"30002530":["Avesber",0.753],"30002539":["Siseide",0.338],"30002542":["Auga",0.385],"30002543":["Eystur",0.949],"30002544":["Pator",0.949],"30002545":["Lustrevik",0.946],"30002568":["Onga",0.949],"30002633":["Du Annes",0.648],"30002634":["Balle",0.461],"30002641":["Aufay",0.523],"30002642":["Iyen-Oursta",0.78],"30002643":["Faurent",0.537],"30002644":["Ambeke",0.501],"30002655":["Vylade",0.796],"30002659":["Dodixie",0.868],"30002681":["Deltole",0.54],"30002682":["Colelie",0.512],"30002691":["Crielere",0.398],"30002718":["Rancer",0.365],"30002719":["Miroitem",0.305],"30002723":["Otou",0.334],"30002761":["Kassigainen",0.916],"30002764":["Hatakani",0.941],"30002765":["Sivala",0.551],"30002768":["Uedama",0.505],"30002791":["Sirppala",0.883],"30002803":["Juunigaishi",0.621],"30002805":["Anttiri",0.713],"30002963":["Odin",0.607],"30002964":["Esescama",0.613],"30002969":["Eredan",0.702],"30002970":["Ohide",0.574],"30002971":["Sasoutikh",0.594],"30002972":["Gheth",0.597],"30002973":["Lisudeh",0.759],"30002974":["Mehatoor",0.659],"30002991":["Uadelah",0.83],"30002994":["Hati",0.849],"30003065":["Otelen",0.785],"30003067":["Huola",0.37],"30003068":["Kourmonen",0.363],"30003520":["Mahrokht",0.86],"30003521":["Alkabsi",0.662],"30003522":["Sarum Prime",0.949],"30003523":["Hama",0.84],"30003525":["Bagodan",0.717],"30003545":["Yuhelia",0.8],"30003548":["Barira",0.815],"30004970":["Renyn",0.898],"30004972":["Algogille",0.925]};
  const kills = [[30002655,1,0],[30002187,7,0],[30002053,14,1],[30002058,1,0],[30002642,1,1],[30002634,1,0],[30000144,2,0],[30002507,1,0],[30002542,13,1],[30002723,1,0],[30000142,7,7],[30002048,1,0],[30002659,4,3],[30002539,10,3],[30002718,3,3],[30002691,3,3],[30002095,1,0],[30002510,1,0],[30003067,2,0]];

  // [type, station, total, left, price, cost, jitaSell, rivals [[price, units]], boughtDaysAgo, lastSaleDaysAgo]
  const sells = [
    [527, ST.hek, 48, 36, 1007000, 820000, 880000, [[1012000, 20], [1019000, 8]], 6, 0.2],
    [519, ST.hek, 2, 2, 1317000, 1090000, 1160000, [[1320000, 10], [1329000, 14]], 5, 0.5],
    [519, ST.hek, 60, 55, 1323000, 1090000, 1160000, null, 5, 0.5],
    [2889, ST.hek, 48, 16, 1764000, 1420000, 1520000, [[1759000, 80], [1761000, 12], [1770000, 6]], 8, 1.1],
    [33474, ST.hek, 26, 19, 1657000, 1480000, 1495000, [[1470000, 104], [1649000, 4]], 12, 3],
    [1183, ST.hek, 60, 43, 719600, 571000, 610000, [[719500, 3], [724000, 30]], 7, 0.4],
    [2048, ST.hek, 40, 26, 1496000, 1210000, 1290000, [[1471000, 56], [1480000, 9]], 9, 2],
    [22291, ST.dodixie, 20, 12, 887400, 720000, 765000, [[886900, 40], [888000, 25]], 6, 0.6],
    [22291, ST.dodixie, 120, 111, 887400, 720000, 765000, null, 6, 0.6],
    [438, ST.dodixie, 40, 27, 2037000, 1650000, 1760000, [[2029000, 15], [2041000, 22]], 6, 0.9],
    [2404, ST.dodixie, 200, 152, 891700, 765000, 810000, [[799000, 78], [889000, 10]], 10, 1.5],
    [2488, ST.dodixie, 120, 60, 421300, 331000, 352000, [[425000, 50]], 4, 0.1],
    [3831, ST.amarr, 99, 64, 985500, 790000, 842000, [[979900, 43], [988000, 30]], 5, 0.3],
    [10631, ST.amarr, 114, 71, 431000, 315000, 336000, [[433500, 30], [436000, 12]], 4, 0.2],
    [10631, ST.amarr, 6, 6, 431000, 315000, 336000, null, 4, 0.2],
    [3041, ST.rens, 40, 27, 711500, 590000, 628000, [[705000, 9], [718000, 5]], 21, 16],
  ];
  // [type, total, left, bid, rivals [[price, units]]]
  const bids = [
    [2281, 100, 74, 1678000, [[1677000, 50], [1675000, 210]]],
    [12058, 40, 40, 2461000, [[2468000, 43], [2466000, 162], [2463000, 708]]],
    [2048, 25, 25, 1184000, [[1189000, 88], [1187000, 69]]],
    [380, 50, 50, 382600, [[383100, 2], [383000, 285], [382900, 100]]],
  ];

  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

  const orders = [], books = {}, tx = [];
  let oid = 7000000000, tid = 9000000000;
  const book = (region, type) => (books[region + ':' + type] = books[region + ':' + type] || []);
  const rival = (region, type, loc, isBuy, price, units, ago) => book(region, type).push({
    order_id: oid++, type_id: type, location_id: loc, system_id: SYS[loc], is_buy_order: isBuy, price,
    volume_remain: units, volume_total: units, issued: iso(ago), duration: 90, min_volume: 1, range: isBuy ? 'station' : 'region',
  });
  const seen = new Set();
  for (const [type, loc, total, left, price, cost, jita, rivals, bought, lastSale] of sells) {
    const region = REGION[loc];
    const mine = { order_id: oid++, type_id: type, location_id: loc, region_id: region, is_buy_order: false, price, volume_remain: left, volume_total: total, issued: iso(26 * H), duration: 90, range: 'region', is_corporation: false };
    orders.push(mine);
    book(region, type).push(Object.assign({ system_id: SYS[loc], min_volume: 1 }, mine));
    if (rivals) rivals.forEach(([p, u], i) => rival(region, type, loc, false, p, u, (3 + i * 7) * H));
    if (!seen.has(type)) {
      seen.add(type);
      rival(10000002, type, ST.jita, false, jita, 400, 2 * H);
      rival(10000002, type, ST.jita, true, Math.round(cost * 0.985 / 1000) * 1000, 300, 2 * H);
      tx.push({ transaction_id: tid++, date: iso(bought * D), type_id: type, location_id: ST.jita, quantity: 400, unit_price: cost, is_buy: true, is_personal: true, client_id: 1, journal_ref_id: tid });
    }
    // sales spread from the last-sale age back to the purchase
    let sold = total - left;
    for (let d = lastSale; sold > 0 && d < bought; d += 0.4 + rnd() * 1.6) {
      const q = Math.min(sold, 1 + Math.floor(rnd() * Math.max(2, total / 6)));
      tx.push({ transaction_id: tid++, date: iso(d * D), type_id: type, location_id: loc, quantity: q, unit_price: Math.round(price * (1 + rnd() * 0.02) / 100) * 100, is_buy: false, is_personal: true, client_id: 2, journal_ref_id: tid });
      sold -= q;
    }
  }
  // earlier closed positions, so the 14-day chart has history
  for (let d = 0.3; d < 14; d += 0.35 + rnd() * 0.5) {
    const pick = sells[Math.floor(rnd() * sells.length)];
    tx.push({ transaction_id: tid++, date: iso(d * D), type_id: pick[0], location_id: pick[1], quantity: 2 + Math.floor(rnd() * 14), unit_price: pick[4], is_buy: false, is_personal: true, client_id: 2, journal_ref_id: tid });
  }
  tx.push({ transaction_id: tid++, date: iso(1.2 * D), type_id: 2329, location_id: ST.hek, quantity: 1400, unit_price: 9150, is_buy: false, is_personal: true, client_id: 2, journal_ref_id: tid });
  for (const [type, total, left, bid, rivals] of bids) {
    const mine = { order_id: oid++, type_id: type, location_id: ST.jita, region_id: 10000002, is_buy_order: true, price: bid, volume_remain: left, volume_total: total, issued: iso(40 * H), duration: 90, range: 'station', escrow: bid * left, min_volume: 1, is_corporation: false };
    orders.push(mine);
    book(10000002, type).push(Object.assign({ system_id: 30000142 }, mine));
    rivals.forEach(([p, u], i) => rival(10000002, type, ST.jita, true, p, u, (5 + i * 9) * H));
       // a higher bid in Perimeter with station range: it cannot be filled in Jita, so it must not count
    rival(10000002, type, 60003466, true, Math.round(bid * 1.02 / 1000) * 1000, 30, 4 * H);
    book(10000002, type)[book(10000002, type).length - 1].system_id = 30000144;
  }

  const planets = [1, 2, 3, 4, 5, 6].map(i => ({ planet_id: 40150000 + i, planet_type: ['barren', 'gas', 'temperate', 'lava', 'oceanic', 'storm'][i - 1], solar_system_id: 30002545, last_update: iso(30 * H), num_pins: 12, owner_id: CHAR, upgrade_level: 4 }));

  function answer(data, ttl, age) { return Promise.resolve({ data, fetched: now, modified: now - (age || 0), expires: Date.now() + ttl }); }

  function get(path, opts) {
    const q = (opts && opts.query) || {};
    let m;
    if (/\/location\/$/.test(path)) return answer({ solar_system_id: 30002053, station_id: ST.hek }, 5e3);
    if (/\/ship\/$/.test(path)) return answer({ ship_item_id: 1, ship_name: 'Dawn Treader IV', ship_type_id: 12733 }, 5e3);
    if (/\/wallet\/$/.test(path)) return answer(6072843112.37, 2 * M, 40e3);
    if (/\/wallet\/transactions\/$/.test(path)) return answer(q.from_id ? [] : tx, 60 * M, 22 * M);
    if (/\/characters\/\d+\/orders\/$/.test(path)) return answer(orders, 20 * M, 9 * M);
    if (/\/assets\/$/.test(path)) return answer([
      { item_id: 1, type_id: 527, quantity: 60, location_id: ST.jita, location_type: 'station', location_flag: 'Hangar', is_singleton: false },
      { item_id: 2, type_id: 2329, quantity: 1200, location_id: ST.hek, location_type: 'station', location_flag: 'Hangar', is_singleton: false },
      { item_id: 3, type_id: 12733, quantity: 1, location_id: ST.hek, location_type: 'station', location_flag: 'Hangar', is_singleton: true },
    ], 60 * M, 35 * M);
    if (/\/skillqueue\/$/.test(path)) return answer([
      { skill_id: 18580, finished_level: 1, queue_position: 0, start_date: iso(20 * H), finish_date: iso(-(3 * D + 4 * H)) },
      { skill_id: 16622, finished_level: 5, queue_position: 1, start_date: iso(-(3 * D + 4 * H)), finish_date: iso(-(11 * D)) },
    ], 2 * M, M);
    if (/\/skills\/$/.test(path)) return answer({ skills: [
      { skill_id: 3443, trained_skill_level: 5 }, { skill_id: 3444, trained_skill_level: 5 },
      { skill_id: 16596, trained_skill_level: 5 }, { skill_id: 18580, trained_skill_level: 0 }, { skill_id: 33399, trained_skill_level: 3 },
    ], total_sp: 1 }, 2 * M, M);
    if (/\/clones\/$/.test(path)) return answer({ home_location: { location_id: ST.rens, location_type: 'station' }, last_clone_jump_date: iso(17 * H), jump_clones: [
      { jump_clone_id: 1, location_id: ST.amarr, location_type: 'station', implants: [] },
      { jump_clone_id: 2, location_id: ST.dodixie, location_type: 'station', implants: [] },
      { jump_clone_id: 3, location_id: ST.jita, location_type: 'station', implants: [] },
    ] }, 2 * M, M);
    if (/\/planets\/$/.test(path)) return answer(planets, 10 * M, 4 * M);
    if ((m = path.match(/\/planets\/(\d+)\/$/)) && /characters/.test(path)) {
      const i = Number(m[1]) - 40150000;
      return answer({ links: [], routes: [], pins: [
        { pin_id: 1, type_id: 2254, latitude: 0, longitude: 0 },
        { pin_id: 2, type_id: 3060, latitude: 0, longitude: 0, expiry_time: iso(-(i === 3 ? 2.2 * H : 20 * H + i * 9 * M)), extractor_details: { heads: [], product_type_id: 2268 } },
      ] }, 10 * M, 4 * M);
    }
    if (/\/markets\/prices\/$/.test(path)) return answer([{ type_id: 527, average_price: 884000 }, { type_id: 2329, average_price: 9100 }, { type_id: 12733, average_price: 251400000 }], 60 * M, 20 * M);
    if ((m = path.match(/\/markets\/(\d+)\/orders\/$/))) return answer(books[m[1] + ':' + q.type_id] || [], 5 * M, 2.4 * M);
    if ((m = path.match(/\/universe\/stations\/(\d+)\/$/))) return answer({ station_id: Number(m[1]), name: names[m[1]] || 'Station ' + m[1], system_id: SYS[m[1]] || 30000144 }, D);
    if ((m = path.match(/\/universe\/systems\/(\d+)\/$/))) { const s = systems[m[1]] || ['System ' + m[1], 0.9]; return answer({ system_id: Number(m[1]), name: s[0], security_status: s[1] }, D); }
    if ((m = path.match(/\/universe\/planets\/(\d+)\/$/))) return answer({ planet_id: Number(m[1]), name: 'Alakgur ' + ['I', 'II', 'III', 'IV', 'V', 'VI'][Number(m[1]) - 40150001] }, D);
    if (/\/universe\/system_kills\/$/.test(path)) return answer(kills.map(([system_id, ship_kills, pod_kills]) => ({ system_id, ship_kills, pod_kills, npc_kills: 0 })), 60 * M, 25 * M);
    if ((m = path.match(/\/route\/(\d+)\/(\d+)\/$/))) {
      const r = routes[m[2] + ':' + (q.flag || 'shortest')];
      if (r && Number(m[1]) === 30002053) return answer(r, D);
      if (Number(m[1]) === 30000144 && Number(m[2]) === 30000142) return answer([30000144, 30000142], D);
      return Promise.reject(new window.Esi.EsiError(404, 'No route found'));
    }
    return Promise.reject(new window.Esi.EsiError(404, 'Sample data has no answer for ' + path));
  }

  function post(path, body) {
    if (/\/universe\/names\/$/.test(path)) return Promise.resolve(body.map(id => ({ id, name: names[id] || (systems[id] && systems[id][0]) || 'Item ' + id, category: id > 6e7 ? 'station' : 'inventory_type' })));
    if (/\/universe\/ids\/$/.test(path)) return Promise.resolve({ inventory_types: Object.entries(names).filter(([, n]) => body.includes(n)).map(([id, name]) => ({ id: Number(id), name })) });
    return Promise.reject(new window.Esi.EsiError(404, 'Sample data has no answer for ' + path));
  }

  window.Demo = { on, get, post, who: { id: CHAR, name: 'Sample Trader', scopes: [] } };
})();
