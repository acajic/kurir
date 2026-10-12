// Fetch: shared drives. Zero-dependency Node server (Node >= 22.13).
// Serves public/, a small JSON API over SQLite, live updates over SSE,
// short Google Maps link resolution and municipality lookup for the map.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = +process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC = path.join(__dirname, 'public');
const UA = process.env.NOMINATIM_UA || 'fetch-drives/1.0 (self-hosted)';
// OSRM-compatible router. The public demo server is fine for light use; point this at your own for more.
const ROUTER = (process.env.ROUTER_URL || 'https://router.project-osrm.org').replace(/\/$/, '');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'fetch.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS drives (id TEXT PRIMARY KEY, whenMs INTEGER NOT NULL, uid TEXT, body TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS drives_when ON drives (whenMs);
  CREATE TABLE IF NOT EXISTS replies (id TEXT PRIMARY KEY, driveId TEXT NOT NULL, createdMs INTEGER NOT NULL, body TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS replies_drive ON replies (driveId, createdMs);
  CREATE TABLE IF NOT EXISTS geocache (k TEXT PRIMARY KEY, v TEXT NOT NULL, at INTEGER NOT NULL);
`);

// ---------- validation ----------
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const ll = v => (Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number' && isFinite(n)) && Math.abs(v[0]) <= 90 && Math.abs(v[1]) <= 180 ? [v[0], v[1]] : null);
function cleanDrive(b, uid) {
  const d = {
    name: str(b.name, 40), uid,
    from: str(b.from, 200), to: str(b.to, 200),
    stops: Array.isArray(b.stops) ? b.stops.slice(0, 8).map(s => str(s, 200)).filter(Boolean) : [],
    fromLL: ll(b.fromLL), toLL: ll(b.toLL),
    stopsLL: Array.isArray(b.stopsLL) ? b.stopsLL.slice(0, 8).map(ll).filter(Boolean) : [],
    whenMs: Number.isFinite(b.whenMs) ? Math.round(b.whenMs) : NaN,
    timeType: b.timeType === 'arrive' ? 'arrive' : 'depart',
    timeSource: b.timeSource === 'link' ? 'link' : 'picked',
    link: /^https:\/\//.test(b.link || '') ? str(b.link, 4000) : '',
    comment: str(b.comment, 500), createdMs: Date.now()
  };
  if (!d.name || !d.from || !d.to || !Number.isFinite(d.whenMs)) return null;
  return d;
}

// ---------- live updates ----------
const clients = new Set();
function broadcast(collection) {
  const msg = `event: change\ndata: ${JSON.stringify({ collection })}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

// ---------- helpers ----------
function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > 64 * 1024) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const clientId = req => str(req.headers['x-client-id'] || '', 64) || null;

