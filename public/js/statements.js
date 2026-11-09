import { api } from './api.js?v=dev';
import { esc, usd, fmtDateTime } from './format.js?v=dev';
import { errorText } from './ui.js?v=dev';

function monthLabel(ym) { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }); }

function tile(k, v, n, cls) { return '<div class="stat ' + cls + '"><small>' + esc(k) + '</small><b>' + esc(v) + '</b><span>' + esc(n) + '</span></div>'; }

function docHtml(st) {
  const t = st.totals; const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const rows = st.rows.length ? st.rows.map((r) => '<tr><td>' + esc(new Date(r.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })) + '</td><td>' + esc(r.type) + '</td><td>' + esc(r.counterparty || '') + '</td><td class="num ' + (r.direction === 'in' ? 'pos' : '') + '">' + (r.direction === 'in' ? '+' : '-') + esc(r.amountMicro == null ? '' : usd(r.amountMicro)) + '</td></tr>').join('') : '<tr><td colspan="4" class="empty-row">No activity in this month.</td></tr>';
  return '<div class="stmt" id="stmt"><div class="stmt-head"><div class="stmt-brand"><span class="stmt-mark">D</span><b>DOVI</b></div><div class="stmt-title"><h2>Account statement</h2><p>' + esc(st.label) + (st.testnet ? ', test network' : '') + '</p></div></div>'
    + '<div class="stmt-meta"><div><small>Account</small><b>' + esc(st.holder || 'Your DOVI account') + '</b></div><div><small>Period</small><b>' + esc(new Date(st.from).toISOString().slice(0, 10)) + ' to ' + esc(new Date(st.to).toISOString().slice(0, 10)) + ' (UTC)</b></div><div><small>Network</small><b>' + esc(st.network) + '</b></div><div><small>Made</small><b>' + esc(fmtDateTime(st.generatedAt)) + '</b></div></div>'
    + '<div class="stats stmt-sum">' + tile('Sent', usd(t.sentMicro), plural(t.sentCount, 'payment'), 't-mint') + tile('Received', usd(t.receivedMicro), plural(t.receivedCount, 'payment'), 't-blue') + tile('Taken back', usd(t.returnedMicro), plural(t.returnedCount, 'payment'), 't-lilac') + tile('DOVI fees paid', usd(st.feesMicro), 'on claimed payments', 't-gold') + tile('Added', usd(t.addedMicro), plural(t.addedCount, 'top up'), 't-mint') + tile('Withdrawn', usd(t.withdrawnMicro), plural(t.withdrawnCount, 'withdrawal'), 't-blue') + '</div>'
    + '<table class="stmt-table"><thead><tr><th>Date</th><th>What</th><th>With</th><th class="num">Amount</th></tr></thead><tbody>' + rows + '</tbody></table>'
    + (st.truncated ? '<p class="note">Only the first 2,000 items are shown.</p>' : '')
    + '<p class="stmt-foot">This statement lists the activity DOVI recorded for your account in this period, in USDC. It does not show your balance, and it is not a bank statement. ' + (st.testnet ? 'This is the test network, so no real money moved. ' : '') + 'Every payment can be checked on the block explorer from its receipt link.</p></div>';
}

export async function renderStatements(root) {
  root.innerHTML = '<div class="skeleton" style="height:120px"></div>';
  let list;
  try { list = await api('/api/statements'); } catch (e) { root.innerHTML = '<p class="err">' + esc(errorText(e)) + '</p>'; return; }
  let ym = list.months[0];
  root.innerHTML = '<h2 class="sec">Statements</h2><div class="card stmt-bar"><label class="field" for="sm" style="margin-top:0">Month</label><select class="input" id="sm">' + list.months.map((m) => '<option value="' + m + '">' + esc(monthLabel(m)) + '</option>').join('') + '</select><div class="stmt-acts"><button class="btn mint" id="spdf" type="button">Save as PDF</button><a class="btn ghost" id="scsv" href="#" download>Download CSV</a></div><p class="note">Save as PDF opens your browser print window. Choose "Save as PDF" as the printer.</p></div><div id="sdoc"></div>';
  const doc = root.querySelector('#sdoc'); let cur = null;
  async function load() {
    doc.innerHTML = '<div class="skeleton" style="height:260px"></div>';
    try {
      cur = await api('/api/statements/' + ym);
      doc.innerHTML = docHtml(cur);
      { const px = root.querySelector('#spdfx'); if (px) px.href = '/api/statements/' + ym + '/pdf'; }
      root.querySelector('#scsv').href = '/api/activity/export?since=' + cur.from + '&until=' + (cur.to + 1);
    } catch (e) { doc.innerHTML = '<p class="err">' + esc(errorText(e)) + '</p>'; }
  }
  root.querySelector('#sm').addEventListener('change', (ev) => { ym = ev.target.value; load(); });
  root.querySelector('#spdf').addEventListener('click', () => { if (cur) window.print(); });
  { const bar = root.querySelector('.stmt-acts'); if (bar) bar.insertAdjacentHTML('beforeend', '<a class="btn sm ghost" id="spdfx" href="#" download>Download PDF</a>'); }
  await load();
}
