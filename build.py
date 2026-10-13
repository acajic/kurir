# Builds every version of Fetch from src/ (edit src/, never the generated files):
#   public/index.html          - the Node server version (server.js)
#   firebase/public/index.html - the Firebase version (Hosting + Firestore)
#   artifact/fetch.html        - the claude.ai Artifact (schematic map, Artifact db)
import os, re
here = os.path.dirname(os.path.abspath(__file__))
src = lambda n: open(os.path.join(here, 'src', n), encoding='utf-8').read()
app, tpl, parse = src('app.js'), src('template.html'), src('parse.js')

# ---------- Artifact ----------
css = re.sub(r'/\*.*?\*/', '', src('leaflet.css'), flags=re.S)
css = re.sub(r'[^\n]*url\(images/[^\n]*\n', '\n', css)
css = re.sub(r'\n\s*\n+', '\n', css)
art = tpl.replace('/*LEAFLET_CSS*/', css).replace('/*PARSE_JS*/', parse).replace('/*APP_JS*/', app)
os.makedirs(os.path.join(here, 'artifact'), exist_ok=True)
open(os.path.join(here, 'artifact', 'fetch.html'), 'w', encoding='utf-8').write(art)

# ---------- Hosted ----------
def cut(s, start, end, new):
    i = s.index(start); j = s.index(end, i) + len(end)
    return s[:i] + new + s[j:]

MAP = r'''  const FALLBACK = [45.807, 15.975];   // used only when location is unavailable and there are no drives
  const map = L.map('map', { zoomControl: true, zoomSnap: 0.5 }).setView(FALLBACK, 11);
  const tok = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
  const driveLayer = L.layerGroup().addTo(map);
  const draftLayer = L.layerGroup().addTo(map);
  const youLayer = L.layerGroup().addTo(map);
  function showPlace(name) { const n = $('map-note'); n.hidden = !name; n.textContent = name ? 'Around ' + name : ''; }
  function fallbackView() {
    if (state.located) return;
    const pts = state.drives.flatMap(d => [d.fromLL, d.toLL]).filter(Boolean);
    if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 13 });
  }
  function locate(explicit) {
    if (!navigator.geolocation) { if (explicit) toast('This browser can\'t share your location.'); return fallbackView(); }
    navigator.geolocation.getCurrentPosition(async pos => {
      state.located = true;
      const p = [pos.coords.latitude, pos.coords.longitude];
      youLayer.clearLayers();
      L.circleMarker(p, { radius: 7, color: tok('--panel'), weight: 3, fillColor: tok('--accent'), fillOpacity: 1 }).addTo(youLayer).bindTooltip('You are here');
      try {
        const j = await municipalityLookup(p[0], p[1]);
        if (j && j.bounds) { map.fitBounds(j.bounds, { padding: [16, 16], maxZoom: 14 }); showPlace(j.name); return; }
      } catch (e) {}
      map.setView(p, 12);
    }, () => {
      if (explicit) toast('Location is blocked. Allow it for this site in your browser to zoom to your area.');
      fallbackView();
    }, { timeout: 10000, maximumAge: 600000 });
  }
  $('locate').addEventListener('click', () => { state.located = false; locate(true); });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => renderMapDrives());
  new MutationObserver(() => renderMapDrives()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
'''
app = cut(app, "  const ZAGREB = [45.807, 15.975];", "attributeFilter: ['data-theme'] });\n", MAP)

# Short links: the server follows the redirect, then the long link is parsed as usual.
app = app.replace("""    const r = parseMapsLink(raw);
""", """    const r = parseMapsLink(raw);
    if (!r.ok && r.reason === 'short') {
      fetch('/api/resolve?url=' + encodeURIComponent(r.link)).then(x => x.json()).then(j => {
        if ($('paste').value.trim() !== raw) return;
        const full = j && j.url ? parseMapsLink(j.url) : null;
        if (full && full.ok) { full.link = j.url; applyParsed(raw, full); }
        else if (state.draft && state.draft.raw === raw) { state.draft.resolving = false; renderComposer(); }
      }).catch(() => { if (state.draft && state.draft.raw === raw) { state.draft.resolving = false; renderComposer(); } });
    }
    applyParsed(raw, r);
  }
  function applyParsed(raw, r) {
""", 1)
app = app.replace("const d = { raw, parsed: r, from: '',", "const d = { raw, parsed: r, resolving: !r.ok && r.reason === 'short', from: '',", 1)
app = app.replace("""      notice = '<div class="notice warn">This is a short link, and the browser can\\'t look inside it. Open it, copy the long link from the address bar, and paste that here instead. You can also type the places below and set the time yourself.</div>';""",
"""      notice = d.resolving ? '<div class="notice">Opening the short link…</div>'
        : '<div class="notice warn">Couldn\\'t open this short link. Open it yourself, copy the long link from the address bar and paste that here, or type the places below.</div>';""", 1)
