(function () {
  const $ = id => document.getElementById(id);
  const DAY = 86400000;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const startOfDay = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const addDays = (ms, n) => { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); };
  const fmtTime = ms => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const fmtDay = ms => new Date(ms).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const fmtDayLong = ms => {
    const today = startOfDay(Date.now()), d = startOfDay(ms);
    const rel = d === today ? 'Today' : d === addDays(today, 1) ? 'Tomorrow' : d === addDays(today, -1) ? 'Yesterday' : null;
    const full = new Date(ms).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    return rel ? rel + ' · ' + full : full;
  };
  const relIn = mins => {
    if (mins < 60) return 'in ' + mins + ' min';
    const h = Math.floor(mins / 60), m = mins % 60;
    return 'in ' + h + ' h' + (m ? ' ' + m + ' min' : '');
  };
  const toLocalInput = ms => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
  const shortPlace = s => (s || '').split(',')[0].trim() || s || '';

  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2600);
  }

  // ---------- state ----------
  const state = {
    name: store.get('fetch.name') || '',
    uid: null,
    db: null,
    dbReady: false,
    drives: [],
    selectedId: null,
    anchorDay: startOfDay(Date.now()),   // first day of the strip is anchor - 3
    day: startOfDay(Date.now()),
    rangeMode: 'day',                    // 'day' | 'week'
    search: '',
    draft: null,
    pick: null,
    window: null,
    unsubDrives: null,
    replies: [],
    unsubReplies: null,
    confirmDelete: null,
    writable: true
  };

  // ---------- name gate ----------
  function showGate() {
    $('gate').hidden = false;
    $('gate-name').value = state.name;
    setTimeout(() => $('gate-name').focus(), 30);
  }
  $('gate-form').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('gate-name').value.trim();
    if (!v) return;
    state.name = v; store.set('fetch.name', v);
    $('gate').hidden = true;
    renderMe();
    $('paste').focus();
  });
  $('me-change').addEventListener('click', showGate);
  function renderMe() { $('me').hidden = !state.name; $('me-name').textContent = state.name; }

  // ---------- map ----------
  const ZAGREB = [45.807, 15.975];
  const map = L.map('map', { zoomControl: true, attributionControl: false, minZoom: 10, maxZoom: 17, zoomSnap: 0.5,
    maxBounds: [[45.55, 15.55], [46.05, 16.45]] }).setView(ZAGREB, 12);
  const tok = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // Hand-placed, approximate geometry: enough to orient, not to navigate.
  const BASE = {
    sava: [[45.842,15.760],[45.830,15.790],[45.818,15.818],[45.806,15.845],[45.797,15.866],[45.789,15.886],[45.781,15.903],[45.777,15.918],[45.778,15.935],[45.781,15.950],[45.784,15.964],[45.786,15.978],[45.788,15.993],[45.790,16.010],[45.790,16.030],[45.786,16.050],[45.783,16.072],[45.785,16.095],[45.792,16.120],[45.800,16.150],[45.806,16.180]],
    jarun: [[45.7845,15.903],[45.7860,15.915],[45.7855,15.930],[45.7835,15.936],[45.7815,15.928],[45.7815,15.912],[45.7828,15.903]],
    bundek: [[45.7865,15.983],[45.7872,15.990],[45.7860,15.994],[45.7850,15.988]],
    parks: [
      [[45.8295,16.010],[45.8300,16.025],[45.8235,16.030],[45.8210,16.020],[45.8230,16.010]],
      [[45.835,15.935],[45.842,15.948],[45.835,15.960],[45.827,15.950]],
      [[45.795,16.072],[45.798,16.085],[45.790,16.090],[45.787,16.078]]
    ],
    hills: [[45.86,15.80],[45.875,15.88],[45.885,15.95],[45.89,16.02],[45.88,16.08],[45.92,16.10],[45.97,16.02],[45.96,15.86],[45.90,15.78]],
    major: [
      [[45.8131,15.9772],[45.8132,15.9620],[45.8150,15.9420],[45.8170,15.9200],[45.8195,15.8950],[45.8200,15.8700],[45.8160,15.8400]],
      [[45.8040,15.9600],[45.8030,15.9800],[45.8025,16.0000],[45.8030,16.0200],[45.8080,16.0400],[45.8150,16.0700]],
      [[45.7960,15.8600],[45.7960,15.9000],[45.7965,15.9400],[45.7975,15.9700],[45.7985,16.0000],[45.8010,16.0300],[45.8060,16.0700],[45.8120,16.1100],[45.8200,16.1500]],
      [[45.7780,15.9400],[45.7765,15.9600],[45.7760,15.9850],[45.7775,16.0150],[45.7820,16.0500],[45.7870,16.0800]],
      [[45.8000,15.8500],[45.7800,15.8620],[45.7600,15.8850],[45.7500,15.9200],[45.7470,15.9600],[45.7480,16.0000],[45.7580,16.0400],[45.7750,16.0800],[45.7950,16.1100],[45.8150,16.1400]]
    ],
    minor: [
      [[45.8080,15.9620],[45.7960,15.9640],[45.7840,15.9655],[45.7700,15.9670]],
      [[45.8150,15.9450],[45.8020,15.9430],[45.7900,15.9410],[45.7800,15.9400]],
      [[45.8220,16.0040],[45.8100,16.0050],[45.7980,16.0060],[45.7880,16.0070],[45.7750,16.0080]],
      [[45.8080,15.9930],[45.7980,15.9930],[45.7880,15.9930],[45.7760,15.9920]],
      [[45.8150,15.9950],[45.8200,16.0150],[45.8260,16.0400],[45.8330,16.0700]],
      [[45.8131,15.9772],[45.8150,15.9950]],
      [[45.8131,15.9772],[45.8045,15.9785],[45.7980,15.9790]],
      [[45.7900,15.9100],[45.7965,15.9200],[45.8050,15.9250],[45.8150,15.9300],[45.8250,15.9300]],
      [[45.7780,15.9400],[45.7650,15.9450],[45.7500,15.9500]],
      [[45.7760,15.9850],[45.7600,15.9900],[45.7480,16.0000]]
    ],
    labels: [
      ['Sljeme', 45.905, 15.955, 'big'], ['Centar', 45.8115, 15.977, 'big'], ['Gornji grad', 45.8175, 15.972, ''],
      ['Trešnjevka', 45.800, 15.947, ''], ['Trnje', 45.797, 15.985, ''], ['Maksimir', 45.828, 16.018, ''],
      ['Peščenica', 45.799, 16.035, ''], ['Dubrava', 45.833, 16.062, ''], ['Novi Zagreb', 45.770, 15.985, 'big'],
      ['Črnomerec', 45.820, 15.935, ''], ['Stenjevec', 45.813, 15.880, ''], ['Podsused', 45.818, 15.840, ''],
      ['Sesvete', 45.830, 16.110, ''], ['Jarun', 45.7895, 15.918, ''], ['Lučko', 45.765, 15.868, ''],
      ['Žitnjak', 45.792, 16.070, ''], ['Šestine', 45.845, 15.955, ''], ['Remetinec', 45.765, 15.950, ''],
      ['Sava', 45.7835, 16.045, 'water']
    ]
  };
  const base = {};
  const driveLayer = L.layerGroup();
  const draftLayer = L.layerGroup();
  function drawBase() {
    base.hills = L.polygon(BASE.hills, { stroke: false, interactive: false }).addTo(map);
    base.parks = BASE.parks.map(p => L.polygon(p, { stroke: false, interactive: false }).addTo(map));
    base.sava = L.polyline(BASE.sava, { weight: 9, interactive: false, lineCap: 'round', lineJoin: 'round' }).addTo(map);
    base.lakes = [L.polygon(BASE.jarun, { stroke: false, interactive: false }).addTo(map), L.polygon(BASE.bundek, { stroke: false, interactive: false }).addTo(map)];
    base.minorCase = BASE.minor.map(l => L.polyline(l, { weight: 5, interactive: false }).addTo(map));
    base.majorCase = BASE.major.map(l => L.polyline(l, { weight: 8, interactive: false }).addTo(map));
    base.minor = BASE.minor.map(l => L.polyline(l, { weight: 3, interactive: false }).addTo(map));
    base.major = BASE.major.map(l => L.polyline(l, { weight: 5, interactive: false }).addTo(map));
    BASE.labels.forEach(([t, la, lo, cls]) => L.marker([la, lo], { interactive: false, keyboard: false,
      icon: L.divIcon({ className: 'map-label ' + cls, html: esc(t), iconSize: [120, 16], iconAnchor: [60, 8] }) }).addTo(map));
    styleBase();
  }
  function styleBase() {
    const water = tok('--water'), park = tok('--park'), road = tok('--road'), casing = tok('--casing');
    base.hills.setStyle({ fillColor: park, fillOpacity: 0.55 });
    base.parks.forEach(p => p.setStyle({ fillColor: park, fillOpacity: 1 }));
    base.sava.setStyle({ color: water, opacity: 1 });
    base.lakes.forEach(p => p.setStyle({ fillColor: water, fillOpacity: 1 }));
    base.minorCase.forEach(p => p.setStyle({ color: casing, opacity: 1 }));
    base.majorCase.forEach(p => p.setStyle({ color: casing, opacity: 1 }));
    base.minor.forEach(p => p.setStyle({ color: road, opacity: 1 }));
    base.major.forEach(p => p.setStyle({ color: road, opacity: 1 }));
    renderMapDrives();
  }
  drawBase();
  driveLayer.addTo(map); draftLayer.addTo(map);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => styleBase());
  new MutationObserver(() => styleBase()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  function arc(a, b) {
    const pts = [], mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const c = [mx - dy * 0.18, my + dx * 0.18];
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const u = 1 - t;
      pts.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]);
    }
    return pts;
  }
  function startIcon(color) {
    return L.divIcon({ className: '', iconSize: [16, 16], iconAnchor: [8, 8],
      html: '<div style="width:16px;height:16px;border-radius:50%;background:' + tok('--panel') + ';border:4px solid ' + color + ';box-sizing:border-box"></div>' });
  }
  function endIcon() { return L.divIcon({ className: '', iconSize: [18, 18], iconAnchor: [9, 22], html: '<div class="pin-end"></div>' }); }

  function renderMapDrives() {
    if (!driveLayer) return;
    driveLayer.clearLayers();
    const accent = tok('--accent'), start = tok('--start'), muted = tok('--muted');
    const shown = visibleDrives();
    let selBounds = null;
    shown.forEach(d => {
      if (!d.fromLL || !d.toLL) return;
      const sel = d.id === state.selectedId;
      const line = L.polyline(d.route || arc(d.fromLL, d.toLL), {
        color: sel ? accent : muted, weight: sel ? 5 : 3, opacity: sel ? 1 : 0.55, dashArray: sel ? null : '6 6'
      }).addTo(driveLayer);
      line.on('click', () => select(d.id, true));
      line.bindTooltip(fmtTime(d.whenMs) + ' · ' + esc(d.name), { sticky: true });
      if (sel) {
        L.marker(d.fromLL, { icon: startIcon(start), zIndexOffset: 500 }).addTo(driveLayer).bindTooltip(esc(shortPlace(d.from)));
        L.marker(d.toLL, { icon: endIcon(), zIndexOffset: 600 }).addTo(driveLayer).bindTooltip(esc(shortPlace(d.to)));
        selBounds = L.latLngBounds([d.fromLL, d.toLL]);
      } else {
        L.circleMarker(d.fromLL, { radius: 4, color: start, weight: 2, fillColor: tok('--panel'), fillOpacity: 1 }).addTo(driveLayer).on('click', () => select(d.id, true));
        L.circleMarker(d.toLL, { radius: 4, color: accent, weight: 0, fillColor: accent, fillOpacity: 0.8 }).addTo(driveLayer).on('click', () => select(d.id, true));
      }
    });
    renderDraftOnMap();
    return selBounds;
  }
  function renderDraftOnMap() {
    if (!draftLayer) return;
    draftLayer.clearLayers();
    const d = state.draft;
    if (!d) return;
    if (d.fromLL) L.marker(d.fromLL, { icon: startIcon(tok('--start')) }).addTo(draftLayer);
    if (d.toLL) L.marker(d.toLL, { icon: endIcon() }).addTo(draftLayer);
    if (d.fromLL && d.toLL) {
      L.polyline(d.route || arc(d.fromLL, d.toLL), d.route ? { color: tok('--accent'), weight: 5, opacity: 0.8 } : { color: tok('--accent'), weight: 4, dashArray: '2 8', lineCap: 'round' }).addTo(draftLayer);
      requestRoute(d);
    }
  }
  // Street-level route preview, only where a routing endpoint exists (the hosted app sets FETCH_ROUTE_URL).
  function routeKey(d) { return [d.fromLL].concat(d.stopsLL || [], [d.toLL]).map(p => p.join(',')).join(';'); }
  function requestRoute(d) {
    if (!window.FETCH_ROUTE_URL) return;
    const key = routeKey(d);
    if (d.routeKey === key) return;
    d.routeKey = key; d.route = null;
    fetch(window.FETCH_ROUTE_URL + '?pts=' + encodeURIComponent(key)).then(r => r.ok ? r.json() : null).then(j => {
      if (!j || state.draft !== d || d.routeKey !== key) return;
      d.route = j.route; d.distanceM = j.distanceM; d.durationS = j.durationS;
      renderDraftOnMap();
    }).catch(() => {});
  }
  map.on('click', e => {
    if (!state.pick || !state.draft) return;
    state.draft[state.pick === 'from' ? 'fromLL' : 'toLL'] = [+e.latlng.lat.toFixed(5), +e.latlng.lng.toFixed(5)];
    state.pick = null;
    $('pick-banner').hidden = true;
    renderComposer();
    renderDraftOnMap();
  });

  // ---------- composer ----------
  $('paste').addEventListener('input', () => handlePaste());
  $('paste').addEventListener('paste', () => setTimeout(handlePaste, 0));
  function handlePaste() {
    const raw = $('paste').value.trim();
    if (!raw) { state.draft = null; renderComposer(); renderDraftOnMap(); return; }
    const r = parseMapsLink(raw);
    const d = { raw, parsed: r, from: '', to: '', stops: [], fromLL: null, toLL: null, time: null, sliderMin: 30, exactMs: null, comment: state.draft ? state.draft.comment : '', changeTime: false };
    if (r.ok) {
      const p = r.places;
      d.from = p[0].name; d.to = p[p.length - 1].name;
      d.fromLL = p[0].ll; d.toLL = p[p.length - 1].ll;
      d.stops = p.slice(1, -1).map(x => x.name).filter(Boolean);
      d.stopsLL = p.slice(1, -1).map(x => x.ll).filter(Boolean);
      d.time = r.time;
    }
    state.draft = d;
    renderComposer();
    renderDraftOnMap();
    if (d.fromLL && d.toLL) map.flyToBounds(L.latLngBounds([d.fromLL, d.toLL]).pad(0.4), { duration: 0.6, maxZoom: 15 });
  }

  function draftWhen(d) {
    if (d.time && !d.changeTime) return { ms: d.time.ms, type: d.time.type, source: 'link' };
    if (d.exactMs) return { ms: d.exactMs, type: 'depart', source: 'picked' };
    const ms = Math.round((Date.now() + d.sliderMin * 60000) / 300000) * 300000;
    return { ms, type: 'depart', source: 'picked' };
  }

  function renderComposer() {
    const f = $('composer');
    const d = state.draft;
    if (!d) { f.hidden = true; f.innerHTML = ''; return; }
    const r = d.parsed;
    let notice = '';
    if (!r.ok && r.reason === 'short') {
      notice = '<div class="notice warn">This is a short link, and the browser can\'t look inside it. Open it, copy the long link from the address bar, and paste that here instead. You can also type the places below and set the time yourself.</div>';
    } else if (!r.ok && r.reason === 'empty') {
      notice = '<div class="notice err">That doesn\'t look like a link. Paste the full address from Google Maps, starting with https://</div>';
    } else if (!r.ok && (r.reason === 'not-maps' || r.reason === 'invalid')) {
      notice = '<div class="notice err">That link isn\'t from Google Maps. Open your route in Google Maps and copy the address from there.</div>';
    } else if (!r.ok) {
      notice = '<div class="notice warn">This Maps link has no route in it. Pick a start and a destination in Google Maps, then copy the link again. You can also fill in the places below.</div>';
    }
    const noPins = r.ok && (!d.fromLL || !d.toLL);
    const when = draftWhen(d);
    const typeWord = when.type === 'arrive' ? 'Arrive by' : 'Depart';
    let timeHtml;
    if (d.time && !d.changeTime) {
      timeHtml = '<div class="when"><div class="when-head"><span class="eyebrow">' + typeWord + '</span><span class="when-big">' + fmtTime(when.ms) + '</span><span class="when-sub">' + fmtDayLong(when.ms) + '</span><span class="tag">From the link</span></div>' +
        '<div><button type="button" class="linkbtn" data-act="change-time">Use a different time</button></div></div>';
    } else {
      const mins = Math.max(0, Math.round((when.ms - Date.now()) / 60000));
      timeHtml = '<div class="when"><div class="when-head"><span class="eyebrow">When are you leaving?</span><span class="when-big" id="when-big">' + fmtTime(when.ms) + '</span><span class="when-sub" id="when-sub">' +
        (d.exactMs ? fmtDayLong(when.ms) : fmtDay(when.ms) + ' · ' + relIn(mins)) + '</span>' + (d.time ? '' : '<span class="tag amber">No time in link</span>') + '</div>' +
        '<input type="range" id="when-slider" min="0" max="2880" step="5" value="' + d.sliderMin + '" aria-label="Departure time from now">' +
        '<div class="scale"><span>now</span><span>+12 h</span><span>+24 h</span><span>+36 h</span><span>+48 h</span></div>' +
        '<div class="exact"><label for="when-exact">Or pick an exact time</label><input type="datetime-local" id="when-exact" value="' + toLocalInput(when.ms) + '">' +
        (d.time ? '<button type="button" class="linkbtn" data-act="link-time">Use the time from the link</button>' : '') + '</div></div>';
    }
    const pinRow = which => {
      const ll = which === 'from' ? d.fromLL : d.toLL;
      const active = state.pick === which;
      return '<div class="pin-row">' + (ll ? '<span>On the map</span>' : '<span>Not on the map yet</span>') +
        '<button type="button" class="chipbtn' + (active ? ' active' : '') + '" data-act="pick-' + which + '">' + (active ? 'Click the map…' : ll ? 'Move pin' : 'Place on map') + '</button></div>';
    };
    const canSave = d.from.trim() && d.to.trim();
    f.innerHTML = notice +
      (noPins ? '<div class="notice">The link names the places but has no coordinates, so the drive will be listed without a line on the map. You can place the pins by hand.</div>' : '') +
      '<div class="fields">' +
        '<div class="field"><label for="d-from">Start</label><input id="d-from" value="' + esc(d.from) + '" placeholder="Where you leave from">' + pinRow('from') + '</div>' +
        '<div class="field"><label for="d-to">Destination</label><input id="d-to" value="' + esc(d.to) + '" placeholder="Where you\'re going">' + pinRow('to') + '</div>' +
      '</div>' +
      (d.stops.length ? '<div class="hint">Stops on the way: ' + esc(d.stops.join(' → ')) + '</div>' : '') +
      timeHtml +
      '<div class="field"><label for="d-comment">Comment (optional)</label><textarea id="d-comment" rows="2" maxlength="500" placeholder="Two free seats, happy to stop at Kaufland on the way">' + esc(d.comment) + '</textarea></div>' +
      '<div class="actions"><button class="btn primary" type="submit" id="d-save"' + (canSave && state.writable ? '' : ' disabled') + '>Share drive</button>' +
      '<button class="btn" type="button" data-act="cancel">Cancel</button>' +
      (!state.writable ? '<span class="hint">You can view drives here, but sharing needs edit access to this page.</span>' : '<span class="hint">Shared as ' + esc(state.name || 'you') + '</span>') + '</div>';
    f.hidden = false;

    $('d-from').addEventListener('input', e => { d.from = e.target.value; $('d-save').disabled = !(d.from.trim() && d.to.trim() && state.writable); });
    $('d-to').addEventListener('input', e => { d.to = e.target.value; $('d-save').disabled = !(d.from.trim() && d.to.trim() && state.writable); });
    $('d-comment').addEventListener('input', e => { d.comment = e.target.value; });
    const slider = $('when-slider');
    if (slider) {
      slider.addEventListener('input', () => {
        d.sliderMin = +slider.value; d.exactMs = null;
        const w = draftWhen(d);
        $('when-big').textContent = fmtTime(w.ms);
        $('when-sub').textContent = fmtDay(w.ms) + ' · ' + relIn(d.sliderMin);
        $('when-exact').value = toLocalInput(w.ms);
      });
      $('when-exact').addEventListener('change', e => {
        const ms = new Date(e.target.value).getTime();
        if (!isFinite(ms)) return;
        d.exactMs = ms;
        const mins = Math.round((ms - Date.now()) / 60000);
        if (mins >= 0 && mins <= 2880) slider.value = Math.round(mins / 5) * 5;
        $('when-big').textContent = fmtTime(ms);
        $('when-sub').textContent = fmtDayLong(ms);
      });
    }
  }
  $('composer').addEventListener('click', e => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    const d = state.draft; if (!d) return;
    const a = act.dataset.act;
    if (a === 'cancel') return clearDraft();
    if (a === 'change-time') { d.changeTime = true; d.exactMs = d.time.ms; renderComposer(); }
    if (a === 'link-time') { d.changeTime = false; d.exactMs = null; renderComposer(); }
    if (a === 'pick-from' || a === 'pick-to') {
      const which = a.slice(5);
      state.pick = state.pick === which ? null : which;
      $('pick-banner').hidden = !state.pick;
      $('pick-banner').textContent = state.pick === 'from' ? 'Click the map where the drive starts' : 'Click the map where the drive ends';
      renderComposer();
    }
  });
  $('composer').addEventListener('submit', async e => {
    e.preventDefault();
    const d = state.draft; if (!d) return;
    if (!state.name) return showGate();
    const w = draftWhen(d);
    const doc = {
      name: state.name, uid: state.uid || null,
      from: d.from.trim().slice(0, 200), to: d.to.trim().slice(0, 200), stops: d.stops.slice(0, 8),
      fromLL: d.fromLL || null, toLL: d.toLL || null, stopsLL: d.stopsLL || [],
      whenMs: w.ms, timeType: w.type, timeSource: w.source,
      link: (d.parsed.link || d.raw || '').slice(0, 4000), comment: d.comment.trim().slice(0, 500),
      createdMs: Date.now()
    };
    const btn = $('d-save'); btn.disabled = true; btn.textContent = 'Sharing…';
    try {
      if (state.db) {
        const ref = await state.db.collection('drives').add(doc);
        state.selectedId = ref.id;
      } else {
        const id = 'local-' + Date.now();
        state.drives.push(Object.assign({ id }, doc));
        state.selectedId = id;
      }
      state.day = startOfDay(w.ms);
      if (Math.abs(state.day - state.anchorDay) > 3 * DAY) state.anchorDay = state.day;
      state.rangeMode = 'day';
      clearDraft();
      ensureWindow();
      renderAll(true);
      toast(state.db ? 'Drive shared' : 'Saved in this tab only. Sharing isn\'t available in this view.');
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Share drive';
      if (err && err.code === 'invalid_argument') { state.writable = false; renderComposer(); toast('You can\'t share drives with view-only access.'); }
      else if (err && err.code === 'quota_exceeded') toast('The drive list is full. Delete some old drives first.');
      else toast('Couldn\'t share the drive. Try again in a moment.');
    }
  });
  function clearDraft() {
    state.draft = null; state.pick = null; $('pick-banner').hidden = true;
    $('paste').value = ''; renderComposer(); renderDraftOnMap();
  }

  // ---------- data ----------
  function ensureWindow() {
    if (!state.db) return;
    const lo = addDays(Math.min(state.anchorDay, state.day), -10), hi = addDays(Math.max(state.anchorDay, state.day), 11);
    if (state.window && lo >= state.window[0] && hi <= state.window[1]) return;
    const win = [addDays(lo, -30), addDays(hi, 30)];
    state.window = win;
    if (state.unsubDrives) state.unsubDrives();
    state.unsubDrives = state.db.collection('drives').where('whenMs', '>=', win[0]).where('whenMs', '<', win[1]).orderBy('whenMs').limit(1000)
      .onSnapshot(snap => {
        state.drives = snap.docs.map(s => Object.assign({ id: s.id }, s.data()));
        state.dbReady = true;
        renderAll(false);
      }, err => {
        state.dbReady = true;
        renderAll(false);
        toast('Live updates stopped. Reload the page to reconnect.');
      });
  }
  function subscribeReplies() {
    return;  // messages on drives were removed at Andro's request
    if (state.unsubReplies) { state.unsubReplies(); state.unsubReplies = null; }
    state.replies = [];
    if (!state.db || !state.selectedId || state.selectedId.startsWith('local-')) return;
    const id = state.selectedId;
    state.unsubReplies = state.db.collection('replies').where('driveId', '==', id).orderBy('createdMs').limit(200)
      .onSnapshot(snap => {
        if (state.selectedId !== id) return;
        state.replies = snap.docs.map(s => Object.assign({ id: s.id }, s.data()));
        renderList();
      }, () => {});
  }

  // ---------- list ----------
  function matches(d, q) {
    const hay = [d.name, d.from, d.to, d.comment, (d.stops || []).join(' ')].join(' ').toLowerCase();
    return q.split(/\s+/).filter(Boolean).every(w => hay.includes(w));
  }
  function visibleDrives() {
    const q = state.search.trim().toLowerCase();
    let ds = state.drives.slice();
    if (q) ds = ds.filter(d => matches(d, q));
    else if (state.rangeMode === 'week') {
      const a = addDays(state.anchorDay, -3), b = addDays(state.anchorDay, 4);
      ds = ds.filter(d => d.whenMs >= a && d.whenMs < b);
    } else {
      const a = state.day, b = addDays(state.day, 1);
      ds = ds.filter(d => d.whenMs >= a && d.whenMs < b);
    }
    return ds.sort((x, y) => x.whenMs - y.whenMs);
  }

  function renderDays() {
    const today = startOfDay(Date.now());
    const counts = {};
    state.drives.forEach(d => { const k = startOfDay(d.whenMs); counts[k] = (counts[k] || 0) + 1; });
    let html = '';
    for (let i = -3; i <= 3; i++) {
      const ms = addDays(state.anchorDay, i);
      const dt = new Date(ms);
      const cls = ['day'];
      if (ms === today) cls.push('today');
      if (!state.search && state.rangeMode === 'day' && ms === state.day) cls.push('sel');
      if (!state.search && state.rangeMode === 'week') cls.push('inrange');
      const c = counts[ms] || 0;
      html += '<button type="button" class="' + cls.join(' ') + '" data-day="' + ms + '" aria-pressed="' + (ms === state.day && state.rangeMode === 'day') + '" title="' + esc(fmtDayLong(ms)) + '">' +
        '<span class="dw">' + (ms === today ? 'Today' : dt.toLocaleDateString('en-GB', { weekday: 'short' })) + '</span>' +
        '<span class="dn">' + dt.getDate() + '</span><span class="dc">' + (c ? c + (c === 1 ? ' drive' : ' drives') : '') + '</span></button>';
    }
    $('day-strip').innerHTML = html;
    const first = addDays(state.anchorDay, -3), last = addDays(state.anchorDay, 3);
    $('range-row').innerHTML =
      '<button type="button" class="chipbtn' + (state.rangeMode === 'day' && !state.search ? ' active' : '') + '" data-range="day">One day</button>' +
      '<button type="button" class="chipbtn' + (state.rangeMode === 'week' && !state.search ? ' active' : '') + '" data-range="week">' +
        esc(new Date(first).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' – ' + new Date(last).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })) + '</button>' +
      (state.anchorDay !== today || state.day !== today ? '<button type="button" class="chipbtn" data-range="today">Back to today</button>' : '');
  }
  $('day-strip').addEventListener('click', e => {
    const b = e.target.closest('[data-day]'); if (!b) return;
    state.day = +b.dataset.day; state.rangeMode = 'day'; state.search = ''; $('search').value = '';
    ensureWindow(); renderAll(true);
  });
  $('range-row').addEventListener('click', e => {
    const b = e.target.closest('[data-range]'); if (!b) return;
    const r = b.dataset.range;
    state.search = ''; $('search').value = '';
    if (r === 'today') { state.anchorDay = state.day = startOfDay(Date.now()); state.rangeMode = 'day'; }
    else state.rangeMode = r;
    ensureWindow(); renderAll(true);
  });
  $('prev-week').addEventListener('click', () => { state.anchorDay = addDays(state.anchorDay, -7); state.day = addDays(state.day, -7); ensureWindow(); renderAll(true); });
  $('next-week').addEventListener('click', () => { state.anchorDay = addDays(state.anchorDay, 7); state.day = addDays(state.day, 7); ensureWindow(); renderAll(true); });
  $('search').addEventListener('input', e => { state.search = e.target.value; renderAll(true); });

  function canDelete(d) {
    if (state.uid && d.uid) return d.uid === state.uid;
    return !!state.name && d.name === state.name;
  }

  function renderList() {
    const ds = visibleDrives();
    const el = $('list');
    if (!ds.length) {
      let msg;
      if (state.db && !state.dbReady) msg = '<strong>Loading drives…</strong>';
      else if (state.search) msg = '<strong>No drives match “' + esc(state.search) + '”</strong><span>Search covers drives a month either side of the days shown.</span>';
      else if (state.rangeMode === 'week') msg = '<strong>No drives these days</strong><span>Paste a Google Maps directions link above to share yours.</span>';
      else msg = '<strong>No drives ' + (state.day === startOfDay(Date.now()) ? 'today yet' : 'on ' + esc(fmtDay(state.day))) + '</strong><span>Paste a Google Maps directions link above to share where you\'re driving. Use the days above to look at earlier or later drives.</span>';
      el.innerHTML = '<div class="empty">' + msg + '</div>';
      return;
    }
    const multiDay = state.search || state.rangeMode === 'week';
    const now = Date.now();
    let html = '', lastDay = null;
    ds.forEach(d => {
      const day = startOfDay(d.whenMs);
      if (multiDay && day !== lastDay) { html += '<div class="group-h">' + esc(fmtDayLong(d.whenMs)) + '</div>'; lastDay = day; }
      const sel = d.id === state.selectedId;
      const past = d.whenMs < now - 30 * 60000;
      html += '<div class="drive' + (sel ? ' sel' : '') + (past ? ' past' : '') + '" data-id="' + esc(d.id) + '" tabindex="0" role="button" aria-expanded="' + sel + '">' +
        '<div class="t">' + fmtTime(d.whenMs) + '<small>' + (d.timeType === 'arrive' ? 'arrive by' : 'depart') + '</small></div>' +
        '<div class="route">' +
          '<div class="leg"><span class="dot"></span><span>' + esc(sel ? d.from : shortPlace(d.from)) + '</span></div>' +
          '<div class="leg"><span class="dot end"></span><span>' + esc(sel ? d.to : shortPlace(d.to)) + '</span></div>' +
          '<div class="by"><span>by <strong>' + esc(d.name || 'Someone') + '</strong></span>' + (!d.fromLL || !d.toLL ? '<span>· not on map</span>' : '') + '</div>' +
          (d.comment && !sel ? '<div class="comment">' + esc(d.comment.length > 120 ? d.comment.slice(0, 118) + '…' : d.comment) + '</div>' : '') +
        '</div>' + (sel ? detailHtml(d) : '') + '</div>';
    });
    el.innerHTML = html;
    const selEl = el.querySelector('.drive.sel');
    if (selEl && renderList._scroll) { selEl.scrollIntoView({ block: 'nearest' }); renderList._scroll = false; }
  }
  function detailHtml(d) {
    const link = /^https:\/\/(www\.)?(google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl)/i.test(d.link || '') ? d.link : null;
    let h = '<div class="detail">';
    if (d.stops && d.stops.length) h += '<div class="hint">Via ' + esc(d.stops.join(' → ')) + '</div>';
    h += '<div class="hint">' + esc(fmtDayLong(d.whenMs)) + ' · ' + (d.timeType === 'arrive' ? 'arriving by ' : 'leaving at ') + fmtTime(d.whenMs) +
      (d.timeSource === 'picked' ? ' (set by ' + esc(d.name || 'the driver') + ')' : '') + '</div>';
    if (d.distanceM) h += '<div class="hint">' + (d.distanceM / 1000).toFixed(1) + ' km · about ' + Math.max(1, Math.round(d.durationS / 60)) + ' min without traffic</div>';
    if (d.comment) h += '<div class="comment">' + esc(d.comment) + '</div>';
    h += '<div class="acts">' + (link ? '<a class="open" href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">Open route in Google Maps</a>' : '');
    if (canDelete(d)) {
      h += state.confirmDelete === d.id
        ? '<span class="hint">Delete this drive?</span><button type="button" class="small-btn danger" data-act="del-yes">Delete</button><button type="button" class="small-btn" data-act="del-no">Keep</button>'
        : '<button type="button" class="small-btn" data-act="del">Delete</button>';
    }
    h += '</div>';
    return h + '</div>';
  }
  function select(id, fromMap) {
    if (state.selectedId === id && !fromMap) { state.selectedId = null; state.confirmDelete = null; subscribeReplies(); renderAll(false); return; }
    state.selectedId = id; state.confirmDelete = null;
    subscribeReplies();
    renderList._scroll = true;
    renderAll(false);
    const d = state.drives.find(x => x.id === id);
    if (d && d.fromLL && d.toLL) map.flyToBounds(L.latLngBounds([d.fromLL, d.toLL]).pad(0.35), { duration: 0.6, maxZoom: 15 });
  }
  $('list').addEventListener('click', async e => {
    const act = e.target.closest('[data-act]');
    if (act) {
      const d = state.drives.find(x => x.id === state.selectedId);
      if (!d) return;
      if (act.dataset.act === 'del') { state.confirmDelete = d.id; renderList(); }
      else if (act.dataset.act === 'del-no') { state.confirmDelete = null; renderList(); }
      else if (act.dataset.act === 'del-yes') {
        try {
          if (state.db && !d.id.startsWith('local-')) await state.db.collection('drives').doc(d.id).delete();
          else state.drives = state.drives.filter(x => x.id !== d.id);
          state.selectedId = null; state.confirmDelete = null; subscribeReplies(); renderAll(false); toast('Drive deleted');
        } catch (err) { toast('Couldn\'t delete the drive.'); }
      }
      return;
    }
    if (e.target.closest('.detail')) return;
    const row = e.target.closest('.drive');
    if (row) select(row.dataset.id, false);
  });
  $('list').addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('drive')) { e.preventDefault(); select(e.target.dataset.id, false); }
  });
  $('list').addEventListener('submit', async e => {
    const f = e.target.closest('[data-reply]'); if (!f) return;
    e.preventDefault();
    if (!state.name) return showGate();
    const input = f.querySelector('input');
    const text = input.value.trim(); if (!text) return;
    input.disabled = true;
    try {
      await state.db.collection('replies').add({ driveId: f.dataset.reply, name: state.name, uid: state.uid || null, text: text.slice(0, 300), createdMs: Date.now() });
      input.value = '';
    } catch (err) { toast(err && err.code === 'invalid_argument' ? 'You can\'t post messages with view-only access.' : 'Couldn\'t send the message.'); }
    input.disabled = false;
    const again = $('reply-' + f.dataset.reply); if (again) again.focus();
  });

  function renderAll() {
    renderDays();
    renderList();
    renderMapDrives();
  }

  // ---------- boot ----------
  renderMe();
  if (!state.name) showGate();
  renderAll();
  setInterval(() => { if (!state.draft) renderList(); }, 60000);

  if (window.claude && claude.use) {
    claude.use('user').then(async user => {
      if (!user) return;
      try { state.uid = await user.id(); } catch (e) {}
      try { const w = await user.can('data.write'); if (w === false) { state.writable = false; renderComposer(); } } catch (e) {}
      renderList();
    });
    claude.use('db').then(db => {
      if (!db) { state.dbReady = true; renderAll(); toast('Drives can\'t be loaded in this view.'); return; }
      state.db = db;
      ensureWindow();
    });
  } else {
    state.dbReady = true;
    renderAll();
  }
})();
