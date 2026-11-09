import { api } from './api.js?v=dev';
import { esc, usd, validAmount } from './format.js?v=dev';
import { sheet, busy, errorText, toast } from './ui.js?v=dev';
import { nairaOptions, openNairaBuy } from './naira.js?v=dev';

const PRESETS = ['10', '25', '50'];
const SUPPORT = { coinbase: 'https://help.coinbase.com/', transak: 'https://support.transak.com/', faucet: 'https://faucet.circle.com/' };
const TICK = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function roundUpCents(micro) { const c = (BigInt(micro) + 9999n) / 10000n; return (c / 100n) + '.' + String(c % 100n).padStart(2, '0'); }
function microOf(text) { const [w, f = ''] = String(text).split('.'); return BigInt(w || '0') * 1000000n + BigInt((f + '000000').slice(0, 6)); }
function region() { try { return /-NG$/i.test(navigator.language || '') || /Lagos/.test(Intl.DateTimeFormat().resolvedOptions().timeZone || '') ? 'NG' : 'OTHER'; } catch { return 'OTHER'; } }

async function balanceOf(session) { return BigInt((await api('/api/wallet/balance?address=' + encodeURIComponent(session.address))).micro); }

export async function openAddMoney(session, { needMicro = null, onDone = null } = {}) {
  const cfg = await api('/api/public/cdp-config').catch(() => ({}));
  const testnet = !!cfg.testnet;
  let ids = [];
  if (!testnet) { const p = await api('/api/onramp/providers').catch(() => ({ providers: [] })); ids = (p.providers || []).map((x) => (typeof x === 'string' ? x : x.id)); }
  const provider = testnet ? 'faucet' : (region() === 'NG' && ids.includes('transak') ? 'transak' : 'coinbase');
  const nopt = await nairaOptions();
  const before = await balanceOf(session).catch(() => 0n);
  const missing = needMicro != null && BigInt(needMicro) > before ? BigInt(needMicro) - before : null;
  const first = missing ? roundUpCents(missing) : null;
  let amount = first || '25';
  let timer = null; let closed = false;
  const s = sheet('<div class="rv"><div class="skeleton" style="height:260px"></div></div>', { label: 'Add money', onClose: () => { closed = true; clearInterval(timer); } });

  const chips = () => (first && !PRESETS.includes(first) ? [first] : []).concat(PRESETS).map((c) => '<button type="button" class="chip pc" data-v="' + c + '" aria-pressed="' + (c === amount) + '">$' + c + '</button>').join('');
  const provName = provider === 'faucet' ? 'the test faucet' : provider === 'transak' ? 'Transak' : 'Coinbase';
  function form() {
    const title = missing ? 'Add $' + first + ' to continue' : (testnet ? 'Get test USDC' : 'Add money');
    const lead = testnet
      ? 'This is a test network, so this gives test USDC and no real money moves. The faucet adds 10 test USDC at a time.'
      : (provider === 'transak' ? 'Pay in naira with a Nigerian bank or card through Transak. Availability and limits depend on your country.' : 'Pay by card or Apple Pay through Coinbase. Availability and limits depend on your country.');
    const summary = testnet ? 'You get 10 test USDC from the faucet.' : 'You pay about $' + esc(amount) + ' and get about ' + esc(amount) + ' USDC. ' + esc(provName) + ' shows the exact fee before you pay.';
    s.set('<div class="rv am"><h2>' + esc(title) + '</h2><p class="hint">' + esc(lead) + '</p>' + (missing ? '<div class="am-need"><span>Your balance</span><b>' + esc(usd(before.toString())) + '</b><span>You need</span><b>' + esc(usd(String(BigInt(needMicro)))) + '</b></div>' : '') + (testnet ? '' : '<div class="am-chips" id="ac">' + chips() + '</div><div class="amount-wrap"><span class="cur" aria-hidden="true">$</span><input class="input" id="aa" inputmode="decimal" autocomplete="off" value="' + esc(amount) + '" aria-label="Amount in USD"></div>') + '<p class="note" id="as">' + summary + '</p><div id="am-err" class="err" role="alert" hidden></div><button class="btn block mint" id="ago" type="button" style="margin-top:12px">' + (missing ? 'Add $' + esc(first) + (onDone ? ' and continue' : '') : (testnet ? 'Get 10 test USDC' : 'Continue to ' + esc(provName))) + '</button>' + (nopt ? '<button class="btn block" id="ang" type="button" style="margin-top:8px">Pay with naira' + (nopt.simulated ? ' (test)' : '') + '</button>' : '') + '<button class="btn block ghost" id="acl" type="button" style="margin-top:8px">Cancel</button></div>');
    s.el.querySelector('#acl').addEventListener('click', s.close);
    const ng = s.el.querySelector('#ang');
    if (ng) ng.addEventListener('click', () => { s.close(); openNairaBuy(session, nopt, { onDone }); });
    const aa = s.el.querySelector('#aa');
    if (aa) {
      const sync = () => { amount = aa.value.trim(); s.el.querySelectorAll('.pc').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === amount))); const as = s.el.querySelector('#as'); if (as && validAmount(amount)) as.textContent = 'You pay about $' + amount + ' and get about ' + amount + ' USDC. ' + provName + ' shows the exact fee before you pay.'; };
      aa.addEventListener('input', sync);
      s.el.querySelectorAll('.pc').forEach((b) => b.addEventListener('click', () => { aa.value = b.dataset.v; sync(); }));
    }
    s.el.querySelector('#ago').addEventListener('click', go);
  }

  async function go(ev) {
    const err = s.el.querySelector('#am-err'); err.hidden = true;
    if (!testnet && !validAmount(amount)) { err.hidden = false; err.textContent = 'Enter an amount like 25 or 25.50.'; return; }
    try {
      if (testnet) await busy(ev.currentTarget, () => api('/api/faucet/usdc', { method: 'POST', body: { address: session.address } }));
      else { const r = await busy(ev.currentTarget, () => api('/api/onramp/url', { method: 'POST', body: { address: session.address, amount, provider } })); window.open(r.url, '_blank', 'noopener'); }
    } catch (e) { err.hidden = false; err.textContent = errorText(e); return; }
    watch();
  }

  function watch() {
    const t0 = Date.now(); const limitMs = 15 * 60 * 1000;
    const stepsHtml = (st) => '<ol class="steps" aria-live="polite">' + [['wait', testnet ? 'Requesting test USDC' : 'Waiting for your payment'], ['way', 'Funds on the way'], ['done', 'Added to your account']].map((x, i) => '<li class="' + (i < st ? 'done' : i === st ? 'active' : 'todo') + '"><span class="si" aria-hidden="true"></span><div><b>' + x[1] + '</b></div></li>').join('') + '</ol>';
    const draw = (st, extra = '') => s.set('<div class="rv am"><h2>' + (testnet ? 'Adding test USDC' : 'Adding money') + '</h2>' + stepsHtml(st) + '<p class="note">' + (testnet ? 'It usually arrives in a few seconds.' : 'Finish the payment in the window we opened. Your balance updates here by itself.') + '</p>' + extra + '<button class="btn block ghost" id="acl" type="button" style="margin-top:10px">Close</button></div>');
    draw(testnet ? 1 : 0);
    s.el.querySelector('#acl').addEventListener('click', s.close);
    clearInterval(timer);
    timer = setInterval(async () => {
      if (closed) return clearInterval(timer);
      let now;
      try { now = await balanceOf(session); } catch { return; }
      if (now > before) {
        clearInterval(timer);
        const added = now - before;
        try { await api('/api/topup/confirmed', { method: 'POST', body: { address: session.address, before: before.toString(), after: now.toString(), provider } }); } catch { /* the activity entry is best effort */ }
        toast({ title: 'Added ' + usd(added.toString()), body: 'It is in your DOVI account.', ms: 4000 });
        s.set('<div class="rv am ok"><div class="okmark" aria-hidden="true" style="color:var(--green-d)">' + TICK + '</div><h2>Added ' + esc(usd(added.toString())) + '</h2><p class="rv-sub">Your balance is now ' + esc(usd(now.toString())) + '.</p><button class="btn block mint" id="adn" type="button">' + (onDone && missing ? 'Continue' : 'Done') + '</button></div>');
        const fin = () => { s.close(); if (onDone) onDone(); };
        s.el.querySelector('#adn').addEventListener('click', fin);
        if (onDone && missing) setTimeout(() => { if (!closed) fin(); }, 1400);
        return;
      }
      if (Date.now() - t0 > 5000 && !testnet) draw(1);
      if (Date.now() - t0 > limitMs) {
        clearInterval(timer);
        draw(1, '<div class="warn">We have not seen the money arrive after 15 minutes. Check that the payment went through with ' + esc(provName) + ', then press Check again. If it did, it can take longer for a bank.</div><a class="btn block ghost" style="margin-top:10px" target="_blank" rel="noopener" href="' + esc(SUPPORT[provider]) + '">Contact ' + esc(provName) + ' support</a><button class="btn block mint" id="ack" type="button" style="margin-top:10px">Check again</button>');
        const ck = s.el.querySelector('#ack'); if (ck) ck.addEventListener('click', watch);
      }
    }, testnet ? 3000 : 5000);
  }
  form();
}
