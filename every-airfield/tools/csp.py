#!/usr/bin/env python3
"""Write index.html's Content Security Policy.

  python3 tools/csp.py            update the policy (run after editing index.html's script)
  python3 tools/csp.py --check    exit 1 if the policy is out of date (the tests run this)

The policy lets the browser run exactly one script: the one in index.html, identified by its SHA-256
hash. Anything injected into the page (a script tag, an inline event handler, javascript: links) is
refused. It also limits where the page may send data: its own server, and the Supabase project and
price server set in index.html. Nothing else.
setup/setup.py and desktop/build.py run this automatically.
"""
import base64
import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
META_RE = re.compile(r'<meta http-equiv="Content-Security-Policy" content="[^"]*">\n')
VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'


def origin(url):
    m = re.match(r"^(https?://[A-Za-z0-9.-]+(?::\d+)?)", url or "")
    return m.group(1) if m else None


def policy(html):
    scripts = re.findall(r"<script>(.*?)</script>", html, re.S)
    if len(scripts) != 1:
        raise SystemExit(f"index.html should have exactly one inline script, found {len(scripts)}.")
    digest = base64.b64encode(hashlib.sha256(scripts[0].encode("utf-8")).digest()).decode()
    connect = ["'self'"]
    for pattern in (r"const PRICE_API = '([^']*)'", r"const AUTH = \{\s*url: '([^']*)'"):
        m = re.search(pattern, html)
        o = origin(m.group(1)) if m else None
        if o and o not in connect:
            connect.append(o)
    return "; ".join([
        "default-src 'self'",
        f"script-src 'sha256-{digest}'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: blob:",
        "connect-src " + " ".join(connect),
        "worker-src 'none'",
        "object-src 'none'",
        "frame-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
    ])


def update(path=ROOT / "index.html", check=False):
    html = path.read_text(encoding="utf-8")
    meta = f'<meta http-equiv="Content-Security-Policy" content="{policy(html)}">\n'
    if META_RE.search(html):
        new = META_RE.sub(lambda _: meta, html, count=1)
    elif VIEWPORT in html:
        new = html.replace(VIEWPORT, VIEWPORT + meta, 1)
    else:
        raise SystemExit("Couldn't find where to put the policy in index.html.")
    if check:
        return new == html
    if new != html:
        path.write_text(new, encoding="utf-8")
    return True


if __name__ == "__main__":
    if "--check" in sys.argv:
        ok = update(check=True)
        print("Content Security Policy is up to date." if ok else "Out of date: run python3 tools/csp.py")
        sys.exit(0 if ok else 1)
    update()
    print("index.html's Content Security Policy is updated.")
