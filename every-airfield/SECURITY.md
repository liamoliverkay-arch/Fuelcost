# Security

Every Airfield is a public map with an email sign-in, crowd-reported fuel prices and desktop apps.
This document covers what we protect, against whom, how, and how each protection is tested.

## Reporting a vulnerability

Please report privately through GitHub: **Security → Report a vulnerability** on this repository.
Don't open a public issue for security problems. We aim to reply within 3 days and to fix confirmed
issues within 14 days, and we'll credit you in the release notes if you'd like.

## What we protect

| Asset | Where it lives |
| --- | --- |
| Visitors' email addresses and names | Supabase database, reachable only by the server functions |
| Sign-in codes | Never stored; only a keyed hash (HMAC-SHA256 with a server-only secret) for 10 minutes |
| Sign-in sessions | 256-bit random tokens in the visitor's browser; the server keeps only a SHA-256 hash |
| The integrity of the price list | Supabase (shared) or `prices.json` (local server) |
| Visitors' browsers and computers | The page's Content Security Policy; the desktop app's sandbox |
| The owner's API keys | Supabase secrets; never in this repository or in the website |

## Threats we defend against

- **Guessing sign-in codes:** brute force, parallel guesses, rotating devices or IP addresses.
- **Locking out or banning someone else:** abusing the lockout and ban rules against a person.
- **Stolen sessions:** a copied session token used from another device.
- **Cross-site scripting:** script injected through a price, a name or any other stored data.
- **Data theft through the page:** an injected script sending visitor data to another server.
- **Malicious or junk price reports:** floods and invalid values.
- **Abuse of the server functions:** floods that would exhaust the free quota or spam inboxes.
- **Attacks on the desktop app:** turning it into a general-purpose runtime, opening windows,
  navigating away, or reading local files.
- **Supply-chain tampering:** with the Electron download, the Mac signing tool, CI actions, or dependencies.

## Protections and the tests that prove them

| Protection | Enforced in | Test |
| --- | --- | --- |
| 6-digit codes from a cryptographic RNG (rejection sampling, no bias), one try each, 10-minute expiry | `ea-auth`, `schema.sql` | `supabase/tests/ea-auth.test.ts`: one try per code |
| Code stored only as an HMAC; no links or user text in emails (anti-phishing) | `ea-auth` | same: only an HMAC is stored, no links |
| Wrong code: email **and** device locked 10 minutes; 5 wrong codes: both banned until the owner lifts it | `ea_fail`, `ea_claim` | lockout and ban tests |
| Two simultaneous guesses: only one is checked (row locks) | `ea_claim` | "two guesses fired at once" |
| Guesses only count when a code was actually sent (nobody can be banned silently) | `ea-auth` | "nothing counts without a live code" |
| Email, device and IP rate limits; IP addresses stored only as salted hashes | `ea_send_ok`, `ea_ip_hit` | flood-limit tests |
| Lockout can't be shortened by changing the clock (monotonic timer; the server's clock decides) | `index.html`, `ea-auth` | lockout tests |
| Sessions only work from the device that signed in | `ea_session`, `ea_unlock` | "a copied token is useless on another device" |
| Browsers can't touch any table or function (RLS with no policies, privileges revoked, `SECURITY DEFINER` with pinned `search_path`) | `schema.sql` | "browsers cannot touch the tables or functions" |
| Only the site's own addresses are answered (exact-match origin allow-list, no `*`) | all three functions | origin tests |
| No account enumeration: replies don't reveal whether an email has an account | `ea-auth` | sign-up tests |
| **Content Security Policy**: only the page's own script may run (identified by its SHA-256 hash); no inline handlers, `eval` or injected scripts; data may only go to the site's own servers | `index.html` (`tools/csp.py`) | `tests/e2e.js`: "injected scripts, inline handlers and outside connections are refused"; `tests/test_server.py`: policy matches the script |
| All stored text is escaped before display; price records are type-checked and range-checked | `index.html` | QA suite |
| Security headers on the local server: anti-clickjacking, `nosniff`, referrer policy, permissions policy (no camera, microphone or payments), COOP | `server.py` | `test_09b_security_headers` |
| Local server never serves its own code, the price file, hidden files or `supabase/`, even with %-encoding or case tricks; bounded request bodies | `server.py` | `test_05b`, `test_09` |
| Price reports: real airports only, three fuels, $0.01 to $50; rate-limited per address and device; atomic writes | `server.py`, `ea-prices` | server and `ea-prices` tests |
| Desktop app: context isolation, sandbox for every renderer, no Node in pages, no `<webview>`, no new windows, navigation locked to the app, links open in the normal browser, only location may be requested | `desktop/main.js` | build check (`EA_SMOKE_TEST`) |
| Desktop app: Electron **fuses** off for run-as-Node, `NODE_OPTIONS`, `--inspect` and extra file privileges | `desktop/build.py` | the build fails if a fuse can't be set |
| Electron and rcodesign downloads are checked against their published SHA-256 checksums; downloads page shows each app's SHA-256 | `desktop/build.py` | the build stops on a mismatch |
| CI actions pinned to exact commits; workflow token is read-only | `.github/workflows/security-checks.yml` | runs on every push |
| No secrets in the repository: setup asks for keys with hidden input, stores the email key as a Supabase secret, and saves no tokens | `setup/setup.py`, `.gitignore` | `setup` tests against fake servers |

## Known limitations (accepted risks)

- **The paywall and the lockout screen also run in the browser.** Clearing site data opens the page.
  That can't be used to check more codes: every code check goes through the server's lockout and ban.
  The map's data files are public on GitHub Pages anyway.
- **Bans stop guessing, not new sign-ups.** A banned person can come back with a different email.
- **Targeted lockouts are possible.** Someone who knows a person's email can trigger code emails and wrong
  guesses for it. Banning that person takes about 50 minutes and sends them 5 code emails, so it can't be
  done silently. Lift it with `python3 setup/setup.py unban <email>`.
- **The IP limit depends on Supabase passing the real address** (`cf-connecting-ip`). The per-email and
  per-device limits hold either way.
- **The desktop apps aren't signed by Apple or Microsoft yet**, so their first launch shows a warning.
  The Mac apps are signed ad hoc; checksums are published on the download page.
- **Airspace is informational**, from the FAA, and not for navigation. Live planes come from a
  community network (adsb.lol).

## Recommended GitHub settings for this repository

In **Settings → Code security**, turn on:

- **Private vulnerability reporting**, so the link above works.
- **Secret scanning** and **push protection**, which block accidental key commits.
- **CodeQL default setup**, for code scanning.

In **Settings → Branches**, protect `main` and require the "Security checks" workflow to pass before merging.
