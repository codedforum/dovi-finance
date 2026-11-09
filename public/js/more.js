import { api } from './api.js?v=dev';
import * as wallet from './wallet.js?v=dev';
import { esc } from './format.js?v=dev';
import { sheet, busy, errorText, toast } from './ui.js?v=dev';

export async function renderMore(root, session) {
  const me = await api('/api/me');
  const ids = me.user.identities;
  const hasX = ids.some((i) => i.kind === 'x');
  root.innerHTML = '<h2 class="sec">Account</h2><div class="card"><div class="rows">' + ids.map((i) => '<div class="r"><span>' + esc({ x: 'X', email: 'Email', google: 'Google', telegram: 'Telegram' }[i.kind] || i.kind) + '</span><b>' + esc(i.label) + '</b></div>').join('') + '<div class="r"><span>Wallet</span><b style="font-size:12px;word-break:break-all">' + esc(session.address) + '</b></div></div>' + (hasX ? '' : '<a class="btn block ghost" style="margin-top:12px" href="/api/auth/x/start?return=/app%23more">Connect your X account</a><p class="note">Connect X so people can send to your handle.</p>') + '</div><h2 class="sec">Help</h2><div class="list"><a class="item" href="/notifications"><div class="ico" aria-hidden="true">🔔</div><div class="mid"><div class="t">Notifications</div></div></a><a class="item" href="/help"><div class="ico" aria-hidden="true">?</div><div class="mid"><div class="t">Help and safety</div></div></a><button class="item" id="rp" type="button" style="text-align:left;cursor:pointer"><div class="ico" aria-hidden="true">⚑</div><div class="mid"><div class="t">Report a problem or a scam</div></div></button><a class="item" href="/terms"><div class="ico" aria-hidden="true">§</div><div class="mid"><div class="t">Terms</div></div></a><a class="item" href="/privacy"><div class="ico" aria-hidden="true">🔒</div><div class="mid"><div class="t">Privacy</div></div></a></div><button class="btn block ghost" id="so" type="button" style="margin-top:22px">Sign out</button><p class="note" style="text-align:center">DOVI is in beta with low limits. Balances are not insured deposits.</p>';
  root.querySelector('#so').addEventListener('click', async () => { await wallet.signOut(); location.href = '/'; });
  root.querySelector('#rp').addEventListener('click', () => reportSheet());
}

export function reportSheet() {
  const s = sheet('<h2>Report</h2><p class="hint">Tell us what happened. We read every report.</p><form id="rf" novalidate><label class="field" for="rs">Subject</label><input class="input" id="rs" maxlength="120" placeholder="Someone is pretending to be me"><label class="field" for="rd">What happened</label><textarea class="input" id="rd" rows="5" maxlength="2000" style="padding:12px 16px"></textarea><div id="rm" class="err" role="alert" hidden></div><button class="btn block mint" style="margin-top:14px" type="submit">Send report</button></form>', { label: 'Report' });
  const f = s.el.querySelector('#rf'); const rm = s.el.querySelector('#rm');
  f.addEventListener('submit', async (e) => {
    e.preventDefault(); rm.hidden = true;
    try { await busy(f.querySelector('button'), () => api('/api/report', { method: 'POST', body: { subject: f.querySelector('#rs').value, detail: f.querySelector('#rd').value } })); s.close(); toast({ title: 'Thank you', body: 'Your report was sent.' }); }
    catch (er) { rm.hidden = false; rm.textContent = errorText(er); }
  });
}
