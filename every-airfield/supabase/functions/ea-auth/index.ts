// Every Airfield sign-in server (Supabase Edge Function "ea-auth").
//
// This function is the only way in. It creates each 6-digit code, emails it, and checks it, so every
// rule below applies to every guess (Supabase Auth isn't used, so there is no side door):
//   • codes come from the system's cryptographic random generator, are stored only as a keyed hash
//     (HMAC-SHA256 with a server-only secret), expire after 10 minutes, and get exactly one try
//   • each wrong code locks that email AND that device out for 10 minutes
//   • 5 wrong codes ban the email and device until the owner runs ea_unban()
//   • guesses are only counted for an email that was actually sent a code (nobody can be banned
//     without code emails arriving in their inbox)
//   • two guesses can't race through at once (the database holds a lock while a code is checked)
//   • code emails: at most 1 per minute and 5 per hour per email/device, 20 per hour per IP address
//   • each IP address: at most 60 requests per 10 minutes (stored only as a salted hash)
//   • only the site's own web addresses (ALLOWED_ORIGINS) are answered
//   • replies never reveal whether an email already has an account
//   • session tokens are 256-bit random values; only their SHA-256 hash is stored, and a token only
//     works from the device that signed in
//   • emails contain no links and nothing a visitor typed, so they can't be used for phishing
//
// Secrets (setup/setup.py sets them; or Supabase → Edge Functions → Secrets):
//   ALLOWED_ORIGINS  e.g. https://yourname.github.io,http://localhost:8000
//   IP_SALT          long random string
//   CODE_PEPPER      long random string (the key for code hashes)
//   BREVO_API_KEY    Brevo → SMTP & API → API keys
//   SENDER_EMAIL     a sender address verified in Brevo
//   SENDER_NAME      shown as the email's sender, e.g. Every Airfield
// SUPABASE_URL and the service role key are provided automatically.
// Deploy with JWT verification OFF (the setup script does): this function does its own checks, and
// browsers call it without any Supabase key.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = serviceKey();
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const IP_SALT = Deno.env.get('IP_SALT') ?? '';
const CODE_PEPPER = Deno.env.get('CODE_PEPPER') ?? '';
const BREVO_API_KEY = Deno.env.get('BREVO_API_KEY') ?? '';
const SENDER_EMAIL = Deno.env.get('SENDER_EMAIL') ?? '';
const SENDER_NAME = (Deno.env.get('SENDER_NAME') ?? 'Every Airfield').slice(0, 70);
const BREVO_URL = Deno.env.get('BREVO_URL') ?? 'https://api.brevo.com/v3/smtp/email';

const CODE_LENGTH = 6;
const CODE_TTL_SECONDS = 600;
const LOCK_MINUTES = 10;
const MAX_FAILURES = 5;
const HOLD_SECONDS = 15;           // how long one code check holds the lock
const SEND_GAP_SECONDS = 60;
const SENDS_PER_HOUR = 5;
const IP_SENDS_PER_HOUR = 20;
const IP_LIMIT_PER_10_MIN = 60;
const SESSION_DAYS = 30;
const MAX_BODY_BYTES = 4096;

// local part: the usual unquoted characters only (no control characters, quotes or non-ASCII look-alikes)
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const DEVICE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE_RE = new RegExp(`^\\d{${CODE_LENGTH}}$`);
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// The service role key: the classic JWT key, or the newer "sb_secret_…" key on projects using new API keys.
function serviceKey(): string {
  const classic = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (classic) return classic;
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    return keys.default ?? Object.values(keys)[0] ?? '';
  } catch {
    return '';
  }
}

// ---------- small helpers ----------

const enc = new TextEncoder();

function corsHeaders(origin: string): Record<string, string> {
  const h: Record<string, string> = {
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  if (ALLOWED_ORIGINS.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'authorization, apikey, content-type, x-client-info';
    h['Access-Control-Max-Age'] = '600';
  }
  return h;
}

function reply(origin: string, status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json; charset=utf-8' },
  });
}

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

