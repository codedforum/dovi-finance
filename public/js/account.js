import { mountRecovery } from './recovery.js?v=dev';
import { api } from './api.js?v=dev';
import * as wallet from './wallet.js?v=dev';
import { esc, usd, fmtDateTime, timeAgo } from './format.js?v=dev';
import { sheet, copy, toast, errorText, logo, busy } from './ui.js?v=dev';
import { avatarHtml, wireAvatars, fmtCount } from './people.js?v=dev';
import { reportSheet } from './more.js?v=dev';
import { mountMyData } from './mydata.js?v=dev';

const NAMES = { x: 'X', email: 'Email', google: 'Google', telegram: 'Telegram' };
const KL = { topup: 'Added via', claim_funded: 'Sent to', claim_sent: 'Claimed by', claim_returned: 'Taken back from', claim_expired: 'Expired, sent to', claim_received: 'Received', send: 'Sent to', receive: 'Received', withdraw: 'Withdrew to' };
const ICON = { x: 'x', email: 'mail', google: 'google', telegram: 'telegram' };

export async function loadAccount() {
  const [me, sm, cfg, ch] = await Promise.all([api('/api/me'), api('/api/me/summary').catch(() => null), api('/api/public/cdp-config').catch(() => ({})), api('/api/chains').catch(() => ({ chains: [] }))]);
  const base = (ch.chains || []).find((x) => x.id === 'base') || {};
  const ids = me.user.identities || [];
  const x = ids.find((i) => i.kind === 'x');
  const email = ids.find((i) => i.kind === 'email' || i.kind === 'google');
  const display = (sm && sm.profile && sm.profile.name) || me.user.name || (email && email.label) || (x && x.label) || 'Your account';
  const handle = x ? x.label : '';
  return { me, sm, cfg, ids, x, email, display, handle, address: me.user.address, explorer: (base.explorerTx || '').replace('/tx/', '/address/'), net: cfg.testnet ? 'Base Sepolia' : 'Base', testnet: !!cfg.testnet, xReady: !!cfg.xAuth };
}

export function setTopAvatar(a) {
  const b = document.getElementById('me'); if (!b) return;
  b.innerHTML = avatarHtml(a.sm && a.sm.profile, a.display, 'sm'); wireAvatars(b);
}

function meter(label, used, cap) {
  const u = Number(used); const c = Number(cap) || 1; const pct = Math.min(100, Math.round((u / c) * 100));
  return '<div class="meter"><div class="mh"><span>' + esc(label) + '</span><b>' + esc(usd(used)) + ' of ' + esc(usd(cap)) + '</b></div><div class="bar" role="progressbar" aria-label="' + esc(label) + '" aria-valuenow="' + pct + '" aria-valuemin="0" aria-valuemax="100"><i style="width:' + pct + '%"></i></div></div>';
}

function identityRows(a) {
  const have = new Set(a.ids.map((i) => i.kind));
  const rows = a.ids.map((i) => '<div class="lrow"><span class="lic">' + logo(ICON[i.kind] || 'mail', 'lg') + '</span><div class="lb"><b>' + esc(NAMES[i.kind] || i.kind) + '</b><small>' + esc(i.label) + '</small></div><span class="status done">Linked</span></div>');
  if (!have.has('x')) rows.push('<div class="lrow"><span class="lic">' + logo('x', 'lg') + '</span><div class="lb"><b>X</b><small>Link it so people can pay your @handle</small></div>' + (a.xReady ? '<a class="btn sm mint" id="lx" href="/api/auth/x/start?return=%2Fapp%23account">Link X</a>' : '<span class="status draft">Coming soon</span>') + '</div>');
  if (!a.ids.some((i) => i.kind === 'email' || i.kind === 'google')) rows.push('<div class="lrow"><span class="lic">' + logo('mail', 'lg') + '</span><div class="lb"><b>Email</b><small>Add an email for recovery and receipts</small></div><button class="btn sm mint" id="le" type="button">Link email</button></div>');
  rows.push('<div class="lrow dim"><span class="lic">' + logo('telegram', 'lg') + '</span><div class="lb"><b>Telegram</b><small>Pay and get paid from a chat</small></div><span class="status draft">Later</span></div>');
  return rows.join('');
}

