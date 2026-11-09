import { api, idem } from './api.js?v=dev';
import { esc, usd, fmtDateTime } from './format.js?v=dev';
import { busy, copy, errorText, toast, sheet } from './ui.js?v=dev';
import { backBar, linesHtml, stepsHtml, stepper, sendAndConfirm, okSheet, failFoot } from './flow.js?v=dev';

const AMOUNT = /^\$?\d+(\.\d{1,6})?$/;
const HANDLE = /^@?[A-Za-z0-9_]{1,15}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const POST = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d{5,25}/i;

export function parseLines(text, defaultAmount) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    const allParts = line.split(/[\s,;\t]+/).filter(Boolean);
    const postTok = allParts.find((p) => POST.test(p));
    const parts = allParts.filter((p) => p !== postTok);
    const amt = parts.find((p) => AMOUNT.test(p));
    const to = parts.find((p) => p !== amt && (EMAIL.test(p) || HANDLE.test(p)));
    if (!amt && !to) continue;
    if (!amt && /^(handle|username|user|email|to|recipient)$/i.test(parts[0]) ) continue;
    const amount = amt ? amt.replace(/^\$/, '') : (defaultAmount || '');
    const bad = !to ? 'No handle or email found.' : (!amount || !AMOUNT.test(amount) ? 'Add an amount, or set the same amount for everyone.' : '');
    out.push({ line: raw.trim(), to: to || '', amount, post: postTok || '', error: bad });
  }
  return out;
}

const shareText = (it) => it.to + ' you have ' + usd(it.amountMicro) + ' waiting on DOVI. Claim it with one login: ' + it.link;
const csv = (items) => 'recipient,amount,link\n' + items.map((i) => [i.to, usd(i.amountMicro).replace('$', ''), i.link].join(',')).join('\n');

function approveBit(i, on) {
  if (!on || !i.needsRelease) return '';
  if (i.released) return '<span class="chip sm">Approved</span>';
  const auto = i.releaseRule === 'time' ? '<span class="chip sm">Auto at ' + esc(fmtDateTime(i.releaseAt * 1000)) + '</span><button class="btn sm ghost" data-stop="' + esc(i.claimId) + '" type="button">Stop auto</button>' : i.releaseRule === 'post' ? '<span class="chip sm">' + (i.releaseNote === 'missing' ? 'Post not found' : i.releaseNote === 'wrong_author' ? 'Post not theirs' : 'Auto when post is ' + esc(i.postHours) + ' h old') + '</span><button class="btn sm ghost" data-stop="' + esc(i.claimId) + '" type="button">Stop auto</button>' : '';
  return auto + (i.status === 'funded' ? '<button class="btn sm mint" data-rel="' + esc(i.claimId) + '" type="button">Approve</button>' : '');
}

function resultItems(b, approve = false) {
  return '<div class="card"><div class="rows">' + b.items.map((i) => '<div class="r bi"><span><b>' + esc(i.to) + '</b><small>' + esc(usd(i.amountMicro)) + ', ' + esc(i.status) + '</small></span><span class="bi-a">' + approveBit(i, approve) + '<button class="btn sm ghost" data-cp="' + esc(i.link) + '" type="button">Copy link</button>' + (i.kind === 'x' ? '<a class="btn sm" target="_blank" rel="noopener" href="https://x.com/intent/tweet?text=' + encodeURIComponent(shareText(i)) + '">Post on X</a>' : '') + '</span></div>').join('') + '</div></div>';
}

function wireCopies(el, b) {
  el.querySelectorAll('[data-cp]').forEach((x) => x.addEventListener('click', async () => { if (await copy(x.dataset.cp)) toast({ title: 'Link copied', ms: 1800 }); }));
  const all = el.querySelector('#cpall'); if (all) all.addEventListener('click', async () => { if (await copy(b.items.map(shareText).join('\n'))) toast({ title: 'All messages copied', ms: 2000 }); });
  const cs = el.querySelector('#cpcsv'); if (cs) cs.addEventListener('click', async () => { if (await copy(csv(b.items))) toast({ title: 'CSV copied', ms: 2000 }); });
}

