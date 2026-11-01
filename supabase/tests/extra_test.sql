-- TESTES ADICIONAIS DE SEGURANÇA (adversariais). Rodam depois do security_test.sql, em transação com ROLLBACK.
-- Cobrem: acesso anônimo, Storage, administração, forjar vínculos, senha da turma, remoção de membros,
-- exclusão de publicação/turma, conclusão independente e vazamento entre turmas.
-- Resultado esperado: "EXTRA: TODOS OS TESTES PASSARAM".

begin;

create function pg_temp.as_su() returns void language plpgsql as $f$
begin reset role; end $f$;

create function pg_temp.as_user(u uuid) returns void language plpgsql as $f$
begin
  reset role;
  perform set_config('request.jwt.claims', case when u is null then '' else json_build_object('sub', u, 'role', 'authenticated')::text end, true);
  set local role authenticated;
end $f$;

create function pg_temp.as_anon() returns void language plpgsql as $f$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
  set local role anon;
end $f$;

-- executa o SQL e exige que FALHE; p_expect = SQLSTATE ou trecho da mensagem ('' aceita qualquer erro)
create function pg_temp.expect_err(p_sql text, p_expect text) returns void language plpgsql as $f$
begin
  begin
    execute p_sql;
  exception when others then
    if p_expect = '' or sqlstate = p_expect or sqlerrm like '%' || p_expect || '%' then return; end if;
    raise exception 'FALHOU: erro inesperado em [%]: % (%)', p_sql, sqlerrm, sqlstate;
  end;
  raise exception 'FALHOU: deveria ter falhado, mas passou: [%]', p_sql;
end $f$;

create function pg_temp.n(p_sql text) returns bigint language plpgsql as $f$
declare r bigint;
begin execute 'select count(*) from (' || p_sql || ') q' into r; return r; end $f$;

do $$
declare
  ana uuid := '00000000-0000-4000-8000-0000000000a1';
  bru uuid := '00000000-0000-4000-8000-0000000000b2';
  eve uuid := '00000000-0000-4000-8000-0000000000c3';
  dan uuid := '00000000-0000-4000-8000-0000000000d4';
  fer uuid := '00000000-0000-4000-8000-0000000000e5';
  cc uuid; code_c text;
  ca uuid; cb uuid; code_a text; code_b text; new_code text;
  v jsonb; n bigint; t text;
  post1 uuid := gen_random_uuid(); post2 uuid := gen_random_uuid(); post3 uuid := gen_random_uuid();
  s_ana uuid := gen_random_uuid(); s_bru uuid := gen_random_uuid(); s_dan uuid := gen_random_uuid(); s_eve uuid := gen_random_uuid();
  a_ana uuid := gen_random_uuid(); a_bru uuid; a_bru3 uuid; a_dan3 uuid;
  pf1 uuid := gen_random_uuid(); pf2 uuid := gen_random_uuid(); pf3 uuid := gen_random_uuid();
  path1 text; path2 text; path3 text;
