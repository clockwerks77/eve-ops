/* Eve Ops — settings. Nothing in this file is secret. */
window.EVEOPS_CONFIG = {
  // Client ID of the EVE developer application (public; this sign-in method uses no secret key).
  clientId: 'a159c63b56f249589acb4cd1a8d63440',
  // Must match the application's Callback URL exactly.
  redirectUri: 'https://clockwerks77.github.io/eve-ops/',
  scopes: [
    'esi-markets.read_character_orders.v1',
    'esi-wallet.read_character_wallet.v1',
    'esi-assets.read_assets.v1',
    'esi-location.read_location.v1',
    'esi-location.read_ship_type.v1',
    'esi-clones.read_clones.v1',
    'esi-skills.read_skillqueue.v1',
    'esi-skills.read_skills.v1',
    'esi-planets.manage_planets.v1',
    'esi-universe.read_structures.v1',
    'esi-markets.structure_markets.v1',
  ],
  esi: 'https://esi.evetech.net/latest',
  sso: 'https://login.eveonline.com/v2/oauth',

  // Fees as verified from the wallet journal: 1.5% broker, 3.375% sales tax,
  // 0.39% of the new order value for each price change.
  fees: { broker: 0.015, salesTax: 0.03375, modify: 0.0039 },

  // Your hubs. An order anywhere else is flagged for a look.
  hubs: [
    { station: 60005686, region: 10000042, name: 'Hek' },
    { station: 60004588, region: 10000030, name: 'Rens' },
    { station: 60011866, region: 10000032, name: 'Dodixie' },
    { station: 60008494, region: 10000043, name: 'Amarr' },
    { station: 60003760, region: 10000002, name: 'Jita' },
  ],
  // Planetary Interaction: where the products are sold (valued at that hub's lowest ask),
  // and how much has to be waiting on the planets before a pickup is called worth a stop.
  pi: { sellStation: 60005686, worth: 50e6 },

  // Jita 4-4 is the source market: its sell price is the reference for "is this a dump?".
  jita: { station: 60003760, region: 10000002, system: 30000142 },

  // Left out of trading math: PLEX, skill injectors, skill extractor.
  excludeTypes: [44992, 40520, 45635, 40519],
  // Planetary products are sold at zero cost basis.
  zeroCostTypes: [2329, 3693, 9830, 9832, 2312, 3775],

  // Restock shortlist: lines with this many days of stock or fewer, that sold at least minWeek units in 7 days. Lines netting under minMargin are listed but not offered a bid.
  restock: { days: 4, minWeek: 5, minMargin: 0.10 },
  // Loot hand-overs: a hub is a place to list a pile only if it would sell within `days` at `share` of that hub's daily trade.
  loot: { share: 0.15, days: 14 },
  // Hauler cargo in m3 (the fitted figure; change it on the page whenever the fit changes).
  haul: { cargo: 11016 },

  // An undercut of this many units or fewer is a sniper: the price is offered, not urged.
  sniperUnits: 5,
  // A price change bigger than this share of your price is flagged "Big move" for you to judge
  // (dump or repricing?) instead of being listed as a routine change.
  bigMove: 0.02,
  // Cost of what you sell: 'wallet' takes what the wallet shows you paid (first in, first out) and falls back to the tracker's
  // pasted unit costs only for units the wallet has no purchase for. 'tracker' takes the tracker's unit cost for every item it lists.
  costs: { prefer: 'wallet' },
  // Weekly close: a week ties out when the page's net is within this share of the figure typed in from the tracker.
  // After `weeks` tied weeks in a row the page says it can take over as the ledger.
  tieOut: { within: 0.02, weeks: 2 },
  // A sell line with no sale at its hub for this many days, on stock bought longer ago than that, is not urged to
  // "Change": the price is still offered, as "Slow line", because each change costs a fee the line may not earn back.
  slowFee: { days: 7 },
  // "Copied" marks on the price buttons: after `grace` seconds of newer market data with the old price still showing,
  // a copied price is reported as not in the book; marks are dropped after `keepHours`.
  copied: { grace: 180, keepHours: 6 },
  // A line with no sale for this many days is listed under "Slow lines".
  staleDays: 14,

  // ---- Expedition ops (the wormhole camp): Phase A, Muster and Kit & Shopping.
  expedition: {
    // Adam flies two characters on one account, never both at once: one seat, two modes.
    modes: [
      { key: 'khiana', name: 'Khiana Kyn', role: 'Scout and combat lead', hull: 'Odysseus', note: 'Scout, combat and the Odysseus. Expedition Command Ships IV lands Nov 19, 2026.', can: ['gas', 'ratter', 'scan', 'pvp', 'boost'] },   // Gas Cloud Harvesting V, Expedition Frigates III (character baseline, Aug 2026)
      { key: 'todashi', name: 'Todashi Kitsune', role: 'Boosts and compression', hull: 'Porpoise', note: 'Porpoise boosts and compression. Industrial Command Ships V, Mining Foreman V; Mining Director I to IV trains Nov 20 to 27, 2026.', can: ['barge', 'ratter', 'boost'] },                              // Mining Barge V
    ],
    // The can-fly matrix, in the order the muster asks it.
    canFly: [
      { key: 'gas', label: 'Gas ship', long: 'Prospect, or Venture with gas harvesting' },
      { key: 'barge', label: 'Barge', long: 'Procurer or another mining barge' },
      { key: 'ratter', label: 'Ratter', long: 'Praxis, Drake or Gila' },
      { key: 'scan', label: 'Scanner', long: 'Cloaky scanning frigate' },
      { key: 'pvp', label: 'PvP hull', long: 'The PvP doctrine hull' },
      { key: 'boost', label: 'Boosts', long: 'Any command or boost ship' },
    ],
    // What every pilot has to be able to fly for the standard kit; a pilot without one gets a plain-language gap.
    // sp: skill points from nothing to sit in the hull and fit its tool, added up from EVE's own type data on 2026-11-15
    // (Venture 750 + Gas Cloud Scoop I 45,505; Procurer 387,760; Praxis 250). It leaves out tank and fitting skills.
    needs: [
      { key: 'gas', lack: 'no gas ship', fix: 'assign a Venture and Gas Cloud Harvesting I', sp: 46255 },
      { key: 'barge', lack: 'no mining barge', fix: 'assign a Procurer (Mining Barge I, Astrogeology III)', sp: 387760 },
      { key: 'ratter', lack: 'no ratting hull', fix: 'assign a Praxis (Spaceship Command I)', sp: 250 },
      { key: 'pvp', lack: 'no PvP hull', fix: 'assign the doctrine hull once it is agreed', sp: null },
    ],
    spPerHour: { omega: 1800, alpha: 900 },        // no implants, even attributes
    // The standard four-hull kit, every pilot. `ship` is the item name for the shopping list until a fit is pasted.
    kit: [
      { key: 'prospect', label: 'Prospect', ship: 'Prospect', role: 'Gas, and always able to scan its own pilot home' },
      { key: 'procurer', label: 'Procurer', ship: 'Procurer', role: 'The tanked ore hull' },
      { key: 'praxis', label: 'Praxis', ship: 'Praxis', role: 'The ratter; a Higgs rig swap makes it the hole roller' },
      { key: 'pvp', label: 'PvP reship', ship: null, role: 'One hull, one agreed doctrine' },
    ],
    places: ['Jita', 'Rens'],
    // Shared camp stock to start from (every figure can be changed on the page). `doubled` is the camp rule: spares x2 for a multi-night stay.
    stock: [
      { item: 'Core Scanner Probe I', label: 'Scanner probes', base: 8, per: 'pilot', doubled: true },
      { item: 'Nanite Repair Paste', label: 'Nanite paste', base: 50, per: 'pilot', doubled: true },
      { item: 'Mobile Depot', label: 'Mobile depots', base: 1, per: 'pilot', doubled: true },
      { item: '', label: 'Ammunition', base: 0, per: 'pilot', doubled: true },
      { item: '', label: 'Cap boosters', base: 0, per: 'pilot', doubled: true },
      { item: 'Mobile Tractor Unit', label: 'Tractor units', base: 2, per: 'camp', doubled: false },
      { item: '', label: 'Salvage destroyer', base: 1, per: 'camp', doubled: false },
    ],
    // The camp's day is these session types. `picket` says whether a picket rotation is offered when one starts.
    windows: [
      { key: 'mining', label: 'Mining', picket: true },
      { key: 'gas', label: 'Gas', picket: true },
      { key: 'ratting', label: 'Ratting', picket: true },
      { key: 'defence', label: 'Defence', picket: false },
      { key: 'exploration', label: 'Exploration', picket: false },
    ],
    exfil: ['active residents return', 'repeated hunter sightings on the chain', 'a key hole goes unstable with the bank still inside'],
    classes: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'],
    stages: [{ key: 'nomad', label: 'Nomad camp' }, { key: 'home', label: 'J142117, the corp home' }],
    holeStates: [{ key: 'fresh', label: 'Fresh' }, { key: 'unstable', label: 'Unstable' }, { key: 'critical', label: 'Critical' }],
    // Timers, in minutes unless named otherwise. `late_min`: the second ring when a picket change is not confirmed.
    // `ahead` and `horizon_hours`: how many picket changes the phone is told about in advance.
    timers: { picket_min: 45, snooze_min: 10, late_min: 5, gas_min: 15, eol_hours: 4, eol_warn_min: [60, 15], ahead: 12, horizon_hours: 10 },
    night0: ['Fits simulated', 'Shopping done', 'Wanderer access confirmed', 'Comms confirmed', 'Shared bookmark folder confirmed', 'Rescue frigates staged in Rens'],
  },

  concurrency: 8,
};
