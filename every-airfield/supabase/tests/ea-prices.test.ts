// Tests for the ea-prices function, against a real Postgres (PGlite, in memory) loaded with schema.sql.
// Run from the project folder:   deno test -A supabase/tests/ea-prices.test.ts

import { PGlite } from 'npm:@electric-sql/pglite@0.5.8';

const ORIGIN = 'https://site.test';
Deno.env.set('EA_TEST', '1');
Deno.env.set('SUPABASE_URL', 'http://supabase.test');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-key-for-tests');
Deno.env.set('ALLOWED_ORIGINS', `${ORIGIN},app://every-airfield`);
Deno.env.set('IP_SALT', 'salt-for-tests');

const db = new PGlite();
await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin;`);
await db.exec(await Deno.readTextFile(new URL('../schema.sql', import.meta.url)));
await db.exec(`set role service_role`);

const realFetch = globalThis.fetch;
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith('http://supabase.test/rest/v1/rpc/')) throw new Error('unexpected fetch ' + url);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const fn = url.split('/').pop()!;
  const names = Object.keys(body), params: unknown[] = [];
  const args = names.map((k, i) => {
    const v = body[k];
    if (Array.isArray(v)) { params.push('{' + v.map((x: string) => '"' + x.replace(/["\\]/g, '\\$&') + '"').join(',') + '}'); return `${k} => $${i + 1}::text[]`; }
    params.push(v);
    return `${k} => $${i + 1}::${typeof v === 'number' ? (Number.isInteger(v) && k !== 'p_price' ? 'integer' : 'numeric') : 'text'}`;
  });
  try {
    const res = await db.query<Record<string, unknown>>(`select * from public.${fn}(${args.join(', ')})`, params);
    const fields = res.fields.map((f) => f.name);
    let out: unknown = res.rows;
    if (fields.length === 1 && fields[0] === fn) out = res.rows[0]?.[fn] ?? null;
    return new Response(JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ message: String((err as Error).message) }), { status: 400 });
  }
};

const { handler } = await import('../functions/ea-prices/index.ts');

let n = 1;
const ip = () => `10.9.${(n >> 8) & 255}.${n++ & 255}`;
async function call(method: string, body?: unknown, opt: { ip?: string; origin?: string; raw?: string } = {}) {
  const res = await handler(new Request('https://fn.test/ea-prices', {
    method, headers: { 'content-type': 'application/json', origin: opt.origin ?? ORIGIN, 'cf-connecting-ip': opt.ip ?? ip() },
    body: method === 'POST' ? (opt.raw ?? JSON.stringify(body)) : undefined,
  }));
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null, headers: res.headers };
}
function eq(a: unknown, b: unknown, msg: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`FAILED: ${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
const opts = { sanitizeOps: false, sanitizeResources: false };

Deno.test('only our site and the desktop app are answered', opts, async () => {
  eq((await call('GET', undefined, { origin: 'https://evil.test' })).status, 403, 'other site');
  eq((await call('GET', undefined, { origin: 'app://every-airfield' })).status, 200, 'desktop app');
  const pre = await handler(new Request('https://x', { method: 'OPTIONS', headers: { origin: ORIGIN } }));
  eq(pre.status, 204, 'preflight');
  eq(pre.headers.get('access-control-allow-origin'), ORIGIN, 'CORS origin');
});

Deno.test('report, list, replace', opts, async () => {
  eq((await call('GET')).body, { prices: [] }, 'empty');
  const r = await call('POST', { ident: 'KSMO', fuel: '100LL', price: 6.256, device: crypto.randomUUID() });
  eq(r.status, 200, 'saved');
  eq([r.body.ident, r.body.fuel, r.body.price], ['KSMO', '100LL', 6.26], 'rounded to cents');
  if (!(Math.abs(r.body.at - Date.now()) < 60000)) throw new Error('FAILED: server time');
  await call('POST', { ident: 'KSMO', fuel: '100LL', price: 5.5 });
  await call('POST', { ident: 'KSMO', fuel: 'JetA', price: 7 });
  const list = (await call('GET')).body.prices;
  eq(list.length, 2, 'one price per airport and fuel');
  eq(list.find((p: { fuel: string }) => p.fuel === '100LL').price, 5.5, 'newer report replaced the older one');
});

Deno.test('bad reports are refused', opts, async () => {
  const bad = [
    { ident: 'KSMO', fuel: '100LL', price: 0 }, { ident: 'KSMO', fuel: '100LL', price: 0.004 },
    { ident: 'KSMO', fuel: '100LL', price: 50.01 }, { ident: 'KSMO', fuel: '100LL', price: -3 },
    { ident: 'KSMO', fuel: '100LL', price: '6' }, { ident: 'KSMO', fuel: 'Diesel', price: 5 },
    { ident: 'KSMO', fuel: 'constructor', price: 5 }, { ident: '', fuel: '100LL', price: 5 },
    { ident: '../x', fuel: '100LL', price: 5 }, { ident: 'A'.repeat(17), fuel: '100LL', price: 5 },
    { ident: '<b>', fuel: '100LL', price: 5 }, { fuel: '100LL', price: 5 },
  ];
  for (const b of bad) eq((await call('POST', b)).status, 400, 'refused ' + JSON.stringify(b));
  for (const raw of ['not json', '[]', 'null', '{"ident":"KSMO","fuel":"100LL","price":1e999}', 'x'.repeat(2500)]) {
    eq((await call('POST', null, { raw })).status, 400, 'refused raw ' + raw.slice(0, 20));
  }
});

Deno.test('report limits: 60 per hour per address, 30 per hour per device', opts, async () => {
  const addr = '192.0.2.50';
  const codes = [];
  for (let i = 0; i < 61; i++) codes.push((await call('POST', { ident: 'K' + i, fuel: 'MOGAS', price: 4 }, { ip: addr })).status);
  eq(codes.slice(0, 60).every((c) => c === 200), true, 'first 60 accepted');
  eq(codes[60], 429, '61st refused');
  const device = crypto.randomUUID();
  const dcodes = [];
  for (let i = 0; i < 31; i++) dcodes.push((await call('POST', { ident: 'D' + i, fuel: 'MOGAS', price: 4, device })).status);
  eq(dcodes[30], 429, '31st from one device refused even from new addresses');
});

Deno.test('browsers cannot touch the price table or functions', opts, async () => {
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`reset role; set role ${role}`);
    for (const sql of [`select * from ea_prices`, `select * from ea_list_prices()`, `select * from ea_report_price('KSMO','100LL',1)`,
      `insert into ea_prices(key, ident, fuel, price) values ('x~JetA','x','JetA',1)`]) {
      let refused = false;
      try { await db.query(sql); } catch { refused = true; }
      if (!refused) throw new Error(`FAILED: ${role} ran ${sql}`);
    }
  }
  await db.exec('reset role; set role service_role');
});

Deno.test('cleanup', opts, () => { globalThis.fetch = realFetch; });
