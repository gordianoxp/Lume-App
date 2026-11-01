"""Auxiliares dos testes de integração no navegador."""
import json, os, re, sys, time, urllib.request, urllib.error
from playwright.sync_api import sync_playwright, expect

PORT = int(os.environ.get('PORT', '8790'))
TLS_PORT = int(os.environ.get('TLS_PORT', '8443'))
BASE = f'http://127.0.0.1:{PORT}'
SHOTS = os.environ.get('SHOTS', '/tmp/it_shots')
os.makedirs(SHOTS, exist_ok=True)
PW = 'senha-segura-1'

results = []
def check(name, cond, extra=''):
    results.append((name, bool(cond), extra))
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{str(extra)[:300]}]' if extra and not cond else ''), flush=True)
    return bool(cond)

def summary():
    ok = sum(1 for r in results if r[1])
    print(f'\n== {ok}/{len(results)} verificações passaram ==')
    for r in results:
        if not r[1]: print('  FALHOU:', r[0], '|', str(r[2])[:300])
    return ok == len(results)

def api(path, body=None, method='POST', token=None, raw=False):
    req = urllib.request.Request(BASE + '/_api/' + path, data=json.dumps(body).encode() if body is not None else None, method=method,
                                 headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + token} if token else {})})
    try:
        with urllib.request.urlopen(req) as r: d = r.read(); return (r.status, d) if raw else json.loads(d or b'null')
    except urllib.error.HTTPError as e:
        d = e.read()
        return (e.code, d) if raw else {'_status': e.code, **(json.loads(d) if d else {})}

def sql(q): return api('_test/sql', {'sql': q})['data']
def reset(): api('_test/reset', {})
def cfg(**kw): return api('_test/config', kw)
def emails(): return api('_test/emails', None, 'GET')

class Env:
    def __init__(self, p):
        self.p = p
        self.browser = p.chromium.launch(args=['--proxy-server=direct://', f'--host-resolver-rules=MAP cdn.jsdelivr.net 127.0.0.1:{TLS_PORT}'])
        self.errors = []
    def ctx(self, w=390, h=844, sw=False, **kw):
        c = self.browser.new_context(viewport={'width': w, 'height': h}, ignore_https_errors=True, locale='pt-BR', timezone_id='America/Bahia',
                                     accept_downloads=True, service_workers='allow' if sw else 'block', **kw)
        c.set_default_timeout(15000)
        return c
    def page(self, ctx, name='p'):
        pg = ctx.new_page()
        pg.on('pageerror', lambda e: self.errors.append(f'[{name}] pageerror: {e}'))
        pg.on('console', lambda m: self.errors.append(f'[{name}] console.{m.type}: {m.text}') if m.type == 'error' else None)
        return pg
    def close(self): self.browser.close()

def wait_js(pg, expr, timeout=15000, step=120):
    """Espera uma expressão JS ficar verdadeira SEM usar eval dentro da página (o CSP do site proíbe 'unsafe-eval')."""
    end = time.time() + timeout / 1000; last = None
    while time.time() < end:
        try: last = pg.evaluate(expr)
        except Exception as e: last = None
        if last: return last
        time.sleep(step / 1000)
    raise TimeoutError(f'condição não atendida em {timeout} ms: {expr[:120]} (último valor: {last!r})')

def open_app(pg, path='/index.html', hash_=''):
    pg.goto(BASE + path + hash_)
    wait_js(pg, "!!(document.querySelector('#auth:not([hidden]) .auth-card') || document.querySelector('#app:not([hidden]) #nav .nb'))")

def in_app(pg): return pg.locator('#app:not([hidden]) #nav .nb').count() > 0
def on_auth(pg): return pg.locator('#auth:not([hidden]) .auth-card').count() > 0

def signup(pg, name, email, pw=PW):
    pg.click('[data-a=authGo][data-m=signup]')
    pg.fill('#au-name', name); pg.fill('#au-email', email); pg.fill('#au-pass', pw); pg.fill('#au-pass2', pw)
    pg.click('#auth-form button[type=submit]')

def login(pg, email, pw=PW):
    pg.fill('#au-email', email); pg.fill('#au-pass', pw)
    pg.click('#auth-form button[type=submit]')

def wait_app(pg, timeout=15000):
    pg.wait_for_selector('#app:not([hidden]) #nav .nb', timeout=timeout)

def goto(pg, hash_):
    pg.evaluate(f"location.hash = '{hash_}'")
    pg.wait_for_timeout(150)

def wait_sync(pg, timeout=15000):
    wait_js(pg, "Cloud.status.state==='idle' && Cloud.status.pending===0 && state.syncedOnce", timeout)

def new_user(env, name, email, pw=PW, **ctxkw):
    c = env.ctx(**ctxkw); pg = env.page(c, name.split()[0])
    open_app(pg)
    signup(pg, name, email, pw)
    wait_app(pg); wait_sync(pg)
    return c, pg

def snap(pg, name): pg.screenshot(path=f'{SHOTS}/{name}.png')
