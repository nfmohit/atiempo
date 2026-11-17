# ATiempo

A small trip planner for Oviedo city buses (TUA). Type a destination and it gives you the
whole trip: the walk to the stop, which bus to take, where to change, the walk at the end,
and when to leave, using TUA's **live** arrival times instead of the timetable where it can.

It works in a phone browser (and can be added to the home screen). No app store needed.

## How it works

1. **Timetable.** TUA's full timetable is published as open data (GTFS) inside the Asturias
   transport consortium feed (Consorcio de Transportes de Asturias, via Spain's National
   Access Point). `scripts/build_data.py` extracts the TUA part into `public/data/tua.json`
   (17 lines, 555 stops, ~2,450 trips).
2. **Routing.** `public/router.js` is a small RAPTOR router that runs in the browser. It finds
   the fastest options with up to 2 changes, including walking to and from stops and between
   stops when changing bus.
3. **Live times.** For each bus leg the app asks TUA's `estimaciones` endpoint when that line
   and direction actually arrives at the boarding stop, and re-times the whole trip: when to
   leave, when you'll arrive, and whether a change still works. It refreshes every 30 seconds.
4. **Map and walking.** OpenStreetMap tiles (Leaflet), place search with Nominatim, and
   turn-by-turn walking directions from the FOSSGIS OSRM foot router.

## Known gaps

- **TUA stop numbers.** TUA's live API uses its own stop numbers (like 5019), which differ from
  the timetable's stop ids. `public/data/stop-map.json` maps one to the other (543 of 555 stops,
  all 17 lines). It's built by `scripts/match_stops.py`, which aligns TUA's per-line stop lists
  with the timetable by order and name. To refresh it, run `tools/collect-tua-stops.js` in a
  browser console on tua.es (instructions in the file), then
  `python3 scripts/match_stops.py public/data/tua.json public/data/stop-map.json tua-stops.json`.
  For any stop still missing, the app asks for its TUA number once and remembers it.
- **TUA's bot shield.** tua.es sits behind Imperva/Incapsula, which blocks requests from cloud
  servers. The server in `server.js` relays live times, but may be blocked when hosted in a data
  centre. The app then tries TUA directly from the phone, which only works if TUA allows
  cross-site requests (CORS).
- **Timetable coverage.** The current extract covers 16 Nov to 31 Dec 2026. Re-run the data
  script with a newer feed to extend it.

## Use it

Online: https://nfmohit.github.io/atiempo/ (published from `public/` by GitHub Actions on every push to `main`).
TUA's live API can't be read directly from another website (no CORS headers), so on GitHub Pages
live times go through a small relay: see `relay/README.md` (free Cloudflare Worker), then set
`liveRelay` in `public/config.json`.

## Run it locally

```sh
node server.js          # http://localhost:8080
npm test                # router tests
```

Requires Node 18+ and no packages.

## Update the timetable

Download the latest Consorcio de Transportes de Asturias GTFS zip (Mobility Database feed
`mdb-2827`, or from nap.transportes.gob.es after registering), then:

```sh
python3 scripts/build_data.py path/to/feed.zip public/data/tua.json
```

## Data sources and licences

- Timetable: Consorcio de Transportes de Asturias GTFS, licence https://nap.transportes.gob.es/licencia-datos
- Live arrivals: TUA (unofficial use of the endpoint their app uses)
- Map data: © OpenStreetMap contributors (ODbL)
