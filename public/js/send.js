import { api, idem, until } from './api.js?v=dev';
import * as wallet from './wallet.js?v=dev';
import { esc, usd, validAmount } from './format.js?v=dev';
import { busy, copy, errorText, toast, sheet } from './ui.js?v=dev';
import { recipientCard, wireAvatars, avatarHtml } from './people.js?v=dev';
import { particles } from './fx.js?v=dev';
import { downloadReceipt } from './receipt.js?v=dev';
import { openAddMoney, roundUpCents } from './addmoney.js?v=dev';
import { mountSendPicker } from './tokens.js?v=dev';

export function microToDecimal(micro) {
  const m = BigInt(micro); const w = m / 1000000n; const f = String(m % 1000000n).padStart(6, '0').replace(/0+$/, '');
  return f ? w + '.' + f : String(w);
}

export async function review({ to, amount, note, paylink, lockHours, payOnDelivery, autoRelease }, session) {
  const address = session.address;
  const protectedSend = !!(lockHours || payOnDelivery || autoRelease);
  const prep = protectedSend ? { mode: 'claim' } : await api('/api/send/prepare', { method: 'POST', body: { to, amount, address, paylink } });
  if (prep.mode === 'direct') return { mode: 'direct', prep, to, amount, paylink };
  const draft = await api('/api/claims/draft', { method: 'POST', body: { to, amount, note, address, paylink, lockHours, payOnDelivery, autoRelease, idempotencyKey: idem() } });
  return { mode: 'claim', draft, to, amount, paylink };
}

export async function approve(r, session, onStep = () => {}) {
  if (r.mode === 'direct') {
    onStep('prep', 'done');
    onStep('send', 'active', 'Approve in your wallet. Network fees are covered.');
    await wallet.sendCalls([{ to: r.prep.tx.to, data: r.prep.tx.data }]);
    onStep('send', 'done');
    let n = 0;
    onStep('confirm', 'active', 'Waiting for the network');
    await until(() => { n++; if (n > 1) onStep('confirm', 'active', 'Still confirming, check ' + n); return api('/api/send/confirmed', { method: 'POST', body: { address: session.address, to: r.prep.to, amount: microToDecimal(r.prep.amountMicro), label: r.prep.target.label, paylink: r.paylink } }); }, { tries: 40, delay: 2000 });
    onStep('confirm', 'done'); onStep('done', 'done');
    return { mode: 'direct', label: r.prep.target.label, amountMicro: r.prep.amountMicro };
  }
  onStep('prep', 'done');
  onStep('send', 'active', 'Approve in your wallet. Network fees are covered.');
  await wallet.sendCalls(r.draft.txs.map((t) => ({ to: t.to, data: t.data })));
  onStep('send', 'done');
  let n = 0;
  onStep('confirm', 'active', 'Waiting for the network');
  const v = await until(() => { n++; if (n > 1) onStep('confirm', 'active', 'Still confirming, check ' + n); return api('/api/claims/' + r.draft.claimId + '/funded', { method: 'POST', body: {} }); }, { tries: 40, delay: 2000 });
  onStep('confirm', 'done'); onStep('done', 'done');
  return { mode: 'claim', link: r.draft.link, label: r.draft.to, amountMicro: r.draft.amountMicro, claimId: v.claimId, lockUntil: r.draft.lockUntil || null, needsRelease: !!r.draft.needsRelease };
}

export function previewHtml(r) {
  const lines = (r.mode === 'direct' ? r.prep.preview.lines : r.draft.preview.lines);
  const note = r.mode === 'direct' ? r.prep.preview.note : r.draft.preview.note;
  const to = r.mode === 'direct' ? r.prep.target.label : r.draft.to;
  return '<div class="card"><div class="rows"><div class="r"><span>To</span><b>' + esc(to) + '</b></div>' + lines.map((l, i) => '<div class="r' + (i === lines.length - 1 ? ' total' : '') + '"><span>' + esc(l.label) + '</span><b>' + esc(l.value) + '</b></div>').join('') + '</div><p class="note">' + esc(note) + '</p></div>';
}

