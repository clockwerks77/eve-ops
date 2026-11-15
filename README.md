# Eve Ops

A live trading board for one EVE Online character: every open order against the current market book, the exact legal price to type at each hub, the route between hubs with the last hour's losses, and the timers that matter (planets, skill queue, jump clone).

It is a static page. There is no server and no database: your browser talks straight to EVE's API (ESI) and EVE's login.

Live at <https://clockwerks77.github.io/eve-ops/>. Add `#demo` to the address to look around with sample data.

## Signing in

"Log in with EVE" uses EVE's single sign-on with PKCE, the flow meant for apps that cannot keep a secret. The page never sees a password and there is no secret key anywhere in this repository. The Client ID in `js/config.js` is public by design.

After sign-in the browser holds a refresh token in its own storage (`localStorage`). It is sent only to `login.eveonline.com`. Each device signs in separately. "Sign out" removes it from that device; to revoke access everywhere, remove the application under *Third Party Applications* in EVE account management.

All requested scopes are read-only in practice. `esi-planets.manage_planets.v1` is the scope that allows reading extractor timers; ESI offers no way to change a colony.

Note that every site under `clockwerks77.github.io` shares the same browser storage, so only host pages you wrote yourself on this account.

## What the page works out

- **Position** of each sell order among sell orders in the same station, and of each buy order among bids that can be filled at its station (range is checked).
- **Price to type**: one legal step under the front of the book (sells) or over the top bid (buys). EVE prices carry four significant figures, so the step is 1,000 ISK above 1M, 100 ISK above 100k, and so on.
- **Call**: Change (a routine step), Big move (the front is more than 2% away from your price: dump or repricing is your call), Sniper (a few units just under you), Hold (the front is below your cost, or at or below the Jita sell price), Leading. Two orders for the same item in one station are always given the same price, and each is named by its size.
- **Net each**: `price × (1 − broker − sales tax) − cost`. Cost is first-in first-out over the wallet transactions EVE still returns (about six weeks), so it is an estimate. The tracker workbook stays the ledger of record.
- **Hub tabs**: one tab per hub with open orders, nearest first. The tab for the hub you dock in (or fly into) selects itself; picking another tab by hand holds until you move again.
- **Routes**: shortest and secure, one square per system coloured by security status, a red cap where ships or pods were lost in the last hour (`ship/pod` counts listed beside it).
- **Overall wealth**: wallet + ISK held in buy orders + sell orders at your list prices + everything in hangars and ships at EVE's universe-wide average price (blueprint copies left out). One character only, and an estimate.
- **Checks**: an order outside your hubs, listed for fewer than 90 days, priced far from the book (decimal slips), or selling below cost gets a red "Check" with the reason.
- **Big moves** are shown with the hub region's last seven days of history (average price, units a day) and a reading: looks like a dump, the market has moved, or could be either.
- **Planetary Interaction**: each colony's product, the units waiting on the planet now and gained per day, the lowest ask in every hub, and a pickup call. EVE reports a colony only as it was when last opened in game, so the page rolls each one forward itself (extractor decay curve, factory cycles, storage limits); `pi.worth` in the settings is the value at which a pickup becomes "worth a stop". The hub nearest the colonies carries a "Planetary pickup" marker when it is.
- **Pins**: "Pin prices" freezes the prices for a stop while you work through it. Each row then waits until the market book shows that exact price.

## How fresh the numbers are

EVE republishes on its own timers and the page refetches as each one lapses:

| Data | Updates every |
|---|---|
| Market books | 5 minutes |
| Your order list | 20 minutes |
| Wallet balance | 2 minutes |
| Sales and purchases | 60 minutes |
| Hangars | 60 minutes |
| Planets | 10 minutes |
| Location | 5 seconds |

Your own orders are matched by ID inside the market book, so a price change shows within 5 minutes without waiting for the 20-minute list. A brand-new order appears once the list refreshes.

## Settings

`js/config.js` holds the fees (broker 1.5%, sales tax 3.375%, 0.39% per price change), the sniper and big-move thresholds, the slow-line threshold, and the item types left out of trading math.

## Deploying

Push to `main`. Bump the version number in `index.html` (the `eveops-version` meta tag and every `?v=`) in the same commit: browsers cache the files for ten minutes otherwise, and an open board checks that number every five minutes and offers a reload when it changes.

## Files

- `index.html`, `css/app.css` — the page and its three layouts (monitor, tablet, phone)
- `js/logic.js` — price steps, book position, calls, FIFO ledger (no network; unit-tested)
- `js/esi.js` — sign-in and requests
- `js/app.js` — loading, model, drawing
- `js/demo.js` — sample data behind `#demo`
- `tests/logic.test.js` — run with `node --test tests/logic.test.js`

The page sets a content security policy that allows requests only to `esi.evetech.net` and `login.eveonline.com`, and scripts only from this repository.

The typeface is Barlow Semi Condensed (SIL Open Font License, see `fonts/LICENSE-Barlow.txt`). EVE Online and its data belong to CCP hf.
