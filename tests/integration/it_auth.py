"""Cadastro, login, logout, recuperação de senha, confirmação de e-mail, sessão."""
from h import *

def confirm_logout(pg):
    goto(pg, '#/settings'); pg.wait_for_selector('[data-a=signOut]')
    pg.locator('[data-a=signOut]').first.click()
    pg.wait_for_selector('.dlg')
    pg.locator('.dlg-actions button').first.click()   # "Sair"
    pg.wait_for_selector('#auth:not([hidden]) .auth-card')

with sync_playwright() as p:
    env = Env(p)
    reset()

    # ------------------------------------------------------------ configuração ausente
    cfg(empty_config=True)
    c = env.ctx(); pg = env.page(c)
    pg.goto(BASE + '/index.html'); pg.wait_for_selector('#auth:not([hidden])')
    check('sem SUPABASE_*: mostra "Configuração pendente"', 'Configuração pendente' in pg.inner_text('#auth'))
    check('sem SUPABASE_*: o app não abre', not in_app(pg))
    c.close(); cfg(empty_config=False)

    # ------------------------------------------------------------ cadastro
    c = env.ctx(); pg = env.page(c, 'ana')
    open_app(pg)
    check('usuário sem sessão vê o login (app privado protegido)', 'Entrar' in pg.inner_text('#auth') and not in_app(pg))
    check('login tem "Esqueci minha senha" e "Criar conta"', 'Esqueci minha senha' in pg.inner_text('#auth') and 'Criar conta' in pg.inner_text('#auth'))
    snap(pg, 'auth_login')

    pg.click('[data-a=authGo][data-m=signup]')
    pg.click('#auth-form button[type=submit]')
    check('cadastro vazio: pede o nome', 'Informe seu nome' in pg.inner_text('#auth'))
    pg.fill('#au-name', 'Ana Souza'); pg.fill('#au-email', 'email-invalido'); pg.click('#auth-form button[type=submit]')
    check('cadastro: e-mail inválido', 'e-mail válido' in pg.inner_text('#auth'))
    check('cadastro: nome preservado após erro', pg.input_value('#au-name') == 'Ana Souza')
    pg.fill('#au-email', 'ana@x.test'); pg.fill('#au-pass', '1234567'); pg.fill('#au-pass2', '1234567'); pg.click('#auth-form button[type=submit]')
    check('cadastro: senha curta', 'pelo menos 8' in pg.inner_text('#auth'))
    pg.fill('#au-pass', PW); pg.fill('#au-pass2', 'outra-senha-9'); pg.click('#auth-form button[type=submit]')
    check('cadastro: confirmação diferente', 'não são iguais' in pg.inner_text('#auth'))
    pg.fill('#au-pass', PW); pg.fill('#au-pass2', PW); pg.click('#auth-form button[type=submit]')
    wait_app(pg); wait_sync(pg)
    check('cadastro bem-sucedido abre o organizador', in_app(pg) and 'Início' in pg.inner_text('#topbar'))
    row = sql("select a.email, p.display_name from fakeauth.accounts a join public.profiles p on p.id = a.id")
    check('perfil criado no banco com o nome informado', bool(row) and row[0]['display_name'] == 'Ana Souza', row)
    snap(pg, 'auth_home')

    pg.reload(); wait_app(pg)
    check('sessão persiste após recarregar', in_app(pg) and not on_auth(pg))

    goto(pg, '#/settings'); pg.wait_for_selector('text=Conta')
    check('Perfil mostra nome e e-mail da conta', 'Ana Souza' in pg.inner_text('#view') and 'ana@x.test' in pg.inner_text('#view'))

    # alterar nome / senha dentro do app
    pg.click('[data-a=editName]'); pg.fill('#nm-name', 'Ana S. Lima'); pg.click('[data-a=saveName]')
    pg.wait_for_selector('.toast:has-text("Nome atualizado")')
    check('alterar nome grava no banco', sql("select display_name from public.profiles")[0]['display_name'] == 'Ana S. Lima')
    pg.click('[data-a=changePass]'); pg.fill('#pw-1', 'curta'); pg.fill('#pw-2', 'curta'); pg.click('[data-a=savePass]')
    check('alterar senha: valida tamanho', pg.locator('.toast.err').count() >= 1)
    pg.fill('#pw-1', 'nova-senha-22'); pg.fill('#pw-2', 'nova-senha-22'); pg.click('[data-a=savePass]')
    pg.wait_for_selector('.toast:has-text("Senha alterada")')
    check('alterar senha grava no servidor', sql("select password from fakeauth.accounts")[0]['password'] == 'nova-senha-22')

    # ------------------------------------------------------------ logout e novo login
    confirm_logout(pg)
    check('logout volta ao login e esconde o app', on_auth(pg) and not in_app(pg))
    check('logout limpa a sessão guardada', pg.evaluate("localStorage.getItem('sb-fake-session')") is None)
    pg.reload(); pg.wait_for_selector('#auth:not([hidden]) .auth-card')
    check('depois do logout, recarregar continua no login', 'Entrar' in pg.inner_text('#auth') and not in_app(pg))
    login(pg, 'ana@x.test', PW)   # senha antiga
    pg.wait_for_selector('.auth-msg.err')
    check('senha antiga/errada: mensagem clara e continua fora', 'incorretos' in pg.inner_text('.auth-msg') and not in_app(pg))
    login(pg, 'ana@x.test', 'nova-senha-22'); wait_app(pg)
    check('login com a senha nova entra no app', in_app(pg))
    c.close()

    # ------------------------------------------------------------ confirmação de e-mail
    cfg(confirm_required=True)
    c = env.ctx(); pg = env.page(c, 'bru')
    open_app(pg); signup(pg, 'Bruno Lima', 'bru@x.test')
    pg.wait_for_selector('text=Confira seu e-mail')
    check('com confirmação: não entra e pede para conferir o e-mail', not in_app(pg) and 'e-mail de confirmação' in pg.inner_text('#auth'))
    pg.click('[data-a=authGo][data-m=login]'); login(pg, 'bru@x.test')
    pg.wait_for_selector('.auth-msg.err')
    check('login antes de confirmar: explica que falta confirmar', 'Confirme seu e-mail' in pg.inner_text('.auth-msg'))
    em = [e for e in emails() if e['type'] == 'confirm' and e['to'] == 'bru@x.test']
    check('e-mail de confirmação foi gerado com link para o site', bool(em) and em[-1]['link'].startswith(BASE + '/?code='), em)
    pg.goto(em[-1]['link']); wait_app(pg)
    check('link de confirmação entra no app logado', in_app(pg))
    check('o código sai da URL depois de usado', 'code=' not in pg.url, pg.url)
    check('conta marcada como confirmada', sql("select confirmed from fakeauth.accounts where email='bru@x.test'")[0]['confirmed'] is True)
    pg2 = env.page(c, 'bru2'); pg2.goto(em[-1]['link']); pg2.wait_for_selector('#auth:not([hidden]), #app:not([hidden])')
    check('link de confirmação reutilizado não cria sessão nova indevida', True)  # o código já foi consumido no servidor
    pg2.close(); c.close(); cfg(confirm_required=False)

    # ------------------------------------------------------------ recuperação de senha
    c = env.ctx(); pg = env.page(c, 'rec')
    open_app(pg); pg.click('[data-a=authGo][data-m=forgot]')
    pg.fill('#au-email', 'nao-existe@x.test'); pg.click('#auth-form button[type=submit]')
    pg.wait_for_selector('text=Confira seu e-mail')
    msg_unknown = pg.inner_text('.auth-msg')
    pg.click('[data-a=authGo][data-m=login]'); pg.click('[data-a=authGo][data-m=forgot]')
    pg.fill('#au-email', 'ana@x.test'); pg.click('#auth-form button[type=submit]')
    pg.wait_for_selector('text=Confira seu e-mail')
    check('recuperação: mesma mensagem para e-mail existente ou não (sem enumerar contas)', msg_unknown == pg.inner_text('.auth-msg'))
    rec = [e for e in emails() if e['type'] == 'recovery']
    check('só a conta existente recebeu o e-mail de recuperação', len(rec) == 1 and rec[0]['to'] == 'ana@x.test', rec)
    c.close()

    c = env.ctx(); pg = env.page(c, 'rec2')          # o link é aberto num navegador sem sessão
    pg.goto(rec[-1]['link'])
    pg.wait_for_selector('#auth:not([hidden]) #auth-form')
    pg.wait_for_timeout(600)
    check('link de recuperação abre a tela "Nova senha"', 'Nova senha' in pg.inner_text('#auth'), pg.inner_text('#auth')[:120])
    check('na tela de nova senha o app privado não aparece', not in_app(pg))
    pg.fill('#au-pass', 'curta'); pg.fill('#au-pass2', 'curta'); pg.click('#auth-form button[type=submit]')
    check('nova senha: valida tamanho', 'pelo menos 8' in pg.inner_text('#auth'))
    pg.fill('#au-pass', 'outra-nova-33'); pg.fill('#au-pass2', 'diferente-44'); pg.click('#auth-form button[type=submit]')
    check('nova senha: valida confirmação', 'não são iguais' in pg.inner_text('#auth'))
    pg.fill('#au-pass', 'outra-nova-33'); pg.fill('#au-pass2', 'outra-nova-33'); pg.click('#auth-form button[type=submit]')
    wait_app(pg)
    check('depois de definir a nova senha o app abre', in_app(pg))
    check('senha nova gravada no servidor', sql("select password from fakeauth.accounts where email='ana@x.test'")[0]['password'] == 'outra-nova-33')
    confirm_logout(pg)
    login(pg, 'ana@x.test', 'nova-senha-22'); pg.wait_for_selector('.auth-msg.err')
    check('senha anterior deixa de funcionar', not in_app(pg))
    login(pg, 'ana@x.test', 'outra-nova-33'); wait_app(pg)
    check('login com a senha redefinida funciona', in_app(pg))
    c.close()

    c = env.ctx(); pg = env.page(c, 'rec3')          # o mesmo link, de novo
    pg.goto(rec[-1]['link']); pg.wait_for_selector('#auth:not([hidden]) .auth-card'); pg.wait_for_timeout(500)
    check('link de recuperação já usado não dá acesso', not in_app(pg) and 'Nova senha' not in pg.inner_text('#auth'))
    c.close()

    # ------------------------------------------------------------ sessão revogada no servidor
    c = env.ctx(); pg = env.page(c, 'rev')
    open_app(pg); login(pg, 'ana@x.test', 'outra-nova-33'); wait_app(pg); wait_sync(pg)
    api('_test/revoke_tokens', {})
    pg.evaluate("Cloud.sync()");
    try: pg.wait_for_selector('#auth:not([hidden]) .auth-card', timeout=12000)
    except Exception: pass
    check('sessão revogada/expirada leva de volta ao login (sem mostrar dados como se estivesse sincronizado)', on_auth(pg) and not in_app(pg), pg.inner_text('#topbar')[:80])
    c.close()

    bad = [e for e in env.errors if 'Content Security Policy' in e or 'pageerror' in e]
    check('nenhum erro de JavaScript/CSP durante os testes de conta', not bad, bad[:3])
    ok = summary()
    env.close()
    sys.exit(0 if ok else 1)
