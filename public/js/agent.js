import { api } from './api.js?v=dev';
import { esc, usd, timeAgo } from './format.js?v=dev';
import { approve as approveSend, review, previewHtml, successHtml, microToDecimal } from './send.js?v=dev';
import { busy, copy, errorText, toast } from './ui.js?v=dev';
import { openAddMoney } from './addmoney.js?v=dev';
import { nairaOptions, openNairaSell } from './naira.js?v=dev';

const I = {
  wallet: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3"/><path d="M4 7.5V17a2 2 0 0 0 2 2h12.5a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 18.5 8H6.5A2.5 2.5 0 0 1 4 5.5"/><circle cx="16" cy="13.5" r="1.1"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  out: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>',
  inn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 7 7 17M15 17H7V9"/></svg>',
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  spark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z"/></svg>',
  shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 5 6v5.5c0 4.2 2.8 7.2 7 9 4.2-1.8 7-4.8 7-9V6z"/><path d="m9 12 2.2 2.2L15 10.4"/></svg>',
};

const KIND = { claim_funded: 'Sent to', claim_sent: 'Claimed by', claim_returned: 'Taken back from', claim_expired: 'Expired, sent to', claim_received: 'Received from', send: 'Sent to', receive: 'Received from', withdraw: 'Withdrew to', topup: 'Added from' };
const shortWho = (c) => (/^0x[0-9a-fA-F]{40}$/.test(String(c || '')) ? String(c).slice(0, 6) + '\u2026' + String(c).slice(-4) : String(c || ''));
const INCOMING = new Set(['claim_received', 'receive', 'claim_returned', 'topup']);

function meterHtml(u) {
  if (!u) return '';
  const left = Math.max(0, u.remaining); const pct = Math.round((left / u.limit) * 100);
  return '<div class="ask-meter' + (left === 0 ? ' out' : left <= 3 ? ' low' : '') + '" title="Free messages left today"><svg viewBox="0 0 36 36" aria-hidden="true"><circle class="trk" cx="18" cy="18" r="15"/><circle class="val" cx="18" cy="18" r="15" style="stroke-dasharray:' + (pct * 0.9425).toFixed(1) + ' 94.25"/></svg><span><b>' + left + '</b> of ' + u.limit + ' left today</span></div>';
}

function welcomeHtml() {
  const t = [['wallet', 'Balance', 'See what you have on Base'], ['clock', 'History', 'Your latest payments'], ['out', 'Send', 'To an X handle or an email'], ['inn', 'Request', 'Ask someone to pay you'], ['send', 'Cash out', 'USDC to naira in your bank'], ['spark', 'Add money', 'Test USDC or pay naira']];
  return '<div class="ask-welcome"><div class="aw-top"><span class="aw-ic">' + I.spark + '</span><div><b>What would you like to do?</b><p>Type it in plain words. I show you exactly what will happen, and nothing moves until you approve.</p></div></div><div class="aw-grid">' + t.map((x) => '<div class="aw-tile"><span>' + I[x[0]] + '</span><b>' + x[1] + '</b><small>' + x[2] + '</small></div>').join('') + '</div><div class="aw-safe">' + I.shield + 'I can never move money without your approval.</div></div>';
}

function balanceHtml(micro) {
  return '<div class="ask-balance"><small>Your balance</small><b>' + esc(usd(micro)) + '</b><span>Test USDC on Base Sepolia</span></div>';
}

function historyHtml(list) {
  if (!list.length) return '<div class="ask-empty"><span>' + I.clock + '</span><b>No activity yet</b><p>Your payments will show up here.</p></div>';
  return '<div class="ask-lead">Your latest activity</div><div class="ask-hist">' + list.slice(0, 5).map((a) => {
    const inn = INCOMING.has(a.kind);
    return '<div class="ah-row"><span class="ah-ic ' + (inn ? 'in' : 'out') + '">' + (inn ? I.inn : I.out) + '</span><div class="ah-mid"><b>' + esc(KIND[a.kind] || String(a.kind).replace(/_/g, ' ')) + (a.counterparty ? ' ' + esc(shortWho(a.counterparty)) : '') + '</b><small>' + esc(a.createdAt ? timeAgo(a.createdAt) : '') + '</small></div><span class="ah-amt' + (inn ? ' pos' : '') + '">' + (inn ? '+' : '') + esc(usd(a.amountMicro)) + '</span></div>';
  }).join('') + '</div>';
}

