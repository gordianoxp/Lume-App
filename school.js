/* ===================== Notas e horário de aulas =====================
   Tudo fica em state.settings (grades, gradeRules, schedule): já é sincronizado com a conta e entra no backup. */

/* ---------- Notas ---------- */
const GRADE_DEFAULTS = { max: [30, 30, 40], pass: [21, 21, 28], total: 70 };
const ORD = ['1º', '2º', '3º'];
const posNum = (v, d) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : d);
function gradeRules() {
  const r = state.settings.gradeRules || {};
  const arr = k => [0, 1, 2].map(i => posNum(r[k] && r[k][i], GRADE_DEFAULTS[k][i]));
  return { max: arr('max'), pass: arr('pass'), total: posNum(r.total, GRADE_DEFAULTS.total) };
}
const fmtNum = n => String(Math.round(n * 100) / 100).replace('.', ',');
const parseGrade = s => { const t = String(s ?? '').trim().replace(',', '.'); if (t === '') return null; const n = Number(t); return isFinite(n) ? n : NaN; };
const gradesOf = sid => { const g = (state.settings.grades || {})[sid] || []; return [0, 1, 2].map(i => (typeof g[i] === 'number' && isFinite(g[i]) ? g[i] : null)); };

/* Situação da disciplina: soma o que já foi lançado e calcula quanto falta nos trimestres vazios */
function gradeStatus(sid) {
  const R = gradeRules(), g = gradesOf(sid);
  const filled = [0, 1, 2].filter(i => g[i] != null), empty = [0, 1, 2].filter(i => g[i] == null);
  const sum = filled.reduce((n, i) => n + g[i], 0);
  if (!filled.length) return { sum, cls: 'idle', msg: 'Anote as notas conforme forem saindo e eu calculo o que falta.' };
  if (!empty.length) {
    return sum >= R.total
      ? { sum, cls: 'ok', msg: `Aprovado com <b>${fmtNum(sum)}</b> pontos (mínimo ${fmtNum(R.total)}).` }
      : { sum, cls: 'bad', msg: `Abaixo do mínimo: <b>${fmtNum(sum)}</b> de ${fmtNum(R.total)} (faltaram ${fmtNum(R.total - sum)}).` };
  }
  const need = R.total - sum, remMax = empty.reduce((n, i) => n + R.max[i], 0);
  const names = empty.map(i => ORD[i]);
  const where = empty.length === 1 ? `no ${names[0]} trimestre` : `nos ${names.slice(0, -1).join(', ')} e ${names[names.length - 1]} trimestres`;
  if (need <= 0) return { sum, cls: 'ok', msg: `Já garantiu os ${fmtNum(R.total)} pontos: <b>aprovado</b>.` };
  if (need > remMax + 1e-9) return { sum, cls: 'bad', msg: `Não dá mais para chegar a ${fmtNum(R.total)}: mesmo com a nota máxima ${where} (${fmtNum(remMax)}) faltariam <b>${fmtNum(need - remMax)}</b>.` };
  if (empty.length === 1) return { sum, cls: 'need', need, msg: `Precisa de <b>${fmtNum(need)}</b> ${where} <span class="muted">(de ${fmtNum(R.max[empty[0]])} · ${Math.round(need / R.max[empty[0]] * 100)}%)</span>.` };
  return { sum, cls: 'need', need, msg: `Faltam <b>${fmtNum(need)}</b> pontos ${where} <span class="muted">(de ${fmtNum(remMax)} possíveis)</span>.` };
}
const gradeInputCls = (v, i, R) => (v == null ? '' : v >= R.pass[i] ? 'hi' : 'lo');
function gradeCardHTML(s) {
  const R = gradeRules(), g = gradesOf(s.id), st = gradeStatus(s.id);
  return `<div class="card gcard" data-sid="${s.id}" style="--c:${esc(s.color)}">
    <div class="gh"><span class="em">${esc(s.icon || '📘')}</span><b>${esc(s.name)}</b><span class="gtot">${gradeTotHTML(st, R)}</span></div>
    <div class="gin-row">${[0, 1, 2].map(i => `<label class="gf"><span>${ORD[i]} trimestre</span><span class="gi"><input class="gin ${gradeInputCls(g[i], i, R)}" inputmode="decimal" autocomplete="off" data-sid="${s.id}" data-t="${i}" value="${g[i] == null ? '' : fmtNum(g[i])}" placeholder="–" aria-label="Nota do ${ORD[i]} trimestre de ${esc(s.name)}"><i>/${fmtNum(R.max[i])}</i></span></label>`).join('')}</div>
    <div class="gstat ${st.cls}">${st.msg}</div></div>`;
}
const gradeTotHTML = (st, R) => `<b>${fmtNum(st.sum)}</b><i>/${fmtNum(R.total)}</i>`;
function gradeSummaryHTML() {
  const sts = state.subjects.map(s => gradeStatus(s.id)), n = c => sts.filter(x => x.cls === c).length;
  return `<div class="stat" style="--c:var(--ok)"><b>${n('ok')}</b><span>Aprovadas</span></div><div class="stat" style="--c:#0ea5e9"><b>${n('need')}</b><span>Precisam de nota</span></div><div class="stat" style="--c:var(--danger)"><b>${n('bad')}</b><span>Em risco</span></div><div class="stat" style="--c:#64748b"><b>${n('idle')}</b><span>Sem notas</span></div>`;
}
function gradeRulesLine() {
  const R = gradeRules();
  return `${[0, 1, 2].map(i => `${ORD[i]} tri: até <b>${fmtNum(R.max[i])}</b> (média ${fmtNum(R.pass[i])})`).join(' · ')} · Para passar de ano: <b>${fmtNum(R.total)}</b> de ${fmtNum(R.max.reduce((a, b) => a + b, 0))} pontos`;
}
VIEWS.grades = () => {
  if (!state.subjects.length) return { title: 'Notas', back: true, html: emptyState('📝', 'Sem disciplinas ainda', 'Crie suas disciplinas para anotar as notas de cada trimestre.', `<button class="btn primary" style="margin-top:12px" data-a="newSubj">Criar disciplina</button>`) };
  return { title: 'Notas', back: true, html: `<div class="card grules"><div class="small">${gradeRulesLine()}</div><button class="link" data-a="editGradeRules">Editar regras</button></div>
    <div class="stats gsum" id="gsum">${gradeSummaryHTML()}</div>
    <div class="gr-grid">${state.subjects.map(gradeCardHTML).join('')}</div>
    <p class="muted small" style="margin:14px 2px 0">Digite a nota de cada trimestre e saia do campo: ela é salva sozinha e sincronizada com a sua conta. Use vírgula para decimais (ex.: 27,5).</p>` };
};
function updateGradeCard(sid) {
  const card = $(`.gcard[data-sid="${sid}"]`); if (!card) return;
  const R = gradeRules(), g = gradesOf(sid), st = gradeStatus(sid);
  card.querySelector('.gtot').innerHTML = gradeTotHTML(st, R);
  const el = card.querySelector('.gstat'); el.className = 'gstat ' + st.cls; el.innerHTML = st.msg;
  card.querySelectorAll('.gin').forEach(inp => { const i = +inp.dataset.t; inp.classList.remove('hi', 'lo'); const c = gradeInputCls(g[i], i, R); if (c) inp.classList.add(c); });
  const sum = $('#gsum'); if (sum) sum.innerHTML = gradeSummaryHTML();
}
async function gradeChanged(inp) {
  const sid = inp.dataset.sid, i = +inp.dataset.t, R = gradeRules(), v = parseGrade(inp.value);
  const prev = gradesOf(sid)[i];
  if (Number.isNaN(v) || (v != null && (v < 0 || v > R.max[i]))) {
    toast(`Digite uma nota de 0 a ${fmtNum(R.max[i])} para o ${ORD[i]} trimestre.`, { err: true });
    inp.value = prev == null ? '' : fmtNum(prev); return;
  }
  const all = { ...(state.settings.grades || {}) }, arr = gradesOf(sid); arr[i] = v; all[sid] = arr;
  await saveSettings({ grades: all });
  inp.value = v == null ? '' : fmtNum(v);
  updateGradeCard(sid);
}

