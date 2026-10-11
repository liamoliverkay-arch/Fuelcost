"""Local server for Every Airfield.

Serves the site and stores reported fuel prices in prices.json so everyone
using this server sees the same prices. Run it from this folder:

    python3 server.py

then open http://localhost:8000 (or http://<this computer's IP>:8000 from
other devices on the same network).
"""
import json
import os
import re
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent
PRICES = ROOT / "prices.json"
FUELS = {"100LL", "JetA", "MOGAS"}
IDENT_RE = re.compile(r"^[A-Za-z0-9\-]{1,16}$")
MAX_BODY = 2000
POSTS_PER_IP = 30            # price reports per IP address per 10 minutes
lock = threading.Lock()
post_log = {}                # ip -> list of recent POST times (guarded by lock)

# Live planes come from adsb.lol, a community network of ADS-B receivers with open data (ODbL).
# Browsers can't read its API directly (no CORS headers), so /api/planes passes it through.
PLANES_UPSTREAM = os.environ.get("PLANES_UPSTREAM", "https://api.adsb.lol/v2/point")
PLANES_CACHE_SECONDS = 5     # one upstream request per area every 5 seconds, shared by everyone
PLANES_PER_IP = 300          # plane requests per IP address per 10 minutes
MAX_DIST_NM = 250
planes_cache = {}            # area key -> (time, json bytes), guarded by planes_lock
planes_lock = threading.Lock()
planes_log = {}              # ip -> recent request times, guarded by planes_lock


def load_idents():
    """Airport idents the site knows (same rule as index.html: column 11, else column 6).
    Only these can have prices, so nobody can fill prices.json with made-up keys."""
    try:
        idents = set()
        for line in (ROOT / "airports.txt").read_text(encoding="utf-8").splitlines():
            f = line.split("\t")
            if len(f) > 5:
                idents.add((f[10] if len(f) > 10 and f[10] else f[5]))
        return idents or None
    except OSError:
        return None          # no airport list: fall back to the format check only


IDENTS = load_idents()