function limitHtml(u) {
  const t = u && u.resetsAt ? new Date(u.resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  return '<div class="ask-limit"><span>' + I.clock + '</span><b>That is all for today</b><p>You have used your ' + (u ? u.limit : '') + ' free messages. They reset at midnight UTC' + (t ? ' (' + esc(t) + ' your time)' : '') + '. You can still send and request money from the Send screen.</p></div>';
}

function noteHtml(text, tone) { return '<div class="ask-note' + (tone ? ' ' + tone : '') + '">' + esc(text) + '</div>'; }

export function renderAgent(root, session) {
  root.innerHTML = '<section class="ask"><header class="ask-head"><div class="ask-title"><span class="ask-mark">' + I.spark + '</span><div><h2>Ask DOVI</h2><p>Your payments assistant</p></div></div><div id="am"></div></header><div class="chat ask-chat" id="chat" aria-live="polite"><div class="msg bot full"><div class="bbl wide">' + welcomeHtml() + '</div></div></div><div class="ask-dock"><div class="quick ask-quick"><button class="chip" type="button" data-q="how much do I have">Balance</button><button class="chip" type="button" data-q="show my history">History</button><button class="chip" type="button" data-q="send 5 to @">Send 5 to...</button><button class="chip" type="button" data-q="request 5 from @">Request 5 from...</button></div><form class="chat-form ask-form" id="cf"><input class="input" id="ci" placeholder="Try: send 5 to @amara" autocomplete="off" aria-label="Message DOVI"><button class="ask-send" type="submit" aria-label="Send message">' + I.send + '</button></form></div></section>';
  const chat = root.querySelector('#chat'); const input = root.querySelector('#ci'); const am = root.querySelector('#am');
  const setUsage = (u) => { am.innerHTML = u && u.remaining <= Math.max(3, Math.round(u.limit * 0.1)) ? meterHtml(u) : ''; };
  api('/api/agent/usage').then(setUsage).catch(() => {});
  setTimeout(() => { let pre = null; try { pre = sessionStorage.getItem('dovi.ask'); if (pre) sessionStorage.removeItem('dovi.ask'); } catch { pre = null; } if (pre) { input.value = pre; root.querySelector('#cf').requestSubmit(); } }, 0);
  const add = (cls, html) => {
    const d = document.createElement('div'); d.className = 'msg ' + cls;
    d.innerHTML = (cls === 'bot' ? '<span class="av">D</span>' : '') + '<div class="bbl">' + html + '</div>';
    chat.appendChild(d); d.scrollIntoView({ block: 'end', behavior: 'smooth' });
    return d.querySelector('.bbl');
  };
  root.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => { input.value = b.dataset.q; input.focus(); if (!b.dataset.q.endsWith('@')) root.querySelector('#cf').requestSubmit(); }));
  root.querySelector('#cf').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = input.value.trim(); if (!text) return;
    input.value = ''; add('me', esc(text));
    const thinking = add('bot', '<span class="typing" aria-label="DOVI is thinking"><i></i><i></i><i></i></span>');
    try {
      const r = await api('/api/agent', { method: 'POST', body: { text } });
      setUsage(r.usage);
      if (!r.ok) { thinking.innerHTML = r.code === 'ask_limit' ? limitHtml(r.usage) : noteHtml(r.message || 'I could not do that.', 'soft'); return; }
      if (r.intent === 'help') { thinking.classList.add('wide'); thinking.innerHTML = welcomeHtml(); return; }
      if (r.intent === 'balance') {
        const { address } = session;
        const b = await api('/api/wallet/balance?address=' + encodeURIComponent(address));
        thinking.innerHTML = balanceHtml(b.micro); return;
      }
      if (r.intent === 'history') { thinking.classList.add('wide'); thinking.innerHTML = historyHtml(r.activity); return; }
      if (r.intent === 'claim') { thinking.innerHTML = noteHtml(r.message); return; }
      if (r.intent === 'chat') { thinking.innerHTML = '<div class="ask-note">' + esc(r.message) + '</div>'; return; }
      if (r.intent === 'navigate') {
        const label = { cashout: 'Open cash out', add: 'Add money', withdraw: 'Open Withdraw', giveaways: 'Open Giveaways' }[r.target] || 'Open';
        thinking.innerHTML = '<div class="ask-note">' + esc(r.message) + '</div><button class="btn sm" id="nv" type="button" style="margin-top:8px">' + esc(label) + '</button>';
        thinking.querySelector('#nv').addEventListener('click', async () => {
          if (r.target === 'cashout') { const o = await nairaOptions(); if (o) return openNairaSell(session, o, {}); toast({ title: 'Cash out to naira is not available right now', ms: 3000 }); return; }
          if (r.target === 'add') return openAddMoney(session, {});
          location.hash = '#' + r.target;
        });
        return;
      }
      thinking.classList.add('wide');
      thinking.innerHTML = '<div class="ask-lead">Here is what I would do. Check it, then approve.</div>' + previewHtml({ mode: 'claim', draft: { to: r.preview.lines[0].value, preview: { lines: r.preview.lines.slice(1), note: r.preview.note || '' } } }) + (r.preview.warning ? '<div class="warn">' + esc(r.preview.warning) + '</div>' : '') + '<div class="ask-actions"><button class="btn sm mint" data-ap type="button">Approve</button><button class="btn sm ghost" data-no type="button">Cancel</button></div>';
      thinking.querySelector('[data-no]').addEventListener('click', () => { thinking.classList.remove('wide'); thinking.innerHTML = noteHtml('Okay, cancelled. Nothing was sent.', 'soft'); });
      thinking.querySelector('[data-ap]').addEventListener('click', async (e) => {
        const apBtn = e.currentTarget;
        if (apBtn.disabled) return;
        apBtn.disabled = true;
        try {
          const a = await api('/api/agent/' + r.intentId + '/approve', { method: 'POST', body: {} });
          if (!a.ok) { thinking.classList.remove('wide'); thinking.innerHTML = noteHtml(a.message, 'soft'); return; }
          if (a.action.type === 'create_request') { await api('/api/requests', { method: 'POST', body: { to: a.action.label, amount: microToDecimal(a.action.amountMicro), note: a.action.note } }); thinking.classList.remove('wide'); thinking.innerHTML = '<div class="ask-done"><span>' + I.send + '</span><b>Request sent</b><p>We asked ' + esc(a.action.label) + ' for ' + esc(usd(a.action.amountMicro)) + '.</p></div>'; return; }
          const rv = await review({ to: a.action.label, amount: microToDecimal(a.action.amountMicro), note: a.action.note }, session);
          const res = await busy(apBtn, () => approveSend(rv, session));
          thinking.innerHTML = successHtml(res);
          const cp = thinking.querySelector('#cp'); if (cp) cp.addEventListener('click', async () => { if (await copy(res.link)) toast({ title: 'Link copied', ms: 2000 }); });
        } catch (er) { thinking.innerHTML = noteHtml(errorText(er), 'bad'); }
      });
    } catch (e) { thinking.innerHTML = noteHtml(errorText(e), 'bad'); }
  });
}
