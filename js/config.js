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

  concurrency: 8,
};
