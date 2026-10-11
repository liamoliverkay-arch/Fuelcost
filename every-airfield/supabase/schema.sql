-- Every Airfield: sign-in protection
-- The setup script (setup/setup.py) runs this for you. To run it by hand: Supabase → SQL Editor →
-- New query → paste → Run. It is safe to run again.
--
-- How sign-in works: the ea-auth Edge Function creates a 6-digit code, emails it, and checks it.
-- Supabase Auth is not used at all, so there is no second door that skips the rules below.
--
--   ea_codes     the current code per email, stored only as a keyed hash (HMAC); one try per code
--   ea_attempts  wrong-code counts and lockouts, per email ("e:<email>") and per device ("d:<id>")
--   ea_bans      emails/devices banned after 5 wrong codes, until the owner runs ea_unban()
--   ea_sends     when codes were last emailed, to stop code-spamming
--   ea_ip_hits   requests per hashed IP address per 10 minutes, to stop floods
--   ea_users     one row per verified person: name, when verified, whether Find Fuel is unlocked
--   ea_sessions  signed-in browsers; only a SHA-256 hash of each session token is stored
--   ea_prices    reported fuel prices, one per airport and fuel (ea-prices function)
--
-- Visitors' browsers can't read or write any of these tables: there are no policies, and anon and
-- authenticated have no privileges. Only the ea-auth function (service role) reaches them, and only
-- through the functions below.

create table if not exists public.ea_attempts (
  key          text primary key,
  failures     integer not null default 0,
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);

create table if not exists public.ea_bans (
  key        text primary key,
  grp        uuid,                       -- keys banned together (an email and its device) share a group
  reason     text not null,
  created_at timestamptz not null default now()
);
alter table public.ea_bans add column if not exists grp uuid;

create table if not exists public.ea_sends (
  key          text primary key,
  last_sent_at timestamptz,
  window_start timestamptz,
  sends        integer not null default 0
);

create table if not exists public.ea_ip_hits (
  ip_hash text not null,
  bucket  timestamptz not null,
  hits    integer not null default 0,
  primary key (ip_hash, bucket)
);

