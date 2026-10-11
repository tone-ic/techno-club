create table if not exists public.avatar_proxy_assignments (
  user_id uuid primary key references auth.users(id) on delete cascade,
  proxy_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.avatar_proxy_assignments enable row level security;
revoke all on public.avatar_proxy_assignments from anon, authenticated;
grant all on public.avatar_proxy_assignments to service_role;

create or replace function public.assign_avatar_proxy(
  p_user_id uuid,
  p_proxy_keys text[]
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing_key text;
  v_selected_key text;
begin
  if p_user_id is null or coalesce(cardinality(p_proxy_keys), 0) = 0 then
    raise exception 'user id and at least one proxy key are required';
  end if;

  -- Serialize assignments so concurrent first-time requests don't all select the same proxy.
  perform pg_advisory_xact_lock(hashtextextended('public.avatar_proxy_assignments', 0));

  select proxy_key
    into v_existing_key
    from public.avatar_proxy_assignments
    where user_id = p_user_id;

  if v_existing_key = any(p_proxy_keys) then
    return v_existing_key;
  end if;

  select candidates.proxy_key
    into v_selected_key
    from unnest(p_proxy_keys) with ordinality as candidates(proxy_key, position)
    left join public.avatar_proxy_assignments as assignments
      on assignments.proxy_key = candidates.proxy_key
    group by candidates.proxy_key, candidates.position
    order by count(assignments.user_id), candidates.position
    limit 1;

  insert into public.avatar_proxy_assignments (user_id, proxy_key)
    values (p_user_id, v_selected_key)
    on conflict (user_id) do update
      set proxy_key = excluded.proxy_key,
          updated_at = now();

  return v_selected_key;
end;
$$;

revoke all on function public.assign_avatar_proxy(uuid, text[]) from public, anon, authenticated;
grant execute on function public.assign_avatar_proxy(uuid, text[]) to service_role;
