# Configuração: Supabase + Netlify

O app precisa de um projeto Supabase (contas, banco, arquivos). **Nada disso foi criado por mim**: você cria o projeto na sua conta e cola só a chave pública (anon). Nunca me passe sua senha do Supabase/Netlify e nunca coloque a chave `service_role` no app.

## 1. Criar o projeto no Supabase
1. https://supabase.com › New project (anote a região e a senha do banco; ela não vai para o app).
2. **Project Settings › API**: copie **Project URL** e a chave **anon / publishable**. (A `service_role` é secreta: não use.)

## 2. Rodar as migrações (SQL Editor, nesta ordem; a 5ª só é necessária para a foto de perfil)
1. `supabase/migrations/20261029000001_schema.sql`
2. `supabase/migrations/20261029000002_rls.sql` (RLS, travas e privilégios)
3. `supabase/migrations/20261029000003_functions.sql` (funções: criar/entrar na turma, agenda etc.)
4. `supabase/migrations/20261029000004_storage_realtime.sql` (bucket privado `files` + políticas + Realtime)
5. `supabase/migrations/20261101000005_avatars.sql` (foto de perfil: coluna `avatar_path` + políticas do Storage)

Cada arquivo deve terminar sem erro. Depois confira em **Storage** que o bucket `files` existe e está **privado**, e em **Database › Replication** que as tabelas aparecem em `supabase_realtime`.

## 3. Autenticação
**Authentication › Providers › Email**: ativado. Para exigir confirmação de e-mail, deixe "Confirm email" ligado (o app já trata os dois casos).
**Authentication › URL Configuration**:
- *Site URL*: o endereço do seu site no Netlify (ex.: `https://seu-site.netlify.app`).
- *Redirect URLs*: o mesmo endereço (e `https://seu-site.netlify.app/**`; adicione seu domínio próprio, se tiver).
Sem isso os links de confirmação e de recuperação de senha não funcionam.
O envio de e-mails padrão do Supabase tem limite baixo por hora; para uso real configure um SMTP próprio (Authentication › SMTP).

## 4. Netlify
Em **Site configuration › Environment variables** crie:
- `SUPABASE_URL` = Project URL
- `SUPABASE_ANON_KEY` = chave anon/publishable

Publique de novo (o comando de build `node scripts/make-config.mjs` grava `www/config.js`; ele recusa a chave `service_role`). Não são necessárias funções serverless.

## 5. Verificação (faça depois de publicar)
- [ ] Cadastro, e-mail de confirmação chega e o link abre o app logado.
- [ ] "Esqueci minha senha": e-mail chega, link abre "Nova senha".
- [ ] Criar turma em um aparelho, entrar em outro com código + senha.
- [ ] Anexo em publicação baixa pelo outro usuário; sem login o link do arquivo não abre.
- [ ] Edição em um aparelho aparece no outro (Realtime ativo).
- [ ] Rode `supabase/tests/security_test.sql` e `extra_test.sql` no SQL Editor de um projeto de TESTE (eles criam usuários fictícios; não rode no projeto com dados reais).

## Migração dos dados antigos
Ao entrar pela primeira vez num aparelho que já tinha dados locais, o app oferece importá-los. Nada local é apagado até você confirmar; o botão fica em Perfil › Importar dados deste aparelho.
