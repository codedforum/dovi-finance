import { api } from './api.js?v=dev';
import { esc, usd, fmtDateTime } from './format.js?v=dev';
import { $ } from './ui.js?v=dev';

const view = $('#view');
function dur(sec) { if (sec == null) return 'Not enough data yet'; if (sec < 90) return sec + ' seconds'; if (sec < 5400) return Math.round(sec / 60) + ' minutes'; return Math.round(sec / 360) / 10 + ' hours'; }
function tile(label, value, source, cls) { return '<div class="stat ' + cls + '"><small>' + esc(label) + '</small><b>' + esc(value) + '</b><span>' + esc(source) + '</span></div>'; }

async function main() {
  let d;
  try { d = await api('/api/public/stats'); } catch { view.innerHTML = '<div class="card paycard"><div class="pay-gone"><h2>Numbers are not available right now</h2><p>Please try again in a minute.</p></div></div>'; return; }
  const p = d.payments;
  view.innerHTML = '<div class="card paycard"><div class="proof-top"><span class="chip ' + (d.testnet ? 'test' : 'live') + '">' + esc(d.network) + (d.testnet ? ', test network' : '') + '</span><span class="proof-st done">Live</span></div><small class="proof-k">DOVI so far</small><h1 class="live-h">Real counts, with the source under each one</h1>'
    + '<div class="stats" style="grid-template-columns:1fr 1fr">'
    + tile('Payments sent', String(p.sent), 'Payments created on the escrow contract', 't-mint')
    + tile('Total sent', usd(d.payments.totalMicro), 'Sum of those payments, USDC', 't-blue')
    + tile('Claimed', String(p.claimed), 'Claimed on chain by the recipient', 't-gold')
    + tile('Taken back', String(p.returned), 'Returned on chain to the sender, no fee', 't-lilac')
    + tile('Claim rate', d.claimRatePct == null ? 'Too few yet' : d.claimRatePct + '%', 'Claimed out of claimed plus taken back, shown from 3 payments', 't-mint')
    + tile('Handles paid', String(d.handlesPaid), 'DOVI accounts that claimed', 't-blue')
    + tile('Time to claim', dur(d.avgClaimSeconds), 'Average from sent to claimed', 't-gold')
    + tile('Waiting now', String(p.waiting), 'Still held in escrow', 't-lilac')
    + tile('Accounts', String(d.accounts), 'DOVI accounts created', 't-mint')
    + '</div><p class="note">' + (d.testnet ? 'This is the test network, so no real money moved. ' : '') + 'Payment counts come from the escrow contract events and refresh every minute. Updated ' + esc(fmtDateTime(d.generatedAt)) + (d.since ? ', first payment ' + esc(fmtDateTime(d.since)) : '') + '. <a href="https://sepolia.basescan.org/address/0x07e5bE5687b739024f28bf8c85faf1d6E14fDbd4" target="_blank" rel="noopener">Check the escrow contract on Basescan</a>.</p><a class="btn block mint" href="https://dovi.finance/">Pay anyone by handle with DOVI</a></div>';
}
main().catch(() => { view.innerHTML = '<p class="err">Something went wrong.</p>'; });
