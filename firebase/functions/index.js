// Opens short maps.app.goo.gl links and returns the full google.com/maps URL,
// which the page can read. Served at /api/resolve through a Hosting rewrite.
// Needs the Blaze plan, because it calls out to Google.
const { onRequest } = require('firebase-functions/v2/https');

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

exports.resolve = onRequest({ region: 'europe-west1', maxInstances: 3, memory: '128MiB' }, async (req, res) => {
  res.set('cache-control', 'no-store');
  try {
    const full = await resolveShort(String(req.query.url || '').slice(0, 2000));
    if (full) res.json({ url: full });
    else res.status(422).json({ error: 'Could not open that short link.' });
  } catch (e) {
    res.status(502).json({ error: 'Could not reach Google Maps to open that short link.' });
  }
});
