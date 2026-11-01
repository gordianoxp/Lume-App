'use strict';
/* Telas de cadastro/login/recuperação de senha e migração dos dados antigos (sem conta) para a conta. */
const Auth = (() => {
  let mode = 'login', busy = false, notice = null;

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const box = () => $('#auth');

  function show(m, n) {
    mode = m; notice = n || null; busy = false;
    $('#app').hidden = true; box().hidden = false;
    document.body.classList.remove('noscroll');
    draw();
  }
  function hide() { box().hidden = true; $('#app').hidden = false; }

  const field = (id, label, type, extra = '') => `<label class="field"><span>${label}</span><input id="${id}" type="${type}" ${extra}></label>`;
  const msgHtml = () => notice ? `<div class="auth-msg ${notice.kind}" role="${notice.kind === 'err' ? 'alert' : 'status'}">${esc(notice.text)}</div>` : '';
  const btn = (label, busyLabel) => `<button class="btn primary block" type="submit" ${busy ? 'disabled' : ''}>${busy ? busyLabel : label}</button>`;

  function draw() {
    const titles = { login: 'Entrar', signup: 'Criar conta', forgot: 'Recuperar senha', reset: 'Nova senha', sent: 'Confira seu e-mail' };
    let body = '';
    if (mode === 'login') body = `<form id="auth-form" novalidate>${msgHtml()}${field('au-email', 'E-mail', 'email', 'autocomplete="email" inputmode="email" required')}${field('au-pass', 'Senha', 'password', 'autocomplete="current-password" required')}${btn('Entrar', 'Entrando…')}</form>
      <div class="auth-links"><button class="link" data-a="authGo" data-m="forgot">Esqueci minha senha</button><button class="link" data-a="authGo" data-m="signup">Criar conta</button></div>`;
    else if (mode === 'signup') body = `<form id="auth-form" novalidate>${msgHtml()}${field('au-name', 'Seu nome', 'text', 'autocomplete="name" maxlength="60" required')}${field('au-email', 'E-mail', 'email', 'autocomplete="email" inputmode="email" required')}${field('au-pass', 'Senha (mínimo 8 caracteres)', 'password', 'autocomplete="new-password" required')}${field('au-pass2', 'Confirmar senha', 'password', 'autocomplete="new-password" required')}${btn('Criar conta', 'Criando…')}</form>
      <div class="auth-links"><button class="link" data-a="authGo" data-m="login">Já tenho conta</button></div>`;
    else if (mode === 'forgot') body = `<form id="auth-form" novalidate><p class="muted small">Informe o e-mail da conta. Enviaremos um link para criar uma nova senha.</p>${msgHtml()}${field('au-email', 'E-mail', 'email', 'autocomplete="email" inputmode="email" required')}${btn('Enviar link', 'Enviando…')}</form>
      <div class="auth-links"><button class="link" data-a="authGo" data-m="login">Voltar</button></div>`;
    else if (mode === 'reset') body = `<form id="auth-form" novalidate><p class="muted small">Escolha uma nova senha para a sua conta.</p>${msgHtml()}${field('au-pass', 'Nova senha (mínimo 8 caracteres)', 'password', 'autocomplete="new-password" required')}${field('au-pass2', 'Confirmar nova senha', 'password', 'autocomplete="new-password" required')}${btn('Salvar nova senha', 'Salvando…')}</form>`;
    else if (mode === 'sent') body = `${msgHtml()}<div class="auth-links" style="justify-content:center"><button class="btn" data-a="authGo" data-m="login">Ir para o login</button></div>`;
    box().innerHTML = `<div class="auth-wrap"><div class="auth-brand"><img src="icons/icon-192.png" alt="" width="64" height="64"><h1>Organizador Escolar</h1></div><div class="card auth-card"><h2>${titles[mode]}</h2>${body}</div></div>`;
    const first = box().querySelector('input'); if (first && mode !== 'sent') setTimeout(() => first.focus(), 50);
  }

  function setBusy(v) { busy = v; draw(); }
  function keepValues(ids) { const v = {}; ids.forEach(i => { const el = document.getElementById(i); if (el) v[i] = el.value; }); return v; }
  function restore(v) { Object.entries(v).forEach(([i, x]) => { const el = document.getElementById(i); if (el) el.value = x; }); }

  async function submit(ev) {
    ev.preventDefault();
    if (busy) return;
    const g = id => (document.getElementById(id) || { value: '' }).value;
    const email = g('au-email').trim(), pass = g('au-pass'), pass2 = g('au-pass2'), name = g('au-name').trim();
    const keep = keepValues(['au-name', 'au-email']);
    const fail = text => { notice = { kind: 'err', text }; draw(); restore(keep); };
    try {
      if (mode === 'login') {
        if (!EMAIL_RE.test(email)) return fail('Informe um e-mail válido.');
        if (!pass) return fail('Informe a senha.');
        notice = null; setBusy(true);
        await Cloud.signIn(email, pass);               // o restante é feito pelo ouvinte de autenticação
      } else if (mode === 'signup') {
        if (name.length < 1) return fail('Informe seu nome.');
        if (!EMAIL_RE.test(email)) return fail('Informe um e-mail válido.');
        if (pass.length < 8) return fail('A senha precisa ter pelo menos 8 caracteres.');
        if (pass !== pass2) return fail('As senhas não são iguais.');
        notice = null; setBusy(true);
        const { session } = await Cloud.signUp(name, email, pass);
        if (!session) show('sent', { kind: 'ok', text: 'Enviamos um e-mail de confirmação. Abra o link que recebemos (veja também o spam) e depois entre com sua senha. Se este e-mail já tiver conta, use "Esqueci minha senha".' });
      } else if (mode === 'forgot') {
        if (!EMAIL_RE.test(email)) return fail('Informe um e-mail válido.');
        notice = null; setBusy(true);
        await Cloud.resetPassword(email);
        show('sent', { kind: 'ok', text: 'Se existir uma conta com esse e-mail, enviamos um link para criar uma nova senha. Ele vale por tempo limitado.' });
      } else if (mode === 'reset') {
        if (pass.length < 8) return fail('A senha precisa ter pelo menos 8 caracteres.');
        if (pass !== pass2) return fail('As senhas não são iguais.');
        notice = null; setBusy(true);
        await Cloud.updatePassword(pass);
        history.replaceState(null, '', location.pathname + '#/home');
        window.__afterReset && window.__afterReset();
      }
    } catch (e) { busy = false; notice = { kind: 'err', text: e.message }; draw(); restore(keep); }
  }

  document.addEventListener('submit', e => { if (e.target && e.target.id === 'auth-form') submit(e); });
  document.addEventListener('click', e => { const b = e.target.closest('[data-a=authGo]'); if (b) { show(b.dataset.m); } });

  return { show, hide, get mode() { return mode; } };
})();

