// End-to-end tests for the ea-auth sign-in function, against a real Postgres (PGlite, in memory)
// loaded with supabase/schema.sql. Only the outside world is faked: Supabase's REST API is a thin
// translation to SQL, and Brevo is an inbox that records the code emails.
//
// Run from the project folder:   deno test -A supabase/tests/ea-auth.test.ts

import { PGlite } from 'npm:@electric-sql/pglite@0.5.8';

const ORIGIN = 'https://site.test';
Deno.env.set('EA_TEST', '1');
Deno.env.set('SUPABASE_URL', 'http://supabase.test');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-key-for-tests');
Deno.env.set('ALLOWED_ORIGINS', `${ORIGIN},http://localhost:8000`);
Deno.env.set('IP_SALT', 'salt-for-tests');
Deno.env.set('CODE_PEPPER', 'pepper-for-tests-0123456789');
Deno.env.set('BREVO_API_KEY', 'brevo-key-for-tests');
Deno.env.set('SENDER_EMAIL', 'codes@site.test');
Deno.env.set('BREVO_URL', 'http://brevo.test/v3/smtp/email');

// ---------- a real database ----------
const db = new PGlite();
await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin;`);
await db.exec(await Deno.readTextFile(new URL('../schema.sql', import.meta.url)));
await db.exec(`set role service_role`);
// run SQL as the owner (for test setup, like "pretend 10 minutes passed")
async function asOwner(sql: string) {
  await db.exec(`reset role; ${sql}; set role service_role;`);
}

// ---------- fake outside world ----------
type Mail = { to: string; subject: string; text: string; html: string };
const inbox: Mail[] = [];
let brevoDown = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const headers = new Headers(init?.headers);
  if (url.startsWith('http://supabase.test/rest/v1/rpc/')) {
    if (headers.get('apikey') !== 'service-key-for-tests') return new Response('{"message":"bad key"}', { status: 401 });
    const fn = url.split('/').pop()!;
    const names = Object.keys(body);
    const params: unknown[] = [];
    const args = names.map((k, i) => {
      const v = body[k];
      if (Array.isArray(v)) {
        params.push('{' + v.map((x: string) => '"' + String(x).replace(/["\\]/g, '\\$&') + '"').join(',') + '}');
        return `${k} => $${i + 1}::text[]`;
      }
      params.push(v);
      return `${k} => $${i + 1}::${typeof v === 'number' ? 'integer' : typeof v === 'boolean' ? 'boolean' : 'text'}`;
    });
    try {
      const res = await db.query<Record<string, unknown>>(`select * from public.${fn}(${args.join(', ')})`, params);
      const fields = res.fields.map((f) => f.name);
      let out: unknown = res.rows;
      if (fields.length === 1 && fields[0] === fn) out = res.rows[0]?.[fn] ?? null;  // scalar / void, like PostgREST
      if (out === '') out = null;
      return new Response(JSON.stringify(out), { status: 200 });
    } catch (err) {
      return new Response(JSON.stringify({ message: String((err as Error).message) }), { status: 400 });
    }
  }
  if (url === 'http://brevo.test/v3/smtp/email') {
    if (headers.get('api-key') !== 'brevo-key-for-tests') return new Response('{"message":"unauthorized"}', { status: 401 });
    if (brevoDown) return new Response('{"message":"down"}', { status: 503 });
    inbox.push({ to: body.to[0].email, subject: body.subject, text: body.textContent, html: body.htmlContent });
    return new Response('{"messageId":"<test@brevo>"}', { status: 201 });
  }
  throw new Error('unexpected fetch in test: ' + url);
};

const { handler } = await import('../functions/ea-auth/index.ts');

// ---------- helpers ----------
const DEVICE_A = '11111111-2222-4333-8444-555555555555';
const DEVICE_B = '66666666-7777-4888-9999-aaaaaaaaaaaa';
let ipCounter = 1;
// a different (made-up) address per call unless a test says otherwise, so tests don't trip the per-IP limit
const freshIp = () => `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}`;

async function call(action: string, extra: Record<string, unknown> = {}, opt: { device?: string; ip?: string; origin?: string; raw?: string } = {}) {
  const res = await handler(new Request('https://project.functions.test/ea-auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: opt.origin ?? ORIGIN, 'cf-connecting-ip': opt.ip ?? freshIp() },
    body: opt.raw ?? JSON.stringify({ action, device: opt.device ?? DEVICE_A, ...extra }),
  }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
function lastCodeFor(email: string): string {
  const mail = [...inbox].reverse().find((m) => m.to === email);
  if (!mail) throw new Error('no email for ' + email);
  const m = mail.text.match(/code is (\d{3}) (\d{3})/);
  if (!m) throw new Error('no code in email');
  return m[1] + m[2];
}
const wrongCode = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');
// "10 minutes pass": end lockouts and send cooldowns (codes are left as they are)
const timePasses = () => asOwner(`update ea_attempts set locked_until = now() - interval '1 second';
  update ea_sends set last_sent_at = now() - interval '2 hours', window_start = now() - interval '2 hours'`);
function assert(cond: unknown, msg: string) { if (!cond) throw new Error('FAILED: ' + msg); }
function eq(a: unknown, b: unknown, msg: string) { if (a !== b) throw new Error(`FAILED: ${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const opts = { sanitizeOps: false, sanitizeResources: false };

// ---------- tests ----------

Deno.test('requests from other websites and malformed requests are refused', opts, async () => {
  eq((await call('status', {}, { origin: 'https://evil.test' })).status, 403, 'unknown origin');
  const pre = await handler(new Request('https://x/ea-auth', { method: 'OPTIONS', headers: { origin: ORIGIN } }));
  eq(pre.status, 204, 'preflight from our site');
  eq(pre.headers.get('access-control-allow-origin'), ORIGIN, 'CORS echoes only our origin');
  const pre2 = await handler(new Request('https://x/ea-auth', { method: 'OPTIONS', headers: { origin: 'https://evil.test' } }));
  eq(pre2.status, 403, 'preflight from another site');
  eq(pre2.headers.get('access-control-allow-origin'), null, 'no CORS for other sites');
  eq((await call('status', {}, { raw: '{not json' })).status, 400, 'bad JSON');
  eq((await call('status', {}, { raw: '[1,2]' })).status, 400, 'array body');
  eq((await call('status', {}, { raw: JSON.stringify({ action: 'status', device: 'x'.repeat(5000) }) })).status, 413, 'too large');
  eq((await call('status', {}, { device: 'not-a-uuid' })).status, 400, 'bad device id');
  eq((await call('send', { email: 'a@b.test\r\nBcc: x@y.test' })).body.error, 'bad_email', 'header injection in email');
  eq((await call('send', { email: 'ａ@b.test' })).body.error, 'bad_email', 'non-ASCII look-alike');
  eq((await call('nonsense')).body.error, 'unknown_action', 'unknown action');
  const get = await handler(new Request('https://x/ea-auth', { method: 'GET', headers: { origin: ORIGIN } }));
  eq(get.status, 405, 'GET');
});

Deno.test('sign-up: code email, one try per code, session, unlock, sign out', opts, async () => {
  const email = 'pilot@example.test';
  const sent = await call('send', { email: '  Pilot@Example.TEST ' });
  eq(sent.status, 200, 'send');
  eq(inbox.at(-1)!.to, email, 'email normalised to lower case');
  const code = lastCodeFor(email);
  assert(/^\d{6}$/.test(code), 'six digits');
  assert(!inbox.at(-1)!.subject.includes(code), 'code not in the subject line (lock-screen previews)');
  assert(!/https?:\/\//.test(inbox.at(-1)!.html) && !/https?:\/\//.test(inbox.at(-1)!.text), 'no links in the email');
  // the code is never stored, only a keyed hash
  await db.exec('reset role');
  const stored = await db.query<{ code_hash: string }>(`select code_hash from ea_codes where email = $1`, [email]);
  await db.exec('set role service_role');
  assert(stored.rows.length === 1 && !stored.rows[0].code_hash.includes(code) && stored.rows[0].code_hash.length === 64, 'only an HMAC is stored');

  eq((await call('send', { email })).body.error, 'send_limit', 'second code within a minute');
  eq((await call('verify', { email, code: '12345' })).body.error, 'bad_code_format', 'five digits');

  const ok = await call('verify', { email, code, name: '  Ada\u0000 Lovelace \u202e ' });
  eq(ok.status, 200, 'right code');
  assert(/^[A-Za-z0-9_-]{43}$/.test(ok.body.session.token), 'session token is 256-bit base64url');
  eq(ok.body.name, 'Ada Lovelace', 'control and direction characters stripped from the name');
  eq(ok.body.unlocked, false, 'not unlocked yet');
  const token = ok.body.session.token;

  eq((await call('verify', { email, code })).body.error, 'no_code', 'a code works only once');

  const st = await call('status', { token });
  eq(st.body.signedIn, true, 'signed in');
  eq(st.body.email, email, 'own email');
  eq((await call('status', { token: 'A'.repeat(43) })).body.signedIn, false, 'made-up token');
  eq((await call('status', { token }, { device: DEVICE_B })).body.signedIn, false, 'a copied token is useless on another device');
  eq((await call('unlock', { token }, { device: DEVICE_B })).status, 401, 'and can not unlock from there');

  eq((await call('unlock', { token: 'A'.repeat(43) })).status, 401, 'unlock needs a real session');
  const un = await call('unlock', { token });
  eq(un.status, 200, 'unlock');
  eq(un.body.charged, 0, 'nothing charged');
  eq((await call('status', { token })).body.unlocked, true, 'unlocked is remembered on the server');

  eq((await call('signout', { token })).status, 200, 'sign out');
  eq((await call('status', { token })).body.signedIn, false, 'token dead after sign out');
});

Deno.test('a wrong code locks email and device for 10 minutes; nothing counts without a live code', opts, async () => {
  const email = 'lock@example.test';
  eq((await call('verify', { email, code: '000000' }, { device: DEVICE_B })).body.error, 'no_code', 'guess with no code sent');
  eq((await call('status', { email }, { device: DEVICE_B })).body.triesLeft, 5, 'that guess was not counted');

  await call('send', { email }, { device: DEVICE_B, ip: freshIp() });
  const code = lastCodeFor(email);
  const bad = await call('verify', { email, code: wrongCode(code) }, { device: DEVICE_B });
  eq(bad.status, 401, 'wrong code');
  eq(bad.body.waitSeconds, 600, '10-minute lockout');
  eq(bad.body.triesLeft, 4, 'four tries left');
  eq(bad.body.banned, false, 'not banned yet');

  // locked: the right code doesn't help, from this device or another one, and no new code can be sent
  eq((await call('verify', { email, code }, { device: DEVICE_B })).status, 400, 'the burned code is gone');
  eq((await call('send', { email }, { device: DEVICE_A, ip: freshIp() })).status, 403, 'no new code while the email is locked');
  const st = await call('status', { email }, { device: DEVICE_B });
  assert(st.body.waitSeconds > 590 && st.body.waitSeconds <= 600, 'server reports the lockout');
  eq((await call('status', {}, { device: DEVICE_B })).body.waitSeconds > 0, true, 'the device itself is locked too');

  await timePasses();
  await call('send', { email }, { device: DEVICE_B, ip: freshIp() });
  const ok = await call('verify', { email, code: lastCodeFor(email) }, { device: DEVICE_B });
  eq(ok.status, 200, 'after the lockout, a new right code works');
  eq((await call('status', { email }, { device: DEVICE_B })).body.triesLeft, 5, 'success resets the count');
});

Deno.test('two guesses fired at once: only one is checked', opts, async () => {
  const email = 'race@example.test';
  await timePasses();
  await call('send', { email }, { ip: freshIp() });
  const code = lastCodeFor(email);
  const [a, b] = await Promise.all([
    call('verify', { email, code: wrongCode(code) }),
    call('verify', { email, code }),
  ]);
  // whichever arrives first is checked; the other must be refused while the first holds the lock
  const statuses = [a.status, b.status].sort();
  assert(statuses.filter((s) => s === 200 || s === 401).length === 1 && statuses.includes(403),
    'exactly one guess checked, the other refused: ' + statuses);
});

Deno.test('5 wrong codes ban the email and device until ea_unban', opts, async () => {
  const email = 'ban@example.test';
  const device = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  let last = null as null | Awaited<ReturnType<typeof call>>;
  for (let i = 1; i <= 5; i++) {
    await timePasses();
    eq((await call('send', { email }, { device, ip: freshIp() })).status, 200, `send #${i}`);
    last = await call('verify', { email, code: wrongCode(lastCodeFor(email)) }, { device });
    eq(last.status, 401, `wrong #${i}`);
  }
  eq(last!.body.banned, true, 'banned after 5');
  eq(last!.body.triesLeft, 0, 'no tries left');
  await timePasses();
  eq((await call('status', { email }, { device })).body.banned, true, 'still banned after the lockout would have ended');
  eq((await call('send', { email }, { device, ip: freshIp() })).status, 403, 'no codes while banned');
  eq((await call('status', { email: 'other@example.test' }, { device })).body.banned, true, 'the device is banned for other emails too');
  eq((await call('status', { email }, { device: DEVICE_A })).body.banned, true, 'the email is banned on other devices too');

  // the owner lifts the ban: both the email and the device it was banned with are cleared
  await db.exec('reset role');
  const r = await db.query<{ ea_unban: string }>(`select ea_unban('BAN@example.test')`);
  await db.exec('set role service_role');
  assert(r.rows[0].ea_unban.startsWith('Unbanned'), 'ea_unban reports the lift');
  const st = await call('status', { email }, { device });
  eq(st.body.banned, false, 'unbanned');
  eq(st.body.triesLeft, 5, 'count reset');
  eq((await call('status', {}, { device })).body.banned, false, 'device unbanned too');
});

Deno.test('flood limits: per-IP requests and per-IP code emails', opts, async () => {
  const ip = '192.0.2.99';
  let limited = 0;
  for (let i = 0; i < 61; i++) if ((await call('status', {}, { ip })).status === 429) limited++;
  eq(limited, 1, 'the 61st request in 10 minutes is refused');

  const ip2 = '192.0.2.100';
  let sends = 0;
  for (let i = 0; i < 22; i++) {
    const r = await call('send', { email: `flood${i}@example.test` }, { ip: ip2, device: crypto.randomUUID() });
    if (r.status === 200) sends++;
  }
  eq(sends, 20, 'at most 20 code emails per IP per hour');
});

Deno.test('email outage: no code is "lost" as a wrong guess', opts, async () => {
  const email = 'outage@example.test';
  await timePasses();
  const device = crypto.randomUUID();
  brevoDown = true;
  const r = await call('send', { email }, { device });
  brevoDown = false;
  eq(r.status, 502, 'send reports the failure');
  eq((await call('status', { email }, { device })).body.triesLeft, 5, 'nothing counted');
});

Deno.test('browsers (anon/authenticated) cannot touch the tables or functions', opts, async () => {
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`reset role; set role ${role}`);
    for (const sql of [`select * from ea_codes`, `select * from ea_users`, `select * from ea_sessions`, `select * from ea_bans`,
      `select ea_unban('x@y.test')`, `select * from ea_status(array['e:x'])`, `select ea_check_code('a','b')`, `insert into ea_bans(key, reason) values ('x','y')`]) {
      let refused = false;
      try { await db.query(sql); } catch { refused = true; }
      assert(refused, `${role} must not run: ${sql}`);
    }
  }
  await db.exec('reset role; set role service_role');
});

Deno.test('cleanup', opts, () => { globalThis.fetch = realFetch; });
