#!/usr/bin/env python3
"""Every Airfield setup: switch on email sign-in codes and live planes.

Before running this, make two free accounts:
  1. Supabase  https://supabase.com      create a project (any name, any region)
  2. Brevo     https://www.brevo.com     add a sender address (Senders, Domains & Dedicated IPs → Senders)
                                         and create an API key (SMTP & API → API keys)
You'll also need a Supabase access token: https://supabase.com/dashboard/account/tokens

Then, from the project folder:
  python3 setup/setup.py               connect everything (safe to run again)
  python3 setup/setup.py unban EMAIL   lift a ban (also lifts the device banned with it)
  python3 setup/setup.py bans          list current bans

Your access token and API key are only used while this runs. The Brevo key is stored as a Supabase
secret (never in the website's files), and the token isn't saved anywhere.
Only Python 3 is needed; nothing gets installed.
"""
import getpass
import json
import os
import re
import secrets
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SUPABASE_API = os.environ.get("SUPABASE_API", "https://api.supabase.com").rstrip("/")
BREVO_API = os.environ.get("BREVO_API", "https://api.brevo.com/v3").rstrip("/")
PROJECT_FILE = ROOT / ".supabase-project"        # remembers which project (not secret; git-ignored)
FUNCTIONS = ["ea-auth", "ea-planes", "ea-prices"]
DESKTOP_ORIGIN = "app://every-airfield"          # the desktop apps (Windows, Mac, Linux) load the site from here
NONINTERACTIVE = "--yes" in sys.argv           # take answers from EA_* environment variables (used by tests)


class SetupError(Exception):
    pass


# ---------- talking to the outside world ----------

def http(method, url, headers=None, body=None, raw=None, content_type="application/json", timeout=60):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    h = {"Accept": "application/json", "User-Agent": "EveryAirfield-setup/1.0", **(headers or {})}
    if data is not None:
        h["Content-Type"] = content_type
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            text = res.read().decode("utf-8", "replace")
            return res.status, (json.loads(text) if text.strip() else None)
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace")
        try:
            payload = json.loads(text)
        except ValueError:
            payload = text
        return e.code, payload
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise SetupError(f"Couldn't reach {url.split('/')[2]}: {e}. Check your internet connection and try again.")


def message_of(payload):
    if isinstance(payload, dict):
        return payload.get("message") or payload.get("msg") or payload.get("error") or json.dumps(payload)[:300]
    return str(payload)[:300]


def supa(token, method, path, body=None, raw=None, content_type="application/json"):
    status, payload = http(method, SUPABASE_API + path, {"Authorization": "Bearer " + token}, body, raw, content_type)
    if status == 401:
        raise SetupError("Supabase didn't accept the access token. Create a new one at "
                         "https://supabase.com/dashboard/account/tokens and try again.")
    if status >= 400:
        raise SetupError(f"Supabase said {status}: {message_of(payload)}")
    return payload


def brevo(key, path):
    status, payload = http("GET", BREVO_API + path, {"api-key": key})
    if status == 401:
        raise SetupError("Brevo didn't accept the API key. Create one under SMTP & API → API keys "
                         "(an API key, not an SMTP key) and try again.")
    if status >= 400:
        raise SetupError(f"Brevo said {status}: {message_of(payload)}")
    return payload


def run_sql(token, ref, query, parameters=None):
    body = {"query": query}
    if parameters:
        body["parameters"] = parameters
    return supa(token, "POST", f"/v1/projects/{ref}/database/query", body)


def deploy_function(token, ref, slug):
    source = (ROOT / "supabase" / "functions" / slug / "index.ts").read_bytes()
    boundary = "----everyairfield" + secrets.token_hex(12)
    meta = json.dumps({"entrypoint_path": "index.ts", "name": slug, "verify_jwt": False})
    parts = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n{meta}\r\n'.encode(),
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="index.ts"\r\nContent-Type: application/typescript\r\n\r\n'.encode()
        + source + b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ]
    return supa(token, "POST", f"/v1/projects/{ref}/functions/deploy?slug={slug}", raw=b"".join(parts),
                content_type="multipart/form-data; boundary=" + boundary)


# ---------- questions ----------

def ask(prompt, default=None, env=None, secret=False, check=None):
    if NONINTERACTIVE and env and os.environ.get(env) is not None:
        value = os.environ[env]
    elif NONINTERACTIVE:
        value = default or ""
    else:
        shown = f"{prompt} [{default}]: " if default else f"{prompt}: "
        value = (getpass.getpass(shown) if secret else input(shown)).strip() or (default or "")
    value = value.strip()
    if check:
        err = check(value)
        if err:
            if NONINTERACTIVE:
                raise SetupError(err)
            print("  " + err)
            return ask(prompt, default, env, secret, check)
    return value


