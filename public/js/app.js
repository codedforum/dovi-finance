import { api } from './api.js?v=dev';
import * as wallet from './wallet.js?v=dev';
import { signInSheet } from './signin.js?v=dev';
import { renderHome } from './home.js?v=dev';
import { openTokenClaim } from './tokens.js?v=dev';
import { cancelFromLink } from './recovery.js?v=dev';
import { renderSend } from './send.js?v=dev';
import { renderActivity, openDetail } from './activity.js?v=dev';
import { renderAgent } from './agent.js?v=dev';
import { renderLinks } from './links.js?v=dev';
import { renderInvite } from './invite.js?v=dev';
import { renderGiveaways } from './giveaways.js?v=dev';
import { renderStatements } from './statements.js?v=dev';
import { renderBatch } from './batch.js?v=dev';
import { renderWithdraw } from './withdraw.js?v=dev';
import { renderAutopay } from './autopay.js?v=dev';
import { renderAgentKeys } from './agentkeys.js?v=dev';
import { renderAccount, openAccountSheet, loadAccount, setTopAvatar } from './account.js?v=dev';
import { startNotifications, openPanel } from './notify.js?v=dev';
import { $, $$, toast, errorText } from './ui.js?v=dev';

const SCREENS = { home: renderHome, send: renderSend, activity: renderActivity, agent: renderAgent, account: renderAccount, batch: renderBatch, withdraw: renderWithdraw, autopay: renderAutopay, keys: renderAgentKeys, links: renderLinks, invite: renderInvite, giveaways: renderGiveaways, statements: renderStatements };
const session = { address: null, user: null };

const TITLES = { home: 'Home', send: 'Send dollars', activity: 'Activity', agent: 'Ask DOVI', account: 'Account', batch: 'Pay many people', withdraw: 'Withdraw', autopay: 'Pay from X', links: 'Payment links', invite: 'Invite friends', giveaways: 'Giveaways', statements: 'Statements', keys: 'Agent keys' };
const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function current() { const h = (location.hash || '#home').slice(1); return SCREENS[h] ? h : 'home'; }

function go(name) { if (location.hash !== '#' + name) location.hash = name; else show(); }

function show() {
  try { if (sessionStorage.getItem('dovi.pay') && current() !== 'send') { location.hash = 'send'; return; } } catch { /* storage blocked */ }
  const name = current();
  $$('.tab').forEach((t) => (t.dataset.t === name ? t.setAttribute('aria-current', 'page') : t.removeAttribute('aria-current')));
  const view = $('#view'); view.innerHTML = ''; view.dataset.screen = name;
  const root = document.createElement('div'); root.className = 'screen'; view.appendChild(root);
  const title = TITLES[name] || 'DOVI';
  try { document.title = title + '. DOVI'; } catch { /* title is cosmetic */ }
  Promise.resolve().then(() => SCREENS[name](root, session, { go })).catch((e) => { root.innerHTML = '<p class="err">' + escHtml(errorText(e)) + '</p>'; }).then(() => { if (root.isConnected && !root.querySelector('h1')) root.insertAdjacentHTML('afterbegin', '<h1 class="sr-only">' + title + '</h1>'); });
  window.scrollTo(0, 0);
  view.focus({ preventScroll: true });
}

let pendingClaim = null;
let pendingTokenClaim = null;
document.addEventListener('dovi:open-claim', (ev) => { openDetail(String(ev.detail)); });

