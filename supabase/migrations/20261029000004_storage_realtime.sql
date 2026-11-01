-- Storage privado + políticas + Realtime.
--
-- Estrutura do bucket "files" (privado, sem URLs públicas):
--   u/<user_id>/<file_id>                          arquivos pessoais
--   c/<class_id>/<post_id>/<uploader_id>/<file_id> anexos de publicações das turmas

insert into storage.buckets (id, name, public, file_size_limit)
values ('files', 'files', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

-- pessoais: só o dono
create policy files_personal_all on storage.objects for all to authenticated
  using (bucket_id = 'files'
         and (storage.foldername(name))[1] = 'u'
         and (storage.foldername(name))[2] = auth.uid()::text)
  with check (bucket_id = 'files'
              and (storage.foldername(name))[1] = 'u'
              and (storage.foldername(name))[2] = auth.uid()::text);

-- turma: leitura para quem pode ver a publicação (ou o próprio autor do envio, ainda sem registro)
create policy files_class_select on storage.objects for select to authenticated
  using (bucket_id = 'files'
         and (storage.foldername(name))[1] = 'c'
         and (
           exists (select 1 from public.post_files pf
                   where pf.storage_path = objects.name and public.can_see_post(pf.post_id))
           or (public.is_member(public.try_uuid((storage.foldername(name))[2]))
               and (storage.foldername(name))[4] = auth.uid()::text)));

-- turma: envio só por membro, dentro da própria pasta de uploader
create policy files_class_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'files'
              and (storage.foldername(name))[1] = 'c'
              and (storage.foldername(name))[4] = auth.uid()::text
              and public.is_member(public.try_uuid((storage.foldername(name))[2])));

-- turma: exclusão pelo autor do envio ou por administrador da turma
create policy files_class_delete on storage.objects for delete to authenticated
  using (bucket_id = 'files'
         and (storage.foldername(name))[1] = 'c'
         and public.is_member(public.try_uuid((storage.foldername(name))[2]))
         and ((storage.foldername(name))[4] = auth.uid()::text
              or public.is_admin(public.try_uuid((storage.foldername(name))[2]))));

-- Realtime (a RLS continua valendo: cada usuário só recebe eventos de linhas que pode ler)
do $$
declare t text;
begin
  foreach t in array array['subjects', 'activities', 'files', 'user_settings', 'classes',
                           'class_members', 'posts', 'post_files'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
              when undefined_object then null;
    end;
  end loop;
end $$;
