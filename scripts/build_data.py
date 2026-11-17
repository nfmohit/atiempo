#!/usr/bin/env python3
"""Extract TUA (Oviedo city buses) from the Asturias consortium GTFS feed into
a compact JSON file the web app loads.

Usage: python3 scripts/build_data.py path/to/gtfs_dir_or_zip public/data/tua.json
"""
import csv, io, json, re, sys, zipfile, collections

TUA_AGENCY_NAME = "Transportes Unidos de Asturias"


def open_feed(path):
    if path.endswith(".zip"):
        z = zipfile.ZipFile(path)
        return lambda name: io.TextIOWrapper(z.open(name), encoding="utf-8-sig")
    return lambda name: open(f"{path}/{name}", encoding="utf-8-sig")


def secs(t):
    h, m, s = (int(x) for x in t.split(":"))
    return h * 3600 + m * 60 + s


def clean_name(n):
    # Some stops look like "[CODE|Name]  Long name [CTA 01151]"; keep the readable part.
    n = re.sub(r"\[CTA \d+\]", "", n)
    n = re.sub(r"^\[[^\]]*\]\s*", "", n)
    return n.strip()


def main(src, out):
    f = open_feed(src)
    agency = [a for a in csv.DictReader(f("agency.txt")) if a["agency_name"].startswith(TUA_AGENCY_NAME)]
    if not agency:
        sys.exit("TUA agency not found in feed")
    aid = agency[0]["agency_id"]

    routes = {r["route_id"]: r for r in csv.DictReader(f("routes.txt")) if r["agency_id"] == aid}
    trips = {t["trip_id"]: t for t in csv.DictReader(f("trips.txt")) if t["route_id"] in routes}

    st = collections.defaultdict(list)
    for r in csv.DictReader(f("stop_times.txt")):
        if r["trip_id"] in trips:
            st[r["trip_id"]].append((int(r["stop_sequence"]), r["stop_id"], secs(r["arrival_time"]), secs(r["departure_time"])))

    used_stops = set()
    # Group trips into patterns: same route, headsign and exact stop sequence.
    patterns = {}
    for tid, rows in st.items():
        rows.sort()
        seq = tuple(r[1] for r in rows)
        t = trips[tid]
        key = (t["route_id"], t["trip_headsign"], seq)
        p = patterns.setdefault(key, {"trips": []})
        p["trips"].append((rows[0][3], t["service_id"], [r[2] for r in rows], [r[3] for r in rows], t["shape_id"]))
        used_stops.update(seq)

    stops_all = {s["stop_id"]: s for s in csv.DictReader(f("stops.txt"))}
    stop_ids = sorted(used_stops, key=int)
    sidx = {s: i for i, s in enumerate(stop_ids)}
    stops = [[s, clean_name(stops_all[s]["stop_name"]), round(float(stops_all[s]["stop_lat"]), 6), round(float(stops_all[s]["stop_lon"]), 6)] for s in stop_ids]

    services = collections.defaultdict(list)
    used_services = {t["service_id"] for t in trips.values()}
    for r in csv.DictReader(f("calendar_dates.txt")):
        if r["service_id"] in used_services and r["exception_type"] == "1":
            services[r["date"]].append(r["service_id"])
    # calendar.txt is optional; include it if present.
    try:
        import datetime
        for r in csv.DictReader(f("calendar.txt")):
            if r["service_id"] not in used_services:
                continue
            d = datetime.date(int(r["start_date"][:4]), int(r["start_date"][4:6]), int(r["start_date"][6:]))
            e = datetime.date(int(r["end_date"][:4]), int(r["end_date"][4:6]), int(r["end_date"][6:]))
            days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
            while d <= e:
                if r[days[d.weekday()]] == "1":
                    services[d.strftime("%Y%m%d")].append(r["service_id"])
                d += datetime.timedelta(days=1)
    except (KeyError, FileNotFoundError):
        pass

    # Shapes, simplified: keep every Nth point for the shapes we actually use.
    used_shapes = {tr[4] for p in patterns.values() for tr in p["trips"]}
    shape_pts = collections.defaultdict(list)
    try:
        for r in csv.DictReader(f("shapes.txt")):
            if r["shape_id"] in used_shapes:
                shape_pts[r["shape_id"]].append((int(r["shape_pt_sequence"]), round(float(r["shape_pt_lat"]), 5), round(float(r["shape_pt_lon"]), 5)))
    except (KeyError, FileNotFoundError):
        pass

    out_patterns = []
    for (rid, headsign, seq), p in patterns.items():
        p["trips"].sort()
        shape = collections.Counter(tr[4] for tr in p["trips"]).most_common(1)[0][0]
        pts = sorted(shape_pts.get(shape, []))
        out_patterns.append({
            "line": routes[rid]["route_short_name"].strip(),
            "lineName": routes[rid]["route_long_name"].strip(),
            "headsign": headsign,
            "stops": [sidx[s] for s in seq],
            # Each trip: service id, then arrival offsets in seconds; departures equal arrivals in this feed
            # except where noted, so we only store arrivals plus the first departure.
            "trips": [[tr[1]] + tr[2] for tr in p["trips"]],
            "shape": [[a, b] for _, a, b in pts],
        })
    out_patterns.sort(key=lambda p: (p["line"], p["headsign"]))

    data = {
        "source": "Consorcio de Transportes de Asturias GTFS (NAP Spain), agency: TUA",
        "stops": stops,
        "patterns": out_patterns,
        "services": {d: sorted(set(v)) for d, v in sorted(services.items())},
    }
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(stops)} stops, {len(out_patterns)} patterns, {sum(len(p['trips']) for p in out_patterns)} trips, "
          f"{len(data['services'])} service days -> {out}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
