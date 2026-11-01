'use strict';
/* Armazenamento local (IndexedDB). Agora é um CACHE POR USUÁRIO + FILA DE SAÍDA:
   - cada conta usa seu próprio banco ("org-<id>"), então contas diferentes no mesmo aparelho nunca se misturam;
   - toda gravação em disciplinas/atividades/arquivos/configurações entra na fila "outbox" na MESMA transação,
     e o módulo de sincronização (cloud.js) envia a fila para a nuvem;
   - o banco antigo ("organizador-escolar") só é lido na migração. */
const DB = (() => {
  let db = null, dbName = null, uid = null;
  const STORES = ['subjects', 'activities', 'files', 'meta', 'outbox', 'classes', 'members', 'profiles', 'posts', 'postfiles'];
  const SYNCED = ['subjects', 'activities', 'files'];
  let onChange = null;

  function open(name, userId) {
    return new Promise((res, rej) => {
      if (!window.indexedDB) return rej(new Error('Este navegador não oferece armazenamento local (IndexedDB).'));
      const r = indexedDB.open(name, 2);
      r.onupgradeneeded = () => {
        const d = r.result;
        STORES.forEach(s => {
          if (d.objectStoreNames.contains(s)) return;
          if (s === 'outbox') { const o = d.createObjectStore(s, { keyPath: 'seq', autoIncrement: true }); o.createIndex('k', 'k'); }
          else d.createObjectStore(s, { keyPath: s === 'meta' ? 'key' : 'id' });
        });
      };
      r.onsuccess = () => { db = r.result; dbName = name; uid = userId || null; res(); };
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('Banco bloqueado por outra aba aberta.'));
    });
  }
  function close() { if (db) { db.close(); db = null; } dbName = null; uid = null; }
  function deleteDatabase(name) {
    return new Promise((res, rej) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = () => res(); r.onerror = () => rej(r.error); r.onblocked = () => res(); });
  }

  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const done = t => new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Operação cancelada pelo banco de dados.'));
  });

  const isSynced = (s, o) => SYNCED.includes(s) || (s === 'meta' && o && o.key === 'settings');
  const tableOf = (s, o) => (s === 'meta' ? 'settings' : s);
  const idOf = (s, o) => (s === 'meta' ? 'settings' : o.id);

  function enqueue(st, table, op, id, extra) {
    const k = table + ':' + id;
    const r = st.index('k').getAllKeys(k);
    r.onsuccess = () => { r.result.forEach(key => st.delete(key)); st.add({ k, table, op, id, at: Date.now(), attempts: 0, ...(extra || {}) }); };
  }
  const poke = () => { if (onChange) try { onChange(); } catch (e) { /* ignorado */ } };

  const all = s => req(db.transaction(s).objectStore(s).getAll());
  const get = (s, id) => req(db.transaction(s).objectStore(s).get(id));
  const count = s => req(db.transaction(s).objectStore(s).count());

  async function put(s, o, opts) {
    const sync = !(opts && opts.local) && isSynced(s, o);
    const t = db.transaction(sync ? [s, 'outbox'] : s, 'readwrite');
    t.objectStore(s).put(o);
    if (sync) enqueue(t.objectStore('outbox'), tableOf(s, o), 'upsert', idOf(s, o));
    await done(t);
    if (sync) poke();
    return o;
  }
  async function putMany(s, list, opts) {
    const sync = !(opts && opts.local) && SYNCED.includes(s);
    const t = db.transaction(sync ? [s, 'outbox'] : s, 'readwrite');
    const st = t.objectStore(s);
    list.forEach(o => { st.put(o); if (sync) enqueue(t.objectStore('outbox'), s, 'upsert', o.id); });
    await done(t);
    if (sync && list.length) poke();
  }
  async function del(s, id, opts) { return delMany(s, [id], opts); }
  async function delMany(s, ids, opts) {
    const sync = !(opts && opts.local) && SYNCED.includes(s);
    const t = db.transaction(sync ? [s, 'outbox'] : s, 'readwrite');
    const st = t.objectStore(s);
    ids.forEach(id => { st.delete(id); if (sync) enqueue(t.objectStore('outbox'), s, 'delete', id); });
    await done(t);
    if (sync && ids.length) poke();
  }

  /* Substitui o conteúdo de um espelho somente-leitura (turmas, membros, publicações…) sem usar a fila. */
  async function replaceLocal(s, rows) {
    const t = db.transaction(s, 'readwrite');
    const st = t.objectStore(s); st.clear(); rows.forEach(o => st.put(o));
    await done(t);
  }
  /* Aplica o resultado de uma sincronização (sem passar pela fila). */
  async function applyLocal(s, puts, dels) {
    if (!puts.length && !dels.length) return;
    const t = db.transaction(s, 'readwrite');
    const st = t.objectStore(s);
    puts.forEach(o => st.put(o)); dels.forEach(id => st.delete(id));
    await done(t);
  }

  /* Substitui TUDO que é sincronizado (restaurar backup / apagar tudo): os registros antigos viram
     exclusões na fila e os novos viram gravações, tudo em uma única transação. */
  async function replaceSynced({ subjects = [], activities = [], files = [], settings = null }) {
    const t = db.transaction(['subjects', 'activities', 'files', 'meta', 'outbox'], 'readwrite');
    const oldIds = {};
    for (const s of SYNCED) oldIds[s] = await req(t.objectStore(s).getAllKeys());
    const ob = t.objectStore('outbox');
    ob.clear();
    const data = { subjects, activities, files };
    for (const s of SYNCED) {
      const st = t.objectStore(s); st.clear();
      data[s].forEach(o => { st.put(o); ob.add({ k: s + ':' + o.id, table: s, op: 'upsert', id: o.id, at: Date.now(), attempts: 0 }); });
    }
    for (const s of SYNCED) oldIds[s].forEach(id => { if (!data[s].some(o => o.id === id)) ob.add({ k: s + ':' + id, table: s, op: 'delete', id, at: Date.now(), attempts: 0 }); });
    if (settings) { t.objectStore('meta').put({ key: 'settings', value: settings }); ob.add({ k: 'settings:settings', table: 'settings', op: 'upsert', id: 'settings', at: Date.now(), attempts: 0 }); }
    await done(t);
    poke();
  }

  async function removeOutbox(seqs) {
    if (!seqs.length) return;
    const t = db.transaction('outbox', 'readwrite');
    seqs.forEach(q => t.objectStore('outbox').delete(q));
    await done(t);
  }
  async function updateOutbox(seq, patch) {
    const t = db.transaction('outbox', 'readwrite');
    const st = t.objectStore('outbox');
    const cur = await req(st.get(seq));
    if (cur) st.put({ ...cur, ...patch });
    await done(t);
  }

  /* ---- leitura do banco ANTIGO (versão sem contas), usado só na migração ---- */
  async function readLegacy() {
    if (!window.indexedDB) return null;
    if (indexedDB.databases) {
      try { if (!(await indexedDB.databases()).some(d => d.name === 'organizador-escolar')) return null; } catch (e) { /* tenta abrir mesmo assim */ }
    }
    return new Promise(res => {
      const r = indexedDB.open('organizador-escolar');
      r.onupgradeneeded = () => { try { r.transaction.abort(); } catch (e) { /* banco inexistente: não cria */ } };
      r.onerror = () => res(null);
      r.onsuccess = async () => {
        const d = r.result;
        try {
          const names = [...d.objectStoreNames];
          if (!names.includes('subjects') || !names.includes('activities')) { d.close(); return res(null); }
          const get = s => names.includes(s) ? new Promise(rs => { const q = d.transaction(s).objectStore(s).getAll(); q.onsuccess = () => rs(q.result); q.onerror = () => rs([]); }) : Promise.resolve([]);
          const out = { subjects: await get('subjects'), activities: await get('activities'), files: await get('files'), meta: await get('meta') };
          d.close(); res(out);
        } catch (e) { d.close(); res(null); }
      };
    });
  }
  async function writeLegacyMeta(key, value) {
    return new Promise(res => {
      const r = indexedDB.open('organizador-escolar');
      r.onerror = () => res(false);
      r.onsuccess = () => {
        const d = r.result;
        try {
          if (![...d.objectStoreNames].includes('meta')) { d.close(); return res(false); }
          const t = d.transaction('meta', 'readwrite'); t.objectStore('meta').put({ key, value });
          t.oncomplete = () => { d.close(); res(true); }; t.onerror = t.onabort = () => { d.close(); res(false); };
        } catch (e) { d.close(); res(false); }
      };
    });
  }

  return {
    open, close, deleteDatabase, all, get, count, put, putMany, del, delMany, replaceLocal, applyLocal, replaceSynced,
    removeOutbox, updateOutbox, readLegacy, writeLegacyMeta,
    set onChange(fn) { onChange = fn; }, get name() { return dbName; }, get uid() { return uid; }
  };
})();
