import { Network, parseEstimaciones, liveForLeg, directionCode, MIN_TRANSFER_S } from './router.js';

// ---------- Config ----------
const OVIEDO = [43.3614, -5.8494];
// Live arrivals: our own server relays TUA first; if that fails we try TUA directly from the browser.
const LIVE_SOURCES = ['api/estimaciones/', 'https://www.tua.es/rest/estimaciones/'];
const GEOCODER = 'https://nominatim.openstreetmap.org/search';
const FOOT_ROUTER = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/';
const LINE_COLORS = { A: '#1d4ed8', B: '#b91c1c', C: '#15803d', D: '#7c3aed', E: '#c2410c', F: '#0e7490', G: '#a16207', H: '#be185d', J: '#4d7c0f', K: '#0369a1', L: '#9333ea', M: '#0f766e', O: '#b45309', U: '#475569', V: '#e11d48', BUH: '#111827' };
const lineColor = l => LINE_COLORS[l] || '#334155';

// ---------- Helpers ----------
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hhmm = s => { s = Math.round(s); const d = ((s % 86400) + 86400) % 86400; return `${String(Math.floor(d / 3600)).padStart(2, '0')}:${String(Math.floor(d / 60) % 60).padStart(2, '0')}`; };
const mins = s => Math.max(0, Math.round(s / 60));
const dist = m => m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;

// Current date and time in Oviedo, whatever the phone's time zone.
function madridNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(p => [p.type, p.value]));
  return { date: `${parts.year}${parts.month}${parts.day}`, iso: `${parts.year}-${parts.month}-${parts.day}`, secs: +parts.hour * 3600 + +parts.minute * 60 + +parts.second };
}

function storage(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* private mode */ } }

// ---------- State ----------
let net, stopMap = {};
const userStopMap = storage('ovibus.stopMap', {});
const state = { from: null, to: null, results: [], selected: -1 };