def access_token():
    token = os.environ.get("SUPABASE_ACCESS_TOKEN") or ask(
        "Supabase access token (from supabase.com/dashboard/account/tokens; typing is hidden)", secret=True,
        check=lambda v: None if v else "Paste the token, then press Enter.")
    return token


def pick_project(token):
    remembered = PROJECT_FILE.read_text().strip() if PROJECT_FILE.exists() else ""
    projects = supa(token, "GET", "/v1/projects") or []
    if not projects:
        raise SetupError("This Supabase account has no projects yet. Create one at https://supabase.com/dashboard, "
                         "wait until it says it's ready, then run this again.")
    by_ref = {p["ref"]: p for p in projects}
    wanted = os.environ.get("EA_PROJECT") or remembered
    if wanted in by_ref and (NONINTERACTIVE or len(projects) == 1 or remembered):
        project = by_ref[wanted]
    elif len(projects) == 1:
        project = projects[0]
    else:
        print("\nYour Supabase projects:")
        for i, p in enumerate(projects, 1):
            print(f"  {i}. {p['name']}  ({p['ref']}, {p.get('region', '?')})")
        n = ask("Which one should Every Airfield use? Number", "1",
                check=lambda v: None if v.isdigit() and 1 <= int(v) <= len(projects) else f"Type a number from 1 to {len(projects)}.")
        project = projects[int(n) - 1]
    if project.get("status") not in (None, "ACTIVE_HEALTHY"):
        raise SetupError(f"Project {project['name']} isn't ready (status {project.get('status')}). "
                         "If it's paused, restore it in the Supabase dashboard, then run this again.")
    PROJECT_FILE.write_text(project["ref"] + "\n")
    print(f"  Using project {project['name']} ({project['ref']}).")
    return project["ref"]


ORIGIN_RE = re.compile(r"^https?://[A-Za-z0-9.-]+(:\d{1,5})?$")


def check_origins(v):
    parts = [p.strip().rstrip("/") for p in v.split(",") if p.strip()]
    if not parts:
        return "Enter at least one address."
    bad = [p for p in parts if not ORIGIN_RE.match(p)]
    if bad:
        return (f"These aren't site addresses: {', '.join(bad)}. Use only the start of the address, like "
                "https://yourname.github.io (no /folder at the end).")
    return None


# ---------- commands ----------

