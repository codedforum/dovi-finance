import { api } from './api.js?v=dev';
import { esc, usd, validAmount, fmtDateTime } from './format.js?v=dev';
import { busy, copy, errorText, toast, sheet } from './ui.js?v=dev';
import { backBar } from './flow.js?v=dev';

const rowHtml = (k) => '<div class="item"><div class="mid"><div class="t">' + esc(k.name) + ' <span class="status ' + (k.status === 'active' ? 'done' : 'draft') + '">' + esc(k.status) + '</span></div>' +
  '<div class="d">' + esc(usd(k.perPaymentMicro)) + ' per payment, ' + esc(usd(k.perDayMicro)) + ' per day</div>' +
  '<div class="d">Spent today ' + esc(usd(k.spentTodayMicro)) + ', ' + esc(usd(k.remainingTodayMicro)) + ' left</div>' +
  '<div class="d">' + esc(k.prefix) + '… ' + (k.lastUsedAt ? 'Last used ' + esc(fmtDateTime(k.lastUsedAt)) : 'Never used') + (k.expiresAt && k.status === 'active' ? ', ends ' + esc(fmtDateTime(k.expiresAt)) : '') + '</div></div>' +
  (k.status === 'active' ? '<button class="btn sm danger" data-revoke="' + esc(k.id) + '" type="button">Revoke</button>' : '') + '</div>';

const configFor = (url, key) => JSON.stringify({ mcpServers: { dovi: { type: 'http', url, headers: { Authorization: 'Bearer ' + key } } } }, null, 2);

export async function renderAgentKeys(root, session, { go }) {
  root.innerHTML = backBar('Agent keys', 'Let an AI agent pay for you, inside limits it cannot raise.') + '<div class="skeleton" style="height:200px"></div>';
  let st; let ap;
  try { [st, ap] = await Promise.all([api('/api/agent-keys'), api('/api/autopay')]); } catch (e) { root.innerHTML = backBar('Agent keys') + '<p class="err">' + esc(errorText(e)) + '</p>'; return; }
  const form = ap.enabled
    ? '<form class="card" id="kf" novalidate><label class="field" for="kn" style="margin-top:0">Name</label><input class="input" id="kn" maxlength="40" placeholder="For example, my research agent" autocomplete="off">' +
      '<label class="field" for="kp">Most per payment</label><div class="amount-wrap"><span class="cur" aria-hidden="true">$</span><input class="input" id="kp" inputmode="decimal" value="' + esc(String(Math.min(Number(ap.perPaymentMicro) / 1e6, 5))) + '"></div>' +
      '<label class="field" for="kd">Most per day</label><div class="amount-wrap"><span class="cur" aria-hidden="true">$</span><input class="input" id="kd" inputmode="decimal" value="' + esc(String(Math.min(Number(ap.perDayMicro) / 1e6, 10))) + '"></div>' +
      '<label class="field" for="kl">The key works for</label><select class="input" id="kl"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option><option value="never">Never expires</option></select>' +
      '<p class="hint">Never more than your Pay from X limits: ' + esc(usd(ap.perPaymentMicro)) + ' per payment, ' + esc(usd(ap.perDayMicro)) + ' per day.</p><p class="err" id="km" role="alert" hidden></p><button class="btn block mint lg" id="kgo" type="submit">Create key</button></form>'
    : '<div class="card"><p><b>Turn on Pay from X first.</b> Its limits are the ceiling for every agent key.</p><a class="btn mint" href="#autopay">Set limits</a></div>';
  root.innerHTML = backBar('Agent keys', 'Let an AI agent pay for you, inside limits it cannot raise.') +
    '<div class="card"><p>Connect Claude, Cursor or any MCP agent. It can check limits, quote and send a payment to an X handle or an email. It cannot change limits, withdraw or read your history.</p><div class="lrow"><div class="lb"><b class="mono">' + esc(st.mcpUrl) + '</b></div><button class="btn sm ghost" id="cu" type="button">Copy</button></div></div>' +
    form + '<h2 class="sec">Your keys</h2>' + (st.keys.length ? '<div class="list">' + st.keys.map(rowHtml).join('') + '</div>' : '<div class="empty"><p>No keys yet.</p></div>') +
    '<p class="hint" style="margin-top:12px">Only give the agent a recipient and an amount yourself. A key that never expires works until you revoke it, so revoke it when the agent is done. Revoke any key at any time and it stops at once.' + (st.available ? '' : ' Sending is not switched on yet, so a key can quote but not send.') + '</p>';
  root.querySelector('#cu').addEventListener('click', async () => { if (await copy(st.mcpUrl)) toast({ title: 'Copied', ms: 1600 }); });
  root.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', () => {
    const s = sheet('<div class="rv"><h2>Revoke this key?</h2><p class="hint">The agent stops working at once. Payments it already sent stay as they are.</p><div class="rv-actions"><button class="btn block danger lg" id="yes" type="button">Revoke key</button><button class="btn block ghost" id="no" type="button">Cancel</button></div></div>', { label: 'Revoke key', cls: 'rvback' });
    s.el.querySelector('#no').addEventListener('click', s.close);
    s.el.querySelector('#yes').addEventListener('click', async (ev) => { try { await busy(ev.currentTarget, () => api('/api/agent-keys/' + b.dataset.revoke + '/revoke', { method: 'POST', body: {} })); s.close(); toast({ title: 'Key revoked', ms: 2400 }); go('keys'); } catch (e) { toast({ title: 'Could not revoke', body: errorText(e), tone: 'bad', icon: '!' }); } });
  }));
  const f = root.querySelector('#kf'); const msg = root.querySelector('#km');
  if (f) f.addEventListener('submit', async (ev) => {
    ev.preventDefault(); msg.hidden = true;
    const name = f.querySelector('#kn').value.trim(); const pp = f.querySelector('#kp').value.trim(); const pd = f.querySelector('#kd').value.trim();
    if (!name) { msg.hidden = false; msg.textContent = 'Give the key a name.'; return; }
    if (!validAmount(pp) || !validAmount(pd)) { msg.hidden = false; msg.textContent = 'Enter amounts like 5 or 20.'; return; }
    try {
      const k = await busy(f.querySelector('#kgo'), () => api('/api/agent-keys', { method: 'POST', body: { name, perPayment: pp, perDay: pd, days: f.querySelector('#kl').value === 'never' ? 'never' : Number(f.querySelector('#kl').value) } }));
      const cfg = configFor(st.mcpUrl, k.key);
      const s = sheet('<div class="rv"><h2>Your key</h2><p class="hint"><b>Copy it now.</b> It is shown once and cannot be shown again. If you lose it, revoke it and make a new one.</p><pre class="keybox mono" id="kb">' + esc(k.key) + '</pre><div class="rv-actions"><button class="btn block mint lg" id="ck" type="button">Copy key</button><button class="btn block ghost" id="cc" type="button">Copy agent config</button><button class="btn block ghost" id="dn" type="button">I saved it</button></div></div>', { label: 'Agent key', cls: 'rvback' });
      s.el.querySelector('#ck').addEventListener('click', async () => { if (await copy(k.key)) toast({ title: 'Key copied', ms: 1600 }); });
      s.el.querySelector('#cc').addEventListener('click', async () => { if (await copy(cfg)) toast({ title: 'Config copied', ms: 1600 }); });
      s.el.querySelector('#dn').addEventListener('click', () => { s.close(); go('keys'); });
    } catch (e) { msg.hidden = false; msg.textContent = errorText(e); }
  });
}
