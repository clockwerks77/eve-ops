// Checks how the page behaves inside the Android app, using a stand-in for the app's EveOpsNative object.
//   node tools/app-link-test.js
// Covers: the summary handed over for the widgets, copy through the app, sign-in asked of the app,
// tokens taken from the app (and no refresh token kept by the page), the hand-over screen in the phone's
// browser after EVE approves, and that an ordinary browser sign-in is unchanged.
const { serve, playwright, chrome } = require('./serve.js');
const fakeApp = signedIn => `
  window.__sent = [];
  window.EveOpsNative = { onmessage: null, postMessage(text) {
    const m = JSON.parse(text); window.__sent.push(m);
    const reply = r => setTimeout(() => this.onmessage({ data: JSON.stringify(Object.assign({ rpc: m.rpc }, r)) }), 5);
    if (m.op === 'who') reply({ slots: ${signedIn ? "{ '': { id: 92279686, name: 'Test Trader', scopes: [] } }" : '{}'} });
    if (m.op === 'token') reply({ ok: true, access: 'TOKEN-FROM-APP-' + (m.slot || 'trader'), exp: Date.now() + 600000, id: 92279686, name: 'Test Trader', scopes: [] });
  } };`;
let failed = 0;
const check = (label, ok, detail) => { if (!ok) failed++; console.log((ok ? 'ok   ' : 'FAIL ') + label + (detail ? ' — ' + detail : '')); };
(async () => {
  const server = await serve(8141), base = 'http://localhost:8141/';
  const browser = await playwright().chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  const open = async init => {
    const page = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2 });
    page.errors = [];
    page.on('pageerror', e => page.errors.push(e.message));
    if (init) await page.addInitScript(init);
    await page.route('https://images.evetech.net/**', r => r.abort());
    return page;
  };

  let page = await open(fakeApp(false));
  await page.goto(base + '#demo', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3500);
  const snaps = await page.evaluate(() => window.__sent.filter(m => m.op === 'snapshot'));
  const last = snaps[snaps.length - 1];
  check('sample data in the app: a finished summary is handed over', !!last && last.settled === true && last.data.v === 1 && !page.errors.length, snaps.length + ' sent ' + page.errors.join(' | '));
  check('the summary has orders, planets, the wormhole pilot and loot', !!last && last.data.orders.change > 0 && last.data.planets.length > 0 && !!last.data.wh && last.data.scout.loot.list > 0);
  if (process.argv[2]) require('fs').writeFileSync(process.argv[2], JSON.stringify(last.data, null, 1));   // refresh the Android test fixture
  await page.click('.price >> nth=0').catch(() => {});
  check('a price tap copies through the app', (await page.evaluate(() => window.__sent.filter(m => m.op === 'copy').length)) === 1);
  await page.close();

  page = await open(fakeApp(false));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.click('text=Log in with EVE');
  await page.waitForTimeout(200);
  check('signed out in the app: the button asks the app to start the sign-in', (await page.evaluate(() => window.__sent.filter(m => m.op === 'login').length)) === 1 && page.url() === base && !(await page.locator('.btn-big').isDisabled()));
  await page.close();

  page = await open(fakeApp(true));
  const seen = [];
  await page.route('https://esi.evetech.net/**', r => { const a = r.request().headers().authorization; if (a) seen.push(a); r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type' }, body: /wallet\/$/.test(r.request().url()) ? '123.45' : /\/(location|ship|skills|clones)\//.test(r.request().url()) ? '{}' : '[]' }); });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  check('signed in through the app: requests carry the app\'s token', seen.length > 0 && seen.every(a => a === 'Bearer TOKEN-FROM-APP-trader'), seen.length + ' requests');
  check('the page keeps no refresh token', !(await page.evaluate(() => 'refresh' in JSON.parse(localStorage.getItem('eveops.auth')))));
  await page.close();

  page = await open(null);
  await page.goto(base + '?code=ONE-TIME-CODE&state=app.scout.abc123', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(600);
  check('phone browser after EVE approves: the code is handed to the app', (await page.locator('a.btn-big').getAttribute('href').catch(() => '')) === 'eveops://auth?code=ONE-TIME-CODE&state=app.scout.abc123' && page.url() === base);
  await page.close();

  page = await open(null);
  await page.goto(base + '?code=X&state=not-ours', { waitUntil: 'networkidle' });
  check('ordinary browser: a sign-in that did not start here is still refused', /did not start in this browser/.test(await page.locator('.door-note').innerText().catch(() => '')));
  await page.close();

  await browser.close(); server.close();
  console.log(failed ? failed + ' check(s) failed' : 'all checks passed');
  process.exit(failed ? 1 : 0);
})();