/* ---------- Horário de aulas ---------- */
const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const toMin = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? (+m[1]) * 60 + (+m[2]) : null; };
const fmtMin = m => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
const SCHED_DEFAULT = { start: '07:00', dur: 50, lessons: 6, breaks: [{ after: 3, min: 15 }], days: [1, 2, 3, 4, 5] };
function schedule() {
  const s = state.settings.schedule || {};
  const lessons = clampInt(s.lessons, 1, 12, SCHED_DEFAULT.lessons);
  const breaks = (Array.isArray(s.breaks) ? s.breaks : SCHED_DEFAULT.breaks).map(b => ({ after: clampInt(b && b.after, 1, 11, 0), min: clampInt(b && b.min, 1, 180, 0) })).filter(b => b.after >= 1 && b.after < lessons && b.min > 0);
  const days = (Array.isArray(s.days) ? s.days : SCHED_DEFAULT.days).filter(d => Number.isInteger(d) && d >= 0 && d <= 6);
  return { start: toMin(s.start) != null ? s.start : SCHED_DEFAULT.start, dur: clampInt(s.dur, 10, 240, SCHED_DEFAULT.dur), lessons, breaks, days: days.length ? days : SCHED_DEFAULT.days, grid: s.grid && typeof s.grid === 'object' ? s.grid : {} };
}
function slotTimes(sc) {
  const slots = [], brs = []; let t = toMin(sc.start);
  for (let n = 1; n <= sc.lessons; n++) {
    slots.push({ n, s: fmtMin(t), e: fmtMin(t + sc.dur), sm: t, em: t + sc.dur }); t += sc.dur;
    const b = sc.breaks.find(x => x.after === n);
    if (b) { brs.push({ after: n, s: fmtMin(t), e: fmtMin(t + b.min) }); t += b.min; }
  }
  return { slots, brs };
}
const subjAt = (sc, dow, i) => { const id = (sc.grid[dow] || [])[i]; return id ? state.subjects.find(s => s.id === id) || null : null; };
const lessonsOn = (sc, sid, dow) => (sc.days.includes(dow) ? Array.from({ length: sc.lessons }, (_, i) => i).filter(i => (sc.grid[dow] || [])[i] === sid) : []);
const dayOrder = days => [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));       // segunda primeiro
function lessonLabel(sc, ls) {
  const T = slotTimes(sc).slots, n = ls.map(i => `${i + 1}ª`);
  const txt = n.length === 1 ? `${n[0]} aula` : `${n.slice(0, -1).join(', ')} e ${n[n.length - 1]} aulas`;
  return `${txt} (${T[ls[0]].s}–${T[ls[ls.length - 1]].e})`;
}

