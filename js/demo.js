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
  const CHAR = 90000001, SCOUT = 90000002, FORT = 1040000000001;

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
    2288: 'Carbon Compounds', 2270: 'Noble Metals', 2396: 'Biofuels', 2399: 'Precious Metals', 2473: 'Barren Basic Industry Facility',
    2474: 'Barren Advanced Industry Facility', 2524: 'Barren Command Center', 2544: 'Barren Launchpad', 2848: 'Barren Extractor Control Unit',
    30744: 'Neural Network Analyzer', 30745: 'Sleeper Data Library', 30746: 'Ancient Coordinates Database', 25624: 'Intact Armor Plates',
    30259: 'Melted Nanoribbons', 30377: 'Fullerite-C320', 30378: 'Fullerite-C540', 20424: 'Datacore - Mechanical Engineering', 11188: 'Stratios', 13278: 'Archaeology',
    3443: 'Trade', 3444: 'Retail', 16596: 'Wholesale', 18580: 'Tycoon', 33399: 'Infomorph Synchronizing', 16622: 'Accounting',
  };

  // Real routes out of Hek and real security values, read from ESI on 2026-11-15.
  const routes = {"30000142:shortest":[30002053,30002723,30002719,30002718,30002691,30002644,30002643,30002642,30000144,30000142],"30000142:secure":[30002053,30002049,30002048,30002682,30002681,30002641,30002634,30002633,30004970,30004972,30002761,30002764,30002765,30002768,30002803,30002805,30002791,30000139,30000144,30000142],"30002187:shortest":[30002053,30002054,30002056,30002057,30002058,30002090,30002095,30002539,30002542,30003068,30003067,30003065,30003520,30003521,30003522,30002187],"30002187:secure":[30002053,30002543,30002545,30002568,30002529,30002530,30002507,30002509,30000004,30000005,30000002,30002973,30002969,30002974,30002972,30002971,30002970,30002963,30002964,30002991,30002994,30003545,30003548,30003525,30003523,30003522,30002187],"30002659:shortest":[30002053,30002049,30002048,30002682,30002681,30002641,30002634,30002655,30002659],"30002659:secure":[30002053,30002049,30002048,30002682,30002681,30002641,30002634,30002655,30002659],"30002510:shortest":[30002053,30002543,30002544,30002568,30002529,30002526,30002510],"30002510:secure":[30002053,30002543,30002545,30002568,30002529,30002526,30002510]};
  const systems = {"30000002":["Lashesih",0.752],"30000004":["Jark",0.817],"30000005":["Sasta",0.814],"30000132":["Ansila",0.912],"30000134":["Hykkota",0.824],"30000138":["Ikuchi",0.949],"30000139":["Urlen",0.949],"30000142":["Jita",0.946],"30000144":["Perimeter",0.949],"30001376":["Nourvukaiken",0.817],"30001379":["Tunttaras",0.885],"30002048":["Bei",0.565],"30002049":["Uttindar",0.504],"30002053":["Hek",0.8],"30002054":["Hror",0.512],"30002056":["Resbroko",0.438],"30002057":["Hadozeko",0.396],"30002058":["Ardar",0.366],"30002090":["Frerstorn",0.306],"30002095":["Eszur",0.213],"30002187":["Amarr",0.949],"30002282":["Bhizheba",0.949],"30002506":["Osoggur",0.532],"30002507":["Abudban",0.732],"30002509":["Odatrik",0.816],"30002510":["Rens",0.895],"30002526":["Frarn",0.839],"30002529":["Gyng",0.798],"30002530":["Avesber",0.753],"30002537":["Amamake",0.439],"30002539":["Siseide",0.338],"30002542":["Auga",0.385],"30002543":["Eystur",0.949],"30002544":["Pator",0.949],"30002545":["Lustrevik",0.946],"30002568":["Onga",0.949],"30002633":["Du Annes",0.648],"30002634":["Balle",0.461],"30002640":["Erme",0.798],"30002641":["Aufay",0.523],"30002642":["Iyen-Oursta",0.78],"30002643":["Faurent",0.537],"30002644":["Ambeke",0.501],"30002655":["Vylade",0.796],"30002659":["Dodixie",0.868],"30002661":["Botane",0.875],"30002681":["Deltole",0.54],"30002682":["Colelie",0.512],"30002691":["Crielere",0.398],"30002692":["Jel",0.607],"30002693":["Egghelende",0.448],"30002718":["Rancer",0.365],"30002719":["Miroitem",0.305],"30002723":["Otou",0.334],"30002761":["Kassigainen",0.916],"30002764":["Hatakani",0.941],"30002765":["Sivala",0.551],"30002768":["Uedama",0.505],"30002791":["Sirppala",0.883],"30002801":["Suroken",0.729],"30002802":["Kusomonmon",0.847],"30002803":["Juunigaishi",0.621],"30002805":["Anttiri",0.713],"30002809":["Sujarento",0.311],"30002811":["Onatoh",0.296],"30002812":["Tannolen",0.304],"30002813":["Tama",0.283],"30002963":["Odin",0.607],"30002964":["Esescama",0.613],"30002969":["Eredan",0.702],"30002970":["Ohide",0.574],"30002971":["Sasoutikh",0.594],"30002972":["Gheth",0.597],"30002973":["Lisudeh",0.759],"30002974":["Mehatoor",0.659],"30002991":["Uadelah",0.83],"30002994":["Hati",0.849],"30003025":["Lirsautton",0.836],"30003030":["Ardallabier",0.714],"30003032":["Meves",0.949],"30003065":["Otelen",0.785],"30003067":["Huola",0.37],"30003068":["Kourmonen",0.363],"30003520":["Mahrokht",0.86],"30003521":["Alkabsi",0.662],"30003522":["Sarum Prime",0.949],"30003523":["Hama",0.84],"30003525":["Bagodan",0.717],"30003545":["Yuhelia",0.8],"30003548":["Barira",0.815],"30004078":["Dresi",0.619],"30004079":["Aphend",0.629],"30004080":["Romi",0.719],"30004083":["Gensela",0.694],"30004970":["Renyn",0.898],"30004972":["Algogille",0.925],"30005192":["Shera",0.598],"30005196":["Ahbazon",0.421],"30005203":["Ourapheh",0.862],"30005331":["Chantrousse",0.639],"30005334":["Tierijev",0.838]};
  // Real routes between the other four hubs (shortest and secure), read from ESI on 2026-11-15, for the trip plan.
  const pairs = {"30000142>30002187:shortest":[30000142,30000138,30000132,30000134,30005196,30005192,30004083,30004078,30004079,30004080,30002282,30002187],"30000142>30002187:secure":[30000142,30000144,30000139,30002802,30002801,30002803,30002768,30002765,30002764,30002761,30004972,30004970,30002633,30002634,30002641,30002681,30002682,30002048,30002049,30002053,30002543,30002545,30002568,30002529,30002526,30002510,30002509,30000004,30000005,30000002,30002973,30002969,30002974,30002972,30002971,30002970,30002963,30002964,30002991,30002994,30003545,30003548,30003525,30003523,30003522,30002187],"30000142>30002659:shortest":[30000142,30000138,30001379,30001376,30002813,30002809,30002811,30002812,30005334,30005331,30005203,30002661,30002659],"30000142>30002659:secure":[30000142,30000144,30000139,30002802,30002801,30002803,30002768,30002765,30002764,30002761,30004972,30004970,30002633,30002640,30002661,30002659],"30000142>30002510:shortest":[30000142,30000144,30002642,30002643,30002644,30002691,30002718,30002719,30002723,30002053,30002543,30002545,30002568,30002529,30002526,30002510],"30000142>30002510:secure":[30000142,30000144,30000139,30002802,30002801,30002803,30002768,30002765,30002764,30002761,30004972,30004970,30002633,30002634,30002641,30002681,30002682,30002048,30002049,30002053,30002543,30002545,30002568,30002529,30002526,30002510],"30002187>30002659:shortest":[30002187,30003522,30003521,30003520,30003065,30003067,30003068,30002542,30002539,30002693,30002692,30003030,30003025,30003032,30002659],"30002187>30002659:secure":[30002187,30003522,30003523,30003525,30003548,30003545,30002994,30002991,30002964,30002963,30002970,30002971,30002972,30002974,30002969,30002973,30000002,30000005,30000004,30002509,30002510,30002526,30002529,30002568,30002545,30002543,30002053,30002049,30002048,30002682,30002681,30002641,30002634,30002655,30002659],"30002187>30002510:shortest":[30002187,30003522,30003521,30003520,30003065,30003067,30003068,30002542,30002537,30002506,30002507,30002510],"30002187>30002510:secure":[30002187,30003522,30003523,30003525,30003548,30003545,30002994,30002991,30002964,30002963,30002970,30002971,30002972,30002974,30002969,30002973,30000002,30000005,30000004,30002509,30002510],"30002659>30002510:shortest":[30002659,30003032,30003025,30003030,30002692,30002693,30002539,30002537,30002506,30002507,30002510],"30002659>30002510:secure":[30002659,30002655,30002634,30002641,30002681,30002682,30002048,30002049,30002053,30002543,30002544,30002568,30002529,30002526,30002510]};
  const kills = [[30002655,1,0],[30002187,7,0],[30002053,14,1],[30002058,1,0],[30002642,1,1],[30002634,1,0],[30000144,2,0],[30002507,1,0],[30002542,13,1],[30002723,1,0],[30000142,7,7],[30002048,1,0],[30002659,4,3],[30002539,10,3],[30002718,3,3],[30002691,3,3],[30002095,1,0],[30002510,1,0],[30003067,2,0]];

  // [type, station, total, left, price, cost, jitaSell, rivals [[price, units]], boughtDaysAgo, lastSaleDaysAgo]
  const sells = [
    [527, ST.hek, 48, 36, 1007000, 820000, 880000, [[1012000, 20], [1019000, 8]], 6, 0.2],
    [519, ST.hek, 2, 2, 1317000, 1090000, 1160000, [[1320000, 10], [1329000, 14]], 5, 0.5],
    [519, ST.hek, 60, 55, 1323000, 1090000, 1160000, null, 5, 0.5],
    [2889, ST.hek, 48, 16, 1764000, 1420000, 1520000, [[1759000, 80], [1761000, 12], [1770000, 6]], 8, 1.1],
    [33474, ST.hek, 26, 19, 1657000, 1480000, 1495000, [[1470000, 104], [1649000, 4]], 12, 3],
    [1183, ST.hek, 60, 43, 719600, 571000, 610000, [[719500, 3], [724000, 30]], 7, 0.4],
    [2048, ST.hek, 40, 26, 1496000, 1210000, 1290000, [[1420000, 56], [1480000, 9]], 9, 2],
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
  // older weeks, for the weekly close (its own random sequence, so the figures above stay as they were)
  let seed2 = 11;
  const rnd2 = () => { seed2 = (seed2 * 16807) % 2147483647; return seed2 / 2147483647; };
  for (const row of sells) if (row[8] < 36) tx.push({ transaction_id: tid++, date: iso(36 * D), type_id: row[0], location_id: ST.jita, quantity: 300, unit_price: row[5], is_buy: true, is_personal: true, client_id: 1, journal_ref_id: tid });
  for (let d = 14.2; d < 35; d += 0.3 + rnd2() * 0.5) {
    const pick = sells[Math.floor(rnd2() * sells.length)];
    tx.push({ transaction_id: tid++, date: iso(d * D), type_id: pick[0], location_id: pick[1], quantity: 2 + Math.floor(rnd2() * 12), unit_price: pick[4], is_buy: false, is_personal: true, client_id: 2, journal_ref_id: tid });
  }
  // a fast line that is about to run out, and one that sold out
  for (let i = 0; i < 6; i++) tx.push({ transaction_id: tid++, date: iso((0.3 + i * 0.5) * D), type_id: 2488, location_id: ST.dodixie, quantity: 26, unit_price: 421300, is_buy: false, is_personal: true, client_id: 2, journal_ref_id: tid });
  for (let i = 0; i < 4; i++) tx.push({ transaction_id: tid++, date: iso((0.4 + i * 0.9) * D), type_id: 380, location_id: ST.rens, quantity: 12, unit_price: 512000, is_buy: false, is_personal: true, client_id: 2, journal_ref_id: tid });
  rival(REGION[ST.rens], 380, ST.rens, false, 515000, 14, 5 * H);
  tx.push({ transaction_id: tid++, date: iso(1.2 * D), type_id: 2329, location_id: ST.hek, quantity: 1400, unit_price: 9150, is_buy: false, is_personal: true, client_id: 2, journal_ref_id: tid });
  for (const [type, total, left, bid, rivals] of bids) {
    const mine = { order_id: oid++, type_id: type, location_id: ST.jita, region_id: 10000002, is_buy_order: true, price: bid, volume_remain: left, volume_total: total, issued: iso(type === 380 ? 3 * H : 40 * H), duration: type === 380 ? 1 : 90, range: 'station', escrow: bid * left, min_volume: 1, is_corporation: false };
    orders.push(mine);
    book(10000002, type).push(Object.assign({ system_id: 30000142 }, mine));
    rivals.forEach(([p, u], i) => rival(10000002, type, ST.jita, true, p, u, (5 + i * 9) * H));
       // a higher bid in Perimeter with station range: it cannot be filled in Jita, so it must not count
    rival(10000002, type, 60003466, true, Math.round(bid * 1.02 / 1000) * 1000, 30, 4 * H);
    book(10000002, type)[book(10000002, type).length - 1].system_id = 30000144;
  }

  // planetary products on sale at every hub
  [[ST.hek, 9150], [ST.rens, 9420], [ST.dodixie, 8870], [ST.amarr, 9010], [ST.jita, 8640]].forEach(([loc, px]) => rival(REGION[loc], 2329, loc, false, px, 5200, 6 * H));
  const colony = i => {
    const id = n => 1000000 * i + n, t0 = iso(34 * H), end = iso(i === 3 ? 2 * H : -62 * H);
    const ecu = (n, prod, q) => ({ pin_id: id(n), type_id: 2848, latitude: 0, longitude: 0, install_time: t0, expiry_time: end, last_cycle_start: t0, extractor_details: { product_type_id: prod, qty_per_cycle: q, cycle_time: 3600, heads: [] }, contents: [] });
    const fac = (n, type, sch) => ({ pin_id: id(n), type_id: type, latitude: 0, longitude: 0, schematic_id: sch, last_cycle_start: iso(48 * H), contents: [] });
    const r = (a, b, type, qty, n) => ({ route_id: id(100 + n), source_pin_id: id(a), destination_pin_id: id(b), content_type_id: type, quantity: qty, waypoints: [] });
    return { links: [], pins: [ecu(1, 2288, 2600 + i * 90), ecu(2, 2270, 1500 + i * 60), fac(3, 2473, 134), fac(4, 2473, 134), fac(5, 2473, 127), fac(6, 2473, 127), fac(7, 2474, 79), fac(8, 2474, 79),
      { pin_id: id(9), type_id: 2524, latitude: 0, longitude: 0, contents: [] }, { pin_id: id(10), type_id: 2544, latitude: 0, longitude: 0, contents: [{ type_id: 2329, amount: 780 + i * 95 }] }],
      routes: [r(1, 3, 2288, 3000, 1), r(1, 4, 2288, 3000, 2), r(1, 9, 2288, 16000, 3), r(2, 5, 2270, 3000, 4), r(2, 6, 2270, 3000, 5), r(2, 9, 2270, 6000, 6),
        r(3, 7, 2396, 20, 7), r(5, 7, 2399, 20, 8), r(4, 8, 2396, 20, 9), r(6, 8, 2399, 20, 10), r(7, 10, 2329, 5, 11), r(8, 10, 2329, 5, 12)] };
  };
  // the wormhole pilot's loot: [type, group, m3 each, average price, { hub: [ask, bid, bid units] }]
  const GROUPS = { 880: ['Sleeper Components', 17], 754: ['Salvaged Materials', 4], 711: ['Harvestable Cloud', 25], 333: ['Datacores', 17] };
  const CATS = { 17: 'Commodity', 4: 'Material', 25: 'Asteroid' };
  const loot = [
    [30744, 880, 0.01, 200000, { jita: [203000, 200000, 9000], amarr: [205000, 200000, 9000], dodixie: [null, 200000, 9000], rens: [209000, 200000, 9000], hek: [212000, 200000, 9000] }],
    [30745, 880, 0.01, 500000, { jita: [506000, 500000, 9000], amarr: [509000, 500000, 9000], dodixie: [512000, 500000, 9000], rens: [null, 500000, 9000], hek: [519000, 500000, 9000] }],
    [30746, 880, 0.01, 1500000, { jita: [1519000, 1500000, 9000], amarr: [1524000, 1500000, 9000], dodixie: [null, 1500000, 9000], rens: [1540000, 1500000, 9000], hek: [1536000, 1500000, 9000] }],
    [25624, 754, 0.01, 1690000, { jita: [1695000, 1610000, 400], amarr: [1740000, 1552000, 60], dodixie: [1790000, 1490000, 25], rens: [2890000, 1405000, 30], hek: [1820000, 1440000, 3] }],
    [30259, 754, 0.01, 3290000, { jita: [3310000, 3204000, 800], amarr: [3390000, 3110000, 90], dodixie: [3450000, 3020000, 40], rens: [3520000, 2950000, 20], hek: [3480000, 2990000, 6] }],
    [30377, 711, 5, 97000, { jita: [98500, 93100, 20000], amarr: [104000, 88000, 3000], dodixie: [null, 84000, 500], rens: [112000, 80500, 200], hek: [109900, 82000, 150] }],
    [30378, 711, 10, 40500, { jita: [41200, 38900, 20000], amarr: [43900, 36000, 2000], dodixie: [45000, null, 0], rens: [null, null, 0], hek: [47800, 33500, 120] }],
    [20424, 333, 0.1, 83000, { jita: [84900, 79500, 5000], amarr: [88800, 74000, 800], dodixie: [91200, 71000, 300], rens: [97500, 68000, 100], hek: [95800, 69500, 25] }],
  ];
  const lootOf = new Map(loot.map(x => [x[0], x]));
  for (const [type, , , , mk] of loot) for (const hub of Object.keys(mk)) {
    const loc = ST[hub], [ask, bid, units] = mk[hub];
    if (ask) rival(REGION[loc], type, loc, false, ask, 60, 7 * H);
    if (bid) rival(REGION[loc], type, loc, true, bid, units, 9 * H);
  }
  const stack = (item_id, type_id, quantity, location_id, location_flag, location_type) => ({ item_id, type_id, quantity, location_id, location_flag, location_type: location_type || 'item', is_singleton: false });
  const scoutAssets = [
    stack(801, 25624, 9, FORT, 'Hangar'), stack(802, 30259, 14, FORT, 'Hangar'), stack(803, 30744, 22, FORT, 'Hangar'), stack(804, 30745, 6, FORT, 'Hangar'), stack(805, 30377, 420, FORT, 'Hangar'),
    stack(811, 20424, 40, ST.hek, 'Hangar', 'station'), stack(812, 30746, 3, ST.hek, 'Hangar', 'station'), stack(813, 30378, 300, ST.hek, 'Hangar', 'station'),
    { item_id: 820, type_id: 11188, quantity: 1, location_id: ST.hek, location_flag: 'Hangar', location_type: 'station', is_singleton: true },
    stack(821, 30744, 8, 820, 'Cargo'), stack(822, 25624, 2, 820, 'Cargo'),
  ];

  const planets = [1, 2, 3, 4, 5, 6].map(i => ({ planet_id: 40150000 + i, planet_type: ['barren', 'gas', 'temperate', 'lava', 'oceanic', 'storm'][i - 1], solar_system_id: 30002543, last_update: iso(34 * H), num_pins: 10, owner_id: CHAR, upgrade_level: 4 }));

  // The wallet journal that goes with those sales and purchases: tax on each sale, a broker fee now and then, balances that end at the wallet.
  const journal = [];
  {
    let jid = 5000000000;
    const rows = tx.slice().sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    rows.forEach((t, i) => {
      const gross = t.quantity * t.unit_price;
      journal.push({ id: jid++, date: t.date, ref_type: 'market_transaction', amount: t.is_buy ? -gross : gross });
      if (!t.is_buy) journal.push({ id: jid++, date: t.date, ref_type: 'transaction_tax', amount: -Math.round(gross * 0.03375 * 100) / 100 });
      if (!t.is_buy && i % 3 === 0) journal.push({ id: jid++, date: t.date, ref_type: 'brokers_fee', amount: -Math.round(gross * 0.0039 * 100) / 100 });
    });
    let bal = 6072843112.37;
    for (let i = journal.length - 1; i >= 0; i--) { journal[i].balance = Math.round(bal * 100) / 100; bal -= journal[i].amount; }
    journal.reverse();
  }

  function answer(data, ttl, age) { return Promise.resolve({ data, fetched: now, modified: now - (age || 0), expires: Date.now() + ttl }); }

  function get(path, opts) {
    const q = (opts && opts.query) || {};
    let m;
    if (path.indexOf('/characters/' + SCOUT + '/') === 0) {
      if (/\/wallet\/$/.test(path)) return answer(1284310455.2, 2 * M, 40e3);
      if (/\/assets\/$/.test(path)) return answer(scoutAssets, 60 * M, 35 * M);
      if (/\/skillqueue\/$/.test(path)) return answer([{ skill_id: 13278, finished_level: 5, queue_position: 0, start_date: iso(30 * H), finish_date: iso(-(6 * D + 2 * H)) }], 2 * M, M);
      if (/\/orders\/$/.test(path)) return answer([], 20 * M, 9 * M);
    }
    if ((m = path.match(/\/universe\/structures\/(\d+)\/$/))) return answer({ name: 'J111613 - Sample Fortizar', solar_system_id: 31002318, position: { x: 0, y: 0, z: 0 } }, D);
    if ((m = path.match(/\/universe\/groups\/(\d+)\/$/)) && GROUPS[m[1]]) return answer({ group_id: Number(m[1]), name: GROUPS[m[1]][0], category_id: GROUPS[m[1]][1] }, D);
    if ((m = path.match(/\/universe\/categories\/(\d+)\/$/)) && CATS[m[1]]) return answer({ category_id: Number(m[1]), name: CATS[m[1]] }, D);
    if (/\/location\/$/.test(path)) return answer({ solar_system_id: 30002053, station_id: ST.hek }, 5e3);
    if (/\/ship\/$/.test(path)) return answer({ ship_item_id: 1, ship_name: 'Dawn Treader IV', ship_type_id: 12733 }, 5e3);
    if (/\/wallet\/$/.test(path)) return answer(6072843112.37, 2 * M, 40e3);
    if (/\/wallet\/transactions\/$/.test(path)) return answer(q.from_id ? [] : tx, 60 * M, 22 * M);
    if (/\/wallet\/journal\/$/.test(path)) return answer(journal, 60 * M, 22 * M);
    if (/\/characters\/\d+\/orders\/$/.test(path)) return answer(orders, 20 * M, 9 * M);
    if (/\/orders\/history\/$/.test(path)) return answer([], 60 * M, 30 * M);
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
    if ((m = path.match(/\/planets\/(\d+)\/$/)) && /characters/.test(path)) return answer(colony(Number(m[1]) - 40150000), 10 * M, 4 * M);
    if ((m = path.match(/\/universe\/types\/(\d+)\/$/))) { const lt = lootOf.get(Number(m[1])); return answer({ type_id: Number(m[1]), volume: lt ? lt[2] : { 2288: 0.005, 2270: 0.005, 2396: 0.19, 2399: 0.19, 2329: 0.75 }[m[1]] || 1, capacity: { 2524: 500, 2544: 10000 }[m[1]] || 0, group_id: lt ? lt[1] : undefined }, D); }
    if ((m = path.match(/\/markets\/(\d+)\/history\/$/)) && lootOf.has(Number(q.type_id))) {
      const base = { 30744: 4000, 30745: 900, 30746: 300, 25624: 600, 30259: 1500, 30377: 9000, 30378: 5000, 20424: 2500 }[q.type_id];
      const mult = { 10000002: 1, 10000043: 0.2, 10000032: 0.08, 10000042: 0.05, 10000030: 0.002 }[m[1]] || 0;
      return answer([1, 2, 3, 4, 5, 6, 7].map(i => ({ date: iso(i * D).slice(0, 10), average: lootOf.get(Number(q.type_id))[3], highest: 0, lowest: 0, order_count: 5, volume: Math.round(base * mult) })).filter(x => x.volume).reverse(), D);
    }
    if ((m = path.match(/\/markets\/(\d+)\/history\/$/))) return answer([1, 2, 3, 4, 5, 6, 7, 8].map(i => ({ date: iso(i * D).slice(0, 10), average: 1540000 + i * 2100, highest: 1560000, lowest: 1500000, order_count: 9, volume: 20 + i })).reverse(), D);
    if (/\/markets\/prices\/$/.test(path)) return answer([{ type_id: 527, average_price: 884000 }, { type_id: 2329, average_price: 9100 }, { type_id: 12733, average_price: 251400000 }, { type_id: 11188, average_price: 318000000 }].concat(loot.map(x => ({ type_id: x[0], average_price: x[3] }))), 60 * M, 20 * M);
    if ((m = path.match(/\/markets\/(\d+)\/orders\/$/))) return answer(books[m[1] + ':' + q.type_id] || [], 5 * M, 2.4 * M);
    if ((m = path.match(/\/universe\/stations\/(\d+)\/$/))) return answer({ station_id: Number(m[1]), name: names[m[1]] || 'Station ' + m[1], system_id: SYS[m[1]] || 30000144 }, D);
    if ((m = path.match(/\/universe\/systems\/(\d+)\/$/))) { const s = systems[m[1]] || ['System ' + m[1], 0.9]; return answer({ system_id: Number(m[1]), name: s[0], security_status: s[1] }, D); }
    if ((m = path.match(/\/universe\/planets\/(\d+)\/$/))) return answer({ planet_id: Number(m[1]), name: 'Alakgur ' + ['I', 'II', 'III', 'IV', 'V', 'VI'][Number(m[1]) - 40150001] }, D);
    if (/\/universe\/system_kills\/$/.test(path)) return answer(kills.map(([system_id, ship_kills, pod_kills]) => ({ system_id, ship_kills, pod_kills, npc_kills: 0 })), 60 * M, 25 * M);
    if ((m = path.match(/\/route\/(\d+)\/(\d+)\/$/))) {
      const r = routes[m[2] + ':' + (q.flag || 'shortest')];
      if (r && Number(m[1]) === 30002053) return answer(r, D);
      const back = routes[m[1] + ':' + (q.flag || 'shortest')];
      if (back && Number(m[2]) === 30002053) return answer(back.slice().reverse(), D);
      const fwd = pairs[m[1] + '>' + m[2] + ':' + (q.flag || 'shortest')], rev = pairs[m[2] + '>' + m[1] + ':' + (q.flag || 'shortest')];
      if (fwd || rev) return answer(fwd || rev.slice().reverse(), D);
      if (Number(m[1]) === 30000144 && Number(m[2]) === 30000142) return answer([30000144, 30000142], D);
      if (Number(m[1]) === 30002053 && Number(m[2]) === 30002543) return answer([30002053, 30002543], D);
      return Promise.reject(new window.Esi.EsiError(404, 'No route found'));
    }
    return Promise.reject(new window.Esi.EsiError(404, 'Sample data has no answer for ' + path));
  }

  function post(path, body) {
    if (/\/universe\/names\/$/.test(path)) return Promise.resolve(body.map(id => ({ id, name: names[id] || (systems[id] && systems[id][0]) || 'Item ' + id, category: id > 6e7 ? 'station' : 'inventory_type' })));
    if (/\/universe\/ids\/$/.test(path)) return Promise.resolve({ inventory_types: Object.entries(names).filter(([, n]) => body.includes(n)).map(([id, name]) => ({ id: Number(id), name })) });
    return Promise.reject(new window.Esi.EsiError(404, 'Sample data has no answer for ' + path));
  }

  window.Demo = { on, get, post, who: { id: CHAR, name: 'Sample Trader', scopes: [] }, scout: { id: SCOUT, name: 'Sample Scout', scopes: [] } };
})();