async function gate() {
  const params = new URLSearchParams(location.search);
  const pp = params.get('pay');
  if (pp) {
    try {
      const j = JSON.parse(decodeURIComponent(escape(atob(pp.replace(/-/g, '+').replace(/_/g, '/')))));
      if (j && typeof j.to === 'string' && /^@?[A-Za-z0-9_]{1,15}$/.test(j.to) && /^\d{1,9}(\.\d{1,6})?$/.test(String(j.amount))) sessionStorage.setItem('dovi.pay', JSON.stringify({ to: j.to, amount: String(j.amount), note: String(j.note || '').slice(0, 140), paylink: /^[2-9a-hj-km-np-zA-HJ-NP-Z]{8}$/.test(String(j.paylink || '')) ? j.paylink : null }));
    } catch { /* ignore a bad link */ }
    history.replaceState(null, '', location.pathname + location.hash);
  }
  const cl = params.get('claim');
  if (cl && /^0x[0-9a-f]{64}$/i.test(cl)) { pendingClaim = cl; params.delete('claim'); history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params.toString() : '') + location.hash); }
  const rcancel = params.get('rcancel');
  if (rcancel && /^[A-Za-z0-9_-]{20,60}$/.test(rcancel)) { params.delete('rcancel'); history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params.toString() : '') + location.hash); setTimeout(() => cancelFromLink(rcancel), 300); }
  const tcl = params.get('tclaim');
  if (tcl && /^0x[0-9a-f]{64}$/i.test(tcl)) { pendingTokenClaim = tcl; params.delete('tclaim'); history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params.toString() : '') + location.hash); }
  const le = params.get('login_error');
  if (le) { toast({ title: 'Sign in did not finish', body: le === 'identity_taken' ? 'That X account is already linked to another DOVI account.' : le === 'x_not_configured' ? 'Sign in with X is not switched on yet.' : le === 'invite_required' ? 'DOVI is invite only right now. Enter an invite code and try again.' : 'Please try again.', tone: 'bad', icon: '!' }); history.replaceState(null, '', location.pathname + location.hash); }
  if (params.get('linked') === 'x') { toast({ title: 'X linked', body: 'People can now pay your @handle.', ms: 4000 }); history.replaceState(null, '', location.pathname + location.hash); }
  let me = null;
  const who = await api('/api/auth/me');
  if (who.identity) me = await api('/api/me');
  if (!me) {
    $('#view').dataset.screen = 'welcome';
    $('#view').innerHTML = '<div class="welcome"><div class="w-art"><img src="/brand/dovi-person-20261025-720.webp" srcset="/brand/dovi-person-20261025-480.webp 480w, /brand/dovi-person-20261025-720.webp 720w, /brand/dovi-person-20261025-1024.webp 1024w" sizes="(max-width:860px) 92vw, 420px" alt="" width="1024" height="1536" decoding="async" fetchpriority="high"><span class="orb o1"></span><span class="orb o2"></span><span class="orb o3"></span></div><div class="w-copy"><span class="kick">DOVI</span><h1>Your handle is your <em>payment address.</em></h1><p>Send dollars to anyone on X or email. They claim with one login. No seed phrase, and every send shows a preview first.</p><button class="btn mint lg" id="si" type="button">Sign in</button><p class="hint">Beta on the Base test network. Balances are not insured deposits.</p></div></div>';
    $('#si').addEventListener('click', async () => { if (await signInSheet({ next: '/app' })) boot(); });
    if (params.get('autosignin')) $('#si').click();
    (window.requestIdleCallback || ((f) => setTimeout(f, 1500)))(() => api('/api/public/cdp-config').then((c) => { if (c && c.sdkUrl) { const l = document.createElement('link'); l.rel = 'modulepreload'; l.href = c.sdkUrl; document.head.appendChild(l); } }).catch(() => {}));
    return false;
  }
  return me;
}