/* Aulas de hoje (cartão da tela inicial) */
function todayClassesHTML() {
  const sc = schedule(), now = new Date(), dow = now.getDay();
  if (!sc.days.includes(dow)) return '';
  const T = slotTimes(sc).slots, nowM = now.getHours() * 60 + now.getMinutes();
  const rows = T.map((t, i) => ({ t, s: subjAt(sc, dow, i) })).filter(x => x.s);
  if (!rows.length) return '';
  let nextMarked = false;
  return `<div class="card blk o4 tclass"><div class="sec-head" style="margin-top:0"><h2>Aulas de hoje</h2><button class="link" data-a="go" data-to="schedule">Horário</button></div>${rows.map(({ t, s }) => {
    const st = nowM >= t.em ? 'past' : nowM >= t.sm ? 'now' : (!nextMarked && (nextMarked = true)) ? 'next' : '';
    return `<div class="trow ${st}" style="--c:${esc(s.color)}"><span class="tn">${t.n}ª</span><span class="tt">${t.s}–${t.e}</span><span class="tm">${esc((s.icon ? s.icon + ' ' : '') + s.name)}</span>${st === 'now' ? '<em>agora</em>' : st === 'next' ? '<em>próxima</em>' : ''}</div>`;
  }).join('')}</div>`;
}

