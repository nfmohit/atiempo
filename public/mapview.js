// Map adapter: one small interface over Leaflet (OpenStreetMap) and Google Maps, so the rest of
// the app doesn't care which one is showing. Google is used when config.json has a key, because
// Google's terms require places found with Google Places to be shown on a Google map.

const pinHtml = cls => `<div class="pin ${cls}"></div>`;
const numHtml = n => `<div class="numpin">${n}</div>`;
const dotEl = ({ radius = 5, color, fill = '#fff', weight = 2 }) => {
  const d = document.createElement('div');
  d.className = 'mapdot';
  Object.assign(d.style, { width: `${radius * 2}px`, height: `${radius * 2}px`, border: `${weight}px solid ${color}`, background: fill });
  return d;
};

// ---------------- Leaflet ----------------
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', crossOrigin: '' });
  document.head.appendChild(css);
  return new Promise((resolve, reject) => {
    const s = Object.assign(document.createElement('script'), { src: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', crossOrigin: '' });
    s.onload = resolve; s.onerror = () => reject(new Error('map did not load'));
    document.head.appendChild(s);
  });
}

export async function leafletMap(el, center, zoom) {
  await loadLeaflet();
  const map = L.map(el, { zoomControl: false }).setView(center, zoom);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  return {
    kind: 'leaflet',
    setView: (ll, z) => map.setView(ll, z),
    fitPoints(points, { pad = 0.2, maxZoom = 18 } = {}) { if (points.length) map.fitBounds(L.latLngBounds(points).pad(pad), { maxZoom }); },
    getZoom: () => map.getZoom(),
    onZoom: cb => map.on('zoomend', () => cb(map.getZoom())),
    onClick: cb => map.on('click', e => cb({ lat: e.latlng.lat, lon: e.latlng.lng })),
    closePopup: () => map.closePopup(),
    layer() {
      const g = L.layerGroup().addTo(map);
      return {
        clear: () => g.clearLayers(),
        show: on => (on ? g.addTo(map) : map.removeLayer(g)),
        pin(lat, lon, { kind, draggable, onDragEnd }) {
          const m = L.marker([lat, lon], { icon: L.divIcon({ className: '', html: pinHtml(kind), iconSize: [18, 18], iconAnchor: [9, 9] }), draggable }).addTo(g);
          if (onDragEnd) m.on('dragend', e => { const p = e.target.getLatLng(); onDragEnd(p.lat, p.lng); });
        },
        numPin(lat, lon, { n, title, onClick }) {
          L.marker([lat, lon], { icon: L.divIcon({ className: '', html: numHtml(n), iconSize: [24, 24], iconAnchor: [12, 12] }) })
            .bindTooltip(title).on('click', onClick).addTo(g);
        },
        dot(lat, lon, { radius = 5, color, fill = '#fff', weight = 2, title, popup }) {
          const m = L.circleMarker([lat, lon], { radius, color, weight, fillColor: fill, fillOpacity: 1 }).addTo(g);
          if (title) m.bindTooltip(title);
          if (popup) m.bindPopup(popup, { maxWidth: 260 });
        },
        line(coords, { color, weight = 4, opacity = 0.9, dashed = false }) {
          L.polyline(coords, { color, weight, opacity, ...(dashed ? { dashArray: '2 8', lineCap: 'round' } : {}) }).addTo(g);
        },
      };
    },
  };
}

// ---------------- Google Maps ----------------
function loadGoogle(key) {
  if (window.google?.maps?.importLibrary) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cb = `__gm${Date.now()}`;
    window[cb] = () => { delete window[cb]; resolve(); };
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&language=es&region=ES&callback=${cb}`;
    s.async = true;
    s.onerror = () => reject(new Error('Google Maps did not load'));
    document.head.appendChild(s);
  });
}

export async function googleMap(el, center, zoom, { key, mapId }) {
  await loadGoogle(key);
  const { Map, InfoWindow, Polyline, LatLngBounds } = await google.maps.importLibrary('maps');
  const { AdvancedMarkerElement } = await google.maps.importLibrary('marker');
  const map = new Map(el, {
    center: { lat: center[0], lng: center[1] }, zoom, mapId: mapId || 'DEMO_MAP_ID',
    disableDefaultUI: true, zoomControl: true, gestureHandling: 'greedy', clickableIcons: true,
  });
  const info = new InfoWindow();
  const clickHandlers = [];
  map.addListener('click', e => {
    // Tapping a business or landmark on the Google map gives its place id.
    if (e.placeId) e.stop();
    for (const cb of clickHandlers) cb({ lat: e.latLng.lat(), lon: e.latLng.lng(), placeId: e.placeId || null });
  });
  const ll = (lat, lon) => ({ lat, lng: lon });
  return {
    kind: 'google',
    map,
    setView: (c, z) => { map.setCenter(ll(c[0], c[1])); map.setZoom(z); },
    fitPoints(points, { maxZoom = 18 } = {}) {
      if (!points.length) return;
      const b = new LatLngBounds();
      points.forEach(p => b.extend(ll(p[0], p[1])));
      map.fitBounds(b, 48);
      if (points.length === 1) map.setZoom(Math.min(maxZoom, 16));
      google.maps.event.addListenerOnce(map, 'idle', () => { if (map.getZoom() > maxZoom) map.setZoom(maxZoom); });
    },
    getZoom: () => map.getZoom(),
    onZoom: cb => map.addListener('zoom_changed', () => cb(map.getZoom())),
    onClick: cb => clickHandlers.push(cb),
    closePopup: () => info.close(),
    layer() {
      const items = [];
      let visible = true;
      const add = o => { items.push(o); if (!visible) o.setMap ? o.setMap(null) : (o.map = null); return o; };
      return {
        clear() { items.forEach(o => (o.setMap ? o.setMap(null) : (o.map = null))); items.length = 0; },
        show(on) { visible = on; items.forEach(o => (o.setMap ? o.setMap(on ? map : null) : (o.map = on ? map : null))); },
        pin(lat, lon, { kind, draggable, onDragEnd }) {
          const content = document.createElement('div'); content.innerHTML = pinHtml(kind);
          const m = add(new AdvancedMarkerElement({ map, position: ll(lat, lon), content: content.firstChild, gmpDraggable: !!draggable, zIndex: 1000 }));
          if (onDragEnd) m.addListener('dragend', () => { const p = m.position; onDragEnd(typeof p.lat === 'function' ? p.lat() : p.lat, typeof p.lng === 'function' ? p.lng() : p.lng); });
        },
        numPin(lat, lon, { n, title, onClick }) {
          const content = document.createElement('div'); content.innerHTML = numHtml(n);
          const m = add(new AdvancedMarkerElement({ map, position: ll(lat, lon), content: content.firstChild, title, gmpClickable: true, zIndex: 900 }));
          m.addListener('gmp-click', onClick);
        },
        dot(lat, lon, opts) {
          const m = add(new AdvancedMarkerElement({ map, position: ll(lat, lon), content: dotEl(opts), title: opts.title || '', gmpClickable: !!opts.popup }));
          if (opts.popup) m.addListener('gmp-click', () => { info.setContent(opts.popup()); info.open({ map, anchor: m }); });
        },
        line(coords, { color, weight = 4, opacity = 0.9, dashed = false }) {
          const path = coords.map(c => ll(c[0], c[1]));
          add(new Polyline(dashed
            ? { map, path, strokeOpacity: 0, icons: [{ icon: { path: 'M 0,-0.5 0,0.5', strokeOpacity: 1, strokeColor: color, strokeWeight: weight, scale: 2 }, offset: '0', repeat: '10px' }] }
            : { map, path, strokeColor: color, strokeWeight: weight, strokeOpacity: opacity }));
        },
      };
    },
  };
}
