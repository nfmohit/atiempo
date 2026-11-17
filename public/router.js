// ATiempo trip planner: a small RAPTOR router over the TUA timetable.
// Works in the browser and in Node (for tests). No dependencies.

export const WALK_SPEED = 1.25; // m/s, about 4.5 km/h
export const WALK_DETOUR = 1.3; // straight-line distance to street distance
export const MAX_ACCESS_M = 1000; // how far we look for a first/last stop
export const MAX_TRANSFER_M = 350; // walking between stops when changing bus
export const MIN_TRANSFER_S = 60; // buffer when changing bus

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function walkSeconds(meters) {
  return Math.round((meters * WALK_DETOUR) / WALK_SPEED);
}

export class Network {
  constructor(data) {
    this.stops = data.stops.map(([id, name, lat, lon], i) => ({ i, id, name, lat, lon }));
    this.patterns = data.patterns.map((p, i) => ({ ...p, i }));
    this.services = data.services;
    // Patterns serving each stop, with the stop's position in the pattern.
    this.stopPatterns = this.stops.map(() => []);
    for (const p of this.patterns) p.stops.forEach((s, pos) => this.stopPatterns[s].push([p.i, pos]));
    // Footpaths between nearby stops.
    this.footpaths = this.stops.map(() => []);
    for (const a of this.stops) {
      for (const b of this.stops) {
        if (a.i === b.i) continue;
        const d = haversine(a.lat, a.lon, b.lat, b.lon);
        if (d <= MAX_TRANSFER_M) this.footpaths[a.i].push([b.i, walkSeconds(d), Math.round(d * WALK_DETOUR)]);
      }
    }
  }

  stopsNear(lat, lon, maxM = MAX_ACCESS_M) {
    const out = [];
    for (const s of this.stops) {
      const d = haversine(lat, lon, s.lat, s.lon);
      if (d <= maxM) out.push([s.i, walkSeconds(d), Math.round(d * WALK_DETOUR)]);
    }
    return out;
  }

  activeServices(yyyymmdd) {
    return new Set(this.services[yyyymmdd] || []);
  }

  // Earliest trip of pattern p leaving position pos at or after time t.
  earliestTrip(p, pos, t, active) {
    let best = -1, bestT = Infinity;
    p.trips.forEach((trip, k) => {
      if (!active.has(trip[0])) return;
      const dep = trip[pos + 1];
      if (dep >= t && dep < bestT) { bestT = dep; best = k; }
    });
    return best;
  }

