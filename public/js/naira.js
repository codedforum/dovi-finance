import { api } from './api.js?v=dev';
import { esc, usd } from './format.js?v=dev';
import { sheet, busy, copy, errorText, toast } from './ui.js?v=dev';
import { linesHtml, stepsHtml, stepper, sendAndConfirm, okSheet, failFoot } from './flow.js?v=dev';

const NGN = '₦';
const commas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
export function ngn(kobo) { const v = BigInt(kobo); const w = v / 100n; const c = v % 100n; return NGN + commas(w) + (c ? '.' + String(c).padStart(2, '0') : ''); }
const money = (n) => (Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function nairaOptions() {
  try { const o = await api('/api/naira/options'); return o && o.available ? o : null; } catch { return null; }
}

const DONE = ['completed', 'failed', 'expired', 'needs_attention', 'refunded'];
function poll(id, onTick, isClosed, ms = 4000) {
  let stop = false;
  (async () => {
    for (let i = 0; i < 450 && !stop && !isClosed(); i++) {
      try { const o = await api('/api/naira/orders/' + id); onTick(o); if (DONE.includes(o.status)) return; } catch { /* the next round tries again */ }
      await new Promise((r) => setTimeout(r, ms));
    }
  })();
  return () => { stop = true; };
}

const testBanner = '<p class="hint" role="note"><b>Test mode.</b> No real naira moves. The USDC is test USDC on Base Sepolia.</p>';
const attention = '<p class="err" role="alert">This order needs a person to look at it. Your money is safe and the DOVI team has been told. Keep the reference below when you ask for help.</p>';

/* naira in: pay by bank transfer, receive USDC in the DOVI account */
export async function openNairaBuy(session, opts, { onDone = null } = {}) {
  let closed = false; let stopPoll = () => {};
  const s = sheet('<div class="rv"><div class="skeleton" style="height:240px"></div></div>', { label: 'Pay with naira', onClose: () => { closed = true; stopPoll(); } });
  const feeF = 1 - (opts.feeBps || 0) / 10000;
  const preview = (text) => { const n = Number(String(text).replace(/,/g, '')); return n > 0 && opts.rate ? '$' + money((n / opts.rate) * feeF) : null; };

  function form(err = '') {
    s.set('<div class="rv"><h2>Pay with naira</h2>' + (opts.simulated ? testBanner : '') +
      '<p class="hint">Send naira by bank transfer from your own bank account. The USDC lands in your DOVI account.</p>' +
      '<label class="field" for="nga">Amount in naira</label><div class="amount-wrap"><span class="cur" aria-hidden="true">' + NGN + '</span><input class="input" id="nga" inputmode="decimal" autocomplete="off" placeholder="5,000"></div>' +
      '<p class="note" id="ngp" aria-live="polite">Rate ' + (opts.rate ? NGN + money(opts.rate) + ' per $1' : 'not available') + ', fee ' + (opts.feeBps / 100).toFixed(1) + '%. Between ' + esc(ngn(opts.minNgnKobo)) + ' and ' + esc(ngn(opts.maxNgnKobo)) + '.</p>' +
      '<p class="err" id="nge" role="alert"' + (err ? '' : ' hidden') + '>' + esc(err) + '</p>' +
      '<div class="rv-actions"><button class="btn block mint lg" id="ngg" type="button">Continue</button><button class="btn block ghost" id="ngc" type="button">Cancel</button></div></div>');
    const a = s.el.querySelector('#nga'); const p = s.el.querySelector('#ngp');
    a.addEventListener('input', () => { const v = preview(a.value); p.textContent = v ? 'You get about ' + v + ' of USDC after the ' + (opts.feeBps / 100).toFixed(1) + '% fee.' : 'Rate ' + (opts.rate ? NGN + money(opts.rate) + ' per $1' : 'not available') + '.'; });
    s.el.querySelector('#ngc').addEventListener('click', s.close);
    s.el.querySelector('#ngg').addEventListener('click', async (ev) => {
      const e = s.el.querySelector('#nge'); e.hidden = true;
      try { const o = await busy(ev.currentTarget, () => api('/api/naira/buy', { method: 'POST', body: { amountNgn: a.value.trim() } })); pay(o); }
      catch (x) { e.hidden = false; e.textContent = errorText(x); }
    });
  }

  function pay(o) {
    const exp = o.pay.amountExpectedKobo;
    s.set('<div class="rv"><h2>Pay ' + esc(ngn(exp)) + '</h2>' + (o.simulated ? testBanner : '') +
      '<p class="hint">Transfer exactly this amount, from a bank account in your own name, to the account below. It works for this order only.</p>' +
      linesHtml([{ label: 'Bank', value: o.pay.bankName }, { label: 'Account number', value: o.pay.accountNumber }, { label: 'Account name', value: o.pay.accountName }, { label: 'Amount', value: ngn(exp) }, { label: 'You get', value: usd(o.usdcMicro) }]) +
      '<button class="btn block ghost" id="ngk" type="button" style="margin-top:10px">Copy account number</button>' +
      '<ol class="steps" aria-live="polite"><li class="active"><span class="si" aria-hidden="true"></span><div><b id="ngs">Waiting for your payment</b><small id="ngt"></small></div></li></ol>' +
      '<p class="err" id="nge" role="alert" hidden></p>' +
      '<div class="rv-actions">' + (o.simulated && opts.rail === 'sim' ? '<button class="btn block mint lg" id="ngp" type="button">I have paid (test)</button>' : '') + '<button class="btn block ghost" id="ngc" type="button">Close</button></div></div>');
    s.el.querySelector('#ngk').addEventListener('click', () => copy(o.pay.accountNumber).then(() => toast({ title: 'Copied', ms: 1800 })));
    s.el.querySelector('#ngc').addEventListener('click', s.close);
    const note = s.el.querySelector('#ngt');
    note.textContent = opts.simulated && opts.rail === 'kora' ? 'Test mode: the partner sandbox completes the payment by itself in about 2 minutes.' : 'This usually takes a few minutes.';
    const sp = s.el.querySelector('#ngp');
    if (sp) sp.addEventListener('click', async (ev) => { try { const r = await busy(ev.currentTarget, () => api('/api/naira/buy/' + o.id + '/test-paid', { method: 'POST', body: {} })); settle(r); } catch (x) { const e = s.el.querySelector('#nge'); e.hidden = false; e.textContent = errorText(x); } });
    stopPoll = poll(o.id, settle, () => closed);
  }

  function settle(o) {
    if (closed) return;
    if (o.status === 'completed') {
      stopPoll();
      toast({ title: 'Added ' + usd(o.usdcMicro), body: 'It is in your DOVI account.', ms: 4000 });
      okSheet(s, { title: 'Added ' + esc(usd(o.usdcMicro)), body: 'Your naira payment arrived as USDC in your DOVI account.' });
      s.el.querySelector('#dn').addEventListener('click', () => { s.close(); if (onDone) onDone(); });
      if (onDone) onDone();
    } else if (o.status === 'expired' || o.status === 'failed') {
      stopPoll();
      s.set('<div class="rv"><h2>' + (o.status === 'expired' ? 'This order expired' : 'The payment did not go through') + '</h2><p class="hint">' + (o.status === 'expired' ? 'We did not receive the payment in time. If you already sent it, contact support with the reference below.' : 'Nothing was added to your account.') + '</p><p class="note mono">Reference ' + esc(o.id) + '</p><button class="btn block" id="ngc" type="button">Close</button></div>');
      s.el.querySelector('#ngc').addEventListener('click', s.close);
    } else if (o.status === 'needs_attention') {
      stopPoll();
      s.set('<div class="rv"><h2>We are checking this order</h2>' + attention + '<p class="note mono">Reference ' + esc(o.id) + '</p><button class="btn block" id="ngc" type="button">Close</button></div>');
      s.el.querySelector('#ngc').addEventListener('click', s.close);
    } else if (o.status === 'crediting') { const t = s.el.querySelector('#ngs'); if (t) t.textContent = 'Payment received, adding your USDC'; }
  }
  form();
}

/* naira out: send USDC from the DOVI account, receive naira in a bank account */
export async function openNairaSell(session, opts, { onDone = null } = {}) {
  let closed = false; let stopPoll = () => {};
  const s = sheet('<div class="rv"><div class="skeleton" style="height:300px"></div></div>', { label: 'Cash out to naira', onClose: () => { closed = true; stopPoll(); } });
  const feeF = 1 - (opts.feeBps || 0) / 10000;
  const short = (b) => b.bankName + ' ending ' + b.last4;

  function form(err = '', keep = {}) {
    let bankCode = keep.bank || ''; let bankLabel = keep.bankName || ''; let looked = keep.looked || null; let seq = 0;
    s.set('<div class="rv"><h2>Cash out to naira</h2>' + (opts.simulated ? testBanner : '') +
      '<p class="hint">Send USDC from your DOVI account and receive naira in your own bank account.</p>' +
      '<label class="field" for="sla">Amount in USDC</label><div class="amount-wrap"><span class="cur" aria-hidden="true">$</span><input class="input" id="sla" inputmode="decimal" autocomplete="off" placeholder="10.00" value="' + esc(keep.amount || '') + '"></div>' +
      '<p class="note" id="slp" aria-live="polite">Rate ' + (opts.rate ? NGN + money(opts.rate) + ' per $1' : 'not available') + ', fee ' + (opts.feeBps / 100).toFixed(1) + '%.</p>' +
      '<label class="field" for="slq">Bank</label><input class="input" id="slq" type="search" role="combobox" aria-expanded="false" aria-controls="slr" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Search your bank, for example OPay" value="' + esc(bankLabel) + '">' +
      '<ul class="list" id="slr" role="listbox" aria-label="Banks" hidden style="max-height:220px;overflow:auto;margin:6px 0 0;padding:0;list-style:none"></ul>' +
      '<label class="field" for="sln">Account number</label><input class="input mono" id="sln" inputmode="numeric" maxlength="10" autocomplete="off" placeholder="10 digits" value="' + esc(keep.account || '') + '">' +
      '<div id="slnm" aria-live="polite"></div>' +
      '<p class="err" id="sle" role="alert"' + (err ? '' : ' hidden') + '>' + esc(err) + '</p>' +
      '<div class="rv-actions"><button class="btn block mint lg" id="slg" type="button">Review</button><button class="btn block ghost" id="slc" type="button">Cancel</button></div></div>');
    const $ = (id) => s.el.querySelector(id);
    const a = $('#sla'); const p = $('#slp'); const q = $('#slq'); const list = $('#slr'); const acct = $('#sln'); const nm = $('#slnm');
    const upd = () => { const n = Number(a.value); p.textContent = n > 0 && opts.rate ? 'You get about ' + NGN + money(n * opts.rate * feeF) + ' after the ' + (opts.feeBps / 100).toFixed(1) + '% fee.' : 'Rate ' + (opts.rate ? NGN + money(opts.rate) + ' per $1' : 'not available') + '.'; };
    a.addEventListener('input', upd); upd();

    const matches = (text) => { const t = text.toLowerCase().split(/\s+/).filter(Boolean); return opts.banks.filter((b) => t.every((w) => (b.name + ' ' + b.words).toLowerCase().includes(w))).slice(0, 8); };
    const drawList = () => {
      const m = matches(q.value.trim() === bankLabel ? '' : q.value);
      list.innerHTML = m.length ? m.map((b) => '<li role="option"><button type="button" class="item" data-c="' + esc(b.code) + '" style="width:100%;text-align:left;padding:10px 12px">' + esc(b.name) + '</button></li>').join('') : '<li class="note" style="padding:10px 12px">No bank matches. Try another spelling.</li>';
      list.hidden = false; q.setAttribute('aria-expanded', 'true');
    };
    const closeList = () => { list.hidden = true; q.setAttribute('aria-expanded', 'false'); };
    q.addEventListener('focus', () => { q.select(); drawList(); });
    q.addEventListener('input', () => { bankCode = ''; bankLabel = ''; looked = null; showName(); drawList(); });
    list.addEventListener('mousedown', (ev) => ev.preventDefault());
    list.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-c]'); if (!b) return;
      bankCode = b.dataset.c; bankLabel = (opts.banks.find((x) => x.code === bankCode) || {}).name || ''; q.value = bankLabel; closeList(); lookup(); acct.focus();
    });
    q.addEventListener('blur', () => setTimeout(closeList, 120));

    function showName() {
      if (!looked) { nm.innerHTML = ''; return; }
      if (looked.state === 'wait') nm.innerHTML = '<p class="note">Looking up the account name…</p>';
      else if (looked.state === 'found') nm.innerHTML = '<div class="card" style="margin-top:10px"><div class="note" style="margin:0">Account name</div><b>' + esc(looked.name) + '</b> <span class="status" style="margin-left:6px">Verified</span></div>';
      else nm.innerHTML = '<label class="field" for="slm">Account name</label><input class="input" id="slm" autocomplete="off" placeholder="As your bank shows it" value="' + esc(looked.typed || '') + '"><p class="note">' + (looked.down ? 'The name lookup is not available right now. Enter the name exactly as your bank shows it.' : (opts.simulated ? 'Test mode can only look up a few sandbox accounts. Enter the name as your bank shows it.' : 'We could not find that account. Check the bank and number, or enter the name as your bank shows it.')) + '</p>';
    }
    async function lookup() {
      const num = acct.value.trim();
      if (!bankCode || !/^\d{10}$/.test(num)) { looked = null; showName(); return; }
      const my = ++seq; looked = { state: 'wait' }; showName();
      try {
        const r = await api('/api/naira/resolve', { method: 'POST', body: { bankCode, accountNumber: num } });
        if (my !== seq || closed) return;
        looked = r.found ? { state: 'found', name: r.accountName } : { state: 'manual', down: r.lookupDown };
      } catch (e) { if (my !== seq || closed) return; looked = { state: 'manual', down: true }; }
      showName();
    }
    acct.addEventListener('input', () => { acct.value = acct.value.replace(/\D/g, '').slice(0, 10); looked = null; seq++; showName(); if (acct.value.length === 10) lookup(); });
    if (bankCode && /^\d{10}$/.test(acct.value)) lookup();

    $('#slc').addEventListener('click', s.close);
    $('#slg').addEventListener('click', async (ev) => {
      const e = $('#sle'); e.hidden = true;
      const manual = s.el.querySelector('#slm');
      const input = { amount: a.value.trim(), bank: bankCode, bankName: bankLabel, account: acct.value.trim(), name: looked && looked.state === 'found' ? looked.name : (manual ? manual.value.trim() : ''), looked: looked && looked.state === 'found' ? looked : (manual ? { state: 'manual', typed: manual.value.trim(), down: looked && looked.down } : null) };
      if (!bankCode) { e.hidden = false; e.textContent = 'Choose your bank from the list.'; return; }
      try { const r = await busy(ev.currentTarget, () => api('/api/naira/sell/prepare', { method: 'POST', body: { amount: input.amount, bank: { bankCode: input.bank, accountNumber: input.account, accountName: input.name } } })); review(r, input); }
      catch (x) { e.hidden = false; e.textContent = errorText(x); }
    });
  }

  function review(p, input) {
    s.set('<div class="rv"><h2>Review cash out</h2>' + (p.simulated ? testBanner : '') + linesHtml(p.preview.lines) + '<p class="note">' + esc(p.preview.note) + '</p><div class="rv-actions"><button class="btn block mint lg" id="slo" type="button">Cash out ' + esc(usd(p.usdcMicro)) + '</button><button class="btn block ghost" id="slx" type="button">Back</button></div></div>');
    s.el.querySelector('#slx').addEventListener('click', () => form('', { amount: input.amount, bank: input.bank, bankName: input.bankName, account: input.account, looked: input.looked }));
    s.el.querySelector('#slo').addEventListener('click', run);
    async function run() {
      s.set('<div class="rv"><h2>Cashing out</h2>' + stepsHtml([['send', 'Approving and sending'], ['confirm', 'Confirming on', true], ['pay', 'Sending naira to your bank'], ['done', 'Naira sent']], 'Base') + '<div class="rv-foot" id="rf">Keep this window open.</div></div>');
      const step = stepper(s.el); s.lock(true);
      let last = 'send';
      try {
        let o = await sendAndConfirm({ txs: [p.tx], confirm: () => api('/api/naira/sell/' + p.orderId + '/confirm', { method: 'POST', body: {} }), onStep: (i, st, t) => { last = i; if (i !== 'done') step(i, st, t); } });
        last = 'pay'; step('pay', 'active', 'Your USDC arrived. The naira payout is on its way.');
        s.lock(false);
        stopPoll = poll(p.orderId, (x) => {
          if (closed) return;
          if (x.status === 'completed') { stopPoll(); step('pay', 'done'); step('done', 'done'); finish(x); }
          else if (x.status === 'refunded') { stopPoll(); s.set('<div class="rv"><h2>The payout could not be made</h2><p class="hint">' + esc(usd(x.usdcMicro)) + ' is back in your DOVI account. Nothing was lost.</p><button class="btn block" id="slc" type="button">Close</button></div>'); s.el.querySelector('#slc').addEventListener('click', s.close); if (onDone) onDone(); }
          else if (x.status === 'needs_attention') { stopPoll(); s.set('<div class="rv"><h2>We are checking your payout</h2>' + attention + '<p class="note mono">Reference ' + esc(x.id) + '</p><button class="btn block" id="slc" type="button">Close</button></div>'); s.el.querySelector('#slc').addEventListener('click', s.close); }
        }, () => closed, 3000);
        if (o && o.status === 'completed') finish(o);
      } catch (e) { s.lock(false); step(last, 'fail', ''); failFoot(s.el, e, last === 'send' ? run : null, s.close); }
    }
    function finish(x) {
      okSheet(s, { title: 'Naira sent', body: esc(ngn(x.ngnKobo)) + ' is on its way to ' + esc(short(x.bank)) + '.' + (x.simulated ? ' This was a test, so no real naira moved.' : '') });
      s.el.querySelector('#dn').addEventListener('click', s.close);
      if (onDone) onDone();
    }
  }
  form();
}
