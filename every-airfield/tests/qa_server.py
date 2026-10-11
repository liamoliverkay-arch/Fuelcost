"""Test server for the Every Airfield end-to-end suite.

usage: python3 -I qa_server.py <site-dir> <port> <out-dir>

* Serves <site-dir> through the real server.py Handler (so /api/prices is the code under test),
  but stores prices in <out-dir>/prices.json so every run starts empty.
* /index.html is served with a tiny test hook (window.__qa, read-only getters into the page's
  closure) and tests/e2e.js appended. The page source on disk is never changed.
* POST /__result appends one JSON line to <out-dir>/results.jsonl.
* GET /__ctl?apifail=1|0&postfail=1|0 makes the price API fail (503) to test error paths.
  QA_APIFAIL=1 in the environment starts with the whole API failing.
* /api/planes goes through the real server.py code, but its "adsb.lol" is a fake at
  /__fake_adsb/v2/point/<lat>/<lon>/<dist> serving a fixed set of test planes around that point.
"""
import importlib.util
import json
import os
import re
import sys
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.dont_write_bytecode = True   # don't leave __pycache__ in the site folder
SITE, PORT, OUT = Path(sys.argv[1]).resolve(), int(sys.argv[2]), Path(sys.argv[3]).resolve()
TESTS = Path(__file__).resolve().parent
OUT.mkdir(parents=True, exist_ok=True)

spec = importlib.util.spec_from_file_location("ea_server", SITE / "server.py")
ea = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ea)
ea.ROOT = SITE
ea.PRICES = OUT / "prices.json"
ea.PLANES_UPSTREAM = f"http://127.0.0.1:{PORT}/__fake_adsb/v2/point"

# test planes: [hex, callsign, registration, type, category, military flag], laid out on a ring around the point
FAKE_PLANES = [("aa0001", "TST001", "N1001", "B738", "A3", 0), ("aa0002", "TST002", "N1002", "A320", "A3", 0),
               ("aa0003", "TST003", "N1003", "B77W", "A5", 0), ("aa0004", "TST004", "N1004", "CL35", "A2", 0),
               ("aa0005", "N4141G", "N4141G", "PA46", "A1", 0), ("aa0006", "N55KX", "N55KX", "C172", "A1", 0),
               ("aa0007", "LIFE1", "N911LF", "EC35", "A7", 0), ("ae0008", "RCH123", "05-5140", "C17", "A5", 1),
               ("aa0009", "GLD9", "N9GL", "ASK2", "B1", 0), ("aa0010", "", "", "", "", 0)]

CTL = {"apifail": os.environ.get("QA_APIFAIL") == "1", "postfail": False}
out_lock = threading.Lock()

EARLY = ("<script>window.__qaErr=[];addEventListener('error',e=>__qaErr.push(String(e.message)+' @'+e.lineno+':'+e.colno));"
         "addEventListener('unhandledrejection',e=>__qaErr.push('unhandled rejection: '+(e.reason&&(e.reason.stack||e.reason.message)||e.reason)));</script>")
HOOK = """  window.__qa = { view, finder, enabled, identIdx, invalidate, planes, settings, airspace, select,
    get planeHits() { return planeHits; }, get selPlane() { return selPlane; }, get selAirspace() { return selAirspace; },
    get recents() { return recents; }, get currentTab() { return currentTab; },
    get N() { return N; }, get W() { return W; }, get H() { return H; }, get DPR() { return DPR; },
    get X() { return X; }, get Y() { return Y; }, get LAT() { return LAT; }, get LON() { return LON; }, get T() { return T; },
    get IDENT() { return IDENT; }, get NAME() { return NAME; }, get selected() { return selected; }, get airportsShown() { return airportsShown; },
    get priceHits() { return priceHits; }, get pricesByAirport() { return pricesByAirport; }, get store() { return store; },
    get pickMode() { return pickMode; }, get anim() { return anim; }, get colors() { return colors; } };
"""
ANCHOR = "  connectStore();\n})();"


def sha(script):
    import base64, hashlib
    return "'sha256-" + base64.b64encode(hashlib.sha256(script.encode("utf-8")).digest()).decode() + "'"


def page():
    s = (SITE / "index.html").read_text()
    assert s.count(ANCHOR) == 1, "test hook anchor not found in index.html"
    m = re.search(r"script-src ('sha256-[^']+')", s)
    assert m, "index.html has no Content Security Policy"
    # the tests run under the page's real policy: the test hook changes the app script, so the policy
    # is given the hashes of exactly the scripts this server serves, and nothing else
    s = s.replace(ANCHOR, HOOK + ANCHOR)
    app = re.findall(r"<script>(.*?)</script>", s, re.S)[0]
    early = EARLY[len("<script>"):-len("</script>")]
    js = "\n" + (TESTS / "e2e.js").read_text() + "\n"
    s = s.replace("script-src " + m.group(1), "script-src " + " ".join([sha(app), sha(early), sha(js)]), 1)
    s = s.replace("<head>", "<head>\n" + EARLY, 1)
    i = s.rindex("</html>")
    return (s[:i] + "<script>" + js + "</script>\n" + s[i:]).encode()


class H(ea.Handler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        u = urlparse(self.path)
        if u.path in ("/", "/index.html"):
            body = page()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if u.path == "/__frame":
            # a fixed-size viewport (e.g. a 390x844 phone): Firefox won't size a top-level window below 500 px
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            w, h, suite = int(q.get("w", 390)), int(q.get("h", 844)), q.get("suite", "phone")
            body = (f'<!doctype html><style>html,body{{margin:0}}iframe{{border:0;display:block}}</style>'
                    f'<iframe width="{w}" height="{h}" src="/index.html?suite={suite}#home"></iframe>').encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if u.path.startswith("/__fake_adsb/v2/point/"):
            import math
            lat, lon, dist = (float(x) for x in u.path.rsplit("/", 3)[1:])
            ac = []
            for k, (hexid, cs, reg, typ, cat, mil) in enumerate(FAKE_PLANES):
                a = 2 * math.pi * k / len(FAKE_PLANES)
                r = 0.15 + 0.05 * (k % 3)                      # degrees from the centre
                ac.append({"hex": hexid, "flight": cs + " ", "r": reg, "t": typ, "category": cat, "dbFlags": mil,
                           "lat": lat + r * math.cos(a), "lon": lon + r * math.sin(a) / max(0.2, math.cos(math.radians(lat))),
                           "alt_baro": "ground" if k == 5 else 3000 + 3500 * k, "gs": 0 if k == 5 else 120 + 40 * k,
                           "track": (37 * k) % 360, "baro_rate": 64 * (k - 4), "squawk": f"{1200 + k:04d}", "seen_pos": 0.4})
            self.send_json(200, {"now": 1700000000000, "ac": ac})
            return
        if u.path == "/__ctl":
            for k, v in parse_qs(u.query).items():
                if k in CTL:
                    CTL[k] = v[0] == "1"
            self.send_json(200, CTL)
            return
        if u.path.startswith("/api/") and CTL["apifail"]:
            self.send_json(503, {"error": "test: api down"})
            return
        super().do_GET()

    def do_POST(self):
        u = urlparse(self.path)
        if u.path == "/__result":
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            with out_lock, open(OUT / "results.jsonl", "ab") as f:
                f.write(body.replace(b"\n", b" ") + b"\n")
            self.send_json(200, {})
            return
        if u.path.startswith("/api/") and (CTL["apifail"] or CTL["postfail"]):
            self.rfile.read(int(self.headers.get("Content-Length", 0) or 0))
            self.send_json(503, {"error": "test: api down"})
            return
        super().do_POST()


ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
