/* CLIENTE SIMULADO do supabase-js (somente para testes). Implementa só o que o app usa e fala com fake_backend.py.
   NÃO é a biblioteca real: o comportamento exato do supabase-js (ordem de eventos, renovação de token, Realtime)
   precisa ser confirmado num projeto Supabase de verdade. */
(function () {
  const KEY = 'sb-fake-session';
  const readSess = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } };
  const writeSess = s => { try { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch (e) { /* ignorado */ } };

  function createClient(url, anonKey, opts) {
    const base = url.replace(/\/$/, '') + '/_api/';
    const subs = new Map(); let subId = 0;
    let session = readSess(), initDone = false, recoveryFlow = false;
    const emit = (ev, s) => subs.forEach(cb => { try { cb(ev, s); } catch (e) { console.error('auth cb', e); } });

    async function call(path, { method = 'POST', json, body, headers, auth = true } = {}) {
      const h = { ...(headers || {}) };
      if (json !== undefined) h['Content-Type'] = 'application/json';
      if (auth && session) h.Authorization = 'Bearer ' + session.access_token;
      let r;
      try { r = await fetch(base + path, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : body }); }
      catch (e) { const err = new TypeError('Failed to fetch'); err.isNet = true; throw err; }
      return r;
    }
    async function tryRefresh() {
      if (!session) return false;
      try {
        const r = await call('auth/refresh', { json: { refresh_token: session.refresh_token }, auth: false });
        if (!r.ok) { session = null; writeSess(null); setTimeout(() => emit('SIGNED_OUT', null), 0); return false; }
        session = (await r.json()).session; writeSess(session); emit('TOKEN_REFRESHED', session); return true;
      } catch (e) { return false; }
    }
    // chamada autenticada com uma renovação automática, como o supabase-js faz
    async function authed(path, o) {
      let r = await call(path, o);
      if (r.status === 401 && await tryRefresh()) r = await call(path, o);
      return r;
    }
    const netErr = e => ({ message: 'TypeError: Failed to fetch', details: String(e), hint: '', code: '' });
    const dbErr = j => ({ message: j.message, code: j.code || '', details: j.details || null, hint: j.hint || null });

    /* ------------------------------ autenticação ------------------------------ */
    async function init() {
      if (initDone) return; initDone = true;
      if (opts && opts.auth && opts.auth.detectSessionInUrl) {
        const q = new URLSearchParams(location.search), code = q.get('code');
        if (code) {
          try {
            const r = await call('auth/exchange', { json: { code }, auth: false });
            const j = await r.json();
            if (r.ok) { session = j.session; writeSess(session); recoveryFlow = j.type === 'recovery'; }
          } catch (e) { /* sem rede: continua sem sessão */ }
        }
      }
    }
    const authApi = {
      onAuthStateChange(cb) {
        const id = ++subId; subs.set(id, cb);
        init().then(() => {
          setTimeout(() => {
            cb('INITIAL_SESSION', session);
            if (recoveryFlow) { recoveryFlow = false; setTimeout(() => emit('PASSWORD_RECOVERY', session), 0); }
          }, 0);
        });
        return { data: { subscription: { unsubscribe: () => subs.delete(id) } } };
      },
      async getSession() { await init(); return { data: { session }, error: null }; },
      async signInWithPassword({ email, password }) {
        try {
          const r = await call('auth/token', { json: { email, password }, auth: false }), j = await r.json();
          if (!r.ok) return { data: { user: null, session: null }, error: { message: j.message, status: r.status } };
          session = j.session; writeSess(session); setTimeout(() => emit('SIGNED_IN', session), 0);
          return { data: { user: session.user, session }, error: null };
        } catch (e) { return { data: { user: null, session: null }, error: { message: 'Failed to fetch', name: 'AuthRetryableFetchError' } }; }
      },
      async signUp({ email, password, options }) {
        try {
          const r = await call('auth/signup', { json: { email, password, name: options && options.data && options.data.name, redirectTo: options && options.emailRedirectTo }, auth: false }), j = await r.json();
          if (!r.ok) return { data: { user: null, session: null }, error: { message: j.message, status: r.status } };
          if (j.session) { session = j.session; writeSess(session); setTimeout(() => emit('SIGNED_IN', session), 0); }
          return { data: { user: j.user, session: j.session || null }, error: null };
        } catch (e) { return { data: { user: null, session: null }, error: { message: 'Failed to fetch', name: 'AuthRetryableFetchError' } }; }
      },
      async resetPasswordForEmail(email, o) {
        try { const r = await call('auth/recover', { json: { email, redirectTo: o && o.redirectTo }, auth: false }); return { data: {}, error: r.ok ? null : { message: 'erro' } }; }
        catch (e) { return { data: null, error: { message: 'Failed to fetch' } }; }
      },
      async updateUser(attrs) {
        try {
          const r = await authed('auth/update', { json: { password: attrs.password, data: attrs.data } }), j = await r.json();
          if (!r.ok) return { data: null, error: { message: j.message, status: r.status } };
          return { data: { user: session && session.user }, error: null };
        } catch (e) { return { data: null, error: { message: 'Failed to fetch' } }; }
      },
      async refreshSession() {
        try {
          const r = await call('auth/refresh', { json: { refresh_token: session && session.refresh_token }, auth: false }), j = await r.json();
          if (!r.ok) return { data: { session: null }, error: { message: j.message } };
          session = j.session; writeSess(session); return { data: { session }, error: null };
        } catch (e) { return { data: { session: null }, error: { message: 'Failed to fetch' } }; }
      },
      async signOut() {
        const s = session; session = null; writeSess(null);
        try { if (s) await call('auth/logout', { json: {}, auth: false, headers: { Authorization: 'Bearer ' + s.access_token } }); } catch (e) { /* offline: encerra só localmente */ }
        setTimeout(() => emit('SIGNED_OUT', null), 0);
        return { error: null };
      }
    };

    /* ------------------------------ dados ------------------------------ */
    class Query {
      constructor(table) { this.t = table; this.b = { table, op: 'select', f: [] }; }
      select(cols) { if (this.b.op === 'select') { this.b.cols = cols || '*'; } else this.b.ret = true; return this; }
      insert(v) { this.b.op = 'insert'; this.b.values = v; return this; }
      upsert(v, o) { this.b.op = 'upsert'; this.b.values = v; this.b.onConflict = o && o.onConflict; return this; }
      update(v) { this.b.op = 'update'; this.b.values = v; return this; }
      delete() { this.b.op = 'delete'; return this; }
      eq(c, v) { this.b.f.push({ c, o: 'eq', v }); return this; }
      in(c, v) { this.b.f.push({ c, o: 'in', v }); return this; }
      range(a, z) { this.b.range = [a, z]; return this; }
      maybeSingle() { this.single = true; return this; }
      then(res, rej) { return this.run().then(res, rej); }
      async run() {
        try {
          const r = await authed('rest', { json: this.b }), j = await r.json();
          if (!r.ok) return { data: null, error: dbErr(j), status: r.status };
          let d = j.data;
          if (this.single) d = Array.isArray(d) ? (d[0] || null) : d;
          return { data: d, error: null, status: r.status };
        } catch (e) { return { data: null, error: netErr(e), status: 0 }; }
      }
    }
    const storageApi = bucket => ({
      async upload(path, body, o) {
        try {
          const r = await authed('storage/upload?path=' + encodeURIComponent(path) + '&upsert=' + (o && o.upsert ? 1 : 0), { body, headers: { 'Content-Type': (o && o.contentType) || 'application/octet-stream' } }), j = await r.json();
          return r.ok ? { data: j, error: null } : { data: null, error: { message: j.message, statusCode: j.statusCode || String(r.status) } };
        } catch (e) { return { data: null, error: { message: 'Failed to fetch' } }; }
      },
      async download(path) {
        try {
          const r = await authed('storage/download?path=' + encodeURIComponent(path), { method: 'GET' });
          if (!r.ok) { const j = await r.json(); return { data: null, error: { message: j.message, statusCode: j.statusCode } }; }
          return { data: await r.blob(), error: null };
        } catch (e) { return { data: null, error: { message: 'Failed to fetch' } }; }
      },
      async remove(paths) {
        try {
          const r = await authed('storage/remove', { json: { paths } }), j = await r.json();
          return r.ok ? { data: j.data, error: null } : { data: null, error: { message: j.message } };
        } catch (e) { return { data: null, error: { message: 'Failed to fetch' } }; }
      }
    });

    /* ------------------------------ tempo real (consulta periódica simulada) ------------------------------ */
    const channels = new Set();
    let pollTimer = null, last = null;
    function ensurePoll() {
      if (pollTimer) return;
      pollTimer = setInterval(async () => {
        if (!channels.size) return;
        try {
          const j = await (await call('changes', { method: 'GET' })).json();
          if (last !== null && j.n !== last) channels.forEach(ch => ch.cbs.forEach(cb => { try { cb({ eventType: '*' }); } catch (e) { /* ignorado */ } }));
          last = j.n;
        } catch (e) { /* offline */ }
      }, 800);
    }

    return {
      auth: authApi,
      from: t => new Query(t),
      async rpc(fn, args) {
        try {
          const r = await authed('rpc', { json: { fn, args } }), j = await r.json();
          return r.ok ? { data: j.data, error: null, status: r.status } : { data: null, error: dbErr(j), status: r.status };
        } catch (e) { return { data: null, error: netErr(e), status: 0 }; }
      },
      storage: { from: storageApi },
      channel(name) {
        const ch = { cbs: [], on(type, filter, cb) { ch.cbs.push(cb); return ch; }, subscribe() { channels.add(ch); ensurePoll(); return ch; } };
        return ch;
      },
      removeChannel(ch) { channels.delete(ch); }
    };
  }
  window.supabase = { createClient };
})();
