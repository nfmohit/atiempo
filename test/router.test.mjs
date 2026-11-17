import { readFileSync } from 'node:fs';
import assert from 'node:assert';
import { Network, parseEstimaciones, liveForLeg } from '../public/router.js';

const net = new Network(JSON.parse(readFileSync(new URL('../public/data/tua.json', import.meta.url))));
const fmt = s => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}`;
const show = it => it.legs.map(l => l.type === 'bus'
  ? `${fmt(l.depart)} bus ${l.headsign} ${net.stops[l.from.stop].name} -> ${net.stops[l.to.stop].name} ${fmt(l.arrive)}`
  : `walk ${l.meters}m`).join(' | ');

// Plaza de la Escandalera (centre) -> HUCA hospital
const centre = { lat: 43.3623, lon: -5.8467 };
const huca = { lat: 43.3770, lon: -5.8740 };
const r = net.plan(centre, huca, 9 * 3600, '20261117');
assert(r.itineraries.length > 0, 'expected itineraries');
r.itineraries.forEach(it => console.log(fmt(it.depart), '->', fmt(it.arrive), '|', show(it)));
for (const it of r.itineraries) {
  for (let i = 1; i < it.legs.length; i++) assert(it.legs[i].depart >= it.legs[i - 1].arrive - 1, 'legs must be in order');
  assert(it.depart >= 9 * 3600 - 1);
}

// Lugones -> Facultad Derecho El Cristo (likely needs a change)
const r2 = net.plan({ lat: 43.4025, lon: -5.8130 }, { lat: 43.3547, lon: -5.8726 }, 8 * 3600, '20261117');
assert(r2.itineraries.length > 0);
r2.itineraries.forEach(it => console.log(fmt(it.depart), '->', fmt(it.arrive), '|', show(it)));

const live = parseEstimaciones({"estimaciones":{"value":[{"line":"F","line_names":[],"vh_first":{"cabecera":false,"destination_names":[{"key":"default","value":"F1 -HUCA"}],"destino":"F1 -HUCA","meters":588,"seconds":294},"vh_second":{"cabecera":false,"destination_names":[{"key":"default","value":"F2-HUCA"}],"destino":"F2-HUCA","meters":1273,"seconds":1273}}]}});
assert.equal(live.length, 2);
assert.equal(live[0].dir, 'F1');
assert.deepEqual(liveForLeg({ line: 'F', headsign: 'F1-CAMPILLIN-HUCA' }, live).map(a => a.seconds), [294]);
console.log('ok');

// Short trip (about 1.2 km): bus options must still be offered even if walking is quicker.
const r3 = net.plan({ lat: 43.3623, lon: -5.8467 }, { lat: 43.3700, lon: -5.8370 }, 13 * 3600 + 40 * 60, '20261117');
assert(r3.itineraries.length > 0, 'short trips should still offer buses');
console.log('short trip:', r3.walkOnly.meters, 'm walk;', r3.itineraries.length, 'bus options');
