import { api } from './api.js?v=dev';
import { esc, usd, validAmount } from './format.js?v=dev';
import { busy, copy, errorText, toast, sheet } from './ui.js?v=dev';
import { backBar, linesHtml, stepsHtml, stepper, sendAndConfirm, okSheet, failFoot } from './flow.js?v=dev';

const tweetUrl = (t) => 'https://x.com/intent/tweet?text=' + encodeURIComponent(t);

function exampleRows(ex) {
  return ex.map((e) => '<div class="lrow"><div class="lb"><b class="mono">' + esc(e) + '</b></div><button class="btn sm ghost" data-cp="' + esc(e) + '" type="button">Copy</button><a class="btn sm" target="_blank" rel="noopener" href="' + esc(tweetUrl(e)) + '">Try on X</a></div>').join('');
}

export async function renderAutopay(root, session, { go }) {
  root.innerHTML = backBar('Pay from X', 'Tweet a payment. DOVI sends it from your account, inside limits you set.', 'pay-from-x') + '<div class="skeleton" style="height:220px"></div>';
  let st;
  try { st = await api('/api/autopay'); } catch (e) { root.innerHTML = backBar('Pay from X') + '<p class="err">' + esc(errorText(e)) + '</p>'; return; }
  const limitsForm = '<form class="card" id="af" novalidate><label class="field" for="ap" style="margin-top:0">Most per payment</label><div class="amount-wrap"><span class="cur" aria-hidden="true">$</span><input class="input" id="ap" inputmode="decimal" value="' + esc(st.perPaymentMicro ? String(Number(st.perPaymentMicro) / 1e6) : '5') + '" autocomplete="off"></div>' +
    '<label class="field" for="ad">Most per day</label><div class="amount-wrap"><span class="cur" aria-hidden="true">$</span><input class="input" id="ad" inputmode="decimal" value="' + esc(st.perDayMicro ? String(Number(st.perDayMicro) / 1e6) : '20') + '" autocomplete="off"></div>' +
    '<p class="hint">Beta limits: ' + esc(usd(st.maxPerPaymentMicro)) + ' per payment, ' + esc(usd(st.maxPerDayMicro)) + ' per day.</p><p class="err" id="am" role="alert" hidden></p><button class="btn block mint lg" id="ago" type="submit">' + (st.enabled ? 'Update limits' : 'Turn on pay from X') + '</button></form>';
  root.innerHTML = backBar('Pay from X', 'Tweet a payment. DOVI sends it from your account, inside limits you set.', 'pay-from-x') +
    '<div class="card ap-top"><span class="status ' + (st.enabled ? 'done' : 'draft') + '">' + (st.enabled ? 'On' : 'Off') + '</span>' +
    (st.enabled ? '<p><b>' + esc(usd(st.perPaymentMicro)) + '</b> per payment, <b>' + esc(usd(st.perDayMicro)) + '</b> per day.</p>' : '<p>Tweet <b>@DoviFinance send 5 usdc to @name</b>, or reply to their post with <b>@DoviFinance send 5 usdc</b>, and DOVI sends it.</p>') + '</div>' +
    (st.xLinked ? '' : '<div class="card"><p><b>Link your X account first.</b> Pay from X works from the X account you link, so nobody else can spend your money.</p><a class="btn mint" href="/api/auth/x/start?return=' + encodeURIComponent('/app#autopay') + '">Link X</a></div>') +
    (st.xLinked && st.available ? limitsForm : '') +
    '<h2 class="sec">How it works</h2><div class="card"><ol class="plain"><li>You set the limits above, once, with your wallet.</li><li>You tweet <span class="mono">@DoviFinance send 5 usdc to @name</span>.</li><li>DOVI sends it from your account and replies without a link. @name gets a direct message with the claim steps, and the money is held for them. If their messages are closed, they see it on Home when they sign in with that X account.</li><li>You can cancel any payment in <a href="#activity">Activity</a> until it is claimed, and turn this off any time.</li></ol></div>' +
    '<h2 class="sec">AI agents</h2><div class="card"><p>Let an AI agent send payments through DOVI with a key that has its own, lower limits.</p><a class="btn" href="#keys">Agent keys</a></div>' +
    '<h2 class="sec">Try it</h2><div class="card">' + exampleRows(st.examples) + '</div>' +
    (st.enabled ? '<button class="btn block danger" id="aoff" type="button" style="margin-top:14px">Turn off pay from X</button>' : '') +
    (st.available ? '' : '<p class="hint" style="margin-top:12px">Pay from X is not switched on yet. DOVI is not reading tweets, so nothing is sent from a tweet and there is nothing to turn on for now.</p>');
  root.querySelectorAll('[data-cp]').forEach((x) => x.addEventListener('click', async () => { if (await copy(x.dataset.cp)) toast({ title: 'Copied', ms: 1600 }); }));
  const f = root.querySelector('#af'); const msg = root.querySelector('#am');
  if (f) f.addEventListener('submit', (ev) => {
    ev.preventDefault(); msg.hidden = true;
    const pp = f.querySelector('#ap').value.trim(); const pd = f.querySelector('#ad').value.trim();
    if (!validAmount(pp) || !validAmount(pd)) { msg.hidden = false; msg.textContent = 'Enter amounts like 5 or 20.'; return; }
    enable({ perPayment: pp, perDay: pd }, () => go('autopay'));
  });
  const off = root.querySelector('#aoff'); if (off) off.addEventListener('click', () => disable(() => go('autopay')));
}

