import { downloadReceipt } from './receipt.js?v=dev';
import { api, until } from './api.js?v=dev';
import * as wallet from './wallet.js?v=dev';
import { esc, usd, timeAgo, inTime, fmtDateTime } from './format.js?v=dev';
import { busy, copy, errorText, toast, sheet } from './ui.js?v=dev';
import { recipientCard, wireAvatars } from './people.js?v=dev';
import { particles } from './fx.js?v=dev';

const STATUS = { funded: 'Waiting to be claimed', expired: 'Expired', claimed: 'Claimed', returned: 'Taken back', draft: 'Not sent' };
const KIND = {
  claim_funded: ['↗', 'Sent to', false], claim_sent: ['✓', 'Claimed by', false], claim_expired: ['⏱', 'Expired, sent to', false],
  swap: ['⇄', 'Swapped', false], token_sent: ['↗', 'Sent to', false], token_received: ['↙', 'Received', true], token_returned: ['↩', 'Taken back from', true],
  claim_returned: ['↩', 'Taken back from', true], claim_received: ['↙', 'Received', true], send: ['↗', 'Sent to', false], receive: ['↙', 'Received', true], topup: ['↧', 'Added via', true], withdraw: ['⇥', 'Withdrew to', false],
};

let notifHandler = null;
export async function reclaim(claimId, onStep = () => {}) {
  onStep('prep', 'active', 'Preparing your refund');
  const p = await api('/api/claims/' + claimId + '/prepare-reclaim', { method: 'POST', body: {} });
  onStep('prep', 'done');
  onStep('send', 'active', 'Approve in your wallet. Network fees are covered.');
  await wallet.sendCalls([{ to: p.tx.to, data: p.tx.data }]);
  onStep('send', 'done');
  let n = 0;
  onStep('confirm', 'active', 'Waiting for the network');
  const v = await until(() => { n++; if (n > 1) onStep('confirm', 'active', 'Still confirming, check ' + n); return api('/api/claims/' + claimId + '/reclaimed', { method: 'POST', body: {} }); }, { tries: 40, delay: 2000 });
  onStep('confirm', 'done'); onStep('done', 'done');
  return v;
}

function claimRow(c) {
  const open = ['funded', 'expired'].includes(c.status);
  const locked = !!(c.lockUntil && Date.now() < c.lockUntil * 1000);
  const needsOk = !!(c.needsRelease && !c.releasedAt && c.status === 'funded');
  return '<div class="item tap" role="button" tabindex="0" data-claim="' + esc(c.claimId) + '"><div class="ico" aria-hidden="true">✉</div><div class="mid"><div class="t">To ' + esc(c.to) + '</div><div class="d"><span class="status ' + esc(c.status) + '">' + esc(STATUS[c.status] || c.status) + '</span> ' + (c.status === 'funded' ? esc(inTime(c.expiry)) : '') + '</div><div class="d">Sent ' + esc(fmtDateTime(c.fundedAt || c.createdAt)) + '</div>' + (locked ? '<div class="d"><span class="chip sm">Locked until ' + esc(fmtDateTime(c.lockUntil * 1000)) + '</span></div>' : '') + (needsOk ? '<div class="d"><span class="chip sm">' + (c.releaseRule === 'time' ? 'Releases automatically ' + esc(fmtDateTime(c.releaseAt * 1000)) : c.releaseRule === 'post' ? 'Releases when their post is ' + esc(c.postHours) + ' hours old' : 'Waiting for your approval') + '</span></div>' : '') + (open ? '<div class="row-acts">' + (needsOk ? '<button class="btn sm mint" data-release="' + esc(c.claimId) + '" type="button">Approve now</button>' + (c.releaseRule ? '<button class="btn sm ghost" data-autostop="' + esc(c.claimId) + '" type="button">Stop auto</button>' : '') : '') + '<button class="btn sm ghost" data-copy="' + esc(c.link) + '" type="button">Copy link</button>' + (locked ? '' : '<button class="btn sm danger" data-reclaim="' + esc(c.claimId) + '" type="button">Take it back</button>') + '</div>' : '') + '</div><div class="amt">' + esc(usd(c.amountMicro)) + '</div></div>';
}

