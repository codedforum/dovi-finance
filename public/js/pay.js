import { api } from './api.js?v=dev';
import { esc, usd, validAmount } from './format.js?v=dev';
import { $, errorText, toast, copy } from './ui.js?v=dev';
import { avatarHtml, wireAvatars, fmtCount } from './people.js?v=dev';

const view = $('#view');
const byHandle = location.pathname.match(/^\/pay\/@?([A-Za-z0-9_]{1,15})$/);
const byCode = location.pathname.match(/^\/p\/([2-9a-hj-km-np-zA-HJ-NP-Z]{8})$/);
const CHIPS = ['1', '5', '10', '20'];

function micro(text) { const [w, f = ''] = String(text).split('.'); return BigInt(w || '0') * 1000000n + BigInt((f + '000000').slice(0, 6)); }

function gone(msg) {
  view.innerHTML = '<div class="card paycard"><div class="pay-gone"><span aria-hidden="true">?</span><h2>' + esc(msg) + '</h2><p>Check the link with the person who sent it to you.</p><a class="btn block" href="/">Go to DOVI</a></div></div>';
}

async function viewer(handle) {
  const app = ((document.querySelector('meta[name="dovi-app"]') || {}).content || '').replace(/\/+$/, '');
  if (app && app !== location.origin) return false;
  try {
    const who = await api('/api/auth/me');
    if (!who.identity) return false;
    const me = await api('/api/me');
    return (me.user.identities || []).some((i) => i.kind === 'x' && String(i.label).toLowerCase() === String(handle).toLowerCase());
  } catch { return false; }
}

async function main() {
  let info;
  try {
    info = byCode ? await api('/api/paylinks/' + byCode[1]) : await api('/api/pay/handle/' + byHandle[1]);
  } catch (e) { return gone(byCode ? 'This payment link is not active' : 'We could not find that account'); }
  const handle = info.handle; const p = info.profile;
  const fixed = info.amountMicro ? BigInt(info.amountMicro) : null;
  const mine = await viewer(handle);
  const url = location.origin + location.pathname;
  const head = '<div class="pay-head">' + avatarHtml(p, handle, 'xl') + '<div class="pay-who"><div class="pay-n">' + esc((p && p.name) || handle) + '</div><div class="pay-h">' + esc(handle) + '</div>' + (p && p.followers != null ? '<span class="chip">' + esc(fmtCount(p.followers)) + ' followers</span>' : '') + '</div></div>';
  const title = byCode ? '<div class="pay-title"><small>Payment for</small><b>' + esc(info.title) + '</b></div>' : '<div class="pay-title"><small>Pay</small><b>' + esc(handle) + ' on DOVI</b></div>';
  let amountBlock;
  if (fixed) amountBlock = '<div class="pay-fixed"><small>Amount</small><b>' + esc(usd(fixed.toString())) + '</b></div>';
  else amountBlock = '<label class="field" for="am">Amount in USD</label><div class="pay-chips" id="chips">' + CHIPS.map((c) => '<button type="button" class="chip pc" data-v="' + c + '">$' + c + '</button>').join('') + '</div><div class="amount-wrap"><span class="cur" aria-hidden="true">$</span><input class="input" id="am" inputmode="decimal" autocomplete="off" placeholder="5.00"></div>';
  const form = mine
    ? '<div class="pay-own"><b>This is your link</b><p>Share it anywhere. People pay your ' + esc(handle) + ' with a sign in and one tap.</p><div class="linkbox"><span>' + esc(url) + '</span><button class="btn sm" id="cp" type="button">Copy</button></div><a class="btn block ghost" href="/app#links">Manage your links</a></div>'
    : '<form id="pf" novalidate>' + amountBlock + '<label class="field" for="nt">Note (optional)</label><input class="input" id="nt" maxlength="140" placeholder="' + (byCode ? esc(info.title) : 'For lunch') + '"><div id="msg" class="err" role="alert" hidden></div><button class="btn block mint" type="submit" style="margin-top:16px">Pay ' + esc(handle) + '</button><p class="note" style="text-align:center">You sign in with email or X, check the details, then approve. DOVI never asks for a seed phrase.</p></form>';
  view.innerHTML = '<div class="card paycard">' + head + title + form + '</div>';
  wireAvatars(view);
  if (mine) { $('#cp').addEventListener('click', async () => { if (await copy(url)) toast({ title: 'Link copied', ms: 2000 }); }); return; }
  const am = $('#am'); const msg = $('#msg');
  view.querySelectorAll('.pc').forEach((b) => b.addEventListener('click', () => { am.value = b.dataset.v; view.querySelectorAll('.pc').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); }));
  $('#pf').addEventListener('submit', (ev) => {
    ev.preventDefault(); msg.hidden = true;
    const amount = fixed ? (Number(fixed) / 1e6).toString() : am.value.trim();
    if (!validAmount(amount)) { msg.hidden = false; msg.textContent = 'Enter an amount like 5 or 5.50.'; return; }
    const note = $('#nt').value.trim();
    const payload = JSON.stringify({ to: handle, amount, note, paylink: byCode ? byCode[1] : null });
    const app = ((document.querySelector('meta[name="dovi-app"]') || {}).content || '').replace(/\/+$/, '');
    const b64 = btoa(unescape(encodeURIComponent(payload))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    location.href = (app || '') + '/app?pay=' + b64 + '#send';
  });
}

main().catch((e) => { view.innerHTML = '<p class="err">' + esc(errorText(e)) + '</p>'; });
