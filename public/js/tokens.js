import { api } from './api.js?v=dev';
import { esc, timeAgo } from './format.js?v=dev';
import * as wallet from './wallet.js?v=dev';
import { sheet, busy, copy, errorText, toast } from './ui.js?v=dev';
import { openSwap, swapOptions } from './swap.js?v=dev';
import { linesHtml, stepsHtml, stepper, sendAndConfirm, okSheet, failFoot } from './flow.js?v=dev';

const NET = 'Base Sepolia';
const friendly = (e) => /estimate gas|execution reverted|useroperation reverted/i.test(String(e && e.message)) ? new Error('The network could not prepare this payment. Check that you have enough ' + 'VIBES for the amount, then try again.') : e;
const STATUS = { funded: 'Waiting', claimed: 'Claimed', returned: 'Returned', expired: 'Expired', pending: 'Pending' };

async function tokenInfo() { try { const o = await api('/api/tokens'); return o && o.enabled ? o : null; } catch { return null; } }

/* the home card: balance, send, and open payments in extra tokens */
/* the token picker on the main Send screen: choosing a test token opens the token send sheet */
export async function mountSendPicker(root, session) {
  const info = await tokenInfo(); if (!info || !root.isConnected) return;
  const form = root.querySelector('#sf'); if (!form) return;
  form.insertAdjacentHTML('afterbegin', tokenSelect(info.tokens, 'USDC', 'tkp'));
  const sel = form.querySelector('#tkp');
  sel.addEventListener('change', () => { if (sel.value !== 'USDC') { const v = sel.value; sel.value = 'USDC'; openTokenSend(session, info.tokens, v, null); } });
}

export async function mountTokens(root, session) {
  const slot = root.querySelector('#tok'); if (!slot) return;
  const info = await tokenInfo(); if (!info || !root.isConnected) { slot.innerHTML = ''; return; }
  let mine = { sent: [], incoming: [] };
  try { mine = await api('/api/tokens/mine'); } catch { /* the card still shows the balance */ }
  const t = info.tokens[0];
  const sw = await swapOptions();
  const bal = info.balances && info.balances[t.symbol];
  const row = (v, who) => '<div class="r"><span>' + esc(who) + '</span><b>' + esc(v.amountText) + '</b><span class="status ' + (v.status === 'claimed' ? 'done' : 'draft') + '">' + esc(STATUS[v.status] || v.status) + '</span>' +
    (who.startsWith('From') || v.status === 'funded' ? '<button class="btn sm" data-tk="' + (who.startsWith('From') ? 'claim' : 'back') + '" data-id="' + esc(v.claimId) + '" type="button">' + (who.startsWith('From') ? 'Claim' : 'Take back') + '</button>' : '') + '</div>';
  const rows = mine.incoming.map((v) => row(v, 'From ' + (v.from || 'someone'))).concat(mine.sent.slice(0, 4).map((v) => row(v, 'To ' + v.to))).join('');
  slot.innerHTML = '<h2 class="sec">Test tokens</h2><div class="card tok-card"><div class="rows"><div class="r"><span>' + esc(t.name) + ' <small>(test token)</small></span><b>' + esc(bal ? bal.text : '0') + ' ' + esc(t.symbol) + '</b></div>' + rows + '</div>' +
    '<button class="btn block" id="tks" type="button">Send a token</button>' + (sw ? '<button class="btn block" id="tkw" type="button" style="margin-top:8px">Swap USDC and ' + esc(t.symbol) + '</button>' : '') + (t.faucet ? '<button class="btn block ghost" id="tkf" type="button" style="margin-top:8px">Get 100 test ' + esc(t.symbol) + '</button>' : '') + '</div>';
  slot.querySelector('#tks').addEventListener('click', () => openTokenSend(session, info.tokens, t.symbol, () => mountTokens(root, session)));
  const swb = slot.querySelector('#tkw'); if (swb) swb.addEventListener('click', () => openSwap(session, sw, () => setTimeout(() => mountTokens(root, session), 800)));
  const fb = slot.querySelector('#tkf');
  if (fb) fb.addEventListener('click', async () => {
    try { await busy(fb, async () => { await wallet.sendCalls([{ to: t.address, data: '0xde5f72fd' }]); await new Promise((r) => setTimeout(r, 2500)); }); toast('Test ' + t.symbol + ' is on its way.'); mountTokens(root, session); }
    catch (e) { toast(/TooSoon|too soon/i.test(String(e && e.message)) ? 'You can take more in an hour.' : errorText(e)); }
  });
  slot.onclick = (ev) => {
    const b = ev.target.closest('[data-tk]'); if (!b) return;
    if (b.dataset.tk === 'claim') openTokenClaim(b.dataset.id, session, () => mountTokens(root, session));
    else takeBack(b.dataset.id, () => mountTokens(root, session));
  };
}

