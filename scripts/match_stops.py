#!/usr/bin/env python3
"""Match TUA's own stop numbers to timetable (GTFS) stops.

TUA's line pages (tua.es/es/lineas-y-horarios/linea-X.html) list each direction's stops in order
with TUA's stop number. We align each list with the timetable's stop sequence for the same
direction (A1, A2, ...) using stop order plus name similarity, and write public/data/stop-map.json.

Usage: python3 scripts/match_stops.py public/data/tua.json public/data/stop-map.json linea-a.html [linea-b.html ...]
       (or the JSON file saved by tools/collect-tua-stops.js, which covers every line)
"""
import difflib, html, json, re, sys, unicodedata


def norm(s):
    s = unicodedata.normalize("NFKD", html.unescape(s)).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\b(avda|avenida|calle|c/|plaza|pza|de|del|la|el|los|las)\b", " ", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return " ".join(s.split())


def parse_line_page(text):
    """Return {'ida': [(num, name)], 'vuelta': [...]}, plus the direction codes (A1, A2)."""
    out = {}
    tabs = re.findall(r'href="#(ida|vuelta)"><span>([^<]+)</span>', text)
    codes = {k: html.unescape(v).strip().upper().replace("Ú", "U") for k, v in tabs}
    parts = re.split(r'<div id="(ida|vuelta)"', text)
    for i in range(1, len(parts) - 1, 2):
        key, body = parts[i], parts[i + 1]
        stops = re.findall(r'<span>(\d+)</span>\s*<strong>([^<]+)</strong>', body)
        out[key] = [(n, html.unescape(name).strip()) for n, name in stops]
    return {codes.get(k, k): v for k, v in out.items()}


def similarity(a, b):
    a, b = norm(a), norm(b)
    if not a or not b:
        return 0.0
    if a == b or a in b or b in a:
        return 1.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def align(tua, gtfs, names):
    """Needleman-Wunsch style alignment of two ordered stop lists by name similarity."""
    n, m = len(tua), len(gtfs)
    GAP = -0.25
    score = [[0.0] * (m + 1) for _ in range(n + 1)]
    back = [[None] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        score[i][0] = i * GAP; back[i][0] = "u"
    for j in range(1, m + 1):
        score[0][j] = j * GAP; back[0][j] = "l"
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            s = similarity(tua[i - 1][1], names[gtfs[j - 1]])
            opts = [(score[i - 1][j - 1] + (s - 0.45) * 2, "d"), (score[i - 1][j] + GAP, "u"), (score[i][j - 1] + GAP, "l")]
            score[i][j], back[i][j] = max(opts)
    pairs = []
    i, j = n, m
    while i > 0 or j > 0:
        b = back[i][j]
        if b == "d":
            pairs.append((tua[i - 1], gtfs[j - 1], similarity(tua[i - 1][1], names[gtfs[j - 1]])))
            i, j = i - 1, j - 1
        elif b == "u":
            i -= 1
        else:
            j -= 1
    return pairs[::-1]


def main(data_path, out_path, pages):
    data = json.load(open(data_path, encoding="utf-8"))
    names = {s[0]: s[1] for s in data["stops"]}
    stop_ids = [s[0] for s in data["stops"]]
    # Longest timetable pattern for each direction code (A1, F2, BUHO...).
    by_dir = {}
    for p in data["patterns"]:
        code = re.match(r"^([A-Z]+\d?)", p["headsign"].upper()).group(1)
        code = "BUHO" + ("1" if "CUATRO" not in p["headsign"].upper() else "2") if code.startswith("BUHO") else code
        seq = [stop_ids[i] for i in p["stops"]]
        if len(seq) > len(by_dir.get(code, [])):
            by_dir[code] = seq

    try:
        mapping = json.load(open(out_path, encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        mapping = {}
    report = []
    sources = []
    for path in pages:
        text = open(path, encoding="utf-8", errors="replace").read()
        if path.endswith(".json"):
            # Output of tools/collect-tua-stops.js: {"A1": [["1033", "Centro Asturiano"], ...], ...}
            sources.append({k.upper().replace("Ú", "U"): [tuple(x) for x in v] for k, v in json.loads(text).items()})
        else:
            sources.append(text)
    for src in sources:
        for code, tua in (src if isinstance(src, dict) else parse_line_page(src)).items():
            gtfs = by_dir.get(code)
            if not gtfs:
                report.append(f"{code}: no timetable direction found")
                continue
            pairs = align(tua, gtfs, names)
            # Accept a weak name match when it sits between two good matches in both lists
            # (e.g. "F. L. C." = "Fundación Laboral Construcción").
            ti = {id(t): k for k, t in enumerate(tua)}
            gi = {g: k for k, g in enumerate(gtfs)}
            ok = [s >= 0.6 for _, _, s in pairs]
            for k, (t, g, s) in enumerate(pairs):
                if not ok[k] and 0 < k < len(pairs) - 1 and ok[k - 1] and ok[k + 1]:
                    pt, pg, _ = pairs[k - 1]; nt, ng, _ = pairs[k + 1]
                    if ti[id(pt)] + 1 == ti[id(t)] == ti[id(nt)] - 1 and gi[pg] + 1 == gi[g] == gi[ng] - 1:
                        ok[k] = "sandwich"
            good = [(t, g) for (t, g, _), o in zip(pairs, ok) if o]
            for (num, _), g in good:
                mapping[g] = num
            report.append(f"{code}: {len(good)}/{len(tua)} TUA stops matched ({len(gtfs)} in timetable)")
            for (t, g, s), o in zip(pairs, ok):
                if not o:
                    report.append(f"   weak: TUA {t[0]} '{t[1]}' ~ timetable {g} '{names[g]}' ({s:.2f})")
    json.dump(dict(sorted(mapping.items(), key=lambda kv: int(kv[0]))), open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    print("\n".join(report))
    print(f"{len(mapping)} of {len(stop_ids)} timetable stops now have a TUA number -> {out_path}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3:])
