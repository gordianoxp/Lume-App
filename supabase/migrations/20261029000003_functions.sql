-- Funções RPC (SECURITY DEFINER) para tudo o que NÃO pode ser feito direto pelo cliente:
-- criar/entrar/administrar turmas, excluir publicações e adicionar publicações à agenda.
-- Cada função valida auth.uid() e as permissões por conta própria (nunca confia no cliente).

-- código de convite: 8 caracteres sem letras ambíguas (sem I, L, O, 0, 1)
create or replace function public.gen_invite_code() returns text
language plpgsql volatile set search_path = public, extensions as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  bytes bytea := extensions.gen_random_bytes(8);
  code text := '';
  i int;
begin
  for i in 0..7 loop
    code := code || substr(alphabet, (get_byte(bytes, i) % 31) + 1, 1);
  end loop;
  return code;
end $$;

-- ---------------------------------------------------------------- criar turma
create or replace function public.create_class(p_name text, p_password text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  v_name text := trim(coalesce(p_name, ''));
  v_code text;
  v_id uuid;
  v_try int := 0;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  if char_length(v_name) < 1 or char_length(v_name) > 60 then raise exception 'invalid_name'; end if;
  if p_password is null or char_length(p_password) < 6 or octet_length(p_password) > 72 then
    raise exception 'invalid_password';
  end if;

  loop
    v_code := public.gen_invite_code();
    begin
      insert into public.classes (name, invite_code, created_by)
      values (v_name, v_code, v_uid) returning id into v_id;
      exit;
    exception when unique_violation then
      v_try := v_try + 1;
      if v_try > 10 then raise; end if;
    end;
  end loop;

  insert into public.class_secrets (class_id, password_hash)
  values (v_id, extensions.crypt(p_password, extensions.gen_salt('bf', 10)));
  insert into public.class_members (class_id, user_id, role) values (v_id, v_uid, 'admin');

  return jsonb_build_object('id', v_id, 'invite_code', v_code);
end $$;

-- ---------------------------------------------------------------- entrar em turma
-- Retorna {ok:true,class_id} ou {ok:false,error:'invalid'|'rate_limited'}.
-- Retorna (e não lança exceção) para que o registro da tentativa falha seja confirmado.
-- A mensagem é a mesma para código inexistente e senha errada (não revela quais turmas existem).
create or replace function public.join_class(p_code text, p_password text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_class_id uuid;
  v_hash text;
  v_user_fail int;
  v_code_fail int;
  v_ok boolean;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;

  delete from public.join_attempts where attempted_at < now() - interval '1 day';

  select count(*) into v_user_fail from public.join_attempts
   where user_id = v_uid and attempted_at > now() - interval '15 minutes';
  select count(*) into v_code_fail from public.join_attempts
   where code = v_code and attempted_at > now() - interval '15 minutes';
  if v_user_fail >= 5 or v_code_fail >= 30 then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  select c.id, s.password_hash into v_class_id, v_hash
    from public.classes c join public.class_secrets s on s.class_id = c.id
   where c.invite_code = v_code;

  if v_hash is null then
    perform extensions.crypt(coalesce(p_password, ''), extensions.gen_salt('bf', 10)); -- iguala o tempo de resposta
    v_ok := false;
  else
    v_ok := v_hash = extensions.crypt(coalesce(p_password, ''), v_hash);
  end if;

  if not v_ok then
    insert into public.join_attempts (user_id, code) values (v_uid, v_code);
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  insert into public.class_members (class_id, user_id, role)
  values (v_class_id, v_uid, 'member') on conflict do nothing;
  delete from public.join_attempts where user_id = v_uid and code = v_code;

  -- quem volta à turma recupera o vínculo das atividades que já tinha adicionado
  update public.activities a set post_removed = false
   where a.user_id = v_uid and a.post_removed
     and exists (select 1 from public.posts p where p.id = a.post_id and p.class_id = v_class_id and p.deleted_at is null);

  return jsonb_build_object('ok', true, 'class_id', v_class_id);
end $$;

-- ---------------------------------------------------------------- administração
create or replace function public.update_class(p_class uuid, p_name text, p_members_can_post boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text := trim(coalesce(p_name, ''));
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not public.is_admin(p_class) then raise exception 'forbidden'; end if;
  if char_length(v_name) < 1 or char_length(v_name) > 60 then raise exception 'invalid_name'; end if;
  update public.classes
     set name = v_name,
         settings = jsonb_set(settings, '{members_can_post}', to_jsonb(coalesce(p_members_can_post, true)))
   where id = p_class;
end $$;

create or replace function public.set_class_password(p_class uuid, p_new text, p_remove_members boolean default false) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not public.is_admin(p_class) then raise exception 'forbidden'; end if;
  if p_new is null or char_length(p_new) < 6 or octet_length(p_new) > 72 then raise exception 'invalid_password'; end if;
  update public.class_secrets
     set password_hash = extensions.crypt(p_new, extensions.gen_salt('bf', 10))
   where class_id = p_class;
  if p_remove_members then
    -- remove só quem é membro comum; administradores ficam
    update public.activities a set post_removed = true
     where a.post_id in (select id from public.posts where class_id = p_class)
       and a.user_id in (select user_id from public.class_members where class_id = p_class and role = 'member');
    delete from public.class_members where class_id = p_class and role = 'member';
  end if;
end $$;

create or replace function public.regenerate_invite_code(p_class uuid) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v_code text; v_try int := 0;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not public.is_admin(p_class) then raise exception 'forbidden'; end if;
  loop
    v_code := public.gen_invite_code();
    begin
      update public.classes set invite_code = v_code where id = p_class;
      exit;
    exception when unique_violation then
      v_try := v_try + 1;
      if v_try > 10 then raise; end if;
    end;
  end loop;
  return v_code;
end $$;

create or replace function public.set_member_role(p_class uuid, p_user uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not public.is_admin(p_class) then raise exception 'forbidden'; end if;
  if p_role not in ('admin', 'member') then raise exception 'invalid_role'; end if;
  if not exists (select 1 from public.class_members where class_id = p_class and user_id = p_user) then
    raise exception 'not_found';
  end if;
  if p_role = 'member' and not exists (
       select 1 from public.class_members where class_id = p_class and role = 'admin' and user_id <> p_user) then
    raise exception 'last_admin';
  end if;
  update public.class_members set role = p_role where class_id = p_class and user_id = p_user;
end $$;

create or replace function public.remove_member(p_class uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_role text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not public.is_admin(p_class) then raise exception 'forbidden'; end if;
  if p_user = auth.uid() then raise exception 'use_leave_class'; end if;
  select role into v_role from public.class_members where class_id = p_class and user_id = p_user;
  if v_role is null then raise exception 'not_found'; end if;
  if v_role = 'admin' then raise exception 'target_is_admin'; end if;
  update public.activities a set post_removed = true
   where a.user_id = p_user and a.post_id in (select id from public.posts where class_id = p_class);
  delete from public.class_members where class_id = p_class and user_id = p_user;
end $$;

create or replace function public.leave_class(p_class uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_role text; v_others int; v_other_admins int;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select role into v_role from public.class_members where class_id = p_class and user_id = v_uid;
  if v_role is null then raise exception 'not_found'; end if;
  select count(*) into v_others from public.class_members where class_id = p_class and user_id <> v_uid;
  select count(*) into v_other_admins from public.class_members where class_id = p_class and user_id <> v_uid and role = 'admin';
  if v_role = 'admin' and v_other_admins = 0 and v_others > 0 then raise exception 'last_admin'; end if;
  update public.activities a set post_removed = true
   where a.user_id = v_uid and a.post_id in (select id from public.posts where class_id = p_class);
  if v_others = 0 then
    delete from public.classes where id = p_class; -- último membro saindo: a turma é encerrada
  else
    delete from public.class_members where class_id = p_class and user_id = v_uid;
  end if;
end $$;

-- O cliente remove antes os arquivos do Storage (a política exige ser admin da turma) e só então chama esta função.
-- As atividades que os colegas adicionaram às suas agendas permanecem (são cópias independentes).
create or replace function public.delete_class(p_class uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not public.is_admin(p_class) then raise exception 'forbidden'; end if;
  update public.activities a set post_removed = true
   where a.post_id in (select id from public.posts where class_id = p_class);
  delete from public.classes where id = p_class;  -- cascata: membros, publicações, anexos; atividades ficam com post_id nulo
end $$;

-- ---------------------------------------------------------------- publicações
-- Se alguém já adicionou a publicação à própria agenda, ela é apenas ocultada do mural (exclusão lógica),
-- preservando os anexos para quem a adicionou. Caso contrário é apagada de vez e a função devolve os
-- caminhos dos anexos para o cliente removê-los do Storage.
create or replace function public.delete_post(p_post uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_post public.posts; v_paths text[];
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select * into v_post from public.posts where id = p_post;
  if not found or not public.is_member(v_post.class_id) then raise exception 'not_found'; end if;
  if v_post.author_id <> v_uid and not public.is_admin(v_post.class_id) then raise exception 'forbidden'; end if;

  if exists (select 1 from public.activities where post_id = p_post) then
    update public.posts set deleted_at = now() where id = p_post and deleted_at is null;
    update public.activities set post_removed = true where post_id = p_post;
    return jsonb_build_object('mode', 'soft', 'paths', '[]'::jsonb);
  end if;

  select coalesce(array_agg(storage_path), '{}') into v_paths from public.post_files where post_id = p_post;
  delete from public.posts where id = p_post;
  return jsonb_build_object('mode', 'hard', 'paths', to_jsonb(v_paths));
end $$;

-- ---------------------------------------------------------------- publicação -> agenda pessoal
-- Cria uma atividade INDIVIDUAL (própria linha, própria conclusão) a partir da publicação.
create or replace function public.add_post_to_agenda(p_post uuid, p_subject uuid, p_rem jsonb default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  v_post public.posts;
  v_existing uuid;
  v_id uuid;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select * into v_post from public.posts where id = p_post;
  if not found or not public.is_member(v_post.class_id) or v_post.deleted_at is not null then
    raise exception 'post_unavailable';
  end if;
  if p_subject is null or not exists (select 1 from public.subjects where id = p_subject and user_id = v_uid) then
    raise exception 'invalid_subject';
  end if;

  select id into v_existing from public.activities where user_id = v_uid and post_id = p_post;
  if v_existing is not null then
    return jsonb_build_object('id', v_existing, 'already', true);
  end if;

  v_id := gen_random_uuid();
  insert into public.activities (id, user_id, subject_id, title, descr, type, due, priority, status, rem,
                                 post_id, post_snapshot)
  values (v_id, v_uid, p_subject, v_post.title, v_post.descr, 'Atividade', v_post.due, 'mid', 'pending',
          coalesce(p_rem, '{"on":false,"keys":[],"custom":[]}'::jsonb),
          p_post,
          jsonb_build_object('title', v_post.title, 'desc', v_post.descr,
                             'due', to_char(v_post.due, 'YYYY-MM-DD"T"HH24:MI')));
  return jsonb_build_object('id', v_id, 'already', false);
exception when unique_violation then
  select id into v_existing from public.activities where user_id = v_uid and post_id = p_post;
  return jsonb_build_object('id', v_existing, 'already', true);
end $$;

-- ---------------------------------------------------------------- permissões de execução
revoke execute on function public.gen_invite_code(), public.create_class(text, text),
  public.join_class(text, text), public.update_class(uuid, text, boolean),
  public.set_class_password(uuid, text, boolean), public.regenerate_invite_code(uuid),
  public.set_member_role(uuid, uuid, text), public.remove_member(uuid, uuid),
  public.leave_class(uuid), public.delete_class(uuid), public.delete_post(uuid),
  public.add_post_to_agenda(uuid, uuid, jsonb) from public, anon;
grant execute on function public.create_class(text, text), public.join_class(text, text),
  public.update_class(uuid, text, boolean), public.set_class_password(uuid, text, boolean),
  public.regenerate_invite_code(uuid), public.set_member_role(uuid, uuid, text),
  public.remove_member(uuid, uuid), public.leave_class(uuid), public.delete_class(uuid),
  public.delete_post(uuid), public.add_post_to_agenda(uuid, uuid, jsonb) to authenticated;
