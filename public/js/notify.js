import { api } from './api.js?v=dev';
import { esc, safeHref, timeAgo } from './format.js?v=dev';
import { toast, sheet } from './ui.js?v=dev';

const ICON = { payment_received: '↙', claim_created: '✉', claim_opened: '👀', claim_completed: '✓', claim_expiring: '⏳', claim_returned: '↩', request_received: '✋', send_confirmed: '✓', send_failed: '!', swap_completed: '⇄', cap_reached: '!', security_login: '🔒', system: 'i' };
const TONE = { send_failed: 'bad', cap_reached: 'warn-t', claim_expiring: 'warn-t', security_login: 'warn-t' };

let unread = 0; let es = null; let poll = null; let bellEl = null;

export function iconFor(type) { return ICON[type] || 'i'; }

function paintBadge() {
  if (!bellEl) return;
  let b = bellEl.querySelector('.badge');
  if (unread > 0) {
    if (!b) { b = document.createElement('span'); b.className = 'badge'; bellEl.appendChild(b); }
    b.textContent = unread > 9 ? '9+' : String(unread);
    bellEl.setAttribute('aria-label', 'Notifications, ' + unread + ' unread');
  } else { if (b) b.remove(); bellEl.setAttribute('aria-label', 'Notifications'); }
}

function onNotification(n) {
  unread++;
  paintBadge();
  toast({ title: n.title, body: n.body, icon: iconFor(n.type), tone: TONE[n.type] || '', action: n.action ? { label: n.action.label, href: safeHref(n.action.href), claim: /^0x[0-9a-f]{64}$/i.test(n.ref || '') ? n.ref : null } : null });
  document.dispatchEvent(new CustomEvent('dovi:notification', { detail: n }));
}

export function startNotifications(bell) {
  bellEl = bell;
  api('/api/notifications?limit=1').then((r) => { unread = r.unread; paintBadge(); }).catch(() => {});
  if (typeof EventSource === 'undefined') { poll = setInterval(pollOnce, 20000); return; }
  es = new EventSource('/api/notifications/stream');
  es.addEventListener('notification', (e) => { try { onNotification(JSON.parse(e.data)); } catch { /* ignore bad frame */ } });
  es.onerror = () => { /* the browser reconnects and sends Last-Event-ID, missed items replay */ };
}

let lastSeen = 0;
async function pollOnce() {
  try {
    const r = await api('/api/notifications?limit=5');
    for (const n of r.notifications.slice().reverse()) if (n.id > lastSeen && lastSeen !== 0) onNotification(n);
    if (r.notifications[0]) lastSeen = Math.max(lastSeen, r.notifications[0].id);
    unread = r.unread; paintBadge();
  } catch { /* offline */ }
}

export function stopNotifications() { if (es) es.close(); if (poll) clearInterval(poll); es = null; poll = null; }

export function renderItem(n) {
  const href = n.action ? safeHref(n.action.href) : null;
  return '<div class="item' + (n.read ? '' : ' unread') + '" data-id="' + n.id + '"><div class="ico' + (['payment_received', 'claim_completed', 'send_confirmed', 'claim_returned'].includes(n.type) ? ' in' : '') + '" aria-hidden="true">' + esc(iconFor(n.type)) + '</div><div class="mid"><div class="t">' + esc(n.title) + '</div><div class="d">' + esc(n.body) + '</div><div class="d">' + esc(timeAgo(n.createdAt)) + '</div>' + (href ? '<div class="row-acts"><a class="btn sm mint"' + (/^0x[0-9a-f]{64}$/i.test(n.ref || '') ? ' data-claim="' + esc(n.ref) + '"' : '') + ' href="' + esc(href) + '">' + esc(n.action.label) + '</a></div>' : '') + '</div></div>';
}

export async function openPanel() {
  const s = sheet('<h2>Notifications</h2><p class="hint">Your latest updates.</p><div class="list" id="np"><div class="skeleton" style="height:64px"></div><div class="skeleton" style="height:64px"></div></div><p style="margin-top:16px"><a class="btn ghost block" href="/notifications">See all notifications</a></p>', { label: 'Notifications' });
  try {
    const r = await api('/api/notifications?limit=8');
    const box = s.el.querySelector('#np');
    box.innerHTML = r.notifications.length ? r.notifications.map(renderItem).join('') : '<div class="empty"><div class="big" aria-hidden="true">🔔</div><h3>You are all caught up</h3><p>New payments and updates show up here.</p></div>';
    if (r.unread) { const m = await api('/api/notifications/read', { method: 'POST', body: { ids: 'all' } }); unread = m.unread; paintBadge(); }
  } catch (e) { s.el.querySelector('#np').innerHTML = '<p class="err">' + esc(e.message) + '</p>'; }
}