function statTiles(sm) {
  if (!sm) return '';
  const s = sm.stats;
  const t = [['Sent', s.sent.micro, s.sent.n + (s.sent.n === 1 ? ' payment' : ' payments'), 't-mint'], ['Received', s.received.micro, s.received.n + (s.received.n === 1 ? ' payment' : ' payments'), 't-blue'], ['Waiting', s.waiting.micro, s.waiting.n + ' to be claimed', 't-gold'], ['Taken back', s.returned.micro, s.returned.n + (s.returned.n === 1 ? ' payment' : ' payments'), 't-lilac']];
  return '<div class="stats">' + t.map((x) => '<div class="stat ' + x[3] + '"><small>' + esc(x[0]) + '</small><b>' + esc(usd(x[1])) + '</b><span>' + esc(x[2]) + '</span></div>').join('') + '</div>';
}

function profileHead(a) {
  const followers = a.sm && a.sm.profile && a.sm.profile.followers != null ? '<span class="chip">' + esc(fmtCount(a.sm.profile.followers)) + ' followers</span>' : '';
  return '<div class="ph-card">' + avatarHtml(a.sm && a.sm.profile, a.display, 'xl') + '<div class="ph-b"><div class="ph-n">' + esc(a.display) + '</div>' + (a.handle ? '<div class="ph-h">' + esc(a.handle) + '</div>' : '<div class="ph-h">' + esc((a.email && a.email.label) || '') + '</div>') + '<div class="ph-c"><span class="chip ' + (a.testnet ? 'test' : 'live') + '">' + esc(a.net) + (a.testnet ? ', test network' : '') + '</span>' + followers + (a.sm && a.sm.memberSince ? '<span class="chip">Joined ' + esc(fmtDateTime(a.sm.memberSince).replace(/, \d{1,2}:\d{2}.*$/, '')) + '</span>' : '') + '</div></div></div>';
}

function walletCard(a, session) {
  const addr = a.address || (session && session.address) || '';
  return '<div class="card wal"><div class="lrow"><span class="lic">' + logo('base', 'lg') + '</span><div class="lb"><b>Your wallet on ' + esc(a.net) + '</b><small class="mono">' + esc(addr.slice(0, 10) + '…' + addr.slice(-8)) + '</small></div><button class="btn sm ghost" id="cw" type="button">Copy</button></div>' + (a.explorer ? '<a class="note" target="_blank" rel="noopener" href="' + esc(a.explorer + addr) + '">View on the block explorer</a>' : '') + '</div>';
}

function linkEmailSheet(onDone) {
  const s = sheet('<h2>Link your email</h2><p class="hint">Add an email so you can sign in either way and get receipts. We send a 6 digit code to confirm it is yours.</p><form id="ef" novalidate><label class="field" for="em">Email</label><input class="input" id="em" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" required><button class="btn block mint" type="submit" style="margin-top:12px">Send me a code</button></form><div id="msg" class="err" role="alert" hidden></div>', { label: 'Link your email' });
  const msg = s.el.querySelector('#msg'); const ef = s.el.querySelector('#ef');
  const fail = (e) => { msg.hidden = false; msg.textContent = errorText(e); };
  ef.addEventListener('submit', async (ev) => {
    ev.preventDefault(); msg.hidden = true;
    const email = s.el.querySelector('#em').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(new Error('Enter a valid email address.'));
    try {
      await busy(ef.querySelector('button'), () => api('/api/auth/email/start', { method: 'POST', body: { email } }));
      ef.outerHTML = '<form id="cf" novalidate><p class="hint">We sent a 6 digit code to <b>' + esc(email) + '</b>.</p><label class="field" for="cd">Code</label><input class="input" id="cd" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456"><button class="btn block mint" type="submit" style="margin-top:12px">Link email</button></form>';
      const cf = s.el.querySelector('#cf'); cf.querySelector('#cd').focus();
      cf.addEventListener('submit', async (e2) => {
        e2.preventDefault(); msg.hidden = true;
        try {
          await busy(cf.querySelector('button'), () => api('/api/auth/email/verify', { method: 'POST', body: { email, code: cf.querySelector('#cd').value.trim(), link: true } }));
          s.close(); toast({ title: 'Email linked', body: email, ms: 4000 }); onDone();
        } catch (e3) { fail(e3); }
      });
    } catch (e) { fail(e); }
  });
}

