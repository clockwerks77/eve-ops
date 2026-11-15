/* Eve Ops — the same pins, copied marks, "Mark as seen" and weekly closes on every device.
   The shared copy is one small file in a secret GitHub gist. Each device reads and writes it with a
   GitHub token that its owner pastes in once; the token stays in that device's storage and goes nowhere but GitHub.
   Off until a token is given. Sample data (#demo) uses its own file and its own setting, never the real one. */
(function () {
  'use strict';
  const E = window.Esi, L = window.Logic;
  const demo = !!(window.Demo && window.Demo.on);
  const KEY = demo ? 'eveops.sync.demo' : 'eveops.sync';
  const FILE = demo ? 'eve-ops-sync-demo.json' : 'eve-ops-sync.json';
  const API = 'https://api.github.com';

  let cfg = E.store.get(KEY) || null;           // { token, id }
  const st = { last: 0, err: null, busy: false, etag: null, remote: null };

  class SyncError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }
  const explain = status => (status === 401 ? 'GitHub did not accept the token. It may have expired.'
    : status === 403 ? 'GitHub refused: the token needs the account permission "Gists" set to read and write (or GitHub asked the page to slow down).'
    : status === 404 ? 'The sync file was not found. Turn sync off and on again to make a new one.'
    : 'GitHub answered ' + status + '.');

  async function call(method, path, body, etag) {
    const headers = { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + cfg.token };
    if (etag) headers['If-None-Match'] = etag;
    if (body) headers['Content-Type'] = 'application/json';
    let res;
    try { res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' }); }
    catch (err) { throw new SyncError(0, 'GitHub could not be reached.'); }
    if (res.status === 304) return { status: 304 };
    if (!res.ok) throw new SyncError(res.status, explain(res.status));
    return { status: res.status, etag: res.headers.get('etag'), json: await res.json() };
  }

  function read(gist) {
    const f = gist && gist.files && gist.files[FILE];
    if (!f) throw new SyncError(404, explain(404));
    if (f.truncated) throw new SyncError(0, 'The sync file has grown too large to read.');
    try { return JSON.parse(f.content) || {}; } catch (err) { return {}; }      // unreadable: start again from this device's copy
  }

  /** Turns sync on for this device: finds the sync file among the token owner's gists, or makes it. */
  async function enable(token) {
    token = String(token || '').trim();
    if (!token) throw new SyncError(0, 'Paste the token first.');
    const was = cfg;
    cfg = { token, id: null };
    try {
      const list = await call('GET', '/gists?per_page=100');
      const have = list.json.find(g => g.files && g.files[FILE]);
      const gist = have || (await call('POST', '/gists', {
        description: 'Eve Ops sync: pins, copied marks and weekly closes shared between devices', public: false,
        files: { [FILE]: { content: JSON.stringify({ v: 1 }) } },
      })).json;
      cfg.id = gist.id;
      E.store.set(KEY, cfg);
      st.etag = null; st.remote = null; st.err = null; st.last = 0;
      return { made: !have };
    } catch (err) { cfg = was; throw err; }
  }
  /** Stops syncing on this device and forgets the token here. The file on GitHub is left alone. */
  function disable() { cfg = null; E.store.del(KEY); st.etag = null; st.remote = null; st.err = null; st.last = 0; }

  /**
   * One round: read the shared copy (cheaply, when it has not changed), join it with this device's, hand the result
   * back through apply() if this device was missing something, and write it up if the shared copy was.
   */
  async function cycle(getLocal, apply, keep) {
    if (!cfg || !cfg.id || st.busy) return false;
    st.busy = true;
    try {
      const r = await call('GET', '/gists/' + cfg.id, null, st.remote ? st.etag : null);
      if (r.status !== 304) { st.remote = read(r.json); st.etag = r.etag; }
      const now = Date.now(), local = getLocal(), merged = L.syncMerge(local, st.remote, now, keep);
      const text = L.stable(merged);
      if (text !== L.stable(L.syncMerge(local, null, now, keep))) apply(merged);
      if (text !== L.stable(L.syncMerge(st.remote, null, now, keep))) {
        await call('PATCH', '/gists/' + cfg.id, { files: { [FILE]: { content: JSON.stringify(merged) } } });
        st.remote = merged; st.etag = null;                 // the next read fetches it whole once, then cheaply again
      }
      st.last = Date.now(); st.err = null;
      return true;
    } catch (err) {
      st.err = err.message || String(err);
      return false;
    } finally { st.busy = false; }
  }

  window.Sync = {
    enable, disable, cycle, file: FILE,
    get on() { return !!(cfg && cfg.id); },
    get state() { return { on: !!(cfg && cfg.id), last: st.last, err: st.err, busy: st.busy }; },
  };
})();
