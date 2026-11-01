-- Testes da foto de perfil (política de Storage + restrição da coluna). Rodam em transação com ROLLBACK.
-- Resultado esperado: "AVATAR: TODOS OS TESTES PASSARAM".
begin;
create function pg_temp.as_user(u uuid) returns void language plpgsql as $f$
begin reset role; perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true); set local role authenticated; end $f$;
create function pg_temp.expect_err(p_sql text) returns void language plpgsql as $f$
begin begin execute p_sql; exception when others then return; end; raise exception 'FALHOU: deveria falhar: [%]', p_sql; end $f$;
create function pg_temp.n(p_sql text) returns bigint language plpgsql as $f$
declare r bigint; begin execute 'select count(*) from (' || p_sql || ') q' into r; return r; end $f$;

do $$
declare
  ana uuid := '00000000-0000-4000-8000-0000000000a1';
  bru uuid := '00000000-0000-4000-8000-0000000000b2';
  eve uuid := '00000000-0000-4000-8000-0000000000c3';
  v jsonb; cid uuid; code text; pa text; pb text;
begin
  reset role;
  insert into auth.users (id, email, raw_user_meta_data) values
    (ana, 'ana@t.test', '{"name":"Ana"}'), (bru, 'bru@t.test', '{"name":"Bruno"}'), (eve, 'eve@t.test', '{"name":"Eve"}');
  pa := 'a/' || ana || '/foto1'; pb := 'a/' || bru || '/foto1';

  perform pg_temp.as_user(ana);
  v := public.create_class('Turma X', 'senha-123'); cid := (v->>'id')::uuid; code := v->>'invite_code';
  insert into storage.objects (bucket_id, name) values ('files', pa);
  update public.profiles set avatar_path = pa where id = ana;
  -- não pode gravar na pasta de outro, nem apontar o perfil para o arquivo de outro
  perform pg_temp.expect_err('insert into storage.objects (bucket_id, name) values (''files'', ''a/' || bru || '/forjada'')');
  perform pg_temp.expect_err('update public.profiles set avatar_path = ''a/' || bru || '/foto1'' where id = ''' || ana || '''');
  perform pg_temp.expect_err('update public.profiles set avatar_path = ''u/qualquer'' where id = ''' || ana || '''');

  perform pg_temp.as_user(bru);
  insert into storage.objects (bucket_id, name) values ('files', pb);
  -- Bruno ainda não divide turma: não lê a foto da Ana
  if pg_temp.n('select 1 from storage.objects where name = ''' || pa || '''') <> 0 then raise exception 'FALHOU: estranho lê foto'; end if;
  perform public.join_class(code, 'senha-123');
  if pg_temp.n('select 1 from storage.objects where name = ''' || pa || '''') <> 1 then raise exception 'FALHOU: colega não lê foto'; end if;
  if (select avatar_path from public.profiles where id = ana) is distinct from pa then raise exception 'FALHOU: colega não vê avatar_path'; end if;

  perform pg_temp.as_user(eve);
  if pg_temp.n('select 1 from storage.objects where name in (''' || pa || ''', ''' || pb || ''')') <> 0 then raise exception 'FALHOU: Eve lê fotos'; end if;
  if pg_temp.n('select 1 from public.profiles where avatar_path is not null') <> 0 then raise exception 'FALHOU: Eve vê perfis de outras turmas'; end if;
  -- só o dono apaga
  delete from storage.objects where name = pa;
  perform pg_temp.as_user(bru);
  delete from storage.objects where name = pa;
  perform pg_temp.as_user(ana);
  if pg_temp.n('select 1 from storage.objects where name = ''' || pa || '''') <> 1 then raise exception 'FALHOU: outro apagou a foto'; end if;
  delete from storage.objects where name = pa;
  if pg_temp.n('select 1 from storage.objects where name = ''' || pa || '''') <> 0 then raise exception 'FALHOU: dono não apaga a própria foto'; end if;
  -- sai da turma: colega perde acesso à foto
  reset role;
  raise notice 'AVATAR: TODOS OS TESTES PASSARAM';
end $$;
rollback;
