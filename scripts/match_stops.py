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


GOOD = 0.6


def accept(pairs, tua, gtfs):
    """Which aligned pairs to trust: good name matches, plus runs of weak matches that sit at the
    same positions in both lists between good matches or at either end (e.g. "F. L. C." =
    "Fundación Laboral Construcción", or "Las Campas II" = "Les Campes 2")."""
    ti = {id(t): k for k, t in enumerate(tua)}
    gi = {g: k for k, g in enumerate(gtfs)}
    ok = [sc >= GOOD for _, _, sc in pairs]
    k = 0
    while k < len(pairs):
        if ok[k]:
            k += 1
            continue
        e = k
        while e < len(pairs) and not ok[e]:
            e += 1
        # Run of weak pairs [k, e). Check it is contiguous with its neighbours in both lists.
        def contiguous(a, b):
            return ti[id(pairs[b][0])] - ti[id(pairs[a][0])] == b - a and gi[pairs[b][1]] - gi[pairs[a][1]] == b - a
        lo_ok = k == 0 and ti[id(pairs[0][0])] == 0 and gi[pairs[0][1]] == 0 or k > 0 and contiguous(k - 1, k)
        hi_ok = e == len(pairs) and ti[id(pairs[-1][0])] == len(tua) - 1 and gi[pairs[-1][1]] == len(gtfs) - 1 or e < len(pairs) and contiguous(e - 1, e)
        inner = all(contiguous(x, x + 1) for x in range(k, e - 1))
        if lo_ok and hi_ok and inner and (k > 0 or e < len(pairs)) and e - k <= 3:
            for x in range(k, e):
                ok[x] = True
        k = e
    return ok


def main(data_path, out_path, pages):
    data = json.load(open(data_path, encoding="utf-8"))
    names = {s[0]: s[1] for s in data["stops"]}
    stop_ids = [s[0] for s in data["stops"]]
    # Every distinct timetable stop sequence per line letter; each TUA direction is aligned
    # against all of them and the best one wins (handles variants, loops and odd headsigns).
    by_line = {}
    for p in data["patterns"]:
        seq = [stop_ids[i] for i in p["stops"]]
        line = "BUHO" if p["line"].upper().startswith("BU") else p["line"].upper()
        if seq not in by_line.setdefault(line, []):
            by_line[line].append(seq)

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
            line = re.match(r"^([A-Z]+?)\d*$", code).group(1)
            cands = by_line.get(line, [])
            if not cands:
                report.append(f"{code}: no timetable line found")
                continue
            best = None
            for gtfs in cands:
                pairs = align(tua, gtfs, names)
                ok = accept(pairs, tua, gtfs)
                if best is None or sum(map(bool, ok)) > best[0]:
                    best = (sum(map(bool, ok)), pairs, ok, gtfs)
            n_ok, pairs, ok, gtfs = best
            for (t, g, _), o in zip(pairs, ok):
                if o:
                    mapping.setdefault(g, set()).add(t[0])
            report.append(f"{code}: {n_ok}/{len(tua)} TUA stops matched ({len(gtfs)} in timetable)")
            for (t, g, sc), o in zip(pairs, ok):
                if not o:
                    report.append(f"   unmatched: TUA {t[0]} '{t[1]}' (closest: timetable {g} '{names[g]}', {sc:.2f})")
    # One timetable stop can stand for more than one TUA stop (e.g. HUCA1/HUCA2 share one stop).
    out = {g: (sorted(v)[0] if len(v) == 1 else sorted(v)) for g, v in sorted(mapping.items(), key=lambda kv: int(kv[0]))}
    json.dump(out, open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    print("\n".join(report))
    multi = {g: v for g, v in out.items() if isinstance(v, list)}
    print(f"{len(out)} of {len(stop_ids)} timetable stops now have a TUA number; {len(multi)} have several: " +
          ", ".join(f"{g} {names[g]} -> {v}" for g, v in list(multi.items())[:15]))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3:])