function wireLinks(el, onDone) {
  const le = el.querySelector('#le'); if (le) le.addEventListener('click', () => linkEmailSheet(onDone));
}


const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hh = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':00';
function sw(id, label, on, locked) { return '<label class="swrow"><span>' + esc(label) + '</span><input type="checkbox" role="switch" id="' + id + '"' + (on ? ' checked' : '') + (locked ? ' disabled' : '') + '></label>'; }

async function mountSettings(el) {
  const anchor = el.querySelector('.rv-actions'); if (!anchor || el.querySelector('#settings-slot')) return;
  anchor.insertAdjacentHTML('beforebegin', '<div id="settings-slot"></div>');
  const slot = el.querySelector('#settings-slot');
  let prefs; let sess; let frozen = false;
  try { let me; [prefs, sess, me] = await Promise.all([api('/api/notification-settings'), api('/api/sessions'), api('/api/me')]); frozen = !!me.user.frozen; } catch { return; }
  const draw = () => {
    slot.innerHTML = '<h3 class="mini">Notifications</h3><div class="card nset">' + sw('nm', 'Money (payments received, sends, requests)', prefs.money) + sw('nc', 'Claims (opened, claimed, expiring, returned)', prefs.claims) + sw('ns', 'Security (new logins, limits, system)', true, true) + sw('nq', 'Quiet hours (no live pop-ups)', prefs.quietOn) + '<div class="qrow"' + (prefs.quietOn ? '' : ' hidden') + '><label>From <select class="input" id="qs">' + HOURS.map((h) => '<option value="' + h * 60 + '"' + (h * 60 === prefs.quietStart ? ' selected' : '') + '>' + hh(h * 60) + '</option>').join('') + '</select></label><label>To <select class="input" id="qe">' + HOURS.map((h) => '<option value="' + h * 60 + '"' + (h * 60 === prefs.quietEnd ? ' selected' : '') + '>' + hh(h * 60) + '</option>').join('') + '</select></label></div><p class="note">Turned off groups create no notifications. Quiet hours still keep them in your list, they just do not pop up.</p></div>'
      + '<h3 class="mini">Devices</h3><div class="card dev">' + (sess.sessions.length ? sess.sessions.map((x) => '<div class="devrow"><div><b>' + esc(x.label) + (x.current ? ' <span class="chip sm">This device</span>' : '') + '</b><small>Signed in ' + esc(timeAgo(x.createdAt)) + ', last active ' + esc(timeAgo(x.lastSeenAt)) + '</small></div><button class="btn sm ghost" data-rv="' + esc(x.id) + '" type="button">' + (x.current ? 'Sign out' : 'Remove') + '</button></div>').join('') : '<p class="note">Devices appear here the next time you sign in.</p>') + '<button class="btn block danger" id="lo" type="button" style="margin-top:10px">Log out everywhere</button></div>'
      + '<h3 class="mini">Safety</h3><div class="card"><b>' + (frozen ? 'Your account is frozen' : 'Freeze account') + '</b><p class="note" style="margin:6px 0 10px">' + (frozen ? 'Sending, batch payouts, withdrawals and Pay from X are paused. You can still receive money and take payments back.' : 'Pause sending, batch payouts, withdrawals and Pay from X at once if you think something is wrong. You can still receive money and take payments back, and unfreeze any time.') + '</p><button class="btn block ' + (frozen ? 'mint' : 'danger') + '" id="fz" type="button">' + (frozen ? 'Unfreeze my account' : 'Freeze my account') + '</button></div>';
    mountRecovery(slot);
    const save = async (patch) => { Object.assign(prefs, patch); try { prefs = await api('/api/notification-settings', { method: 'POST', body: { ...prefs, tzOffset: -new Date().getTimezoneOffset() } }); } catch (e) { toast({ title: 'Could not save', body: errorText(e), tone: 'bad', icon: '!' }); } };
    slot.querySelector('#nm').addEventListener('change', (e) => save({ money: e.target.checked }));
    slot.querySelector('#nc').addEventListener('change', (e) => save({ claims: e.target.checked }));
    slot.querySelector('#nq').addEventListener('change', (e) => { slot.querySelector('.qrow').hidden = !e.target.checked; save({ quietOn: e.target.checked }); });
    slot.querySelector('#qs').addEventListener('change', (e) => save({ quietStart: Number(e.target.value), quietOn: true }));
    slot.querySelector('#qe').addEventListener('change', (e) => save({ quietEnd: Number(e.target.value), quietOn: true }));
    slot.querySelectorAll('[data-rv]').forEach((b) => b.addEventListener('click', async () => {
      try { const r = await busy(b, () => api('/api/sessions/' + b.dataset.rv + '/revoke', { method: 'POST', body: {} })); if (r.signedOut) { try { await wallet.signOut(); } catch { /* best effort */ } location.href = '/'; return; } sess = await api('/api/sessions'); draw(); toast({ title: 'Device removed', ms: 2500 }); } catch (e) { toast({ title: 'Could not remove it', body: errorText(e), tone: 'bad', icon: '!' }); }
    }));
    slot.querySelector('#fz').addEventListener('click', async (e) => { try { await busy(e.currentTarget, () => api(frozen ? '/api/account/unfreeze' : '/api/account/freeze', { method: 'POST', body: {} })); frozen = !frozen; document.dispatchEvent(new CustomEvent('dovi:freeze', { detail: frozen })); toast({ title: frozen ? 'Account frozen' : 'Account unfrozen', ms: 3000 }); draw(); } catch (er) { toast({ title: 'Could not change that', body: errorText(er), tone: 'bad', icon: '!' }); } });
    slot.querySelector('#lo').addEventListener('click', async (e) => { try { await busy(e.currentTarget, () => api('/api/sessions/logout-all', { method: 'POST', body: {} })); try { await wallet.signOut(); } catch { /* wallet sign out is best effort */ } location.href = '/'; } catch (er) { toast({ title: 'Could not log out', body: errorText(er), tone: 'bad', icon: '!' }); } });
  };
  draw();
}