export function successHtml(res) {
  if (res.mode === 'direct') return '<div class="success"><div class="tick" aria-hidden="true">✓</div><h2>Sent</h2><p>' + esc(usd(res.amountMicro)) + ' is on its way to ' + esc(res.label) + '.</p></div>';
  const text = 'I sent you ' + usd(res.amountMicro) + ' on DOVI. Claim it with one login: ' + res.link;
  return '<div class="success"><div class="tick" aria-hidden="true">✓</div><h2>Ready to claim</h2><p>' + esc(usd(res.amountMicro)) + ' is waiting for ' + esc(res.label) + '. Send them this link.</p><div class="linkbox"><span id="lk">' + esc(res.link) + '</span><button class="btn sm" id="cp" type="button">Copy</button></div><a class="btn block mint" target="_blank" rel="noopener" href="https://twitter.com/intent/tweet?text=' + encodeURIComponent(text) + '">Share on X</a>' + (res.needsRelease ? '<p class="note">Pay on delivery: they can claim only after you approve. Approve it from Activity when you are ready.</p>' : '') + (res.lockUntil ? '<p class="note">Locked for them until ' + esc(new Date(res.lockUntil * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })) + '. You cannot take it back before then.</p>' : '') + '<p class="note">If they do not claim it in time, you can take it back from Activity once any lock ends. No fee is charged then.</p></div>';
}

const STEPS = [['prep', 'Payment prepared'], ['send', 'Approving and sending'], ['confirm', 'Confirming on'], ['done', 'Claim link ready']];

function amountBig(amountMicro) {
  const t = usd(amountMicro);
  const [w, f] = t.replace('$', '').split('.');
  return '<div class="rv-amt" aria-label="' + esc(t) + '"><span class="cur">$</span><span class="w">' + esc(w) + '</span><span class="f">.' + esc(f || '00') + '</span></div>';
}

