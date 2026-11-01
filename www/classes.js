'use strict';
/* Turmas: lista, criar, entrar, mural, publicações, participantes e administração.
   Leitura vem do espelho local (funciona offline); toda ação que muda a turma exige conexão e é validada no servidor. */
const CL = { tab: 'mural', subject: '', when: 'upcoming', mine: '' };

const nameOf = id => { const p = state.profiles.find(x => x.id === id); return (p && p.display_name) || 'Aluno'; };
const myRole = cid => { const m = state.members.find(x => x.class_id === cid && x.user_id === (state.user && state.user.id)); return m ? m.role : null; };
const clsById = id => state.classes.find(c => c.id === id);
const fmtCode = c => (c || '').replace(/^(.{4})(.{4})$/, '$1-$2');
const myActFor = pid => state.activities.find(a => a.postId === pid);
const postsOf = cid => state.posts.filter(p => p.class_id === cid && !p.deleted_at);
const needOnline = () => { if (!navigator.onLine) { toast('Esta ação exige conexão com a internet.', { err: true }); return false; } return true; };
const dtOf = p => parseLocal(String(p.due).slice(0, 16));
const roleBadge = r => r === 'admin' ? '<span class="badge">Administrador</span>' : '';

/* ---------- aviso de mudanças da publicação em atividades já adicionadas à agenda ---------- */
async function applyPostUpdates() {
  let n = 0;
  for (const a of state.activities) {
    if (!a.postId) continue;
    const p = state.posts.find(x => x.id === a.postId);
    if (!p || p.deleted_at) continue;
    const d = diffPost(a, p);
    if (!Object.keys(d.auto).length && !Object.keys(d.snapUpdates).length) continue;
    await DB.put('activities', { ...a, ...d.auto, postSnapshot: { ...(a.postSnapshot || {}), ...d.snapUpdates } });
    n++;
  }
  return n;
}

const FIELD_LABEL = { title: 'Título', desc: 'Descrição', due: 'Entrega' };
const showVal = (f, v) => f === 'due' && v ? fmtDT(parseLocal(v)) : (v || '—');

function postInfoHTML(a) {
  if (!a.postId && !a.postRemoved) return '';
  const p = state.posts.find(x => x.id === a.postId);
  const cls = p && clsById(p.class_id);
  const live = p && !p.deleted_at && !a.postRemoved;
  let h = `<div class="hr"></div><div class="small muted">Origem</div>`;
  if (live) {
    h += `<p style="margin:2px 0 8px">Publicada na turma <b>${esc(cls ? cls.name : '—')}</b> por <b>${esc(nameOf(p.author_id))}</b>. A conclusão desta atividade é só sua.</p>`;
    const d = diffPost(a, p);
    const keys = Object.keys(d.conflicts);
    if (keys.length) {
      h += `<div class="banner"><b>A publicação foi atualizada</b><div class="small muted" style="margin:4px 0 8px">Você alterou estes campos por conta própria, então não os trocamos sozinhos.</div>${keys.map(f => `<div style="margin-bottom:10px"><b>${FIELD_LABEL[f]}</b><div class="small">Turma: ${esc(showVal(f, d.conflicts[f].theirs))}</div><div class="small">Seu: ${esc(showVal(f, d.conflicts[f].mine))}</div><div class="row" style="margin-top:6px"><button class="btn sm" data-a="resolvePost" data-id="${a.id}" data-f="${f}" data-v="theirs">Usar a da turma</button><button class="btn sm" data-a="resolvePost" data-id="${a.id}" data-f="${f}" data-v="mine">Manter a minha</button></div></div>`).join('')}</div>`;
    }
    const pfs = state.postfiles.filter(f => f.post_id === a.postId);
    if (pfs.length) h += `<div class="small muted" style="margin:6px 0">Anexos da turma (${pfs.length})</div>${pfs.map(pfRow).join('')}`;
  } else {
    h += `<p style="margin:2px 0 8px;color:var(--warn)">⚠️ A publicação original foi removida ou você não tem mais acesso a ela. Esta atividade continua na sua agenda como uma cópia independente.</p>`;
  }
  return h;
}
const pfRow = f => `<div class="frow"><div class="ext ${extOf(f.name)}">${esc(extOf(f.name))}</div><div class="grow"><div style="font-weight:600;overflow-wrap:anywhere">${esc(f.name)}</div><div class="small muted">${fmtSize(f.size)}</div></div><button class="ibtn" data-a="pfOpen" data-id="${f.id}" aria-label="Abrir">${ICON.open}</button><button class="ibtn" data-a="pfDl" data-id="${f.id}" aria-label="Baixar">${ICON.download}</button></div>`;