export function openBatch(id) {
  const s = sheet('<div class="rv"><div class="skeleton" style="height:240px"></div></div>', { label: 'Batch', cls: 'rvback' });
  api('/api/batches/' + id).then((b) => {
    s.set('<div class="rv"><h2>' + esc(b.title || 'Batch payout') + '</h2><p class="hint">' + esc(b.count) + ' payments, ' + esc(usd(b.totalMicro)) + ' with fees. Sent ' + esc(fmtDateTime(b.fundedAt || b.createdAt)) + '.</p><p class="note">' + Object.entries(b.counts).map(([k, v]) => esc(v + ' ' + k)).join(', ') + '</p>' + (b.lockUntil ? '<p class="note">Locked for them until ' + esc(fmtDateTime(b.lockUntil * 1000)) + '. You cannot take these back before then.</p>' : '') + (b.payOnDelivery ? '<p class="note">Pay on delivery. People can claim only after you approve them.</p><button class="btn block mint" id="relall" type="button" style="margin-bottom:10px">Approve everyone</button>' : '') + resultItems(b, true) + '<div class="rv-actions"><button class="btn block" id="cpall" type="button">Copy all messages</button><button class="btn block ghost" id="cpcsv" type="button">Copy as CSV</button></div></div>');
    wireCopies(s.el, b);
    const again = () => { s.close(); openBatch(id); };
    s.el.querySelectorAll('[data-rel]').forEach((x) => x.addEventListener('click', async () => { try { await busy(x, () => api('/api/claims/' + x.dataset.rel + '/release', { method: 'POST', body: {} })); toast({ title: 'Approved', ms: 2000 }); again(); } catch (e) { toast({ title: 'Could not approve', body: errorText(e), tone: 'bad', icon: '!' }); } }));
    s.el.querySelectorAll('[data-stop]').forEach((x) => x.addEventListener('click', async () => { try { await busy(x, () => api('/api/claims/' + x.dataset.stop + '/auto-cancel', { method: 'POST', body: {} })); toast({ title: 'Automatic release stopped', body: 'You approve this one yourself now.', ms: 3000 }); again(); } catch (e) { toast({ title: 'Could not stop it', body: errorText(e), tone: 'bad', icon: '!' }); } }));
    const ra = s.el.querySelector('#relall'); if (ra) ra.addEventListener('click', async () => { try { const r = await busy(ra, () => api('/api/batches/' + id + '/release', { method: 'POST', body: {} })); toast({ title: r.released + ' approved', ms: 2500 }); again(); } catch (e) { toast({ title: 'Could not approve', body: errorText(e), tone: 'bad', icon: '!' }); } });
  }).catch((e) => s.set('<div class="rv"><h2>Batch</h2><p class="err">' + esc(errorText(e)) + '</p></div>'));
}

