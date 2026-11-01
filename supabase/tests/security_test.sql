-- TESTE DE SEGURANÇA (RLS + funções). Rode no SQL Editor do Supabase DEPOIS das 4 migrações.
-- Tudo roda dentro de uma transação que termina em ROLLBACK: nada é gravado de verdade.
-- Resultado esperado: a mensagem final "TODOS OS TESTES PASSARAM". Qualquer falha lança uma exceção
-- com o nome do teste que quebrou.
--
-- ATENÇÃO: este script NÃO foi executado por quem o escreveu (não havia banco disponível). Se algum teste
-- falhar por causa do próprio script (e não da segurança), corrija o teste; se falhar por causa da segurança,
-- NÃO publique o app antes de resolver.

begin;

do $$
declare
  ana  uuid := '00000000-0000-4000-8000-0000000000a1';
  bru  uuid := '00000000-0000-4000-8000-0000000000b2';
  eve  uuid := '00000000-0000-4000-8000-0000000000c3';
  v_class uuid; v_code text; v_res jsonb; v_post uuid := gen_random_uuid();
  v_sub_a uuid := gen_random_uuid(); v_sub_b uuid := gen_random_uuid(); v_act uuid := gen_random_uuid();
  v_act_b uuid; v_n int;
begin
  -- usuários de teste (a trigger cria os perfis)
  insert into auth.users (id, aud, role, email) values
    (ana, 'authenticated', 'authenticated', 'ana.teste@example.com'),
    (bru, 'authenticated', 'authenticated', 'bru.teste@example.com'),
    (eve, 'authenticated', 'authenticated', 'eve.teste@example.com');

  ---------------------------------------------------------------- Ana cria turma e dados
  perform set_config('request.jwt.claims', json_build_object('sub', ana, 'role', 'authenticated')::text, true);
  set local role authenticated;

  v_res := public.create_class('3º Ano A — CESA', 'senha123');
  v_class := (v_res ->> 'id')::uuid; v_code := v_res ->> 'invite_code';
  if v_code !~ '^[A-Z0-9]{8}$' then raise exception 'FALHOU: formato do código de convite'; end if;

  insert into public.subjects (id, user_id, name, color) values (v_sub_a, ana, 'Matemática', '#4f46e5');
  insert into public.activities (id, user_id, subject_id, title, due)
    values (v_act, ana, v_sub_a, 'Lista 1 (pessoal da Ana)', now()::timestamp);

  insert into public.posts (id, class_id, author_id, title, subject_name, due)
    values (v_post, v_class, ana, 'Prova de Matemática', 'Matemática', (now() + interval '3 days')::timestamp);

  ---------------------------------------------------------------- hash da senha é inacessível
  begin
    perform 1 from public.class_secrets;
    raise exception 'FALHOU: class_secrets legível pelo usuário';
  exception when insufficient_privilege then null; end;

  ---------------------------------------------------------------- Bruno (fora da turma)
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', bru, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into v_n from public.activities;
  if v_n <> 0 then raise exception 'FALHOU: Bruno enxerga atividades de outra conta (%)', v_n; end if;
  select count(*) into v_n from public.posts;
  if v_n <> 0 then raise exception 'FALHOU: não-membro enxerga publicações'; end if;
  select count(*) into v_n from public.classes;
  if v_n <> 0 then raise exception 'FALHOU: não-membro enxerga a turma'; end if;

  -- não consegue se inserir como membro/admin direto na tabela
  begin
    insert into public.class_members (class_id, user_id, role) values (v_class, bru, 'admin');
    raise exception 'FALHOU: inserção direta em class_members';
  exception when insufficient_privilege then null; end;

  -- não consegue editar a atividade da Ana (0 linhas afetadas)
  update public.activities set title = 'invadido' where id = v_act;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FALHOU: Bruno alterou atividade da Ana'; end if;

  -- não consegue publicar na turma sem ser membro
  begin
    insert into public.posts (class_id, author_id, title, due) values (v_class, bru, 'x', now()::timestamp);
    raise exception 'FALHOU: publicou sem ser membro';
  exception when insufficient_privilege then null; end;

  ---------------------------------------------------------------- entrada: senha errada, limite, certa
  v_res := public.join_class(v_code, 'errada1');
  if (v_res ->> 'ok')::boolean or v_res ->> 'error' <> 'invalid' then raise exception 'FALHOU: senha errada aceita'; end if;
  v_res := public.join_class('ZZZZZZZZ', 'qualquer');
  if (v_res ->> 'ok')::boolean or v_res ->> 'error' <> 'invalid' then raise exception 'FALHOU: código inexistente deve dar o mesmo erro'; end if;
  perform public.join_class(v_code, 'errada2');
  perform public.join_class(v_code, 'errada3');
  perform public.join_class(v_code, 'errada4');
  v_res := public.join_class(v_code, 'senha123'); -- 5 falhas já registradas: bloqueado mesmo com a senha certa
  if v_res ->> 'error' is distinct from 'rate_limited' then raise exception 'FALHOU: limite de tentativas não bloqueou (%)', v_res; end if;

  -- libera o limite (como superusuário) e entra com a senha certa
  reset role;
  delete from public.join_attempts;
  perform set_config('request.jwt.claims', json_build_object('sub', bru, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_res := public.join_class(v_code, 'senha123');
  if not (v_res ->> 'ok')::boolean then raise exception 'FALHOU: entrada com senha correta (%)', v_res; end if;

  ---------------------------------------------------------------- Bruno, agora membro
  select count(*) into v_n from public.posts;
  if v_n <> 1 then raise exception 'FALHOU: membro não enxerga o mural'; end if;
  select count(*) into v_n from public.activities;
  if v_n <> 0 then raise exception 'FALHOU: membro enxerga atividades pessoais de outro membro'; end if;

  begin
    perform public.set_member_role(v_class, bru, 'admin');
    raise exception 'FALHOU: membro virou admin';
  exception when others then
    if sqlerrm <> 'forbidden' then raise; end if;
  end;
  begin
    perform public.set_class_password(v_class, 'novasenha', true);
    raise exception 'FALHOU: membro trocou a senha da turma';
  exception when others then
    if sqlerrm <> 'forbidden' then raise; end if;
  end;
  begin
    perform public.remove_member(v_class, ana);
    raise exception 'FALHOU: membro removeu o admin';
  exception when others then
    if sqlerrm <> 'forbidden' then raise; end if;
  end;
  begin
    perform public.delete_class(v_class);
    raise exception 'FALHOU: membro excluiu a turma';
  exception when others then
    if sqlerrm <> 'forbidden' then raise; end if;
  end;

  -- não consegue forjar vínculo com publicação inserindo direto
  insert into public.subjects (id, user_id, name, color) values (v_sub_b, bru, 'Matemática', '#22c55e');
  begin
    insert into public.activities (id, user_id, subject_id, title, due, post_id)
      values (gen_random_uuid(), bru, v_sub_b, 'forjada', now()::timestamp, v_post);
    raise exception 'FALHOU: vínculo forjado com publicação';
  exception when others then
    if sqlerrm <> 'forbidden_post_link' then raise; end if;
  end;

  -- não consegue usar a disciplina de outra pessoa
  begin
    insert into public.activities (id, user_id, subject_id, title, due)
      values (gen_random_uuid(), bru, v_sub_a, 'roubada', now()::timestamp);
    raise exception 'FALHOU: usou disciplina de outro usuário';
  exception when insufficient_privilege then null; end;

  ---------------------------------------------------------------- adicionar à agenda: conclusão individual
  v_res := public.add_post_to_agenda(v_post, v_sub_b);
  v_act_b := (v_res ->> 'id')::uuid;
  if (v_res ->> 'already')::boolean then raise exception 'FALHOU: primeira adição marcada como duplicada'; end if;
  v_res := public.add_post_to_agenda(v_post, v_sub_b);
  if not (v_res ->> 'already')::boolean or (v_res ->> 'id')::uuid <> v_act_b then raise exception 'FALHOU: duplicata na agenda'; end if;

  update public.activities set status = 'done', completed_at = now() where id = v_act_b;

  -- Ana adiciona a mesma publicação; a dela continua pendente
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', ana, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.add_post_to_agenda(v_post, v_sub_a);
  select count(*) into v_n from public.activities where post_id = v_post and status = 'pending';
  if v_n <> 1 then raise exception 'FALHOU: conclusão do Bruno afetou a Ana'; end if;

  ---------------------------------------------------------------- Eve (outra turma): isolamento
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', eve, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.create_class('Turma da Eve', 'eve12345');
  select count(*) into v_n from public.posts;
  if v_n <> 0 then raise exception 'FALHOU: isolamento entre turmas (posts)'; end if;
  select count(*) into v_n from public.class_members where class_id = v_class;
  if v_n <> 0 then raise exception 'FALHOU: isolamento entre turmas (membros)'; end if;
  select count(*) into v_n from public.profiles where id in (ana, bru);
  if v_n <> 0 then raise exception 'FALHOU: perfis de quem não é da mesma turma estão visíveis'; end if;

  ---------------------------------------------------------------- excluir publicação preserva a atividade
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', ana, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_res := public.delete_post(v_post);
  if v_res ->> 'mode' <> 'soft' then raise exception 'FALHOU: exclusão deveria ser lógica (há atividades vinculadas)'; end if;
  -- pela RLS a Ana só enxerga a própria atividade vinculada (nunca a do Bruno)
  select count(*) into v_n from public.activities where post_id = v_post and post_removed;
  if v_n <> 1 then raise exception 'FALHOU: Ana deveria enxergar só a própria atividade vinculada (%)', v_n; end if;
  reset role;  -- como superusuário, confere que as DUAS (Ana e Bruno) ficaram marcadas
  select count(*) into v_n from public.activities where post_id = v_post and post_removed;
  if v_n <> 2 then raise exception 'FALHOU: atividades vinculadas deveriam ser marcadas como origem removida'; end if;

  -- sai do mural, mas as atividades continuam
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', bru, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.activities where id = v_act_b and title = 'Prova de Matemática';
  if v_n <> 1 then raise exception 'FALHOU: atividade pessoal sumiu após excluir a publicação'; end if;

  ---------------------------------------------------------------- membro removido perde o acesso
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', ana, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.remove_member(v_class, bru);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', bru, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.posts;
  if v_n <> 0 then raise exception 'FALHOU: membro removido ainda enxerga publicações'; end if;
  select count(*) into v_n from public.activities where id = v_act_b;
  if v_n <> 1 then raise exception 'FALHOU: atividade pessoal do membro removido sumiu'; end if;

  reset role;
  raise notice 'TODOS OS TESTES PASSARAM';
end $$;

rollback;