begin
  insert into auth.users (id, aud, role, email, raw_user_meta_data) values
    (ana, 'authenticated', 'authenticated', 'ana@x.test', '{"name":"Ana Souza"}'),
    (bru, 'authenticated', 'authenticated', 'bru@x.test', '{"name":"Bruno Lima"}'),
    (eve, 'authenticated', 'authenticated', 'eve@x.test', '{}'),
    (dan, 'authenticated', 'authenticated', 'dan@x.test', '{"name":"   "}'),
    (fer, 'authenticated', 'authenticated', 'fer@x.test', '{"name":"Fernanda"}');

  -- perfil criado automaticamente, com fallback de nome
  if (select display_name from public.profiles where id = ana) <> 'Ana Souza' then raise exception 'FALHOU: nome do perfil (metadata)'; end if;
  if (select display_name from public.profiles where id = eve) <> 'eve' then raise exception 'FALHOU: nome do perfil (fallback e-mail)'; end if;
  if (select display_name from public.profiles where id = dan) <> 'dan' then raise exception 'FALHOU: nome em branco deve cair no e-mail'; end if;

  ------------------------------------------------------------------ 1. anônimo (sem login) não acessa nada
  perform pg_temp.as_anon();
  perform pg_temp.expect_err('select * from public.activities', '42501');
  perform pg_temp.expect_err('select * from public.subjects', '42501');
  perform pg_temp.expect_err('select * from public.files', '42501');
  perform pg_temp.expect_err('select * from public.classes', '42501');
  perform pg_temp.expect_err('select * from public.class_members', '42501');
  perform pg_temp.expect_err('select * from public.posts', '42501');
  perform pg_temp.expect_err('select * from public.post_files', '42501');
  perform pg_temp.expect_err('select * from public.profiles', '42501');
  perform pg_temp.expect_err('select * from public.user_settings', '42501');
  perform pg_temp.expect_err('select * from public.class_secrets', '42501');
  perform pg_temp.expect_err('select * from public.join_attempts', '42501');
  perform pg_temp.expect_err('select public.create_class(''x'', ''abcdef'')', '42501');
  perform pg_temp.expect_err('select public.join_class(''AAAAAAAA'', ''x'')', '42501');
  perform pg_temp.expect_err('select public.add_post_to_agenda(gen_random_uuid(), gen_random_uuid())', '42501');
  perform pg_temp.expect_err('select public.delete_post(gen_random_uuid())', '42501');
  perform pg_temp.expect_err('select public.delete_class(gen_random_uuid())', '42501');
  perform pg_temp.expect_err('select public.is_member(gen_random_uuid())', '42501');
  perform pg_temp.expect_err('select public.gen_invite_code()', '42501');
  perform pg_temp.expect_err('select public.handle_new_user()', '');

  -- autenticado, mas sem "sub" no token => as funções recusam
  perform pg_temp.as_user(null);
  perform pg_temp.expect_err('select public.create_class(''x'', ''abcdef'')', 'not_authenticated');
  perform pg_temp.expect_err('select public.join_class(''AAAAAAAA'', ''x'')', 'not_authenticated');
  perform pg_temp.expect_err('select public.add_post_to_agenda(gen_random_uuid(), gen_random_uuid())', 'not_authenticated');
  if pg_temp.n('select 1 from public.activities') <> 0 then raise exception 'FALHOU: token sem sub enxerga atividades'; end if;

  ------------------------------------------------------------------ 2. turmas e entradas
  perform pg_temp.as_user(ana);
  v := public.create_class('3º Ano A — CESA', 'senha123'); ca := (v ->> 'id')::uuid; code_a := v ->> 'invite_code';
  perform pg_temp.expect_err('select public.create_class('''', ''senha123'')', 'invalid_name');
  perform pg_temp.expect_err('select public.create_class(repeat(''x'', 61), ''senha123'')', 'invalid_name');
  perform pg_temp.expect_err('select public.create_class(''Turma'', ''12345'')', 'invalid_password');
  perform pg_temp.as_user(eve);
  v := public.create_class('Turma B', 'eve12345'); cb := (v ->> 'id')::uuid; code_b := v ->> 'invite_code';
  if code_a = code_b then raise exception 'FALHOU: códigos de convite repetidos'; end if;

  perform pg_temp.as_user(bru); v := public.join_class(lower(substr(code_a, 1, 4)) || ' - ' || substr(code_a, 5), 'senha123'); -- tolera minúsculas, espaço e hífen
  if not (v ->> 'ok')::boolean then raise exception 'FALHOU: entrada com código formatado (%)', v; end if;
  perform pg_temp.as_user(dan); v := public.join_class(code_a, 'senha123');
  if not (v ->> 'ok')::boolean then raise exception 'FALHOU: dan não entrou'; end if;
  v := public.join_class(code_a, 'senha123'); -- entrar de novo não duplica nem eleva cargo
  perform pg_temp.as_su();
  if (select count(*) from public.class_members where class_id = ca) <> 3 then raise exception 'FALHOU: entrada repetida duplicou membro'; end if;
  if (select role from public.class_members where class_id = ca and user_id = dan) <> 'member' then raise exception 'FALHOU: cargo de quem entra deve ser member'; end if;

  -- perfis: visíveis só entre colegas
  perform pg_temp.as_user(bru);
  if pg_temp.n('select 1 from public.profiles where id = ''' || ana || '''') <> 1 then raise exception 'FALHOU: colega de turma não enxergado'; end if;
  if pg_temp.n('select 1 from public.profiles where id = ''' || eve || '''') <> 0 then raise exception 'FALHOU: perfil de quem não é da turma vazou'; end if;
  perform pg_temp.expect_err('insert into public.profiles (id, display_name) values (''' || eve || ''', ''x'')', '42501');
  update public.profiles set display_name = 'hack' where id = ana;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FALHOU: alterou perfil de outro usuário'; end if;

  ------------------------------------------------------------------ 3. permissão de publicar
  perform pg_temp.as_user(ana);
  perform public.update_class(ca, '3º Ano A — CESA', false);
  perform pg_temp.as_user(bru);
  perform pg_temp.expect_err('insert into public.posts (class_id, author_id, title, due) values (''' || ca || ''', ''' || bru || ''', ''x'', now()::timestamp)', '42501');
  perform pg_temp.as_user(ana);
  insert into public.posts (id, class_id, author_id, title, subject_name, due) values (post1, ca, ana, 'Prova de Matemática', 'Matemática', (now() + interval '3 days')::timestamp);
  perform public.update_class(ca, '3º Ano A — CESA', true);

  perform pg_temp.as_user(bru);
  insert into public.posts (id, class_id, author_id, title, due) values (post2, ca, bru, 'Resumo de História', (now() + interval '5 days')::timestamp);
  perform pg_temp.expect_err('insert into public.posts (class_id, author_id, title, due) values (''' || ca || ''', ''' || ana || ''', ''forjada'', now()::timestamp)', '42501');
  perform pg_temp.expect_err('insert into public.posts (class_id, author_id, title, due, deleted_at) values (''' || ca || ''', ''' || bru || ''', ''x'', now()::timestamp, now())', '42501');
  update public.posts set title = 'hack' where id = post1;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FALHOU: membro editou publicação de outro autor'; end if;
  update public.posts set title = 'Resumo de História (editado)' where id = post2;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FALHOU: autor não conseguiu editar a própria publicação'; end if;
  perform pg_temp.expect_err('update public.posts set class_id = ''' || cb || ''' where id = ''' || post2 || '''', '42501');
  perform pg_temp.expect_err('update public.posts set author_id = ''' || ana || ''' where id = ''' || post2 || '''', '42501');
  perform pg_temp.expect_err('update public.posts set deleted_at = now() where id = ''' || post2 || '''', '42501');
  perform pg_temp.expect_err('delete from public.posts where id = ''' || post2 || '''', '42501');   -- só pela função delete_post

  perform pg_temp.as_user(eve);   -- outra turma: não publica nem enxerga nada da turma A
  perform pg_temp.expect_err('insert into public.posts (class_id, author_id, title, due) values (''' || ca || ''', ''' || eve || ''', ''x'', now()::timestamp)', '42501');
  if pg_temp.n('select 1 from public.posts') <> 0 then raise exception 'FALHOU: Eve enxerga publicações da turma A'; end if;
  if pg_temp.n('select 1 from public.classes where id = ''' || ca || '''') <> 0 then raise exception 'FALHOU: Eve enxerga a turma A'; end if;
  if pg_temp.n('select 1 from public.class_members where class_id = ''' || ca || '''') <> 0 then raise exception 'FALHOU: Eve enxerga membros da turma A'; end if;

  ------------------------------------------------------------------ 4. anexos e Storage
  path1 := 'c/' || ca || '/' || post1 || '/' || ana || '/' || pf1;
  path2 := 'c/' || ca || '/' || post2 || '/' || bru || '/' || pf2;
  if (select public from storage.buckets where id = 'files') then raise exception 'FALHOU: bucket público'; end if;

  perform pg_temp.as_user(ana);
  insert into storage.objects (bucket_id, name) values ('files', path1);
  insert into public.post_files (id, post_id, class_id, uploader_id, name, mime, size, storage_path) values (pf1, post1, ca, ana, 'enunciado.pdf', 'application/pdf', 1000, path1);
  perform pg_temp.expect_err('insert into public.post_files (post_id, class_id, uploader_id, name, size, storage_path) values (''' || post1 || ''', ''' || ca || ''', ''' || ana || ''', ''x.pdf'', 10, ''c/qualquer'')', '23514');
  perform pg_temp.expect_err('insert into public.post_files (id, post_id, class_id, uploader_id, name, size, storage_path) values (''' || pf3 || ''', ''' || post1 || ''', ''' || ca || ''', ''' || ana || ''', ''grande.bin'', 99999999, ''c/' || ca || '/' || post1 || '/' || ana || '/' || pf3 || ''')', '23514');

  perform pg_temp.as_user(bru);
  if pg_temp.n('select 1 from storage.objects where name = ''' || path1 || '''') <> 1 then raise exception 'FALHOU: membro não consegue ler anexo da turma'; end if;
  if pg_temp.n('select 1 from public.post_files where id = ''' || pf1 || '''') <> 1 then raise exception 'FALHOU: membro não vê metadados do anexo'; end if;
  perform pg_temp.expect_err('insert into public.post_files (id, post_id, class_id, uploader_id, name, size, storage_path) values (''' || pf3 || ''', ''' || post1 || ''', ''' || ca || ''', ''' || bru || ''', ''x.pdf'', 10, ''c/' || ca || '/' || post1 || '/' || bru || '/' || pf3 || ''')', '42501'); -- não é o autor da publicação
  perform pg_temp.expect_err('insert into storage.objects (bucket_id, name) values (''files'', ''c/' || ca || '/' || post1 || '/' || ana || '/forjado'')', '42501'); -- em nome de outro
  delete from storage.objects where name = path1;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FALHOU: membro apagou anexo de outro'; end if;
  insert into storage.objects (bucket_id, name) values ('files', path2);
  insert into public.post_files (id, post_id, class_id, uploader_id, name, mime, size, storage_path) values (pf2, post2, ca, bru, 'resumo.docx', '', 500, path2);

  perform pg_temp.as_user(eve);
  if pg_temp.n('select 1 from storage.objects where name in (''' || path1 || ''', ''' || path2 || ''')') <> 0 then raise exception 'FALHOU: Eve lê anexos da turma A'; end if;
  if pg_temp.n('select 1 from public.post_files') <> 0 then raise exception 'FALHOU: Eve vê metadados de anexos da turma A'; end if;
  perform pg_temp.expect_err('insert into storage.objects (bucket_id, name) values (''files'', ''c/' || ca || '/' || post1 || '/' || eve || '/x'')', '42501'); -- não é membro
  delete from storage.objects where name = path1; get diagnostics n = row_count;
  if n <> 0 then raise exception 'FALHOU: Eve apagou anexo da turma A'; end if;

  -- arquivos pessoais
  perform pg_temp.as_user(ana);
  insert into storage.objects (bucket_id, name) values ('files', 'u/' || ana || '/privado1');
  perform pg_temp.as_user(bru);
  if pg_temp.n('select 1 from storage.objects where name like ''u/%''') <> 0 then raise exception 'FALHOU: arquivo pessoal de outro visível'; end if;
  perform pg_temp.expect_err('insert into storage.objects (bucket_id, name) values (''files'', ''u/' || ana || '/invasao'')', '42501');
  perform pg_temp.expect_err('insert into storage.objects (bucket_id, name) values (''files'', ''solto.txt'')', '42501');  -- fora da estrutura u/ ou c/
  perform pg_temp.expect_err('insert into storage.objects (bucket_id, name) values (''publico'', ''u/' || bru || '/x'')', '');   -- outro bucket

  -- administrador da turma remove anexo de membro
  perform pg_temp.as_user(ana);
  delete from storage.objects where name = path2; get diagnostics n = row_count;
  if n <> 1 then raise exception 'FALHOU: admin não conseguiu remover anexo de membro'; end if;

  ------------------------------------------------------------------ 5. disciplinas, agenda e conclusão individual
  perform pg_temp.as_user(ana); insert into public.subjects (id, user_id, name, color) values (s_ana, ana, 'Matemática', '#4f46e5');
  perform pg_temp.as_user(bru); insert into public.subjects (id, user_id, name, color) values (s_bru, bru, 'Mat.', '#22c55e');
  perform pg_temp.as_user(dan); insert into public.subjects (id, user_id, name, color) values (s_dan, dan, 'Matemática', '#ef4444');
  perform pg_temp.as_user(eve); insert into public.subjects (id, user_id, name, color) values (s_eve, eve, 'Matemática', '#ef4444');

  perform pg_temp.as_user(ana);
  insert into public.activities (id, user_id, subject_id, title, due) values (a_ana, ana, s_ana, 'Pessoal da Ana', now()::timestamp);
  insert into public.posts (id, class_id, author_id, title, due) values (post3, ca, ana, 'Trabalho de Física', (now() + interval '7 days')::timestamp);
  path3 := 'c/' || ca || '/' || post3 || '/' || ana || '/' || pf3;
  insert into storage.objects (bucket_id, name) values ('files', path3);
  insert into public.post_files (id, post_id, class_id, uploader_id, name, size, storage_path) values (pf3, post3, ca, ana, 'fisica.pdf', 10, path3);

  perform pg_temp.as_user(bru);
  perform pg_temp.expect_err('select public.add_post_to_agenda(''' || post3 || ''', ''' || s_ana || ''')', 'invalid_subject');  -- disciplina de outra pessoa
  perform pg_temp.expect_err('select public.add_post_to_agenda(''' || post3 || ''', null)', 'invalid_subject');
  perform pg_temp.expect_err('select public.add_post_to_agenda(gen_random_uuid(), ''' || s_bru || ''')', 'post_unavailable');
  a_bru3 := (public.add_post_to_agenda(post3, s_bru) ->> 'id')::uuid;
  a_bru := (public.add_post_to_agenda(post1, s_bru) ->> 'id')::uuid;
  perform pg_temp.as_user(dan);
  a_dan3 := (public.add_post_to_agenda(post3, s_dan) ->> 'id')::uuid;
  perform pg_temp.as_user(eve);
  perform pg_temp.expect_err('select public.add_post_to_agenda(''' || post3 || ''', ''' || s_eve || ''')', 'post_unavailable');   -- não é da turma

  -- Bruno conclui; Dan continua pendente
  perform pg_temp.as_user(bru);
  update public.activities set status = 'done', completed_at = now() where id = a_bru3;
  perform pg_temp.as_user(dan);
  if (select status from public.activities where id = a_dan3) <> 'pending' then raise exception 'FALHOU: conclusão do Bruno alterou a atividade do Dan'; end if;
  if pg_temp.n('select 1 from public.activities where id = ''' || a_bru3 || '''') <> 0 then raise exception 'FALHOU: Dan enxerga a atividade do Bruno'; end if;

  ------------------------------------------------------------------ 6. proteção contra forjar dados
  perform pg_temp.as_user(bru);
  perform pg_temp.expect_err('update public.activities set user_id = ''' || ana || ''' where id = ''' || a_bru3 || '''', '42501');
  perform pg_temp.expect_err('update public.activities set post_id = ''' || post2 || ''' where id = ''' || a_bru3 || '''', 'forbidden_post_link');
  perform pg_temp.expect_err('update public.activities set post_id = null where id = ''' || a_bru3 || '''', 'forbidden_post_link');
  perform pg_temp.expect_err('update public.activities set post_removed = true where id = ''' || a_bru3 || '''', 'forbidden_post_link');
  perform pg_temp.expect_err('insert into public.activities (id, user_id, subject_id, title, due, post_removed) values (gen_random_uuid(), ''' || bru || ''', ''' || s_bru || ''', ''x'', now()::timestamp, true)', 'forbidden_post_link');
  perform pg_temp.expect_err('insert into public.activities (id, user_id, subject_id, title, due) values (gen_random_uuid(), ''' || ana || ''', ''' || s_bru || ''', ''em nome da Ana'', now()::timestamp)', '42501');
  perform pg_temp.expect_err('insert into public.activities (id, user_id, subject_id, title, due) values (gen_random_uuid(), ''' || bru || ''', ''' || s_ana || ''', ''disciplina alheia'', now()::timestamp)', '42501');
  perform pg_temp.expect_err('insert into public.files (id, user_id, activity_id, name, size, storage_path) values (''' || gen_random_uuid() || ''', ''' || bru || ''', ''' || a_ana || ''', ''x'', 1, ''u/' || bru || '/x'')', '');
  perform pg_temp.expect_err('insert into public.subjects (id, user_id, name, color) values (gen_random_uuid(), ''' || ana || ''', ''x'', ''#000000'')', '42501');
  perform pg_temp.expect_err('insert into public.subjects (id, user_id, name, color) values (gen_random_uuid(), ''' || bru || ''', ''x'', ''vermelho'')', '23514');
  perform pg_temp.expect_err('update public.class_members set role = ''admin'' where user_id = ''' || bru || '''', '42501');
  perform pg_temp.expect_err('update public.classes set name = ''dominada'' where id = ''' || ca || '''', '42501');
  perform pg_temp.expect_err('select public.set_member_role(''' || ca || ''', ''' || bru || ''', ''admin'')', 'forbidden');
  perform pg_temp.expect_err('select public.regenerate_invite_code(''' || ca || ''')', 'forbidden');
  perform pg_temp.expect_err('select public.update_class(''' || ca || ''', ''x'', true)', 'forbidden');
  perform pg_temp.expect_err('select public.delete_post(''' || post1 || ''')', 'forbidden');                      -- não é o autor nem admin
  perform pg_temp.expect_err('select public.leave_class(''' || cb || ''')', 'not_found');                          -- não é da turma B
  perform pg_temp.expect_err('select public.delete_post(''' || post1 || '''::uuid)', '');
  if pg_temp.n('select 1 from public.activities where user_id <> ''' || bru || '''') <> 0 then raise exception 'FALHOU: Bruno enxerga atividades de outros'; end if;

  -- adicionar duas vezes não duplica
  if (public.add_post_to_agenda(post3, s_bru) ->> 'already')::boolean is not true then raise exception 'FALHOU: duplicata na agenda'; end if;
  perform pg_temp.as_su();
  if (select count(*) from public.activities where user_id = bru and post_id = post3) <> 1 then raise exception 'FALHOU: atividade duplicada no banco'; end if;

  ------------------------------------------------------------------ 7. exclusão de publicação: lógica x definitiva
  perform pg_temp.as_user(ana);
  v := public.delete_post(post1);   -- Bruno adicionou => exclusão lógica
  if v ->> 'mode' <> 'soft' then raise exception 'FALHOU: delete_post deveria ser lógico'; end if;
  perform pg_temp.as_user(bru);     -- continua lendo (adicionou à agenda)
  if pg_temp.n('select 1 from public.posts where id = ''' || post1 || '''') <> 1 then raise exception 'FALHOU: Bruno perdeu a publicação que adicionou'; end if;
  if pg_temp.n('select 1 from storage.objects where name = ''' || path1 || '''') <> 1 then raise exception 'FALHOU: Bruno perdeu o anexo da publicação que adicionou'; end if;
  perform pg_temp.as_user(dan);     -- não adicionou => não enxerga mais
  if pg_temp.n('select 1 from public.posts where id = ''' || post1 || '''') <> 0 then raise exception 'FALHOU: publicação excluída ainda aparece no mural'; end if;
  if pg_temp.n('select 1 from storage.objects where name = ''' || path1 || '''') <> 0 then raise exception 'FALHOU: anexo de publicação excluída ainda legível'; end if;
  perform pg_temp.expect_err('select public.add_post_to_agenda(''' || post1 || ''', ''' || s_dan || ''')', 'post_unavailable');

  perform pg_temp.as_user(bru);     -- exclusão definitiva: devolve os caminhos para o cliente apagar do Storage
  v := public.delete_post(post2);
  if v ->> 'mode' <> 'hard' or (v -> 'paths' ->> 0) <> path2 then raise exception 'FALHOU: exclusão definitiva (%)', v; end if;
  perform pg_temp.as_su();
  if exists (select 1 from public.post_files where post_id = post2) then raise exception 'FALHOU: metadados de anexo sobraram'; end if;

  ------------------------------------------------------------------ 8. administração
  perform pg_temp.as_user(ana);
  perform public.set_member_role(ca, dan, 'admin');
  perform public.set_member_role(ca, ana, 'member');            -- Dan segue como admin
  perform pg_temp.as_user(dan);
  perform pg_temp.expect_err('select public.set_member_role(''' || ca || ''', ''' || dan || ''', ''member'')', 'last_admin');
  perform pg_temp.expect_err('select public.set_member_role(''' || ca || ''', ''' || dan || ''', ''chefe'')', 'invalid_role');
  perform pg_temp.expect_err('select public.leave_class(''' || ca || ''')', 'last_admin');
  perform public.set_member_role(ca, ana, 'admin');
  perform pg_temp.expect_err('select public.remove_member(''' || ca || ''', ''' || ana || ''')', 'target_is_admin');
  perform pg_temp.expect_err('select public.remove_member(''' || ca || ''', ''' || dan || ''')', 'use_leave_class');
  perform pg_temp.as_user(ana);
  perform public.set_member_role(ca, dan, 'member');
  perform pg_temp.expect_err('select public.leave_class(''' || ca || ''')', 'last_admin');     -- há membros e ela é a única admin

  ------------------------------------------------------------------ 9. senha da turma
  perform pg_temp.as_user(ana);
  perform public.set_class_password(ca, 'nova1234', false);
  perform pg_temp.expect_err('select public.set_class_password(''' || ca || ''', ''curta'', false)', 'invalid_password');
  perform pg_temp.as_su();
  if (select count(*) from public.class_members where class_id = ca) <> 3 then raise exception 'FALHOU: trocar a senha expulsou membros'; end if;
  select password_hash into t from public.class_secrets where class_id = ca;
  if t !~ '^\$2[aby]\$' or t like '%nova1234%' then raise exception 'FALHOU: a senha da turma deve estar em hash bcrypt'; end if;

  perform pg_temp.as_user(eve);                                  -- Eve (admin da turma B) tenta entrar na A
  v := public.join_class(code_a, 'senha123');
  if (v ->> 'ok')::boolean or v ->> 'error' <> 'invalid' then raise exception 'FALHOU: senha antiga ainda vale (%)', v; end if;
  v := public.join_class(code_a, 'nova1234');
  if not (v ->> 'ok')::boolean then raise exception 'FALHOU: senha nova não funciona (%)', v; end if;
  if pg_temp.n('select 1 from public.class_members where user_id = ''' || eve || '''') <> 2 then raise exception 'FALHOU: Eve deveria estar em 2 turmas'; end if;
  if pg_temp.n('select 1 from public.posts where class_id = ''' || cb || '''') <> 0 then raise exception 'FALHOU: mural da turma B deveria estar vazio'; end if;
  -- no mural da A só a publicação 3 está viva para quem não a adicionou (post1 foi excluída, post2 apagada)
  if pg_temp.n('select 1 from public.posts where class_id = ''' || ca || '''') <> 1 then raise exception 'FALHOU: mural da turma A para a Eve'; end if;

  ------------------------------------------------------------------ 10. código de convite
  perform pg_temp.as_user(ana);
  new_code := public.regenerate_invite_code(ca);
  if new_code = code_a or new_code !~ '^[A-Z0-9]{8}$' then raise exception 'FALHOU: novo código de convite'; end if;
  perform pg_temp.as_user(fer);
  v := public.join_class(code_a, 'nova1234');
  if (v ->> 'ok')::boolean then raise exception 'FALHOU: código antigo ainda entra'; end if;
  v := public.join_class(new_code, 'nova1234');
  if not (v ->> 'ok')::boolean then raise exception 'FALHOU: código novo não entra (%)', v; end if;

  ------------------------------------------------------------------ 11. trocar a senha EXPULSANDO membros
  perform pg_temp.as_user(ana);
  perform public.set_class_password(ca, 'outra1234', true);
  perform pg_temp.as_su();
  if (select count(*) from public.class_members where class_id = ca) <> 1 then raise exception 'FALHOU: só a administradora deveria restar'; end if;
  if (select count(*) from public.activities where id in (a_bru3, a_dan3) and post_removed) <> 2 then raise exception 'FALHOU: atividades dos removidos deveriam ficar com "origem removida"'; end if;
  perform pg_temp.as_user(bru);                                  -- removido: perde mural e anexos, mantém a atividade
  if pg_temp.n('select 1 from public.posts') <> 0 then raise exception 'FALHOU: removido ainda vê publicações'; end if;
  if pg_temp.n('select 1 from storage.objects where name = ''' || path3 || '''') <> 0 then raise exception 'FALHOU: removido ainda lê anexos da turma'; end if;
  if pg_temp.n('select 1 from public.activities where id = ''' || a_bru3 || '''') <> 1 then raise exception 'FALHOU: atividade do removido sumiu'; end if;
  perform pg_temp.expect_err('select public.update_class(''' || ca || ''', ''x'', true)', 'forbidden');
  v := public.join_class(new_code, 'outra1234');                 -- volta à turma: recupera o vínculo da publicação viva
  if not (v ->> 'ok')::boolean then raise exception 'FALHOU: reentrada (%)', v; end if;
  perform pg_temp.as_su();
  if (select post_removed from public.activities where id = a_bru3) then raise exception 'FALHOU: vínculo não foi restaurado na reentrada'; end if;
  if not (select post_removed from public.activities where id = a_bru) then raise exception 'FALHOU: publicação excluída não pode voltar'; end if;

  ------------------------------------------------------------------ 12. excluir a turma preserva as atividades pessoais
  perform pg_temp.as_user(bru);
  perform pg_temp.expect_err('select public.delete_class(''' || ca || ''')', 'forbidden');
  perform pg_temp.as_user(ana);
  perform public.delete_class(ca);
  perform pg_temp.as_su();
  if exists (select 1 from public.classes where id = ca) then raise exception 'FALHOU: turma não foi excluída'; end if;
  if exists (select 1 from public.posts where class_id = ca) then raise exception 'FALHOU: publicações da turma sobraram'; end if;
  if not exists (select 1 from public.activities where id = a_bru3 and post_id is null and post_removed) then raise exception 'FALHOU: atividade do Bruno deveria permanecer, sem vínculo'; end if;
  if not exists (select 1 from public.activities where id = a_dan3) then raise exception 'FALHOU: atividade do Dan sumiu'; end if;
  if not exists (select 1 from public.activities where id = a_ana) then raise exception 'FALHOU: atividade pessoal da Ana sumiu'; end if;
  perform pg_temp.as_user(bru);
  if (select title from public.activities where id = a_bru3) <> 'Trabalho de Física' then raise exception 'FALHOU: Bruno não lê a própria atividade após a exclusão da turma'; end if;
  perform pg_temp.as_user(fer);
  v := public.join_class(new_code, 'outra1234');
  if (v ->> 'ok')::boolean then raise exception 'FALHOU: entrou numa turma excluída'; end if;

  ------------------------------------------------------------------ 13. último membro que sai encerra a turma
  perform pg_temp.as_user(eve);
  perform public.leave_class(cb);
  perform pg_temp.as_su();
  if exists (select 1 from public.classes where id = cb) then raise exception 'FALHOU: turma sem membros deveria ser encerrada'; end if;

  ------------------------------------------------------------------ 14. limite de tentativas por código (muitas contas tentando o mesmo código)
  perform pg_temp.as_user(ana);
  v := public.create_class('Turma C', 'cccc1111'); cc := (v ->> 'id')::uuid; code_c := v ->> 'invite_code';
  perform pg_temp.as_su();
  insert into public.join_attempts (user_id, code) select gen_random_uuid(), code_c from generate_series(1, 30);
  perform pg_temp.as_user(bru);
  v := public.join_class(code_c, 'cccc1111');
  if v ->> 'error' is distinct from 'rate_limited' then raise exception 'FALHOU: limite por código não bloqueou (%)', v; end if;
  perform pg_temp.expect_err('select * from public.join_attempts', '42501');

  perform pg_temp.as_su();
  raise notice 'EXTRA: TODOS OS TESTES PASSARAM';
end $$;

rollback;
