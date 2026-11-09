import { openAddMoney } from './addmoney.js?v=dev';
import { nairaOptions, openNairaSell } from './naira.js?v=dev';
import { mountTokens } from './tokens.js?v=dev';
import { api } from './api.js?v=dev';
import * as wallet from './wallet.js?v=dev';
import { esc, usd, timeAgo, safeHref } from './format.js?v=dev';
import { sheet, copy, toast, errorText, busy, logo } from './ui.js?v=dev';
import { chipsHtml } from './chains.js?v=dev';
import { particles, countUp } from './fx.js?v=dev';

let notifHandler = null;
let liveTimer = null;
let visHandler = null;
export async function renderHome(root, session, { go }) {
  root.innerHTML = [
    '<section class="home-top">',
    '<div class="hero-card"><div class="lbl"><span>Your dollars</span><span class="chip live sm">' + logo('base') + 'Base Sepolia</span></div><div class="bal" id="bal"><span class="skeleton" style="display:inline-block;width:190px;height:56px;background:rgba(255,255,255,.15)"></span></div><div class="sub">' + logo('usdc') + ' USDC. Not a bank deposit.</div><div class="sub" id="ngn" hidden></div><div class="acts"><button class="act" data-a="add" type="button"><span class="ai" aria-hidden="true">＋</span>Add money</button><button class="act" data-a="send" type="button"><span class="ai" aria-hidden="true">↗</span>Send</button><button class="act" data-a="request" type="button"><span class="ai" aria-hidden="true">↙</span>Request</button><button class="act" data-a="receive" type="button"><span class="ai" aria-hidden="true">⌗</span>Receive</button></div></div>',
    '<form class="agent-card" id="ag"><span class="ag-ic" aria-hidden="true">◎</span><span class="kick">DOVI agent</span><h1>Money should understand you.</h1><p>Send, request or check in plain English. DOVI shows a preview and waits for your approval.</p><div class="ag-in"><label class="sr" for="agq">Ask DOVI</label><input id="agq" class="ag-field" maxlength="200" autocomplete="off" placeholder="Try &quot;send $20 to @ada&quot;"><button type="submit" aria-label="Ask">↑</button></div></form>',
    '</section>',
    '<div id="inc"></div>',
    '<div id="tok"></div>',
    '<h2 class="sec">Everything your dollars can do</h2>',
    '<div class="tiles">',
    '<button class="tile t-mint" data-a="send" type="button"><span class="ti2" aria-hidden="true">↗</span><b>Send to a handle</b><small>X handle or email. They claim with one login.</small></button>',
    '<button class="tile t-gold" data-a="request" type="button"><span class="ti2" aria-hidden="true">↙</span><b>Request money</b><small>Ask anyone, they see it in DOVI.</small></button>',
    '<button class="tile t-mint" data-a="batch" type="button"><span class="ti2" aria-hidden="true">⇶</span><b>Pay many people</b><small>Giveaways and payouts, one list.</small></button>',
    '<button class="tile t-gold" data-a="autopay" type="button"><span class="ti2" aria-hidden="true">@</span><b>Pay from X</b><small>Tweet a payment, DOVI sends it from your account.</small></button>',
    '<button class="tile t-lilac" data-a="withdraw" type="button"><span class="ti2" aria-hidden="true">⇥</span><b>Withdraw</b><small>To your Base wallet or your bank in naira.</small></button>',
    '<button class="tile t-gold" data-a="swap" type="button"><span class="ti2" aria-hidden="true">⇄</span><b>Swap to naira <span class="status draft" id="swst">Coming soon</span></b><small id="swsm">Cash out your USDC to your bank, with partners.</small></button>',
    '<button class="tile t-mint" data-a="links" type="button"><span class="ti2" aria-hidden="true">&#8734;</span><b>Payment links</b><small>Your pay-me link and reusable links.</small></button>',
    '<button class="tile t-gold" data-a="giveaways" type="button"><span class="ti2" aria-hidden="true">&#10022;</span><b>Giveaways</b><small>Pick winners from your X post.</small></button>',
    '<button class="tile t-lilac" data-a="invite" type="button"><span class="ti2" aria-hidden="true">&#9733;</span><b>Invite friends</b><small>Your permanent invite code.</small></button>',
    '<button class="tile t-blue" data-a="receive" type="button"><span class="ti2" aria-hidden="true">↓</span><b>Receive</b><small>Your handle and address.</small></button>',
    '<button class="tile t-lilac" data-a="activity" type="button"><span class="ti2" aria-hidden="true">≡</span><b>Activity</b><small>Receipts, claims and returns.</small></button>',
    '<button class="tile t-blue" data-a="agent" type="button"><span class="ti2" aria-hidden="true">✦</span><b>Ask the agent</b><small>Plain words in, exact preview out.</small></button>',
    '</div>',
    '<section class="coming" aria-labelledby="cmh"><div class="stage" aria-hidden="true"><img src="/brand/dovi-platform-20261025-1200.webp" srcset="/brand/dovi-platform-20261025-800.webp 800w, /brand/dovi-platform-20261025-1200.webp 1200w, /brand/dovi-platform-20261025-1659.webp 1659w" sizes="(max-width:860px) 92vw, 640px" alt="" width="1659" height="948" decoding="async" loading="lazy"><span class="pulse"></span><span class="sheen"></span><span class="fxp"></span></div><div class="cm-body"><h2 id="cmh">Coming to your account</h2><div class="cm-list"><span class="soonpill"><em class="st st-next">Next</em>Savings pot</span><span class="soonpill"><em class="st st-next">Next</em>Private send</span><span class="soonpill"><em class="st st-later">Later</em>' + logo('telegram') + 'Telegram</span></div></div></section>',
    '<div class="chips" id="ch" aria-label="Networks"></div>',
    '<h2 class="sec">Recent <a href="#activity">See all</a></h2><div class="list" id="rc"><div class="skeleton" style="height:60px"></div></div>'
  ].join('');
  particles(root.querySelector('.fxp'), 18);
  root.querySelector('#ag').addEventListener('submit', (e) => { e.preventDefault(); const q = root.querySelector('#agq').value.trim(); if (q) { try { sessionStorage.setItem('dovi.ask', q); } catch { /* storage blocked, the question is not carried over */ } } go('agent'); });
  function loadIncoming() {
    api('/api/claims/incoming').then((r) => { const el = root.querySelector('#inc'); if (!el) return; const list = r.incoming || []; el.innerHTML = list.map((c) => '<a class="hero-card" style="display:block;margin:0 0 12px;text-decoration:none;min-height:0;padding:18px 22px" href="' + esc(safeHref(c.path)) + '"><div class="lbl"><span>Waiting for you</span></div><div class="bal" style="font-size:32px">' + esc(usd(c.amountMicro)) + '</div><div class="sub">From ' + esc(c.from) + '. Tap to claim.</div></a>').join(''); }).catch(() => {});
  }
  loadIncoming();
  chipsHtml().then((h) => { const el = root.querySelector('#ch'); if (el) el.innerHTML = h; }).catch(() => {});
  const bal = root.querySelector('#bal');
  let fx = null;
  const showNgn = () => { const el = root.querySelector('#ngn'); if (!el || !fx || !fx.available || session.balanceMicro == null) return; const usdc = Number(session.balanceMicro) / 1e6; const n = new Intl.NumberFormat('en-NG', { maximumFractionDigits: 0 }); el.hidden = false; el.textContent = 'About ₦' + n.format(usdc * fx.rate) + ' at ₦' + n.format(fx.rate) + ' per $1.'; };
  api('/api/public/fx').then((r) => { fx = r; showNgn(); }).catch(() => {});
  let balSeq = 0;
  async function refreshBalance() {
    const my = ++balSeq;
    try { const b = await api('/api/wallet/balance?address=' + encodeURIComponent(session.address)); if (my !== balSeq) return; const changed = String(session.balanceMicro) !== String(b.micro) || !bal.dataset.done; session.balanceMicro = b.micro; bal.classList.remove('err'); if (changed) { bal.dataset.done = '1'; countUp(bal, Number(b.micro), (v) => usd(Math.round(v))); } showNgn(); }
    catch (e) { if (my !== balSeq || bal.dataset.done) return; bal.classList.add('err'); bal.innerHTML = 'Balance unavailable <button class="linkbtn" type="button" id="rb">Retry</button>'; bal.title = errorText(e); const rb = bal.querySelector('#rb'); if (rb) rb.addEventListener('click', () => { bal.classList.remove('err'); bal.textContent = '...'; refreshBalance(); }); }
  }
  refreshBalance();
  nairaOptions().then((o) => { if (!o || !root.isConnected) return; const st = root.querySelector('#swst'); const sm = root.querySelector('#swsm'); if (st) st.textContent = o.simulated ? 'Test' : 'Live'; if (sm) sm.textContent = 'Cash out your USDC to your Nigerian bank account.'; });
  function loadRecent() {
  api('/api/activity?limit=8').then((a0) => {
    const a = { activity: a0.activity.filter((x) => !['claim_sent', 'claim_expired'].includes(x.kind)).slice(0, 3) };
    const rc = root.querySelector('#rc'); if (!rc) return; rc.dataset.ok = '1';
    rc.innerHTML = a.activity.length ? a.activity.map((x) => { const inb = ['claim_received', 'receive', 'claim_returned', 'topup'].includes(x.kind); const ret = x.kind === 'claim_returned'; return '<div class="item"><div class="ico' + (inb ? ' in' : '') + '" aria-hidden="true">' + (ret ? '↩' : inb ? '↙' : '↗') + '</div><div class="mid"><div class="t">' + (ret ? 'Returned to you' : inb ? 'Received' : 'Sent') + (!ret && x.counterparty ? (inb ? ' from ' : ' to ') + esc(x.counterparty) : '') + '</div><div class="d">' + esc(timeAgo(x.createdAt)) + '</div></div><div class="amt' + (inb ? ' pos' : '') + '">' + (inb ? '+' : '-') + esc(usd(x.amountMicro).replace('-', '')) + '</div></div>'; }).join('') : '<div class="empty"><div class="big" aria-hidden="true">✉</div><h3>Send your first dollars</h3><p>Type a handle or an email. They claim it with one login.</p><button class="btn mint" data-a="send" type="button">Send dollars</button></div>';
  }).catch(() => { const rc = root.querySelector('#rc'); if (rc && !rc.dataset.ok) rc.innerHTML = ''; });
  }
  loadRecent();
  mountTokens(root, session);
  const stopLive = () => {
    if (notifHandler) document.removeEventListener('dovi:notification', notifHandler);
    if (visHandler) document.removeEventListener('visibilitychange', visHandler);
    if (liveTimer) clearInterval(liveTimer);
    notifHandler = null; visHandler = null; liveTimer = null;
  };
  stopLive();
  const refreshAll = () => { if (!root.isConnected || !root.querySelector('#bal')) { stopLive(); return; } refreshBalance(); loadRecent(); loadIncoming(); };
  notifHandler = refreshAll; document.addEventListener('dovi:notification', refreshAll);
  visHandler = () => { if (document.visibilityState === 'visible') refreshAll(); };
  document.addEventListener('visibilitychange', visHandler);
  liveTimer = setInterval(() => { if (document.visibilityState === 'visible') refreshAll(); }, 15000);

  root.addEventListener('click', async (ev) => {
    const a = ev.target.closest('[data-a]'); if (!a) return;
    const k = a.dataset.a;
    if (k === 'send') return go('send');
    if (k === 'batch') return go('batch');
    if (k === 'autopay') return go('autopay');
    if (k === 'links') return go('links');
    if (k === 'invite') return go('invite');
    if (k === 'giveaways') return go('giveaways');
    if (k === 'withdraw') return go('withdraw');
    if (k === 'activity') return go('activity');
    if (k === 'agent') return go('agent');
    if (k === 'swap') return swapSheet(session, refreshBalance);
    if (k === 'request') return requestSheet();
    if (k === 'receive') return receiveSheet(session);
    if (k === 'add') return openAddMoney(session, { onDone: () => setTimeout(refreshBalance, 500) });
  });
}

