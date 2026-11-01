-- Funções auxiliares e políticas RLS.
-- As funções são SECURITY DEFINER para evitar recursão entre políticas; todas fixam search_path.

create or replace function public.try_uuid(p text) returns uuid
language plpgsql immutable set search_path = public as $$
begin
  return p::uuid;
exception when others then
  return null;
end $$;

create or replace function public.is_member(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.class_members where class_id = cid and user_id = auth.uid());
$$;

create or replace function public.is_admin(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.class_members
                 where class_id = cid and user_id = auth.uid() and role = 'admin');
$$;

-- admin sempre pode publicar; membros só se a turma permitir
create or replace function public.can_post(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.class_members m join public.classes c on c.id = m.class_id
    where m.class_id = cid and m.user_id = auth.uid()
      and (m.role = 'admin' or coalesce((c.settings ->> 'members_can_post')::boolean, true)));
$$;

create or replace function public.shares_class(uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.class_members a join public.class_members b on a.class_id = b.class_id
    where a.user_id = auth.uid() and b.user_id = uid);
$$;

create or replace function public.post_class(pid uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select class_id from public.posts where id = pid;
$$;

create or replace function public.is_post_author(pid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.posts where id = pid and author_id = auth.uid() and deleted_at is null);
$$;

-- Quem pode ler uma publicação: MEMBRO da turma, e a publicação não pode estar removida
-- (a menos que o próprio usuário já a tenha adicionado à agenda).
create or replace function public.can_see_post(pid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.posts p
    where p.id = pid
      and public.is_member(p.class_id)
      and (p.deleted_at is null
           or exists (select 1 from public.activities a where a.post_id = p.id and a.user_id = auth.uid())));
$$;

create or replace function public.owns_subject(sid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.subjects where id = sid and user_id = auth.uid());
$$;

create or replace function public.owns_activity(aid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.activities where id = aid and user_id = auth.uid());
$$;

-- ---------------------------------------------------------------- gatilhos de proteção
-- O cliente não pode forjar vínculos com publicações: só as funções RPC (que rodam como dono) criam
-- atividades com post_id. O cliente pode atualizar o restante da própria atividade normalmente.
create or replace function public.activities_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      if new.post_id is not null or new.post_removed then
        raise exception 'forbidden_post_link' using errcode = '42501';
      end if;
    else
      if new.post_id is distinct from old.post_id or new.post_removed is distinct from old.post_removed then
        raise exception 'forbidden_post_link' using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end $$;
create trigger activities_guard_trg before insert or update on public.activities
  for each row execute function public.activities_guard();

create or replace function public.posts_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' and current_user in ('authenticated', 'anon') then
    if new.class_id <> old.class_id or new.author_id <> old.author_id
       or new.created_at <> old.created_at or new.deleted_at is distinct from old.deleted_at then
      raise exception 'immutable_field' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger posts_guard_trg before update on public.posts
  for each row execute function public.posts_guard();

-- ---------------------------------------------------------------- RLS
alter table public.profiles       enable row level security;
alter table public.classes        enable row level security;
alter table public.class_secrets  enable row level security;
alter table public.class_members  enable row level security;
alter table public.join_attempts  enable row level security;
alter table public.posts          enable row level security;
alter table public.post_files     enable row level security;
alter table public.subjects       enable row level security;
alter table public.activities     enable row level security;
alter table public.files          enable row level security;
alter table public.user_settings  enable row level security;

-- perfis: o próprio e colegas de turma (para mostrar nomes de autores/participantes)
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.shares_class(id));
create policy profiles_insert on public.profiles for insert to authenticated
  with check (id = auth.uid());
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- turmas / membros: somente leitura direta; toda alteração passa por funções RPC
create policy classes_select on public.classes for select to authenticated
  using (public.is_member(id));
create policy class_members_select on public.class_members for select to authenticated
  using (public.is_member(class_id));
-- class_secrets e join_attempts: RLS ligada e NENHUMA política => ninguém lê nem escreve pelo app

-- publicações
create policy posts_select on public.posts for select to authenticated
  using (public.can_see_post(id));
create policy posts_insert on public.posts for insert to authenticated
  with check (author_id = auth.uid() and deleted_at is null and public.can_post(class_id));
create policy posts_update on public.posts for update to authenticated
  using (author_id = auth.uid() and deleted_at is null and public.is_member(class_id))
  with check (author_id = auth.uid() and deleted_at is null and public.is_member(class_id));
-- exclusão: apenas pela função delete_post (sem política de DELETE)

create policy post_files_select on public.post_files for select to authenticated
  using (public.can_see_post(post_id));
create policy post_files_insert on public.post_files for insert to authenticated
  with check (uploader_id = auth.uid()
              and public.is_post_author(post_id)
              and class_id = public.post_class(post_id));
create policy post_files_delete on public.post_files for delete to authenticated
  using (uploader_id = auth.uid() or public.is_admin(class_id));

-- dados pessoais: cada linha pertence a um usuário
create policy subjects_all on public.subjects for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy activities_all on public.activities for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and (subject_id is null or public.owns_subject(subject_id)));

create policy files_all on public.files for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid()
              and (subject_id is null or public.owns_subject(subject_id))
              and (activity_id is null or public.owns_activity(activity_id)));

create policy user_settings_all on public.user_settings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------- privilégios
revoke all on public.profiles, public.classes, public.class_secrets, public.class_members,
              public.join_attempts, public.posts, public.post_files, public.subjects,
              public.activities, public.files, public.user_settings
  from anon, authenticated;

grant select, update on public.profiles to authenticated;
grant insert on public.profiles to authenticated;
grant select on public.classes, public.class_members to authenticated;
grant select, insert, update on public.posts to authenticated;
grant select, insert, delete on public.post_files to authenticated;
grant select, insert, update, delete on public.subjects, public.activities, public.files,
                                         public.user_settings to authenticated;
-- class_secrets e join_attempts: nenhum privilégio para anon/authenticated

-- funções auxiliares: apenas usuários autenticados
revoke execute on function public.try_uuid(text), public.is_member(uuid), public.is_admin(uuid),
  public.can_post(uuid), public.shares_class(uuid), public.post_class(uuid),
  public.is_post_author(uuid), public.can_see_post(uuid), public.owns_subject(uuid),
  public.owns_activity(uuid) from public, anon;
grant execute on function public.try_uuid(text), public.is_member(uuid), public.is_admin(uuid),
  public.can_post(uuid), public.shares_class(uuid), public.post_class(uuid),
  public.is_post_author(uuid), public.can_see_post(uuid), public.owns_subject(uuid),
  public.owns_activity(uuid) to authenticated;
