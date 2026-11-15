/* Eve Ops — Expedition ops, Phase A: Muster (who is coming and what they can fly) and Kit & Shopping
   (the standard four-hull kit, the fits, camp stock, the shopping list, the Night 0 checklist).
   One operator, no network needed: everything is kept on this device and can be exported.
   Adam flies two characters on one account, so he is one seat with two modes, never two pilots.
   The entities follow the module's spec (Pilot, CanFly, KitItem, Checklist; Camp, Window, Timer, Bank,
   LootEvent and WindowRecord are kept empty here for the phases that fill them). */
(function () {
  'use strict';
  const C = window.EVEOPS_CONFIG, L = window.Logic, E = window.Esi, X = C.expedition;
  const demo = !!(window.Demo && window.Demo.on);
  const KEY = demo ? 'eveops.expedition.demo' : 'eveops.expedition';
  const U = { tab: 'muster', open: null, fit: null, draft: '', io: null, ioText: '', note: '', drop: null };
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
    d.seats.m1 = p[1].id;
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
    return out;
  }
  let D = normal(E.store.get(KEY)) || (demo ? sample() : fresh());
  const save = () => { E.store.set(KEY, D); repaint(); };

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
          seg('Adam’s mode', X.modes.map(x => [x.key, x.name.split(' ')[0] + '-mode']), D.adam_mode, k => { D.adam_mode = k; save(); }),
          h('span', { class: 'sub' }, off.map(x => x.name + ' and the ' + x.hull).join(', ') + ' stay logged off: one account, one character at a time.')),
        seat('m1', 1), seat('m2', 2), seat('m3', 3)),
      h('p', { class: 'note' }, 'The picket is one of the miner and ratter seats in turn, and earns the same share. The rotation order is set per window on the camp board, which is the next phase.'));
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
    const list = D.checklists.find(c => c.kind === 'night0'), done = list.items.filter(i => i.checked).length;
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
        h('div', { class: 'checks' }, list.items.map(it => h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: it.checked, onchange: e => { it.checked = e.target.checked; it.checked_at = it.checked ? Date.now() : null; save(); } }),
          h('span', null, it.label, it.checked_at ? h('span', { class: 'sub' }, 'done ' + new Date(it.checked_at).toLocaleString('en-CA', { weekday: 'short', hour: 'numeric', minute: '2-digit' })) : null)))))];
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
        h('p', { class: 'note' }, 'The JSON holds pilots, answers, kit, fits, stock and checklists. Keep a copy before changing phones: nothing here is stored anywhere but this device.'));
    }
    return h('section', { class: 'block ex-block ex-io' },
      h('div', { class: 'block-head' }, h('h3', null, 'Import'), h('span', { class: 'why' }, 'replaces what is in this module on this device')),
      h('textarea', { class: 'costs-text', rows: 6, spellcheck: 'false', 'data-keep': 'ex-import', 'aria-label': 'Exported JSON', placeholder: 'Paste the JSON from Export here.', value: U.ioText, oninput: e => { U.ioText = e.target.value; } }),
      U.note ? h('p', { class: 'note neg' }, U.note) : null,
      h('div', { class: 'tools' },
        h('button', { type: 'button', class: 'btn', onclick: () => { let d = null; try { d = normal(JSON.parse(U.ioText)); } catch (err) { d = null; }
          if (!d) { U.note = 'That is not an export from this module, so nothing was changed.'; return repaint(); }
          D = d; U.io = null; U.ioText = ''; U.note = ''; U.open = null; save(); } }, 'Replace with this'),
        h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { U.io = null; U.note = ''; repaint(); } }, 'Cancel')));
  }

  /** The whole Expedition view. `paint` redraws the page (and keeps a box being typed in). */
  function view(paint) {
    repaint = paint;
    const tab = (key, name) => h('button', { type: 'button', class: 'view' + (U.tab === key ? ' is-on' : ''), 'aria-pressed': U.tab === key ? 'true' : 'false', onclick: () => { U.tab = key; repaint(); } }, name);
    return h('main', { class: 'ex' },
      h('header', { class: 'ex-head' },
        h('h2', null, 'Expedition ops'),
        h('nav', { class: 'views', 'aria-label': 'Expedition sections' }, tab('muster', 'Muster'), tab('kit', 'Kit & Shopping')),
        h('span', { class: 'ex-tools' },
          h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { U.io = U.io === 'export' ? null : 'export'; U.note = ''; repaint(); } }, 'Export'),
          h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { U.io = U.io === 'import' ? null : 'import'; U.note = ''; repaint(); } }, 'Import'))),
      h('p', { class: 'note ex-lede' }, 'Kept on this device and usable with no network. Camp board, timers and the bank come in the next phases.'),
      ioView(),
      U.tab === 'muster' ? musterView() : kitView());
  }

  window.Ex = { view, data: () => D };
})();