export function tokenSelect(list, current, id = 'tks2') {
  return '<label class="field" for="' + id + '" style="margin-top:0">Token</label><select class="input" id="' + id + '"><option value="USDC"' + (current === 'USDC' ? ' selected' : '') + '>USDC (test dollars)</option>' + list.map((x) => '<option value="' + esc(x.symbol) + '"' + (x.symbol === current ? ' selected' : '') + '>' + esc(x.symbol) + ' (' + esc(x.name) + ', test token)</option>').join('') + '</select>';
}

export function openTokenSend(session, tokenList, symbol, onDone) {
  const list = Array.isArray(tokenList) ? tokenList : [tokenList];
  let t = list.find((x) => x.symbol === symbol) || list[0];
  const s = sheet('', { label: 'Send a token' });
  function form(err = '') {
    s.set('<div class="rv"><h2>Send</h2>' + tokenSelect(list, t.symbol) + '<p class="hint" role="note"><b>Test token.</b> ' + esc(t.name) + ' here is a test token on ' + NET + '. It has no real value.</p>' +
      '<label class="field" for="tkw">To</label><input class="input" id="tkw" autocomplete="off" placeholder="@handle or email">' +
      '<label class="field" for="tka">Amount in ' + esc(t.symbol) + '</label><input class="input" id="tka" inputmode="decimal" autocomplete="off" placeholder="' + esc(t.min) + '">' +
      '<p class="hint">From ' + esc(t.min) + ' to ' + esc(t.max) + ' ' + esc(t.symbol) + ' per payment. No fee.</p>' + (err ? '<p class="err" role="alert">' + esc(err) + '</p>' : '') +
      '<button class="btn block mint" id="tkg" type="button">Review</button></div>');
    s.el.querySelector('#tkg').addEventListener('click', (e) => review(e.currentTarget));
    s.el.querySelector('#tks2').addEventListener('change', (e) => { if (e.target.value === 'USDC') { s.close(); location.hash = '#send'; return; } t = list.find((x) => x.symbol === e.target.value) || t; form(); });
  }
  async function review(btn) {
    const to = s.el.querySelector('#tkw').value.trim(); const amount = s.el.querySelector('#tka').value.trim();
    try {
      const d = await busy(btn, () => api('/api/tokens/draft', { method: 'POST', body: { to, amount, symbol: t.symbol, address: session.address, idempotencyKey: crypto.randomUUID() } }));
      s.set('<div class="rv"><h2>Review</h2>' + linesHtml([{ label: 'To', value: d.to }, { label: 'Amount', value: d.amountText }, { label: 'Fee', value: 'None' }]) + '<p class="note">They have 7 days to claim it. If they do not, you can take it back.</p>' +
        '<div class="rv-foot" id="rf"><button class="btn block mint" id="go" type="button">Send ' + esc(d.amountText) + '</button><button class="btn block ghost" id="cx" type="button" style="margin-top:8px">Cancel</button></div></div>');
      s.el.querySelector('#cx').addEventListener('click', s.close);
      s.el.querySelector('#go').addEventListener('click', () => run(d));
    } catch (e) { form(errorText(e)); }
  }
  async function run(d) {
    s.set('<div class="rv"><h2>Sending</h2>' + stepsHtml([['send', 'Approving and sending'], ['confirm', 'Confirming on', true], ['done', 'Sent']], NET) + '<div class="rv-foot" id="rf">Keep this window open.</div></div>');
    const step = stepper(s.el); s.lock(true); let last = 'send';
    try {
      const v = await sendAndConfirm({ txs: d.txs, confirm: () => api('/api/tokens/' + d.claimId + '/funded', { method: 'POST', body: {} }), onStep: (i, st, x) => { last = i; step(i, st, x); } });
      s.lock(false);
      okSheet(s, { title: 'Sent', body: esc(v.amountText) + ' is waiting for ' + esc(v.to) + '.', extra: '<button class="btn block" id="cp" type="button">Copy claim link</button>', doneLabel: 'Done' });
      const cp = s.el.querySelector('#cp'); if (cp) cp.addEventListener('click', () => copy(v.link));
      if (onDone) onDone();
    } catch (e) { s.lock(false); step(last, 'fail', ''); failFoot(s.el, friendly(e), last === 'send' ? () => run(d) : null, s.close); }
  }
  form();
}

