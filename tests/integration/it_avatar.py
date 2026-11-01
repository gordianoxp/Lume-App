"""Foto de perfil (enviar, colega vê, estranho não vê, remover) e créditos."""
from h import *
import zlib, struct
def png(w, h, rgb):
    raw = b''.join(b'\x00' + bytes(rgb) * w for _ in range(h))
    ch = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + ch(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + ch(b'IDAT', zlib.compress(raw)) + ch(b'IEND', b'')
IMG = png(60, 30, (200, 40, 40))

def has_img(pg, name_part):  # há <img> dentro do avatar?
    return pg.evaluate("n => [...document.querySelectorAll('.av')].some(e => e.getAttribute('aria-label').includes(n) && e.querySelector('img'))", name_part)

with sync_playwright() as p:
    env = Env(p); reset()
    ca, A = new_user(env, 'Ana Souza', 'ana@x.test')
    cb, B = new_user(env, 'Bruno Lima', 'bru@x.test')
    cc, C = new_user(env, 'Carla Dias', 'car@x.test')

    goto(A, '#/settings'); A.wait_for_selector('[data-a=pickAvatar]')
    check('Perfil mostra os créditos de Bruno Gordiano', 'Bruno Gordiano' in A.inner_text('#view') and 'Idealizado e criado por' in A.inner_text('#view'))
    check('sem foto, aparece a inicial do nome', A.locator('.av').first.inner_text().strip() == 'A')
    A.set_input_files('#av-file', {'name': 'f.png', 'mimeType': 'image/png', 'buffer': IMG})
    A.wait_for_selector('.toast:has-text("Foto atualizada")'); wait_sync(A)
    path = sql("select avatar_path from public.profiles p where display_name='Ana Souza'")[0]['avatar_path']
    check('foto gravada no Storage privado e no perfil (a/<id>/...)', bool(path) and path.startswith('a/'), path)
    check('o arquivo existe no Storage', sql(f"select count(*) n from storage.objects where name='{path}'")[0]['n'] == 1)
    wait_js(A, "[...document.querySelectorAll('.av')].some(e=>e.querySelector('img'))")
    check('a foto aparece no Perfil de quem enviou', True)
    size = A.evaluate("(()=>{const i=document.querySelector('.av img'); return [i.naturalWidth,i.naturalHeight]})()")
    check('imagem foi recortada em quadrado e reduzida (320x320)', size == [320, 320], size)

    # Bruno e Carla: sem turma em comum → não veem
    goto(B, '#/settings'); B.wait_for_selector('[data-a=pickAvatar]')
    # turma: Ana cria, Bruno entra; Carla fica de fora
    goto(A, '#/classes'); A.click('[data-a=newClass]'); A.fill('#nc-name', 'Turma F'); A.fill('#nc-pw', 'senha-123'); A.fill('#nc-pw2', 'senha-123'); A.click('#nc-save'); A.wait_for_selector('.code-box')
    code = A.inner_text('.code-box').replace('-', '').replace(' ', '')
    wait_sync(A)
    goto(B, '#/classes'); B.click('[data-a=joinClass]'); B.fill('#jn-code', code); B.fill('#jn-pw', 'senha-123'); B.click('#jn-save'); B.wait_for_selector('.code-box'); wait_sync(B)
    B.click('[data-a=classTab][data-v=people]'); B.wait_for_selector('.frow')
    try: wait_js(B, "[...document.querySelectorAll('.av')].some(e=>e.getAttribute('aria-label').includes('Ana') && e.querySelector('img'))", 12000)
    except Exception: pass
    check('colega de turma vê a foto da Ana na lista de participantes', has_img(B, 'Ana'))
    check('Bruno (sem foto) continua com a inicial', not has_img(B, 'Bruno'))

    # Carla (fora da turma) não consegue baixar a foto nem vê o perfil
    check('estranho não vê o perfil/avatar_path da Ana', C.evaluate("state.profiles.every(p => p.id !== '%s' || !p.avatar_path)" % sql("select id from public.profiles where display_name='Ana Souza'")[0]['id']))

    # não aceita arquivo que não é imagem
    goto(A, '#/settings'); A.wait_for_selector('[data-a=pickAvatar]')
    A.set_input_files('#av-file', {'name': 'x.txt', 'mimeType': 'text/plain', 'buffer': b'ola'})
    A.wait_for_selector('.toast.err')
    check('arquivo que não é imagem é recusado', 'imagem' in A.inner_text('.toast.err'))
    check('a foto anterior continua intacta', sql("select avatar_path from public.profiles where display_name='Ana Souza'")[0]['avatar_path'] == path)

    # trocar apaga a antiga
    A.wait_for_timeout(2500)
    goto(A, '#/settings'); A.wait_for_selector('[data-a=pickAvatar]')
    A.set_input_files('#av-file', {'name': 'g.png', 'mimeType': 'image/png', 'buffer': png(30, 60, (20, 80, 200))})
    A.wait_for_selector('.toast:has-text("Foto atualizada")'); wait_sync(A)
    new = sql("select avatar_path from public.profiles where display_name='Ana Souza'")[0]['avatar_path']
    check('trocar a foto muda o caminho e apaga o arquivo antigo', new != path and sql(f"select count(*) n from storage.objects where name='{path}'")[0]['n'] == 0 and sql(f"select count(*) n from storage.objects where name='{new}'")[0]['n'] == 1)

    # remover
    A.wait_for_timeout(2500); goto(A, '#/settings'); A.wait_for_selector('[data-a=removeAvatar]')
    A.click('[data-a=removeAvatar]'); A.wait_for_selector('.dlg'); A.locator('.dlg-actions button').first.click()
    A.wait_for_selector('.toast:has-text("Foto removida")'); wait_sync(A)
    check('remover foto limpa o perfil e apaga o arquivo', sql("select avatar_path from public.profiles where display_name='Ana Souza'")[0]['avatar_path'] is None and sql("select count(*) n from storage.objects where name like 'a/%'")[0]['n'] == 0)

    # rodapé do login
    c2 = env.ctx(); L = env.page(c2, 'login'); open_app(L)
    check('tela de login traz "Criado por Bruno Gordiano"', 'Criado por Bruno Gordiano' in L.inner_text('#auth'))

    bad = [e for e in env.errors if 'Content Security Policy' in e or 'pageerror' in e]
    check('nenhum erro de JavaScript/CSP', not bad, bad[:3])
    ok = summary(); env.close(); sys.exit(0 if ok else 1)
