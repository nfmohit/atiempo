// ATiempo live-times relay for Cloudflare Workers (free plan is plenty).
// The browser can't read TUA's live API from another website (no CORS headers), so this
// fetches it server-side and adds them. Only the estimaciones endpoint is relayed.
const TUA = 'https://www.tua.es/rest/estimaciones/';
const ALLOWED_ORIGINS = ['https://nfmohit.github.io', 'http://localhost:8080'];
const CACHE_SECONDS = 15;

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
    const key = new Request(`https://cache.atiempo/${m[1]}`);
    const hit = await cache.match(key);
    if (hit) return new Response(hit.body, { headers: { ...Object.fromEntries(hit.headers), ...cors } });

    const r = await fetch(TUA + m[1], { headers: { accept: 'application/json', 'user-agent': 'ATiempo/0.1 (trip planner; https://github.com/nfmohit/atiempo)' } });
    const text = await r.text();
    try { JSON.parse(text); } catch {
      return json({ error: 'TUA did not return live data (its bot protection may be blocking this relay)', status: r.status }, 502, cors);
    }
    const res = new Response(text, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${CACHE_SECONDS}` } });
    ctx.waitUntil(cache.put(key, res.clone()));
    return new Response(text, { headers: { 'content-type': 'application/json; charset=utf-8', ...cors } });
  },
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}
