#!/usr/bin/env python3
"""Download US airspace from the FAA and write airspace.json for the map.

  python3 tools/build_airspace.py

Source: FAA Aeronautical Information Services open data (public domain), updated every 56 days:
  • Class_Airspace: Class B, C and D airspace around airports (with each shelf's floor and ceiling)
  • Special_Use_Airspace: restricted, prohibited, warning, alert and danger areas, and MOAs
It also works out each airport's airspace class (B, C or D) for the airport card, by matching the
FAA's airport IDs to airports.txt. Shapes are rounded to about 10 m, which is plenty for a map.
Only Python 3 is needed.
"""
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services"
PAGE = 2000


def fetch_all(service, where, fields):
    feats, offset = [], 0
    while True:
        q = urllib.parse.urlencode({
            "where": where, "outFields": ",".join(fields), "outSR": 4326, "f": "geojson",
            "geometryPrecision": 4, "maxAllowableOffset": 0.0002,
            "resultOffset": offset, "resultRecordCount": PAGE, "orderByFields": "OBJECTID",
        })
        url = f"{BASE}/{service}/FeatureServer/0/query?{q}"
        for attempt in range(4):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "EveryAirfield-tools/1.0"}), timeout=120) as r:
                    page = json.loads(r.read())
                break
            except Exception as e:                       # flaky network: retry a few times
                if attempt == 3:
                    raise SystemExit(f"Couldn't download {service}: {e}")
                time.sleep(3 * (attempt + 1))
        got = page.get("features") or []
        feats += got
        print(f"  {service}: {len(feats)} shapes", flush=True)
        if len(got) < PAGE:
            return feats
        offset += PAGE


def alt(val, uom, code):
    """FAA altitude fields → short text, e.g. 'SFC', '2,500 ft', 'FL180', 'UNL'."""
    try:
        v = float(val)
    except (TypeError, ValueError):
        v = None
    code = (code or "").upper()
    if code == "SFC" or (v == 0 and code in ("", "MSL", "AGL")):
        return "SFC"
    if v is None or v <= -9000:
        return "UNL"
    if code == "STD" or (uom or "").upper() == "FL":
        return f"FL{int(v if v < 1000 else v / 100):03d}"
    return f"{int(v):,} ft" + (" AGL" if code == "AGL" else "")


def rings(geom):
    """GeoJSON polygon/multipolygon → list of flat [lon, lat, lon, lat, …] rings, 4 decimals."""
    if not geom:
        return []
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"] if geom["type"] == "MultiPolygon" else []
    out = []
    for poly in polys:
        for ring in poly:
            flat = []
            for lon, lat, *_ in ring:
                flat += [round(lon, 4), round(lat, 4)]
            if len(flat) >= 6:
                out.append(flat)
    return out


def main():
    print("Downloading FAA airspace (public domain) …")
    cls = fetch_all("Class_Airspace", "CLASS IN ('B','C','D')",
                    ["IDENT", "ICAO_ID", "NAME", "CLASS", "LOWER_VAL", "LOWER_UOM", "LOWER_CODE", "UPPER_VAL", "UPPER_UOM", "UPPER_CODE", "WKHR_CODE"])
    sua = fetch_all("Special_Use_Airspace", "1=1",
                    ["NAME", "TYPE_CODE", "LOWER_VAL", "LOWER_UOM", "LOWER_CODE", "UPPER_VAL", "UPPER_UOM", "UPPER_CODE", "TIMESOFUSE", "CONT_AGENT", "CITY", "STATE"])

    # our airports, by every code the FAA might use for them
    by_code = {}
    for line in (ROOT / "airports.txt").read_text(encoding="utf-8").splitlines():
        f = line.split("\t")
        if len(f) < 6:
            continue
        ident = f[10] if len(f) > 10 and f[10] else f[5]
        for code in {ident, f[5], f[4]}:
            if code:
                by_code.setdefault(code.upper(), ident)

    out_cls, apt = [], {}
    rank = {"B": 0, "C": 1, "D": 2}
    for feat in cls:
        p = feat.get("properties") or {}
        c = (p.get("CLASS") or "").upper()
        r = rings(feat.get("geometry"))
        if c not in rank or not r:
            continue
        ident = by_code.get((p.get("ICAO_ID") or "").upper()) or by_code.get((p.get("IDENT") or "").upper()) \
            or by_code.get("K" + (p.get("IDENT") or "").upper())
        lo, hi = alt(p.get("LOWER_VAL"), p.get("LOWER_UOM"), p.get("LOWER_CODE")), alt(p.get("UPPER_VAL"), p.get("UPPER_UOM"), p.get("UPPER_CODE"))
        out_cls.append([c, ident or "", (p.get("NAME") or "").title(), lo, hi, (p.get("WKHR_CODE") or ""), r])
        if ident and (ident not in apt or rank[c] < rank[apt[ident]["c"]]):
            apt[ident] = {"c": c, "hi": hi}
        if ident and apt[ident]["c"] == c and lo == "SFC":
            apt[ident]["hi"] = hi                 # the surface area's ceiling is the one pilots quote

    types = {"R": "Restricted", "P": "Prohibited", "W": "Warning", "A": "Alert", "D": "Danger", "MOA": "MOA"}
    out_sua = []
    for feat in sua:
        p = feat.get("properties") or {}
        t = (p.get("TYPE_CODE") or "").upper()
        r = rings(feat.get("geometry"))
        if t not in types or not r:
            continue
        place = ", ".join(x for x in [(p.get("CITY") or "").title(), p.get("STATE") or ""] if x)
        out_sua.append([t, (p.get("NAME") or "").strip(), alt(p.get("LOWER_VAL"), p.get("LOWER_UOM"), p.get("LOWER_CODE")),
                        alt(p.get("UPPER_VAL"), p.get("UPPER_UOM"), p.get("UPPER_CODE")),
                        (p.get("TIMESOFUSE") or "").strip()[:200], (p.get("CONT_AGENT") or "").strip()[:80], place[:100], r])

    data = {
        "source": "FAA Aeronautical Information Services (public domain)",
        "fetched": time.strftime("%Y-%m-%d"),
        "cls": out_cls,          # [class, airport ident, name, floor, ceiling, hours code, rings]
        "sua": out_sua,          # [type, name, floor, ceiling, times of use, controlling agency, place, rings]
        "apt": {k: [v["c"], v["hi"]] for k, v in sorted(apt.items())},   # airport ident → [class, ceiling]
    }
    path = ROOT / "airspace.json"
    path.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {path.name}: {len(out_cls)} class B/C/D shapes, {len(out_sua)} special-use areas, "
          f"{len(apt)} airports with their class, {path.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
