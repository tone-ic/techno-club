-- Storage buckets for generated avatar assets.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatar-models',
  'avatar-models',
  true,
  20971520,
  array[
    'model/gltf-binary',
    'application/octet-stream',
    'image/jpeg',
    'image/png',
    'image/webp'
  ]::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'avatar_models_public_read'
  ) then
    create policy "avatar_models_public_read"
      on storage.objects for select
      using (bucket_id = 'avatar-models');
  end if;
end $$;
