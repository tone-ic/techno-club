-- seed.sql — тестовые данные
-- Применять только в dev окружении!

-- Тестовая комната
insert into club_rooms (id, name, status, max_players, shard)
values
  ('00000000-0000-0000-0000-000000000001', 'Main Floor', 'open', 50, 0),
  ('00000000-0000-0000-0000-000000000002', 'VIP Room', 'private', 20, 0)
on conflict do nothing;
