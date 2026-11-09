import { api, until } from './api.js?v=dev';
import * as wallet from './wallet.js?v=dev';
import { signInSheet } from './signin.js?v=dev';
import { esc, usd, inTime, fmtDateTime } from './format.js?v=dev';
import { busy, errorText, $ } from './ui.js?v=dev';
import { avatarHtml, wireAvatars, recipientCard } from './people.js?v=dev';
import { particles, countUp } from './fx.js?v=dev';
import { downloadReceipt } from './receipt.js?v=dev';

const id = (location.pathname.match(/\/claim\/(0x[0-9a-f]{64})/) || location.pathname.match(/\/c\/([2-9a-hj-km-np-zA-HJ-NP-Z]{8})$/) || [])[1];
let fullId = id;
const view = $('#view');

const ART = { ready: 'claim', pending: 'claim', claimed: 'claimed', returned: 'returned', expired: 'expired' };
const SAFE = '<p class="note" style="text-align:center">DOVI never asks for your password or a seed phrase. Payments are held safely until the right person claims them.</p>';

function art(kind) {
  return '<div class="claimhero ' + kind + '"><img src="/brand/dovi-' + ART[kind] + '-20261025-800.webp" srcset="/brand/dovi-' + ART[kind] + '-20261025-480.webp 480w, /brand/dovi-' + ART[kind] + '-20261025-800.webp 800w" sizes="(max-width:560px) 92vw, 520px" alt="" width="800" height="602" decoding="async" fetchpriority="high"><span class="sheen"></span><span class="fxp"></span></div>';
}

function card(inner, kind = 'ready', burst = 0) {
  view.innerHTML = art(kind) + '<div class="card claim-card">' + inner + '</div>' + SAFE;
  particles(view.querySelector('.fxp'), burst || (kind === 'ready' ? 16 : 8));
  wireAvatars(view);
}

const STEPS = [['signin', 'Signed in'], ['wallet', 'Setting up your account'], ['claim', 'Claiming on the network'], ['done', 'Money in your account']];
function stepsHtml() { return '<ol class="steps" aria-live="polite">' + STEPS.map((x) => '<li data-s="' + x[0] + '" class="todo"><span class="si" aria-hidden="true"></span><div><b>' + esc(x[1]) + '</b><small></small></div></li>').join('') + '</ol>'; }
function setStep(id, state, detail) { const li = view.querySelector('li[data-s="' + id + '"]'); if (!li) return; li.className = state; const sm = li.querySelector('small'); if (sm) sm.textContent = detail || ''; }

