// ---- Google Maps directions link parsing ----
const ZAGREB_TZ = 'Europe/Zagreb';

function tzOffsetMs(utcMs, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(utcMs));
  const p = {};
  for (const x of parts) p[x.type] = +x.value;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs;
}

// Google encodes the chosen time as wall-clock seconds written as if UTC.
function zagrebWallToUtc(wallSecs) {
  const wall = wallSecs * 1000;
  let utc = wall - tzOffsetMs(wall, ZAGREB_TZ);
  utc = wall - tzOffsetMs(utc, ZAGREB_TZ);
  return utc;
}

// The data= blob is a flat list of !<id><type><value> tokens where an "m" token
// owns the next <value> tokens. Rebuild the tree from those counts.
function parseDataBlob(blob) {
  const toks = blob.split('!').filter(Boolean).map(t => {
    const m = /^(\d+)([a-z])(.*)$/.exec(t);
    return m ? { id: +m[1], type: m[2], value: m[3] } : null;
  }).filter(Boolean);
  let i = 0;
  function take(n) {
    const out = [];
    let used = 0;
    while (used < n && i < toks.length) {
      const t = toks[i++];
      used++;
      if (t.type === 'm') {
        const count = +t.value || 0;
        const start = i;
        t.children = take(count);
        used += i - start;
      }
      out.push(t);
    }
    return out;
  }
  return take(Infinity);
}

function findDirections(nodes) {
  for (const n of nodes) {
    if (n.type !== 'm' || !n.children) continue;
    const wps = n.children.filter(c => c.id === 1 && c.type === 'm');
    const hasMode = n.children.some(c => c.id === 3 && c.type === 'e');
    if (wps.length >= 2 || hasMode) return n;
    const deeper = findDirections(n.children);
    if (deeper) return deeper;
  }
  return null;
}

function waypointCoords(wp) {
  let lat = null, lng = null;
  (function walk(ns) {
    for (const c of ns) {
      if (c.type === 'd' && c.id === 1 && lng === null) lng = parseFloat(c.value);
      else if (c.type === 'd' && c.id === 2 && lat === null) lat = parseFloat(c.value);
      if (c.children) walk(c.children);
    }
  })(wp.children || []);
  return lat !== null && lng !== null && isFinite(lat) && isFinite(lng) ? [lat, lng] : null;
}

function cleanPlace(s) {
  return decodeURIComponent(s.replace(/\+/g, ' ')).replace(/\s+/g, ' ').trim();
}

function coordsFromText(s) {
  const m = /^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/.exec(s || '');
  return m ? [+m[1], +m[2]] : null;
}

function isShortLink(u) {
  return /^(maps\.app\.goo\.gl|goo\.gl)$/i.test(u.hostname);
}

// Returns {ok, kind, places:[{name, ll}], time:{ms, type}|null, mode, link} or {ok:false, reason}
function parseMapsLink(raw) {
  const text = (raw || '').trim();
  const urlMatch = /https?:\/\/\S+/.exec(text);
  if (!urlMatch) return { ok: false, reason: 'empty' };
  let u;
  try { u = new URL(urlMatch[0]); } catch (e) { return { ok: false, reason: 'invalid' }; }
  const link = u.href;
  if (isShortLink(u)) return { ok: false, reason: 'short', link };
  if (!/(^|\.)google\.[a-z.]+$/i.test(u.hostname) || !/^\/maps/.test(u.pathname) && !/^maps\./.test(u.hostname)) {
    return { ok: false, reason: 'not-maps', link };
  }

  // ?api=1 style and the old saddr/daddr style
  const q = u.searchParams;
  if (q.get('destination') || q.get('daddr')) {
    const from = q.get('origin') || q.get('saddr') || '';
    const to = q.get('destination') || q.get('daddr') || '';
    const stops = (q.get('waypoints') || '').split('|').filter(Boolean);
    const places = [from, ...stops, to].map(s => ({ name: s.trim(), ll: coordsFromText(s) }));
    return { ok: true, places, time: null, mode: q.get('travelmode') || null, link };
  }

  const dirIdx = u.pathname.indexOf('/dir/');
  if (dirIdx < 0) return { ok: false, reason: 'not-directions', link };
  const rest = u.pathname.slice(dirIdx + 5).split('/');
  const segs = [];
  let blob = '';
  for (const s of rest) {
    if (s.startsWith('@')) continue;
    if (s.startsWith('data=')) { blob = s.slice(5); continue; }
    if (s.startsWith('am=')) continue;
    segs.push(s);
  }
  while (segs.length && segs[segs.length - 1] === '') segs.pop();
  const names = segs.map(cleanPlace);

  let wpNodes = [], time = null, mode = null;
  if (blob) {
    const dir = findDirections(parseDataBlob(blob));
    if (dir) {
      wpNodes = dir.children.filter(c => c.id === 1 && c.type === 'm');
      const opts = dir.children.find(c => c.id === 2 && c.type === 'm');
      if (opts && opts.children) {
        const j = opts.children.find(c => c.id === 8 && c.type === 'j');
        const e = opts.children.find(c => c.id === 6 && c.type === 'e');
        if (j && +j.value > 0) {
          time = { ms: zagrebWallToUtc(+j.value), type: e && e.value === '1' ? 'arrive' : 'depart' };
        }
      }
      const m = dir.children.find(c => c.id === 3 && c.type === 'e');
      if (m) mode = ['driving', 'bicycling', 'walking', 'transit'][+m.value] || null;
    }
  }

  const n = Math.max(names.length, wpNodes.length);
  if (n < 2) return { ok: false, reason: 'one-place', link };
  const places = [];
  for (let k = 0; k < n; k++) {
    const name = names[k] || '';
    const ll = (wpNodes[k] && waypointCoords(wpNodes[k])) || coordsFromText(name);
    places.push({ name, ll });
  }
  return { ok: true, places, time, mode, link };
}

if (typeof module !== 'undefined') module.exports = { parseMapsLink, zagrebWallToUtc };