/* ===================== Migração dos dados antigos (neste navegador) para a conta ===================== */
const Migrate = (() => {
  let running = false;

  async function summary() {
    const legacy = await DB.readLegacy();
    if (!legacy) return null;
    const n = { subjects: legacy.subjects.length, activities: legacy.activities.length, files: legacy.files.length };
    if (!n.subjects && !n.activities && !n.files) return null;
    const meta = Object.fromEntries(legacy.meta.map(m => [m.key, m.value]));
    return { legacy, n, migratedTo: meta.migratedTo || [] };
  }

  /* Pergunta uma vez por sessão, só quando os dados antigos ainda não foram importados por NENHUMA conta. */
  async function offerIfAny() {
    if (running || !state.user) return;
    const s = await summary().catch(() => null);
    if (!s || s.migratedTo.length) return;
    const key = 'org:legacyAsked:' + state.user.id;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
    const r = await dialog({
      title: 'Importar seus dados antigos?',
      msg: `Encontramos dados salvos neste aparelho, de antes de existirem as contas: <b>${s.n.subjects}</b> disciplina(s), <b>${s.n.activities}</b> atividade(s) e <b>${s.n.files}</b> arquivo(s). Quer enviá-los para a conta <b>${esc(state.user.email || '')}</b>? Os dados antigos <b>não serão apagados</b> deste aparelho.`,
      actions: [{ label: 'Importar para minha conta', kind: 'primary', value: true }, { label: 'Agora não', value: null }]
    });
    if (r) await run(s);
  }

  async function manual() {
    const s = await summary();
    if (!s) return toast('Não há dados antigos neste aparelho.');
    if (s.migratedTo.length) {
      const mine = s.migratedTo.includes(state.user.id);
      const ok = await dialog({ title: mine ? 'Importar de novo?' : 'Estes dados já foram importados por outra conta', msg: mine ? 'Você já importou estes dados. Importar de novo não cria duplicatas: itens iguais são ignorados.' : 'Para não misturar contas, confirme que estes dados antigos são mesmo seus antes de importá-los para esta conta.', actions: [{ label: 'Importar', kind: 'primary', value: true }, { label: 'Cancelar', value: null }] });
      if (!ok) return;
    }
    await run(s);
  }

  async function run(s) {
    if (running) return;
    running = true;
    try {
      const map = (await DB.get('meta', 'legacyMap'))?.value || { subjects: {}, activities: {}, files: {} };
      const res = { subjects: 0, activities: 0, files: 0, skipped: 0, failed: 0 };
      toast('Importando seus dados…', { long: true });
      const idFor = (kind, oldId) => { if (!map[kind][oldId]) map[kind][oldId] = uid(); return map[kind][oldId]; };  // sempre ids novos: nunca colide com outra conta
      const saveMap = () => DB.put('meta', { key: 'legacyMap', value: map });
      await loadAll();

      // disciplinas: reaproveita uma com o mesmo nome em vez de duplicar
      for (const sub of s.legacy.subjects) {
        const exist = state.subjects.find(x => norm(x.name) === norm(sub.name));
        if (exist) { map.subjects[sub.id] = exist.id; res.skipped++; continue; }
        if (state.subjects.some(x => x.id === map.subjects[sub.id])) { res.skipped++; continue; }
        const rec = { id: idFor('subjects', sub.id), name: String(sub.name || 'Disciplina').slice(0, 40), color: /^#[0-9a-f]{6}$/i.test(sub.color) ? sub.color : '#64748b', icon: sub.icon || '', createdAt: sub.createdAt || Date.now() };
        await DB.put('subjects', rec); state.subjects.push(rec); res.subjects++;
      }
      await saveMap();

      // atividades: ignora as que já existem (mesmo título, disciplina e entrega) => sem duplicatas
      for (const a of s.legacy.activities) {
        const sid = map.subjects[a.subjectId] || null;
        if (!sid) { res.failed++; continue; }
        const dup = state.activities.find(x => x.id === map.activities[a.id]) || state.activities.find(x => x.subjectId === sid && norm(x.title) === norm(a.title) && x.due === a.due);
        if (dup) { map.activities[a.id] = dup.id; res.skipped++; continue; }
        const rec = {
          id: idFor('activities', a.id), title: String(a.title || 'Atividade').slice(0, 120), desc: a.desc || '', notes: a.notes || '', subjectId: sid, type: a.type || 'Atividade',
          due: a.due, priority: ['low', 'mid', 'high'].includes(a.priority) ? a.priority : 'mid', status: ['pending', 'doing', 'done'].includes(a.status) ? a.status : 'pending',
          checklist: a.checklist || [], rem: a.rem || { on: false, keys: [], custom: [] }, createdAt: a.createdAt || Date.now(), completedAt: a.completedAt || null, focusMin: a.focusMin || 0,
          postId: null, postRemoved: false, postSnapshot: null
        };
        await DB.put('activities', rec); state.activities.push(rec); res.activities++;
      }
      await saveMap();

      // arquivos: o conteúdo é copiado e enviado ao armazenamento da conta pela fila de sincronização
      for (const f of s.legacy.files) {
        if (state.files.some(x => x.id === map.files[f.id])) { res.skipped++; continue; }
        if (!f.blob) { res.failed++; continue; }
        if (f.size > MAX_FILE_BYTES) { res.failed++; continue; }
        const rec = { id: idFor('files', f.id), name: f.name, type: f.type || '', size: f.size, blob: f.blob, subjectId: map.subjects[f.subjectId] || null, activityId: map.activities[f.activityId] || null, addedAt: f.addedAt || Date.now(), remote: false, path: '' };
        await DB.put('files', rec); state.files.push(rec); res.files++;
      }
      await saveMap();

      // configurações antigas: só se a conta ainda não tem configurações próprias
      const oldSet = (s.legacy.meta.find(m => m.key === 'settings') || {}).value;
      if (oldSet && !state.hasServerSettings) await saveSettings({ ...state.settings, ...oldSet });

      await refresh();
      const left = await Cloud.flushAll();                     // só confirma depois que o servidor recebeu tudo
      const failedItems = await Cloud.failedItems();
      if (left > 0 || failedItems.length) {
        toast(`Importado neste aparelho, mas ${left} item(ns) ainda não chegaram à nuvem. Eles serão enviados quando houver conexão — os dados antigos foram mantidos.`, { err: true });
        return;
      }
      const prev = (s.migratedTo || []).filter(x => x !== state.user.id);
      await DB.writeLegacyMeta('migratedTo', [...prev, state.user.id]);
      await dialog({ title: 'Importação concluída', msg: `Importados: <b>${res.subjects}</b> disciplina(s), <b>${res.activities}</b> atividade(s), <b>${res.files}</b> arquivo(s).${res.skipped ? ` Ignorados por já existirem: ${res.skipped}.` : ''}${res.failed ? ` <b>Não importados: ${res.failed}</b> (sem disciplina ou arquivo ausente).` : ''}<br><br>Os dados antigos continuam neste aparelho. Quando quiser, remova-os em Perfil › Dados antigos.`, actions: [{ label: 'Ok', kind: 'primary', value: true }] });
    } catch (e) {
      toast('A importação não terminou: ' + errMsg(e) + '. Nada foi apagado; tente de novo em Perfil › Dados antigos.', { err: true });
    } finally { running = false; }
  }

  async function removeLegacy() {
    const s = await summary();
    if (!s) return toast('Não há dados antigos neste aparelho.');
    if (!s.migratedTo.length && !await confirmDlg('Ainda não importados', 'Estes dados antigos <b>nunca foram importados</b> para nenhuma conta. Se apagá-los, eles serão perdidos. Apagar mesmo assim?', 'Apagar mesmo assim')) return;
    if (!await confirmDlg('Remover dados antigos?', 'Remove do aparelho a cópia de antes das contas. Os dados já importados continuam na sua conta.', 'Remover')) return;
    await DB.deleteDatabase('organizador-escolar');
    toast('Dados antigos removidos deste aparelho.');
    render();
  }

  return { offerIfAny, manual, removeLegacy, summary };
})();
