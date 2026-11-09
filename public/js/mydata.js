import { api } from './api.js?v=dev';
import { esc, fmtDateTime } from './format.js?v=dev';
import { busy, errorText, toast, sheet } from './ui.js?v=dev';

const STATUS = { open: 'Open', done: 'Done', declined: 'Closed' };

export async function mountMyData(root) {
  const slot = root.querySelector('#mydata'); if (!slot) return;
  const draw = async () => {
    let reqs = [];
    try { reqs = (await api('/api/account/data-requests')).requests; } catch { /* the card still offers the download */ }
    const open = reqs.find((r) => r.status === 'open');
    slot.innerHTML = '<h3 class="mini">Your data</h3><div class="card"><p class="hint" style="margin-top:0">See what DOVI holds about you, or ask us to delete it. <a href="/data-request" target="_blank" rel="noopener">How deletion works</a></p>'
      + '<div class="row-acts"><a class="btn sm ghost" id="mdl" href="/api/account/export" download>Download my data</a>'
      + (open ? '<button class="btn sm ghost" id="mcx" type="button">Cancel deletion request</button>' : '<button class="btn sm danger" id="mdel" type="button">Request deletion</button>') + '</div>'
      + (reqs.length ? '<div class="rows" style="margin-top:12px">' + reqs.map((r) => '<div class="r"><span>Deletion request, ' + esc(fmtDateTime(r.createdAt)) + '</span><b>' + esc(STATUS[r.status] || r.status) + (r.status === 'open' ? ', answer by ' + esc(fmtDateTime(r.dueAt)) : '') + '</b></div>').join('') + '</div>' : '') + '</div>';
    const del = slot.querySelector('#mdel');
    if (del) del.addEventListener('click', () => {
      const s = sheet('<div class="rv"><h2>Request deletion</h2><p class="hint">We will delete your account and the personal data we hold, and keep only records the law requires. We aim to answer within 30 days.</p><ul class="plain"><li>Payments you sent that are still waiting must be claimed or taken back first.</li><li>Withdraw any USDC you want to keep. Your wallet is yours.</li><li>Payments on Base are public and cannot be removed by anyone.</li></ul><label class="field" for="mdn">Anything we should know (optional)</label><input class="input" id="mdn" maxlength="300" autocomplete="off"><div class="rv-actions"><button class="btn block danger lg" id="mgo" type="button">Send deletion request</button><button class="btn block ghost" id="mno" type="button">Keep my account</button></div></div>', { label: 'Request deletion', cls: 'rvback' });
      s.el.querySelector('#mno').addEventListener('click', s.close);
      s.el.querySelector('#mgo').addEventListener('click', async (ev) => {
        try { await busy(ev.currentTarget, () => api('/api/account/data-request', { method: 'POST', body: { kind: 'delete', detail: s.el.querySelector('#mdn').value.trim() } })); s.close(); toast({ title: 'Request sent', body: 'We will answer within 30 days. You can cancel it here until then.', ms: 4000 }); draw(); }
        catch (e) { toast({ title: 'Could not send it', body: errorText(e), tone: 'bad', icon: '!' }); }
      });
    });
    const cx = slot.querySelector('#mcx');
    if (cx && open) cx.addEventListener('click', async () => { try { await busy(cx, () => api('/api/account/data-request/' + open.id + '/cancel', { method: 'POST', body: {} })); toast({ title: 'Request cancelled', ms: 2400 }); draw(); } catch (e) { toast({ title: 'Could not cancel', body: errorText(e), tone: 'bad', icon: '!' }); } });
  };
  await draw();
}
