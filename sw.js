/* Eve Ops: the copy of the page kept on the device, so it opens with no network.
   Only this page's own files are kept. Requests to EVE, zKillboard and GitHub's API are never touched.
   The page itself is always fetched fresh when there is a network (so a new version shows at once) and comes
   from the copy only when there is none; the versioned files (css, js, fonts) come from the copy first. */
'use strict';
const VERSION = new URL(self.location.href).searchParams.get('v') || '0';
const CACHE = 'eveops-v' + VERSION;
const SCOPE = self.registration.scope;                       // https://.../eve-ops/
const isPage = url => url.origin === self.location.origin && (url.href.split('?')[0].split('#')[0] === SCOPE || url.pathname.endsWith('/index.html'));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const res = await fetch(SCOPE, { cache: 'no-store' });
    const html = await res.clone().text();
    await cache.put(SCOPE, res);
    // everything the page names with a version, plus the fonts its stylesheet names
    const files = Array.from(html.matchAll(/(?:src|href)="([^"]+\?v=[^"]+)"/g), m => new URL(m[1], SCOPE).href);
    await Promise.all(files.map(async f => {
      const r = await fetch(f, { cache: 'no-store' });
      if (!r.ok) throw new Error('could not keep ' + f);
      await cache.put(f, r.clone());
      if (/\.css(\?|$)/.test(f)) await Promise.all(Array.from((await r.text()).matchAll(/url\("?([^")]+)"?\)/g), m => cache.add(new URL(m[1], f).href).catch(() => {})));
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.indexOf('eveops-v') === 0 && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.href.indexOf(SCOPE) !== 0) return;      // not this page's file: the browser handles it
  if (!isPage(url) && !url.searchParams.has('v') && url.pathname.indexOf('/fonts/') < 0) return;                 // only the page, its versioned files and its fonts
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (isPage(url)) {
      try {
        const res = await fetch(req);
        if (res.ok && req.mode === 'navigate') cache.put(SCOPE, res.clone());
        return res;
      } catch (err) {
        const kept = await cache.match(SCOPE);
        if (kept) return kept;
        throw err;
      }
    }
    const kept = await cache.match(req);
    if (kept) return kept;
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  })());
});
