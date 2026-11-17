// gOviedo live-times relay for Cloudflare Workers (free plan is plenty).
// The browser can't read TUA's live API from another website (no CORS headers), so this
// fetches it server-side and adds them. Only the estimaciones endpoint is relayed.
//
// TUA's bot protection sometimes refuses a request (Cloudflare reports 520). We retry once,
// and if that fails too we return the last good answer for that stop when it's under
// STALE_SECONDS old. Every answer carries "fetchedAt" (ms) so the app can correct the
// countdowns for its age.
const TUA = 'https://www.tua.es/rest/estimaciones/';
const ALLOWED_ORIGINS = ['https://nfmohit.github.io', 'http://localhost:8080'];
const FRESH_SECONDS = 15;
const STALE_SECONDS = 120;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('origin') || '';
    const cors = {
      'access-control-allow-origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'access-control-allow-methods': 'GET, OPTIONS',
      vary: 'origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const m = new URL(request.url).pathname.match(/^\/estimaciones\/(\d{1,6})$/);
    if (request.method !== 'GET' || !m) return json({ error: 'use /estimaciones/<stop number>' }, 404, cors);

    const cache = caches.default;
    const key = new Request(`https://cache.goviedo/${m[1]}`);
    const cached = await cache.match(key).then(r => r && r.json()).catch(() => null);
    const age = cached ? (Date.now() - cached.fetchedAt) / 1000 : Infinity;
    if (age < FRESH_SECONDS) return json(cached, 200, cors);

    let lastStatus = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, 400));
      try {
        const r = await fetch(TUA + m[1], { headers: { accept: 'application/json', 'user-agent': 'gOviedo/0.1 (trip planner; https://github.com/nfmohit/goviedo)' } });
        lastStatus = r.status;
        const body = JSON.parse(await r.text());
        body.fetchedAt = Date.now();
        ctx.waitUntil(cache.put(key, new Response(JSON.stringify(body), { headers: { 'cache-control': `public, max-age=${STALE_SECONDS}` } })));
        return json(body, 200, cors);
      } catch { /* not JSON or network error: retry */ }
    }
    if (age < STALE_SECONDS) return json({ ...cached, stale: true }, 200, cors);
    return json({ error: 'TUA did not return live data (its bot protection may be blocking this relay)', status: lastStatus }, 502, cors);
  },
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}