  /**
   * Plan from origin to destination departing at `depart` seconds after midnight on `date` (YYYYMMDD).
   * Returns itineraries, one per number of buses used (Pareto: fewer buses vs earlier arrival).
   */
  raptor(origin, dest, depart, date, maxRounds = 3) {
    const active = this.activeServices(date);
    const n = this.stops.length;
    const access = this.stopsNear(origin.lat, origin.lon);
    const egress = new Map(this.stopsNear(dest.lat, dest.lon).map(([s, t, m]) => [s, [t, m]]));
    const best = new Array(n).fill(Infinity);
    const rounds = []; // rounds[k][s] = {t, label}
    let r0 = new Array(n).fill(null);
    let marked = new Set();
    for (const [s, t, m] of access) {
      r0[s] = { t: depart + t, label: { type: 'access', walkS: t, walkM: m } };
      best[s] = depart + t;
      marked.add(s);
    }
    rounds.push(r0);
    const results = [];
    const directM = Math.round(haversine(origin.lat, origin.lon, dest.lat, dest.lon) * WALK_DETOUR);
    let bestDest = depart + walkSeconds(directM / WALK_DETOUR);

    for (let k = 1; k <= maxRounds && marked.size; k++) {
      const prev = rounds[k - 1];
      // Labels carry over between rounds so later rounds can board where earlier rounds arrived.
      const cur = prev.slice();
      // Collect patterns to scan, from the earliest marked stop on each.
      const queue = new Map();
      for (const s of marked) {
        for (const [pi, pos] of this.stopPatterns[s]) {
          const q = queue.get(pi);
          if (q === undefined || pos < q) queue.set(pi, pos);
        }
      }
      marked = new Set();
      for (const [pi, startPos] of queue) {
        const p = this.patterns[pi];
        let trip = -1, boardPos = -1, boardStop = -1;
        for (let pos = startPos; pos < p.stops.length; pos++) {
          const s = p.stops[pos];
          if (trip >= 0) {
            const arr = p.trips[trip][pos + 1];
            if (arr < Math.min(best[s], bestDest)) {
              cur[s] = { t: arr, label: { type: 'bus', pattern: pi, trip, boardPos, alightPos: pos, from: boardStop } };
              best[s] = arr;
              marked.add(s);
            }
          }
          // Can we catch an earlier trip here?
          const ready = prev[s] ? prev[s].t + (k > 1 ? MIN_TRANSFER_S : 0) : Infinity;
          if (ready < Infinity && (trip < 0 || ready <= p.trips[trip][pos + 1])) {
            const t2 = this.earliestTrip(p, pos, ready, active);
            if (t2 >= 0 && (trip < 0 || p.trips[t2][pos + 1] < p.trips[trip][pos + 1])) {
              trip = t2; boardPos = pos; boardStop = s;
            }
          }
        }
      }
      // Walking transfers.
      for (const s of [...marked]) {
        for (const [s2, t, m] of this.footpaths[s]) {
          const arr = cur[s].t + t;
          if (arr < Math.min(best[s2], bestDest)) {
            cur[s2] = { t: arr, label: { type: 'walk', from: s, walkS: t, walkM: m } };
            best[s2] = arr;
            marked.add(s2);
          }
        }
      }
      rounds.push(cur);
      // Best arrival at destination using exactly k buses.
      let bestK = null;
      for (const [s, [t, m]] of egress) {
        if (cur[s] && cur[s].label.type === 'bus' && cur[s].t + t < (bestK ? bestK.t : Infinity)) bestK = { t: cur[s].t + t, stop: s, walkS: t, walkM: m };
      }
      if (bestK && bestK.t < bestDest) {
        bestDest = bestK.t;
        results.push(this.reconstruct(rounds, k, bestK, origin, dest, depart));
      }
    }
    return { itineraries: results, walkOnly: { seconds: walkSeconds(directM / WALK_DETOUR), meters: directM } };
  }

  reconstruct(rounds, k, end, origin, dest, depart) {
    const legs = [];
    legs.push({ type: 'walk', from: { stop: end.stop }, to: { place: dest }, seconds: end.walkS, meters: end.walkM });
    let s = end.stop;
    for (let r = k; r >= 0; r--) {
      let lab = rounds[r][s];
      while (lab.label.type === 'walk') {
        legs.push({ type: 'walk', from: { stop: lab.label.from }, to: { stop: s }, seconds: lab.label.walkS, meters: lab.label.walkM });
        s = lab.label.from;
        lab = rounds[r][s];
      }
      if (lab.label.type === 'bus') {
        const L = lab.label, p = this.patterns[L.pattern], trip = p.trips[L.trip];
        legs.push({
          type: 'bus', line: p.line, headsign: p.headsign, pattern: L.pattern, trip: L.trip,
          boardPos: L.boardPos, alightPos: L.alightPos,
          from: { stop: p.stops[L.boardPos] }, to: { stop: p.stops[L.alightPos] },
          depart: trip[L.boardPos + 1], arrive: trip[L.alightPos + 1],
          numStops: L.alightPos - L.boardPos,
        });
        s = p.stops[L.boardPos];
      } else if (lab.label.type === 'access') {
        legs.push({ type: 'walk', from: { place: origin }, to: { stop: s }, seconds: lab.label.walkS, meters: lab.label.walkM });
        break;
      }
    }
    legs.reverse();
    return this.timeLegs(legs);
  }