assert 'Opening the short link' in app and 'function applyParsed' in app

BOOT_SERVER = r'''  // REST + server-sent events, shaped like the small slice of the Artifact db API the page uses.
  function restDb(cid) {
    const listeners = { drives: new Set(), replies: new Set() };
    const es = new EventSource('/api/events');
    es.addEventListener('change', e => { const c = JSON.parse(e.data).collection; (listeners[c] || []).forEach(f => f()); });
    let opened = false;
    es.onopen = () => { if (opened) Object.values(listeners).forEach(s => s.forEach(f => f())); opened = true; };
    const headers = { 'content-type': 'application/json', 'x-client-id': cid };
    async function call(method, url, body) {
      const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { const e = new Error(j.error || 'Request failed'); e.code = r.status === 403 ? 'forbidden' : r.status === 400 ? 'bad_request' : 'unavailable'; throw e; }
      return j;
    }
    function query(name, filters) {
      return {
        where(f, op, v) { return query(name, filters.concat([[f, op, v]])); },
        orderBy() { return this; },
        limit() { return this; },
        onSnapshot(next, error) {
          const params = new URLSearchParams();
          for (const [f, op, v] of filters) {
            if (f === 'whenMs' && op === '>=') params.set('from', v);
            else if (f === 'whenMs' && op === '<') params.set('to', v);
            else if (f === 'driveId') params.set('driveId', v);
          }
          let dead = false;
          const run = () => call('GET', '/api/' + name + '?' + params).then(rows => {
            if (!dead) next({ docs: rows.map(r => ({ id: r.id, data: () => r })) });
          }).catch(() => { if (!dead) toast('Can\'t reach the server. Retrying…'); setTimeout(() => { if (!dead) run(); }, 5000); });
          listeners[name].add(run);
          run();
          return () => { dead = true; listeners[name].delete(run); };
        },
        async add(data) { const j = await call('POST', '/api/' + name, data); return { id: j.id }; },
        doc(id) { return { delete: () => call('DELETE', '/api/' + name + '/' + encodeURIComponent(id)) }; }
      };
    }
    return { collection: name => query(name, []) };
  }

  // ---------- boot ----------
  renderMe();
  if (!state.name) showGate();
  renderAll();
  setInterval(() => { if (!state.draft) renderList(); }, 60000);
  state.uid = store.get('fetch.client');
  if (!state.uid) { state.uid = crypto.randomUUID(); store.set('fetch.client', state.uid); }
  state.db = restDb(state.uid);
  ensureWindow();
  locate(false);
})();
'''

MUNI_SERVER = r"""  async function municipalityLookup(lat, lon) {
    const r = await fetch('/api/municipality?lat=' + lat + '&lon=' + lon);
    return r.ok ? r.json() : null;
  }
"""
ROUTE_SERVER = 'window.FETCH_ROUTE = pts => fetch("/api/route?pts=" + encodeURIComponent(pts)).then(r => r.ok ? r.json() : null);\n'

def hosted_page(app, boot, muni, route, head_scripts=''):
    a = cut(app, "  // ---------- boot ----------", "})();\n", muni + boot)
    # First drive load: if location never arrived, frame the drives instead.
    a = a.replace("        state.dbReady = true;\n        renderAll(false);\n      }, err", "        const first = !state.dbReady;\n        state.dbReady = true;\n        renderAll(false);\n        if (first) setTimeout(fallbackView, 1500);\n      }, err", 1)
    assert 'fallbackView, 1500' in a
    t = tpl.replace('<style>\n/*LEAFLET_CSS*/\n</style>\n', '<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">\n')
    assert 'unpkg.com/leaflet' in t
    t = t.replace('Shared drives around Zagreb', 'Shared drives near you')
    t = t.replace('<div class="map-note">Schematic map of Zagreb. Open a drive for the exact route in Google Maps.</div>',
      '<div class="map-note" id="map-note" hidden></div>\n      <button class="locate" id="locate" type="button">Zoom to my area</button>')
    t = t.replace('<span class="eyebrow">Fetch · Zagreb</span>', '<span class="eyebrow">Fetch</span>')
    t = t.replace('@media (prefers-reduced-motion', EXTRA_CSS + '@media (prefers-reduced-motion', 1)
    leaflet = '<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js"></script>'
    assert leaflet in t
    t = t.replace(leaflet, head_scripts + leaflet)
    t = t.replace('/*PARSE_JS*/', route + parse).replace('/*APP_JS*/', a)
    return ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
            '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}</style>\n</head>\n<body>\n' + t + '\n</body>\n</html>\n')

def write(rel, text):
    path = os.path.join(here, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, 'w', encoding='utf-8').write(text)

