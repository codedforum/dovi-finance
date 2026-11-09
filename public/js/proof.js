import { api } from './api.js?v=dev';
import { esc, usd, fmtDateTime } from './format.js?v=dev';
import { $ } from './ui.js?v=dev';

const view = $('#view');
const code = (location.pathname.match(/^\/r\/([2-9a-hj-km-np-zA-HJ-NP-Z]{12})$/) || [])[1];
const STATUS = { funded: ['Waiting to be claimed', 'wait'], claimed: ['Claimed', 'done'], returned: ['Taken back by the sender', 'back'] };

function gone() {
  view.innerHTML = '<div class="card paycard"><div class="pay-gone"><span aria-hidden="true">?</span><h2>This receipt is not available</h2><p>The link may have been turned off by the person who shared it.</p><a class="btn block" href="/">Go to DOVI</a></div></div>';
}

function txRow(label, hash, base) {
  if (!hash) return '';
  const short = hash.slice(0, 8) + '...' + hash.slice(-6);
  return '<div class="r"><span>' + esc(label) + '</span>' + (base ? '<a href="' + esc(base + hash) + '" target="_blank" rel="noopener"><b>' + esc(short) + '</b></a>' : '<b>' + esc(short) + '</b>') + '</div>';
}

async function main() {
  if (!code) return gone();
  let r;
  try { r = await api('/api/receipt/' + code); } catch { return gone(); }
  const st = STATUS[r.status] || [r.status, 'wait'];
  const title = r.role === 'sender' ? 'Payment sent' : 'Payment received';
  const when = r.claimedAt || r.returnedAt || r.sentAt;
  view.innerHTML = '<div class="card paycard proof"><div class="proof-top"><span class="chip ' + (r.testnet ? 'test' : 'live') + '">' + esc(r.network) + (r.testnet ? ', test network' : '') + '</span><span class="proof-st ' + esc(st[1]) + '">' + esc(st[0]) + '</span></div>'
    + '<small class="proof-k">' + esc(title) + '</small><div class="proof-amt">' + esc(usd(r.amountMicro)) + '</div><div class="proof-ft">USDC</div>'
    + '<div class="card"><div class="rows"><div class="r"><span>From</span><b>' + esc(r.from || 'Sender') + '</b></div><div class="r"><span>To</span><b>' + esc(r.to) + '</b></div>' + (when ? '<div class="r"><span>Date</span><b>' + esc(fmtDateTime(when)) + '</b></div>' : '') + (r.feeMicro && r.feeMicro !== '0' ? '<div class="r"><span>DOVI fee</span><b>' + esc(usd(r.feeMicro)) + '</b></div>' : '') + (r.note ? '<div class="r"><span>Note</span><b>' + esc(r.note) + '</b></div>' : '') + '</div></div>'
    + (r.txs && (r.txs.send || r.txs.claim || r.txs.reclaim) ? '<h3 class="mini">On the chain</h3><div class="card"><div class="rows">' + txRow('Payment sent', r.txs.send, r.explorerTx) + txRow('Claimed', r.txs.claim, r.explorerTx) + txRow('Taken back', r.txs.reclaim, r.explorerTx) + '</div></div>' : '')
    + '<p class="note" style="text-align:center">This receipt was shared by one of the people in the payment. Anyone can check the transactions on the block explorer.</p><a class="btn block mint" href="https://dovi.finance/">Pay anyone by handle with DOVI</a></div>';
}
main().catch(() => gone());
