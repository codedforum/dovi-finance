import { api } from './api.js?v=dev';
import { esc, usd, fmtDateTime, validAmount } from './format.js?v=dev';
import { busy, copy, errorText, toast, sheet } from './ui.js?v=dev';
import { nairaOptions, openNairaSell } from './naira.js?v=dev';
import { backBar, linesHtml, stepsHtml, stepper, sendAndConfirm, okSheet, failFoot } from './flow.js?v=dev';

const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);

async function pollPrivate(id, step) {
  for (let i = 0; i < 90; i++) {
    const w = await api('/api/withdraw/' + id);
    if (w.status === 'done') return w;
    if (['refunded', 'failed'].includes(w.status)) throw new Error('The private route could not finish. Your USDC is refunded to your DOVI account.');
    step('route', 'active', 'Private route in progress, usually under a minute');
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error('Still in progress. Check Activity in a few minutes.');
}

export async function renderWithdraw(root, session, { go }) {
  root.innerHTML = backBar('Withdraw', 'Move your USDC to a Base wallet you control.', 'withdraw') + '<div class="skeleton" style="height:260px"></div>';
  const opts = await api('/api/withdraw/options').catch(() => null);
  const nopt = await nairaOptions();
  if (!opts) { root.innerHTML = backBar('Withdraw') + '<p class="err">Withdrawals are not available right now.</p>'; return; }
  let route = 'public';
  root.innerHTML = backBar('Withdraw', 'Move your USDC to a Base wallet you control.', 'withdraw') +
    '<div class="hero-card wd-bal"><div class="lbl"><span>Available</span></div><div class="bal" id="wb"><span class="skeleton" style="display:inline-block;width:140px;height:44px"></span></div></div>' +
    (nopt ? '<div class="card" id="wsw"><b>Cash out to naira</b>' + (nopt.simulated ? ' <span class="status draft">Test</span>' : '') + '<p class="note" style="margin:6px 0 10px">Send USDC from your DOVI account and receive naira in your own Nigerian bank account.</p><button class="btn block mint" id="wng" type="button">Cash out to naira</button></div>' : '<div class="card" id="wsw"><b>Swap to naira or other fiat</b> <span class="status draft">Coming soon</span><p class="note" style="margin:6px 0 0">Cash out to your bank, peer to peer or through a licensed partner. Availability depends on your country.</p></div>') +
    '<form class="card" id="wf" novalidate><label class="field" for="wa" style="margin-top:0">Wallet address on Base</label><input class="input mono" id="wa" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="0x…">' +
    '<label class="field" for="wm">Amount</label><div class="amount-wrap"><span class="cur" aria-hidden="true">$</span><input class="input" id="wm" inputmode="decimal" placeholder="0.00" autocomplete="off"></div><button class="linkbtn" id="wx" type="button">Withdraw everything</button>' +
    '<fieldset class="routes" id="wr"><legend class="field">Route</legend>' +
    '<label class="route on"><input type="radio" name="rt" value="public" checked><span><b>Public</b><small>Straight to your wallet. Fastest. Anyone can see it came from your DOVI account.</small></span></label>' +
    '<label class="route' + (opts.private.available ? '' : ' off') + '"><input type="radio" name="rt" value="private"' + (opts.private.available ? '' : ' disabled') + '><span><b>Private</b><small>' + (opts.private.available ? 'Hides the link between your DOVI account and this wallet. Amount and timing stay visible, and DOVI can still see it.' : esc(opts.private.reason)) + '</small></span></label>' +
    (nopt ? '' : '<label class="route off"><input type="radio" name="rt" value="fiat" disabled><span><b>To naira or other cash</b><small>' + esc(opts.fiat.reason) + '</small></span></label>') + '</fieldset>' +
    '<p class="err" id="wmsg" role="alert" hidden></p><button class="btn block mint lg" id="wgo" type="submit">Review withdrawal</button></form>' +
    '<h2 class="sec">Recent withdrawals</h2><div class="list" id="wh"><div class="skeleton" style="height:56px"></div></div>';
  const wng = root.querySelector('#wng');
  if (wng) wng.addEventListener('click', () => openNairaSell(session, nopt, { onDone: () => { loadHist(); api('/api/wallet/balance?address=' + encodeURIComponent(session.address)).then((b) => { session.balanceMicro = b.micro; root.querySelector('#wb').textContent = usd(b.micro); }).catch(() => {}); } }));
  const bal = root.querySelector('#wb'); const f = root.querySelector('#wf'); const msg = root.querySelector('#wmsg');
  api('/api/wallet/balance?address=' + encodeURIComponent(session.address)).then((b) => { session.balanceMicro = b.micro; bal.textContent = usd(b.micro); }).catch(() => { bal.textContent = 'Unavailable'; });
  f.querySelector('#wx').addEventListener('click', () => { if (session.balanceMicro) f.querySelector('#wm').value = (Number(session.balanceMicro) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, ''); });
  f.querySelectorAll('input[name=rt]').forEach((r) => r.addEventListener('change', () => { route = r.value; f.querySelectorAll('.route').forEach((l) => l.classList.toggle('on', l.querySelector('input').checked)); }));
  const loadHist = () => api('/api/withdraw').then((r) => { const el = root.querySelector('#wh'); if (!el) return; el.innerHTML = r.withdrawals.length ? r.withdrawals.map((w) => '<div class="item"><div class="ico" aria-hidden="true">&#8599;</div><div class="mid"><b>To ' + esc(short(w.to)) + '</b><small>' + esc(w.route === 'private' ? 'Private' : 'Public') + ', ' + esc(w.status) + ', ' + esc(fmtDateTime(w.createdAt)) + '</small></div><div class="amt">' + esc(usd(w.amountMicro)) + '</div></div>').join('') : '<p class="hint">No withdrawals yet.</p>'; }).catch(() => {});
  loadHist();
  f.addEventListener('submit', (ev) => {
    ev.preventDefault(); msg.hidden = true;
    const to = f.querySelector('#wa').value.trim(); const amount = f.querySelector('#wm').value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) { msg.hidden = false; msg.textContent = 'Enter a valid Base wallet address, starting with 0x.'; return; }
    if (!validAmount(amount)) { msg.hidden = false; msg.textContent = 'Enter an amount like 5 or 5.50.'; return; }
    review({ to, amount, route }, session, () => { f.reset(); loadHist(); api('/api/wallet/balance?address=' + encodeURIComponent(session.address)).then((b) => { bal.textContent = usd(b.micro); }).catch(() => {}); });
  });
}