export async function renderBatch(root, session, { go }) {
  root.innerHTML = backBar('Pay many people', 'Giveaways, bounties, campaign payouts. One list, one approval, one claim link each.', 'batch') +
    '<form class="card" id="bf" novalidate><label class="field" for="bt" style="margin-top:0">Name (optional)</label><input class="input" id="bt" maxlength="80" placeholder="October giveaway" autocomplete="off">' +
    '<label class="field" for="bl">Who gets paid</label><textarea class="input" id="bl" rows="7" spellcheck="false" autocapitalize="none" placeholder="@amara 5&#10;@kofi 5&#10;lena@mail.com 10"></textarea>' +
    '<p class="hint">One person per line: an X handle or an email, then the amount. Commas and spreadsheet paste work.</p>' +
    '<label class="field" for="bd">Same amount for everyone (optional)</label><div class="amount-wrap"><span class="cur" aria-hidden="true">$</span><input class="input" id="bd" inputmode="decimal" placeholder="5" autocomplete="off"></div>' +
    '<div id="bopts"></div><div id="bp" aria-live="polite"></div><p class="err" id="bm" role="alert" hidden></p><button class="btn block mint lg" id="br" type="submit">Review</button></form>' +
    '<h2 class="sec">Past batches</h2><div class="list" id="bh"><div class="skeleton" style="height:60px"></div></div>';
  const f = root.querySelector('#bf'); const msg = root.querySelector('#bm'); const prev = root.querySelector('#bp');
  const releaseHtml = '<label class="field" for="brl">When can they claim?</label><select class="input" id="brl"><option value="now">Right away</option><option value="approve">After I approve each one</option><option value="time">Automatically at a time</option><option value="post">Automatically after their post has been up for a while</option></select><div id="brx"></div>';
  const wireRelease = () => {
    const sel = f.querySelector('#brl'); const box = f.querySelector('#brx'); if (!sel) return;
    sel.addEventListener('change', () => {
      const v = sel.value; const soon = new Date(Date.now() + 20 * 60000); const pad = (n) => String(n).padStart(2, '0');
      const local = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      box.innerHTML = v === 'time' ? '<label class="field" for="bat">Release at</label><input class="input" type="datetime-local" id="bat" value="' + local(new Date(Date.now() + 3600000)) + '" min="' + local(soon) + '" max="' + local(new Date(Date.now() + 6 * 86400000)) + '"><p class="hint">Money is held in escrow and DOVI approves it at this time. You can still approve earlier or stop the schedule.</p>' : v === 'post' ? '<label class="field" for="bph">The post must have been up for</label><select class="input" id="bph"><option value="1">1 hour</option><option value="6">6 hours</option><option value="24" selected>24 hours</option><option value="48">2 days</option><option value="96">4 days</option></select><p class="hint">Add each person\'s post link on their line, for example: @amara 5 https://x.com/amara/status/123. DOVI checks that the post exists and is from them.</p>' : v === 'approve' ? '<p class="hint">Money is held in escrow. Each person can claim only after you approve them.</p>' : '';
    });
  };
  api('/api/public/cdp-config').then((c) => {
    f.querySelector('#bopts').innerHTML = '<div class="protect"><b>Protect the payouts</b>' + releaseHtml + (c.lockEnabled ? '<label class="field" for="bk">Lock the money for them</label><select class="input" id="bk"><option value="">No lock</option><option value="24">1 day</option><option value="72">3 days</option><option value="168">7 days</option></select><p class="hint">A locked payment cannot be taken back by you before the lock ends.</p>' : '') + '</div>';
    wireRelease();
  }).catch(() => {});
  const ta = f.querySelector('#bl'); const def = f.querySelector('#bd');
  let pre = null; try { pre = sessionStorage.getItem('dovi.batchlines'); sessionStorage.removeItem('dovi.batchlines'); } catch { pre = null; }
  const redraw = () => {
    const rows = parseLines(ta.value, def.value.trim().replace(/^\$/, ''));
    const ok = rows.filter((r) => !r.error); const total = ok.reduce((s, r) => s + Math.round(Number(r.amount) * 1e6), 0);
    prev.innerHTML = rows.length ? '<div class="bprev"><b>' + ok.length + ' of ' + rows.length + ' lines ready</b>' + (ok.length ? ', ' + esc(usd(total)) + ' before the fee' : '') + rows.filter((r) => r.error).slice(0, 4).map((r) => '<p class="hint" style="color:var(--red);margin:4px 0 0">' + esc(r.line.slice(0, 40)) + ': ' + esc(r.error) + '</p>').join('') + '</div>' : '';
  };
  ta.addEventListener('input', redraw); def.addEventListener('input', redraw);
  if (pre) { ta.value = String(pre).slice(0, 4000); redraw(); }
  const loadHistory = () => api('/api/batches').then((r) => {
    const el = root.querySelector('#bh'); if (!el) return;
    el.innerHTML = r.batches.length ? r.batches.map((b) => '<button class="item" data-b="' + esc(b.batchId) + '" type="button"><div class="ico" aria-hidden="true">&#8599;</div><div class="mid"><b>' + esc(b.title || 'Batch payout') + '</b><small>' + esc(b.count) + ' payments, ' + esc(fmtDateTime(b.fundedAt || b.createdAt)) + '</small></div><div class="amt">' + esc(usd(b.totalMicro)) + '</div></button>').join('') : '<p class="hint">No batches yet.</p>';
    el.querySelectorAll('[data-b]').forEach((x) => x.addEventListener('click', () => openBatch(x.dataset.b)));
  }).catch(() => {});
  loadHistory();
  f.addEventListener('submit', (ev) => {
    ev.preventDefault(); msg.hidden = true;
    const rows = parseLines(ta.value, def.value.trim().replace(/^\$/, ''));
    if (!rows.length) { msg.hidden = false; msg.textContent = 'Add at least one line.'; return; }
    if (rows.some((r) => r.error)) { msg.hidden = false; msg.textContent = 'Fix the lines marked above first.'; return; }
    const lk = f.querySelector('#bk'); const mode = (f.querySelector('#brl') || {}).value || 'now';
    let autoRelease; let payOnDelivery;
    if (mode === 'approve') payOnDelivery = true;
    if (mode === 'time') { const v = (f.querySelector('#bat') || {}).value; const at = v ? Math.floor(new Date(v).getTime() / 1000) : 0; if (!at || at < Math.floor(Date.now() / 1000) + 600) { msg.hidden = false; msg.textContent = 'Pick a release time at least 10 minutes from now.'; return; } autoRelease = { mode: 'time', at }; }
    if (mode === 'post') { if (rows.some((r) => !r.post)) { msg.hidden = false; msg.textContent = 'Add the post link to every line, after the amount.'; return; } autoRelease = { mode: 'post', hours: Number((f.querySelector('#bph') || {}).value || 24) }; }
    review({ title: f.querySelector('#bt').value.trim(), items: rows.map((r) => ({ to: r.to, amount: r.amount, post: r.post || undefined })), lockHours: lk && lk.value ? Number(lk.value) : undefined, payOnDelivery, autoRelease }, session, () => { ta.value = ''; redraw(); loadHistory(); });
  });
}

