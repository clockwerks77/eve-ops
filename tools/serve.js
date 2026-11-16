// A tiny static server for the repository root, shared by the scripts in this folder.
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png' };

exports.playwright = () => require(process.env.PLAYWRIGHT || '/opt/npm-tools/node_modules/playwright');
exports.chrome = process.env.CHROME || '/usr/bin/google-chrome';
exports.serve = port => new Promise(resolve => {
  const server = http.createServer((req, res) => {
    let f = decodeURIComponent(req.url.split('?')[0]);
    if (f.endsWith('/')) f += 'index.html';
    const full = path.join(root, f);
    if (!full.startsWith(root) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[path.extname(full)] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  });
  server.listen(port, () => resolve(server));
});

/**
 * Moves the page's clock forward by whole days so its "today" is a Thursday. The sample data is dated back from "now",
 * so in the first hours of a Monday the week has no sales yet and the weekly-close checks would have nothing to read.
 */
exports.midweek = page => page.addInitScript(days => {
  const Real = Date, shift = days * 864e5;
  if (!shift) return;
  class Shifted extends Real {
    constructor(...a) { if (a.length) super(...a); else super(Real.now() + shift); }
    static now() { return Real.now() + shift; }
  }
  window.Date = Shifted;
}, (4 - new Date().getDay() + 7) % 7);
