// Two browsers stand in for two devices and share state through a stand-in for GitHub's gist API (nothing leaves this machine).
// Runs on the sample data (#demo), which syncs through its own file name and setting.
//   node tools/sync-test.js
const assert = require('assert');
const { serve, playwright, chrome } = require('./serve.js');
(async () => {
  const server = await serve(8145);
  const browser = await playwright().chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  const ok = (name, cond) => { assert.ok(cond, name); console.log('ok  ', name); };

  // ---- the stand-in for GitHub: one account, its gists, and a log of what was asked
  const gists = [], log = [];
  let refuse = 0, tag = 1;
  const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'ETag', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS' };
  const github = async route => {
    const req = route.request(), url = new URL(req.url()), method = req.method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const auth = req.headers().authorization || '';
    log.push({ method, path: url.pathname, auth, inm: req.headers()['if-none-match'] || '' });
    if (refuse) return route.fulfill({ status: refuse, headers: cors, contentType: 'application/json', body: '{"message":"no"}' });
    if (auth !== 'Bearer test-token') return route.fulfill({ status: 401, headers: cors, contentType: 'application/json', body: '{"message":"Bad credentials"}' });
    const send = (status, body, etag) => route.fulfill({ status, headers: Object.assign({}, cors, etag ? { etag } : {}), contentType: 'application/json', body: JSON.stringify(body) });
    if (method === 'GET' && url.pathname === '/gists') return send(200, gists);
    if (method === 'POST' && url.pathname === '/gists') { const g = Object.assign({ id: 'g' + (gists.length + 1), etag: '"' + (tag++) + '"' }, JSON.parse(req.postData())); gists.push(g); return send(201, g, g.etag); }
    const g = gists.find(x => '/gists/' + x.id === url.pathname);
    if (!g) return send(404, { message: 'Not Found' });
    if (method === 'GET') return req.headers()['if-none-match'] === g.etag ? route.fulfill({ status: 304, headers: cors }) : send(200, g, g.etag);
    if (method === 'PATCH') { Object.assign(g.files, JSON.parse(req.postData()).files); g.etag = '"' + (tag++) + '"'; return send(200, g, g.etag); }
    return send(405, {});
  };
  const device = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await ctx.newPage();
    page.errors = [];
    page.on('pageerror', e => page.errors.push(e.message));
    await ctx.route('https://api.github.com/**', github);
    await page.route('https://images.evetech.net/**', r => r.abort());
    await page.goto('http://localhost:8145/#demo', { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    return page;
  };
  const turnOn = async (page, token) => { await page.locator('[data-keep="sync-token"]').fill(token); await page.locator('.panel-sync >> text=Turn on').click(); await page.waitForTimeout(700); };
  const syncNow = async page => { await page.locator('.panel-sync >> text=Sync now').click(); await page.waitForTimeout(700); };
  const shared = () => JSON.parse(gists[0].files['eve-ops-sync-demo.json'].content);
  const panel = page => page.locator('.panel-sync').innerText();

  const pc = await device();
  ok('sync is off until a token is given, and nothing has been sent to GitHub', /Make a token/.test(await panel(pc)) && log.length === 0);
  await turnOn(pc, 'wrong-token');
  ok('a token GitHub rejects is reported and not kept', /did not accept the token/.test(await panel(pc)) && await pc.evaluate(() => localStorage.getItem('eveops.sync.demo')) === null);
  await turnOn(pc, 'test-token');
  ok('the first device makes one secret file', gists.length === 1 && gists[0].public === false && !!gists[0].files['eve-ops-sync-demo.json'] && /This device made the shared file/.test(await panel(pc)));
  ok('the real sync file and setting are untouched by sample data', !gists[0].files['eve-ops-sync.json'] && await pc.evaluate(() => localStorage.getItem('eveops.sync')) === null);

  // a price copied on the PC shows as copied on the phone
  const key = await pc.locator('.stop .rows .price').first().getAttribute('data-copy');
  await pc.locator('.stop .rows .price').first().click();
  await pc.waitForTimeout(4200);                                   // the write goes up a few seconds after the press
  ok('a copied mark is written to the shared file', !!shared().copied[key] && shared().copied[key].price > 0);
  const phone = await device();
  await turnOn(phone, 'test-token');
  ok('the second device joins the same file', gists.length === 1 && /joined the shared file/.test(await panel(phone)));
  ok('and shows the price as copied', await phone.locator('.price.is-done[data-copy="' + key + '"]').count() === 1 && /1 of \d+ copied/.test(await phone.locator('.stop-sum').first().innerText()));

  // undone on the phone, it clears on the PC
  await phone.locator('.tag').first().click();
  await phone.waitForTimeout(4200);
  ok('removing the mark on the phone is written as a removal', shared().copied[key].gone === true);
  await syncNow(pc);
  ok('and the mark is gone on the PC', await pc.locator('.price.is-done').count() === 0 && !/copied/.test(await pc.locator('.stop-sum').first().innerText()));

  // pins and the tracker figure travel too
  await pc.locator('.stop-tools >> text=/^Pin \\d+ price/').click();
  const row = pc.locator('.closes-table tbody tr').nth(1);
  await row.locator('.isk-in').fill('18.2M'); await row.locator('.isk-in').press('Enter');
  await pc.waitForTimeout(4200);
  await syncNow(phone);
  ok('pins made on the PC show on the phone', await phone.locator('.chip-pin').count() > 0);
  ok('the tracker figure typed on the PC shows on the phone', await phone.locator('.closes-table tbody tr').nth(1).locator('.isk-in').inputValue() === '18,200,000');

  // the tracker's costs travel too
  await pc.click('text=Paste rows from the tracker');
  await pc.locator('.costs-text').fill('Item\tVenue\tUnit Cost\nSmall Shield Extender II\tRens\t401,500');
  await pc.click('text=Read these rows');
  await pc.waitForTimeout(4600);
  await syncNow(phone);
  ok('tracker costs pasted on the PC reach the phone, and its weekly figures use them', /1 row, 1 item/.test(await phone.locator('.closes-costs').innerText())
    && /at tracker cost/.test(await phone.locator('.closes-table tbody tr').first().innerText()));

  // quiet when nothing changes; clear about failures
  const writes = log.filter(x => x.method === 'PATCH').length;
  await syncNow(pc); await syncNow(pc);
  ok('checking again with nothing new writes nothing and asks only "has it changed?"', log.filter(x => x.method === 'PATCH').length === writes && log[log.length - 1].inm !== '');
  refuse = 401; await syncNow(pc);
  ok('an expired token is reported in the panel', /did not accept the token/.test(await panel(pc)));
  refuse = 0; await syncNow(pc);
  ok('and sync recovers when GitHub accepts it again', /Last checked/.test(await panel(pc)));
  await pc.locator('.panel-sync >> text=Turn off here').click(); await pc.waitForTimeout(200);
  ok('turning it off forgets the token on that device and leaves the file', await pc.evaluate(() => localStorage.getItem('eveops.sync.demo')) === null && gists.length === 1);
  ok('the token only ever went to GitHub\'s API, as a bearer token', log.every(x => /^Bearer (test|wrong)-token$/.test(x.auth)));
  ok('no page errors', pc.errors.length === 0 && phone.errors.length === 0);
  await browser.close(); server.close();
  console.log('all checks passed');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
