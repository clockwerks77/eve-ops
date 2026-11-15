// Draws the page on its sample data (#demo) at the three sizes Adam reads it on, and saves pictures to look at.
//   node tools/render.js <output folder>
// Prints page errors and any sideways overflow. Needs Playwright and Chrome (see serve.js for the paths).
const path = require('path'), fs = require('fs');
const { serve, playwright, chrome } = require('./serve.js');
const out = process.argv[2] || 'shots';
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const server = await serve(8140);
  const browser = await playwright().chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  let problems = 0;
  for (const [name, w, hgt, dpr] of [['monitor', 1920, 1080, 1], ['tablet', 1280, 800, 1], ['phone', 390, 844, 2]]) {
    const page = await browser.newPage({ viewport: { width: w, height: hgt }, deviceScaleFactor: dpr });
    const logs = [];
    page.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED/.test(m.text())) logs.push(m.text()); });
    page.on('pageerror', e => logs.push('pageerror: ' + e.message));
    await page.route('https://images.evetech.net/**', r => r.abort());      // item icons are not needed to judge layout
    await page.goto('http://localhost:8140/#demo', { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(out, name + '-trading.png'), fullPage: true });
    const wide1 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await page.click('text=Wormholes');
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(out, name + '-wormholes.png'), fullPage: true });
    const wide2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const loot = await page.locator('#loot').count();
    problems += logs.length + (wide1 > 0) + (wide2 > 0) + (loot ? 0 : 1);
    console.log(name + ':', 'sideways overflow', wide1, '/', wide2, '| loot table', loot ? 'shown' : 'MISSING', '|', logs.length ? logs.join(' | ') : 'no errors');
    await page.close();
  }
  await browser.close(); server.close();
  console.log(problems ? problems + ' problem(s)' : 'all clear', '- pictures in', out);
  process.exit(problems ? 1 : 0);
})();