VIEWS.schedule = () => {
  if (!state.subjects.length) return { title: 'Horário de aulas', back: true, html: emptyState('🕖', 'Sem disciplinas ainda', 'Crie suas disciplinas para montar o horário de aulas.', `<button class="btn primary" style="margin-top:12px" data-a="newSubj">Criar disciplina</button>`) };
  const sc = schedule(), { slots, brs } = slotTimes(sc), days = dayOrder(sc.days), today = new Date().getDay();
  const last = slots[slots.length - 1];
  let grid = `<div class="sch-h"></div>${days.map(d => `<div class="sch-h ${d === today ? 'today' : ''}">${DIAS[d]}</div>`).join('')}`;
  slots.forEach((t, i) => {
    grid += `<div class="sch-t"><b>${t.n}ª</b><span>${t.s}</span><span>${t.e}</span></div>` + days.map(d => {
      const s = subjAt(sc, d, i);
      return `<button class="sch-c ${s ? '' : 'empty'} ${d === today ? 'today' : ''}" ${s ? `style="--c:${esc(s.color)}"` : ''} data-a="pickLesson" data-d="${d}" data-i="${i}" aria-label="${DIAS_LONGO[d]}, ${t.n}ª aula${s ? ': ' + esc(s.name) : ': vazia'}">${s ? `<span class="e">${esc(s.icon || '')}</span><span class="n">${esc(s.name)}</span>` : '＋'}</button>`;
    }).join('');
    const b = brs.find(x => x.after === t.n);
    if (b) grid += `<div class="sch-brk">Intervalo · ${b.s}–${b.e}</div>`;
  });
  return {
    title: 'Horário', back: true,
    actions: `<button class="icon-btn" data-a="editSchedule" aria-label="Configurar horários">${ICON.edit}</button>`,
    html: `<div class="card grules"><div class="small">${sc.lessons} aulas de <b>${sc.dur} min</b> · das <b>${slots[0].s}</b> às <b>${last.e}</b>${brs.length ? ' · ' + brs.map(b => `intervalo de ${b.s} às ${b.e}`).join(', ') : ''}</div><button class="link" data-a="editSchedule">Configurar</button></div>
      ${todayClassesHTML().replace('blk o4 tclass', 'tclass')}
      <div class="sched" style="--n:${days.length}">${grid}</div>
      <p class="muted small" style="margin:12px 2px 0">Toque em um quadrado para escolher a disciplina daquela aula. Com o horário montado, o formulário de atividade mostra quando é a próxima aula de cada disciplina.</p>`
  };
};
const WEEKDAY_NAMES = { 1: 'Segunda-feira', 2: 'Terça-feira', 3: 'Quarta-feira', 4: 'Quinta-feira', 5: 'Sexta-feira', 6: 'Sábado', 0: 'Domingo' };
Object.assign(ACT, {
  pickLesson: d => {
    const sc = schedule(), dow = +d.d, i = +d.i, t = slotTimes(sc).slots[i]; if (!t) return;
    const cur = (sc.grid[dow] || [])[i] || null;
    state.form = { type: 'lesson', d: dow, i };
    openSheet(`${sheetHead(`${t.n}ª aula · ${WEEKDAY_NAMES[dow]}`)}<div class="sheet-body"><p class="muted" style="margin-top:0">${t.s}–${t.e}. Qual disciplina é esta aula?</p>
      ${state.subjects.map(s => `<button class="opt ${s.id === cur ? 'sel' : ''}" data-a="setLesson" data-s="${s.id}"><span class="oi" style="background:${esc(s.color)}22;color:${esc(s.color)}">${esc(s.icon || '📘')}</span><span class="grow"><b style="overflow-wrap:anywhere">${esc(s.name)}</b></span>${s.id === cur ? ICON.check : ''}</button>`).join('')}
      <button class="opt" data-a="setLesson" data-s=""><span class="oi">${ICON.x}</span><span class="grow"><b>Deixar vazio (sem aula)</b></span></button>
      <label class="setrow" style="margin-top:10px"><input type="checkbox" id="pl-all"><span>Repetir a ${t.n}ª aula em todos os dias</span></label></div>`);
  },
  setLesson: async d => {
    const f = state.form; if (!f || f.type !== 'lesson') return;
    const sc = schedule(), grid = {}; Object.keys(sc.grid).forEach(k => { grid[k] = [...sc.grid[k]]; });
    const all = $('#pl-all') && $('#pl-all').checked, val = d.s || null;
    for (const dow of (all ? sc.days : [f.d])) { const row = grid[dow] ? [...grid[dow]] : []; while (row.length < sc.lessons) row.push(null); row[f.i] = val; grid[dow] = row; }
    await saveSettings({ schedule: { ...(state.settings.schedule || {}), start: sc.start, dur: sc.dur, lessons: sc.lessons, breaks: sc.breaks, days: sc.days, grid } });
    closeSheet(); render();
  },
  editSchedule: () => {
    const sc = schedule(); state.form = { type: 'schedule' };
    openSheet(`${sheetHead('Configurar horário de aulas')}<div class="sheet-body">
      <div class="grid2"><label class="field"><span>Início das aulas</span><input type="time" id="sc-start" value="${sc.start}"></label><label class="field"><span>Duração de cada aula (min)</span><input type="number" id="sc-dur" min="10" max="240" value="${sc.dur}" inputmode="numeric"></label></div>
      <label class="field"><span>Aulas por dia</span><input type="number" id="sc-n" min="1" max="12" value="${sc.lessons}" inputmode="numeric"></label>
      <div class="field"><span>Dias de aula</span><div class="chips" id="sc-days">${[1, 2, 3, 4, 5, 6, 0].map(d => `<label class="chip ${sc.days.includes(d) ? 'on' : ''}"><input type="checkbox" value="${d}" ${sc.days.includes(d) ? 'checked' : ''} hidden>${DIAS[d]}</label>`).join('')}</div></div>
      <div class="field"><span>Intervalos</span><div id="sc-breaks">${sc.breaks.map(breakRow).join('')}</div><button class="btn sm" data-a="addBreak">＋ Adicionar intervalo</button></div>
      <p class="muted small">Os horários de cada aula são calculados a partir do início, da duração e dos intervalos. O padrão da sua escola: 6 aulas de 50 min a partir das 7:00, com intervalo de 15 min depois da 3ª aula (termina às 12:15).</p>
    </div><div class="sheet-foot"><button class="btn" data-a="resetSchedule">Padrão</button><button class="btn primary" data-a="saveSchedule">Salvar</button></div>`);
  },
  addBreak: () => { const box = $('#sc-breaks'); if (box) box.insertAdjacentHTML('beforeend', breakRow({ after: 1, min: 15 })); },
  rmBreak: d => { const r = d.el ? null : null; },
  saveSchedule: async () => {
    const start = $('#sc-start').value, dur = Number($('#sc-dur').value), n = Number($('#sc-n').value);
    if (toMin(start) == null) return toast('Informe o horário de início das aulas.', { err: true });
    if (!Number.isInteger(dur) || dur < 10 || dur > 240) return toast('A duração da aula deve ficar entre 10 e 240 minutos.', { err: true });
    if (!Number.isInteger(n) || n < 1 || n > 12) return toast('O número de aulas por dia deve ficar entre 1 e 12.', { err: true });
    const days = $$('#sc-days input:checked').map(x => +x.value); if (!days.length) return toast('Marque pelo menos um dia de aula.', { err: true });
    const breaks = []; 
    for (const r of $$('#sc-breaks .brow')) {
      const after = Number(r.querySelector('.br-after').value), min = Number(r.querySelector('.br-min').value);
      if (!Number.isInteger(after) || after < 1 || after >= n) return toast(`O intervalo deve ser depois de uma aula entre 1 e ${n - 1}.`, { err: true });
      if (!Number.isInteger(min) || min < 1 || min > 180) return toast('A duração do intervalo deve ficar entre 1 e 180 minutos.', { err: true });
      if (breaks.some(b => b.after === after)) return toast('Há dois intervalos depois da mesma aula.', { err: true });
      breaks.push({ after, min });
    }
    const old = schedule();
    await saveSettings({ schedule: { start, dur, lessons: n, breaks: breaks.sort((a, b) => a.after - b.after), days, grid: old.grid } });
    closeSheet(); render(); toast('Horário atualizado.');
  },
  resetSchedule: async () => {
    const ok = await confirmDlg('Voltar ao padrão?', 'Início às 7:00, 6 aulas de 50 minutos e intervalo de 15 minutos depois da 3ª aula. As disciplinas que você já colocou nos quadrados são mantidas.', 'Usar padrão');
    if (!ok) return;
    const old = schedule();
    await saveSettings({ schedule: { ...SCHED_DEFAULT, breaks: SCHED_DEFAULT.breaks.map(b => ({ ...b })), days: [...SCHED_DEFAULT.days], grid: old.grid } });
    closeSheet(); render(); toast('Horário padrão aplicado.');
  },
  editGradeRules: () => {
    const R = gradeRules(); state.form = { type: 'gradeRules' };
    openSheet(`${sheetHead('Regras de notas')}<div class="sheet-body">
      <p class="muted" style="margin-top:0">“Média” é a nota para ficar no azul no trimestre. “Máximo” é o valor total do trimestre.</p>
      ${[0, 1, 2].map(i => `<div class="grid2"><label class="field"><span>${ORD[i]} trimestre · máximo</span><input id="gr-max${i}" inputmode="decimal" value="${fmtNum(R.max[i])}"></label><label class="field"><span>${ORD[i]} trimestre · média</span><input id="gr-pass${i}" inputmode="decimal" value="${fmtNum(R.pass[i])}"></label></div>`).join('')}
      <label class="field"><span>Pontos no total para passar de ano</span><input id="gr-total" inputmode="decimal" value="${fmtNum(R.total)}"></label>
    </div><div class="sheet-foot"><button class="btn" data-a="resetGradeRules">Padrão</button><button class="btn primary" data-a="saveGradeRules">Salvar</button></div>`);
  },
  saveGradeRules: async () => {
    const max = [0, 1, 2].map(i => parseGrade($(`#gr-max${i}`).value)), pass = [0, 1, 2].map(i => parseGrade($(`#gr-pass${i}`).value)), total = parseGrade($('#gr-total').value);
    if ([...max, ...pass, total].some(x => x == null || Number.isNaN(x) || x <= 0 || x > 1000)) return toast('Preencha todos os campos com números maiores que zero.', { err: true });
    if (pass.some((p, i) => p > max[i])) return toast('A média de um trimestre não pode passar do máximo dele.', { err: true });
    if (total > max[0] + max[1] + max[2]) return toast('O total para passar de ano não pode ser maior que a soma dos máximos.', { err: true });
    await saveSettings({ gradeRules: { max, pass, total } });
    closeSheet(); render(); toast('Regras atualizadas.');
  },
  resetGradeRules: async () => {
    await saveSettings({ gradeRules: { max: [...GRADE_DEFAULTS.max], pass: [...GRADE_DEFAULTS.pass], total: GRADE_DEFAULTS.total } });
    closeSheet(); render(); toast('Regras padrão aplicadas.');
  },
  pickClassDate: d => {
    const el = $('#' + d.for); if (!el) return;
    el.value = d.date; updateNextClass();
  }
});
const breakRow = b => `<div class="row brow" style="margin-bottom:8px;gap:8px;flex-wrap:wrap"><span class="small">Depois da aula</span><input type="number" class="br-after" min="1" max="11" value="${b.after}" style="width:72px" inputmode="numeric"><span class="small">duração (min)</span><input type="number" class="br-min" min="1" max="180" value="${b.min}" style="width:80px" inputmode="numeric"><button type="button" class="icon-btn" data-a="rmBreak" aria-label="Remover intervalo">${ICON.trash}</button></div>`;
ACT.rmBreak = (d, e) => { const r = e && e.target.closest('.brow'); if (r) r.remove(); };