async function enable(input, onDone) {
  const s = sheet('<div class="rv"><h2>Preparing</h2><div class="skeleton" style="height:140px"></div></div>', { label: 'Turn on pay from X', cls: 'rvback' });
  let p;
  try { p = await api('/api/autopay/prepare', { method: 'POST', body: input }); }
  catch (e) { s.set('<div class="rv"><h2>We could not prepare that</h2><p class="err" role="alert">' + esc(errorText(e)) + '</p><button class="btn block" id="cl" type="button" style="margin-top:14px">Close</button></div>'); s.el.querySelector('#cl').addEventListener('click', s.close); return; }
  const net = await api('/api/public/cdp-config').then((c) => (c.testnet ? 'Base Sepolia' : 'Base')).catch(() => 'Base');
  s.set('<div class="rv"><h2>Turn on pay from X</h2>' + linesHtml(p.preview.lines) + '<p class="note">' + esc(p.preview.note) + '</p><div class="rv-actions"><button class="btn block mint lg" id="go" type="button">Approve with your wallet</button><button class="btn block ghost" id="cancel" type="button">Cancel</button></div></div>');
  s.el.querySelector('#cancel').addEventListener('click', s.close);
  s.el.querySelector('#go').addEventListener('click', run);
  async function run() {
    s.set('<div class="rv"><h2>Turning on</h2>' + stepsHtml([['prep', 'Limits prepared'], ['send', 'Approving'], ['confirm', 'Confirming on', true], ['done', 'Pay from X is on']], net) + '<div class="rv-foot" id="rf">Keep this window open.</div></div>');
    const step = stepper(s.el); step('prep', 'done'); s.lock(true); let last = 'send';
    try {
      await sendAndConfirm({ txs: p.txs, confirm: () => api('/api/autopay/confirm', { method: 'POST', body: input }), onStep: (i, st, t) => { last = i; step(i, st, t); } });
      s.lock(false); okSheet(s, { title: 'Pay from X is on', body: 'Tweet <b>@DoviFinance send @name 5 usdc</b> to try it.' });
      s.el.querySelector('#dn').addEventListener('click', () => { s.close(); onDone(); });
    } catch (e) { s.lock(false); step(last, 'fail', ''); failFoot(s.el, e, last === 'send' ? run : null, s.close); }
  }
}

async function disable(onDone) {
  const s = sheet('<div class="rv"><h2>Turn off pay from X?</h2><p class="hint">DOVI will stop sending payments from your tweets and your allowance is removed. Payments already sent stay waiting, and you can take them back in Activity.</p><div class="rv-actions"><button class="btn block danger-solid" id="go" type="button">Turn off</button><button class="btn block ghost" id="cancel" type="button">Keep it on</button></div></div>', { label: 'Turn off', cls: 'rvback' });
  s.el.querySelector('#cancel').addEventListener('click', s.close);
  s.el.querySelector('#go').addEventListener('click', async () => {
    const net = await api('/api/public/cdp-config').then((c) => (c.testnet ? 'Base Sepolia' : 'Base')).catch(() => 'Base');
    s.set('<div class="rv"><h2>Turning off</h2>' + stepsHtml([['send', 'Approving'], ['confirm', 'Confirming on', true], ['done', 'Turned off']], net) + '<div class="rv-foot" id="rf"></div></div>');
    const step = stepper(s.el); s.lock(true); let last = 'send';
    try {
      const p = await api('/api/autopay/prepare-off', { method: 'POST', body: {} });
      await sendAndConfirm({ txs: p.txs, confirm: () => api('/api/autopay/confirm-off', { method: 'POST', body: {} }), onStep: (i, st, t) => { last = i; step(i, st, t); } });
      s.lock(false); okSheet(s, { title: 'Pay from X is off', body: 'Nothing will be sent from your tweets.' });
      s.el.querySelector('#dn').addEventListener('click', () => { s.close(); onDone(); });
    } catch (e) { s.lock(false); step(last, 'fail', ''); failFoot(s.el, e, null, s.close); }
  });
}
