import { api, until } from './api.js?v=dev';
import { esc } from './format.js?v=dev';
import * as wallet from './wallet.js?v=dev';
import { sheet, busy, errorText } from './ui.js?v=dev';
import { linesHtml, stepsHtml, stepper, okSheet, failFoot } from './flow.js?v=dev';

const NET = 'Base Sepolia';
const friendly = (e) => (/estimate gas|execution reverted|useroperation reverted/i.test(String(e && e.message)) ? new Error('The swap could not be prepared. The price may have moved, or you may not have enough. Try again with a smaller amount.') : e);

export async function swapOptions() { try { const o = await api('/api/swap/options'); return o && o.enabled ? o : null; } catch { return null; } }

export function openSwap(session, opts, onDone) {
  const symbols = opts.symbols; let from = symbols[0]; let to = symbols[1]; let timer = null; let seq = 0;
  const s = sheet('', { label: 'Swap' });
  const sel = (id, cur) => '<select class="input" id="' + id + '">' + symbols.map((x) => '<option value="' + esc(x) + '"' + (x === cur ? ' selected' : '') + '>' + esc(x) + '</option>').join('') + '</select>';
  function form(err = '') {
    s.set('<div class="rv"><h2>Swap</h2><p class="hint" role="note"><b>Test pool.</b> ' + esc(opts.priceText || '') + '. Test tokens only, on ' + NET + '. A 0.3 percent fee stays in the pool.</p>' +
      '<label class="field" for="swf" style="margin-top:0">You pay</label>' + sel('swf', from) +
      '<label class="field" for="swa">Amount</label><input class="input" id="swa" inputmode="decimal" autocomplete="off" placeholder="0">' +
      '<label class="field" for="swt">You get</label>' + sel('swt', to) +
      '<div id="swq" aria-live="polite" style="min-height:48px"></div>' + (err ? '<p class="err" role="alert">' + esc(err) + '</p>' : '') +
      '<button class="btn block mint" id="swg" type="button" disabled>Review swap</button></div>');
    const f = s.el.querySelector('#swf'); const t = s.el.querySelector('#swt'); const a = s.el.querySelector('#swa'); const g = s.el.querySelector('#swg'); const q = s.el.querySelector('#swq');
    const other = (v) => symbols.find((x) => x !== v);
    f.addEventListener('change', () => { from = f.value; to = other(from); t.value = to; refresh(); });
    t.addEventListener('change', () => { to = t.value; from = other(to); f.value = from; refresh(); });
    a.addEventListener('input', () => { clearTimeout(timer); g.disabled = true; timer = setTimeout(refresh, 350); });
    g.addEventListener('click', () => review(g, a.value));
    async function refresh() {
      const my = ++seq; const v = a.value.trim();
      if (!v || !/^\d+(\.\d{1,6})?$/.test(v) || Number(v) === 0) { q.textContent = ''; g.disabled = true; return; }
      try { const r = await api('/api/swap/quote', { method: 'POST', body: { from, to, amount: v } }); if (my !== seq) return; const imp = Number(r.impactPct); const cls = imp >= 5 ? 'bad' : imp >= 1 ? 'warn' : 'ok'; q.innerHTML = '<div class="swq"><div class="swq-main"><small>You get about</small><b>' + esc(r.out) + '</b></div><div class="swq-rows"><div><span>At least</span><b>' + esc(r.minOut) + '</b></div><div><span>Price impact</span><b class="imp ' + cls + '">' + esc(r.impactPct) + '%</b></div><div><span>Fee</span><b>0.3%</b></div></div><p class="swq-note">If the price moves below the minimum, the swap is cancelled.</p></div>'; g.disabled = false; }
      catch (e) { if (my !== seq) return; q.innerHTML = '<span class="err">' + esc(errorText(e)) + '</span>'; g.disabled = true; }
    }
  }
  async function review(btn, amount) {
    try {
      const p = await busy(btn, () => api('/api/swap/prepare', { method: 'POST', body: { from, to, amount, address: session.address } }));
      s.set('<div class="rv"><h2>Review swap</h2>' + linesHtml([{ label: 'You pay', value: p.amountIn }, { label: 'You get about', value: p.out }, { label: 'At least', value: p.minOut }, { label: 'Fee', value: '0.3 percent, kept in the pool' }]) + '<div class="rv-foot" id="rf"><button class="btn block mint" id="go" type="button">Swap</button><button class="btn block ghost" id="cx" type="button" style="margin-top:8px">Cancel</button></div></div>');
      s.el.querySelector('#cx').addEventListener('click', s.close);
      s.el.querySelector('#go').addEventListener('click', () => run(p));
    } catch (e) { form(errorText(e)); }
  }
  async function run(p) {
    s.set('<div class="rv"><h2>Swapping</h2>' + stepsHtml([['send', 'Approving and swapping'], ['confirm', 'Confirming on', true], ['done', 'Done']], NET) + '<div class="rv-foot" id="rf">Keep this window open.</div></div>');
    const step = stepper(s.el); s.lock(true); let last = 'send';
    try {
      step('send', 'active', 'Approve in your wallet. Network fees are covered.');
      await wallet.sendCalls(p.txs.map((x) => ({ to: x.to, data: x.data })));
      step('send', 'done'); step('confirm', 'active', 'Waiting for the network'); last = 'confirm';
      await until(() => api('/api/swap/confirmed', { method: 'POST', body: { from: p.fromSymbol, to: p.toSymbol, amount: p.amountText, address: session.address } }), { tries: 40, delay: 2000 });
      step('confirm', 'done'); step('done', 'done'); s.lock(false);
      okSheet(s, { title: 'Swapped', body: esc(p.amountIn) + ' for about ' + esc(p.out) + '.' });
      if (onDone) onDone();
    } catch (e) { s.lock(false); step(last, 'fail', ''); failFoot(s.el, friendly(e), last === 'send' ? () => run(p) : null, s.close); }
  }
  form();
}