let hmacKey: Promise<CryptoKey> | null = null;
async function codeHash(email: string, code: string): Promise<string> {
  hmacKey ??= crypto.subtle.importKey('raw', enc.encode(CODE_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', await hmacKey, enc.encode(email + '|' + code)));
}

// a uniformly random 6-digit code (rejection sampling, so no number is more likely than another)
function newCode(): string {
  const limit = Math.floor(0x100000000 / 1_000_000) * 1_000_000;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return String(buf[0] % 1_000_000).padStart(CODE_LENGTH, '0');
  }
}

// 32 random bytes as base64url (43 characters)
function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The first X-Forwarded-For entry is whatever the caller typed, so prefer cf-connecting-ip, which
// Cloudflare (in front of *.supabase.co) sets to the real address. The per-email and per-device
// limits are the real protection; this one only slows floods.
function clientIp(req: Request): string {
  const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') ||
    (req.headers.get('x-forwarded-for') ?? '').split(',')[0] || 'unknown';
  return ip.trim().slice(0, 64);
}

function normEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

// names are only ever shown back to the same person; still, keep them plain and short
function normName(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}
// control characters, zero-width and bidirectional-override characters (built from code points so no
// invisible character ever sits in this source file)
const INVISIBLE = new RegExp('[' + [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]]
  .map(([a, b]) => '\\u' + a.toString(16).padStart(4, '0') + '-\\u' + b.toString(16).padStart(4, '0')).join('') + ']', 'g');

const normDevice = (v: unknown) => (typeof v === 'string' && DEVICE_RE.test(v) ? v : null);
const normToken = (v: unknown) => (typeof v === 'string' && TOKEN_RE.test(v) ? v : null);

