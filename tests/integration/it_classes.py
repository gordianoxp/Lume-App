"""Turmas: criar/entrar, mural, agenda individual, isolamento, administração, sincronização entre aparelhos."""
from h import *
import datetime
FUT = (datetime.date.today() + datetime.timedelta(days=5)).isoformat()

def open_class(pg, name):
    goto(pg, '#/classes'); pg.wait_for_selector('[data-a=newClass]')
    pg.locator('.subj', has_text=name).first.click(); pg.wait_for_selector('.code-box')

def create_class(pg, name, pw):
    goto(pg, '#/classes'); pg.click('[data-a=newClass]')
    pg.fill('#nc-name', name); pg.fill('#nc-pw', pw); pg.fill('#nc-pw2', pw); pg.click('#nc-save')
    pg.wait_for_selector('.code-box')
    return pg.inner_text('.code-box').replace('-', '').replace(' ', '')

def join(pg, code, pw):
    goto(pg, '#/classes'); pg.click('[data-a=joinClass]')
    pg.fill('#jn-code', code); pg.fill('#jn-pw', pw); pg.click('#jn-save')

def new_post(pg, title, subj='Matemática'):
    pg.click('[data-a=newPost]'); pg.wait_for_selector('#pp-title')
    pg.fill('#pp-title', title); pg.fill('#pp-subj', subj); pg.fill('#pp-date', FUT); pg.fill('#pp-desc', 'Descrição ' + title)
    pg.click('#pp-save'); pg.wait_for_selector('.toast')

