delete from avatars older
using avatars newer
where older.user_id = newer.user_id
  and (
    older.created_at < newer.created_at
    or (older.created_at = newer.created_at and older.id < newer.id)
  );

alter table avatars
  add constraint avatars_user_id_unique unique (user_id);
