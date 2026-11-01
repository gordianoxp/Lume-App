'use strict';
/* Lembretes. No APK (Capacitor) usa notificações locais agendadas pelo sistema.
   No navegador/PWA usa a Notification API enquanto o app está ativo. */
const Native = !!(window.Capacitor && typeof Capacitor.isNativePlatform === 'function' && Capacitor.isNativePlatform());
const LN = () => window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.LocalNotifications;

function reminderTimes(a) {
  if (!a.rem || !a.rem.on || a.status === 'done') return [];
  const due = parseLocal(a.due);
  if (!due) return [];
  const out = [];
  for (const k of a.rem.keys || []) {
    if (k === 'd1') out.push(new Date(due.getTime() - DAY));
    else if (k === 'h3') out.push(new Date(due.getTime() - 3 * 3600e3));
    else if (k === 'h1') out.push(new Date(due.getTime() - 3600e3));
    else if (k === 'sameday') { const x = sod(due); x.setHours(8, 0, 0, 0); out.push(x); }
    else if (k === 'due') out.push(due);
  }
  for (const c of a.rem.custom || []) { const d = parseLocal(c); if (d) out.push(d); }
  return out;
}

function reminderBody(a) {
  const s = subj(a.subjectId);
  return `${s ? s.name : 'Atividade'} • entrega ${fmtDT(parseLocal(a.due))}`;
}

async function notifStatus() {
  if (Native) {
    try { const r = await LN().checkPermissions(); return r.display === 'granted' ? 'granted' : (r.display === 'denied' ? 'denied' : 'default'); }
    catch (e) { return 'unsupported'; }
  }
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

async function notifRequest() {
  try {
    if (Native) { const r = await LN().requestPermissions(); return r.display === 'granted' ? 'granted' : 'denied'; }
    if (!('Notification' in window)) return 'unsupported';
    return await Notification.requestPermission();
  } catch (e) { return 'denied'; }
}

async function showNotif(title, body, tag) {
  if (state.notif === 'granted') {
    try {
      const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
      if (reg) { await reg.showNotification(title, { body, tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url: './' } }); return; }
      new Notification(title, { body, tag });
      return;
    } catch (e) { /* cai para o aviso dentro do app */ }
  }
  toast(`🔔 ${title} — ${body}`, { long: true });
}

/* Navegador: dispara lembretes cuja hora já chegou (janela de 36 h) e que ainda não foram avisados. */
async function reminderTick() {
  if (Native) return;
  const now = Date.now();
  const fired = new Set(state.fired);
  let changed = false;
  for (const a of state.activities) {
    for (const t of reminderTimes(a)) {
      const ms = t.getTime();
      const key = a.id + '|' + ms;
      if (ms <= now && ms > now - 36 * 3600e3 && !fired.has(key)) {
        fired.add(key); changed = true;
        await showNotif(a.title, reminderBody(a), key);
      }
    }
  }
  if (changed) {
    state.fired = [...fired].slice(-500);
    try { await DB.put('meta', { key: 'fired', value: state.fired }); } catch (e) { /* sem impacto no uso */ }
  }
}

async function nativeReschedule() {
  const ln = LN();
  if (!ln) return;
  const pend = await ln.getPending();
  if (pend.notifications && pend.notifications.length) await ln.cancel({ notifications: pend.notifications });
  const now = Date.now();
  const items = [];
  for (const a of state.activities) for (const t of reminderTimes(a)) if (t.getTime() > now) items.push({ a, t });
  items.sort((x, y) => x.t - y.t);
  const notifications = items.slice(0, 200).map((it, i) => ({
    id: i + 1, title: it.a.title, body: reminderBody(it.a),
    schedule: { at: it.t, allowWhileIdle: true }
  }));
  if (notifications.length) await ln.schedule({ notifications });
}

async function rescheduleReminders() {
  try { if (Native) await nativeReschedule(); else await reminderTick(); }
  catch (e) { console.warn('Falha ao reagendar lembretes', e); }
}