def cmd_setup():
    print(__doc__.split("Then, from")[0].strip(), "\n")
    for f in ["supabase/schema.sql", *(f"supabase/functions/{fn}/index.ts" for fn in FUNCTIONS), "index.html"]:
        if not (ROOT / f).exists():
            raise SetupError(f"{f} is missing. Run this from a complete copy of the project.")

    print("Step 1 of 7: Supabase")
    token = access_token()
    ref = pick_project(token)

    print("\nStep 2 of 7: Brevo (sends the code emails)")
    brevo_key = os.environ.get("BREVO_API_KEY") or ask(
        "Brevo API key (starts with xkeysib-; typing is hidden)", secret=True,
        check=lambda v: None if v else "Paste the key, then press Enter.")
    account = brevo(brevo_key, "/account")
    print(f"  Brevo account: {account.get('email', 'OK')}")
    senders = (brevo(brevo_key, "/senders") or {}).get("senders") or []
    active = [s for s in senders if s.get("active")]
    if not active:
        raise SetupError("Brevo has no verified sender yet. In Brevo, open Senders, Domains & Dedicated IPs → Senders, "
                         "add the address codes should come from, click the link Brevo emails you, then run this again.")
    print("  Verified senders: " + ", ".join(s["email"] for s in active))
    sender = ask("Send codes from which address?", active[0]["email"], env="EA_SENDER",
                 check=lambda v: None if v.lower() in {s["email"].lower() for s in active}
                 else "Pick one of the verified senders listed above.")
    sender_name = ask("Sender name people will see", "Every Airfield", env="EA_SENDER_NAME",
                      check=lambda v: None if 0 < len(v) <= 70 else "Use 1 to 70 characters.")

    print("\nStep 3 of 7: Where the site runs")
    print("  Only these addresses (plus the desktop apps) can use sign-in, prices and live planes. For GitHub Pages use")
    print("  https://YOURNAME.github.io (just that part, even if the site lives in a /folder).")
    origins = ask("Site addresses, comma-separated", "https://YOURNAME.github.io,http://localhost:8000", env="EA_ORIGINS",
                  check=lambda v: "Replace YOURNAME with your GitHub username." if "YOURNAME" in v else check_origins(v))
    origins = ",".join(p.strip().rstrip("/") for p in origins.split(",") if p.strip())
    if DESKTOP_ORIGIN not in origins.split(","):
        origins += "," + DESKTOP_ORIGIN          # always allow the desktop apps
    contact = ask("Email shown to suspended visitors, so they can ask to be unbanned (Enter to skip)", "", env="EA_CONTACT",
                  check=lambda v: None if not v or re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", v) else "That doesn't look like an email address.")

    print("\nStep 4 of 7: Database tables and rules")
    run_sql(token, ref, (ROOT / "supabase" / "schema.sql").read_text())
    print("  Done.")

    print("\nStep 5 of 7: Secrets (kept inside Supabase, not in your files)")
    existing = {s.get("name") for s in (supa(token, "GET", f"/v1/projects/{ref}/secrets") or [])}
    new = [
        {"name": "ALLOWED_ORIGINS", "value": origins},
        {"name": "BREVO_API_KEY", "value": brevo_key},
        {"name": "SENDER_EMAIL", "value": sender},
        {"name": "SENDER_NAME", "value": sender_name},
    ]
    # random keys are made once and then kept, so codes and limits survive running this again
    for name in ("IP_SALT", "CODE_PEPPER"):
        if name not in existing:
            new.append({"name": name, "value": secrets.token_urlsafe(48)})
    supa(token, "POST", f"/v1/projects/{ref}/secrets", new)
    print("  Done: " + ", ".join(s["name"] for s in new))

    print("\nStep 6 of 7: Server functions")
    for slug in FUNCTIONS:
        out = deploy_function(token, ref, slug)
        print(f"  {slug}: {(out or {}).get('status', 'deployed')}")

    print("\nStep 7 of 7: Connecting the website")
    url = f"https://{ref}.supabase.co"
    html_path = ROOT / "index.html"
    html = html_path.read_text(encoding="utf-8")
    block = re.search(r"const AUTH = \{.*?\n  \};", html, re.S)
    if not block:
        raise SetupError("Couldn't find the AUTH settings in index.html. Set url to " + url + " by hand.")
    new_block = re.sub(r"url: '[^']*'", f"url: '{url}'", block.group(0), count=1)
    new_block = re.sub(r"contact: '[^']*'", "contact: " + json.dumps(contact).replace('"', "'"), new_block, count=1)
    html_path.write_text(html.replace(block.group(0), new_block), encoding="utf-8")
    # the page's security policy names its script by hash and lists the servers it may talk to: refresh it
    import subprocess
    subprocess.run([sys.executable, "-I", str(ROOT / "tools" / "csp.py")], check=True)
    print(f"  index.html now points at {url} (security policy updated)")

    test_to = ask("\nSend a test code to which email? (Enter to skip)", "", env="EA_TEST_EMAIL")
    if test_to:
        origin = origins.split(",")[0]
        status, payload = http("POST", f"{url}/functions/v1/ea-auth", {"Origin": origin},
                               {"action": "send", "email": test_to, "device": "00000000-0000-4000-8000-000000000000"})
        if status == 200:
            print(f"  Sent. Check {test_to} (and the spam folder) for a 6-digit code.")
        else:
            print(f"  The test email didn't go out ({status}: {message_of(payload)}). Functions can take a minute to start;")
            print("  try signing up on the site in a minute, or check Edge Functions → ea-auth → Logs in Supabase.")

    print("\nAll set. Next:")
    print("  • Commit and push in GitHub Desktop so the live site gets the new index.html.")
    print("  • Sign up on the site with your own email to see a real code arrive.")
    print("  • To lift a ban later:  python3 setup/setup.py unban their@email.com")


def cmd_unban(email):
    if not re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", email or ""):
        raise SetupError("Usage: python3 setup/setup.py unban person@example.com")
    token = access_token()
    ref = pick_project(token)
    rows = run_sql(token, ref, "select public.ea_unban($1) as result", [email]) or []
    print("  " + (rows[0].get("result") if rows and isinstance(rows[0], dict) else json.dumps(rows)))


def cmd_bans():
    token = access_token()
    ref = pick_project(token)
    rows = run_sql(token, ref, "select key, reason, created_at from public.ea_bans order by created_at desc limit 200") or []
    if not rows:
        print("  Nobody is banned.")
    for r in rows:
        kind = "email " if r["key"].startswith("e:") else "device" if r["key"].startswith("d:") else "      "
        print(f"  {kind} {r['key'][2:]:40}  {str(r['created_at'])[:19]}  {r['reason']}")


def main():
    args = [a for a in sys.argv[1:] if a != "--yes"]
    try:
        if not args or args[0] == "setup":
            cmd_setup()
        elif args[0] == "unban" and len(args) == 2:
            cmd_unban(args[1])
        elif args[0] == "bans":
            cmd_bans()
        else:
            print(__doc__)
            return 2
    except SetupError as e:
        print("\nStopped: " + str(e))
        print("Nothing else was changed. You can run this again once that's sorted; it's safe to repeat.")
        return 1
    except KeyboardInterrupt:
        print("\nCancelled.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