function histRow(x) {
  const k = KIND[x.kind] || ['•', x.kind, false];
  const inb = k[2];
  const neutral = ['claim_sent', 'claim_expired', 'swap'].includes(x.kind);
  const who = x.counterparty ? ' ' + esc(x.counterparty) : '';
  const tail = x.kind === 'claim_returned' ? ', you got it back in full' : '';
  return '<div class="item tap" role="button" tabindex="0" data-act="' + esc(x.id) + '" data-ref="' + esc(x.ref || '') + '" data-kind="' + esc(x.kind) + '"><div class="ico' + (inb ? ' in' : '') + '" aria-hidden="true">' + esc(k[0]) + '</div><div class="mid"><div class="t">' + esc(k[1]) + who + '</div><div class="d">' + esc(fmtDateTime(x.createdAt)) + ', ' + esc(timeAgo(x.createdAt)) + esc(tail) + '</div></div><div class="amt' + (inb ? ' pos' : '') + '">' + (x.amountText ? esc(x.amountText) : (neutral ? '' : inb ? '+' : '-') + esc(usd(x.amountMicro).replace('-', ''))) + '</div></div>';
}

const STEPS = [['prep', 'Refund prepared'], ['send', 'Sending your refund'], ['confirm', 'Confirming on the network'], ['done', 'Money back in your account']];

export async function confirmTakeBack(claim, { onDone } = {}) {
  const prof = claim.kind === 'x' ? await api('/api/recipient/preview', { method: 'POST', body: { to: claim.to } }).catch(() => null) : null;
  const person = { profile: prof && prof.profile, label: claim.to, hasAccount: !!(prof && prof.hasAccount) };
  const s = sheet('<div class="rv"></div>', { label: 'Take this payment back', cls: 'rvback' });
  const body = () => s.el.querySelector('.rv');
  const ask = () => {
    body().innerHTML = '<h2>Take it back?</h2>' + recipientCard(person, { compact: true }) + '<div class="rv-amt" aria-label="' + esc(usd(claim.amountMicro)) + '"><span class="cur">$</span><span class="w">' + esc(usd(claim.amountMicro).replace('$', '').split('.')[0]) + '</span><span class="f">.' + esc(usd(claim.amountMicro).split('.')[1] || '00') + '</span></div><div class="card rv-rows"><div class="rows"><div class="r"><span>Sent</span><b>' + esc(fmtDateTime(claim.fundedAt || claim.createdAt)) + '</b></div><div class="r"><span>You get back</span><b>' + esc(usd(claim.amountMicro)) + '</b></div><div class="r"><span>DOVI fee</span><b>$0.00, none charged</b></div></div></div><p class="note">The link stops working right away. If they already opened it, they will see that the payment was taken back.</p><div class="rv-actions"><button class="btn block danger-solid lg" id="yes" type="button">Take it back</button><button class="btn block ghost" id="no" type="button">Keep waiting</button></div>';
    wireAvatars(body());
    body().querySelector('#no').addEventListener('click', s.close);
    body().querySelector('#yes').addEventListener('click', run);
  };
  const setStep = (id, state, detail) => { const li = body().querySelector('li[data-s="' + id + '"]'); if (!li) return; li.className = state; const sm = li.querySelector('small'); if (sm) sm.textContent = detail || ''; };
  async function run() {
    body().innerHTML = '<h2>Taking it back</h2>' + recipientCard(person, { compact: true }) + '<ol class="steps" aria-live="polite">' + STEPS.map((x) => '<li data-s="' + x[0] + '" class="todo"><span class="si" aria-hidden="true"></span><div><b>' + esc(x[1]) + '</b><small></small></div></li>').join('') + '</ol><div class="rv-foot" id="rf">Keep this window open.</div>';
    wireAvatars(body()); s.lock(true);
    let last = 'prep';
    try {
      const v = await reclaim(claim.claimId, (id, st, d) => { last = id; setStep(id, st, d); });
      s.lock(false);
      const when = fmtDateTime((v && v.returnedAt) || Date.now());
      body().className = 'rv ok';
      body().innerHTML = '<div class="burst" id="bu" aria-hidden="true"></div><div class="okmark" aria-hidden="true"><svg viewBox="0 0 52 52" width="64" height="64"><circle cx="26" cy="26" r="24" fill="none" stroke="currentColor" stroke-width="3" class="oc"/><path d="M15 27l8 8 14-16" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" class="op"/></svg></div><h2>Taken back</h2><p class="rv-sub">' + esc(usd(claim.amountMicro)) + ' is back in your account. No fee was charged.</p><div class="card rv-rows"><div class="rows"><div class="r"><span>Sent to</span><b>' + esc(claim.to) + '</b></div><div class="r"><span>Sent</span><b>' + esc(fmtDateTime(claim.fundedAt || claim.createdAt)) + '</b></div><div class="r"><span>Taken back</span><b>' + esc(when) + '</b></div><div class="r"><span>Taken back by</span><b>You</b></div></div></div><button class="btn block ghost" id="done" type="button" style="margin-top:14px">Done</button>';
      particles(body().querySelector('#bu'), 18);
      body().querySelector('#done').addEventListener('click', s.close);
      if (onDone) onDone();
    } catch (e) {
      s.lock(false); setStep(last, 'fail', '');
      const safe = last === 'prep' || last === 'send';
      const rf = body().querySelector('#rf');
      rf.innerHTML = '<p class="err" role="alert">' + esc(errorText(e)) + '</p>' + (safe ? '<button class="btn block mint" id="retry" type="button">Try again</button>' : '<p class="note">If your wallet already approved this, the refund may still arrive. Check Activity in a minute.</p>') + '<button class="btn block ghost" id="cl" type="button" style="margin-top:10px">Close</button>';
      const rt = rf.querySelector('#retry'); if (rt) rt.addEventListener('click', run);
      rf.querySelector('#cl').addEventListener('click', s.close);
    }
  }
  ask();
}