async function signOutNow() { await wallet.signOut(); location.href = '/'; }

export async function openAccountSheet(session, { go }) {
  const s = sheet('<div class="rv"><div class="skeleton" style="height:300px"></div></div>', { label: 'Your account', cls: 'rvback acct' });
  let a;
  try { a = await loadAccount(); } catch (e) { s.set('<div class="rv"><h2>Account</h2><p class="err">' + esc(errorText(e)) + '</p></div>'); return; }
  setTopAvatar(a);
  const lim = a.sm && a.sm.limits;
  s.set('<div class="rv">' + profileHead(a) + statTiles(a.sm) + (lim ? '<div class="card">' + meter('Sent today', lim.spentTodayMicro, lim.perDayMicro) + '<p class="note">Beta limits: ' + esc(usd(lim.perClaimMicro)) + ' per payment, ' + esc(usd(lim.perDayMicro)) + ' a day.</p></div>' : '') + '<h3 class="mini">Linked accounts</h3><div class="card llist">' + identityRows(a) + '</div>' + walletCard(a, session) + '<div class="rv-actions"><button class="btn block mint" id="dash" type="button">Open your dashboard</button><div class="two"><a class="btn ghost" href="/notifications">Notifications</a><a class="btn ghost" href="/help">Help</a></div><button class="btn block ghost" id="rep" type="button">Report a problem</button><button class="btn block danger" id="so" type="button">Sign out</button></div></div>');
  wireAvatars(s.el);
  s.el.querySelector('#dash').addEventListener('click', () => { s.close(); go('account'); });
  s.el.querySelector('#rep').addEventListener('click', () => { s.close(); reportSheet(); });
  s.el.querySelector('#so').addEventListener('click', signOutNow);
  wireLinks(s.el, () => { s.close(); openAccountSheet(session, { go }); });
  mountSettings(s.el);
  const cw = s.el.querySelector('#cw'); if (cw) cw.addEventListener('click', async () => { if (await copy(a.address)) toast({ title: 'Address copied', ms: 2000 }); });
}

