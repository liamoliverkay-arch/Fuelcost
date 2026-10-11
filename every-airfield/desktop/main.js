// Every Airfield desktop app (Electron) for Windows, macOS and Linux.
//
// The app carries its own copy of the website and the airport data, served from app://every-airfield,
// so it works offline and keeps its storage (recent airports, where you left off, settings, sign-in)
// on this computer between runs. Links to other sites open in the normal browser.
// Live planes are fetched here directly (no CORS limits outside a browser), and when the site isn't
// connected to Supabase, fuel prices are kept in a file on this computer.
'use strict';
const { app, BrowserWindow, Menu, net, protocol, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SCHEME = 'app';
const ORIGIN = 'app://every-airfield';
const SITE = path.join(__dirname, 'site');
const PLANES_UPSTREAM = 'https://api.adsb.lol/v2/point';
const FUELS = new Set(['100LL', 'JetA', 'MOGAS']);

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);
app.setName('Every Airfield');
// every renderer runs in Chromium's sandbox, whatever a window's own settings say
app.enableSandbox();
// tests and build checks can keep the app's data in a separate folder
if (process.env.EA_USER_DATA) app.setPath('userData', process.env.EA_USER_DATA);
if (!app.requestSingleInstanceLock()) app.quit();

// ---------- window size and position, remembered between runs ----------
const windowFile = () => path.join(app.getPath('userData'), 'window.json');
function loadBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(windowFile(), 'utf8'));
    if (b && b.width >= 480 && b.height >= 360) return b;
  } catch {}
  return { width: 1280, height: 820 };
}
function saveBounds(win) {
  try {
    fs.writeFileSync(windowFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
  } catch {}
}

// ---------- live planes ----------
const planesCache = new Map();
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
function compact(a) {
  const lat = num(a.lat, 5), lon = num(a.lon, 5);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (typeof a.seen_pos === 'number' && a.seen_pos > 60) return null;
  const hex = str(a.hex, 12).toLowerCase();
  if (!/^~?[0-9a-f]{6}$/.test(hex)) return null;
  return [hex, str(a.flight, 10), str(a.r, 12), str(a.t, 6), str(a.category, 2),
    typeof a.dbFlags === 'number' && (a.dbFlags & 1) ? 1 : 0, lat, lon,
    a.alt_baro === 'ground' ? -1 : num(a.alt_baro, 0), num(a.gs, 0),
    num(a.track, 0) ?? num(a.true_heading, 0), num(a.baro_rate, 0) ?? num(a.geom_rate, 0), str(a.squawk, 4)];
}
async function planes(url) {
  let lat = Number(url.searchParams.get('lat')), lon = Number(url.searchParams.get('lon')), dist = Number(url.searchParams.get('dist'));
  if (![lat, lon, dist].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || dist <= 0) return json(400, { error: 'bad_position' });
  lat = Math.round(lat * 4) / 4; lon = Math.round(lon * 4) / 4; dist = Math.min(250, Math.ceil(dist / 25) * 25);
  const key = `${lat}/${lon}/${dist}`, hit = planesCache.get(key);
  if (hit && Date.now() - hit.at < 5000) return json(200, hit.body);
  try {
    const res = await net.fetch(`${PLANES_UPSTREAM}/${lat}/${lon}/${dist}`, { headers: { Accept: 'application/json', 'User-Agent': 'EveryAirfield-desktop/1.0' } });
    if (!res.ok) throw new Error('upstream ' + res.status);
    const data = await res.json();
    const body = JSON.stringify({ now: typeof data.now === 'number' ? data.now : Date.now(), ac: (Array.isArray(data.ac) ? data.ac : []).map(compact).filter(Boolean) });
    planesCache.set(key, { at: Date.now(), body });
    if (planesCache.size > 200) planesCache.delete(planesCache.keys().next().value);
    return json(200, body);
  } catch {
    return json(502, { error: 'planes_unavailable' });
  }
}

// ---------- fuel prices on this computer (used when the site isn't connected to Supabase) ----------
const pricesFile = () => path.join(app.getPath('userData'), 'prices.json');
function loadPrices() {
  try { return JSON.parse(fs.readFileSync(pricesFile(), 'utf8')) || {}; } catch { return {}; }
}
async function prices(req) {
  if (req.method === 'GET') return json(200, { prices: Object.values(loadPrices()) });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  let b;
  try { b = JSON.parse(await req.text()); } catch { return json(400, { error: 'bad_request' }); }
  const ok = b && typeof b.ident === 'string' && /^[A-Za-z0-9-]{1,16}$/.test(b.ident) && typeof b.fuel === 'string' && FUELS.has(b.fuel) &&
    typeof b.price === 'number' && Number.isFinite(b.price) && Math.round(b.price * 100) >= 1 && b.price <= 50;
  if (!ok) return json(400, { error: 'Send ident, fuel (100LL, JetA or MOGAS) and a price between 0 and 50.' });
  const all = loadPrices();
  const rec = { ident: b.ident, fuel: b.fuel, price: Math.round(b.price * 100) / 100, at: Date.now() };
  all[`${rec.ident}~${rec.fuel}`] = rec;
  const tmp = pricesFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(all));
  fs.renameSync(tmp, pricesFile());          // a crash mid-write can't leave a half-written file
  return json(200, rec);
}

