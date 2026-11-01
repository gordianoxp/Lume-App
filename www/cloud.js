'use strict';
/* Nuvem (Supabase): sessão, sincronização, tempo real, arquivos e chamadas das turmas.
   O app continua funcionando sem internet: as alterações ficam na fila local (outbox) e são enviadas depois. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_ATTEMPTS = 5;
const POST_FIELDS = ['title', 'desc', 'due'];

/* ---------- conversões entre o formato local do app e as linhas do banco (funções puras) ---------- */
const CloudMap = {
  iso: ms => (ms ? new Date(ms).toISOString() : null),
  subjectRow: (s, uid) => ({ id: s.id, user_id: uid, name: s.name, color: s.color, icon: s.icon || '', created_at: new Date(s.createdAt || Date.now()).toISOString() }),
  subjectLocal: r => ({ id: r.id, name: r.name, color: r.color, icon: r.icon || '', createdAt: Date.parse(r.created_at) || Date.now(), _v: r.updated_at }),
  activityRow: (a, uid) => ({
    id: a.id, user_id: uid, subject_id: a.subjectId || null, title: a.title, descr: a.desc || '', notes: a.notes || '',
    type: a.type || 'Atividade', due: a.due, priority: a.priority, status: a.status, checklist: a.checklist || [], rem: a.rem || {},
    focus_min: a.focusMin || 0, completed_at: CloudMap.iso(a.completedAt), created_at: new Date(a.createdAt || Date.now()).toISOString(),
    post_id: a.postId || null, post_removed: !!a.postRemoved, post_snapshot: a.postSnapshot || null
  }),
  activityLocal: r => ({
    id: r.id, title: r.title, desc: r.descr || '', notes: r.notes || '', subjectId: r.subject_id, type: r.type, due: String(r.due).slice(0, 16),
    priority: r.priority, status: r.status, checklist: r.checklist || [], rem: r.rem || { on: false, keys: [], custom: [] },
    focusMin: r.focus_min || 0, completedAt: r.completed_at ? Date.parse(r.completed_at) : null, createdAt: Date.parse(r.created_at) || Date.now(),
    postId: r.post_id || null, postRemoved: !!r.post_removed, postSnapshot: r.post_snapshot || null, _v: r.updated_at
  }),
  fileRow: (f, uid) => ({ id: f.id, user_id: uid, subject_id: f.subjectId || null, activity_id: f.activityId || null, name: f.name, mime: f.type || '', size: f.size, storage_path: `u/${uid}/${f.id}`, added_at: new Date(f.addedAt || Date.now()).toISOString() }),
  fileLocal: (r, prev) => ({ id: r.id, name: r.name, type: r.mime || '', size: Number(r.size), blob: prev && prev.blob ? prev.blob : null, subjectId: r.subject_id, activityId: r.activity_id, addedAt: Date.parse(r.added_at) || Date.now(), remote: true, path: r.storage_path, _v: r.updated_at })
};

/* Mescla linhas do servidor com as locais. Itens com alteração pendente na fila nunca são sobrescritos
   nem apagados por uma leitura do servidor. */
function mergeRows(local, server, pending, toLocal) {
  const lm = new Map(local.map(x => [x.id, x]));
  const puts = [], dels = [], seen = new Set();
  for (const r of server) {
    seen.add(r.id);
    if (pending.has(r.id)) continue;
    const l = lm.get(r.id);
    if (l && l._v && l._v === r.updated_at) continue;
    puts.push(toLocal(r, l));
  }
  for (const l of local) if (!seen.has(l.id) && !pending.has(l.id)) dels.push(l.id);
  return { puts, dels };
}

/* Atividade criada a partir de uma publicação: o que mudou na publicação é aplicado automaticamente
   apenas nos campos que o usuário NÃO alterou por conta própria; nos demais há conflito para ele decidir. */
