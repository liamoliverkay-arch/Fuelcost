// Every Airfield live planes (Supabase Edge Function "ea-planes").
//
// Plane positions come from adsb.lol, a community network of ADS-B receivers whose data is open
// (Open Database License). Browsers can't read adsb.lol directly because its API sends no CORS
// headers, so this function fetches the planes around one map position and passes them on:
//   • only the site's own web addresses (ALLOWED_ORIGINS) are answered
//   • each IP address: at most 300 requests per 10 minutes (stored only as a salted hash)
//   • answers are cached for 5 seconds and shared between visitors looking at the same area, so
//     adsb.lol sees at most one request per area every 5 seconds however many people are watching
//   • only the fields the map shows are passed on, about a sixth of the original size
//
// GET /functions/v1/ea-planes?lat=40.7&lon=-74.0&dist=120     (dist in nautical miles, max 250)
// Reply: { now, ac: [[hex, callsign, registration, type, category, military, lat, lon, alt, gs, track, vrate, squawk], ...] }
//        alt is feet, or -1 on the ground, or null when unknown.
// Deploy with JWT verification OFF (setup/setup.py does): browsers call it without any Supabase key.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const IP_SALT = Deno.env.get('IP_SALT') ?? '';
const UPSTREAM = Deno.env.get('PLANES_UPSTREAM') ?? 'https://api.adsb.lol/v2/point';

const CACHE_MS = 5000;
const MAX_DIST_NM = 250;
const IP_LIMIT_PER_10_MIN = 300;
const MAX_STALE_SECONDS = 60;      // drop planes whose last position report is older than this

const cache = new Map<string, { at: number; body: string }>();
const inflight = new Map<string, Promise<string>>();

function corsHeaders(origin: string): Record<string, string> {
  const h: Record<string, string> = { 'Vary': 'Origin', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  if (ALLOWED_ORIGINS.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
    h['Access-Control-Max-Age'] = '600';
  }
  return h;
}

function reply(origin: string, status: number, body: string, cacheSeconds = 0): Response {
  return new Response(body, {
    status,
    headers: {
      ...corsHeaders(origin),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheSeconds ? `public, max-age=${cacheSeconds}` : 'no-store',
    },
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

async function ipAllowed(req: Request): Promise<boolean> {
  if (!SUPABASE_URL || !SERVICE_KEY || !IP_SALT) return true;   // limits need the database; without it, cache-only protection
  const headers: Record<string, string> = { 'Content-Type': 'application/json', apikey: SERVICE_KEY };
  if (!SERVICE_KEY.startsWith('sb_')) headers.Authorization = 'Bearer ' + SERVICE_KEY;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ea_ip_hit`, {
    method: 'POST', headers,
    body: JSON.stringify({ p_ip_hash: await sha256Hex(IP_SALT + '|planes|' + clientIp(req)), p_limit: IP_LIMIT_PER_10_MIN }),
  });
  if (!res.ok) return true;          // the limiter being down shouldn't take the map down
  return (await res.json()) !== false;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v: unknown, digits: number) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(digits)) : null);

// adsb.lol's aircraft record → the compact row the map uses
export function compact(a: Record<string, unknown>): unknown[] | null {
  const lat = num(a.lat, 5), lon = num(a.lon, 5);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (typeof a.seen_pos === 'number' && a.seen_pos > MAX_STALE_SECONDS) return null;
  const hex = str(a.hex, 12).toLowerCase();
  if (!/^~?[0-9a-f]{6}$/.test(hex)) return null;
  const alt = a.alt_baro === 'ground' ? -1 : num(a.alt_baro, 0);
  const track = num(a.track, 0) ?? num(a.true_heading, 0) ?? num(a.mag_heading, 0);
  return [
    hex,
    str(a.flight, 10),
    str(a.r, 12),
    str(a.t, 6),
    str(a.category, 2),
    typeof a.dbFlags === 'number' && (a.dbFlags & 1) ? 1 : 0,
    lat, lon, alt,
    num(a.gs, 0),
    track,
    num(a.baro_rate, 0) ?? num(a.geom_rate, 0),
    str(a.squawk, 4),
  ];
}

async function fetchArea(lat: number, lon: number, dist: number): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${UPSTREAM}/${lat}/${lon}/${dist}`, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'EveryAirfield/1.0 (live map; cached 5s)' },
    });
    if (!res.ok) throw new Error('upstream ' + res.status);
    const data = await res.json();
    const ac = (Array.isArray(data?.ac) ? data.ac : []).map(compact).filter(Boolean);
    return JSON.stringify({ now: typeof data?.now === 'number' ? data.now : Date.now(), ac });
  } finally {
    clearTimeout(timer);
  }
}

export async function handler(req: Request): Promise<Response> {
  const origin = req.headers.get('origin') ?? '';
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: ALLOWED_ORIGINS.includes(origin) ? 204 : 403, headers: corsHeaders(origin) });
  }
  if (req.method !== 'GET') return reply(origin, 405, '{"error":"method_not_allowed"}');
  if (!ALLOWED_ORIGINS.includes(origin)) return reply(origin, 403, '{"error":"origin_not_allowed"}');

  const q = new URL(req.url).searchParams;
  let lat = Number(q.get('lat')), lon = Number(q.get('lon')), dist = Number(q.get('dist'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(dist) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || dist <= 0) {
    return reply(origin, 400, '{"error":"bad_position"}');
  }
  // snap to a coarse grid so nearby visitors share one cached answer
  lat = Math.round(lat * 4) / 4;
  lon = Math.round(lon * 4) / 4;
  dist = Math.min(MAX_DIST_NM, Math.ceil(dist / 25) * 25);

  try {
    if (!(await ipAllowed(req))) return reply(origin, 429, '{"error":"slow_down"}');
    const key = `${lat}/${lon}/${dist}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return reply(origin, 200, hit.body, 5);
    let p = inflight.get(key);
    if (!p) {
      p = fetchArea(lat, lon, dist).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    const body = await p;
    cache.set(key, { at: Date.now(), body });
    if (cache.size > 500) for (const [k, v] of cache) if (Date.now() - v.at > CACHE_MS) cache.delete(k);
    return reply(origin, 200, body, 5);
  } catch (err) {
    console.error('ea-planes error', err);
    return reply(origin, 502, '{"error":"planes_unavailable"}');
  }
}

if (!Deno.env.get('EA_TEST')) Deno.serve(handler);