async function review(input, session, onDone) {
  const s = sheet('<div class="rv"><h2>Checking your list</h2><div class="skeleton" style="height:140px"></div></div>', { label: 'Review batch', cls: 'rvback' });
  let d;
  try { d = await api('/api/batches/draft', { method: 'POST', body: { ...input, address: session.address, idempotencyKey: idem() } }); }
  catch (e) {
    const det = e.details || null;
    s.set('<div class="rv"><h2>Fix these lines</h2>' + (det ? '<ul class="plain">' + det.map((x) => '<li><b>Line ' + esc(x.line) + '</b>: ' + esc(x.message) + '</li>').join('') + '</ul>' : '<p class="err" role="alert">' + esc(errorText(e)) + '</p>') + '<button class="btn block" id="cl" type="button" style="margin-top:14px">Back to the list</button></div>');
    s.el.querySelector('#cl').addEventListener('click', s.close); return;
  }
  const net = await api('/api/public/cdp-config').then((c) => (c.testnet ? 'Base Sepolia' : 'Base')).catch(() => 'Base');
  const view = () => {
    s.set('<div class="rv"><h2>Review batch</h2><p class="hint">' + esc(d.title || 'Batch payout') + '</p>' + linesHtml(d.preview.lines.concat(d.lockUntil ? [{ label: 'Locked until', value: fmtDateTime(d.lockUntil * 1000) }] : []).concat(d.payOnDelivery ? [{ label: 'Claims open', value: d.releaseMode === 'time' ? 'At ' + fmtDateTime(d.items[0].releaseAt * 1000) : d.releaseMode === 'post' ? 'When each post is ' + d.items[0].postHours + ' hours old' : 'After you approve' }] : [])) + '<div class="card"><div class="rows">' + d.items.slice(0, 8).map((i) => '<div class="r"><span>' + esc(i.to) + '</span><b>' + esc(usd(i.amountMicro)) + '</b></div>').join('') + (d.items.length > 8 ? '<div class="r"><span>and ' + (d.items.length - 8) + ' more</span><b></b></div>' : '') + '</div></div><p class="note">' + esc(d.preview.note) + '</p><div class="rv-actions"><button class="btn block mint lg" id="go" type="button">Approve and send ' + esc(usd(d.totalMicro)) + '</button><button class="btn block ghost" id="cancel" type="button">Cancel</button></div></div>');
    s.el.querySelector('#cancel').addEventListener('click', s.close);
    s.el.querySelector('#go').addEventListener('click', run);
  };
  async function run() {
    s.set('<div class="rv"><h2>Sending ' + esc(d.count) + ' payments</h2>' + stepsHtml([['prep', 'Batch prepared'], ['send', 'Approving and sending'], ['confirm', 'Confirming on', true], ['done', 'Claim links ready']], net) + '<div class="rv-foot" id="rf">Keep this window open. It usually takes under a minute.</div></div>');
    const step = stepper(s.el); step('prep', 'done'); s.lock(true);
    let last = 'send';
    try {
      const b = await sendAndConfirm({ txs: d.txs, confirm: () => api('/api/batches/' + d.batchId + '/funded', { method: 'POST', body: {} }), onStep: (i, st, t) => { last = i; step(i, st, t); } });
      s.lock(false);
      okSheet(s, { title: b.count + ' payments sent', body: esc(usd(b.totalMicro)) + ' is waiting. Share each link, or post on X.', extra: '<div style="max-height:34vh;overflow:auto;margin-top:12px">' + resultItems(b) + '</div><div class="rv-actions"><button class="btn block ghost" id="cpall" type="button">Copy all messages</button><button class="btn block ghost" id="cpcsv" type="button">Copy as CSV</button></div>', doneLabel: 'Done' });
      wireCopies(s.el, b); s.el.querySelector('#dn').addEventListener('click', s.close);
      if (onDone) onDone();
    } catch (e) { s.lock(false); step(last, 'fail', ''); failFoot(s.el, e, last === 'send' ? run : null, s.close); }
  }
  view();
}
