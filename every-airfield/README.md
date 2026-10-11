# Every Airfield

A world map of 72,657 airports, heliports and seaplane bases, with live planes, US airspace and
crowd-reported fuel prices. It runs as a website and as a desktop app for Windows, Mac and Linux.

- **Find Fuel**: pan and zoom the map (drag, scroll or pinch). Find the cheapest reported fuel near an
  airport, a city, coordinates, your GPS or a spot you click, within a radius you choose.
  - **Live planes** from [adsb.lol](https://adsb.lol) (open data). Click one for its callsign, type, altitude and speed.
  - **US airspace** from the FAA: Class B, C and D drawn like a sectional chart, plus restricted,
    prohibited, warning and alert areas and MOAs. Click inside an area for its floor, ceiling and hours.
    Each airport's card shows its own airspace class.
  - **Recents**: the airports you open and your searches show under the search box, like Google Maps.
  - The map **reopens where you left off**: same spot, same airport, same tab.
- **Report Fuel Price**: enter an airport ID and the price per gallon. It appears on everyone's map.
- **Download**: the desktop apps for Windows, macOS and Linux.
- **Settings** (gear): light, dark or automatic theme; live planes on or off and which kinds; airspace
  layers; history on or off, and Clear history.

Find Fuel sits behind a sign-up screen: an emailed 6-digit code, then a "$5 setup fee" that charges
**$0.00** (payments are switched off; there is no payment code at all).

## Run it on your computer

```bash
python3 server.py
```

Then open <http://localhost:8000>. Other devices on the same Wi-Fi can use `http://<your computer's IP>:8000`.
`server.py` also stores fuel prices (in `prices.json`) and passes live planes through from adsb.lol.
Opening `index.html` by double-clicking won't work: browsers block pages opened from disk from loading the data.

## Put it on GitHub with GitHub Desktop

1. In GitHub Desktop choose **File → Add local repository…** and pick this folder.
   If it says the folder isn't a repository yet, click **create a repository**, then **Create repository**.
2. Click **Publish repository**.
3. To make it a website: on github.com open the repository → **Settings → Pages**, set **Source** to
   *Deploy from a branch*, branch `main`, folder `/ (root)`, and save.
   After a minute it's live at `https://<your-username>.github.io/<repository-name>/`.

On GitHub Pages the map, search, airspace, recents and settings work straight away. Sign-in codes,
shared fuel prices and live planes need the free setup below, because GitHub Pages can only host files.

## Switch on email codes, shared prices and live planes (free, about 10 minutes)

You need two free accounts. Only you can create them:

1. **Supabase** (<https://supabase.com>): create a project (any name, any region). Then create an
   access token at <https://supabase.com/dashboard/account/tokens>.
2. **Brevo** (<https://www.brevo.com>, sends the code emails, 300 a day free): add a sender address under
   *Senders, Domains & Dedicated IPs → Senders* and click the link Brevo emails you. Then create an
   **API key** under *SMTP & API → API keys*.

Then run, from this folder:

```bash
python3 setup/setup.py
```

It asks for the token and key (typing is hidden), then sets everything up in Supabase: the database
tables and rules, the three server functions (`ea-auth` for codes, `ea-prices` for the shared price list,
`ea-planes` for live planes), and their secrets. Finally it puts your project's address into `index.html`
and can send you a test code. Your Brevo key is stored as a Supabase secret, never in the website's
files, and the token isn't saved anywhere. It's safe to run again.

Commit and push `index.html` in GitHub Desktop afterwards, so the live site uses it.

### How sign-in is protected

All of these rules run on Supabase's servers, so nothing in the browser can skip them:

- Codes are 6 digits from a cryptographic random generator. They're stored only as a keyed hash,
  expire after 10 minutes, and work for one try only.
- A wrong code closes the whole site on that device for **10 minutes**, with a countdown. Changing the
  computer's clock doesn't shorten it: the countdown ignores clock changes, and the server's clock has
  the final say whenever the site is online.
- **5 wrong codes** ban that email and that device until you lift the ban.
- Guesses only count for an email that was sent a code, so nobody can get banned without code emails
  arriving in their inbox. Two guesses can't race through at the same time.
- There are limits on code emails (1 a minute and 5 an hour per email or device, 20 an hour per network address),
  on requests (60 per 10 minutes per address) and on price reports (60 an hour per address, 30 per device).
- Only your own site addresses (and the desktop app) are answered, and browsers can't read or change any of the
  database tables directly.
- Sign-in sessions are 256-bit random tokens; the server keeps only their hash, for 30 days.

What it can't do: a banned person can come back with a different email and a cleared browser (bans stop
guessing, not new sign-ups), and the map's data files are public on GitHub Pages.

### Lifting a ban

```bash
python3 setup/setup.py unban person@example.com     # also lifts the device banned with them
python3 setup/setup.py bans                         # who's banned right now
```

## Desktop apps (Windows, Mac, Linux)

```bash
python3 desktop/build.py --release <your-github-name>/<repository-name>
```

This builds four apps into `downloads/`: Windows, Mac (Apple Silicon), Mac (Intel) and Linux. Each one
is Electron (the engine behind apps like VS Code) with this site and all the airport data inside, so
it works offline and keeps its history and settings on that computer. It also fills in the Download
page's version, file sizes and SHA-256 fingerprints, and points its buttons at your GitHub release.

The apps are 120–160 MB each, too big for a GitHub repository (that's why `downloads/` is git-ignored).
Put them in a **GitHub release** instead:

1. On github.com open your repository → **Releases → Draft a new release**.
2. Set the tag to `v1.0.0` (the version in `desktop/package.json`), drag in every `.zip` from `downloads/`, and publish.
3. Commit and push `index.html` in GitHub Desktop.

Building needs Python 3 and an internet connection (it downloads Electron and checks it against
Electron's published checksums). The Mac apps also need [rcodesign](https://github.com/indygreg/apple-platform-rs)
to sign them, which Apple Silicon requires; set `RCODESIGN=/path/to/rcodesign`. The apps aren't
code-signed by Apple or Microsoft, so the first time they open, Windows and macOS ask the user to
confirm. The Download page explains how.

## Updating the airspace

The FAA publishes new airspace every 56 days. To refresh `airspace.json`:

```bash
python3 tools/build_airspace.py
```

## Security

See [SECURITY.md](SECURITY.md) for the threat model, every protection and the test that proves it,
known limitations, and how to report a vulnerability. After editing the script in `index.html`, run
`python3 tools/csp.py` so its Content Security Policy matches (the tests and the CI check fail otherwise).

## Tests

```bash
tests/run.sh                                   # browser tests in headless Firefox, plus the server tests (about 5 minutes)
deno test -A supabase/tests/                   # the three Supabase functions against a real in-memory Postgres
```

`tests/run.sh` drives the real page: sign-up, the map, search, the fuel finder, reporting prices,
downloads, airspace, live planes (from a fake feed), recents, reopening where you left off, dark
mode and a phone-sized screen. The Supabase tests check every sign-in rule above.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The whole website (HTML, CSS and JavaScript in one file) |
| `airports.txt` | Airports, from [OurAirports](https://ourairports.com/data/) (public domain) |
| `world.json` | Country outlines, from Natural Earth via [world-atlas](https://github.com/topojson/world-atlas) |
| `countries.json` | Country names by ISO code |
| `airspace.json` | US airspace, from the FAA (public domain), made by `tools/build_airspace.py` |
| `server.py` | Local server: hosts the site, stores fuel prices, passes live planes through |
| `setup/setup.py` | One-command Supabase + Brevo setup, and unbanning |
| `supabase/` | Database setup (`schema.sql`), the three server functions, and their tests |
| `desktop/` | The desktop app (`main.js`, `preload.js`) and its builder (`build.py`) |
| `tools/` | Data scripts, and `csp.py`, which writes the page's Content Security Policy |
| `CONTRIBUTING.md` | How others can suggest changes |
| `SECURITY.md` | Threat model, protections, how to report a vulnerability |
| `.github/workflows/` | Security checks that run on every push |
| `tests/` | End-to-end and server tests |

## Data credits

Airports © OurAirports contributors (public domain). Map outlines from Natural Earth via world-atlas.
Airspace from the FAA Aeronautical Information Services (public domain); not for navigation. Always
check official charts and NOTAMs (including temporary flight restrictions) before you fly. Live
aircraft positions from adsb.lol (Open Database License). Fuel prices are reported by users and may be
out of date; confirm with the FBO.
