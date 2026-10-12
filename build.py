# Builds both versions of Fetch from src/:
#   public/index.html   - the hosted app served by server.js
#   artifact/fetch.html - the claude.ai Artifact (schematic map, Artifact db)
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
        const r = await fetch('/api/municipality?lat=' + p[0] + '&lon=' + p[1]);
        const j = await r.json();
        if (r.ok && j.bounds) { map.fitBounds(j.bounds, { padding: [16, 16], maxZoom: 14 }); showPlace(j.name); return; }
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

BOOT = r'''  // REST + server-sent events, shaped like the small slice of the Artifact db API the page uses.
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
app = cut(app, "  // ---------- boot ----------", "})();\n", BOOT)
# First drive load: if location never arrived, frame the drives instead.
app = app.replace("        state.dbReady = true;\n        renderAll(false);\n      }, err", "        const first = !state.dbReady;\n        state.dbReady = true;\n        renderAll(false);\n        if (first) setTimeout(fallbackView, 1500);\n      }, err", 1)
assert 'fallbackView, 1500' in app

t = tpl.replace('<style>\n/*LEAFLET_CSS*/\n</style>\n', '<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">\n')
assert 'unpkg.com/leaflet' in t
t = t.replace('Shared drives around Zagreb', 'Shared drives near you')
t = t.replace('<div class="map-note">Schematic map of Zagreb. Open a drive for the exact route in Google Maps.</div>',
  '<div class="map-note" id="map-note" hidden></div>\n      <button class="locate" id="locate" type="button">Zoom to my area</button>')
t = t.replace('<span class="eyebrow">Fetch · Zagreb</span>', '<span class="eyebrow">Fetch</span>')
extra_css = '''
:root { --tile-filter: none; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --tile-filter: invert(1) hue-rotate(180deg) brightness(0.85) contrast(0.9); } }
:root[data-theme="dark"] { --tile-filter: invert(1) hue-rotate(180deg) brightness(0.85) contrast(0.9); }
.leaflet-tile-pane { filter: var(--tile-filter); }
.map-note { bottom: auto; top: 10px; left: 54px; color: var(--ink); font-weight: 600; }
.locate { position: absolute; top: 10px; right: 10px; z-index: 500; height: 34px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); font-weight: 600; font-size: 14px; box-shadow: 0 1px 3px rgba(0,0,0,0.15); }
.leaflet-control-attribution { background: var(--panel) !important; color: var(--muted) !important; }
.leaflet-control-attribution a { color: var(--accent) !important; }
'''
t = t.replace('@media (prefers-reduced-motion', extra_css + '@media (prefers-reduced-motion', 1)
t = t.replace('/*PARSE_JS*/', 'window.FETCH_ROUTE_URL = "/api/route";\n' + parse).replace('/*APP_JS*/', app)
page = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
        '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}</style>\n</head>\n<body>\n' + t + '\n</body>\n</html>\n')
os.makedirs(os.path.join(here, 'public'), exist_ok=True)
open(os.path.join(here, 'public', 'index.html'), 'w', encoding='utf-8').write(page)
print('built artifact/fetch.html and public/index.html')
