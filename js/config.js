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

  // Jita 4-4 is the source market: its sell price is the reference for "is this a dump?".
  jita: { station: 60003760, region: 10000002, system: 30000142 },

  // Left out of trading math: PLEX, skill injectors, skill extractor.
  excludeTypes: [44992, 40520, 45635, 40519],
  // Planetary products are sold at zero cost basis.
  zeroCostTypes: [2329, 3693, 9830, 9832, 2312, 3775],

  // An undercut of this many units or fewer is a sniper: the price is offered, not urged.
  sniperUnits: 5,
  // A line with no sale for this many days is listed under "Slow lines".
  staleDays: 14,

  concurrency: 8,
};