function timeline(d) {
  const ev = [{ t: d.fundedAt || d.createdAt, h: 'Sent', s: (d.role === 'sender' ? 'You sent ' + usd(d.amountMicro) + ' to ' + d.to : usd(d.amountMicro) + ' was sent to you'), tone: 'ok' }];
  if (d.status === 'claimed') ev.push({ t: d.claimedAt, h: 'Claimed', s: (d.role === 'sender' ? d.to + ' claimed it. DOVI fee ' + usd(d.chargedFeeMicro || 0) : 'You claimed it.'), tone: 'ok' });
  else if (d.status === 'returned') ev.push({ t: d.returnedAt, h: 'Taken back', s: (d.role === 'sender' ? 'You' : 'The sender') + ' took it back. ' + usd(d.amountMicro) + ' returned in full, no fee', tone: 'ret' });
  else if (d.status === 'expired') ev.push({ t: d.expiredAt || d.expiry * 1000, h: 'Expired', s: 'Not claimed in time. You can still take it back.', tone: 'ret' });
  else ev.push({ t: null, h: 'Waiting', s: 'Not claimed yet, ' + inTime(d.expiry), tone: 'wait' });
  return '<ol class="tl">' + ev.map((e) => '<li class="' + e.tone + '"><span class="dot" aria-hidden="true"></span><div><b>' + esc(e.h) + '</b>' + (e.t ? '<time>' + esc(fmtDateTime(e.t)) + '</time>' : '') + '<small>' + esc(e.s) + '</small></div></li>').join('') + '</ol>';
}

