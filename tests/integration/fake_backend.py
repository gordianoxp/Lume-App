#!/usr/bin/env python3
"""Servidor de TESTE (não é o Supabase de verdade).

Faz o papel do Supabase para os testes do navegador, mas as regras de segurança são as REAIS:
cada chamada de dados/RPC/Storage é executada num PostgreSQL de verdade, com `set local role authenticated`
e o JWT do usuário, ou seja, passando pelas mesmas políticas RLS e funções das migrações.

O que é simulado (e portanto NÃO provado por estes testes): o servidor de autenticação (GoTrue), o envio de e-mails,
o PostgREST, o Storage e o Realtime reais. Veja README/SETUP para os testes que ainda precisam ser feitos num projeto Supabase.

Uso: python3 fake_backend.py   (variáveis: DBNAME=org_it  PORT=8790  TLS_PORT=8443)
"""
import hashlib, json, mimetypes, os, re, secrets, ssl, subprocess, sys, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
WWW = os.path.join(ROOT, 'www')
DBNAME = os.environ.get('DBNAME', 'org_it')
PORT = int(os.environ.get('PORT', '8790'))
TLS_PORT = int(os.environ.get('TLS_PORT', '8443'))
STORE = os.environ.get('STORE', '/tmp/fake_store')
CDN_PATH = '/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js'
FAKE_CLIENT = os.path.join(os.path.dirname(__file__), 'fake_supabase.js')

TABLES = {'subjects', 'activities', 'files', 'user_settings', 'classes', 'class_members', 'posts', 'post_files', 'profiles',
          'class_secrets', 'join_attempts'}   # as duas últimas existem de propósito: o teste prova que o acesso é negado
RPCS = {'create_class', 'join_class', 'update_class', 'set_class_password', 'regenerate_invite_code', 'set_member_role',
        'remove_member', 'leave_class', 'delete_class', 'delete_post', 'add_post_to_agenda', 'gen_invite_code', 'is_member'}

S = {  # estado do servidor de teste
    'tokens': {}, 'refresh': {}, 'codes': {}, 'emails': [], 'changes': 0, 'lock': threading.Lock(),
    'cfg': {'confirm_required': False, 'fail_writes': False, 'latency': 0, 'empty_config': False, 'strict_pwd': 6},
}
os.makedirs(STORE, exist_ok=True)


# ------------------------------------------------------------------ SQL
def lit(v):
    if v is None: return 'null'
    if isinstance(v, bool): return 'true' if v else 'false'
    if isinstance(v, (int, float)): return str(v)
    if isinstance(v, (dict, list)): return "'" + json.dumps(v).replace("'", "''") + "'::jsonb"
    return "'" + str(v).replace("'", "''") + "'"


IDENT = re.compile(r'^[a-z_][a-z0-9_]*$')
def ident(x):
    if not IDENT.match(x): raise ValueError('identificador inválido')
    return x


class PgError(Exception):
    def __init__(self, code, msg): super().__init__(msg); self.code = code; self.msg = msg