/* ---------- Próxima aula da disciplina (formulário de atividade e adicionar rápido) ---------- */
function classDates(sid, count = 3, span = 28) {
  const sc = schedule(), out = [], t0 = sod(new Date());
  for (let k = 0; k < span && out.length < count; k++) {
    const d = addDays(t0, k), ls = lessonsOn(sc, sid, d.getDay());
    if (ls.length) out.push({ d, ls });
  }
  return out;
}
function nextClassHTML(sid, dateStr, forId) {
  const s = state.subjects.find(x => x.id === sid); if (!s) return '';
  const sc = schedule(), tot = Object.values(sc.grid).flat().filter(x => x === sid).length;
  if (!tot) return `<div class="nc muted small">${esc(s.name)} ainda não está no seu horário de aulas. Monte o horário (menu Horário de aulas) para ver aqui a próxima aula.</div>`;
  const list = classDates(sid), today = sod(new Date());
  const chips = list.map(({ d, ls }) => {
    const diff = Math.round((d - today) / DAY), rel = diff === 0 ? 'hoje' : diff === 1 ? 'amanhã' : `${DIAS[d.getDay()]}, ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
    return `<button type="button" class="chip ${ymd(d) === dateStr ? 'on' : ''}" data-a="pickClassDate" data-for="${forId}" data-date="${ymd(d)}">${rel} · ${ls.map(i => i + 1 + 'ª').join(' e ')} aula${ls.length > 1 ? 's' : ''}</button>`;
  }).join('');
  let info = '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3]), ls = lessonsOn(sc, sid, d.getDay());
    info = ls.length ? `<div class="nc-i ok">✓ Neste dia tem aula de ${esc(s.name)}: ${lessonLabel(sc, ls)}.</div>` : `<div class="nc-i no">${sc.days.includes(d.getDay()) ? `Neste dia não tem aula de ${esc(s.name)}.` : 'Neste dia não há aula.'}</div>`;
  }
  return `<div class="nc"><div class="small muted">Próximas aulas de <b>${esc(s.name)}</b> (toque para usar a data):</div><div class="chips nc-chips">${chips || '<span class="small muted">Nenhuma nas próximas 4 semanas.</span>'}</div>${info}</div>`;
}
function updateNextClass() {
  [['f-nextclass', 'f-subj', 'f-date'], ['qa-next', 'qa-subj', 'qa-date']].forEach(([box, sel, dt]) => {
    const b = $('#' + box), s = $('#' + sel), d = $('#' + dt); if (!b || !s || !d) return;
    b.innerHTML = nextClassHTML(s.value, d.value, dt);
  });
}
document.addEventListener('change', e => {
  const t = e.target;
  if (t.classList && t.classList.contains('gin')) return gradeChanged(t);
  if (['f-subj', 'f-date', 'qa-subj', 'qa-date'].includes(t.id)) updateNextClass();
  if (t.closest && t.closest('#sc-days')) { const lab = t.closest('label'); if (lab) lab.classList.toggle('on', t.checked); }
});
document.addEventListener('input', e => { if (e.target.id === 'f-date' || e.target.id === 'qa-date') updateNextClass(); });
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('gin')) e.target.blur(); });
