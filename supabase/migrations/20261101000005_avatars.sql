-- Foto de perfil. O arquivo fica no bucket privado "files", em a/<id_do_usuário>/<nome>.
-- Quem lê: o próprio usuário e quem divide uma turma com ele. Quem escreve: só o dono, na própria pasta.
alter table public.profiles add column avatar_path text;
alter table public.profiles add constraint profiles_avatar_path_chk
  check (avatar_path is null or (char_length(avatar_path) <= 100 and avatar_path like 'a/' || id::text || '/%'));

create policy avatars_select on storage.objects for select to authenticated
  using (bucket_id = 'files'
         and (storage.foldername(name))[1] = 'a'
         and (   (storage.foldername(name))[2] = auth.uid()::text
              or public.shares_class(public.try_uuid((storage.foldername(name))[2]))));

create policy avatars_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'files'
              and (storage.foldername(name))[1] = 'a'
              and (storage.foldername(name))[2] = auth.uid()::text);

create policy avatars_delete on storage.objects for delete to authenticated
  using (bucket_id = 'files'
         and (storage.foldername(name))[1] = 'a'
         and (storage.foldername(name))[2] = auth.uid()::text);
