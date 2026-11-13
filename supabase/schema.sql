-- =====================================================================
-- Game With Me - database setup
-- Paste this whole file into Supabase > SQL Editor > New query > Run.
-- Safe to run more than once.
-- =====================================================================

-- ---------- tables ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null check (username ~ '^[A-Za-z0-9_]{3,20}$'),
  custom_replies text[] not null default '{}',
  created_at timestamptz not null default now()
);
create unique index if not exists profiles_username_lower on public.profiles (lower(username));
-- Chosen controller colours, e.g. {"body": "crimson", "buttons": "white", "ring": "gold"}
alter table public.profiles add column if not exists controller jsonb not null default '{}'::jsonb;
-- Keep the two fields a user can edit small.
alter table public.profiles drop constraint if exists profiles_replies_small;
alter table public.profiles add constraint profiles_replies_small
  check (cardinality(custom_replies) <= 8 and char_length(array_to_string(custom_replies, '')) <= 320);
alter table public.profiles drop constraint if exists profiles_controller_small;
alter table public.profiles add constraint profiles_controller_small
  check (jsonb_typeof(controller) = 'object' and octet_length(controller::text) <= 200);

create table if not exists public.parties (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 30),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.party_members (
  party_id uuid not null references public.parties(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (party_id, user_id)
);
create index if not exists party_members_user on public.party_members (user_id);

-- Invite codes live apart from parties so only members can read them.
create table if not exists public.party_invites (
  party_id uuid primary key references public.parties(id) on delete cascade,
  code text not null unique
);

create table if not exists public.join_requests (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references public.parties(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (party_id, user_id)
);
alter table public.join_requests add column if not exists notified_at timestamptz;

-- One row each time someone presses the controller.
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  platform text not null check (char_length(platform) <= 30),
  game text check (char_length(game) <= 40),
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
create index if not exists sessions_active on public.sessions (user_id) where ended_at is null;
create index if not exists sessions_user_started on public.sessions (user_id, started_at desc);
-- Set by the notify function so each check-in is announced once only.
alter table public.sessions add column if not exists notified_at timestamptz;

create table if not exists public.responses (
  session_id uuid not null references public.sessions(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  text text not null check (char_length(text) between 1 and 40),
  created_at timestamptz not null default now(),
  primary key (session_id, user_id)
);
-- What the host was last told, and how many times, so replies cannot be used to spam.
alter table public.responses add column if not exists notified_text text;
alter table public.responses add column if not exists notify_count int not null default 0;

create table if not exists public.availability (
  user_id uuid not null references public.profiles(id) on delete cascade,
  day date not null,
  slot text not null check (slot in ('am', 'pm', 'eve')),
  primary key (user_id, day, slot)
);

-- Every slot a user has ever ticked. Unticking a slot does not remove it from here,
-- so the Planner trophy cannot be lost. Nobody can read or write this directly.
create table if not exists public.availability_log (
  user_id uuid not null references public.profiles(id) on delete cascade,
  day date not null,
  slot text not null,
  primary key (user_id, day, slot)
);
insert into public.availability_log (user_id, day, slot)
  select user_id, day, slot from public.availability on conflict do nothing;

create table if not exists public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user on public.push_subscriptions (user_id);

-- ---------- helper functions (used by the security rules) ----------
create or replace function public.is_member(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from party_members where party_id = p and user_id = auth.uid());
$$;

create or replace function public.is_owner(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from parties where id = p and owner_id = auth.uid());
$$;

-- True when the signed-in user is in at least one party with the other user.
create or replace function public.shares_party(other uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select other = auth.uid() or exists (
    select 1 from party_members a join party_members b using (party_id)
    where a.user_id = auth.uid() and b.user_id = other);
$$;

-- Whose username and controller may the signed-in user see?
-- Themselves, party mates, people asking to join a party they host,
-- and anyone who replied to a party mate's recent check-in.
create or replace function public.can_see_profile(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p = auth.uid()
    or exists (select 1 from party_members a join party_members b using (party_id)
               where a.user_id = auth.uid() and b.user_id = p)
    or exists (select 1 from join_requests r join parties pa on pa.id = r.party_id
               where r.user_id = p and pa.owner_id = auth.uid())
    or exists (select 1 from responses r
               join sessions s on s.id = r.session_id
               join party_members a on a.user_id = s.user_id
               join party_members b on b.party_id = a.party_id
               where r.user_id = p and b.user_id = auth.uid() and s.started_at > now() - interval '1 day');
$$;

-- ---------- triggers ----------
-- New login -> profile row with the chosen username.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare uname text := new.raw_user_meta_data->>'username';
begin
  if uname is null or uname !~ '^[A-Za-z0-9_]{3,20}$' then
    raise exception 'Invalid username';
  end if;
  insert into profiles (id, username) values (new.id, uname);
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- New party -> creator becomes a member and an invite code is made.
create or replace function public.handle_new_party() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into party_members (party_id, user_id) values (new.id, new.owner_id);
  insert into party_invites (party_id, code)
    values (new.id, upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)));
  return new;
end $$;
drop trigger if exists on_party_created on public.parties;
create trigger on_party_created after insert on public.parties
  for each row execute function public.handle_new_party();

-- Ticking a slot is remembered for good (see availability_log).
create or replace function public.log_availability() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into availability_log (user_id, day, slot) values (new.user_id, new.day, new.slot) on conflict do nothing;
  return new;
end $$;
drop trigger if exists on_availability_added on public.availability;
create trigger on_availability_added after insert on public.availability
  for each row execute function public.log_availability();

-- ---------- functions the app calls ----------
-- The only way to check in. The database stamps the time, and a second call inside
-- the hour (a double tap, a second phone) returns the session already running
-- instead of making another. The app cannot insert or edit sessions directly.
create or replace function public.check_in(p_platform text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  s sessions%rowtype;
begin
  if me is null then raise exception 'Not signed in'; end if;
  if p_platform is null or char_length(p_platform) not between 1 and 30 then raise exception 'Invalid platform'; end if;
  perform pg_advisory_xact_lock(hashtextextended(me::text, 0));   -- one check-in at a time per person
  select * into s from sessions
    where user_id = me and started_at > now() - interval '1 hour'
    order by started_at desc limit 1;
  if found then
    return jsonb_build_object('id', s.id, 'started_at', s.started_at, 'is_new', false);
  end if;
  insert into sessions (user_id, platform) values (me, p_platform) returning * into s;
  return jsonb_build_object('id', s.id, 'started_at', s.started_at, 'is_new', true);
end $$;

-- The only way to reply: to a party mate's check-in from the last hour, never your own.
create or replace function public.send_reply(p_session uuid, p_text text) returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  host uuid;
  started timestamptz;
  t text := trim(coalesce(p_text, ''));
begin
  if me is null then raise exception 'Not signed in'; end if;
  select user_id, started_at into host, started from sessions where id = p_session;
  if not found or not shares_party(host) then raise exception 'That session was not found'; end if;
  if host = me then raise exception 'You cannot reply to your own check-in'; end if;
  if started <= now() - interval '1 hour' then raise exception 'That session has ended'; end if;
  if char_length(t) not between 1 and 40 then raise exception 'Replies are 1 to 40 characters'; end if;
  insert into responses (session_id, user_id, text) values (p_session, me, t)
  on conflict (session_id, user_id) do update set text = excluded.text, created_at = now();
end $$;

create or replace function public.username_available(name text) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from profiles where lower(username) = lower(name));
$$;

create or replace function public.search_users(q text)
returns table (user_id uuid, username text, party_id uuid, party_name text)
language sql stable security definer set search_path = public as $$
  select p.id, p.username, pa.id, pa.name
  from profiles p
  left join party_members m on m.user_id = p.id
  left join parties pa on pa.id = m.party_id
  where auth.uid() is not null
    and p.id <> auth.uid()
    and lower(p.username) = lower(trim(q))     -- exact username only: no browsing other people
  order by pa.name
  limit 40;
$$;

create or replace function public.join_party_by_code(invite text) returns uuid
language plpgsql security definer set search_path = public as $$
declare pid uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select party_id into pid from party_invites where code = upper(trim(invite));
  if pid is null then raise exception 'That invite code was not recognised'; end if;
  insert into party_members (party_id, user_id) values (pid, auth.uid()) on conflict do nothing;
  delete from join_requests where party_id = pid and user_id = auth.uid();
  return pid;
end $$;

-- Only the party host can accept or decline.
create or replace function public.answer_request(req uuid, accept boolean) returns void
language plpgsql security definer set search_path = public as $$
declare r join_requests%rowtype;
begin
  select * into r from join_requests where id = req;
  if not found or not is_owner(r.party_id) then raise exception 'Not allowed'; end if;
  if accept then
    insert into party_members (party_id, user_id) values (r.party_id, r.user_id) on conflict do nothing;
  end if;
  delete from join_requests where id = req;
end $$;

-- A phone belongs to whoever signed in on it last.
create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  insert into push_subscriptions (endpoint, user_id, p256dh, auth)
    values (p_endpoint, auth.uid(), p_p256dh, p_auth)
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;

-- ---------- stats ----------
create or replace function public.wg_slot(t timestamp) returns text
language sql immutable as $$
  select case when extract(hour from t) < 12 then 'am' when extract(hour from t) < 17 then 'pm' else 'eve' end;
$$;

-- Everything the profile page shows, in one call: your own numbers, plus a
-- leaderboard for each party you are in. "tz" is the phone's time zone so that
-- "Friday evening" means Friday evening where you live.
create or replace function public.get_stats(tz text default 'UTC') returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  tzn text := tz;
  mine jsonb;
  groups jsonb;
begin
  if me is null then raise exception 'Not signed in'; end if;
  if not exists (select 1 from pg_timezone_names where name = tzn) then tzn := 'UTC'; end if;

  with s as (select id, timezone(tzn, started_at) as t from sessions where user_id = me),
  days as (select distinct t::date as d from s),
  runs as (select count(*) as n from (select d - (row_number() over (order by d))::int as grp from days) x group by grp),
  got as (select r.session_id from responses r join sessions x on x.id = r.session_id where x.user_id = me and r.user_id <> me)
  select jsonb_build_object(
    'checkins', (select count(*) from s),
    'early', (select count(*) from s where extract(hour from t) between 4 and 8),
    'night', (select count(*) from s where extract(hour from t) >= 23 or extract(hour from t) < 4),
    'weekend', (select count(*) from s where extract(isodow from t) >= 6),
    'streak', coalesce((select max(n) from runs), 0),
    'top_day', (select extract(isodow from t)::int from s group by 1 order by count(*) desc, 1 limit 1),
    'top_slot', (select wg_slot(t) from s group by 1 order by count(*) desc, 1 limit 1),
    'top_hour', (select extract(hour from t)::int from s group by 1 order by count(*) desc, 1 limit 1),
    'replies', (select count(*) from responses where user_id = me),
    'received', (select count(*) from got),
    'rally', coalesce((select max(c) from (select count(*) as c from got group by session_id) q), 0),
    'planned', (select count(*) from availability_log where user_id = me),
    'since', (select created_at from profiles where id = me)
  ) into mine;

  select coalesce(jsonb_agg(g order by g->>'name'), '[]'::jsonb) into groups from (
    select jsonb_build_object(
      'id', pa.id, 'name', pa.name,
      'members', (select jsonb_agg(jsonb_build_object(
            'id', pr.id, 'username', pr.username, 'controller', pr.controller,
            'checkins', (select count(*) from sessions x where x.user_id = pr.id),
            'replies', (select count(*) from responses r where r.user_id = pr.id)))
          from party_members m join profiles pr on pr.id = m.user_id where m.party_id = pa.id),
      'checkins', (select count(*) from sessions x join party_members m on m.user_id = x.user_id where m.party_id = pa.id),
      'top_day', (select extract(isodow from timezone(tzn, x.started_at))::int
          from sessions x join party_members m on m.user_id = x.user_id where m.party_id = pa.id
          group by 1 order by count(*) desc, 1 limit 1),
      'top_slot', (select wg_slot(timezone(tzn, x.started_at))
          from sessions x join party_members m on m.user_id = x.user_id where m.party_id = pa.id
          group by 1 order by count(*) desc, 1 limit 1)
    ) as g
    from parties pa
    where exists (select 1 from party_members m where m.party_id = pa.id and m.user_id = me)
  ) z;

  return jsonb_build_object('me', mine, 'parties', groups);
end $$;

-- ---------- security rules (row level security) ----------
alter table public.profiles enable row level security;
alter table public.parties enable row level security;
alter table public.party_members enable row level security;
alter table public.party_invites enable row level security;
alter table public.join_requests enable row level security;
alter table public.sessions enable row level security;
alter table public.responses enable row level security;
alter table public.availability enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.availability_log enable row level security;   -- no policies: closed to the app

-- You can see your own profile and those of people you have a reason to see (can_see_profile).
-- Finding someone new goes through search_users, which needs their exact username.
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (can_see_profile(id));
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists parties_read on public.parties;
create policy parties_read on public.parties for select to authenticated using (owner_id = auth.uid() or is_member(id));
drop policy if exists parties_insert on public.parties;
create policy parties_insert on public.parties for insert to authenticated with check (owner_id = auth.uid());
drop policy if exists parties_delete on public.parties;
create policy parties_delete on public.parties for delete to authenticated using (owner_id = auth.uid());

-- Membership is only ever added by the functions above.
drop policy if exists members_read on public.party_members;
create policy members_read on public.party_members for select to authenticated using (is_member(party_id));
drop policy if exists members_leave on public.party_members;
create policy members_leave on public.party_members for delete to authenticated
  using (user_id = auth.uid() or is_owner(party_id));

drop policy if exists invites_read on public.party_invites;
create policy invites_read on public.party_invites for select to authenticated using (is_member(party_id));

drop policy if exists requests_read on public.join_requests;
create policy requests_read on public.join_requests for select to authenticated
  using (user_id = auth.uid() or is_owner(party_id));
drop policy if exists requests_insert on public.join_requests;
create policy requests_insert on public.join_requests for insert to authenticated
  with check (user_id = auth.uid() and not is_member(party_id));
drop policy if exists requests_delete on public.join_requests;
create policy requests_delete on public.join_requests for delete to authenticated using (user_id = auth.uid());

-- Only people who share a party with you can see when you are on, reply, or see your week.
drop policy if exists sessions_read on public.sessions;
create policy sessions_read on public.sessions for select to authenticated using (shares_party(user_id));
-- Check-ins are created only by check_in(); these older rules are removed if present.
drop policy if exists sessions_insert on public.sessions;
drop policy if exists sessions_update on public.sessions;

drop policy if exists responses_read on public.responses;
create policy responses_read on public.responses for select to authenticated
  using (exists (select 1 from sessions s where s.id = session_id and shares_party(s.user_id)));
-- Replies are written only by send_reply(); these older rules are removed if present.
drop policy if exists responses_insert on public.responses;
drop policy if exists responses_update on public.responses;

drop policy if exists availability_read on public.availability;
create policy availability_read on public.availability for select to authenticated using (shares_party(user_id));
drop policy if exists availability_insert on public.availability;
create policy availability_insert on public.availability for insert to authenticated with check (user_id = auth.uid());
drop policy if exists availability_delete on public.availability;
create policy availability_delete on public.availability for delete to authenticated using (user_id = auth.uid());

drop policy if exists push_own on public.push_subscriptions;
create policy push_own on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- permissions ----------
-- Start from nothing, then allow exactly what the app needs. In particular a user can
-- change only their quick replies and controller colours on their own profile, never
-- their username or join date.
grant usage on schema public to anon, authenticated;
revoke all on all tables in schema public from anon, authenticated;
grant select on public.profiles, public.parties, public.party_members, public.party_invites,
  public.join_requests, public.sessions, public.responses, public.availability, public.push_subscriptions to authenticated;
grant update (custom_replies, controller) on public.profiles to authenticated;
grant insert (name, owner_id) on public.parties to authenticated;
grant delete on public.parties, public.party_members, public.join_requests, public.availability, public.push_subscriptions to authenticated;
grant insert (party_id, user_id) on public.join_requests to authenticated;
grant insert on public.availability to authenticated;
grant execute on function public.username_available(text) to anon, authenticated;
grant execute on function public.search_users(text), public.join_party_by_code(text),
  public.answer_request(uuid, boolean), public.save_push_subscription(text, text, text),
  public.is_member(uuid), public.is_owner(uuid), public.shares_party(uuid), public.get_stats(text),
  public.can_see_profile(uuid), public.check_in(text), public.send_reply(uuid, text) to authenticated;

-- ---------- live updates ----------
do $$
declare t text;
begin
  foreach t in array array['sessions', 'responses', 'availability', 'party_members', 'join_requests', 'parties'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