async function swapSheet(session, refresh) {
  const nopt = await nairaOptions();
  if (nopt) return openNairaSell(session, nopt, { onDone: () => setTimeout(refresh, 500) });
  const s = sheet('<h2>Swap to naira or other fiat</h2><p class="hint"><span class="status draft">Coming soon</span></p><div class="card" style="margin-top:12px"><p style="margin-top:0">Soon you will be able to swap your USDC to naira or another local currency and send it to your bank account, peer to peer or through a licensed partner.</p><p class="note">You will see the rate before you confirm. Availability depends on your country. Nothing here moves money yet.</p></div><button class="btn block" id="sw-ok" type="button" style="margin-top:12px">Got it</button>', { label: 'Swap to naira or other fiat' });
  s.el.querySelector('#sw-ok').addEventListener('click', s.close);
}

function receiveSheet(session) {
  const s = sheet('<h2>Receive</h2><p class="hint">Share your handle so people can send to you, or use this address.</p><div class="card" style="margin-top:12px"><p class="note" style="margin-top:0">Your address on Base Sepolia (test network)</p><div class="linkbox"><span id="ad">' + esc(session.address) + '</span><button class="btn sm" id="cpa" type="button">Copy</button></div><p class="note">Only send test USDC on Base Sepolia to this address. Real money or other networks sent here can be lost.</p></div>', { label: 'Receive' });
  s.el.querySelector('#cpa').addEventListener('click', async () => { if (await copy(session.address)) toast({ title: 'Address copied', ms: 2000 }); });
}