export async function openDetail(claimId, { reload = () => {} } = {}) {
  const s = sheet('<div class="rv"><div class="skeleton" style="height:240px"></div></div>', { label: 'Payment details', cls: 'rvback' });
  let d;
  try { d = await api('/api/claims/' + claimId + '/detail'); } catch (e) { s.set('<div class="rv"><h2>Not available</h2><p class="err">' + esc(errorText(e)) + '</p><button class="btn block" id="c" type="button">Close</button></div>'); s.el.querySelector('#c').addEventListener('click', s.close); return; }
  const prof = d.kind === 'x' ? await api('/api/recipient/preview', { method: 'POST', body: { to: d.to } }).catch(() => null) : null;
  const person = { profile: prof && prof.profile, label: d.to, hasAccount: !!(prof && prof.hasAccount) };
  const tx = (h, label) => (h ? '<div class="r"><span>' + esc(label) + '</span>' + (d.explorerTx ? '<a href="' + esc(d.explorerTx + h) + '" target="_blank" rel="noopener"><b>' + esc(h.slice(0, 8) + '…' + h.slice(-6)) + '</b></a>' : '<b>' + esc(h.slice(0, 8) + '…' + h.slice(-6)) + '</b>') + '</div>' : '');
  const open = ['funded', 'expired'].includes(d.status) && d.role === 'sender';
  const paid = d.status === 'claimed' && d.role === 'sender' ? BigInt(d.amountMicro) + BigInt(d.chargedFeeMicro || 0) : BigInt(d.amountMicro);
  s.set('<div class="rv"><div class="dh"><h2>Payment</h2><span class="status ' + esc(d.status) + '">' + esc(STATUS[d.status] || d.status) + '</span></div>' + recipientCard(person, { compact: true }) + '<div class="rv-amt" aria-label="' + esc(usd(d.amountMicro)) + '"><span class="cur">$</span><span class="w">' + esc(usd(d.amountMicro).replace('$', '').split('.')[0]) + '</span><span class="f">.' + esc(usd(d.amountMicro).split('.')[1] || '00') + '</span></div>' + (d.note ? '<div class="rv-note">&ldquo;' + esc(d.note) + '&rdquo;</div>' : '') + timeline(d) + '<div class="card rv-rows"><div class="rows"><div class="r"><span>Amount</span><b>' + esc(usd(d.amountMicro)) + '</b></div><div class="r"><span>DOVI fee</span><b>' + (d.status === 'claimed' ? esc(usd(d.chargedFeeMicro)) : '$0.00, not charged') + '</b></div><div class="r total"><span>' + (d.status === 'returned' ? 'You got back' : d.status === 'claimed' ? (d.role === 'sender' ? 'You paid' : 'You received') : 'Held for you') + '</span><b>' + esc(usd(d.status === 'returned' ? d.amountMicro : paid.toString())) + '</b></div>' + tx(d.txs.send, 'Send transaction') + tx(d.txs.claim, 'Claim transaction') + tx(d.txs.reclaim, 'Take back transaction') + '</div></div>' + (open ? '<div class="rv-actions">' + (d.link ? '<button class="btn block ghost" id="cp" type="button">Copy link</button>' : '') + '<button class="btn block danger-solid" id="tb" type="button">Take it back</button></div>' : '') + '<button class="btn block ghost" id="c" type="button" style="margin-top:10px">Close</button></div>');
  wireAvatars(s.el);
  const lockedNow = !!(d.lockUntil && Date.now() < d.lockUntil * 1000);
  const needsOk = !!(d.role === 'sender' && d.needsRelease && !d.releasedAt && d.status === 'funded');
  if (d.lockUntil || needsOk) {
    const anchor = s.el.querySelector('#tb') || s.el.querySelector('#c');
    anchor.insertAdjacentHTML('beforebegin', (d.lockUntil ? '<p class="note">' + (lockedNow ? 'Locked for them until ' : 'Was locked for them until ') + esc(fmtDateTime(d.lockUntil * 1000)) + '.' + (lockedNow && d.role === 'sender' ? ' You cannot take it back before then.' : '') + '</p>' : '') + (needsOk ? '<button class="btn block mint" id="rel" type="button" style="margin-bottom:10px">Approve so they can claim</button>' : ''));
    const rel = s.el.querySelector('#rel');
    if (rel) rel.addEventListener('click', async () => { try { await busy(rel, () => api('/api/claims/' + claimId + '/release', { method: 'POST', body: {} })); toast({ title: 'Approved', body: 'They can claim it now.', ms: 3000 }); s.close(); reload(); } catch (er) { toast({ title: 'Could not approve', body: errorText(er), tone: 'bad', icon: '!' }); } });
  }
  if (lockedNow && d.role === 'sender') { const tbb = s.el.querySelector('#tb'); if (tbb) tbb.remove(); }
  if (['funded', 'claimed', 'returned'].includes(d.status)) {
    s.el.querySelector('#c').insertAdjacentHTML('beforebegin', '<button class="btn block ghost" id="rcp" type="button" style="margin-bottom:10px">Download receipt</button>');
    s.el.querySelector('#rcp').addEventListener('click', async (e) => {
      try { await busy(e.currentTarget, () => downloadReceipt({ amountMicro: d.amountMicro, label: d.role === 'sender' ? d.to : (d.from || 'Sender'), kind: d.role === 'sender' ? (d.status === 'returned' ? 'returned' : 'sent') : 'received', feeMicro: d.status === 'claimed' && d.role === 'sender' ? d.chargedFeeMicro : null, when: d.claimedAt || d.createdAt || Date.now(), ref: String(claimId).replace(/^0x/, '').slice(0, 8), testnet: /Sepolia|test/i.test((document.getElementById('net') || {}).textContent || '') })); } catch (er) { toast({ title: 'Could not make the receipt', body: errorText(er), tone: 'bad', icon: '!' }); }
    });
  }
  if (['funded', 'claimed', 'returned'].includes(d.status)) {
    const slot = s.el.querySelector('#c');
    slot.insertAdjacentHTML('beforebegin', '<button class="btn block ghost" id="pfl" type="button" style="margin-bottom:10px">Share proof link</button>');
    const pfl = s.el.querySelector('#pfl'); let have = null;
    api('/api/claims/' + claimId + '/receipt').then((r) => { have = r.receipt; if (have) pfl.textContent = 'Stop sharing proof link'; }).catch(() => {});
    pfl.addEventListener('click', async () => {
      try {
        if (have) { await busy(pfl, () => api('/api/receipts/' + have.code + '/revoke', { method: 'POST', body: {} })); have = null; pfl.textContent = 'Share proof link'; toast({ title: 'Proof link turned off', ms: 2500 }); return; }
        const r = await busy(pfl, () => api('/api/receipts', { method: 'POST', body: { claimId } }));
        if (!r) return;
        have = { code: r.code, url: r.url }; pfl.textContent = 'Stop sharing proof link';
        const ok = await copy(r.url); toast({ title: ok ? 'Proof link copied' : 'Proof link ready', body: 'Anyone with it can see this payment. You can turn it off here.', ms: 5000 });
      } catch (er) { toast({ title: 'Could not share', body: errorText(er), tone: 'bad', icon: '!' }); }
    });
  }
  s.el.querySelector('#c').addEventListener('click', s.close);
  const cp = s.el.querySelector('#cp'); if (cp) cp.addEventListener('click', async () => { if (await copy(d.link)) toast({ title: 'Link copied', ms: 2000 }); });
  const tb = s.el.querySelector('#tb'); if (tb) tb.addEventListener('click', () => { s.close(); confirmTakeBack(d, { onDone: reload }); });
}

