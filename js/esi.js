/* Eve Ops — EVE sign-in (OAuth 2 with PKCE, no secret) and the ESI request layer.
   The refresh token is kept in this browser's localStorage and sent only to login.eveonline.com.
   Inside the Eve Ops Android app the app keeps the sign-in instead (its widgets use it too) and
   this page asks the app for access tokens. */
(function () {
  'use strict';
  const C = window.EVEOPS_CONFIG;
  const AUTH = 'eveops.auth', PKCE = 'eveops.pkce';
  // A second character can be signed in beside the first: slot '' is the trader, 'scout' the wormhole pilot.
  const key = slot => (slot ? AUTH + '.' + slot : AUTH);

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* storage unavailable */ } },
  };

  class EsiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  // ------------------------------------------------- the Android app, if any
  // The app puts an EveOpsNative object on this page only: postMessage(text) out, onmessage in.
  const N = window.EveOpsNative || null;
  const calls = new Map();
  let callId = 0;
  if (N) N.onmessage = e => {
    let m;
    try { m = JSON.parse(e.data); } catch (err) { return; }
    const done = calls.get(m.rpc);
    if (done) { calls.delete(m.rpc); done(m); }
  };
  function tell(op, args) {
    if (!N) return;
    try { N.postMessage(JSON.stringify(Object.assign({ op }, args))); } catch (err) { /* the app has gone away */ }
  }
  function ask(op, args) {
    return new Promise((resolve, reject) => {
      const rpc = ++callId;                                   // answers carry the same number back
      calls.set(rpc, resolve);
      tell(op, Object.assign({ rpc }, args));
      setTimeout(() => { if (calls.delete(rpc)) reject(new EsiError(0, 'The app did not answer.')); }, 30000);
    });
  }
  /** In the app: learn who is signed in there, so who() can answer straight away. */
  async function init() {
    if (!N) return;
    const r = await ask('who');
    for (const slot of ['', 'scout']) {
      const w = r.slots && r.slots[slot], have = store.get(key(slot));
      if (!w) store.del(key(slot));
      else if (!have || !have.app || have.id !== w.id) store.set(key(slot), { app: true, access: null, exp: 0, id: w.id, name: w.name, scopes: w.scopes || [] });
    }
  }

  // ------------------------------------------------------------- sign-in
  function b64url(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function randomString(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a); }
  async function sha256(text) { return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))); }
  function readJwt(token) {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(part), c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  const form = params => Object.entries(params).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');

  async function login(slot) {
    if (N) return tell('login', { slot: slot || '' });      // the app opens EVE's sign-in in the phone's browser
    const verifier = randomString(32), state = randomString(16);
    const challenge = b64url(await sha256(verifier));
    if (!store.set(PKCE, { verifier, state, slot: slot || '' })) throw new EsiError(0, 'This browser is blocking storage, so the sign-in cannot be kept.');
    location.assign(C.sso + '/authorize/?' + form({
      response_type: 'code', redirect_uri: C.redirectUri, client_id: C.clientId,
      scope: C.scopes.join(' '), code_challenge: challenge, code_challenge_method: 'S256', state,
    }));
  }

  async function tokenRequest(params) {
    const res = await fetch(C.sso + '/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(params),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new EsiError(res.status, json.error_description || json.error || 'Sign-in failed (' + res.status + ').');
    return json;
  }

  function saveToken(json, slot) {
    const claims = readJwt(json.access_token);
    const auth = {
      refresh: json.refresh_token, access: json.access_token,
      exp: Date.now() + (Number(json.expires_in || 1200) - 60) * 1000,
      id: Number(String(claims.sub).split(':').pop()), name: claims.name,
      scopes: [].concat(claims.scp || []),
    };
    store.set(key(slot), auth);
    return auth;
  }

  /** If EVE has just sent the browser back with ?code=..., finish the sign-in. */
  async function finishLogin() {
    const q = new URLSearchParams(location.search);
    const code = q.get('code'), state = q.get('state'), denied = q.get('error');
    if (!code && !denied) return false;
    history.replaceState(null, '', location.pathname); // take the one-time code out of the address bar
    // A sign-in started by the Android app comes back to this page in the phone's browser: pass the code on to the app.
    if (state && state.indexOf('app.') === 0) return { handoff: 'eveops://auth?' + form(denied ? { error: denied, state } : { code, state }) };
    const p = store.get(PKCE);
    store.del(PKCE);
    if (denied) throw new EsiError(0, 'EVE did not complete the sign-in (' + denied + ').');
    if (!p || p.state !== state) throw new EsiError(0, 'That sign-in did not start in this browser. Try again.');
    saveToken(await tokenRequest({ grant_type: 'authorization_code', code, client_id: C.clientId, code_verifier: p.verifier }), p.slot);
    return p.slot || true;
  }

  const refreshing = new Map();
  async function token(force, slot) {
    const a = store.get(key(slot));
    if (!a) throw new EsiError(401, 'Signed out.');
    if (!force && a.access && a.exp > Date.now()) return a.access;
    if (N) {
      if (!refreshing.has(slot || '')) {
        refreshing.set(slot || '', ask('token', { slot: slot || '', force: !!force }).then(r => {
          if (!r.ok) {
            if (r.gone) store.del(key(slot));                 // EVE no longer accepts this sign-in
            throw new EsiError(r.gone ? 401 : 0, r.error || 'The app could not renew the sign-in.');
          }
          const auth = { app: true, access: r.access, exp: r.exp, id: r.id, name: r.name, scopes: r.scopes || [] };
          store.set(key(slot), auth);
          return auth;
        }).finally(() => { refreshing.delete(slot || ''); }));
      }
      return (await refreshing.get(slot || '')).access;
    }
    if (!refreshing.has(slot || '')) {
      refreshing.set(slot || '', tokenRequest({ grant_type: 'refresh_token', refresh_token: a.refresh, client_id: C.clientId })
        .then(json => saveToken(json, slot), err => {
          if (err.status === 400 || err.status === 401) store.del(key(slot)); // EVE no longer accepts this sign-in
          throw err;
        })
        .finally(() => { refreshing.delete(slot || ''); }));
    }
    return (await refreshing.get(slot || '')).access;
  }

  function who(slot) { const a = store.get(key(slot)); return a ? { id: a.id, name: a.name, scopes: a.scopes || [] } : null; }
  function signOut(slot) { tell('signout', { slot: slot || '' }); store.del(key(slot)); }

  // ------------------------------------------------------------ requests
  const cache = new Map(), flying = new Map(), waiting = [];
  let active = 0, pausedUntil = 0;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function limited(fn) {
    if (active >= C.concurrency) await new Promise(r => waiting.push(r));
    active++;
    try {
      const wait = pausedUntil - Date.now();
      if (wait > 0) await sleep(wait);
      return await fn();
    } finally {
      active--;
      const next = waiting.shift();
      if (next) next();
    }
  }

  async function request(url, auth, init) {
    return limited(async () => {
      for (let attempt = 0; ; attempt++) {
        const headers = Object.assign({ Accept: 'application/json' }, init && init.headers);
        if (auth) headers.Authorization = 'Bearer ' + await token(attempt > 0, auth === true ? '' : auth);
        const res = await fetch(url, Object.assign({}, init, { headers }));
        if (res.status === 401 && auth && attempt === 0) continue; // access token went stale early: refresh once
        if (res.status === 420 || res.status === 429) {
          const s = Number(res.headers.get('retry-after') || res.headers.get('x-esi-error-limit-reset') || 60);
          pausedUntil = Date.now() + Math.min(Math.max(s, 5), 300) * 1000;
          throw new EsiError(res.status, 'EVE asked the page to slow down. It will try again by itself.');
        }
        if (!res.ok) {
          let msg = '';
          try { msg = (await res.json()).error || ''; } catch (e) { /* not JSON */ }
          throw new EsiError(res.status, msg || 'Request failed (' + res.status + ').');
        }
        return res;
      }
    });
  }

  /**
   * GET an ESI path. Resolves to { data, modified, expires, fetched } (times in ms).
   * Answers are reused until EVE's own expiry time, so calling often costs nothing.
   */
  function get(path, opts) {
    opts = opts || {};
    if (window.Demo && window.Demo.on) return window.Demo.get(path, opts);
    const q = opts.query ? '?' + form(opts.query) : '';
    const url = C.esi + path + q;
    const now = Date.now();
    const hit = cache.get(url);
    if (hit && (hit.expires > now || now - hit.fetched < 20000)) return Promise.resolve(hit);
    if (flying.has(url)) return flying.get(url);
    const p = (async () => {
      const res = await request(url, opts.auth);
      let data = await res.json();
      const pages = Number(res.headers.get('x-pages') || 1);
      if (pages > 1 && Array.isArray(data)) {
        const sep = q ? '&' : '?';
        const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) =>
          request(url + sep + 'page=' + (i + 2), opts.auth).then(r => r.json())));
        data = data.concat(...rest);
      }
      const t = Date.now();
      const entry = {
        data, fetched: t,
        expires: Date.parse(res.headers.get('expires') || '') || t + 60000,
        modified: Date.parse(res.headers.get('last-modified') || '') || t,
      };
      cache.set(url, entry);
      return entry;
    })().finally(() => flying.delete(url));
    flying.set(url, p);
    return p;
  }

  /**
   * One page of a public path, fetched fresh and not kept (for the New lines screen, which reads whole regional books and thousands of
   * histories once and keeps only what it needs). It runs outside the page's own request queue, so the board keeps refreshing meanwhile,
   * but it waits out the same slow-down pause. A 404 is an empty page. -> { data, pages }
   */
  async function page(path, query, n) {
    if (window.Demo && window.Demo.on) return window.Demo.page(path, query, n);
    const wait = pausedUntil - Date.now();
    if (wait > 0) await sleep(wait);
    const q = Object.assign({}, query || {}, n > 1 ? { page: n } : null);
    const res = await fetch(C.esi + path + (Object.keys(q).length ? '?' + form(q) : ''), { headers: { Accept: 'application/json' } });
    if (res.status === 404) return { data: [], pages: 1 };
    if (res.status === 420 || res.status === 429) {
      const s = Number(res.headers.get('retry-after') || res.headers.get('x-esi-error-limit-reset') || 60);
      pausedUntil = Date.now() + Math.min(Math.max(s, 5), 300) * 1000;
      throw new EsiError(res.status, 'EVE asked the page to slow down.');
    }
    if (!res.ok) throw new EsiError(res.status, 'Request failed (' + res.status + ').');
    return { data: await res.json(), pages: Number(res.headers.get('x-pages') || 1) };
  }

  async function post(path, body) {
    if (window.Demo && window.Demo.on) return window.Demo.post(path, body);
    const res = await request(C.esi + path, false, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return res.json();
  }

  window.Esi = { login, finishLogin, init, who, signOut, get, page, post, store, EsiError, native: !!N, tell, ask, get paused() { return Math.max(0, pausedUntil - Date.now()); } };
})();
