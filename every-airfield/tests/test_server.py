"""API tests for server.py's /api/prices and /api/planes (no browser needed).

usage: python3 -I test_server.py <site-dir>
"""
import http.client
import importlib.util
import json
import socket
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.dont_write_bytecode = True   # don't leave __pycache__ in the site folder
SITE = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent).resolve()
spec = importlib.util.spec_from_file_location("ea_server", SITE / "server.py")
ea = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ea)


class Api(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        ea.PRICES = Path(cls.tmp.name) / "prices.json"
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), type("Q", (ea.Handler,), {"log_message": lambda *a: None}))
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.tmp.cleanup()

    def req(self, method, path, body=None, headers=None, raw=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        c.request(method, path, body=data, headers={"Content-Type": "application/json", **(headers or {})})
        r = c.getresponse()
        out = r.read()
        c.close()
        try:
            return r.status, json.loads(out)
        except ValueError:
            return r.status, out

    def prices(self):
        return self.req("GET", "/api/prices")[1]["prices"]

    def test_01_empty_list(self):
        s, b = self.req("GET", "/api/prices")
        self.assertEqual(s, 200)
        self.assertEqual(b, {"prices": []})

    def test_02_valid_post_and_overwrite(self):
        s, rec = self.req("POST", "/api/prices", {"ident": "KSMO", "fuel": "100LL", "price": 6.256})
        self.assertEqual(s, 200)
        self.assertEqual(rec["price"], 6.26)
        self.assertIsInstance(rec["at"], int)
        self.req("POST", "/api/prices", {"ident": "KSMO", "fuel": "100LL", "price": 5})
        same = [p for p in self.prices() if p["ident"] == "KSMO" and p["fuel"] == "100LL"]
        self.assertEqual(len(same), 1)
        self.assertEqual(same[0]["price"], 5)

    def test_03_rejects_bad_values(self):
        before = len(self.prices())
        bad = [
            {"ident": "KSMO", "fuel": "100LL", "price": 0},
            {"ident": "KSMO", "fuel": "100LL", "price": -1},
            {"ident": "KSMO", "fuel": "100LL", "price": 50.01},
            {"ident": "KSMO", "fuel": "100LL", "price": 0.004},     # rounds to 0
            {"ident": "KSMO", "fuel": "100LL", "price": "abc"},
            {"ident": "KSMO", "fuel": "100LL", "price": None},
            {"ident": "KSMO", "fuel": "Diesel", "price": 5},
            {"ident": "", "fuel": "100LL", "price": 5},
            {"ident": "../x", "fuel": "100LL", "price": 5},
            {"ident": "<script>", "fuel": "100LL", "price": 5},
            {"ident": "A" * 17, "fuel": "100LL", "price": 5},
            {"fuel": "100LL", "price": 5},
            {"ident": "KSMO", "price": 5},
            {"ident": "KSMO", "fuel": "100LL"},
        ]
        for b in bad:
            with self.subTest(body=b):
                self.assertEqual(self.req("POST", "/api/prices", b)[0], 400)
        for raw in [b"not json", b"[]", b"null", b'"str"', b'{"ident":"KSMO","fuel":"100LL","price":NaN}',
                    b'{"ident":"KSMO","fuel":"100LL","price":Infinity}', b"\xff\xfe"]:
            with self.subTest(raw=raw):
                self.assertEqual(self.req("POST", "/api/prices", raw=raw)[0], 400)
        self.assertEqual(len(self.prices()), before)

    def test_04_body_too_large(self):
        s, _ = self.req("POST", "/api/prices", raw=b"{" + b" " * 3000 + b"}")
        self.assertEqual(s, 400)

    def test_05_private_files_not_served(self):
        for p in ["/server.py", "/prices.json", "/server.py?x=1"]:
            with self.subTest(path=p):
                self.assertEqual(self.req("GET", p)[0], 404)

    def test_05b_disguised_private_files_not_served(self):
        # the check runs on the decoded, resolved file path, so %-encoding and case tricks don't work
        for p in ["/server.p%79", "/server%2epy", "/SERVER.PY", "/prices.jso%6E", "/supabase/schema.sql", "/tests/", "/.gitignore"]:
            with self.subTest(path=p):
                self.assertEqual(self.req("GET", p)[0], 404)

    def test_06_other_post_paths_404(self):
        self.assertEqual(self.req("POST", "/index.html", {})[0], 404)

    def test_07_cors_preflight(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("OPTIONS", "/api/prices")
        r = c.getresponse()
        self.assertEqual(r.status, 204)
        self.assertEqual(r.getheader("Access-Control-Allow-Origin"), "*")
        c.close()

    def test_08_concurrent_posts_all_kept(self):
        ea.post_log.clear()                    # start a fresh 10-minute window for this address
        idents = sorted(ea.IDENTS)[:20]        # only real airports can have prices
        ts = [threading.Thread(target=self.req, args=("POST", "/api/prices", {"ident": i, "fuel": "JetA", "price": 4})) for i in idents]
        [t.start() for t in ts]
        [t.join() for t in ts]
        have = {p["ident"] for p in self.prices()}
        self.assertTrue(set(idents) <= have)

    def test_09_negative_content_length_does_not_hang(self):
        # a negative length used to make the server wait for the client forever
        s = socket.create_connection(("127.0.0.1", self.port), timeout=3)
        s.sendall(b"POST /api/prices HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: -1\r\n\r\n{}")
        try:
            self.assertTrue(s.recv(100).startswith(b"HTTP/1.0 400"))
        finally:
            s.close()

    def test_09b_security_headers(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("GET", "/index.html")
        r = c.getresponse(); r.read(); c.close()
        self.assertEqual(r.status, 200)
        self.assertEqual(r.getheader("X-Frame-Options"), "SAMEORIGIN")
        self.assertEqual(r.getheader("X-Content-Type-Options"), "nosniff")
        self.assertIn("frame-ancestors 'self'", r.getheader("Content-Security-Policy"))
        self.assertIn("camera=()", r.getheader("Permissions-Policy"))
        self.assertEqual(r.getheader("Cross-Origin-Opener-Policy"), "same-origin")

    def test_09c_page_policy_matches_its_script(self):
        # index.html's Content Security Policy must carry the hash of its current script, or the page won't run
        import subprocess
        r = subprocess.run([sys.executable, "-I", str(SITE / "tools" / "csp.py"), "--check"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        html = (SITE / "index.html").read_text()
        for d in ("script-src 'sha256-", "object-src 'none'", "base-uri 'none'", "form-action 'none'"):
            self.assertIn(d, html)
        self.assertNotIn("'unsafe-eval'", html)
        self.assertNotIn("script-src 'unsafe-inline'", html)

    def test_10_made_up_airports_refused(self):
        ea.post_log.clear()
        self.assertEqual(self.req("POST", "/api/prices", {"ident": "ZZZZ9", "fuel": "100LL", "price": 5})[0], 400)

    def test_11_report_limit_per_address(self):
        ea.post_log.clear()
        ident = sorted(ea.IDENTS)[0]
        codes = [self.req("POST", "/api/prices", {"ident": ident, "fuel": "MOGAS", "price": 4})[0] for _ in range(31)]
        self.assertEqual(codes[:30], [200] * 30)
        self.assertEqual(codes[30], 429)
        ea.post_log.clear()


class Planes(unittest.TestCase):
    """/api/planes against a fake adsb.lol, so the test doesn't depend on the internet."""

    @classmethod
    def setUpClass(cls):
        from http.server import BaseHTTPRequestHandler
        cls.upstream_hits = []
        sample = {"now": 1700000000000, "ac": [
            {"hex": "a2615e", "flight": "UAL1821 ", "r": "N25201", "t": "B738", "category": "A3", "lat": 40.6143, "lon": -75.0756,
             "alt_baro": 10600, "gs": 304.3, "track": 132.6, "baro_rate": -704, "squawk": "3514", "seen_pos": 0.1},
            {"hex": "ae1234", "flight": "RCH123", "t": "C17", "category": "A5", "dbFlags": 1, "lat": 40.1, "lon": -74.5,
             "alt_baro": "ground", "gs": 12, "track": 90},
            {"hex": "bad", "lat": 40, "lon": -74},                                   # malformed address: dropped
            {"hex": "a00001", "lat": 40.2, "lon": -74.2, "seen_pos": 300},           # stale position: dropped
            {"hex": "a00002", "flight": "<b>x</b>", "lat": 40.3, "lon": -74.3},     # passed through as plain data; the page escapes it
        ]}
        hits = cls.upstream_hits

        class Fake(BaseHTTPRequestHandler):
            def do_GET(self):
                hits.append(self.path)
                body = json.dumps(sample).encode()
                self.send_response(200); self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

            def log_message(self, *a):
                pass

        cls.fake = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=cls.fake.serve_forever, daemon=True).start()
        ea.PLANES_UPSTREAM = f"http://127.0.0.1:{cls.fake.server_address[1]}/v2/point"
        ea.planes_cache.clear()
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), type("Q", (ea.Handler,), {"log_message": lambda *a: None}))
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.fake.shutdown()

    def get(self, path):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("GET", path)
        r = c.getresponse()
        out = r.read()
        c.close()
        return r.status, out

    def test_01_compact_rows(self):
        s, out = self.get("/api/planes?lat=40.7&lon=-74.0&dist=60")
        self.assertEqual(s, 200)
        ac = json.loads(out)["ac"]
        self.assertEqual(len(ac), 3)
        self.assertEqual(ac[0], ["a2615e", "UAL1821", "N25201", "B738", "A3", 0, 40.6143, -75.0756, 10600, 304, 133, -704, "3514"])
        self.assertEqual(ac[1][5], 1)            # military flag
        self.assertEqual(ac[1][8], -1)           # on the ground
        self.assertEqual(ac[2][1], "<b>x</b>")
        self.assertIn("/v2/point/40.75/-74.0/75", self.upstream_hits[-1])   # snapped to the shared grid

    def test_02_cached_for_nearby_views(self):
        before = len(self.upstream_hits)
        self.get("/api/planes?lat=40.71&lon=-74.02&dist=55")   # same snapped area as test_01
        self.assertEqual(len(self.upstream_hits), before)

    def test_03_bad_requests(self):
        for q in ["", "?lat=91&lon=0&dist=50", "?lat=40&lon=181&dist=50", "?lat=40&lon=0&dist=0", "?lat=x&lon=0&dist=5"]:
            with self.subTest(q=q):
                self.assertEqual(self.get("/api/planes" + q)[0], 400)

    def test_04_radius_capped(self):
        ea.planes_cache.clear()
        self.get("/api/planes?lat=10&lon=10&dist=5000")
        self.assertTrue(self.upstream_hits[-1].endswith("/250"))


if __name__ == "__main__":
    import os
    res = unittest.main(argv=[sys.argv[0], "-v"], exit=False).result
    sys.stdout.flush(); sys.stderr.flush()
    os._exit(0 if res.wasSuccessful() else 1)   # skip interpreter teardown: the hung handler thread from test_09 can abort it
