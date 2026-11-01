'use strict';
/* ===================== Dados e configurações ===================== */
async function loadAll() {
  const [subjects, activities, files, meta, classes, members, profiles, posts, postfiles] = await Promise.all([DB.all('subjects'), DB.all('activities'), DB.all('files'), DB.all('meta'), DB.all('classes'), DB.all('members'), DB.all('profiles'), DB.all('posts'), DB.all('postfiles')]);
  state.subjects = subjects.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  state.activities = activities;
  state.files = files;
  state.classes = classes; state.members = members; state.profiles = profiles; state.posts = posts; state.postfiles = postfiles;
  const m = Object.fromEntries(meta.map(x => [x.key, x.value]));
  state.settings = { ...DEFAULT_SETTINGS, ...(m.settings || {}) };
  state.fired = m.fired || [];
}
async function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  await DB.put('meta', { key: 'settings', value: state.settings });
}
async function refresh() {
  await loadAll();
  render();
  rescheduleReminders();
}
function errMsg(e) {
  if (e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''))) return 'Sem espaço suficiente de armazenamento no aparelho.';
  return (e && e.message) || String(e);
}
function applyTheme() {
  const pref = state.settings.theme;
  const dark = pref === 'dark' || (pref === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const m = document.querySelector('meta[name=theme-color]');
  if (m) m.content = dark ? '#0e1016' : '#f5f6fb';
}
function requestPersist() { try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { /* opcional */ } }
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

/* ===================== Camada de interface: toast, diálogo, folha ===================== */
function toast(msg, o = {}) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (o.err ? ' err' : '');
  el.innerHTML = `<span>${esc(msg)}</span>`;
  if (o.action) {
    const b = document.createElement('button');
    b.textContent = o.label || 'Desfazer';
    b.onclick = () => { el.remove(); o.action(); };
    el.appendChild(b);
  }
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => el.remove(), (o.long || o.action || o.err) ? 7000 : 3200);
}

function dialog({ title, msg, actions }) {
  return new Promise(res => {
    const el = $('#dialog');
    el.innerHTML = `<div class="dlg-back"></div><div class="dlg" role="dialog" aria-modal="true"><h3>${esc(title)}</h3><p>${msg}</p><div class="dlg-actions">${actions.map((x, i) => `<button class="btn ${x.kind || ''}" data-i="${i}">${esc(x.label)}</button>`).join('')}</div></div>`;
    el.classList.add('open');
    const close = v => { el.classList.remove('open'); el.innerHTML = ''; el.onclick = null; res(v); };
    el.onclick = e => {
      const b = e.target.closest('button[data-i]');
      if (b) close(actions[+b.dataset.i].value);
      else if (e.target.classList.contains('dlg-back')) close(null);
    };
  });
}
const confirmDlg = (title, msg, label = 'Excluir') => dialog({ title, msg, actions: [{ label, kind: 'danger', value: true }, { label: 'Cancelar', value: null }] });

/* ===================== Foto de perfil ===================== */
function avatarHTML(userId, size, name) {
  const p = state.profiles.find(x => x.id === userId); const nm = name || (p && p.display_name) || '';
  return `<span class="av" style="--s:${size || 44}px" data-av="${esc(userId)}" role="img" aria-label="Foto de ${esc(nm || 'participante')}">${esc((nm.trim()[0] || '?').toUpperCase())}</span>`;
}
function hydrateAvatars(root) {
  (root || document).querySelectorAll('.av[data-av]').forEach(el => {
    const p = state.profiles.find(x => x.id === el.dataset.av);
    if (!p || !p.avatar_path || el.querySelector('img')) return;
    Cloud.avatarUrl(p.avatar_path).then(url => {
      if (!url || !el.isConnected || el.querySelector('img')) return;
      const im = new Image(); im.alt = ''; im.onload = () => { el.textContent = ''; el.appendChild(im); }; im.src = url;
    }).catch(() => { /* fica com a inicial */ });
  });
}
async function prepAvatar(file) {
  if (!file || !/^image\//.test(file.type)) throw new Error('Escolha um arquivo de imagem (JPG, PNG ou WebP).');
  if (file.size > 20 * 1024 * 1024) throw new Error('Esta imagem é muito grande (máximo 20 MB).');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Não foi possível ler esta imagem. Tente um JPG ou PNG.')); i.src = url; });
    const side = Math.min(img.naturalWidth, img.naturalHeight), S = 320;
    if (!side) throw new Error('Imagem inválida.');
    const cv = document.createElement('canvas'); cv.width = cv.height = S;
    cv.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, S, S);
    const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.85));
    if (!blob) throw new Error('Não foi possível preparar a imagem.');
    return blob;
  } finally { URL.revokeObjectURL(url); }
}