create table if not exists public.ea_codes (
  email      text primary key,
  code_hash  text not null,              -- HMAC-SHA256(server-only key, email|code); the code is never stored
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.ea_users (
  email       text primary key,
  name        text not null default '',
  verified_at timestamptz,
  unlocked    boolean not null default false,
  unlocked_at timestamptz,
  created_at  timestamptz not null default now()
);

create table if not exists public.ea_sessions (
  token_hash   text primary key,         -- SHA-256 of the token; the token itself lives only in the browser
  email        text not null references public.ea_users (email) on delete cascade,
  device       text,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_seen_at timestamptz not null default now()
);
create index if not exists ea_sessions_email on public.ea_sessions (email);

create table if not exists public.ea_prices (
  key   text primary key,                -- '<airport ident>~<fuel>': a new report replaces the old one
  ident text not null check (ident ~ '^[A-Za-z0-9-]{1,16}$'),
  fuel  text not null check (fuel in ('100LL', 'JetA', 'MOGAS')),
  price numeric(5, 2) not null check (price > 0 and price <= 50),
  at    timestamptz not null default now()
);

alter table public.ea_attempts enable row level security;
alter table public.ea_bans     enable row level security;
alter table public.ea_sends    enable row level security;
alter table public.ea_ip_hits  enable row level security;
alter table public.ea_codes    enable row level security;
alter table public.ea_users    enable row level security;
alter table public.ea_sessions enable row level security;
alter table public.ea_prices   enable row level security;
revoke all on public.ea_attempts, public.ea_bans, public.ea_sends, public.ea_ip_hits,
              public.ea_codes, public.ea_users, public.ea_sessions, public.ea_prices from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Functions used by ea-auth. Row locks stop two requests at once from both slipping through (for
-- example, two guesses fired at the same moment). They run as their owner (security definer), so
-- search_path is pinned with pg_temp last: otherwise Postgres would look in the caller's temporary
-- schema first and a temp table named like ours could stand in.
-- ---------------------------------------------------------------------------------------------

-- Current state for a set of keys: banned?, seconds left on a lockout, wrong codes so far.
create or replace function public.ea_status(p_keys text[])
returns table (banned boolean, wait_seconds integer, failures integer)
language sql security definer set search_path = public, pg_temp as $$
  select
    exists (select 1 from ea_bans b where b.key = any (p_keys)),
    coalesce((select max(greatest(0, ceil(extract(epoch from (a.locked_until - now())))))::integer
                from ea_attempts a where a.key = any (p_keys)), 0),
    coalesce((select max(a.failures) from ea_attempts a where a.key = any (p_keys)), 0);
$$;

-- Atomically check that none of the keys is banned or locked, then hold them for p_hold_seconds
-- while one code is checked. Returns false if the caller has to wait (or is banned).
create or replace function public.ea_claim(p_keys text[], p_hold_seconds integer)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare k text;
begin
  foreach k in array p_keys loop
    insert into ea_attempts (key) values (k) on conflict (key) do nothing;
  end loop;
  perform 1 from ea_attempts where key = any (p_keys) order by key for update;
  if exists (select 1 from ea_bans where key = any (p_keys)) then return false; end if;
  if exists (select 1 from ea_attempts where key = any (p_keys) and locked_until > now()) then return false; end if;
  update ea_attempts set locked_until = now() + make_interval(secs => p_hold_seconds), updated_at = now()
   where key = any (p_keys);
  return true;
end $$;

-- Give back a hold from ea_claim when no code was actually checked. A real 10-minute lockout is
-- longer than any hold, so it is never shortened by this.
create or replace function public.ea_release(p_keys text[], p_hold_seconds integer)
returns void
language sql security definer set search_path = public, pg_temp as $$
  update ea_attempts set locked_until = null, updated_at = now()
   where key = any (p_keys) and locked_until is not null
     and locked_until <= now() + make_interval(secs => p_hold_seconds);
$$;

-- A wrong code: count it, lock for p_lock_minutes, ban at p_max failures. The keys banned together
-- (the email and the device) share a group, so ea_unban lifts both.
create or replace function public.ea_fail(p_keys text[], p_lock_minutes integer, p_max integer)
returns table (failures integer, banned boolean, wait_seconds integer)
language plpgsql security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare f integer; g uuid := gen_random_uuid();
begin
  perform 1 from ea_attempts where key = any (p_keys) order by key for update;
  update ea_attempts a
     set failures = a.failures + 1,
         locked_until = now() + make_interval(mins => p_lock_minutes),
         updated_at = now()
   where a.key = any (p_keys);
  select max(a.failures) into f from ea_attempts a where a.key = any (p_keys);
  if f >= p_max then
    insert into ea_bans (key, grp, reason)
      select k, g, 'wrong verification code ' || p_max || ' times' from unnest(p_keys) as k
      on conflict (key) do nothing;
  end if;
  return query select f, f >= p_max, p_lock_minutes * 60;
end $$;

-- A right code: clear the wrong-code count and any lockout.
create or replace function public.ea_succeed(p_keys text[])
returns void
language sql security definer set search_path = public, pg_temp as $$
  update ea_attempts set failures = 0, locked_until = null, updated_at = now() where key = any (p_keys);
$$;

-- May we email another code? At most one per p_gap_seconds and p_per_hour per hour, per key.
-- Returns 0 when allowed (and records the send), otherwise the seconds to wait.
create or replace function public.ea_send_ok(p_keys text[], p_gap_seconds integer, p_per_hour integer)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare k text; wait integer := 0; r ea_sends%rowtype;
begin
  foreach k in array p_keys loop
    insert into ea_sends (key) values (k) on conflict (key) do nothing;
  end loop;
  for r in select * from ea_sends where key = any (p_keys) order by key for update loop
    if r.last_sent_at is not null and r.last_sent_at > now() - make_interval(secs => p_gap_seconds) then
      wait := greatest(wait, ceil(extract(epoch from (r.last_sent_at + make_interval(secs => p_gap_seconds) - now())))::integer);
    end if;
    if r.window_start is not null and r.window_start > now() - interval '1 hour' and r.sends >= p_per_hour then
      wait := greatest(wait, ceil(extract(epoch from (r.window_start + interval '1 hour' - now())))::integer);
    end if;
  end loop;
  if wait > 0 then return wait; end if;
  update ea_sends
     set last_sent_at = now(),
         sends = case when window_start is null or window_start <= now() - interval '1 hour' then 1 else sends + 1 end,
         window_start = case when window_start is null or window_start <= now() - interval '1 hour' then now() else window_start end
   where key = any (p_keys);
  return 0;
end $$;

-- Count a request from a (hashed) IP address; false once it passes p_limit in the current 10 minutes.
create or replace function public.ea_ip_hit(p_ip_hash text, p_limit integer)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare b timestamptz := to_timestamp(floor(extract(epoch from now()) / 600) * 600); n integer;
begin
  insert into ea_ip_hits (ip_hash, bucket, hits) values (p_ip_hash, b, 1)
    on conflict (ip_hash, bucket) do update set hits = ea_ip_hits.hits + 1
    returning hits into n;
  delete from ea_ip_hits where bucket < now() - interval '1 day';
  return n <= p_limit;
end $$;

-- Keep a new code for an email (replacing any earlier one) for p_ttl_seconds.
create or replace function public.ea_store_code(p_email text, p_code_hash text, p_ttl_seconds integer)
returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into ea_codes (email, code_hash, expires_at) values (p_email, p_code_hash, now() + make_interval(secs => p_ttl_seconds))
    on conflict (email) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at, created_at = now();
  delete from ea_codes where expires_at < now() - interval '1 day';
$$;

-- Is there a live code for this email? (Guesses are only counted when there is.)
create or replace function public.ea_has_code(p_email text)
returns boolean
language sql security definer set search_path = public, pg_temp as $$
  select exists (select 1 from ea_codes where email = p_email and expires_at > now());
$$;

-- Check a code. Every code gets exactly one try: it is deleted whether the guess is right or wrong.
-- Returns 'ok', 'wrong', or 'none' (no live code).
create or replace function public.ea_check_code(p_email text, p_code_hash text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare r ea_codes%rowtype;
begin
  select * into r from ea_codes where email = p_email for update;
  if not found then return 'none'; end if;
  delete from ea_codes where email = p_email;
  if r.expires_at <= now() then return 'none'; end if;
  if r.code_hash = p_code_hash then return 'ok'; end if;
  return 'wrong';
end $$;

-- A verified sign-in: create or update the person and start a session. Keeps their 10 newest sessions.
create or replace function public.ea_sign_in(p_email text, p_name text, p_token_hash text, p_device text, p_ttl_days integer)
returns table (name text, unlocked boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
begin
  insert into ea_users (email, name, verified_at) values (p_email, coalesce(p_name, ''), now())
    on conflict (email) do update
      set verified_at = now(),
          name = case when coalesce(excluded.name, '') <> '' then excluded.name else ea_users.name end;
  insert into ea_sessions (token_hash, email, device, expires_at)
    values (p_token_hash, p_email, p_device, now() + make_interval(days => p_ttl_days));
  delete from ea_sessions s
   where s.email = p_email
     and s.token_hash not in (select s2.token_hash from ea_sessions s2 where s2.email = p_email order by s2.created_at desc limit 10);
  delete from ea_sessions where expires_at < now();
  return query select u.name, u.unlocked from ea_users u where u.email = p_email;
end $$;

-- Who does a session token belong to? Nothing comes back for an unknown or expired token, or when it
-- is used from a different device than the one that signed in (a copied token is useless elsewhere).
drop function if exists public.ea_session(text);
create or replace function public.ea_session(p_token_hash text, p_device text)
returns table (email text, name text, unlocked boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
begin
  update ea_sessions set last_seen_at = now()
   where token_hash = p_token_hash and expires_at > now() and device = p_device;
  return query
    select u.email, u.name, u.unlocked
      from ea_sessions s join ea_users u on u.email = s.email
     where s.token_hash = p_token_hash and s.expires_at > now() and s.device = p_device;
end $$;

-- Unlock Find Fuel for the session's person (the $5 setup fee is $0.00 while payments are off).
drop function if exists public.ea_unlock(text);
create or replace function public.ea_unlock(p_token_hash text, p_device text)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare e text;
begin
  select email into e from ea_sessions where token_hash = p_token_hash and expires_at > now() and device = p_device;
  if e is null then return false; end if;
  update ea_users set unlocked = true, unlocked_at = coalesce(unlocked_at, now()) where email = e;
  return true;
end $$;

create or replace function public.ea_sign_out(p_token_hash text)
returns void
language sql security definer set search_path = public, pg_temp as $$
  delete from ea_sessions where token_hash = p_token_hash;
$$;

-- Fuel prices: report one (replacing that airport's earlier price for the same fuel) and list them all.
create or replace function public.ea_report_price(p_ident text, p_fuel text, p_price numeric)
returns table (ident text, fuel text, price numeric, at bigint)
language plpgsql security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
begin
  return query
  insert into ea_prices as p (key, ident, fuel, price, at)
    values (p_ident || '~' || p_fuel, p_ident, p_fuel, round(p_price, 2), now())
    on conflict (key) do update set price = excluded.price, at = excluded.at
    returning p.ident, p.fuel, p.price, (extract(epoch from p.at) * 1000)::bigint;
end $$;

create or replace function public.ea_list_prices()
returns table (ident text, fuel text, price numeric, at bigint)
language sql security definer set search_path = public, pg_temp as $$
  select p.ident, p.fuel, p.price, (extract(epoch from p.at) * 1000)::bigint
    from ea_prices p order by p.at desc limit 20000;
$$;

-- Lift a ban (the owner runs this, or setup/setup.py unban):  select ea_unban('person@example.com');
-- Also lifts the device banned together with that email, and clears their wrong-code counts.
create or replace function public.ea_unban(p_email text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare k text := 'e:' || lower(trim(p_email)); keys text[]; n integer;
begin
  select coalesce(array_agg(b.key), array[]::text[]) into keys
    from ea_bans b
   where b.key = k or (b.grp is not null and b.grp in (select grp from ea_bans where key = k));
  delete from ea_bans where key = any (keys);
  get diagnostics n = row_count;
  delete from ea_attempts where key = any (keys) or key = k;
  return case when n > 0 then 'Unbanned ' || array_to_string(keys, ', ') else 'No ban found for ' || k end;
end $$;

-- Only the server (service role) may call these.
do $$
declare f text;
begin
  foreach f in array array[
    'ea_status(text[])', 'ea_claim(text[], integer)', 'ea_release(text[], integer)',
    'ea_fail(text[], integer, integer)', 'ea_succeed(text[])', 'ea_send_ok(text[], integer, integer)',
    'ea_ip_hit(text, integer)', 'ea_store_code(text, text, integer)', 'ea_has_code(text)',
    'ea_check_code(text, text)', 'ea_sign_in(text, text, text, text, integer)', 'ea_session(text, text)',
    'ea_unlock(text, text)', 'ea_sign_out(text)', 'ea_unban(text)',
    'ea_report_price(text, text, numeric)', 'ea_list_prices()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
