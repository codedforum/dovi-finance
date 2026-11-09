import { api } from './api.js?v=dev';
import { esc } from './format.js?v=dev';
import { renderItem } from './notify.js?v=dev';
import { toast, errorText, $, $$ } from './ui.js?v=dev';

let group = ''; let before = null; let loading = false;
const nl = $('#nl'); const moreBtn = $('#more');

function skeleton() { nl.innerHTML = '<div class="skeleton" style="height:70px"></div><div class="skeleton" style="height:70px"></div><div class="skeleton" style="height:70px"></div>'; }
function empty() { nl.innerHTML = '<div class="empty"><div class="big" aria-hidden="true">🔔</div><h3>You are all caught up</h3><p>New payments, claims and security updates show up here.</p></div>'; }

async function load(reset) {
  if (loading) return; loading = true;
  if (reset) { before = null; skeleton(); }
  try {
    const q = new URLSearchParams({ limit: '20' }); if (group) q.set('group', group); if (before) q.set('before', before);
    const r = await api('/api/notifications?' + q.toString());
    if (reset) nl.innerHTML = '';
    if (!r.notifications.length && reset) empty();
    nl.insertAdjacentHTML('beforeend', r.notifications.map(renderItem).join(''));
    before = r.notifications.length ? r.notifications[r.notifications.length - 1].id : before;
    moreBtn.hidden = r.notifications.length < 20;
  } catch (e) {
    if (e.status === 401) { nl.innerHTML = '<div class="empty"><h3>Sign in to see notifications</h3><a class="btn mint" href="/app">Open DOVI</a></div>'; moreBtn.hidden = true; }
    else nl.innerHTML = '<p class="err">' + esc(errorText(e)) + '</p><button class="btn ghost" id="rt" type="button">Try again</button>';
    const rt = $('#rt'); if (rt) rt.addEventListener('click', () => load(true));
  } finally { loading = false; }
}

$$('.seg button').forEach((b) => b.addEventListener('click', () => { $$('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); group = b.dataset.g; load(true); }));
moreBtn.addEventListener('click', () => load(false));
$('#mr').addEventListener('click', async () => { try { await api('/api/notifications/read', { method: 'POST', body: { ids: 'all' } }); $$('.item.unread').forEach((x) => x.classList.remove('unread')); toast({ title: 'All marked as read', ms: 2000 }); } catch (e) { toast({ title: 'Could not mark as read', body: errorText(e), tone: 'bad', icon: '!' }); } });
load(true);
if (typeof EventSource !== 'undefined') { const es = new EventSource('/api/notifications/stream'); es.addEventListener('notification', () => load(true)); }