/* ===================== Lista de turmas ===================== */
VIEWS.classes = () => {
  const list = [...state.classes].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  let h = '';
  if (!navigator.onLine) h += `<div class="banner small">Você está offline. Dá para consultar o que já foi baixado; criar, entrar e publicar exigem conexão.</div>`;
  h += `<div class="grid2" style="margin-bottom:14px"><button class="btn primary" data-a="newClass">＋ Criar turma</button><button class="btn" data-a="joinClass">Entrar em turma</button></div>`;
  if (!list.length) {
    h += state.syncedOnce ? emptyState('👥', 'Você ainda não participa de nenhuma turma', 'Crie uma turma para compartilhar atividades e arquivos com os colegas, ou entre em uma com o código e a senha que eles passaram.') : `<div class="loading">Carregando…</div>`;
  } else h += list.map(c => {
    const posts = postsOf(c.id), up = posts.filter(p => dtOf(p) >= new Date()).length, n = state.members.filter(m => m.class_id === c.id).length;
    return `<button class="subj" style="--c:var(--primary);width:100%;margin-bottom:10px;min-height:0" data-a="go" data-to="class/${c.id}"><span class="row" style="gap:8px"><span class="em">👥</span><span class="nm grow">${esc(c.name)}</span>${roleBadge(myRole(c.id))}</span><span class="small muted">${n} participante${n === 1 ? '' : 's'} · ${up} atividade${up === 1 ? '' : 's'} por vir</span></button>`;
  }).join('');
  return { title: 'Turmas', html: h };
};

/* ===================== Tela da turma ===================== */
VIEWS.class = id => {
  const c = clsById(id);
  if (!c) return { title: 'Turma', back: true, html: state.syncedOnce ? emptyState('❓', 'Turma não encontrada', 'Ela pode ter sido excluída ou você saiu dela.', '<br><button class="btn" data-a="go" data-to="classes">Ver minhas turmas</button>') : `<div class="loading">Carregando…</div>` };
  if (state.routeChanged) { CL.tab = 'mural'; CL.subject = ''; CL.when = 'upcoming'; CL.mine = ''; }
  const role = myRole(id), admin = role === 'admin';
  let h = '';
  if (!navigator.onLine) h += `<div class="banner small">Você está offline: mostrando a última versão baixada. Publicar e administrar exigem conexão.</div>`;
  h += `<div class="card"><div class="row"><div class="grow"><div class="small muted">Código de convite</div><div class="code-box" aria-label="Código de convite">${esc(fmtCode(c.invite_code))}</div></div><button class="ibtn" data-a="copyCode" data-id="${id}" aria-label="Copiar código">${ICON.copy}</button><button class="ibtn" data-a="shareCode" data-id="${id}" aria-label="Compartilhar convite">${ICON.share}</button></div><div class="small muted" style="margin-top:6px">Para entrar, a pessoa também precisa da senha da turma.</div></div>`;
  const tabs = [['mural', 'Mural'], ['people', 'Participantes']].concat(admin ? [['admin', 'Administração']] : []);
  h += `<div class="seg" style="margin-bottom:12px">${tabs.map(([k, l]) => `<button class="${CL.tab === k ? 'on' : ''}" data-a="classTab" data-v="${k}">${l}</button>`).join('')}</div>`;
  if (CL.tab === 'mural') h += muralHTML(c);
  else if (CL.tab === 'people') h += peopleHTML(c);
  else if (admin) h += adminHTML(c);
  return { title: c.name, back: true, html: h };
};

