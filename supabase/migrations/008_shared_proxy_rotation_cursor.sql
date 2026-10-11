create table if not exists public.proxy_rotation_cursors (
  cursor_name text primary key,
  next_index integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.proxy_rotation_cursors enable row level security;
revoke all on public.proxy_rotation_cursors from anon, authenticated;
grant all on public.proxy_rotation_cursors to service_role;

create or replace function public.next_avatar_proxy_index(p_pool_size integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_selected_index integer;
begin
  if p_pool_size is null or p_pool_size < 1 then
    raise exception 'proxy pool size must be greater than zero';
  end if;

  insert into public.proxy_rotation_cursors as cursors (cursor_name, next_index)
    values ('avatar_generation', 0)
    on conflict (cursor_name) do update
      set next_index = (cursors.next_index + 1) % p_pool_size,
          updated_at = now()
    returning next_index into v_selected_index;

  return v_selected_index;
end;
$$;

revoke all on function public.next_avatar_proxy_index(integer) from public, anon, authenticated;
grant execute on function public.next_avatar_proxy_index(integer) to service_role;
