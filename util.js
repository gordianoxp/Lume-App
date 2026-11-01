'use strict';
/* Estado global, constantes e funções utilitárias. */
const state = {
  subjects: [], activities: [], files: [], settings: {}, fired: [],
  user: null, classes: [], members: [], profiles: [], posts: [], postfiles: [], syncedOnce: false, hasServerSettings: false, dirty: false,
  notif: 'default', route: null, routeChanged: false,
  cal: { mode: 'month', date: new Date(), sel: new Date() },
  timer: null, sheetOpen: false, sheetPushed: false, form: null, pendingUpload: null
};

const DEFAULT_SETTINGS = {
  theme: 'auto', soonDays: 3, defaultSort: 'due',
  defaultReminders: ['d1'], customTypes: [], notifBannerDismissed: false
};

const DAY = 86400000;
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const DIAS_LONGO = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const PRIORITIES = { low: 'Baixa', mid: 'Média', high: 'Alta' };
const STATUS = { pending: 'Pendente', doing: 'Em andamento', done: 'Concluída' };
const DEFAULT_TYPES = ['Atividade', 'Trabalho escrito', 'Apresentação', 'Pesquisa', 'Prova / Avaliação', 'Leitura', 'Trabalho em grupo'];
const COLORS = ['#4f46e5', '#0ea5e9', '#14b8a6', '#22c55e', '#eab308', '#f97316', '#ef4444', '#ec4899', '#a855f7', '#64748b'];
const EMOJIS = ['', '📘', '📗', '📙', '📕', '🧮', '🔬', '🧪', '🌍', '📜', '🎨', '🎵', '💻', '⚽', '🗣️', '🧠', '✏️', '📐'];
const REM_OPTIONS = [
  ['d1', '1 dia antes'], ['h3', '3 horas antes'], ['h1', '1 hora antes'],
  ['sameday', 'No dia da entrega (8h)'], ['due', 'No horário da entrega']
];

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/* sempre um UUID v4 válido (o banco exige esse formato) */
const uid = () => {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const sod = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

function parseLocal(s) {
  if (!s) return null;
  const [d, t = '00:00'] = s.split('T');
  const [y, m, da] = d.split('-').map(Number);
  const [hh, mm] = t.split(':').map(Number);
  const r = new Date(y, m - 1, da, hh || 0, mm || 0);
  return isNaN(r) ? null : r;
}
const fmtDate = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
const fmtHM = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtDT = d => `${fmtDate(d)} às ${fmtHM(d)}`;
function fmtRel(d) {
  const diff = Math.round((sod(d) - sod(new Date())) / DAY);
  const hm = fmtHM(d);
  if (diff === 0) return `Hoje, ${hm}`;
  if (diff === 1) return `Amanhã, ${hm}`;
  if (diff === -1) return `Ontem, ${hm}`;
  if (diff > 1 && diff < 7) return `${DIAS[d.getDay()]}, ${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${hm}`;
  return `${fmtDate(d)} ${hm}`;
}
function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1).replace('.', ',') + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1).replace('.', ',') + ' MB';
  return (b / 1073741824).toFixed(2).replace('.', ',') + ' GB';
}
const extOf = n => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toUpperCase().slice(0, 5) : 'ARQ'; };
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

/* ---- Consultas sobre os dados ---- */
const subj = id => state.subjects.find(s => s.id === id);
const isPending = a => a.status !== 'done';
const dueOf = a => parseLocal(a.due);
const isOverdue = a => isPending(a) && dueOf(a) < new Date();
const isToday = a => isPending(a) && !isOverdue(a) && ymd(dueOf(a)) === ymd(new Date());
const isSoon = a => {
  if (!isPending(a) || isOverdue(a) || isToday(a)) return false;
  const diff = Math.round((sod(dueOf(a)) - sod(new Date())) / DAY);
  return diff >= 1 && diff <= (state.settings.soonDays || 3);
};
const filesOf = actId => state.files.filter(f => f.activityId === actId);
const colorOf = a => (subj(a.subjectId) || {}).color || '#64748b';
const prioW = { high: 0, mid: 1, low: 2 };

function sortActs(list, key) {
  const c = [...list];
  const byDue = (a, b) => dueOf(a) - dueOf(b);
  if (key === 'priority') c.sort((a, b) => prioW[a.priority] - prioW[b.priority] || byDue(a, b));
  else if (key === 'subject') c.sort((a, b) => ((subj(a.subjectId) || {}).name || '').localeCompare((subj(b.subjectId) || {}).name || '', 'pt-BR') || byDue(a, b));
  else if (key === 'created') c.sort((a, b) => b.createdAt - a.createdAt);
  else c.sort(byDue);
  return c;
}

/* ---- Ícones (SVG de traço) ---- */
const ic = (p, s = 22) => `<svg class="ic" viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICON = {
  home: ic('<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>'),
  calendar: ic('<rect x="3" y="4" width="18" height="17" rx="3"/><path d="M8 2v4M16 2v4M3 10h18"/>'),
  plus: ic('<path d="M12 5v14M5 12h14"/>', 26),
  folder: ic('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  user: ic('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>'),
  search: ic('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>'),
  check: ic('<path d="M5 12l5 5 9-10"/>', 18),
  back: ic('<path d="M15 5l-7 7 7 7"/>'),
  trash: ic('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>', 18),
  edit: ic('<path d="M4 20h4L19 9l-4-4L4 16z"/>', 18),
  copy: ic('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>', 18),
  clip: ic('<path d="M20 11l-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L14 7"/>', 16),
  x: ic('<path d="M6 6l12 12M18 6L6 18"/>', 20),
  download: ic('<path d="M12 4v12M7 11l5 5 5-5M5 20h14"/>', 18),
  share: ic('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 10.6l6.8-4.2M8.6 13.4l6.8 4.2"/>', 18),
  open: ic('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>', 18),
  swap: ic('<path d="M4 8h14l-3-3M20 16H6l3 3"/>', 18),
  play: ic('<path d="M7 4l13 8-13 8z"/>', 20),
  pause: ic('<path d="M8 5v14M16 5v14"/>', 20),
  chart: ic('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>', 20),
  history: ic('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>', 20),
  clock: ic('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 20),
  list: ic('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>', 20),
  bell: ic('<path d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7M10 20a2 2 0 0 0 4 0"/>', 20),
  focus: ic('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>', 20),
  users: ic('<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.5 3-6 7-6s7 2.5 7 6M16 4.5a3.5 3.5 0 0 1 0 7M18 14.3c2.3.7 4 2.6 4 5.7"/>'),
  cloud: ic('<path d="M7 18a4.5 4.5 0 0 1-.5-9A6 6 0 0 1 18 8.5 4.8 4.8 0 0 1 17.5 18z"/>', 16)
};