const GROUPS = [['', 'All'], ['sent', 'Sent'], ['received', 'Received'], ['returned', 'Returned'], ['swaps', 'Swaps'], ['added', 'Added'], ['withdrawn', 'Withdrawn']];
const RANGES = [['', 'All time'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days']];

export async function renderActivity(root) {
  root.innerHTML = '<h2 class="sec">Waiting to be claimed</h2><div class="list" id="cl"><div class="skeleton" style="height:70px"></div></div><div class="hist-head"><h2 class="sec" style="margin:0">History</h2><span class="hist-links"><a class="btn sm ghost" href="#statements">Statements</a><a class="btn sm ghost" id="csv" href="/api/activity/export" download>Export CSV</a></span></div><div class="afilter"><div class="asearch"><input class="input" id="aq" type="search" placeholder="Search a name, handle or email" autocomplete="off" aria-label="Search history"></div><div class="agroups" id="ag">' + GROUPS.map((g, i) => '<button type="button" class="chip" data-g="' + g[0] + '" aria-pressed="' + (i === 0) + '">' + g[1] + '</button>').join('') + '</div><select class="input arange" id="ar" aria-label="Date range">' + RANGES.map((r) => '<option value="' + r[0] + '">' + r[1] + '</option>').join('') + '</select></div><div class="list" id="al"><div class="skeleton" style="height:60px"></div><div class="skeleton" style="height:60px"></div></div><button class="btn block ghost" id="more" type="button" hidden style="margin-top:10px">Load more</button>';
  const cl = root.querySelector('#cl'); const al = root.querySelector('#al'); const more = root.querySelector('#more');
  let claims = []; let hist = []; let group = ''; let range = ''; let q = ''; let timer = null; let seq = 0;
  const params = (extra = {}) => { const p = new URLSearchParams(); if (q) p.set('q', q); if (group) p.set('group', group); if (range) p.set('since', String(Date.now() - Number(range) * 86400000)); Object.entries(extra).forEach(([k, v]) => p.set(k, String(v))); return p; };
  const csvLink = () => { const a = root.querySelector('#csv'); if (a) a.href = '/api/activity/export?' + params().toString(); };
  const filtered = () => !!(q || group || range);
  function drawHist(hasMore) {
    if (!al.isConnected) return;
    al.innerHTML = hist.length ? hist.map(histRow).join('') : (filtered() ? '<div class="empty"><div class="big" aria-hidden="true">🔎</div><h3>Nothing matches</h3><p>Try a different name or clear the filters.</p></div>' : '<div class="empty"><div class="big" aria-hidden="true">🕘</div><h3>No activity yet</h3><p>Send your first dollars to see them here.</p></div>');
    if (more) more.hidden = !hasMore;
  }
  async function loadHist(append = false) {
    const my = ++seq;
    try {
      const last = append && hist.length ? hist[hist.length - 1].id : null;
      const a = await api('/api/activity?' + params({ limit: 50, ...(last ? { before: last } : {}) }).toString());
      if (my !== seq) return;
      hist = append ? hist.concat(a.activity) : a.activity;
      drawHist(a.activity.length === 50);
    } catch (e) { if (my === seq) al.innerHTML = '<p class="err">' + esc(errorText(e)) + '</p>'; }
    csvLink();
  }
  async function load() {
    if (!root.isConnected) return;
    try {
      const c = await api('/api/claims');
      claims = c.claims;
      const waiting = c.claims.filter((x) => ['funded', 'expired'].includes(x.status));
      cl.innerHTML = waiting.length ? waiting.map(claimRow).join('') : '<div class="empty"><div class="big" aria-hidden="true">✉</div><h3>Nothing waiting</h3><p>Payments you send to someone new show up here until they claim them.</p></div>';
    } catch (e) { cl.innerHTML = '<p class="err">' + esc(errorText(e)) + '</p>'; }
    await loadHist(false);
  }
  root.querySelector('#aq').addEventListener('input', (ev) => { clearTimeout(timer); timer = setTimeout(() => { q = ev.target.value.trim(); loadHist(false); }, 350); });
  root.querySelector('#ag').addEventListener('click', (ev) => { const b = ev.target.closest('[data-g]'); if (!b) return; group = b.dataset.g; root.querySelectorAll('#ag .chip').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); loadHist(false); });
  root.querySelector('#ar').addEventListener('change', (ev) => { range = ev.target.value; loadHist(false); });
  more.addEventListener('click', () => loadHist(true));
  const act = (ev) => {
    const cp = ev.target.closest('[data-copy]'); if (cp) { copy(cp.dataset.copy).then((ok) => { if (ok) toast({ title: 'Link copied', ms: 2000 }); }); return; }
    const rl = ev.target.closest('[data-release]');
    if (rl) { busy(rl, () => api('/api/claims/' + rl.dataset.release + '/release', { method: 'POST', body: {} })).then(() => { toast({ title: 'Approved', body: 'They can claim it now.', ms: 3000 }); load(); }).catch((e) => toast({ title: 'Could not approve', body: errorText(e), tone: 'bad', icon: '!' })); return; }
    const st = ev.target.closest('[data-autostop]');
    if (st) { busy(st, () => api('/api/claims/' + st.dataset.autostop + '/auto-cancel', { method: 'POST', body: {} })).then(() => { toast({ title: 'Automatic release stopped', body: 'You approve this one yourself now.', ms: 3000 }); load(); }).catch((e) => toast({ title: 'Could not stop it', body: errorText(e), tone: 'bad', icon: '!' })); return; }
    const rc = ev.target.closest('[data-reclaim]');
    if (rc) { const c = claims.find((x) => x.claimId === rc.dataset.reclaim); if (c) confirmTakeBack(c, { onDone: load }); return; }
    const row = ev.target.closest('[data-claim],[data-act]'); if (!row) return;
    const id = row.dataset.claim || (/^0x[0-9a-f]{64}$/.test(row.dataset.ref) && !['send', 'receive', 'swap', 'token_sent', 'token_received', 'token_returned'].includes(row.dataset.kind) ? row.dataset.ref : null);
    if (id) openDetail(id, { reload: load });
  };
  root.addEventListener('click', act);
  root.addEventListener('keydown', (ev) => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('.item.tap')) { ev.preventDefault(); act(ev); } });
  if (notifHandler) document.removeEventListener('dovi:notification', notifHandler);
  notifHandler = load;
  document.addEventListener('dovi:notification', load);
  await load();
}