async function main() {
  if (!id) return card('<h2>Link not valid</h2><p>This payment link is not valid. Ask the sender to send it again.</p>', 'expired');
  let c;
  try { c = await api('/api/claims/' + id); fullId = c.claimId; } catch (e) { return card('<h2>Payment not found</h2><p>' + esc(e.message) + '</p><a class="btn" href="/">Go to DOVI</a>', 'expired'); }
  const amt = usd(c.amountMicro);
  const who = '<div class="from"><span class="fromrow">' + avatarHtml(null, c.from, 'sm') + '<span>' + esc(c.from) + '</span></span></div>';
  if (c.status === 'pending') return card(who + '<div class="amt">' + esc(amt) + '</div><p>is on the way. This payment is not ready yet, check back in a minute.</p>', 'pending');
  if (c.status === 'claimed') return card('<h2>Already claimed</h2><div class="amt">' + esc(amt) + '</div><p>This payment was claimed' + (c.claimedAt ? ' on ' + esc(fmtDateTime(c.claimedAt)) : '') + '. If that was you, open DOVI to see it.</p><a class="btn mint" href="/app">Open DOVI</a>', 'claimed');
  if (c.status === 'returned') return card('<h2>Payment taken back</h2><div class="amt">' + esc(amt) + '</div><p>' + esc(c.from) + ' took this payment back, so it can no longer be claimed.</p><div class="rows facts"><div class="r"><span>Sent by</span><b>' + esc(c.from) + '</b></div><div class="r"><span>Sent</span><b>' + esc(fmtDateTime(c.sentAt)) + '</b></div><div class="r"><span>Taken back</span><b>' + esc(fmtDateTime(c.returnedAt)) + '</b></div></div><a class="btn" href="/">Go to DOVI</a>', 'returned');
  if (c.status === 'expired') return card('<h2>This payment expired</h2><p>It was not claimed in time. The sender can take it back, or send it again.</p>', 'expired');
  const forX = c.kind === 'x';
  card(who + '<div class="sent">sent you</div><div class="amt" id="amt">' + esc(amt) + '</div>' + recipientCard({ profile: c.toProfile, label: c.to, hasAccount: false }, { compact: true }) + '<p class="exp">' + esc(inTime(c.expiry)) + '</p>' + (c.note ? '<p class="cnote">&ldquo;' + esc(c.note) + '&rdquo;</p>' : '') + (c.lockUntil ? '<p class="lockline">Locked for you. The sender cannot take this back before ' + esc(fmtDateTime(c.lockUntil * 1000)) + '.</p>' : '') + (c.awaitingRelease ? '<div class="warn" role="status">' + (c.autoReleaseRule === 'time' && c.autoReleaseAt ? 'This payment opens automatically on ' + esc(fmtDateTime(c.autoReleaseAt * 1000)) + '. It stays safe in escrow for you until then.' : c.autoReleaseRule === 'post' ? 'This payment opens automatically once your post has been up long enough. It stays safe in escrow for you.' : 'The sender approves this payment before you can claim it. Check back soon. It stays safe in escrow for you.') + '</div>' : '') + '<div id="act"><button class="btn block mint lg" id="cl" type="button"' + (c.awaitingRelease ? ' disabled' : '') + '>' + (c.awaitingRelease ? 'Waiting for approval' : 'Claim ' + esc(amt)) + '</button><p class="hint">' + (forX ? 'Sign in as ' + esc(c.to) + ' on X to claim.' : 'Sign in with ' + esc(c.to) + ' to claim.') + '</p></div><div id="m" class="err" role="alert" hidden></div>');
  const msg = $('#m');
  $('#cl').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    if (btn.disabled) return;
    btn.disabled = true;
    msg.hidden = true;
    let at = 'signin';
    try {
      let me = null;
      if ((await api('/api/auth/me')).identity) me = await api('/api/me');
      if (!me) { const ok = await signInSheet({ title: 'Sign in to claim', lead: forX ? 'Use the X account ' + c.to + '.' : 'Use the email ' + c.to + '.', next: location.pathname }); if (!ok) { btn.disabled = false; return; } me = await api('/api/me'); }
      $('#act').innerHTML = stepsHtml();
      setStep('signin', 'done');
      at = 'wallet'; setStep('wallet', 'active', 'No wallet to install');
      await wallet.start();
      const address = await wallet.address();
      await api('/api/me/address', { method: 'POST', body: { address } });
      setStep('wallet', 'done');
      at = 'claim'; setStep('claim', 'active', 'Approve in your account. Network fees are covered.');
      const p = await api('/api/claims/' + fullId + '/prepare-claim', { method: 'POST', body: { address } });
      await wallet.sendCalls([{ to: p.tx.to, data: p.tx.data }]);
      let n = 0;
      setStep('claim', 'active', 'Waiting for the network');
      await until(() => { n++; if (n > 1) setStep('claim', 'active', 'Still confirming, check ' + n); return api('/api/claims/' + fullId + '/claimed', { method: 'POST', body: {} }); }, { tries: 40, delay: 2000 });
      setStep('claim', 'done'); setStep('done', 'done');
      await new Promise((r) => setTimeout(r, 650));
      card('<div class="okmark" aria-hidden="true"><svg viewBox="0 0 52 52" width="64" height="64"><circle cx="26" cy="26" r="24" fill="none" stroke="currentColor" stroke-width="3" class="oc"/><path d="M15 27l8 8 14-16" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" class="op"/></svg></div><h2>You got</h2><div class="amt" id="amt">' + esc(amt) + '</div><p>It is in your new DOVI account. No wallet to install and no seed phrase.</p><a class="btn mint lg" href="/app">Open DOVI</a><button class="btn block ghost" id="rcp" type="button" style="margin-top:10px">Download receipt</button>', 'claimed', 34);
      $('#rcp').addEventListener('click', async (e) => { try { await busy(e.currentTarget, () => downloadReceipt({ amountMicro: c.amountMicro, label: c.from, kind: 'received', when: Date.now(), ref: String(fullId || '').replace(/^0x/, '').slice(0, 8), testnet: /Sepolia|test/i.test((document.getElementById('net') || {}).textContent || '') })); } catch (er) { /* receipt is optional */ } });
      countUp($('#amt'), Number(c.amountMicro), (v) => usd(Math.round(v)), 900);
    } catch (e) {
      const act = $('#act');
      if (act && act.querySelector('.steps')) setStep(at, 'fail', ''); else { btn.disabled = false; }
      msg.hidden = false; msg.textContent = errorText(e);
      if (e && e.code === 'not_recipient' && act && !act.querySelector('.steps')) { act.insertAdjacentHTML('beforeend', '<button class="btn block" id="sw" type="button" style="margin-top:12px">Sign in with another account</button>'); $('#sw').addEventListener('click', async () => { try { await wallet.signOut(); } catch { /* best effort */ } location.reload(); }); }
      if (act && act.querySelector('.steps')) act.insertAdjacentHTML('beforeend', '<button class="btn block mint" id="retry" type="button" style="margin-top:12px">Try again</button>'), $('#retry').addEventListener('click', () => location.reload());
    }
  });
}
main().catch((e) => card('<h2>Something went wrong</h2><p>' + esc(errorText(e)) + '</p>', 'expired'));