async function openReview({ to, amount, note, paylink, lockHours, payOnDelivery, autoRelease }, session, root, onDone, redraw) {
  const net = await api('/api/public/cdp-config').then((c) => (c.testnet ? 'Base Sepolia' : 'Base')).catch(() => 'Base');
  const s = sheet('<div class="rv"><h2>Review payment</h2><div class="rcard"><span class="pfp lg"><span class="ph skeleton"></span></span><div class="rc-b"><div class="skeleton" style="height:18px;width:60%"></div><div class="skeleton" style="height:14px;width:40%;margin-top:8px"></div></div></div><div class="skeleton" style="height:70px;margin-top:16px"></div></div>', { label: 'Review payment', cls: 'rvback' });
  let r; let prof;
  try {
    [r, prof] = await Promise.all([review({ to, amount, note, paylink, lockHours, payOnDelivery, autoRelease }, session), api('/api/recipient/preview', { method: 'POST', body: { to } }).catch(() => null)]);
  } catch (e) { s.set('<div class="rv"><h2>We could not prepare that</h2><p class="err" role="alert">' + esc(errorText(e)) + '</p><button class="btn block" id="cl" type="button" style="margin-top:14px">Close</button></div>'); s.el.querySelector('#cl').addEventListener('click', s.close); return; }
  const label = r.mode === 'direct' ? r.prep.target.label : r.draft.to;
  const person = { profile: prof && prof.profile, label, hasAccount: r.mode === 'direct' || !!(prof && prof.hasAccount) };
  const amountMicro = r.mode === 'direct' ? r.prep.amountMicro : r.draft.amountMicro;
  const lines = r.mode === 'direct' ? r.prep.preview.lines : r.draft.preview.lines;
  const extra = r.mode === 'claim' ? [r.draft.lockUntil ? { label: 'Locked until', value: new Date(r.draft.lockUntil * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) } : null, r.draft.needsRelease ? { label: 'Claims open', value: r.draft.releaseAt ? new Date(r.draft.releaseAt * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'After you approve' } : null].filter(Boolean) : [];
  const viewLines = lines.slice(0, -1).concat(extra, lines.slice(-1));
  const noteText = r.mode === 'direct' ? r.prep.preview.note : r.draft.preview.note;
  const view = () => {
    s.set('<div class="rv">' + '<h2>Review and send</h2>' + recipientCard(person) + amountBig(amountMicro) + '<div class="rv-sub">They receive' + (note ? ', with your note' : '') + '</div>' + (note ? '<div class="rv-note">&ldquo;' + esc(note) + '&rdquo;</div>' : '') + '<div class="card rv-rows"><div class="rows">' + viewLines.map((l, i) => '<div class="r' + (i === viewLines.length - 1 ? ' total' : '') + '"><span>' + esc(l.label) + '</span><b>' + esc(l.value) + '</b></div>').join('') + '</div></div><p class="note">' + esc(noteText) + '</p><div class="rv-actions"><button class="btn block mint lg" id="go" type="button">Approve and send</button><button class="btn block ghost" id="cancel" type="button">Cancel</button></div></div>');
    wireAvatars(s.el);
    s.el.querySelector('#cancel').addEventListener('click', s.close);
    s.el.querySelector('#go').addEventListener('click', run);
    checkFunds();
  };
  const microOf = (t) => { const [w, f = ''] = String(t).replace(/[$,\s]/g, '').split('.'); return BigInt(w || '0') * 1000000n + BigInt((f + '000000').slice(0, 6)); };
  async function checkFunds() {
    try {
      const need = microOf(lines[lines.length - 1].value);
      const bal = BigInt((await api('/api/wallet/balance?address=' + encodeURIComponent(session.address))).micro);
      if (bal >= need) return;
      const go = s.el.querySelector('#go'); if (!go) return;
      const fresh = go.cloneNode(true); fresh.textContent = 'Add $' + roundUpCents(need - bal) + ' and send'; go.replaceWith(fresh);
      fresh.insertAdjacentHTML('beforebegin', '<p class="warn" role="status">Your balance is ' + esc(usd(bal.toString())) + ' and this payment needs ' + esc(usd(need.toString())) + '.</p>');
      fresh.addEventListener('click', () => openAddMoney(session, { needMicro: need.toString(), onDone: () => run() }));
    } catch { /* balance unavailable, the normal approve button stays */ }
  }
  const progress = () => {
    s.set('<div class="rv"><h2>Sending</h2>' + recipientCard(person, { compact: true }) + amountBig(amountMicro) + '<ol class="steps" aria-live="polite">' + STEPS.map((x, i) => '<li data-s="' + x[0] + '" class="todo"><span class="si" aria-hidden="true"></span><div><b>' + esc(x[1]) + (x[0] === 'confirm' ? ' ' + esc(net) : '') + '</b><small></small></div></li>').join('') + '</ol><div class="rv-foot" id="rf">Keep this window open. It usually takes under a minute.</div></div>');
    wireAvatars(s.el);
  };
  const setStep = (id, state, detail) => {
    const li = s.el.querySelector('li[data-s="' + id + '"]'); if (!li) return;
    li.className = state; const sm = li.querySelector('small'); if (sm) sm.textContent = detail || '';
  };
  let failedAt = null;
  async function run() {
    progress(); s.lock(true); failedAt = null;
    let last = 'prep';
    const track = (id, st, d) => { last = id; setStep(id, st, d); };
    try {
      const res = await approve(r, session, track);
      s.lock(false); success(res);
    } catch (e) {
      s.lock(false); failedAt = last; setStep(last, 'fail', '');
      const rf = s.el.querySelector('#rf'); const safeRetry = last === 'send' || last === 'prep';
      rf.innerHTML = '<p class="err" role="alert">' + esc(errorText(e)) + '</p>' + (safeRetry ? '<button class="btn block mint" id="retry" type="button">Try again</button>' : '<p class="note">If your wallet already approved this, it may still arrive. Check Activity in a minute before trying again.</p>') + '<button class="btn block ghost" id="cl" type="button" style="margin-top:10px">Close</button>';
      const rt = rf.querySelector('#retry'); if (rt) rt.addEventListener('click', run);
      rf.querySelector('#cl').addEventListener('click', s.close);
    }
  }
  function success(res) {
    const text = 'I sent you ' + usd(res.amountMicro) + ' on DOVI. Claim it with one login: ' + res.link;
    s.set('<div class="rv ok"><div class="burst" id="bu" aria-hidden="true"></div><div class="okmark" aria-hidden="true"><svg viewBox="0 0 52 52" width="64" height="64"><circle cx="26" cy="26" r="24" fill="none" stroke="currentColor" stroke-width="3" class="oc"/><path d="M15 27l8 8 14-16" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" class="op"/></svg></div>' + (res.mode === 'direct' ? '<h2>Sent</h2><p class="rv-sub">' + esc(usd(res.amountMicro)) + ' is on its way to ' + esc(res.label) + '.</p>' : '<h2>Ready to claim</h2><p class="rv-sub">' + esc(usd(res.amountMicro)) + ' is waiting for ' + esc(res.label) + '. Send them this link.</p><div class="linkbox"><span id="lk">' + esc(res.link) + '</span><button class="btn sm" id="cp" type="button">Copy</button></div><div class="rv-actions"><a class="btn block mint" target="_blank" rel="noopener" href="https://twitter.com/intent/tweet?text=' + encodeURIComponent(text) + '">Share on X</a><button class="btn block ghost" id="cm" type="button">Copy message</button></div>' + (res.needsRelease ? '<p class="note">Pay on delivery: they can claim only after you approve. Approve it from Activity when you are ready.</p>' : '') + (res.lockUntil ? '<p class="note">Locked for them until ' + esc(new Date(res.lockUntil * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })) + '. You cannot take it back before then.</p>' : '') + '<p class="note">If they do not claim it in time, you can take it back from Activity once any lock ends. No fee is charged then.</p>') + '<button class="btn block ghost" id="rcp" type="button" style="margin-top:10px">Download receipt</button><button class="btn block ghost" id="done" type="button" style="margin-top:10px">Done</button></div>');
    const rcp = s.el.querySelector('#rcp'); if (rcp) rcp.addEventListener('click', async (e) => { try { await busy(e.currentTarget, () => downloadReceipt({ amountMicro: res.amountMicro, label: res.label, kind: 'sent', note, feeMicro: res.mode === 'direct' ? '0' : null, when: Date.now(), ref: res.claimId ? String(res.claimId).slice(2, 10) : '', testnet: net.indexOf('Sepolia') >= 0 })); } catch (er) { toast({ title: 'Could not make the receipt', body: errorText(er), tone: 'bad', icon: '!' }); } });
    particles(s.el.querySelector('#bu'), 22);
    const cp = s.el.querySelector('#cp'); if (cp) cp.addEventListener('click', async () => { if (await copy(res.link)) toast({ title: 'Link copied', ms: 2000 }); });
    const cm = s.el.querySelector('#cm'); if (cm) cm.addEventListener('click', async () => { if (await copy(text)) toast({ title: 'Message copied', ms: 2000 }); });
    s.el.querySelector('#done').addEventListener('click', s.close);
    if (onDone) onDone();
    redraw();
  }
  view();
}