def psql(sql, uid=None, role=None):
    """Executa SQL como o usuário (RLS valendo) e devolve o valor JSON da linha marcada com @@."""
    pre = 'begin;\n'
    if role == 'anon' or (uid is None and role is None):
        pre += "select set_config('request.jwt.claims', '', true);\nset local role anon;\n"
    elif role == 'su':
        pass
    else:
        pre += f"select set_config('request.jwt.claims', {lit(json.dumps({'sub': uid, 'role': 'authenticated'}))}, true);\nset local role authenticated;\n"
    script = pre + sql.rstrip(';') + ';\ncommit;\n'
    p = subprocess.run(['psql', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-d', DBNAME, '-f', '-'],
                       input=script, text=True, capture_output=True)
    if p.returncode != 0:
        m = re.search(r'ERROR:\s+(\w{5}):\s+(.*)', p.stderr)
        code, msg = (m.group(1), m.group(2).strip()) if m else ('XX000', p.stderr.strip()[:300])
        if code == 'P0001' or True:
            raise PgError(code, msg)
    for line in p.stdout.splitlines():
        if line.startswith('@@'):
            return json.loads(line[2:] or 'null') if line[2:] != '' else None
    return None


# ------------------------------------------------------------------ autenticação (simulada)
def sess_for(uid, email, name):
    a, r = 'at_' + secrets.token_hex(16), 'rt_' + secrets.token_hex(16)
    S['tokens'][a] = uid; S['refresh'][r] = uid
    return {'access_token': a, 'refresh_token': r, 'expires_in': 3600, 'token_type': 'bearer',
            'user': {'id': uid, 'email': email, 'user_metadata': {'name': name or ''}}}


def acct(where, val):
    r = psql(f"select '@@' || coalesce(row_to_json(a)::text, 'null') from (select id, email, password, confirmed, name from fakeauth.accounts where {where} = {lit(val)}) a", role='su')
    return r


def auth_api(path, body, uid):
    cfg = S['cfg']
    if path == 'signup':
        email = (body.get('email') or '').strip().lower(); pw = body.get('password') or ''; name = (body.get('name') or '').strip()
        if len(pw) < cfg['strict_pwd']: return 422, {'message': f'Password should be at least {cfg["strict_pwd"]} characters.'}
        if acct('email', email): return 200, {'session': None, 'user': {'id': str(uuid.uuid4()), 'email': email}}   # sem enumeração de contas
        new = str(uuid.uuid4())
        psql(f"insert into fakeauth.accounts (id, email, password, confirmed, name) values ({lit(new)}, {lit(email)}, {lit(pw)}, {lit(not cfg['confirm_required'])}, {lit(name)});\n"
             f"insert into auth.users (id, aud, role, email, raw_user_meta_data) values ({lit(new)}, 'authenticated', 'authenticated', {lit(email)}, {lit({'name': name})})", role='su')
        if cfg['confirm_required']:
            code = 'cf_' + secrets.token_hex(8); S['codes'][code] = (new, 'signup')
            S['emails'].append({'to': email, 'type': 'confirm', 'link': f"{body.get('redirectTo') or ''}?code={code}"})
            return 200, {'session': None, 'user': {'id': new, 'email': email}}
        return 200, {'session': sess_for(new, email, name), 'user': {'id': new, 'email': email}}
    if path == 'token':
        a = acct('email', (body.get('email') or '').strip().lower())
        if not a or a['password'] != body.get('password'): return 400, {'message': 'Invalid login credentials'}
        if not a['confirmed']: return 400, {'message': 'Email not confirmed'}
        return 200, {'session': sess_for(a['id'], a['email'], a['name'])}
    if path == 'exchange':
        c = S['codes'].pop(body.get('code'), None)
        if not c: return 400, {'message': 'invalid flow state, no valid flow state found'}
        a = acct('id', c[0])
        if c[1] == 'signup': psql(f"update fakeauth.accounts set confirmed = true where id = {lit(c[0])}", role='su')
        return 200, {'session': sess_for(a['id'], a['email'], a['name']), 'type': c[1]}
    if path == 'recover':
        a = acct('email', (body.get('email') or '').strip().lower())
        if a:
            code = 'rc_' + secrets.token_hex(8); S['codes'][code] = (a['id'], 'recovery')
            S['emails'].append({'to': a['email'], 'type': 'recovery', 'link': f"{body.get('redirectTo') or ''}?code={code}"})
        return 200, {}
    if path == 'refresh':
        u = S['refresh'].get(body.get('refresh_token'))
        if not u: return 400, {'message': 'Invalid Refresh Token: Refresh Token Not Found'}
        a = acct('id', u)
        return 200, {'session': sess_for(a['id'], a['email'], a['name'])}
    if path == 'update':
        if not uid: return 401, {'message': 'JWT expired'}
        a = acct('id', uid)
        if 'password' in body:
            if len(body['password']) < cfg['strict_pwd']: return 422, {'message': 'Password should be at least 6 characters.'}
            if body['password'] == a['password']: return 422, {'message': 'New password should be different from the old password.'}
            psql(f"update fakeauth.accounts set password = {lit(body['password'])} where id = {lit(uid)}", role='su')
        if 'data' in body and 'name' in body['data']:
            psql(f"update fakeauth.accounts set name = {lit(body['data']['name'])} where id = {lit(uid)}", role='su')
        return 200, {'user': {'id': uid}}
    if path == 'logout':
        for k in [k for k, v in S['tokens'].items() if v == uid]: S['tokens'].pop(k, None)
        for k in [k for k, v in S['refresh'].items() if v == uid]: S['refresh'].pop(k, None)
        return 200, {}
    return 404, {'message': 'rota inexistente'}


# ------------------------------------------------------------------ dados (REST) e RPC
def where_sql(filters, alias=''):
    out = []
    for f in filters:
        col = (alias + '.' if alias else '') + ident(f['c'])
        if f['o'] == 'eq': out.append(f"{col} = {lit(f['v'])}")
        elif f['o'] == 'in': out.append(f"{col} in ({', '.join(lit(x) for x in f['v'])})" if f['v'] else 'false')
    return ' and '.join(out) or 'true'


def rest(body, uid):
    t = ident(body['table'])
    if t not in TABLES: raise PgError('42P01', 'tabela inexistente')
    op = body['op']
    if op == 'select':
        cols = body.get('cols') or '*'
        cols = '*' if cols.strip() == '*' else ', '.join(ident(c.strip()) for c in cols.split(','))
        rg = body.get('range')
        lim = f" offset {int(rg[0])} limit {int(rg[1]) - int(rg[0]) + 1}" if rg else ''
        return psql(f"select '@@' || coalesce(json_agg(row_to_json(q)), '[]'::json)::text from (select {cols} from public.{t} as tt where {where_sql(body.get('f', []), 'tt')}{lim}) q", uid)
    vals = body.get('values')
    rows = vals if isinstance(vals, list) else [vals] if vals is not None else []
    if op in ('insert', 'upsert'):
        if not rows: return None
        cols = sorted({k for r in rows for k in r})
        cl = ', '.join(ident(c) for c in cols)
        sql = f"insert into public.{t} ({cl}) select {cl} from json_populate_recordset(null::public.{t}, {lit(json.dumps(rows))})"
        if op == 'upsert':
            oc = body.get('onConflict') or 'id'
            sets = ', '.join(f"{ident(c)} = excluded.{ident(c)}" for c in cols if c not in oc.split(','))
            sql += f" on conflict ({oc}) do update set {sets}" if sets else f" on conflict ({oc}) do nothing"
        if body.get('ret'): sql += ' returning *'; return psql(f"select '@@' || coalesce(json_agg(row_to_json(q)), '[]'::json)::text from ({sql}) q", uid)
        return psql(sql, uid)
    if op == 'update':
        cols = list(vals.keys()); sets = ', '.join(f"{ident(c)} = x.{ident(c)}" for c in cols)
        sql = f"update public.{t} as tt set {sets} from (select * from json_populate_record(null::public.{t}, {lit(json.dumps(vals))})) x where {where_sql(body.get('f', []), 'tt')}"
        return psql(sql, uid)
    if op == 'delete':
        return psql(f"delete from public.{t} as tt where {where_sql(body.get('f', []), 'tt')}", uid)
    raise PgError('XX000', 'operação inválida')


def rpc(body, uid):
    fn = body['fn']
    if fn not in RPCS: raise PgError('42883', 'função inexistente')
    args = ', '.join(f"{ident(k)} := {lit(v)}" for k, v in (body.get('args') or {}).items())
    r = psql(f"select '@@' || coalesce(row_to_json(q)::jsonb->'r', 'null'::jsonb)::text from (select public.{fn}({args}) as r) q", uid)
    return None if r == '' else r


def blob_path(path): return os.path.join(STORE, hashlib.sha256(path.encode()).hexdigest())


# ------------------------------------------------------------------ HTTP
def load_headers_file():
    """Lê www/_headers e aplica exatamente os cabeçalhos que o Netlify aplicaria."""
    rules, cur = [], None
    for line in open(os.path.join(WWW, '_headers'), encoding='utf-8'):
        if not line.strip(): continue
        if not line.startswith((' ', '\t')): cur = (line.strip(), {}); rules.append(cur)
        else:
            k, v = line.strip().split(':', 1); cur[1][k.strip()] = v.strip()
    return rules


def headers_for(path):
    out = {}
    for pat, hs in load_headers_file():
        if pat == '/*' or pat == path: out.update(hs)
    return out


class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *a): pass

    def send(self, code, body=b'', ctype='application/json', extra=None):
        if isinstance(body, (dict, list)) or body is None: body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(body)))
        for k, v in (extra or {}).items(): self.send_header(k, v)
        self.end_headers(); self.wfile.write(body)

    def uid(self):
        a = self.headers.get('Authorization', '')
        return S['tokens'].get(a[7:]) if a.startswith('Bearer ') else None

    def raw_body(self):
        n = int(self.headers.get('Content-Length') or 0); return self.rfile.read(n) if n else b''

    def do_GET(self):
        u = urlparse(self.path); p = u.path
        if p.startswith('/_api/'): return self.api('GET', p[6:], u)
        if p == '/': p = '/index.html'
        if p == '/config.js':
            cfg = "window.APP_CONFIG = {};" if S['cfg']['empty_config'] else f"window.APP_CONFIG = {{supabaseUrl: 'http://127.0.0.1:{PORT}', supabaseAnonKey: 'test-anon-key'}};"
            return self.send(200, cfg.encode(), 'application/javascript', {**headers_for('/config.js')})
        f = os.path.normpath(os.path.join(WWW, p.lstrip('/')))
        if not f.startswith(WWW) or not os.path.isfile(f) or os.path.basename(f) == '_headers': return self.send(404, b'not found', 'text/plain')
        ct = mimetypes.guess_type(f)[0] or 'application/octet-stream'
        if f.endswith('.js'): ct = 'application/javascript'
        self.send(200, open(f, 'rb').read(), ct + ('; charset=utf-8' if ct.startswith(('text/', 'application/javascript')) else ''), headers_for(p))

    def do_POST(self):
        u = urlparse(self.path)
        if u.path.startswith('/_api/'): return self.api('POST', u.path[6:], u)
        self.send(404, b'not found', 'text/plain')

    def api(self, method, path, u):
        cfg = S['cfg']
        if cfg['latency']: time.sleep(cfg['latency'])
        try:
            if path.startswith('_test/'): return self.test_api(method, path[6:])
            uid = self.uid()
            if path.startswith('auth/'):
                code, out = auth_api(path[5:], json.loads(self.raw_body() or b'{}'), uid)
                return self.send(code, out)
            if path == 'changes': return self.send(200, {'n': S['changes']})
            if not uid: return self.send(401, {'code': 'PGRST301', 'message': 'JWT expired'})
            writes = path.startswith('storage/') and path.split('/')[1] in ('upload', 'remove')
            if path == 'rest' or path == 'rpc':
                body = json.loads(self.raw_body()); writes = path == 'rpc' or body.get('op') != 'select'
            if writes and cfg['fail_writes']: return self.send(500, {'code': '', 'message': 'falha injetada pelo teste'})
            if path == 'rest':
                r = rest(body, uid)
                if writes: S['changes'] += 1
                return self.send(200, {'data': r})
            if path == 'rpc':
                r = rpc(body, uid); S['changes'] += 1
                return self.send(200, {'data': r})
            if path == 'storage/upload':
                q = parse_qs(u.query); name = q['path'][0]; up = q.get('upsert', ['0'])[0] == '1'
                data = self.raw_body()
                sql = f"insert into storage.objects (bucket_id, name, metadata) values ('files', {lit(name)}, {lit({'size': len(data), 'mimetype': self.headers.get('Content-Type', '')})})"
                if up: sql += " on conflict (bucket_id, name) do update set updated_at = now(), metadata = excluded.metadata"
                try: psql(sql, uid)
                except PgError as e:
                    if e.code == '23505': return self.send(409, {'message': 'The resource already exists', 'statusCode': '409'})
                    raise
                open(blob_path(name), 'wb').write(data); open(blob_path(name) + '.ct', 'w').write(self.headers.get('Content-Type', ''))
                S['changes'] += 1
                return self.send(200, {'Key': 'files/' + name})
            if path == 'storage/download':
                name = parse_qs(u.query)['path'][0]
                r = psql(f"select '@@' || count(*) from storage.objects where bucket_id = 'files' and name = {lit(name)}", uid)
                if int(r) == 0 or not os.path.exists(blob_path(name)): return self.send(400, {'message': 'Object not found', 'statusCode': '404'})
                ct = open(blob_path(name) + '.ct').read() or 'application/octet-stream'
                return self.send(200, open(blob_path(name), 'rb').read(), ct)
            if path == 'storage/remove':
                names = json.loads(self.raw_body())['paths']
                r = psql(f"with d as (delete from storage.objects where bucket_id = 'files' and name in ({', '.join(lit(n) for n in names)}) returning name) select '@@' || coalesce(json_agg(name), '[]'::json)::text from d", uid) if names else []
                for n in r or []:
                    for suf in ('', '.ct'):
                        try: os.remove(blob_path(n) + suf)
                        except FileNotFoundError: pass
                S['changes'] += 1
                return self.send(200, {'data': [{'name': n} for n in (r or [])]})
            return self.send(404, {'message': 'rota inexistente'})
        except PgError as e:
            st = 403 if e.code == '42501' else 409 if e.code == '23505' else 400
            return self.send(st, {'code': e.code, 'message': e.msg, 'details': None, 'hint': None})
        except Exception as e:   # noqa
            return self.send(500, {'code': 'XX000', 'message': repr(e)})

    def test_api(self, method, path):
        if path == 'emails': return self.send(200, S['emails'])
        if path == 'config':
            S['cfg'].update(json.loads(self.raw_body() or b'{}')); return self.send(200, S['cfg'])
        if path == 'sql':   # consulta do teste como superusuário (para conferir o banco por fora do app)
            b = json.loads(self.raw_body())
            return self.send(200, {'data': psql(f"select '@@' || coalesce(json_agg(row_to_json(q)), '[]'::json)::text from ({b['sql']}) q", role='su')})
        if path == 'exec':
            psql(json.loads(self.raw_body())['sql'], role='su'); return self.send(200, {})
        if path == 'revoke_tokens':   # simula sessão expirada/revogada
            S['tokens'].clear(); S['refresh'].clear(); return self.send(200, {})
        if path == 'reset':
            psql("truncate fakeauth.accounts, public.join_attempts cascade;\ndelete from storage.objects;\ndelete from auth.users;\ndelete from public.classes;", role='su')
            S['tokens'].clear(); S['refresh'].clear(); S['codes'].clear(); S['emails'].clear()
            S['cfg'].update({'confirm_required': False, 'fail_writes': False, 'latency': 0, 'empty_config': False})
            for f in os.listdir(STORE): os.remove(os.path.join(STORE, f))
            return self.send(200, {})
        return self.send(404, {'message': 'rota de teste inexistente'})