def load():
    try:
        return json.loads(PRICES.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save(prices):
    # write a temp file and rename it over prices.json, so a crash mid-write can't leave a
    # half-written file (which load() would read as empty, wiping every price on the next save)
    fd, tmp = tempfile.mkstemp(dir=ROOT, prefix=".prices-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(prices, f, indent=1)
        os.replace(tmp, PRICES)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _num(v, digits):
    if not isinstance(v, (int, float)) or isinstance(v, bool) or v != v or abs(v) == float("inf"):
        return None
    r = round(v, digits)
    return int(r) if digits == 0 else r     # whole numbers as 304, like the ea-planes function


def _str(v, n):
    return v.strip()[:n] if isinstance(v, str) else ""


def compact_plane(a):
    """adsb.lol's aircraft record -> [hex, callsign, registration, type, category, military,
    lat, lon, alt (ft, -1 on the ground, None unknown), gs, track, vrate, squawk]."""
    lat, lon = _num(a.get("lat"), 5), _num(a.get("lon"), 5)
    if lat is None or lon is None or abs(lat) > 90 or abs(lon) > 180:
        return None
    if isinstance(a.get("seen_pos"), (int, float)) and a["seen_pos"] > 60:
        return None
    hexid = _str(a.get("hex"), 12).lower()
    if not re.fullmatch(r"~?[0-9a-f]{6}", hexid):
        return None
    alt = -1 if a.get("alt_baro") == "ground" else _num(a.get("alt_baro"), 0)
    track = _num(a.get("track"), 0)
    if track is None:
        track = _num(a.get("true_heading"), 0)
    vrate = _num(a.get("baro_rate"), 0)
    if vrate is None:
        vrate = _num(a.get("geom_rate"), 0)
    flags = a.get("dbFlags")
    return [hexid, _str(a.get("flight"), 10), _str(a.get("r"), 12), _str(a.get("t"), 6),
            _str(a.get("category"), 2), 1 if isinstance(flags, int) and flags & 1 else 0,
            lat, lon, alt, _num(a.get("gs"), 0), track, vrate, _str(a.get("squawk"), 4)]


def planes_rate_ok(ip):
    now = time.time()
    with planes_lock:
        recent = [t for t in planes_log.get(ip, []) if now - t < 600]
        ok = len(recent) < PLANES_PER_IP
        if ok:
            recent.append(now)
        planes_log[ip] = recent
        if len(planes_log) > 10000:
            for k in [k for k, v in planes_log.items() if not v or now - v[-1] >= 600]:
                del planes_log[k]
        return ok


def fetch_planes(lat, lon, dist):
    key = f"{lat}/{lon}/{dist}"
    with planes_lock:
        hit = planes_cache.get(key)
        if hit and time.time() - hit[0] < PLANES_CACHE_SECONDS:
            return hit[1]
    req = urllib.request.Request(f"{PLANES_UPSTREAM}/{lat}/{lon}/{dist}",
                                 headers={"Accept": "application/json",
                                          "User-Agent": "EveryAirfield/1.0 (live map; cached 5s)"})
    with urllib.request.urlopen(req, timeout=8) as res:
        data = json.loads(res.read(8_000_000))
    rows = [r for r in (compact_plane(a) for a in (data.get("ac") or []) if isinstance(a, dict)) if r]
    body = json.dumps({"now": data.get("now") if isinstance(data.get("now"), (int, float)) else int(time.time() * 1000),
                       "ac": rows}, separators=(",", ":")).encode()
    with planes_lock:
        planes_cache[key] = (time.time(), body)
        if len(planes_cache) > 500:
            for k in [k for k, v in planes_cache.items() if time.time() - v[0] > PLANES_CACHE_SECONDS]:
                del planes_cache[k]
    return body


def rate_ok(ip):
    now = time.time()
    with lock:
        recent = [t for t in post_log.get(ip, []) if now - t < 600]
        if len(recent) >= POSTS_PER_IP:
            post_log[ip] = recent
            return False
        recent.append(now)
        post_log[ip] = recent
        if len(post_log) > 10000:    # forget idle addresses so this can't grow without limit
            for k in [k for k, v in post_log.items() if now - v[-1] >= 600]:
                del post_log[k]
        return True


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        # defence in depth on top of index.html's Content Security Policy
        self.send_header("X-Frame-Options", "SAMEORIGIN")                 # no clickjacking from other sites
        self.send_header("Content-Security-Policy", "frame-ancestors 'self'")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Permissions-Policy", "geolocation=(self), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        # lets a copy of the site hosted elsewhere (e.g. GitHub Pages) use this server's price API.
        # "*" is fine here: the API has no cookies or logins, and prices are public anyway.
        if self.path.startswith("/api/"):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def send_json(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_head(self):
        # Used by both GET and HEAD. Decide on the real file path (after %-decoding, "#", "?", "..",
        # case and symlinks are all resolved), not on the raw URL text, which is easy to disguise
        # (e.g. /server%2epy or /SERVER.PY). Hidden files, Python files, prices.json, the supabase/
        # folder and folder listings are not served.
        path = Path(self.translate_path(self.path)).resolve()
        try:
            rel = path.relative_to(ROOT)
        except ValueError:
            rel = None
        if (rel is None
                or any(p.startswith(".") for p in rel.parts)
                or (rel.parts and rel.parts[0].lower() == "supabase")
                or path.suffix.lower() == ".py"
                or path.name.lower() == PRICES.name
                or (path.is_dir() and path != ROOT)):
            self.send_error(404)
            return None
        if path == ROOT and not (ROOT / "index.html").is_file():
            self.send_error(404)          # never fall back to a folder listing
            return None
        return super().send_head()

    def do_GET(self):
        if self.path.split("?")[0] == "/api/prices":
            with lock:
                self.send_json(200, {"prices": list(load().values())})
            return
        if self.path.split("?")[0] == "/api/planes":
            self.serve_planes()
            return
        super().do_GET()

    def serve_planes(self):
        q = parse_qs(urlsplit(self.path).query)
        try:
            lat, lon, dist = (float(q[k][0]) for k in ("lat", "lon", "dist"))
            if not (abs(lat) <= 90 and abs(lon) <= 180 and 0 < dist):
                raise ValueError
        except (KeyError, ValueError, IndexError):
            self.send_json(400, {"error": "Send lat, lon and dist (nautical miles)."})
            return
        if not planes_rate_ok(self.client_address[0]):
            self.send_json(429, {"error": "Too many requests. Try again in a few minutes."})
            return
        # snap to a coarse grid so nearby views share one cached answer
        lat, lon = round(lat * 4) / 4, round(lon * 4) / 4
        dist = min(MAX_DIST_NM, -(-int(dist) // 25) * 25)
        try:
            body = fetch_planes(lat, lon, dist)
        except (urllib.error.URLError, TimeoutError, ValueError, OSError):
            self.send_json(502, {"error": "Live planes are unavailable right now."})
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "public, max-age=5")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path.split("?")[0] != "/api/prices":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            # a negative length would make read() wait for the client to hang up, reading forever
            if not 0 < length <= MAX_BODY:
                raise ValueError("bad body size")
            body = json.loads(self.rfile.read(length))
            ident, fuel, price = body["ident"], body["fuel"], body["price"]
            # bool is a subclass of int in Python, so rule it out explicitly
            if not isinstance(ident, str) or not isinstance(fuel, str) \
                    or isinstance(price, bool) or not isinstance(price, (int, float)):
                raise ValueError("bad types")
            price = round(float(price), 2)
            if not IDENT_RE.match(ident) or (IDENTS is not None and ident not in IDENTS) \
                    or fuel not in FUELS or not 0 < price <= 50:
                raise ValueError("bad values")
        except (ValueError, KeyError, TypeError, RecursionError):
            self.send_json(400, {"error": "Send ident, fuel (100LL, JetA or MOGAS) and a price between 0 and 50."})
            return
        if not rate_ok(self.client_address[0]):
            self.send_json(429, {"error": "Too many reports from this address. Try again in a few minutes."})
            return
        rec = {"ident": ident, "fuel": fuel, "price": price, "at": int(time.time() * 1000)}
        with lock:
            prices = load()
            prices[f"{ident}~{fuel}"] = rec
            save(prices)
        self.send_json(200, rec)


if __name__ == "__main__":
    print("Every Airfield running at http://localhost:8000  (Ctrl+C to stop)")
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
