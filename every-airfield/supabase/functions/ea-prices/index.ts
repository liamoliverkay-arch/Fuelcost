// Every Airfield shared fuel prices (Supabase Edge Function "ea-prices").
//
// One price list for the website and the desktop apps:
//   GET  → { prices: [{ ident, fuel, price, at }] }       newest first, cached for 10 seconds
//   POST { ident, fuel, price, device } → the saved record
// Protections:
//   • only the site's own web addresses and the desktop app (ALLOWED_ORIGINS) are answered
//   • each IP address: at most 300 requests per 10 minutes, and 60 price reports per hour
//   • each device: at most 30 price reports per hour
//   • fuel must be 100LL, JetA or MOGAS; price between $0.01 and $50; airport IDs 1–16 letters, digits or dashes
//   • the database rejects anything else too, and browsers can't reach the table directly
// Deploy with JWT verification OFF (setup/setup.py does): browsers call it without any Supabase key.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = serviceKey();
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const IP_SALT = Deno.env.get('IP_SALT') ?? '';

const IP_LIMIT_PER_10_MIN = 300;
const REPORTS_PER_HOUR_PER_IP = 60;
const REPORTS_PER_HOUR_PER_DEVICE = 30;
const LIST_CACHE_MS = 10000;
const MAX_BODY_BYTES = 2000;
const FUELS = new Set(['100LL', 'JetA', 'MOGAS']);
const IDENT_RE = /^[A-Za-z0-9-]{1,16}$/;
const DEVICE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

function corsHeaders(origin: string): Record<string, string> {
  const h: Record<string, string> = { 'Vary': 'Origin', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  if (ALLOWED_ORIGINS.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'content-type';
    h['Access-Control-Max-Age'] = '600';
  }
  return h;
}
function reply(origin: string, status: number, body: unknown, cacheSeconds = 0): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cacheSeconds ? `public, max-age=${cacheSeconds}` : 'no-store' },
  });
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}
function clientIp(req: Request): string {
  const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') ||
    (req.headers.get('x-forwarded-for') ?? '').split(',')[0] || 'unknown';
  return ip.trim().slice(0, 64);
}
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', apikey: SERVICE_KEY };
  if (!SERVICE_KEY.startsWith('sb_')) headers.Authorization = 'Bearer ' + SERVICE_KEY;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args) });
  const text = await res.text();
  if (!res.ok) throw new Error(`database call ${fn} failed (${res.status}): ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

let listCache: { at: number; body: string } | null = null;

export async function handler(req: Request): Promise<Response> {
  const origin = req.headers.get('origin') ?? '';
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: ALLOWED_ORIGINS.includes(origin) ? 204 : 403, headers: corsHeaders(origin) });
  }
  if (req.method !== 'GET' && req.method !== 'POST') return reply(origin, 405, { error: 'method_not_allowed' });
  if (!ALLOWED_ORIGINS.includes(origin)) return reply(origin, 403, { error: 'origin_not_allowed' });
  if (!SUPABASE_URL || !SERVICE_KEY || !IP_SALT) return reply(origin, 500, { error: 'server_not_configured' });

  try {
    const ipHash = await sha256Hex(IP_SALT + '|prices|' + clientIp(req));
    if (!(await rpc<boolean>('ea_ip_hit', { p_ip_hash: ipHash, p_limit: IP_LIMIT_PER_10_MIN }))) {
      return reply(origin, 429, { error: 'slow_down' });
    }

    if (req.method === 'GET') {
      if (listCache && Date.now() - listCache.at < LIST_CACHE_MS) return reply(origin, 200, listCache.body, 10);
      const rows = await rpc<{ ident: string; fuel: string; price: number | string; at: number }[]>('ea_list_prices', {});
      const body = JSON.stringify({ prices: (rows ?? []).map((r) => ({ ident: r.ident, fuel: r.fuel, price: Number(r.price), at: Number(r.at) })) });
      listCache = { at: Date.now(), body };
      return reply(origin, 200, body, 10);
    }

    const raw = await req.text().catch(() => '');
    if (!raw || raw.length > MAX_BODY_BYTES) return reply(origin, 400, { error: 'bad_request' });
    let b: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      b = parsed;
    } catch {
      return reply(origin, 400, { error: 'bad_request' });
    }
    const ident = b.ident, fuel = b.fuel, price = b.price, device = b.device;
    if (typeof ident !== 'string' || !IDENT_RE.test(ident) || typeof fuel !== 'string' || !FUELS.has(fuel) ||
        typeof price !== 'number' || !Number.isFinite(price) || Math.round(price * 100) < 1 || price > 50) {
      return reply(origin, 400, { error: 'Send ident, fuel (100LL, JetA or MOGAS) and a price between 0 and 50.' });
    }
    const keys = ['p:' + ipHash];
    if (Number(await rpc<number>('ea_send_ok', { p_keys: keys, p_gap_seconds: 0, p_per_hour: REPORTS_PER_HOUR_PER_IP })) > 0 ||
        (typeof device === 'string' && DEVICE_RE.test(device) &&
         Number(await rpc<number>('ea_send_ok', { p_keys: ['pd:' + device], p_gap_seconds: 0, p_per_hour: REPORTS_PER_HOUR_PER_DEVICE })) > 0)) {
      return reply(origin, 429, { error: 'Too many reports from here. Try again in a while.' });
    }
    const rows = await rpc<{ ident: string; fuel: string; price: number | string; at: number }[]>('ea_report_price', {
      p_ident: ident, p_fuel: fuel, p_price: Math.round(price * 100) / 100,
    });
    listCache = null;
    const r = rows?.[0];
    return reply(origin, 200, r ? { ident: r.ident, fuel: r.fuel, price: Number(r.price), at: Number(r.at) } : { ident, fuel, price });
  } catch (err) {
    console.error('ea-prices error', err);
    return reply(origin, 500, { error: 'server_error' });
  }
}

if (!Deno.env.get('EA_TEST')) Deno.serve(handler);