function filteredPosts(cid) {
  const now = new Date(), wk = new Date(now.getTime() + 7 * DAY);
  return postsOf(cid).filter(p => {
    const d = dtOf(p);
    if (CL.subject && norm(p.subject_name) !== norm(CL.subject)) return false;
    if (CL.when === 'upcoming' && d < now) return false;
    if (CL.when === 'week' && (d < now || d > wk)) return false;
    if (CL.when === 'past' && d >= now) return false;
    if (CL.mine === 'in' && !myActFor(p.id)) return false;
    if (CL.mine === 'out' && myActFor(p.id)) return false;
    return true;
  }).sort((a, b) => CL.when === 'past' ? dtOf(b) - dtOf(a) : dtOf(a) - dtOf(b));
}
function postCard(p, first) {
  const d = dtOf(p), late = d < new Date(), mine = myActFor(p.id), nf = state.postfiles.filter(f => f.post_id === p.id).length;
  const edited = Date.parse(p.updated_at) - Date.parse(p.created_at) > 60000;
  return `<div class="item post ${first ? 'hl' : ''}" style="--c:${esc(p.subject_color || '#64748b')}"><div class="item-main" data-a="postDetail" data-id="${p.id}">
    <div class="item-title">${esc(p.title)}</div>
    <div class="item-meta"><span class="dot"></span>${esc(p.subject_name || 'Sem disciplina')} · <span class="${late ? 'late' : ''}">${late ? 'Prazo passou · ' : ''}${fmtRel(d)}</span></div>
    <div class="item-meta">Publicado por ${avatarHTML(p.author_id, 20)} <b>${esc(nameOf(p.author_id))}</b> em ${fmtDate(new Date(p.created_at))}${edited ? ` · editado em ${fmtDate(new Date(p.updated_at))}` : ''}</div>
    <div class="badges">${nf ? `<span class="badge">${ICON.clip}${nf}</span>` : ''}${mine ? '<span class="badge low">✓ Na sua agenda</span>' : ''}${first ? '<span class="badge high">Próxima entrega</span>' : ''}</div></div>
    <div class="post-act">${mine ? `<button class="btn sm" data-a="openAgendaAct" data-id="${mine.id}">Abrir</button>` : `<button class="btn sm primary" data-a="addToAgenda" data-id="${p.id}">Adicionar à minha agenda</button>`}</div></div>`;
}
function muralHTML(c) {
  const subs = [...new Set(postsOf(c.id).map(p => p.subject_name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const list = filteredPosts(c.id);
  const canPost = myRole(c.id) === 'admin' || (c.settings && c.settings.members_can_post !== false);
  const firstUp = list.find(p => dtOf(p) >= new Date());
  let h = canPost ? `<button class="btn primary block" style="margin-bottom:12px" data-a="newPost" data-id="${c.id}">＋ Publicar atividade</button>` : `<div class="small muted" style="margin-bottom:10px">Nesta turma só os administradores publicam.</div>`;
  h += `<div class="grid2" style="margin-bottom:8px"><select id="cf-subj" aria-label="Disciplina"><option value="">Todas as disciplinas</option>${subs.map(s => `<option ${norm(CL.subject) === norm(s) ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
    <select id="cf-when" aria-label="Prazo">${[['upcoming', 'Próximas'], ['week', 'Esta semana'], ['past', 'Prazo já passou'], ['all', 'Todas']].map(([k, l]) => `<option value="${k}" ${CL.when === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <select id="cf-mine" style="margin-bottom:12px" aria-label="Estado"><option value="">Todas (na minha agenda ou não)</option><option value="in" ${CL.mine === 'in' ? 'selected' : ''}>Já na minha agenda</option><option value="out" ${CL.mine === 'out' ? 'selected' : ''}>Ainda não adicionadas</option></select>`;
  h += list.length ? list.map(p => postCard(p, firstUp && p.id === firstUp.id)).join('') : emptyState('📋', postsOf(c.id).length ? 'Nada com esses filtros' : 'O mural está vazio', postsOf(c.id).length ? 'Mude os filtros para ver outras publicações.' : 'Publique a primeira atividade para os colegas.');
  return h;
}
function peopleHTML(c) {
  const admin = myRole(c.id) === 'admin';
  const ms = state.members.filter(m => m.class_id === c.id).sort((a, b) => (a.role === b.role ? nameOf(a.user_id).localeCompare(nameOf(b.user_id), 'pt-BR') : a.role === 'admin' ? -1 : 1));
  let h = `<div class="small muted" style="margin-bottom:8px">${ms.length} participante${ms.length === 1 ? '' : 's'}</div>` + ms.map(m => {
    const me = m.user_id === state.user.id;
    return `<div class="frow">${avatarHTML(m.user_id, 44)}<div class="grow"><div style="font-weight:600;overflow-wrap:anywhere">${esc(nameOf(m.user_id))}${me ? ' <span class="muted small">(você)</span>' : ''}</div><div class="small muted">Desde ${fmtDate(new Date(m.joined_at))}</div></div>${roleBadge(m.role)}
      ${admin && !me ? `<button class="ibtn" data-a="memberMenu" data-c="${c.id}" data-u="${m.user_id}" aria-label="Opções de ${esc(nameOf(m.user_id))}">⋯</button>` : ''}</div>`;
  }).join('');
  h += `<button class="btn block ghost-danger" style="margin-top:14px" data-a="leaveClass" data-id="${c.id}">Sair da turma</button>`;
  return h;
}
function adminHTML(c) {
  const mp = !(c.settings && c.settings.members_can_post === false);
  return `<div class="card"><b>Configurações</b><label class="field" style="margin-top:10px"><span>Nome da turma</span><input id="ad-name" maxlength="60" value="${esc(c.name)}"></label><label class="setrow"><input type="checkbox" id="ad-mp" ${mp ? 'checked' : ''}>Participantes comuns podem publicar</label><button class="btn primary block" style="margin-top:8px" data-a="saveClassEdit" data-id="${c.id}">Salvar</button></div>
  <div class="card"><b>Senha de entrada</b><p class="small muted" style="margin:4px 0 10px">A senha nunca é exibida nem guardada em texto puro. Trocar a senha vale só para <b>novas entradas</b>; quem já está na turma continua nela.</p><label class="field"><span>Nova senha (mínimo 6 caracteres)</span><input id="ad-pw" type="password" autocomplete="new-password"></label><label class="setrow"><input type="checkbox" id="ad-kick">Também remover os participantes atuais (administradores ficam)</label><button class="btn block" style="margin-top:8px" data-a="savePassword" data-id="${c.id}">Trocar senha</button></div>
  <div class="card"><b>Código de convite</b><p class="small muted" style="margin:4px 0 10px">Se o código vazou, gere outro. O código antigo para de funcionar.</p><button class="btn block" data-a="regenCode" data-id="${c.id}">Gerar novo código</button></div>
  <div class="card"><b>Excluir turma</b><p class="small muted" style="margin:4px 0 10px">Apaga o mural, os anexos e a lista de participantes. As atividades que os colegas já adicionaram às próprias agendas <b>continuam</b> com eles.</p><button class="btn block ghost-danger" data-a="delClass" data-id="${c.id}">Excluir turma…</button></div>`;
}

/* ===================== Criar / entrar ===================== */
function codeSheet(title, code, extra) {
  openSheet(`${sheetHead(title)}<div class="sheet-body"><p class="muted" style="margin-top:0">${extra}</p><div class="code-box big">${esc(fmtCode(code))}</div><p class="small muted">Passe o código e a senha aos colegas. Por segurança, a senha não fica visível depois.</p></div><div class="sheet-foot"><button class="btn" data-a="copyCodeRaw" data-code="${esc(code)}">Copiar código</button><button class="btn primary" data-a="closeSheet">Pronto</button></div>`);
}
async function copyText(t) { try { await navigator.clipboard.writeText(t); toast('Copiado.'); } catch (e) { window.prompt('Copie o texto:', t); } }

/* ===================== Publicações ===================== */
function formPostFilesHTML() {
  const f = state.form; if (!f || f.type !== 'post') return '';
  const old = f.id ? state.postfiles.filter(x => x.post_id === f.id && !f.removeIds.includes(x.id)) : [];
  const rows = [...old.map(x => `<div class="crow"><div class="ext ${extOf(x.name)}" style="width:36px;height:36px">${extOf(x.name)}</div><span class="grow small" style="overflow-wrap:anywhere">${esc(x.name)} · ${fmtSize(x.size)}</span><button class="ibtn d" data-a="ppRmOld" data-id="${x.id}" aria-label="Remover anexo">${ICON.x}</button></div>`),
    ...f.newFiles.map((x, i) => `<div class="crow"><div class="ext ${extOf(x.name)}" style="width:36px;height:36px">${extOf(x.name)}</div><span class="grow small" style="overflow-wrap:anywhere">${esc(x.name)} · ${fmtSize(x.size)} <i class="muted">(novo)</i></span><button class="ibtn d" data-a="ppRmNew" data-i="${i}" aria-label="Remover anexo">${ICON.x}</button></div>`)];
  return rows.join('') || '<div class="small muted" style="margin-bottom:8px">Nenhum arquivo anexado.</div>';
}
function openPostForm(classId, id) {
  const p = id ? state.posts.find(x => x.id === id) : null;
  state.form = { type: 'post', classId, id: p ? p.id : null, newFiles: [], removeIds: [] };
  const d = p ? dtOf(p) : null;
  openSheet(`${sheetHead(p ? 'Editar publicação' : 'Publicar atividade')}<div class="sheet-body">
    <label class="field"><span>Título *</span><input id="pp-title" maxlength="120" value="${esc(p ? p.title : '')}" placeholder="Ex.: Lista de exercícios 3"></label>
    <label class="field"><span>Disciplina</span><input id="pp-subj" maxlength="40" list="pp-subj-list" value="${esc(p ? p.subject_name : '')}" placeholder="Ex.: Matemática"><datalist id="pp-subj-list">${state.subjects.map(s => `<option value="${esc(s.name)}">`).join('')}</datalist></label>
    <div class="grid2"><label class="field"><span>Data de entrega *</span><input type="date" id="pp-date" value="${d ? ymd(d) : ymd(addDays(new Date(), 1))}"></label><label class="field"><span>Horário</span><input type="time" id="pp-time" value="${d ? fmtHM(d) : '23:59'}"></label></div>
    <label class="field"><span>Descrição ou enunciado</span><textarea id="pp-desc" maxlength="5000">${esc(p ? p.descr : '')}</textarea></label>
    <div class="field"><span>Arquivos (até ${fmtSize(MAX_FILE_BYTES)} cada)</span><div id="pp-files"></div><button class="btn sm" data-a="ppPick">${ICON.clip} Anexar arquivos</button></div>
    <div id="pp-status" class="small muted" role="status"></div>
  </div><div class="sheet-foot"><button class="btn" data-a="closeSheet">Cancelar</button><button class="btn primary" id="pp-save" data-a="savePost">${p ? 'Salvar' : 'Publicar'}</button></div>`);
  $('#pp-files').innerHTML = formPostFilesHTML();
}
async function savePost() {
  const f = state.form; if (!f || f.type !== 'post') return;
  const title = $('#pp-title').value.trim(), date = $('#pp-date').value, time = $('#pp-time').value || '23:59';
  if (!title) return fieldErr('pp-title', 'Informe o título.');
  if (!date || !parseLocal(`${date}T${time}`)) return fieldErr('pp-date', 'Informe uma data de entrega válida.');
  const big = f.newFiles.find(x => x.size > MAX_FILE_BYTES);
  if (big) return toast(`“${big.name}” passa do limite de ${fmtSize(MAX_FILE_BYTES)}.`, { err: true });
  if (!needOnline()) return;
  const subjName = $('#pp-subj').value.trim();
  const mine = state.subjects.find(s => norm(s.name) === norm(subjName));
  const row = { title, subject_name: subjName, subject_color: mine ? mine.color : '#64748b', descr: $('#pp-desc').value.trim(), due: `${date}T${time}` };
  const btn = $('#pp-save'), status = $('#pp-status'); btn.disabled = true; btn.textContent = 'Enviando…';
  const failures = [];
  try {
    let pid = f.id;
    if (!pid) { pid = uid(); await Cloud.table(c => c.from('posts').insert({ id: pid, class_id: f.classId, author_id: state.user.id, ...row })); }
    else await Cloud.table(c => c.from('posts').update(row).eq('id', pid));
    let i = 0;
    for (const file of f.newFiles) {
      i++; status.textContent = `Enviando arquivo ${i} de ${f.newFiles.length}: ${file.name}`;
      try {
        const fid = uid(), path = `c/${f.classId}/${pid}/${state.user.id}/${fid}`;
        await Cloud.uploadClassFile(path, file);
        await Cloud.table(c => c.from('post_files').insert({ id: fid, post_id: pid, class_id: f.classId, uploader_id: state.user.id, name: file.name, mime: file.type || '', size: file.size, storage_path: path }));
      } catch (e) { failures.push(`${file.name}: ${e.message}`); }
    }
    for (const rid of f.removeIds) {
      const pf = state.postfiles.find(x => x.id === rid); if (!pf) continue;
      try { await Cloud.table(c => c.from('post_files').delete().eq('id', rid)); await Cloud.removeStorage([pf.storage_path]); } catch (e) { failures.push(`remover ${pf.name}: ${e.message}`); }
    }
    await Cloud.sync();
    closeSheet(); render();
    if (failures.length) toast(`Publicado, mas ${failures.length} arquivo(s) falharam: ${failures[0]}. Edite a publicação para anexar de novo.`, { err: true });
    else toast(f.id ? 'Publicação atualizada.' : 'Atividade publicada na turma.');
  } catch (e) {
    btn.disabled = false; btn.textContent = f.id ? 'Salvar' : 'Publicar';
    status.textContent = '';
    toast('Não foi possível publicar: ' + e.message, { err: true });
    await Cloud.sync().catch(() => { });
  }
}
function openPostDetail(id) {
  const p = state.posts.find(x => x.id === id); if (!p) return;
  const c = clsById(p.class_id), me = state.user.id, canEdit = p.author_id === me, canDel = canEdit || myRole(p.class_id) === 'admin';
  const mine = myActFor(id), files = state.postfiles.filter(f => f.post_id === id), d = dtOf(p);
  const edited = Date.parse(p.updated_at) - Date.parse(p.created_at) > 60000;
  state.form = { type: 'postDetail', id };
  openSheet(`${sheetHead(p.title)}<div class="sheet-body">
    <dl class="kv"><dt>Turma</dt><dd>${esc(c ? c.name : '—')}</dd><dt>Disciplina</dt><dd><span class="dot" style="--c:${esc(p.subject_color)}"></span>${esc(p.subject_name || '—')}</dd><dt>Entrega</dt><dd>${fmtDT(d)}</dd><dt>Autor</dt><dd>${esc(nameOf(p.author_id))}</dd><dt>Publicada em</dt><dd>${fmtDT(new Date(p.created_at))}</dd>${edited ? `<dt>Atualizada em</dt><dd>${fmtDT(new Date(p.updated_at))}</dd>` : ''}</dl>
    ${p.descr ? `<div class="small muted">Descrição</div><p class="pre" style="margin-top:2px">${esc(p.descr)}</p>` : ''}
    <div class="small muted" style="margin:10px 0 6px">Arquivos (${files.length})</div>${files.length ? files.map(pfRow).join('') : '<div class="small muted">Nenhum arquivo anexado.</div>'}
    <div class="hr"></div><div class="grid2">${canEdit ? `<button class="btn" data-a="editPost" data-id="${id}">${ICON.edit} Editar</button>` : ''}${canDel ? `<button class="btn ghost-danger" data-a="delPost" data-id="${id}">${ICON.trash} Excluir</button>` : ''}</div>
  </div><div class="sheet-foot">${mine ? `<button class="btn" data-a="openAgendaAct" data-id="${mine.id}">Ver na minha agenda</button>` : `<button class="btn primary" data-a="addToAgenda" data-id="${id}">Adicionar à minha agenda</button>`}</div>`);
}

/* ---------- adicionar à agenda pessoal ---------- */
function addToAgenda(pid) {
  const p = state.posts.find(x => x.id === pid);
  if (!p || p.deleted_at) return toast('Esta publicação não está mais disponível.', { err: true });
  const ex = myActFor(pid);
  if (ex) { toast('Esta publicação já está na sua agenda.'); return openActDetail(ex.id); }
  if (!needOnline()) return;
  const match = state.subjects.find(s => norm(s.name) === norm(p.subject_name));
  if (match) return doAddToAgenda(pid, match.id);
  closeSheet(true);
  state.form = { type: 'agenda', postId: pid };
  openSheet(`${sheetHead('Em qual disciplina?')}<div class="sheet-body"><p class="muted" style="margin-top:0">A publicação é de <b>${esc(p.subject_name || 'sem disciplina')}</b>, mas você não tem uma disciplina com esse nome. Escolha como organizá-la, sem criar duplicatas.</p>
    <label class="field"><span>Disciplina na sua agenda</span><select id="ag-subj">${p.subject_name ? `<option value="__new">Criar “${esc(p.subject_name)}”</option>` : ''}${state.subjects.map(s => `<option value="${s.id}">${esc((s.icon ? s.icon + ' ' : '') + s.name)}</option>`).join('')}</select></label>
    ${!p.subject_name && !state.subjects.length ? '<p class="small muted">Crie uma disciplina antes (Início › Nova disciplina).</p>' : ''}</div><div class="sheet-foot"><button class="btn" data-a="closeSheet">Cancelar</button><button class="btn primary" data-a="confirmAgenda">Adicionar</button></div>`);
}
async function doAddToAgenda(pid, subjectId) {
  const p = state.posts.find(x => x.id === pid);
  try {
    let sid = subjectId;
    if (sid === '__new') {
      const rec = { id: uid(), name: p.subject_name.slice(0, 40), color: /^#[0-9a-f]{6}$/i.test(p.subject_color) ? p.subject_color : '#64748b', icon: '', createdAt: Date.now() };
      await DB.put('subjects', rec); sid = rec.id;
    }
    if (!sid) return toast('Escolha uma disciplina.', { err: true });
    if ((await Cloud.flushAll()) > 0) throw new Error('Não foi possível enviar sua disciplina agora. Tente de novo.');   // a disciplina precisa existir no servidor
    const dr = state.settings.defaultReminders || [];
    const r = await Cloud.rpc('add_post_to_agenda', { p_post: pid, p_subject: sid, p_rem: { on: dr.length > 0, keys: dr, custom: [] } });
    await Cloud.sync(); closeSheet(); render();
    toast(r.already ? 'Esta publicação já estava na sua agenda.' : 'Adicionada à sua agenda. A conclusão é só sua.');
  } catch (e) { toast('Não foi possível adicionar: ' + e.message, { err: true }); }
}

/* ===================== Ações ===================== */
Object.assign(ACT, {
  classTab: d => { CL.tab = d.v; render(); },
  newClass: () => { closeSheet(true); state.form = { type: 'newClass' }; openSheet(`${sheetHead('Criar turma')}<div class="sheet-body"><label class="field"><span>Nome da turma *</span><input id="nc-name" maxlength="60" placeholder="Ex.: 3º Ano A — CESA"></label><label class="field"><span>Senha de entrada * (mínimo 6 caracteres)</span><input id="nc-pw" type="password" autocomplete="new-password"></label><label class="field"><span>Repita a senha</span><input id="nc-pw2" type="password" autocomplete="new-password"></label><p class="small muted">Você será o administrador. Um código de convite será gerado. Quem tiver o código <b>e</b> a senha poderá entrar.</p></div><div class="sheet-foot"><button class="btn" data-a="closeSheet">Cancelar</button><button class="btn primary" id="nc-save" data-a="saveNewClass">Criar turma</button></div>`); },
  saveNewClass: async () => {
    const name = $('#nc-name').value.trim(), pw = $('#nc-pw').value, pw2 = $('#nc-pw2').value;
    if (!name) return fieldErr('nc-name', 'Informe o nome da turma.');
    if (pw.length < 6) return fieldErr('nc-pw', 'A senha precisa ter pelo menos 6 caracteres.');
    if (pw !== pw2) return fieldErr('nc-pw2', 'As senhas não são iguais.');
    if (!needOnline()) return;
    const b = $('#nc-save'); b.disabled = true; b.textContent = 'Criando…';
    try {
      const r = await Cloud.rpc('create_class', { p_name: name, p_password: pw });
      await Cloud.sync(); closeSheet(true);
      location.hash = '#/class/' + r.id;
      setTimeout(() => codeSheet('Turma criada!', r.invite_code, `A turma <b>${esc(name)}</b> está pronta.`), 150);
    } catch (e) { b.disabled = false; b.textContent = 'Criar turma'; toast('Não foi possível criar a turma: ' + e.message, { err: true }); }
  },
  joinClass: () => { closeSheet(true); state.form = { type: 'join' }; openSheet(`${sheetHead('Entrar em turma')}<div class="sheet-body"><label class="field"><span>Código da turma</span><input id="jn-code" maxlength="12" autocapitalize="characters" autocomplete="off" placeholder="XXXX-XXXX" style="text-transform:uppercase"></label><label class="field"><span>Senha</span><input id="jn-pw" type="password" autocomplete="off"></label><div id="jn-err" class="auth-msg err" role="alert" hidden></div></div><div class="sheet-foot"><button class="btn" data-a="closeSheet">Cancelar</button><button class="btn primary" id="jn-save" data-a="saveJoin">Entrar</button></div>`); },
  saveJoin: async () => {
    const code = $('#jn-code').value.trim(), pw = $('#jn-pw').value, err = $('#jn-err');
    const show = t => { err.textContent = t; err.hidden = false; };
    if (!code || !pw) return show('Informe o código e a senha da turma.');
    if (!needOnline()) return;
    const b = $('#jn-save'); b.disabled = true; b.textContent = 'Entrando…';
    try {
      const r = await Cloud.rpc('join_class', { p_code: code, p_password: pw });
      if (!r || !r.ok) { b.disabled = false; b.textContent = 'Entrar'; return show(r && r.error === 'rate_limited' ? 'Muitas tentativas. Aguarde alguns minutos e tente de novo.' : 'Não foi possível entrar. Confira o código e a senha.'); }
      await Cloud.sync(); closeSheet(true); location.hash = '#/class/' + r.class_id; toast('Você entrou na turma.');
    } catch (e) { b.disabled = false; b.textContent = 'Entrar'; show(e.message); }
  },
  copyCode: d => { const c = clsById(d.id); if (c) copyText(fmtCode(c.invite_code)); },
  copyCodeRaw: d => copyText(fmtCode(d.code)),
  shareCode: async d => {
    const c = clsById(d.id); if (!c) return;
    const text = `Entre na turma “${c.name}” no Organizador Escolar.\nCódigo: ${fmtCode(c.invite_code)}\n(peça a senha ao administrador)\n${location.origin}`;
    try { if (navigator.share) await navigator.share({ title: 'Convite para a turma', text }); else await copyText(text); } catch (e) { if (e.name !== 'AbortError') copyText(text); }
  },
  newPost: d => { closeSheet(true); openPostForm(d.id, null); },
  editPost: d => { const p = state.posts.find(x => x.id === d.id); closeSheet(true); if (p) openPostForm(p.class_id, p.id); },
  ppPick: () => pickFiles(true, list => { state.form.newFiles.push(...list); $('#pp-files').innerHTML = formPostFilesHTML(); }),
  ppRmNew: d => { state.form.newFiles.splice(+d.i, 1); $('#pp-files').innerHTML = formPostFilesHTML(); },
  ppRmOld: d => { state.form.removeIds.push(d.id); $('#pp-files').innerHTML = formPostFilesHTML(); },
  savePost: () => savePost(),
  postDetail: d => { closeSheet(true); openPostDetail(d.id); },
  delPost: async d => {
    const p = state.posts.find(x => x.id === d.id); if (!p) return;
    if (!await confirmDlg('Excluir publicação?', `<b>${esc(p.title)}</b> sai do mural. Quem já adicionou a atividade à própria agenda <b>continua com ela</b>.`)) return;
    if (!needOnline()) return;
    try {
      const r = await Cloud.rpc('delete_post', { p_post: d.id });
      if (r && r.mode === 'hard' && r.paths && r.paths.length) { try { await Cloud.removeStorage(r.paths); } catch (e) { toast('Publicação excluída, mas alguns anexos não puderam ser apagados do armazenamento.', { err: true }); } }
      await Cloud.sync(); closeSheet(); render(); toast('Publicação excluída.');
    } catch (e) { toast('Não foi possível excluir: ' + e.message, { err: true }); }
  },
  pfOpen: async d => {
    const pf = state.postfiles.find(x => x.id === d.id); if (!pf) return;
    try { const b = await Cloud.postFileBlob(pf); if (Native) return await deliverFile(b, pf.name); const url = URL.createObjectURL(b); if (!window.open(url, '_blank')) await deliverFile(b, pf.name); setTimeout(() => URL.revokeObjectURL(url), 120000); }
    catch (e) { toast('Não foi possível abrir: ' + e.message, { err: true }); }
  },
  pfDl: async d => { const pf = state.postfiles.find(x => x.id === d.id); if (!pf) return; try { await deliverFile(await Cloud.postFileBlob(pf), pf.name); } catch (e) { if (e.name !== 'AbortError') toast('Não foi possível baixar: ' + e.message, { err: true }); } },
  addToAgenda: d => addToAgenda(d.id),
  confirmAgenda: () => { const pid = state.form.postId; const v = $('#ag-subj').value; doAddToAgenda(pid, v); },
  openAgendaAct: d => { closeSheet(true); openActDetail(d.id); },
  resolvePost: async d => {
    const a = state.activities.find(x => x.id === d.id), p = a && state.posts.find(x => x.id === a.postId); if (!a || !p) return;
    const theirs = { title: p.title, desc: p.descr || '', due: String(p.due).slice(0, 16) };
    const upd = { ...a, postSnapshot: { ...(a.postSnapshot || {}), [d.f]: theirs[d.f] } };
    if (d.v === 'theirs') upd[d.f] = theirs[d.f];
    try { await DB.put('activities', upd); await refresh(); closeSheet(true); openActDetail(a.id); } catch (e) { toast('Não foi possível salvar: ' + errMsg(e), { err: true }); }
  },
  saveClassEdit: async d => {
    const name = $('#ad-name').value.trim(); if (!name) return fieldErr('ad-name', 'Informe o nome da turma.');
    if (!needOnline()) return;
    try { await Cloud.rpc('update_class', { p_class: d.id, p_name: name, p_members_can_post: $('#ad-mp').checked }); await Cloud.sync(); render(); toast('Turma atualizada.'); }
    catch (e) { toast('Não foi possível salvar: ' + e.message, { err: true }); }
  },
  savePassword: async d => {
    const pw = $('#ad-pw').value, kick = $('#ad-kick').checked;
    if (pw.length < 6) return fieldErr('ad-pw', 'A senha precisa ter pelo menos 6 caracteres.');
    if (!needOnline()) return;
    if (kick && !await confirmDlg('Remover participantes?', 'Todos os participantes comuns serão removidos da turma e perderão o acesso. Os administradores ficam.', 'Trocar e remover')) return;
    try { await Cloud.rpc('set_class_password', { p_class: d.id, p_new: pw, p_remove_members: kick }); $('#ad-pw').value = ''; $('#ad-kick').checked = false; await Cloud.sync(); render(); toast(kick ? 'Senha trocada e participantes removidos.' : 'Senha trocada. Quem já está na turma continua nela.'); }
    catch (e) { toast('Não foi possível trocar a senha: ' + e.message, { err: true }); }
  },
  regenCode: async d => {
    if (!await confirmDlg('Gerar novo código?', 'O código atual deixa de funcionar. Quem já está na turma não é afetado.', 'Gerar novo')) return;
    if (!needOnline()) return;
    try { const code = await Cloud.rpc('regenerate_invite_code', { p_class: d.id }); await Cloud.sync(); render(); codeSheet('Novo código', code, 'O código foi renovado.'); }
    catch (e) { toast('Não foi possível gerar: ' + e.message, { err: true }); }
  },
  memberMenu: async d => {
    const m = state.members.find(x => x.class_id === d.c && x.user_id === d.u); if (!m) return;
    const isAdm = m.role === 'admin', nm = nameOf(d.u);
    const r = await dialog({ title: nm, msg: isAdm ? 'Esta pessoa é administradora.' : 'Participante da turma.', actions: [isAdm ? { label: 'Remover cargo de administrador', value: 'demote' } : { label: 'Tornar administrador', kind: 'primary', value: 'promote' }, ...(isAdm ? [] : [{ label: 'Remover da turma', kind: 'danger', value: 'remove' }]), { label: 'Cancelar', value: null }] });
    if (!r || !needOnline()) return;
    try {
      if (r === 'remove') { if (!await confirmDlg('Remover participante?', `<b>${esc(nm)}</b> perde o acesso ao mural e aos anexos. As atividades que já adicionou à própria agenda continuam com ele.`, 'Remover')) return; await Cloud.rpc('remove_member', { p_class: d.c, p_user: d.u }); }
      else await Cloud.rpc('set_member_role', { p_class: d.c, p_user: d.u, p_role: r === 'promote' ? 'admin' : 'member' });
      await Cloud.sync(); render(); toast('Pronto.');
    } catch (e) { toast('Não foi possível concluir: ' + e.message, { err: true }); }
  },
  leaveClass: async d => {
    const c = clsById(d.id); if (!c) return;
    if (!await confirmDlg('Sair da turma?', `Você deixa de ver o mural de <b>${esc(c.name)}</b>. Suas atividades pessoais continuam, inclusive as que vieram do mural.`, 'Sair da turma')) return;
    if (!needOnline()) return;
    try { await Cloud.rpc('leave_class', { p_class: d.id }); await Cloud.sync(); location.hash = '#/classes'; toast('Você saiu da turma.'); }
    catch (e) { toast('Não foi possível sair: ' + e.message, { err: true }); }
  },
  delClass: async d => {
    const c = clsById(d.id); if (!c) return;
    if (!await confirmDlg('Excluir a turma?', `<b>${esc(c.name)}</b> será apagada para todos: mural, anexos e participantes. As atividades que os colegas já adicionaram às agendas continuam com eles.`, 'Continuar')) return;
    if (!await confirmDlg('Última confirmação', 'Esta ação não pode ser desfeita.', 'Excluir turma')) return;
    if (!needOnline()) return;
    try {
      const paths = state.postfiles.filter(f => f.class_id === d.id).map(f => f.storage_path);
      if (paths.length) await Cloud.removeStorage(paths);          // antes de excluir: a permissão de apagar anexos depende da turma existir
      await Cloud.rpc('delete_class', { p_class: d.id });
      await Cloud.sync(); location.hash = '#/classes'; toast('Turma excluída.');
    } catch (e) { toast('Não foi possível excluir: ' + e.message, { err: true }); }
  }
});

document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'cf-subj') { CL.subject = t.value; render(); }
  else if (t.id === 'cf-when') { CL.when = t.value; render(); }
  else if (t.id === 'cf-mine') { CL.mine = t.value; render(); }
});
