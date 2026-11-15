"""Rebuilds js/whdata.js from the data files in a copy of Wanderer (github.com/wanderer-industries/wanderer, MIT).
   python3 -I tools/whdata.py <wanderer>/priv/repo/data js/whdata.js
"""
# Build a compact lookup of wormhole statics, effects and wormhole types from Wanderer's MIT-licensed data files.
import json, sys, os
src, out = sys.argv[1], sys.argv[2]
systems = json.load(open(os.path.join(src, 'wormholeSystems.json')))
holes = json.load(open(os.path.join(src, 'wormholes.json')))
fxsrc = json.load(open(os.path.join(src, 'effects.json')))
effects = sorted({s.get('effectName') for s in systems if s.get('effectName')})
S = {}
for s in systems:
    e = s.get('effectName')
    S[str(s['solarSystemID'])] = [s.get('statics') or [], effects.index(e) if e else -1]
H = {}
for h in holes:
    try: life = float(h.get('lifetime') or 0)
    except ValueError: life = 0
    H[h['name']] = [(h.get('dest') or [''])[0], life, int(h.get('total_mass') or 0), int(h.get('max_mass_per_jump') or 0)]
FX = {f['name']: [[m['name'], 1 if m.get('positive') else 0, m.get('power') or []] for m in f.get('modifiers', [])] for f in fxsrc}
js = ("/* Wormhole statics, system effects and wormhole types.\n"
      "   Derived from data files in Wanderer (github.com/wanderer-industries/wanderer), MIT License,\n"
      "   Copyright (c) 2024 Wanderer Industries. Game data belongs to CCP hf. */\n"
      "window.WHDATA = " + json.dumps({'effects': effects, 'systems': S, 'holes': H, 'fx': FX}, separators=(',', ':')) + ";\n")
open(out, 'w').write(js)
home = [s for s in systems if s.get('systemName') == 'J142117']
print(len(js), 'bytes; fx names:', sorted(FX.keys()))
print('J142117:', json.dumps(home[0]) if home else 'not in data')
print('fx sample', json.dumps(FX.get('Pulsar'))[:260])
