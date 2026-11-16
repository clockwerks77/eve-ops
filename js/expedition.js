/* Eve Ops — Expedition ops. Phase A: Muster (who is coming and what they can fly) and Kit & Shopping
   (the standard four-hull kit, the fits, camp stock, the shopping list, the Night 0 checklist).
   Phase B: the Camp board (status, where we left off, hole board, timers and the picket rotation),
   windows and the session log. The Android app rings the timers; this page tells it what to ring for.
   One operator, no network needed: everything is kept on this device and can be exported.
   Adam flies two characters on one account, so he is one seat with two modes, never two pilots.
   The entities follow the module's spec (Pilot, CanFly, KitItem, Checklist; Camp, Window, Timer, Bank,
   LootEvent is kept empty here for the phase that fills it). */
(function () {
  'use strict';
  const C = window.EVEOPS_CONFIG, L = window.Logic, E = window.Esi, X = C.expedition;
  const demo = !!(window.Demo && window.Demo.on);
  const KEY = demo ? 'eveops.expedition.demo' : 'eveops.expedition';
  const U = { tab: null, open: null, fit: null, draft: '', io: null, ioText: '', note: '', drop: null, gas: '', hole: '',
    camp: { system_name: '', system_class: 'C2', statics: '', stage_type: 'nomad' }, win: { type: X.windows[0].key, present: null, order: null, interval: X.timers.picket_min } };
  let repaint = () => {};
  const uid = p => p + Math.random().toString(36).slice(2, 9);
  const num = n => Number(n).toLocaleString('en-US');
  const plural = (n, one, many) => num(n) + ' ' + (n === 1 ? one : many || one + 's');
  const KIT = X.kit.map(k => k.key);

  function h(tag, props) {
    const e = document.createElement(tag);
    for (const k of Object.keys(props || {})) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else if (k === 'class') e.className = v;
      else if (k === 'value' && tag === 'textarea') e.value = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    const add = x => { if (x == null || x === false) return; if (Array.isArray(x)) x.forEach(add); else e.append(x.nodeType ? x : document.createTextNode(String(x))); };
    for (let i = 2; i < arguments.length; i++) add(arguments[i]);
    return e;
  }

  // ------------------------------------------------------------------ data
  function blankPilot() {
    return { id: uid('p'), display_name: '', character_name: '', is_adam: false, adam_mode_capabilities: null, sp_approx: null, omega: null,
      timezone_note: '', loss_tolerance: { mode: null, pot_cap: null, note: '' }, will_train: null, stage_pref: null, fly_asked: false };
  }
  function fresh() {
    const caps = {};
    X.modes.forEach(m => { caps[m.key] = { note: m.note, can_fly: {} }; m.can.forEach(k => { caps[m.key].can_fly[k] = true; }); });
    const adam = Object.assign(blankPilot(), { id: 'adam', display_name: 'Adam', character_name: X.modes.map(m => m.name).join(' / '), is_adam: true, adam_mode_capabilities: caps, omega: true, fly_asked: true });
    const hulls = {};
    X.kit.forEach(k => { hulls[k.key] = { buy_at: X.places[0], eft: '' }; });
    return {
      v: 1, adam_mode: X.modes[0].key, pilots: [adam, blankPilot(), blankPilot(), blankPilot()], can_fly: [], kit: [], seats: { m1: null, m2: null, m3: null }, hulls,
      stock: X.stock.map(s => Object.assign({ id: uid('s'), have: 0, buy_at: X.places[0] }, s)),
      checklists: [{ id: 'night0', camp_id: null, kind: 'night0', items: X.night0.map(label => ({ label, checked: false, checked_at: null })) }],
      camps: [], windows: [], timers: [], banks: [], loot_events: [], window_records: [],
    };
  }
  /** Sample data's crew: invented people, so the screens can be looked over without typing anything. */
  function sample() {
    const d = fresh(), p = d.pilots;
    Object.assign(p[1], { display_name: 'Rook', character_name: 'Rook Vance', sp_approx: 12e6, omega: true, timezone_note: 'Fri and Sat nights, Eastern', will_train: 'yes', stage_pref: 'either', fly_asked: true, loss_tolerance: { mode: 'own', pot_cap: null, note: '' } });
    Object.assign(p[2], { display_name: 'Finch', character_name: 'Finch Arden', sp_approx: 3.2e6, omega: false, fly_asked: true, will_train: 'maybe' });
    ['gas', 'barge', 'ratter', 'scan'].forEach(k => d.can_fly.push({ pilot_id: p[1].id, hull_key: k, can_fly: true }));
    d.can_fly.push({ pilot_id: p[2].id, hull_key: 'ratter', can_fly: true });
    d.kit.push({ pilot_id: p[1].id, hull_key: 'prospect', status: 'owned' }, { pilot_id: p[1].id, hull_key: 'procurer', status: 'owned' }, { pilot_id: 'adam', hull_key: 'praxis', status: 'staged' });
    Object.assign(p[3], { display_name: 'Wick', character_name: 'Wick Dorne', sp_approx: 6.5e6, omega: true, fly_asked: true });
    d.seats = { m1: p[1].id, m2: p[2].id, m3: p[3].id };
    // a camp in its second night, with a mining window running
    const now = Date.now(), HR = 3600000, me = p[0].id, a = p[1].id, b = p[2].id, c3 = p[3].id;
    d.checklists[0].camp_id = 'c-sample';
    d.checklists[0].items.forEach(i => { i.checked = true; i.checked_at = now - 31 * HR; });
    d.camps.push({ id: 'c-sample', system_name: 'J211405', system_class: 'C2', statics: 'highsec, C3', stage_type: 'nomad', start_date: now - 32 * HR, status: 'active',
      nights: [{ n: 1, started_at: now - 26 * HR, ended_at: now - 22.5 * HR }, { n: 2, started_at: now - 1.2 * HR, ended_at: null }],
      holes: [{ id: 'h-1', destination: 'highsec static', state: 'fresh', eol_at: null, picketed: false, bookmarked: true }, { id: 'h-2', destination: 'C3 static', state: 'unstable', eol_at: now - 2.6 * HR, picketed: true, bookmarked: true }] });
    d.windows.push(
      { id: 'w-1', camp_id: 'c-sample', night: 1, type: 'mining', start: now - 25.8 * HR, end: now - 24.3 * HR, pilot_ids: [me, a, b, c3], adam_mode: 'todashi', note: '', pickets: [{ pilot_id: a, from: now - 25.8 * HR, to: now - 25.05 * HR }, { pilot_id: b, from: now - 25.05 * HR, to: now - 24.3 * HR }] },
      { id: 'w-2', camp_id: 'c-sample', night: 1, type: 'ratting', start: now - 24.1 * HR, end: now - 22.7 * HR, pilot_ids: [me, a, b], adam_mode: 'khiana', note: 'Rolled the C3 twice. Hunter on the chain, stood down early.', pickets: [] },
      { id: 'w-3', camp_id: 'c-sample', night: 2, type: 'mining', start: now - 20 * 60000, end: null, pilot_ids: [me, a, b, c3], adam_mode: 'todashi', note: '', pickets: [] });
    d.window_records.push({ window_id: 'w-1', camp_id: 'c-sample', type: 'mining', start: now - 25.8 * HR, end: now - 24.3 * HR, pilot_ids_present: [me, a, b, c3], adam_mode: 'todashi' },
      { window_id: 'w-2', camp_id: 'c-sample', type: 'ratting', start: now - 24.1 * HR, end: now - 22.7 * HR, pilot_ids_present: [me, a, b], adam_mode: 'khiana' });
    d.timers.push({ id: 't-win', camp_id: 'c-sample', kind: 'window', label: 'Mining window', ends_at: null, rotation_order: [], started_at: now - 20 * 60000, window_id: 'w-3' },
      { id: 't-picket', camp_id: 'c-sample', kind: 'picket', label: 'Picket rotation', ends_at: now + 25 * 60000, rotation_order: [a, b, c3], started_at: now - 20 * 60000, since: now - 20 * 60000, turn: 0, interval_min: 45, acked: null, window_id: 'w-3' },
      { id: 't-eol', camp_id: 'c-sample', kind: 'eol', label: 'C3 static', ends_at: now + 1.4 * HR, rotation_order: [], hole_id: 'h-2' });
    d.adam_mode = 'todashi';
    d.sample_at = now;
    return d;
  }
  /** Whatever was stored (or imported), with anything missing filled in, so older exports keep working. */
  function normal(d) {
    const f = fresh();
    if (!d || d.v !== 1 || !Array.isArray(d.pilots)) return null;
    const out = Object.assign(f, d);
    out.pilots = d.pilots.map(p => { const q = Object.assign(blankPilot(), p); q.loss_tolerance = Object.assign({ mode: null, pot_cap: null, note: '' }, p.loss_tolerance); return q; });
    if (!out.pilots.some(p => p.is_adam)) out.pilots.unshift(fresh().pilots[0]);
    out.hulls = Object.assign({}, fresh().hulls, d.hulls);
    out.seats = Object.assign({ m1: null, m2: null, m3: null }, d.seats);
    if (!X.modes.some(m => m.key === out.adam_mode)) out.adam_mode = X.modes[0].key;
    if (!(out.checklists || []).some(c => c.kind === 'night0')) out.checklists = (out.checklists || []).concat(fresh().checklists);
    for (const k of ['camps', 'windows', 'timers', 'banks', 'loot_events', 'window_records']) if (!Array.isArray(out[k])) out[k] = [];
    out.camps.forEach(c => { c.nights = c.nights || []; c.holes = c.holes || []; });
    out.windows.forEach(w => { w.pickets = w.pickets || []; w.pilot_ids = w.pilot_ids || []; });
    return out;
  }
  let D = normal(E.store.get(KEY)) || (demo ? sample() : fresh());
  if (demo && (!D.sample_at || Date.now() - D.sample_at > 6 * 3600000)) D = sample();          // the sample camp is always "tonight"
  const save = () => { E.store.set(KEY, D); push(); repaint(); };

  const adam = () => D.pilots.find(p => p.is_adam);
  const mode = () => X.modes.find(m => m.key === D.adam_mode);
  const label = p => p.display_name || 'Pilot ' + (D.pilots.indexOf(p) + 1);
  /** Can this pilot fly it? For Adam: can either of his characters (one seat, whichever mode he is in). */
  const canFly = (p, key) => (p.is_adam ? X.modes.some(m => !!p.adam_mode_capabilities[m.key].can_fly[key]) : D.can_fly.some(r => r.pilot_id === p.id && r.hull_key === key && r.can_fly));
  function setFly(p, key, on) {
    D.can_fly = D.can_fly.filter(r => !(r.pilot_id === p.id && r.hull_key === key));
    D.can_fly.push({ pilot_id: p.id, hull_key: key, can_fly: on });
    p.fly_asked = true;
    save();
  }
  const kitRow = (p, key) => D.kit.find(r => r.pilot_id === p.id && r.hull_key === key);
  function setKit(p, key, status) {
    D.kit = D.kit.filter(r => !(r.pilot_id === p.id && r.hull_key === key));
    D.kit.push({ pilot_id: p.id, hull_key: key, status });
    save();
  }
  /** The six muster questions, and whether each has an answer yet. */
  const questions = p => [
    { n: 1, q: 'Who they are', done: !!p.display_name && !!p.character_name && p.omega != null },
    { n: 2, q: 'Ships they can fly', done: !!p.fly_asked },
    { n: 3, q: 'Will train an assigned seat', done: p.will_train != null },
    { n: 4, q: 'Corp home or nomad', done: p.stage_pref != null },
    { n: 5, q: 'Which nights', done: !!p.timezone_note },
    { n: 6, q: 'Loss tolerance', done: p.loss_tolerance.mode != null },
  ];
  function trainText(p, sp) {
    if (sp == null) return '';
    const days = L.trainDays(sp, p.omega === false ? X.spPerHour.alpha : X.spPerHour.omega);
    const span = days < 0.2 ? 'under a day of training' : 'about ' + plural(Math.max(1, Math.round(days)), 'day') + ' of training from nothing';
    return ', ' + span + (p.omega == null && days >= 0.2 ? ' as an Omega (double as an Alpha)' : p.omega === false && days >= 0.2 ? ' as an Alpha' : '');
  }
  /** What stands between this pilot and the standard kit, in plain words. */
  function gaps(p) {
    if (!p.is_adam && !p.fly_asked) return [label(p) + ': ships not asked yet.'];
    return X.needs.filter(n => !canFly(p, n.key)).map(n => label(p) + ': ' + n.lack + '. ' + n.fix.charAt(0).toUpperCase() + n.fix.slice(1) + trainText(p, n.sp) + '.');
  }
  const ready = p => L.kitReady(p.id, D.kit, KIT);
  const hulls = () => X.kit.map(k => { const fit = L.parseEft(D.hulls[k.key].eft); return { key: k.key, label: k.label, role: k.role, ship: fit ? fit.ship : k.ship, buy_at: D.hulls[k.key].buy_at, items: fit ? fit.items : [], fit }; });
  const shopping = () => L.shoppingList({ pilots: D.pilots.map(p => p.id), kit: D.kit, hulls: hulls(), stock: D.stock });

  // ----------------------------------------------------------------- parts
  const seg = (name, options, value, pick) => h('span', { class: 'seg', role: 'group', 'aria-label': name }, options.map(o =>
    h('button', { type: 'button', class: 'seg-b' + (o[0] === value ? ' is-on' : ''), 'aria-pressed': o[0] === value ? 'true' : 'false', onclick: () => pick(o[0]) }, o[1])));
  const text = (keep, value, name, apply, more) => h('input', Object.assign({ class: 'ex-in', type: 'text', 'data-keep': keep, 'aria-label': name, value: value == null ? '' : String(value),
    onchange: e => { apply(e.target.value.trim()); save(); }, onkeydown: e => { if (e.key === 'Enter') e.target.blur(); } }, more));
  const meter = r => h('span', { class: 'meter', role: 'img', 'aria-label': r.pct + '% of the kit' }, h('i', { class: 'w' + Math.round(r.pct / 25) * 25 }));
  function copyText(btn, value) {
    const done = () => { btn.classList.add('is-copied'); setTimeout(() => btn.classList.remove('is-copied'), 1400); };
    if (E.native) { E.tell('copy', { text: value }); return done(); }
    if (navigator.clipboard) navigator.clipboard.writeText(value).then(done, () => {});
  }

  // ---------------------------------------------------------------- muster
  function seatsView() {
    const me = adam(), m = mode(), off = X.modes.filter(x => x !== m);
    const others = D.pilots.filter(p => !p.is_adam);
    const seat = (key, n) => h('div', { class: 'seat' }, h('span', { class: 'seat-role' }, 'Miner and ratter ' + n),
      h('select', { class: 'ex-in', 'aria-label': 'Pilot for miner and ratter seat ' + n, onchange: e => { D.seats[key] = e.target.value || null; save(); } },
        h('option', { value: '', selected: !D.seats[key] }, 'Not assigned'),
        others.filter(p => p.id === D.seats[key] || !Object.keys(D.seats).some(k => D.seats[k] === p.id)).map(p => h('option', { value: p.id, selected: p.id === D.seats[key] }, label(p)))));
    return h('section', { class: 'block ex-block' },
      h('div', { class: 'block-head' }, h('h3', null, 'Seats'), h('span', { class: 'why' }, 'four pilots, four seats')),
      h('div', { class: 'seats' },
        h('div', { class: 'seat seat-adam' },
          h('span', { class: 'seat-role' }, m.role),
          h('span', { class: 'seat-who' }, label(me) + ', flying ', h('b', null, m.name), ' in the ' + m.hull),
          seg('Adam’s mode', X.modes.map(x => [x.key, x.name.split(' ')[0] + '-mode']), D.adam_mode, setMode),
          h('span', { class: 'sub' }, off.map(x => x.name + ' and the ' + x.hull).join(', ') + ' stay logged off: one account, one character at a time.')),
        seat('m1', 1), seat('m2', 2), seat('m3', 3)),
      h('p', { class: 'note' }, 'The picket is one of the miner and ratter seats in turn, and earns the same share. The rotation order is set when a window starts, on the Camp board.'));
  }

  function editor(p) {
    const q = questions(p), Q = (n, body) => h('div', { class: 'q' + (q[n - 1].done ? ' is-done' : '') }, h('h5', null, h('span', { class: 'q-n' }, n), q[n - 1].q), body);
    const kp = k => p.id + ':' + k;
    if (p.is_adam) {
      return h('div', { class: 'pedit' }, X.modes.map(m => { const cap = p.adam_mode_capabilities[m.key];
        return h('div', { class: 'q is-done' }, h('h5', null, m.name.split(' ')[0] + '-mode: ' + m.role + ', ' + m.hull),
          h('div', { class: 'checks' }, X.canFly.map(c => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!cap.can_fly[c.key], onchange: e => { cap.can_fly[c.key] = e.target.checked; save(); } }), h('span', null, c.long)))),
          h('label', { class: 'ex-field' }, 'Note ', text(kp('note-' + m.key), cap.note, m.name + ' note', v => { cap.note = v; }, { class: 'ex-in ex-wide' }))); }));
    }
    return h('div', { class: 'pedit' },
      Q(1, [h('label', { class: 'ex-field' }, 'Real name ', text(kp('name'), p.display_name, 'Real name', v => { p.display_name = v; })),
        h('label', { class: 'ex-field' }, 'Character ', text(kp('char'), p.character_name, 'Character name', v => { p.character_name = v; })),
        h('label', { class: 'ex-field' }, 'Skill points, roughly ', text(kp('sp'), p.sp_approx == null ? '' : L.short(p.sp_approx), 'Skill points', v => { p.sp_approx = v === '' ? null : L.parseIsk(v); }, { placeholder: 'e.g. 12M' })),
        h('span', { class: 'ex-field' }, 'Clone ', seg('Clone', [[true, 'Omega'], [false, 'Alpha']], p.omega, v => { p.omega = v; save(); }))]),
      Q(2, [h('div', { class: 'checks' }, X.canFly.map(c => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: canFly(p, c.key), onchange: e => setFly(p, c.key, e.target.checked) }), h('span', null, c.long)))),
        !p.fly_asked ? h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { p.fly_asked = true; save(); } }, 'None of these yet') : null]),
      Q(3, [h('p', { class: 'q-ask' }, 'Willing to train an assigned seat for two to four weeks?'), seg('Will train', [['yes', 'Yes'], ['maybe', 'Maybe'], ['no', 'No']], p.will_train, v => { p.will_train = v; save(); })]),
      Q(4, [h('p', { class: 'q-ask' }, 'Happy to stage from the corp home, J142117, or the nomad camp only?'), seg('Stage', [['either', 'Either'], ['nomad', 'Nomad only'], ['home', 'J142117 only']], p.stage_pref, v => { p.stage_pref = v; save(); })]),
      Q(5, [h('label', { class: 'ex-field' }, 'Nights and time zone ', text(kp('nights'), p.timezone_note, 'Nights and time zone', v => { p.timezone_note = v; }, { class: 'ex-in ex-wide', placeholder: 'e.g. Fri and Sat, Eastern' }))]),
      Q(6, [seg('Losses', [['own', 'Own rebuys'], ['pot', 'Shared SRP pot']], p.loss_tolerance.mode, v => { p.loss_tolerance.mode = v; save(); }),
        p.loss_tolerance.mode === 'pot' ? h('label', { class: 'ex-field' }, 'Pot cap ', text(kp('cap'), p.loss_tolerance.pot_cap == null ? '' : L.short(p.loss_tolerance.pot_cap), 'Pot cap in ISK', v => { p.loss_tolerance.pot_cap = v === '' ? null : L.parseIsk(v); }, { placeholder: 'e.g. 500M' })) : null,
        h('label', { class: 'ex-field' }, 'Note ', text(kp('loss'), p.loss_tolerance.note, 'Loss note', v => { p.loss_tolerance.note = v; }, { class: 'ex-in ex-wide' }))]),
      h('div', { class: 'tools' }, U.drop === p.id
        ? [h('span', { class: 'neg' }, 'Remove ' + label(p) + ' and their answers?'),
          h('button', { type: 'button', class: 'btn', onclick: () => { D.pilots = D.pilots.filter(x => x !== p); D.can_fly = D.can_fly.filter(r => r.pilot_id !== p.id); D.kit = D.kit.filter(r => r.pilot_id !== p.id); Object.keys(D.seats).forEach(k => { if (D.seats[k] === p.id) D.seats[k] = null; }); U.drop = U.open = null; save(); } }, 'Remove'),
          h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { U.drop = null; repaint(); } }, 'Keep')]
        : h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { U.drop = p.id; repaint(); } }, 'Remove this pilot')));
  }

  function pilotCard(p) {
    const r = ready(p), q = questions(p), open = U.open === p.id, m = mode(), g = gaps(p);
    return h('article', { class: 'pcard' + (open ? ' is-open' : ''), 'data-pilot': p.id },
      h('header', { class: 'pcard-head' },
        h('h4', null, label(p), !p.display_name ? h('span', { class: 'sub' }, 'not named yet') : null),
        p.is_adam ? h('span', { class: 'chip chip-lead' }, m.name.split(' ')[0] + '-mode') : p.omega == null ? null : h('span', { class: 'chip ' + (p.omega ? 'chip-lead' : 'chip-hold') }, p.omega ? 'Omega' : 'Alpha'),
        !p.is_adam && p.sp_approx != null ? h('span', { class: 'chip chip-hold' }, L.short(p.sp_approx) + ' SP') : null),
      h('p', { class: 'pcard-who' }, p.is_adam ? ['One seat, two characters: ', h('b', null, m.name), ' now; ', X.modes.filter(x => x !== m).map(x => x.name).join(', '), ' logged off.'] : p.character_name || 'Character not known yet'),
      h('p', { class: 'pcard-ready' }, meter(r), h('b', null, r.pct + '%'), ' of the kit, ' + r.have + ' of ' + r.total + ' hulls',
        p.is_adam ? null : h('span', { class: 'pcard-q' + (q.every(x => x.done) ? ' is-done' : '') }, q.filter(x => x.done).length + ' of 6 questions answered')),
      g.length ? h('ul', { class: 'gaps' }, g.map(t => h('li', null, t))) : h('p', { class: 'gaps-none' }, 'Can fly the whole standard kit.'),
      h('button', { type: 'button', class: 'btn btn-quiet', 'aria-expanded': open ? 'true' : 'false', onclick: () => { U.open = open ? null : p.id; U.drop = null; repaint(); } }, open ? 'Close' : p.is_adam ? 'What each character can fly' : 'Muster questions'),
      open ? editor(p) : null);
  }

  function matrix() {
    return h('section', { class: 'block ex-block' },
      h('div', { class: 'block-head' }, h('h3', null, 'Can fly'), h('span', { class: 'why' }, 'tick straight in the table')),
      h('div', { class: 'pi-scroll' }, h('table', { class: 'pi-table ex-matrix' },
        h('thead', null, h('tr', null, h('th', { class: 'l' }, 'Pilot'), X.canFly.map(c => h('th', { title: c.long }, c.label)))),
        h('tbody', null, D.pilots.map(p => h('tr', null, h('td', { class: 'l' }, label(p)),
          X.canFly.map(c => h('td', null, p.is_adam
            ? (() => { const who = X.modes.filter(m => p.adam_mode_capabilities[m.key].can_fly[c.key]).map(m => m.name.split(' ')[0]); return who.length ? h('span', { class: 'best' }, who.join(', ')) : h('span', { class: 'sub' }, 'no'); })()
            : h('input', { type: 'checkbox', 'aria-label': label(p) + ': ' + c.long, checked: canFly(p, c.key), onchange: e => setFly(p, c.key, e.target.checked) })))))))),
      h('p', { class: 'note' }, X.canFly.map(c => c.label + ': ' + c.long.charAt(0).toLowerCase() + c.long.slice(1)).join('. ') + '. Adam’s row names which of his characters can; change it on his card.'));
  }

  function musterView() {
    const crew = D.pilots.filter(p => !p.is_adam), asked = crew.reduce((n, p) => n + questions(p).filter(x => x.done).length, 0), all = crew.length * 6;
    const kitAll = D.pilots.reduce((n, p) => n + ready(p).have, 0), kitMax = D.pilots.length * KIT.length;
    return [
      h('dl', { class: 'facts ex-facts' },
        h('div', { class: 'fact' }, h('dt', null, 'Pilots'), h('dd', null, D.pilots.length, h('span', { class: 'sub' }, 'Adam is one seat'))),
        h('div', { class: 'fact' }, h('dt', null, 'Muster questions'), h('dd', null, asked + ' of ' + all, h('span', { class: 'sub' }, all - asked ? (all - asked) + ' still open' : 'all answered'))),
        h('div', { class: 'fact' }, h('dt', null, 'Crew kit'), h('dd', null, (kitMax ? Math.round(kitAll / kitMax * 100) : 0) + '%', h('span', { class: 'sub' }, kitAll + ' of ' + kitMax + ' hulls')))),
      seatsView(),
      h('div', { class: 'pcards' }, D.pilots.map(pilotCard)),
      h('div', { class: 'tools' }, h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { const p = blankPilot(); D.pilots.push(p); U.open = p.id; save(); } }, 'Add a pilot')),
      matrix()];
  }

  // ------------------------------------------------------- kit and shopping
  function fitCard(hl) {
    const open = U.fit === hl.key, cfg = D.hulls[hl.key];
    return h('article', { class: 'pcard fitcard', 'data-hull': hl.key },
      h('header', { class: 'pcard-head' }, h('h4', null, hl.label), hl.ship && hl.ship !== hl.label ? h('span', { class: 'chip chip-lead' }, hl.ship) : null),
      h('p', { class: 'pcard-who' }, hl.role),
      h('p', { class: 'pcard-who' }, hl.fit ? ['Fit "' + (hl.fit.name || 'unnamed') + '": ', h('b', null, plural(hl.fit.items.reduce((n, i) => n + i.qty, 0), 'module or item', 'modules and items')), ' besides the hull.']
        : hl.ship ? 'No fit pasted yet: only the hull goes on the shopping list.' : 'No doctrine fit yet: it cannot go on the shopping list until one is pasted.'),
      hl.fit && hl.fit.loaded.length ? h('p', { class: 'note' }, 'Loaded charges are not counted (' + hl.fit.loaded.join(', ') + '): put ammunition in camp stock.') : null,
      h('p', { class: 'ex-field' }, 'Buy in ', seg('Buy ' + hl.label + ' in', X.places.map(p => [p, p]), cfg.buy_at, v => { cfg.buy_at = v; save(); })),
      open ? [h('textarea', { class: 'costs-text', rows: 8, spellcheck: 'false', 'data-keep': 'fit-' + hl.key, 'aria-label': 'Fit for ' + hl.label + ' in EFT format',
        placeholder: '[' + (hl.ship || 'Ship') + ', Camp standard]\nPaste the fit as the game or a fitting tool copies it.', value: U.draft, oninput: e => { U.draft = e.target.value; } }),
        U.note ? h('p', { class: 'note neg' }, U.note) : null,
        h('div', { class: 'tools' },
          h('button', { type: 'button', class: 'btn', onclick: () => { if (U.draft.trim() && !L.parseEft(U.draft)) { U.note = 'That does not start with a fit header like [Procurer, Camp standard].'; return repaint(); } cfg.eft = U.draft.trim(); U.fit = null; U.note = ''; save(); } }, 'Save fit'),
          h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { U.fit = null; U.note = ''; repaint(); } }, 'Cancel'))]
        : h('div', { class: 'tools' },
          h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { U.fit = hl.key; U.draft = cfg.eft; U.note = ''; repaint(); } }, hl.fit ? 'Change the fit' : 'Paste a fit'),
          hl.fit ? h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { cfg.eft = ''; save(); } }, 'Remove fit') : null));
  }

  function stockView() {
    const n = D.pilots.length, number = (keep, value, name, apply) => text(keep, value, name, v => { apply(Math.max(0, Math.round(L.parseIsk(v) || 0))); }, { class: 'ex-in ex-num', inputmode: 'numeric' });
    return h('section', { class: 'block ex-block' },
      h('div', { class: 'block-head' }, h('h3', null, 'Camp stock'), h('span', { class: 'why' }, 'consumables are doubled: spares × 2 for a stay of several nights')),
      h('div', { class: 'pi-scroll' }, h('table', { class: 'pi-table ex-stock' },
        h('thead', null, h('tr', null, h('th', { class: 'l' }, 'What'), h('th', { class: 'l' }, 'Item name, as in the market'), h('th', null, 'Each'), h('th', null, 'For'), h('th', null, 'Doubled'), h('th', null, 'Wanted'), h('th', null, 'Have'), h('th', null, 'To buy'), h('th', null, 'Buy in'), h('th', null, ''))),
        h('tbody', null, D.stock.map(st => { const want = L.stockNeed(st, n), short = Math.max(0, want - (st.have || 0));
          return h('tr', null,
            h('td', { class: 'l', 'data-l': 'What' }, text('sl-' + st.id, st.label, 'What it is', v => { st.label = v; })),
            h('td', { class: 'l', 'data-l': 'Item name, as in the market' }, text('si-' + st.id, st.item, 'Item name', v => { st.item = v; }, { class: 'ex-in ex-wide', placeholder: 'not named yet' })),
            h('td', { 'data-l': 'Each' }, number('sb-' + st.id, st.base, 'Each', v => { st.base = v; })),
            h('td', { 'data-l': 'For' }, seg('For', [['pilot', 'each pilot'], ['camp', 'the camp']], st.per, v => { st.per = v; save(); })),
            h('td', { 'data-l': 'Doubled' }, h('input', { type: 'checkbox', 'aria-label': 'Doubled', checked: !!st.doubled, onchange: e => { st.doubled = e.target.checked; save(); } })),
            h('td', { 'data-l': 'Wanted' }, num(want)),
            h('td', { 'data-l': 'Have' }, number('sh-' + st.id, st.have, 'Have', v => { st.have = v; })),
            h('td', { class: short ? 'best' : '', 'data-l': 'To buy' }, short ? num(short) : want ? 'covered' : h('span', { class: 'sub' }, 'set Each')),
            h('td', { 'data-l': 'Buy in' }, seg('Buy in', X.places.map(p => [p, p]), st.buy_at, v => { st.buy_at = v; save(); })),
            h('td', { class: 'ex-drop' }, h('button', { type: 'button', class: 'trip-skip', title: 'Remove this line', 'aria-label': 'Remove ' + (st.label || st.item || 'this line'), onclick: () => { D.stock = D.stock.filter(x => x !== st); save(); } }, '×'))); })))),
      h('div', { class: 'tools' }, h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { D.stock.push({ id: uid('s'), item: '', label: 'New line', base: 1, per: 'pilot', doubled: true, have: 0, buy_at: X.places[0] }); save(); } }, 'Add a line')),
      h('p', { class: 'note' }, 'The starting figures are placeholders to edit, not doctrine; a line with no item name stays off the shopping list until it is named. "Wanted" is Each, times the ' + plural(n, 'pilot') + ' when it is for each pilot, times two when doubled.'));
  }

  function shoppingView() {
    const sh = shopping();
    return h('section', { class: 'block ex-block', id: 'ex-shopping' },
      h('div', { class: 'block-head' }, h('h3', null, 'Shopping list'), h('span', { class: 'why' }, 'every missing hull with its fit, and the camp stock still short; no prices')),
      h('div', { class: 'shop' }, X.places.map(place => { const lines = sh.places[place] || [], txt = L.multibuy(lines);
        return h('div', { class: 'shop-place', 'data-place': place },
          h('h4', null, place, h('span', { class: 'sub' }, lines.length ? plural(lines.length, 'line') + ', ' + plural(lines.reduce((a, l) => a + l.qty, 0), 'unit') : 'nothing to buy')),
          lines.length ? [h('pre', { class: 'multibuy' }, txt), h('button', { type: 'button', class: 'btn copy-btn', onclick: e => copyText(e.currentTarget, txt) }, 'Copy for Multibuy')] : null); })),
      sh.unnamed.length ? h('p', { class: 'note' }, 'Not on the list yet, because the item is not named: ' + sh.unnamed.map(u => u.label + ' × ' + num(u.qty)).join('; ') + '.') : null,
      h('p', { class: 'note' }, 'In game: open the Market, choose Multibuy, then Import from clipboard.'));
  }

  function kitView() {
    const kitAll = D.pilots.reduce((n, p) => n + ready(p).have, 0), kitMax = D.pilots.length * KIT.length;
    const list = night0(), done = list.items.filter(i => i.checked).length;
    return [
      h('section', { class: 'block ex-block' },
        h('div', { class: 'block-head' }, h('h3', null, 'The standard kit'), h('span', null, (kitMax ? Math.round(kitAll / kitMax * 100) : 0) + '% of the crew’s hulls in hand'), h('span', { class: 'why' }, 'every pilot, all four hulls')),
        h('div', { class: 'pcards' }, D.pilots.map(p => { const r = ready(p);
          return h('article', { class: 'pcard', 'data-kit': p.id },
            h('header', { class: 'pcard-head' }, h('h4', null, label(p)), h('span', { class: 'pcard-pct' }, meter(r), h('b', null, r.pct + '%'))),
            h('div', { class: 'kit-rows' }, X.kit.map(k => h('div', { class: 'kit-row' }, h('span', { class: 'kit-hull' }, k.label),
              seg(label(p) + ': ' + k.label, [['missing', 'Missing'], ['owned', 'Owned'], ['staged', 'At camp']], (kitRow(p, k.key) || { status: 'missing' }).status, v => setKit(p, k.key, v)))))); }))),
      h('section', { class: 'block ex-block' },
        h('div', { class: 'block-head' }, h('h3', null, 'Standard fits'), h('span', { class: 'why' }, 'one fit per hull, the same for every pilot, so anyone can fly anyone’s reship')),
        h('div', { class: 'pcards' }, hulls().map(fitCard))),
      stockView(),
      shoppingView(),
      h('section', { class: 'block ex-block', id: 'ex-night0' },
        h('div', { class: 'block-head' }, h('h3', null, 'Night 0 checklist'), h('span', { class: 'chip ' + (done === list.items.length ? 'chip-lead' : 'chip-hold') }, done + ' of ' + list.items.length)),
        checks(list))];
  }
  const checks = list => h('div', { class: 'checks' }, list.items.map(it => h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: it.checked, onchange: e => { it.checked = e.target.checked; it.checked_at = it.checked ? Date.now() : null; save(); } }),
    h('span', null, it.label, it.checked_at ? h('span', { class: 'sub' }, 'done ' + new Date(it.checked_at).toLocaleString('en-CA', { weekday: 'short', hour: 'numeric', minute: '2-digit' })) : null))));


  // ------------------------------------------------------------------ camp
  const T = X.timers, MIN = 60000;
  const camp = () => D.camps.find(c => c.status !== 'ended') || null;
  const nightOf = c => c.nights.find(n => !n.ended_at) || null;
  const openWin = c => D.windows.find(w => w.camp_id === c.id && !w.end) || null;
  const night0 = () => D.checklists.filter(c => c.kind === 'night0').pop();
  const pname = id => { const p = D.pilots.find(q => q.id === id); return p ? label(p) : 'a pilot since removed'; };
  const modeName = k => (X.modes.find(m => m.key === k) || {}).name || k;
  const typeName = k => (X.windows.find(w => w.key === k) || {}).label || k;
  const hm = ts => new Date(ts).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const dayName = ts => new Date(ts).toLocaleDateString('en-CA', { weekday: 'short', day: 'numeric', month: 'short' });
  const others = w => w.pilot_ids.filter(id => id !== adam().id).map(pname).join(', ') || 'nobody else';
  /** A running clock: counts down to `until`, or up from `since`. The tick below keeps the text moving. */
  const face = (kind, ts, cls) => h('b', { class: 'clockface' + (cls ? ' ' + cls : ''), ['data-' + kind]: ts }, L.clock(kind === 'until' ? ts - Date.now() : Date.now() - ts));
  function setMode(k) {
    D.adam_mode = k;
    const c = camp(), w = c && openWin(c);
    if (w) w.adam_mode = k;                       // one account: the window is flown by whichever character is logged in
    save();
  }

  /** Brings a picket rotation up to `now`; turns that have ended go into the window's log. */
  function rollTimer(t, now) {
    const r = L.picketRoll(t, now);
    if (!r.stints.length) return false;
    Object.assign(t, r.timer);
    const w = D.windows.find(x => x.id === t.window_id);
    if (w) w.pickets = w.pickets.concat(r.stints);
    return true;
  }
  function roll() {
    let moved = false;
    for (const t of D.timers) if (t.kind === 'picket' && rollTimer(t, Date.now())) moved = true;
    return moved;
  }

  // The Android app rings the alarms. It is handed the list of what to ring for, and reports back what was pressed
  // on its notifications (Done, Snooze) while this page was not looking.
  const app = { known: !E.native, timers: false, allowed: true, exact: true };
  let pushed = null, pushT = 0;
  const alerts = () => { const c = camp(); return c ? L.campAlerts({ timers: D.timers.filter(t => t.camp_id === c.id), name: pname, rules: T }, Date.now()) : []; };
  function push() {
    if (!app.timers || demo) return;
    clearTimeout(pushT);
    pushT = setTimeout(() => {
      const list = alerts(), text = JSON.stringify([list, D.timers.map(t => t.id)]);
      if (text === pushed) return;
      E.ask('timers', { alerts: list, live: D.timers.map(t => t.id) }).then(r => {
        pushed = text;
        const was = app.allowed + '|' + app.exact;
        app.allowed = r.allowed !== false; app.exact = r.exact !== false;
        if (was !== app.allowed + '|' + app.exact) repaint();
      }, () => {});
    }, 200);
  }
  function applyAct(a) {
    const cut = String(a.id).indexOf(':'), id = cut < 0 ? String(a.id) : String(a.id).slice(0, cut), t = D.timers.find(x => x.id === id);
    if (!t) return;
    if (t.kind === 'gas') { t.acked = true; return; }
    if (t.kind !== 'picket') return;
    const boundary = Number(String(a.id).slice(cut + 1)), w = D.windows.find(x => x.id === t.window_id);
    rollTimer(t, a.at);
    if (a.act === 'done' && t.since === boundary) t.acked = boundary;
    if (a.act === 'snooze' && w) { const r = L.picketSnooze(t, w.pickets, boundary, a.until); if (r.ok) { Object.assign(t, r.timer); w.pickets = r.stints; } }
  }
  function pull() {
    if (!app.timers || demo) return Promise.resolve();
    return E.ask('timer-acts', {}).then(r => {
      const acts = (r.acts || []).slice().sort((x, y) => x.at - y.at);
      if (!acts.length) return;
      acts.forEach(applyAct); roll(); pushed = null; save();
    }, () => {});
  }
  /** What this build of the app can do, and whether Android lets it notify. */
  function look() {
    if (!E.native) return;
    E.ask('notify', {}).then(r => {
      app.known = true; app.timers = !!r.timers; app.allowed = !!r.allowed; app.exact = r.exact !== false;
      if (app.timers) pull().then(push);           // what was pressed on the phone first, then the list as it now stands
      // a camp is running and Android has not been asked yet whether the app may notify: ask once
      if (app.timers && !app.allowed && !app.asked && !demo && camp()) { app.asked = true; E.ask('notify', { ask: true }).then(() => {}, () => {}); setTimeout(look, 4000); setTimeout(look, 12000); }
      repaint();
    }, () => { app.known = true; repaint(); });
  }
  look();
  window.addEventListener('eveops-resume', look);
  let lastTick = Date.now(), pulledAt = 0;
  setInterval(() => {
    const c = camp(), now = Date.now(), was = lastTick;
    lastTick = now;
    if (!c) return;
    if (roll()) return save();
    if (app.timers && !demo && !document.hidden && now - pulledAt > 5000) { pulledAt = now; pull(); }
    if (!document.querySelector('.ex .camp')) return;
    let crossed = Math.floor(now / MIN) !== Math.floor(was / MIN);          // once a minute the wording may change ("gone by", "15 minutes left")
    document.querySelectorAll('.ex [data-until], .ex [data-since]').forEach(el => {
      const u = Number(el.getAttribute('data-until')), s0 = Number(el.getAttribute('data-since'));
      if (u) { if (was < u && now >= u) crossed = true; el.textContent = L.clock(u - now); } else el.textContent = L.clock(now - s0);
    });
    if (crossed) repaint();
  }, 1000);

  function campSetup() {
    const d = U.camp, ended = D.camps.filter(c => c.status === 'ended');
    const field = (keep, key, name, more) => h('label', { class: 'ex-field' }, name + ' ', h('input', Object.assign({ class: 'ex-in', type: 'text', 'data-keep': keep, 'aria-label': name, value: d[key], oninput: e => { d[key] = e.target.value; } }, more)));
    return [h('section', { class: 'block ex-block camp-setup', id: 'camp-setup' },
      h('div', { class: 'block-head' }, h('h3', null, 'Set up a camp'), h('span', { class: 'why' }, 'entered by hand; the Wormholes tab keeps the live chain')),
      field('camp-sys', 'system_name', 'System', { placeholder: 'e.g. J123405' }),
      h('span', { class: 'ex-field' }, 'Class ', seg('Class', X.classes.map(c => [c, c]), d.system_class, v => { d.system_class = v; repaint(); })),
      field('camp-statics', 'statics', 'Statics', { placeholder: 'e.g. highsec, C3' }),
      h('span', { class: 'ex-field' }, 'Stage ', seg('Stage', X.stages.map(x => [x.key, x.label]), d.stage_type, v => { d.stage_type = v; repaint(); })),
      U.note ? h('p', { class: 'note neg' }, U.note) : null,
      h('div', { class: 'tools' }, h('button', { type: 'button', class: 'btn', onclick: () => {
        if (!d.system_name.trim()) { U.note = 'Name the system first.'; return repaint(); }
        const id = uid('c'), list = night0();
        D.camps.push({ id, system_name: d.system_name.trim(), system_class: d.system_class, statics: d.statics.trim(), stage_type: d.stage_type, start_date: Date.now(), status: 'setup', nights: [],
          holes: d.statics.split(/[,;/]+/).map(x => x.trim()).filter(Boolean).map(x => ({ id: uid('h'), destination: x + ' static', state: 'fresh', eol_at: null, picketed: false, bookmarked: false })) });
        if (list && list.camp_id == null) list.camp_id = id;              // the checklist ticked while getting ready is this camp's
        else D.checklists.push({ id: uid('k'), camp_id: id, kind: 'night0', items: X.night0.map(l => ({ label: l, checked: false, checked_at: null })) });
        U.camp = { system_name: '', system_class: 'C2', statics: '', stage_type: 'nomad' }; U.note = ''; save();
      } }, 'Create the camp')),
      h('p', { class: 'note' }, 'Seats come from Muster. A hole is put on the board for each static; add the rest as they are scanned.')),
    ended.length ? h('section', { class: 'block ex-block', id: 'camp-earlier' },
      h('div', { class: 'block-head' }, h('h3', null, 'Earlier camps')),
      ended.slice().reverse().map(c => h('div', { class: 'lognight' },
        h('h4', null, c.system_name, h('span', { class: 'sub' }, dayName(c.start_date) + (c.ended_at ? ' to ' + dayName(c.ended_at) : '') + ', ' + plural(c.nights.length, 'night'))),
        h('div', { class: 'tools' }, c.nights.map(n => h('button', { type: 'button', class: 'btn btn-quiet copy-btn', onclick: e => copyText(e.currentTarget, nightMd(c, n)) }, 'Copy Night ' + n.n + ' as Markdown')))))) : null];
  }

  function statusLine(c) {
    const n = nightOf(c), w = openWin(c), m = mode(), last = c.nights[c.nights.length - 1], off = X.modes.filter(x => x !== m);
    return h('section', { class: 'camp-status', id: 'camp-status' },
      h('div', { class: 'cs' }, h('span', { class: 'cs-k' }, 'Camp'), h('b', null, c.system_name),
        h('span', { class: 'sub' }, [c.system_class, c.statics ? 'statics: ' + c.statics : '', (X.stages.find(x => x.key === c.stage_type) || {}).label].filter(Boolean).join(' · '))),
      h('div', { class: 'cs' }, h('span', { class: 'cs-k' }, 'Night'), h('b', null, n ? String(n.n) : last ? 'Night ' + last.n + ' ended' : 'Not started'),
        h('span', { class: 'sub' }, n ? 'since ' + dayName(n.started_at) + ' ' + hm(n.started_at) : last ? dayName(last.ended_at) + ' ' + hm(last.ended_at) : 'Night 0 checklist first')),
      h('div', { class: 'cs' }, h('span', { class: 'cs-k' }, 'Window'), w ? h('b', null, typeName(w.type), ' ', face('since', w.start)) : h('b', null, 'None running'),
        w ? h('span', { class: 'sub' }, 'since ' + hm(w.start)) : null),
      h('div', { class: 'cs cs-adam' }, h('span', { class: 'cs-k' }, 'Adam'), h('b', null, m.name, ' in the ' + m.hull),
        h('span', { class: 'sub' }, off.map(x => x.name + ' and the ' + x.hull).join(', ') + ': logged off'),
        seg('Adam’s mode', X.modes.map(x => [x.key, x.name.split(' ')[0] + '-mode']), D.adam_mode, setMode)));
  }

  const holeWords = hl => (hl.destination || 'unnamed hole') + ' ' + hl.state + (hl.eol_at ? ', end of life since ' + hm(hl.eol_at) : '') + (hl.picketed ? ', picketed' : '');
  /** The re-entry card: what a returning quartermaster needs before touching anything. */
  function leftOff(c) {
    const n = nightOf(c), last = c.nights[c.nights.length - 1], list = night0(), ticked = list.items.filter(i => i.checked).length, ready = ticked === list.items.length;
    const wins = D.windows.filter(w => w.camp_id === c.id && w.end).sort((a, b) => a.start - b.start), lw = wins[wins.length - 1];
    const of = k => wins.filter(w => w.night === k), total = ws => ws.reduce((a, w) => a + (w.end - w.start), 0);
    const lines = [];
    if (!last) lines.push('Camp set up ' + dayName(c.start_date) + '. Night 1 has not started.');
    else if (n) lines.push('Night ' + n.n + ' has been running since ' + dayName(n.started_at) + ' ' + hm(n.started_at) + ': ' + (of(n.n).length ? plural(of(n.n).length, 'window') + ' so far, ' + L.span(total(of(n.n))) + ' in all' : 'no window run yet') + '.');
    else lines.push('Night ' + last.n + ' ended ' + dayName(last.ended_at) + ' ' + hm(last.ended_at) + ': ' + (of(last.n).length ? plural(of(last.n).length, 'window') + ', ' + L.span(total(of(last.n))) + ' in all' : 'no windows were run') + '.');
    if (lw) lines.push(['Last window: ', h('b', null, typeName(lw.type)), ', ' + dayName(lw.start) + ' ' + hm(lw.start) + ' to ' + hm(lw.end) + ' (' + L.span(lw.end - lw.start) + '), Adam flying ' + modeName(lw.adam_mode) + ', with ' + others(lw) + '.',
      lw.pickets.length ? ' Picket: ' + lw.pickets.map(p => pname(p.pilot_id)).join(', then ') + '.' : '', lw.note ? [' Note: ', h('i', null, lw.note)] : '']);
    lines.push(c.holes.length ? 'Holes as last recorded: ' + c.holes.map(holeWords).join('; ') + '.' : 'No holes on the board.');
    lines.push('Bank totals by ship come with the next phase.');
    const startNight = () => { c.nights.push({ n: c.nights.length + 1, started_at: Date.now(), ended_at: null }); c.status = 'active'; save(); };
    return h('section', { class: 'block ex-block camp-left', id: 'camp-left' },
      h('div', { class: 'block-head' }, h('h3', null, 'Where we left off')),
      h('ul', { class: 'left-lines' }, lines.map(l => h('li', null, l))),
      !last ? [h('h4', { class: 'camp-sub' }, 'Night 0 checklist', h('span', { class: 'chip ' + (ready ? 'chip-lead' : 'chip-hold') }, ticked + ' of ' + list.items.length)), checks(list)] : null,
      h('div', { class: 'tools' },
        n ? h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { n.ended_at = Date.now(); save(); } }, 'End Night ' + n.n)
          : h('button', { type: 'button', class: 'btn', disabled: !last && !ready, onclick: startNight }, 'Start Night ' + (c.nights.length + 1)),
        !n && last ? h('button', { type: 'button', class: 'btn btn-quiet copy-btn', onclick: e => copyText(e.currentTarget, nightMd(c, last)) }, 'Copy Night ' + last.n + ' as Markdown') : null),
      !last && !ready ? h('p', { class: 'note' }, 'Night 1 can start once every Night 0 box is ticked.') : null);
  }

  /** The window about to start, with what was left unset filled in: everyone present, the seats' order on picket. */
  function winDraft() {
    const d = U.win, crew = D.pilots.filter(p => !p.is_adam).map(p => p.id), type = X.windows.find(w => w.key === d.type) || X.windows[0];
    const present = (d.present || crew).filter(id => crew.indexOf(id) >= 0);
    const seated = ['m1', 'm2', 'm3'].map(k => D.seats[k]).filter(Boolean);
    const all = present.concat([adam().id]);
    const order = (d.order || (seated.length ? seated : crew)).filter(id => all.indexOf(id) >= 0 && (d.order || present.indexOf(id) >= 0));
    return { type: type.key, picket: type.picket, present, order: type.picket ? order : [], interval: Math.max(1, Math.round(Number(d.interval) || T.picket_min)), crew };
  }
  function windowStart(c) {
    const v = winDraft(), d = U.win;
    const flip = (list, id) => (list.indexOf(id) >= 0 ? list.filter(x => x !== id) : list.concat([id]));
    return h('section', { class: 'block ex-block camp-start', id: 'camp-start' },
      h('div', { class: 'block-head' }, h('h3', null, 'Start a window')),
      h('p', { class: 'ex-field' }, seg('Window type', X.windows.map(w => [w.key, w.label]), v.type, k => { d.type = k; repaint(); })),
      h('div', { class: 'q' }, h('h5', null, 'Who is here'),
        h('div', { class: 'chips' }, h('span', { class: 'pick is-on is-fixed' }, 'Adam, flying ' + mode().name),
          v.crew.map(id => h('button', { type: 'button', class: 'pick' + (v.present.indexOf(id) >= 0 ? ' is-on' : ''), 'aria-pressed': v.present.indexOf(id) >= 0 ? 'true' : 'false',
            onclick: () => { d.present = flip(v.present, id); d.order = v.order.filter(x => x === adam().id || d.present.indexOf(x) >= 0); repaint(); } }, pname(id))))),
      v.picket ? h('div', { class: 'q' }, h('h5', null, 'Picket rotation', h('span', { class: 'sub' }, 'press the names in the order they take the picket')),
        h('div', { class: 'chips' }, v.present.concat([adam().id]).map(id => { const at = v.order.indexOf(id);
          return h('button', { type: 'button', class: 'pick' + (at >= 0 ? ' is-on' : ''), 'data-rot': id, 'aria-pressed': at >= 0 ? 'true' : 'false', onclick: () => { d.order = flip(v.order, id); repaint(); } },
            at >= 0 ? h('span', { class: 'pick-n' }, at + 1) : null, pname(id)); })),
        h('label', { class: 'ex-field' }, 'Change every ', h('input', { class: 'ex-in ex-num', type: 'text', inputmode: 'numeric', 'data-keep': 'win-every', 'aria-label': 'Minutes between picket changes', value: String(d.interval), oninput: e => { d.interval = e.target.value; } }), ' minutes'),
        h('p', { class: 'note' }, !v.order.length ? 'Nobody chosen: this window runs with no picket.' : v.order.length === 1 ? pname(v.order[0]) + ' pickets for the whole window: no rotation, so nothing rings.'
          : 'The phone rings at each change with who takes over, whether or not anyone touches it.')) : null,
      h('div', { class: 'tools' }, h('button', { type: 'button', class: 'btn', onclick: () => {
        const now = Date.now(), w = { id: uid('w'), camp_id: c.id, night: nightOf(c).n, type: v.type, start: now, end: null, pilot_ids: [adam().id].concat(v.present), adam_mode: D.adam_mode, note: '', pickets: [] };
        D.windows.push(w);
        D.timers.push({ id: uid('t'), camp_id: c.id, kind: 'window', label: typeName(v.type) + ' window', ends_at: null, rotation_order: [], started_at: now, window_id: w.id });
        if (v.order.length) D.timers.push({ id: uid('t'), camp_id: c.id, kind: 'picket', label: 'Picket rotation', ends_at: now + v.interval * MIN, rotation_order: v.order, started_at: now, since: now, turn: 0, interval_min: v.interval, acked: null, window_id: w.id });
        d.present = d.order = null; save();
      } }, 'Start the ' + typeName(v.type) + ' window')));
  }

  function picketCard(t, w) {
    const o = t.rotation_order, n = o.length, on = o[t.turn % n], next = o[(t.turn + 1) % n], now = Date.now();
    const pending = n > 1 && t.since > t.started_at && t.acked !== t.since && now - t.since < 15 * MIN;       // a change the phone rang for, not yet confirmed
    const snooze = (boundary, until) => { const r = L.picketSnooze(t, w.pickets, boundary, until); if (r.ok) { Object.assign(t, r.timer); w.pickets = r.stints; } save(); };
    return h('div', { class: 'picket' + (pending ? ' is-due' : ''), id: 'camp-picket' },
      h('div', { class: 'picket-on' }, h('span', { class: 'cs-k' }, 'On picket'), h('b', null, pname(on)), h('span', { class: 'sub' }, 'since ' + hm(t.since))),
      n > 1 ? h('div', { class: 'picket-next' }, h('span', { class: 'cs-k' }, 'Next'), h('b', null, pname(next)), h('span', { class: 'sub' }, 'in ', face('until', t.ends_at), ', at ' + hm(t.ends_at)))
        : h('div', { class: 'picket-next' }, h('span', { class: 'sub' }, 'No rotation: one pilot holds the picket.')),
      n > 1 ? h('div', { class: 'tools' }, pending
        ? [h('span', { class: 'picket-ask' }, pname(on) + ' took over at ' + hm(t.since) + '.'),
          h('button', { type: 'button', class: 'btn', onclick: () => { t.acked = t.since; save(); } }, 'Confirmed'),
          h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => snooze(t.since, Date.now() + T.snooze_min * MIN) }, 'Not yet: ' + T.snooze_min + ' more minutes')]
        : [h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { const at = Date.now(); w.pickets.push({ pilot_id: on, from: t.since, to: at }); t.turn = (t.turn + 1) % n; t.since = at; t.ends_at = at + t.interval_min * MIN; t.acked = at; save(); } }, 'Change now'),
          h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => snooze(t.ends_at, t.ends_at + T.snooze_min * MIN) }, T.snooze_min + ' more minutes for ' + pname(on))]) : null,
      w.pickets.length ? h('p', { class: 'note' }, 'So far: ' + w.pickets.map(p => pname(p.pilot_id) + ' ' + hm(p.from) + ' to ' + hm(p.to)).join('; ') + '.') : null);
  }
  function endWindow(c, w) {
    const now = Date.now();
    roll();
    for (const t of D.timers) if (t.kind === 'picket' && t.window_id === w.id) w.pickets.push({ pilot_id: t.rotation_order[t.turn % t.rotation_order.length], from: t.since, to: now });
    D.timers = D.timers.filter(t => t.window_id !== w.id && !(t.kind === 'gas' && t.camp_id === c.id));
    w.end = now;
    // the hand-off to the ISK-per-hour module: one record per finished window
    D.window_records.push({ window_id: w.id, camp_id: c.id, type: w.type, start: w.start, end: w.end, pilot_ids_present: w.pilot_ids.slice(), adam_mode: w.adam_mode });
    save();
  }
  function windowCard(c, w) {
    const p = D.timers.find(t => t.kind === 'picket' && t.window_id === w.id);
    return h('section', { class: 'block ex-block camp-window', id: 'camp-window' },
      h('div', { class: 'block-head' }, h('h3', null, typeName(w.type) + ' window'), face('since', w.start), h('span', { class: 'why' }, 'since ' + hm(w.start) + '; Adam flying ' + modeName(w.adam_mode) + ', with ' + others(w))),
      p ? picketCard(p, w) : h('p', { class: 'note' }, 'No picket in this window.'),
      h('label', { class: 'ex-field' }, 'Note ', text('wn-' + w.id, w.note, 'Window note', v => { w.note = v; }, { class: 'ex-in ex-wide', placeholder: 'one line on what happened' })),
      h('div', { class: 'tools' }, h('button', { type: 'button', class: 'btn', onclick: () => endWindow(c, w) }, 'End the window')));
  }

  const eolTimer = hl => D.timers.find(t => t.kind === 'eol' && t.hole_id === hl.id);
  function holeBoard(c) {
    const tick = (name, on, set) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: on, onchange: e => { set(e.target.checked); save(); } }), h('span', null, name));
    const setEol = (hl, at) => {
      D.timers = D.timers.filter(t => !(t.kind === 'eol' && t.hole_id === hl.id));
      hl.eol_at = at;
      if (at) D.timers.push({ id: uid('t'), camp_id: c.id, kind: 'eol', label: hl.destination || 'an unnamed system', ends_at: at + T.eol_hours * 3600000, rotation_order: [], hole_id: hl.id });
    };
    return h('section', { class: 'block ex-block camp-holes', id: 'camp-holes' },
      h('div', { class: 'block-head' }, h('h3', null, 'Hole board'), h('span', { class: 'why' }, 'the camp’s control state, kept by hand')),
      c.holes.length ? h('div', { class: 'holes' }, c.holes.map(hl => { const end = hl.eol_at ? hl.eol_at + T.eol_hours * 3600000 : 0, left = end - Date.now();
        return h('div', { class: 'hole st-' + hl.state + (hl.eol_at ? ' is-eol' : ''), 'data-hole': hl.id },
          text('hd-' + hl.id, hl.destination, 'Where it leads', v => { hl.destination = v; const t = eolTimer(hl); if (t) t.label = v || 'an unnamed system'; }, { class: 'ex-in hole-dest', placeholder: 'Where it leads' }),
          seg('Mass', X.holeStates.map(x => [x.key, x.label]), hl.state, v => { hl.state = v; save(); }),
          tick('End of life', !!hl.eol_at, on => setEol(hl, on ? Date.now() : null)),
          hl.eol_at ? h('span', { class: 'hole-eol' + (left < 15 * MIN ? ' is-due' : '') },
            h('label', { class: 'ex-field' }, 'first seen ', h('input', { class: 'ex-in ex-time', type: 'time', 'aria-label': 'When end of life was first seen', value: hm(hl.eol_at), onchange: e => {
              const parts = e.target.value.split(':').map(Number), d = new Date();
              if (parts.length < 2 || parts.some(isNaN)) return;
              d.setHours(parts[0], parts[1], 0, 0);
              if (d.getTime() > Date.now() + MIN) d.setDate(d.getDate() - 1);                // a time later than now was yesterday's
              setEol(hl, d.getTime()); save();
            } })),
            left > 0 ? ['gone by ' + hm(end) + ' at the latest: ', face('until', end), ' left'] : 'should have closed by ' + hm(end)) : null,
          tick('Picketed', hl.picketed, on => { hl.picketed = on; }),
          tick('Bookmarked both sides', hl.bookmarked, on => { hl.bookmarked = on; }),
          h('button', { type: 'button', class: 'trip-skip', title: 'Take this hole off the board', 'aria-label': 'Remove the hole to ' + (hl.destination || 'an unnamed system'), onclick: () => { setEol(hl, null); c.holes = c.holes.filter(x => x !== hl); save(); } }, '×')); }))
        : h('p', { class: 'note' }, 'No holes on the board.'),
      h('div', { class: 'tools' },
        h('input', { class: 'ex-in', type: 'text', 'data-keep': 'hole-new', 'aria-label': 'New hole: where it leads', placeholder: 'Where it leads', value: U.hole, oninput: e => { U.hole = e.target.value; } }),
        h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { c.holes.push({ id: uid('h'), destination: U.hole.trim(), state: 'fresh', eol_at: null, picketed: false, bookmarked: false }); U.hole = ''; save(); } }, 'Add a hole')),
      h('p', { class: 'note' }, 'Ticking End of life starts a ' + T.eol_hours + '-hour timer from when it was first seen, with rings at ' + T.eol_warn_min.join(' and ') + ' minutes left.'));
  }

  /** How the alarms will reach him, said plainly, with the fix when there is one. */
  function ringWords() {
    if (demo) return ['Sample data does not ring the phone.'];
    if (!E.native) return ['In a browser these only count down while this page is open. The alarms ring from the Eve Ops Android app.'];
    if (!app.known) return ['Checking what the app can do…'];
    if (!app.timers) return ['This build of the app cannot ring alarms. Install the newest Eve Ops app, then the timers ring with the phone folded.'];
    if (!app.allowed) return ['Android is blocking notifications from Eve Ops, so nothing will ring. ',
      h('button', { type: 'button', class: 'btn', onclick: () => { E.ask('notify', { ask: true }).then(() => {}, () => {}); setTimeout(look, 4000); setTimeout(look, 12000); } }, 'Ask Android to allow them'),
      h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => E.tell('notify-settings', {}) }, 'Open Android’s settings for Eve Ops')];
    return ['These ring on the phone with sound, with the app shut or the phone folded.' + (app.exact ? '' : ' Android has not allowed exact alarms, so they may ring a few minutes late.')];
  }
  function timersBlock(c) {
    const now = Date.now(), mine = D.timers.filter(t => t.camp_id === c.id), gas = mine.filter(t => t.kind === 'gas'), eol = mine.filter(t => t.kind === 'eol').sort((a, b) => a.ends_at - b.ends_at);
    return h('section', { class: 'block ex-block camp-timers', id: 'camp-timers' },
      h('div', { class: 'block-head' }, h('h3', null, 'Timers')),
      h('p', { class: 'note ring' + (E.native && app.known && (!app.timers || !app.allowed) && !demo ? ' neg' : '') }, ringWords()),
      gas.length || eol.length ? h('div', { class: 'tcards' },
        gas.map(t => { const due = now >= t.ends_at;
          return h('div', { class: 'tcard' + (due ? ' is-due' : ''), 'data-timer': 'gas' }, h('span', { class: 'cs-k' }, 'Gas site'), h('b', null, t.label),
            due ? h('span', null, 'Sleepers due. ', face('since', t.started_at), ' since first entry') : h('span', null, 'Sleepers in ', face('until', t.ends_at), '; entered ' + hm(t.started_at)),
            h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { D.timers = D.timers.filter(x => x !== t); save(); } }, 'Left the site')); }),
        eol.map(t => { const left = t.ends_at - now;
          return h('div', { class: 'tcard' + (left < T.eol_warn_min[T.eol_warn_min.length - 1] * MIN ? ' is-due' : left < T.eol_warn_min[0] * MIN ? ' is-near' : ''), 'data-timer': 'eol' }, h('span', { class: 'cs-k' }, 'Hole, end of life'), h('b', null, t.label),
            left > 0 ? h('span', null, face('until', t.ends_at), ' left at most; gone by ' + hm(t.ends_at)) : h('span', null, 'Should have closed by ' + hm(t.ends_at))); }))
        : h('p', { class: 'note' }, 'No gas or hole timers running.'),
      h('div', { class: 'tools' },
        h('input', { class: 'ex-in', type: 'text', 'data-keep': 'gas-new', 'aria-label': 'Gas site name', placeholder: 'Gas site name', value: U.gas, oninput: e => { U.gas = e.target.value; } }),
        h('button', { type: 'button', class: 'btn', onclick: () => { const at = Date.now();
          D.timers.push({ id: uid('t'), camp_id: c.id, kind: 'gas', label: U.gas.trim() || 'Gas site ' + (gas.length + 1), ends_at: at + T.gas_min * MIN, rotation_order: [], started_at: at, acked: false }); U.gas = ''; save(); } }, 'Entered a gas site: start ' + T.gas_min + ' minutes')));
  }

  const nightMd = (c, n) => L.nightMarkdown({ camp: c, night: n, windows: D.windows.filter(w => w.camp_id === c.id && w.night === n.n), holes: c.holes, name: pname, mode: modeName, type: typeName, time: hm, day: dayName });
  function logBlock(c) {
    const nights = c.nights.slice().reverse();
    return h('section', { class: 'block ex-block camp-log', id: 'camp-log' },
      h('div', { class: 'block-head' }, h('h3', null, 'Session log'), h('span', { class: 'why' }, 'window by window; the note can be changed afterwards')),
      nights.length ? nights.map(n => { const wins = D.windows.filter(w => w.camp_id === c.id && w.night === n.n).sort((a, b) => b.start - a.start);
        return h('div', { class: 'lognight', 'data-night': n.n },
          h('h4', null, 'Night ' + n.n, h('span', { class: 'sub' }, dayName(n.started_at) + ' ' + hm(n.started_at) + (n.ended_at ? ' to ' + hm(n.ended_at) : ', running')),
            h('button', { type: 'button', class: 'btn btn-quiet copy-btn', onclick: e => copyText(e.currentTarget, nightMd(c, n)) }, 'Copy Night ' + n.n + ' as Markdown')),
          wins.length ? wins.map(w => h('div', { class: 'logwin' + (w.end ? '' : ' is-open') },
            h('b', null, typeName(w.type)),
            h('span', null, hm(w.start) + ' to ' + (w.end ? hm(w.end) + ' (' + L.span(w.end - w.start) + ')' : 'now')),
            h('span', { class: 'sub' }, 'Adam flying ' + modeName(w.adam_mode) + '; with ' + others(w)),
            w.pickets.length ? h('span', { class: 'sub' }, 'Picket: ' + w.pickets.map(p => pname(p.pilot_id) + ' ' + hm(p.from) + ' to ' + hm(p.to)).join('; ')) : null,
            w.end ? text('ln-' + w.id, w.note, 'Note for the ' + typeName(w.type) + ' window', v => { w.note = v; }, { class: 'ex-in ex-wide', placeholder: 'note' }) : null))
            : h('p', { class: 'note' }, 'No windows yet.')); })
        : h('p', { class: 'note' }, 'Nothing logged yet.'));
  }
  function strikeBlock(c) {
    const busy = !!nightOf(c);
    return h('section', { class: 'block ex-block camp-strike', id: 'camp-strike' },
      h('div', { class: 'block-head' }, h('h3', null, 'Strike camp')),
      h('p', null, 'Agreed reasons to leave: ', X.exfil.join('; '), '.'),
      h('p', { class: 'note' }, 'The strike checklist and the bank manifest are the next phase of this module. Until then a camp is ended by hand.'),
      h('div', { class: 'tools' }, U.drop === 'camp'
        ? [h('span', { class: 'neg' }, 'End the camp in ' + c.system_name + '? Its log is kept under Earlier camps.'),
          h('button', { type: 'button', class: 'btn', onclick: () => { c.status = 'ended'; c.ended_at = Date.now(); D.timers = D.timers.filter(t => t.camp_id !== c.id); U.drop = null; save(); } }, 'End the camp'),
          h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { U.drop = null; repaint(); } }, 'Keep it')]
        : h('button', { type: 'button', class: 'btn btn-quiet', disabled: busy, onclick: () => { U.drop = 'camp'; repaint(); } }, 'End this camp'),
        busy ? h('span', { class: 'sub' }, 'End the night first.') : null));
  }
  function campView() {
    const c = camp();
    if (!c) return h('div', { class: 'camp' }, campSetup());
    if (roll()) { E.store.set(KEY, D); push(); }
    const n = nightOf(c), w = openWin(c);
    return h('div', { class: 'camp' }, statusLine(c), w ? windowCard(c, w) : leftOff(c), !w && n ? windowStart(c) : null, holeBoard(c), timersBlock(c), logBlock(c), strikeBlock(c));
  }

  // ------------------------------------------------------- export and import
  function markdown() {
    const yes = v => (v == null ? 'not asked' : v);
    const out = ['# Expedition muster', '', 'Exported ' + new Date().toLocaleString('en-CA') + '.', ''];
    for (const p of D.pilots) {
      const r = ready(p);
      out.push('## ' + label(p) + (p.is_adam ? ' (one seat: ' + X.modes.map(m => m.name).join(' or ') + ')' : ''), '');
      if (!p.is_adam) out.push('- Character: ' + (p.character_name || 'not known'), '- Clone: ' + (p.omega == null ? 'not asked' : p.omega ? 'Omega' : 'Alpha') + (p.sp_approx != null ? ', about ' + L.short(p.sp_approx) + ' SP' : ''),
        '- Will train an assigned seat: ' + yes(p.will_train), '- Stage: ' + yes(p.stage_pref === 'home' ? 'J142117 only' : p.stage_pref === 'nomad' ? 'nomad only' : p.stage_pref), '- Nights: ' + (p.timezone_note || 'not asked'),
        '- Losses: ' + (p.loss_tolerance.mode == null ? 'not asked' : p.loss_tolerance.mode === 'own' ? 'own rebuys' : 'shared SRP pot' + (p.loss_tolerance.pot_cap != null ? ', cap ' + L.short(p.loss_tolerance.pot_cap) : '')) + (p.loss_tolerance.note ? ' (' + p.loss_tolerance.note + ')' : ''));
      out.push('- Can fly: ' + (X.canFly.filter(c => canFly(p, c.key)).map(c => c.label.toLowerCase()).join(', ') || 'none of the list'),
        '- Kit: ' + r.pct + '% (' + X.kit.map(k => k.label + ' ' + ((kitRow(p, k.key) || { status: 'missing' }).status === 'staged' ? 'at camp' : (kitRow(p, k.key) || { status: 'missing' }).status)).join(', ') + ')');
      gaps(p).forEach(g => out.push('- Gap: ' + g));
      out.push('');
    }
    return out.join('\n');
  }
  function ioView() {
    if (!U.io) return null;
    const json = JSON.stringify(D, null, 1);
    if (U.io === 'export') {
      return h('section', { class: 'block ex-block ex-io' },
        h('div', { class: 'block-head' }, h('h3', null, 'Export'), h('span', { class: 'why' }, 'everything in this module, as it is on this device')),
        h('div', { class: 'tools' },
          h('button', { type: 'button', class: 'btn copy-btn', onclick: e => copyText(e.currentTarget, json) }, 'Copy as JSON'),
          h('button', { type: 'button', class: 'btn btn-quiet copy-btn', onclick: e => copyText(e.currentTarget, markdown()) }, 'Copy the muster as Markdown'),
          E.native ? null : h('a', { class: 'btn btn-quiet', download: 'eve-ops-expedition.json', href: URL.createObjectURL(new Blob([json], { type: 'application/json' })) }, 'Save as a file'),
          h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { U.io = null; repaint(); } }, 'Close')),
        h('p', { class: 'note' }, 'The JSON holds pilots, answers, kit, fits, stock, checklists, camps, windows and timers. Keep a copy before changing phones: nothing here is stored anywhere but this device.'));
    }
    return h('section', { class: 'block ex-block ex-io' },
      h('div', { class: 'block-head' }, h('h3', null, 'Import'), h('span', { class: 'why' }, 'replaces what is in this module on this device')),
      h('textarea', { class: 'costs-text', rows: 6, spellcheck: 'false', 'data-keep': 'ex-import', 'aria-label': 'Exported JSON', placeholder: 'Paste the JSON from Export here.', value: U.ioText, oninput: e => { U.ioText = e.target.value; } }),
      U.note ? h('p', { class: 'note neg' }, U.note) : null,
      h('div', { class: 'tools' },
        h('button', { type: 'button', class: 'btn', onclick: () => { let d = null; try { d = normal(JSON.parse(U.ioText)); } catch (err) { d = null; }
          if (!d) { U.note = 'That is not an export from this module, so nothing was changed.'; return repaint(); }
          D = d; U.io = null; U.ioText = ''; U.note = ''; U.open = null; pushed = null; save(); } }, 'Replace with this'),
        h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { U.io = null; U.note = ''; repaint(); } }, 'Cancel')));
  }

  /** The whole Expedition view. `paint` redraws the page (and keeps a box being typed in). */
  function view(paint) {
    repaint = paint;
    if (!U.tab) U.tab = camp() ? 'camp' : 'muster';          // mid-camp, the board is what he came for
    const tab = (key, name) => h('button', { type: 'button', class: 'view' + (U.tab === key ? ' is-on' : ''), 'aria-pressed': U.tab === key ? 'true' : 'false', onclick: () => { U.tab = key; repaint(); } }, name);
    return h('main', { class: 'ex' },
      h('header', { class: 'ex-head' },
        h('h2', null, 'Expedition ops'),
        h('nav', { class: 'views', 'aria-label': 'Expedition sections' }, tab('camp', 'Camp'), tab('muster', 'Muster'), tab('kit', 'Kit & Shopping')),
        h('span', { class: 'ex-tools' },
          h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { U.io = U.io === 'export' ? null : 'export'; U.note = ''; repaint(); } }, 'Export'),
          h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { U.io = U.io === 'import' ? null : 'import'; U.note = ''; repaint(); } }, 'Import'))),
      h('p', { class: 'note ex-lede' }, 'Kept on this device and usable with no network. The bank manifest and the strike checklist come in the next phase.'),
      ioView(),
      U.tab === 'camp' ? campView() : U.tab === 'muster' ? musterView() : kitView());
  }

  /** True once a camp's first night has started and until the camp is ended: the page then opens on the camp board. */
  const campOpen = () => { const c = camp(); return !!c && c.status === 'active'; };
  window.Ex = { view, data: () => D, campOpen };
})();