export async function openTokenClaim(id, session, onDone) {
  const s = sheet('<div class="rv"><div class="skeleton" style="height:200px"></div></div>', { label: 'Claim payment' });
  let c;
  try { c = await api('/api/tokens/claim/' + encodeURIComponent(id)); } catch (e) { s.set('<div class="rv"><h2>Payment not found</h2><p>' + esc(errorText(e)) + '</p></div>'); return; }
  if (c.status !== 'funded') { s.set('<div class="rv"><h2>' + esc(STATUS[c.status] || c.status) + '</h2><p>' + esc(c.amountText) + ' from ' + esc(c.from) + ' is not available to claim.</p></div>'); return; }
  s.set('<div class="rv"><p class="hint">' + esc(c.from) + ' sent you</p><h2>' + esc(c.amountText) + '</h2><p class="hint" role="note"><b>Test token</b> on ' + NET + '.</p><div class="rv-foot" id="rf"><button class="btn block mint" id="cl" type="button">Claim</button></div></div>');
  s.el.querySelector('#cl').addEventListener('click', async () => {
    s.set('<div class="rv"><h2>Claiming</h2>' + stepsHtml([['send', 'Claiming on the network'], ['confirm', 'Confirming on', true], ['done', 'In your account']], NET) + '<div class="rv-foot" id="rf">Keep this window open.</div></div>');
    const step = stepper(s.el); s.lock(true); let last = 'send';
    try {
      const p = await api('/api/tokens/' + encodeURIComponent(id) + '/prepare-claim', { method: 'POST', body: { address: session.address } });
      const v = await sendAndConfirm({ txs: [p.tx], confirm: () => api('/api/tokens/' + encodeURIComponent(id) + '/claimed', { method: 'POST', body: {} }), onStep: (i, st, x) => { last = i; step(i, st, x); } });
      s.lock(false); okSheet(s, { title: 'Claimed', body: esc(v.amountText) + ' is in your account.' });
      if (onDone) onDone();
    } catch (e) { s.lock(false); step(last, 'fail', ''); failFoot(s.el, friendly(e), null, s.close); }
  });
}

async function takeBack(id, onDone) {
  const s = sheet('<div class="rv"><h2>Taking it back</h2>' + stepsHtml([['send', 'Returning to you'], ['confirm', 'Confirming on', true], ['done', 'Returned']], NET) + '<div class="rv-foot" id="rf">Keep this window open.</div></div>', { label: 'Take back' });
  const step = stepper(s.el); s.lock(true); let last = 'send';
  try {
    const p = await api('/api/tokens/' + encodeURIComponent(id) + '/prepare-reclaim', { method: 'POST', body: {} });
    const v = await sendAndConfirm({ txs: [p.tx], confirm: () => api('/api/tokens/' + encodeURIComponent(id) + '/reclaimed', { method: 'POST', body: {} }), onStep: (i, st, x) => { last = i; step(i, st, x); } });
    s.lock(false); okSheet(s, { title: 'Returned', body: esc(v.amountText) + ' is back in your account.' });
    if (onDone) onDone();
  } catch (e) { s.lock(false); step(last, 'fail', ''); failFoot(s.el, friendly(e), null, s.close); }
}

void timeAgo; void toast;
