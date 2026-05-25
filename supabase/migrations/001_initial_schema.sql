-- 001_initial_schema.sql
-- Применить через: supabase db push

-- ─── Extensions ───────────────────────────────────────────────────────────────
create extension if not exists "uuid-ossp";

-- ─── Profiles ─────────────────────────────────────────────────────────────────
create table if not exists profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Аноним',
  avatar_id   uuid,
  role        text not null default 'guest'
                   check (role in ('guest','bouncer','guard','dj','bartender','light','admin')),
  age_confirmed boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- RLS
alter table profiles enable row level security;
create policy "profiles_select_own" on profiles for select using (auth.uid() = user_id);
create policy "profiles_update_own" on profiles for update using (auth.uid() = user_id);
create policy "profiles_insert_own" on profiles for insert with check (auth.uid() = user_id);

-- Авто-создать профиль при регистрации
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into profiles (user_id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', 'Аноним'))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();

-- ─── Avatars ──────────────────────────────────────────────────────────────────
create table if not exists avatars (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  glb_url         text,
  face_tex_url    text,           -- скрыт от других через RLS
  config_json     jsonb not null default '{}',
  version         int not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table avatars enable row level security;
-- Своё: видит всё
create policy "avatars_all_own" on avatars for all using (auth.uid() = user_id);
-- Чужое: только публичные поля (config_json без face_tex_url) — через API/view
create policy "avatars_select_others" on avatars for select
  using (true);

-- ─── Club Rooms ───────────────────────────────────────────────────────────────
create table if not exists club_rooms (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  status      text not null default 'open' check (status in ('open','closed','private')),
  max_players int not null default 50,
  dj_user_id  uuid references auth.users(id),
  shard       int not null default 0,
  created_at  timestamptz not null default now()
);

alter table club_rooms enable row level security;
create policy "club_rooms_select_all" on club_rooms for select using (true);

-- ─── Queue Entries ────────────────────────────────────────────────────────────
create table if not exists queue_entries (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  room_id     uuid not null references club_rooms(id) on delete cascade,
  status      text not null default 'waiting' check (status in ('waiting','processing','done')),
  position    int not null default 0,
  joined_at   timestamptz not null default now(),
  unique (user_id, room_id)
);

alter table queue_entries enable row level security;
create policy "queue_select_own" on queue_entries for select using (auth.uid() = user_id);

-- ─── Admission Attempts ────────────────────────────────────────────────────────
create table if not exists admission_attempts (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  room_id         uuid not null references club_rooms(id) on delete cascade,
  result          text not null check (result in ('approved','denied')),
  reason_code     text check (reason_code in ('dress_code','overcrowded','behavior','closed_event','vibe_check')),
  cooldown_until  timestamptz,
  bouncer_id      uuid references auth.users(id),
  created_at      timestamptz not null default now()
);

alter table admission_attempts enable row level security;
create policy "admission_select_own" on admission_attempts for select using (auth.uid() = user_id);

-- ─── Roles ────────────────────────────────────────────────────────────────────
create table if not exists roles (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null,
  room_id     uuid references club_rooms(id),
  approved_by uuid references auth.users(id),
  expires_at  timestamptz,
  created_at  timestamptz not null default now()
);

alter table roles enable row level security;
create policy "roles_select_own" on roles for select using (auth.uid() = user_id);

-- ─── Reports ──────────────────────────────────────────────────────────────────
create table if not exists reports (
  id          uuid primary key default uuid_generate_v4(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  target_id   uuid not null references auth.users(id) on delete cascade,
  room_id     uuid references club_rooms(id),
  reason      text not null,
  details     text,
  created_at  timestamptz not null default now()
);

alter table reports enable row level security;
create policy "reports_insert_own" on reports for insert with check (auth.uid() = reporter_id);
create policy "reports_select_own" on reports for select using (auth.uid() = reporter_id);

-- ─── Moderation Actions ────────────────────────────────────────────────────────
create table if not exists moderation_actions (
  id          uuid primary key default uuid_generate_v4(),
  mod_id      uuid not null references auth.users(id),
  target_id   uuid not null references auth.users(id),
  action      text not null check (action in ('mute','kick','ban','warn','unban')),
  reason      text not null,
  room_id     uuid references club_rooms(id),
  created_at  timestamptz not null default now()
);

alter table moderation_actions enable row level security;
-- Только admin/guard могут смотреть
create policy "modaction_select_mod" on moderation_actions for select
  using (
    exists (select 1 from profiles where user_id = auth.uid() and role in ('admin','guard'))
  );

-- ─── Bans ─────────────────────────────────────────────────────────────────────
create table if not exists bans (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  reason      text not null,
  until       timestamptz,         -- null = перманентный
  banned_by   uuid references auth.users(id),
  created_at  timestamptz not null default now()
);

alter table bans enable row level security;
create policy "bans_select_own" on bans for select using (auth.uid() = user_id);

-- ─── Bouncer Stats ────────────────────────────────────────────────────────────
create table if not exists bouncer_stats (
  id          uuid primary key default uuid_generate_v4(),
  bouncer_id  uuid not null references auth.users(id) on delete cascade,
  session_id  text not null,
  approves    int not null default 0,
  denies      int not null default 0,
  escalations int not null default 0,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz
);

alter table bouncer_stats enable row level security;
create policy "bouncer_stats_select_own" on bouncer_stats for select using (auth.uid() = bouncer_id);