function openSheet(html) {
  const o = $('#sheet');
  o.innerHTML = `<div class="sheet-back" data-a="closeSheet"></div><div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  o.classList.add('open');
  document.body.classList.add('noscroll');
  if (!state.sheetOpen) { history.pushState({ sheet: 1 }, '', location.href); state.sheetPushed = true; }
  state.sheetOpen = true;
  hydrateAvatars(o);
}
function hideSheetUI() {
  const o = $('#sheet');
  o.classList.remove('open'); o.innerHTML = '';
  document.body.classList.remove('noscroll');
  state.sheetOpen = false; state.form = null;
}
function closeSheet(keepHistory) {
  if (!state.sheetOpen) return;
  hideSheetUI();
  if (state.sheetPushed) { state.sheetPushed = false; if (!keepHistory) history.back(); }
}
const sheetHead = t => `<div class="sheet-head"><h2>${esc(t)}</h2><button class="icon-btn" data-a="closeSheet" aria-label="Fechar">${ICON.x}</button></div>`;

/* ===================== Roteamento e renderização ===================== */
const TAB = { home: 'home', subject: 'home', activities: 'home', upcoming: 'home', progress: 'home', history: 'home', focus: 'home', search: 'home', calendar: 'calendar', files: 'home', classes: 'classes', class: 'classes', settings: 'settings' };
const VIEWS = {};
let lastKey = '';

function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [name, ...rest] = h.split('/');
  return { name: name || 'home', arg: decodeURIComponent(rest.join('/')) };
}
function render() {
  const r = parseRoute();
  state.route = r;
  const key = r.name + '/' + r.arg;
  state.routeChanged = key !== lastKey;
  lastKey = key;
  const view = $('#view');
  const keep = view.scrollTop;
  const v = (VIEWS[r.name] || VIEWS.home)(r.arg);
  $('#topbar').innerHTML = `${v.back ? `<button class="icon-btn" data-a="back" aria-label="Voltar">${ICON.back}</button>` : ''}<h1>${esc(v.title)}</h1>${syncChipHTML()}${v.actions !== undefined ? v.actions : `<button class="icon-btn" data-a="go" data-to="search" aria-label="Buscar">${ICON.search}</button>`}`;
  view.innerHTML = v.html;
  hydrateAvatars(view);
  view.scrollTop = state.routeChanged ? 0 : keep;
  const tab = TAB[r.name] || 'home';
  const items = [['home', 'Início', ICON.home], ['calendar', 'Calendário', ICON.calendar], ['add', 'Adicionar', ICON.plus], ['classes', 'Turmas', ICON.users], ['settings', 'Perfil', ICON.user]];
  $('#nav').innerHTML = items.map(([k, l, i]) => k === 'add'
    ? `<button class="nb add" data-a="openAdd" aria-label="Adicionar"><span class="plus">${i}</span><span>${l}</span></button>`
    : `<button class="nb ${tab === k ? 'on' : ''}" data-a="go" data-to="${k}" ${tab === k ? 'aria-current="page"' : ''}>${i}<span>${l}</span></button>`).join('');
  if (v.after) v.after();
}

const emptyState = (icon, title, text, btn = '') => `<div class="empty"><div class="big">${icon}</div><b>${esc(title)}</b>${esc(text)}${btn}</div>`;

/* ===================== Componentes ===================== */
function actItem(a) {
  const s = subj(a.subjectId) || { name: '—', color: '#64748b' };
  const due = dueOf(a), late = isOverdue(a), nf = filesOf(a.id).length, cl = a.checklist || [];
  const done = a.status === 'done';
  return `<div class="item ${done ? 'done' : ''}" style="--c:${s.color}">
    <button class="check ${done ? 'on' : ''}" data-a="toggle" data-id="${a.id}" aria-label="${done ? 'Reabrir' : 'Concluir'}: ${esc(a.title)}">${ICON.check}</button>
    <div class="item-main" data-a="openAct" data-id="${a.id}">
      <div class="item-title">${esc(a.title)}</div>
      <div class="item-meta"><span class="dot"></span>${esc(s.name)} · <span class="${late ? 'late' : ''}">${late ? 'Atrasada · ' : ''}${due ? fmtRel(due) : ''}</span></div>
      <div class="badges">
        <span class="badge ${a.priority}">${PRIORITIES[a.priority]}</span>
        ${a.status === 'doing' ? '<span class="badge doing">Em andamento</span>' : ''}
        <span class="badge">${esc(a.type || 'Atividade')}</span>
        ${a.postId ? `<span class="badge">${ICON.users.replace(/width="22" height="22"/, 'width="13" height="13"')} Turma</span>` : ''}
        ${nf ? `<span class="badge">${ICON.clip}${nf}</span>` : ''}
        ${cl.length ? `<span class="badge">✓ ${cl.filter(x => x.done).length}/${cl.length}</span>` : ''}
      </div>
    </div></div>`;
}

function notifHelp() {
  if (state.notif === 'unsupported') {
    return isIOS && !Native
      ? 'No iPhone, as notificações só funcionam com o app instalado: toque em Compartilhar no Safari e depois em “Adicionar à Tela de Início”. Abra o app por esse ícone para ativar.'
      : 'Este navegador não oferece notificações. Os lembretes aparecerão como avisos dentro do app.';
  }
  if (state.notif === 'denied') {
    return isIOS ? 'As notificações estão bloqueadas. Abra Ajustes › Notificações › Escola e ative “Permitir Notificações”.' : 'As notificações estão bloqueadas. Ative-as nas configurações do navegador para este site.';
  }
  return '';
}
function notifBanner() {
  if (state.settings.notifBannerDismissed || !state.activities.length) return '';
  if (state.notif === 'default') return `<div class="banner"><b>Receba lembretes dos prazos</b><div class="small muted" style="margin:4px 0 10px">Ative as notificações para ser avisado antes das entregas.</div><div class="row"><button class="btn primary sm" data-a="notifEnable">Ativar</button><button class="btn sm" data-a="notifDismiss">Agora não</button></div></div>`;
  const h = notifHelp();
  if (h) return `<div class="banner"><div class="small">${esc(h)}</div><div class="row" style="margin-top:8px"><button class="btn sm" data-a="notifDismiss">Entendi</button></div></div>`;
  return '';
}

/* ===================== Início ===================== */
VIEWS.home = () => {
  if (!state.syncedOnce && !state.subjects.length && !state.activities.length) return { title: 'Início', html: `<div class="loading">Carregando seus dados…</div>` };
  const P = state.activities.filter(isPending);
  const late = P.filter(isOverdue), today = P.filter(isToday), soon = P.filter(isSoon);
  const total = state.activities.length, done = total - P.length, pct = total ? Math.round(done / total * 100) : 0;
  const urgent = [...late.sort((a, b) => dueOf(a) - dueOf(b)), ...today.sort((a, b) => dueOf(a) - dueOf(b)), ...soon.sort((a, b) => dueOf(a) - dueOf(b))];
  let h = '';
  if (!state.subjects.length) {
    h += `<div class="card"><b style="font-size:18px">Bem-vindo(a)! 👋</b><p class="muted">Comece criando suas disciplinas. Depois cadastre atividades, anexe arquivos e acompanhe os prazos.</p><button class="btn primary block" data-a="newSubj">Criar primeira disciplina</button></div>`;
  }
  h += notifBanner();
  h += `<div class="stats">
    <button class="stat" style="--c:var(--primary)" data-a="go" data-to="activities/today"><b>${today.length}</b><span>Vencem hoje</span></button>
    <button class="stat" style="--c:#0ea5e9" data-a="go" data-to="activities/soon"><b>${soon.length}</b><span>Próximos ${state.settings.soonDays} dias</span></button>
    <button class="stat" style="--c:var(--danger)" data-a="go" data-to="activities/overdue"><b>${late.length}</b><span>Atrasadas</span></button>
    <button class="stat" style="--c:#64748b" data-a="go" data-to="activities/pending"><b>${P.length}</b><span>Pendentes no total</span></button>
  </div>
  <div class="card" data-a="go" data-to="progress" style="cursor:pointer"><div class="row" style="justify-content:space-between;margin-bottom:8px"><b>Progresso geral</b><span class="muted small">${done} de ${total} concluídas · ${pct}%</span></div><div class="bar"><i style="width:${pct}%"></i></div></div>`;
  if (state.subjects.length) {
    h += `<div class="card"><b>Adicionar rápido</b><div class="row" style="margin:10px 0 8px"><input id="qa-title" placeholder="O que precisa ser feito?" maxlength="120" aria-label="Título"></div>
      <div class="grid2"><select id="qa-subj" aria-label="Disciplina">${state.subjects.map(s => `<option value="${s.id}">${esc((s.icon ? s.icon + ' ' : '') + s.name)}</option>`).join('')}</select><input type="date" id="qa-date" value="${ymd(addDays(new Date(), 1))}" aria-label="Data de entrega"></div>
      <div class="row" style="margin-top:10px"><button class="btn primary grow" data-a="quickAdd">Adicionar</button><button class="btn" data-a="quickMore">Mais opções</button></div></div>`;
  }
  if (urgent.length) {
    h += `<div class="sec-head"><h2>Atenção</h2><button class="link" data-a="go" data-to="upcoming">Próximas entregas</button></div>${urgent.slice(0, 5).map(actItem).join('')}`;
    if (urgent.length > 5) h += `<button class="btn block" data-a="go" data-to="activities/soon">Ver todas (${urgent.length})</button>`;
  } else if (state.activities.length) {
    h += `<div class="empty"><div class="big">🎉</div><b>Nada urgente!</b>Você não tem entregas atrasadas, de hoje ou dos próximos dias.</div>`;
  }
  if (state.subjects.length) {
    h += `<div class="sec-head"><h2>Disciplinas</h2></div><div class="subj-grid">${state.subjects.map(s => {
      const sp = P.filter(a => a.subjectId === s.id), ss = sp.filter(a => isToday(a) || isSoon(a)), sl = sp.filter(isOverdue);
      return `<button class="subj" style="--c:${s.color}" data-a="go" data-to="subject/${s.id}"><span class="em">${esc(s.icon || '📘')}</span><span class="nm">${esc(s.name)}</span><span class="small muted">${sp.length} pendente${sp.length === 1 ? '' : 's'}</span>${ss.length ? `<span class="small" style="color:var(--warn)">⏰ ${ss.length} com prazo próximo</span>` : ''}${sl.length ? `<span class="small late">${sl.length} atrasada${sl.length === 1 ? '' : 's'}</span>` : ''}</button>`;
    }).join('')}<button class="subj new" data-a="newSubj"><span class="em">＋</span><span>Nova disciplina</span></button></div>`;
  }
  h += `<div class="sec-head"><h2>Atalhos</h2></div><div class="grid2">
    <button class="btn" data-a="go" data-to="upcoming">${ICON.clock} Próximas entregas</button>
    <button class="btn" data-a="go" data-to="activities/pending">${ICON.list} Todas as tarefas</button>
    <button class="btn" data-a="go" data-to="progress">${ICON.chart} Progresso</button>
    <button class="btn" data-a="go" data-to="history">${ICON.history} Histórico</button>
    <button class="btn" data-a="go" data-to="files">${ICON.folder} Meus arquivos</button>
    <button class="btn" data-a="go" data-to="focus">${ICON.focus} Modo foco</button></div>`;
  return { title: 'Início', html: h };
};

/* ===================== Lista de atividades (filtros, ordenação, busca) ===================== */
const L = { filter: 'pending', sort: 'due', q: '', subject: '', fixed: null };
const FILTERS = [['pending', 'Pendentes'], ['today', 'Hoje'], ['soon', 'Prazo próximo'], ['overdue', 'Atrasadas'], ['high', 'Alta prioridade'], ['doing', 'Em andamento'], ['done', 'Concluídas']];
function filteredActs() {
  const q = norm(L.q);
  const arr = state.activities.filter(a => {
    if (L.subject && a.subjectId !== L.subject) return false;
    switch (L.filter) {
      case 'pending': if (!isPending(a)) return false; break;
      case 'today': if (!isToday(a)) return false; break;
      case 'soon': if (!(isToday(a) || isSoon(a))) return false; break;
      case 'overdue': if (!isOverdue(a)) return false; break;
      case 'high': if (!(isPending(a) && a.priority === 'high')) return false; break;
      case 'doing': if (a.status !== 'doing') return false; break;
      case 'done': if (a.status !== 'done') return false; break;
    }
    if (q && !norm(`${a.title} ${a.desc} ${(subj(a.subjectId) || {}).name}`).includes(q)) return false;
    return true;
  });
  return sortActs(arr, L.sort);
}
function listItemsHTML() {
  const arr = filteredActs();
  if (arr.length) return arr.map(actItem).join('');
  if (!state.activities.length) return emptyState('📝', 'Nenhuma atividade ainda', 'Cadastre sua primeira atividade para começar.', `<br><button class="btn primary" data-a="newAct"${L.fixed ? ` data-subj="${L.fixed}"` : ''}>Nova atividade</button>`);
  return emptyState('🔍', 'Nada por aqui', 'Nenhuma atividade corresponde a este filtro ou busca.');
}
function listControls() {
  return `<div class="chips" role="tablist">${FILTERS.map(([k, l]) => `<button class="chip ${L.filter === k ? 'on' : ''}" data-a="setFilter" data-v="${k}">${l}</button>`).join('')}</div>
  <div class="row" style="margin-bottom:8px"><input id="l-q" type="search" placeholder="Buscar por título, descrição ou disciplina" value="${esc(L.q)}" aria-label="Buscar"></div>
  <div class="grid2" style="margin-bottom:12px"><select id="l-sort" aria-label="Ordenar por">${[['due', 'Ordenar: entrega'], ['priority', 'Ordenar: prioridade'], ['subject', 'Ordenar: disciplina'], ['created', 'Ordenar: cadastro']].map(([k, l]) => `<option value="${k}" ${L.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
  ${L.fixed ? '<div></div>' : `<select id="l-subj" aria-label="Disciplina"><option value="">Todas as disciplinas</option>${state.subjects.map(s => `<option value="${s.id}" ${L.subject === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`}</div>
  <div id="list">${listItemsHTML()}</div>`;
}
VIEWS.activities = arg => {
  if (state.routeChanged) { L.filter = FILTERS.some(f => f[0] === arg) ? arg : 'pending'; L.q = ''; L.subject = ''; L.sort = state.settings.defaultSort; }
  L.fixed = null;
  return { title: 'Atividades', back: true, html: listControls(), actions: `<button class="icon-btn" data-a="newAct" aria-label="Nova atividade">${ICON.plus.replace('width="26" height="26"', 'width="22" height="22"')}</button>` };
};
VIEWS.subject = id => {
  const s = subj(id);
  if (!s) return { title: 'Disciplina', back: true, html: emptyState('❓', 'Disciplina não encontrada', 'Ela pode ter sido excluída.', '<br><button class="btn" data-a="go" data-to="home">Ir para o início</button>') };
  if (state.routeChanged) { L.filter = 'pending'; L.q = ''; L.sort = state.settings.defaultSort; }
  L.fixed = id; L.subject = id;
  const all = state.activities.filter(a => a.subjectId === id), pend = all.filter(isPending), done = all.length - pend.length;
  const pct = all.length ? Math.round(done / all.length * 100) : 0;
  const html = `<div class="card" style="border-top:5px solid ${s.color}"><div class="row"><span style="font-size:30px">${esc(s.icon || '📘')}</span><div class="grow"><b style="font-size:18px;overflow-wrap:anywhere">${esc(s.name)}</b><div class="small muted">${pend.length} pendente${pend.length === 1 ? '' : 's'} · ${done} concluída${done === 1 ? '' : 's'}</div></div><button class="ibtn" data-a="editSubj" data-id="${id}" aria-label="Editar disciplina">${ICON.edit}</button></div><div class="bar" style="--c:${s.color};margin-top:12px"><i style="width:${pct}%"></i></div></div>
  <button class="btn primary block" style="margin-bottom:14px" data-a="newAct" data-subj="${id}">＋ Nova atividade em ${esc(s.name)}</button>${listControls()}`;
  return { title: s.name, back: true, html };
};
function updateList() { const el = $('#list'); if (el) el.innerHTML = listItemsHTML(); }

/* ===================== Próximas entregas ===================== */
VIEWS.upcoming = () => {
  const P = sortActs(state.activities.filter(isPending), 'due');
  if (!P.length) return { title: 'Próximas entregas', back: true, html: emptyState('🎉', 'Sem entregas pendentes', 'Quando você cadastrar atividades, elas aparecem aqui em ordem cronológica.') };
  const groups = [];
  for (const a of P) {
    const d = dueOf(a);
    let label;
    if (isOverdue(a)) label = 'Atrasadas';
    else { const diff = Math.round((sod(d) - sod(new Date())) / DAY); label = diff === 0 ? 'Hoje' : diff === 1 ? 'Amanhã' : `${DIAS_LONGO[d.getDay()]}, ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`; }
    let g = groups.find(x => x.label === label);
    if (!g) { g = { label, items: [] }; groups.push(g); }
    g.items.push(a);
  }
  return { title: 'Próximas entregas', back: true, html: groups.map(g => `<div class="dayhead ${g.label === 'Hoje' ? 'today' : ''}" ${g.label === 'Atrasadas' ? 'style="color:var(--danger)"' : ''}>${g.label}<span class="muted small">${g.items.length}</span></div>${g.items.map(actItem).join('')}`).join('') };
};

/* ===================== Calendário ===================== */
function groupByDay() {
  const m = {};
  for (const a of sortActs(state.activities, 'due')) { const d = dueOf(a); if (d) (m[ymd(d)] = m[ymd(d)] || []).push(a); }
  return m;
}
VIEWS.calendar = () => {
  const c = state.cal, by = groupByDay();
  const dayList = (d, withAdd) => {
    const items = by[ymd(d)] || [];
    return `<div class="dayhead ${ymd(d) === ymd(new Date()) ? 'today' : ''}"><span>${DIAS_LONGO[d.getDay()]}, ${pad(d.getDate())}/${pad(d.getMonth() + 1)}</span><button class="link" data-a="newAct" data-date="${ymd(d)}">＋ Adicionar</button></div>${items.length ? items.map(actItem).join('') : `<div class="muted small" style="padding:4px 2px 8px">Nenhuma entrega neste dia.</div>`}`;
  };
  let title, body;
  if (c.mode === 'month') {
    const y = c.date.getFullYear(), m = c.date.getMonth();
    title = `${MESES[m]} ${y}`;
    const start = addDays(new Date(y, m, 1), -new Date(y, m, 1).getDay());
    let cells = DIAS.map(d => `<div class="cal-dow">${d}</div>`).join('');
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i), k = ymd(d), items = by[k] || [];
      const cls = [d.getMonth() !== m ? 'out' : '', k === ymd(new Date()) ? 'today' : '', k === ymd(c.sel) ? 'sel' : ''].join(' ');
      cells += `<button class="cell ${cls}" data-a="calSel" data-d="${k}" aria-label="${fmtDate(d)}, ${items.length} atividade(s)"><span class="dn">${d.getDate()}</span><span class="dots">${items.slice(0, 3).map(a => `<i style="background:${colorOf(a)}" class="${a.status === 'done' ? 'dn2' : ''}"></i>`).join('')}${items.length > 3 ? '<b>+</b>' : ''}</span>${items.some(a => a.priority === 'high' && isPending(a)) ? '<em class="hp">!</em>' : ''}</button>`;
    }
    body = `<div class="cal-grid">${cells}</div>${dayList(c.sel)}`;
  } else if (c.mode === 'week') {
    const s = addDays(sod(c.date), -c.date.getDay()), e = addDays(s, 6);
    title = `${pad(s.getDate())}/${pad(s.getMonth() + 1)} – ${pad(e.getDate())}/${pad(e.getMonth() + 1)}`;
    body = Array.from({ length: 7 }, (_, i) => dayList(addDays(s, i))).join('');
  } else {
    title = fmtDate(c.date);
    body = dayList(c.date);
  }
  const html = `<div class="seg" style="margin-bottom:12px">${[['month', 'Mês'], ['week', 'Semana'], ['day', 'Dia']].map(([k, l]) => `<button class="${c.mode === k ? 'on' : ''}" data-a="calMode" data-v="${k}">${l}</button>`).join('')}</div>
  <div class="cal-head"><button class="icon-btn" data-a="calNav" data-v="-1" aria-label="Anterior">${ICON.back}</button><b>${title}</b><button class="icon-btn" data-a="calNav" data-v="1" aria-label="Próximo" style="transform:scaleX(-1)">${ICON.back}</button></div>
  <div style="margin-bottom:6px"><button class="link" data-a="calToday">Ir para hoje</button></div>${body}`;
  return { title: 'Calendário', html };
};

/* ===================== Meus arquivos ===================== */
const F = { q: '', subject: '' };
function filesListHTML() {
  const q = norm(F.q);
  const arr = state.files.filter(f => (!F.subject || f.subjectId === F.subject) && (!q || norm(f.name).includes(q))).sort((a, b) => b.addedAt - a.addedAt);
  if (!arr.length) return state.files.length ? emptyState('🔍', 'Nenhum arquivo encontrado', 'Tente outra busca ou filtro.') : emptyState('📁', 'Nenhum arquivo ainda', 'Envie PDFs, documentos, apresentações, planilhas e imagens para ter tudo em um só lugar.', '<br><button class="btn primary" data-a="pickUpload">Enviar arquivos</button>');
  return arr.map(f => {
    const act = state.activities.find(a => a.id === f.activityId), s = subj(f.subjectId);
    const ext = extOf(f.name);
    return `<div class="frow"><div class="ext ${ext}">${esc(ext)}</div><div class="grow"><div style="font-weight:600;overflow-wrap:anywhere">${esc(f.name)}</div><div class="small muted">${fmtSize(f.size)} · ${fmtDate(new Date(f.addedAt))}${s ? ' · ' + esc(s.name) : ''}</div>${act ? `<div class="small"><a href="#" data-a="openAct" data-id="${act.id}" style="color:var(--primary)">${ICON.clip} ${esc(act.title)}</a></div>` : '<div class="small muted">Sem atividade vinculada</div>'}
      <div class="facts"><button class="ibtn" data-a="fileOpen" data-id="${f.id}" aria-label="Abrir">${ICON.open}</button><button class="ibtn" data-a="fileDl" data-id="${f.id}" aria-label="Baixar">${ICON.download}</button><button class="ibtn" data-a="fileShare" data-id="${f.id}" aria-label="Compartilhar">${ICON.share}</button><button class="ibtn" data-a="fileReplace" data-id="${f.id}" aria-label="Substituir">${ICON.swap}</button><button class="ibtn d" data-a="fileDel" data-id="${f.id}" aria-label="Excluir">${ICON.trash}</button></div></div></div>`;
  }).join('');
}
VIEWS.files = () => ({
  title: 'Meus arquivos',
  actions: `<button class="icon-btn" data-a="pickUpload" aria-label="Enviar arquivos">${ICON.plus.replace('width="26" height="26"', 'width="22" height="22"')}</button><button class="icon-btn" data-a="go" data-to="search" aria-label="Buscar">${ICON.search}</button>`,
  html: `<div class="grid2" style="margin-bottom:12px"><input id="fl-q" type="search" placeholder="Buscar arquivo" value="${esc(F.q)}" aria-label="Buscar arquivo"><select id="fl-subj" aria-label="Disciplina"><option value="">Todas as disciplinas</option>${state.subjects.map(s => `<option value="${s.id}" ${F.subject === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div><div id="flist">${filesListHTML()}</div><p id="storage-info" class="small muted" style="text-align:center"></p>`,
  after: async () => {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate(); const el = $('#storage-info');
        const used = state.files.reduce((n, f) => n + f.size, 0);
        if (el) el.textContent = `${state.files.length} arquivo(s) · ${fmtSize(used)} usados pelos anexos${e.quota ? ` · espaço disponível estimado: ${fmtSize(Math.max(0, e.quota - e.usage))}` : ''}`;
      }
    } catch (err) { /* informativo apenas */ }
  }
});

/* ===================== Progresso ===================== */
function donut(parts, size = 130) {
  const r = 48, C = 2 * Math.PI * r, tot = parts.reduce((n, p) => n + p.v, 0);
  let off = 0;
  const segs = tot ? parts.filter(p => p.v).map(p => { const len = p.v / tot * C; const s = `<circle cx="60" cy="60" r="${r}" fill="none" stroke="${p.c}" stroke-width="16" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 60 60)"/>`; off += len; return s; }).join('') : `<circle cx="60" cy="60" r="${r}" fill="none" stroke="var(--line)" stroke-width="16"/>`;
  return `<svg viewBox="0 0 120 120" width="${size}" height="${size}" role="img" aria-label="Distribuição das atividades">${segs}</svg>`;
}
VIEWS.progress = () => {
  const A = state.activities, total = A.length;
  if (!total) return { title: 'Progresso', back: true, html: emptyState('📊', 'Sem dados ainda', 'Cadastre atividades para acompanhar seu progresso.') };
  const done = A.filter(a => a.status === 'done').length, late = A.filter(isOverdue).length;
  const doing = A.filter(a => a.status === 'doing' && !isOverdue(a)).length, pend = A.filter(a => a.status === 'pending' && !isOverdue(a)).length;
  const pct = Math.round(done / total * 100);
  const weeks = [];
  const w0 = addDays(sod(new Date()), -new Date().getDay());
  for (let i = 5; i >= 0; i--) {
    const s = addDays(w0, -7 * i), e = addDays(s, 7);
    weeks.push({ label: `${pad(s.getDate())}/${pad(s.getMonth() + 1)}`, n: A.filter(a => a.completedAt && a.completedAt >= s.getTime() && a.completedAt < e.getTime()).length });
  }
  const mx = Math.max(1, ...weeks.map(w => w.n));
  const byS = state.subjects.map(s => { const l = A.filter(a => a.subjectId === s.id), d = l.filter(a => a.status === 'done').length; return { s, t: l.length, d, p: l.length ? Math.round(d / l.length * 100) : 0 }; }).filter(x => x.t);
  const html = `<div class="stats"><div class="stat"><b>${total}</b><span>Cadastradas</span></div><div class="stat" style="--c:#0ea5e9"><b>${total - done}</b><span>Pendentes</span></div><div class="stat" style="--c:var(--ok)"><b>${done}</b><span>Concluídas</span></div><div class="stat" style="--c:var(--danger)"><b>${late}</b><span>Atrasadas</span></div></div>
  <div class="card"><div class="donutwrap">${donut([{ v: done, c: '#16a34a' }, { v: doing, c: '#4f46e5' }, { v: pend, c: '#0ea5e9' }, { v: late, c: '#dc2626' }])}<div class="legend"><div style="font-size:30px;font-weight:800">${pct}%</div><div class="muted small" style="margin-top:-6px">de conclusão geral</div><div><i style="background:#16a34a"></i>Concluídas ${done}</div><div><i style="background:#4f46e5"></i>Em andamento ${doing}</div><div><i style="background:#0ea5e9"></i>Pendentes ${pend}</div><div><i style="background:#dc2626"></i>Atrasadas ${late}</div></div></div></div>
  <h2>Por disciplina</h2><div class="card">${byS.map(x => `<div style="margin-bottom:14px"><div class="row" style="justify-content:space-between;margin-bottom:6px"><span style="overflow-wrap:anywhere">${esc((x.s.icon || '') + ' ' + x.s.name)}</span><b>${x.p}%</b></div><div class="bar" style="--c:${x.s.color}"><i style="width:${x.p}%"></i></div><div class="small muted" style="margin-top:3px">${x.d} de ${x.t} concluídas</div></div>`).join('')}</div>
  <h2>Concluídas por semana</h2><div class="card"><div class="bars">${weeks.map(w => `<div><span>${w.n}</span><i style="height:${Math.round(w.n / mx * 80)}px"></i><span>${w.label}</span></div>`).join('')}</div></div>`;
  return { title: 'Progresso', back: true, html };
};

/* ===================== Histórico ===================== */
const H = { subject: '', type: '', period: 'all', kind: 'done' };
function allTypes() { return [...new Set([...DEFAULT_TYPES, ...(state.settings.customTypes || []), ...state.activities.map(a => a.type).filter(Boolean)])]; }
VIEWS.history = () => {
  const now = Date.now();
  const days = H.period === 'all' ? 0 : +H.period;
  let arr = state.activities.filter(a => {
    if (H.kind === 'done' ? a.status !== 'done' : !(dueOf(a) < sod(new Date()))) return false;
    if (H.subject && a.subjectId !== H.subject) return false;
    if (H.type && a.type !== H.type) return false;
    const ref = a.status === 'done' && a.completedAt ? a.completedAt : dueOf(a).getTime();
    if (days && ref < now - days * DAY) return false;
    return true;
  });
  arr = arr.sort((a, b) => ((b.completedAt || dueOf(b).getTime()) - (a.completedAt || dueOf(a).getTime())));
  const html = `<div class="seg" style="margin-bottom:10px"><button class="${H.kind === 'done' ? 'on' : ''}" data-a="histKind" data-v="done">Concluídas</button><button class="${H.kind === 'old' ? 'on' : ''}" data-a="histKind" data-v="old">Todas as antigas</button></div>
  <div class="grid2" style="margin-bottom:8px"><select id="h-subj" aria-label="Disciplina"><option value="">Todas as disciplinas</option>${state.subjects.map(s => `<option value="${s.id}" ${H.subject === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select><select id="h-type" aria-label="Tipo"><option value="">Todos os tipos</option>${allTypes().map(t => `<option ${H.type === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
  <select id="h-per" style="margin-bottom:12px" aria-label="Período">${[['all', 'Todo o período'], ['7', 'Últimos 7 dias'], ['30', 'Últimos 30 dias'], ['90', 'Últimos 90 dias'], ['365', 'Último ano']].map(([k, l]) => `<option value="${k}" ${H.period === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
  ${arr.length ? arr.map(a => actItem(a) + (a.completedAt ? `<div class="small muted" style="margin:-4px 4px 10px 8px">Concluída em ${fmtDT(new Date(a.completedAt))}</div>` : '')).join('') : emptyState('🗂️', 'Nada no histórico', H.kind === 'done' ? 'As atividades concluídas aparecem aqui e nunca são apagadas automaticamente.' : 'Nenhuma atividade antiga com esses filtros.')}`;
  return { title: 'Histórico', back: true, html };
};

/* ===================== Busca global ===================== */
let SQ = '';
function searchResultsHTML() {
  const q = norm(SQ);
  if (q.length < 1) return `<div class="muted" style="text-align:center;padding:30px 10px">Digite para buscar em atividades e arquivos.</div>`;
  const acts = sortActs(state.activities.filter(a => norm(`${a.title} ${a.desc} ${a.notes} ${(subj(a.subjectId) || {}).name}`).includes(q)), 'due');
  const files = state.files.filter(f => norm(f.name).includes(q));
  let h = '';
  if (acts.length) h += `<h2>Atividades (${acts.length})</h2>${acts.map(actItem).join('')}`;
  if (files.length) h += `<h2>Arquivos (${files.length})</h2>${files.map(f => `<div class="frow"><div class="ext ${extOf(f.name)}">${esc(extOf(f.name))}</div><div class="grow"><div style="font-weight:600;overflow-wrap:anywhere">${esc(f.name)}</div><div class="small muted">${fmtSize(f.size)}</div></div><button class="ibtn" data-a="fileOpen" data-id="${f.id}" aria-label="Abrir">${ICON.open}</button></div>`).join('')}`;
  return h || emptyState('🔍', 'Nenhum resultado', 'Tente outras palavras.');
}
VIEWS.search = () => {
  if (state.routeChanged) SQ = '';
  return { title: 'Buscar', back: true, actions: '', html: `<input id="s-q" type="search" placeholder="Buscar atividades e arquivos" value="${esc(SQ)}" autofocus aria-label="Buscar"><div id="sres" style="margin-top:8px">${searchResultsHTML()}</div>` };
};

/* ===================== Modo foco ===================== */
const timerLeft = () => { const t = state.timer; if (!t) return 0; return t.running ? Math.max(0, Math.round((t.end - Date.now()) / 1000)) : t.left; };
const mmss = s => `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
VIEWS.focus = arg => {
  const t = state.timer;
  let html;
  if (!t) {
    const pend = sortActs(state.activities.filter(isPending), 'due');
    html = `<div class="card"><p class="muted" style="margin-top:0">Escolha o tempo e, se quiser, a atividade em que vai trabalhar.</p>
      <label class="field"><span>Atividade (opcional)</span><select id="fo-act"><option value="">— sem atividade —</option>${pend.map(a => `<option value="${a.id}" ${a.id === arg ? 'selected' : ''}>${esc(a.title)}</option>`).join('')}</select></label>
      <div class="seg" style="margin-bottom:10px">${[15, 25, 45, 60].map(m => `<label><input type="radio" name="fomin" value="${m}" ${m === 25 ? 'checked' : ''}><span>${m} min</span></label>`).join('')}</div>
      <label class="field"><span>Ou outra duração (minutos)</span><input id="fo-custom" type="number" min="1" max="240" inputmode="numeric" placeholder="Ex.: 30"></label>
      <button class="btn primary block" data-a="focusStart">${ICON.play} Iniciar sessão</button></div>`;
  } else {
    const left = timerLeft(), a = state.activities.find(x => x.id === t.actId);
    const C = 2 * Math.PI * 90;
    html = `<div class="card"><div class="timer"><div class="ringwrap"><svg viewBox="0 0 200 200" width="240" height="240"><circle cx="100" cy="100" r="90" fill="none" stroke="var(--line)" stroke-width="12"/><circle id="ring" cx="100" cy="100" r="90" fill="none" stroke="var(--primary)" stroke-width="12" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - (t.total ? left / t.total : 0))}" transform="rotate(-90 100 100)"/></svg><span class="t" id="tm">${mmss(left)}</span></div></div>
      <p style="text-align:center" class="muted">${t.done ? '🎉 Sessão concluída! Bom trabalho.' : (a ? 'Focando em: ' + esc(a.title) : 'Sessão de foco')}</p>
      <div class="row">${t.done ? '' : `<button class="btn primary grow" data-a="${t.running ? 'focusPause' : 'focusResume'}">${t.running ? ICON.pause + ' Pausar' : ICON.play + ' Retomar'}</button>`}<button class="btn grow" data-a="focusReset">${t.done ? 'Nova sessão' : 'Cancelar'}</button></div></div>`;
  }
  return { title: 'Modo foco', back: true, html };
};
function finishTimer() {
  const t = state.timer; if (!t || t.done) return;
  t.running = false; t.left = 0; t.done = true;
  const a = state.activities.find(x => x.id === t.actId);
  if (a) { a.focusMin = (a.focusMin || 0) + Math.round(t.total / 60); DB.put('activities', a).catch(() => toast('Não foi possível registrar o tempo de foco.', { err: true })); }
  showNotif('Sessão de foco concluída', a ? a.title : 'Hora de uma pausa!', 'focus');
  try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (e) { /* opcional */ }
  if (state.route && state.route.name === 'focus') render();
}
function timerUI() {
  const t = state.timer; if (!t || !state.route || state.route.name !== 'focus') return;
  if (t.running && timerLeft() <= 0) return finishTimer();
  const left = timerLeft(), tm = $('#tm'), ring = $('#ring');
  if (tm) tm.textContent = mmss(left);
  if (ring) { const C = 2 * Math.PI * 90; ring.setAttribute('stroke-dashoffset', C * (1 - (t.total ? left / t.total : 0))); }
}

/* ===================== Configurações ===================== */
VIEWS.settings = () => {
  const s = state.settings;
  const notifTxt = { granted: '✅ Notificações ativadas', denied: '🚫 Notificações bloqueadas', default: 'Notificações ainda não ativadas', unsupported: 'Notificações indisponíveis neste modo' }[state.notif];
  const help = notifHelp();
  const prof = state.profiles.find(p => p.id === (state.user && state.user.id));
  const myName = (prof && prof.display_name) || (state.user && state.user.name) || '';
  const cs = Cloud.status;
  const html = `<h2>Conta</h2><div class="card"><div class="row" style="gap:14px;align-items:center">${avatarHTML(state.user && state.user.id, 72, myName)}<div class="grow" style="min-width:0"><div style="font-weight:700;font-size:17px;overflow-wrap:anywhere">${esc(myName || 'Sem nome')}</div><div class="muted small" style="overflow-wrap:anywhere">${esc((state.user && state.user.email) || '')}</div></div></div>
    <div class="grid2" style="margin-top:12px"><button class="btn" data-a="pickAvatar">${prof && prof.avatar_path ? 'Trocar foto' : 'Adicionar foto'}</button>${prof && prof.avatar_path ? '<button class="btn ghost-danger" data-a="removeAvatar">Remover foto</button>' : ''}</div><input type="file" id="av-file" accept="image/*" hidden>
    <p class="small muted" style="margin:6px 0 0">Sua foto é visível para você e para quem participa das mesmas turmas que você.</p>
    <div class="row" style="margin:10px 0 0;gap:8px;flex-wrap:wrap"><span class="sync-chip ${syncKind()}" style="cursor:default">${syncChipInner()}</span></div>
    ${cs.error ? `<p class="small" style="color:var(--danger);margin:8px 0 0">${esc(cs.error)}</p>` : ''}
    <div class="grid2" style="margin-top:12px"><button class="btn" data-a="syncNow">Sincronizar agora</button><button class="btn" data-a="editName">Alterar nome</button><button class="btn" data-a="changePass">Alterar senha</button><button class="btn" data-a="signOut">Sair da conta</button></div>
    ${cs.failed ? '<button class="btn block" style="margin-top:10px" data-a="retryFailed">Tentar enviar de novo os itens com erro</button>' : ''}</div>
  <h2>Aparência</h2><div class="card"><div class="seg">${[['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Escuro']].map(([k, l]) => `<button class="${s.theme === k ? 'on' : ''}" data-a="setTheme" data-v="${k}">${l}</button>`).join('')}</div></div>
  <h2>Notificações</h2><div class="card"><div style="font-weight:600">${notifTxt}</div>${help ? `<p class="small muted">${esc(help)}</p>` : ''}${state.notif === 'default' ? '<button class="btn primary block" style="margin-top:10px" data-a="notifEnable">Ativar notificações</button>' : ''}
    <div class="hr"></div><div style="font-weight:600;margin-bottom:6px">Lembretes padrão para novas atividades</div>${REM_OPTIONS.map(([k, l]) => `<label class="setrow"><input type="checkbox" class="defrem" value="${k}" ${s.defaultReminders.includes(k) ? 'checked' : ''}>${l}</label>`).join('')}
    <p class="small muted">${Native ? 'Os lembretes são agendados no sistema e chegam mesmo com o app fechado.' : 'Na versão web, os lembretes são disparados enquanto o app está aberto ou ativo em segundo plano. Para lembretes garantidos com o app fechado, use a versão instalada via Xcode (veja o README).'}</p></div>
  <h2>Disciplinas</h2><div class="card">${state.subjects.length ? state.subjects.map(x => `<div class="row" style="padding:6px 0"><span class="dot" style="--c:${x.color};width:14px;height:14px"></span><span class="grow" style="overflow-wrap:anywhere">${esc((x.icon || '') + ' ' + x.name)}</span><button class="ibtn" data-a="editSubj" data-id="${x.id}" aria-label="Editar ${esc(x.name)}">${ICON.edit}</button><button class="ibtn d" data-a="delSubj" data-id="${x.id}" aria-label="Excluir ${esc(x.name)}">${ICON.trash}</button></div>`).join('') : '<p class="muted small" style="margin-top:0">Nenhuma disciplina cadastrada.</p>'}<button class="btn block" style="margin-top:8px" data-a="newSubj">＋ Nova disciplina</button></div>
  <h2>Organização</h2><div class="card"><label class="field"><span>“Prazo próximo” significa até</span><select id="s-soon">${[1, 2, 3, 5, 7].map(n => `<option value="${n}" ${s.soonDays === n ? 'selected' : ''}>${n} dia${n > 1 ? 's' : ''}</option>`).join('')}</select></label>
    <label class="field"><span>Ordenação padrão das listas</span><select id="s-sort">${[['due', 'Data de entrega'], ['priority', 'Prioridade'], ['subject', 'Disciplina'], ['created', 'Data de cadastro']].map(([k, l]) => `<option value="${k}" ${s.defaultSort === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    ${(s.customTypes || []).length ? `<div class="small muted" style="margin-bottom:6px">Tipos de atividade personalizados</div>${s.customTypes.map((t, i) => `<div class="row" style="padding:4px 0"><span class="grow">${esc(t)}</span><button class="ibtn d" data-a="rmType" data-i="${i}" aria-label="Remover tipo ${esc(t)}">${ICON.trash}</button></div>`).join('')}` : ''}</div>
  <h2>Dados e backup</h2><div class="card"><div class="grid2"><button class="btn" data-a="exportJson">Exportar JSON</button><button class="btn" data-a="exportCsv">Exportar CSV</button></div>
    <button class="btn block" style="margin-top:10px" data-a="backupFull">Backup completo (com arquivos)</button><button class="btn block" style="margin-top:10px" data-a="restorePick">Restaurar backup</button>
    <p class="small muted">O JSON e o CSV trazem só os dados das atividades. O backup completo inclui disciplinas, atividades, configurações e os arquivos anexados.</p>
    <button class="btn block ghost-danger" data-a="wipe">Apagar todos os dados</button></div>
  <h2>Dados antigos</h2><div class="card small"><span class="muted">Se você usou o app antes de existirem as contas, os dados daquela época podem estar neste aparelho.</span><div class="grid2" style="margin-top:10px"><button class="btn" data-a="legacyImport">Importar dados antigos</button><button class="btn ghost-danger" data-a="legacyRemove">Remover do aparelho</button></div></div>
  <h2>Créditos</h2><div class="card credits"><div class="muted small">Idealizado e criado por</div><div class="credit-name">Bruno Gordiano</div><div class="muted small">Lume · versão 2.1</div></div>
  <h2>Sobre</h2><div class="card small"><b>Lume</b> · organizador escolar · versão 2.1<br><span class="muted">Seus dados ficam na sua conta (nuvem) e uma cópia é guardada neste aparelho para funcionar sem internet. Alterações feitas offline são enviadas quando a conexão voltar. Arquivos novos só chegam à nuvem quando houver internet.</span></div>`;
  return { title: 'Perfil e ajustes', html };
};

/* ===================== Disciplinas: formulário e exclusão ===================== */
function openSubjForm(id) {
  const s = id ? subj(id) : null;
  state.form = { type: 'subj', id };
  const color = s ? s.color : COLORS[state.subjects.length % COLORS.length];
  openSheet(`${sheetHead(s ? 'Editar disciplina' : 'Nova disciplina')}<div class="sheet-body">
    <label class="field"><span>Nome *</span><input id="sf-name" maxlength="40" value="${esc(s ? s.name : '')}" placeholder="Ex.: Matemática"></label>
    <div class="field"><span>Cor</span><div class="swatches">${COLORS.map(c => `<label><input type="radio" name="sf-color" value="${c}" ${c === color ? 'checked' : ''}><span style="--c:${c}"></span></label>`).join('')}</div></div>
    <div class="field"><span>Ícone (opcional)</span><div class="swatches emoji">${EMOJIS.map(e => `<label><input type="radio" name="sf-icon" value="${e}" ${(s ? s.icon || '' : '') === e ? 'checked' : ''}><span aria-label="${e || 'Sem ícone'}">${e || '∅'}</span></label>`).join('')}</div></div>
  </div><div class="sheet-foot"><button class="btn" data-a="closeSheet">Cancelar</button><button class="btn primary" data-a="saveSubj">Salvar</button></div>`);
}
async function saveSubj() {
  const name = $('#sf-name').value.trim();
  if (!name) return fieldErr('sf-name', 'Informe o nome da disciplina.');
  const id = state.form.id;
  if (state.subjects.some(x => x.id !== id && norm(x.name) === norm(name))) return fieldErr('sf-name', 'Já existe uma disciplina com esse nome.');
  const prev = id ? subj(id) : null;
  const rec = { id: id || uid(), name, color: $('input[name=sf-color]:checked').value, icon: $('input[name=sf-icon]:checked').value, createdAt: prev ? prev.createdAt : Date.now() };
  try { await DB.put('subjects', rec); closeSheet(); await refresh(); toast(okMsg('Disciplina salva.')); }
  catch (e) { toast('Não foi possível salvar: ' + errMsg(e), { err: true }); }
}
async function deleteSubj(id) {
  const s = subj(id); if (!s) return;
  const acts = state.activities.filter(a => a.subjectId === id);
  const files = state.files.filter(f => f.subjectId === id);
  if (!acts.length && !files.length) {
    if (await confirmDlg('Excluir disciplina?', `A disciplina <b>${esc(s.name)}</b> será excluída.`)) await doDeleteSubj(id, 'delete');
    return;
  }
  const others = state.subjects.filter(x => x.id !== id);
  const actions = [];
  if (others.length) actions.push({ label: 'Mover para outra disciplina', value: 'move' });
  actions.push({ label: 'Excluir tudo (atividades e arquivos)', kind: 'danger', value: 'delete' }, { label: 'Cancelar', value: null });
  const r = await dialog({ title: `Excluir “${s.name}”?`, msg: `Ela tem <b>${acts.length}</b> atividade(s) e <b>${files.length}</b> arquivo(s). O que fazer com elas?`, actions });
  if (r === 'delete') { if (await confirmDlg('Tem certeza?', 'As atividades e os arquivos dessa disciplina serão apagados definitivamente.', 'Excluir tudo')) await doDeleteSubj(id, 'delete'); }
  else if (r === 'move') {
    state.form = { type: 'move', id };
    openSheet(`${sheetHead('Mover para qual disciplina?')}<div class="sheet-body"><label class="field"><span>Disciplina de destino</span><select id="mv-to">${others.map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}</select></label></div><div class="sheet-foot"><button class="btn" data-a="closeSheet">Cancelar</button><button class="btn primary" data-a="confirmMove">Mover e excluir “${esc(s.name)}”</button></div>`);
  }
}
async function doDeleteSubj(id, mode, target) {
  try {
    const acts = state.activities.filter(a => a.subjectId === id), files = state.files.filter(f => f.subjectId === id);
    if (mode === 'move') {
      await DB.putMany('activities', acts.map(a => ({ ...a, subjectId: target })));
      await DB.putMany('files', files.map(f => ({ ...f, subjectId: target })));
    } else {
      await DB.delMany('activities', acts.map(a => a.id));
      await DB.delMany('files', files.map(f => f.id));
    }
    await DB.del('subjects', id);
    closeSheet();
    if (state.route && state.route.name === 'subject' && state.route.arg === id) location.hash = '#/home';
    await refresh(); toast(okMsg('Disciplina excluída.'));
  } catch (e) { toast('Não foi possível excluir: ' + errMsg(e), { err: true }); }
}

/* ===================== Atividades: formulário ===================== */
function fieldErr(id, msg) {
  $$('.field.err').forEach(x => x.classList.remove('err'));
  const el = document.getElementById(id);
  if (el) { const f = el.closest('.field'); if (f) f.classList.add('err'); el.focus(); }
  toast(msg, { err: true });
}
const checkRow = (c = { t: '', done: false }) => `<div class="crow"><input type="checkbox" ${c.done ? 'checked' : ''} aria-label="Concluído"><input type="text" maxlength="100" value="${esc(c.t)}" placeholder="Etapa (ex.: pesquisar)"><button class="ibtn d" data-a="rmRow" aria-label="Remover">${ICON.x}</button></div>`;
const remRow = (v = '') => `<div class="crow"><input type="datetime-local" value="${esc(v)}" aria-label="Lembrete em horário personalizado"><button class="ibtn d" data-a="rmRow" aria-label="Remover">${ICON.x}</button></div>`;
function formFilesHTML() {
  const f = state.form; if (!f || f.type !== 'act') return '';
  const old = f.id ? filesOf(f.id).filter(x => !f.removeFileIds.includes(x.id)) : [];
  const rows = [...old.map(x => `<div class="crow"><div class="ext ${extOf(x.name)}" style="width:36px;height:36px">${extOf(x.name)}</div><span class="grow small" style="overflow-wrap:anywhere">${esc(x.name)} · ${fmtSize(x.size)}</span><button class="ibtn d" data-a="rmOldFile" data-id="${x.id}" aria-label="Remover anexo">${ICON.x}</button></div>`),
    ...f.newFiles.map((x, i) => `<div class="crow"><div class="ext ${extOf(x.name)}" style="width:36px;height:36px">${extOf(x.name)}</div><span class="grow small" style="overflow-wrap:anywhere">${esc(x.name)} · ${fmtSize(x.size)} <i class="muted">(novo)</i></span><button class="ibtn d" data-a="rmNewFile" data-i="${i}" aria-label="Remover anexo">${ICON.x}</button></div>`)];
  return rows.join('') || '<div class="small muted" style="margin-bottom:8px">Nenhum arquivo anexado.</div>';
}
function openActForm(o = {}) {
  if (!state.subjects.length) { toast('Crie uma disciplina antes de cadastrar atividades.'); openSubjForm(); return; }
  const a = o.id ? state.activities.find(x => x.id === o.id) : null;
  state.form = { type: 'act', id: a ? a.id : null, isNew: !a, newFiles: [], removeFileIds: [] };
  const due = a ? dueOf(a) : null;
  const d = a ? ymd(due) : (o.date || ymd(addDays(new Date(), 1)));
  const t = a ? fmtHM(due) : '23:59';
  const rem = a ? a.rem : { on: state.settings.defaultReminders.length > 0, keys: state.settings.defaultReminders, custom: [] };
  const types = [...new Set([...DEFAULT_TYPES, ...(state.settings.customTypes || []), ...(a && a.type ? [a.type] : [])])];
  const subjId = a ? a.subjectId : (o.subjectId || state.subjects[0].id);
  openSheet(`${sheetHead(a ? 'Editar atividade' : 'Nova atividade')}<div class="sheet-body">
    <label class="field"><span>Título *</span><input id="f-title" maxlength="120" value="${esc(a ? a.title : (o.title || ''))}" placeholder="Ex.: Lista de exercícios 3"></label>
    <div class="grid2"><label class="field"><span>Disciplina *</span><select id="f-subj">${state.subjects.map(s => `<option value="${s.id}" ${s.id === subjId ? 'selected' : ''}>${esc((s.icon ? s.icon + ' ' : '') + s.name)}</option>`).join('')}</select></label>
    <label class="field"><span>Tipo</span><select id="f-type">${types.map(x => `<option ${a && a.type === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}<option value="__new">Outro (personalizado)…</option></select></label></div>
    <label class="field" id="f-type-new-wrap" hidden><span>Nome do novo tipo</span><input id="f-type-new" maxlength="40"></label>
    <div class="grid2"><label class="field"><span>Data de entrega *</span><input type="date" id="f-date" value="${d}"></label><label class="field"><span>Horário</span><input type="time" id="f-time" value="${t}"></label></div>
    <div class="field"><span>Prioridade</span><div class="seg">${[['low', 'Baixa'], ['mid', 'Média'], ['high', 'Alta']].map(([k, l]) => `<label><input type="radio" name="prio" value="${k}" ${(a ? a.priority : 'mid') === k ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></div>
    <label class="field"><span>Status</span><select id="f-status">${Object.entries(STATUS).map(([k, l]) => `<option value="${k}" ${(a ? a.status : 'pending') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="field"><span>Descrição e instruções</span><textarea id="f-desc" maxlength="3000">${esc(a ? a.desc : '')}</textarea></label>
    <div class="field"><span>Checklist (etapas)</span><div id="f-check">${(a ? a.checklist || [] : []).map(checkRow).join('')}</div><button class="btn sm" data-a="addCheck">＋ Adicionar etapa</button></div>
    <label class="field"><span>Observações</span><textarea id="f-notes" maxlength="2000" style="min-height:60px">${esc(a ? a.notes : '')}</textarea></label>
    <div class="field"><span>Arquivos anexados</span><div id="f-files">${''}</div><button class="btn sm" data-a="pickFormFiles">${ICON.clip} Anexar arquivos</button></div>
    <div class="hr"></div>
    <label class="setrow"><input type="checkbox" id="f-rem-on" ${rem.on ? 'checked' : ''}><b>Lembretes para esta atividade</b></label>
    <div id="f-rem-box">${REM_OPTIONS.map(([k, l]) => `<label class="setrow"><input type="checkbox" name="rem" value="${k}" ${(rem.keys || []).includes(k) ? 'checked' : ''}>${l}</label>`).join('')}
    <div class="small muted" style="margin:8px 0 6px">Horários personalizados</div><div id="f-rem-c">${(rem.custom || []).map(remRow).join('')}</div><button class="btn sm" data-a="addRem">＋ Horário personalizado</button></div>
  </div><div class="sheet-foot"><button class="btn" data-a="closeSheet">Cancelar</button><button class="btn primary" data-a="saveAct">Salvar</button></div>`);
  renderFormFiles();
  setTimeout(() => { if (!a) { const el = $('#f-title'); el && el.focus(); } }, 250);
}
function renderFormFiles() { const el = $('#f-files'); if (el) el.innerHTML = formFilesHTML(); }
function findDup(title, subjectId, exceptId) {
  const n = norm(title);
  return state.activities.find(x => { if (x.id === exceptId || x.subjectId !== subjectId) return false; const m = norm(x.title); return m === n || (n.length >= 5 && m.length >= 5 && (m.includes(n) || n.includes(m))); });
}
async function saveAct() {
  const f = state.form; if (!f || f.type !== 'act') return;
  $$('.field.err').forEach(x => x.classList.remove('err'));
  const title = $('#f-title').value.trim(), subjectId = $('#f-subj').value, date = $('#f-date').value, time = $('#f-time').value || '23:59';
  if (!title) return fieldErr('f-title', 'Informe o título da atividade.');
  if (!subjectId) return fieldErr('f-subj', 'Escolha a disciplina.');
  if (!date || !parseLocal(`${date}T${time}`)) return fieldErr('f-date', 'Informe uma data de entrega válida.');
  let type = $('#f-type').value, newType = false;
  if (type === '__new') { type = $('#f-type-new').value.trim(); if (!type) return fieldErr('f-type-new', 'Informe o nome do novo tipo.'); newType = true; }
  const prev = f.id ? state.activities.find(x => x.id === f.id) : null;
  if (!prev || norm(prev.title) !== norm(title) || prev.subjectId !== subjectId) {
    const dup = findDup(title, subjectId, f.id);
    if (dup) {
      const ok = await dialog({ title: 'Possível duplicata', msg: `Já existe “<b>${esc(dup.title)}</b>” nesta disciplina (entrega ${fmtDate(dueOf(dup))}). Deseja salvar mesmo assim?`, actions: [{ label: 'Salvar mesmo assim', kind: 'primary', value: true }, { label: 'Voltar e revisar', value: null }] });
      if (!ok) return;
    }
  }
  const status = $('#f-status').value;
  const a = {
    id: f.id || uid(), title, desc: $('#f-desc').value.trim(), notes: $('#f-notes').value.trim(), subjectId, type,
    due: `${date}T${time}`, priority: $('input[name=prio]:checked').value, status,
    checklist: $$('#f-check .crow').map(r => ({ t: r.querySelector('input[type=text]').value.trim(), done: r.querySelector('input[type=checkbox]').checked })).filter(x => x.t),
    rem: { on: $('#f-rem-on').checked, keys: $$('input[name=rem]:checked').map(x => x.value), custom: $$('#f-rem-c input').map(x => x.value).filter(Boolean) },
    createdAt: prev ? prev.createdAt : Date.now(), focusMin: prev ? prev.focusMin || 0 : 0,
    postId: prev ? prev.postId || null : null, postRemoved: prev ? !!prev.postRemoved : false, postSnapshot: prev ? prev.postSnapshot || null : null,
    completedAt: status === 'done' ? (prev && prev.completedAt ? prev.completedAt : Date.now()) : null
  };
  try {
    if (newType && !(state.settings.customTypes || []).includes(type) && !DEFAULT_TYPES.includes(type)) await saveSettings({ customTypes: [...(state.settings.customTypes || []), type] });
    await DB.put('activities', a);
    f.id = a.id; f.isNew = false;
    if (f.newFiles.length) { await storeFiles(f.newFiles, { subjectId, activityId: a.id }); f.newFiles = []; }
    const removed = [...f.removeFileIds];
    if (removed.length) { await DB.delMany('files', removed); f.removeFileIds = []; }
    const moved = state.files.filter(x => x.activityId === a.id && x.subjectId !== subjectId && !removed.includes(x.id)).map(x => ({ ...x, subjectId }));
    if (moved.length) await DB.putMany('files', moved);
    closeSheet(); await refresh(); toast(okMsg('Atividade salva.'));
  } catch (e) {
    await refresh().catch(() => { });
    toast('Não foi possível concluir: ' + errMsg(e), { err: true });
  }
}

/* ===================== Detalhes da atividade ===================== */
function openActDetail(id) {
  const a = state.activities.find(x => x.id === id); if (!a) return;
  const s = subj(a.subjectId) || { name: '—', color: '#64748b' }, due = dueOf(a), late = isOverdue(a), files = filesOf(a.id), done = a.status === 'done';
  const rt = reminderTimes({ ...a, status: 'pending' });
  state.form = { type: 'detail', id };
  openSheet(`${sheetHead(a.title)}<div class="sheet-body">
    <div class="badges" style="margin:0 0 6px"><span class="badge ${a.priority}">Prioridade ${PRIORITIES[a.priority].toLowerCase()}</span><span class="badge ${a.status === 'doing' ? 'doing' : ''}">${STATUS[a.status]}</span>${late ? '<span class="badge high">Atrasada</span>' : ''}</div>
    <dl class="kv"><dt>Disciplina</dt><dd><span class="dot" style="--c:${s.color}"></span>${esc(s.name)}</dd><dt>Tipo</dt><dd>${esc(a.type || '—')}</dd><dt>Entrega</dt><dd class="${late ? 'late' : ''}">${due ? fmtDT(due) : '—'}</dd>${a.completedAt ? `<dt>Concluída em</dt><dd>${fmtDT(new Date(a.completedAt))}</dd>` : ''}<dt>Cadastrada em</dt><dd>${fmtDate(new Date(a.createdAt))}</dd>${a.focusMin ? `<dt>Tempo de foco</dt><dd>${a.focusMin} min</dd>` : ''}<dt>Lembretes</dt><dd>${a.rem && a.rem.on && rt.length ? rt.sort((x, y) => x - y).map(x => fmtDT(x)).join('<br>') : 'Desativados'}</dd></dl>
    ${a.desc ? `<div class="small muted">Descrição</div><p class="pre" style="margin-top:2px">${esc(a.desc)}</p>` : ''}
    ${(a.checklist || []).length ? `<div class="small muted">Checklist</div>${a.checklist.map((c, i) => `<label class="setrow"><input type="checkbox" data-a="toggleCheck" data-id="${a.id}" data-i="${i}" ${c.done ? 'checked' : ''}><span style="${c.done ? 'text-decoration:line-through;color:var(--muted)' : ''}">${esc(c.t)}</span></label>`).join('')}` : ''}
    ${a.notes ? `<div class="small muted" style="margin-top:8px">Observações</div><p class="pre" style="margin-top:2px">${esc(a.notes)}</p>` : ''}
    <div class="small muted" style="margin:10px 0 6px">Arquivos (${files.length})</div>${files.length ? files.map(f => `<div class="frow"><div class="ext ${extOf(f.name)}">${extOf(f.name)}</div><div class="grow"><div style="font-weight:600;overflow-wrap:anywhere">${esc(f.name)}</div><div class="small muted">${fmtSize(f.size)}</div></div><button class="ibtn" data-a="fileOpen" data-id="${f.id}" aria-label="Abrir">${ICON.open}</button><button class="ibtn" data-a="fileDl" data-id="${f.id}" aria-label="Baixar">${ICON.download}</button></div>`).join('') : '<div class="small muted">Nenhum arquivo anexado.</div>'}
    ${typeof postInfoHTML === 'function' ? postInfoHTML(a) : ''}
    <div class="hr"></div>
    <div class="grid2"><button class="btn" data-a="editAct" data-id="${a.id}">${ICON.edit} Editar</button><button class="btn" data-a="dupAct" data-id="${a.id}">${ICON.copy} Duplicar</button>
    ${done ? '' : `<button class="btn" data-a="setDoing" data-id="${a.id}">${a.status === 'doing' ? 'Voltar a pendente' : 'Marcar em andamento'}</button><button class="btn" data-a="goFocus" data-id="${a.id}">${ICON.focus} Modo foco</button>`}
    <button class="btn ghost-danger" data-a="delAct" data-id="${a.id}" style="grid-column:1/-1">${ICON.trash} Excluir</button></div>
  </div><div class="sheet-foot"><button class="btn ${done ? '' : 'primary'}" data-a="toggleSheet" data-id="${a.id}">${done ? '↩ Reabrir atividade' : '✓ Marcar como concluída'}</button></div>`);
}
async function setStatus(a, status) {
  const upd = { ...a, status, completedAt: status === 'done' ? Date.now() : null };
  await DB.put('activities', upd);
}
async function toggleDone(id, fromSheet) {
  const a = state.activities.find(x => x.id === id); if (!a) return;
  const wasDone = a.status === 'done', prevStatus = a.status, prevCompleted = a.completedAt;
  try {
    await setStatus(a, wasDone ? 'pending' : 'done');
    if (fromSheet) closeSheet();
    await refresh();
    toast(okMsg(wasDone ? 'Atividade reaberta.' : 'Atividade concluída! 🎉'), {
      label: 'Desfazer', action: async () => { try { await DB.put('activities', { ...a, status: prevStatus, completedAt: prevCompleted }); await refresh(); } catch (e) { toast('Não foi possível desfazer: ' + errMsg(e), { err: true }); } }
    });
  } catch (e) { toast('Não foi possível atualizar: ' + errMsg(e), { err: true }); }
}
async function deleteAct(id) {
  const a = state.activities.find(x => x.id === id); if (!a) return;
  const files = filesOf(id);
  let delFiles = false;
  if (files.length) {
    const r = await dialog({ title: 'Excluir atividade?', msg: `<b>${esc(a.title)}</b> tem <b>${files.length}</b> arquivo(s) anexado(s). O que fazer com eles?`, actions: [{ label: 'Excluir atividade e arquivos', kind: 'danger', value: 'all' }, { label: 'Excluir só a atividade (manter arquivos)', value: 'keep' }, { label: 'Cancelar', value: null }] });
    if (!r) return; delFiles = r === 'all';
  } else if (!await confirmDlg('Excluir atividade?', `<b>${esc(a.title)}</b> será excluída definitivamente.`)) return;
  try {
    await DB.del('activities', id);
    if (files.length) { if (delFiles) await DB.delMany('files', files.map(f => f.id)); else await DB.putMany('files', files.map(f => ({ ...f, activityId: null }))); }
    closeSheet(); await refresh(); toast(okMsg('Atividade excluída.'));
  } catch (e) { toast('Não foi possível excluir: ' + errMsg(e), { err: true }); }
}
async function duplicateAct(id) {
  const a = state.activities.find(x => x.id === id); if (!a) return;
  const c = { ...a, id: uid(), title: a.title + ' (cópia)', status: 'pending', completedAt: null, createdAt: Date.now(), focusMin: 0, postId: null, postRemoved: false, postSnapshot: null, _v: undefined, checklist: (a.checklist || []).map(x => ({ ...x, done: false })) };
  try { await DB.put('activities', c); await refresh(); toast('Atividade duplicada (os anexos não são copiados).'); openActForm({ id: c.id }); }
  catch (e) { toast('Não foi possível duplicar: ' + errMsg(e), { err: true }); }
}
async function quickAdd() {
  const title = $('#qa-title').value.trim(), subjectId = $('#qa-subj').value, date = $('#qa-date').value;
  if (!title) return fieldErr('qa-title', 'Digite o título da atividade.');
  if (!date) return toast('Escolha a data de entrega.', { err: true });
  const dup = findDup(title, subjectId);
  if (dup && !await dialog({ title: 'Possível duplicata', msg: `Já existe “<b>${esc(dup.title)}</b>” nesta disciplina. Salvar mesmo assim?`, actions: [{ label: 'Salvar mesmo assim', kind: 'primary', value: true }, { label: 'Cancelar', value: null }] })) return;
  const a = { id: uid(), title, desc: '', notes: '', subjectId, type: 'Atividade', due: `${date}T23:59`, priority: 'mid', status: 'pending', checklist: [], rem: { on: state.settings.defaultReminders.length > 0, keys: state.settings.defaultReminders, custom: [] }, createdAt: Date.now(), completedAt: null, focusMin: 0 };
  try { await DB.put('activities', a); await refresh(); toast(okMsg('Atividade adicionada.')); }
  catch (e) { toast('Não foi possível salvar: ' + errMsg(e), { err: true }); }
}

/* ===================== Arquivos: seleção, armazenamento e ações ===================== */
function pickFiles(multiple, cb) {
  const i = document.createElement('input');
  i.type = 'file'; i.multiple = multiple; i.style.display = 'none';
  i.onchange = () => { const list = [...i.files]; i.remove(); if (list.length) cb(list); };
  document.body.appendChild(i); i.click();
}
async function storeFiles(list, { subjectId, activityId }) {
  let n = 0;
  const tooBig = list.filter(f => f.size > MAX_FILE_BYTES);
  if (tooBig.length) throw new Error(`“${tooBig[0].name}” tem ${fmtSize(tooBig[0].size)}; o limite é ${fmtSize(MAX_FILE_BYTES)} por arquivo.`);
  for (const file of list) {
    const rec = { id: uid(), name: file.name, type: file.type || '', size: file.size, blob: file, subjectId: subjectId || null, activityId: activityId || null, addedAt: Date.now(), remote: false, path: '' };
    await DB.put('files', rec);
    const back = await DB.get('files', rec.id);
    if (!back || !back.blob || back.blob.size !== file.size) throw new Error(`O arquivo “${file.name}” não foi gravado corretamente.`);
    n++;
  }
  requestPersist();
  return n;
}
function populateUpAct() {
  const sid = $('#up-subj').value;
  const list = sortActs(state.activities.filter(a => isPending(a) && (!sid || a.subjectId === sid)), 'due');
  $('#up-act').innerHTML = `<option value="">Só guardar em Meus arquivos</option>${list.map(a => `<option value="${a.id}">${esc(a.title)}</option>`).join('')}<option value="__new">➕ Criar nova atividade com estes arquivos</option>`;
  toggleUpNew();
}
function toggleUpNew() { const w = $('#up-new'); if (w) w.hidden = $('#up-act').value !== '__new'; }
function openUploadSheet(files) {
  state.pendingUpload = files;
  state.form = { type: 'upload' };
  const first = files[0].name.replace(/\.[^.]+$/, '');
  openSheet(`${sheetHead('Enviar arquivos')}<div class="sheet-body">
    <div class="card">${files.map(f => `<div class="row" style="padding:4px 0"><div class="ext ${extOf(f.name)}" style="width:36px;height:36px">${extOf(f.name)}</div><span class="grow small" style="overflow-wrap:anywhere">${esc(f.name)}<br><span class="muted">${fmtSize(f.size)}</span></span></div>`).join('')}</div>
    <label class="field"><span>Disciplina</span><select id="up-subj"><option value="">— sem disciplina —</option>${state.subjects.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
    <label class="field"><span>Atividade</span><select id="up-act"></select></label>
    <div id="up-new" hidden><label class="field"><span>Título da nova atividade *</span><input id="up-title" maxlength="120" value="${esc(first)}"></label><label class="field"><span>Data de entrega *</span><input type="date" id="up-date" value="${ymd(addDays(new Date(), 1))}"></label><p class="small muted" style="margin-top:-6px">A nova atividade precisa de uma disciplina.</p></div>
  </div><div class="sheet-foot"><button class="btn" data-a="closeSheet">Cancelar</button><button class="btn primary" data-a="saveUpload">Salvar arquivos</button></div>`);
  populateUpAct();
}
async function saveUpload() {
  const files = state.pendingUpload; if (!files || !files.length) return;
  let subjectId = $('#up-subj').value || null, actId = $('#up-act').value;
  try {
    if (actId === '__new') {
      const title = $('#up-title').value.trim(), date = $('#up-date').value;
      if (!subjectId) return fieldErr('up-subj', 'Escolha a disciplina para criar a atividade.');
      if (!title) return fieldErr('up-title', 'Informe o título da atividade.');
      if (!date) return fieldErr('up-date', 'Informe a data de entrega.');
      const a = { id: uid(), title, desc: '', notes: '', subjectId, type: 'Atividade', due: `${date}T23:59`, priority: 'mid', status: 'pending', checklist: [], rem: { on: state.settings.defaultReminders.length > 0, keys: state.settings.defaultReminders, custom: [] }, createdAt: Date.now(), completedAt: null, focusMin: 0 };
      await DB.put('activities', a); actId = a.id;
    } else if (actId) {
      subjectId = state.activities.find(x => x.id === actId).subjectId;
    } else actId = null;
    const n = await storeFiles(files, { subjectId, activityId: actId });
    state.pendingUpload = null;
    closeSheet(); await refresh(); toast(`${n} arquivo${n > 1 ? 's' : ''} salvo${n > 1 ? 's' : ''}.`);
  } catch (e) { await refresh().catch(() => { }); toast('Falha ao salvar arquivos: ' + errMsg(e), { err: true }); }
}
const blobToB64 = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
async function deliverFile(blob, name) {
  if (Native && Capacitor.Plugins.Filesystem && Capacitor.Plugins.Share) {
    const data = await blobToB64(blob);
    const r = await Capacitor.Plugins.Filesystem.writeFile({ path: name, data, directory: 'CACHE' });
    await Capacitor.Plugins.Share.share({ title: name, url: r.uri });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function fileOpen(id) {
  const f = state.files.find(x => x.id === id); if (!f) return;
  try {
    const blob = await Cloud.fileBlob(f);
    if (Native) return await deliverFile(blob, f.name);
    const url = URL.createObjectURL(blob);
    const w = window.open(url, '_blank');
    if (!w) await deliverFile(blob, f.name);
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  } catch (e) { toast('Não foi possível abrir: ' + errMsg(e), { err: true }); }
}
async function fileShare(id) {
  const f = state.files.find(x => x.id === id); if (!f) return;
  try {
    const blob = await Cloud.fileBlob(f);
    const file = new File([blob], f.name, { type: f.type });
    if (!Native && navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: f.name });
    else await deliverFile(blob, f.name);
  } catch (e) { if (e && e.name !== 'AbortError') toast('Não foi possível compartilhar: ' + errMsg(e), { err: true }); }
}
async function fileDelete(id) {
  const f = state.files.find(x => x.id === id); if (!f) return;
  const act = state.activities.find(a => a.id === f.activityId);
  const msg = act ? `O arquivo <b>${esc(f.name)}</b> está vinculado à atividade <b>${esc(act.title)}</b>. Ao excluí-lo, ele deixa de aparecer nela.` : `O arquivo <b>${esc(f.name)}</b> será excluído definitivamente.`;
  if (!await confirmDlg('Excluir arquivo?', msg)) return;
  try { await DB.del('files', id); closeSheet(); await refresh(); toast(okMsg('Arquivo excluído.')); }
  catch (e) { toast('Não foi possível excluir: ' + errMsg(e), { err: true }); }
}
function fileReplace(id) {
  const f = state.files.find(x => x.id === id); if (!f) return;
  pickFiles(false, async ([nf]) => {
    if (!await dialog({ title: 'Substituir arquivo?', msg: `<b>${esc(f.name)}</b> será trocado por <b>${esc(nf.name)}</b>. O vínculo com a atividade é mantido.`, actions: [{ label: 'Substituir', kind: 'primary', value: true }, { label: 'Cancelar', value: null }] })) return;
    try {
      if (nf.size > MAX_FILE_BYTES) throw new Error(`O arquivo tem ${fmtSize(nf.size)}; o limite é ${fmtSize(MAX_FILE_BYTES)}.`);
      await DB.put('files', { ...f, name: nf.name, type: nf.type || '', size: nf.size, blob: nf, addedAt: Date.now(), remote: false });
      const back = await DB.get('files', id);
      if (!back || back.blob.size !== nf.size) throw new Error('A substituição não foi gravada corretamente.');
      await refresh(); toast(okMsg('Arquivo substituído.'));
    } catch (e) { toast('Não foi possível substituir: ' + errMsg(e), { err: true }); }
  });
}

/* ===================== Exportação, backup e restauração ===================== */
const csvCell = v => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
async function exportCsv() {
  const head = ['Título', 'Disciplina', 'Tipo', 'Entrega', 'Prioridade', 'Status', 'Descrição', 'Observações', 'Cadastrada em', 'Concluída em', 'Anexos'];
  const rows = sortActs(state.activities, 'due').map(a => [a.title, (subj(a.subjectId) || {}).name || '', a.type, fmtDT(dueOf(a)), PRIORITIES[a.priority], STATUS[a.status], a.desc, a.notes, fmtDate(new Date(a.createdAt)), a.completedAt ? fmtDT(new Date(a.completedAt)) : '', filesOf(a.id).map(f => f.name).join(' | ')]);
  const csv = '﻿' + [head, ...rows].map(r => r.map(csvCell).join(';')).join('\r\n');
  try { await deliverFile(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `atividades-${ymd(new Date())}.csv`); }
  catch (e) { if (e.name !== 'AbortError') toast('Não foi possível exportar: ' + errMsg(e), { err: true }); }
}
const stripLocal = ({ _v, blob, remote, path, ...r }) => r;
async function buildBackup(withFiles) {
  const files = [];
  for (const f of state.files) {
    const meta = stripLocal(f);
    if (!withFiles) { files.push(meta); continue; }
    const blob = await Cloud.fileBlob(f);   // baixa da nuvem se o arquivo ainda não está neste aparelho
    files.push({ ...meta, data: await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); }) });
  }
  return { app: 'organizador-escolar', version: 2, exportedAt: new Date().toISOString(), withFiles, settings: state.settings,
    subjects: state.subjects.map(({ _v, ...r }) => r), activities: state.activities.map(({ _v, ...r }) => r), files };
}
async function exportJson(withFiles) {
  try {
    toast(withFiles ? 'Preparando backup…' : 'Preparando exportação…');
    const data = await buildBackup(withFiles);
    await deliverFile(new Blob([JSON.stringify(data)], { type: 'application/json' }), `${withFiles ? 'backup-completo' : 'dados'}-${ymd(new Date())}.json`);
  } catch (e) { if (e.name !== 'AbortError') toast('Não foi possível exportar: ' + errMsg(e), { err: true }); }
}
async function restoreBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { return toast('Arquivo inválido: não é um JSON legível.', { err: true }); }
  if (!data || data.app !== 'organizador-escolar' || !Array.isArray(data.subjects) || !Array.isArray(data.activities)) return toast('Este arquivo não parece ser um backup deste aplicativo.', { err: true });
  const fl = Array.isArray(data.files) ? data.files : [];
  const withData = fl.filter(f => f.data).length;
  const ok = await dialog({ title: 'Restaurar backup?', msg: `Isto <b>substitui todos os dados da sua conta</b> (inclusive nos outros dispositivos) por: ${data.subjects.length} disciplina(s), ${data.activities.length} atividade(s) e ${withData} arquivo(s)${fl.length > withData ? ` (${fl.length - withData} arquivo(s) estão sem conteúdo no backup e serão ignorados)` : ''}. Atividades que vieram do mural de uma turma voltam como atividades pessoais.`, actions: [{ label: 'Restaurar', kind: 'danger', value: true }, { label: 'Cancelar', value: null }] });
  if (!ok) return;
  try {
    const sm = new Map(), am = new Map();
    const subjects = data.subjects.map(x => { const id = uid(); sm.set(x.id, id); return { id, name: String(x.name || 'Disciplina').slice(0, 40), color: /^#[0-9a-f]{6}$/i.test(x.color) ? x.color : '#64748b', icon: x.icon || '', createdAt: x.createdAt || Date.now() }; });
    let dropped = 0;
    const activities = [];
    for (const a of data.activities) {
      if (!sm.has(a.subjectId)) { dropped++; continue; }
      const { _v, ...r } = a; const id = uid(); am.set(a.id, id);
      activities.push({ ...r, id, subjectId: sm.get(a.subjectId), postId: null, postRemoved: false, postSnapshot: null });
    }
    const files = [];
    for (const f of fl) {
      if (!f.data) continue;
      const { data: d, _v, ...meta } = f; const blob = await (await fetch(d)).blob();
      if (blob.size > MAX_FILE_BYTES) { dropped++; continue; }
      files.push({ ...meta, id: uid(), blob, subjectId: sm.get(f.subjectId) || null, activityId: am.get(f.activityId) || null, remote: false, path: '' });
    }
    await DB.replaceSynced({ subjects, activities, files, settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) } });
    await loadAll(); applyTheme(); render(); rescheduleReminders();
    toast(`Backup restaurado: ${state.subjects.length} disciplinas, ${state.activities.length} atividades, ${state.files.length} arquivos.${dropped ? ` ${dropped} item(ns) ignorado(s).` : ''} Enviando para a nuvem…`, { long: true });
  } catch (e) { toast('A restauração falhou e nada foi alterado: ' + errMsg(e), { err: true }); }
}
async function wipeAll() {
  if (!await confirmDlg('Apagar todos os dados?', 'Disciplinas, atividades e arquivos pessoais serão removidos <b>definitivamente da sua conta</b>, inclusive nos outros dispositivos. As turmas não são afetadas. Considere fazer um backup antes.', 'Continuar')) return;
  if (!await confirmDlg('Última confirmação', 'Tem certeza? Esta ação não pode ser desfeita.', 'Apagar tudo')) return;
  try { await DB.replaceSynced({}); await loadAll(); applyTheme(); render(); rescheduleReminders(); toast('Todos os dados foram apagados.'); }
  catch (e) { toast('Não foi possível apagar: ' + errMsg(e), { err: true }); }
}

/* ===================== Ações (delegação de eventos) ===================== */
const ACT = {
  go: d => { location.hash = '#/' + d.to; },
  reloadPage: () => location.reload(),
  back: () => { if (history.length > 1) history.back(); else location.hash = '#/home'; },
  openAdd: () => openSheet(`${sheetHead('Adicionar')}<div class="sheet-body">
    <button class="opt" data-a="newAct"><span class="oi">${ICON.list}</span><span><b>Nova atividade</b><br><span class="small muted">Trabalho, prova, leitura, pesquisa…</span></span></button>
    <button class="opt" data-a="pickUpload"><span class="oi">${ICON.clip}</span><span><b>Enviar arquivos</b><br><span class="small muted">PDF, Word, PowerPoint, Excel, TXT, imagens e outros</span></span></button>
    <button class="opt" data-a="newSubj"><span class="oi">${ICON.folder}</span><span><b>Nova disciplina</b><br><span class="small muted">Matemática, História, Inglês…</span></span></button></div>`),
  closeSheet: () => closeSheet(),
  newAct: d => { closeSheet(true); openActForm({ subjectId: d.subj, date: d.date }); },
  editAct: d => { closeSheet(true); openActForm({ id: d.id }); },
  newSubj: () => { closeSheet(true); openSubjForm(); },
  editSubj: d => { closeSheet(true); openSubjForm(d.id); },
  delSubj: d => deleteSubj(d.id),
  saveSubj: () => saveSubj(),
  confirmMove: () => { const to = $('#mv-to').value, id = state.form.id; doDeleteSubj(id, 'move', to); },
  openAct: (d, e) => { if (e) e.preventDefault(); closeSheet(true); openActDetail(d.id); },
  saveAct: () => saveAct(),
  dupAct: d => { closeSheet(true); duplicateAct(d.id); },
  delAct: d => deleteAct(d.id),
  toggle: d => toggleDone(d.id, false),
  toggleSheet: d => toggleDone(d.id, true),
  setDoing: async d => { const a = state.activities.find(x => x.id === d.id); try { await DB.put('activities', { ...a, status: a.status === 'doing' ? 'pending' : 'doing' }); closeSheet(); await refresh(); } catch (e) { toast('Não foi possível atualizar: ' + errMsg(e), { err: true }); } },
  toggleCheck: async (d, e) => { const a = state.activities.find(x => x.id === d.id); const cl = (a.checklist || []).map((c, i) => i === +d.i ? { ...c, done: e.target.checked } : c); try { await DB.put('activities', { ...a, checklist: cl }); await loadAll(); openActDetail(d.id); render(); } catch (err) { toast('Não foi possível salvar a etapa: ' + errMsg(err), { err: true }); } },
  goFocus: d => { closeSheet(true); location.hash = '#/focus/' + d.id; },
  addCheck: () => { $('#f-check').insertAdjacentHTML('beforeend', checkRow()); const r = $$('#f-check .crow input[type=text]'); r[r.length - 1].focus(); },
  addRem: () => $('#f-rem-c').insertAdjacentHTML('beforeend', remRow()),
  rmRow: (d, e) => e.target.closest('.crow').remove(),
  pickFormFiles: () => pickFiles(true, list => { state.form.newFiles.push(...list); renderFormFiles(); }),
  rmNewFile: d => { state.form.newFiles.splice(+d.i, 1); renderFormFiles(); },
  rmOldFile: d => { state.form.removeFileIds.push(d.id); renderFormFiles(); },
  pickUpload: () => { pickFiles(true, files => { closeSheet(true); openUploadSheet(files); }); },
  saveUpload: () => saveUpload(),
  setFilter: d => { L.filter = d.v; render(); },
  quickAdd: () => quickAdd(),
  quickMore: () => openActForm({ subjectId: $('#qa-subj').value, date: $('#qa-date').value, title: $('#qa-title').value.trim() }),
  calMode: d => { state.cal.mode = d.v; state.cal.date = new Date(state.cal.sel); render(); },
  calNav: d => {
    const c = state.cal, n = +d.v;
    if (c.mode === 'month') { c.date = new Date(c.date.getFullYear(), c.date.getMonth() + n, 1); c.sel = new Date(c.date); }
    else { c.date = addDays(c.date, n * (c.mode === 'week' ? 7 : 1)); c.sel = new Date(c.date); }
    render();
  },
  calToday: () => { state.cal.date = new Date(); state.cal.sel = new Date(); render(); },
  calSel: d => { const x = parseLocal(d.d); state.cal.sel = x; if (x.getMonth() !== state.cal.date.getMonth()) state.cal.date = new Date(x); render(); },
  fileOpen: d => fileOpen(d.id),
  fileDl: d => { const f = state.files.find(x => x.id === d.id); if (f) Cloud.fileBlob(f).then(b => deliverFile(b, f.name)).catch(e => { if (e.name !== 'AbortError') toast('Não foi possível baixar: ' + errMsg(e), { err: true }); }); },
  fileShare: d => fileShare(d.id),
  fileReplace: d => fileReplace(d.id),
  fileDel: d => fileDelete(d.id),
  notifEnable: async () => { state.notif = await notifRequest(); if (state.notif === 'granted') { toast('Notificações ativadas.'); rescheduleReminders(); } else if (state.notif === 'denied') toast('Permissão negada. Veja as instruções em Perfil › Notificações.', { long: true }); render(); },
  notifDismiss: async () => { await saveSettings({ notifBannerDismissed: true }); render(); },
  setTheme: async d => { await saveSettings({ theme: d.v }); applyTheme(); render(); },
  rmType: async d => { const t = [...state.settings.customTypes]; t.splice(+d.i, 1); await saveSettings({ customTypes: t }); render(); },
  exportJson: () => exportJson(false),
  exportCsv: () => exportCsv(),
  backupFull: () => exportJson(true),
  restorePick: () => pickFiles(false, ([f]) => restoreBackup(f)),
  syncNow: async () => { if (!navigator.onLine) return toast('Você está offline. A sincronização acontece quando a conexão voltar.'); const ok = await Cloud.sync(); toast(ok ? 'Tudo sincronizado.' : (Cloud.status.error || 'Não foi possível sincronizar agora.'), ok ? {} : { err: true }); render(); },
  retryFailed: async () => { await Cloud.retryFailed(); render(); },
  legacyImport: () => Migrate.manual(),
  legacyRemove: () => Migrate.removeLegacy(),
  pickAvatar: () => { const f = $('#av-file'); if (f) f.click(); },
  removeAvatar: async () => {
    if (!await confirmDlg('Remover foto?', 'Você volta a aparecer com a inicial do seu nome.', 'Remover')) return;
    try { await Cloud.removeAvatar(); await Cloud.sync(); await refresh(); toast('Foto removida.'); } catch (e) { toast(errMsg(e), { err: true }); }
  },
  editName: () => {
    const prof = state.profiles.find(p => p.id === state.user.id);
    state.form = { type: 'name' };
    openSheet(`${sheetHead('Alterar nome')}<div class="sheet-body"><label class="field"><span>Nome</span><input id="nm-name" maxlength="60" value="${esc((prof && prof.display_name) || state.user.name || '')}"></label></div><div class="sheet-foot"><button class="btn" data-a="closeSheet">Cancelar</button><button class="btn primary" data-a="saveName">Salvar</button></div>`);
  },
  saveName: async () => {
    const n = $('#nm-name').value.trim(); if (!n) return fieldErr('nm-name', 'Informe seu nome.');
    try { await Cloud.updateName(n); state.user.name = n; await Cloud.sync(); closeSheet(); await refresh(); toast('Nome atualizado.'); }
    catch (e) { toast(errMsg(e), { err: true }); }
  },
  changePass: () => {
    state.form = { type: 'pass' };
    openSheet(`${sheetHead('Alterar senha')}<div class="sheet-body"><label class="field"><span>Nova senha (mínimo 8 caracteres)</span><input id="pw-1" type="password" autocomplete="new-password"></label><label class="field"><span>Confirmar nova senha</span><input id="pw-2" type="password" autocomplete="new-password"></label></div><div class="sheet-foot"><button class="btn" data-a="closeSheet">Cancelar</button><button class="btn primary" data-a="savePass">Salvar</button></div>`);
  },
  savePass: async () => {
    const a = $('#pw-1').value, b = $('#pw-2').value;
    if (a.length < 8) return fieldErr('pw-1', 'A senha precisa ter pelo menos 8 caracteres.');
    if (a !== b) return fieldErr('pw-2', 'As senhas não são iguais.');
    try { await Cloud.updatePassword(a); closeSheet(); toast('Senha alterada.'); } catch (e) { toast(e.message, { err: true }); }
  },
  signOut: async () => {
    const n = await DB.count('outbox');
    const actions = [{ label: 'Sair', kind: n ? 'danger' : 'primary', value: 'out' }];
    if (!n) actions.push({ label: 'Sair e remover meus dados deste aparelho', value: 'wipe' });
    actions.push({ label: 'Cancelar', value: null });
    const r = await dialog({ title: 'Sair da conta?', msg: n ? `Há <b>${n}</b> alteração(ões) que ainda não chegaram à nuvem. Elas ficam guardadas neste aparelho e são enviadas quando você entrar de novo <b>nesta mesma conta</b>.` : 'Suas atividades continuam salvas na conta. Use a segunda opção em aparelhos compartilhados.', actions });
    if (!r) return;
    const id = state.user.id;
    await teardown();
    localStorage.removeItem('org:lastUser');
    await Cloud.signOut();
    if (r === 'wipe') { try { await DB.deleteDatabase('org-' + id); } catch (e) { /* ignorado */ } }
    Auth.show('login');
  },
  notifEnableDummy: () => { },
  wipe: () => wipeAll(),
  histKind: d => { H.kind = d.v; render(); },
  focusStart: () => {
    const custom = parseInt($('#fo-custom').value, 10), sel = $('input[name=fomin]:checked');
    const min = custom > 0 ? Math.min(custom, 240) : +(sel ? sel.value : 25);
    state.timer = { total: min * 60, left: min * 60, end: Date.now() + min * 60000, running: true, done: false, actId: $('#fo-act').value || null };
    render();
  },
  focusPause: () => { const t = state.timer; t.left = timerLeft(); t.running = false; render(); },
  focusResume: () => { const t = state.timer; t.end = Date.now() + t.left * 1000; t.running = true; render(); },
  focusReset: () => { state.timer = null; render(); }
};

function bindEvents() {
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-a]');
    if (!el || el.tagName === 'INPUT') return;
    const fn = ACT[el.dataset.a];
    if (fn) fn(el.dataset, e);
  });
  document.addEventListener('change', async e => {
    const t = e.target;
    if (t.matches('input[data-a=toggleCheck]')) return ACT.toggleCheck(t.dataset, e);
    if (t.id === 'av-file') {
      const f = t.files && t.files[0]; t.value = ''; if (!f) return;
      try { const blob = await prepAvatar(f); toast('Enviando foto…'); await Cloud.uploadAvatar(blob); await Cloud.sync(); await refresh(); toast('Foto atualizada.'); }
      catch (err) { toast(errMsg(err), { err: true }); }
      return;
    }
    if (t.id === 'f-type') { $('#f-type-new-wrap').hidden = t.value !== '__new'; return; }
    if (t.id === 'f-rem-on') { $('#f-rem-box').style.opacity = t.checked ? 1 : .45; return; }
    if (t.id === 'up-subj') return populateUpAct();
    if (t.id === 'up-act') return toggleUpNew();
    if (t.id === 'l-sort') { L.sort = t.value; return updateList(); }
    if (t.id === 'l-subj') { L.subject = t.value; return updateList(); }
    if (t.id === 'fl-subj') { F.subject = t.value; $('#flist').innerHTML = filesListHTML(); return; }
    if (t.id === 'h-subj') { H.subject = t.value; return render(); }
    if (t.id === 'h-type') { H.type = t.value; return render(); }
    if (t.id === 'h-per') { H.period = t.value; return render(); }
    if (t.id === 's-soon') { await saveSettings({ soonDays: +t.value }); return render(); }
    if (t.id === 's-sort') { await saveSettings({ defaultSort: t.value }); return toast('Ordenação padrão atualizada.'); }
    if (t.classList.contains('defrem')) { await saveSettings({ defaultReminders: $$('.defrem:checked').map(x => x.value) }); return; }
  });
  document.addEventListener('input', e => {
    const t = e.target;
    if (t.id === 'l-q') { L.q = t.value; updateList(); }
    else if (t.id === 'fl-q') { F.q = t.value; $('#flist').innerHTML = filesListHTML(); }
    else if (t.id === 's-q') { SQ = t.value; $('#sres').innerHTML = searchResultsHTML(); }
  });
  window.addEventListener('hashchange', () => { if (state.sheetOpen) { hideSheetUI(); state.sheetPushed = false; } render(); });
  window.addEventListener('popstate', () => { if (state.sheetOpen) { hideSheetUI(); state.sheetPushed = false; } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { reminderTick(); timerUI(); } });
  matchMedia('(prefers-color-scheme: dark)').addEventListener && matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && state.sheetOpen) closeSheet(); });
}

/* ===================== Inicialização ===================== */
/* ===================== Estado de sincronização (indicador no topo) ===================== */
function syncKind() {
  const c = Cloud.status;
  if (!navigator.onLine || c.state === 'offline') return 'off';
  if (c.state === 'syncing') return 'sync';
  if (c.state === 'error') return 'err';
  if (c.pending > 0) return 'pend';
  return 'ok';
}
function syncChipInner() {
  const c = Cloud.status, k = syncKind();
  const label = { off: 'Offline' + (c.pending ? ` · ${c.pending} pendente${c.pending > 1 ? 's' : ''}` : ''), sync: 'Sincronizando…', err: c.failed ? 'Erro ao sincronizar' : 'Sem conexão com o servidor', pend: `${c.pending} pendente${c.pending > 1 ? 's' : ''}`, ok: 'Sincronizado' }[k];
  return `<i class="sdot"></i><span>${label}</span>`;
}
function syncChipHTML() { return state.user ? `<button class="sync-chip ${syncKind()}" id="sync-chip" data-a="go" data-to="settings" aria-label="Estado da sincronização">${syncChipInner()}</button>` : ''; }
function updateChip() {
  const el = $('#sync-chip'); if (el) { el.className = 'sync-chip ' + syncKind(); el.innerHTML = syncChipInner(); }
  if (state.route && state.route.name === 'settings' && !state.sheetOpen && !isTyping()) render();
}
const okMsg = t => { const k = syncKind(); return (k === 'off' || k === 'err') ? t.replace(/\.$/, '') + ' neste aparelho (será enviado quando a conexão voltar).' : t; };
const isTyping = () => { const a = document.activeElement; return !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && $('#view').contains(a) && a.type !== 'checkbox' && a.type !== 'radio'); };

/* ===================== Sessão: entrar, sair, trocar de conta ===================== */
let booted = null, recovering = false, gen = 0;
const userInfo = u => ({ id: u.id, email: u.email || '', name: (u.user_metadata && u.user_metadata.name) || '' });

async function teardown() {
  Cloud.stop();
  if (state.sheetOpen) hideSheetUI();
  state.sheetPushed = false;
  $('#dialog').classList.remove('open'); $('#dialog').innerHTML = '';
  gen++; DB.close(); booted = null;
  Object.assign(state, { user: null, subjects: [], activities: [], files: [], classes: [], members: [], profiles: [], posts: [], postfiles: [], settings: { ...DEFAULT_SETTINGS }, timer: null, syncedOnce: false, hasServerSettings: false });
  $('#view').innerHTML = ''; $('#topbar').innerHTML = '';
}

async function bootApp(u) {
  if (booted === u.id) return;
  if (booted) await teardown();
  booted = u.id; const my = gen;
  state.user = userInfo(u);
  try { await DB.open('org-' + u.id, u.id); await loadAll(); }
  catch (e) { if (my !== gen) return; booted = null; state.user = null; Auth.show('login', { kind: 'err', text: 'Não foi possível abrir o armazenamento deste aparelho: ' + errMsg(e) + ' Se você está em navegação privada, use uma janela normal.' }); return; }
  if (my !== gen || recovering) return;   // a sessão mudou (ex.: link de recuperação) enquanto abria
  try { localStorage.setItem('org:lastUser', JSON.stringify(state.user)); } catch (e) { /* opcional */ }
  state.syncedOnce = false; state.hasServerSettings = false;
  applyTheme(); Auth.hide();
  if (!location.hash || location.hash === '#' || /[?&]code=/.test(location.search)) history.replaceState(null, '', location.pathname + '#/home');
  lastKey = ''; render();
  state.notif = await notifStatus();
  if (my !== gen || recovering) return;
  Cloud.start(state.user, {
    onData: async changed => {
      const first = !state.syncedOnce; state.syncedOnce = true;
      if (!changed && !first) return;
      await loadAll(); applyTheme();
      if (typeof applyPostUpdates === 'function') { const n = await applyPostUpdates(); if (n) await loadAll(); }
      if (isTyping()) state.dirty = true; else render();
      rescheduleReminders();
    }
  });
  setTimeout(() => Migrate.offerIfAny(), 1200);
}

async function onAuth(event, session) {
  if (/[?&]code=/.test(location.search) && event !== 'INITIAL_SESSION') history.replaceState(null, '', location.pathname + location.hash);
  if (event === 'PASSWORD_RECOVERY') { recovering = true; if (booted) await teardown(); Auth.show('reset'); return; }
  if (event === 'SIGNED_OUT') { if (!recovering) { await teardown(); localStorage.removeItem('org:lastUser'); Auth.show('login'); } return; }
  if (recovering) return;
  if (session && session.user) { await bootApp(session.user); return; }
  if (event === 'INITIAL_SESSION') {
    let last = null; try { last = JSON.parse(localStorage.getItem('org:lastUser') || 'null'); } catch (e) { /* ignorado */ }
    if (last && last.id && !navigator.onLine) { await bootApp({ id: last.id, email: last.email, user_metadata: { name: last.name } }); return; }  // abre offline com o cache da última conta
    Auth.show('login');
  }
}
window.__afterReset = async () => { recovering = false; try { const s = await Cloud.getSession(); if (s) { await bootApp(s.user); toast('Senha alterada.'); } else Auth.show('login', { kind: 'ok', text: 'Senha alterada. Entre com a nova senha.' }); } catch (e) { Auth.show('login'); } };

function showSetupNeeded() {
  $('#app').hidden = true; const b = $('#auth'); b.hidden = false;
  const cfg = window.APP_CONFIG || {};
  const hasCfg = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
  b.innerHTML = hasCfg
    ? `<div class="auth-wrap"><div class="card auth-card"><h2>Não foi possível carregar o app</h2><p>Um componente necessário (biblioteca de contas) não carregou. Verifique sua conexão com a internet, desative bloqueadores de conteúdo para este site e tente de novo.</p><button class="btn primary block" data-a="reloadPage">Tentar de novo</button></div></div>`
    : `<div class="auth-wrap"><div class="card auth-card"><h2>Configuração pendente</h2><p>O servidor de contas ainda não foi configurado para este site. Quem publica o app precisa definir as variáveis <b>SUPABASE_URL</b> e <b>SUPABASE_ANON_KEY</b> no Netlify e publicar de novo. O passo a passo está no arquivo <b>SETUP.md</b>.</p></div></div>`;
}

function init() {
  bindEvents();
  document.addEventListener('focusout', () => { if (state.dirty) { state.dirty = false; setTimeout(() => { if (!isTyping()) render(); else state.dirty = true; }, 80); } });
  applyTheme();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => { });
  setInterval(reminderTick, 20000);
  setInterval(timerUI, 250);
  if (!Cloud.configured) return showSetupNeeded();
  Cloud.onAuth(onAuth);
  Cloud.onStatus(updateChip);
  Cloud.init();
  window.addEventListener('online', updateChip); window.addEventListener('offline', updateChip);
}
window.addEventListener('DOMContentLoaded', init);
