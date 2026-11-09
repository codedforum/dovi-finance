import { esc, usd } from './format.js?v=dev';
import { sheet, copy, toast, errorText } from './ui.js?v=dev';
import * as wallet from './wallet.js?v=dev';
import { until } from './api.js?v=dev';
import { particles } from './fx.js?v=dev';

export function backBar(title, sub, help) {
  return '<div class="pghead"><div class="pgtop"><a class="back" href="#home" aria-label="Back to Home">&larr; Home</a>' + (help ? '<a class="back" href="/help#' + esc(help) + '" target="_blank" rel="noopener">How it works</a>' : '') + '</div><h1>' + esc(title) + '</h1>' + (sub ? '<p class="hint">' + esc(sub) + '</p>' : '') + '</div>';
}

export function linesHtml(lines) {
  return '<div class="card"><div class="rows">' + lines.map((l, i) => '<div class="r' + (i === lines.length - 1 ? ' total' : '') + '"><span>' + esc(l.label) + '</span><b>' + esc(l.value) + '</b></div>').join('') + '</div></div>';
}

export function stepsHtml(steps, net) {
  return '<ol class="steps" aria-live="polite">' + steps.map((x) => '<li data-s="' + x[0] + '" class="todo"><span class="si" aria-hidden="true"></span><div><b>' + esc(x[1]) + (x[2] ? ' ' + esc(net || '') : '') + '</b><small></small></div></li>').join('') + '</ol>';
}

export function stepper(el) {
  return (id, state, detail) => { const li = el.querySelector('li[data-s="' + id + '"]'); if (!li) return; li.className = state; const sm = li.querySelector('small'); if (sm) sm.textContent = detail || ''; };
}

/* runs wallet transactions then waits for the app to see them on chain */
export async function sendAndConfirm({ txs, confirm, onStep }) {
  onStep('send', 'active', 'Approve in your wallet. Network fees are covered.');
  await wallet.sendCalls(txs.map((t) => ({ to: t.to, data: t.data })));
  onStep('send', 'done');
  let n = 0; onStep('confirm', 'active', 'Waiting for the network');
  const out = await until(() => { n++; if (n > 1) onStep('confirm', 'active', 'Still confirming, check ' + n); return confirm(); }, { tries: 40, delay: 2000 });
  onStep('confirm', 'done'); onStep('done', 'done');
  return out;
}

export function okSheet(s, { title, body, extra = '', doneLabel = 'Done' }) {
  s.set('<div class="rv ok"><div class="burst" id="bu" aria-hidden="true"></div><div class="okmark" aria-hidden="true"><svg viewBox="0 0 52 52" width="64" height="64"><circle cx="26" cy="26" r="24" fill="none" stroke="currentColor" stroke-width="3" class="oc"/><path d="M15 27l8 8 14-16" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" class="ok"/></svg></div><h2>' + esc(title) + '</h2><p class="hint" style="text-align:center">' + body + '</p>' + extra + '<div class="rv-actions"><button class="btn block mint" id="dn" type="button">' + esc(doneLabel) + '</button></div></div>');
  particles(s.el.querySelector('#bu'), 22);
  const dn = s.el.querySelector('#dn'); if (dn) dn.addEventListener('click', () => s.close());
}

export function failFoot(el, e, retry, closeFn) {
  const rf = el.querySelector('#rf'); if (!rf) return;
  rf.innerHTML = '<p class="err" role="alert">' + esc(errorText(e)) + '</p>' + (retry ? '<button class="btn block mint" id="rt" type="button">Try again</button>' : '') + '<button class="btn block ghost" id="cx" type="button" style="margin-top:8px">Close</button>';
  const rt = rf.querySelector('#rt'); if (rt) rt.addEventListener('click', retry);
  rf.querySelector('#cx').addEventListener('click', closeFn);
}

export { usd, copy, toast, sheet };