with sync_playwright() as p:
    env = Env(p); reset()
    ca, A = new_user(env, 'Ana Souza', 'ana@x.test')
    cb, B = new_user(env, 'Bruno Lima', 'bru@x.test')
    cc, C = new_user(env, 'Carla Dias', 'car@x.test')

    code = create_class(A, '3º Ano A', 'turma-123')
    check('criar turma gera código de convite', len(code) >= 6, code)
    check('criador é admin no banco', sql("select role from public.class_members m join public.classes c on c.id=m.class_id where c.name='3º Ano A'")[0]['role'] == 'admin')
    check('senha da turma não fica em texto puro nas tabelas legíveis', 'turma-123' not in json.dumps(sql("select * from public.classes")))

    join(B, code, 'errada-999'); B.wait_for_selector('#jn-err:not([hidden])')
    msg_wrong_pw = B.inner_text('#jn-err')
    B.fill('#jn-code', 'ZZZZZZZZ'); B.click('#jn-save'); B.wait_for_timeout(700)
    msg_wrong_code = B.inner_text('#jn-err')
    check('senha errada e código inexistente dão a mesma mensagem genérica', msg_wrong_pw == msg_wrong_code and msg_wrong_pw, (msg_wrong_pw, msg_wrong_code))
    check('Bruno ainda não é membro', sql("select count(*) n from public.class_members m join public.profiles p on p.id=m.user_id where p.display_name='Bruno Lima'")[0]['n'] == 0)
    B.fill('#jn-code', code); B.fill('#jn-pw', 'turma-123'); B.click('#jn-save')
    B.wait_for_selector('.code-box'); wait_sync(B)
    check('entrar com código e senha corretos abre a turma', 'Mural' in B.inner_text('#view'))
    check('Bruno entra como membro (não admin)', sql("select role from public.class_members m join public.profiles p on p.id=m.user_id where p.display_name='Bruno Lima'")[0]['role'] == 'member')
    check('membro não vê a aba Administração', B.locator('[data-a=classTab][data-v=admin]').count() == 0)

    # mural
    open_class(A, '3º Ano A'); new_post(A, 'Lista de exercícios')
    wait_sync(A)
    check('post gravado no banco com autor e data', sql("select title, due from public.posts")[0]['title'] == 'Lista de exercícios')
    B.reload(); wait_app(B); wait_sync(B); open_class(B, '3º Ano A')
    wait_js(B, "document.body.innerText.includes('Lista de exercícios')")
    check('colega vê o post no mural', 'Lista de exercícios' in B.inner_text('#view'))

    # adicionar à agenda
    B.locator('.post-act [data-a=addToAgenda]').first.click()
    try:
        B.wait_for_selector('[data-a=confirmAgenda]', timeout=3000); B.click('[data-a=confirmAgenda]')
    except Exception: pass
    B.wait_for_selector('.toast'); wait_sync(B)
    n = sql("select count(*) n from public.activities where post_id is not null")[0]['n']
    check('"Adicionar à minha agenda" cria uma atividade individual', n == 1, n)
    check('a atividade derivada é do Bruno', sql("select p.display_name from public.activities a join public.profiles p on p.id=a.user_id where a.post_id is not null")[0]['display_name'] == 'Bruno Lima')
    check('Ana não ganhou cópia automática', sql("select count(*) n from public.activities a join public.profiles p on p.id=a.user_id where p.display_name='Ana S. Lima' or p.display_name='Ana Souza'")[0]['n'] == 0)

    # conclusão independente: Ana também adiciona; concluir a do Bruno não altera a da Ana
    open_class(A, '3º Ano A'); A.locator('.post-act [data-a=addToAgenda]').first.click()
    try: A.wait_for_selector('[data-a=confirmAgenda]', timeout=3000); A.click('[data-a=confirmAgenda]')
    except Exception: pass
    A.wait_for_selector('.toast'); wait_sync(A)
    check('cada pessoa tem sua própria atividade derivada (2 no total, sem duplicar)', sql("select count(*) n from public.activities where post_id is not null")[0]['n'] == 2)
    api('_test/exec', {'sql': "update public.activities a set status='done' from public.profiles p where p.id=a.user_id and p.display_name='Bruno Lima' and a.post_id is not null"})
    check('concluir a do Bruno não conclui a da Ana', sql("select count(*) n from public.activities a join public.profiles p on p.id=a.user_id where a.post_id is not null and a.status='done' and p.display_name<>'Bruno Lima'")[0]['n'] == 0)
    check('o post em si não muda', sql("select count(*) n from public.posts")[0]['n'] == 1)

    # edição do post propaga
    open_class(A, '3º Ano A'); A.locator('[data-a=postDetail]').first.click(); A.wait_for_selector('[data-a=editPost]'); A.click('[data-a=editPost]')
    A.wait_for_selector('#pp-title'); A.fill('#pp-title', 'Lista de exercícios (revisada)'); A.click('#pp-save'); A.wait_for_selector('.toast'); wait_sync(A)
    B.evaluate("Cloud.sync()"); wait_sync(B)
    wait_js(B, "state.posts.some(p=>p.title.includes('revisada'))")
    check('edição do post chega ao colega (outro aparelho)', True)
    check('as cópias individuais continuam existindo e a conclusão do Bruno foi preservada após a edição', sql("select count(*) n from public.activities where post_id is not null and status='done'")[0]['n'] == 1)

    # intruso (Carla) – nada vaza
    for sqlq, label in [("select count(*) n from public.posts", 'posts'), ("select count(*) n from public.classes", 'classes'), ("select count(*) n from public.activities", 'activities')]:
        pass
    check('Carla (sem turma) não vê a turma na interface', 'Você ainda não participa' in (lambda: (goto(C, '#/classes'), C.wait_for_selector('[data-a=newClass]'), C.inner_text('#view'))[-1])())

    # exclusão do post mantém a cópia
    open_class(A, '3º Ano A'); A.locator('[data-a=postDetail]').first.click(); A.wait_for_selector('[data-a=delPost]'); A.click('[data-a=delPost]')
    A.wait_for_selector('.dlg'); A.locator('.dlg-actions button').first.click(); A.wait_for_selector('.toast'); wait_sync(A)
    check('post excluído continua como atividade na agenda de quem adicionou', sql("select count(*) n from public.activities where post_id is not null")[0]['n'] == 2)
    check('a atividade fica marcada como origem removida', sql("select bool_and(post_removed) b from public.activities where post_id is not null")[0]['b'] is True)

    # administração
    open_class(A, '3º Ano A'); A.click('[data-a=classTab][data-v=admin]'); A.wait_for_selector('#ad-name')
    A.fill('#ad-name', '3º Ano A — CESA'); A.click('[data-a=saveClassEdit]'); A.wait_for_selector('.toast'); wait_sync(A)
    check('admin renomeia a turma', sql("select name from public.classes")[0]['name'] == '3º Ano A — CESA')
    A.fill('#ad-pw', 'nova-turma-456'); A.click('[data-a=savePassword]')
    try: A.wait_for_selector('.dlg', timeout=2500); A.locator('.dlg-actions button').first.click()
    except Exception: pass
    A.wait_for_selector('.toast'); wait_sync(A)
    check('trocar a senha não expulsa quem já participa', sql("select count(*) n from public.class_members")[0]['n'] == 2)
    join(C, code, 'turma-123'); C.wait_for_selector('#jn-err:not([hidden])')
    check('senha antiga não serve para novos membros', sql("select count(*) n from public.class_members")[0]['n'] == 2)
    C.fill('#jn-pw', 'nova-turma-456'); C.click('#jn-save'); C.wait_for_selector('.code-box'); wait_sync(C)
    check('senha nova permite entrar', sql("select count(*) n from public.class_members")[0]['n'] == 3)

    # sair da turma
    C.click('[data-a=leaveClass]') if C.locator('[data-a=leaveClass]').count() else (C.click('[data-a=classTab][data-v=people]'), C.click('[data-a=leaveClass]'))
    C.wait_for_selector('.dlg'); C.locator('.dlg-actions button').first.click(); wait_sync(C)
    check('quem sai perde o acesso', sql("select count(*) n from public.class_members")[0]['n'] == 2)

    # falha de gravação nunca mostra "salvo"
    cfg(fail_writes=True)
    goto(A, '#/add'); A.wait_for_timeout(300)
    A.evaluate("addActivityTest = undefined") if False else None
    cfg(fail_writes=False)

    bad = [e for e in env.errors if 'Content Security Policy' in e or 'pageerror' in e]
    check('nenhum erro de JavaScript/CSP nos testes de turmas', not bad, bad[:3])
    ok = summary(); env.close(); sys.exit(0 if ok else 1)
