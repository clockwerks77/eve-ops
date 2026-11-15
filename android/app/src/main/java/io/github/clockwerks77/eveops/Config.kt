package io.github.clockwerks77.eveops

/** Settings shared with the dashboard page (js/config.js). Nothing here is secret. */
object Config {
    /** Client ID of the EVE developer application. This sign-in method (PKCE) uses no secret key. */
    const val CLIENT_ID = "a159c63b56f249589acb4cd1a8d63440"

    const val ORIGIN = "https://clockwerks77.github.io"
    const val PAGE = "https://clockwerks77.github.io/eve-ops/"

    /** Must match the EVE application's Callback URL exactly. The page there hands the code back to this app. */
    const val REDIRECT = PAGE
    const val SSO = "https://login.eveonline.com/v2/oauth"

    val SCOPES = listOf(
        "esi-markets.read_character_orders.v1",
        "esi-wallet.read_character_wallet.v1",
        "esi-assets.read_assets.v1",
        "esi-location.read_location.v1",
        "esi-location.read_ship_type.v1",
        "esi-clones.read_clones.v1",
        "esi-skills.read_skillqueue.v1",
        "esi-skills.read_skills.v1",
        "esi-planets.manage_planets.v1",
        "esi-universe.read_structures.v1",
        "esi-markets.structure_markets.v1",
    )

    /** Two characters can be signed in: the trader and the wormhole pilot. */
    const val TRADER = ""
    const val SCOUT = "scout"
    val SLOTS = listOf(TRADER, SCOUT)
}
