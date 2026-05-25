-- 004_game_player_state.sql
-- Persistent game loop state written by the raw WebSocket game server.

create table if not exists game_player_state (
  player_key text primary key,
  user_id uuid,
  role text not null default 'guest'
    check (role in ('guest','bouncer','guard','dj','bartender','vip','owner','admin')),
  clubles_balance int not null default 1000 check (clubles_balance >= 0),
  vip_access boolean not null default false,
  lockscreen_music_until timestamptz,
  cooldown_until timestamptz,
  active_entitlements jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists game_player_state_user_id_idx on game_player_state (user_id);
create index if not exists game_player_state_cooldown_idx on game_player_state (cooldown_until);

alter table game_player_state enable row level security;

create policy "game_player_state_select_own" on game_player_state
  for select using (auth.uid() = user_id);

create table if not exists game_admission_events (
  id uuid primary key default uuid_generate_v4(),
  player_key text not null,
  user_id uuid,
  result text not null check (result in ('approved','denied')),
  reason_code text,
  cooldown_until timestamptz,
  actor_player_key text,
  actor_user_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists game_admission_events_player_key_idx on game_admission_events (player_key, created_at desc);
create index if not exists game_admission_events_actor_idx on game_admission_events (actor_player_key, created_at desc);

alter table game_admission_events enable row level security;

create policy "game_admission_events_select_own" on game_admission_events
  for select using (auth.uid() = user_id);
