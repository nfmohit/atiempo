// Ovibus server: serves the web app and relays TUA live arrivals.
// No dependencies. Run: node server.js  (PORT defaults to 8080)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 8080);
const ROOT = fileURLToPath(new URL('./public/', import.meta.url));
const TUA_BASE = process.env.TUA_BASE || 'https://www.tua.es/rest/estimaciones/';
const CACHE_MS = 15000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const cache = new Map();

async function live(stopId, res) {
  if (!/^\d{1,6}$/.test(stopId)) return send(res, 400, { error: 'bad stop id' });
  const hit = cache.get(stopId);
  if (hit && Date.now() - hit.at < CACHE_MS) return send(res, 200, hit.body);
  try {
    const r = await fetch(TUA_BASE + stopId, { headers: { accept: 'application/json', 'user-agent': 'Ovibus/0.1 (trip planner prototype)' }, signal: AbortSignal.timeout(8000) });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { return send(res, 502, { error: 'TUA did not return JSON (it may be blocking this server)', status: r.status }); }
    cache.set(stopId, { at: Date.now(), body });
    send(res, 200, body);
  } catch (e) {
    send(res, 502, { error: String(e.message || e) });
  }
}

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(/^\/api\/estimaciones\/([^/]+)$/);
  if (m) return live(m[1], res);
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (path.endsWith('/')) path += 'index.html';
  const file = join(ROOT, path);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  try {
    await stat(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}).listen(PORT, () => console.log(`Ovibus on http://localhost:${PORT}`));
