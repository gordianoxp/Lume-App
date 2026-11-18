/* Service worker: faz o app abrir sem internet (usa a cópia guardada só quando a rede falha).
   Guarda só os arquivos do próprio app e a biblioteca do Supabase.
   NUNCA intercepta chamadas à API do Supabase (login, banco, arquivos): elas sempre vão direto à rede. */
const CACHE = 'lume-v7';
const CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';
const SHELL = ['index.html', 'styles.css', 'config.js', 'db.js', 'util.js', 'notify.js', 'cloud.js', 'app.js', 'auth.js', 'classes.js',
  'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(SHELL.map(u => c.add(new Request(u, { cache: 'reload' }))));
    try { await c.add(new Request(CDN, { mode: 'cors', credentials: 'omit' })); } catch (err) { /* tenta de novo no primeiro uso */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;
  if (!same && req.url !== CDN) return;            // API do Supabase e qualquer outro domínio: rede direta
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const nav = req.mode === 'navigate';
    const key = nav ? 'index.html' : req;           // toda navegação (inclusive "/?code=...") abre o mesmo index.html
    if (req.url === CDN) { const lib = await cache.match(key); if (lib) return lib; }   // biblioteca com versão fixa: cache primeiro
    // Arquivos do app: REDE PRIMEIRO (sempre a versão mais nova publicada); a cópia guardada só entra se a rede falhar
    // ou demorar demais. Assim uma atualização no GitHub/Netlify aparece na hora, sem ficar preso numa cópia antiga.
    const hit = await cache.match(key);
    const net = fetch(nav ? 'index.html' : req, { cache: 'no-cache' });
    net.catch(() => {});
    if (!hit) {                                      // nada guardado: espera a rede quanto for preciso
      try { const r = await net; if (r && r.ok) cache.put(key, r.clone()); return r; } catch (err) { return Response.error(); }
    }
    try {
      const r = await Promise.race([net, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
      if (r && r.ok) cache.put(key, r.clone());
      return r;
    } catch (err) { return hit; }
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => cs.length ? cs[0].focus() : self.clients.openWindow('./')));
});