// Call one of the database functions in schema.sql through Supabase's REST API.
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', apikey: SERVICE_KEY };
  if (!SERVICE_KEY.startsWith('sb_')) headers.Authorization = 'Bearer ' + SERVICE_KEY;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args) });
  const text = await res.text();
  if (!res.ok) throw new Error(`database call ${fn} failed (${res.status}): ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}
const firstRow = <T>(v: unknown): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v as T | null));

type Status = { banned: boolean; waitSeconds: number; failures: number };
async function status(keys: string[]): Promise<Status> {
  const row = firstRow<{ banned: boolean; wait_seconds: number; failures: number }>(await rpc('ea_status', { p_keys: keys }))
    ?? { banned: false, wait_seconds: 0, failures: 0 };
  return { banned: !!row.banned, waitSeconds: Number(row.wait_seconds) || 0, failures: Number(row.failures) || 0 };
}
const stateBody = (s: Status) => ({
  banned: s.banned,
  waitSeconds: s.banned ? 0 : s.waitSeconds,
  triesLeft: Math.max(0, MAX_FAILURES - s.failures),
  serverTime: Date.now(),
});

type Session = { email: string; name: string; unlocked: boolean };
// sessions only work from the device that signed in, so a copied token is useless anywhere else
async function sessionOf(token: string | null, device: string): Promise<Session | null> {
  if (!token) return null;
  return firstRow<Session>(await rpc('ea_session', { p_token_hash: await sha256Hex(token), p_device: device }));
}

async function sendCodeEmail(to: string, code: string): Promise<boolean> {
  const spaced = code.slice(0, 3) + ' ' + code.slice(3);
  const text = `Your Every Airfield sign-in code is ${spaced}.\n\nIt works once and expires in 10 minutes.\n\n` +
    `If you didn't ask for this code, you can ignore this email: someone may have typed your address by mistake. ` +
    `Never share this code with anyone.`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f3f5f2;font-family:Arial,Helvetica,sans-serif;color:#142430">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="440" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border:1px solid #dfe4e2;border-radius:14px">
<tr><td style="background:#0c2033;color:#f2f6f9;padding:18px 24px;border-radius:14px 14px 0 0;font-size:18px;font-weight:bold;letter-spacing:2px">EVERY AIRFIELD</td></tr>
<tr><td style="padding:24px">
<p style="margin:0 0 12px;font-size:15px">Your sign-in code is:</p>
<p style="margin:0 0 16px;font-family:'Courier New',monospace;font-size:34px;font-weight:bold;letter-spacing:6px;color:#0c2033">${spaced}</p>
<p style="margin:0 0 12px;font-size:14px;color:#5b6c78">It works once and expires in 10 minutes.</p>
<p style="margin:0;font-size:13px;color:#5b6c78">If you didn't ask for this code, you can ignore this email: someone may have typed your address by mistake. Never share this code with anyone.</p>
</td></tr></table></td></tr></table></body></html>`;
  try {
    const res = await fetch(BREVO_URL, {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: SENDER_NAME, email: SENDER_EMAIL },
        to: [{ email: to }],
        subject: 'Your Every Airfield sign-in code',
        textContent: text,
        htmlContent: html,
        tags: ['sign-in-code'],
      }),
    });
    if (!res.ok) {
      console.error('email send failed', res.status, (await res.text()).slice(0, 300));
      return false;
    }
    return true;
  } catch (err) {
    console.error('email send failed', err);
    return false;
  }
}

// ---------- the request handler ----------

export async function handler(req: Request): Promise<Response> {
  const origin = req.headers.get('origin') ?? '';
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: ALLOWED_ORIGINS.includes(origin) ? 204 : 403, headers: corsHeaders(origin) });
  }
  if (req.method !== 'POST') return reply(origin, 405, { error: 'method_not_allowed' });
  if (!ALLOWED_ORIGINS.includes(origin)) return reply(origin, 403, { error: 'origin_not_allowed' });
  if (!SUPABASE_URL || !SERVICE_KEY || !IP_SALT || CODE_PEPPER.length < 16 || !BREVO_API_KEY || !SENDER_EMAIL) {
    return reply(origin, 500, { error: 'server_not_configured' });
  }

  // read and parse the body defensively
  const raw = await req.text().catch(() => '');
  if (raw.length > MAX_BODY_BYTES) return reply(origin, 413, { error: 'too_large' });
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return reply(origin, 400, { error: 'bad_request' });
  }

  try {
    const ipHash = await sha256Hex(IP_SALT + '|' + clientIp(req));
    if (!(await rpc<boolean>('ea_ip_hit', { p_ip_hash: ipHash, p_limit: IP_LIMIT_PER_10_MIN }))) {
      return reply(origin, 429, { error: 'slow_down', retryAfter: 600 });
    }

    const action = body.action;
    const device = normDevice(body.device);
    if (!device) return reply(origin, 400, { error: 'bad_device' });
    const email = normEmail(body.email);
    const keys = ['d:' + device];
    if (email) keys.push('e:' + email);

    if (action === 'status') {
      const token = normToken(body.token);
      const sess = await sessionOf(token, device);
      // a signed-in person's own email always counts, so editing the saved email in the browser
      // can't hide a ban or lockout
      if (sess && !keys.includes('e:' + sess.email)) keys.push('e:' + sess.email);
      const s = await status(keys);
      return reply(origin, 200, {
        ok: true, ...stateBody(s),
        signedIn: !!sess, name: sess?.name ?? null, email: sess?.email ?? null, unlocked: !!sess?.unlocked,
      });
    }

    if (action === 'send') {
      if (!email) return reply(origin, 400, { error: 'bad_email' });
      const s = await status(keys);
      if (s.banned || s.waitSeconds > 0) return reply(origin, 403, { ok: false, ...stateBody(s) });
      const wait = await rpc<number>('ea_send_ok', { p_keys: keys, p_gap_seconds: SEND_GAP_SECONDS, p_per_hour: SENDS_PER_HOUR });
      if (Number(wait) > 0) return reply(origin, 429, { ok: false, error: 'send_limit', retryAfter: Number(wait) });
      const ipWait = await rpc<number>('ea_send_ok', { p_keys: ['i:' + ipHash], p_gap_seconds: 0, p_per_hour: IP_SENDS_PER_HOUR });
      if (Number(ipWait) > 0) return reply(origin, 429, { ok: false, error: 'send_limit', retryAfter: Number(ipWait) });
      const code = newCode();
      await rpc('ea_store_code', { p_email: email, p_code_hash: await codeHash(email, code), p_ttl_seconds: CODE_TTL_SECONDS });
      if (!(await sendCodeEmail(email, code))) return reply(origin, 502, { ok: false, error: 'send_failed' });
      return reply(origin, 200, { ok: true, sent: true, resendAfter: SEND_GAP_SECONDS, expiresIn: CODE_TTL_SECONDS });
    }

    if (action === 'verify') {
      if (!email) return reply(origin, 400, { error: 'bad_email' });
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      if (!CODE_RE.test(code)) return reply(origin, 400, { error: 'bad_code_format' });
      // Only count guesses for an email that has a live code. Without this, anyone could get any
      // email banned without that person ever receiving a code. The reply is the same whether or not
      // the email has an account.
      if (!(await rpc<boolean>('ea_has_code', { p_email: email }))) return reply(origin, 400, { ok: false, error: 'no_code' });
      if (!(await rpc<boolean>('ea_claim', { p_keys: keys, p_hold_seconds: HOLD_SECONDS }))) {
        return reply(origin, 403, { ok: false, ...stateBody(await status(keys)) });
      }
      let result: string;
      try {
        result = String(await rpc('ea_check_code', { p_email: email, p_code_hash: await codeHash(email, code) }));
      } catch (err) {
        await rpc('ea_release', { p_keys: keys, p_hold_seconds: HOLD_SECONDS }).catch(() => {});
        throw err;
      }
      if (result === 'none') {
        // the code expired between the two checks: nothing was guessed, so nothing is counted
        await rpc('ea_release', { p_keys: keys, p_hold_seconds: HOLD_SECONDS });
        return reply(origin, 400, { ok: false, error: 'no_code' });
      }
      if (result !== 'ok') {
        const f = firstRow<{ failures: number; banned: boolean }>(
          await rpc('ea_fail', { p_keys: keys, p_lock_minutes: LOCK_MINUTES, p_max: MAX_FAILURES })) ?? { failures: MAX_FAILURES, banned: true };
        const failures = Number(f.failures) || MAX_FAILURES;
        return reply(origin, 401, {
          ok: false, error: 'wrong_code',
          banned: !!f.banned, waitSeconds: f.banned ? 0 : LOCK_MINUTES * 60,
          triesLeft: Math.max(0, MAX_FAILURES - failures), serverTime: Date.now(),
        });
      }
      await rpc('ea_succeed', { p_keys: keys });
      const token = newToken();
      const person = firstRow<{ name: string; unlocked: boolean }>(await rpc('ea_sign_in', {
        p_email: email, p_name: normName(body.name), p_token_hash: await sha256Hex(token), p_device: device, p_ttl_days: SESSION_DAYS,
      }));
      return reply(origin, 200, {
        ok: true,
        session: { token, expiresAt: Date.now() + SESSION_DAYS * 86400_000 },
        name: person?.name ?? '', email, unlocked: !!person?.unlocked,
      });
    }

    if (action === 'unlock') {
      // the $5 setup fee is $0.00 while payments are switched off, so a verified person unlocks directly
      const token = normToken(body.token);
      const sess = await sessionOf(token, device);
      if (!sess || !token) return reply(origin, 401, { ok: false, error: 'not_signed_in' });
      const s = await status(['d:' + device, 'e:' + sess.email]);
      if (s.banned || s.waitSeconds > 0) return reply(origin, 403, { ok: false, ...stateBody(s) });
      if (!(await rpc<boolean>('ea_unlock', { p_token_hash: await sha256Hex(token), p_device: device }))) {
        return reply(origin, 401, { ok: false, error: 'not_signed_in' });
      }
      return reply(origin, 200, { ok: true, unlocked: true, charged: 0 });
    }

    if (action === 'signout') {
      const token = normToken(body.token);
      if (token) await rpc('ea_sign_out', { p_token_hash: await sha256Hex(token) });
      return reply(origin, 200, { ok: true });
    }

    return reply(origin, 400, { error: 'unknown_action' });
  } catch (err) {
    console.error('ea-auth error', err);
    return reply(origin, 500, { error: 'server_error' });
  }
}

// Tests import handler() directly; everywhere else this file serves requests.
if (!Deno.env.get('EA_TEST')) Deno.serve(handler);