class TLSHandler(BaseHTTPRequestHandler):
    """Faz o papel do CDN (jsdelivr): serve o cliente simulado do supabase-js."""
    protocol_version = 'HTTP/1.1'
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.split('?')[0] != CDN_PATH:
            self.send_response(404); self.send_header('Content-Length', '0'); self.end_headers(); return
        body = open(FAKE_CLIENT, 'rb').read()
        self.send_response(200)
        for k, v in {'Content-Type': 'application/javascript', 'Content-Length': str(len(body)), 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60'}.items(): self.send_header(k, v)
        self.end_headers(); self.wfile.write(body)


def main():
    cert, key = '/tmp/fake_cdn_cert.pem', '/tmp/fake_cdn_key.pem'
    if not os.path.exists(cert):
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '3', '-subj', '/CN=cdn.jsdelivr.net',
                        '-addext', 'subjectAltName=DNS:cdn.jsdelivr.net'], check=True, capture_output=True)
    tls = ThreadingHTTPServer(('127.0.0.1', TLS_PORT), TLSHandler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(cert, key)
    tls.socket = ctx.wrap_socket(tls.socket, server_side=True)
    threading.Thread(target=tls.serve_forever, daemon=True).start()
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), H); srv.daemon_threads = True
    print(f'fake backend em http://127.0.0.1:{PORT}  (CDN simulado em https://127.0.0.1:{TLS_PORT})', flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