export async function renderAccount(root, session, { go }) {
  root.innerHTML = '<div class="skeleton" style="height:140px"></div><div class="skeleton" style="height:200px;margin-top:14px"></div>';
  let a;
  try { a = await loadAccount(); } catch (e) { root.innerHTML = '<p class="err">' + esc(errorText(e)) + '</p>'; return; }
  setTopAvatar(a);
  const lim = a.sm && a.sm.limits; const st = a.sm && a.sm.stats;
  const act = await api('/api/activity?limit=4').catch(() => ({ activity: [] }));
  root.innerHTML = '<section class="dash"><div class="dcol">' + profileHead(a) + statTiles(a.sm) + (st ? '<div class="card"><div class="rows"><div class="r"><span>DOVI fees paid</span><b>' + esc(usd(st.feesPaid.micro)) + '</b></div><div class="r"><span>Payments claimed by others</span><b>' + esc(String(st.claimed.n)) + '</b></div><div class="r"><span>Direct sends to DOVI users</span><b>' + esc(String(st.directSent.n)) + '</b></div></div></div>' : '') + '<h2 class="sec">Recent <a href="#activity">See all</a></h2><div class="list">' + (act.activity.length ? act.activity.map((x) => '<div class="item"><div class="ico" aria-hidden="true">•</div><div class="mid"><div class="t">' + esc(KL[x.kind] || x.kind.replace(/_/g, ' ')) + (x.counterparty ? ' ' + esc(x.counterparty) : '') + '</div><div class="d">' + esc(fmtDateTime(x.createdAt)) + ', ' + esc(timeAgo(x.createdAt)) + '</div></div><div class="amt">' + esc(usd(x.amountMicro)) + '</div></div>').join('') : '<div class="empty"><h3>No activity yet</h3></div>') + '</div></div><div class="dcol"><h2 class="sec">Linked accounts</h2><div class="card llist">' + identityRows(a) + '</div><div class="note" style="margin:8px 4px 16px">Sign in with email or X, then link the other one any time. A payment to an X handle can only be claimed by the account that has proven that handle.</div>' + (lim ? '<h2 class="sec">Limits</h2><div class="card">' + meter('Sent today', lim.spentTodayMicro, lim.perDayMicro) + '<div class="rows" style="margin-top:10px"><div class="r"><span>Per payment</span><b>' + esc(usd(lim.perClaimMicro)) + '</b></div><div class="r"><span>Minimum</span><b>' + esc(usd(lim.minMicro)) + '</b></div><div class="r"><span>DOVI fee on a claim</span><b>' + esc((lim.feeBps / 100).toFixed(2).replace(/\.00$/, '')) + '%, min ' + esc(usd(lim.feeMinMicro)) + '</b></div></div></div>' : '') + '<h2 class="sec">Wallet</h2>' + walletCard(a, session) + '<h2 class="sec">Account</h2><div class="rv-actions"><div class="two"><a class="btn ghost" href="/notifications">Notifications</a><a class="btn ghost" href="/help">Help</a></div><button class="btn block ghost" id="rep" type="button">Report a problem</button><button class="btn block danger" id="so" type="button">Sign out</button></div></div></section>';
  wireAvatars(root);
  root.querySelector('#rep').addEventListener('click', reportSheet);
  root.querySelector('#so').addEventListener('click', signOutNow);
  wireLinks(root, () => renderAccount(root, session, { go }));
  mountSettings(root);
  { const dc = root.querySelector('.dcol'); if (dc) { dc.insertAdjacentHTML('beforeend', '<div id="mydata"></div>'); mountMyData(root); } }
  const cw = root.querySelector('#cw'); if (cw) cw.addEventListener('click', async () => { if (await copy(a.address)) toast({ title: 'Address copied', ms: 2000 }); });
}