function requestSheet() {
  const s = sheet('<h2>Request money</h2><p class="hint">Ask an X handle or an email for money. They see it in DOVI.</p><form id="rf" novalidate><label class="field" for="rt">From</label><input class="input" id="rt" placeholder="@handle or email" autocapitalize="none" autocomplete="off"><label class="field" for="ra">Amount in USD</label><input class="input" id="ra" inputmode="decimal" placeholder="10.00"><label class="field" for="rn">Note (optional)</label><input class="input" id="rn" maxlength="140" placeholder="For dinner"><div id="rm" class="err" role="alert" hidden></div><button class="btn block mint" style="margin-top:14px" type="submit">Send request</button></form>', { label: 'Request money' });
  const f = s.el.querySelector('#rf'); const rm = s.el.querySelector('#rm');
  f.addEventListener('submit', async (e) => {
    e.preventDefault(); rm.hidden = true;
    try {
      const r = await busy(f.querySelector('button'), () => api('/api/requests', { method: 'POST', body: { to: f.querySelector('#rt').value.trim(), amount: f.querySelector('#ra').value.trim(), note: f.querySelector('#rn').value.trim() } }));
      if (!r) return;
      s.close(); toast({ title: 'Request sent', body: r.delivered ? r.to + ' will see it in DOVI.' : r.to + ' is not on DOVI yet, so they will not see it until they join.' });
    } catch (er) { rm.hidden = false; rm.textContent = errorText(er); }
  });
}
