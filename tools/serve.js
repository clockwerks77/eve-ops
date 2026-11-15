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