export function renderSend(root, session, { onDone } = {}) {
  root.innerHTML = '<h2 class="sec">Send dollars</h2><form class="card sendform" id="sf" novalidate><label class="field" for="to" style="margin-top:0">To</label><input class="input" id="to" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="@handle or email"><div class="recent" id="rc" hidden></div><div id="rp" class="rp" aria-live="polite"></div><p class="hint">They do not need a wallet. They sign in and claim it.</p><label class="field" for="am">Amount in USD</label><div class="amount-chips" id="chips">' + ['1', '5', '10', '20'].map((c) => '<button type="button" class="chip pc" data-v="' + c + '">$' + c + '</button>').join('') + '</div><div class="amount-wrap"><span class="cur" aria-hidden="true">$</span><input class="input" id="am" inputmode="decimal" autocomplete="off" placeholder="5.00"></div><label class="field" for="nt">Note (optional)</label><input class="input" id="nt" maxlength="140" placeholder="For lunch"><div id="msg" class="err" role="alert" hidden></div><button class="btn block mint" type="submit" style="margin-top:16px">Review</button></form>';
  mountSendPicker(root, session);
  const form = root.querySelector('#sf'); const msg = root.querySelector('#msg'); const rp = root.querySelector('#rp'); const toEl = form.querySelector('#to');
  api('/api/public/cdp-config').then((c) => {
    if (!c.lockEnabled) return;
    const btn = form.querySelector('button[type=submit]'); if (!btn) return;
    btn.insertAdjacentHTML('beforebegin', '<details class="protect" id="sprot"><summary>Protect this payment</summary><label class="field" for="sk">Lock the money for them</label><select class="input" id="sk"><option value="">No lock</option><option value="24">1 day</option><option value="72">3 days</option><option value="168">7 days</option></select><p class="hint">You cannot take it back before the lock ends.</p><label class="field" for="srl">When can they claim?</label><select class="input" id="srl"><option value="now">Right away</option><option value="approve">After I approve</option><option value="time">Automatically at a time</option></select><div id="srx"></div></details>');
  }).catch(() => {});
  const fail = (e) => { msg.hidden = false; msg.textContent = errorText(e); };
  let seq = 0; let timer = null;
  toEl.addEventListener('input', () => {
    clearTimeout(timer); rp.innerHTML = ''; const v = toEl.value.trim();
    if (!(/^@?[A-Za-z0-9_]{1,15}$/.test(v) || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v))) return;
    const my = ++seq;
    timer = setTimeout(async () => {
      rp.innerHTML = '<div class="rcard compact"><span class="pfp sm"><span class="ph skeleton"></span></span><div class="rc-b"><div class="skeleton" style="height:14px;width:50%"></div></div></div>';
      try { const p = await api('/api/recipient/preview', { method: 'POST', body: { to: v } }); if (my !== seq) return; rp.innerHTML = recipientCard({ profile: p.profile, label: p.label, hasAccount: p.hasAccount }, { compact: true }); wireAvatars(rp); }
      catch (e) { if (my !== seq) return; rp.innerHTML = '<p class="hint" style="color:var(--red)">' + esc(errorText(e)) + '</p>'; }
    }, 650);
  });
  let paylink = null;
  form.querySelectorAll('.pc').forEach((b) => b.addEventListener('click', () => { form.querySelector('#am').value = b.dataset.v; form.querySelectorAll('.pc').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); }));
  form.addEventListener('change', (ev) => {
    const srl = ev.target.closest('#srl'); if (!srl) return;
    const pad = (n) => String(n).padStart(2, '0'); const local = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    form.querySelector('#srx').innerHTML = srl.value === 'time' ? '<label class="field" for="sat">Release at</label><input class="input" type="datetime-local" id="sat" value="' + local(new Date(Date.now() + 3600000)) + '" min="' + local(new Date(Date.now() + 20 * 60000)) + '" max="' + local(new Date(Date.now() + 6 * 86400000)) + '"><p class="hint">Held in escrow until then. You can approve earlier or stop the schedule.</p>' : '';
  });
  form.addEventListener('submit', (ev) => {
    ev.preventDefault(); msg.hidden = true;
    const to = toEl.value.trim(); const amount = form.querySelector('#am').value.trim(); const note = form.querySelector('#nt').value.trim();
    if (!to) return fail(new Error('Enter an X handle or an email.'));
    if (!validAmount(amount)) return fail(new Error('Enter an amount like 5 or 5.50.'));
    const lk = form.querySelector('#sk'); const mode = (form.querySelector('#srl') || {}).value || 'now';
    let autoRelease;
    if (mode === 'time') { const v = (form.querySelector('#sat') || {}).value; const at = v ? Math.floor(new Date(v).getTime() / 1000) : 0; if (!at || at < Math.floor(Date.now() / 1000) + 600) return fail(new Error('Pick a release time at least 10 minutes from now.')); autoRelease = { mode: 'time', at }; }
    openReview({ to, amount, note, paylink, lockHours: lk && lk.value ? Number(lk.value) : undefined, payOnDelivery: mode === 'approve' ? true : undefined, autoRelease }, session, root, onDone, () => { form.reset(); rp.innerHTML = ''; paylink = null; });
  });
  api('/api/recipients/recent').then((r) => {
    const box = root.querySelector('#rc'); if (!box || !r.recent.length) return;
    box.hidden = false; box.innerHTML = '<small>Recent</small>' + r.recent.map((x) => '<button type="button" class="chip pr" data-l="' + esc(x.label) + '">' + esc(x.label) + '</button>').join('');
    box.querySelectorAll('.pr').forEach((b) => b.addEventListener('click', () => { toEl.value = b.dataset.l; toEl.dispatchEvent(new Event('input')); form.querySelector('#am').focus(); }));
  }).catch(() => {});
  let pre = null;
  try { pre = JSON.parse(sessionStorage.getItem('dovi.pay') || 'null'); sessionStorage.removeItem('dovi.pay'); } catch { pre = null; }
  if (pre && pre.to && validAmount(pre.amount)) {
    toEl.value = pre.to; form.querySelector('#am').value = pre.amount; form.querySelector('#nt').value = pre.note || ''; paylink = pre.paylink || null;
    toEl.dispatchEvent(new Event('input'));
    toast({ title: 'Opened from a link', body: 'Check who you are paying and the amount before you approve.', icon: '!', ms: 9000 });
    setTimeout(() => form.requestSubmit(), 50);
  }
}
