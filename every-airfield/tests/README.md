# End-to-end tests

Run everything with `tests/run.sh` (or pick suites: `tests/run.sh server desktop dark phone noapi`). Needs `python3` and `firefox`, and takes about 3–4 minutes. Exit code 0 means everything passed.

- `server`: API tests for `server.py`'s `/api/prices` (unittest, no browser).
- `desktop`: paywall, map, search, finder, layers, report flow, invalid input, world wrap, sign-out, and persistence across reloads.
- `dark`: dark colour scheme, plus switching theme while the page is open.
- `phone`: the app in a 390×844 viewport at 2× pixel density.
- `noapi`: price server down (read-only mode).

How it works: `qa_server.py` serves this folder through the real `server.py` handler, with prices stored in `tests/out/<suite>/`. It injects `e2e.js` and a read-only `window.__qa` hook into `index.html` as the page is served, so the file on disk is never changed. `e2e.js` then drives the UI with DOM events and posts each result back to the server. Logs and Firefox profiles go to `tests/out/`, which is safe to delete.
