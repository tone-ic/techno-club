-- 005_profile_onboarding.sql
-- Email onboarding: unique nickname, age confirmation, and under-18 lockout.

alter table profiles
  add column if not exists display_name_key text,
  add column if not exists age int,
  add column if not exists onboarding_completed boolean not null default false,
  add column if not exists display_name_changed_at timestamptz,
  add column if not exists underage_blocked_at timestamptz;

alter table profiles drop constraint if exists profiles_role_check;
alter table profiles
  add constraint profiles_role_check
  check (role in ('guest','bouncer','guard','dj','bartender','light','vip','owner','admin'));

create unique index if not exists profiles_display_name_key_unique
  on profiles (display_name_key)
  where display_name_key is not null;

create or replace function public.normalize_display_name_key(value text)
returns text
language sql
immutable
as $$
  select nullif(lower(regexp_replace(btrim(coalesce(value, '')), '\s+', ' ', 'g')), '');
$$;

create or replace function public.complete_profile_onboarding(
  p_display_name text,
  p_age int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_name text := btrim(coalesce(p_display_name, ''));
  v_key text := public.normalize_display_name_key(p_display_name);
  v_profile profiles%rowtype;
  v_next_change_at timestamptz;
  v_provider text := coalesce(auth.jwt() -> 'app_metadata' ->> 'provider', '');
  v_providers jsonb := coalesce(auth.jwt() -> 'app_metadata' -> 'providers', '[]'::jsonb);
begin
  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  if v_provider <> 'email' and not (v_providers ? 'email') then
    return jsonb_build_object('status', 'email_required');
  end if;

  insert into profiles (user_id, display_name)
  values (v_user_id, 'Аноним')
  on conflict (user_id) do nothing;

  select * into v_profile from profiles where user_id = v_user_id;

  if p_age is null or p_age < 1 or p_age > 120 then
    return jsonb_build_object('status', 'invalid_age');
  end if;

  if p_age < 18 then
    update profiles
      set age = p_age,
          age_confirmed = false,
          onboarding_completed = false,
          underage_blocked_at = now(),
          updated_at = now()
      where user_id = v_user_id;

    return jsonb_build_object('status', 'underage');
  end if;

  if v_key is null or char_length(v_name) < 3 or char_length(v_name) > 24 then
    return jsonb_build_object('status', 'invalid_name');
  end if;

  if exists (
    select 1 from profiles
    where display_name_key = v_key and user_id <> v_user_id
  ) then
    return jsonb_build_object('status', 'duplicate');
  end if;

  if v_profile.onboarding_completed
     and v_profile.display_name_key is not null
     and v_profile.display_name_key <> v_key
     and v_profile.display_name_changed_at is not null
     and v_profile.display_name_changed_at > now() - interval '7 days' then
    v_next_change_at := v_profile.display_name_changed_at + interval '7 days';
    return jsonb_build_object('status', 'cooldown', 'next_change_at', v_next_change_at);
  end if;

  update profiles
    set display_name = v_name,
        display_name_key = v_key,
        age = p_age,
        age_confirmed = true,
        onboarding_completed = true,
        underage_blocked_at = null,
        display_name_changed_at = case
          when v_profile.display_name_key is distinct from v_key then now()
          else coalesce(v_profile.display_name_changed_at, now())
        end,
        updated_at = now()
    where user_id = v_user_id;

  return jsonb_build_object('status', 'ok', 'display_name', v_name);
exception
  when unique_violation then
    return jsonb_build_object('status', 'duplicate');
end;
$$;

grant execute on function public.complete_profile_onboarding(text, int) to authenticated;