// Follow a maps.app.goo.gl redirect chain to the full google.com/maps URL.
async function resolveShort(url) {
  let u = new URL(url);
  for (let hop = 0; hop < 6; hop++) {
    if (/(^|\.)google\.[a-z.]+$/i.test(u.hostname) && u.pathname.startsWith('/maps')) return u.href;
    if (!/^(maps\.app\.goo\.gl|goo\.gl)$/i.test(u.hostname) && !/(^|\.)google\.[a-z.]+$/i.test(u.hostname)) return null;
    const r = await fetch(u.href, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (compatible; fetch-drives)' }, signal: AbortSignal.timeout(6000) });
    const loc = r.headers.get('location');
    if (!loc) return null;
    u = new URL(loc, u);
  }
  return null;
}

// Municipality around a point, from OpenStreetMap Nominatim (cached, ~1 km grid).
async function municipality(lat, lon) {
  const k = lat.toFixed(2) + ',' + lon.toFixed(2);
  const hit = db.prepare('SELECT v FROM geocache WHERE k = ?').get(k);
  if (hit) return JSON.parse(hit.v);
  const q = new URL('https://nominatim.openstreetmap.org/reverse');
  q.search = new URLSearchParams({ format: 'jsonv2', lat, lon, zoom: '10', addressdetails: '1' });
  const r = await fetch(q, { headers: { 'user-agent': UA, 'accept-language': 'hr,en' }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error('nominatim ' + r.status);
  const j = await r.json();
  const bb = (j.boundingbox || []).map(Number);
  const a = j.address || {};
  const out = {
    name: a.city || a.town || a.municipality || a.village || j.name || '',
    bounds: bb.length === 4 ? [[bb[0], bb[2]], [bb[1], bb[3]]] : null
  };
  db.prepare('INSERT OR REPLACE INTO geocache (k, v, at) VALUES (?, ?, ?)').run(k, JSON.stringify(out), Date.now());
  return out;
}

// Fastest driving route through the points, as [lat, lng] pairs. Cached in memory.
const routeCache = new Map();
async function drivingRoute(points) {
  const key = points.map(p => p[0].toFixed(5) + ',' + p[1].toFixed(5)).join(';');
  if (routeCache.has(key)) return routeCache.get(key);
  const coords = points.map(p => p[1].toFixed(6) + ',' + p[0].toFixed(6)).join(';');
  const r = await fetch(`${ROUTER}/route/v1/driving/${coords}?overview=full&geometries=geojson`,
    { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('router ' + r.status);
  const j = await r.json();
  const best = j.routes && j.routes[0];
  if (!best) return null;
  let line = best.geometry.coordinates.map(([lng, lat]) => [+lat.toFixed(5), +lng.toFixed(5)]);
  if (line.length > 3000) { const step = Math.ceil(line.length / 3000); line = line.filter((_, i) => i % step === 0 || i === line.length - 1); }
  const out = { route: line, distanceM: Math.round(best.distance), durationS: Math.round(best.duration) };
  if (routeCache.size > 500) routeCache.clear();
  routeCache.set(key, out);
  return out;
}
const drivePoints = d => d.fromLL && d.toLL ? [d.fromLL, ...(d.stopsLL || []), d.toLL] : null;
async function attachRoute(id, d) {
  const pts = drivePoints(d);
  if (!pts) return;
  try {
    const r = await drivingRoute(pts);
    if (!r) return;
    const row = db.prepare('SELECT body FROM drives WHERE id = ?').get(id);
    if (!row) return;
    db.prepare('UPDATE drives SET body = ? WHERE id = ?').run(JSON.stringify(Object.assign(JSON.parse(row.body), r)), id);
    broadcast('drives');
  } catch (e) { console.warn('route failed for', id, e.message); }
}

// ---------- routes ----------
async function api(req, res, url) {
  const p = url.pathname;
  if (p === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(': hi\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (p === '/api/drives' && req.method === 'GET') {
    const from = +url.searchParams.get('from') || 0, to = +url.searchParams.get('to') || 8.64e15;
    const rows = db.prepare('SELECT id, body FROM drives WHERE whenMs >= ? AND whenMs < ? ORDER BY whenMs LIMIT 1000').all(from, to);
    return send(res, 200, rows.map(r => Object.assign(JSON.parse(r.body), { id: r.id })));
  }
  if (p === '/api/drives' && req.method === 'POST') {
    const d = cleanDrive(await readBody(req), clientId(req));
    if (!d) return send(res, 400, { error: 'A drive needs a name, a start, a destination and a time.' });
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO drives (id, whenMs, uid, body) VALUES (?, ?, ?, ?)').run(id, d.whenMs, d.uid, JSON.stringify(d));
    broadcast('drives');
    attachRoute(id, d);
    return send(res, 201, { id });
  }
  let m = /^\/api\/drives\/([\w-]{1,64})$/.exec(p);
  if (m && req.method === 'DELETE') {
    const row = db.prepare('SELECT uid FROM drives WHERE id = ?').get(m[1]);
    if (!row) return send(res, 404, { error: 'Not found' });
    if (!row.uid || row.uid !== clientId(req)) return send(res, 403, { error: 'Only the person who shared a drive can delete it.' });
    db.prepare('DELETE FROM drives WHERE id = ?').run(m[1]);
    db.prepare('DELETE FROM replies WHERE driveId = ?').run(m[1]);
    broadcast('drives'); broadcast('replies');
    return send(res, 200, { ok: true });
  }
  if (p === '/api/replies' && req.method === 'GET') {
    const rows = db.prepare('SELECT id, body FROM replies WHERE driveId = ? ORDER BY createdMs LIMIT 200').all(str(url.searchParams.get('driveId'), 64));
    return send(res, 200, rows.map(r => Object.assign(JSON.parse(r.body), { id: r.id })));
  }
  if (p === '/api/replies' && req.method === 'POST') {
    const b = await readBody(req);
    const r = { driveId: str(b.driveId, 64), name: str(b.name, 40), uid: clientId(req), text: str(b.text, 300), createdMs: Date.now() };
    if (!r.driveId || !r.name || !r.text) return send(res, 400, { error: 'A message needs a name and some text.' });
    if (!db.prepare('SELECT 1 FROM drives WHERE id = ?').get(r.driveId)) return send(res, 404, { error: 'That drive no longer exists.' });
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO replies (id, driveId, createdMs, body) VALUES (?, ?, ?, ?)').run(id, r.driveId, r.createdMs, JSON.stringify(r));
    broadcast('replies');
    return send(res, 201, { id });
  }
  if (p === '/api/route' && req.method === 'GET') {
    const pts = str(url.searchParams.get('pts'), 2000).split(';').map(s => ll(s.split(',').map(Number))).filter(Boolean);
    if (pts.length < 2 || pts.length > 10) return send(res, 400, { error: 'Need 2 to 10 points' });
    try { const r = await drivingRoute(pts); return r ? send(res, 200, r) : send(res, 404, { error: 'No route found' }); }
    catch (e) { return send(res, 502, { error: 'Routing failed' }); }
  }
  if (p === '/api/resolve' && req.method === 'GET') {
    try {
      const full = await resolveShort(str(url.searchParams.get('url'), 2000));
      return full ? send(res, 200, { url: full }) : send(res, 422, { error: 'Could not open that short link.' });
    } catch (e) { return send(res, 502, { error: 'Could not reach Google Maps to open that short link.' }); }
  }
  if (p === '/api/municipality' && req.method === 'GET') {
    const lat = +url.searchParams.get('lat'), lon = +url.searchParams.get('lon');
    if (!isFinite(lat) || !isFinite(lon)) return send(res, 400, { error: 'lat and lon required' });
    try { return send(res, 200, await municipality(lat, lon)); }
    catch (e) { return send(res, 502, { error: 'Lookup failed' }); }
  }
  return send(res, 404, { error: 'Not found' });
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: 'Something went wrong on the server.' });
  }
}).listen(PORT, () => console.log('Fetch listening on :' + PORT));