  // Fill in walking leg times: walk to the first stop just in time, then chain.
  timeLegs(legs) {
    const firstBus = legs.findIndex(l => l.type === 'bus');
    let t = legs[firstBus].depart;
    for (let i = firstBus - 1; i >= 0; i--) { legs[i].arrive = t; legs[i].depart = t - legs[i].seconds; t = legs[i].depart; }
    t = legs[firstBus].arrive;
    for (let i = firstBus + 1; i < legs.length; i++) {
      if (legs[i].type === 'walk') { legs[i].depart = t; legs[i].arrive = t + legs[i].seconds; t = legs[i].arrive; }
      else t = legs[i].arrive;
    }
    const buses = legs.filter(l => l.type === 'bus');
    return { legs, depart: legs[0].depart, arrive: legs[legs.length - 1].arrive, buses: buses.length };
  }

  /** Several options: re-run after each found departure to get later alternatives too. */
  plan(origin, dest, depart, date, { count = 5 } = {}) {
    const out = [];
    let t = depart, walkOnly = null;
    for (let i = 0; i < count * 2 && out.length < count; i++) {
      const r = this.raptor(origin, dest, t, date);
      walkOnly = walkOnly || r.walkOnly;
      if (!r.itineraries.length) break;
      for (const it of r.itineraries) {
        // Same buses boarded at a different stop count as the same option: keep the later departure.
        const key = it.legs.filter(l => l.type === 'bus').map(l => `${l.pattern}:${l.trip}`).join('|');
        const prevIdx = out.findIndex(o => o.key === key);
        it.key = key;
        if (prevIdx < 0) out.push(it);
        else if (it.depart > out[prevIdx].depart || (it.depart === out[prevIdx].depart && it.arrive < out[prevIdx].arrive)) out[prevIdx] = it;
      }
      // Next search: just after the earliest first-bus departure found.
      const firstDeps = r.itineraries.map(it => {
        const b = it.legs.find(l => l.type === 'bus');
        return b.depart - it.legs.filter((l, j) => j < it.legs.indexOf(b)).reduce((a, l) => a + l.seconds, 0);
      });
      t = Math.min(...firstDeps) + 60;
    }
    out.sort((a, b) => a.arrive - b.arrive || b.depart - a.depart || a.buses - b.buses);
    return { itineraries: out.slice(0, count), walkOnly };
  }

  // Scheduled departures of a pattern at a stop near a time (used to match live arrivals).
  scheduledAt(patternIdx, pos, date, from, to) {
    const active = this.activeServices(date);
    const p = this.patterns[patternIdx];
    return p.trips.map((tr, k) => [k, tr[pos + 1], tr[0]]).filter(([, t, sv]) => active.has(sv) && t >= from && t <= to).map(([k, t]) => ({ trip: k, t }));
  }
}

// --- Live arrivals (TUA "estimaciones") ---

// Direction code of a pattern, e.g. "F1" from "F1-CAMPILLIN-HUCA", "BUHO" for the night bus.
export function directionCode(headsign) {
  const m = headsign.match(/^([A-Z]+\d?)/i);
  return m ? m[1].toUpperCase() : headsign.toUpperCase();
}

/**
 * Normalise a TUA estimaciones response into [{line, dir, destino, seconds, meters}].
 * Example input: {"estimaciones":{"value":[{"line":"F","vh_first":{"destino":"F1 -HUCA","seconds":294,"meters":588},"vh_second":{...}}]}}
 */
export function parseEstimaciones(json) {
  const out = [];
  const rows = json?.estimaciones?.value || [];
  for (const row of rows) {
    for (const key of ['vh_first', 'vh_second']) {
      const v = row[key];
      if (!v || v.seconds == null) continue;
      const destino = v.destino || v.destination_names?.[0]?.value || '';
      out.push({ line: String(row.line).trim().toUpperCase(), dir: directionCode(destino.replace(/\s+/g, '')), destino, seconds: v.seconds, meters: v.meters, terminus: !!v.cabecera });
    }
  }
  return out;
}

/** Live arrivals that match a bus leg's line and direction. */
export function liveForLeg(leg, arrivals) {
  const dir = directionCode(leg.headsign);
  const line = leg.line.toUpperCase();
  const lineMatches = arrivals.filter(a => a.line === line || (line === 'BUH' && a.line.startsWith('BU')));
  const exact = lineMatches.filter(a => a.dir === dir);
  return exact.length ? exact : lineMatches;
}