function json(status, body) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

// ---------- the app:// site ----------
async function handle(req) {
  const url = new URL(req.url);
  if (url.host !== 'every-airfield') return new Response('Not found', { status: 404 });
  if (url.pathname === '/api/planes') return planes(url);
  if (url.pathname === '/api/prices') return prices(req);
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return new Response('Bad request', { status: 400 }); }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(SITE, rel));
  // only files inside the bundled site, never anything above it
  if (!file.startsWith(SITE + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('Not found', { status: 404 });
  const res = await net.fetch(pathToFileURL(file).toString());
  const headers = new Headers(res.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(res.body, { status: res.status, headers });
}

function createWindow() {
  const b = loadBounds();
  const win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height, minWidth: 480, minHeight: 360,
    title: 'Every Airfield', backgroundColor: '#0c2033', show: false,
    icon: path.join(SITE, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, spellcheck: false,
      additionalArguments: [`--ea-version=${app.getVersion()}`],
    },
  });
  if (b.maximized) win.maximize();
  win.once('ready-to-show', () => { if (!process.env.EA_SMOKE_TEST) win.show(); });
  win.on('close', () => saveBounds(win));
  // links to other sites open in the normal browser; the app window only ever shows the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN + '/')) {
      e.preventDefault();
      if (/^https:\/\//.test(url)) shell.openExternal(url);
    }
  });
  win.loadURL(ORIGIN + '/index.html');
  return win;
}

app.whenReady().then(() => {
  protocol.handle(SCHEME, handle);
  // "Use my location" may ask for location; nothing else (camera, microphone, notifications…) is ever allowed,
  // and only the app's own page may ask
  const fromApp = (wc) => !!wc && wc.getURL().startsWith(ORIGIN + '/');
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(permission === 'geolocation' && fromApp(wc)));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'geolocation' && fromApp(wc));
  // no other web content ever gets a window, a <webview> or a navigation of its own
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-attach-webview', (ev) => ev.preventDefault());
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (ev, url) => { if (!url.startsWith(ORIGIN + '/')) ev.preventDefault(); });
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' }, { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]));
  const win = createWindow();
  app.on('second-instance', () => { if (win.isMinimized()) win.restore(); win.focus(); });
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });

  // build check: load the page hidden, report whether the map and airport data came up, then quit
  if (process.env.EA_SMOKE_TEST) {
    const started = Date.now();
    const check = async () => {
      const r = await win.webContents.executeJavaScript(
        `({ title: document.title, airports: document.getElementById('total')?.textContent || '', tab: location.hash, desktop: !!window.eaDesktop, errors: window.__errs || [] })`).catch((e) => ({ error: String(e) }));
      if ((r.airports && /\d/.test(r.airports)) || Date.now() - started > 45000) {
        process.stdout.write('EA_SMOKE ' + JSON.stringify(r) + '\n');
        app.quit();
      } else setTimeout(check, 500);
    };
    win.webContents.once('did-finish-load', () => setTimeout(check, 500));
  }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin' || process.env.EA_SMOKE_TEST) app.quit(); });