// ---------- Map ----------
const map = L.map('map', { zoomControl: false }).setView(OVIEDO, 14);
L.control.zoom({ position: 'topright' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const stopLayer = L.layerGroup();
const pinIcon = cls => L.divIcon({ className: '', html: `<div class="pin ${cls}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
let fromMarker = null, toMarker = null;

function setPlace(which, place, { fit = true } = {}) {
  state[which] = place;
  $(`#${which}`).value = place ? place.label : '';
  const m = which === 'from' ? fromMarker : toMarker;
  if (m) map.removeLayer(m);
  const nm = place ? L.marker([place.lat, place.lon], { icon: pinIcon(which), draggable: true }).addTo(map) : null;
  if (nm) nm.on('dragend', e => { const ll = e.target.getLatLng(); setPlace(which, { lat: ll.lat, lon: ll.lng, label: 'Dropped pin' }, { fit: false }); search(); });
  if (which === 'from') fromMarker = nm; else toMarker = nm;
  if (fit && state.from && state.to) map.fitBounds(L.latLngBounds([[state.from.lat, state.from.lon], [state.to.lat, state.to.lon]]).pad(0.3));
}

map.on('click', e => {
  const which = state.to && !state.from ? 'from' : 'to';
  setPlace(which, { lat: e.latlng.lat, lon: e.latlng.lng, label: 'Point on map' }, { fit: false });
  search();
});

// Bus stops appear when zoomed in; tap one for live arrivals.
function drawStops() {
  stopLayer.clearLayers();
  for (const s of net.stops) {
    L.circleMarker([s.lat, s.lon], { radius: 5, color: '#0b5c4b', weight: 2, fillColor: '#fff', fillOpacity: 1 })
      .bindPopup(() => stopPopup(s), { maxWidth: 260 })
      .addTo(stopLayer);
  }
}
map.on('zoomend', () => { if (map.getZoom() >= 16) stopLayer.addTo(map); else map.removeLayer(stopLayer); });

function stopPopup(stop) {
  const el = document.createElement('div');
  const lines = [...new Set(net.stopPatterns[stop.i].map(([pi]) => net.patterns[pi].line))].sort();
  el.innerHTML = `<strong>${esc(stop.name)}</strong><div>${lines.map(l => `<span class="chip" style="background:${lineColor(l)}">${esc(l)}</span>`).join(' ')}</div><div class="popup-body sched">Loading live times…</div>`;
  const body = el.querySelector('.popup-body');
  const tuaId = tuaStopIds(stop);
  if (!tuaId.length) {
    body.innerHTML = '';
    body.appendChild(stopNumberEditor(stop, () => map.closePopup()));
    return el;
  }
  fetchLiveMany(tuaId).then(arr => {
    if (!arr.length) { body.textContent = 'No buses on their way right now.'; return; }
    body.className = 'popup-body';
    body.innerHTML = `<ul class="popup-live">${arr.sort((a, b) => a.seconds - b.seconds).map(a => `<li><span class="chip" style="background:${lineColor(a.line)}">${esc(a.line)}</span> ${esc(a.destino)} <span class="live">${mins(a.seconds)} min</span></li>`).join('')}</ul><div class="sched">TUA stop ${esc(tuaLabel(tuaId))}</div>`;
  }).catch(err => { body.textContent = `Live times unavailable: ${err.message}`; });
  return el;
}

// ---------- TUA stop numbers ----------
// The timetable's stop ids differ from TUA's own stop numbers, so we keep a mapping.
// A timetable stop can stand for several TUA stops (e.g. HUCA1 and HUCA2), so this returns a list.
function tuaStopIds(stop) {
  const v = userStopMap[stop.id] || stopMap[stop.id];
  return v ? [].concat(v).map(String) : [];
}
const tuaLabel = ids => ids.join(' / ');

async function fetchLiveMany(ids) {
  const lists = await Promise.allSettled(ids.map(fetchLive));
  const ok = lists.filter(r => r.status === 'fulfilled');
  if (!ok.length) throw lists[0].reason;
  return ok.flatMap(r => r.value);
}

function stopNumberEditor(stop, onSaved) {
  const box = document.createElement('div');
  box.className = 'stopno';
  box.innerHTML = `<div class="sub">Live times need TUA's stop number (shown in the TUA app). Enter it once and it's remembered.</div>
    <input inputmode="numeric" pattern="[0-9]*" placeholder="e.g. 5019" aria-label="TUA stop number"> <button type="button">Save</button>`;
  const input = box.querySelector('input');
  input.value = userStopMap[stop.id] || '';
  box.querySelector('button').addEventListener('click', e => {
    e.stopPropagation();
    const v = input.value.trim();
    if (v && !/^\d{1,6}$/.test(v)) { input.setCustomValidity('Numbers only'); input.reportValidity(); return; }
    if (v) userStopMap[stop.id] = v; else delete userStopMap[stop.id];
    save('ovibus.stopMap', userStopMap);
    onSaved?.();
    refreshLive();
  });
  box.addEventListener('click', e => e.stopPropagation());
  return box;
}

// ---------- Live arrivals ----------
const liveCache = new Map();
let liveSourceIdx = 0;
async function fetchLive(tuaId) {
  const hit = liveCache.get(tuaId);
  if (hit && Date.now() - hit.at < 20000) return hit.data;
  let lastErr;
  for (let k = 0; k < LIVE_SOURCES.length; k++) {
    const idx = (liveSourceIdx + k) % LIVE_SOURCES.length;
    try {
      const r = await fetch(LIVE_SOURCES[idx] + encodeURIComponent(tuaId), { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const fetchedAt = madridNow().secs;
      const data = parseEstimaciones(await r.json()).map(a => ({ ...a, fetchedAt }));
      liveSourceIdx = idx;
      liveCache.set(tuaId, { at: Date.now(), data });
      return data;
    } catch (e) { lastErr = e; }
  }
  throw new Error(lastErr?.message || 'no source');
}

/**
 * Re-time an itinerary with live data. For each bus leg whose stop has a TUA number, find the
 * live bus of that line and direction that is closest to the scheduled time and still catchable.
 */
async function applyLive(it, now) {
  const result = { legs: [], leaveBy: null, ok: true, notes: [] };
  let ready = now.secs + it.legs.slice(0, it.legs.findIndex(l => l.type === 'bus')).reduce((a, l) => a + l.seconds, 0);
  let shift = 0; // delay carried from the previous bus
  let first = true;
  for (const leg of it.legs) {
    if (leg.type !== 'bus') { result.legs.push(null); continue; }
    const stop = net.stops[leg.from.stop];
    const tuaId = tuaStopIds(stop);
    const info = { scheduled: leg.depart, live: null, tuaId: tuaId.length ? tuaId : null };
    if (tuaId.length && leg.depart - now.secs < 3 * 3600) {
      try {
        const arr = liveForLeg(leg, await fetchLiveMany(tuaId));
        const cands = arr.map(a => ({ ...a, at: a.fetchedAt + a.seconds }));
        const earliest = first ? now.secs : ready;
        // Work out which timetabled trip each live bus is. Buses run late more often than early,
        // so being early counts double. A live bus is ours only if our trip is its best match.
        const sched = net.scheduledAt(leg.pattern, leg.boardPos, now.date, now.secs - 3600, now.secs + 3 * 3600);
        const tripOf = c => {
          let best = null, bestCost = Infinity;
          for (const s of sched) { const d = c.at - s.t, cost = d >= 0 ? d : -2 * d; if (cost < bestCost) { bestCost = cost; best = s.trip; } }
          return best;
        };
        const mine = cands.filter(c => tripOf(c) === leg.trip);
        if (mine.length) {
          info.live = mine[0];
          if (info.live.at < earliest - 30) { info.missed = true; info.live = null; }
        }
      } catch (e) { info.error = e.message; }
    }
    const dep = info.live ? info.live.at : leg.depart + shift;
    if (!first && dep < ready) { result.ok = false; result.notes.push(`The change to line ${leg.line} at ${stop.name} looks tight.`); }
    const delay = dep - leg.depart;
    info.depart = dep;
    info.arrive = leg.arrive + delay;
    shift = delay;
    ready = info.arrive + MIN_TRANSFER_S;
    if (first) {
      const walkBefore = it.legs.slice(0, it.legs.indexOf(leg)).reduce((a, l) => a + l.seconds, 0);
      result.leaveBy = dep - walkBefore;
      first = false;
    }
    result.legs.push(info);
  }
  const lastBus = [...result.legs].reverse().find(Boolean);
  const tailWalk = it.legs.slice(result.legs.lastIndexOf(lastBus) + 1).reduce((a, l) => a + l.seconds, 0);
  result.arrive = lastBus.arrive + tailWalk;
  result.anyLive = result.legs.some(l => l?.live);
  return result;
}

// ---------- Geocoding ----------
let suggestTimer, suggestFor = null, suggestions = [];
async function geocode(q) {
  const u = new URL(GEOCODER);
  u.search = new URLSearchParams({ q, format: 'jsonv2', limit: '6', countrycodes: 'es', viewbox: '-5.98,43.43,-5.72,43.30', bounded: '1', 'accept-language': 'es,en' });
  const r = await fetch(u);
  if (!r.ok) throw new Error(`search failed (${r.status})`);
  return (await r.json()).map(p => ({ lat: +p.lat, lon: +p.lon, label: p.name || p.display_name.split(',')[0], detail: p.display_name.split(',').slice(1, 4).join(',').trim() }));
}

function localStopMatches(q) {
  const n = q.toLowerCase();
  const seen = new Set();
  return net.stops.filter(s => s.name.toLowerCase().includes(n) && !seen.has(s.name) && seen.add(s.name)).slice(0, 3)
    .map(s => ({ lat: s.lat, lon: s.lon, label: s.name, detail: 'Bus stop' }));
}

function showSuggestions(which, list) {
  suggestFor = which; suggestions = list;
  const ul = $('#suggest');
  ul.style.top = which === 'from' ? '48px' : '96px';
  ul.innerHTML = list.map((p, i) => `<li role="option" data-i="${i}">${esc(p.label)}<small>${esc(p.detail || '')}</small></li>`).join('') || '<li aria-disabled="true">No matches in Oviedo</li>';
  ul.hidden = false;
}
$('#suggest').addEventListener('mousedown', e => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  e.preventDefault();
  setPlace(suggestFor, suggestions[+li.dataset.i]);
  $('#suggest').hidden = true;
  search();
});
for (const which of ['from', 'to']) {
  const input = $(`#${which}`);
  input.addEventListener('input', () => {
    clearTimeout(suggestTimer);
    const q = input.value.trim();
    if (q.length < 3) { $('#suggest').hidden = true; return; }
    suggestTimer = setTimeout(async () => {
      const local = localStopMatches(q);
      showSuggestions(which, local);
      try { showSuggestions(which, [...(await geocode(q)), ...local]); } catch { /* keep local */ }
    }, 350);
  });
  input.addEventListener('blur', () => setTimeout(() => { $('#suggest').hidden = true; }, 150));
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && suggestFor === which && suggestions[0]) { e.preventDefault(); setPlace(which, suggestions[0]); $('#suggest').hidden = true; search(); } });
}

// ---------- Location ----------
function locate(thenSearch = true) {
  if (!navigator.geolocation) { status('Location is not available on this device. Tap the map or type a starting point.', true); return; }
  status('Finding you…');
  navigator.geolocation.getCurrentPosition(pos => {
    setPlace('from', { lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'My location' }, { fit: !!state.to });
    if (!state.to) map.setView([pos.coords.latitude, pos.coords.longitude], 15);
    status('');
    if (thenSearch) search();
  }, () => status('Could not get your location. Type a starting point or tap the map.', true), { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
}
$('#locate').addEventListener('click', () => locate());
$('#swap').addEventListener('click', () => { const f = state.from, t = state.to; setPlace('from', t); setPlace('to', f); search(); });
$('#when').addEventListener('change', () => {
  const at = $('#when').value === 'at';
  $('#time').hidden = $('#date').hidden = !at;
  if (at && !$('#time').value) { const n = madridNow(); $('#time').value = hhmm(n.secs); $('#date').value = n.iso; }
  search();
});
$('#time').addEventListener('change', search);
$('#date').addEventListener('change', search);
$('#search').addEventListener('submit', e => { e.preventDefault(); search(); });

// ---------- Planning ----------
function status(msg, error = false) { const s = $('#status'); s.textContent = msg; s.classList.toggle('error', error); }

function departureTime() {
  const now = madridNow();
  if ($('#when').value === 'at' && $('#time').value) {
    const [h, m] = $('#time').value.split(':').map(Number);
    return { date: ($('#date').value || now.iso).replaceAll('-', ''), secs: h * 3600 + m * 60, live: false };
  }
  return { ...now, live: true };
}

async function search() {
  if (!state.to) return;
  if (!state.from) { locate(true); return; }
  $('#detail').hidden = true; $('#results').hidden = false;
  routeLayer.clearLayers();
  const when = departureTime();
  if (!net.services[when.date]) {
    status('The timetable data does not cover that date yet. Try another day, or update the data.', true);
    $('#results').innerHTML = '';
    return;
  }
  const { itineraries, walkOnly } = net.plan(state.from, state.to, when.secs, when.date, { count: 5 });
  state.results = itineraries.map(it => ({ it, live: null }));
  state.when = when;
  if (!itineraries.length) {
    status(walkOnly.meters < 2500 ? `No useful bus found. Walking takes about ${mins(walkOnly.seconds)} min (${dist(walkOnly.meters)}).` : 'No bus trip found for that time.', !itineraries.length && walkOnly.meters >= 2500);
    $('#results').innerHTML = '';
    return;
  }
  status(walkOnly.meters < 1500 ? `Walking the whole way takes about ${mins(walkOnly.seconds)} min.` : '');
  renderResults();
  setPanel('expanded');
  if (when.live) refreshLive();
}

async function refreshLive() {
  const when = state.when;
  if (!when?.live) return;
  const now = madridNow();
  await Promise.all(state.results.map(async r => { r.live = await applyLive(r.it, now); }));
  // Re-rank by live arrival.
  state.results.sort((a, b) => (a.live?.arrive ?? a.it.arrive) - (b.live?.arrive ?? b.it.arrive));
  // If a bus is running late, it can replace an earlier option entirely; show only real choices.
  const seenOpt = new Set();
  state.results = state.results.filter(r => {
    if (r.live?.legs.some(l => l?.missed)) return false;
    const k = `${r.it.key}|${r.live?.leaveBy ?? r.it.depart}`;
    if (seenOpt.has(k)) return false;
    seenOpt.add(k);
    return true;
  });
  renderResults();
  if (state.selected >= 0 && !$('#detail').hidden) renderDetail(state.selected);
}
setInterval(() => { if (state.results.length && state.when?.live) { liveCache.clear(); refreshLive(); } }, 30000);

function legChips(it) {
  return it.legs.map(l => l.type === 'bus'
    ? `<span class="chip" style="background:${lineColor(l.line)}">${esc(l.line)}</span>`
    : `<span title="walk">🚶${mins(l.seconds)}</span>`).join('<span aria-hidden="true">›</span>');
}

function renderResults() {
  const now = madridNow();
  $('#results').innerHTML = state.results.map(({ it, live }, i) => {
    const dep = live?.leaveBy ?? it.depart, arr = live?.arrive ?? it.arrive;
    let leave = '';
    if (state.when.live) {
      const inS = dep - now.secs;
      leave = inS <= 30 ? '<strong>Leave now</strong>' : `Leave in <strong>${mins(inS)} min</strong>`;
    } else leave = `Leave at <strong>${hhmm(dep)}</strong>`;
    const firstBus = live?.legs.find(Boolean);
    let liveTxt = '';
    if (firstBus?.live) {
      const d = Math.round((firstBus.depart - firstBus.scheduled) / 60);
      liveTxt = ` · <span class="live">live</span> ${d === 0 ? 'on time' : d > 0 ? `<span class="late">${d} min late</span>` : `${-d} min early`}`;
    } else if (state.when.live && firstBus) liveTxt = ' · <span class="sched">timetable time</span>';
    return `<li data-i="${i}" class="${i === state.selected ? 'selected' : ''}">
      <div class="it-top"><span class="it-times">${hhmm(dep)} → ${hhmm(arr)}</span><span class="it-dur">${mins(arr - dep)} min</span></div>
      <div class="it-legs">${legChips(it)}</div>
      <div class="it-leave">${leave}${liveTxt}</div>
      ${live && !live.ok ? `<div class="warn">${esc(live.notes[0])}</div>` : ''}
    </li>`;
  }).join('');
}
$('#results').addEventListener('click', e => {
  const li = e.target.closest('li[data-i]');
  if (li) { state.selected = +li.dataset.i; renderDetail(state.selected); }
});

// ---------- Itinerary detail ----------
async function walkRoute(a, b) {
  try {
    const r = await fetch(`${FOOT_ROUTER}${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson&steps=true`);
    if (!r.ok) throw 0;
    const j = await r.json();
    const route = j.routes?.[0];
    if (!route) throw 0;
    const steps = route.legs[0].steps.map(describeStep).filter(Boolean);
    return { coords: route.geometry.coordinates.map(([x, y]) => [y, x]), steps, meters: route.distance };
  } catch {
    return { coords: [[a.lat, a.lon], [b.lat, b.lon]], steps: [], meters: null };
  }
}
function describeStep(s) {
  const name = s.name ? ` onto ${s.name}` : '';
  const m = s.maneuver, mod = m.modifier ? m.modifier.replace('slight ', 'slightly ').replace('sharp ', 'sharp ') : '';
  const d = s.distance ? ` (${dist(s.distance)})` : '';
  switch (m.type) {
    case 'depart': return `Head ${bearingWord(m.bearing_after)}${s.name ? ` on ${s.name}` : ''}${d}`;
    case 'arrive': return 'Arrive';
    case 'turn': case 'end of road': case 'fork': return `Turn ${mod}${name}${d}`;
    case 'roundabout': case 'rotary': return `At the roundabout, take exit ${m.exit || ''}${name}${d}`;
    case 'continue': case 'new name': return `Continue${name}${d}`;
    default: return s.distance > 5 ? `${mod ? `Go ${mod}` : 'Continue'}${name}${d}` : null;
  }
}
function bearingWord(b = 0) { return ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'][Math.round(b / 45) % 8]; }

function pointOf(end) { return end.place ? end.place : net.stops[end.stop]; }
function nameOf(end, which) { return end.place ? (which === 'from' ? state.from.label : state.to.label) : net.stops[end.stop].name; }

async function renderDetail(i) {
  const { it, live } = state.results[i];
  renderResults();
  routeLayer.clearLayers();
  const bounds = L.latLngBounds([]);
  const box = $('#detail');
  $('#results').hidden = true;
  box.hidden = false;
  const busInfo = j => live?.legs[j];
  const html = [`<button class="back" type="button">‹ All options</button><ol class="steps">`];
  let t = live?.leaveBy ?? it.depart;
  it.legs.forEach((leg, j) => {
    if (leg.type === 'walk') {
      const to = nameOf(leg.to, 'to');
      html.push(`<li class="step"><span class="t">${hhmm(t)}</span><div class="what">🚶 Walk to <strong>${esc(to)}</strong><div class="sub">about ${mins(leg.seconds)} min, ${dist(leg.meters)}</div><details data-walk="${j}"><summary>Directions</summary><ol><li>Loading…</li></ol></details></div></li>`);
      t += leg.seconds;
    } else {
      const info = busInfo(j);
      const dep = info?.depart ?? leg.depart, arr = info?.arrive ?? leg.arrive;
      const stop = net.stops[leg.from.stop];
      let liveLine = '';
      if (info?.live) {
        const d = Math.round((info.depart - leg.depart) / 60);
        liveLine = `<div class="sub"><span class="live">live</span> bus is ${dist(info.live.meters)} away · timetable ${hhmm(leg.depart)}${d ? ` (${d > 0 ? '+' : ''}${d} min)` : ''}</div>`;
      } else if (info?.error) liveLine = `<div class="sub">Live times unavailable (${esc(info.error)}). Showing timetable.</div>`;
      else if (state.when.live) liveLine = '<div class="sub">Timetable time (no live match yet)</div>';
      html.push(`<li class="step"><span class="t">${hhmm(dep)}</span><div class="what"><span class="chip" style="background:${lineColor(leg.line)}">${esc(leg.line)}</span> <strong>${esc(leg.headsign)}</strong><div class="sub">Board at ${esc(stop.name)} · ${leg.numStops} stop${leg.numStops === 1 ? '' : 's'} · get off at ${esc(net.stops[leg.to.stop].name)} (${hhmm(arr)})</div>${liveLine}<div data-stopno="${leg.from.stop}"></div></div></li>`);
      t = arr;
    }
  });
  html.push(`<li class="step"><span class="t">${hhmm(live?.arrive ?? it.arrive)}</span><div class="what">📍 Arrive at <strong>${esc(state.to.label)}</strong></div></li></ol>`);
  if (live && !live.ok) html.push(`<div class="warn">${esc(live.notes.join(' '))}</div>`);
  box.innerHTML = html.join('');
  box.querySelector('.back').addEventListener('click', () => { box.hidden = true; $('#results').hidden = false; state.selected = -1; routeLayer.clearLayers(); renderResults(); });
  // Stop-number editors for boarding stops without a TUA number.
  box.querySelectorAll('[data-stopno]').forEach(el => {
    const stop = net.stops[+el.dataset.stopno];
    if (tuaStopIds(stop).length) { el.innerHTML = `<div class="stopno sub">TUA stop ${esc(tuaLabel(tuaStopIds(stop)))}</div>`; return; }
    if (state.when.live) el.appendChild(stopNumberEditor(stop));
  });

  // Map: bus legs along their route shape, walking legs from the foot router.
  for (const [j, leg] of it.legs.entries()) {
    if (leg.type === 'bus') {
      const p = net.patterns[leg.pattern];
      const a = net.stops[leg.from.stop], b = net.stops[leg.to.stop];
      const coords = sliceShape(p.shape, a, b) || p.stops.slice(leg.boardPos, leg.alightPos + 1).map(s => [net.stops[s].lat, net.stops[s].lon]);
      L.polyline(coords, { color: lineColor(leg.line), weight: 6, opacity: 0.9 }).addTo(routeLayer);
      for (const s of [a, b]) L.circleMarker([s.lat, s.lon], { radius: 6, color: lineColor(leg.line), fillColor: '#fff', fillOpacity: 1, weight: 3 }).bindTooltip(s.name).addTo(routeLayer);
      coords.forEach(c => bounds.extend(c));
    }
  }
  map.fitBounds(bounds.extend([state.from.lat, state.from.lon]).extend([state.to.lat, state.to.lon]).pad(0.15));
  for (const [j, leg] of it.legs.entries()) {
    if (leg.type !== 'walk') continue;
    const w = await walkRoute(pointOf(leg.from), pointOf(leg.to));
    if (state.selected !== i) return;
    L.polyline(w.coords, { color: '#2563eb', weight: 4, dashArray: '2 8', lineCap: 'round' }).addTo(routeLayer);
    const det = box.querySelector(`[data-walk="${j}"] ol`);
    if (det) det.innerHTML = w.steps.length ? w.steps.map(s => `<li>${esc(s)}</li>`).join('') : '<li>Walk directions unavailable; the dotted line shows the general direction.</li>';
  }
}

// Part of a route shape between two stops (nearest shape points to each stop).
function sliceShape(shape, a, b) {
  if (!shape?.length) return null;
  const near = (s, from) => { let bi = from, bd = Infinity; for (let k = from; k < shape.length; k++) { const d = (shape[k][0] - s.lat) ** 2 + (shape[k][1] - s.lon) ** 2; if (d < bd) { bd = d; bi = k; } } return bi; };
  const i = near(a, 0), j = near(b, i);
  return j > i ? shape.slice(i, j + 1) : null;
}

// ---------- Bottom sheet on phones ----------
function setPanel(mode) { const p = $('#panel'); p.classList.toggle('collapsed', mode === 'collapsed'); p.classList.toggle('expanded', mode === 'expanded'); }
$('#grip').addEventListener('click', () => setPanel($('#panel').classList.contains('collapsed') ? 'expanded' : 'collapsed'));

// ---------- Boot ----------
(async function boot() {
  status('Loading timetable…');
  try {
    const [data, sm] = await Promise.all([
      fetch('data/tua.json').then(r => r.json()),
      fetch('data/stop-map.json').then(r => r.ok ? r.json() : {}).catch(() => ({})),
    ]);
    net = new Network(data);
    stopMap = sm;
    window.ovibus = { net, state }; // handy for debugging
    drawStops();
    status('');
    locate(false);
  } catch (e) {
    status(`Could not load the timetable: ${e.message}`, true);
  }
})();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