async function review(input, session, onDone) {
  const s = sheet('<div class="rv"><h2>Preparing</h2><div class="skeleton" style="height:140px"></div></div>', { label: 'Review withdrawal', cls: 'rvback' });
  let p;
  try { p = await api('/api/withdraw/prepare', { method: 'POST', body: input }); }
  catch (e) { s.set('<div class="rv"><h2>We could not prepare that</h2><p class="err" role="alert">' + esc(errorText(e)) + '</p><button class="btn block" id="cl" type="button" style="margin-top:14px">Close</button></div>'); s.el.querySelector('#cl').addEventListener('click', s.close); return; }
  const net = await api('/api/public/cdp-config').then((c) => (c.testnet ? 'Base Sepolia' : 'Base')).catch(() => 'Base');
  s.set('<div class="rv"><h2>Review withdrawal</h2>' + linesHtml(p.preview.lines.map((l) => l)) + '<p class="note">' + esc(p.preview.note) + '</p><div class="rv-actions"><button class="btn block mint lg" id="go" type="button">Withdraw ' + esc(usd(p.amountMicro)) + '</button><button class="btn block ghost" id="cancel" type="button">Cancel</button></div></div>');
  s.el.querySelector('#cancel').addEventListener('click', s.close);
  s.el.querySelector('#go').addEventListener('click', run);
  async function run() {
    const steps = [['prep', 'Withdrawal prepared'], ['send', 'Approving and sending'], ['confirm', 'Confirming on', true]].concat(p.route === 'private' ? [['route', 'Private route']] : []).concat([['done', 'Arrived']]);
    s.set('<div class="rv"><h2>Withdrawing</h2>' + stepsHtml(steps, net) + '<div class="rv-foot" id="rf">Keep this window open.</div></div>');
    const step = stepper(s.el); step('prep', 'done'); s.lock(true);
    let last = 'send';
    try {
      let w = await sendAndConfirm({ txs: [p.tx], confirm: () => api('/api/withdraw/' + p.withdrawalId + '/confirm', { method: 'POST', body: {} }), onStep: (i, st, t) => { last = i; step(i, st, t); } });
      if (p.route === 'private') { last = 'route'; step('route', 'active', ''); w = await pollPrivate(p.withdrawalId, step); step('route', 'done'); }
      s.lock(false);
      okSheet(s, { title: 'Withdrawal sent', body: esc(usd(p.receiveMicro)) + ' is on its way to ' + esc(short(p.to)) + '.' });
      s.el.querySelector('#dn').addEventListener('click', s.close);
      onDone();
    } catch (e) { s.lock(false); step(last, 'fail', ''); failFoot(s.el, e, last === 'send' ? run : null, s.close); }
  }
}