EXTRA_CSS = '''
:root { --tile-filter: none; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --tile-filter: invert(1) hue-rotate(180deg) brightness(0.85) contrast(0.9); } }
:root[data-theme="dark"] { --tile-filter: invert(1) hue-rotate(180deg) brightness(0.85) contrast(0.9); }
.leaflet-tile-pane { filter: var(--tile-filter); }
.map-note { bottom: auto; top: 10px; left: 54px; color: var(--ink); font-weight: 600; }
.locate { position: absolute; top: 10px; right: 10px; z-index: 500; height: 34px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); font-weight: 600; font-size: 14px; box-shadow: 0 1px 3px rgba(0,0,0,0.15); }
.leaflet-control-attribution { background: var(--panel) !important; color: var(--muted) !important; }
.leaflet-control-attribution a { color: var(--accent) !important; }
'''

write('public/index.html', hosted_page(app, BOOT_SERVER, MUNI_SERVER, ROUTE_SERVER))

# ---------- Firebase (Hosting + Firestore + one Cloud Function for short links) ----------
FB = '10.14.1'
FB_SCRIPTS = ''.join('<script src="/__/firebase/%s/firebase-%s-compat.js"></script>\n' % (FB, m) for m in ('app', 'auth', 'firestore')) + '<script src="/__/firebase/init.js"></script>\n'
MUNI_FB = r"""  async function municipalityLookup(lat, lon) {
    const r = await fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&addressdetails=1&lat=' + lat + '&lon=' + lon, { headers: { 'accept-language': 'hr,en' } });
    if (!r.ok) return null;
    const j = await r.json(), a = j.address || {}, bb = (j.boundingbox || []).map(Number);
    return { name: a.city || a.town || a.municipality || a.village || j.name || '', bounds: bb.length === 4 ? [[bb[0], bb[2]], [bb[1], bb[3]]] : null };
  }
"""
ROUTE_FB = r"""window.FETCH_ROUTE = pts => {
  const c = pts.split(';').map(p => p.split(',').reverse().join(',')).join(';');
  return fetch('https://router.project-osrm.org/route/v1/driving/' + c + '?overview=full&geometries=geojson').then(r => r.ok ? r.json() : null).then(j => {
    const b = j && j.routes && j.routes[0];
    if (!b) return null;
    let line = b.geometry.coordinates.map(([x, y]) => [+y.toFixed(5), +x.toFixed(5)]);
    if (line.length > 1500) { const st = Math.ceil(line.length / 1500); line = line.filter((_, i) => i % st === 0 || i === line.length - 1); }
    return { route: line, distanceM: Math.round(b.distance), durationS: Math.round(b.duration) };
  });
};
"""
BOOT_FB = r"""  // Firestore, shaped like the small slice of the Artifact db API the page uses.
  // Firestore has no nested arrays, so point lists are stored as maps and strings.
  function fbDb() {
    const fs = firebase.firestore();
    const enc = d => {
      const o = Object.assign({}, d);
      if (o.stopsLL) o.stopsLL = o.stopsLL.map(p => ({ lat: p[0], lng: p[1] }));
      if (o.route) o.route = o.route.map(p => p[0] + ',' + p[1]).join(';');
      return o;
    };
    const dec = o => {
      const d = Object.assign({}, o);
      if (Array.isArray(d.stopsLL)) d.stopsLL = d.stopsLL.map(p => [p.lat, p.lng]);
      if (typeof d.route === 'string') d.route = d.route.split(';').map(p => p.split(',').map(Number));
      return d;
    };
    const wrap = q => ({
      where: (f, op, v) => wrap(q.where(f, op, v)),
      orderBy: (f, dir) => wrap(q.orderBy(f, dir)),
      limit: n => wrap(q.limit(n)),
      onSnapshot: (next, err) => q.onSnapshot(snap => next({ docs: snap.docs.map(s => { const d = dec(s.data()); return { id: s.id, data: () => d }; }) }), err),
      add: data => q.add(enc(data)),
      doc: id => q.doc(id)
    });
    return { collection: name => wrap(fs.collection(name)) };
  }

  // ---------- boot ----------
  renderMe();
  if (!state.name) showGate();
  renderAll();
  setInterval(() => { if (!state.draft) renderList(); }, 60000);
  firebase.auth().onAuthStateChanged(u => {
    if (!u) return;
    state.uid = u.uid;
    if (!state.db) { state.db = fbDb(); ensureWindow(); }
    renderList();
  });
  firebase.auth().signInAnonymously().catch(() => toast('Couldn\'t connect to the drive list. Reload the page to try again.'));
  locate(false);
})();
"""
write('firebase/public/index.html', hosted_page(app, BOOT_FB, MUNI_FB, ROUTE_FB, FB_SCRIPTS))
print('built artifact/fetch.html, public/index.html and firebase/public/index.html')