async function boot() {
  const me = await gate();
  if (!me) return;
  try {
    await wallet.start();
    session.address = await wallet.address();
    session.user = me.user;
    if (me.user.address !== session.address) await api('/api/me/address', { method: 'POST', body: { address: session.address } });
  } catch (e) { $('#view').innerHTML = '<div class="empty"><div class="big" aria-hidden="true">!</div><h3>Your wallet is not ready</h3><p>' + escHtml(errorText(e)) + '</p><button class="btn" id="rt" type="button">Try again</button></div>'; $('#rt').addEventListener('click', boot); return; }
  startNotifications($('#bell'));
  const frozenBanner = (on) => {
    let el = document.getElementById('fzb');
    if (!on) { if (el) el.remove(); return; }
    if (el) return;
    el = document.createElement('div'); el.id = 'fzb'; el.className = 'freezebar'; el.setAttribute('role', 'status');
    el.innerHTML = '<span>Your account is frozen. Sending is paused.</span><button class="btn sm" id="fzu" type="button">Unfreeze</button>';
    const tb = document.querySelector('.topbar'); if (tb) tb.insertAdjacentElement('afterend', el);
    el.querySelector('#fzu').addEventListener('click', async () => { try { await api('/api/account/unfreeze', { method: 'POST', body: {} }); frozenBanner(false); document.dispatchEvent(new CustomEvent('dovi:freeze', { detail: false })); toast({ title: 'Account unfrozen', ms: 3000 }); } catch (e) { toast({ title: 'Could not unfreeze', body: errorText(e), tone: 'bad', icon: '!' }); } });
  };
  frozenBanner(!!me.user.frozen);
  api('/api/recovery/mine').then((r) => { if (r && r.incoming && r.incoming.length) { const rb = document.createElement('div'); rb.className = 'freezebar'; rb.setAttribute('role', 'alert'); rb.innerHTML = '<span>Someone asked to move your account to a new login. If this was not you, cancel it in Account.</span><a class="btn sm" href="#account">Open</a>'; const tb1 = document.querySelector('.topbar'); if (tb1) tb1.insertAdjacentElement('afterend', rb); } }).catch(() => {});
  if (me.user.held) { const hb = document.createElement('div'); hb.className = 'freezebar'; hb.setAttribute('role', 'status'); hb.innerHTML = '<span>Your account is on hold, so sending is paused. Contact support from the Help page.</span>'; const tb0 = document.querySelector('.topbar'); if (tb0) tb0.insertAdjacentElement('afterend', hb); }
  document.addEventListener('dovi:freeze', (ev) => frozenBanner(!!ev.detail));
  const meBtn = $('#me'); meBtn.hidden = false; meBtn.addEventListener('click', () => openAccountSheet(session, { go }));
  loadAccount().then(setTopAvatar).catch(() => { meBtn.textContent = '•'; });
  api('/api/public/cdp-config').then((c) => { const n = $('#net'); if (c && c.testnet && n) { n.lastChild.textContent = 'Test network'; n.title = 'Test network, no real money'; n.setAttribute('aria-label', 'Test network, no real money'); n.classList.add('test'); } }).catch(() => {});
  show();
  if (pendingTokenClaim) { const tc = pendingTokenClaim; pendingTokenClaim = null; setTimeout(() => openTokenClaim(tc, session), 500); }
  if (pendingClaim) { const pc = pendingClaim; pendingClaim = null; setTimeout(() => openDetail(pc), 400); }
}

$('#bell').addEventListener('click', openPanel);
$$('.tab').forEach((t) => t.addEventListener('click', () => go(t.dataset.t)));
window.addEventListener('hashchange', () => { if (session.address) show(); });
boot().catch((e) => { $('#view').innerHTML = '<p class="err">' + escHtml(errorText(e)) + '</p>'; });

async function showNotice() {
  try {
    const r = await api('/api/banner');
    const old = document.getElementById('notice'); if (old) old.remove();
    if (!r || !r.banner) return;
    const d = document.createElement('div');
    d.id = 'notice'; d.className = 'notice ' + (r.banner.tone === 'warn' ? 'warn' : 'info'); d.setAttribute('role', 'status');
    d.textContent = r.banner.text;
    const main = document.getElementById('view'); main.parentNode.insertBefore(d, main);
  } catch { /* the notice is optional */ }
}
showNotice();
setInterval(showNotice, 300000);
