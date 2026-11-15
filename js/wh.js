/* Eve Ops — wormhole tab: follows a second character through space, builds the chain from their jumps,
   shows each hole's class, effect and statics, recent kills from zKillboard, and the signatures you paste. */
(function () {
  'use strict';
  const C = window.EVEOPS_CONFIG, L = window.Logic, E = window.Esi, DATA = window.WHDATA || { effects: [], systems: {}, holes: {} };
  const demo = !!(window.Demo && window.Demo.on);
  const KEY = 'eveops.wh', NS = 'http://www.w3.org/2000/svg', M = 6e4;
  const W = Object.assign({ systems: {}, links: [], names: {}, last: null, lastAt: 0, home: null }, demo ? null : E.store.get(KEY));
  const S = { loc: null, ship: null, sel: null, kills: new Map(), note: '', repaint: () => {} };
  const save = () => { if (!demo) E.store.set(KEY, W); };
  const isJ = id => id >= 31000000 && id < 32000000;
  const num = n => Number(n).toLocaleString('en-US');
  const who = () => (demo ? { id: 1, name: 'Sample Scout' } : E.who('scout'));

  function el(ns, tag, props, kids) {
    const e = ns ? document.createElementNS(NS, tag) : document.createElement(tag);
    for (const k of Object.keys(props || {})) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else if (k === 'class' && !ns) e.className = v;
      else if (k === 'style') for (const p of Object.keys(v)) e.style.setProperty(p, v[p]); // the page's policy forbids style attributes
      else e.setAttribute(k, v === true ? '' : v);
    }
    const add = x => { if (x == null || x === false) return; if (Array.isArray(x)) x.forEach(add); else e.append(x.nodeType ? x : document.createTextNode(String(x))); };
    kids.forEach(add);
    return e;
  }
  const h = (tag, props, ...kids) => el(false, tag, props, kids);
  const sv = (tag, props, ...kids) => el(true, tag, props, kids);

  // ------------------------------------------------------------------ data
  const CLASS = { A: 'C1', B: 'C2', C: 'C3', D: 'C4', E: 'C5', F: 'C6', G: 'Thera', H: 'C13', K: 'Drifter' };
  /** Static facts about a system, fetched once and kept: name, class, planets with their positions. */
  async function sys(id) {
    const have = W.systems[id];
    if (have && have.planets) return have;
    const r = (await E.get('/universe/systems/' + id + '/')).data;
    const s = W.systems[id] = Object.assign({ id, first: Date.now(), sigs: [], structures: {} }, have, { name: r.name, sec: r.security_status });
    try {
      const con = (await E.get('/universe/constellations/' + r.constellation_id + '/')).data;
      const reg = (await E.get('/universe/regions/' + con.region_id + '/')).data;
      s.cls = isJ(id) ? CLASS[reg.name[0]] || 'W-space' : r.security_status >= 0.45 ? 'High' : r.security_status > 0 ? 'Low' : 'Null';
    } catch (err) { s.cls = isJ(id) ? 'W-space' : 'K-space'; }
    s.planets = await Promise.all((r.planets || []).map(p => E.get('/universe/planets/' + p.planet_id + '/').then(d => (
      { name: d.data.name, x: d.data.position.x, z: d.data.position.z, moons: (p.moons || []).length }), () => null))).then(a => a.filter(Boolean));
    save();
    return s;
  }
  const statics = id => (DATA.systems[id] || [[], -1])[0];
  const effect = id => { const e = (DATA.systems[id] || [[], -1])[1]; return e >= 0 ? DATA.effects[e] : null; };
  const hole = code => { const x = DATA.holes[code]; return x ? { dest: String(x[0]).toUpperCase().replace('HS', 'High').replace('LS', 'Low').replace('NS', 'Null'), life: x[1], mass: x[2], jump: x[3] } : null; };
  /** What the system effect does at this class: [{ name, good, power }]. */
  const fxOf = (id, cls) => {
    const rows = effect(id) && DATA.fx ? DATA.fx[effect(id)] : null, i = /^C[1-6]$/.test(cls || '') ? Number(cls[1]) - 1 : -1;
    return rows ? rows.map(r => ({ name: r[0], good: !!r[1], power: i >= 0 ? r[2][i] : r[2].join(' / ') })) : [];
  };
  const shipFit = kg => (!kg ? '' : kg <= 5e6 ? 'Frigates and destroyers' : kg <= 62e6 ? 'Up to battlecruisers' : kg <= 375e6 ? 'Up to battleships' : kg <= 1e9 ? 'Up to freighters' : 'Capitals fit');
  const staticText = code => { const x = hole(code); return x && x.dest ? code + ' to ' + x.dest + (x.life ? ', ' + x.life + ' h' : '') : code; };

  /** Where the pilot is. A change of system made while the page was watching becomes a link in the chain. */
  async function tick() {
    const me = who();
    if (!me || demo) return false;
    const pair = await Promise.all([E.get('/characters/' + me.id + '/location/', { auth: 'scout' }), E.get('/characters/' + me.id + '/ship/', { auth: 'scout' })]);
    const loc = pair[0].data, id = loc.solar_system_id, prev = W.last, watched = Date.now() - W.lastAt < 2 * M;
    const moved = prev !== id || !S.loc || S.loc.structure_id !== loc.structure_id || S.loc.station_id !== loc.station_id;
    S.loc = loc; S.ship = pair[1].data; W.lastAt = Date.now();
    if (S.ship && !W.names[S.ship.ship_type_id]) await names([S.ship.ship_type_id]).catch(() => {});
    const s = await sys(id);
    if (loc.structure_id && !s.structures[loc.structure_id]) {
      try { const st = (await E.get('/universe/structures/' + loc.structure_id + '/', { auth: 'scout' })).data; s.structures[loc.structure_id] = { name: st.name, x: st.position.x, z: st.position.z }; } catch (err) { /* no docking rights */ }
    }
    if (prev !== id) {
      if (prev && watched && W.systems[prev]) {
        let gate = false;
        if (!isJ(prev) && !isJ(id)) gate = await E.get('/route/' + prev + '/' + id + '/', { query: { flag: 'shortest' } }).then(r => r.data.length === 2, () => false);
        if (!gate && !W.links.some(l => (l.a === prev && l.b === id) || (l.a === id && l.b === prev))) W.links.push({ a: prev, b: id, at: Date.now() });
      }
      s.seen = Date.now(); W.last = id; S.sel = id;
      if (!W.home && isJ(id)) W.home = id;
      loadKills(id);
    }
    save();
    return moved;
  }

  async function names(ids) {
    const need = Array.from(new Set(ids)).filter(x => x && !W.names[x]);
    if (need.length) (await E.post('/universe/names/', need)).forEach(x => { W.names[x.id] = x.name; });
  }
  /** Kills in a system over the last 7 days, newest first, from zKillboard (EVE publishes none for wormhole space). */
  async function loadKills(id) {
    const hit = S.kills.get(id);
    if (demo || (hit && Date.now() - hit.at < 10 * M)) return;
    S.kills.set(id, Object.assign({ list: null, total: 0 }, hit, { at: Date.now(), err: null }));
    try {
      const raw = await (await fetch('https://zkillboard.com/api/kills/systemID/' + id + '/pastSeconds/604800/')).json();
      const mails = (await Promise.all(raw.slice(0, 40).map(k => E.get('/killmails/' + k.killmail_id + '/' + k.zkb.hash + '/').then(x => ({ k, m: x.data }), () => null)))).filter(Boolean);
      const ids = [];
      mails.forEach(x => { ids.push(x.m.victim.ship_type_id, x.m.victim.corporation_id, x.m.victim.alliance_id); const fb = x.m.attackers.find(a => a.final_blow) || {}; ids.push(fb.corporation_id, fb.alliance_id); });
      await names(ids).catch(() => {});
      const hours = new Array(24).fill(0);
      mails.forEach(x => { if (!x.k.zkb.npc) hours[new Date(x.m.killmail_time).getUTCHours()]++; });
      S.kills.set(id, { at: Date.now(), total: raw.length, hours, list: mails.map(x => {
        const fb = x.m.attackers.find(a => a.final_blow) || {};
        return { id: x.k.killmail_id, at: Date.parse(x.m.killmail_time), ship: W.names[x.m.victim.ship_type_id] || 'Ship', victim: W.names[x.m.victim.alliance_id] || W.names[x.m.victim.corporation_id] || 'Unknown',
          by: W.names[fb.alliance_id] || W.names[fb.corporation_id] || (x.k.zkb.npc ? 'NPCs' : 'Unknown'), pilots: x.m.attackers.length, value: x.k.zkb.totalValue || 0, npc: !!x.k.zkb.npc };
      }) });
      save();
    } catch (err) { S.kills.set(id, { at: Date.now(), total: 0, list: null, err: 'zKillboard did not answer.' }); }
    S.repaint();
  }

  function paste(id, text) {
    const rows = L.parseSigs(text), s = W.systems[id];
    if (!s) return;
    if (!rows.length) { S.note = 'No signatures in that paste. Copy from the probe scanner window with Ctrl+A, Ctrl+C.'; return S.repaint(); }
    const old = new Map((s.sigs || []).map(x => [x.id, x])), now = Date.now();
    s.sigs = rows.map(r => Object.assign({ first: now, fresh: old.size > 0 && !old.has(r.id) }, old.get(r.id), r, { fresh: old.size > 0 && !old.has(r.id) }));
    const gone = Array.from(old.keys()).filter(k => !rows.some(r => r.id === k)).length;
    s.pasted = now; save();
    S.note = num(rows.length) + ' read' + (old.size ? ', ' + s.sigs.filter(x => x.fresh).length + ' new, ' + gone + ' gone' : '') + '.';
    S.repaint();
  }

  // --------------------------------------------------------------- drawing
  const TONE = { C1: '#4ecef8', C2: '#60dba3', C3: '#f5ff83', C4: '#dc6d07', C5: '#ce440f', C6: '#bc1117', High: '#2c75e2', Low: '#dc6d07', Null: '#8d3264' };
  const tone = cls => TONE[cls] || '#b28ad6';
  const GROUPS = ['Wormhole', 'Combat Site', 'Data Site', 'Relic Site', 'Gas Site', 'Ore Site', ''];
  const GTONE = { Wormhole: '#b28ad6', 'Combat Site': '#f06a6a', 'Data Site': '#4ecef8', 'Relic Site': '#f2b94b', 'Gas Site': '#60dba3', 'Ore Site': '#c9a27a', '': '#88a2ab' };
  const groupName = g => g || 'Unscanned';
  const ago = t => L.span(Date.now() - t) + ' ago';

  function chainSvg() {
    const ids = Object.keys(W.systems).map(Number);
    const adj = new Map(ids.map(id => [id, []]));
    for (const l of W.links) if (adj.has(l.a) && adj.has(l.b)) { adj.get(l.a).push(l.b); adj.get(l.b).push(l.a); }
    const pos = new Map();
    let row = 0;
    const place = start => {
      const layers = [], seen = new Set([start]), q = [[start, 0]];
      while (q.length) { const cur = q.shift(); (layers[cur[1]] = layers[cur[1]] || []).push(cur[0]); for (const n of adj.get(cur[0])) if (!seen.has(n) && !pos.has(n)) { seen.add(n); q.push([n, cur[1] + 1]); } }
      const tall = Math.max.apply(null, layers.map(a => a.length));
      layers.forEach((a, d) => a.forEach((id, i) => pos.set(id, { x: d, y: row + i + (tall - a.length) / 2 })));
      row += tall;
    };
    const order = ids.slice().sort((a, b) => (a === W.home ? -1 : b === W.home ? 1 : (W.systems[a].first || 0) - (W.systems[b].first || 0)));
    for (const id of order) if (!pos.has(id)) place(id);
    const cols = Math.max.apply(null, [0].concat(Array.from(pos.values()).map(p => p.x))) + 1;
    const X = p => 12 + p.x * 204, Y = p => 12 + p.y * 62;
    const here = S.loc && S.loc.solar_system_id;
    return sv('svg', { class: 'wh-chain', width: cols * 204 + 8, height: Math.max(1, row) * 62 + 12, viewBox: '0 0 ' + (cols * 204 + 8) + ' ' + (Math.max(1, row) * 62 + 12), role: 'img', 'aria-label': 'Chain of connected systems' },
      W.links.filter(l => pos.has(l.a) && pos.has(l.b)).map(l => {
        const a = pos.get(l.a), b = pos.get(l.b), tag = [l.type, l.life === 'eol' ? 'EOL' : '', l.mass === 'crit' ? 'crit' : l.mass === 'half' ? 'reduced' : ''].filter(Boolean).join(' ');
        return [sv('line', { x1: X(a) + 72, y1: Y(a) + 23, x2: X(b) + 72, y2: Y(b) + 23, class: 'wh-link' + (l.life === 'eol' || l.mass === 'crit' ? ' is-warn' : '') }),
          tag ? sv('text', { x: (X(a) + 144 + X(b)) / 2, y: (Y(a) + Y(b)) / 2 + 17, class: 'wh-tag', 'text-anchor': 'middle' }, tag) : null];
      }),
      ids.map(id => {
        const s = W.systems[id], p = pos.get(id), k = S.kills.get(id);
        const tip = s.name + ', ' + (s.cls || '') + (effect(id) ? ', ' + effect(id) : '') + (statics(id).length ? ', statics ' + statics(id).map(staticText).join('; ') : '')
          + ((s.sigs || []).length ? ', ' + s.sigs.length + ' signatures' : '') + (k && k.list ? ', ' + k.total + ' kills in 7 days' : '');
        return sv('g', { class: 'wh-node' + (id === here ? ' is-here' : '') + (id === S.sel ? ' is-sel' : ''), transform: 'translate(' + X(p) + ',' + Y(p) + ')', tabindex: 0, role: 'button',
          onclick: () => { S.sel = id; loadKills(id); S.repaint(); }, onkeydown: e => { if (e.key === 'Enter') { S.sel = id; loadKills(id); S.repaint(); } } },
          sv('title', null, tip),
          sv('rect', { width: 144, height: 46, rx: 3 }),
          sv('rect', { width: 5, height: 46, fill: tone(s.cls) }),
          sv('text', { x: 14, y: 19, class: 'wh-name' }, s.name),
          sv('text', { x: 14, y: 36, class: 'wh-sub' }, (s.cls || '') + (statics(id).length ? '  ' + statics(id).map(c => (hole(c) || {}).dest || c).join(' ') : '') + (id === W.home ? '  home' : '')));
      }));
  }

  function systemSvg(s, readout) {
    const P = (s.planets || []).map(p => Object.assign({ d: Math.hypot(p.x, p.z), a: Math.atan2(p.z, p.x) }, p)).sort((a, b) => a.d - b.d);
    const c = 190, r0 = 30, r1 = 128, lo = P.length ? Math.log(P[0].d) : 0, hi = P.length ? Math.log(P[P.length - 1].d) : 1;
    const rOf = d => (P.length < 2 ? (r0 + r1) / 2 : r0 + (r1 - r0) * Math.max(-0.15, Math.min(1.1, (Math.log(d) - lo) / (hi - lo || 1))));
    const at = (r, a) => [c + r * Math.cos(a), c - r * Math.sin(a)];
    const say = text => ({ tabindex: 0, onmouseenter: () => { readout.textContent = text; }, onfocus: () => { readout.textContent = text; } });
    const sigs = s.sigs || [];
    return sv('svg', { class: 'wh-system', viewBox: '0 0 380 380', role: 'img', 'aria-label': 'Map of ' + s.name },
      P.map(p => sv('circle', { cx: c, cy: c, r: rOf(p.d), class: 'wh-orbit' })),
      sv('circle', { cx: c, cy: c, r: 164, class: 'wh-belt' }),
      sv('circle', Object.assign({ cx: c, cy: c, r: 9, class: 'wh-sun' }, say(s.name + ' sun'))),
      P.map(p => { const q = at(rOf(p.d), p.a); const label = p.name.split(' ').pop();
        return sv('g', Object.assign({ class: 'wh-planet' }, say(p.name + ', ' + (p.d / 1.496e11).toFixed(1) + ' AU from the sun, ' + p.moons + (p.moons === 1 ? ' moon' : ' moons'))),
          sv('circle', { cx: q[0], cy: q[1], r: 5.5 }), sv('text', { x: q[0] + 8, y: q[1] + 4 }, label)); }),
      Object.keys(s.structures || {}).map(k => { const st = s.structures[k], q = at(rOf(Math.hypot(st.x, st.z)), Math.atan2(st.z, st.x));
        const label = st.name.indexOf(' - ') >= 0 ? st.name.slice(st.name.indexOf(' - ') + 3) : st.name;
        return sv('g', Object.assign({ class: 'wh-structure' }, say(st.name + ', ' + (Math.hypot(st.x, st.z) / 1.496e11).toFixed(1) + ' AU from the sun')),
          sv('rect', { x: q[0] - 5, y: q[1] - 5, width: 10, height: 10 }), sv('text', { x: q[0] + 9, y: q[1] + 4 }, label.length > 28 ? label.slice(0, 27) + '\u2026' : label)); }),
      sigs.map((g, i) => { const q = at(164, Math.PI / 2 - (i / sigs.length) * 2 * Math.PI);
        return sv('g', Object.assign({ class: 'wh-sig' }, say(g.id + ', ' + groupName(g.group) + (g.name ? ', ' + g.name : '') + ', first seen ' + ago(g.first) + (g.fresh ? ', new' : '') + '. Position unknown.')),
          sv('circle', { cx: q[0], cy: q[1], r: g.fresh ? 7 : 5.5, fill: GTONE[g.group] || GTONE[''] }), sv('text', { x: q[0], y: q[1] - 9, 'text-anchor': 'middle' }, g.id.slice(0, 3))); }));
  }

  function infoCol(id, s) {
    const fx = fxOf(id, s.cls), st = statics(id), structs = Object.keys(s.structures || {}).map(k => s.structures[k]);
    const moons = (s.planets || []).reduce((n, p) => n + p.moons, 0);
    return h('div', { class: 'wh-info' },
      h('h4', null, 'Effect' + (effect(id) ? ': ' + effect(id) : '')),
      effect(id) ? h('ul', { class: 'wh-fx' }, fx.map(x => h('li', { class: x.good ? 'is-good' : 'is-bad' }, h('span', null, x.name), h('b', null, x.power))))
        : h('p', { class: 'note' }, isJ(id) ? 'None. This system has no wormhole effect.' : 'None. Known space has no wormhole effect.'),
      st.length ? [h('h4', null, 'Statics'), h('ul', { class: 'timers' }, st.map(c => { const x = hole(c) || {};
        return h('li', null, h('span', { class: 't-what' }, c + ' to ' + (x.dest || 'unknown'), h('span', { class: 'sub' }, x.life ? 'lasts ' + x.life + ' h' : '')),
          h('span', { class: 't-when' }, shipFit(x.jump), h('span', { class: 'sub' }, x.mass ? num(x.mass / 1e6) + 'M kg in total' : ''))); }))] : null,
      h('h4', null, 'In this system'),
      h('ul', { class: 'timers' },
        h('li', null, h('span', { class: 't-what' }, 'Planets'), h('span', { class: 't-when' }, (s.planets || []).length + ', with ' + moons + (moons === 1 ? ' moon' : ' moons'))),
        structs.map(x => h('li', null, h('span', { class: 't-what' }, x.name), h('span', { class: 't-when' }, (Math.hypot(x.x, x.z) / 1.496e11).toFixed(1) + ' AU out')))));
  }
  function linkPanel(id) {
    const ls = W.links.filter(l => l.a === id || l.b === id);
    if (!ls.length) return null;
    const pick = (l, key, opts) => h('select', { 'aria-label': key, onchange: e => { l[key] = e.target.value; save(); S.repaint(); } },
      opts.map(o => h('option', { value: o[0], selected: (l[key] || '') === o[0] }, o[1])));
    return h('section', { class: 'panel' }, h('h3', null, 'Connections'), h('ul', { class: 'wh-links' }, ls.map(l => {
      const o = W.systems[l.a === id ? l.b : l.a] || { name: 'Unknown' }, x = hole(l.type), dies = x && x.life ? l.at + x.life * 36e5 : null;
      const types = [['', 'Type unknown'], ['K162', 'K162, exit side']].concat(Array.from(new Set(statics(l.a).concat(statics(l.b)))).map(c => [c, staticText(c)]));
      return h('li', null, h('b', null, 'To ' + o.name + (o.cls ? ' (' + o.cls + ')' : '')),
        h('span', { class: 'sub' }, 'first seen ' + ago(l.at) + (dies ? (dies > Date.now() ? ', gone within ' + L.span(dies - Date.now()) : ', past its lifetime') : '')),
        h('span', { class: 'wh-picks' }, pick(l, 'type', types), pick(l, 'life', [['', 'Lifetime fresh'], ['eol', 'End of life']]), pick(l, 'mass', [['', 'Mass stable'], ['half', 'Mass reduced'], ['crit', 'Mass critical']]),
          h('button', { type: 'button', class: 'btn btn-quiet btn-small', onclick: () => { W.links = W.links.filter(z => z !== l); save(); S.repaint(); } }, 'Remove')));
    })));
  }

  // ------------------------------------------------------------------ view
  function view(repaint, extra) {
    S.repaint = repaint;
    const me = who();
    if (!me) {
      return h('main', { class: 'door' }, h('h1', null, 'Wormholes'),
        h('p', { class: 'lede' }, 'Sign in the character that flies the holes. The page follows where they are and builds the chain from their jumps.'),
        h('button', { type: 'button', class: 'btn btn-big', onclick: e => { if (!E.native) e.currentTarget.disabled = true; E.login('scout'); } }, 'Log in the wormhole pilot'),
        h('p', { class: 'small' }, 'This is a second sign-in beside the trading character. Read-only, kept in this browser.'));
    }
    const here = S.loc && S.loc.solar_system_id, cur = W.systems[here], id = S.sel && W.systems[S.sel] ? S.sel : here, s = W.systems[id];
    const whereTxt = !cur ? 'Finding ' + me.name + '.' : (S.loc.structure_id || S.loc.station_id ? 'Docked in ' : 'In space in ') + cur.name + (cur.cls ? ' (' + cur.cls + ')' : '') + (S.ship ? ', flying ' + (W.names[S.ship.ship_type_id] || 'a ship') + (S.ship.ship_name ? ' "' + L.shipName(S.ship.ship_name) + '"' : '') : '');
    const head = h('header', { class: 'wh-head' }, h('h2', null, me.name), h('p', null, whereTxt),
      h('span', { class: 'tools' },
        s && isJ(id) && id !== W.home ? h('button', { type: 'button', class: 'btn btn-quiet btn-small', onclick: () => { W.home = id; save(); repaint(); } }, 'Make ' + s.name + ' home') : null,
        W.links.length || Object.keys(W.systems).length > 1 ? h('button', { type: 'button', class: 'btn btn-quiet btn-small', onclick: () => { const keep = {}; if (cur) keep[here] = cur; if (W.home && W.systems[W.home]) keep[W.home] = W.systems[W.home]; W.systems = keep; W.links = []; save(); repaint(); } }, 'Clear the chain') : null,
        demo ? null : h('button', { type: 'button', class: 'btn btn-quiet btn-small', onclick: () => { E.signOut('scout'); repaint(); } }, 'Sign this pilot out')));
    if (!s) return h('main', { class: 'board' }, h('div', { class: 'stops' }, head, h('p', { class: 'empty' }, 'Waiting for the first location reading.')));
    const k = S.kills.get(id), sigs = s.sigs || [], readout = h('p', { class: 'wh-readout' }, 'Hover or tab to a planet, structure or signature.');
    const counts = GROUPS.map(g => [g, sigs.filter(x => (GROUPS.indexOf(x.group) >= 0 ? x.group : '') === g).length]).filter(x => x[1]);
    return h('main', { class: 'board' },
      h('div', { class: 'stops' }, head,
        h('section', { class: 'wh-block' }, h('h3', null, 'Chain'), Object.keys(W.systems).length ? chainSvg() : null,
          h('p', { class: 'note' }, 'A system is added each time ' + me.name + ' jumps while this page is open. Jumps through stargates are not drawn. Select a system to see it below and at right.')),
        h('section', { class: 'wh-block' }, h('h3', null, s.name + ', system map'), h('div', { class: 'wh-split' }, h('div', { class: 'wh-map' }, systemSvg(s, readout), readout), infoCol(id, s)),
          h('p', { class: 'note' }, 'Planets and any structure this pilot has docked in sit at their true bearing from the sun, with distances compressed. Signatures are on the outer ring in the order pasted: EVE gives no position for them.')), extra || null),
      h('aside', { class: 'side' },
        h('section', { class: 'panel' }, h('h3', null, s.name),
          h('dl', { class: 'facts' },
            h('div', { class: 'fact' }, h('dt', null, 'Class'), h('dd', null, s.cls || '')),
            h('div', { class: 'fact' }, h('dt', null, 'Effect'), h('dd', null, effect(id) || 'None')),
            statics(id).length ? h('div', { class: 'fact' }, h('dt', null, 'Statics'), h('dd', null, statics(id).map(c => h('span', { class: 'sub-line' }, staticText(c))))) : null,
            h('div', { class: 'fact' }, h('dt', null, 'Planets'), h('dd', null, (s.planets || []).length)),
            s.seen ? h('div', { class: 'fact' }, h('dt', null, 'Last here'), h('dd', null, ago(s.seen))) : null)),
        linkPanel(id),
        h('section', { class: 'panel' }, h('h3', null, 'Kills, last 7 days'),
          !k ? h('p', { class: 'note' }, 'Not loaded yet.') : k.err ? h('p', { class: 'note' }, k.err) : !k.list ? h('p', { class: 'note' }, 'Loading from zKillboard.')
            : !k.list.length ? h('p', { class: 'note' }, 'None on zKillboard.')
            : [h('p', { class: 'wh-killsum' }, (k.total >= 200 ? '200 or more' : num(k.total)) + (k.total === 1 ? ' kill' : ' kills') + ', ' + k.list.filter(x => Date.now() - x.at < 864e5).length + (k.list.length < k.total ? ' or more' : '') + ' in the last 24 h'),
              h('ul', { class: 'feed' }, k.list.slice(0, 8).map(x => h('li', { class: x.npc ? 'tone-calm' : 'tone-bad' },
                h('span', null, x.ship + ' of ' + x.victim), h('span', { class: 'sub' }, ago(x.at) + ', lost to ' + (x.npc ? 'NPCs' : x.pilots + (x.pilots === 1 ? ' pilot' : ' pilots') + ' (' + x.by + ')') + ', ' + L.short(x.value)))))],
          k && k.hours && k.list && k.list.length ? [h('div', { class: 'bars wh-hours', role: 'list', 'aria-label': 'Player kills by hour of day, EVE time' }, k.hours.map((n, hr) =>
            h('span', { class: 'bar', role: 'listitem', tabindex: 0, 'aria-label': hr + ':00, ' + n + ' kills' }, h('span', { class: 'tip' }, h('b', null, String(hr).padStart(2, '0') + ':00 EVE time'), h('span', null, n + (n === 1 ? ' kill' : ' kills'))),
              h('span', { class: 'col' }, h('i', { style: { height: Math.max(2, Math.round(n / Math.max(1, Math.max.apply(null, k.hours)) * 100)) + '%' } })), h('span', { class: 'day' }, hr % 6 === 0 ? String(hr).padStart(2, '0') : '')))),
            h('p', { class: 'note' }, 'Player kills by hour of day, EVE time, from the newest ' + k.list.length + '.')] : null,
          h('p', { class: 'note' }, 'From zKillboard, which can run hours behind. EVE publishes no kill data for wormhole space.')),
        h('section', { class: 'panel' }, h('h3', null, 'Signatures in ' + s.name),
          counts.length ? h('ul', { class: 'wh-counts' }, counts.map(x => h('li', null, h('i', { style: { background: GTONE[x[0]] } }), x[1] + ' ' + groupName(x[0])))) : null,
          h('textarea', { class: 'wh-paste', rows: 3, placeholder: 'Paste the probe scanner window here (Ctrl+A, Ctrl+C in game)', 'aria-label': 'Paste signatures for ' + s.name,
            onpaste: e => { const t = (e.clipboardData || window.clipboardData).getData('text'); e.preventDefault(); paste(id, t); } }),
          S.note ? h('p', { class: 'note' }, S.note) : null,
          sigs.length ? h('ul', { class: 'timers' }, sigs.map(x => h('li', null,
            h('span', { class: 't-what' }, x.id + ' ' + groupName(x.group), h('span', { class: 'sub' }, x.name || 'not scanned down')),
            h('span', { class: 't-when' }, x.fresh ? 'New' : '', h('span', { class: 'sub' }, 'seen ' + ago(x.first))))))
            : h('p', { class: 'note' }, 'Nothing pasted for this system yet.'),
          s.pasted ? h('p', { class: 'note' }, 'Last paste ' + ago(s.pasted) + '.') : null)));
  }

  if (demo) { // sample chain so the tab can be looked at without a sign-in
    const P = (n, au, deg, moons) => ({ name: 'J111613 ' + n, x: au * 1.496e11 * Math.cos(deg * Math.PI / 180), z: au * 1.496e11 * Math.sin(deg * Math.PI / 180), moons });
    const t = Date.now();
    W.systems = {
      31002318: { id: 31002318, name: 'J111613', cls: 'C3', first: t - 9e6, seen: t - 6e5, structures: { 1: { name: 'J111613 - Sample Fortizar', x: 4.1e11, z: -2.2e11 } },
        planets: [P('I', 0.4, 20, 0), P('II', 0.9, 140, 1), P('III', 1.8, 250, 2), P('IV', 4.2, 310, 9), P('V', 9.5, 70, 14), P('VI', 21, 190, 6)],
        pasted: t - 12e5, sigs: L.parseSigs('ABC-123\tCosmic Signature\tWormhole\tUnstable Wormhole\nDEF-456\tCosmic Signature\tGas Site\tBarren Perimeter Reservoir\nGHI-789\tCosmic Signature\tRelic Site\tForgotten Perimeter Coronation Platform\nJKL-012\tCosmic Signature\t\t\nMNO-345\tCosmic Anomaly\tOre Site\tOrdinary Perimeter Deposit\nPQR-678\tCosmic Anomaly\tCombat Site\tFortification Frontier Stronghold').map((x, i) => Object.assign(x, { first: t - (i + 1) * 9e5, fresh: i === 3 })) },
      30002053: { id: 30002053, name: 'Hek', cls: 'High', first: t - 8e6, seen: t - 5e6, planets: [], sigs: [], structures: {} },
      30002718: { id: 30002718, name: 'Rancer', cls: 'Low', first: t - 7e6, seen: t - 4e6, planets: [], sigs: [], structures: {} },
    };
    W.links = [{ a: 31002318, b: 30002053, at: t - 5 * 36e5, type: 'E175', life: 'eol' }, { a: 31002318, b: 30002718, at: t - 36e5 }];
    W.home = 31002318; W.names = { 11188: 'Stratios' };
    S.loc = { solar_system_id: 31002318, structure_id: 1 }; S.ship = { ship_type_id: 11188, ship_name: 'Deep Dive' }; S.sel = 31002318;
    S.kills.set(31002318, { at: t, total: 3, hours: [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 4, 3, 1, 0, 0], list: [
      { at: t - 3 * 36e5, ship: 'Heron', victim: 'Sample Explorers', by: 'Sample Hunters', pilots: 2, value: 41e6, npc: false },
      { at: t - 30 * 36e5, ship: 'Venture', victim: 'Sample Miners', by: 'Sample Hunters', pilots: 1, value: 4.2e6, npc: false },
      { at: t - 70 * 36e5, ship: 'Drake', victim: 'Sample Ratters', by: 'NPCs', pilots: 3, value: 96e6, npc: true }] });
  }

  /** A few lines about where the pilot is now, for the Android app's widget. */
  function summary() {
    const me = who();
    if (!me || !S.loc) return null;
    const id = S.loc.solar_system_id, s = W.systems[id];
    if (!s) return null;
    const k = S.kills.get(id), docked = S.loc.structure_id || S.loc.station_id;
    return {
      pilot: me.name, system: s.name, cls: s.cls || '', effect: effect(id) || '', statics: statics(id).map(staticText),
      docked: !!docked, place: S.loc.structure_id && s.structures && s.structures[S.loc.structure_id] ? s.structures[S.loc.structure_id].name : '',
      ship: S.ship ? W.names[S.ship.ship_type_id] || '' : '', shipName: S.ship ? L.shipName(S.ship.ship_name) : '',
      kills: k && k.list ? { week: k.total, day: k.list.filter(x => Date.now() - x.at < 864e5).length, last: k.list.length ? k.list[0].at : 0 } : null,
      sigs: (s.sigs || []).length, links: W.links.length, at: demo ? Date.now() : W.lastAt,
    };
  }

  window.Wh = { view, tick, summary, signedIn: () => !!who() };
})();