function diffPost(a, p) {
  const snap = a.postSnapshot || {};
  const theirs = { title: p.title, desc: p.descr || '', due: String(p.due || '').slice(0, 16) };
  const auto = {}, conflicts = {}, snapUpdates = {};
  for (const f of POST_FIELDS) {
    if (theirs[f] === snap[f]) continue;
    if (a[f] === theirs[f]) snapUpdates[f] = theirs[f];
    else if (a[f] === snap[f]) { auto[f] = theirs[f]; snapUpdates[f] = theirs[f]; }
    else conflicts[f] = { mine: a[f], theirs: theirs[f] };
  }
  return { auto, conflicts, snapUpdates };
}

const Cloud = (() => {
  const cfg = window.APP_CONFIG || {};
  const configured = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase && window.supabase.createClient);
  let client = null, user = null, running = false, chain = Promise.resolve(), queued = null;
  let channel = null, retryTimer = null, retryN = 0, debounce = null, pollId = null, authCb = null;
  const st = { state: 'idle', pending: 0, failed: 0, lastSync: null, error: '' };
  const listeners = new Set();
  let hooks = { onData: () => { }, onOffline: () => { } };

  const setStatus = patch => { Object.assign(st, patch); listeners.forEach(f => { try { f(st); } catch (e) { /* ignorado */ } }); };
  const isOnline = () => navigator.onLine !== false;

  function transient(e) {
    if (!e) return false;
    if (e.name === 'TypeError' || /fetch|network|timeout|abort|load failed/i.test(String(e.message || ''))) return true;
    const code = String(e.code || ''), status = Number(e.status || 0);
    return !isOnline() || code === '' && !status || code === 'PGRST301' || status === 401 || status === 408 || status === 429 || status >= 500;
  }
  function friendly(e) {
    const m = String((e && (e.message || e.error_description)) || e || '');
    const map = {
      not_authenticated: 'Sua sessão expirou. Entre novamente.', invalid_name: 'Informe um nome válido (até 60 caracteres).',
      invalid_password: 'A senha deve ter de 6 a 72 caracteres.', forbidden: 'Você não tem permissão para fazer isso.',
      not_found: 'Não encontrado. Pode ter sido removido.', last_admin: 'A turma precisa de pelo menos um administrador. Escolha outro antes.',
      target_is_admin: 'Remova primeiro o cargo de administrador desta pessoa.', use_leave_class: 'Use a opção "Sair da turma".',
      invalid_subject: 'Escolha uma disciplina sua.', post_unavailable: 'Esta publicação não está mais disponível.',
      forbidden_post_link: 'Operação não permitida.', invalid_role: 'Cargo inválido.'
    };
    for (const k of Object.keys(map)) if (m.includes(k)) return map[k];
    if (transient(e)) return 'Sem conexão com o servidor. Tente de novo quando estiver online.';
    if (/row-level security|permission denied|42501/i.test(m)) return 'Você não tem permissão para fazer isso.';
    return 'Não foi possível concluir (' + m.slice(0, 120) + ').';
  }
  const ok = ({ data, error }) => { if (error) { const e = new Error(friendly(error)); e.raw = error; e.transient = transient(error); throw e; } return data; };

  async function fetchAll(build) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const rows = ok(await build().range(from, from + 999));
      out.push(...rows);
      if (rows.length < 1000) break;
    }
    return out;
  }

  /* ------------------------------------------------ autenticação ------------------------------------------------ */
  function init() {
    if (!configured) return false;
    client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    client.auth.onAuthStateChange((event, session) => { setTimeout(() => authCb && authCb(event, session), 0); });
    return true;
  }
  const authErr = e => {
    const m = String((e && e.message) || '');
    if (/invalid login credentials/i.test(m)) return 'E-mail ou senha incorretos.';
    if (/email not confirmed/i.test(m)) return 'Confirme seu e-mail antes de entrar (veja a caixa de entrada e o spam).';
    if (/rate limit|too many/i.test(m)) return 'Muitas tentativas. Aguarde alguns minutos e tente de novo.';
    if (/password should be at least|weak/i.test(m)) return 'A senha é muito fraca. Use pelo menos 8 caracteres.';
    if (/already registered/i.test(m)) return 'Não foi possível criar a conta com esses dados.';
    if (/same password|different from the old/i.test(m)) return 'A nova senha precisa ser diferente da atual.';
    if (/expired|invalid.*(token|code)|otp/i.test(m)) return 'O link expirou ou já foi usado. Peça um novo.';
    if (transient(e)) return 'Sem conexão com a internet. Verifique a rede e tente de novo.';
    return 'Não foi possível concluir. Tente novamente.';
  };
  async function wrapAuth(fn) { try { return await fn(); } catch (e) { const x = new Error(authErr(e)); x.raw = e; throw x; } }
  const redirect = () => location.origin + location.pathname.replace(/index\.html$/, '');

  const api = {
    configured, st, get client() { return client; }, get user() { return user; },
    init, onAuth(fn) { authCb = fn; },
    onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get status() { return st; },
    friendly, transient,

    async getSession() { const { data, error } = await client.auth.getSession(); if (error) throw error; return data.session; },
    signIn: (email, password) => wrapAuth(async () => { const { data, error } = await client.auth.signInWithPassword({ email, password }); if (error) throw error; return data; }),
    signUp: (name, email, password) => wrapAuth(async () => {
      const { data, error } = await client.auth.signUp({ email, password, options: { data: { name }, emailRedirectTo: redirect() } });
      if (error) throw error; return { session: data.session };
    }),
    resetPassword: email => wrapAuth(async () => { const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: redirect() }); if (error) throw error; }),
    updatePassword: password => wrapAuth(async () => { const { error } = await client.auth.updateUser({ password }); if (error) throw error; }),
    async updateName(name) {
      if (!isOnline()) throw new Error('Alterar o nome exige conexão com a internet.');
      ok(await client.from('profiles').update({ display_name: name }).eq('id', user.id));
      await client.auth.updateUser({ data: { name } });
    },
    async signOut() { try { await client.auth.signOut(); } catch (e) { /* mesmo offline, encerra localmente */ } },
    async refresh() { const { data, error } = await client.auth.refreshSession(); if (error) throw error; return data.session; },

    /* ------------------------------------------------ sincronização ------------------------------------------------ */
    start(u, h) {
      user = u; hooks = { ...hooks, ...h }; running = true; retryN = 0;
      DB.onChange = () => scheduleSync(300);
      api.sync();
      startRealtime();
      clearInterval(pollId);
      pollId = setInterval(() => { if (!document.hidden && isOnline()) api.sync(); }, 60000);
    },
    stop() {
      running = false; user = null; DB.onChange = null;
      clearTimeout(retryTimer); clearTimeout(debounce); clearInterval(pollId);
      if (channel && client) { try { client.removeChannel(channel); } catch (e) { /* ignorado */ } }
      channel = null; setStatus({ state: 'idle', pending: 0, failed: 0, error: '' });
    },
    sync() {
      if (!running) return Promise.resolve(false);
      if (queued) return queued;
      const run = chain.then(() => { queued = null; return syncOnce(); }, () => { queued = null; return syncOnce(); });
      queued = run; chain = run.catch(() => { });
      return run;
    },
    /* Espera a fila esvaziar (usado antes de ações que dependem do servidor, como adicionar publicação à agenda). */
    async flushAll() { await api.sync(); return DB.count('outbox'); },

    async retryFailed() {
      const items = await DB.all('outbox');
      for (const it of items) if ((it.attempts || 0) >= MAX_ATTEMPTS) await DB.updateOutbox(it.seq, { attempts: 0, error: '' });
      return api.sync();
    },
    async failedItems() { return (await DB.all('outbox')).filter(i => (i.attempts || 0) >= MAX_ATTEMPTS); },

    /* ------------------------------------------------ arquivos ------------------------------------------------ */
    async fileBlob(f) {
      if (f.blob) return f.blob;
      if (!isOnline()) throw new Error('Este arquivo ainda não foi baixado neste aparelho. Conecte-se à internet para abri-lo.');
      const { data, error } = await client.storage.from('files').download(f.path || `u/${user.id}/${f.id}`);
      if (error) throw new Error(friendly(error));
      await DB.put('files', { ...f, blob: data }, { local: true });
      f.blob = data;
      return data;
    },
    async postFileBlob(pf) {
      if (!isOnline()) throw new Error('Conecte-se à internet para abrir este anexo.');
      const { data, error } = await client.storage.from('files').download(pf.storage_path);
      if (error) throw new Error(friendly(error));
      return data;
    },
    async uploadClassFile(path, file) {
      const { error } = await client.storage.from('files').upload(path, file, { upsert: false, contentType: file.type || 'application/octet-stream' });
      if (error) throw new Error(friendly(error));
    },
    async removeStorage(paths) {
      if (!paths.length) return;
      const { error } = await client.storage.from('files').remove(paths);
      if (error) throw new Error(friendly(error));
    },

    /* ------------------------------------------------ foto de perfil ------------------------------------------------ */
    async uploadAvatar(blob) {
      if (!isOnline()) throw new Error('Trocar a foto exige conexão com a internet.');
      const old = (state.profiles.find(p => p.id === user.id) || {}).avatar_path;
      const path = `a/${user.id}/${uid().replace(/-/g, '')}`;
      const up = await client.storage.from('files').upload(path, blob, { upsert: false, contentType: 'image/jpeg' });
      if (up.error) throw new Error(friendly(up.error));
      const r = await client.from('profiles').update({ avatar_path: path }).eq('id', user.id);
      if (r.error) { try { await client.storage.from('files').remove([path]); } catch (e) { /* ignorado */ } throw new Error(friendly(r.error)); }
      if (old) { try { await client.storage.from('files').remove([old]); } catch (e) { /* ignorado */ } }
      return path;
    },
    async removeAvatar() {
      if (!isOnline()) throw new Error('Remover a foto exige conexão com a internet.');
      const old = (state.profiles.find(p => p.id === user.id) || {}).avatar_path;
      const r = await client.from('profiles').update({ avatar_path: null }).eq('id', user.id);
      if (r.error) throw new Error(friendly(r.error));
      if (old) { try { await client.storage.from('files').remove([old]); } catch (e) { /* ignorado */ } }
    },
    /** Devolve um blob: URL da foto (cache em memória e no aparelho, para funcionar offline). */
    async avatarUrl(path) {
      if (!path) return null;
      if (avatarCache.has(path)) return avatarCache.get(path);
      let blob = null;
      try { const c = await DB.get('meta', 'av:' + path); blob = c && c.value; } catch (e) { /* sem cache */ }
      if (!blob) {
        if (!isOnline()) return null;
        const { data, error } = await client.storage.from('files').download(path);
        if (error || !data) return null;
        blob = data;
        try { await DB.put('meta', { key: 'av:' + path, value: blob }, { local: true }); } catch (e) { /* opcional */ }
      }
      const url = URL.createObjectURL(blob); avatarCache.set(path, url); return url;
    },

    /* ------------------------------------------------ turmas (todas exigem conexão) ------------------------------------------------ */
    async rpc(name, args) { if (!isOnline()) { const e = new Error('Esta ação exige conexão com a internet.'); e.transient = true; throw e; } return ok(await client.rpc(name, args)); },
    async table(fn) { if (!isOnline()) { const e = new Error('Esta ação exige conexão com a internet.'); e.transient = true; throw e; } return ok(await fn(client)); }
  };

  const avatarCache = new Map();
  function scheduleSync(ms) { clearTimeout(debounce); debounce = setTimeout(() => api.sync(), ms); }

  function startRealtime() {
    if (!client || channel) return;
    try {
      channel = client.channel('db-' + user.id);
      ['subjects', 'activities', 'files', 'user_settings', 'classes', 'class_members', 'posts', 'post_files'].forEach(t =>
        channel.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => scheduleSync(400)));
      channel.subscribe();
    } catch (e) { channel = null; }
  }

  /* ----- uma rodada: envia a fila, depois lê o servidor ----- */
  async function syncOnce() {
    if (!running || !user) return false;
    if (!isOnline()) { setStatus({ state: 'offline', pending: await DB.count('outbox') }); return false; }
    setStatus({ state: 'syncing', error: '' });
    try {
      // Sem sessão válida as consultas voltariam VAZIAS (e apagariam o cache local): nunca sincroniza assim.
      const { data: sd } = await client.auth.getSession();
      if (!sd || !sd.session || !sd.session.user || sd.session.user.id !== user.id) {
        setStatus({ state: 'offline', pending: await DB.count('outbox'), error: 'Entre novamente para sincronizar.' });
        return false;
      }
      await flush();
      await pull();
      retryN = 0;
      const items = await DB.all('outbox');
      const failed = items.filter(i => (i.attempts || 0) >= MAX_ATTEMPTS).length;
      setStatus({ state: failed ? 'error' : 'idle', pending: items.length, failed, lastSync: Date.now(), error: failed ? 'Alguns itens não puderam ser enviados.' : '' });
      return true;
    } catch (e) {
      const pending = await DB.count('outbox').catch(() => 0);
      if (e && (e.transient || transient(e.raw || e))) {
        setStatus({ state: isOnline() ? 'error' : 'offline', pending, error: 'Sem conexão com o servidor.' });
        retryN++; clearTimeout(retryTimer);
        retryTimer = setTimeout(() => api.sync(), Math.min(300000, 5000 * 3 ** Math.min(retryN, 4)));
      } else {
        setStatus({ state: 'error', pending, error: friendly(e) });
      }
      return false;
    }
  }

  function throwTransient(error) { const e = new Error(friendly(error)); e.raw = error; e.transient = transient(error); throw e; }

  async function flush() {
    const items = (await DB.all('outbox')).sort((a, b) => a.seq - b.seq).filter(i => (i.attempts || 0) < MAX_ATTEMPTS);
    const up = { subjects: [], activities: [], files: [], settings: [] }, del = { subjects: [], activities: [], files: [] };
    items.forEach(i => { (i.op === 'upsert' ? up : del)[i.table].push(i); });
    for (const t of ['subjects', 'activities', 'files', 'settings']) if (up[t].length) await pushUpserts(t, up[t]);
    for (const t of ['files', 'activities', 'subjects']) if (del[t].length) await pushDeletes(t, del[t]);
  }

  /* Tenta enviar em lote; se falhar por erro permanente, isola o item defeituoso e continua com os outros. */
  async function guarded(items, batchFn) {
    try { await batchFn(items); await DB.removeOutbox(items.map(i => i.seq)); return; }
    catch (e) {
      if (e.transient || transient(e.raw || e)) throw Object.assign(e, { transient: true });
      if (items.length === 1) { await DB.updateOutbox(items[0].seq, { attempts: (items[0].attempts || 0) + 1, error: String(e.message || e).slice(0, 200) }); return; }
    }
    for (const it of items) {
      try { await batchFn([it]); await DB.removeOutbox([it.seq]); }
      catch (e) {
        if (e.transient || transient(e.raw || e)) throw Object.assign(e, { transient: true });
        await DB.updateOutbox(it.seq, { attempts: (it.attempts || 0) + 1, error: String(e.message || e).slice(0, 200) });
      }
    }
  }

  async function pushUpserts(table, items) {
    const uid = user.id;
    const recs = [];
    for (const it of items) {
      const rec = table === 'settings' ? await DB.get('meta', 'settings') : await DB.get(table, it.id);
      if (!rec) { await DB.removeOutbox([it.seq]); continue; }
      recs.push({ it, rec });
    }
    if (!recs.length) return;
    const byId = new Map(recs.map(r => [r.it.seq, r]));
    await guarded(recs.map(r => r.it), async batch => {
      const rs = batch.map(i => byId.get(i.seq).rec);
      if (table === 'subjects') throwTransient2(await client.from('subjects').upsert(rs.map(r => CloudMap.subjectRow(r, uid)), { onConflict: 'id' }));
      else if (table === 'activities') {
        for (const r of rs) {
          const row = CloudMap.activityRow(r, uid);
          if (r.postId) { // atividades vindas do mural já existem no servidor (criadas pela função RPC): só atualiza
            const { id, user_id, post_id, post_removed, ...patch } = row;
            throwTransient2(await client.from('activities').update(patch).eq('id', id));
          } else throwTransient2(await client.from('activities').upsert(row, { onConflict: 'id' }));
        }
      } else if (table === 'files') {
        for (const r of rs) {
          if (r.blob && !r.remote) {
            const { error } = await client.storage.from('files').upload(`u/${uid}/${r.id}`, r.blob, { upsert: true, contentType: r.type || 'application/octet-stream' });
            if (error) throwTransient(error);
          }
          throwTransient2(await client.from('files').upsert(CloudMap.fileRow(r, uid), { onConflict: 'id' }));
          if (r.blob && !r.remote) await DB.put('files', { ...r, remote: true, path: `u/${uid}/${r.id}` }, { local: true });
        }
      } else if (table === 'settings') {
        throwTransient2(await client.from('user_settings').upsert({ user_id: uid, data: rs[0].value, updated_at: new Date().toISOString() }, { onConflict: 'user_id' }));
      }
    });
  }
  function throwTransient2(res) { if (res && res.error) throwTransient(res.error); return res; }

  async function pushDeletes(table, items) {
    const uid = user.id;
    await guarded(items, async batch => {
      const ids = batch.map(i => i.id);
      if (table === 'files') {
        const { error } = await client.storage.from('files').remove(ids.map(id => `u/${uid}/${id}`));
        if (error && !/not found/i.test(error.message || '')) throwTransient(error);
      }
      throwTransient2(await client.from(table).delete().in('id', ids));
    });
  }

  async function pull() {
    const uid = user.id;
    const [subs, acts, files, sets] = await Promise.all([
      fetchAll(() => client.from('subjects').select('*').eq('user_id', uid)),
      fetchAll(() => client.from('activities').select('*').eq('user_id', uid)),
      fetchAll(() => client.from('files').select('*').eq('user_id', uid)),
      client.from('user_settings').select('data,updated_at').eq('user_id', uid).maybeSingle().then(ok)
    ]);
    const [classes, members, profiles, posts, postfiles] = await Promise.all([
      fetchAll(() => client.from('classes').select('*')),
      fetchAll(() => client.from('class_members').select('*')),
      fetchAll(() => client.from('profiles').select('id,display_name,avatar_path')),
      fetchAll(() => client.from('posts').select('*')),
      fetchAll(() => client.from('post_files').select('*'))
    ]);

    const outbox = await DB.all('outbox');
    const pend = t => new Set(outbox.filter(o => o.table === t).map(o => o.id));
    let changed = false;
    const cfgs = [['subjects', subs, CloudMap.subjectLocal], ['activities', acts, CloudMap.activityLocal], ['files', files, CloudMap.fileLocal]];
    for (const [store, rows, fn] of cfgs) {
      const local = await DB.all(store);
      const { puts, dels } = mergeRows(local, rows, pend(store), fn);
      if (puts.length || dels.length) { await DB.applyLocal(store, puts, dels); changed = true; }
    }
    // configurações (última gravação vence; nunca sobrescreve alteração pendente)
    const hasPendingSettings = outbox.some(o => o.table === 'settings');
    const localSet = await DB.get('meta', 'settings');
    if (sets && !hasPendingSettings) {
      if (JSON.stringify(localSet && localSet.value) !== JSON.stringify(sets.data)) { await DB.applyLocal('meta', [{ key: 'settings', value: sets.data }], []); changed = true; }
      state.hasServerSettings = true;
    } else if (!sets && localSet && !hasPendingSettings) {
      await DB.put('meta', localSet); // primeira vez: envia as configurações locais
    }
    // espelhos das turmas (somente leitura)
    const mrows = members.map(m => ({ ...m, id: m.class_id + ':' + m.user_id }));
    const mirrors = [['classes', classes], ['members', mrows], ['profiles', profiles], ['posts', posts], ['postfiles', postfiles]];
    const key = a => JSON.stringify([...a].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)));
    for (const [s, rows] of mirrors) {
      const cur = await DB.all(s);
      if (key(cur) !== key(rows)) { await DB.replaceLocal(s, rows); changed = true; }
    }
    hooks.onData(changed);
  }

  window.addEventListener('online', async () => {
    if (!running) return;
    try { await api.refresh(); } catch (e) { /* o listener de autenticação trata sessão inválida */ }
    api.sync();
  });
  window.addEventListener('offline', () => { if (running) DB.count('outbox').then(n => setStatus({ state: 'offline', pending: n })).catch(() => { }); });
  document.addEventListener('visibilitychange', () => { if (running && !document.hidden) api.sync(); });

  return api;
})();
